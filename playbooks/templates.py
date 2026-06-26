from dataclasses import dataclass


@dataclass(frozen=True)
class PlaybookTemplate:
    key: str
    title: str
    summary: str
    steps: tuple[str, ...]


CREDENTIAL_DUMPING = PlaybookTemplate(
    key="credential_dumping_lsass",
    title="Credential Dumping / LSASS Response",
    summary="Validate suspected LSASS or credential dumping activity and guide containment.",
    steps=(
        "Confirm affected host and timestamp.",
        "Validate the LSASS access source process.",
        "Check whether the process is expected security tooling or administrative activity.",
        "Review user context and parent process.",
        "Search for related credential access or lateral movement alerts.",
        "If true positive, isolate the host or approve containment action.",
        "Force password reset for potentially affected accounts.",
        "Add analyst conclusion and close/reclassify the incident.",
    ),
)

BRUTE_FORCE = PlaybookTemplate(
    key="brute_force",
    title="Brute Force Response",
    summary="Investigate failed authentication bursts and possible account compromise.",
    steps=(
        "Identify target account and source IP/host.",
        "Count failed login attempts and timeframe.",
        "Check for successful login after failures.",
        "Validate whether source is expected scanner/service.",
        "Lock or reset account if suspicious.",
        "Block source or escalate.",
    ),
)

NEW_USER_PERSISTENCE = PlaybookTemplate(
    key="new_user_persistence",
    title="New User / Persistence Response",
    summary="Validate account creation activity and persistence risk.",
    steps=(
        "Identify created account.",
        "Confirm creator/admin context.",
        "Validate change ticket or legitimate admin action.",
        "Check group membership and privileges.",
        "Disable account if unauthorized.",
        "Review related persistence indicators.",
    ),
)

POWERSHELL_EXECUTION = PlaybookTemplate(
    key="powershell_encoded_command",
    title="PowerShell Encoded Command / Script Execution Response",
    summary="Inspect suspicious PowerShell execution and related host activity.",
    steps=(
        "Decode or inspect the PowerShell command if available.",
        "Identify parent process and user.",
        "Check execution policy bypass, download cradle, or suspicious flags.",
        "Search host for related process/network/file events.",
        "Contain host if malicious.",
        "Add detection tuning notes if benign.",
    ),
)

SCHEDULED_TASK = PlaybookTemplate(
    key="scheduled_task_persistence",
    title="Scheduled Task Persistence Response",
    summary="Investigate suspicious scheduled task creation or modification.",
    steps=(
        "Identify task name, command, creator, and schedule.",
        "Validate legitimate administrative purpose.",
        "Check payload path and persistence intent.",
        "Remove or disable task if malicious.",
        "Search for related account/process activity.",
    ),
)

GENERIC = PlaybookTemplate(
    key="generic_suspicious_alert",
    title="Generic Suspicious Alert Response",
    summary="General analyst workflow for suspicious alerts without a specialized playbook.",
    steps=(
        "Confirm host, user, rule, timestamp, and severity.",
        "Review AI reasoning and recommended action.",
        "Correlate with Wazuh logs.",
        "Decide true positive or false positive.",
        "Document analyst conclusion.",
        "Approve/reject or escalate.",
    ),
)


def _text_contains(text: str, *needles: str) -> bool:
    return any(needle.lower() in text for needle in needles)


def select_template(incident) -> PlaybookTemplate:
    mitre = (incident.mitre_technique or "").lower()
    rule_id = str(incident.rule_id or "")
    description = (incident.rule_description or "").lower()

    if (
        "t1003" in mitre
        or rule_id in {"100001", "100002", "100003"}
        or _text_contains(description, "lsass", "mimikatz", "credential dumping")
    ):
        return CREDENTIAL_DUMPING

    if "t1110" in mitre or _text_contains(description, "brute force", "multiple failed logins"):
        return BRUTE_FORCE

    if (
        "t1136" in mitre
        or rule_id == "100005"
        or _text_contains(description, "new user", "account created", "new account created")
    ):
        return NEW_USER_PERSISTENCE

    if (
        "t1059" in mitre
        or rule_id == "100006"
        or _text_contains(description, "powershell", "encoded command")
    ):
        return POWERSHELL_EXECUTION

    if "t1053" in mitre or rule_id == "100007" or _text_contains(description, "scheduled task"):
        return SCHEDULED_TASK

    return GENERIC
