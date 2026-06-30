from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from pathlib import Path
import zipfile
import io
import os
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import get_admin_user
from app.config import get_settings
from app import models

router = APIRouter(prefix="/settings", tags=["settings"])

SETTING_KEYS = ["public_url", "max_upload_mb", "analysis_workers", "features_streaming", "features_export"]


def _get_db_settings(db: Session) -> dict:
    rows = db.query(models.AppSetting).all()
    return {row.key: row.value for row in rows}


def _set_db_setting(db: Session, key: str, value: str):
    row = db.query(models.AppSetting).filter(models.AppSetting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(models.AppSetting(key=key, value=value))
    db.commit()


@router.get("/")
def get_settings_endpoint(
    db: Session = Depends(get_db),
    _admin=Depends(get_admin_user),
):
    cfg = get_settings()
    db_settings = _get_db_settings(db)
    return {
        "public_url": db_settings.get("public_url", cfg.public_url),
        "max_upload_mb": int(db_settings.get("max_upload_mb", cfg.max_upload_mb)),
        "analysis_workers": int(db_settings.get("analysis_workers", cfg.analysis_workers)),
        "port": cfg.port,
        "features_streaming": db_settings.get("features_streaming", "true") == "true",
        "features_export": db_settings.get("features_export", "true") == "true",
        "spotify_configured": bool(cfg.spotify_client_id),
    }


@router.patch("/")
def update_settings(
    body: dict,
    db: Session = Depends(get_db),
    _admin=Depends(get_admin_user),
):
    for key, val in body.items():
        if key in SETTING_KEYS:
            _set_db_setting(db, key, str(val))
    return {"detail": "Settings updated"}


class CookiesBody(BaseModel):
    cookies: str


@router.get("/youtube-cookies")
def get_youtube_cookies(
    _admin=Depends(get_admin_user),
):
    cfg = get_settings()
    cookie_path = Path(cfg.data_dir) / "youtube_cookies.txt"
    return {"configured": cookie_path.exists()}


@router.post("/youtube-cookies")
def save_youtube_cookies(
    body: CookiesBody,
    _admin=Depends(get_admin_user),
):
    cfg = get_settings()
    cookie_path = Path(cfg.data_dir) / "youtube_cookies.txt"
    cookie_path.write_text(body.cookies.strip())
    return {"detail": "Cookies saved"}


@router.delete("/youtube-cookies")
def delete_youtube_cookies(
    _admin=Depends(get_admin_user),
):
    cfg = get_settings()
    cookie_path = Path(cfg.data_dir) / "youtube_cookies.txt"
    if cookie_path.exists():
        cookie_path.unlink()
    return {"detail": "Cookies deleted"}


@router.get("/export")
def export_config(
    db: Session = Depends(get_db),
    _admin=Depends(get_admin_user),
):
    cfg = get_settings()
    db_settings = _get_db_settings(db)
    public_url = db_settings.get("public_url", cfg.public_url)
    port = cfg.port

    docker_compose = f"""version: "3.8"

services:
  xkc:
    image: ghcr.io/tuikat/xkc:latest
    restart: unless-stopped
    ports:
      - "{port}:{port}"
    volumes:
      - xkc_data:/data
    env_file: .env

volumes:
  xkc_data:
"""

    env_file = f"""# XKC DJ Library Server
XKC_PUBLIC_URL={public_url}
XKC_SECRET_KEY=CHANGE_THIS_TO_A_RANDOM_64_CHAR_HEX_STRING
XKC_ADMIN_USERNAME=admin
XKC_ADMIN_PASSWORD=CHANGE_THIS_TO_SECURE_PASSWORD
XKC_DATA_DIR=/data
XKC_PORT={port}
XKC_MAX_UPLOAD_MB=500
XKC_ANALYSIS_WORKERS=2
# Optional: Spotify API credentials for liked-tracks sync
# XKC_SPOTIFY_CLIENT_ID=
# XKC_SPOTIFY_CLIENT_SECRET=
"""

    domain = public_url.replace("https://", "").replace("http://", "").split("/")[0]
    caddy_file = f"""{domain} {{
    reverse_proxy localhost:{port}
}}
"""

    nginx_conf = f"""server {{
    listen 80;
    server_name {domain};
    return 301 https://$host$request_uri;
}}

server {{
    listen 443 ssl;
    server_name {domain};

    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;

    client_max_body_size 500M;

    location / {{
        proxy_pass http://localhost:{port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }}
}}
"""

    readme = f"""# XKC DJ Library Server — Setup Guide

## Quick Start (Docker)

1. Copy `docker-compose.yml` and `.env` to your server
2. Edit `.env` — set XKC_SECRET_KEY and XKC_ADMIN_PASSWORD
3. Run: `docker compose up -d`
4. Visit: http://localhost:{port}

## HTTPS with Caddy (recommended)

1. Install Caddy: https://caddyserver.com/docs/install
2. Copy the `Caddyfile` to `/etc/caddy/Caddyfile`
3. `systemctl reload caddy`

## HTTPS with Nginx

1. Install Nginx + Certbot
2. Copy `nginx.conf` to `/etc/nginx/sites-available/xkc`
3. `ln -s /etc/nginx/sites-available/xkc /etc/nginx/sites-enabled/`
4. `certbot --nginx -d {domain}`
5. `nginx -s reload`

## Desktop App

Download the latest release from:
https://github.com/tuikat/xkc/releases

Configure it with your server URL: {public_url}

## Data Backup

All data lives in the Docker volume `xkc_data`.
To backup: `docker run --rm -v xkc_data:/data -v $(pwd):/backup ubuntu tar czf /backup/xkc-backup.tar.gz /data`
"""

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("docker-compose.yml", docker_compose)
        zf.writestr(".env", env_file)
        zf.writestr("Caddyfile", caddy_file)
        zf.writestr("nginx.conf", nginx_conf)
        zf.writestr("README.md", readme)
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=xkc-server-config.zip"},
    )
