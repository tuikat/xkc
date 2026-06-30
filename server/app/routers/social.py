"""Social features: share invites, user profiles, public playlist discovery."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.dependencies import get_current_user
from app import models

router = APIRouter(prefix="/social", tags=["social"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _playlist_dict(p: models.Playlist, include_tracks: bool = False) -> dict:
    d = {c.name: getattr(p, c.name) for c in p.__table__.columns}
    d["track_count"] = len(p.tracks)
    d["owner_username"] = p.owner.username if p.owner else None
    d["owner_avatar_color"] = p.owner.avatar_color if p.owner else None
    if include_tracks:
        d["tracks"] = []
        for pt in sorted(p.tracks, key=lambda x: x.position):
            t = pt.track
            td = {c.name: getattr(t, c.name) for c in t.__table__.columns}
            td["tag_ids"] = [tag.id for tag in t.tags]
            td["added_by_username"] = pt.added_by_user.username if pt.added_by_user else None
            d["tracks"].append(td)
    return d


def _invite_dict(inv: models.PlaylistShareInvite) -> dict:
    return {
        "id": inv.id,
        "playlist_id": inv.playlist_id,
        "playlist_name": inv.playlist.name if inv.playlist else None,
        "from_user_id": inv.from_user_id,
        "from_username": inv.from_user.username if inv.from_user else None,
        "from_avatar_color": inv.from_user.avatar_color if inv.from_user else None,
        "to_user_id": inv.to_user_id,
        "to_username": inv.to_user.username if inv.to_user else None,
        "status": inv.status,
        "message": inv.message,
        "created_at": inv.created_at.isoformat() if inv.created_at else None,
    }


# ---------------------------------------------------------------------------
# Users list (for invite picker)
# ---------------------------------------------------------------------------

@router.get("/users")
def list_users(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return all active users except self (for share picker)."""
    users = db.query(models.User).filter(
        models.User.is_active == True,
        models.User.id != current_user.id,
    ).order_by(models.User.username).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "avatar_color": u.avatar_color,
            "bio": u.bio,
        }
        for u in users
    ]


# ---------------------------------------------------------------------------
# User profile
# ---------------------------------------------------------------------------

@router.get("/users/{username}")
def get_profile(
    username: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Public playlists + playlists shared with current user
    public_playlists = [
        p for p in user.playlists
        if p.visibility == "public"
    ]
    # Playlists shared directly with me (accepted invites)
    shared_with_me = [
        inv.playlist for inv in
        db.query(models.PlaylistShareInvite).filter(
            models.PlaylistShareInvite.from_user_id == user.id,
            models.PlaylistShareInvite.to_user_id == current_user.id,
            models.PlaylistShareInvite.status == "accepted",
        ).all()
        if inv.playlist
    ]
    # Deduplicate
    seen = set()
    visible_playlists = []
    for p in public_playlists + shared_with_me:
        if p.id not in seen:
            seen.add(p.id)
            visible_playlists.append(_playlist_dict(p))

    return {
        "id": user.id,
        "username": user.username,
        "avatar_color": user.avatar_color,
        "bio": user.bio,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "playlists": visible_playlists,
    }


@router.patch("/users/me/profile")
def update_profile(
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Update own bio and avatar_color."""
    if "bio" in body:
        current_user.bio = body["bio"]
    if "avatar_color" in body:
        current_user.avatar_color = body["avatar_color"]
    db.commit()
    return {"bio": current_user.bio, "avatar_color": current_user.avatar_color}


# ---------------------------------------------------------------------------
# Playlist visibility (make public/private)
# ---------------------------------------------------------------------------

@router.patch("/playlists/{playlist_id}/visibility")
def set_visibility(
    playlist_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.owner_id != current_user.id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Access denied")
    vis = body.get("visibility", "private")
    if vis not in ("private", "public"):
        raise HTTPException(status_code=400, detail="visibility must be private or public")
    playlist.visibility = vis
    db.commit()
    return {"visibility": playlist.visibility}


# ---------------------------------------------------------------------------
# Share invites
# ---------------------------------------------------------------------------

class SendInviteBody(BaseModel):
    playlist_id: str
    to_user_id: str
    message: Optional[str] = None


@router.post("/invites", status_code=status.HTTP_201_CREATED)
def send_invite(
    body: SendInviteBody,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == body.playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if playlist.owner_id != current_user.id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Only the owner can share this playlist")
    to_user = db.query(models.User).filter(models.User.id == body.to_user_id).first()
    if not to_user:
        raise HTTPException(status_code=404, detail="User not found")
    if to_user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot share with yourself")

    # Upsert: reset to pending if previously denied
    existing = db.query(models.PlaylistShareInvite).filter(
        models.PlaylistShareInvite.playlist_id == body.playlist_id,
        models.PlaylistShareInvite.to_user_id == body.to_user_id,
    ).first()
    if existing:
        if existing.status == "accepted":
            return _invite_dict(existing)
        existing.status = "pending"
        existing.message = body.message
        from datetime import datetime, timezone
        existing.created_at = datetime.now(timezone.utc)
        db.commit()
        return _invite_dict(existing)

    invite = models.PlaylistShareInvite(
        playlist_id=body.playlist_id,
        from_user_id=current_user.id,
        to_user_id=body.to_user_id,
        message=body.message,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return _invite_dict(invite)


@router.get("/invites")
def list_invites(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Pending invites addressed TO me."""
    invites = db.query(models.PlaylistShareInvite).filter(
        models.PlaylistShareInvite.to_user_id == current_user.id,
        models.PlaylistShareInvite.status == "pending",
    ).order_by(models.PlaylistShareInvite.created_at.desc()).all()
    return [_invite_dict(i) for i in invites]


@router.get("/invites/sent")
def list_sent_invites(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """All invites I sent."""
    invites = db.query(models.PlaylistShareInvite).filter(
        models.PlaylistShareInvite.from_user_id == current_user.id,
    ).order_by(models.PlaylistShareInvite.created_at.desc()).all()
    return [_invite_dict(i) for i in invites]


@router.patch("/invites/{invite_id}")
def respond_to_invite(
    invite_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    invite = db.query(models.PlaylistShareInvite).filter(
        models.PlaylistShareInvite.id == invite_id,
    ).first()
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    if invite.to_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your invite")
    new_status = body.get("status")
    if new_status not in ("accepted", "denied"):
        raise HTTPException(status_code=400, detail="status must be accepted or denied")
    invite.status = new_status
    db.commit()
    return _invite_dict(invite)


# ---------------------------------------------------------------------------
# Public playlist search
# ---------------------------------------------------------------------------

@router.get("/search")
def search_public_playlists(
    q: str = "",
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Search public playlists from all users."""
    query = db.query(models.Playlist).filter(models.Playlist.visibility == "public")
    if q:
        query = query.filter(models.Playlist.name.ilike(f"%{q}%"))
    playlists = query.order_by(models.Playlist.name).limit(50).all()
    return [_playlist_dict(p) for p in playlists]
