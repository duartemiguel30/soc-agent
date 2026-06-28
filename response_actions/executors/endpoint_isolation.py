from response_actions.executors.common import (
    first_observable,
    is_protected_value,
    protected_set,
    render_command_template,
    run_command,
    safe_command_summary,
    validate_target,
)


class IsolateEndpointAction:
    key = "isolate_endpoint"
    display_name = "Isolate endpoint"
    description = "Run a configured lab isolation command for the affected endpoint."
    risk_level = "critical"
    required_observables = ("host", "agent_name", "agent_ip")

    def _target_values(self, observable_map: dict[str, list[str]], config: dict) -> tuple[dict[str, str] | None, str | None, str | None]:
        host = first_observable(observable_map, ("host", "source_workstation", "agent_name"))
        agent = first_observable(observable_map, ("agent_name", "agent_id")) or host or ""
        agent_ip = first_observable(observable_map, ("agent_ip",)) or ""
        target = host or agent_ip
        target, error = validate_target(target, "endpoint target")
        if error:
            return None, None, error

        protected = protected_set(config.get("endpoint_isolation_protected_hosts"))
        if is_protected_value(target, protected) or is_protected_value(host, protected) or is_protected_value(agent_ip, protected):
            return None, target, "Endpoint target is protected by ENDPOINT_ISOLATION_PROTECTED_HOSTS."

        incident_id = first_observable(observable_map, ("incident_id",)) or ""
        return {"host": host or target, "agent": agent, "agent_ip": agent_ip, "incident_id": incident_id}, target, None

    def availability(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        if not config["response_actions_enabled"]:
            return {"available": False, "reason": "Response actions are disabled by configuration."}
        if not config.get("endpoint_isolation_enabled"):
            return {"available": False, "reason": "Endpoint isolation is disabled by configuration.", "status": "unavailable"}
        if config.get("endpoint_isolation_mode") not in {"dry_run", "execute"}:
            return {"available": False, "reason": "ENDPOINT_ISOLATION_MODE must be dry_run or execute.", "status": "unavailable"}
        values, target, error = self._target_values(observable_map, config)
        if error:
            return {
                "available": False,
                "reason": error,
                "status": "protected" if "protected" in error.lower() else "unavailable",
                "target": target,
            }
        if config.get("endpoint_isolation_mode") == "execute" and not config.get("endpoint_isolation_command_template"):
            return {
                "available": False,
                "reason": "ENDPOINT_ISOLATION_COMMAND_TEMPLATE is required for execute mode.",
                "status": "unavailable",
                "target": target,
            }
        return {"available": True, "reason": f"Endpoint target {target} is eligible.", "status": "available", "target": target}

    def dry_run(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        values, target, error = self._target_values(observable_map, config)
        if error:
            return {"ok": False, "status": "protected" if "protected" in error.lower() else "unavailable", "target": target, "message": error}
        template = config.get("endpoint_isolation_command_template") or ""
        command, command_error = render_command_template(template, values or {}) if template else (None, None)
        return {
            "ok": True,
            "mode": "dry_run",
            "status": "dry_run",
            "target": target,
            "command_summary": safe_command_summary("endpoint isolation") if command else None,
            "message": f"Would isolate endpoint {target}.",
            "command_template_configured": bool(template and not command_error),
        }

    def execute(self, observable_map: dict[str, list[str]], config: dict, reason: str | None = None) -> dict:
        availability = self.availability(observable_map, config)
        if not availability["available"]:
            return {"ok": False, "status": availability.get("status", "failed"), "target": availability.get("target"), "message": availability["reason"]}
        if config.get("endpoint_isolation_mode") == "dry_run":
            result = self.dry_run(observable_map, config)
            result["reason"] = reason
            result["message"] = f"Endpoint isolation dry-run confirmed for {result['target']}. No command was executed."
            return result

        values, target, error = self._target_values(observable_map, config)
        if error:
            return {"ok": False, "mode": "execute", "status": "protected" if "protected" in error.lower() else "failed", "target": target, "message": error}
        template = config.get("endpoint_isolation_command_template") or ""
        command, command_error = render_command_template(template, values or {})
        if command_error:
            return {"ok": False, "mode": "execute", "status": "failed", "target": target, "message": command_error}

        result = run_command(command, int(config.get("endpoint_isolation_timeout_seconds") or 20))
        return {
            **result,
            "mode": "execute",
            "status": "executed" if result.get("ok") else "failed",
            "target": target,
            "reason": reason,
            "command_summary": safe_command_summary("endpoint isolation"),
            "message": f"Endpoint isolation command completed for {target}." if result.get("ok") else result.get("message", "Endpoint isolation failed."),
        }
