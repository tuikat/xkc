"""
Metadata enrichment: fills empty fields from MusicBrainz (structured releases)
and SoundCloud via yt-dlp (DJ/underground music with genre tags).

Only overwrites fields that are NULL/empty. Skips if match confidence is low.
"""
import difflib
import io
import json
import logging
import re
import subprocess
import time
from pathlib import Path

import requests
from PIL import Image
from sqlalchemy.orm import Session

from app import models

logger = logging.getLogger(__name__)

_MB_BASE = 'https://musicbrainz.org/ws/2'

# Remix patterns: "(Artist Remix)", "(Artist Edit)", etc.
_REMIX_RE = re.compile(
    r'\(([^()]+?)\s+(?:Remix|Edit|Bootleg|VIP|Rework|Flip|Mashup|Re-?edit|Extended(?:\s+Mix)?|Dub(?:\s+Mix)?)\)',
    re.IGNORECASE,
)
_REMIX_BRACKET_RE = re.compile(
    r'\[([^\[\]]+?)\s+(?:Remix|Edit|Bootleg|VIP|Rework|Flip|Mashup)\]',
    re.IGNORECASE,
)
_MB_HEADERS = {'User-Agent': 'XKC-DJ-Library/1.0 (xkc-dj-library)'}
_mb_last = [0.0]  # module-level rate-limit tracker (1 req/sec MB limit)

# Known junk folksonomy tags that aren't genres
_NON_GENRE_TAGS = {
    'seen live', 'live', 'favorites', 'favourite', 'love', 'great', 'classic',
    'best', 'amazing', 'awesome', 'excellent', 'good', 'cool', 'nice', 'perfect',
    'british', 'american', 'english', 'german', 'swedish', 'french', 'canadian',
    'male vocalist', 'female vocalist', 'singer-songwriter', '00s', '90s', '80s',
    '70s', 'under 2000 listeners', 'heard on pandora', 'spotify',
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_remixer_from_title(title: str) -> str:
    """Return the remixer name found in title like 'Track (Artist Remix)', or ''."""
    m = _REMIX_RE.search(title) or _REMIX_BRACKET_RE.search(title)
    return m.group(1).strip() if m else ''


def _clean_title_for_search(title: str) -> str:
    """Strip remix parentheticals to get a clean search-friendly base title."""
    cleaned = _REMIX_RE.sub('', title)
    cleaned = _REMIX_BRACKET_RE.sub('', cleaned)
    return cleaned.strip(' -–()[]').strip()


def _sim(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _mb_rate_limit():
    elapsed = time.time() - _mb_last[0]
    if elapsed < 1.1:
        time.sleep(1.1 - elapsed)
    _mb_last[0] = time.time()


def _mb_search(title: str, artist: str) -> dict | None:
    """Search MusicBrainz for a recording and return the best match with full data."""
    _mb_rate_limit()
    try:
        resp = requests.get(
            f'{_MB_BASE}/recording/',
            params={
                'query': f'recording:"{title}" AND artist:"{artist}"',
                'fmt': 'json',
                'limit': 5,
                'inc': 'releases+genres+tags+isrcs+artist-credits+label-rels',
            },
            headers=_MB_HEADERS,
            timeout=12,
        )
        if resp.status_code != 200:
            logger.debug(f'MB search returned {resp.status_code}')
            return None
        for rec in resp.json().get('recordings', []):
            if rec.get('score', 0) < 60:
                continue
            mb_title = rec.get('title', '')
            mb_artist = ', '.join(
                c.get('name', '') for c in rec.get('artist-credit', []) if isinstance(c, dict)
            )
            if _sim(title, mb_title) >= 0.70 and _sim(artist, mb_artist) >= 0.55:
                return rec
        # Second attempt: looser query without quotes for edge cases
        _mb_rate_limit()
        resp2 = requests.get(
            f'{_MB_BASE}/recording/',
            params={
                'query': f'{title} {artist}',
                'fmt': 'json',
                'limit': 3,
                'inc': 'releases+genres+tags+isrcs+artist-credits',
            },
            headers=_MB_HEADERS,
            timeout=12,
        )
        if resp2.status_code == 200:
            for rec in resp2.json().get('recordings', []):
                if rec.get('score', 0) < 75:
                    continue
                mb_title = rec.get('title', '')
                mb_artist = ', '.join(
                    c.get('name', '') for c in rec.get('artist-credit', []) if isinstance(c, dict)
                )
                if _sim(title, mb_title) >= 0.70 and _sim(artist, mb_artist) >= 0.55:
                    return rec
    except Exception as e:
        logger.debug(f'MusicBrainz error: {e}')
    return None


def _mb_release_details(release_id: str) -> dict | None:
    """Fetch full release info including label-info."""
    _mb_rate_limit()
    try:
        resp = requests.get(
            f'{_MB_BASE}/release/{release_id}',
            params={'fmt': 'json', 'inc': 'labels+genres+tags'},
            headers=_MB_HEADERS,
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        logger.debug(f'MB release details error: {e}')
    return None


def _pick_best_release(releases: list[dict]) -> dict | None:
    """Pick original single/EP/album over compilations."""
    if not releases:
        return None
    # Prefer non-compilation releases with an actual date
    priority = []
    for r in releases:
        rtype = r.get('release-group', {}).get('primary-type', '')
        if rtype in ('Single', 'EP', 'Album'):
            priority.append(r)
    return (priority or releases)[0]


def _extract_genres_from_rec(rec: dict) -> list[str]:
    """Extract genres using the proper genres array, falling back to filtered tags."""
    # MusicBrainz genres (curated, much more reliable than tags)
    genres = rec.get('genres', [])
    if genres:
        # Sort by vote count, take top 3
        sorted_genres = sorted(genres, key=lambda g: -g.get('count', 0))
        return [g['name'].title() for g in sorted_genres[:3] if g.get('count', 0) > 0]

    # Fall back to folksonomy tags, but filter out non-genre noise
    tags = sorted(rec.get('tags', []), key=lambda x: -x.get('count', 0))
    result = []
    for t in tags[:10]:
        name = t['name'].lower()
        if t.get('count', 0) > 0 and name not in _NON_GENRE_TAGS and len(name) > 2:
            result.append(t['name'].title())
        if len(result) >= 3:
            break
    return result


def _fetch_itunes_artwork(title: str, artist: str, track_id: str, data_dir: str) -> str | None:
    """Search iTunes for artwork, download, save to /data/artwork/{track_id}.jpg."""
    try:
        # Try artist + title first, then just title
        for term in [f'{artist} {title}', title]:
            resp = requests.get(
                'https://itunes.apple.com/search',
                params={'term': term, 'entity': 'song', 'limit': 10, 'media': 'music'},
                timeout=10,
            )
            if resp.status_code != 200:
                continue
            results = resp.json().get('results', [])
            best = None
            best_score = 0.0
            for r in results:
                title_sim = _sim(title, r.get('trackName', ''))
                artist_sim = _sim(artist, r.get('artistName', ''))
                score = (title_sim * 0.6 + artist_sim * 0.4)
                if score > best_score:
                    best_score = score
                    best = r
            if best and best_score >= 0.55:
                # artworkUrl100 → 600x600
                art_url = (
                    best.get('artworkUrl100', '')
                    .replace('100x100bb', '600x600bb')
                    .replace('100x100', '600x600')
                )
                if not art_url:
                    continue
                img_resp = requests.get(art_url, timeout=10)
                if img_resp.status_code != 200:
                    continue
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
        if ' - ' in sc_title:
            sc_artist_part, sc_title_part = sc_title.split(' - ', 1)
        else:
            sc_artist_part, sc_title_part = sc_uploader, sc_title
        if _sim(title, sc_title_part) >= 0.65 and _sim(artist, sc_artist_part) >= 0.50:
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
    if not track.title:
        return False

    updated = False

    # --- Step 1: Parse artist from title if artist is missing ---
    # Pattern: "BWK Project - Gimme The Light" with no artist field
    if not track.artist and ' - ' in track.title:
        parts = track.title.split(' - ', 1)
        candidate_artist = parts[0].strip()
        candidate_title = parts[1].strip()
        if candidate_artist and candidate_title:
            track.artist = candidate_artist
            track.title = candidate_title
            updated = True
            logger.info(f'Parsed artist from title: "{track.artist}" / "{track.title}"')

    # --- Step 2: Extract remixer from title if remixer field is empty ---
    # Pattern: "GITP (SEYTHO. Remix)" → remixer = "SEYTHO."
    if not track.remixer and track.title:
        remixer = _extract_remixer_from_title(track.title)
        if remixer:
            track.remixer = remixer
            updated = True
            logger.info(f'Parsed remixer: "{remixer}" from "{track.title}"')

    if not track.artist:
        # Can't search without an artist
        if updated:
            try:
                db.commit()
            except Exception:
                db.rollback()
        return updated

    # Use clean title for searches (strip remix tags to improve match accuracy)
    search_title = _clean_title_for_search(track.title)
    search_artist = track.artist

    # --- MusicBrainz: year, album, label, ISRC, genre ---
    rec = _mb_search(search_title, search_artist)
    if rec:
        releases = rec.get('releases', [])
        best_release = _pick_best_release(releases)

        if not track.year and best_release:
            date = best_release.get('date', '')
            if not date:
                # Try other releases for a date
                for r in releases:
                    date = r.get('date', '')
                    if date:
                        break
            if date and len(date) >= 4:
                try:
                    yr = int(date[:4])
                    if 1900 <= yr <= 2035:
                        track.year = yr
                        updated = True
                except ValueError:
                    pass

        if not track.album and best_release:
            alb = best_release.get('title', '')
            if alb and _sim(alb, track.title) < 0.85:
                track.album = alb
                updated = True

        # For label: try to get from release details if not in basic search result
        if not track.label and best_release:
            # Basic search includes label-info if inc= has it
            li = best_release.get('label-info', [])
            if li and isinstance(li, list):
                lbl = li[0].get('label', {}).get('name', '') if li else ''
                if lbl and lbl.lower() not in ('', 'self-released', '[no label]'):
                    track.label = lbl
                    updated = True
            elif best_release.get('id') and not track.label:
                # Fetch full release details for label
                rel_details = _mb_release_details(best_release['id'])
                if rel_details:
                    li2 = rel_details.get('label-info', [])
                    if li2:
                        lbl2 = li2[0].get('label', {}).get('name', '')
                        if lbl2 and lbl2.lower() not in ('', 'self-released', '[no label]'):
                            track.label = lbl2
                            updated = True

        if not track.isrc:
            isrcs = rec.get('isrcs', [])
            if isrcs:
                track.isrc = isrcs[0]
                updated = True

        if not track.genre:
            genres = _extract_genres_from_rec(rec)
            if genres:
                track.genre = ', '.join(genres)
                updated = True

    # --- SoundCloud: genre fallback for DJ/underground tracks ---
    if not track.genre:
        sc = _sc_search(search_title, search_artist)
        if sc:
            genre = sc.get('genre', '')
            if genre and genre.strip():
                # Clean up semicolons that some SC tracks use
                track.genre = genre.replace(';', ',').strip()
                updated = True
            else:
                sc_tags = sc.get('tags', [])
                if isinstance(sc_tags, list) and sc_tags:
                    track.genre = ', '.join(sc_tags[:3])
                    updated = True

    # --- iTunes: artwork (always try if no artwork yet) ---
    if not track.artwork_path or not Path(track.artwork_path).exists():
        art_path = _fetch_itunes_artwork(search_title, search_artist, track.id, data_dir)
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
