from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, BackgroundTasks, status
from sqlalchemy.orm import Session
from pathlib import Path
from typing import List, Optional
from lxml import etree
import uuid
import shutil
import threading

from app.database import get_db
from app.schemas import RekordboxImportPreview, RekordboxImportConfirm
from app.dependencies import get_current_user, require_permission
from app.config import get_settings
from app import models

router = APIRouter(prefix="/import", tags=["import"])

ALLOWED_AUDIO = {".mp3", ".flac", ".wav", ".aiff", ".aif", ".m4a", ".ogg", ".opus"}

_import_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def parse_rekordbox_xml(filepath: str) -> dict:
    tree = etree.parse(filepath)
    root = tree.getroot()
    tracks = root.findall(".//TRACK")
    playlists = root.findall('.//NODE[@Type="1"]')
    return {
        "track_count": len(tracks),
        "playlist_count": len(playlists),
        "playlists": [p.get("Name", "") for p in playlists[:50]],
    }


def _run_rekordbox_import(job_id: str, xml_path: str, confirm: RekordboxImportConfirm, user_id: str):
    from app.database import SessionLocal
    from app.routers.tracks import extract_tags, extract_artwork
    db = SessionLocal()
    settings = get_settings()
    try:
        with _jobs_lock:
            _import_jobs[job_id]["status"] = "running"

        tree = etree.parse(xml_path)
        root = tree.getroot()
        all_tracks = root.findall(".//TRACK")
        all_playlists = root.findall('.//NODE[@Type="1"]')

        if not confirm.import_all and confirm.playlist_names:
            wanted_pl = set(confirm.playlist_names)
            filtered_pls = [p for p in all_playlists if p.get("Name", "") in wanted_pl]
            wanted_track_ids = set()
            for pl in filtered_pls:
                for entry in pl.findall(".//TRACK"):
                    wanted_track_ids.add(entry.get("Key", ""))
            all_tracks = [t for t in all_tracks if t.get("TrackID", "") in wanted_track_ids]

        imported = 0
        for xml_track in all_tracks:
            location = xml_track.get("Location", "")
            if location.startswith("file://localhost"):
                location = location[len("file://localhost"):]
            elif location.startswith("file://"):
                location = location[len("file://"):]

            existing = db.query(models.Track).filter(models.Track.file_path == location).first()
            if existing:
                continue

            file_path = Path(location)
            if not file_path.exists():
                continue

            track_id = str(uuid.uuid4())
            track = models.Track(
                id=track_id,
                file_path=str(file_path),
                file_size=file_path.stat().st_size if file_path.exists() else None,
                file_format=file_path.suffix.lstrip("."),
                analysis_state="complete",
                uploaded_by=user_id,
                source_type="rekordbox",
                title=xml_track.get("Name"),
                artist=xml_track.get("Artist"),
                album=xml_track.get("Album"),
                album_artist=xml_track.get("AlbumArtist"),
                genre=xml_track.get("Genre"),
                label=xml_track.get("Label"),
                remixer=xml_track.get("Remixer"),
                composer=xml_track.get("Composer"),
                year=_safe_int(xml_track.get("Year")),
                bpm=_safe_float(xml_track.get("AverageBpm")),
                duration_ms=_safe_int_ms(xml_track.get("TotalTime")),
                bitrate=_safe_int(xml_track.get("BitRate")),
                rating=_rb_rating(xml_track.get("Rating", "0")),
                comment=xml_track.get("Comments"),
            )
            db.add(track)

            # Import cues
            for pos_tag in xml_track.findall("POSITION_MARK"):
                cue_type = "hot" if pos_tag.get("Type") == "0" else "memory"
                start_ms = _safe_int(pos_tag.get("Start", "0"), 0)
                if start_ms is None:
                    start_ms = int(float(pos_tag.get("Start", "0")) * 1000)
                cue = models.Cue(
                    track_id=track_id,
                    position_ms=start_ms,
                    type=cue_type,
                    label=pos_tag.get("Name"),
                    sort_order=_safe_int(pos_tag.get("Num", "0"), 0),
                )
                db.add(cue)

            # Import beat grid
            tempo_tags = xml_track.findall("TEMPO")
            if tempo_tags:
                beat_positions = []
                for tempo in tempo_tags:
                    inizio = float(tempo.get("Inizio", "0"))
                    bpm_val = float(tempo.get("Bpm", "120"))
                    beat_positions.append(inizio * 1000)
                import zlib, json as _json
                beat_obj = models.Beat(
                    track_id=track_id,
                    beat_positions_ms=beat_positions,
                    downbeats_ms=[beat_positions[0]] if beat_positions else [],
                )
                db.add(beat_obj)

            imported += 1

        # Import playlists
        prefix = confirm.playlist_prefix
        pl_filter = set(confirm.playlist_names) if not confirm.import_all and confirm.playlist_names else None
        user = db.query(models.User).filter(models.User.id == user_id).first()

        if user:
            for xml_pl in all_playlists:
                pl_name = xml_pl.get("Name", "Untitled")
                if pl_filter and pl_name not in pl_filter:
                    continue
                full_name = f"{prefix} — {pl_name}" if prefix else pl_name
                playlist = models.Playlist(
                    name=full_name,
                    owner_id=user_id,
                )
                db.add(playlist)
                db.flush()

                for i, entry in enumerate(xml_pl.findall(".//TRACK")):
                    key = entry.get("Key", "")
                    matching = root.find(f'.//TRACK[@TrackID="{key}"]')
                    if matching is None:
                        continue
                    loc = matching.get("Location", "")
                    if loc.startswith("file://localhost"):
                        loc = loc[len("file://localhost"):]
                    elif loc.startswith("file://"):
                        loc = loc[len("file://"):]
                    track = db.query(models.Track).filter(models.Track.file_path == loc).first()
                    if track:
                        pt = models.PlaylistTrack(
                            playlist_id=playlist.id,
                            track_id=track.id,
                            position=i,
                        )
                        db.add(pt)

        db.commit()

        with _jobs_lock:
            _import_jobs[job_id]["status"] = "complete"
            _import_jobs[job_id]["tracks_imported"] = imported
    except Exception as e:
        db.rollback()
        with _jobs_lock:
            _import_jobs[job_id]["status"] = "failed"
            _import_jobs[job_id]["error"] = str(e)
    finally:
        db.close()


def _run_folder_import(job_id: str, paths: list, user_id: str):
    from app.database import SessionLocal
    from app.routers.tracks import extract_tags, extract_artwork
    from app.services.audio import analyze_track_background
    db = SessionLocal()
    settings = get_settings()
    try:
        with _jobs_lock:
            _import_jobs[job_id]["status"] = "running"

        imported = 0
        for p in paths:
            file_path = Path(p)
            if not file_path.exists() or file_path.suffix.lower() not in ALLOWED_AUDIO:
                continue
            existing = db.query(models.Track).filter(models.Track.file_path == str(file_path)).first()
            if existing:
                continue
            track_id = str(uuid.uuid4())
            tags = extract_tags(str(file_path))
            artwork_path = extract_artwork(str(file_path), track_id, settings.data_dir)
            track = models.Track(
                id=track_id,
                file_path=str(file_path),
                file_size=file_path.stat().st_size,
                file_format=file_path.suffix.lstrip("."),
                analysis_state="pending",
                artwork_path=artwork_path,
                uploaded_by=user_id,
                source_type="manual",
                title=tags.get("title", file_path.stem),
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
            analyze_track_background(track_id, str(file_path), db)
            imported += 1

        with _jobs_lock:
            _import_jobs[job_id]["status"] = "complete"
            _import_jobs[job_id]["tracks_imported"] = imported
    except Exception as e:
        with _jobs_lock:
            _import_jobs[job_id]["status"] = "failed"
            _import_jobs[job_id]["error"] = str(e)
    finally:
        db.close()


def _safe_int(val, default=None):
    try:
        return int(val) if val else default
    except Exception:
        return default


def _safe_float(val, default=None):
    try:
        return float(val) if val else default
    except Exception:
        return default


def _safe_int_ms(val, default=None):
    try:
        return int(float(val) * 1000) if val else default
    except Exception:
        return default


def _rb_rating(val: str) -> int:
    mapping = {"0": 0, "51": 1, "102": 2, "153": 3, "204": 4, "255": 5}
    return mapping.get(str(val), 0)


@router.post("/rekordbox")
async def upload_rekordbox_xml(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("rekordbox_import")),
):
    settings = get_settings()
    if not file.filename.endswith(".xml"):
        raise HTTPException(status_code=400, detail="File must be a .xml file")

    import_id = str(uuid.uuid4())
    tmp_path = Path(settings.data_dir) / "imports" / f"{import_id}.xml"
    tmp_path.parent.mkdir(parents=True, exist_ok=True)

    with tmp_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    preview = parse_rekordbox_xml(str(tmp_path))
    with _jobs_lock:
        _import_jobs[import_id] = {
            "status": "preview",
            "xml_path": str(tmp_path),
            "user_id": current_user.id,
            **preview,
        }

    return {"import_id": import_id, **preview}


@router.post("/rekordbox/{import_id}/confirm")
def confirm_rekordbox_import(
    import_id: str,
    body: RekordboxImportConfirm,
    background_tasks: BackgroundTasks,
    current_user: models.User = Depends(require_permission("rekordbox_import")),
):
    job = _import_jobs.get(import_id)
    if not job:
        raise HTTPException(status_code=404, detail="Import session not found")
    if job["status"] not in ("preview", "failed"):
        raise HTTPException(status_code=400, detail="Import already running or complete")

    background_tasks.add_task(
        _run_rekordbox_import, import_id, job["xml_path"], body, current_user.id
    )
    return {"import_id": import_id, "status": "queued"}


@router.get("/rekordbox/{import_id}/status")
def get_import_status(
    import_id: str,
    current_user: models.User = Depends(get_current_user),
):
    job = _import_jobs.get(import_id)
    if not job:
        raise HTTPException(status_code=404, detail="Import session not found")
    return {
        "import_id": import_id,
        "status": job.get("status"),
        "tracks_imported": job.get("tracks_imported"),
        "error": job.get("error"),
    }


@router.post("/folder")
def scan_folder(
    body: dict,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(require_permission("upload")),
):
    paths = body.get("paths", [])
    all_files = []
    for p in paths:
        fp = Path(p)
        if fp.is_dir():
            all_files.extend(
                str(f) for f in fp.rglob("*") if f.is_file() and f.suffix.lower() in ALLOWED_AUDIO
            )
        elif fp.is_file() and fp.suffix.lower() in ALLOWED_AUDIO:
            all_files.append(str(fp))

    existing = {t.file_path for t in db.query(models.Track.file_path).all()}
    new_files = [f for f in all_files if f not in existing]
    import_id = str(uuid.uuid4())
    with _jobs_lock:
        _import_jobs[import_id] = {
            "status": "preview",
            "paths": all_files,
            "new_count": len(new_files),
            "total_count": len(all_files),
            "duplicate_count": len(all_files) - len(new_files),
            "user_id": current_user.id,
        }
    return {
        "import_id": import_id,
        "total_count": len(all_files),
        "new_count": len(new_files),
        "duplicate_count": len(all_files) - len(new_files),
    }


@router.post("/folder/confirm")
def confirm_folder_import(
    body: dict,
    background_tasks: BackgroundTasks,
    current_user: models.User = Depends(require_permission("upload")),
):
    import_id = body.get("import_id")
    if not import_id:
        raise HTTPException(status_code=400, detail="import_id required")
    job = _import_jobs.get(import_id)
    if not job:
        raise HTTPException(status_code=404, detail="Import session not found")
    background_tasks.add_task(_run_folder_import, import_id, job["paths"], current_user.id)
    return {"import_id": import_id, "status": "queued"}
