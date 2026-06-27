# SOC AI Agent

SOC AI Agent is a lab SOC workflow application for Wazuh alert ingestion, Gemini/LangGraph triage, incident tracking, analyst review, manual playbooks, notes, archive management, read-only executive reporting, and controlled defensive response actions.

The backend is FastAPI with SQLite persistence. The primary admin UI is the Next.js app in `frontend/`. The legacy FastAPI-served `static/index.html` remains available at `/` as a fallback.

## Current Capabilities

- Public Wazuh webhook ingestion at `POST /webhook/wazuh`.
- Gemini/LangGraph alert enrichment and classification.
- SQLite-backed incidents, correlated alert events, admin users, admin sessions, admin audit events, notes, archive state, manual playbooks, action history, and observables.
- Multi-user admin authentication with opaque HttpOnly session cookies, RBAC roles, and sliding idle-session expiration.
- Next.js admin console for dashboard, incidents, archive, incident detail, notes, playbooks, response actions, report generation, user management, and admin audit review.
- Clean light/dark admin-console UI theme with centralized CSS variables for quick browser tuning.
- Dashboard analytics for alert/event evolution, MITRE distribution, top agents, severity, and decisions.
- Additive incident observables extracted from Wazuh/Sysmon payloads.
- Alert correlation/deduplication groups repeated Wazuh alerts into one incident with event count, first seen, and last seen metadata.
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
- Response action dry-run previews are logged only to admin audit events, not incident action history.
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
SESSION_IDLE_TIMEOUT_MINUTES=30
INCIDENT_CORRELATION_WINDOW_MINUTES=15

RESPONSE_ACTIONS_ENABLED=true
AD_ACTIONS_ENABLED=false
AD_ACTION_MODE=dry_run
AD_DOMAIN=WINDOMAIN
AD_DOMAIN_CONTROLLER=dc.windomain.local
AD_PROTECTED_USERS=Administrator,admin,krbtgt,vagrant,Domain Admins,Enterprise Admins,Schema Admins
```

`AUTH_COOKIE_SECURE=false` is for local HTTP lab use. Set it to `true` behind HTTPS.

`SESSION_IDLE_TIMEOUT_MINUTES` controls admin inactivity timeout. The default is 30 minutes. Each authenticated request refreshes `last_activity_at` and extends `expires_at`; inactivity beyond the configured minutes requires logging in again. `SESSION_TTL_HOURS` is still accepted as a legacy fallback when `SESSION_IDLE_TIMEOUT_MINUTES` is missing, but new environments should use `SESSION_IDLE_TIMEOUT_MINUTES`.

## Admin RBAC

Admin users have one of four roles:

- `super_admin`: full access, including user management, audit review, settings, incident actions, playbooks, notes, response actions, and report generation.
- `admin`: incident operations, playbooks, notes, response action execution, reports, and audit review. Admins cannot manage users.
- `analyst`: dashboard/incidents, triage work, playbooks, notes, response action previews, and reports. Analysts cannot manage users or execute response actions.
- `viewer`: dashboard/incidents and report generation only.

Backend permission checks are authoritative. The frontend hides unavailable controls and navigation, but forbidden API calls still return `403` and create a `permission_denied` admin audit event.

`INCIDENT_CORRELATION_WINDOW_MINUTES` controls how long repeated related Wazuh alerts are grouped into an existing active incident. The default is 15 minutes.

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

Insert the first admin row using the generated hash:

```sql
INSERT INTO admin_users (username, password_hash, display_name, role, is_active)
VALUES ('admin', '<generated_hash>', 'SOC Admin', 'super_admin', 1);
```

Verify users and sessions:

```sql
SELECT id, username, display_name, role, is_active, created_at, last_login_at FROM admin_users;
SELECT id, admin_user_id, created_at, last_activity_at, expires_at, revoked_at FROM admin_sessions;
SELECT id, created_at, actor_username, event_type, target_username, success FROM admin_audit_events ORDER BY id DESC LIMIT 20;
```

The browser receives only an opaque HttpOnly session cookie. SQLite stores only `token_hash`, never the raw session token. Admin sessions use sliding idle expiration: active use refreshes `last_activity_at`, `expires_at`, and the cookie max age; logout sets `revoked_at` immediately.

Existing single-user databases are migrated safely at startup. If no active `super_admin` exists, the first active admin user is promoted to `super_admin` so user management remains reachable.

## Database Tables

FastAPI calls `Base.metadata.create_all(bind=engine)` on startup and safely adds missing admin-only columns for existing SQLite databases:

- `admin_users.display_name`
- `admin_users.role`
- `admin_users.is_active`
- `admin_users.created_at`
- `admin_users.updated_at`
- `admin_users.last_login_at`
- `admin_users.created_by`
- `admin_sessions.last_activity_at`

It also creates `admin_audit_events` when missing. After pulling schema changes onto the logger VM, you can manually verify/create runtime tables:

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
- `source_workstation`
- `source_port`
- `process_name`
- `parent_process_name`
- `command_line`
- `target_image`
- `host`

Windows failed-logon/brute-force alerts extract source fields directly from raw Wazuh payload paths such as `data.win.eventdata.ipAddress`, `data.win.eventdata.targetUserName`, and `data.win.eventdata.workstationName`. These raw observables drive correlation, alert activity metadata, and response-action availability; Gemini reasoning text is not trusted as a source for executable observables.

Extraction is defensive: missing fields are ignored, empty values are not stored, and exact duplicates are prevented with unique `(incident_id, key, value)`. Older incidents may have no observables.

In the incident detail UI, observables are shown as concrete alert values that response actions can use. They help explain why an action is available, suggested, or unavailable.

## Alert Correlation And Deduplication

Wazuh ingestion stores alert occurrences in the additive `incident_alert_events` table. Repeated alerts that share a deterministic correlation key within the configured window are appended to the existing active, non-archived incident instead of creating duplicate incidents.

Exact duplicate Wazuh payloads are ignored using a SHA256 alert hash. Correlated repeated alerts do not call Gemini/LangGraph again; Gemini is called only when a new incident must be created.

Correlation is deterministic and does not use AI reasoning or recommended actions. It uses normalized Wazuh fields such as rule ID, agent/host, source IP, target username, MITRE technique, and process image where available. Brute-force rule `100004` prefers rule ID plus source IP and target username, then falls back to source IP or agent. Process-style alerts prefer rule ID, agent, and process image when present.

Incident API responses include:

- `event_count`
- `first_seen`
- `last_seen`
- `correlation_key`

Older incidents with no alert-event rows report `event_count=1`, with `first_seen` and `last_seen` falling back to `created_at`.

When a correlated alert provides additional observables, ingestion merges them into the same incident using the existing unique observable constraint. This can make response actions available later, but webhook ingestion still does not execute response actions.

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
- optional server-side filters: `status`, `severity`, `classification`, `decision`, `rule_level`, `mitre`, `agent`, `q`, `sort`, `from`, and `to`
- optional pagination with `limit` and `offset`; when `limit` is present the response is `{ items, total, limit, offset, has_more }`, while unpaginated callers still receive the original array shape

## Backend API

Session routes:

- `POST /auth/login`: public login route.
- `POST /auth/logout`: clears or revokes the session cookie when present.
- `GET /auth/me`: requires a valid admin session and returns `username`, `display_name`, `role`, and `permissions`.

Admin routes:

- `GET /admin/users`: list admin users. Requires `manage_users`.
- `POST /admin/users`: create an admin user. Requires `manage_users`.
- `GET /admin/users/{user_id}`: read one admin user. Requires `manage_users`.
- `PATCH /admin/users/{user_id}`: update display name, role, or active state. Requires `manage_users`.
- `POST /admin/users/{user_id}/reset-password`: reset an admin password. Requires `manage_users`.
- `POST /admin/users/{user_id}/disable`: disable login for a user. Requires `manage_users`.
- `POST /admin/users/{user_id}/enable`: re-enable login for a user. Requires `manage_users`.
- `GET /admin/audit-events`: filter admin audit events. Requires `view_audit`.
- `GET /admin/audit-metrics`: admin audit metrics. Requires `view_audit`.

Admin user safeguards:

- Usernames are unique.
- Roles must be `super_admin`, `admin`, `analyst`, or `viewer`.
- Users are disabled instead of deleted.
- Disabled users cannot log in.
- The last active `super_admin` cannot be disabled or demoted.
- Password hashes are never returned by the API.

Incident, report, analytics, and response routes require admin session authentication plus RBAC permissions:

- Dashboard/analytics data: `view_dashboard` or `view_incidents`, depending on endpoint.
- Incident lists/details/timeline/notes/actions: `view_incidents`.
- Approve/reject: `approve_incidents` / `reject_incidents`.
- Archive/unarchive: `archive_incidents`.
- Notes: `add_notes` for creation; viewing remains `view_incidents`.
- Playbook creation and step updates: `manage_playbooks`.
- Response action details and dry-run preview: `view_response_actions`.
- Response action execute or confirmed dry-run: `execute_response_actions`.
- Report generation: `generate_report`.

Admin audit events are created for login success/failure, logout, session expiry, user management, permission denial, incident approve/reject/archive/unarchive, notes, playbook changes, response action dry-runs/execution/failures, and report generation. Normal read-only page views are not logged.

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

The UI supports a clean light/dark theme toggle in the header and mobile drawer. The selected theme is stored in `localStorage` under `soc_theme`; auth tokens are not stored in browser storage. Theme colors are centralized in `frontend/app/globals.css` under `:root` and `:root[data-theme="dark"]`; the fastest presentation-prep variables to adjust are `--bg`, `--panel`, `--line`, `--text`, `--muted`, `--accent`, `--accent-strong`, and the severity variables.

The header shows the current user and role. Navigation and mutating controls are hidden when the authenticated user lacks the required permission, while backend RBAC remains authoritative. Admin pages are:

- `/admin/users`: super-admin user management with create, role/display-name update, enable/disable, and password reset.
- `/admin/audit`: audit metrics, filtered audit event review, and progressive loading.

Dashboard distribution charts are computed in the frontend from existing incident API responses. They use fields such as `severity`, `decision`, `mitre_technique`, `agent_name`, `event_count`, `first_seen`, `last_seen`, and `created_at`.

The Alert/Event Evolution chart uses the protected read-only `GET /analytics/alert-evolution` endpoint. It defaults to `archived=all`, so active and archived history are included in dashboard analytics. The endpoint counts stored `incident_alert_events` by `event_timestamp` with `created_at` fallback, then adds one fallback event for incidents that have no alert-event rows. This avoids double-counting correlated incidents while preserving older incidents created before alert-event storage existed.

The evolution explorer supports:

- `24h` with hourly buckets.
- `7d` with daily buckets.
- `1m` with daily or weekly buckets.
- `1y` with weekly or monthly buckets.
- `All` with yearly buckets.

By default, Alert/Event Evolution opens on `24h`. The `24h` and `7d` ranges are rolling windows relative to the current time. The `1m` and `1y` ranges are calendar windows: current month-to-now and current year-to-now by default, with month/year pickers for anchored historical periods.

Previous/next navigation moves one full selected window at a time. From the current rolling window, Previous steps back once and Next returns naturally to the current live window; the reset/current button appears only when the selection is more than one step away from current or when a manual historical calendar anchor is selected. `All` history hides period navigation. No heavy chart dependency is used; charts are plain React, CSS, and SVG with CSS-only height/fade transitions during refresh. The dashboard uses a compact responsive analytics grid for event evolution, severity, MITRE, decision, and agent distributions. The dashboard timeline uses compact contained scrolling when buckets do not fit, while `/analytics/alerts` uses an expanded wrapped timeline view that avoids internal horizontal scrollbars and spends vertical page space instead.

Dashboard metric semantics are explicit:

- `Total incidents` counts stored incident records, active plus archived.
- `Total alert events` counts correlated alert-event volume, falling back to one event for older incidents without alert-event rows.
- Dashboard charts are event-weighted by default and use `Counted by alert events` labels where the value is not a plain incident count.

Dashboard metric cards and chart rows link to filtered internal views. Severity, decision, MITRE technique, and agent drilldowns open `/incidents` with query-param initialized filters. Timeline bucket clicks on the dashboard open `/incidents` with `archived=all`, exact `from`/`to` bounds, and friendly Date scope params where applicable: day/hour buckets initialize `date_scope=day&date=YYYY-MM-DD`, month buckets initialize `date_scope=month&month=YYYY-MM`, and year buckets initialize `date_scope=year&year=YYYY`. Bucket clicks on `/analytics/alerts` open a read-only alert-period drilldown. Alert drilldown pages load matching alerts progressively, 25 at a time, and infinite scroll fetches more as the analyst reaches the bottom so large alert histories are not rendered all at once. The incidents page supports `archived`, `status`, `severity`, `classification`, `decision`, `rule_level`, `mitre`, `agent`, `date_scope`, `date`, `month`, `year`, `from`, `to`, and `q` query params.

The `/incidents` page is the main active/archive workflow. It initially renders at most 25 matching cards, then loads the next 25 as the normal page scroll nears the bottom; there is no internal vertical results scrollbar. Its Archive scope filter supports Active (`archived=false`), Archived (`archived=true`), and All (`archived=all`), with Active as the default. The Date scope filter supports All, Day, Month, and Year; Day uses a date picker, Month uses a month picker, and Year uses a numeric year field. Changing search, sort, archive scope, Date scope, or any filter resets pagination to the first page. The legacy `/archive` route remains available as a compatibility shortcut and redirects to `/incidents?archived=true`.

Mobile navigation uses a polished right-side drawer with an overlay; the theme toggle and logout remain inside the drawer. Incident detail uses explicit responsive columns on desktop to avoid large grid gaps, with long activity/history/playbook/note lists scrolling internally for balance, then collapses to one ordered column on narrow screens.

Current UI pages:

- `/dashboard`: operational metrics, event/alert evolution, MITRE distribution, top agents, severity distribution, decision distribution, and navigation shortcuts.
- `/incidents`: active/archived/all incident triage with archive scope filtering, approve/reject, archive/unarchive, and detail links.
- `/archive`: compatibility shortcut to `/incidents?archived=true`.
- `/incidents/{id}`: read-only incident fields plus alert activity, observables, response actions, manual playbook, notes, timeline, and action history in a responsive two-column/masonry-style desktop layout.
- `/analytics/alerts`: read-only full alert/event timeline explorer using active plus archived history by default.
- `/analytics/mitre`: read-only full MITRE ATT&CK distribution, sorted by alert-event weighted count.
- `/report`: global executive report generated from stored incidents.

The frontend uses FastAPI's HttpOnly cookie through `/backend/*`. It uses `localStorage` only for the `soc_theme` preference and does not store auth tokens in `localStorage` or `sessionStorage`.

## Automated Demo Recording

The frontend includes a Playwright-based demo recorder for polished presentation-style videos. It navigates the admin console, injects temporary on-screen captions and a fake cursor, uses smooth human-like scrolling, and records a browser video without changing production app behavior or storing auth tokens in browser storage. The demo is read-only for incident data.

Prerequisites:

- Backend running, for example `http://192.168.56.105:8000`.
- Frontend running, for example `http://192.168.56.105:3000`.
- Frontend npm dependencies installed.
- Playwright installed locally for demo tooling: `npm install --save-dev playwright` and `npx playwright install chromium`.

Run from `frontend/`:

```bash
DEMO_ADMIN_USERNAME=admin DEMO_ADMIN_PASSWORD=admin npm run demo:record
```

The recorder automatically loads demo environment variables from `frontend/.env.demo`, then falls back to `.env.demo` in the repository root. Shell environment variables take precedence over values in `.env.demo`, so one-off overrides can be passed inline. To use a custom file, set `DEMO_ENV_FILE=/custom/path/.env.demo`.

Example `frontend/.env.demo` for faster 1080p local testing:

```env
#### video record ####
DEMO_FRONTEND_URL=http://192.168.56.105:3000
DEMO_HEADLESS=false

## 1080 ##
DEMO_VIDEO_WIDTH=1920
DEMO_VIDEO_HEIGHT=1080
DEMO_SPEED=normal
DEMO_CAPTION_MIN_MS=1400
DEMO_CAPTION_MAX_MS=3200
DEMO_CAPTION_PER_CHAR_MS=32
DEMO_PAGE_MIN_MS=1200
DEMO_PAGE_MAX_MS=2600
DEMO_CLICK_PAUSE_MS=650
DEMO_HOVER_PAUSE_MS=420
DEMO_FILTER_PAUSE_MS=900
DEMO_RANGE_PAUSE_MS=850
DEMO_SECTION_PAUSE_MS=1200
DEMO_SCROLL_MIN_MS=650
DEMO_SCROLL_MAX_MS=1600
DEMO_SLOW_MO_MS=220
DEMO_GENERATE_REPORT=true
DEMO_REPORT_TIMEOUT_MS=90000
```

Example 4K presentation block:

```env
## 4k ##
DEMO_VIDEO_WIDTH="3840"
DEMO_VIDEO_HEIGHT="2160"
DEMO_HEADLESS=true
```

Optional variables:

- `DEMO_FRONTEND_URL`: defaults to `http://192.168.56.105:3000`.
- `DEMO_BASE_URL`: legacy fallback if `DEMO_FRONTEND_URL` is not set.
- `DEMO_ADMIN_USERNAME`: defaults to `admin` for local demo convenience.
- `DEMO_ADMIN_PASSWORD`: defaults to `admin` for local demo convenience.
- `DEMO_HEADLESS`: defaults to `false` for visible local recording; set `DEMO_HEADLESS=true` for headless runs.
- `DEMO_VIDEO_WIDTH`: defaults to `1920`.
- `DEMO_VIDEO_HEIGHT`: defaults to `1080`.
- `DEMO_SPEED`: supports `slow`, `normal`, or `fast`; defaults to `normal`.
- `DEMO_SPEED_MULTIPLIER`: optional numeric multiplier such as `0.85`; overrides `DEMO_SPEED`.
- `DEMO_SLOW_MO_MS`: defaults to `120`.
- `DEMO_CAPTION_MIN_MS`: defaults to `1400`.
- `DEMO_CAPTION_MAX_MS`: defaults to `3200`.
- `DEMO_CAPTION_PER_CHAR_MS`: defaults to `32`.
- `DEMO_PAGE_MIN_MS`: defaults to `1200`.
- `DEMO_PAGE_MAX_MS`: defaults to `2600`.
- `DEMO_CLICK_PAUSE_MS`: defaults to `650`.
- `DEMO_HOVER_PAUSE_MS`: defaults to `420`.
- `DEMO_FILTER_PAUSE_MS`: defaults to `900`.
- `DEMO_RANGE_PAUSE_MS`: defaults to `850`.
- `DEMO_SECTION_PAUSE_MS`: defaults to `1200`.
- `DEMO_SCROLL_MIN_MS`: defaults to `650`.
- `DEMO_SCROLL_MAX_MS`: defaults to `1600`.
- `DEMO_GENERATE_REPORT`: defaults to `true`; the recorder clicks `Generate report` on `/report`.
- `DEMO_REPORT_TIMEOUT_MS`: defaults to `90000`; controls how long the recorder waits for generated report output.
- `DEMO_TOGGLE_THEME=true`: toggles light/dark mode once during the recording.
- `DEMO_ENV_FILE`: optional path to a specific demo env file.

For faster local test recordings, override the video size:

```bash
DEMO_VIDEO_WIDTH=1920 DEMO_VIDEO_HEIGHT=1080 DEMO_ADMIN_USERNAME=admin DEMO_ADMIN_PASSWORD=admin npm run demo:record
```

For final 4K recording, keep the same pacing and only override output size/headless mode:

```bash
DEMO_VIDEO_WIDTH=3840 DEMO_VIDEO_HEIGHT=2160 DEMO_HEADLESS=true DEMO_ADMIN_USERNAME=admin DEMO_ADMIN_PASSWORD=admin npm run demo:record
```

The output video is saved at:

```text
demo-output/soc-ai-agent-demo.webm
```

Optional high-quality 4K MP4 conversion if `ffmpeg` is installed:

```bash
ffmpeg -y -i demo-output/soc-ai-agent-demo.webm \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
  demo-output/soc-ai-agent-demo-4k.mp4
```

Faster test conversion:

```bash
ffmpeg -y -i demo-output/soc-ai-agent-demo.webm \
  -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p \
  demo-output/soc-ai-agent-demo.mp4
```

The demo covers dashboard metrics, Alert/Event Evolution, alert timeline drilldowns, MITRE analytics, incident filters and progressive loading, incident detail sections, response-action availability, and `/report`. On `/report`, it clicks `Generate report` by default and waits for the read-only generated executive summary to appear. This may call Gemini or another upstream AI service and can take time. Captions intentionally stay visible long enough for viewers to read them, and the injected cursor exists only during recording.

The demo flow opens pages, changes read-only filters, scrolls, opens drilldowns, opens an incident detail, and generates the read-only report; it does not approve, reject, archive, unarchive, execute response actions, create notes, update playbook steps, or create playbooks.

## Validation

Common validation commands:

```bash
python -m compileall main.py agent db scripts security.py playbooks response_actions
cd frontend
npm run build
npm run lint
```

For demos, run the full product manually because behavior depends on the live VM, Wazuh, FastAPI, Gemini configuration, auth state, and SQLite data.

Manual correlation checks on the logger VM:

- Send repeated brute-force alerts with the same rule/source/user inside `INCIDENT_CORRELATION_WINDOW_MINUTES`; one incident should show `event_count > 1`.
- Re-send the exact same payload; the webhook should report it as a duplicate and not add another alert event.
- Send the same pattern outside the window; a new incident should be created.
- Archive an incident, then send the same pattern again; the archived incident should not receive new events.
- Confirm no response action executes from `POST /webhook/wazuh`.

## Security Checklist

- Keep `.env` and `incidents.db` local.
- Do not commit secrets, hashes, cookies, session tokens, or AD credentials.
- Keep `AD_ACTIONS_ENABLED=false` unless intentionally testing the dry-run AD workflow.
- Keep `AD_ACTION_MODE=dry_run` for demos.
- Do not treat AD dry-run confirmation as real account disablement.
- Do not add automatic response execution to `/webhook/wazuh`.
- Do not let Gemini directly execute defensive actions.
- Keep `/report` read-only.
