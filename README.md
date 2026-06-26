# SOC AI Agent

FastAPI remains the SOC backend for Wazuh ingestion, incident APIs, LangGraph/Gemini analysis, SQLite persistence, approval/rejection, report generation, and real admin authentication. The Next.js app in `frontend/` is the admin UI.

## Backend

Create a local `.env` from `.env.example` and set session configuration only:

```bash
AUTH_COOKIE_NAME=soc_admin_session
AUTH_COOKIE_SECURE=false
FRONTEND_ORIGIN=http://192.168.56.105:3000
SESSION_TTL_HOURS=8
```

Admin users are stored in SQLite in the `admin_users` table. Admin sessions are stored in SQLite in the `admin_sessions` table. The browser receives only an opaque HttpOnly session cookie; the database stores only `token_hash`, never the raw token. No `JWT_SECRET` is needed, and no default admin is created automatically.

Run the backend:

```bash
cd ~/soc-agent
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

FastAPI issues an opaque HttpOnly cookie with `SameSite=Lax` after a successful admin login. `AUTH_COOKIE_SECURE=false` is intended for local HTTP development; set it to `true` behind HTTPS in production.

## Manual Admin Creation

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

Verify admin users and sessions:

```sql
SELECT id, username, role, is_active, created_at FROM admin_users;
SELECT id, admin_user_id, created_at, expires_at, revoked_at FROM admin_sessions;
```

Do not commit real passwords, hashes, session tokens, `.env`, or `incidents.db`.

## Routes

Protected backend routes:

- `GET /incidents`
- `GET /incidents/pending`
- `GET /incidents/archive`
- `GET /incidents/{id}`
- `GET /incidents/{id}/playbook`
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

Public backend routes:

- `GET /health`
- `POST /webhook/wazuh`
- `GET /` serving the legacy fallback dashboard

The Wazuh webhook remains public because Wazuh calls it directly.

## Incident Archive

Incident `status` remains the operational outcome, such as `pending_human`, `approved`, `rejected`, or `processed`. Archive state is separate visibility/lifecycle organization stored in the additive `incident_archive_states` table. Archiving an incident does not change its operational status.

An incident is archived when it has one row in `incident_archive_states`. The row stores `archived_at`, `archived_by`, and an optional `reason`. Dashboard and active incident views request non-archived incidents, while the Next.js `/archive` page shows archived incidents and supports unarchiving.

Archive endpoints:

- `POST /incidents/{id}/archive`
- `POST /incidents/{id}/unarchive`
- `GET /incidents/archive`

`GET /incidents` remains compatible and supports `?archived=false`, `?archived=true`, and `?archived=all`.

## Manual Incident Response Playbooks

Manual playbooks give analysts a deterministic checklist for each incident. They do not call Gemini and do not depend on live AI output for their steps. Playbooks are created lazily: the first request to `GET /incidents/{id}/playbook` creates one from a template if the incident does not already have one.

Template selection uses existing incident fields:

- Credential dumping / LSASS: MITRE `T1003` or `T1003.001`, rule IDs `100001`-`100003`, or descriptions mentioning LSASS, Mimikatz, or credential dumping.
- Brute force: MITRE `T1110` or `T1110.001`, or descriptions mentioning brute force or multiple failed logins.
- New user / persistence: MITRE `T1136` or `T1136.001`, rule ID `100005`, or descriptions mentioning new user/account creation.
- PowerShell encoded command / script execution: MITRE `T1059` or `T1059.001`, rule ID `100006`, or descriptions mentioning PowerShell or encoded command.
- Scheduled task persistence: MITRE `T1053` or `T1053.005`, rule ID `100007`, or descriptions mentioning scheduled task.
- Generic suspicious alert: fallback for all other alerts.

Each playbook has ordered checklist steps with statuses `todo`, `in_progress`, `done`, and `skipped`. Analysts can add notes, and the backend records historical `incident_action_events` for incident-specific actions: playbook creation, step updates, notes, approvals, and rejections. The timeline uses these action events as its primary source; synthetic incident/AI/playbook fallback entries are only added for older incidents that do not have equivalent action events. Notes appear in the timeline through `note_added` action events; old notes without a corresponding action event are added as fallback timeline entries without duplicating logged notes. The Notes panel always shows full note bodies. The global `/report` endpoint remains read-only and does not write incident history. The incident detail page shows the playbook, analyst notes, combined timeline, and action history.

After pulling this code onto the `logger` VM, create or verify the new runtime tables:

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

Codex/code generation only updates repository code. It does not create real runtime SQLite tables or insert real rows on the `logger` VM.

## Frontend

The Next.js app runs separately on port 3000 and proxies browser calls from `/backend/*` to FastAPI. Configure `frontend/.env` from `frontend/.env.example`:

```bash
API_BASE_URL=http://192.168.56.105:8000
NEXT_PUBLIC_API_BASE_URL=http://192.168.56.105:8000
```

Run the frontend:

```bash
cd ~/soc-agent/frontend
npm install
npm run dev -- --host 0.0.0.0
```

`frontend/next.config.ts` allows the VM dev origin `192.168.56.105` and rewrites `/backend/*` to FastAPI. Restart the Next dev server after changing this config.

Open:

```text
http://192.168.56.105:3000
```

The old FastAPI-served `static/index.html` remains as a legacy fallback, but the Next.js frontend is the main admin UI.

## Security Notes

Do not commit `.env`, `incidents.db`, `venv/`, `__pycache__/`, API keys, GitHub tokens, cookies, raw session tokens, or other secrets. The Next.js app does not know or store admin credentials or tokens; it relies on FastAPI's HttpOnly session cookie through `/backend/*`.
