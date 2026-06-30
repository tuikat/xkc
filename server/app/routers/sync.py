from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pathlib import Path
from typing import List, Optional
import uuid
import shutil
import logging

from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.config import get_settings
from app import models

router = APIRouter(prefix="/sync", tags=["sync"])
logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".mp3", ".flac", ".wav", ".aiff", ".aif", ".m4a", ".ogg", ".opus"}


@router.get("/manifest")
def get_manifest(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    tracks = db.query(
        models.Track.id,
        models.Track.file_hash,
        models.Track.analysis_state,
        models.Track.date_added,
        models.Track.title,
        models.Track.artist,
        models.Track.file_path,
        models.Track.file_size,
    ).all()
    return [
        {
            "track_id": t.id,
            "file_hash": t.file_hash,
            "analysis_state": t.analysis_state,
            "updated_at": t.date_added.isoformat() if t.date_added else None,
            "title": t.title,
            "artist": t.artist,
            "filename": Path(t.file_path).name if t.file_path else None,
            "file_size": t.file_size,
        }
        for t in tracks
    ]


@router.post("/batch-upload")
async def batch_upload(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("upload")),
):
    settings = get_settings()
    from app.routers.tracks import extract_tags, extract_artwork, _run_analysis
    from app.services.audio import executor

    results = []

    for file in files:
        ext = Path(file.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            results.append({"filename": file.filename, "status": "rejected", "reason": "unsupported format"})
            continue

        # Check duplicate by filename+size (quick check before full hash)
        tracks_dir = Path(settings.data_dir) / "tracks"
        tracks_dir.mkdir(parents=True, exist_ok=True)
        track_id = str(uuid.uuid4())
        dest = tracks_dir / f"{track_id}{ext}"

        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        # Hash for dedup
        import hashlib
        h = hashlib.md5()
        with dest.open("rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        file_hash = h.hexdigest()

        existing = db.query(models.Track).filter(models.Track.file_hash == file_hash).first()
        if existing:
            dest.unlink()
            results.append({"filename": file.filename, "status": "duplicate", "track_id": existing.id})
            continue

        tags = extract_tags(str(dest))
        artwork_path = extract_artwork(str(dest), track_id, settings.data_dir)

        track = models.Track(
            id=track_id,
            file_path=str(dest),
            file_hash=file_hash,
            file_size=dest.stat().st_size,
            file_format=ext.lstrip("."),
            analysis_state="pending",
            artwork_path=artwork_path,
            uploaded_by=current_user.id,
            source_type="desktop_sync",
            title=tags.get("title", Path(file.filename).stem),
            artist=tags.get("artist"),
            album=tags.get("album"),
            album_artist=tags.get("album_artist"),
            genre=tags.get("genre"),
            bpm=tags.get("bpm"),
            duration_ms=tags.get("duration_ms"),
            bitrate=tags.get("bitrate"),
        )
        db.add(track)
        db.commit()
        logger.info(f"Batch upload saved: {file.filename} -> track {track_id}, queued for analysis")

        background_tasks.add_task(executor.submit, _run_analysis, track_id, str(dest))
        results.append({"filename": file.filename, "status": "uploaded", "track_id": track_id})

    return {"results": results}


@router.get("/pioneer-export")
def pioneer_export_for_usb(
    playlist_ids: str = Query(..., description="Comma-separated playlist IDs"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("export")),
):
    settings = get_settings()
    ids = [p.strip() for p in playlist_ids.split(",") if p.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="No playlist IDs provided")

    from app.services.pdb_export import build_usb_export
    job_id = str(uuid.uuid4())
    zip_path = build_usb_export(ids, db, settings, job_id)

    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=f"xkc-usb-export-{job_id[:8]}.zip",
    )
