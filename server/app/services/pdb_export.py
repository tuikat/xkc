"""Pioneer USB export — generates rekordbox.xml + ANLZ files for CDJ/XDJ/rekordbox."""
import shutil
import zipfile
import logging
from pathlib import Path
from typing import List

from lxml import etree
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Pioneer cue colours indexed by sort_order (0-7 = hot cues)
_HOT_CUE_COLORS = [
    (204, 0, 0),      # Red
    (204, 102, 0),    # Orange
    (204, 204, 0),    # Yellow
    (0, 204, 0),      # Green
    (0, 204, 204),    # Cyan
    (0, 0, 204),      # Blue
    (102, 0, 204),    # Purple
    (204, 0, 102),    # Pink
]

_KIND_MAP = {
    '.mp3': 'MP3 File', '.flac': 'FLAC File', '.wav': 'WAV File',
    '.aiff': 'AIFF File', '.aif': 'AIFF File', '.m4a': 'AAC File',
    '.aac': 'AAC File', '.ogg': 'OGG File', '.opus': 'OGG File',
}


def _pioneer_rating(rating: int) -> int:
    """Convert 0-5 star rating to Pioneer 0-255 scale."""
    if not rating:
        return 0
    return min(255, int((rating / 5) * 255))


def _cue_type_num(cue_type: str) -> str:
    """Return Pioneer numeric Type value for POSITION_MARK."""
    mapping = {'hot': '0', 'memory': '0', 'fadein': '1',
               'fadeout': '2', 'load': '3', 'loop': '4'}
    return mapping.get(cue_type, '0')


def _build_rekordbox_xml(tracks_data: list, playlists_data: list) -> bytes:
    """Generate a complete rekordbox.xml for Pioneer CDJ/XDJ/rekordbox import."""
    root = etree.Element('DJ_PLAYLISTS', Version="1.0.0")
    etree.SubElement(root, 'PRODUCT', Name="rekordbox", Version="6.8.5", Company="Pioneer DJ")

    collection = etree.SubElement(root, 'COLLECTION', Entries=str(len(tracks_data)))
    track_id_map: dict[str, int] = {}

    for idx, t in enumerate(tracks_data):
        int_id = idx + 1
        track_id_map[t['id']] = int_id

        src_path = t.get('file_path') or ''
        ext = Path(src_path).suffix.lower() if src_path else '.mp3'
        file_fmt = (t.get('file_format') or '').lower()
        kind = _KIND_MAP.get(f'.{file_fmt}' if file_fmt else ext, _KIND_MAP.get(ext, 'MP3 File'))
        usb_rel = f"Contents/{t['id']}{ext}"

        bpm = t.get('bpm')
        bpm_str = f"{bpm:.2f}" if bpm else "0.00"
        duration_s = int((t.get('duration_ms') or 0) / 1000)
        date_added = (t.get('date_added') or '')[:10] or '2024-01-01'
        bitrate = t.get('bitrate') or 0
        size = Path(src_path).stat().st_size if src_path and Path(src_path).exists() else 0

        attrs = {
            'TrackID': str(int_id),
            'Name': t.get('title') or '',
            'Artist': t.get('artist') or '',
            'Composer': '',
            'Album': t.get('album') or '',
            'Grouping': '',
            'Genre': t.get('genre') or '',
            'Kind': kind,
            'Size': str(size),
            'TotalTime': str(duration_s),
            'DiscNumber': '0',
            'TrackNumber': '0',
            'Year': str(t.get('year') or ''),
            'AverageBpm': bpm_str,
            'DateModified': date_added,
            'DateAdded': date_added,
            'BitRate': str(bitrate),
            'SampleRate': '44100',
            'Comments': t.get('comment') or '',
            'PlayCount': str(t.get('play_count') or 0),
            'LastPlayed': '',
            'Rating': str(_pioneer_rating(t.get('rating') or 0)),
            'Location': f"file://localhost/{usb_rel}",
            'Remixer': t.get('remixer') or '',
            'Tonality': t.get('key_musical') or '',
            'Label': t.get('label') or '',
            'Mix': '',
            'Colour': '0',
        }
        track_el = etree.SubElement(collection, 'TRACK', **attrs)

        # Beat grid TEMPO entry — CDJs use this for beat sync
        if bpm:
            etree.SubElement(track_el, 'TEMPO',
                             Inizio="0.000", Bpm=bpm_str,
                             Metro="4/4", Battito="1")

        # Cue points
        for cue in sorted(t.get('cues', []), key=lambda c: c.get('sort_order', 0)):
            pos_s = cue['position_ms'] / 1000.0
            cue_type = cue.get('type', 'hot')
            sort = cue.get('sort_order', 0)
            num = sort if cue_type == 'hot' else -1
            r, g, b = _HOT_CUE_COLORS[sort % len(_HOT_CUE_COLORS)] if cue_type == 'hot' else (255, 255, 0)
            mark_attrs = {
                'Name': cue.get('label') or '',
                'Type': _cue_type_num(cue_type),
                'Start': f"{pos_s:.3f}",
                'Num': str(num),
                'Red': str(r), 'Green': str(g), 'Blue': str(b),
            }
            if cue_type == 'loop' and cue.get('loop_length_ms'):
                end_s = (cue['position_ms'] + cue['loop_length_ms']) / 1000.0
                mark_attrs['End'] = f"{end_s:.3f}"
            etree.SubElement(track_el, 'POSITION_MARK', **mark_attrs)

    # Playlists
    playlists_el = etree.SubElement(root, 'PLAYLISTS')
    root_node = etree.SubElement(playlists_el, 'NODE', Type="0", Name="ROOT",
                                 Count=str(len(playlists_data)))
    for pl in playlists_data:
        track_ids = pl.get('track_ids', [])
        pl_node = etree.SubElement(root_node, 'NODE', Type="1",
                                   Name=pl['name'], KeyType="0",
                                   Entries=str(len(track_ids)))
        for t_uuid in track_ids:
            int_id = track_id_map.get(t_uuid)
            if int_id:
                etree.SubElement(pl_node, 'TRACK', Key=str(int_id))

    return etree.tostring(root, pretty_print=True, xml_declaration=True, encoding='UTF-8')


def build_usb_export(
    playlist_ids: List[str],
    db: Session,
    settings,
    job_id: str,
) -> str:
    """Build Pioneer USB structure as a ZIP and return the ZIP file path."""
    from app import models

    playlists = (
        db.query(models.Playlist)
        .filter(models.Playlist.id.in_(playlist_ids))
        .all()
    )

    seen_ids: set = set()
    ordered_tracks: list = []
    playlists_data: list = []

    for pl in playlists:
        track_ids = []
        for pt in sorted(pl.tracks, key=lambda x: x.position):
            track = pt.track
            if track.id not in seen_ids:
                seen_ids.add(track.id)
                beat = (db.query(models.Beat).filter(models.Beat.track_id == track.id).first())
                cues_raw = [
                    {
                        'position_ms': c.position_ms,
                        'type': c.type,
                        'label': c.label,
                        'sort_order': c.sort_order,
                        'loop_length_ms': c.loop_length_ms,
                    }
                    for c in track.cues
                ]
                ordered_tracks.append({
                    'id': track.id,
                    'title': track.title,
                    'artist': track.artist,
                    'album': track.album,
                    'genre': track.genre,
                    'label': track.label,
                    'remixer': track.remixer,
                    'year': track.year,
                    'bpm': track.bpm,
                    'key_musical': track.key_musical,
                    'duration_ms': track.duration_ms,
                    'bitrate': track.bitrate,
                    'file_format': track.file_format,
                    'date_added': str(track.date_added) if track.date_added else None,
                    'rating': track.rating,
                    'play_count': track.play_count,
                    'comment': track.comment,
                    'file_path': track.file_path,
                    'anlz_path': track.anlz_path,
                    'cues': cues_raw,
                    'beat_times_ms': beat.beat_positions_ms if beat else [],
                })
            track_ids.append(track.id)
        playlists_data.append({'name': pl.name, 'track_ids': track_ids})

    export_dir = Path(settings.data_dir) / "exports" / job_id
    content_dir = export_dir / "Contents"
    pioneer_dir = export_dir / "PIONEER" / "rekordbox"
    anlz_dir = export_dir / "PIONEER" / "USBANLZ"
    for d in [content_dir, pioneer_dir, anlz_dir]:
        d.mkdir(parents=True, exist_ok=True)

    # Write rekordbox.xml (root level + inside PIONEER/rekordbox for older CDJs)
    xml_bytes = _build_rekordbox_xml(ordered_tracks, playlists_data)
    (export_dir / "rekordbox.xml").write_bytes(xml_bytes)
    (pioneer_dir / "rekordbox.xml").write_bytes(xml_bytes)

    # Copy audio files and ANLZ data
    for t in ordered_tracks:
        src = t.get('file_path') or ''
        if src and Path(src).exists():
            ext = Path(src).suffix
            shutil.copy2(src, content_dir / f"{t['id']}{ext}")

        anlz_src = t.get('anlz_path')
        if anlz_src and Path(anlz_src).exists():
            anlz_dst = anlz_dir / t['id']
            anlz_dst.mkdir(parents=True, exist_ok=True)
            for f in Path(anlz_src).iterdir():
                if f.is_file():
                    shutil.copy2(f, anlz_dst / f.name)
            # Re-generate ANLZ with cue points if we have beat data
            if t.get('beat_times_ms') or t.get('cues'):
                _regenerate_anlz_with_cues(t, anlz_dst)

    zip_path = Path(settings.data_dir) / "exports" / f"{job_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
        for f in export_dir.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(export_dir))

    shutil.rmtree(export_dir)
    logger.info(f"Pioneer export complete: {zip_path} ({len(ordered_tracks)} tracks)")
    return str(zip_path)


def _regenerate_anlz_with_cues(track_data: dict, anlz_dst: Path) -> None:
    """Overwrite ANLZ files for this track, adding cue points to the EXT file."""
    try:
        from app.services.anlz import generate_anlz_with_cues
        beat_times = track_data.get('beat_times_ms') or []
        bpm = track_data.get('bpm') or 0
        duration_ms = track_data.get('duration_ms') or 0
        cues = track_data.get('cues') or []
        generate_anlz_with_cues(
            track_id=track_data['id'],
            beat_times_ms=beat_times,
            bpm=float(bpm),
            duration_ms=int(duration_ms),
            cues=cues,
            anlz_dir=str(anlz_dst),
        )
    except Exception as e:
        logger.warning(f"ANLZ cue regeneration failed for {track_data['id']}: {e}")
