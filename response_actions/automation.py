import logging

from playbooks.service import log_action_event
from response_actions.registry import get_response_action
from response_actions.service import observable_map, response_action_config, safe_action_result_for_persistence

logger = logging.getLogger(__name__)

AUTOMATION_ACTOR = "system:auto_response"
SEVERITY_RANK = {"unknown": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def severity_allows(incident, min_severity: str) -> bool:
    incident_severity = str(getattr(incident, "severity", "") or "unknown").strip().lower()
    required = (min_severity or "high").strip().lower()
    return SEVERITY_RANK.get(incident_severity, 0) >= SEVERITY_RANK.get(required, 3)


def decision_allows(incident, required_decision: str | None) -> bool:
    if not required_decision:
        return True
    return str(getattr(incident, "decision", "") or "").strip().lower() == required_decision.strip().lower()


def automated_event_type(result: dict, mode: str) -> str:
    if not result.get("ok"):
        return "automated_response_action_failed"
    if mode == "dry_run" or result.get("mode") == "dry_run":
        return "automated_response_action_dry_run"
    return "automated_response_action_executed"


def automated_message(action, result: dict, mode: str) -> str:
    target = result.get("target")
    target_text = f" for {target}" if target else ""
    if not result.get("ok"):
        return f"Automated response action failed: {action.display_name}{target_text}. {result.get('message') or ''}".strip()
    if mode == "dry_run" or result.get("mode") == "dry_run":
        return f"Automated response dry-run completed: {action.display_name}{target_text}."
    return f"Automated response executed: {action.display_name}{target_text}."


def run_automated_response_actions(db, incident, observables) -> list[dict]:
    config = response_action_config()
    attempts: list[dict] = []

    if not config.get("auto_response_actions_enabled"):
        return attempts
    mode = config.get("auto_response_action_mode")
    if mode not in {"dry_run", "execute"}:
        logger.warning("Invalid AUTO_RESPONSE_ACTION_MODE=%r; skipping automation", mode)
        return attempts
    if str(getattr(incident, "status", "") or "").lower() in {"approved", "rejected"}:
        return attempts
    if not severity_allows(incident, config.get("auto_response_min_severity", "high")):
        return attempts
    if not decision_allows(incident, config.get("auto_response_require_decision")):
        return attempts

    mapped = observable_map(observables)
    mapped.setdefault("incident_id", [incident.id])
    reason = (
        f"Automated policy: severity>={config.get('auto_response_min_severity')}, "
        f"decision={config.get('auto_response_require_decision') or 'any'}, mode={mode}."
    )

    for action_key in sorted(config.get("auto_response_allowed_actions") or []):
        action = get_response_action(action_key)
        if not action:
            attempts.append(
                {
                    "event_type": "automated_response_action_failed",
                    "action_key": action_key,
                    "success": False,
                    "details": {"action_key": action_key, "mode": mode, "result_status": "unavailable", "message": "Action is not registered."},
                }
            )
            continue

        try:
            availability = action.availability(mapped, config)
            if not availability.get("available"):
                result = {
                    "ok": False,
                    "mode": mode,
                    "status": availability.get("status") or "unavailable",
                    "target": availability.get("target"),
                    "message": availability.get("reason"),
                }
            elif mode == "dry_run":
                result = action.dry_run(mapped, config)
            else:
                result = action.execute(mapped, config, reason=reason)
        except Exception as exc:
            logger.exception("Automated response action failed for incident %s action %s", incident.id, action_key)
            result = {"ok": False, "mode": mode, "status": "failed", "message": str(exc)}

        event_type = automated_event_type(result, mode)
        metadata = {
            "action_key": action_key,
            "mode": result.get("mode") or mode,
            "actor": AUTOMATION_ACTOR,
            "reason": reason,
            "target_summary": result.get("target"),
            "result_status": result.get("status") or ("executed" if result.get("ok") else "failed"),
            "command_summary": result.get("command_summary"),
            "result": safe_action_result_for_persistence(result),
        }
        log_action_event(
            db,
            incident.id,
            AUTOMATION_ACTOR,
            event_type,
            automated_message(action, result, mode),
            metadata,
        )
        attempts.append(
            {
                "event_type": event_type,
                "action_key": action_key,
                "success": bool(result.get("ok")),
                "details": metadata,
            }
        )

    return attempts
