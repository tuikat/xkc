"""Generate Pioneer ANLZ analysis files (.DAT, .EXT) for USB export."""
import struct
import logging
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)

ANLZ_MAGIC = b'PMAI'
SECTION_HEADER_SIZE = 12  # type(4) + len(4) + body_len(4)


def _file_header(total_size: int) -> bytes:
    # magic(4) + header_len(4) + unknown(4) + file_len(4) + unknown(4)
    header_len = 20
    return struct.pack('>4sIIII', ANLZ_MAGIC, header_len, 0, total_size, 0)


def _section(section_type: bytes, body: bytes) -> bytes:
    body_len = len(body)
    total_len = SECTION_HEADER_SIZE + body_len
    header = struct.pack('>4sII', section_type, total_len, body_len)
    return header + body


def _build_beat_grid(beat_times_ms: List[float], bpm: float) -> bytes:
    """Build PBPM section body."""
    # PBPM body: unknown(4) + bpm_x100(4) + count(4) + entries
    # Each entry: bar_number(2) + beat_number(2) + ms_offset(4) + unknown(4)
    count = len(beat_times_ms)
    body = struct.pack('>III', 0, int(bpm * 100), count)
    for i, t_ms in enumerate(beat_times_ms):
        bar = (i // 4) + 1
        beat_in_bar = (i % 4) + 1
        body += struct.pack('>HHIi', bar, beat_in_bar, int(t_ms), 0)
    return body


def _build_waveform_preview(waveform: List[float]) -> bytes:
    """Build PWAV section body — 400 bytes, each byte 0-31 height."""
    import numpy as np
    arr = np.array(waveform, dtype=np.float32)
    # Resample to 400 points
    indices = np.linspace(0, len(arr) - 1, 400).astype(int)
    sampled = arr[indices]
    # Normalize to 0-31
    max_val = float(sampled.max()) or 1.0
    normalized = np.clip((sampled / max_val * 31), 0, 31).astype(np.uint8)
    # PWAV body: unknown(4) + entry_count(4) + unknown(4) + data
    body = struct.pack('>III', 0, 400, 0)
    body += bytes(normalized)
    return body


def generate_anlz(
    track_id: str,
    beat_times_ms: List[float],
    bpm: float,
    duration_ms: int,
    waveform_overview: List[float],
    anlz_dir: str,
) -> str:
    """Generate ANLZ0000.DAT in anlz_dir."""
    sections = []

    if beat_times_ms:
        beat_body = _build_beat_grid(beat_times_ms, bpm)
        sections.append(_section(b'PBPM', beat_body))

    if waveform_overview:
        wav_body = _build_waveform_preview(waveform_overview)
        sections.append(_section(b'PWAV', wav_body))

    content = b''.join(sections)
    total_size = 20 + len(content)  # header + sections
    file_data = _file_header(total_size) + content

    out_path = Path(anlz_dir) / "ANLZ0000.DAT"
    out_path.write_bytes(file_data)
    logger.info(f"Generated ANLZ DAT for track {track_id}: {out_path}")
    return str(out_path)
