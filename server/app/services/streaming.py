"""Streaming sync service. Downloads tracks from Spotify and SoundCloud."""
import logging
import subprocess
import json
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def sync_source(source_id: str, db_url: str, data_dir: str):
    """Run in thread pool. Syncs a streaming source."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.models import StreamSource, StreamSyncLog, Track, Playlist, PlaylistTrack
    import uuid

    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine)
    db = Session()

    log = None
    try:
        source = db.query(StreamSource).filter(StreamSource.id == source_id).first()
        if not source:
            return

        log = StreamSyncLog(source_id=source_id)
        db.add(log)
        db.commit()

        if source.service == 'spotify':
            track_list = _fetch_spotify_tracklist(source.source_url)
        elif source.service == 'soundcloud':
            track_list = _fetch_soundcloud_tracklist(source.source_url)
        elif source.service == 'youtube':
            track_list = _fetch_youtube_tracklist(source.source_url)
        else:
            raise ValueError(f"Unknown service: {source.service}")

        log.tracks_found = len(track_list)
        db.commit()

        tracks_dir = Path(data_dir) / "tracks"
        tracks_dir.mkdir(parents=True, exist_ok=True)

        downloaded = 0
        skipped = 0

        mirror_playlist = None
        if source.sync_mode == 'mirror_playlist' and source.mirror_playlist_id:
            mirror_playlist = db.query(Playlist).filter(
                Playlist.id == source.mirror_playlist_id).first()

        for item in track_list:
            existing = None
            if item.get('isrc'):
                existing = db.query(Track).filter(Track.isrc == item['isrc']).first()
            if not existing and item.get('title') and item.get('artist'):
                existing = db.query(Track).filter(
                    Track.title.ilike(item['title']),
                    Track.artist.ilike(item['artist'])
                ).first()

            if existing:
                skipped += 1
                if mirror_playlist:
                    _add_to_playlist(existing.id, mirror_playlist.id, db)
                continue

            track_uuid = str(uuid.uuid4())
            out_path = tracks_dir / f"{track_uuid}"
            dl_path = _download_track(source.service, item, str(out_path), source.download_quality)

            if dl_path and Path(dl_path).exists():
                track = Track(
                    id=track_uuid,
                    file_path=dl_path,
                    title=item.get('title'),
                    artist=item.get('artist'),
                    album=item.get('album'),
                    isrc=item.get('isrc'),
                    source_type=source.service,
                    source_id=item.get('id'),
                    uploaded_by=source.user_id,
                    analysis_state='pending',
                )
                db.add(track)
                db.flush()

                if mirror_playlist:
                    _add_to_playlist(track.id, mirror_playlist.id, db)

                from app.services.audio import analyze_track_background, executor
                executor.submit(analyze_track_background, track.id, dl_path, data_dir, db_url)

                downloaded += 1
            else:
                skipped += 1

        db.commit()
        log.tracks_downloaded = downloaded
        log.tracks_skipped = skipped
        log.status = 'complete'
        log.completed_at = datetime.now(timezone.utc)
        source.last_synced_at = datetime.now(timezone.utc)
        db.commit()

    except Exception as e:
        logger.error(f"Sync failed for source {source_id}: {e}", exc_info=True)
        if log:
            log.status = 'failed'
            log.error = str(e)
            log.completed_at = datetime.now(timezone.utc)
            try:
                db.commit()
            except Exception:
                pass
    finally:
        db.close()


def _add_to_playlist(track_id: str, playlist_id: str, db):
    from app.models import PlaylistTrack
    from sqlalchemy import func
    max_pos = db.query(func.max(PlaylistTrack.position)).filter(
        PlaylistTrack.playlist_id == playlist_id).scalar() or 0
    entry = PlaylistTrack(playlist_id=playlist_id, track_id=track_id, position=max_pos + 1)
    db.merge(entry)


def _fetch_spotify_tracklist(url: str) -> list:
    """Use spotdl to list tracks without downloading."""
    tmp_file = '/tmp/spotdl_list.spotdl'
    # Delete stale file so a timeout can't cause us to read old data
    Path(tmp_file).unlink(missing_ok=True)
    try:
        result = subprocess.run(
            ['spotdl', 'save', url, '--save-file', tmp_file],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3600,  # 1 hour — large playlists (3000+ songs) take 15-30 min
        )
        if result.returncode != 0:
            logger.error(f"spotdl save exited {result.returncode}")
        if Path(tmp_file).exists():
            with open(tmp_file) as f:
                data = json.load(f)
            if not isinstance(data, list):
                logger.error(f"Unexpected spotdl format: {type(data)}")
                return []
            return [
                {
                    'title': t.get('name', ''),
                    'artist': ', '.join(t.get('artists', [])) if isinstance(t.get('artists'), list) else t.get('artist', ''),
                    'album': t.get('album_name', ''),
                    'isrc': t.get('isrc') or None,
                    'id': t.get('song_id'),
                    'url': t.get('url'),
                }
                for t in data
            ]
    except Exception as e:
        logger.error(f"Spotify fetch failed: {e}", exc_info=True)
    return []


def _fetch_soundcloud_tracklist(url: str) -> list:
    """Use yt-dlp to list SoundCloud tracks."""
    try:
        result = subprocess.run(
            ['yt-dlp', '--flat-playlist', '-J', url],
            stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdout=subprocess.PIPE, timeout=60
        )
        data = json.loads(result.stdout)
        entries = data.get('entries', [data]) if 'entries' in data else [data]
        return [
            {
                'title': e.get('title', ''),
                'artist': e.get('uploader', ''),
                'id': e.get('id'),
                'url': e.get('url') or e.get('webpage_url'),
            }
            for e in entries
        ]
    except Exception as e:
        logger.error(f"SoundCloud fetch failed: {e}")
    return []


def _fetch_youtube_tracklist(url: str) -> list:
    """Use yt-dlp to list YouTube playlist tracks."""
    try:
        result = subprocess.run(
            ['yt-dlp', '--flat-playlist', '-J', url],
            stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdout=subprocess.PIPE, timeout=60
        )
        data = json.loads(result.stdout)
        entries = data.get('entries', [data])
        return [
            {
                'title': e.get('title', ''),
                'artist': e.get('uploader', ''),
                'id': e.get('id'),
                'url': e.get('webpage_url') or e.get('url'),
            }
            for e in entries
        ]
    except Exception as e:
        logger.error(f"YouTube fetch failed: {e}")
    return []


def _download_track(service: str, item: dict, out_base: str, quality: str) -> Optional[str]:
    """Download a single track. Returns final file path or None."""
    url = item.get('url')
    if not url:
        return None
    if service == 'spotify':
        return _download_spotdl(url, out_base, quality)
    else:
        return _download_ytdlp(url, out_base, quality)


def _download_spotdl(url: str, out_base: str, quality: str) -> Optional[str]:
    out_dir = str(Path(out_base).parent)
    out_name = Path(out_base).name
    try:
        subprocess.run(
            [
                'spotdl', 'download', url,
                '--output', f'{out_dir}/{out_name}.{{output-ext}}',
                '--format', 'mp3' if quality != 'flac' else 'flac',
                '--bitrate', '320k' if quality == 'best' else '128k',
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=300
        )
        for ext in ['mp3', 'flac', 'opus', 'm4a']:
            p = Path(f"{out_base}.{ext}")
            if p.exists():
                return str(p)
    except Exception as e:
        logger.error(f"spotdl download failed: {e}")
    return None


def _download_ytdlp(url: str, out_base: str, quality: str) -> Optional[str]:
    try:
        subprocess.run(
            [
                'yt-dlp', '-x', '--audio-format', 'mp3',
                '--audio-quality', '0',
                '-o', f'{out_base}.%(ext)s',
                '--embed-metadata', '--add-metadata',
                url,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=300
        )
        for ext in ['mp3', 'flac', 'opus', 'm4a', 'webm']:
            p = Path(f"{out_base}.{ext}")
            if p.exists():
                return str(p)
    except Exception as e:
        logger.error(f"yt-dlp download failed: {e}")
    return None
