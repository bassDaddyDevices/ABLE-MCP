"""Lightweight MIDI analysis primitives.

Inputs are sequences of ``MidiNote``-like objects: anything with ``pitch``,
``start``, ``duration``, ``velocity`` attributes (the .als parser's dataclass
fits) or dicts with those keys.

All functions are deterministic, dependency-free, and tolerant of empty input.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

# Krumhansl-Schmuckler key profiles (Krumhansl & Kessler, 1982) — major/minor
# tone-weight vectors. Index 0 = tonic.
_MAJOR_PROFILE = (
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
)
_MINOR_PROFILE = (
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
)

_PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def _note_field(note: Any, name: str, default: float = 0.0) -> float:
    if isinstance(note, dict):
        return float(note.get(name, default))
    return float(getattr(note, name, default))


def _pitch_field(note: Any) -> int:
    if isinstance(note, dict):
        return int(note.get("pitch", 0))
    return int(getattr(note, "pitch", 0))


@dataclass(frozen=True)
class KeyEstimate:
    tonic: str  # e.g. "C", "F#"
    mode: str  # "major" | "minor"
    confidence: float  # 0..1, gap between best and second-best
    correlation: float  # raw Pearson coefficient for the winner
    alternatives: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class NoteStats:
    count: int
    pitch_min: int | None
    pitch_max: int | None
    avg_velocity: float
    notes_per_beat: float
    total_beats: float
    pitch_class_histogram: list[float]  # length 12, normalized weights


def _pitch_class_weights(notes: Sequence[Any]) -> list[float]:
    """Duration-weighted pitch-class histogram, normalized to sum=1 (or zeros)."""
    weights = [0.0] * 12
    total = 0.0
    for n in notes:
        dur = max(_note_field(n, "duration", 0.0), 0.0)
        if dur <= 0:
            dur = 0.25  # treat zero-length as a sixteenth so it still counts
        pc = _pitch_field(n) % 12
        weights[pc] += dur
        total += dur
    if total <= 0:
        return [0.0] * 12
    return [w / total for w in weights]


def _pearson(a: Sequence[float], b: Sequence[float]) -> float:
    n = len(a)
    if n == 0:
        return 0.0
    ma = sum(a) / n
    mb = sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    da = sum((a[i] - ma) ** 2 for i in range(n)) ** 0.5
    db = sum((b[i] - mb) ** 2 for i in range(n)) ** 0.5
    if da == 0 or db == 0:
        return 0.0
    return num / (da * db)


def estimate_key(notes: Iterable[Any]) -> KeyEstimate | None:
    """Krumhansl-Schmuckler key estimation. Returns None if there are no notes."""
    notes = list(notes)
    if not notes:
        return None
    weights = _pitch_class_weights(notes)
    if sum(weights) == 0:
        return None
    scored: list[tuple[float, str, str]] = []
    for tonic in range(12):
        rotated_major = [_MAJOR_PROFILE[(i - tonic) % 12] for i in range(12)]
        rotated_minor = [_MINOR_PROFILE[(i - tonic) % 12] for i in range(12)]
        scored.append((_pearson(weights, rotated_major), _PITCH_CLASSES[tonic], "major"))
        scored.append((_pearson(weights, rotated_minor), _PITCH_CLASSES[tonic], "minor"))
    scored.sort(key=lambda x: x[0], reverse=True)
    best = scored[0]
    runner = scored[1] if len(scored) > 1 else (0.0, "", "")
    confidence = max(0.0, min(1.0, best[0] - runner[0]))
    return KeyEstimate(
        tonic=best[1],
        mode=best[2],
        confidence=confidence,
        correlation=best[0],
        alternatives=[
            {"tonic": t, "mode": m, "correlation": c}
            for c, t, m in scored[1:5]
        ],
    )


def note_stats(notes: Iterable[Any]) -> NoteStats:
    notes = list(notes)
    if not notes:
        return NoteStats(0, None, None, 0.0, 0.0, 0.0, [0.0] * 12)
    pitches = [_pitch_field(n) for n in notes]
    velocities = [_note_field(n, "velocity", 0.0) for n in notes]
    starts = [_note_field(n, "start", 0.0) for n in notes]
    ends = [_note_field(n, "start", 0.0) + _note_field(n, "duration", 0.0) for n in notes]
    span = max(ends) - min(starts) if ends and starts else 0.0
    span = max(span, 0.0)
    return NoteStats(
        count=len(notes),
        pitch_min=min(pitches),
        pitch_max=max(pitches),
        avg_velocity=sum(velocities) / len(velocities),
        notes_per_beat=(len(notes) / span) if span > 0 else 0.0,
        total_beats=span,
        pitch_class_histogram=_pitch_class_weights(notes),
    )


def estimate_meter_density(notes: Iterable[Any], beats_per_bar: int = 4) -> dict[str, Any]:
    """Beat-position density: how many notes start near each beat in a bar."""
    notes = list(notes)
    bins = [0] * beats_per_bar
    for n in notes:
        beat = _note_field(n, "start", 0.0)
        slot = int(beat) % beats_per_bar
        bins[slot] += 1
    total = sum(bins)
    return {
        "beats_per_bar": beats_per_bar,
        "by_beat": bins,
        "fraction_on_downbeat": (bins[0] / total) if total else 0.0,
    }


# --- Chord guessing -------------------------------------------------------

# Canonical chord templates as semitone sets relative to root (root included).
_CHORD_TEMPLATES: tuple[tuple[str, frozenset[int]], ...] = (
    ("maj", frozenset({0, 4, 7})),
    ("min", frozenset({0, 3, 7})),
    ("dim", frozenset({0, 3, 6})),
    ("aug", frozenset({0, 4, 8})),
    ("sus2", frozenset({0, 2, 7})),
    ("sus4", frozenset({0, 5, 7})),
    ("maj7", frozenset({0, 4, 7, 11})),
    ("7", frozenset({0, 4, 7, 10})),
    ("min7", frozenset({0, 3, 7, 10})),
    ("dim7", frozenset({0, 3, 6, 9})),
    ("m7b5", frozenset({0, 3, 6, 10})),
)


def _label_chord(pcs: frozenset[int]) -> str | None:
    if not pcs:
        return None
    best: tuple[str, int] | None = None  # (label, score)
    for root in range(12):
        rel = frozenset((p - root) % 12 for p in pcs)
        for name, template in _CHORD_TEMPLATES:
            # Score = matches - extras. Tie-broken by template specificity (size).
            matches = len(template & rel)
            extras = len(rel - template)
            missing = len(template - rel)
            if matches < 3:  # need a triad's worth
                continue
            score = matches * 3 - extras * 2 - missing
            label = f"{_PITCH_CLASSES[root]}{name}" if name != "maj" else _PITCH_CLASSES[root]
            if best is None or score > best[1]:
                best = (label, score)
    return best[0] if best else None


def guess_chords(notes: Iterable[Any], window_beats: float = 1.0) -> list[dict[str, Any]]:
    """Slide a window across the timeline, label each window's pitch-class set.

    Adjacent identical labels are coalesced. Empty windows are skipped.
    """
    notes = list(notes)
    if not notes:
        return []
    starts = [_note_field(n, "start", 0.0) for n in notes]
    ends = [_note_field(n, "start", 0.0) + _note_field(n, "duration", 0.0) for n in notes]
    t0 = min(starts)
    t1 = max(ends)
    if t1 <= t0 or window_beats <= 0:
        return []
    windows: list[dict[str, Any]] = []
    cur = t0
    while cur < t1:
        nxt = cur + window_beats
        active: list[int] = []
        for n in notes:
            s = _note_field(n, "start", 0.0)
            e = s + _note_field(n, "duration", 0.0)
            if e > cur and s < nxt:
                active.append(_pitch_field(n) % 12)
        if active:
            label = _label_chord(frozenset(active))
            if label:
                if windows and windows[-1]["chord"] == label:
                    windows[-1]["end"] = nxt
                else:
                    windows.append({"start": cur, "end": nxt, "chord": label})
        cur = nxt
    return windows
