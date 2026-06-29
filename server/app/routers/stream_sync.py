from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, status
from sqlalchemy.orm import Session
from typing import List
import threading

from app.database import get_db
from app.schemas import StreamSourceCreate, StreamSourceOut
from app.dependencies import get_current_user, require_permission
from app.config import get_settings
from app import models

router = APIRouter(prefix="/stream-sources", tags=["stream-sources"])

# Tracks which source_ids are currently syncing (prevents double-trigger)
_syncing: set[str] = set()
_syncing_lock = threading.Lock()


def _run_sync(source_id: str, log_id: str):
    from app.services.streaming import sync_source
    from app.database import get_db_url
    try:
        settings = get_settings()
        sync_source(source_id, get_db_url(), settings.data_dir, log_id)
    finally:
        with _syncing_lock:
            _syncing.discard(source_id)


@router.get("/", response_model=List[StreamSourceOut])
def list_sources(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    return db.query(models.StreamSource).filter(
        models.StreamSource.user_id == current_user.id
    ).order_by(models.StreamSource.created_at.desc()).all()


@router.get("/active-syncs")
def get_active_syncs(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return all currently running sync logs for this user's sources."""
    source_ids = [
        s.id for s in db.query(models.StreamSource.id).filter(
            models.StreamSource.user_id == current_user.id
        ).all()
    ]
    if not source_ids:
        return []
    logs = db.query(models.StreamSyncLog).filter(
        models.StreamSyncLog.source_id.in_(source_ids),
        models.StreamSyncLog.status == 'running',
    ).all()
    return [_log_dict(log, db) for log in logs]


@router.post("/", response_model=StreamSourceOut, status_code=status.HTTP_201_CREATED)
def create_source(
    body: StreamSourceCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("stream_sync")),
):
    source = models.StreamSource(
        user_id=current_user.id,
        service=body.service,
        display_name=body.display_name,
        source_type=body.source_type,
        source_url=body.source_url,
        sync_mode=body.sync_mode,
        auto_sync=body.auto_sync,
        sync_interval_hours=body.sync_interval_hours,
        download_quality=body.download_quality,
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


@router.get("/{source_id}")
def get_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    source = db.query(models.StreamSource).filter(
        models.StreamSource.id == source_id,
        models.StreamSource.user_id == current_user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Stream source not found")
    logs = db.query(models.StreamSyncLog).filter(
        models.StreamSyncLog.source_id == source_id
    ).order_by(models.StreamSyncLog.started_at.desc()).limit(10).all()
    return {
        "id": source.id,
        "service": source.service,
        "display_name": source.display_name,
        "source_type": source.source_type,
        "source_url": source.source_url,
        "sync_mode": source.sync_mode,
        "auto_sync": source.auto_sync,
        "sync_interval_hours": source.sync_interval_hours,
        "last_synced_at": source.last_synced_at,
        "mirror_playlist_id": source.mirror_playlist_id,
        "created_at": source.created_at,
        "recent_logs": [_log_dict(lg, db) for lg in logs],
    }


@router.patch("/{source_id}", response_model=StreamSourceOut)
def update_source(
    source_id: str,
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("stream_sync")),
):
    source = db.query(models.StreamSource).filter(
        models.StreamSource.id == source_id,
        models.StreamSource.user_id == current_user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Stream source not found")
    allowed = {"display_name", "sync_mode", "auto_sync", "sync_interval_hours", "download_quality", "mirror_playlist_id", "source_url"}
    for k, v in body.items():
        if k in allowed:
            setattr(source, k, v)
    db.commit()
    db.refresh(source)
    return source


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_source(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    source = db.query(models.StreamSource).filter(
        models.StreamSource.id == source_id,
        models.StreamSource.user_id == current_user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Stream source not found")
    db.delete(source)
    db.commit()


@router.get("/logs/{log_id}")
def get_log(
    log_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Get sync log status — DB-backed, survives page refresh."""
    log = db.query(models.StreamSyncLog).filter(
        models.StreamSyncLog.id == log_id
    ).first()
    if not log:
        raise HTTPException(status_code=404, detail="Log not found")
    return _log_dict(log, db)


@router.post("/{source_id}/sync")
def trigger_sync(
    source_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("stream_sync")),
):
    source = db.query(models.StreamSource).filter(
        models.StreamSource.id == source_id,
        models.StreamSource.user_id == current_user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Stream source not found")

    with _syncing_lock:
        if source_id in _syncing:
            raise HTTPException(status_code=409, detail="Sync already in progress")
        _syncing.add(source_id)

    # Create the log entry in DB immediately — this is the authoritative job record
    log = models.StreamSyncLog(source_id=source_id, status='running')
    db.add(log)
    db.commit()
    db.refresh(log)

    background_tasks.add_task(_run_sync, source_id, log.id)
    return {"log_id": log.id, "status": "running", "source_name": source.display_name}


@router.get("/{source_id}/log")
def get_sync_log(
    source_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    source = db.query(models.StreamSource).filter(
        models.StreamSource.id == source_id,
        models.StreamSource.user_id == current_user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Stream source not found")
    logs = db.query(models.StreamSyncLog).filter(
        models.StreamSyncLog.source_id == source_id
    ).order_by(models.StreamSyncLog.started_at.desc()).limit(20).all()
    return [_log_dict(lg, db) for lg in logs]


def _log_dict(log: models.StreamSyncLog, db) -> dict:
    source = db.query(models.StreamSource).filter(
        models.StreamSource.id == log.source_id
    ).first()
    return {
        "id": log.id,
        "source_id": log.source_id,
        "source_name": source.display_name if source else None,
        "status": log.status,
        "tracks_found": log.tracks_found,
        "tracks_downloaded": log.tracks_downloaded,
        "tracks_skipped": log.tracks_skipped,
        "error": log.error,
        "started_at": log.started_at.isoformat() if log.started_at else None,
        "completed_at": log.completed_at.isoformat() if log.completed_at else None,
    }
