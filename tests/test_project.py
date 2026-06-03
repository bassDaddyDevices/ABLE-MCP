"""Tests for project backup helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from able_mcp import project


def _make_als(p: Path) -> Path:
    p.write_bytes(b"\x1f\x8b\x08\x00fake")  # not real gzip, just non-empty
    return p


def test_make_backup_creates_timestamped_copy(tmp_path: Path):
    src = _make_als(tmp_path / "MySong.als")
    bak = project.make_backup(src)
    assert bak.exists()
    assert bak.parent == tmp_path / "Backup"
    assert bak.name.startswith("MySong.")
    assert bak.suffix == ".als"
    assert bak.read_bytes() == src.read_bytes()


def test_make_backup_rejects_non_als(tmp_path: Path):
    bad = tmp_path / "thing.txt"
    bad.write_text("hi")
    with pytest.raises(ValueError):
        project.make_backup(bad)


def test_list_versions_returns_only_matching(tmp_path: Path):
    src = _make_als(tmp_path / "Song.als")
    other = _make_als(tmp_path / "Other.als")
    backup_dir = tmp_path / "Backup"
    backup_dir.mkdir()
    (backup_dir / "Song.20260101-000000.als").write_bytes(b"x")
    (backup_dir / "Other.20260101-000000.als").write_bytes(b"x")
    (backup_dir / "Song.notes.txt").write_text("ignore me")

    versions = project.list_versions(src)
    names = {v["name"] for v in versions}
    assert names == {"Song.20260101-000000.als"}
    # ensure the unrelated als is excluded
    assert all("Other" not in n for n in names)
    assert other.exists()


def test_list_versions_no_dir(tmp_path: Path):
    src = _make_als(tmp_path / "Solo.als")
    assert project.list_versions(src) == []
