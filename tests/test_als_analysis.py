from __future__ import annotations

from pathlib import Path

import pytest

from able_mcp.als import analysis, parser
from tests.fixtures import EMPTY_SET, FOUR_TRACK_SET, write_als


@pytest.fixture()
def four(tmp_path: Path):
    return parser.parse(write_als(FOUR_TRACK_SET, tmp_path / "four.als"))


@pytest.fixture()
def empty(tmp_path: Path):
    return parser.parse(write_als(EMPTY_SET, tmp_path / "e.als"))


def test_summary_counts(four) -> None:
    s = analysis.summarize(four)
    assert s.tempo == 124.0
    assert s.track_count == 4
    assert s.midi_track_count == 2
    assert s.audio_track_count == 2
    assert s.clip_count == 3  # bass, lead, drums; vox has none
    assert s.midi_note_count == 3
    assert s.scene_count == 2
    assert s.has_master_processing is True


def test_empty_set_warns(empty) -> None:
    sug = analysis.find_unfinished(empty)
    codes = {s.code for s in sug}
    assert "empty_set" in codes


def test_unfinished_findings(four) -> None:
    sug = analysis.find_unfinished(four)
    codes = {s.code for s in sug}
    # Lead has clips but no notes:
    assert "midi_track_no_notes" in codes
    # Vox audio track is empty:
    assert "audio_track_empty" in codes
    # Drums is muted:
    assert "track_muted" in codes
    # Master has a Limiter, so no_master_processing should NOT appear:
    assert "no_master_processing" not in codes
    # Lead has no devices:
    assert "midi_track_no_instrument" in codes
