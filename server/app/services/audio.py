"""Audio analysis service using librosa + mutagen."""
import logging
import hashlib
import io
import struct
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
import numpy as np

logger = logging.getLogger(__name__)
executor = ThreadPoolExecutor(max_workers=2)


def compute_file_hash(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def analyze_track_background(track_id: str, filepath: str, data_dir: str, db_url: str):
    """Run in thread pool. Creates its own DB session."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.models import Track, Beat
    engine = create_engine(db_url, connect_args={"check_same_thread": False})
    Session = sessionmaker(bind=engine)
    db = Session()
    try:
        track = db.query(Track).filter(Track.id == track_id).first()
        if not track:
            return
        track.analysis_state = "analyzing"
        db.commit()

        import librosa
        import soundfile as sf

        # Load audio
        y, sr = librosa.load(filepath, sr=None, mono=True)

        # BPM and beats
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='frames')
        beat_times_ms = [float(t * 1000) for t in librosa.frames_to_time(beat_frames, sr=sr)]
        bpm = float(tempo)

        # Key detection
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = chroma.mean(axis=1)
        key_idx = int(np.argmax(chroma_mean))
        is_minor = _detect_minor(chroma_mean)
        key_musical, key_camelot = _key_to_camelot(key_idx, is_minor)

        # Waveform overview (500 points)
        overview = _compute_waveform_overview(y, 500)

        # Waveform detail (2000 points for scrollable view)
        detail = _compute_waveform_overview(y, 2000)

        # Energy (RMS)
        rms = float(np.sqrt(np.mean(y**2)))

        # Update track
        track.bpm = round(bpm, 2)
        track.bpm_analysed = True
        track.key_camelot = key_camelot
        track.key_musical = key_musical
        track.energy = round(rms, 6)
        track.analysis_state = "complete"
        track.file_hash = compute_file_hash(filepath)

        # Save beats
        existing_beat = db.query(Beat).filter(Beat.track_id == track_id).first()
        if existing_beat:
            db.delete(existing_beat)
        beat = Beat(
            track_id=track_id,
            beat_positions_ms=beat_times_ms,
            downbeats_ms=beat_times_ms[::4],  # every 4th beat as downbeat estimate
            waveform_overview=_encode_waveform(overview),
            waveform_detail=_encode_waveform(detail),
        )
        db.add(beat)
        db.commit()

        # Generate ANLZ files
        try:
            anlz_dir = Path(data_dir) / "anlz" / track_id
            anlz_dir.mkdir(parents=True, exist_ok=True)
            from app.services.anlz import generate_anlz
            generate_anlz(
                track_id=track_id,
                beat_times_ms=beat_times_ms,
                bpm=bpm,
                duration_ms=int(librosa.get_duration(y=y, sr=sr) * 1000),
                waveform_overview=overview,
                anlz_dir=str(anlz_dir),
            )
            track.anlz_path = str(anlz_dir)
            db.commit()
        except Exception as e:
            logger.warning(f"ANLZ generation failed for {track_id}: {e}")

    except Exception as e:
        logger.error(f"Analysis failed for track {track_id}: {e}", exc_info=True)
        try:
            track = db.query(Track).filter(Track.id == track_id).first()
            if track:
                track.analysis_state = "failed"
                track.analysis_error = str(e)
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _detect_minor(chroma_mean: np.ndarray) -> bool:
    major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_profile = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    key_idx = int(np.argmax(chroma_mean))
    major_match = np.corrcoef(np.roll(major_profile, key_idx), chroma_mean)[0, 1]
    minor_match = np.corrcoef(np.roll(minor_profile, key_idx), chroma_mean)[0, 1]
    return minor_match > major_match


def _key_to_camelot(key_idx: int, is_minor: bool) -> tuple:
    notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    camelot_major = {0: '8B', 1: '3B', 2: '10B', 3: '5B', 4: '12B', 5: '7B',
                     6: '2B', 7: '9B', 8: '4B', 9: '11B', 10: '6B', 11: '1B'}
    camelot_minor = {0: '5A', 1: '12A', 2: '7A', 3: '2A', 4: '9A', 5: '4A',
                     6: '11A', 7: '6A', 8: '1A', 9: '8A', 10: '3A', 11: '10A'}
    note = notes[key_idx]
    suffix = 'm' if is_minor else ''
    musical = f"{note}{suffix}"
    camelot = camelot_minor[key_idx] if is_minor else camelot_major[key_idx]
    return musical, camelot


def _compute_waveform_overview(y: np.ndarray, points: int) -> list:
    chunk_size = max(1, len(y) // points)
    result = []
    for i in range(points):
        start = i * chunk_size
        end = min(start + chunk_size, len(y))
        if start >= len(y):
            result.append(0.0)
        else:
            chunk = y[start:end]
            result.append(float(np.max(np.abs(chunk))))
    return result


def _encode_waveform(waveform: list) -> bytes:
    """Pack waveform as binary float32 array."""
    return struct.pack(f'{len(waveform)}f', *waveform)


def decode_waveform(data: bytes) -> list:
    count = len(data) // 4
    return list(struct.unpack(f'{count}f', data))


def _extract_basic_tags(filepath: str) -> dict:
    """Quick tag extraction without full analysis."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(filepath, easy=True)
        if not audio:
            return {}
        result = {}
        mapping = {
            'title': 'title', 'artist': 'artist', 'album': 'album',
            'albumartist': 'album_artist', 'genre': 'genre',
            'comment': 'comment', 'isrc': 'isrc',
        }
        for src, dst in mapping.items():
            val = audio.get(src, [None])[0]
            if val:
                result[dst] = str(val)
        year_str = audio.get('date', [None])[0]
        if year_str:
            try:
                result['year'] = int(str(year_str)[:4])
            except ValueError:
                pass
        bpm_str = audio.get('bpm', [None])[0]
        if bpm_str:
            try:
                result['bpm'] = float(bpm_str)
            except ValueError:
                pass
        if hasattr(audio, 'info'):
            result['duration_ms'] = int(audio.info.length * 1000)
            result['bitrate'] = getattr(audio.info, 'bitrate', None)
            result['file_format'] = type(audio).__name__.lower()[:16]
        return result
    except Exception:
        return {}
