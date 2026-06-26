import json
import logging
import os
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from agent.graph import build_graph
from db.database import Base, engine, get_db
from db.models import (
    AdminSession,
    AdminUser,
    Incident,
    IncidentActionEvent,
    IncidentAlertEvent,
    IncidentArchiveState,
    IncidentNote,
    IncidentObservable,
    IncidentPlaybook,
    IncidentPlaybookStep,
)
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from playbooks.service import get_or_create_playbook, load_playbook, log_action_event, template_suggestion
from response_actions.service import describe_actions, dry_run_action, execute_action, list_observables
from security import hash_session_token, verify_password
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
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
INCIDENT_CORRELATION_WINDOW_MINUTES = int(os.getenv("INCIDENT_CORRELATION_WINDOW_MINUTES", "15"))

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


class ResponseActionRequest(BaseModel):
    confirm: str | None = None
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


def incident_event_stats(db: Session | None, incident: Incident) -> dict:
    if not db:
        return {
            "event_count": 1,
            "first_seen": incident.created_at,
            "last_seen": incident.created_at,
            "correlation_key": None,
        }

    rows = (
        db.query(
            func.count(IncidentAlertEvent.id),
            func.min(func.coalesce(IncidentAlertEvent.event_timestamp, IncidentAlertEvent.created_at)),
            func.max(func.coalesce(IncidentAlertEvent.event_timestamp, IncidentAlertEvent.created_at)),
            func.min(IncidentAlertEvent.correlation_key),
        )
        .filter(IncidentAlertEvent.incident_id == incident.id)
        .first()
    )
    event_count = int(rows[0] or 0) if rows else 0
    if event_count < 1:
        return {
            "event_count": 1,
            "first_seen": incident.created_at,
            "last_seen": incident.created_at,
            "correlation_key": None,
        }
    return {
        "event_count": event_count,
        "first_seen": rows[1] or incident.created_at,
        "last_seen": rows[2] or incident.created_at,
        "correlation_key": rows[3],
    }


def serialize_incident(
    incident: Incident,
    archive_state: IncidentArchiveState | None = None,
    db: Session | None = None,
) -> dict:
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
    data.update(incident_event_stats(db, incident))
    data["archive_state"] = serialize_archive_state(archive_state)
    data["is_archived"] = archive_state is not None
    return data


def serialize_alert_event(event: IncidentAlertEvent) -> dict:
    return {
        "id": event.id,
        "incident_id": event.incident_id,
        "correlation_key": event.correlation_key,
        "rule_id": event.rule_id,
        "agent_name": event.agent_name,
        "src_ip": event.src_ip,
        "target_username": event.target_username,
        "event_timestamp": event.event_timestamp,
        "summary": event.summary,
        "created_at": event.created_at,
    }


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


def serialize_observable(observable: IncidentObservable) -> dict:
    return {
        "id": observable.id,
        "incident_id": observable.incident_id,
        "key": observable.key,
        "value": observable.value,
        "source": observable.source,
        "created_at": observable.created_at,
    }


def get_nested_value(data: dict, path: tuple[str, ...]):
    current = data
    for key in path:
        if not isinstance(current, dict):
            return None
        if key in current:
            current = current[key]
            continue
        lower_key = key.lower()
        matched_key = next((candidate for candidate in current if str(candidate).lower() == lower_key), None)
        if matched_key is None:
            return None
        current = current[matched_key]
    return current


def clean_observable_value(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    return text or None


def extract_wazuh_observables(alert: dict) -> list[tuple[str, str]]:
    field_map = {
        "agent_name": [("agent", "name")],
        "agent_id": [("agent", "id")],
        "src_ip": [
            ("data", "srcip"),
            ("data", "src_ip"),
            ("data", "win", "eventdata", "sourceIp"),
            ("data", "win", "eventdata", "sourceIpAddress"),
        ],
        "target_username": [("data", "win", "eventdata", "targetUserName")],
        "subject_username": [("data", "win", "eventdata", "subjectUserName")],
        "user": [("data", "win", "eventdata", "user")],
        "process_name": [("data", "win", "eventdata", "image")],
        "parent_process_name": [("data", "win", "eventdata", "parentImage")],
        "command_line": [("data", "win", "eventdata", "commandLine")],
        "target_image": [("data", "win", "eventdata", "targetImage")],
        "host": [("data", "win", "system", "computer")],
    }
    observables: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for key, paths in field_map.items():
        for path in paths:
            value = clean_observable_value(get_nested_value(alert, path))
            if not value:
                continue
            candidate = (key, value)
            if candidate in seen:
                continue
            seen.add(candidate)
            observables.append(candidate)
    return observables


def parse_wazuh_timestamp(value) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo:
            return parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except ValueError:
        logger.debug("Could not parse Wazuh timestamp: %s", value)
        return None


def normalize_correlation_value(value) -> str | None:
    text = clean_observable_value(value)
    if not text:
        return None
    return text.lower()


def wazuh_alert_context(alert: dict) -> dict:
    rule = alert.get("rule") if isinstance(alert.get("rule"), dict) else {}
    agent = alert.get("agent") if isinstance(alert.get("agent"), dict) else {}
    mitre = rule.get("mitre") if isinstance(rule.get("mitre"), dict) else {}
    techniques = mitre.get("technique") if isinstance(mitre.get("technique"), list) else []
    observables = dict(extract_wazuh_observables(alert))
    agent_name = (
        clean_observable_value(agent.get("name"))
        or observables.get("agent_name")
        or observables.get("host")
    )
    target_username = (
        observables.get("target_username")
        or observables.get("user")
        or observables.get("subject_username")
    )
    return {
        "rule_id": clean_observable_value(rule.get("id")),
        "agent_name": agent_name,
        "host": observables.get("host"),
        "src_ip": observables.get("src_ip"),
        "target_username": target_username,
        "process_name": observables.get("process_name"),
        "target_image": observables.get("target_image"),
        "mitre_technique": clean_observable_value(techniques[0] if techniques else None),
        "timestamp": parse_wazuh_timestamp(alert.get("timestamp")),
        "summary": build_alert_summary(alert, rule, agent_name, target_username, observables),
    }


def build_alert_summary(
    alert: dict,
    rule: dict,
    agent_name: str | None,
    target_username: str | None,
    observables: dict[str, str],
) -> str:
    description = clean_observable_value(rule.get("description")) or "Wazuh alert"
    parts = [description]
    if agent_name:
        parts.append(f"agent={agent_name}")
    if observables.get("src_ip"):
        parts.append(f"src_ip={observables['src_ip']}")
    if target_username:
        parts.append(f"user={target_username}")
    if observables.get("process_name") or observables.get("target_image"):
        parts.append(f"process={observables.get('target_image') or observables.get('process_name')}")
    return " | ".join(parts)[:500]


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def build_alert_hash(alert: dict) -> str:
    hash_payload = {
        "timestamp": alert.get("timestamp"),
        "rule": alert.get("rule"),
        "agent": alert.get("agent"),
        "manager": alert.get("manager"),
        "location": alert.get("location"),
        "decoder": alert.get("decoder"),
        "data": alert.get("data"),
        "full_log": alert.get("full_log"),
        "id": alert.get("id"),
    }
    return hashlib.sha256(canonical_json(hash_payload).encode("utf-8")).hexdigest()


def build_correlation_key(context: dict) -> str:
    rule_id = normalize_correlation_value(context.get("rule_id")) or "unknown_rule"
    agent_name = normalize_correlation_value(context.get("agent_name") or context.get("host"))
    src_ip = normalize_correlation_value(context.get("src_ip"))
    target_username = normalize_correlation_value(context.get("target_username"))
    process_name = normalize_correlation_value(context.get("target_image") or context.get("process_name"))
    mitre_technique = normalize_correlation_value(context.get("mitre_technique"))

    if rule_id == "100004":
        if src_ip and target_username:
            parts = ("rule", rule_id, "src", src_ip, "user", target_username)
        elif src_ip:
            parts = ("rule", rule_id, "src", src_ip)
        elif agent_name:
            parts = ("rule", rule_id, "agent", agent_name)
        else:
            parts = ("rule", rule_id)
        return "|".join(parts)

    if process_name and ("lsass" in process_name or mitre_technique):
        parts = ["rule", rule_id]
        if agent_name:
            parts.extend(["agent", agent_name])
        parts.extend(["process", process_name])
        return "|".join(parts)

    parts = ["rule", rule_id]
    if agent_name:
        parts.extend(["agent", agent_name])
    if src_ip:
        parts.extend(["src", src_ip])
    if target_username:
        parts.extend(["user", target_username])
    if not agent_name and not src_ip and not target_username and mitre_technique:
        parts.extend(["mitre", mitre_technique])
    return "|".join(parts)


def create_alert_event(
    incident_id: str,
    correlation_key: str,
    alert_hash: str,
    context: dict,
) -> IncidentAlertEvent:
    return IncidentAlertEvent(
        incident_id=incident_id,
        correlation_key=correlation_key,
        alert_hash=alert_hash,
        rule_id=clean_observable_value(context.get("rule_id")),
        agent_name=clean_observable_value(context.get("agent_name") or context.get("host")),
        src_ip=clean_observable_value(context.get("src_ip")),
        target_username=clean_observable_value(context.get("target_username")),
        event_timestamp=context.get("timestamp"),
        summary=clean_observable_value(context.get("summary")),
    )


def find_recent_correlated_incident(db: Session, correlation_key: str) -> Incident | None:
    cutoff = utc_now() - timedelta(minutes=INCIDENT_CORRELATION_WINDOW_MINUTES)
    return (
        db.query(Incident)
        .join(IncidentAlertEvent, IncidentAlertEvent.incident_id == Incident.id)
        .outerjoin(IncidentArchiveState, IncidentArchiveState.incident_id == Incident.id)
        .filter(
            IncidentAlertEvent.correlation_key == correlation_key,
            IncidentArchiveState.id.is_(None),
            or_(Incident.status.is_(None), ~Incident.status.in_(["approved", "rejected"])),
            or_(
                IncidentAlertEvent.event_timestamp >= cutoff,
                IncidentAlertEvent.created_at >= cutoff,
            ),
        )
        .order_by(
            func.coalesce(IncidentAlertEvent.event_timestamp, IncidentAlertEvent.created_at).desc(),
            Incident.created_at.desc(),
        )
        .first()
    )


def store_wazuh_observables(db: Session, incident_id: str, alert: dict) -> None:
    try:
        observables = extract_wazuh_observables(alert)
        for key, value in observables:
            exists = (
                db.query(IncidentObservable)
                .filter(
                    IncidentObservable.incident_id == incident_id,
                    IncidentObservable.key == key,
                    IncidentObservable.value == value,
                )
                .first()
            )
            if exists:
                continue
            db.add(IncidentObservable(incident_id=incident_id, key=key, value=value, source="wazuh"))
    except Exception as exc:
        logger.warning("Observable extraction skipped for incident %s: %s", incident_id, exc)


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

    context = None
    alert_hash = None
    correlation_key = None
    try:
        context = wazuh_alert_context(alert)
        alert_hash = build_alert_hash(alert)
        correlation_key = build_correlation_key(context)

        duplicate_event = db.query(IncidentAlertEvent).filter(IncidentAlertEvent.alert_hash == alert_hash).first()
        if duplicate_event:
            incident = db.query(Incident).filter(Incident.id == duplicate_event.incident_id).first()
            logger.info(
                "Duplicate Wazuh alert ignored for incident %s correlation_key=%s",
                duplicate_event.incident_id,
                duplicate_event.correlation_key,
            )
            return {
                "incident_id": duplicate_event.incident_id,
                "duplicate": True,
                "correlated": True,
                "event_count": incident_event_stats(db, incident)["event_count"] if incident else None,
            }

        correlated_incident = find_recent_correlated_incident(db, correlation_key)
        if correlated_incident:
            db.add(create_alert_event(correlated_incident.id, correlation_key, alert_hash, context))
            store_wazuh_observables(db, correlated_incident.id, alert)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                existing = db.query(IncidentAlertEvent).filter(IncidentAlertEvent.alert_hash == alert_hash).first()
                if existing:
                    return {
                        "incident_id": existing.incident_id,
                        "duplicate": True,
                        "correlated": True,
                        "event_count": incident_event_stats(db, correlated_incident)["event_count"],
                    }
                raise
            db.refresh(correlated_incident)
            stats = incident_event_stats(db, correlated_incident)
            logger.info(
                "Wazuh alert correlated into incident %s correlation_key=%s event_count=%s",
                correlated_incident.id,
                correlation_key,
                stats["event_count"],
            )
            return {
                "incident_id": correlated_incident.id,
                "classification": correlated_incident.classification,
                "confidence": correlated_incident.confidence,
                "severity": correlated_incident.severity,
                "decision": correlated_incident.decision,
                "correlated": True,
                "duplicate": False,
                "event_count": stats["event_count"],
            }
    except Exception as exc:
        db.rollback()
        logger.warning("Alert correlation failed; creating a new incident instead: %s", exc)

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
    store_wazuh_observables(db, incident_id, alert)
    if context and alert_hash and correlation_key:
        db.add(create_alert_event(incident_id, correlation_key, alert_hash, context))
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
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if alert_hash:
            existing = db.query(IncidentAlertEvent).filter(IncidentAlertEvent.alert_hash == alert_hash).first()
            if existing:
                logger.info("Wazuh alert was already stored during new-incident commit: %s", existing.incident_id)
                return {
                    "incident_id": existing.incident_id,
                    "duplicate": True,
                    "correlated": True,
                }
        raise

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
        "correlated": False,
        "duplicate": False,
        "event_count": 1,
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
        return [serialize_incident(incident, archive_states.get(incident.id), db) for incident in incidents]
    if archived.lower() == "true":
        archive_states = {state.incident_id: state for state in db.query(IncidentArchiveState).all()}
        return [serialize_incident(incident, archive_states.get(incident.id), db) for incident in incidents]
    return [serialize_incident(incident, db=db) for incident in incidents]


@app.get("/incidents/pending")
def list_pending(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """List incidents awaiting human review."""
    incidents = db.query(Incident).filter(Incident.status == "pending_human").all()
    return [serialize_incident(incident, get_archive_state(db, incident.id), db) for incident in incidents]


@app.get("/incidents/archive")
def list_archived_incidents(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """Return archived incidents with archive metadata."""
    rows = (
        db.query(Incident, IncidentArchiveState)
        .join(IncidentArchiveState, IncidentArchiveState.incident_id == Incident.id)
        .order_by(IncidentArchiveState.archived_at.desc())
        .all()
    )
    return [serialize_incident(incident, archive_state, db) for incident, archive_state in rows]


@app.get("/incidents/{incident_id}")
def get_incident_detail(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return a single incident with stored AI analysis fields."""
    incident = get_incident_or_404(db, incident_id)
    return serialize_incident(incident, get_archive_state(db, incident_id), db)


@app.get("/incidents/{incident_id}/alert-events")
def get_incident_alert_events(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return compact correlated Wazuh alert events for an incident."""
    get_incident_or_404(db, incident_id)
    events = (
        db.query(IncidentAlertEvent)
        .filter(IncidentAlertEvent.incident_id == incident_id)
        .order_by(
            func.coalesce(IncidentAlertEvent.event_timestamp, IncidentAlertEvent.created_at).asc(),
            IncidentAlertEvent.id.asc(),
        )
        .all()
    )
    return [serialize_alert_event(event) for event in events]


@app.get("/incidents/{incident_id}/observables")
def get_incident_observables(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return extracted incident observables without mutating incident state."""
    get_incident_or_404(db, incident_id)
    return [serialize_observable(observable) for observable in list_observables(db, incident_id)]


@app.get("/incidents/{incident_id}/response-actions")
def get_incident_response_actions(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Return policy-gated response actions and dry-run previews for this incident."""
    incident = get_incident_or_404(db, incident_id)
    return describe_actions(db, incident_id, incident)


@app.post("/incidents/{incident_id}/response-actions/{action_key}/dry-run")
def dry_run_incident_response_action(
    incident_id: str,
    action_key: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Run response action validation and preview only; dry-runs are not logged to avoid noisy history."""
    get_incident_or_404(db, incident_id)
    result = dry_run_action(db, incident_id, action_key)
    status_code = result.pop("status_code", None)
    if not result.get("ok"):
        raise HTTPException(
            status_code=status_code or status.HTTP_400_BAD_REQUEST,
            detail=result.get("message") or "Dry-run failed",
        )
    return result


@app.post("/incidents/{incident_id}/response-actions/{action_key}/execute")
def execute_incident_response_action(
    incident_id: str,
    action_key: str,
    payload: ResponseActionRequest | None = None,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Execute a policy-gated response action only after explicit analyst request."""
    get_incident_or_404(db, incident_id)
    if action_key == "disable_ad_account":
        if not payload or payload.confirm != "DISABLE_ACCOUNT":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="disable_ad_account requires confirm=DISABLE_ACCOUNT.",
            )
        if not payload.reason or not payload.reason.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="disable_ad_account requires an analyst reason.",
            )

    reason = payload.reason.strip() if payload and payload.reason else None
    result = execute_action(db, incident_id, action_key, current_admin_username(admin), reason)
    status_code = result.pop("status_code", None)
    if not result.get("ok"):
        raise HTTPException(
            status_code=status_code or status.HTTP_400_BAD_REQUEST,
            detail=result.get("message") or "Response action failed",
        )
    return result


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
    """Return an existing manual playbook or a suggested template without creating rows."""
    incident = get_incident_or_404(db, incident_id)
    playbook, steps = load_playbook(db, incident_id)
    return {
        "playbook": serialize_playbook(playbook, steps) if playbook else None,
        "suggested_template": None if playbook else template_suggestion(incident),
    }


@app.post("/incidents/{incident_id}/playbook")
def create_incident_playbook(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Create the deterministic manual response playbook when an analyst explicitly requests it."""
    incident = get_incident_or_404(db, incident_id)
    playbook, steps, created = get_or_create_playbook(db, incident, current_admin_username(admin))
    return {"playbook": serialize_playbook(playbook, steps), "created": created}


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
    """Return an existing manual playbook or a suggested template without creating rows."""
    incident = get_incident_or_404(db, incident_id)
    playbook, steps = load_playbook(db, incident_id)
    return {
        "playbook": serialize_playbook(playbook, steps) if playbook else None,
        "suggested_template": None if playbook else template_suggestion(incident),
    }


@app.post("/incidents/{incident_id}/playbook")
def create_incident_playbook(
    incident_id: str,
    db: Session = Depends(get_db),
    admin: dict = Depends(get_current_admin),
):
    """Create the deterministic manual response playbook when an analyst explicitly requests it."""
    incident = get_incident_or_404(db, incident_id)
    playbook, steps, created = get_or_create_playbook(db, incident, current_admin_username(admin))
    return {"playbook": serialize_playbook(playbook, steps), "created": created}


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
