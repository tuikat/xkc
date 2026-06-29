from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.schemas import PlaylistCreate, PlaylistUpdate, PlaylistOut, AddTracksToPlaylist
from app.dependencies import get_current_user, require_permission
from app import models

router = APIRouter(prefix="/playlists", tags=["playlists"])


def _can_access(playlist: models.Playlist, user: models.User) -> bool:
    if user.is_admin:
        return True
    if playlist.owner_id == user.id:
        return True
    if playlist.is_shared:
        return True
    return False


def _can_edit(playlist: models.Playlist, user: models.User) -> bool:
    if user.is_admin:
        return True
    if playlist.owner_id == user.id:
        return True
    if playlist.is_shared and playlist.share_permission == "edit":
        return True
    return False


@router.get("/", response_model=List[dict])
def list_playlists(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    if current_user.is_admin:
        playlists = db.query(models.Playlist).all()
    else:
        playlists = db.query(models.Playlist).filter(
            (models.Playlist.owner_id == current_user.id) |
            (models.Playlist.is_shared == True)
        ).all()

    result = []
    for p in playlists:
        d = {c.name: getattr(p, c.name) for c in p.__table__.columns}
        d["track_count"] = len(p.tracks)
        result.append(d)
    return result


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_playlist(
    body: PlaylistCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_playlists")),
):
    playlist = models.Playlist(
        name=body.name,
        owner_id=current_user.id,
        parent_id=body.parent_id,
        is_smart=body.is_smart,
        smart_rules=body.smart_rules,
        cover_color=body.cover_color,
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    d = {c.name: getattr(playlist, c.name) for c in playlist.__table__.columns}
    d["track_count"] = 0
    return d


@router.get("/{playlist_id}")
def get_playlist(
    playlist_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not _can_access(playlist, current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    d = {c.name: getattr(playlist, c.name) for c in playlist.__table__.columns}
    d["tracks"] = []
    for pt in sorted(playlist.tracks, key=lambda x: x.position):
        t = pt.track
        td = {c.name: getattr(t, c.name) for c in t.__table__.columns}
        td["tag_ids"] = [tag.id for tag in t.tags]
        d["tracks"].append(td)
    d["track_count"] = len(d["tracks"])
    return d


@router.patch("/{playlist_id}")
def update_playlist(
    playlist_id: str,
    body: PlaylistUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not _can_edit(playlist, current_user):
        raise HTTPException(status_code=403, detail="Access denied")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(playlist, field, val)
    db.commit()
    db.refresh(playlist)
    d = {c.name: getattr(playlist, c.name) for c in playlist.__table__.columns}
    d["track_count"] = len(playlist.tracks)
    return d


@router.delete("/{playlist_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_playlist(
    playlist_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not _can_edit(playlist, current_user):
        raise HTTPException(status_code=403, detail="Access denied")
    db.delete(playlist)
    db.commit()


@router.post("/{playlist_id}/tracks", status_code=status.HTTP_201_CREATED)
def add_tracks_to_playlist(
    playlist_id: str,
    body: AddTracksToPlaylist,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_playlists")),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not _can_edit(playlist, current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    existing_ids = {pt.track_id for pt in playlist.tracks}
    max_pos = max((pt.position for pt in playlist.tracks), default=-1)

    for i, track_id in enumerate(body.track_ids):
        if track_id in existing_ids:
            continue
        track = db.query(models.Track).filter(models.Track.id == track_id).first()
        if not track:
            continue
        position = body.position if body.position is not None else max_pos + 1 + i
        pt = models.PlaylistTrack(
            playlist_id=playlist_id, track_id=track_id, position=position
        )
        db.add(pt)

    db.commit()
    return {"added": len(body.track_ids)}


@router.delete("/{playlist_id}/tracks/{track_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_track_from_playlist(
    playlist_id: str,
    track_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_playlists")),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not _can_edit(playlist, current_user):
        raise HTTPException(status_code=403, detail="Access denied")
    pt = db.query(models.PlaylistTrack).filter(
        models.PlaylistTrack.playlist_id == playlist_id,
        models.PlaylistTrack.track_id == track_id,
    ).first()
    if pt:
        db.delete(pt)
        db.commit()


@router.put("/{playlist_id}/tracks/reorder", status_code=status.HTTP_204_NO_CONTENT)
def reorder_playlist_tracks(
    playlist_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("manage_playlists")),
):
    playlist = db.query(models.Playlist).filter(models.Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if not _can_edit(playlist, current_user):
        raise HTTPException(status_code=403, detail="Access denied")

    track_ids: list = body.get("track_ids", [])
    pts = {pt.track_id: pt for pt in playlist.tracks}
    for i, tid in enumerate(track_ids):
        if tid in pts:
            pts[tid].position = i
    db.commit()
