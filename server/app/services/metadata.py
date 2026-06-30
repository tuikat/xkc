"""
Metadata enrichment: fills empty fields from MusicBrainz (structured releases)
and SoundCloud via yt-dlp (DJ/underground music with genre tags).

Only overwrites fields that are NULL/empty. Skips if match confidence is low.
"""
import difflib
import io
import json
import logging
import subprocess
import time
from pathlib import Path

import requests
from PIL import Image
from sqlalchemy.orm import Session

from app import models

logger = logging.getLogger(__name__)

_MB_BASE = 'https://musicbrainz.org/ws/2'
_MB_HEADERS = {'User-Agent': 'XKC-DJ-Library/1.0 (xkc-dj-library)'}
_mb_last = [0.0]  # module-level rate-limit tracker (1 req/sec MB limit)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _mb_search(title: str, artist: str) -> dict | None:
    elapsed = time.time() - _mb_last[0]
    if elapsed < 1.1:
        time.sleep(1.1 - elapsed)
    _mb_last[0] = time.time()
    try:
        resp = requests.get(
            f'{_MB_BASE}/recording/',
            params={
                'query': f'recording:"{title}" AND artist:"{artist}"',
                'fmt': 'json',
                'limit': 5,
            },
            headers=_MB_HEADERS,
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        for rec in resp.json().get('recordings', []):
            if rec.get('score', 0) < 70:
                continue
            mb_title = rec.get('title', '')
            mb_artist = ', '.join(
                c.get('name', '') for c in rec.get('artist-credit', []) if isinstance(c, dict)
            )
            if _sim(title, mb_title) >= 0.75 and _sim(artist, mb_artist) >= 0.65:
                return rec
    except Exception as e:
        logger.debug(f'MusicBrainz error: {e}')
    return None


def _fetch_itunes_artwork(title: str, artist: str, track_id: str, data_dir: str) -> str | None:
    """Search iTunes for artwork, download, save to /data/artwork/{track_id}.jpg."""
    try:
        resp = requests.get(
            'https://itunes.apple.com/search',
            params={'term': f'{artist} {title}', 'entity': 'song', 'limit': 5, 'media': 'music'},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        results = resp.json().get('results', [])
        # Find best title match
        best = None
        best_score = 0.0
        for r in results:
            score = (_sim(title, r.get('trackName', '')) + _sim(artist, r.get('artistName', ''))) / 2
            if score > best_score:
                best_score = score
                best = r
        if not best or best_score < 0.65:
            return None
        art_url = best.get('artworkUrl100', '').replace('100x100', '600x600')
        if not art_url:
            return None
        img_resp = requests.get(art_url, timeout=10)
        if img_resp.status_code != 200:
            return None
        art_dir = Path(data_dir) / 'artwork'
        art_dir.mkdir(parents=True, exist_ok=True)
        art_path = art_dir / f'{track_id}.jpg'
        img = Image.open(io.BytesIO(img_resp.content)).convert('RGB')
        img.save(str(art_path), 'JPEG', quality=90)
        return str(art_path)
    except Exception as e:
        logger.debug(f'iTunes artwork error: {e}')
        return None


def _sc_search(title: str, artist: str) -> dict | None:
    query = f'{artist} - {title}'
    try:
        r = subprocess.run(
            ['yt-dlp', '--dump-json', '--no-playlist', '--no-download',
             f'scsearch1:{query}'],
            capture_output=True, text=True, timeout=25,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return None
        data = json.loads(r.stdout.strip())
        sc_title = data.get('title', '')
        sc_uploader = data.get('uploader', '')
        # SoundCloud titles are often "Artist - Title"
        if ' - ' in sc_title:
            sc_artist_part, sc_title_part = sc_title.split(' - ', 1)
        else:
            sc_artist_part, sc_title_part = sc_uploader, sc_title
        if _sim(title, sc_title_part) >= 0.72 and _sim(artist, sc_artist_part) >= 0.60:
            return data
    except Exception as e:
        logger.debug(f'SoundCloud search error: {e}')
    return None


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def enrich_track(track: models.Track, db: Session, data_dir: str = '/data') -> bool:
    """
    Attempt to fill empty metadata fields from MusicBrainz, SoundCloud, and iTunes (artwork).
    Returns True if any field was updated.
    Never touches: rating, color, play_count, cues, file_path, source_type.
    """
    if not track.title or not track.artist:
        return False

    updated = False

    # --- MusicBrainz: year, album, label, ISRC, genre ---
    rec = _mb_search(track.title, track.artist)
    if rec:
        releases = rec.get('releases', [])

        if not track.year and releases:
            date = releases[0].get('date', '')
            if date and len(date) >= 4:
                try:
                    yr = int(date[:4])
                    if 1900 <= yr <= 2030:
                        track.year = yr
                        updated = True
                except ValueError:
                    pass

        if not track.album and releases:
            alb = releases[0].get('title', '')
            # Don't use the album if it's nearly identical to the track title
            # (indicates a standalone single, not a real album)
            if alb and _sim(alb, track.title) < 0.85:
                track.album = alb
                updated = True

        if not track.label and releases:
            li = releases[0].get('label-info', [])
            if li:
                lbl = li[0].get('label', {}).get('name', '')
                if lbl:
                    track.label = lbl
                    updated = True

        if not track.isrc:
            isrcs = rec.get('isrcs', [])
            if isrcs:
                track.isrc = isrcs[0]
                updated = True

        if not track.genre:
            tags = sorted(rec.get('tags', []), key=lambda x: -x.get('count', 0))
            genres = [t['name'].title() for t in tags[:3] if t.get('count', 0) > 0]
            if genres:
                track.genre = ', '.join(genres)
                updated = True

    # --- SoundCloud: genre fallback for DJ/underground tracks ---
    if not track.genre:
        sc = _sc_search(track.title, track.artist)
        if sc:
            genre = sc.get('genre', '')
            if genre:
                track.genre = genre
                updated = True
            else:
                sc_tags = sc.get('tags', [])
                if isinstance(sc_tags, list) and sc_tags:
                    track.genre = ', '.join(sc_tags[:3])
                    updated = True

    # --- iTunes: artwork (always try if no artwork yet) ---
    if not track.artwork_path or not Path(track.artwork_path).exists():
        art_path = _fetch_itunes_artwork(track.title, track.artist, track.id, data_dir)
        if art_path:
            track.artwork_path = art_path
            updated = True

    if updated:
        try:
            db.commit()
            logger.info(f'Enriched: {track.artist} - {track.title}')
        except Exception as e:
            logger.warning(f'Enrich commit failed: {e}')
            db.rollback()
            return False

    return updated


def enrich_batch(track_ids: list[str], db_url: str, data_dir: str = '/data') -> None:
    """Enrich a list of tracks by ID — runs in a background thread with its own DB session."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(db_url)
    Session_ = sessionmaker(bind=engine)
    db = Session_()
    try:
        for tid in track_ids:
            track = db.query(models.Track).filter(models.Track.id == tid).first()
            if track:
                enrich_track(track, db, data_dir)
    finally:
        db.close()
