# SOC AI Agent

SOC AI Agent is a lab SOC workflow application for Wazuh alert ingestion, Gemini/LangGraph triage, incident tracking, analyst review, manual playbooks, notes, archive management, read-only executive reporting, and controlled defensive response actions.

The backend is FastAPI with SQLite persistence. The primary admin UI is the Next.js app in `frontend/`. The legacy FastAPI-served `static/index.html` remains available at `/` as a fallback.

## Current Capabilities

- Public Wazuh webhook ingestion at `POST /webhook/wazuh`.
- Gemini/LangGraph alert enrichment and classification.
- SQLite-backed incidents, admin users, admin sessions, notes, archive state, manual playbooks, action history, and observables.
- Admin authentication with opaque HttpOnly session cookies.
- Next.js admin console for dashboard, incidents, archive, incident detail, notes, playbooks, response actions, and report generation.
- Additive incident observables extracted from Wazuh/Sysmon payloads.
- Analyst-controlled response actions:
  - `block_source_ip`
  - `disable_ad_account` in disabled/dry-run-only mode
- Read-only `/report` endpoint that generates an executive summary from stored incidents.

## Safety Model

This project is intentionally conservative.

- Gemini can recommend actions, but it does not execute them.
- Wazuh ingestion does not execute response actions.
- Incident detail viewing is read-only unless the analyst explicitly submits notes, creates a playbook, changes checklist state, archives/unarchives, approves/rejects, or executes a response action.
- Manual playbooks are created only by `POST /incidents/{id}/playbook`.
- Response action dry-run previews are not logged to avoid noisy history.
- Explicit response action execute attempts are audited.
- `response_action_executed` is reserved for real executed actions.
- `response_action_dry_run_confirmed` records analyst-confirmed simulations where no real system state changed.
- `response_action_failed` records failed requested actions or policy failures.
- AD account disable is disabled by default and real AD execution is not implemented.
- `/report` is read-only and does not write incident history.

Do not commit `.env`, `incidents.db`, `venv/`, `__pycache__/`, `.next/`, `node_modules/`, API keys, cookies, session tokens, password hashes, passwords, AD credentials, or other secrets.

## Backend Configuration

Create a local `.env` from `.env.example`. The safe current response-action configuration is:

```env
AUTH_COOKIE_NAME=soc_admin_session
AUTH_COOKIE_SECURE=false
FRONTEND_ORIGIN=http://192.168.56.105:3000
SESSION_TTL_HOURS=8

RESPONSE_ACTIONS_ENABLED=true
AD_ACTIONS_ENABLED=false
AD_ACTION_MODE=dry_run
AD_DOMAIN=WINDOMAIN
AD_DOMAIN_CONTROLLER=dc.windomain.local
AD_PROTECTED_USERS=Administrator,admin,krbtgt,vagrant,Domain Admins,Enterprise Admins,Schema Admins
```

`AUTH_COOKIE_SECURE=false` is for local HTTP lab use. Set it to `true` behind HTTPS.

`AD_DOMAIN` and `AD_DOMAIN_CONTROLLER` are lab/runtime labels used in dry-run output. They are not credentials. Do not add AD credential placeholders to `.env.example`, and do not hardcode AD credentials.

## Running The Backend

From the logger VM or backend host:

```bash
cd ~/soc-agent
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

The repository does not currently include a Python requirements file. Use the existing lab virtual environment or document dependencies separately before rebuilding the environment from scratch.

## Admin User Setup

Admin users live in SQLite in `admin_users`. No default admin is created automatically.

Generate a PBKDF2-SHA256 password hash:

```bash
cd ~/soc-agent
source venv/bin/activate
python scripts/create_admin_hash.py
```

Open SQLite:

```bash
sqlite3 incidents.db
```

Insert the admin row using the generated hash:

```sql
INSERT INTO admin_users (username, password_hash, role, is_active)
VALUES ('admin', '<generated_hash>', 'admin', 1);
```

Verify users and sessions:

```sql
SELECT id, username, role, is_active, created_at FROM admin_users;
SELECT id, admin_user_id, created_at, expires_at, revoked_at FROM admin_sessions;
```

The browser receives only an opaque HttpOnly session cookie. SQLite stores only `token_hash`, never the raw session token.

## Database Tables

FastAPI calls `Base.metadata.create_all(bind=engine)` on startup. After pulling schema changes onto the logger VM, you can manually verify/create runtime tables:

```bash
cd ~/soc-agent
source venv/bin/activate
python - <<'PY'
from db.database import engine
from db.models import Base

print(sorted(Base.metadata.tables.keys()))
Base.metadata.create_all(bind=engine)
print("Database tables created/verified.")
PY
```

This repository work only changes code. Do not commit the runtime `incidents.db`.

## Incident Observables

Wazuh ingestion extracts useful fields into the additive `incident_observables` table without changing the existing `incidents` table.

Current extracted keys include:

- `agent_name`
- `agent_id`
- `src_ip`
- `target_username`
- `subject_username`
- `user`
- `process_name`
- `parent_process_name`
- `command_line`
- `target_image`
- `host`

Extraction is defensive: missing fields are ignored, empty values are not stored, and exact duplicates are prevented with unique `(incident_id, key, value)`. Older incidents may have no observables.

In the incident detail UI, observables are shown as concrete alert values that response actions can use. They help explain why an action is available, suggested, or unavailable.

## Response Actions

Response actions appear on `/incidents/{id}` in the Next.js UI and are available through protected backend endpoints. The UI separates them by context:

- Suggested response actions: available actions that match incident evidence, observables, MITRE/rule context, or recommended-action text.
- Other available actions: actions that can run because required observables/config are present, but are not specifically suggested for this incident.
- Unavailable actions: compact explanations only. They show the action name, unavailable reason, and required observables/config, but no execute controls.

Suggestion metadata is deterministic. It does not call Gemini and does not execute actions.

### `block_source_ip`

- Risk: medium.
- Requires `src_ip`.
- Dry-run shows the iptables DROP command.
- Execute validates the IP, rejects loopback/multicast/unspecified addresses, checks whether the rule already exists, and fails clearly if the host is not Linux or `iptables` is unavailable.

### `disable_ad_account`

- Risk: high.
- Requires `target_username`, `subject_username`, or `user`.
- Disabled by default with `AD_ACTIONS_ENABLED=false`.
- In `AD_ACTION_MODE=dry_run`, even explicit analyst confirmation does not disable an account.
- If AD actions are disabled by configuration, the UI shows only compact unavailable status and does not show confirmation, reason, or execute controls.
- The UI requires typing `DISABLE_ACCOUNT` and entering a reason before recording a dry-run confirmation.
- Successful AD dry-run confirmation logs `response_action_dry_run_confirmed`, not `response_action_executed`.
- Real WinRM/PowerShell AD disable execution is not implemented.

High-risk AD dry-run confirmation request body:

```json
{ "confirm": "DISABLE_ACCOUNT", "reason": "Analyst-approved containment rationale" }
```

Username safety checks reject unsupported characters, machine accounts, protected usernames such as `Administrator`, `admin`, `krbtgt`, `vagrant`, admin-like names, and additional entries in `AD_PROTECTED_USERS`.

Real AD execution is future work. If implemented later, credential handling must be designed separately and reviewed. Real execution should require explicit approval, lab testing, rollback procedure, audited execution, and safe credential storage outside code and `.env.example`.

## Manual Playbooks, Notes, Timeline, And Archive

Manual playbooks provide deterministic analyst checklists. `GET /incidents/{id}/playbook` returns an existing playbook or suggested template without creating rows. `POST /incidents/{id}/playbook` explicitly creates or returns the playbook.

Template selection currently covers:

- Credential dumping / LSASS
- Brute force
- New user / persistence
- PowerShell encoded command / script execution
- Scheduled task persistence
- Generic suspicious alert fallback

Playbook steps support `todo`, `in_progress`, `done`, and `skipped`. Notes are stored separately and represented in the timeline through action events.

Archive state is separate from incident operational status. Archiving affects list/dashboard visibility but does not change `status`.

`GET /incidents` supports:

- `?archived=false`
- `?archived=true`
- `?archived=all`

## Backend API

Session routes:

- `POST /auth/login`: public login route.
- `POST /auth/logout`: clears or revokes the session cookie when present.
- `GET /auth/me`: requires a valid admin session.

Incident, report, and response routes require admin session authentication:

- `GET /incidents`
- `GET /incidents/pending`
- `GET /incidents/archive`
- `GET /incidents/{id}`
- `GET /incidents/{id}/observables`
- `GET /incidents/{id}/response-actions`
- `POST /incidents/{id}/response-actions/{action_key}/dry-run`
- `POST /incidents/{id}/response-actions/{action_key}/execute`
- `GET /incidents/{id}/playbook`
- `POST /incidents/{id}/playbook`
- `PATCH /playbook/steps/{step_id}`
- `GET /incidents/{id}/notes`
- `POST /incidents/{id}/notes`
- `GET /incidents/{id}/timeline`
- `GET /incidents/{id}/actions`
- `POST /incidents/{id}/archive`
- `POST /incidents/{id}/unarchive`
- `POST /incidents/{id}/approve`
- `POST /incidents/{id}/reject`
- `GET /report`

Other public routes:

- `POST /webhook/wazuh`
- `GET /health`
- `GET /`

The Wazuh webhook is public because Wazuh calls it directly.

## Frontend

The Next.js app runs on port 3000 and proxies browser calls from `/backend/*` to FastAPI.

Configure `frontend/.env` from `frontend/.env.example`:

```env
API_BASE_URL=http://192.168.56.105:8000
NEXT_PUBLIC_API_BASE_URL=http://192.168.56.105:8000
```

Run the frontend:

```bash
cd ~/soc-agent/frontend
npm install
npm run dev -- --host 0.0.0.0
```

Open:

```text
http://192.168.56.105:3000
```

Current UI pages:

- `/dashboard`: operational metrics and navigation shortcuts.
- `/incidents`: active incident triage, filtering, approve/reject, archive, and detail links.
- `/archive`: archived incident search, filtering, and unarchive.
- `/incidents/{id}`: read-only incident fields plus observables, response actions, manual playbook, notes, timeline, and action history.
- `/report`: global executive report generated from stored incidents.

The frontend uses FastAPI's HttpOnly cookie through `/backend/*`. It does not store auth tokens in `localStorage` or `sessionStorage`.

## Validation

Common validation commands:

```bash
python -m compileall main.py agent db scripts security.py playbooks response_actions
cd frontend
npm run build
npm run lint
```

For demos, run the full product manually because behavior depends on the live VM, Wazuh, FastAPI, Gemini configuration, auth state, and SQLite data.

## Security Checklist

- Keep `.env` and `incidents.db` local.
- Do not commit secrets, hashes, cookies, session tokens, or AD credentials.
- Keep `AD_ACTIONS_ENABLED=false` unless intentionally testing the dry-run AD workflow.
- Keep `AD_ACTION_MODE=dry_run` for demos.
- Do not treat AD dry-run confirmation as real account disablement.
- Do not add automatic response execution to `/webhook/wazuh`.
- Do not let Gemini directly execute defensive actions.
- Keep `/report` read-only.
