import os
import asyncio
import hashlib
import re
import secrets
import smtplib
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage

import asyncpg
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
CODE_HASH = os.getenv("CODE_HASH")
ACTOR_PEPPER = os.getenv("ACTOR_PEPPER", "")
TEST_MODE = os.getenv("TEST_MODE", "false").lower() == "true"
ADMIN_RESET_KEY = os.getenv("ADMIN_RESET_KEY")
BLOCK_MINUTES = int(os.getenv("BLOCK_MINUTES", "10"))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
ALLOW_CREDENTIALS = os.getenv("CORS_ALLOW_CREDENTIALS", "true").lower() == "true"
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true" if not TEST_MODE else "false").lower() == "true"
COOKIE_SAMESITE = os.getenv("COOKIE_SAMESITE", "lax").lower()
DEVICE_COOKIE_NAME = "device_id"
DEVICE_COOKIE_MAX_AGE_DAYS = int(os.getenv("DEVICE_COOKIE_MAX_AGE_DAYS", "365"))
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")

SMTP_HOST = os.getenv("SMTP_HOST")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD")
SMTP_FROM = os.getenv("SMTP_FROM") or SMTP_USER
SMTP_TO = os.getenv("SMTP_TO")
SMTP_TLS = os.getenv("SMTP_TLS", "true").lower() == "true"

ph = PasswordHasher()
app = FastAPI()
pool: asyncpg.pool.Pool | None = None

if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    COOKIE_SAMESITE = "lax"


class EnterCodeBody(BaseModel):
    code: str


class SubmitContactBody(BaseModel):
    claimToken: str
    name: str
    email: str
    phone: str | None = None


@app.on_event("startup")
async def startup():
    global pool
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required")
    if not CODE_HASH:
        raise RuntimeError("CODE_HASH is required")
    if TEST_MODE and not ADMIN_RESET_KEY:
        raise RuntimeError("TEST_MODE=true requires ADMIN_RESET_KEY")
    pool = await asyncpg.create_pool(DATABASE_URL)


@app.on_event("shutdown")
async def shutdown():
    global pool
    if pool:
        await pool.close()


def sha256_hex(v: str) -> str:
    return hashlib.sha256(v.encode("utf-8")).hexdigest()


def get_actor_hash(request: Request) -> str:
    ip = request.client.host or ""
    ua = request.headers.get("user-agent", "")
    device = getattr(request.state, "device_id", "") or request.cookies.get(DEVICE_COOKIE_NAME, "")
    return sha256_hex(f"{ip}|{ua}|{device}|{ACTOR_PEPPER}")


def normalize_device_id(value: str | None) -> str:
    if not value:
        return ""
    value = value.strip()
    if not DEVICE_ID_RE.fullmatch(value):
        return ""
    return value


@app.middleware("http")
async def ensure_device_cookie(request: Request, call_next):
    header_device_id = normalize_device_id(request.headers.get("x-device-id"))
    cookie_device_id = normalize_device_id(request.cookies.get(DEVICE_COOKIE_NAME))

    set_cookie = False
    if header_device_id:
        device_id = header_device_id
        set_cookie = cookie_device_id != header_device_id
    elif cookie_device_id:
        device_id = cookie_device_id
    else:
        device_id = secrets.token_hex(16)
        set_cookie = True

    request.state.device_id = device_id
    response = await call_next(request)

    if set_cookie:
        max_age = DEVICE_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60
        response.set_cookie(
            DEVICE_COOKIE_NAME,
            device_id,
            max_age=max_age,
            httponly=True,
            secure=COOKIE_SECURE,
            samesite=COOKIE_SAMESITE,
            path="/",
        )
    return response


def send_email_sync(subject: str, body: str) -> None:
    if not SMTP_HOST or not SMTP_TO or not SMTP_FROM:
        raise RuntimeError("SMTP is not configured")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = SMTP_FROM
    message["To"] = SMTP_TO
    message.set_content(body)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as server:
        server.ehlo()
        if SMTP_TLS:
            server.starttls()
            server.ehlo()
        if SMTP_USER and SMTP_PASSWORD:
            server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(message)


if CORS_ORIGINS:
    allow_credentials = ALLOW_CREDENTIALS
    if CORS_ORIGINS == ["*"]:
        allow_credentials = False
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/api/status")
async def status():
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT winner_actor_hash FROM contest_state WHERE id=1")
        closed = bool(row and row.get("winner_actor_hash"))
        return {"ok": True, "closed": closed}


@app.post("/api/enter-code")
async def enter_code(body: EnterCodeBody, request: Request):
    code = (body.code or "").strip()
    if not re.fullmatch(r"[0-9A-Z]{4}", code):
        return JSONResponse({"ok": False, "reason": "invalid_format"}, status_code=400)

    actor_hash = get_actor_hash(request)

    async with pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            state = await conn.fetchrow("SELECT winner_actor_hash FROM contest_state WHERE id=1 FOR UPDATE")
            if state and state.get("winner_actor_hash"):
                await tr.rollback()
                return JSONResponse({"ok": False, "reason": "already_won"}, status_code=409)

            lock = await conn.fetchrow(
                "SELECT failed_count, blocked_until FROM attempt_locks WHERE actor_hash=$1 FOR UPDATE",
                actor_hash,
            )

            now = datetime.now(timezone.utc)
            if lock and lock.get("blocked_until") and lock["blocked_until"] > now:
                await tr.rollback()
                return JSONResponse(
                    {"ok": False, "reason": "blocked", "blockedUntil": lock["blocked_until"].isoformat()},
                    status_code=429,
                )

            # verify code
            try:
                ok = ph.verify(CODE_HASH, code)
            except VerifyMismatchError:
                ok = False

            if not ok:
                failed = (lock["failed_count"] if lock else 0) + 1
                if not lock:
                    await conn.execute(
                        "INSERT INTO attempt_locks(actor_hash, failed_count) VALUES($1,$2)", actor_hash, failed
                    )
                else:
                    await conn.execute(
                        "UPDATE attempt_locks SET failed_count=$2 WHERE actor_hash=$1", actor_hash, failed
                    )

                if failed >= 3:
                    blocked_until = now + timedelta(minutes=BLOCK_MINUTES)
                    await conn.execute(
                        "UPDATE attempt_locks SET failed_count=0, blocked_until=$2 WHERE actor_hash=$1",
                        actor_hash,
                        blocked_until,
                    )

                    await tr.commit()
                    return JSONResponse(
                        {"ok": False, "reason": "blocked", "blockedUntil": blocked_until.isoformat()},
                        status_code=429,
                    )

                remaining = max(0, 3 - failed)
                await tr.commit()
                return JSONResponse({"ok": False, "reason": "wrong_code", "remaining": remaining}, status_code=401)

            # correct code: create claim token and set winner
            raw_token = secrets.token_hex(32)
            token_hash = sha256_hex(raw_token)

            await conn.execute(
                "UPDATE contest_state SET winner_actor_hash=$1, winner_claimed_at=NOW() WHERE id=1",
                actor_hash,
            )

            await conn.execute(
                "INSERT INTO winner_claim_tokens(token_hash, actor_hash, expires_at) VALUES($1,$2,NOW()+INTERVAL '15 minutes')",
                token_hash,
                actor_hash,
            )

            await tr.commit()
            return JSONResponse({"ok": True, "claimToken": raw_token})
        except Exception:
            await tr.rollback()
            return JSONResponse({"ok": False, "reason": "server_error"}, status_code=500)


@app.post("/api/submit-contact")
async def submit_contact(body: SubmitContactBody, _request: Request):
    claimToken = (body.claimToken or "").strip()
    if not claimToken or not body.name or not body.email:
        return JSONResponse({"ok": False, "reason": "invalid_payload"}, status_code=400)

    token_hash = sha256_hex(claimToken)

    async with pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            token = await conn.fetchrow(
                "SELECT actor_hash, used_at, expires_at FROM winner_claim_tokens WHERE token_hash=$1 FOR UPDATE",
                token_hash,
            )
            if not token:
                await tr.rollback()
                return JSONResponse({"ok": False, "reason": "unauthorized"}, status_code=401)

            if token["used_at"] or token["expires_at"] < datetime.now(timezone.utc):
                await tr.rollback()
                return JSONResponse({"ok": False, "reason": "unauthorized"}, status_code=401)

            await conn.execute(
                "INSERT INTO winner_contacts(actor_hash, name, email, phone) VALUES($1,$2,$3,$4)",
                token["actor_hash"],
                body.name.strip(),
                body.email.strip(),
                (body.phone or "").strip() or None,
            )

            await conn.execute("UPDATE winner_claim_tokens SET used_at=NOW() WHERE token_hash=$1", token_hash)
            await conn.execute("UPDATE contest_state SET contact_submitted=true WHERE id=1")
            await tr.commit()

            email_sent = False
            if SMTP_HOST and SMTP_TO and SMTP_FROM:
                subject = "Ny vinnare - Gymkompaniet"
                lines = [
                    "En vinnare har skickat in sina uppgifter.",
                    "",
                    f"Namn: {body.name.strip()}",
                    f"E-post: {body.email.strip()}",
                ]
                if body.phone:
                    lines.append(f"Telefon: {body.phone.strip()}")
                body_text = "\n".join(lines)
                try:
                    await asyncio.to_thread(send_email_sync, subject, body_text)
                    email_sent = True
                except Exception:
                    email_sent = False

            return {"ok": True, "emailSent": email_sent}
        except Exception:
            await tr.rollback()
            return JSONResponse({"ok": False, "reason": "server_error"}, status_code=500)


@app.post("/api/admin/reset")
async def admin_reset(request: Request):
    if not TEST_MODE:
        return JSONResponse({"ok": False, "reason": "not_found"}, status_code=404)

    key = request.headers.get("x-reset-key")
    if not key or key != ADMIN_RESET_KEY:
        return JSONResponse({"ok": False, "reason": "unauthorized"}, status_code=401)

    async with pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            await conn.execute(
                "UPDATE contest_state SET winner_actor_hash = NULL, winner_claimed_at = NULL, contact_submitted = false WHERE id = 1"
            )
            await conn.execute("DELETE FROM winner_claim_tokens")
            await conn.execute("DELETE FROM winner_contacts")
            await conn.execute("DELETE FROM attempt_locks")
            await tr.commit()
            return {"ok": True, "reset": True}
        except Exception:
            await tr.rollback()
            return JSONResponse({"ok": False, "reason": "server_error"}, status_code=500)
