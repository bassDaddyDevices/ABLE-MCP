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
from .complement import (
    ExtractSummary,
    GuideNote,
    extract_guide_melody_from_wav,
    generate_complementary_melody,
    seconds_notes_to_beats,
)

__all__ = [
    "KeyEstimate",
    "NoteStats",
    "estimate_key",
    "estimate_meter_density",
    "guess_chords",
    "note_stats",
    "GuideNote",
    "ExtractSummary",
    "extract_guide_melody_from_wav",
    "seconds_notes_to_beats",
    "generate_complementary_melody",
]
