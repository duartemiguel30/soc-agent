import uuid
import logging
from fastapi import FastAPI, Depends
from sqlalchemy.orm import Session
from db.database import engine, Base, get_db
from db.models import Incident
from agent.graph import build_graph
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

Base.metadata.create_all(bind=engine)

app = FastAPI(title="SOC AI Agent")
graph = build_graph()

@app.post("/webhook/wazuh")
async def receive_alert(alert: dict, db: Session = Depends(get_db)):
    """Recebe alertas do Wazuh e processa com o agente LangGraph."""
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

    logger.info(f"Incident {incident_id} saved - decision={result.get('decision')} confidence={result.get('confidence')}%")

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
def list_incidents(db: Session = Depends(get_db)):
    """Lista todos os incidentes guardados."""
    return db.query(Incident).order_by(Incident.created_at.desc()).all()

@app.get("/incidents/pending")
def list_pending(db: Session = Depends(get_db)):
    """Lista incidentes aguardando revisão humana."""
    return db.query(Incident).filter(Incident.status == "pending_human").all()


@app.post("/incidents/{incident_id}/approve")
def approve_incident(incident_id: str, db: Session = Depends(get_db)):
    """Analista aprova a ação recomendada."""
    incident = db.query(Incident).filter(Incident.id == incident_id).first()
    if not incident:
        return {"error": "Incident not found"}
    incident.status = "approved"
    db.commit()
    logger.info(f"Incident {incident_id} APPROVED by human analyst")
    return {"incident_id": incident_id, "status": "approved", "action": incident.recommended_action}

@app.post("/incidents/{incident_id}/reject")
def reject_incident(incident_id: str, db: Session = Depends(get_db)):
    """Analista rejeita — fecha como falso positivo."""
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
def generate_report(db: Session = Depends(get_db)):
    """Gera um relatório executivo dos incidentes com AI."""
    from langchain_google_genai import ChatGoogleGenerativeAI
    from config import GEMINI_API_KEY

    incidents = db.query(Incident).order_by(Incident.created_at.desc()).limit(50).all()

    if not incidents:
        return {"report": "No incidents found."}

    summary = "\n".join([
        f"- [{i.created_at}] Rule {i.rule_id}: {i.rule_description} | Agent: {i.agent_name} | "
        f"Classification: {i.classification} | Confidence: {i.confidence}% | "
        f"Severity: {i.severity} | Decision: {i.decision} | Status: {i.status}"
        for i in incidents
    ])

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
        temperature=0
    )

    response = llm.invoke(prompt)
    content = response.content
    if isinstance(content, list):
        content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in content])

    return {"report": content, "incidents_analyzed": len(incidents)}

@app.get("/health")
def health():
    return {"status": "ok"}
