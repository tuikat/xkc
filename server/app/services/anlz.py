"""Generate Pioneer ANLZ analysis files (.DAT, .EXT) for USB export."""
import struct
import logging
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

ANLZ_MAGIC = b'PMAI'
SECTION_HEADER_SIZE = 12  # type(4) + len(4) + body_len(4)

# Pioneer PCOB cue type values
_PCOB_TYPE_CUE = 1
_PCOB_TYPE_HOT = 2
_PCOB_TYPE_LOOP = 4
_PCOB_TYPE_LOAD = 3

_HOT_CUE_COLORS = [
    0xCC0000, 0xCC6600, 0xCCCC00, 0x00CC00,
    0x00CCCC, 0x0000CC, 0x6600CC, 0xCC0066,
]


def _file_header(total_size: int) -> bytes:
    header_len = 20
    return struct.pack('>4sIIII', ANLZ_MAGIC, header_len, 0, total_size, 0)


def _section(section_type: bytes, body: bytes) -> bytes:
    body_len = len(body)
    total_len = SECTION_HEADER_SIZE + body_len
    return struct.pack('>4sII', section_type, total_len, body_len) + body


def _build_beat_grid(beat_times_ms: List[float], bpm: float) -> bytes:
    count = len(beat_times_ms)
    body = struct.pack('>III', 0, int(bpm * 100), count)
    for i, t_ms in enumerate(beat_times_ms):
        bar = (i // 4) + 1
        beat_in_bar = (i % 4) + 1
        body += struct.pack('>HHIi', bar, beat_in_bar, int(t_ms), 0)
    return body


def _build_waveform_preview(waveform: List[float]) -> bytes:
    import numpy as np
    arr = np.array(waveform, dtype=np.float32)
    indices = np.linspace(0, len(arr) - 1, 400).astype(int)
    sampled = arr[indices]
    max_val = float(sampled.max()) or 1.0
    normalized = np.clip((sampled / max_val * 31), 0, 31).astype(np.uint8)
    body = struct.pack('>III', 0, 400, 0)
    body += bytes(normalized)
    return body


def _build_cue_list(cues: List[dict]) -> bytes:
    """Build PCOB section body with cue point entries."""
    if not cues:
        return struct.pack('>II', 0, 0)

    entries = []
    for cue in sorted(cues, key=lambda c: c.get('sort_order', 0)):
        cue_type = cue.get('type', 'hot')
        pos_ms = int(cue.get('position_ms', 0))
        sort = cue.get('sort_order', 0)
        label = cue.get('label') or ''
        name_bytes = label.encode('utf-16-be') if label else b''
        name_len = len(name_bytes)

        if cue_type == 'hot':
            pb_type = _PCOB_TYPE_HOT
            hot_index = sort
            color = _HOT_CUE_COLORS[sort % len(_HOT_CUE_COLORS)]
        elif cue_type == 'loop':
            pb_type = _PCOB_TYPE_LOOP
            hot_index = 0xFF
            color = 0x00CCCC
        elif cue_type == 'load':
            pb_type = _PCOB_TYPE_LOAD
            hot_index = 0xFF
            color = 0xCCCC00
        else:
            pb_type = _PCOB_TYPE_CUE
            hot_index = 0xFF
            color = 0xFFFF00

        # Entry: type(4) + flags(4) + position(4) + loop_end(4) + color(4) + hot_index(2) + unknown(2) + name_len(2) + name
        loop_end = pos_ms
        if cue_type == 'loop' and cue.get('loop_length_ms'):
            loop_end = pos_ms + int(cue['loop_length_ms'])

        entry = struct.pack('>IIIIIHHh',
                            pb_type, 0, pos_ms, loop_end, color,
                            hot_index if hot_index != 0xFF else 0xFFFF,
                            0, name_len)
        entry += name_bytes
        entries.append(entry)

    body = struct.pack('>II', len(entries), 0)
    for e in entries:
        body += e
    return body


def _build_waveform_detail(duration_ms: int) -> bytes:
    """Build PWV2 section — 2500-byte detail waveform (blank if no data)."""
    count = 2500
    body = struct.pack('>III', 0, count, 2)
    body += bytes(count * 2)
    return body


def _build_anlz_file(sections: list) -> bytes:
    content = b''.join(sections)
    total_size = 20 + len(content)
    return _file_header(total_size) + content


def generate_anlz(
    track_id: str,
    beat_times_ms: List[float],
    bpm: float,
    duration_ms: int,
    waveform_overview: List[float],
    anlz_dir: str,
) -> str:
    """Generate ANLZ0000.DAT with beat grid and waveform overview."""
    sections = []

    if beat_times_ms:
        sections.append(_section(b'PBPM', _build_beat_grid(beat_times_ms, bpm)))

    if waveform_overview:
        sections.append(_section(b'PWAV', _build_waveform_preview(waveform_overview)))

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
) -> None:
    """Regenerate ANLZ0000.DAT and generate ANLZ0000.EXT with cue points for USB export."""
    anlz_path = Path(anlz_dir)

    # DAT file: beat grid only (waveform overview already in existing file)
    dat_sections = []
    if beat_times_ms:
        dat_sections.append(_section(b'PBPM', _build_beat_grid(beat_times_ms, bpm)))
    dat_path = anlz_path / "ANLZ0000.DAT"
    if not dat_path.exists() or beat_times_ms:
        if dat_sections:
            dat_path.write_bytes(_build_anlz_file(dat_sections))

    # EXT file: cue list + waveform detail
    ext_sections = []
    if cues:
        ext_sections.append(_section(b'PCOB', _build_cue_list(cues)))
    ext_sections.append(_section(b'PWV2', _build_waveform_detail(duration_ms)))

    ext_path = anlz_path / "ANLZ0000.EXT"
    ext_path.write_bytes(_build_anlz_file(ext_sections))
    logger.info(f"Generated ANLZ EXT for track {track_id}: {ext_path}")
