"""File scanner and Rekordbox XML import service."""
import logging
import uuid
import shutil
from pathlib import Path
from typing import List, Dict, Optional, Callable

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {'.mp3', '.flac', '.wav', '.aiff', '.aif', '.m4a', '.ogg', '.opus', '.aac'}


def scan_directory(directory: str) -> List[str]:
    """Recursively find all audio files in a directory."""
    result = []
    for p in Path(directory).rglob('*'):
        if p.suffix.lower() in AUDIO_EXTENSIONS and p.is_file():
            result.append(str(p))
    return sorted(result)


def import_files(
    filepaths: List[str],
    user_id: str,
    db_url: str,
    data_dir: str,
    copy_files: bool = True,
    progress_callback: Optional[Callable] = None,
) -> Dict:
    """Import a list of audio files into the library."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.models import Track
    from app.services.audio import analyze_track_background, executor, compute_file_hash, _extract_basic_tags

    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine)
    db = Session()

    tracks_dir = Path(data_dir) / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)

    imported = 0
    skipped = 0
    errors = []

    try:
        for i, filepath in enumerate(filepaths):
            try:
                p = Path(filepath)
                if not p.exists():
                    errors.append(f"File not found: {filepath}")
                    continue

                file_hash = compute_file_hash(filepath)
                existing = db.query(Track).filter(Track.file_hash == file_hash).first()
                if existing:
                    skipped += 1
                    continue

                existing_path = db.query(Track).filter(Track.file_path == filepath).first()
                if existing_path:
                    skipped += 1
                    continue

                track_id = str(uuid.uuid4())
                if copy_files:
                    dest = tracks_dir / f"{track_id}{p.suffix.lower()}"
                    shutil.copy2(filepath, dest)
                    final_path = str(dest)
                else:
                    final_path = filepath

                tags = _extract_basic_tags(final_path)

                track = Track(
                    id=track_id,
                    file_path=final_path,
                    file_hash=file_hash,
                    file_size=p.stat().st_size,
                    file_format=p.suffix.lower().lstrip('.'),
                    uploaded_by=user_id,
                    source_type='manual',
                    analysis_state='pending',
                    **tags,
                )
                db.add(track)
                db.flush()

                executor.submit(analyze_track_background, track_id, final_path, data_dir, db_url)

                imported += 1
                if progress_callback:
                    progress_callback(i + 1, len(filepaths), track_id)

            except Exception as e:
                errors.append(f"{filepath}: {e}")
                logger.error(f"Failed to import {filepath}: {e}")

        db.commit()
    finally:
        db.close()

    return {'imported': imported, 'skipped': skipped, 'errors': errors}


def import_rekordbox_xml(
    xml_path: str,
    user_id: str,
    db_url: str,
    data_dir: str,
    playlist_prefix: str = "RB Import",
    playlist_names: Optional[List[str]] = None,
    import_all: bool = True,
) -> Dict:
    """Import tracks and playlists from a Rekordbox XML export."""
    from lxml import etree
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.models import Track, Playlist, PlaylistTrack, Cue

    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        tree = etree.parse(xml_path)
        root = tree.getroot()

        track_elements = root.findall('.//TRACK[@Location]')

        if import_all:
            pl_elements = root.findall('.//NODE[@Type="1"]')
        elif playlist_names:
            pl_elements = [
                p for p in root.findall('.//NODE[@Type="1"]')
                if p.get('Name') in playlist_names
            ]
        else:
            pl_elements = []

        imported_tracks = 0
        skipped_tracks = 0
        imported_playlists = 0
        rb_id_to_uuid: Dict[str, str] = {}

        for el in track_elements:
            location = el.get('Location', '')
            local_path = location.replace('file://localhost', '').replace('file://', '')
            rb_track_id = el.get('TrackID', '')

            existing = db.query(Track).filter(Track.file_path == local_path).first()
            if existing:
                rb_id_to_uuid[rb_track_id] = existing.id
                skipped_tracks += 1
                continue

            bpm_str = el.get('AverageBpm', '')
            try:
                bpm = float(bpm_str) if bpm_str else None
            except ValueError:
                bpm = None

            track_id = str(uuid.uuid4())
            rb_id_to_uuid[rb_track_id] = track_id

            track = Track(
                id=track_id,
                file_path=local_path,
                title=el.get('Name'),
                artist=el.get('Artist'),
                album=el.get('Album'),
                genre=el.get('Genre'),
                bpm=bpm,
                bpm_analysed=bpm is not None,
                key_musical=el.get('Tonality'),
                year=_safe_int(el.get('Year')),
                duration_ms=_safe_int(el.get('TotalTime'), multiplier=1000),
                rating=_safe_int(el.get('Rating')),
                comment=el.get('Comments'),
                source_type='rekordbox',
                uploaded_by=user_id,
                analysis_state='complete' if bpm else 'pending',
            )

            cues_to_add = []
            for cue_el in el.findall('POSITION_MARK'):
                pos_ms = int(float(cue_el.get('Start', 0)) * 1000)
                cue_type = 'hot' if cue_el.get('Type') == '0' else 'memory'
                cue = Cue(
                    track_id=track_id,
                    position_ms=pos_ms,
                    type=cue_type,
                    label=cue_el.get('Name', ''),
                    sort_order=_safe_int(cue_el.get('Num')) or 0,
                )
                cues_to_add.append(cue)

            db.add(track)
            for cue in cues_to_add:
                db.add(cue)

            imported_tracks += 1

        db.flush()

        for pl_el in pl_elements:
            pl_name = f"{playlist_prefix} — {pl_el.get('Name', 'Untitled')}"
            playlist = Playlist(
                id=str(uuid.uuid4()),
                name=pl_name,
                owner_id=user_id,
            )
            db.add(playlist)
            db.flush()

            for i, track_el in enumerate(pl_el.findall('TRACK')):
                rb_key = track_el.get('Key', '')
                track_uuid = rb_id_to_uuid.get(rb_key)
                if track_uuid:
                    entry = PlaylistTrack(
                        playlist_id=playlist.id,
                        track_id=track_uuid,
                        position=i,
                    )
                    db.add(entry)

            imported_playlists += 1

        db.commit()
        return {
            'tracks_imported': imported_tracks,
            'tracks_skipped': skipped_tracks,
            'playlists_imported': imported_playlists,
        }

    except Exception as e:
        db.rollback()
        logger.error(f"Rekordbox XML import failed: {e}", exc_info=True)
        raise
    finally:
        db.close()


def _safe_int(val, multiplier: int = 1) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(float(val)) * multiplier
    except (ValueError, TypeError):
        return None
