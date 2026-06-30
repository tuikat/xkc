"""Pioneer export.pdb binary database writer.

This is the database file CDJ/XDJ players actually read for standalone USB
playback -- rekordbox.xml (which this project also writes, for interop with
other DJ software) is NOT read by the players themselves in standalone mode.

Binary layout verified field-for-field against the Deep Symmetry "Crate
Digger" reverse-engineering spec (rekordbox_pdb.ksy) -- the same reference
used by Mixxx, rekordcrate and other community CDJ-compatible tools:
https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_pdb.ksy

There is no public reference implementation that *writes* this format (every
known open-source project only reads it), and no real CDJ hardware was
available to validate against while building this -- correctness here rests
on a careful, field-by-field reading of that spec plus a self-consistency
test (see test in the dev scratchpad) that fully round-trips a generated
file. Real-hardware testing is the actual proof; please report back what you
see if a CDJ doesn't show something correctly.
"""
import struct
from typing import Dict, List, Optional

PAGE_SIZE = 4096
PAGE_HEADER_SIZE = 40
ROW_GROUP_SIZE = 0x24  # 16 row offsets (2B) + present flags (2B) + gap (2B) + transaction flags (2B)
ROW_GROUP_MAX_ROWS = 16

PAGE_TYPE_TRACKS = 0
PAGE_TYPE_GENRES = 1
PAGE_TYPE_ARTISTS = 2
PAGE_TYPE_ALBUMS = 3
PAGE_TYPE_LABELS = 4
PAGE_TYPE_KEYS = 5
PAGE_TYPE_COLORS = 6
PAGE_TYPE_PLAYLIST_TREE = 7
PAGE_TYPE_PLAYLIST_ENTRIES = 8
PAGE_TYPE_ARTWORK = 13

_TABLE_ORDER = [
    PAGE_TYPE_TRACKS, PAGE_TYPE_GENRES, PAGE_TYPE_ARTISTS, PAGE_TYPE_ALBUMS,
    PAGE_TYPE_LABELS, PAGE_TYPE_KEYS, PAGE_TYPE_COLORS,
    PAGE_TYPE_PLAYLIST_TREE, PAGE_TYPE_PLAYLIST_ENTRIES, PAGE_TYPE_ARTWORK,
]


def encode_device_sql_string(s: Optional[str]) -> bytes:
    """DeviceSQL variable-length string. Short ASCII (<=126 bytes) packs the
    length into a single mangled header byte; longer or non-ASCII strings use
    a 4-byte header with an explicit 0x40 (ascii) or 0x90 (utf-16le) marker."""
    s = s or ''
    try:
        raw = s.encode('ascii')
        ascii_ok = True
    except UnicodeEncodeError:
        raw = b''
        ascii_ok = False

    if ascii_ok and len(raw) <= 126:
        length_and_kind = ((len(raw) + 1) << 1) | 1
        return bytes([length_and_kind]) + raw
    if ascii_ok:
        body = raw
    else:
        body = s.encode('utf-16-le')
    length = 4 + len(body)
    marker = 0x40 if ascii_ok else 0x90
    return bytes([marker]) + struct.pack('<H', length) + b'\x00' + body


class _Page:
    """One page of a table: a 40-byte header, a heap that grows forward from
    the end of the header, and a row index that grows backward from the end
    of the page."""

    def __init__(self, page_type: int):
        self.page_type = page_type
        self.row_offsets: List[int] = []
        self.heap = bytearray()

    def can_fit(self, row_len: int) -> bool:
        next_count = len(self.row_offsets) + 1
        groups = max(1, (next_count + ROW_GROUP_MAX_ROWS - 1) // ROW_GROUP_MAX_ROWS)
        footer = groups * ROW_GROUP_SIZE
        return PAGE_HEADER_SIZE + len(self.heap) + row_len + footer <= PAGE_SIZE

    def add_row(self, row_bytes: bytes):
        self.row_offsets.append(len(self.heap))
        self.heap += row_bytes

    def render(self, page_index: int, next_page_index: int, sequence: int) -> bytes:
        num_rows = len(self.row_offsets)
        num_row_groups = max(1, (num_rows + ROW_GROUP_MAX_ROWS - 1) // ROW_GROUP_MAX_ROWS)
        footer_size = num_row_groups * ROW_GROUP_SIZE
        used_size = len(self.heap)
        free_size = max(0, PAGE_SIZE - PAGE_HEADER_SIZE - used_size - footer_size)

        buf = bytearray(PAGE_SIZE)
        struct.pack_into('<4xIIII', buf, 0, page_index, self.page_type, next_page_index, sequence)
        # bytes 20-23 reserved, left zero
        bitfield = (num_rows & 0x1FFF) | ((num_rows & 0x7FF) << 13)
        buf[24] = bitfield & 0xFF
        buf[25] = (bitfield >> 8) & 0xFF
        buf[26] = (bitfield >> 16) & 0xFF
        buf[27] = 0x24  # page_flags: ordinary data page (bit 0x40 clear)
        struct.pack_into('<HHHH', buf, 28, free_size, used_size, 0, 0)
        # bytes 36-39 reserved, left zero

        buf[PAGE_HEADER_SIZE:PAGE_HEADER_SIZE + used_size] = self.heap

        for group_index in range(num_row_groups):
            base = PAGE_SIZE - group_index * ROW_GROUP_SIZE
            present = 0
            for slot in range(ROW_GROUP_MAX_ROWS):
                row_idx = group_index * ROW_GROUP_MAX_ROWS + slot
                ofs_pos = base - 6 - 2 * slot
                value = self.row_offsets[row_idx] if row_idx < num_rows else 0
                struct.pack_into('<H', buf, ofs_pos, value)
                if row_idx < num_rows:
                    present |= (1 << slot)
            struct.pack_into('<H', buf, base - 4, present)
            # transaction_row_flags at `base` left as zero: no pending transaction
        return bytes(buf)


class _Table:
    def __init__(self, page_type: int):
        self.page_type = page_type
        # Real rekordbox exports always have an empty placeholder as the first
        # page of a table's chain, with actual rows starting on the next one.
        # Mimicked here in case any firmware parser relies on that pattern.
        self.pages: List[_Page] = [_Page(page_type)]
        self._placeholder_consumed = False

    def add_row(self, row_bytes: bytes):
        if not self._placeholder_consumed:
            self.pages.append(_Page(self.page_type))
            self._placeholder_consumed = True
        if not self.pages[-1].can_fit(len(row_bytes)):
            self.pages.append(_Page(self.page_type))
        self.pages[-1].add_row(row_bytes)


class PdbWriter:
    def __init__(self):
        self._tables: Dict[int, _Table] = {pt: _Table(pt) for pt in _TABLE_ORDER}
        self._sequence = 1

    def add_row(self, page_type: int, row_bytes: bytes):
        self._tables[page_type].add_row(row_bytes)

    def build(self) -> bytes:
        next_index = 1  # page 0 is the file header/table-of-contents page
        table_page_indices: Dict[int, List[int]] = {}
        for pt in _TABLE_ORDER:
            pages = self._tables[pt].pages
            indices = list(range(next_index, next_index + len(pages)))
            table_page_indices[pt] = indices
            next_index += len(pages)
        total_pages = next_index

        rendered: Dict[int, bytes] = {}
        for pt in _TABLE_ORDER:
            pages = self._tables[pt].pages
            indices = table_page_indices[pt]
            for i, page in enumerate(pages):
                page_index = indices[i]
                next_page = indices[i + 1] if i + 1 < len(indices) else total_pages
                rendered[page_index] = page.render(page_index, next_page, self._sequence)

        header = bytearray(PAGE_SIZE)
        struct.pack_into('<4xIIIII4x', header, 0,
                          PAGE_SIZE, len(_TABLE_ORDER), total_pages, 0, self._sequence)
        pos = 28
        for pt in _TABLE_ORDER:
            indices = table_page_indices[pt]
            struct.pack_into('<IIII', header, pos, pt, 0, indices[0], indices[-1])
            pos += 16

        out = bytearray(header)
        for page_index in range(1, total_pages):
            out += rendered[page_index]
        return bytes(out)


# --- Row encoders -----------------------------------------------------------
# Each returns the complete row bytes (fixed fields + inline string data).
# Strings are always placed immediately after the row's fixed part, so the
# "near" 1-byte offset form is always usable and the 2-byte "far" form (an
# optional escape hatch in the format) is never needed.

def build_artist_row(row_id: int, name: str) -> bytes:
    name_bytes = encode_device_sql_string(name)
    ofs_name = 10  # subtype(2)+index_shift(2)+id(4)+0x03(1)+ofs_name_near(1)
    fixed = struct.pack('<HHIBB', 0x60, 0, row_id, 0x03, ofs_name)
    return fixed + name_bytes


def build_album_row(row_id: int, name: str, artist_id: int = 0) -> bytes:
    name_bytes = encode_device_sql_string(name)
    ofs_name = 22  # subtype(2)+index_shift(2)+unk(4)+artist_id(4)+id(4)+unk(4)+0x03(1)+ofs_name_near(1)
    fixed = struct.pack('<HHIIIIBB', 0x80, 0, 0, artist_id, row_id, 0, 0x03, ofs_name)
    return fixed + name_bytes


def build_genre_row(row_id: int, name: str) -> bytes:
    return struct.pack('<I', row_id) + encode_device_sql_string(name)


def build_label_row(row_id: int, name: str) -> bytes:
    return struct.pack('<I', row_id) + encode_device_sql_string(name)


def build_key_row(row_id: int, name: str) -> bytes:
    return struct.pack('<II', row_id, row_id) + encode_device_sql_string(name)


def build_color_row(row_id: int, name: str) -> bytes:
    fixed = struct.pack('<5xHB', row_id, 0)
    return fixed + encode_device_sql_string(name)


def build_artwork_row(row_id: int, path: str) -> bytes:
    return struct.pack('<I', row_id) + encode_device_sql_string(path)


def build_playlist_tree_row(row_id: int, name: str, parent_id: int = 0,
                             sort_order: int = 0, is_folder: bool = False) -> bytes:
    fixed = struct.pack('<I4xIII', parent_id, sort_order, row_id, 1 if is_folder else 0)
    return fixed + encode_device_sql_string(name)


def build_playlist_entry_row(entry_index: int, track_id: int, playlist_id: int) -> bytes:
    return struct.pack('<III', entry_index, track_id, playlist_id)


# Order of the 21 variable-length string fields in a track_row, by index in ofs_strings.
_TRACK_STRING_FIELDS = [
    'isrc', 'texter', 'unknown_2', 'unknown_3', 'unknown_4', 'message',
    'kuvo_public', 'autoload_hot_cues', 'unknown_5', 'unknown_6',
    'date_added', 'release_date', 'mix_name', 'unknown_7', 'analyze_path',
    'analyze_date', 'comment', 'title', 'unknown_8', 'filename', 'file_path',
]


def build_track_row(row_id: int, *, title: str, artist_id: int = 0, album_id: int = 0,
                     genre_id: int = 0, label_id: int = 0, key_id: int = 0,
                     remixer_id: int = 0, artwork_id: int = 0, color_id: int = 0,
                     sample_rate: int = 44100, sample_depth: int = 16, bitrate: int = 0,
                     file_size: int = 0, tempo_bpm: float = 0, duration_s: int = 0,
                     year: int = 0, rating: int = 0, play_count: int = 0,
                     isrc: str = '', comment: str = '', date_added: str = '',
                     analyze_path: str = '', analyze_date: str = '',
                     filename: str = '', file_path: str = '') -> bytes:
    strings = {f: '' for f in _TRACK_STRING_FIELDS}
    strings.update({
        'isrc': isrc, 'comment': comment, 'date_added': date_added,
        'analyze_path': analyze_path, 'analyze_date': analyze_date,
        'title': title, 'filename': filename, 'file_path': file_path,
    })
    encoded = [encode_device_sql_string(strings[f]) for f in _TRACK_STRING_FIELDS]

    FIXED_SIZE = 136
    offsets = []
    pos = FIXED_SIZE
    for enc in encoded:
        offsets.append(pos)
        pos += len(enc)

    tempo = max(0, int(round(tempo_bpm * 100))) if tempo_bpm else 0
    fixed = struct.pack(
        '<HHIIIII HH IIIIIIIIIIII HHHHH H BB HH',
        0x24, 0,                                   # subtype, index_shift
        0, sample_rate, 0, file_size, 0,            # bitmask, sample_rate, composer_id, file_size, unk1
        19048, 30967,                               # unk2, unk3 (spec: "always" these values)
        artwork_id, key_id, 0, label_id, remixer_id,  # original_artist_id always 0 (not modeled)
        bitrate, 0, tempo, genre_id, album_id, artist_id, row_id,  # track_number always 0
        0, play_count, year, sample_depth, duration_s,  # disc_number always 0
        41,                                          # unknown, spec: "always 41?"
        color_id, rating,
        1, 2,                                        # unknowns, spec: "always 1?" / "alternating 2 or 3"
    )
    fixed += struct.pack(f'<{len(offsets)}H', *offsets)
    assert len(fixed) == FIXED_SIZE, len(fixed)
    return fixed + b''.join(encoded)
