"""Streaming sync service. Downloads tracks from Spotify/SoundCloud/YouTube."""
import logging
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.services.metadata import enrich_batch

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {'.mp3', '.flac', '.m4a', '.opus', '.ogg', '.wav', '.aiff'}

# Strip ANSI escape codes and carriage returns from terminal output
_ANSI = re.compile(r'(\x9B|\x1B\[)[0-9:;<=>?]*[ -/]*[@-~]|\x1B[PX^_].*?\x1B\\|\x1B[@-_]|\x07|\r')


def _should_enrich(db) -> bool:
    from app.models import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == 'enrich_on_import').first()
    return row is None or row.value != 'false'


def sync_source(source_id: str, db_url: str, data_dir: str, log_id: str):
    """Run in thread pool. Syncs a streaming source. log_id must be pre-created in DB."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.models import StreamSource, StreamSyncLog, Playlist

    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine)
    db = Session()

    try:
        source = db.query(StreamSource).filter(StreamSource.id == source_id).first()
        log = db.query(StreamSyncLog).filter(StreamSyncLog.id == log_id).first()
        if not source or not log:
            return

        mirror_playlist = None
        if source.mirror_playlist_id:
            mirror_playlist = db.query(Playlist).filter(
                Playlist.id == source.mirror_playlist_id
            ).first()

        tracks_dir = Path(data_dir) / "tracks"
        tracks_dir.mkdir(parents=True, exist_ok=True)

        if source.service == 'spotify':
            _sync_spotify(source, log, db, tracks_dir, data_dir, db_url, mirror_playlist)
        elif source.service in ('soundcloud', 'youtube'):
            _sync_ytdlp(source, log, db, tracks_dir, data_dir, db_url, mirror_playlist)
        else:
            raise ValueError(f"Unknown service: {source.service}")

        log.status = 'complete'
        log.completed_at = datetime.now(timezone.utc)
        source.last_synced_at = datetime.now(timezone.utc)
        db.commit()

    except Exception as e:
        logger.error(f"Sync failed for source {source_id}: {e}", exc_info=True)
        try:
            log = db.query(StreamSyncLog).filter(StreamSyncLog.id == log_id).first()
            if log and log.status == 'running':
                log.status = 'failed'
                log.error = str(e)
                log.completed_at = datetime.now(timezone.utc)
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _sync_spotify(source, log, db, tracks_dir: Path, data_dir: str, db_url: str, mirror_playlist):
    """Download Spotify playlist using spotdl, then scan and import new files."""
    from app.models import Track

    existing_paths = {
        row[0] for row in db.query(Track.file_path).filter(Track.file_path.isnot(None)).all()
    }

    # -1 = "searching" phase (no count yet); frontend shows "Searching..."
    log.tracks_found = -1
    log.tracks_downloaded = 0
    log.tracks_skipped = 0
    db.commit()

    quality = source.download_quality or 'best'
    fmt = 'flac' if quality == 'flac' else 'mp3'
    bitrate = '320k' if quality != 'low' else '128k'
    output_tmpl = str(tracks_dir / '{artists} - {title}.{output-ext}')

    env = os.environ.copy()
    env['NO_COLOR'] = '1'   # disable Rich colours → plain text output
    env['TERM'] = 'dumb'
    env['PYTHONUNBUFFERED'] = '1'

    cookie_file = Path(data_dir) / 'youtube_cookies.txt'
    cookie_args = ['--cookie-file', str(cookie_file)] if cookie_file.exists() else []
    if not cookie_args:
        logger.warning("No youtube_cookies.txt found — YouTube downloads will likely fail. Add cookies in Settings → Streaming.")

    logger.info(f"Starting spotdl download for {source.source_url}")
    proc = subprocess.Popen(
        [
            'spotdl', 'download', source.source_url,
            '--output', output_tmpl,
            '--format', fmt,
            '--bitrate', bitrate,
            '--threads', '5',
            *cookie_args,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,   # merge stderr so we see all output
        stdin=subprocess.DEVNULL,
        text=True,
        bufsize=1,
        env=env,
    )

    # Read output in a background thread (drains the pipe so it never deadlocks)
    dl_count = [0]
    sk_count = [0]
    last_flush = [time.time()]

    def _read_output():
        for raw in proc.stdout:
            line = _ANSI.sub('', raw).strip()
            if not line:
                continue

            low = line.lower()

            # "Found 3442 songs in Playlist" — set total track count
            if log.tracks_found == -1 and 'found' in low and 'song' in low:
                m = re.search(r'found\s+(\d[\d,]*)\s+song', low)
                if m:
                    log.tracks_found = int(m.group(1).replace(',', ''))

            # Downloaded / skipped lines — increment counters
            if 'downloaded' in low or '✔' in line or '✓' in line:
                dl_count[0] += 1
            elif 'skip' in low or 'already' in low:
                sk_count[0] += 1

            # Commit to DB at most every 4 seconds
            now = time.time()
            if now - last_flush[0] >= 4:
                log.tracks_downloaded = dl_count[0]
                log.tracks_skipped = sk_count[0]
                try:
                    db.commit()
                except Exception:
                    pass
                last_flush[0] = now

    reader = threading.Thread(target=_read_output, daemon=True)
    reader.start()

    try:
        returncode = proc.wait(timeout=7200)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        returncode = -1
        logger.warning("spotdl timed out after 2 hours — importing whatever was downloaded")
    finally:
        reader.join(timeout=15)

    if returncode not in (0, -1):
        raise RuntimeError(f"spotdl exited with code {returncode} — check that all CLI flags are valid")

    # Reset counts before import phase (avoid carrying over parse noise from any error output)
    log.tracks_downloaded = 0
    log.tracks_skipped = 0
    db.commit()

    # Scan filesystem for new files and import them into our library
    new_files = [
        f for f in tracks_dir.iterdir()
        if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS and str(f) not in existing_paths
    ]
    logger.info(f"spotdl finished. {len(new_files)} new files to import.")

    # Update tracks_found with the actual file count (in case parsing missed the "Found N" line)
    if log.tracks_found < 0 or log.tracks_found < len(new_files):
        log.tracks_found = len(new_files)

    imported = 0
    skipped_import = 0
    imported_ids: list[str] = []
    for track_file in new_files:
        result = _import_file(track_file, source, db, data_dir, db_url, mirror_playlist)
        if result == 'imported':
            imported += 1
            from app.models import Track as _Track
            t = db.query(_Track).filter_by(file_path=str(track_file)).first()
            if t:
                imported_ids.append(t.id)
        else:
            try:
                track_file.unlink()
            except Exception:
                pass
            skipped_import += 1
        log.tracks_downloaded = imported
        log.tracks_skipped = skipped_import
        db.commit()

    # Enrich metadata in background thread — doesn't block sync completion
    if imported_ids and _should_enrich(db):
        threading.Thread(target=enrich_batch, args=(imported_ids, db_url), daemon=True).start()


def _sync_ytdlp(source, log, db, tracks_dir: Path, data_dir: str, db_url: str, mirror_playlist):
    """Download SoundCloud/YouTube playlist via yt-dlp, then scan and import new files."""
    from app.models import Track

    existing_paths = {
        row[0] for row in db.query(Track.file_path).filter(Track.file_path.isnot(None)).all()
    }

    log.tracks_found = -1
    db.commit()

    output_tmpl = str(tracks_dir / '%(uploader)s - %(title)s.%(ext)s')
    logger.info(f"Starting yt-dlp download for {source.source_url}")
    try:
        subprocess.run(
            [
                'yt-dlp', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '-o', output_tmpl,
                '--embed-metadata', '--add-metadata',
                '--ignore-errors',
                source.source_url,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=7200,
        )
    except subprocess.TimeoutExpired:
        logger.warning("yt-dlp download timed out — importing whatever completed")
    except FileNotFoundError:
        raise RuntimeError("yt-dlp not found. Is it installed?")

    new_files = [
        f for f in tracks_dir.iterdir()
        if f.is_file() and f.suffix.lower() in AUDIO_EXTENSIONS and str(f) not in existing_paths
    ]

    log.tracks_found = len(new_files)
    db.commit()

    downloaded = 0
    skipped = 0
    for track_file in new_files:
        result = _import_file(track_file, source, db, data_dir, db_url, mirror_playlist)
        if result == 'imported':
            downloaded += 1
        else:
            skipped += 1
        log.tracks_downloaded = downloaded
        log.tracks_skipped = skipped
        db.commit()


def _import_file(
    track_file: Path,
    source,
    db,
    data_dir: str,
    db_url: str,
    mirror_playlist,
) -> str:
    """Import a single audio file into the library. Returns 'imported' or 'skipped'."""
    from app.models import Track
    from app.services.audio import analyze_track_background, executor

    try:
        tags = _extract_file_tags(str(track_file))

        # Dedup by ISRC
        if tags.get('isrc'):
            existing = db.query(Track).filter(Track.isrc == tags['isrc']).first()
            if existing:
                if mirror_playlist:
                    _add_to_playlist(existing.id, mirror_playlist.id, db)
                return 'skipped'

        # Dedup by title + artist
        if tags.get('title') and tags.get('artist'):
            existing = db.query(Track).filter(
                Track.title.ilike(tags['title']),
                Track.artist.ilike(tags['artist']),
            ).first()
            if existing:
                if mirror_playlist:
                    _add_to_playlist(existing.id, mirror_playlist.id, db)
                return 'skipped'

        track_id = str(uuid.uuid4())
        track = Track(
            id=track_id,
            file_path=str(track_file),
            title=tags.get('title') or track_file.stem,
            artist=tags.get('artist'),
            album=tags.get('album'),
            genre=tags.get('genre'),
            year=tags.get('year'),
            isrc=tags.get('isrc'),
            source_type=source.service,
            uploaded_by=source.user_id,
            analysis_state='pending',
        )
        db.add(track)
        db.flush()

        if mirror_playlist:
            _add_to_playlist(track_id, mirror_playlist.id, db)

        executor.submit(analyze_track_background, track_id, str(track_file), data_dir, db_url)
        return 'imported'

    except Exception as e:
        logger.warning(f"Failed to import {track_file}: {e}")
        return 'skipped'


def _extract_file_tags(filepath: str) -> dict:
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(filepath, easy=True)
        if not audio:
            return {}
        info: dict = {}
        for src, dst in [
            ('title', 'title'), ('artist', 'artist'), ('album', 'album'),
            ('genre', 'genre'), ('isrc', 'isrc'),
        ]:
            val = audio.get(src, [None])[0]
            if val:
                info[dst] = str(val)
        year_raw = audio.get('date', [None])[0]
        if year_raw:
            try:
                info['year'] = int(str(year_raw)[:4])
            except ValueError:
                pass
        return info
    except Exception:
        return {}


def _add_to_playlist(track_id: str, playlist_id: str, db):
    from app.models import PlaylistTrack
    from sqlalchemy import func
    # merge prevents duplicate entries (PlaylistTrack has composite PK on playlist+track)
    max_pos = db.query(func.max(PlaylistTrack.position)).filter(
        PlaylistTrack.playlist_id == playlist_id
    ).scalar() or 0
    entry = PlaylistTrack(playlist_id=playlist_id, track_id=track_id, position=max_pos + 1)
    db.merge(entry)
