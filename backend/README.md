# Backend (FastAPI) for Contest

Requirements

- Python 3.10+
- PostgreSQL

Quick start (macOS / Linux):

1. Create Python venv and install deps

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Create Postgres DB and run SQL

```bash
# example using psql
psql -c "CREATE DATABASE contestdb;"
psql -d contestdb -f init.sql
```

3. Create `.env` from `.env.example` and set `CODE_HASH` (use argon2 to hash your 3-digit code)

4. Run server

```bash
uvicorn app.main:app --reload --port 8000
```

Example API calls

- Status

```bash
curl http://localhost:8000/api/status
```

- Try wrong code

```bash
curl -X POST http://localhost:8000/api/enter-code -H "Content-Type: application/json" -d '{"code":"111"}'
```

- Reset (only when TEST_MODE=true)

```bash
curl -X POST http://localhost:8000/api/admin/reset -H "x-reset-key: dev-reset-123"
```

Notes

- The code verification uses Argon2; store only hash in `.env` and never reveal the plain code.
- The API sets a `device_id` cookie to track attempts per browser. If the frontend is on another domain, enable CORS (`CORS_ORIGINS=...`) and set `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true`, and send requests with `credentials: "include"`.
- This backend is a working skeleton implementing the contest logic and admin reset for test mode.
- Next: build frontend UI and connect to these endpoints.
