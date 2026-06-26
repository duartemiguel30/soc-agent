import os

from db.models import IncidentObservable
from playbooks.service import log_action_event
from response_actions.registry import get_response_action, get_response_actions


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def response_action_config() -> dict:
    protected_users = os.getenv("AD_PROTECTED_USERS", "")
    return {
        "response_actions_enabled": env_bool("RESPONSE_ACTIONS_ENABLED", True),
        "ad_actions_enabled": env_bool("AD_ACTIONS_ENABLED", False),
        "ad_action_mode": os.getenv("AD_ACTION_MODE", "dry_run").strip().lower(),
        "ad_domain": os.getenv("AD_DOMAIN", "WINDOMAIN"),
        "ad_domain_controller": os.getenv("AD_DOMAIN_CONTROLLER", "dc.windomain.local"),
        "ad_username": os.getenv("AD_USERNAME", ""),
        "ad_password": os.getenv("AD_PASSWORD", ""),
        "ad_protected_users": [item.strip() for item in protected_users.split(",") if item.strip()],
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


def describe_actions(db, incident_id: str) -> list[dict]:
    observables = list_observables(db, incident_id)
    mapped = observable_map(observables)
    config = response_action_config()
    descriptions = []
    for action in get_response_actions():
        availability = action.availability(mapped, config)
        dry_run = action.dry_run(mapped, config) if availability["available"] else None
        descriptions.append(
            {
                "key": action.key,
                "name": action.display_name,
                "description": action.description,
                "risk_level": action.risk_level,
                "required_observables": list(action.required_observables),
                "available": availability["available"],
                "availability_reason": availability["reason"],
                "needs_human_review": availability.get("needs_human_review", False),
                "dry_run": dry_run,
            }
        )
    return descriptions


def dry_run_action(db, incident_id: str, action_key: str) -> dict:
    action = get_response_action(action_key)
    if not action:
        return {"ok": False, "status_code": 404, "message": "Response action not found."}

    observables = list_observables(db, incident_id)
    mapped = observable_map(observables)
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
            "result": {key: value for key, value in result.items() if key not in {"status_code"}},
        },
    )
    db.commit()
    return result
