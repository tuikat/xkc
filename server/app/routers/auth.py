from fastapi import APIRouter, Depends, HTTPException, Response, Cookie, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime, timezone

from app.database import get_db
from app.schemas import LoginRequest, TokenResponse, RefreshRequest, UserOut
from app.auth import verify_password, create_session, refresh_session, hash_token, get_user_from_token
from app.dependencies import get_current_user
from app import models

router = APIRouter(prefix="/auth", tags=["auth"])

ACCESS_TOKEN_COOKIE = "access_token"
REFRESH_TOKEN_COOKIE = "refresh_token"
COOKIE_MAX_AGE = 60 * 60 * 24 * 7  # 7 days in seconds


def _set_tokens(response: Response, access_token: str, refresh_token: str) -> None:
    response.set_cookie(
        key=ACCESS_TOKEN_COOKIE,
        value=access_token,
        httponly=True,
        samesite="lax",
        max_age=COOKIE_MAX_AGE,
        path="/",
    )
    response.set_cookie(
        key=REFRESH_TOKEN_COOKIE,
        value=refresh_token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,  # 30 days
        path="/auth/refresh",
    )


@router.post("/login")
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(
        models.User.username == body.username,
        models.User.is_active == True,
    ).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    user.last_login = datetime.now(timezone.utc)
    db.commit()

    access_token, refresh_token = create_session(user, db, device_label=body.device_label)
    _set_tokens(response, access_token, refresh_token)
    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "bearer"}


@router.post("/refresh")
def refresh(
    body: RefreshRequest,
    response: Response,
    refresh_token_cookie: Optional[str] = Cookie(None, alias=REFRESH_TOKEN_COOKIE),
    db: Session = Depends(get_db),
):
    token = body.refresh_token or refresh_token_cookie
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token provided")

    result = refresh_session(token, db)
    if not result:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired refresh token")

    new_access, new_refresh = result
    _set_tokens(response, new_access, new_refresh)
    return {"access_token": new_access, "refresh_token": new_refresh, "token_type": "bearer"}


@router.post("/logout")
def logout(
    response: Response,
    refresh_token_cookie: Optional[str] = Cookie(None, alias=REFRESH_TOKEN_COOKIE),
    db: Session = Depends(get_db),
):
    if refresh_token_cookie:
        token_hash = hash_token(refresh_token_cookie)
        session = db.query(models.UserSession).filter(
            models.UserSession.refresh_token_hash == token_hash
        ).first()
        if session:
            db.delete(session)
            db.commit()

    response.delete_cookie(ACCESS_TOKEN_COOKIE, path="/")
    response.delete_cookie(REFRESH_TOKEN_COOKIE, path="/auth/refresh")
    return {"detail": "Logged out"}


@router.get("/me", response_model=UserOut)
def me(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.get("/desktop-login")
def desktop_login(token: str = "", db: Session = Depends(get_db)):
    """Validate desktop token, set auth cookie, redirect to web app (used by Tauri iframe handoff)."""
    user = get_user_from_token(token, db) if token else None
    resp = RedirectResponse(url="/", status_code=302)
    if user:
        resp.set_cookie(
            key=ACCESS_TOKEN_COOKIE,
            value=token,
            httponly=True,
            samesite="lax",
            max_age=COOKIE_MAX_AGE,
            path="/",
        )
    return resp
