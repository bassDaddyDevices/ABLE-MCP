"""Tests for the pure-Python MIDI analysis primitives."""

from __future__ import annotations

from able_mcp.midi import analysis


def _note(pitch: int, start: float, duration: float = 0.5, velocity: int = 100) -> dict:
    return {"pitch": pitch, "start": start, "duration": duration, "velocity": velocity}


def test_estimate_key_empty():
    assert analysis.estimate_key([]) is None


def test_estimate_key_c_major_scale():
    # C D E F G A B (7 notes of C major over 7 beats).
    notes = [_note(60 + offs, i, duration=1.0) for i, offs in enumerate([0, 2, 4, 5, 7, 9, 11])]
    key = analysis.estimate_key(notes)
    assert key is not None
    assert key.tonic == "C"
    assert key.mode == "major"
    assert key.confidence > 0
    assert key.correlation > 0.7


def test_estimate_key_a_minor_signal():
    # A minor pentatonic emphasized: A C D E G — should land in A minor or
    # close enough that A is a serious candidate.
    notes = [_note(57 + offs, i, duration=1.0, velocity=100)
             for i, offs in enumerate([0, 3, 5, 7, 10] * 2)]
    key = analysis.estimate_key(notes)
    assert key is not None
    candidates = {(key.tonic, key.mode)} | {(a["tonic"], a["mode"]) for a in key.alternatives}
    assert ("A", "minor") in candidates


def test_note_stats_basic():
    notes = [_note(60, 0, 1.0, 80), _note(64, 1, 1.0, 100), _note(67, 2, 1.0, 120)]
    stats = analysis.note_stats(notes)
    assert stats.count == 3
    assert stats.pitch_min == 60
    assert stats.pitch_max == 67
    assert stats.avg_velocity == 100.0
    assert stats.total_beats == 3.0
    assert sum(stats.pitch_class_histogram) > 0.99


def test_estimate_meter_density_downbeat_heavy():
    notes = [_note(60, beat, 0.25) for beat in (0, 0, 0, 1, 2, 3)]
    res = analysis.estimate_meter_density(notes, beats_per_bar=4)
    assert res["beats_per_bar"] == 4
    assert sum(res["by_beat"]) == 6
    assert res["fraction_on_downbeat"] > 0.4


def test_guess_chords_c_major_triad():
    # Sustained C E G across 2 beats.
    notes = [_note(60, 0, 2.0), _note(64, 0, 2.0), _note(67, 0, 2.0)]
    chords = analysis.guess_chords(notes, window_beats=1.0)
    assert chords, "expected at least one labeled window"
    assert chords[0]["chord"] == "C"


def test_guess_chords_minor_triad():
    notes = [_note(57, 0, 2.0), _note(60, 0, 2.0), _note(64, 0, 2.0)]
    chords = analysis.guess_chords(notes, window_beats=1.0)
    assert chords
    assert chords[0]["chord"].startswith("A")
    assert "min" in chords[0]["chord"]


def test_guess_chords_empty():
    assert analysis.guess_chords([]) == []
