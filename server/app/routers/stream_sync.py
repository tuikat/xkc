from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, status
from sqlalchemy.orm import Session
from typing import List
import uuid
import threading

from app.database import get_db
from app.schemas import StreamSourceCreate, StreamSourceOut
from app.dependencies import get_current_user, require_permission
from app.config import get_settings
from app import models

router = APIRouter(prefix="/stream-sources", tags=["stream-sources"])

_sync_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _run_sync(job_id: str, source_id: str):
    from app.services.streaming import sync_source
    from app.database import get_db_url
    try:
        with _jobs_lock:
            _sync_jobs[job_id] = {"status": "running", "source_id": source_id}
        settings = get_settings()
        sync_source(source_id, get_db_url(), settings.data_dir)
        with _jobs_lock:
            _sync_jobs[job_id]["status"] = "complete"
    except Exception as e:
        with _jobs_lock:
            _sync_jobs[job_id]["status"] = "failed"
            _sync_jobs[job_id]["error"] = str(e)


@router.get("/", response_model=List[StreamSourceOut])
def list_sources(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    return db.query(models.StreamSource).filter(
        models.StreamSource.user_id == current_user.id
    ).order_by(models.StreamSource.created_at.desc()).all()


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
        "recent_logs": [
            {
                "id": lg.id,
                "started_at": lg.started_at,
                "completed_at": lg.completed_at,
                "tracks_found": lg.tracks_found,
                "tracks_downloaded": lg.tracks_downloaded,
                "tracks_skipped": lg.tracks_skipped,
                "status": lg.status,
                "error": lg.error,
            }
            for lg in logs
        ],
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
    allowed = {"display_name", "sync_mode", "auto_sync", "sync_interval_hours", "download_quality"}
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


@router.get("/jobs/{job_id}")
def get_job_status(
    job_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    with _jobs_lock:
        job = _sync_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Attach latest log detail when complete
    if job["status"] == "complete":
        source_id = job.get("source_id")
        if source_id:
            log = db.query(models.StreamSyncLog).filter(
                models.StreamSyncLog.source_id == source_id
            ).order_by(models.StreamSyncLog.started_at.desc()).first()
            if log:
                return {**job, "tracks_downloaded": log.tracks_downloaded, "tracks_skipped": log.tracks_skipped, "tracks_found": log.tracks_found}
    return job


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
    job_id = str(uuid.uuid4())
    background_tasks.add_task(_run_sync, job_id, source_id)
    return {"job_id": job_id, "status": "queued"}


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
    ).order_by(models.StreamSyncLog.started_at.desc()).limit(50).all()
    return [
        {
            "id": lg.id,
            "started_at": lg.started_at,
            "completed_at": lg.completed_at,
            "tracks_found": lg.tracks_found,
            "tracks_downloaded": lg.tracks_downloaded,
            "tracks_skipped": lg.tracks_skipped,
            "status": lg.status,
            "error": lg.error,
        }
        for lg in logs
    ]
