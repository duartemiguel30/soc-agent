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
- `POST /incidents/{id}/approve`
- `POST /incidents/{id}/reject`
- `GET /report`

Public backend routes:

- `GET /health`
- `POST /webhook/wazuh`
- `GET /` serving the legacy fallback dashboard

The Wazuh webhook remains public because Wazuh calls it directly.

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
