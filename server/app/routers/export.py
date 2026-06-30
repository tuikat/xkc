from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pathlib import Path
from typing import Optional
import uuid
import zipfile
import shutil
import threading
import logging

from app.database import get_db
from app.schemas import ExportRequest
from app.dependencies import require_permission
from app.config import get_settings
from app import models

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/export", tags=["export"])

# In-memory job store
_export_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _flat_export(job_id: str, playlist_ids: list, db: Session, settings):
    try:
        with _jobs_lock:
            _export_jobs[job_id]["status"] = "running"

        export_dir = Path(settings.data_dir) / "exports" / job_id
        export_dir.mkdir(parents=True, exist_ok=True)

        playlists = db.query(models.Playlist).filter(models.Playlist.id.in_(playlist_ids)).all()
        total = sum(len(p.tracks) for p in playlists)
        done = 0

        for playlist in playlists:
            safe_name = "".join(c if c.isalnum() or c in " -_" else "_" for c in playlist.name)
            pl_dir = export_dir / safe_name
            pl_dir.mkdir(exist_ok=True)
            for pt in sorted(playlist.tracks, key=lambda x: x.position):
                track = pt.track
                src = Path(track.file_path)
                if src.exists():
                    artist = track.artist or "Unknown Artist"
                    title = track.title or src.stem
                    safe = "".join(c if c.isalnum() or c in " -_." else "_" for c in f"{artist} - {title}{src.suffix}")
                    shutil.copy2(src, pl_dir / safe)
                done += 1
                with _jobs_lock:
                    _export_jobs[job_id]["progress"] = int(done / total * 100) if total else 100

        zip_path = Path(settings.data_dir) / "exports" / f"{job_id}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in export_dir.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(export_dir.parent))

        shutil.rmtree(export_dir)

        with _jobs_lock:
            _export_jobs[job_id]["status"] = "complete"
            _export_jobs[job_id]["zip_path"] = str(zip_path)
            _export_jobs[job_id]["progress"] = 100
    except Exception as e:
        with _jobs_lock:
            _export_jobs[job_id]["status"] = "failed"
            _export_jobs[job_id]["error"] = str(e)


def _pioneer_export(job_id: str, playlist_ids: list, db: Session, settings):
    try:
        with _jobs_lock:
            _export_jobs[job_id]["status"] = "running"

        from app.services.pdb_export import build_usb_export
        from app.database import SessionLocal
        # Use a fresh DB session (background task — original may be closed)
        with SessionLocal() as bg_db:
            zip_path = build_usb_export(playlist_ids, bg_db, settings, job_id)

        with _jobs_lock:
            _export_jobs[job_id]["status"] = "complete"
            _export_jobs[job_id]["zip_path"] = str(zip_path)
            _export_jobs[job_id]["progress"] = 100
    except Exception as e:
        logger.exception(f"Pioneer export {job_id} failed: {e}")
        with _jobs_lock:
            _export_jobs[job_id]["status"] = "failed"
            _export_jobs[job_id]["error"] = str(e)


@router.post("/")
def create_export(
    body: ExportRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("export")),
):
    settings = get_settings()
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _export_jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "zip_path": None,
            "error": None,
            "format": body.format,
        }

    if body.format == "pioneer":
        background_tasks.add_task(_pioneer_export, job_id, body.playlist_ids, db, settings)
    else:
        background_tasks.add_task(_flat_export, job_id, body.playlist_ids, db, settings)

    return {"job_id": job_id}


@router.get("/{job_id}")
def get_export_status(
    job_id: str,
    current_user=Depends(require_permission("export")),
):
    job = _export_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "error": job.get("error"),
        "download_url": f"/api/export/{job_id}/download" if job["status"] == "complete" else None,
    }


@router.get("/{job_id}/download")
def download_export(
    job_id: str,
    current_user=Depends(require_permission("export")),
):
    job = _export_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Export job not found")
    if job["status"] != "complete":
        raise HTTPException(status_code=400, detail=f"Export not ready (status: {job['status']})")
    zip_path = Path(job["zip_path"])
    if not zip_path.exists():
        raise HTTPException(status_code=404, detail="Export file not found")
    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=f"xkc-export-{job_id[:8]}.zip",
    )
