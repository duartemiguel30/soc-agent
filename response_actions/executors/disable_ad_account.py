import re

try:
    import ldap3
except ImportError:  # Optional dependency; only needed when AD_ACTION_MODE=execute.
    ldap3 = None


DEFAULT_PROTECTED_USERS = {
    "administrator",
    "admin",
    "krbtgt",
    "vagrant",
    "domain admins",
    "enterprise admins",
    "schema admins",
}

PROTECTED_GROUP_NAMES = {
    "domain admins",
    "enterprise admins",
    "schema admins",
    "administrators",
    "account operators",
    "server operators",
    "backup operators",
    "print operators",
}

PROTECTED_PRIMARY_GROUP_IDS = {"512", "518", "519", "544", "548", "549", "550", "551"}

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

    def _protected_names(self, config: dict) -> set[str]:
        return self._protected_users(config) | PROTECTED_GROUP_NAMES

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

    def _dn_contains_protected_group(self, dn: str, protected_names: set[str]) -> bool:
        normalized = str(dn or "").lower()
        for name in protected_names:
            escaped = name.replace(",", "\\,")
            if f"cn={name}," in normalized or f"cn={escaped}," in normalized:
                return True
        return False

    def _entry_values(self, entry, attribute: str) -> list[str]:
        try:
            value = getattr(entry, attribute).value
        except Exception:
            return []
        if value is None:
            return []
        if isinstance(value, (list, tuple, set)):
            return [str(item) for item in value if item is not None]
        return [str(value)]

    def _entry_is_protected(self, entry, config: dict) -> tuple[bool, str | None]:
        protected_names = self._protected_names(config)
        values_to_check = []
        values_to_check.extend(self._entry_values(entry, "sAMAccountName"))
        values_to_check.extend(self._entry_values(entry, "cn"))
        values_to_check.append(str(getattr(entry, "entry_dn", "") or ""))
        for value in values_to_check:
            normalized = value.strip().lower()
            leaf = normalized.rsplit("\\", 1)[-1].split("@", 1)[0]
            if normalized in protected_names or leaf in protected_names:
                return True, "AD account is protected by privileged group/admin metadata."
            if self._dn_contains_protected_group(normalized, protected_names):
                return True, "AD account is protected by privileged group/admin metadata."

        for dn in self._entry_values(entry, "memberOf"):
            if self._dn_contains_protected_group(dn, PROTECTED_GROUP_NAMES):
                return True, "AD account is protected by privileged group/admin metadata."

        admin_count = next(iter(self._entry_values(entry, "adminCount")), "").strip()
        if admin_count == "1":
            return True, "AD account is protected by privileged group/admin metadata."

        primary_group_id = next(iter(self._entry_values(entry, "primaryGroupID")), "").strip()
        if primary_group_id in PROTECTED_PRIMARY_GROUP_IDS:
            return True, "AD account is protected by privileged group/admin metadata."

        return False, None

    def availability(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        if not config["response_actions_enabled"]:
            return {"available": False, "reason": "Response actions are disabled by configuration."}
        if not config["ad_actions_enabled"]:
            return {"available": False, "reason": "AD response actions are disabled by configuration."}
        if config["ad_action_mode"] not in {"dry_run", "execute"}:
            return {"available": False, "reason": "AD_ACTION_MODE must be dry_run or execute."}

        username, error = self._validate_username(self._username(observable_map), config)
        if error:
            protected = "protected" in error.lower() or "privileged" in error.lower()
            return {"available": False, "reason": error, "status": "protected" if protected else "unavailable"}

        if config["ad_action_mode"] == "execute":
            missing = [
                key
                for key in ("ad_ldap_server", "ad_base_dn", "ad_bind_dn", "ad_bind_password")
                if not config.get(key)
            ]
            if missing:
                return {
                    "available": False,
                    "reason": f"AD LDAP execution is missing configuration: {', '.join(missing)}.",
                    "needs_human_review": True,
                    "status": "unavailable",
                }
            if ldap3 is None:
                return {
                    "available": False,
                    "reason": "Python package ldap3 is required for AD_ACTION_MODE=execute.",
                    "needs_human_review": True,
                    "status": "unavailable",
                }
            return {"available": True, "reason": f"Account {username} can be disabled through LDAP.", "status": "available"}

        return {"available": True, "reason": f"Account {username} can be evaluated in dry-run mode.", "status": "available"}

    def dry_run(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        username, error = self._validate_username(self._username(observable_map), config)
        if error:
            return {"ok": False, "message": error}
        domain = config.get("ad_domain") or "WINDOMAIN"
        controller = config.get("ad_ldap_server") or config.get("ad_domain_controller") or "dc.windomain.local"
        return {
            "ok": True,
            "mode": "dry_run",
            "status": "dry_run",
            "target": username,
            "domain": domain,
            "domain_controller": controller,
            "command_summary": "configured AD LDAP disable operation",
            "message": (
                f"Would disable AD account {username} in {domain} via {controller}. "
                "Username denylist checks passed; LDAP privileged membership checks run only in execute mode."
            ),
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

        username, error = self._validate_username(self._username(observable_map), config)
        if error:
            return {"ok": False, "status": "protected" if "protected" in error.lower() else "failed", "message": error}

        return self._execute_ldap_disable(username, config, reason)

    def _execute_ldap_disable(self, username: str, config: dict, reason: str | None) -> dict:
        if ldap3 is None:
            return {"ok": False, "status": "failed", "message": "ldap3 is required for AD LDAP execution."}

        server_name = config.get("ad_ldap_server")
        base_dn = config.get("ad_base_dn")
        bind_dn = config.get("ad_bind_dn")
        bind_password = config.get("ad_bind_password")
        if not all([server_name, base_dn, bind_dn, bind_password]):
            return {"ok": False, "status": "failed", "message": "AD LDAP execution is not fully configured."}

        server = ldap3.Server(server_name, get_info=ldap3.NONE)
        try:
            connection = ldap3.Connection(server, user=bind_dn, password=bind_password, auto_bind=True)
        except Exception:
            return {"ok": False, "status": "failed", "target": username, "message": "LDAP bind failed."}

        try:
            escaped_username = username.replace("\\", "\\5c").replace("*", "\\2a").replace("(", "\\28").replace(")", "\\29")
            if not connection.search(
                search_base=base_dn,
                search_filter=f"(&(objectClass=user)(sAMAccountName={escaped_username}))",
                attributes=[
                    "distinguishedName",
                    "sAMAccountName",
                    "cn",
                    "userAccountControl",
                    "memberOf",
                    "adminCount",
                    "primaryGroupID",
                ],
                size_limit=1,
            ):
                return {"ok": False, "status": "failed", "target": username, "message": "AD account was not found."}
            if not connection.entries:
                return {"ok": False, "status": "failed", "target": username, "message": "AD account was not found."}

            entry = connection.entries[0]
            protected, protected_reason = self._entry_is_protected(entry, config)
            if protected:
                return {
                    "ok": False,
                    "mode": "execute",
                    "status": "protected",
                    "target": username,
                    "message": protected_reason,
                }
            distinguished_name = str(entry.entry_dn)
            current_uac = int(str(entry.userAccountControl.value or "0"))
            disabled_uac = current_uac | 0x2
            if current_uac == disabled_uac:
                return {
                    "ok": True,
                    "mode": "execute",
                    "status": "executed",
                    "target": username,
                    "already_present": True,
                    "reason": reason,
                    "message": f"AD account {username} is already disabled.",
                }

            if not connection.modify(
                distinguished_name,
                {"userAccountControl": [(ldap3.MODIFY_REPLACE, [disabled_uac])]},
            ):
                return {"ok": False, "mode": "execute", "status": "failed", "target": username, "message": "LDAP modify failed."}

            return {
                "ok": True,
                "mode": "execute",
                "status": "executed",
                "target": username,
                "reason": reason,
                "command_summary": "configured AD LDAP disable operation",
                "message": f"Disabled AD account {username}.",
            }
        except Exception:
            return {"ok": False, "mode": "execute", "status": "failed", "target": username, "message": "LDAP disable failed."}
        finally:
            connection.unbind()
