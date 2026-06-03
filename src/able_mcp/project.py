"""Project-level helpers: timestamped backups, version listing.

Lightweight utilities — these never modify the source ``.als`` in place.
"""

from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path


def make_backup(als_path: Path, backup_dir: Path | None = None) -> Path:
    """Copy an .als to a timestamped backup file. Never overwrites the source."""
    if not als_path.is_file():
        raise FileNotFoundError(f"No file at {als_path}")
    if als_path.suffix.lower() != ".als":
        raise ValueError("Expected an .als file")
    target_dir = backup_dir or als_path.parent / "Backup"
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = target_dir / f"{als_path.stem}.{stamp}.als"
    shutil.copy2(als_path, target)
    return target


def list_versions(als_path: Path, backup_dir: Path | None = None) -> list[dict[str, object]]:
    """List timestamped backups for an .als file."""
    target_dir = backup_dir or als_path.parent / "Backup"
    if not target_dir.is_dir():
        return []
    stem = als_path.stem
    out: list[dict[str, object]] = []
    for p in sorted(target_dir.iterdir()):
        if p.suffix.lower() != ".als":
            continue
        if not p.name.startswith(stem + "."):
            continue
        st = p.stat()
        out.append(
            {
                "path": str(p),
                "name": p.name,
                "size_bytes": st.st_size,
                "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            }
        )
    return out
