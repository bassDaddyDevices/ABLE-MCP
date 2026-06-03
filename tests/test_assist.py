"""Tests for the assist module."""

from __future__ import annotations

from pathlib import Path

from able_mcp import assist
from able_mcp.als import parser

from .fixtures import FOUR_TRACK_SET, write_als


def test_assist_finishing_runs(tmp_path: Path):
    p = write_als(FOUR_TRACK_SET, tmp_path / "set.als")
    live_set = parser.parse(p)
    suggestions = assist.assist_finishing(live_set)
    # Synthetic fixture is intentionally rough; we just need the function to
    # produce a list of well-formed suggestions.
    assert isinstance(suggestions, list)
    for s in suggestions:
        assert s.severity in ("info", "warn", "blocker")
        assert isinstance(s.code, str) and s.code
        assert isinstance(s.message, str) and s.message


def test_harmonic_overview_no_midi(tmp_path: Path):
    p = write_als(FOUR_TRACK_SET, tmp_path / "set.als")
    live_set = parser.parse(p)
    res = assist.harmonic_overview(live_set)
    # Synthetic fixture has no real notes, so we expect either no notes or an
    # estimate with 0 confidence — either way the dict is well-formed.
    assert "key" in res
    assert "chords" in res
    assert "stats" in res
