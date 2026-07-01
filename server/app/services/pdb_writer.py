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
PAGE_TYPE_UNKNOWN_9 = 9
PAGE_TYPE_UNKNOWN_10 = 10
PAGE_TYPE_HISTORY_PLAYLISTS = 11
PAGE_TYPE_HISTORY_ENTRIES = 12
PAGE_TYPE_ARTWORK = 13
PAGE_TYPE_UNKNOWN_14 = 14
PAGE_TYPE_UNKNOWN_15 = 15
PAGE_TYPE_COLUMNS = 16
PAGE_TYPE_UNKNOWN_17 = 17
PAGE_TYPE_UNKNOWN_18 = 18
PAGE_TYPE_HISTORY = 19

# A real rekordbox export.pdb declares ALL 20 table types in its header (0-19),
# each with at least one allocated page even when empty. Emitting only a subset
# is a self-inconsistency rekordbox's re-parser rejects as "device library
# corrupted" and CDJs read as "database not found". We declare all 20 in order.
_TABLE_ORDER = list(range(20))

# Fixed reference tables copied verbatim from a real rekordbox 7.2.7 export.pdb.
# These are identical in every export (independent of library content): the 8
# standard track colors (6), the browsable metadata columns (16, the CDJ browse
# menu with U+FFFA/U+FFFB-wrapped localized names), two browse-config tables
# (17, 18), and a history/property row (19). Copied as opaque bytes because
# their exact row layout is not in the public spec -- verbatim real bytes are
# guaranteed correct.
_FIXED_REFERENCE_ROWS = {
    6: [
        bytes.fromhex('00000000010100000b50696e6b000000'),
        bytes.fromhex('000000000202000009526564'),
        bytes.fromhex('00000000030300000f4f72616e676500'),
        bytes.fromhex('00000000040400000f59656c6c6f7700'),
        bytes.fromhex('00000000050500000d477265656e0000'),
        bytes.fromhex('00000000060600000b41717561000000'),
        bytes.fromhex('00000000070700000b426c7565000000'),
        bytes.fromhex('00000000080800000f507572706c6500'),
    ],
    16: [
        bytes.fromhex('0100800090120000faff470045004e0052004500fbff0000'),
        bytes.fromhex('0200810090140000faff410052005400490053005400fbff'),
        bytes.fromhex('0300820090120000faff41004c00420055004d00fbff0000'),
        bytes.fromhex('0400830090120000faff54005200410043004b00fbff0000'),
        bytes.fromhex('05008500900e0000faff420050004d00fbff0000'),
        bytes.fromhex('0600860090140000faff52004100540049004e004700fbff'),
        bytes.fromhex('0700870090100000faff5900450041005200fbff'),
        bytes.fromhex('0800880090160000faff520045004d004900580045005200fbff0000'),
        bytes.fromhex('0900890090120000faff4c004100420045004c00fbff0000'),
        bytes.fromhex('0a008a0090260000faff4f0052004900470049004e0041004c002000410052005400490053005400fbff0000'),
        bytes.fromhex('0b008b00900e0000faff4b0045005900fbff0000'),
        bytes.fromhex('0c008d00900e0000faff430055004500fbff0000'),
        bytes.fromhex('0d008e0090120000faff43004f004c004f005200fbff0000'),
        bytes.fromhex('0e00920090100000faff540049004d004500fbff'),
        bytes.fromhex('0f00930090160000faff4200490054005200410054004500fbff0000'),
        bytes.fromhex('10009400901a0000faff460049004c00450020004e0041004d004500fbff0000'),
        bytes.fromhex('1100840090180000faff50004c00410059004c00490053005400fbff'),
        bytes.fromhex('1200980090200000faff48004f00540020004300550045002000420041004e004b00fbff'),
        bytes.fromhex('1300950090160000faff48004900530054004f0052005900fbff0000'),
        bytes.fromhex('1400910090140000faff530045004100520043004800fbff'),
        bytes.fromhex('1500960090180000faff43004f004d004d0045004e0054005300fbff'),
        bytes.fromhex('16008c00901c0000faff4400410054004500200041004400440045004400fbff'),
        bytes.fromhex('1700970090220000faff44004a00200050004c0041005900200043004f0055004e005400fbff0000'),
        bytes.fromhex('1800900090140000faff46004f004c00440045005200fbff'),
        bytes.fromhex('1900a10090160000faff440045004600410055004c005400fbff0000'),
        bytes.fromhex('1a00a20090180000faff41004c00500048004100420045005400fbff'),
        bytes.fromhex('1b00aa0090180000faff4d00410054004300480049004e004700fbff'),
    ],
    17: [
        bytes.fromhex('0f00140006010000'), bytes.fromhex('1000150063010000'),
        bytes.fromhex('1200170063010000'), bytes.fromhex('0800090063010000'),
        bytes.fromhex('09000a0063010000'), bytes.fromhex('0a000b0063010000'),
        bytes.fromhex('0d000f0063010000'), bytes.fromhex('0e00130004010000'),
        bytes.fromhex('0100010063010000'), bytes.fromhex('0500060005010000'),
        bytes.fromhex('0600070063010000'), bytes.fromhex('0700080063010000'),
        bytes.fromhex('0200020002000100'), bytes.fromhex('0300030003000200'),
        bytes.fromhex('0400040001000300'), bytes.fromhex('0b000c0063000400'),
        bytes.fromhex('1100050063000500'), bytes.fromhex('1300160063000600'),
        bytes.fromhex('1400120063000700'), bytes.fromhex('1b001a0063020800'),
        bytes.fromhex('1800110063000900'), bytes.fromhex('16001b0063050a00'),
    ],
    18: [
        bytes.fromhex('1600110001000000'), bytes.fromhex('0e00080001000000'),
        bytes.fromhex('0800090001000000'), bytes.fromhex('09000a0001000000'),
        bytes.fromhex('0a000b0001000000'), bytes.fromhex('0f000d0001000000'),
        bytes.fromhex('0d000f0001000000'), bytes.fromhex('1700100001000000'),
        bytes.fromhex('0100060001000000'), bytes.fromhex('1500070001000000'),
        bytes.fromhex('1900000000010000'), bytes.fromhex('1a00010000020000'),
        bytes.fromhex('0200020000030000'), bytes.fromhex('0300030000040000'),
        bytes.fromhex('0500040000050000'), bytes.fromhex('0600050000060000'),
        bytes.fromhex('0b000c0000070000'),
    ],
    19: [
        bytes.fromhex('8002c000020000000000000017323032362d30372d3031191e0b3130303003000000000000000000'),
    ],
}

# exportExt.pdb is a separate, smaller DeviceSQL file (9 table types) that a real
# rekordbox export ships alongside export.pdb. Its only populated tables are the
# 28 preset My-Tag definitions (type 3) and one metadata row (type 7) -- both
# fixed reference data, copied verbatim from a real exportExt.pdb.
_EXT_TABLE_ORDER = list(range(9))
_EXT_FIXED_REFERENCE_ROWS = {
    3: [
        bytes.fromhex('80060000000000000000000000000000000000000100000000000001031f250d47656e72650300000000000000000000'),
        bytes.fromhex('8006200000000000000000000100000000000000bc09ecb400000000031f2a174163696420486f75736503000000000000000000'),
        bytes.fromhex('8006400000000000000000000100000001000000c5a9ba2800000000031f2a174465657020486f75736503000000000000000000'),
        bytes.fromhex('8006600000000000000000000100000002000000d1363a6800000000031f260f546563686e6f03000000000000000000'),
        bytes.fromhex('80068000000000000000000001000000030000000b6d07dc00000000031f28134e7520446973636f030000000000000000000000'),
        bytes.fromhex('8006a00000000000000000000100000004000000a6c8805c00000000031f2d1d456c656374726f20486f7573650300000000000000000000'),
        bytes.fromhex('8006c0000000000000000000010000000500000090761c4b00000000031f2a1742617373204d7573696303000000000000000000'),
        bytes.fromhex('8006e000000000000000000001000000060000001bd9da0100000000031f240b54726170030000000000000000000000'),
        bytes.fromhex('80060001000000000000000000000000010000000200000000000001031f2a17436f6d706f6e656e747303000000000000000000'),
        bytes.fromhex('80062001000000000000000002000000000000006b40f09800000000031f250d53796e74680300000000000000000000'),
        bytes.fromhex('80064001000000000000000002000000010000003dfe642200000000031f250d566f63616c0300000000000000000000'),
        bytes.fromhex('8006600100000000000000000200000002000000fde1511200000000031f240b42656174030000000000000000000000'),
        bytes.fromhex('80068001000000000000000002000000030000009fdb494400000000031f28135375622042617373030000000000000000000000'),
        bytes.fromhex('8006a00100000000000000000200000004000000cc5c095d00000000031f2a1750657263757373696f6e03000000000000000000'),
        bytes.fromhex('8006c00100000000000000000200000005000000d883b1e000000000031f250d5069616e6f0300000000000000000000'),
        bytes.fromhex('8006e00100000000000000000200000006000000d38636f700000000031f240b4461726b030000000000000000000000'),
        bytes.fromhex('8006000200000000000000000200000007000000870fb49e00000000031f250d55707065720300000000000000000000'),
        bytes.fromhex('80062002000000000000000000000000020000000300000000000001031f2915536974756174696f6e0300000000000000000000'),
        bytes.fromhex('8006400200000000000000000300000000000000f94978cb00000000031f2a174d61696e20466c6f6f7203000000000000000000'),
        bytes.fromhex('80066002000000000000000003000000010000005e00546a00000000031f2c1b5365636f6e6420466c6f6f72030000000000000000000000'),
        bytes.fromhex('800680020000000000000000030000000200000084b1e80d00000000031f260f4c6f756e676503000000000000000000'),
        bytes.fromhex('8006a002000000000000000003000000030000003117e11b00000000031f29154d6964204e696768740300000000000000000000'),
        bytes.fromhex('8006c0020000000000000000030000000400000030cdd8ba00000000031f27114d6f726e696e67030000000000000000'),
        bytes.fromhex('8006e002000000000000000003000000050000008fd3eb4300000000031f28134275696c64207570030000000000000000000000'),
        bytes.fromhex('8006000300000000000000000300000006000000586775f700000000031f29155065616b2054696d650300000000000000000000'),
        bytes.fromhex('800620030000000000000000030000000700000096367a6c00000000031f2a174275696c6420646f776e03000000000000000000'),
        bytes.fromhex('80064003000000000000000000000000030000000400000000000001031f2f21556e7469746c656420436f6c756d6e030000000000000000'),
        bytes.fromhex('80066003000000000000000004000000000000001facd0bb00000000031f2a174d7920436f6d6d656e7403000000000000000000'),
    ],
    7: [
        bytes.fromhex('000700000000000000000000000000000000000000000000b5ac012e0322232425260303030303000000000000000000000000000000000000000000'),
    ],
}


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
    def __init__(self, table_order: Optional[List[int]] = None,
                 fixed_rows: Optional[Dict[int, List[bytes]]] = None):
        self._table_order = table_order if table_order is not None else _TABLE_ORDER
        self._tables: Dict[int, _Table] = {pt: _Table(pt) for pt in self._table_order}
        self._sequence = 1
        # Seed the fixed reference tables (colors + browse menu + history) that a
        # real export always carries. Track/artist/etc. rows are added later by
        # the caller on top of these.
        seed = fixed_rows if fixed_rows is not None else _FIXED_REFERENCE_ROWS
        for page_type, rows in seed.items():
            for row in rows:
                self._tables[page_type].add_row(row)

    def add_row(self, page_type: int, row_bytes: bytes):
        self._tables[page_type].add_row(row_bytes)

    def build(self) -> bytes:
        next_index = 1  # page 0 is the file header/table-of-contents page
        table_page_indices: Dict[int, List[int]] = {}
        for pt in self._table_order:
            pages = self._tables[pt].pages
            indices = list(range(next_index, next_index + len(pages)))
            table_page_indices[pt] = indices
            next_index += len(pages)
        total_pages = next_index

        rendered: Dict[int, bytes] = {}
        for pt in self._table_order:
            pages = self._tables[pt].pages
            indices = table_page_indices[pt]
            for i, page in enumerate(pages):
                page_index = indices[i]
                next_page = indices[i + 1] if i + 1 < len(indices) else total_pages
                rendered[page_index] = page.render(page_index, next_page, self._sequence)

        header = bytearray(PAGE_SIZE)
        struct.pack_into('<4xIIIII4x', header, 0,
                          PAGE_SIZE, len(self._table_order), total_pages, 0, self._sequence)
        pos = 28
        for pt in self._table_order:
            indices = table_page_indices[pt]
            struct.pack_into('<IIII', header, pos, pt, 0, indices[0], indices[-1])
            pos += 16

        out = bytearray(header)
        for page_index in range(1, total_pages):
            out += rendered[page_index]
        return bytes(out)


def build_export_ext_pdb() -> bytes:
    """Build exportExt.pdb -- the 9-table companion file a real rekordbox export
    ships next to export.pdb. Only the fixed preset My-Tag definitions and one
    metadata row are populated (verbatim from a real export); the rest are the
    empty tables rekordbox still declares."""
    return PdbWriter(table_order=_EXT_TABLE_ORDER,
                     fixed_rows=_EXT_FIXED_REFERENCE_ROWS).build()


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
