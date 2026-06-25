import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta

from agent.graph import build_graph
from db.database import Base, engine, get_db
from db.models import AdminSession, AdminUser, Incident
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
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
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class LoginRequest(BaseModel):
    username: str
    password: str


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
def list_incidents(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """List all stored incidents."""
    return db.query(Incident).order_by(Incident.created_at.desc()).all()


@app.get("/incidents/pending")
def list_pending(db: Session = Depends(get_db), admin: dict = Depends(get_current_admin)):
    """List incidents awaiting human review."""
    return db.query(Incident).filter(Incident.status == "pending_human").all()


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
