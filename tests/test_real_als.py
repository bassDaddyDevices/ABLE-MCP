"""Regression tests against a real Live 12.4 .als fixture.

This locks the parser against a known-good schema. If Live changes element
names again, these tests will fail loudly and we'll know we need to update
the parser rather than discovering it via silently-empty results.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from able_mcp.als import analysis, parser

REAL_FIXTURE = Path(__file__).parent / "fixtures" / "real" / "simple_live12.als"


@pytest.fixture(scope="module")
def real_set():
    if not REAL_FIXTURE.exists():
        pytest.skip("real fixture not present")
    return parser.parse(REAL_FIXTURE)


def test_real_set_basic_metadata(real_set) -> None:
    assert real_set.creator and "Ableton Live 12" in real_set.creator
    assert real_set.tempo == 145.0


def test_real_set_track_kinds(real_set) -> None:
    kinds = [t.kind for t in real_set.tracks]
    # 1 audio, 1 midi, 5 returns
    assert kinds.count("audio") >= 1
    assert kinds.count("midi") >= 1
    assert kinds.count("return") >= 1


def test_real_set_has_main_track(real_set) -> None:
    # Live 12 renamed MasterTrack to MainTrack — both should resolve.
    assert real_set.master_track is not None
    assert real_set.master_track.kind == "master"


def test_real_set_summarizes(real_set) -> None:
    s = analysis.summarize(real_set)
    assert s.track_count == len(real_set.tracks)
    assert s.tempo == 145.0
