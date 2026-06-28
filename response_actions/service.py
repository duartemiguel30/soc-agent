import json
import os
from typing import Any

from db.models import IncidentActionEvent, IncidentObservable
from playbooks.service import log_action_event
from response_actions.registry import get_response_action, get_response_actions


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return max(1, int(value))
    except ValueError:
        return default


def response_action_config() -> dict:
    protected_users = os.getenv("AD_PROTECTED_USERS", "")
    protected_hosts = os.getenv("ENDPOINT_ISOLATION_PROTECTED_HOSTS", "")
    allowed_auto_actions = os.getenv("AUTO_RESPONSE_ALLOWED_ACTIONS", "block_source_ip,isolate_endpoint")
    return {
        "response_actions_enabled": env_bool("RESPONSE_ACTIONS_ENABLED", True),
        "ad_actions_enabled": env_bool("AD_ACTIONS_ENABLED", False),
        "ad_action_mode": os.getenv("AD_ACTION_MODE", "dry_run").strip().lower(),
        "ad_domain": os.getenv("AD_DOMAIN", "WINDOMAIN"),
        "ad_domain_controller": os.getenv("AD_DOMAIN_CONTROLLER", "dc.windomain.local"),
        "ad_ldap_server": os.getenv("AD_LDAP_SERVER", "").strip(),
        "ad_base_dn": os.getenv("AD_BASE_DN", "DC=windomain,DC=local").strip(),
        "ad_bind_dn": os.getenv("AD_BIND_DN", "").strip(),
        "ad_bind_password": os.getenv("AD_BIND_PASSWORD", ""),
        "ad_protected_users": [item.strip() for item in protected_users.split(",") if item.strip()],
        "endpoint_isolation_enabled": env_bool("ENDPOINT_ISOLATION_ENABLED", False),
        "endpoint_isolation_mode": os.getenv("ENDPOINT_ISOLATION_MODE", "dry_run").strip().lower(),
        "endpoint_isolation_protected_hosts": [
            item.strip() for item in protected_hosts.split(",") if item.strip()
        ],
        "endpoint_isolation_command_template": os.getenv("ENDPOINT_ISOLATION_COMMAND_TEMPLATE", ""),
        "endpoint_isolation_timeout_seconds": env_int("ENDPOINT_ISOLATION_TIMEOUT_SECONDS", 20),
        "host_context_collection_enabled": env_bool("HOST_CONTEXT_COLLECTION_ENABLED", False),
        "host_context_collection_mode": os.getenv("HOST_CONTEXT_COLLECTION_MODE", "dry_run").strip().lower(),
        "host_context_command_template": os.getenv("HOST_CONTEXT_COMMAND_TEMPLATE", ""),
        "host_context_timeout_seconds": env_int("HOST_CONTEXT_TIMEOUT_SECONDS", 20),
        "auto_response_actions_enabled": env_bool("AUTO_RESPONSE_ACTIONS_ENABLED", False),
        "auto_response_action_mode": os.getenv("AUTO_RESPONSE_ACTION_MODE", "dry_run").strip().lower(),
        "auto_response_allowed_actions": {item.strip() for item in allowed_auto_actions.split(",") if item.strip()},
        "auto_response_min_severity": os.getenv("AUTO_RESPONSE_MIN_SEVERITY", "high").strip().lower(),
        "auto_response_require_decision": os.getenv("AUTO_RESPONSE_REQUIRE_DECISION", "auto_response").strip().lower(),
    }


def observable_map(observables: list[IncidentObservable]) -> dict[str, list[str]]:
    mapped: dict[str, list[str]] = {}
    for observable in observables:
        mapped.setdefault(observable.key, []).append(observable.value)
    return mapped


def list_observables(db, incident_id: str) -> list[IncidentObservable]:
    return (
        db.query(IncidentObservable)
        .filter(IncidentObservable.incident_id == incident_id)
        .order_by(IncidentObservable.key.asc(), IncidentObservable.id.asc())
        .all()
    )


def normalize_text(value: Any) -> str:
    return str(value or "").lower()


def text_contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text for keyword in keywords)


def suggested_metadata(action_key: str, incident, mapped: dict[str, list[str]], available: bool) -> tuple[bool, str | None]:
    if not available:
        return False, None

    context = " ".join(
        normalize_text(value)
        for value in (
            getattr(incident, "recommended_action", None),
            getattr(incident, "rule_description", None),
            getattr(incident, "mitre_technique", None),
            getattr(incident, "classification", None),
            getattr(incident, "reasoning", None),
        )
    )

    if action_key == "block_source_ip":
        if not mapped.get("src_ip"):
            return False, None
        if text_contains_any(context, ("block", "firewall", "deny", "source ip", "src_ip", " ip ", "containment")):
            return True, "Incident context mentions IP blocking, firewall denial, or containment and a source IP is available."
        if text_contains_any(context, ("source", "remote address", "network")):
            return True, "Incident context appears source-IP based and a source IP is available."
        return False, None

    if action_key == "disable_ad_account":
        has_username = any(mapped.get(key) for key in ("target_username", "subject_username", "user"))
        if not has_username:
            return False, None
        if text_contains_any(
            context,
            (
                "disable account",
                "lock account",
                "user account",
                "ad account",
                "compromised account",
                "account compromise",
            ),
        ):
            return True, "Incident context mentions account disablement or account compromise and a username is available."
        if text_contains_any(context, ("brute force", "failed login", "failed logon", "suspicious login", "t1110")):
            return True, "Login or brute-force context with a username can justify account containment review."
        return False, None

    if action_key == "isolate_endpoint":
        if not any(mapped.get(key) for key in ("host", "agent_name", "agent_ip", "source_workstation")):
            return False, None
        if text_contains_any(context, ("isolate", "contain", "quarantine", "endpoint", "host")):
            return True, "Incident context mentions endpoint containment and an endpoint target is available."
        return False, None

    if action_key == "collect_host_context":
        if any(mapped.get(key) for key in ("host", "agent_name", "agent_ip", "source_workstation")):
            return True, "Endpoint context collection is available for this incident target."
        return False, None

    return False, None


def action_automation_eligible(action_key: str, config: dict) -> bool:
    return action_key in (config.get("auto_response_allowed_actions") or set())


def last_automated_event(db, incident_id: str, action_key: str) -> dict | None:
    events = (
        db.query(IncidentActionEvent)
        .filter(
            IncidentActionEvent.incident_id == incident_id,
            IncidentActionEvent.event_type.in_(
                [
                    "automated_response_action_dry_run",
                    "automated_response_action_executed",
                    "automated_response_action_failed",
                ]
            ),
        )
        .order_by(IncidentActionEvent.created_at.desc(), IncidentActionEvent.id.desc())
        .all()
    )
    for event in events:
        if not event.metadata_json:
            continue
        try:
            metadata = json.loads(event.metadata_json)
        except json.JSONDecodeError:
            continue
        if metadata.get("action_key") == action_key:
            return {
                "event_type": event.event_type,
                "created_at": event.created_at,
                "status": metadata.get("result_status"),
                "mode": metadata.get("mode"),
            }
    return None


def describe_actions(db, incident_id: str, incident=None) -> list[dict]:
    observables = list_observables(db, incident_id)
    mapped = observable_map(observables)
    mapped.setdefault("incident_id", [incident_id])
    config = response_action_config()
    descriptions = []
    for action in get_response_actions():
        availability = action.availability(mapped, config)
        dry_run = action.dry_run(mapped, config) if availability["available"] else None
        suggested, suggested_reason = suggested_metadata(action.key, incident, mapped, availability["available"])
        category = "suggested" if availability["available"] and suggested else "available" if availability["available"] else "unavailable"
        mode = dry_run.get("mode") if dry_run else None
        result_status = dry_run.get("status") if dry_run else availability.get("status")
        descriptions.append(
            {
                "key": action.key,
                "name": action.display_name,
                "description": action.description,
                "risk_level": action.risk_level,
                "required_observables": list(action.required_observables),
                "available": availability["available"],
                "availability_reason": availability["reason"],
                "availability_status": availability.get("status") or ("available" if availability["available"] else "unavailable"),
                "needs_human_review": availability.get("needs_human_review", False),
                "dry_run": dry_run,
                "mode": mode,
                "result_status": result_status,
                "suggested": suggested,
                "suggested_reason": suggested_reason,
                "category": category,
                "automation_eligible": action_automation_eligible(action.key, config),
                "automated_attempt": last_automated_event(db, incident_id, action.key),
            }
        )
    return descriptions


def dry_run_action(db, incident_id: str, action_key: str) -> dict:
    action = get_response_action(action_key)
    if not action:
        return {"ok": False, "status_code": 404, "message": "Response action not found."}

    observables = list_observables(db, incident_id)
    mapped = observable_map(observables)
    mapped.setdefault("incident_id", [incident_id])
    config = response_action_config()
    availability = action.availability(mapped, config)
    if not availability["available"]:
        return {"ok": False, "status_code": 400, "message": availability["reason"]}

    return action.dry_run(mapped, config)


def action_event_type(result: dict) -> str:
    if not result.get("ok"):
        return "response_action_failed"
    if result.get("mode") == "dry_run":
        return "response_action_dry_run_confirmed"
    return "response_action_executed"


SAFE_RESULT_KEYS = {
    "ok",
    "mode",
    "status",
    "target",
    "message",
    "returncode",
    "already_present",
    "needs_human_review",
    "command_template_configured",
    "command_summary",
    "stdout_truncated",
    "stderr_truncated",
}


def safe_action_result_for_persistence(result: dict) -> dict:
    return {key: value for key, value in result.items() if key in SAFE_RESULT_KEYS}


def action_event_message(action, result: dict) -> str:
    if result.get("mode") == "dry_run" and result.get("ok"):
        target = result.get("target")
        target_text = f" for {target}" if target else ""
        if action.key == "disable_ad_account":
            return (
                f"Analyst confirmed AD account disable dry-run simulation{target_text}. "
                "No real account was disabled."
            )
        return (
            f"Analyst confirmed dry-run simulation for {action.display_name}{target_text}. "
            "No real account or system state was changed."
        )
    return result.get("message") or f"Response action {action.display_name} completed."


def execute_action(db, incident_id: str, action_key: str, actor: str | None, reason: str | None) -> dict:
    action = get_response_action(action_key)
    if not action:
        return {"ok": False, "status_code": 404, "message": "Response action not found."}

    observables = list_observables(db, incident_id)
    mapped = observable_map(observables)
    mapped.setdefault("incident_id", [incident_id])
    config = response_action_config()
    availability = action.availability(mapped, config)
    if not availability["available"]:
        message = availability["reason"]
        log_action_event(
            db,
            incident_id,
            actor,
            "response_action_failed",
            f"Response action failed policy checks: {action.display_name}. {message}",
            {"action_key": action.key, "reason": reason, "availability_reason": message},
        )
        db.commit()
        return {"ok": False, "status_code": 400, "message": message}

    result = action.execute(mapped, config, reason=reason)
    event_type = action_event_type(result)
    log_action_event(
        db,
        incident_id,
        actor,
        event_type,
        action_event_message(action, result),
        {
            "action_key": action.key,
            "risk_level": action.risk_level,
            "reason": reason,
            "mode": result.get("mode") or "execute",
            "actor": actor,
            "target": result.get("target"),
            "target_summary": result.get("target"),
            "result_status": result.get("status") or ("executed" if result.get("ok") else "failed"),
            "command_summary": result.get("command_summary"),
            "result": safe_action_result_for_persistence(result),
        },
    )
    db.commit()
    return result
