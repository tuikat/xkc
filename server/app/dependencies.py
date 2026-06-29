from fastapi import Depends, HTTPException, Cookie, status
from sqlalchemy.orm import Session
from typing import Optional
from .database import get_db
from .auth import get_user_from_token
from . import models


def get_current_user(
    access_token: Optional[str] = Cookie(None),
    db: Session = Depends(get_db),
) -> models.User:
    if not access_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user = get_user_from_token(access_token, db)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    return user


def get_admin_user(current_user: models.User = Depends(get_current_user)) -> models.User:
    if not current_user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


def require_permission(permission: str):
    def check(current_user: models.User = Depends(get_current_user)) -> models.User:
        if current_user.is_admin:
            return current_user
        perms = current_user.permissions or {}
        if not perms.get(permission, False):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail=f"Permission '{permission}' required")
        return current_user
    return check
