import ipaddress
import os
import platform
import shutil
import subprocess


class BlockSourceIpAction:
    key = "block_source_ip"
    display_name = "Block source IP"
    description = "Add a local firewall drop rule for the source IP observed in this incident."
    risk_level = "medium"
    required_observables = ("src_ip",)

    def _source_ip(self, observable_map: dict[str, list[str]]) -> str | None:
        values = observable_map.get("src_ip") or []
        return values[0] if values else None

    def _validated_ip(self, value: str | None) -> tuple[str | None, str | None]:
        if not value:
            return None, "No src_ip observable is available for this incident."
        try:
            ip = ipaddress.ip_address(value)
        except ValueError:
            return None, "The src_ip observable is not a valid IP address."

        if ip.is_loopback or ip.is_multicast or ip.is_unspecified:
            return None, "The source IP is loopback, multicast, or unspecified and will not be blocked."
        return str(ip), None

    def availability(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        if not config["response_actions_enabled"]:
            return {"available": False, "reason": "Response actions are disabled by configuration."}

        ip, error = self._validated_ip(self._source_ip(observable_map))
        if error:
            return {"available": False, "reason": error}
        return {"available": True, "reason": f"Source IP {ip} is available."}

    def dry_run(self, observable_map: dict[str, list[str]], config: dict) -> dict:
        ip, error = self._validated_ip(self._source_ip(observable_map))
        if error:
            return {"ok": False, "message": error}

        return {
            "ok": True,
            "mode": "dry_run",
            "status": "dry_run",
            "target": ip,
            "command_summary": "configured local firewall block command",
            "message": f"Would add an iptables DROP rule for {ip}.",
        }

    def execute(self, observable_map: dict[str, list[str]], config: dict, reason: str | None = None) -> dict:
        availability = self.availability(observable_map, config)
        if not availability["available"]:
            return {"ok": False, "message": availability["reason"]}

        ip = self._source_ip(observable_map)
        if platform.system().lower() != "linux":
            return {
                "ok": False,
                "target": ip,
                "needs_human_review": True,
                "message": "Real IP blocking is only implemented for Linux iptables on this host.",
            }

        if not shutil.which("iptables"):
            return {
                "ok": False,
                "target": ip,
                "needs_human_review": True,
                "message": "iptables is not available on this host.",
            }

        check_command = self._iptables_command(ip, check=True)
        check = subprocess.run(check_command, capture_output=True, text=True, timeout=10)
        if check.returncode == 0:
            return {
                "ok": True,
                "target": ip,
                "already_present": True,
                "message": f"iptables DROP rule for {ip} is already present.",
            }

        command = self._iptables_command(ip)
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return {
                "ok": False,
                "target": ip,
                "returncode": result.returncode,
                "stderr_truncated": bool((result.stderr or "").strip()),
                "needs_human_review": True,
                "message": "Failed to add iptables DROP rule.",
            }

        return {
            "ok": True,
            "target": ip,
            "mode": "execute",
            "status": "executed",
            "command_summary": "configured local firewall block command",
            "reason": reason,
            "message": f"Added iptables DROP rule for {ip}.",
        }

    def _iptables_command(self, ip: str, check: bool = False) -> list[str]:
        action = "-C" if check else "-A"
        command = ["iptables", action, "INPUT", "-s", ip, "-j", "DROP"]
        if hasattr(os, "geteuid") and os.geteuid() != 0:
            return ["sudo", *command]
        return command

