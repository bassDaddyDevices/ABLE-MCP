"""Pure-Python MIDI analysis: key estimation, density, chord guess.

No third-party deps; works on whatever notes you can hand it (parsed from .als
or sent live).
"""

from .analysis import (
    KeyEstimate,
    NoteStats,
    estimate_key,
    estimate_meter_density,
    guess_chords,
    note_stats,
)

__all__ = [
    "KeyEstimate",
    "NoteStats",
    "estimate_key",
    "estimate_meter_density",
    "guess_chords",
    "note_stats",
]
