"""Audio guide extraction + complementary MIDI generation.

The goal is practical songwriting support:
1) derive a monophonic guide melody from a vocal WAV file, then
2) generate a complementary line that follows phrase contour without cloning.

Dependency-free by design (stdlib only) so this can run anywhere `able-mcp`
runs. The extractor is intentionally conservative and best for clean,
monophonic vocals.
"""

from __future__ import annotations

import math
import random
import wave
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any

from .analysis import estimate_key


@dataclass(frozen=True)
class GuideNote:
    pitch: int
    start_sec: float
    duration_sec: float
    velocity: int = 100


@dataclass(frozen=True)
class ExtractSummary:
    sample_rate: int
    frame_size: int
    hop_size: int
    voiced_frames: int
    total_frames: int


def _rms(frame: list[float]) -> float:
    if not frame:
        return 0.0
    return math.sqrt(sum(x * x for x in frame) / len(frame))


def _autocorr_pitch_hz(
    frame: list[float],
    sample_rate: int,
    min_hz: float = 80.0,
    max_hz: float = 1000.0,
) -> float | None:
    n = len(frame)
    if n < 64:
        return None

    # Remove DC bias to stabilize autocorrelation.
    mean = sum(frame) / n
    x = [v - mean for v in frame]

    min_lag = max(1, int(sample_rate / max_hz))
    max_lag = min(n - 2, int(sample_rate / min_hz))
    if max_lag <= min_lag:
        return None

    e0 = sum(v * v for v in x)
    if e0 <= 1e-9:
        return None

    best_lag = -1
    best_score = -1.0
    for lag in range(min_lag, max_lag + 1):
        num = 0.0
        den_b = 0.0
        upper = n - lag
        for i in range(upper):
            a = x[i]
            b = x[i + lag]
            num += a * b
            den_b += b * b
        den = math.sqrt(e0 * den_b) if den_b > 0 else 0.0
        score = (num / den) if den > 0 else 0.0
        if score > best_score:
            best_score = score
            best_lag = lag

    # Reject weakly periodic frames.
    if best_lag <= 0 or best_score < 0.35:
        return None
    return float(sample_rate) / float(best_lag)


def _hz_to_midi(hz: float) -> int:
    return int(round(69 + 12 * math.log2(max(hz, 1e-6) / 440.0)))


def _read_wav_mono(path: Path) -> tuple[list[float], int]:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if sampwidth not in (1, 2):
        raise ValueError(f"Unsupported WAV sample width: {sampwidth * 8} bits (expected 8 or 16)")

    data: list[float] = []
    if sampwidth == 1:
        # Unsigned 8-bit PCM.
        for i in range(0, len(raw), channels):
            s = 0.0
            for ch in range(channels):
                v = raw[i + ch]
                s += (v - 128) / 128.0
            data.append(s / channels)
    else:
        # Signed 16-bit PCM little-endian.
        step = sampwidth * channels
        for i in range(0, len(raw), step):
            s = 0.0
            for ch in range(channels):
                off = i + ch * sampwidth
                v = int.from_bytes(raw[off : off + 2], "little", signed=True)
                s += v / 32768.0
            data.append(s / channels)

    return data, sample_rate


def extract_guide_melody_from_wav(
    file_path: str,
    min_note: int = 45,
    max_note: int = 88,
    frame_ms: float = 40.0,
    hop_ms: float = 10.0,
    min_note_sec: float = 0.08,
) -> tuple[list[GuideNote], ExtractSummary]:
    """Extract a monophonic vocal guide from WAV.

    Returns (notes, summary). Note timing is in seconds.
    """
    path = Path(file_path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"No audio file at {path}")

    samples, sample_rate = _read_wav_mono(path)
    if not samples:
        return [], ExtractSummary(sample_rate, 0, 0, 0, 0)

    frame_size = max(64, int(sample_rate * frame_ms / 1000.0))
    hop_size = max(16, int(sample_rate * hop_ms / 1000.0))

    midi_track: list[int | None] = []
    voiced_frames = 0
    total_frames = 0

    # Dynamic energy floor based on first second.
    probe = samples[: min(len(samples), sample_rate)]
    probe_rms = _rms(probe)
    energy_threshold = max(0.01, probe_rms * 0.35)

    i = 0
    while i + frame_size <= len(samples):
        frame = samples[i : i + frame_size]
        total_frames += 1
        if _rms(frame) < energy_threshold:
            midi_track.append(None)
            i += hop_size
            continue

        hz = _autocorr_pitch_hz(frame, sample_rate)
        if hz is None:
            midi_track.append(None)
            i += hop_size
            continue

        midi = _hz_to_midi(hz)
        if midi < min_note or midi > max_note:
            midi_track.append(None)
        else:
            midi_track.append(midi)
            voiced_frames += 1
        i += hop_size

    if not midi_track:
        return [], ExtractSummary(sample_rate, frame_size, hop_size, voiced_frames, total_frames)

    # Median smooth local voiced regions.
    smoothed: list[int | None] = midi_track[:]
    window = 2
    for idx in range(len(midi_track)):
        if midi_track[idx] is None:
            continue
        vals = [midi_track[j] for j in range(max(0, idx - window), min(len(midi_track), idx + window + 1))]
        vals = [v for v in vals if v is not None]
        smoothed[idx] = int(round(median(vals))) if vals else None

    # Convert frame track to note events by grouping contiguous voiced frames
    # with similar pitch.
    notes: list[GuideNote] = []
    cur_pitch: int | None = None
    cur_start = 0
    last_idx = 0

    def flush(end_idx: int) -> None:
        nonlocal cur_pitch, cur_start
        if cur_pitch is None:
            return
        start_sec = (cur_start * hop_size) / sample_rate
        end_sec = ((end_idx * hop_size) + frame_size) / sample_rate
        dur = max(0.0, end_sec - start_sec)
        if dur >= min_note_sec:
            notes.append(GuideNote(pitch=cur_pitch, start_sec=start_sec, duration_sec=dur, velocity=100))
        cur_pitch = None

    for idx, p in enumerate(smoothed):
        last_idx = idx
        if p is None:
            flush(idx)
            continue
        if cur_pitch is None:
            cur_pitch = p
            cur_start = idx
            continue
        if abs(p - cur_pitch) <= 1:
            cur_pitch = int(round((cur_pitch * 0.7) + (p * 0.3)))
            continue
        flush(idx)
        cur_pitch = p
        cur_start = idx
    flush(last_idx + 1)

    return notes, ExtractSummary(sample_rate, frame_size, hop_size, voiced_frames, total_frames)


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def _pick_register(register: str) -> tuple[int, int]:
    r = register.lower().strip()
    if r in {"low", "bass"}:
        return 36, 60
    if r in {"high", "top"}:
        return 67, 96
    return 52, 76


def _scale_pitch_classes_from_key(guide_notes: list[dict[str, Any]]) -> set[int]:
    key = estimate_key(guide_notes)
    if key is None:
        return set(range(12))

    tonic_map = {
        "C": 0,
        "C#": 1,
        "D": 2,
        "D#": 3,
        "E": 4,
        "F": 5,
        "F#": 6,
        "G": 7,
        "G#": 8,
        "A": 9,
        "A#": 10,
        "B": 11,
    }
    tonic = tonic_map.get(key.tonic, 0)
    intervals = [0, 2, 3, 5, 7, 8, 10] if key.mode == "minor" else [0, 2, 4, 5, 7, 9, 11]
    return {(tonic + i) % 12 for i in intervals}


def _snap_to_scale(pitch: int, pcs: set[int]) -> int:
    if not pcs or (pitch % 12) in pcs:
        return pitch
    for d in range(1, 7):
        up = pitch + d
        dn = pitch - d
        if (up % 12) in pcs:
            return up
        if (dn % 12) in pcs:
            return dn
    return pitch


def generate_complementary_melody(
    guide_notes: list[dict[str, Any]],
    similarity: float = 0.55,
    density: float = 0.75,
    register: str = "mid",
    call_response: bool = True,
    seed: int | None = None,
) -> list[dict[str, Any]]:
    """Generate complementary notes from a guide melody in beat space.

    guide_notes entries must contain {pitch, start, duration, velocity?} where
    start/duration are in beats.

    similarity: 0..1 (higher keeps rhythm/contour closer)
    density: 0..1 (higher emits more notes)
    """
    if not guide_notes:
        return []

    rng = random.Random(seed)
    sim = max(0.0, min(1.0, similarity))
    den = max(0.0, min(1.0, density))

    lo, hi = _pick_register(register)
    pcs = _scale_pitch_classes_from_key(guide_notes)

    # Consonant complement intervals first; avoid frequent unison by design.
    intervals = [3, 4, 7, 9, -3, -4, -5, 10]
    out: list[dict[str, Any]] = []

    # Delay for call/response feel (in beats).
    response_delay = 0.0
    if call_response:
        avg = sum(max(0.05, float(n.get("duration", 0.25))) for n in guide_notes) / len(guide_notes)
        response_delay = min(0.5, max(0.125, avg * 0.6))

    for idx, g in enumerate(sorted(guide_notes, key=lambda n: float(n.get("start", 0.0)))):
        if rng.random() > den:
            continue

        gp = int(g.get("pitch", 60))
        gs = float(g.get("start", 0.0))
        gd = max(0.05, float(g.get("duration", 0.25)))
        gv = int(g.get("velocity", 100))

        interval = intervals[idx % len(intervals)]
        if rng.random() > sim:
            interval = rng.choice(intervals)

        p = gp + interval
        if abs(p - gp) <= 1:
            p += 3
        p = _snap_to_scale(p, pcs)
        p = _clamp(p, lo, hi)

        start = gs + response_delay
        if rng.random() > sim:
            start += rng.choice([-0.125, 0.0, 0.125, 0.25])
        start = max(0.0, start)

        dur = gd * (0.75 if call_response else 0.9)
        if rng.random() > sim:
            dur *= rng.choice([0.5, 0.75, 1.0, 1.25])
        dur = max(0.05, dur)

        vel = _clamp(int(gv * 0.88 + rng.randint(-8, 8)), 1, 127)

        out.append({"pitch": p, "start": start, "duration": dur, "velocity": vel})

    # De-overlap in monophonic-friendly order.
    out.sort(key=lambda n: (n["start"], n["pitch"]))
    cleaned: list[dict[str, Any]] = []
    for n in out:
        if not cleaned:
            cleaned.append(n)
            continue
        prev = cleaned[-1]
        prev_end = prev["start"] + prev["duration"]
        if n["start"] < prev_end:
            # Keep the stronger note; move weaker one slightly.
            if n["velocity"] > prev["velocity"]:
                prev["duration"] = max(0.05, n["start"] - prev["start"])
                cleaned.append(n)
            else:
                n2 = dict(n)
                n2["start"] = prev_end + 0.01
                cleaned.append(n2)
        else:
            cleaned.append(n)

    return cleaned


def seconds_notes_to_beats(notes: list[GuideNote], tempo_bpm: float) -> list[dict[str, Any]]:
    """Convert GuideNote(second-based) to beat-based dict notes."""
    if tempo_bpm <= 0:
        raise ValueError("tempo_bpm must be > 0")
    beats_per_sec = tempo_bpm / 60.0
    return [
        {
            "pitch": n.pitch,
            "start": n.start_sec * beats_per_sec,
            "duration": n.duration_sec * beats_per_sec,
            "velocity": n.velocity,
        }
        for n in notes
    ]
