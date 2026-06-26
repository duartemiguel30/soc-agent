import json
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta

from agent.graph import build_graph
from db.database import Base, engine, get_db
from db.models import (
    AdminSession,
    AdminUser,
    Incident,
    IncidentActionEvent,
    IncidentArchiveState,
    IncidentNote,
    IncidentPlaybook,
    IncidentPlaybookStep,
)
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from playbooks.service import get_or_create_playbook, log_action_event
from security import hash_session_token, verify_password
from sqlalchemy.orm import Session

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="SOC AI Agent")
graph = build_graph()

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://192.168.56.105:3000")
AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "soc_admin_session")
AUTH_COOKIE_SECURE = os.getenv("AUTH_COOKIE_SECURE", "false").lower() in {"1", "true", "yes", "on"}
SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "8"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class LoginRequest(BaseModel):
    username: str
    password: str


class PlaybookStepUpdate(BaseModel):
    status: str


class NoteCreate(BaseModel):
    body: str


class ArchiveRequest(BaseModel):
    reason: str | None = None


def utc_now() -> datetime:
    return datetime.utcnow()


def get_client_ip(request: Request) -> str | None:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else None


def set_session_cookie(response: Response, token: str, expires_at: datetime) -> None:
    max_age = max(0, int((expires_at - utc_now()).total_seconds()))
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
        max_age=max_age,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        httponly=True,
        secure=AUTH_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def current_admin_username(admin: dict | None) -> str | None:
    if not admin:
        return None
    user = admin.get("user")
    return getattr(user, "username", None)


def get_incident_or_404(db: Session, incident_id: str) -> Incident:
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incident not found")
    return incident


def serialize_archive_state(archive_state: IncidentArchiveState | None) -> dict | None:
    if not archive_state:
        return None
    return {
        "id": archive_state.id,
        "incident_id": archive_state.incident_id,
        "archived_at": archive_state.archived_at,
        "archived_by": archive_state.archived_by,
        "reason": archive_state.reason,
        "created_at": archive_state.created_at,
    }


def serialize_incident(incident: Incident, archive_state: IncidentArchiveState | None = None) -> dict:
    data = {
        "id": incident.id,
        "agent_name": incident.agent_name,
        "rule_id": incident.rule_id,
        "rule_description": incident.rule_description,
        "rule_level": incident.rule_level,
        "mitre_technique": incident.mitre_technique,
        "classification": incident.classification,
        "confidence": incident.confidence,
        "severity": incident.severity,
        "reasoning": incident.reasoning,
        "recommended_action": incident.recommended_action,
        "decision": incident.decision,
        "status": incident.status,
        "created_at": incident.created_at,
    }
    data["archive_state"] = serialize_archive_state(archive_state)
    data["is_archived"] = archive_state is not None
    return data


def get_archive_state(db: Session, incident_id: str) -> IncidentArchiveState | None:
    return db.query(IncidentArchiveState).filter(IncidentArchiveState.incident_id == incident_id).first()


def incident_query_with_archive_filter(db: Session, archived: str | None):
    query = db.query(Incident)
    normalized = (archived or "all").lower()
    if normalized == "false":
        query = query.outerjoin(
            IncidentArchiveState,
            IncidentArchiveState.incident_id == Incident.id,
        ).filter(IncidentArchiveState.id.is_(None))
    elif normalized == "true":
        query = query.join(IncidentArchiveState, IncidentArchiveState.incident_id == Incident.id)
    elif normalized != "all":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="archived must be one of: true, false, all",
        )
    return query


def serialize_playbook(playbook: IncidentPlaybook, steps: list[IncidentPlaybookStep]) -> dict:
    return {
        "id": playbook.id,
        "incident_id": playbook.incident_id,
        "template_key": playbook.template_key,
        "title": playbook.title,
        "summary": playbook.summary,
        "status": playbook.status,
        "created_at": playbook.created_at,
        "updated_at": playbook.updated_at,
        "completed_at": playbook.completed_at,
        "steps": [
            {
                "id": step.id,
                "playbook_id": step.playbook_id,
                "step_order": step.step_order,
                "title": step.title,
                "description": step.description,
                "status": step.status,
                "is_required": step.is_required,
                "completed_at": step.completed_at,
                "completed_by": step.completed_by,
                "created_at": step.created_at,
                "updated_at": step.updated_at,
            }
            for step in steps
        ],
    }


def serialize_note(note: IncidentNote) -> dict:
    return {
        "id": note.id,
        "incident_id": note.incident_id,
        "author": note.author,
        "body": note.body,
        "created_at": note.created_at,
    }


def serialize_action_event(event: IncidentActionEvent) -> dict:
    return {
        "id": event.id,
        "incident_id": event.incident_id,
        "actor": event.actor,
        "event_type": event.event_type,
        "message": event.message,
        "metadata_json": event.metadata_json,
        "created_at": event.created_at,
    }


def update_playbook_status(db: Session, playbook_id: int) -> None:
    playbook = db.query(IncidentPlaybook).filter(IncidentPlaybook.id == playbook_id).first()
    if not playbook:
        return
    steps = db.query(IncidentPlaybookStep).filter(IncidentPlaybookStep.playbook_id == playbook_id).all()
    statuses = {step.status for step in steps}
    if steps and statuses.issubset({"done", "skipped"}):
        playbook.status = "completed"
        if not playbook.completed_at:
            playbook.completed_at = utc_now()
    elif any(step.status == "in_progress" for step in steps):
        playbook.status = "in_progress"
        playbook.completed_at = None
    else:
        playbook.status = "open"
        playbook.completed_at = None


def action_event_source(event: IncidentActionEvent) -> str:
    if event.event_type == "ai_analysis_completed":
        return "ai"
    if event.actor and event.actor != "system":
        return "analyst"
    return "system"


def get_current_admin(request: Request, db: Session = Depends(get_db)) -> dict:
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin authentication required")

    token_hash = hash_session_token(token)
    admin_session = db.query(AdminSession).filter(AdminSession.token_hash == token_hash).first()
    if not admin_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin authentication required")
    if admin_session.revoked_at is not None or admin_session.expires_at <= utc_now():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin authentication required")

    admin_user = db.query(AdminUser).filter(AdminUser.id == admin_session.admin_user_id).first()
    if not admin_user or not admin_user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin authentication required")
    return {"user": admin_user, "session": admin_session}


@app.post("/auth/login")
def login(credentials: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    admin_user = db.query(AdminUser).filter(AdminUser.username == credentials.username).first()
    if not admin_user or not admin_user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin credentials")

    if not verify_password(credentials.password, admin_user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin credentials")

    raw_token = secrets.token_urlsafe(32)
    expires_at = utc_now() + timedelta(hours=SESSION_TTL_HOURS)
    admin_session = AdminSession(
        admin_user_id=admin_user.id,
        token_hash=hash_session_token(raw_token),
        expires_at=expires_at,
        user_agent=request.headers.get("user-agent"),
        client_ip=get_client_ip(request),
    )
    db.add(admin_session)
    db.commit()

    set_session_cookie(response, raw_token, expires_at)
    return {"username": admin_user.username, "role": admin_user.role}


@app.post("/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(AUTH_COOKIE_NAME)
    if token:
        admin_session = db.query(AdminSession).filter(AdminSession.token_hash == hash_session_token(token)).first()
        if admin_session and admin_session.revoked_at is None:
            admin_session.revoked_at = utc_now()
            db.commit()
    clear_session_cookie(response)
    return {"ok": True}


@app.get("/auth/me")
def me(admin: dict = Depends(get_current_admin)):
    admin_user = admin["user"]
    admin_session = admin["session"]
    return {
        "username": admin_user.username,
        "role": admin_user.role,
        "session": {
            "created_at": admin_session.created_at,
            "expires_at": admin_session.expires_at,
        },
    }


@app.post("/webhook/wazuh")
async def receive_alert(alert: dict, db: Session = Depends(get_db)):
    """Receive Wazuh alerts and process them through the LangGraph agent."""
    logger.info(f"Alert received: rule_id={alert.get('rule', {}).get('id')}")

    initial_state = {
        "raw_alert": alert,
        "agent_name": "",
        "rule_id": "",
        "rule_description": "",
        "rule_level": 0,
        "mitre_technique": "",
        "timestamp": "",
        "classification": "",
        "confidence": 0,
        "severity": "",
        "reasoning": "",
        "recommended_action": "",
        "decision": "",
        "incident_id": None,
        "status": "",
    }

    result = graph.invoke(initial_state)

    incident_id = str(uuid.uuid4())
    incident = Incident(
        id=incident_id,
        agent_name=result.get("agent_name"),
        rule_id=result.get("rule_id"),
        rule_description=result.get("rule_description"),
        rule_level=result.get("rule_level"),
        mitre_technique=result.get("mitre_technique"),
        classification=result.get("classification"),
        confidence=result.get("confidence"),
        severity=result.get("severity"),
        reasoning=result.get("reasoning"),
        recommended_action=result.get("recommended_action"),
        decision=result.get("decision"),
        status=result.get("status"),
    )
    db.add(incident)
    log_action_event(
        db,
        incident_id,
        "system",
        "incident_created",
        f"Incident created from Wazuh alert rule {result.get('rule_id') or 'unknown'}.",
    )
    log_action_event(
        db,
        incident_id,
        "system",
        "ai_analysis_completed",
        "AI analysis completed and stored with the incident.",
        {
            "classification": result.get("classification"),
            "confidence": result.get("confidence"),
            "severity": result.get("severity"),
            "decision": result.get("decision"),
        },
    )
    db.commit()

    logger.info(
        f"Incident {incident_id} saved - decision={result.get('decision')} "
        f"confidence={result.get('confidence')}%"
    )

    return {
        "incident_id": incident_id,
        "classification": result.get("classification"),
        "confidence": result.get("confidence"),
        "severity": result.get("severity"),
        "decision": result.get("decision"),
        "reasoning": result.get("reasoning"),
        "recommended_action": result.get("recommended_action"),
    }


@app.get("/incidents")
def list_incidents(
    archived: str = "all",
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """List all stored incidents."""
    incidents = incident_query_with_archive_filter(db, archived).order_by(Incident.created_at.desc()).all()
    if archived.lower() == "all":
        archive_states = {state.incident_id: state for state in db.query(IncidentArchiveState).all()}
        return [serialize_incident(incident, archive_states.get(incident.id)) for incident in incidents]
    if archived.lower() == "true":
        archive_states = {state.incident_id: state for state in db.query(IncidentArchiveState).all()}
        return [serialize_incident(incident, archive_states.get(incident.id)) for incident in incidents]
    return [serialize_incident(incident) for incident in incidents]


@app.get("/incidents/pending")
def list_pending(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """List incidents awaiting human review."""
    return db.query(Incident).filter(Incident.status == "pending_human").all()


@app.get("/incidents/archive")
def list_archived_incidents(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """Return archived incidents with archive metadata."""
    rows = (
        db.query(Incident, IncidentArchiveState)
        .join(IncidentArchiveState, IncidentArchiveState.incident_id == Incident.id)
        .order_by(IncidentArchiveState.archived_at.desc())
        .all()
    )
    return [serialize_incident(incident, archive_state) for incident, archive_state in rows]


@app.get("/incidents/{incident_id}")
def get_incident_detail(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return a single incident with stored AI analysis fields."""
    incident = get_incident_or_404(db, incident_id)
    return serialize_incident(incident, get_archive_state(db, incident_id))


@app.post("/incidents/{incident_id}/archive")
def archive_incident(
    incident_id: str,
    payload: ArchiveRequest | None = None,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Archive an incident for dashboard/list visibility without changing its operational status."""
    get_incident_or_404(db, incident_id)
    actor = current_admin_username(admin)
    archive_state = get_archive_state(db, incident_id)
    if not archive_state:
        archive_state = IncidentArchiveState(
            incident_id=incident_id,
            archived_at=utc_now(),
            archived_by=actor,
            reason=(payload.reason.strip() if payload and payload.reason else None),
        )
        db.add(archive_state)
        log_action_event(
            db,
            incident_id,
            actor,
            "incident_archived",
            "Incident archived for dashboard/list organization.",
            {"reason": archive_state.reason} if archive_state.reason else None,
        )
        db.commit()
        db.refresh(archive_state)
    return {"incident_id": incident_id, "is_archived": True, "archive_state": serialize_archive_state(archive_state)}


@app.post("/incidents/{incident_id}/unarchive")
def unarchive_incident(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Remove archive state without changing incident operational status."""
    get_incident_or_404(db, incident_id)
    actor = current_admin_username(admin)
    archive_state = get_archive_state(db, incident_id)
    if archive_state:
        db.delete(archive_state)
        log_action_event(
            db,
            incident_id,
            actor,
            "incident_unarchived",
            "Incident restored to active views.",
        )
        db.commit()
    return {"incident_id": incident_id, "is_archived": False}


@app.get("/incidents/{incident_id}/playbook")
def get_incident_playbook(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return or lazily create the deterministic manual response playbook for an incident."""
    incident = get_incident_or_404(db, incident_id)
    playbook, steps, _created = get_or_create_playbook(db, incident, current_admin_username(admin))
    return serialize_playbook(playbook, steps)


@app.patch("/playbook/steps/{step_id}")
def update_playbook_step(
    step_id: int,
    payload: PlaybookStepUpdate,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Update a manual playbook checklist step status."""
    accepted_statuses = {"todo", "in_progress", "done", "skipped"}
    if payload.status not in accepted_statuses:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid step status",
        )

    step = db.query(IncidentPlaybookStep).filter(IncidentPlaybookStep.id == step_id).first()
    if not step:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook step not found")

    playbook = db.query(IncidentPlaybook).filter(IncidentPlaybook.id == step.playbook_id).first()
    if not playbook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Playbook not found")

    actor = current_admin_username(admin)
    previous_status = step.status
    step.status = payload.status
    if payload.status == "done":
        step.completed_at = utc_now()
        step.completed_by = actor
    elif payload.status in {"todo", "in_progress", "skipped"}:
        step.completed_at = None
        step.completed_by = None

    update_playbook_status(db, step.playbook_id)
    log_action_event(
        db,
        playbook.incident_id,
        actor,
        "playbook_step_updated",
        f"Playbook step {step.step_order} changed from {previous_status} to {payload.status}: {step.title}",
        {
            "step_id": step.id,
            "playbook_id": playbook.id,
            "previous_status": previous_status,
            "status": payload.status,
        },
    )
    db.commit()
    db.refresh(step)
    return {
        "id": step.id,
        "playbook_id": step.playbook_id,
        "step_order": step.step_order,
        "title": step.title,
        "description": step.description,
        "status": step.status,
        "is_required": step.is_required,
        "completed_at": step.completed_at,
        "completed_by": step.completed_by,
        "created_at": step.created_at,
        "updated_at": step.updated_at,
    }


@app.post("/incidents/{incident_id}/notes")
def add_incident_note(
    incident_id: str,
    payload: NoteCreate,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Add an analyst note to an incident."""
    get_incident_or_404(db, incident_id)
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Note body is required")

    actor = current_admin_username(admin)
    note = IncidentNote(incident_id=incident_id, author=actor, body=body)
    db.add(note)
    db.flush()
    log_action_event(
        db,
        incident_id,
        actor,
        "note_added",
        "Analyst note added.",
        {"note_id": note.id},
    )
    db.commit()
    db.refresh(note)
    return serialize_note(note)


@app.get("/incidents/{incident_id}/notes")
def list_incident_notes(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return analyst notes oldest first for stable chronological reading."""
    get_incident_or_404(db, incident_id)
    notes = (
        db.query(IncidentNote)
        .filter(IncidentNote.incident_id == incident_id)
        .order_by(IncidentNote.created_at.asc(), IncidentNote.id.asc())
        .all()
    )
    return [serialize_note(note) for note in notes]


@app.get("/incidents/{incident_id}/actions")
def list_incident_actions(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return historical action events oldest first."""
    get_incident_or_404(db, incident_id)
    events = (
        db.query(IncidentActionEvent)
        .filter(IncidentActionEvent.incident_id == incident_id)
        .order_by(IncidentActionEvent.created_at.asc(), IncidentActionEvent.id.asc())
        .all()
    )
    return [serialize_action_event(event) for event in events]


@app.get("/incidents/{incident_id}/timeline")
def get_incident_timeline(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return chronological timeline events, using action events first.

    Notes are represented by note_added action events. Synthetic entries are only
    fallback records for old incidents that predate action-event logging.
    """
    incident = get_incident_or_404(db, incident_id)
    events = (
        db.query(IncidentActionEvent)
        .filter(IncidentActionEvent.incident_id == incident_id)
        .order_by(IncidentActionEvent.created_at.asc(), IncidentActionEvent.id.asc())
        .all()
    )
    existing_event_types = {event.event_type for event in events}

    timeline = [
        {
            "timestamp": event.created_at,
            "source": action_event_source(event),
            "event_type": event.event_type,
            "actor": event.actor,
            "message": event.message,
            "metadata_json": event.metadata_json,
        }
        for event in events
    ]

    if "incident_created" not in existing_event_types:
        timeline.append(
            {
                "timestamp": incident.created_at,
                "source": "system",
                "event_type": "incident_created",
                "actor": "system",
                "message": f"Incident created for rule {incident.rule_id or 'unknown'}.",
            }
        )

    if (
        "ai_analysis_completed" not in existing_event_types
        and (incident.classification or incident.reasoning or incident.recommended_action)
    ):
        timeline.append(
            {
                "timestamp": incident.created_at,
                "source": "ai",
                "event_type": "ai_analysis_completed",
                "actor": "system",
                "message": "AI analysis fields are available for this incident.",
            }
        )

    if "playbook_created" not in existing_event_types:
        playbook = (
            db.query(IncidentPlaybook)
            .filter(IncidentPlaybook.incident_id == incident_id)
            .order_by(IncidentPlaybook.created_at.asc())
            .first()
        )
    else:
        playbook = None
    if playbook:
        timeline.append(
            {
                "timestamp": playbook.created_at,
                "source": "system",
                "event_type": "playbook_created",
                "actor": "system",
                "message": f"Manual playbook available: {playbook.title}",
            }
        )

    logged_note_ids = set()
    for event in events:
        if event.event_type != "note_added" or not event.metadata_json:
            continue
        try:
            metadata = json.loads(event.metadata_json)
        except json.JSONDecodeError:
            continue
        note_id = metadata.get("note_id")
        if note_id is not None:
            logged_note_ids.add(note_id)

    notes_without_events = (
        db.query(IncidentNote)
        .filter(IncidentNote.incident_id == incident_id)
        .order_by(IncidentNote.created_at.asc(), IncidentNote.id.asc())
        .all()
    )
    for note in notes_without_events:
        if note.id in logged_note_ids:
            continue
        timeline.append(
            {
                "timestamp": note.created_at,
                "source": "analyst",
                "event_type": "note_added",
                "actor": note.author,
                "message": note.body,
            }
        )

    return sorted(timeline, key=lambda item: item["timestamp"])


@app.post("/incidents/{incident_id}/approve")
def approve_incident(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Approve the recommended action."""
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        return {"error": "Incident not found"}
    incident.status = "approved"
    log_action_event(
        db,
        incident_id,
        current_admin_username(admin),
        "incident_approved",
        "Incident approved by analyst.",
        {"action": incident.recommended_action},
    )
    db.commit()
    logger.info(f"Incident {incident_id} APPROVED by human analyst")
    return {"incident_id": incident_id, "status": "approved", "action": incident.recommended_action}


@app.post("/incidents/{incident_id}/reject")
def reject_incident(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Reject the incident and close it as a false positive."""
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        return {"error": "Incident not found"}
    incident.status = "rejected"
    log_action_event(
        db,
        incident_id,
        current_admin_username(admin),
        "incident_rejected",
        "Incident rejected by analyst and closed as false positive.",
    )
    db.commit()
    logger.info(f"Incident {incident_id} REJECTED by human analyst - closed as false positive")
    return {"incident_id": incident_id, "status": "rejected"}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
def serve_dashboard():
    return FileResponse("static/index.html")


@app.get("/report")
def generate_report(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """Generate an executive AI report from stored incidents."""
    from config import GEMINI_API_KEY
    from langchain_google_genai import ChatGoogleGenerativeAI

    incidents = db.query(Incident).order_by(Incident.created_at.desc()).limit(50).all()

    if not incidents:
        return {"report": "No incidents found."}

    summary = "\n".join(
        [
            f"- [{i.created_at}] Rule {i.rule_id}: {i.rule_description} | Agent: {i.agent_name} | "
            f"Classification: {i.classification} | Confidence: {i.confidence}% | "
            f"Severity: {i.severity} | Decision: {i.decision} | Status: {i.status}"
            for i in incidents
        ]
    )

    prompt = f"""You are a senior SOC analyst. Based on the following security incidents detected in the last period, generate a concise executive security report.

INCIDENTS:
{summary}

Write a professional report with these sections:
1. Executive Summary (2-3 sentences)
2. Key Findings (bullet points of most critical incidents)
3. False Positives Identified (what was correctly filtered)
4. Recommended Actions (prioritized)
5. Overall Risk Assessment (Low/Medium/High/Critical)

Be concise and professional."""

    llm = ChatGoogleGenerativeAI(
        model="gemini-3.1-flash-lite",
        google_api_key=GEMINI_API_KEY,
        temperature=0,
    )

    response = llm.invoke(prompt)
    content = response.content
    if isinstance(content, list):
        content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in content])

    return {"report": content, "incidents_analyzed": len(incidents)}


@app.get("/health")
def health():
    return {"status": "ok"}
