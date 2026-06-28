import os
import re
import shlex
import subprocess
from string import Formatter


SAFE_TARGET_RE = re.compile(r"^[A-Za-z0-9._:@\\/\-]{1,255}$")
def env_bool(value) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def first_observable(observable_map: dict[str, list[str]], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        for value in observable_map.get(key) or []:
            cleaned = str(value or "").strip()
            if cleaned:
                return cleaned
    return None


def protected_set(values: list[str] | tuple[str, ...] | None) -> set[str]:
    return {str(value).strip().lower() for value in values or [] if str(value).strip()}


def is_protected_value(value: str | None, protected_values: set[str]) -> bool:
    if not value:
        return False
    normalized = value.strip().lower()
    leaf = normalized.rsplit("\\", 1)[-1].split("@", 1)[0]
    return normalized in protected_values or leaf in protected_values


def validate_target(value: str | None, label: str = "target") -> tuple[str | None, str | None]:
    if not value:
        return None, f"No {label} observable is available."
    if not SAFE_TARGET_RE.fullmatch(value):
        return None, f"The {label} contains unsupported characters."
    return value, None


def template_fields(template: str) -> set[str]:
    return {
        field_name
        for _, field_name, _, _ in Formatter().parse(template)
        if field_name
    }


def render_command_template(template: str, values: dict[str, str]) -> tuple[str | None, str | None]:
    if not template.strip():
        return None, "Command template is not configured."
    unsupported = template_fields(template) - set(values)
    if unsupported:
        return None, f"Command template has unsupported placeholders: {', '.join(sorted(unsupported))}."
    try:
        return template.format(**values), None
    except (KeyError, ValueError) as exc:
        return None, f"Command template could not be rendered: {exc}"


def safe_command_summary(label: str) -> str:
    return f"configured {label} command"


def run_command(command: str, timeout_seconds: int) -> dict:
    try:
        args = shlex.split(command, posix=os.name != "nt")
    except ValueError as exc:
        return {"ok": False, "message": f"Command template could not be parsed: {exc}"}
    if not args:
        return {"ok": False, "message": "Command template rendered to an empty command."}

    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": f"Command timed out after {timeout_seconds} seconds."}
    except OSError as exc:
        return {"ok": False, "message": f"Command could not be started: {exc}"}

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    return {
        "ok": result.returncode == 0,
        "returncode": result.returncode,
        "stdout_truncated": bool(stdout),
        "stderr_truncated": bool(stderr),
        "message": "Command completed." if result.returncode == 0 else "Command failed.",
    }
