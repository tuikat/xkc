"""Pioneer USB export service. Generates export.pdb and USB directory structure."""
import os
import io
import struct
import shutil
import zipfile
import logging
import hashlib
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from datetime import datetime

logger = logging.getLogger(__name__)

PAGE_SIZE = 4096

# Table type constants (page_type field)
TABLE_TRACKS = 0
TABLE_GENRES = 1
TABLE_ARTISTS = 2
TABLE_ALBUMS = 3
TABLE_LABELS = 4
TABLE_KEYS = 5
TABLE_COLORS = 6
TABLE_ARTWORK = 7
TABLE_PLAYLIST_TREE = 8
TABLE_PLAYLIST_ENTRIES = 9


class PDBWriter:
    """Minimal Pioneer DeviceSQL PDB writer."""

    def __init__(self):
        self.pages: List[bytes] = []
        self._string_cache: Dict[str, int] = {}

    def _pad_page(self, data: bytes) -> bytes:
        if len(data) > PAGE_SIZE:
            data = data[:PAGE_SIZE]
        return data + b'\x00' * (PAGE_SIZE - len(data))

    def _encode_string(self, s: str) -> bytes:
        """Encode a DeviceSQL string: 1-byte length prefix + UTF-16LE + 2-byte terminator."""
        if not s:
            return b'\x00'
        encoded = s.encode('utf-16-le')
        length = len(encoded) // 2
        return bytes([length + 1]) + encoded + b'\x00\x00'

    def _encode_isrc(self, s: str) -> bytes:
        if not s:
            return b'\x00'
        b = s.encode('ascii', errors='replace')[:12]
        return bytes([len(b)]) + b

    def add_page(self, page_type: int, rows_data: List[bytes]) -> int:
        """Add a table page. Returns page index."""
        header = struct.pack(
            '<IIIIHHHHHHIIIII',
            page_type,        # page_type
            0,                # unknown
            0,                # next_page (0 = last)
            0,                # unknown
            len(rows_data),   # num_rows_large
            0,                # unknown
            0,                # free_size
            0,                # used_size
            0,                # unknown
            len(rows_data),   # num_rows_small
            0, 0, 0, 0, 0     # unknown x5
        )
        rows_blob = b''
        offsets = []
        for row in rows_data:
            offsets.append(40 + len(offsets) * 2 + len(rows_blob))
            rows_blob += row

        offset_data = struct.pack(f'<{len(offsets)}H', *offsets) if offsets else b''
        content = header + offset_data + rows_blob
        page = self._pad_page(content)
        idx = len(self.pages)
        self.pages.append(page)
        return idx

    def write(self, path: str):
        with open(path, 'wb') as f:
            for page in self.pages:
                f.write(page)


def _text_row(row_id: int, name: str) -> bytes:
    """Generic ID + name row (artists, genres, etc.)"""
    name_bytes = name.encode('utf-8', errors='replace')[:254] + b'\x00'
    return struct.pack('<HH', row_id, len(name_bytes)) + name_bytes


def _track_row(
    track_id: int, title: str, artist_id: int, album_id: int,
    genre_id: int, duration: int, bpm_x100: int, key_id: int,
    rating: int, file_path: str, comment: str
) -> bytes:
    """Simplified track row for export.pdb."""
    title_b = title.encode('utf-8', errors='replace')[:254] + b'\x00'
    path_b = file_path.encode('utf-8', errors='replace')[:510] + b'\x00'
    comment_b = (comment or '').encode('utf-8', errors='replace')[:254] + b'\x00'
    return (
        struct.pack('<HHHHHIII',
                    track_id, artist_id, album_id, genre_id,
                    key_id, rating, duration, bpm_x100)
        + struct.pack(f'<H{len(title_b)}s', len(title_b), title_b)
        + struct.pack(f'<H{len(path_b)}s', len(path_b), path_b)
        + struct.pack(f'<H{len(comment_b)}s', len(comment_b), comment_b)
    )


def _playlist_tree_row(playlist_id: int, parent_id: int, name: str, is_folder: int) -> bytes:
    name_b = name.encode('utf-8', errors='replace')[:254] + b'\x00'
    return struct.pack('<HHIH', playlist_id, parent_id, is_folder, len(name_b)) + name_b


def _playlist_entry_row(entry_id: int, playlist_id: int, track_id: int, position: int) -> bytes:
    return struct.pack('<HHHH', entry_id, playlist_id, track_id, position)


def build_usb_export(
    playlist_ids: List[str],
    tracks_data: List[dict],
    playlists_data: List[dict],
    output_dir: str,
    data_dir: str,
) -> str:
    """
    Build Pioneer USB structure in output_dir.
    Returns path to output_dir.
    """
    pioneer_dir = Path(output_dir) / "PIONEER"
    rb_dir = pioneer_dir / "rekordbox"
    anlz_dir = pioneer_dir / "USBANLZ"
    content_dir = Path(output_dir) / "Contents"
    for d in [rb_dir, anlz_dir, content_dir]:
        d.mkdir(parents=True, exist_ok=True)

    artists: Dict[str, int] = {}
    albums: Dict[str, int] = {}
    genres: Dict[str, int] = {}

    def get_or_add(d: dict, key: str) -> int:
        if not key:
            key = "Unknown"
        if key not in d:
            d[key] = len(d) + 1
        return d[key]

    writer = PDBWriter()

    track_rows = []
    track_id_map: Dict[str, int] = {}
    for i, t in enumerate(tracks_data):
        int_id = i + 1
        track_id_map[t['id']] = int_id
        artist_id = get_or_add(artists, t.get('artist') or 'Unknown Artist')
        album_id = get_or_add(albums, t.get('album') or 'Unknown Album')
        genre_id = get_or_add(genres, t.get('genre') or 'Unknown Genre')
        src_path = t.get('file_path', '')
        ext = Path(src_path).suffix if src_path else '.mp3'
        usb_path = f"/Contents/{t['id']}{ext}"
        bpm_x100 = int((t.get('bpm') or 0) * 100)
        row = _track_row(
            track_id=int_id,
            title=t.get('title') or 'Unknown',
            artist_id=artist_id,
            album_id=album_id,
            genre_id=genre_id,
            duration=int((t.get('duration_ms') or 0) / 1000),
            bpm_x100=bpm_x100,
            key_id=0,
            rating=t.get('rating') or 0,
            file_path=usb_path,
            comment=t.get('comment') or '',
        )
        track_rows.append(row)

    if track_rows:
        writer.add_page(TABLE_TRACKS, track_rows)
    if artists:
        writer.add_page(TABLE_ARTISTS, [_text_row(v, k) for k, v in artists.items()])
    if albums:
        writer.add_page(TABLE_ALBUMS, [_text_row(v, k) for k, v in albums.items()])
    if genres:
        writer.add_page(TABLE_GENRES, [_text_row(v, k) for k, v in genres.items()])

    playlist_rows = []
    pl_entry_rows = []
    entry_id = 1
    for pl in playlists_data:
        pl_int_id = len(playlist_rows) + 1
        playlist_rows.append(_playlist_tree_row(pl_int_id, 0, pl['name'], 0))
        for pos, t_uuid in enumerate(pl.get('track_ids', [])):
            t_int_id = track_id_map.get(t_uuid)
            if t_int_id:
                pl_entry_rows.append(_playlist_entry_row(entry_id, pl_int_id, t_int_id, pos))
                entry_id += 1

    if playlist_rows:
        writer.add_page(TABLE_PLAYLIST_TREE, playlist_rows)
    if pl_entry_rows:
        writer.add_page(TABLE_PLAYLIST_ENTRIES, pl_entry_rows)

    writer.write(str(rb_dir / "export.pdb"))

    # Copy audio files and ANLZ
    for t in tracks_data:
        src = t.get('file_path', '')
        if src and Path(src).exists():
            ext = Path(src).suffix
            dst = content_dir / f"{t['id']}{ext}"
            shutil.copy2(src, dst)

        anlz_src = t.get('anlz_path')
        if anlz_src and Path(anlz_src).exists():
            anlz_dst = anlz_dir / t['id']
            anlz_dst.mkdir(parents=True, exist_ok=True)
            for f in Path(anlz_src).iterdir():
                shutil.copy2(f, anlz_dst / f.name)

    return output_dir


def generate_rekordbox_xml(tracks_data: List[dict], playlists_data: List[dict]) -> str:
    """Generate rekordbox.xml format as a fallback/additional export."""
    from lxml import etree
    root = etree.Element('DJ_PLAYLISTS', Version="1.0.0")
    etree.SubElement(root, 'PRODUCT', Name="XKC", Version="1.0", Company="XKC")

    collection = etree.SubElement(root, 'COLLECTION', Entries=str(len(tracks_data)))
    for idx, t in enumerate(tracks_data):
        track_el = etree.SubElement(collection, 'TRACK')
        track_el.set('TrackID', str(idx + 1))
        track_el.set('Name', t.get('title') or '')
        track_el.set('Artist', t.get('artist') or '')
        track_el.set('Album', t.get('album') or '')
        track_el.set('Genre', t.get('genre') or '')
        track_el.set('Kind', 'MP3 File')
        track_el.set('TotalTime', str(int((t.get('duration_ms') or 0) / 1000)))
        track_el.set('AverageBpm', str(t.get('bpm') or ''))
        track_el.set('Tonality', t.get('key_musical') or '')
        track_el.set('Rating', str(t.get('rating') or 0))
        track_el.set('Location', f"file://localhost{t.get('file_path', '')}")
        track_el.set('Comments', t.get('comment') or '')

        for cue in t.get('cues', []):
            pos = cue['position_ms'] / 1000.0
            cue_el = etree.SubElement(track_el, 'POSITION_MARK')
            cue_el.set('Name', cue.get('label') or '')
            cue_el.set('Type', '0' if cue['type'] == 'hot' else '1')
            cue_el.set('Start', f"{pos:.3f}")
            cue_el.set('Num', str(cue.get('sort_order', 0)))

    playlists_el = etree.SubElement(root, 'PLAYLISTS')
    root_node = etree.SubElement(playlists_el, 'NODE', Type="0", Name="ROOT",
                                  Count=str(len(playlists_data)))
    for pl in playlists_data:
        pl_node = etree.SubElement(root_node, 'NODE', Type="1", Name=pl['name'],
                                    KeyType="0", Entries=str(len(pl.get('track_ids', []))))
        for t_uuid in pl.get('track_ids', []):
            found_idx = next((i + 1 for i, t in enumerate(tracks_data) if t['id'] == t_uuid), None)
            if found_idx:
                etree.SubElement(pl_node, 'TRACK', Key=str(found_idx))

    return etree.tostring(root, pretty_print=True, xml_declaration=True, encoding='UTF-8').decode()
