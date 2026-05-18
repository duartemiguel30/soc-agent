TRIAGE_PROMPT = """
You are an expert SOC analyst. Analyze the following security alert and provide a structured assessment.

Alert Details:
- Agent: {agent_name}
- Rule ID: {rule_id}
- Description: {rule_description}
- Severity Level: {rule_level}/15
- MITRE Technique: {mitre_technique}
- Timestamp: {timestamp}

Raw Alert Data:
{raw_alert}

Respond ONLY with a valid JSON object with this exact structure:
{{
    "classification": "true_positive" or "false_positive",
    "confidence": <integer 0-100>,
    "severity": "low" or "medium" or "high" or "critical",
    "reasoning": "<brief explanation of your assessment>",
    "recommended_action": "<specific action to take>"
}}

Guidelines:
- confidence >= 85: you are highly certain
- confidence 60-84: you are moderately certain, human review recommended
- confidence < 60: you are uncertain, human must decide
- Be concise in reasoning (max 2 sentences)
- recommended_action should be specific and actionable
"""
