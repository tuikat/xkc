from datetime import datetime, timedelta, timezone
from typing import Optional
from jose import JWTError, jwt
import bcrypt
from sqlalchemy.orm import Session
from .config import get_settings
from . import models
import hashlib
import secrets


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_access_token(user_id: str) -> str:
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": user_id, "exp": expire, "type": "access"},
        settings.secret_key, algorithm="HS256"
    )


def create_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def decode_access_token(token: str) -> Optional[str]:
    try:
        settings = get_settings()
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        if payload.get("type") != "access":
            return None
        return payload.get("sub")
    except JWTError:
        return None


def get_user_from_token(token: str, db: Session) -> Optional[models.User]:
    user_id = decode_access_token(token)
    if not user_id:
        return None
    return db.query(models.User).filter(
        models.User.id == user_id,
        models.User.is_active == True
    ).first()


def create_session(user: models.User, db: Session, device_label: str = None) -> tuple[str, str]:
    settings = get_settings()
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token()

    expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    session = models.UserSession(
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_token),
        device_label=device_label,
        expires_at=expire,
    )
    db.add(session)
    db.commit()
    return access_token, refresh_token


def refresh_session(refresh_token: str, db: Session) -> Optional[tuple[str, str]]:
    token_hash = hash_token(refresh_token)
    session = db.query(models.UserSession).filter(
        models.UserSession.refresh_token_hash == token_hash,
        models.UserSession.expires_at > datetime.now(timezone.utc),
    ).first()
    if not session:
        return None
    user = db.query(models.User).filter(
        models.User.id == session.user_id,
        models.User.is_active == True
    ).first()
    if not user:
        return None
    new_access = create_access_token(user.id)
    new_refresh = create_refresh_token()
    session.refresh_token_hash = hash_token(new_refresh)
    db.commit()
    return new_access, new_refresh
