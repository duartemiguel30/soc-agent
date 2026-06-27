# SOC AI Agent Documentation

This document is the project handbook for `soc-agent`. It explains what the system does, how the backend and frontend fit together, how data moves through the product, which controls are safety-critical, and how to run and validate the lab.

The shorter front-door guide remains [`README.md`](README.md). Use this file when you need the complete project picture.

## 1. Project Purpose

SOC AI Agent is a lab SOC workflow application. It receives Wazuh alerts, enriches new incidents with Gemini/LangGraph triage, stores incident and alert history in SQLite, and gives analysts a web console for investigation, review, reporting, audit, and controlled defensive response actions.

The system is designed for defensive lab use. AI can classify, reason, and recommend, but real state-changing response actions stay behind explicit RBAC, policy, dry-run defaults, and per-action safeguards.

Core goals:

- Convert Wazuh alert payloads into durable SOC incidents.
- Deduplicate exact repeated alert payloads.
- Correlate related alert events into active incidents inside a configurable time window.
- Preserve concrete observables such as source IPs, usernames, hosts, processes, and command lines.
- Let analysts review incidents, notes, playbooks, response-action availability, timeline, and audit history.
- Keep admin authentication and RBAC server-authoritative.
- Keep dangerous AD and endpoint actions disabled or dry-run by default.

## 2. Repository Layout

Top-level backend files:

- `main.py`: FastAPI application, routes, auth/RBAC enforcement, Wazuh ingestion, incident APIs, audit APIs, report API, and startup migrations.
- `config.py`: environment-driven runtime configuration.
- `security.py`: password hashing, session token hashing, and auth helpers.
- `db/database.py`: SQLAlchemy engine/session setup.
- `db/models.py`: SQLAlchemy models for incidents, alert events, users, sessions, audit events, notes, playbooks, actions, and observables.
- `agent/`: Gemini/LangGraph triage graph, prompts, state, and nodes.
- `playbooks/`: deterministic incident response playbook templates and service logic.
- `response_actions/`: response-action registry, service, automation policy, and executors.
- `scripts/create_admin_hash.py`: helper to generate a password hash for the first admin user.
- `static/index.html`: legacy fallback UI served by FastAPI.

Frontend files:

- `frontend/app/`: Next.js App Router pages and components.
- `frontend/app/components/`: shared UI shell, auth guard, incident list, analytics widgets.
- `frontend/lib/api.ts`: browser API client using `/backend/*` proxy routes and HttpOnly cookies.
- `frontend/lib/analytics.ts`, `frontend/lib/incidents.ts`: frontend data shaping helpers.
- `frontend/scripts/record-demo.mjs`: Playwright demo video recorder.
- `frontend/scripts/smoke-admin-rbac-response-actions.mjs`: Playwright admin/RBAC/response-action smoke test.
- `frontend/next.config.ts`: Next.js config, including backend proxy behavior.

Important local-only files:

- `.env`: backend runtime secrets/config, never commit.
- `frontend/.env`: frontend runtime config, never commit.
- `incidents.db`: local SQLite runtime data, never commit.
- `venv/`, `frontend/node_modules/`, `frontend/.next/`: generated dependencies/build output, never commit.
- `demo-output/`, `smoke-output/`: generated videos/test output, never commit.

## 3. Runtime Architecture

The product has two runtime services:

1. FastAPI backend on port `8000`.
2. Next.js frontend on port `3000`.

The browser talks to the frontend. Frontend API calls use `/backend/*`; Next proxies those requests to FastAPI. This keeps browser code simple and allows the backend to use HttpOnly cookies for authentication without putting tokens in JavaScript storage.

Typical local lab URLs:

- Frontend: `http://192.168.56.105:3000`
- Backend: `http://192.168.56.105:8000`
- Wazuh webhook: `POST http://192.168.56.105:8000/webhook/wazuh`

## 4. Backend Data Model

SQLite is the persistence layer. Tables are created on startup with SQLAlchemy metadata, and startup code safely adds missing admin/session columns for older lab databases.

Main data groups:

- Incidents: normalized SOC incident records.
- Alert events: individual correlated Wazuh alert occurrences.
- Observables: extracted concrete evidence such as `src_ip`, `target_username`, `agent_name`, `process_name`, and `command_line`.
- Admin users: local admin identities, roles, active/disabled state, and password hashes.
- Admin sessions: hashed opaque session tokens and sliding idle expiration metadata.
- Admin audit events: security-relevant events such as login, permission denial, user management, response actions, and report generation.
- Notes: analyst-authored incident notes.
- Playbooks: incident-specific checklist state derived from deterministic templates.
- Incident actions: incident timeline/history entries for analyst actions and response-action outcomes.
- Archive state: archive/unarchive metadata stored separately from incident operational status.

The runtime database is local lab state. Do not commit `incidents.db`.

## 5. Authentication And Sessions

Authentication uses local admin users stored in SQLite.

Login flow:

1. Browser submits username/password to `POST /auth/login`.
2. Backend verifies the password hash.
3. Backend creates an admin session with a random opaque token.
4. SQLite stores only a token hash.
5. Browser receives the raw token only as an HttpOnly cookie.

The frontend does not store auth tokens in `localStorage` or `sessionStorage`. The only expected localStorage use is the UI theme preference under `soc_theme`.

Sessions use sliding idle expiration:

- `SESSION_IDLE_TIMEOUT_MINUTES` controls inactivity timeout.
- Each authenticated request refreshes `last_activity_at` and `expires_at`.
- Logout revokes the session and clears the cookie.
- Expired or revoked sessions cannot authenticate.

`AUTH_COOKIE_SECURE=false` is acceptable only for local HTTP lab use. Use `AUTH_COOKIE_SECURE=true` behind HTTPS.

## 6. RBAC Model

Backend RBAC is authoritative. The frontend hides controls for usability, but all protected API routes enforce permissions server-side.

Roles:

- `super_admin`: full access, including user management and audit review.
- `admin`: incident operations, reports, audit review, playbooks, notes, and response-action execution; no user management.
- `analyst`: investigation workflow, playbooks, notes, response-action previews, and reports; no user management or execution.
- `viewer`: read-focused dashboard/incidents/report access.

Important permissions:

- `manage_users`: create/update/disable/enable users and reset passwords.
- `view_audit`: view admin audit events and metrics.
- `view_incidents`: read incidents and related investigation data.
- `approve_incidents`, `reject_incidents`: approve/reject incident decisions.
- `archive_incidents`: archive/unarchive incidents.
- `add_notes`: create incident notes.
- `manage_playbooks`: create/update playbooks and checklist steps.
- `view_response_actions`: view response-action availability and dry-run previews.
- `execute_response_actions`: execute or confirm response actions.
- `generate_report`: generate the executive report.

Admin user safeguards:

- Usernames are unique.
- Users are disabled instead of deleted.
- Disabled users cannot log in.
- The last active `super_admin` cannot be disabled or demoted.
- Password hashes are never returned by the API.
- User management changes create audit events.

## 7. Wazuh Ingestion Flow

Wazuh sends alerts to `POST /webhook/wazuh`.

For each alert:

1. The backend computes a SHA256 alert hash.
2. Exact duplicate payloads are ignored.
3. Useful observables are extracted from stable Wazuh fields.
4. A deterministic correlation key is computed from rule and observable data.
5. If an active, non-archived incident with the same key exists inside `INCIDENT_CORRELATION_WINDOW_MINUTES`, the alert is appended as an alert event.
6. If no matching incident exists, Gemini/LangGraph triage runs and a new incident is created.
7. New incident creation may evaluate automatic response policy, if explicitly enabled.

Important behavior:

- Exact duplicates do not create more incident activity.
- Correlated follow-up alerts do not call Gemini again.
- Correlation does not rely on AI reasoning text.
- Archived incidents do not receive new correlated events.
- Automation only evaluates newly created incidents, not duplicate or correlated follow-up events.

The default correlation window documented by the project is 15 minutes.

## 8. AI Triage

The AI triage layer lives under `agent/`.

Gemini/LangGraph produces fields such as:

- classification
- confidence
- severity
- reasoning
- recommended action
- decision
- MITRE technique where applicable

AI output is stored as incident context. It does not directly execute actions. Response-action availability and execution rely on deterministic observables, configuration, RBAC, and policy checks.

## 9. Incident Workflow

Main incident pages:

- `/dashboard`: operational metrics, alert/event evolution, severity, MITRE, decision, and agent distribution.
- `/incidents`: active/archived/all incident list with filters, pagination, approve/reject, archive/unarchive, and detail links.
- `/archive`: compatibility redirect to archived incidents.
- `/incidents/{id}`: investigation view with alert activity, observables, response actions, playbook, notes, timeline, and action history.
- `/analytics/alerts`: full alert/event evolution explorer.
- `/analytics/alerts/detail`: alert-period drilldown.
- `/analytics/mitre`: MITRE distribution view.
- `/report`: executive report generation.
- `/admin/users`: user management.
- `/admin/audit`: audit metrics and event review.

Archive state is independent from incident operational status. Archiving changes visibility and dashboard/list behavior, but it does not rewrite the incident decision/status fields.

Incident list filters include:

- archive scope
- status
- severity
- classification
- decision
- rule level
- MITRE technique
- agent
- date scope
- query text
- sort

## 10. Observables

Observables are concrete values extracted from alerts and attached to incidents. They drive response-action availability and explain why an action is possible or unavailable.

Current observable examples:

- `agent_name`
- `agent_id`
- `src_ip`
- `target_username`
- `subject_username`
- `user`
- `source_workstation`
- `source_port`
- `process_name`
- `parent_process_name`
- `command_line`
- `target_image`
- `host`

Extraction is additive and defensive:

- Missing fields are ignored.
- Empty values are ignored.
- Exact duplicate `(incident_id, key, value)` entries are prevented.
- Older incidents may have no observables.

## 11. Playbooks, Notes, Timeline, And Actions

Manual playbooks provide deterministic checklists. Reading the playbook suggestion endpoint does not create database rows. Rows are created only by explicit analyst action.

Template families include:

- credential dumping / LSASS
- brute force
- new user / persistence
- PowerShell encoded command / script execution
- scheduled task persistence
- generic suspicious alert fallback

Notes are analyst-authored and show in incident context. Timeline data combines system, AI, analyst, playbook, note, and response-action activity where appropriate.

## 12. Response Actions

Response actions live in `response_actions/`.

Supported actions:

- `block_source_ip`
- `disable_ad_account`
- `isolate_endpoint`
- `collect_host_context`

Response-action UI groups actions as:

- Suggested: available and relevant to the incident evidence.
- Other available: executable or previewable because required data/config exists.
- Unavailable: compact explanation only, with no execute controls.

Safety rules:

- Gemini recommendations do not execute anything.
- Dry-run is the default posture.
- Dangerous actions require explicit config.
- High-risk actions require confirmation text and a reason.
- Backend RBAC enforces execution permissions.
- Audit events are created for dry-runs, confirmed dry-runs, executions, failures, and denials.
- Raw secrets must never be returned or logged.

### `block_source_ip`

Requires `src_ip`. Dry-run shows intended behavior. Execute validates the target IP and checks platform/tool availability.

### `disable_ad_account`

Requires a target username observable. Disabled by default.

Real execution requires:

- `AD_ACTIONS_ENABLED=true`
- `AD_ACTION_MODE=execute`
- LDAP server/base/bind configuration
- optional `ldap3` package
- non-protected target username

Protected accounts and admin-like names are rejected. Bind passwords belong only in local `.env`.

### `isolate_endpoint`

Requires a host, agent, or IP observable. Disabled and dry-run by default. Real execution requires an explicit command template and protected-host safeguards.

### `collect_host_context`

Requires a host, agent, or IP observable. Intended for non-destructive collection or demo-safe simulation. Disabled and dry-run by default unless intentionally configured.

## 13. Automatic Response Policy

Automatic response actions are disabled by default.

Relevant configuration:

```env
AUTO_RESPONSE_ACTIONS_ENABLED=false
AUTO_RESPONSE_ACTION_MODE=dry_run
AUTO_RESPONSE_ALLOWED_ACTIONS=block_source_ip,isolate_endpoint
AUTO_RESPONSE_MIN_SEVERITY=high
AUTO_RESPONSE_REQUIRE_DECISION=auto_response
```

Automation runs only after a new incident is created and analyzed. It does not run for:

- exact duplicate alert payloads
- correlated follow-up events
- archived incidents
- already approved/rejected incidents

Automated actor is `system:auto_response`. Failures are logged but should not break webhook ingestion.

## 14. Reporting

`/report` generates an executive summary from stored incidents. It is intended to be read-only with respect to incident operational data.

Report generation may call the configured AI provider and can take time. It requires authenticated access and the `generate_report` permission.

## 15. Admin Audit

Admin audit events record security-relevant operations, including:

- login success/failure
- logout
- session expiration
- permission denial
- user creation/update/disable/enable/password reset
- incident approve/reject/archive/unarchive
- note creation
- playbook creation and step changes
- response-action previews, confirmations, executions, failures, and policy results
- report generation

Read-only page views are not normally audited. Audit details are redacted before storage to avoid leaking tokens, cookies, passwords, bind credentials, or command secrets.

## 16. Configuration

Create local config from examples:

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
```

Never commit local `.env` files.

Backend baseline:

```env
AUTH_COOKIE_NAME=soc_admin_session
AUTH_COOKIE_SECURE=false
FRONTEND_ORIGIN=http://192.168.56.105:3000
SESSION_IDLE_TIMEOUT_MINUTES=30
INCIDENT_CORRELATION_WINDOW_MINUTES=15
RESPONSE_ACTIONS_ENABLED=true
```

Frontend baseline:

```env
API_BASE_URL=http://192.168.56.105:8000
NEXT_PUBLIC_API_BASE_URL=http://192.168.56.105:8000
```

Keep these disabled unless intentionally testing them:

```env
AUTO_RESPONSE_ACTIONS_ENABLED=false
AD_ACTIONS_ENABLED=false
ENDPOINT_ISOLATION_ENABLED=false
HOST_CONTEXT_COLLECTION_ENABLED=false
```

Keep action modes in dry-run for demos:

```env
AUTO_RESPONSE_ACTION_MODE=dry_run
AD_ACTION_MODE=dry_run
ENDPOINT_ISOLATION_MODE=dry_run
HOST_CONTEXT_COLLECTION_MODE=dry_run
```

## 17. Running The Project

Backend:

```bash
cd ~/soc-agent
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

Frontend development:

```bash
cd ~/soc-agent/frontend
npm install
npm run dev -- --host 0.0.0.0
```

Frontend production-style local run:

```bash
cd ~/soc-agent/frontend
npm run build
npm run start -- -H 0.0.0.0
```

Open:

```text
http://192.168.56.105:3000
```

## 18. First Admin Setup

No default admin is created automatically.

Generate a password hash:

```bash
cd ~/soc-agent
source venv/bin/activate
python scripts/create_admin_hash.py
```

Insert the first `super_admin`:

```bash
sqlite3 incidents.db
```

```sql
INSERT INTO admin_users (username, password_hash, display_name, role, is_active)
VALUES ('admin', '<generated_hash>', 'SOC Admin', 'super_admin', 1);
```

Verify:

```sql
SELECT id, username, display_name, role, is_active, created_at, last_login_at FROM admin_users;
```

If an older database has active admins but no active `super_admin`, startup migration promotes the first active admin to preserve user-management access.

## 19. Development And Validation

Backend syntax validation:

```bash
python -m compileall main.py agent db scripts security.py playbooks response_actions
```

Frontend validation:

```bash
cd frontend
npm run build
npm run lint
```

Diff hygiene:

```bash
git diff --check
```

Do not commit generated files or secrets.

## 20. Admin/RBAC Smoke Test

The frontend includes a Playwright smoke test:

```bash
cd frontend
npm run smoke:admin
```

Default configuration:

```env
SMOKE_FRONTEND_URL=http://192.168.56.105:3000
SMOKE_BACKEND_URL=http://192.168.56.105:8000
SMOKE_ADMIN_USERNAME=admin
SMOKE_ADMIN_PASSWORD=admin
SMOKE_HEADLESS=false
SMOKE_SLOW_MO_MS=80
SMOKE_OUTPUT_DIR=smoke-output
SMOKE_GENERATE_REPORT=false
```

The smoke script can load `.env.smoke` from the repo root or `frontend/`, or a custom file through `SMOKE_ENV_FILE`.

It validates:

- admin login and `/auth/me`
- `/admin/users` access and disposable test-user creation
- per-user Save behavior
- explicit password reset behavior
- viewer and analyst RBAC denial paths
- audit event visibility
- response-action UI safety
- report page loading
- cleanup by disabling disposable smoke users

It does not execute response actions. It writes JSON results and failure screenshots to `smoke-output/`.

## 21. Demo Recording

The demo recorder is:

```bash
cd frontend
npm run demo:record
```

It uses Playwright to record a guided browser flow. It loads demo environment variables from `frontend/.env.demo`, then `.env.demo`, unless overridden by shell variables or `DEMO_ENV_FILE`.

Demo output is written under `demo-output/`.

The demo flow is designed to be safe:

- It navigates pages.
- It changes read-only filters.
- It opens drilldowns and incident detail.
- It may generate the read-only report.
- It does not approve, reject, archive, unarchive, execute response actions, create notes, update playbook steps, or create playbooks.

## 22. Manual Operational Checks

Useful manual checks after changes:

- Existing admin can log in.
- Existing admin is `super_admin` or can access `/admin/users`.
- Viewer cannot access `/admin/users` or `/admin/audit`.
- Viewer cannot see archive/unarchive, approve/reject, note, playbook, or execute controls.
- Direct viewer requests to protected mutation endpoints return `403`.
- Analyst can investigate incidents but cannot manage users or execute response actions.
- Admin/super_admin can archive/unarchive where appropriate.
- Password reset works only through the explicit reset button.
- Editing admin user display name or role does not save until `Save changes`.
- Audit events appear for login, permission denial, user management, and response actions.
- Response-action unavailable/protected/manual/dry-run statuses render without exposing raw secrets.
- `.env.example` keeps safe defaults.

## 23. Security Rules

Never commit:

- `.env`
- `.env.demo`
- `.env.smoke`
- `incidents.db`
- `venv/`
- `__pycache__/`
- `.next/`
- `node_modules/`
- `demo-output/`
- `smoke-output/`
- API keys
- cookies
- session tokens
- password hashes
- plaintext passwords
- AD credentials
- LDAP bind passwords
- command credentials

Do not store auth/session tokens in browser storage.

Keep real destructive actions disabled unless intentionally testing in a controlled lab. Prefer dry-run modes for demos and validation.

## 24. Troubleshooting

Frontend cannot reach backend:

- Confirm FastAPI is running on port `8000`.
- Confirm frontend `.env` points at the backend.
- Confirm Next dev/prod server was restarted after env changes.
- Confirm CORS `FRONTEND_ORIGIN` matches the frontend URL.

Login fails:

- Confirm an active admin user exists.
- Confirm the password hash was generated by the project helper.
- Confirm the user is not disabled.
- Confirm session cookie settings match HTTP/HTTPS.

RBAC controls look wrong:

- Check `/auth/me` role and permissions.
- Confirm frontend was rebuilt/restarted.
- Verify direct API calls return expected `403`.
- Review `/admin/audit` for permission-denied events.

Smoke test fails on Save behavior:

- Make sure the running frontend is rebuilt/restarted with current code.
- Confirm editing display name or role does not issue a PATCH until `Save changes`.
- Review `smoke-output/smoke-results.json` and failure screenshots.

Response actions appear unavailable:

- Check required observables on the incident.
- Check action-specific enable flags.
- Check dry-run/execute mode.
- Check protected users/hosts.
- Check audit events for policy or permission failures.

Report generation fails or times out:

- Confirm AI provider configuration is present in local `.env`.
- Confirm network access from the backend host.
- Increase the relevant timeout for demo/smoke flows if needed.

