import time
import json
import subprocess
import logging
from langchain_google_genai import ChatGoogleGenerativeAI
from agent.state import AlertState
from agent.prompts import TRIAGE_PROMPT
from config import GEMINI_API_KEY

logger = logging.getLogger(__name__)

llm = ChatGoogleGenerativeAI(
    model="gemini-3.1-flash-lite",
    google_api_key=GEMINI_API_KEY,
    temperature=0
)
_last_call = 0.0
_min_interval = 13
def enrich_alert(state: AlertState) -> AlertState:
    """Extrai e normaliza os campos do alerta raw do Wazuh."""
    alert = state["raw_alert"]

    rule = alert.get("rule", {})
    agent = alert.get("agent", {})
    mitre = rule.get("mitre", {})
    techniques = mitre.get("technique", [])
    mitre_technique = techniques[0] if techniques else "Unknown"

    return {
        **state,
        "agent_name": agent.get("name", "unknown"),
        "rule_id": str(rule.get("id", "")),
        "rule_description": rule.get("description", ""),
        "rule_level": int(rule.get("level", 0)),
        "mitre_technique": mitre_technique,
        "timestamp": alert.get("timestamp", ""),
    }

def analyze_with_ai(state: AlertState) -> AlertState:
    """Envia o alerta ao Gemini e obtém classificação."""
    global _last_call
    elapsed = time.time() - _last_call
    if elapsed < _min_interval:
        wait = _min_interval - elapsed
        logger.info(f"Rate limiting: waiting {wait:.1f}s before Gemini call")
        time.sleep(wait)
    _last_call = time.time()

    prompt = TRIAGE_PROMPT.format(
        agent_name=state["agent_name"],
        rule_id=state["rule_id"],
        rule_description=state["rule_description"],
        rule_level=state["rule_level"],
        mitre_technique=state["mitre_technique"],
        timestamp=state["timestamp"],
        raw_alert=json.dumps(state["raw_alert"], indent=2)
    )

    try:
        response = llm.invoke(prompt)

        content = response.content
        if isinstance(content, list):
        	content = "".join([c.get("text", "") if isinstance(c, dict) else str(c) for c in content])
        	content = content.strip()

        # Remove markdown code blocks if present
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]

        result = json.loads(content)

        return {
            **state,
            "classification": result.get("classification", "unknown"),
            "confidence": int(result.get("confidence", 0)),
            "severity": result.get("severity", "unknown"),
            "reasoning": result.get("reasoning", ""),
            "recommended_action": result.get("recommended_action", ""),
        }
    except Exception as e:
        logger.error(f"AI analysis failed: {e}")
        return {
            **state,
            "classification": "unknown",
            "confidence": 0,
            "severity": "unknown",
            "reasoning": f"AI analysis failed: {str(e)}",
            "recommended_action": "Manual review required",
        }

def decide_action(state: AlertState) -> AlertState:
    """Decide o que fazer com base na confiança e nível do alerta."""
    confidence = state["confidence"]
    level = state["rule_level"]

    if confidence >= 85 and level < 12:
        decision = "auto_response"
        status = "processed"
    elif confidence < 60 or level == 15:
        decision = "critical_alert"
        status = "pending_human"
    else:
        decision = "human_review"
        status = "pending_human"

    logger.info(f"Decision: {decision} (confidence={confidence}, level={level})")

    return {
        **state,
        "decision": decision,
        "status": status,
    }

def route_decision(state: AlertState) -> str:
    """LangGraph router — devolve o nome do próximo nó."""
    return state["decision"]


def auto_response(state: AlertState) -> AlertState:
    """Resposta automática para alertas de alta confiança."""
    logger.info(f"AUTO RESPONSE: {state['recommended_action']} for {state['agent_name']}")
    
    # Tenta extrair IP do alerta e bloquear
    try:
        raw = state.get("raw_alert", {})
        src_ip = (
            raw.get("data", {}).get("srcip") or
            raw.get("data", {}).get("win", {}).get("eventdata", {}).get("sourceIp")
        )
        if src_ip and src_ip not in ["127.0.0.1", "::1"]:
            result = subprocess.run(
                ["sudo", "iptables", "-A", "INPUT", "-s", src_ip, "-j", "DROP"],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                logger.info(f"BLOCKED IP: {src_ip}")
            else:
                logger.warning(f"Failed to block IP {src_ip}: {result.stderr}")
    except Exception as e:
        logger.error(f"block_ip failed: {e}")

    return {**state, "status": "processed"}

def human_review(state: AlertState) -> AlertState:
    """Escala para revisão humana."""
    logger.warning(f"HUMAN REVIEW REQUIRED: {state['rule_description']} on {state['agent_name']}")
    return {**state, "status": "pending_human"}

def critical_alert(state: AlertState) -> AlertState:
    """Alerta crítico — AI tem baixa confiança ou nível máximo."""
    logger.error(f"CRITICAL ALERT: {state['rule_description']} on {state['agent_name']} - confidence={state['confidence']}%")
    return {**state, "status": "pending_human"}
