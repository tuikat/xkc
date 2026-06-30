"""Generate Pioneer ANLZ analysis files (.DAT, .EXT) for USB export.

Binary layout verified field-for-field against the Deep Symmetry "Crate Digger"
reverse-engineering spec (rekordbox_anlz.ksy) -- the same reference used by Mixxx,
rekordcrate and other community CDJ-compatible tools:
https://github.com/Deep-Symmetry/crate-digger/blob/main/src/main/kaitai/rekordbox_anlz.ksy

Deliberately out of scope for now (no current need / matches project roadmap):
PVBR (VBR seek index), PWV2-PWV7 (tiny/scrolling/color waveforms), PSSI (song
structure / lighting phrases). A plain PWAV preview waveform plus beat grid and
cue points covers standalone CDJ playback, beat sync, and hot cues/loops.
"""
import struct
import logging
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

ANLZ_MAGIC = b'PMAI'
FILE_HEADER_LEN = 28
SECTION_HEADER_LEN = 12  # fourcc(4) + len_header(4) + len_tag(4), fixed for top-level sections

_CUE_TYPE_MEMORY = 1
_CUE_TYPE_LOOP = 2

# RGB used for both the legacy PCOB list and as PCO2's explicit color fields
_HOT_CUE_COLORS = [
    (0xCC, 0x00, 0x00), (0xCC, 0x66, 0x00), (0xCC, 0xCC, 0x00), (0x00, 0xCC, 0x00),
    (0x00, 0xCC, 0xCC), (0x00, 0x00, 0xCC), (0x66, 0x00, 0xCC), (0xCC, 0x00, 0x66),
]


def _file_header(total_size: int) -> bytes:
    header = struct.pack('>4sII', ANLZ_MAGIC, FILE_HEADER_LEN, total_size)
    return header + b'\x00' * (FILE_HEADER_LEN - len(header))


def _section(fourcc: bytes, body: bytes) -> bytes:
    return struct.pack('>4sII', fourcc, SECTION_HEADER_LEN, SECTION_HEADER_LEN + len(body)) + body


def _build_anlz_file(sections: List[bytes]) -> bytes:
    content = b''.join(s for s in sections if s)
    return _file_header(FILE_HEADER_LEN + len(content)) + content


def _build_path(file_path: str) -> bytes:
    text = (file_path or '') + '\x00'
    encoded = text.encode('utf-16-be')
    # len_path is documented as 2 bytes larger than the actual encoded text
    # (the reader computes the real size as len_path - 2).
    return struct.pack('>I', len(encoded) + 2) + encoded


def _build_beat_grid(beat_times_ms: List[float], bpm: float) -> bytes:
    if not beat_times_ms:
        return b''
    tempo = max(1, int(round(bpm * 100))) if bpm else 0
    body = struct.pack('>III', 0, 0x80000, len(beat_times_ms))
    for i, t_ms in enumerate(beat_times_ms):
        beat_number = (i % 4) + 1  # position within bar; we don't track true downbeat phase
        body += struct.pack('>HHI', beat_number, tempo, max(0, int(round(t_ms))))
    return body


def _build_wave_preview(waveform: List[float]) -> bytes:
    import numpy as np
    count = 400
    if waveform:
        arr = np.array(waveform, dtype=np.float32)
        indices = np.linspace(0, len(arr) - 1, count).astype(int)
        sampled = arr[indices]
        max_val = float(sampled.max()) or 1.0
        data = bytes(np.clip(sampled / max_val * 31, 0, 31).astype(np.uint8))
    else:
        data = bytes(count)
    return struct.pack('>II', len(data), 0x10000) + data


def _bucket_cues(cues: List[dict]) -> tuple:
    """Split XKC cues into Pioneer's two lists: hot cues (assigned to pads A-H)
    and ordinary memory cues/loops. XKC cue kinds with no CDJ equivalent
    (fadein, fadeout, load) become plain memory cues -- the binary format only
    knows about memory_cue vs loop."""
    hot, memory = [], []
    for cue in sorted(cues, key=lambda c: c.get('sort_order', 0)):
        is_hot = cue.get('type') == 'hot'
        is_loop = cue.get('type') == 'loop'
        pos_ms = max(0, int(cue.get('position_ms', 0)))
        entry = {
            'hot_cue': (cue.get('sort_order', 0) + 1) if is_hot else 0,
            'kind': _CUE_TYPE_LOOP if is_loop else _CUE_TYPE_MEMORY,
            'time_ms': pos_ms,
            'loop_time_ms': pos_ms + int(cue.get('loop_length_ms') or 0) if is_loop else 0,
            'label': cue.get('label') or '',
            'color_idx': cue.get('sort_order', 0) % len(_HOT_CUE_COLORS),
        }
        (hot if is_hot else memory).append(entry)
    return hot, memory


def _order_fields(i: int, count: int) -> tuple:
    """First/last-in-sequence link hints used by the player's cue list UI.
    0xFFFF is the documented sentinel for "no entry on this side"."""
    order_first = 0xFFFF if i == 0 else i
    order_last = 0xFFFF if i == count - 1 else i + 1
    return order_first, order_last


def _build_cue_entry(entry: dict, order_first: int, order_last: int) -> bytes:
    body = struct.pack(
        '>IIIHHB3sII16s',
        entry['hot_cue'],
        1,        # status: enabled (not disabled, not an in-progress active loop)
        0x10000,  # unknown, spec notes it "seems to always be 0x10000"
        order_first, order_last,
        entry['kind'], b'\x00\x00\x00',
        entry['time_ms'], entry['loop_time_ms'],
        b'\x00' * 16,
    )
    return struct.pack('>4sII', b'PCPT', SECTION_HEADER_LEN, SECTION_HEADER_LEN + len(body)) + body


def _build_cue_extended_entry(entry: dict) -> bytes:
    comment = (entry['label'] + '\x00').encode('utf-16-be') if entry['label'] else b''
    r, g, b = _HOT_CUE_COLORS[entry['color_idx']]
    fixed = struct.pack(
        '>IB3sIIB7sHH',
        entry['hot_cue'],
        entry['kind'], b'\x00\x00\x00',
        entry['time_ms'], entry['loop_time_ms'],
        entry['color_idx'] + 1, b'\x00' * 7,
        0, 0,  # loop_numerator/denominator: 0 = not beat-quantized
    )
    tail = struct.pack('>I', len(comment)) + comment + struct.pack('>BBBB', entry['color_idx'] + 1, r, g, b)
    body = fixed + tail
    return struct.pack('>4sII', b'PCP2', SECTION_HEADER_LEN, SECTION_HEADER_LEN + len(body)) + body


def _build_cue_list(entries: List[dict], list_type: int) -> bytes:
    """PCOB: a basic cue list readable by every CDJ generation. list_type is the
    Pioneer cue_list_type enum: 0 = memory cues/loops, 1 = hot cues/loops."""
    if not entries:
        return b''
    body = struct.pack('>IHH I', list_type, 0, len(entries), 0)  # type, reserved(2), num_cues, memory_count
    for i, e in enumerate(entries):
        of, ol = _order_fields(i, len(entries))
        body += _build_cue_entry(e, of, ol)
    return _section(b'PCOB', body)


def _build_cue_extended_list(entries: List[dict], list_type: int) -> bytes:
    """PCO2: nxs2+ extension adding cue names and explicit colors."""
    if not entries:
        return b''
    body = struct.pack('>IH2s', list_type, len(entries), b'\x00\x00')
    for e in entries:
        body += _build_cue_extended_entry(e)
    return _section(b'PCO2', body)


def generate_anlz(
    track_id: str,
    beat_times_ms: List[float],
    bpm: float,
    duration_ms: int,
    waveform_overview: List[float],
    anlz_dir: str,
    file_path: str = '',
) -> str:
    """Generate ANLZ0000.DAT with path, beat grid and a preview waveform."""
    sections = [
        _section(b'PPTH', _build_path(file_path)),
        _section(b'PQTZ', _build_beat_grid(beat_times_ms, bpm)) if beat_times_ms else b'',
        _section(b'PWAV', _build_wave_preview(waveform_overview)),
    ]
    out_path = Path(anlz_dir) / "ANLZ0000.DAT"
    out_path.write_bytes(_build_anlz_file(sections))
    logger.info(f"Generated ANLZ DAT for track {track_id}: {out_path}")
    return str(out_path)


def generate_anlz_with_cues(
    track_id: str,
    beat_times_ms: List[float],
    bpm: float,
    duration_ms: int,
    cues: List[dict],
    anlz_dir: str,
    file_path: str = '',
) -> None:
    """Regenerate ANLZ0000.DAT (path + beat grid) and ANLZ0000.EXT (cue points)
    for USB export, now that the user may have added cues since initial analysis."""
    anlz_path = Path(anlz_dir)

    dat_sections = [
        _section(b'PPTH', _build_path(file_path)),
        _section(b'PQTZ', _build_beat_grid(beat_times_ms, bpm)) if beat_times_ms else b'',
    ]
    if beat_times_ms:
        dat_path = anlz_path / "ANLZ0000.DAT"
        dat_path.write_bytes(_build_anlz_file(dat_sections))

    hot, memory = _bucket_cues(cues)
    ext_sections = [
        _section(b'PPTH', _build_path(file_path)),
        _build_cue_list(memory, list_type=0),
        _build_cue_list(hot, list_type=1),
        _build_cue_extended_list(memory, list_type=0),
        _build_cue_extended_list(hot, list_type=1),
    ]
    ext_path = anlz_path / "ANLZ0000.EXT"
    ext_path.write_bytes(_build_anlz_file(ext_sections))
    logger.info(f"Generated ANLZ EXT for track {track_id}: {ext_path} ({len(hot)} hot cues, {len(memory)} memory cues/loops)")
