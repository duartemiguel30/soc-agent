from typing import TypedDict, Optional

class AlertState(TypedDict):
    # Raw alert from Wazuh
    raw_alert: dict

    # Enriched context
    agent_name: str
    rule_id: str
    rule_description: str
    rule_level: int
    mitre_technique: str
    timestamp: str

    # AI analysis
    classification: str        # true_positive / false_positive
    confidence: int            # 0-100
    severity: str              # low / medium / high / critical
    reasoning: str
    recommended_action: str

    # Decision
    decision: str              # auto_response / human_review / critical_alert

    # Final
    incident_id: Optional[str]
    status: str                # processed / pending_human / error
