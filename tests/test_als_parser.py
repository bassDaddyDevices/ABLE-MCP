from __future__ import annotations

from pathlib import Path

import pytest

from able_mcp.als import parser
from tests.fixtures import EMPTY_SET, FOUR_TRACK_SET, write_als


@pytest.fixture()
def empty_als(tmp_path: Path) -> Path:
    return write_als(EMPTY_SET, tmp_path / "empty.als")


@pytest.fixture()
def four_track_als(tmp_path: Path) -> Path:
    return write_als(FOUR_TRACK_SET, tmp_path / "four.als")


def test_parse_empty(empty_als: Path) -> None:
    s = parser.parse(empty_als)
    assert s.tempo == 120.0
    assert s.tracks == []
    assert s.scenes == []
    assert s.creator and "Ableton Live 12" in s.creator


def test_parse_tempo_and_meter(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    assert s.tempo == 124.0
    assert s.time_signature_numerator == 4
    assert s.time_signature_denominator == 4


def test_parse_track_count_and_kinds(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    assert len(s.tracks) == 4
    assert [t.kind for t in s.tracks] == ["midi", "midi", "audio", "audio"]
    assert [t.name for t in s.tracks] == ["Bass", "Lead", "Drums", "Vox"]


def test_parse_midi_notes(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    bass = s.tracks[0]
    assert len(bass.clips) == 1
    clip = bass.clips[0]
    assert clip.is_midi
    assert clip.length == 4.0
    assert clip.looping is True
    assert len(clip.notes) == 3
    pitches = sorted(n.pitch for n in clip.notes)
    assert pitches == [36, 36, 43]
    bass_note = next(n for n in clip.notes if n.pitch == 43)
    assert bass_note.start == 2.0
    assert bass_note.duration == 0.5
    assert bass_note.velocity == 90.0


def test_empty_midi_clip_has_no_notes(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    lead = s.tracks[1]
    assert len(lead.clips) == 1
    assert lead.clips[0].notes == []


def test_audio_clip_sample_path(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    drums = s.tracks[2]
    assert drums.muted is True
    assert len(drums.clips) == 1
    clip = drums.clips[0]
    assert not clip.is_midi
    assert clip.sample_path is not None
    assert "drums.wav" in clip.sample_path


def test_devices_extracted(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    bass = s.tracks[0]
    assert len(bass.devices) == 1
    assert bass.devices[0].kind == "Operator"
    assert bass.devices[0].name == "Bass Synth"


def test_scenes(four_track_als: Path) -> None:
    s = parser.parse(four_track_als)
    assert [sc.name for sc in s.scenes] == ["Intro", "Drop"]


def test_parse_rejects_non_gzip(tmp_path: Path) -> None:
    bad = tmp_path / "bad.als"
    bad.write_bytes(b"not gzip")
    with pytest.raises(Exception):
        parser.parse(bad)
