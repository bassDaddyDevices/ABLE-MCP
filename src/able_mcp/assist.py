"""Creative-assist heuristics combining .als analysis with optional live state.

Each function here returns a list of ``Suggestion`` dicts that the MCP layer
can hand back to the agent. The wording is opinionated but conservative —
prefer flagging issues over silently ignoring them.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .als import analysis as als_analysis
from .als.schema import LiveSet
from .midi import analysis as midi_analysis


@dataclass(frozen=True)
class FinishingSuggestion:
    severity: str  # "info" | "warn" | "blocker"
    code: str
    message: str
    track: str | None = None


def assist_finishing(live_set: LiveSet) -> list[FinishingSuggestion]:
    """Combine the .als unfinished checks with MIDI-content sanity checks."""
    out: list[FinishingSuggestion] = []
    for s in als_analysis.find_unfinished(live_set):
        out.append(
            FinishingSuggestion(
                severity=s.severity, code=s.code, message=s.message, track=s.track
            )
        )

    # Per-track MIDI sanity: empty MIDI tracks, single-note clips, weirdly
    # short clips. Things that very often signal "I forgot to finish this".
    for track in live_set.tracks:
        if track.kind != "midi":
            continue
        if not track.clips:
            continue
        for clip in track.clips:
            if not clip.is_midi:
                continue
            if len(clip.notes) == 0:
                out.append(
                    FinishingSuggestion(
                        severity="warn",
                        code="midi.empty_clip",
                        message=f"MIDI clip '{clip.name or 'unnamed'}' has no notes.",
                        track=track.name,
                    )
                )
                continue
            if len(clip.notes) == 1:
                out.append(
                    FinishingSuggestion(
                        severity="info",
                        code="midi.single_note",
                        message=f"Clip '{clip.name or 'unnamed'}' has a single note — placeholder?",
                        track=track.name,
                    )
                )
            if (clip.length or 0) > 0 and (clip.length or 0) < 1.0:
                out.append(
                    FinishingSuggestion(
                        severity="info",
                        code="clip.very_short",
                        message=f"Clip '{clip.name or 'unnamed'}' is shorter than one beat.",
                        track=track.name,
                    )
                )
    return out


def harmonic_overview(live_set: LiveSet) -> dict[str, Any]:
    """Aggregate all MIDI notes in the set and run key/chord analysis."""
    notes: list[Any] = []
    for track in live_set.tracks:
        if track.kind != "midi":
            continue
        for clip in track.clips:
            notes.extend(clip.notes)
    if not notes:
        return {"key": None, "chords": [], "stats": asdict(midi_analysis.note_stats([]))}
    key = midi_analysis.estimate_key(notes)
    return {
        "key": asdict(key) if key else None,
        "chords": midi_analysis.guess_chords(notes, window_beats=1.0)[:64],
        "stats": asdict(midi_analysis.note_stats(notes)),
    }
