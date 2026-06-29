from fastapi import (
    APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks,
    Query, WebSocket, WebSocketDisconnect, status
)
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
from pathlib import Path
from typing import Optional, List
from PIL import Image
from mutagen import File as MutagenFile
import uuid
import shutil
import io
import asyncio
import json
import os

from app.database import get_db
from app.schemas import TrackOut, TrackUpdate, CueCreate, CueOut
from app.dependencies import get_current_user, require_permission
from app.config import get_settings
from app import models

router = APIRouter(prefix="/tracks", tags=["tracks"])

ALLOWED_EXTENSIONS = {".mp3", ".flac", ".wav", ".aiff", ".aif", ".m4a", ".ogg", ".opus"}

# websocket connections: track_id -> list of websockets
_ws_connections: dict[str, list[WebSocket]] = {}


async def notify_ws(track_id: str, message: dict):
    conns = _ws_connections.get(track_id, [])
    dead = []
    for ws in conns:
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            dead.append(ws)
    for ws in dead:
        conns.remove(ws)


def extract_tags(filepath: str) -> dict:
    try:
        audio = MutagenFile(filepath, easy=True)
        if not audio:
            return {}
        info = {}
        mapping = {
            "title": "title", "artist": "artist", "album": "album",
            "albumartist": "album_artist", "genre": "genre", "label": "label",
            "remixer": "remixer", "composer": "composer", "comment": "comment", "isrc": "isrc",
        }
        for src, dst in mapping.items():
            val = audio.get(src, [None])[0]
            if val:
                info[dst] = str(val)
        year_str = audio.get("date", [None])[0]
        if year_str:
            try:
                info["year"] = int(str(year_str)[:4])
            except Exception:
                pass
        bpm_str = audio.get("bpm", [None])[0]
        if bpm_str:
            try:
                info["bpm"] = float(bpm_str)
            except Exception:
                pass
        if hasattr(audio, "info"):
            info["duration_ms"] = int(audio.info.length * 1000)
            info["bitrate"] = getattr(audio.info, "bitrate", None)
        return info
    except Exception:
        return {}


def extract_artwork(filepath: str, track_id: str, data_dir: str) -> Optional[str]:
    try:
        audio = MutagenFile(filepath)
        artwork_data = None
        if hasattr(audio, "tags") and audio.tags:
            for tag in audio.tags.values():
                if hasattr(tag, "data"):
                    artwork_data = tag.data
                    break
                elif hasattr(tag, "value") and isinstance(tag.value, bytes):
                    artwork_data = tag.value
                    break
        if not artwork_data:
            return None
        art_path = Path(data_dir) / "artwork" / f"{track_id}.jpg"
        art_path.parent.mkdir(parents=True, exist_ok=True)
        img = Image.open(io.BytesIO(artwork_data))
        img = img.convert("RGB")
        img.thumbnail((500, 500))
        img.save(art_path, "JPEG", quality=85)
        return str(art_path)
    except Exception:
        return None


def _run_analysis(track_id: str, file_path: str):
    """Run in thread pool. audio.py creates its own DB session."""
    from app.services.audio import analyze_track_background
    from app.database import get_db_url
    settings = get_settings()
    try:
        asyncio.run(notify_ws(track_id, {"state": "analyzing", "step": "starting"}))
        analyze_track_background(track_id, file_path, settings.data_dir, get_db_url())
        asyncio.run(notify_ws(track_id, {"state": "complete"}))
    except Exception as e:
        from app.database import SessionLocal
        db = SessionLocal()
        try:
            track = db.query(models.Track).filter(models.Track.id == track_id).first()
            if track:
                track.analysis_state = "failed"
                track.analysis_error = str(e)
                db.commit()
        finally:
            db.close()
        asyncio.run(notify_ws(track_id, {"state": "failed", "error": str(e)}))


@router.get("/", response_model=List[dict])
def search_tracks(
    q: Optional[str] = Query(None),
    playlist_id: Optional[str] = Query(None),
    tag_ids: Optional[str] = Query(None),
    genre: Optional[str] = Query(None),
    artist: Optional[str] = Query(None),
    min_bpm: Optional[float] = Query(None),
    max_bpm: Optional[float] = Query(None),
    key_camelot: Optional[str] = Query(None),
    analysis_state: Optional[str] = Query(None),
    sort_by: str = Query("date_added"),
    limit: int = Query(100, le=500),
    offset: int = Query(0),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    query = db.query(models.Track)

    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                models.Track.title.ilike(like),
                models.Track.artist.ilike(like),
                models.Track.album.ilike(like),
            )
        )
    if playlist_id:
        query = query.join(models.PlaylistTrack, models.PlaylistTrack.track_id == models.Track.id).filter(
            models.PlaylistTrack.playlist_id == playlist_id
        )
    if tag_ids:
        for tid in tag_ids.split(","):
            tid = tid.strip()
            if tid:
                query = query.filter(
                    models.Track.tags.any(models.Tag.id == tid)
                )
    if genre:
        query = query.filter(models.Track.genre.ilike(f"%{genre}%"))
    if artist:
        query = query.filter(models.Track.artist.ilike(f"%{artist}%"))
    if min_bpm is not None:
        query = query.filter(models.Track.bpm >= min_bpm)
    if max_bpm is not None:
        query = query.filter(models.Track.bpm <= max_bpm)
    if key_camelot:
        query = query.filter(models.Track.key_camelot == key_camelot)
    if analysis_state:
        query = query.filter(models.Track.analysis_state == analysis_state)

    sort_col = {
        "date_added": models.Track.date_added.desc(),
        "bpm": models.Track.bpm,
        "title": models.Track.title,
        "artist": models.Track.artist,
    }.get(sort_by, models.Track.date_added.desc())
    query = query.order_by(sort_col)

    tracks = query.offset(offset).limit(limit).all()
    result = []
    for t in tracks:
        d = {c.name: getattr(t, c.name) for c in t.__table__.columns}
        d["tag_ids"] = [tag.id for tag in t.tags]
        result.append(d)
    return result


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_track(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("upload")),
):
    settings = get_settings()
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(ALLOWED_EXTENSIONS)}",
        )

    track_id = str(uuid.uuid4())
    tracks_dir = Path(settings.data_dir) / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    dest = tracks_dir / f"{track_id}{ext}"

    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    tags = extract_tags(str(dest))
    artwork_path = extract_artwork(str(dest), track_id, settings.data_dir)

    file_size = dest.stat().st_size
    file_format = ext.lstrip(".")

    track = models.Track(
        id=track_id,
        file_path=str(dest),
        file_size=file_size,
        file_format=file_format,
        analysis_state="pending",
        artwork_path=artwork_path,
        uploaded_by=current_user.id,
        source_type="manual",
        title=tags.get("title", Path(file.filename).stem),
        artist=tags.get("artist"),
        album=tags.get("album"),
        album_artist=tags.get("album_artist"),
        genre=tags.get("genre"),
        label=tags.get("label"),
        remixer=tags.get("remixer"),
        composer=tags.get("composer"),
        comment=tags.get("comment"),
        isrc=tags.get("isrc"),
        year=tags.get("year"),
        bpm=tags.get("bpm"),
        duration_ms=tags.get("duration_ms"),
        bitrate=tags.get("bitrate"),
    )
    db.add(track)
    db.commit()
    db.refresh(track)

    import concurrent.futures
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    background_tasks.add_task(executor.submit, _run_analysis, track_id, str(dest))

    return {c.name: getattr(track, c.name) for c in track.__table__.columns}


@router.get("/{track_id}")
def get_track(
    track_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    d = {c.name: getattr(track, c.name) for c in track.__table__.columns}
    d["tags"] = [{"id": t.id, "name": t.name, "color": t.color, "group_id": t.group_id} for t in track.tags]
    d["cues"] = [
        {c2.name: getattr(cue, c2.name) for c2 in cue.__table__.columns}
        for cue in sorted(track.cues, key=lambda c2: c2.sort_order)
    ]
    d["has_beat_data"] = track.beats is not None
    return d


@router.patch("/{track_id}")
def update_track(
    track_id: str,
    body: TrackUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(track, field, val)
    db.commit()
    db.refresh(track)
    return {c.name: getattr(track, c.name) for c in track.__table__.columns}


@router.delete("/{track_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_track(
    track_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("delete")),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    file_path = Path(track.file_path)
    if file_path.exists():
        file_path.unlink()
    if track.artwork_path:
        art = Path(track.artwork_path)
        if art.exists():
            art.unlink()
    db.delete(track)
    db.commit()


@router.get("/{track_id}/artwork")
def get_artwork(
    track_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track or not track.artwork_path or not Path(track.artwork_path).exists():
        raise HTTPException(status_code=404, detail="Artwork not found")
    return FileResponse(track.artwork_path, media_type="image/jpeg")


_AUDIO_MIME = {
    ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
    ".aiff": "audio/aiff", ".aif": "audio/aiff", ".m4a": "audio/mp4",
    ".ogg": "audio/ogg", ".opus": "audio/opus", ".aac": "audio/aac",
}

@router.get("/{track_id}/stream")
def stream_track(
    track_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    path = Path(track.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    mime = _AUDIO_MIME.get(path.suffix.lower(), "audio/mpeg")
    return FileResponse(str(path), media_type=mime, headers={"Accept-Ranges": "bytes"})


@router.get("/{track_id}/waveform")
def get_waveform(
    track_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    beat = db.query(models.Beat).filter(models.Beat.track_id == track_id).first()
    if not beat:
        return {"overview": [], "detail": [], "beat_times_ms": []}
    from app.services.audio import decode_waveform
    return {
        "overview": decode_waveform(beat.waveform_overview) if beat.waveform_overview else [],
        "detail": decode_waveform(beat.waveform_detail) if beat.waveform_detail else [],
        "beat_times_ms": beat.beat_positions_ms or [],
    }


@router.post("/{track_id}/cues", response_model=CueOut, status_code=status.HTTP_201_CREATED)
def add_cue(
    track_id: str,
    body: CueCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    cue = models.Cue(track_id=track_id, **body.model_dump())
    db.add(cue)
    db.commit()
    db.refresh(cue)
    return cue


@router.put("/{track_id}/cues/{cue_id}", response_model=CueOut)
def update_cue(
    track_id: str,
    cue_id: str,
    body: CueCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    cue = db.query(models.Cue).filter(
        models.Cue.id == cue_id, models.Cue.track_id == track_id
    ).first()
    if not cue:
        raise HTTPException(status_code=404, detail="Cue not found")
    for field, val in body.model_dump().items():
        setattr(cue, field, val)
    db.commit()
    db.refresh(cue)
    return cue


@router.delete("/{track_id}/cues/{cue_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cue(
    track_id: str,
    cue_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    cue = db.query(models.Cue).filter(
        models.Cue.id == cue_id, models.Cue.track_id == track_id
    ).first()
    if not cue:
        raise HTTPException(status_code=404, detail="Cue not found")
    db.delete(cue)
    db.commit()


@router.post("/{track_id}/tags")
def set_track_tags(
    track_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    tag_ids = body.get("tag_ids", [])
    tags = db.query(models.Tag).filter(models.Tag.id.in_(tag_ids)).all()
    track.tags = tags
    db.commit()
    return {"tag_ids": [t.id for t in tags]}


@router.patch("/{track_id}/beats")
def update_beats(
    track_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    beat = db.query(models.Beat).filter(models.Beat.track_id == track_id).first()
    if not beat:
        raise HTTPException(status_code=404, detail="Beat data not found")
    offset_ms = body.get("offset_ms")
    positions = body.get("beat_positions_ms")
    if offset_ms is not None and beat.beat_positions_ms:
        beat.beat_positions_ms = [round(p + offset_ms, 3) for p in beat.beat_positions_ms]
    elif positions is not None:
        beat.beat_positions_ms = positions
    db.commit()
    return {"beat_positions_ms": beat.beat_positions_ms}


@router.post("/{track_id}/reanalyze")
def reanalyze_track(
    track_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("edit_metadata")),
):
    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    track.analysis_state = "pending"
    db.commit()
    import concurrent.futures
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    background_tasks.add_task(executor.submit, _run_analysis, track_id, track.file_path)
    return {"status": "reanalysis queued"}


@router.websocket("/ws/{track_id}/analysis")
async def ws_analysis(
    track_id: str,
    websocket: WebSocket,
    db: Session = Depends(get_db),
):
    await websocket.accept()
    _ws_connections.setdefault(track_id, []).append(websocket)

    track = db.query(models.Track).filter(models.Track.id == track_id).first()
    if track:
        await websocket.send_text(json.dumps({"state": track.analysis_state}))

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        conns = _ws_connections.get(track_id, [])
        if websocket in conns:
            conns.remove(websocket)
