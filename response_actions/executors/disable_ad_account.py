import re


DEFAULT_PROTECTED_USERS = {
    "administrator",
    "admin",
    "krbtgt",
    "vagrant",
    "domain admins",
    "enterprise admins",
    "schema admins",
}

USERNAME_RE = re.compile(r"^[A-Za-z0-9._@\\-]{1,128}$")


class DisableAdAccountAction:
    key = "disable_ad_account"
    display_name = "Disable AD account"
    description = "Disable a Windows Active Directory account identified in the incident observables."
    risk_level = "high"
    required_observables = ("target_username", "subject_username", "user")

    def _username(self, observable_map: dict[str, list[str]]) -> str | None:
        for key in self.required_observables:
            values = observable_map.get(key) or []
            for value in values:
                cleaned = value.strip()
                if cleaned:
                    return cleaned
        return None

    def _protected_users(self, config: dict) -> set[str]:
        configured = config.get("ad_protected_users") or []
        return {item.strip().lower() for item in configured if item.strip()} | DEFAULT_PROTECTED_USERS

    def _validate_username(self, username: str | None, config: dict) -> tuple[str | None, str | None]:
        if not username:
            return None, "No target_username, subject_username, or user observable is available."
        if not USERNAME_RE.fullmatch(username):
            return None, "Username contains unsupported characters."
        if username.endswith("$"):
            return None, "Machine accounts are not eligible for this action."

        leaf = username.rsplit("\\", 1)[-1].split("@", 1)[0].strip().lower()
        protected = self._protected_users(config)
        if leaf in protected or username.strip().lower() in protected:
            return None, "Username is protected by the AD action denylist."
        if "domain admin" in username.lower() or "enterprise admin" in username.lower():
            return None, "Privileged admin-like accounts are protected by default."
        return username, None

    def availability(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        if not config["response_actions_enabled"]:
            return {"available": False, "reason": "Response actions are disabled by configuration."}
        if not config["ad_actions_enabled"]:
            return {"available": False, "reason": "AD response actions are disabled by configuration."}
        if config["ad_action_mode"] == "disabled":
            return {"available": False, "reason": "AD_ACTION_MODE is disabled."}

        username, error = self._validate_username(self._username(observable_map), config)
        if error:
            return {"available": False, "reason": error}

        if config["ad_action_mode"] not in {"dry_run", "winrm", "powershell_remoting"}:
            return {"available": False, "reason": "AD_ACTION_MODE must be dry_run, disabled, winrm, or powershell_remoting."}

        if config["ad_action_mode"] in {"winrm", "powershell_remoting"}:
            return {
                "available": False,
                "reason": "Real AD disable execution is not implemented in this build; use dry_run and complete manually.",
                "needs_human_review": True,
            }

        return {"available": True, "reason": f"Account {username} can be evaluated in dry-run mode."}

    def dry_run(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        username, error = self._validate_username(self._username(observable_map), config)
        if error:
            return {"ok": False, "message": error}
        domain = config.get("ad_domain") or "WINDOMAIN"
        controller = config.get("ad_domain_controller") or "dc.windomain.local"
        return {
            "ok": True,
            "mode": "dry_run",
            "target": username,
            "domain": domain,
            "domain_controller": controller,
            "command": f"Disable-ADAccount -Identity {username}",
            "message": f"Would disable AD account {username} in {domain} via {controller}.",
        }

    def execute(self, observable_map: dict[str, list[str]], config: dict, reason: str | None = None) -> dict:
        availability = self.availability(observable_map, config)
        if not availability["available"]:
            return {
                "ok": False,
                "needs_human_review": availability.get("needs_human_review", False),
                "message": availability["reason"],
            }

        if config["ad_action_mode"] == "dry_run":
            result = self.dry_run(observable_map, config)
            result["message"] = (
                f"Analyst confirmed AD account disable dry-run for {result['target']}. "
                "No real account was disabled because AD_ACTION_MODE=dry_run."
            )
            result["reason"] = reason
            return result

        return {
            "ok": False,
            "needs_human_review": True,
            "message": "Real AD execution is not implemented; complete this action manually after review.",
        }
