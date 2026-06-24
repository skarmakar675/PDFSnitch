from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import platform
import secrets
import smtplib
import sqlite3
import time
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import urllib.error
import urllib.request
from urllib.parse import urljoin

from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
DATA_DIR = Path(os.getenv("PDFSNITCH_DATA_DIR", str(BASE_DIR / "data"))).resolve()
UPLOAD_DIR = Path(os.getenv("PDFSNITCH_UPLOAD_DIR", str(BASE_DIR / "uploads"))).resolve()
MEDIA_DIR = Path(os.getenv("PDFSNITCH_MEDIA_DIR", str(BASE_DIR / "media"))).resolve()
EXPORT_DIR = Path(os.getenv("PDFSNITCH_EXPORT_DIR", str(BASE_DIR / "exports"))).resolve()
DB_PATH = DATA_DIR / "pdfc_app.db"

for directory in (DATA_DIR, UPLOAD_DIR, MEDIA_DIR, EXPORT_DIR):
    directory.mkdir(parents=True, exist_ok=True)

router = APIRouter()

DEFAULT_SETTINGS: dict[str, Any] = {
    "site_title": "PDFSnitch",
    "site_tagline": "Make files lighter without the quality cliff.",
    "logo_url": "",
    "favicon_url": "",
    "primary_color": "#00b894",
    "secondary_color": "#e8fff8",
    "button_text": "Compress PDF",
    "footer_text": "",
    "copyright_text": "",
    "facebook_url": "",
    "instagram_url": "",
    "youtube_url": "",
    "linkedin_url": "",
    "twitter_url": "",
    "api_base_url": "https://pdfsnitch-izhk.onrender.com",
    "compress_endpoint": "/api/compress",
    "health_endpoint": "/api/health",
    "request_timeout": "60",
    "max_upload_size": "25",
    "default_quality": "medium",
    "default_resolution": "144",
    "default_conversion": "none",
    "default_multimedia": "discard",
    "default_fonts": "unchanged",
    "allowed_file_types": ".pdf",
    "drag_drop_enabled": "true",
    "download_button_enabled": "true",
    "temporary_notice_enabled": "true",
    "success_message": "Your PDF is ready to download.",
    "error_message": "Cannot reach the PDF processing service. try again Sometime.",
    "seo_title": "PDFSnitch",
    "seo_description": "Compress PDF files online.",
    "seo_keywords": "pdf compressor, compress pdf, reduce pdf size",
    "canonical_url": "",
    "robots_index": "true",
    "og_title": "PDFSnitch",
    "og_description": "Compress PDF files online.",
    "og_image": "",
    "twitter_title": "PDFSnitch",
    "twitter_description": "Compress PDF files online.",
    "twitter_image": "",
    "org_name": "",
    "org_logo": "",
    "contact_email": "",
    "google_search_console_meta": "",
    "bing_webmaster_meta": "",
    "sitemap_url": "",
    "header_scripts": "",
    "footer_scripts": "",
    "ads_enabled": "false",
    "monetization_mode": "auto",
    "adsense_publisher_id": "",
    "auto_ads_enabled": "false",
    "auto_ads_code": "",
    "auto_generate_adsense_script": "true",
    "manual_ads_enabled": "false",
    "disable_ads_for_admin": "true",
    "disable_ads_on_mobile": "false",
    "disable_ads_on_desktop": "false",
    "ads_txt_content": "",
    "ad_above_header": "false",
    "ad_below_intro": "true",
    "ad_above_tool": "false",
    "ad_below_tool": "true",
    "ad_after_result": "true",
    "ad_footer": "true",
    "ad_sidebar": "false",
    "min_button_distance": "250",
    "disable_ads_during_compression": "true",
    "manual_ad_slots": json.dumps([
        {"name": "below_intro", "enabled": True, "type": "display", "publisherId": "", "slotId": "", "format": "auto", "responsive": True, "customHtml": "", "device": "all", "placement": "below_intro"},
        {"name": "below_tool", "enabled": True, "type": "display", "publisherId": "", "slotId": "", "format": "auto", "responsive": True, "customHtml": "", "device": "all", "placement": "below_tool"},
        {"name": "after_result", "enabled": True, "type": "display", "publisherId": "", "slotId": "", "format": "auto", "responsive": True, "customHtml": "", "device": "all", "placement": "after_result"},
        {"name": "footer", "enabled": True, "type": "display", "publisherId": "", "slotId": "", "format": "auto", "responsive": True, "customHtml": "", "device": "all", "placement": "footer"},
    ]),
}

BOOL_KEYS = {
    "robots_index", "drag_drop_enabled", "download_button_enabled", "temporary_notice_enabled",
    "ads_enabled", "auto_ads_enabled", "auto_generate_adsense_script", "manual_ads_enabled",
    "disable_ads_for_admin", "disable_ads_on_mobile", "disable_ads_on_desktop",
    "ad_above_header", "ad_below_intro", "ad_above_tool", "ad_below_tool",
    "ad_after_result", "ad_footer", "ad_sidebar", "disable_ads_during_compression",
}

EVENTS = {
    "page_view", "compress_click", "compress_success", "compress_failed", "download_click",
    "ad_slot_rendered", "ad_slot_blocked", "backend_error",
}


class LoginPayload(BaseModel):
    username: str
    password: str


class OtpVerifyPayload(BaseModel):
    challenge_id: str
    otp: str


class PasswordChangePayload(BaseModel):
    current_password: str
    new_password: str
    username: str = ""


class OtpSettingsPayload(BaseModel):
    enabled: bool = False
    email: str = ""


class TrackPayload(BaseModel):
    event_name: str
    page_url: str = ""
    event_data: dict[str, Any] | None = None
    visitor_id: str = ""
    referrer: str = ""
    browser: str = ""
    device: str = ""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_admin_storage() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS visitors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                visitor_id TEXT,
                ip_hash TEXT,
                user_agent TEXT,
                device TEXT,
                browser TEXT,
                referrer TEXT,
                page_url TEXT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                visitor_id TEXT,
                event_name TEXT,
                event_data TEXT,
                page_url TEXT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS admin_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT,
                details TEXT,
                created_at TEXT
            );
            CREATE TABLE IF NOT EXISTS admin_otp_challenges (
                challenge_id TEXT PRIMARY KEY,
                username TEXT,
                otp_hash TEXT,
                expires_at INTEGER,
                used INTEGER DEFAULT 0,
                created_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_visitors_created ON visitors(created_at);
            CREATE INDEX IF NOT EXISTS idx_visitors_visitor ON visitors(visitor_id);
            CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
            CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name);
            CREATE INDEX IF NOT EXISTS idx_admin_otp_expires ON admin_otp_challenges(expires_at);
            """
        )
        for key, value in DEFAULT_SETTINGS.items():
            connection.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (key, str(value)))
        for key, value in {
            "admin_username": os.getenv("ADMIN_USERNAME", "admin"),
            "admin_password_hash": "",
            "admin_otp_enabled": "false",
            "admin_otp_email": os.getenv("ADMIN_OTP_EMAIL", ""),
        }.items():
            connection.execute("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)", (key, value))
        connection.commit()


def get_settings() -> dict[str, Any]:
    init_admin_storage()
    values = DEFAULT_SETTINGS.copy()
    with db() as connection:
        rows = connection.execute("SELECT key, value FROM settings").fetchall()
    for row in rows:
        values[row["key"]] = row["value"]
    if isinstance(values.get("manual_ad_slots"), str):
        try:
            values["manual_ad_slots"] = json.loads(values["manual_ad_slots"])
        except json.JSONDecodeError:
            values["manual_ad_slots"] = []
    for key in BOOL_KEYS:
        values[key] = str(values.get(key, "false")).lower() in {"1", "true", "yes", "on"}
    for key in ("max_upload_size", "request_timeout", "default_resolution", "min_button_distance"):
        try:
            values[key] = int(values.get(key, DEFAULT_SETTINGS.get(key, "0")))
        except (TypeError, ValueError):
            values[key] = int(DEFAULT_SETTINGS.get(key, "0"))
    return values


def save_settings(payload: dict[str, Any]) -> dict[str, Any]:
    allowed = set(DEFAULT_SETTINGS.keys())
    clean: dict[str, str] = {}
    for key, value in payload.items():
        if key not in allowed:
            continue
        if key == "manual_ad_slots":
            slots = value if isinstance(value, list) else []
            clean[key] = json.dumps([sanitize_slot(slot) for slot in slots])
        elif key in BOOL_KEYS:
            clean[key] = "true" if bool(value) else "false"
        elif key in {"primary_color", "secondary_color"}:
            text = str(value).strip()
            clean[key] = text if text.startswith("#") and len(text) in {4, 7} else DEFAULT_SETTINGS[key]
        elif key.endswith("_url") or key in {"api_base_url", "canonical_url", "sitemap_url"}:
            clean[key] = str(value).strip()[:500]
        else:
            clean[key] = str(value).strip()[:20000]
    with db() as connection:
        for key, value in clean.items():
            connection.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, value))
        connection.execute("INSERT INTO admin_logs(action, details, created_at) VALUES(?, ?, ?)", ("save_settings", json.dumps({"keys": list(clean)}), now_iso()))
        connection.commit()
    return get_settings()


def sanitize_slot(slot: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": str(slot.get("name", "ad_slot")).strip()[:80].replace(" ", "_"),
        "enabled": bool(slot.get("enabled", False)),
        "type": str(slot.get("type", "display")) if slot.get("type") in {"display", "in_article", "multiplex", "custom_html"} else "display",
        "publisherId": str(slot.get("publisherId", "")).strip()[:80],
        "slotId": str(slot.get("slotId", "")).strip()[:80],
        "format": str(slot.get("format", "auto")) if slot.get("format") in {"auto", "rectangle", "horizontal", "vertical"} else "auto",
        "responsive": bool(slot.get("responsive", True)),
        "customHtml": str(slot.get("customHtml", ""))[:20000],
        "device": str(slot.get("device", "all")) if slot.get("device") in {"all", "desktop", "mobile"} else "all",
        "placement": str(slot.get("placement", "below_tool")) if slot.get("placement") in {"below_intro", "below_tool", "after_result", "footer", "sidebar", "shortcode_only"} else "below_tool",
    }


def public_api_base_url(settings: dict[str, Any], request: Request | None = None) -> str:
    env_url = os.getenv("PDFSNITCH_PUBLIC_API_BASE_URL", "").strip().rstrip("/")
    if env_url:
        return env_url
    configured = str(settings.get("api_base_url", "")).strip().rstrip("/")
    if configured and "127.0.0.1" not in configured and "localhost" not in configured:
        return configured
    if request:
        return str(request.base_url).rstrip("/")
    return configured or "https://pdfsnitch-izhk.onrender.com"


def public_asset_url(value: str, api_base_url: str) -> str:
    value = str(value or "").strip()
    if not value:
        return ""
    if value.startswith(("http://", "https://", "data:")):
        return value
    if value.startswith("/"):
        return f"{api_base_url}{value}"
    return urljoin(f"{api_base_url}/", value)


def frontend_settings(request: Request | None = None) -> dict[str, Any]:
    settings = get_settings()
    api_base_url = public_api_base_url(settings, request)
    publisher_id = settings["adsense_publisher_id"]
    auto_code = settings["auto_ads_code"]
    if settings["auto_generate_adsense_script"] and publisher_id:
        auto_code = f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={publisher_id}" crossorigin="anonymous"></script>'
    return {
        "siteTitle": settings["site_title"],
        "siteTagline": settings["site_tagline"],
        "logoUrl": public_asset_url(settings["logo_url"], api_base_url),
        "faviconUrl": public_asset_url(settings["favicon_url"], api_base_url),
        "primaryColor": settings["primary_color"],
        "secondaryColor": settings["secondary_color"],
        "buttonText": settings["button_text"],
        "footerText": settings["footer_text"],
        "apiBaseUrl": api_base_url,
        "compressEndpoint": settings["compress_endpoint"],
        "maxUploadSize": settings["max_upload_size"],
        "defaultQuality": settings["default_quality"],
        "defaultResolution": settings["default_resolution"],
        "defaultConversion": settings["default_conversion"],
        "defaultMultimedia": settings["default_multimedia"],
        "defaultFonts": settings["default_fonts"],
        "successMessage": settings["success_message"],
        "errorMessage": settings["error_message"],
        "seo": {
            "title": settings["seo_title"],
            "description": settings["seo_description"],
            "keywords": settings["seo_keywords"],
            "canonicalUrl": settings["canonical_url"],
            "robotsIndex": settings["robots_index"],
            "ogTitle": settings["og_title"],
            "ogDescription": settings["og_description"],
            "ogImage": settings["og_image"],
            "twitterTitle": settings["twitter_title"],
            "twitterDescription": settings["twitter_description"],
            "twitterImage": settings["twitter_image"],
            "organizationName": settings["org_name"],
            "organizationLogo": settings["org_logo"],
            "contactEmail": settings["contact_email"],
            "googleSearchConsoleMeta": settings["google_search_console_meta"],
            "bingWebmasterMeta": settings["bing_webmaster_meta"],
        },
        "ads": {
            "enabled": settings["ads_enabled"],
            "mode": settings["monetization_mode"],
            "publisherId": publisher_id,
            "autoAdsEnabled": settings["auto_ads_enabled"],
            "autoAdsCode": auto_code,
            "manualAdsEnabled": settings["manual_ads_enabled"],
            "disableAdsForAdmin": settings["disable_ads_for_admin"],
            "disableAdsOnMobile": settings["disable_ads_on_mobile"],
            "disableAdsOnDesktop": settings["disable_ads_on_desktop"],
            "placements": {
                "aboveHeader": settings["ad_above_header"],
                "belowIntro": settings["ad_below_intro"],
                "aboveTool": settings["ad_above_tool"],
                "belowTool": settings["ad_below_tool"],
                "afterResult": settings["ad_after_result"],
                "footer": settings["ad_footer"],
                "sidebar": settings["ad_sidebar"],
            },
            "safety": {
                "minButtonDistance": settings["min_button_distance"],
                "disableDuringCompression": settings["disable_ads_during_compression"],
            },
            "slots": settings["manual_ad_slots"],
        },
        "scripts": {
            "header": settings["header_scripts"],
            "footer": settings["footer_scripts"],
        },
    }


def secret_key() -> str:
    return os.getenv("ADMIN_SECRET_KEY", "change-this-secret")


def get_setting_value(key: str, fallback: str = "") -> str:
    init_admin_storage()
    with db() as connection:
        row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else fallback


def set_setting_values(values: dict[str, str]) -> None:
    with db() as connection:
        for key, value in values.items():
            connection.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, value))
        connection.commit()


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 240000)
    return f"pbkdf2_sha256${salt}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, stored_hash: str) -> bool:
    if not stored_hash:
        return secrets.compare_digest(password, os.getenv("ADMIN_PASSWORD", "admin123"))
    try:
        algorithm, salt, digest = stored_hash.split("$", 2)
        if algorithm != "pbkdf2_sha256":
            return False
        return secrets.compare_digest(hash_password(password, salt), stored_hash)
    except ValueError:
        return False


def admin_username() -> str:
    return get_setting_value("admin_username", os.getenv("ADMIN_USERNAME", "admin"))


def env_truthy(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def admin_otp_enabled() -> bool:
    setting_enabled = get_setting_value("admin_otp_enabled", "false").lower() in {"1", "true", "yes", "on"}
    return setting_enabled or env_truthy("ADMIN_OTP_ENABLED")


def mask_email(email: str) -> str:
    if "@" not in email:
        return email[:2] + "***"
    name, domain = email.split("@", 1)
    return f"{name[:2]}***@{domain}"


def send_otp_email(email: str, code: str) -> None:
    subject = "Your PDFSnitch admin OTP"
    text = f"Your PDFSnitch admin login OTP is: {code}\n\nThis code expires in 10 minutes. If you did not request it, ignore this email."
    resend_key = os.getenv("RESEND_API_KEY", "").strip()
    if resend_key:
        resend_from = os.getenv("RESEND_FROM_EMAIL", "PDFSnitch <onboarding@resend.dev>").strip()
        payload = json.dumps({"from": resend_from, "to": [email], "subject": subject, "text": text}).encode()
        request = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={"Authorization": f"Bearer {resend_key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status >= 400:
                    raise HTTPException(503, "Resend email API failed. Check RESEND_API_KEY and RESEND_FROM_EMAIL.")
            return
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")[:300]
            raise HTTPException(503, f"Resend email API failed: {detail or exc.reason}") from exc
        except OSError as exc:
            raise HTTPException(503, "Cannot connect to Resend email API. Check Render outbound HTTPS/network status.") from exc

    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM_EMAIL", username or email).strip()
    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in {"1", "true", "yes", "on"}
    if not host or not sender:
        raise HTTPException(503, "SMTP email is not configured. Add SMTP_HOST and SMTP_FROM_EMAIL in backend/.env, then restart backend.")
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = email
    message.set_content(text)
    try:
        with smtplib.SMTP(host, port, timeout=30) as server:
            if use_tls:
                server.starttls()
            if username and password:
                server.login(username, password)
            server.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        raise HTTPException(503, "SMTP login failed. Check your Gmail app password in Render environment variables.") from exc
    except smtplib.SMTPException as exc:
        raise HTTPException(503, f"SMTP email failed: {exc}") from exc
    except OSError as exc:
        raise HTTPException(503, "Cannot connect to SMTP server. Check SMTP_HOST, SMTP_PORT and SMTP_USE_TLS.") from exc


def create_otp_challenge(username: str, email: str) -> dict[str, str]:
    code = f"{secrets.randbelow(1000000):06d}"
    challenge_id = secrets.token_urlsafe(24)
    otp_hash = hmac.new(secret_key().encode(), f"{challenge_id}:{code}".encode(), hashlib.sha256).hexdigest()
    expires = int(time.time()) + 10 * 60
    send_otp_email(email, code)
    with db() as connection:
        connection.execute("DELETE FROM admin_otp_challenges WHERE expires_at < ? OR username = ?", (int(time.time()), username))
        connection.execute(
            "INSERT INTO admin_otp_challenges(challenge_id, username, otp_hash, expires_at, used, created_at) VALUES(?, ?, ?, ?, 0, ?)",
            (challenge_id, username, otp_hash, expires, now_iso()),
        )
        connection.commit()
    return {"challengeId": challenge_id, "emailMasked": mask_email(email)}


def sign_token(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    signature = hmac.new(secret_key().encode(), body.encode(), hashlib.sha256).digest()
    sig = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"{body}.{sig}"


def verify_token(token: str) -> dict[str, Any]:
    try:
        body, sig = token.split(".", 1)
        expected = base64.urlsafe_b64encode(hmac.new(secret_key().encode(), body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        if not hmac.compare_digest(sig, expected):
            raise ValueError("bad signature")
        padded = body + "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
        if payload.get("exp", 0) < int(time.time()):
            raise ValueError("expired")
        return payload
    except Exception as exc:
        raise HTTPException(401, "Invalid or expired admin session.") from exc


def require_admin(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Admin login required.")
    return verify_token(authorization.split(" ", 1)[1])


def hash_ip(request: Request) -> str:
    client = request.client.host if request.client else ""
    return hashlib.sha256(f"{client}:{secret_key()}".encode()).hexdigest()


def date_bounds(period: str) -> tuple[str, str]:
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "yesterday":
        start, end = today - timedelta(days=1), today
    elif period == "last30":
        start, end = today - timedelta(days=30), today + timedelta(days=1)
    elif period == "month":
        start, end = today.replace(day=1), today + timedelta(days=1)
    elif period == "today":
        start, end = today, today + timedelta(days=1)
    else:
        start, end = today - timedelta(days=7), today + timedelta(days=1)
    return start.isoformat(), end.isoformat()


def count_events(name: str | None = None, start: str | None = None, end: str | None = None) -> int:
    clauses, params = [], []
    if name:
        clauses.append("event_name = ?")
        params.append(name)
    if start:
        clauses.append("created_at >= ?")
        params.append(start)
    if end:
        clauses.append("created_at < ?")
        params.append(end)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with db() as connection:
        return int(connection.execute(f"SELECT COUNT(*) AS total FROM events{where}", params).fetchone()["total"])


def unique_visitors(start: str | None = None, end: str | None = None) -> int:
    clauses, params = [], []
    if start:
        clauses.append("created_at >= ?")
        params.append(start)
    if end:
        clauses.append("created_at < ?")
        params.append(end)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with db() as connection:
        return int(connection.execute(f"SELECT COUNT(DISTINCT visitor_id) AS total FROM visitors{where}", params).fetchone()["total"])


def api_status() -> dict[str, Any]:
    settings = get_settings()
    url = urljoin(str(settings["api_base_url"]).rstrip("/") + "/", str(settings["health_endpoint"]).lstrip("/"))
    started = time.perf_counter()
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=min(int(settings["request_timeout"]), 10)) as response:
            elapsed = round((time.perf_counter() - started) * 1000)
            return {"connected": 200 <= response.status < 500, "statusCode": response.status, "responseTimeMs": elapsed, "error": ""}
    except Exception as exc:
        elapsed = round((time.perf_counter() - started) * 1000)
        return {"connected": False, "statusCode": None, "responseTimeMs": elapsed, "error": str(exc)}


@router.post("/api/admin/login")
def login(payload: LoginPayload):
    username = admin_username()
    stored_hash = get_setting_value("admin_password_hash", "")
    if not (secrets.compare_digest(payload.username, username) and verify_password(payload.password, stored_hash)):
        raise HTTPException(401, "Invalid username or password.")
    otp_enabled = admin_otp_enabled()
    otp_email = get_setting_value("admin_otp_email", os.getenv("ADMIN_OTP_EMAIL", "")).strip()
    if otp_enabled:
        if not otp_email:
            raise HTTPException(503, "Email OTP is enabled but admin OTP email is missing.")
        challenge = create_otp_challenge(username, otp_email)
        return {"requiresOtp": True, **challenge}
    token = sign_token({"sub": username, "iat": int(time.time()), "exp": int(time.time()) + 12 * 60 * 60})
    with db() as connection:
        connection.execute("INSERT INTO admin_logs(action, details, created_at) VALUES(?, ?, ?)", ("login", json.dumps({"username": username}), now_iso()))
        connection.commit()
    return {"token": token, "username": username}


@router.post("/api/admin/login/verify-otp")
def verify_login_otp(payload: OtpVerifyPayload):
    with db() as connection:
        row = connection.execute(
            "SELECT challenge_id, username, otp_hash, expires_at, used FROM admin_otp_challenges WHERE challenge_id = ?",
            (payload.challenge_id,),
        ).fetchone()
        if not row or int(row["used"]) or int(row["expires_at"]) < int(time.time()):
            raise HTTPException(401, "OTP is invalid or expired.")
        expected = hmac.new(secret_key().encode(), f"{payload.challenge_id}:{payload.otp.strip()}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, row["otp_hash"]):
            raise HTTPException(401, "OTP is invalid or expired.")
        connection.execute("UPDATE admin_otp_challenges SET used = 1 WHERE challenge_id = ?", (payload.challenge_id,))
        connection.execute("INSERT INTO admin_logs(action, details, created_at) VALUES(?, ?, ?)", ("login_otp", json.dumps({"username": row["username"]}), now_iso()))
        connection.commit()
    token = sign_token({"sub": row["username"], "iat": int(time.time()), "exp": int(time.time()) + 12 * 60 * 60})
    return {"token": token, "username": row["username"]}


@router.post("/api/admin/logout")
def logout(_admin: dict[str, Any] = Depends(require_admin)):
    return {"ok": True}


@router.get("/api/admin/me")
def me(admin: dict[str, Any] = Depends(require_admin)):
    return {"username": admin.get("sub", "admin")}


@router.get("/api/admin/security")
def get_security(_admin: dict[str, Any] = Depends(require_admin)):
    return {
        "username": admin_username(),
        "otpEnabled": admin_otp_enabled(),
        "otpEmail": get_setting_value("admin_otp_email", os.getenv("ADMIN_OTP_EMAIL", "")),
        "smtpConfigured": bool(os.getenv("SMTP_HOST", "").strip() and os.getenv("SMTP_FROM_EMAIL", os.getenv("SMTP_USERNAME", "")).strip()),
    }


@router.post("/api/admin/security/password")
def change_password(payload: PasswordChangePayload, _admin: dict[str, Any] = Depends(require_admin)):
    if len(payload.new_password) < 8:
        raise HTTPException(400, "New password must contain at least 8 characters.")
    stored_hash = get_setting_value("admin_password_hash", "")
    if not verify_password(payload.current_password, stored_hash):
        raise HTTPException(401, "Current password is incorrect.")
    username = payload.username.strip()[:80] or admin_username()
    set_setting_values({"admin_username": username, "admin_password_hash": hash_password(payload.new_password)})
    with db() as connection:
        connection.execute("INSERT INTO admin_logs(action, details, created_at) VALUES(?, ?, ?)", ("change_password", json.dumps({"username": username}), now_iso()))
        connection.commit()
    return {"ok": True, "username": username}


@router.post("/api/admin/security/otp")
def save_otp_settings(payload: OtpSettingsPayload, _admin: dict[str, Any] = Depends(require_admin)):
    email = payload.email.strip()[:320]
    if payload.enabled and ("@" not in email or "." not in email.split("@")[-1]):
        raise HTTPException(400, "Enter a valid email address before enabling OTP.")
    set_setting_values({"admin_otp_enabled": "true" if payload.enabled else "false", "admin_otp_email": email})
    with db() as connection:
        connection.execute("INSERT INTO admin_logs(action, details, created_at) VALUES(?, ?, ?)", ("save_otp_settings", json.dumps({"enabled": payload.enabled, "email": mask_email(email) if email else ""}), now_iso()))
        connection.commit()
    return get_security(_admin)


@router.get("/api/public/settings")
def public_settings(request: Request):
    return frontend_settings(request)


@router.post("/api/track")
async def track(payload: TrackPayload, request: Request):
    if payload.event_name not in EVENTS:
        raise HTTPException(400, "Unsupported event name.")
    visitor_id = payload.visitor_id.strip()[:120] or hashlib.sha256(f"{hash_ip(request)}:{request.headers.get('user-agent', '')}".encode()).hexdigest()
    user_agent = request.headers.get("user-agent", "")[:1000]
    created = now_iso()
    with db() as connection:
        if payload.event_name == "page_view":
            connection.execute(
                "INSERT INTO visitors(visitor_id, ip_hash, user_agent, device, browser, referrer, page_url, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (visitor_id, hash_ip(request), user_agent, payload.device[:50], payload.browser[:100], payload.referrer[:1000], payload.page_url[:1000], created),
            )
        connection.execute(
            "INSERT INTO events(visitor_id, event_name, event_data, page_url, created_at) VALUES(?, ?, ?, ?, ?)",
            (visitor_id, payload.event_name, json.dumps(payload.event_data or {}), payload.page_url[:1000], created),
        )
        connection.commit()
    return {"ok": True}


@router.get("/api/admin/dashboard-stats")
def dashboard_stats(_admin: dict[str, Any] = Depends(require_admin)):
    today_start, today_end = date_bounds("today")
    yesterday_start, yesterday_end = date_bounds("yesterday")
    week_start, week_end = date_bounds("last7")
    month_start, month_end = date_bounds("month")
    settings = get_settings()
    return {
        "todayVisitors": unique_visitors(today_start, today_end),
        "yesterdayVisitors": unique_visitors(yesterday_start, yesterday_end),
        "last7DaysVisitors": unique_visitors(week_start, week_end),
        "thisMonthVisitors": unique_visitors(month_start, month_end),
        "totalVisitors": unique_visitors(),
        "totalPageViews": count_events("page_view"),
        "totalCompressClicks": count_events("compress_click"),
        "totalSuccessfulCompressions": count_events("compress_success"),
        "totalFailedCompressions": count_events("compress_failed"),
        "totalDownloadClicks": count_events("download_click"),
        "backendStatus": api_status(),
        "settingsSummary": {"siteTitle": settings["site_title"], "apiBaseUrl": settings["api_base_url"], "maxUploadSize": settings["max_upload_size"]},
        "monetizationStatus": {"enabled": settings["ads_enabled"], "mode": settings["monetization_mode"], "autoAds": settings["auto_ads_enabled"], "manualAds": settings["manual_ads_enabled"]},
    }


@router.get("/api/admin/analytics/summary")
def analytics_summary(period: str = "last7", _admin: dict[str, Any] = Depends(require_admin)):
    start, end = date_bounds(period)
    return {
        "period": period,
        "uniqueVisitors": unique_visitors(start, end),
        "pageViews": count_events("page_view", start, end),
        "compressClicks": count_events("compress_click", start, end),
        "compressSuccess": count_events("compress_success", start, end),
        "compressFailed": count_events("compress_failed", start, end),
        "downloads": count_events("download_click", start, end),
    }


def grouped_events(group_expr: str, limit: int = 60) -> list[dict[str, Any]]:
    with db() as connection:
        rows = connection.execute(
            f"SELECT {group_expr} AS label, COUNT(*) AS events, COUNT(DISTINCT visitor_id) AS visitors FROM events GROUP BY label ORDER BY label DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


@router.get("/api/admin/analytics/daily")
def analytics_daily(_admin: dict[str, Any] = Depends(require_admin)):
    return grouped_events("substr(created_at, 1, 10)", 90)


@router.get("/api/admin/analytics/weekly")
def analytics_weekly(_admin: dict[str, Any] = Depends(require_admin)):
    return grouped_events("strftime('%Y-W%W', created_at)", 60)


@router.get("/api/admin/analytics/monthly")
def analytics_monthly(_admin: dict[str, Any] = Depends(require_admin)):
    return grouped_events("substr(created_at, 1, 7)", 36)


@router.get("/api/admin/analytics/top-pages")
def analytics_top_pages(_admin: dict[str, Any] = Depends(require_admin)):
    with db() as connection:
        rows = connection.execute("SELECT page_url, COUNT(*) AS views FROM events WHERE event_name = 'page_view' GROUP BY page_url ORDER BY views DESC LIMIT 25").fetchall()
    return [dict(row) for row in rows]


@router.get("/api/admin/analytics/referrers")
def analytics_referrers(_admin: dict[str, Any] = Depends(require_admin)):
    with db() as connection:
        rows = connection.execute("SELECT referrer, COUNT(*) AS visits FROM visitors GROUP BY referrer ORDER BY visits DESC LIMIT 25").fetchall()
    return [dict(row) for row in rows]


@router.get("/api/admin/analytics/events")
def analytics_events(limit: int = 100, _admin: dict[str, Any] = Depends(require_admin)):
    limit = min(max(limit, 1), 500)
    with db() as connection:
        rows = connection.execute("SELECT id, visitor_id, event_name, event_data, page_url, created_at FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]


@router.get("/api/admin/analytics/export-csv")
def analytics_export_csv(_admin: dict[str, Any] = Depends(require_admin)):
    with db() as connection:
        rows = connection.execute("SELECT visitor_id, event_name, event_data, page_url, created_at FROM events ORDER BY id DESC").fetchall()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["visitor_id", "event_name", "event_data", "page_url", "created_at"])
    for row in rows:
        writer.writerow([row["visitor_id"], row["event_name"], row["event_data"], row["page_url"], row["created_at"]])
    return Response(output.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=pdfc-analytics.csv"})


@router.get("/api/admin/settings")
def admin_get_settings(_admin: dict[str, Any] = Depends(require_admin)):
    return get_settings()


@router.post("/api/admin/settings")
async def admin_save_settings(request: Request, _admin: dict[str, Any] = Depends(require_admin)):
    return save_settings(await request.json())


def save_media_file(upload: UploadFile, kind: str) -> str:
    extension = Path(upload.filename or "").suffix.lower()
    if extension not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".svg"}:
        raise HTTPException(415, "Only image files are allowed.")
    data = upload.file.read(3 * 1024 * 1024 + 1)
    if len(data) > 3 * 1024 * 1024:
        raise HTTPException(413, "Image must be 3 MB or smaller.")
    if extension != ".svg":
        try:
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(415, "Uploaded file is not a valid image.") from exc
    filename = f"{kind}-{secrets.token_hex(8)}{extension}"
    (MEDIA_DIR / filename).write_bytes(data)
    return f"/api/media/{filename}"


@router.get("/api/media/{filename}")
def get_media(filename: str):
    safe_name = Path(filename).name
    path = MEDIA_DIR / safe_name
    if not path.exists():
        raise HTTPException(404, "Media not found.")
    return FileResponse(path)


@router.post("/api/admin/media/upload-logo")
def upload_logo(file: UploadFile = File(...), _admin: dict[str, Any] = Depends(require_admin)):
    url = save_media_file(file, "logo")
    return save_settings({"logo_url": url})


@router.post("/api/admin/media/upload-favicon")
def upload_favicon(file: UploadFile = File(...), _admin: dict[str, Any] = Depends(require_admin)):
    url = save_media_file(file, "favicon")
    return save_settings({"favicon_url": url})


@router.delete("/api/admin/media/logo")
def delete_logo(_admin: dict[str, Any] = Depends(require_admin)):
    return save_settings({"logo_url": ""})


@router.delete("/api/admin/media/favicon")
def delete_favicon(_admin: dict[str, Any] = Depends(require_admin)):
    return save_settings({"favicon_url": ""})


@router.post("/api/admin/test-backend")
def test_backend(_admin: dict[str, Any] = Depends(require_admin)):
    return api_status()


@router.post("/api/admin/tools/clear-analytics")
def clear_analytics(_admin: dict[str, Any] = Depends(require_admin)):
    with db() as connection:
        connection.execute("DELETE FROM visitors")
        connection.execute("DELETE FROM events")
        connection.execute("INSERT INTO admin_logs(action, details, created_at) VALUES(?, ?, ?)", ("clear_analytics", "{}", now_iso()))
        connection.commit()
    return {"ok": True}


@router.post("/api/admin/tools/reset-settings")
def reset_settings(_admin: dict[str, Any] = Depends(require_admin)):
    with db() as connection:
        connection.execute("DELETE FROM settings")
        for key, value in DEFAULT_SETTINGS.items():
            connection.execute("INSERT INTO settings(key, value) VALUES(?, ?)", (key, str(value)))
        connection.commit()
    return get_settings()


@router.get("/api/admin/tools/export-settings")
def export_settings(_admin: dict[str, Any] = Depends(require_admin)):
    payload = json.dumps(get_settings(), indent=2)
    return Response(payload, media_type="application/json", headers={"Content-Disposition": "attachment; filename=pdfc-settings.json"})


@router.post("/api/admin/tools/import-settings")
async def import_settings(request: Request, _admin: dict[str, Any] = Depends(require_admin)):
    return save_settings(await request.json())


@router.get("/api/admin/tools/system-check")
def system_check(_admin: dict[str, Any] = Depends(require_admin)):
    settings = get_settings()
    return {
        "pythonVersion": platform.python_version(),
        "fastapiStatus": "ok",
        "sqliteStatus": DB_PATH.exists(),
        "databasePath": str(DB_PATH),
        "uploadFolderStatus": UPLOAD_DIR.exists(),
        "mediaFolderStatus": MEDIA_DIR.exists(),
        "exportFolderStatus": EXPORT_DIR.exists(),
        "frontendUrl": "http://127.0.0.1:5173",
        "backendUrl": settings["api_base_url"],
        "backendStatus": api_status(),
    }


@router.get("/ads.txt", response_class=PlainTextResponse)
def ads_txt():
    settings = get_settings()
    content = str(settings.get("ads_txt_content") or "").strip()
    publisher = str(settings.get("adsense_publisher_id") or "").replace("ca-", "")
    if not content and publisher:
        content = f"google.com, {publisher}, DIRECT, f08c47fec0942fa0"
    return PlainTextResponse(content + ("\n" if content else ""))
