"""Heuristic analysis over a parsed :class:`LiveSet`.

These are *suggestions*, not authoritative judgements: they exist to give the
LLM concrete hooks for "what's unfinished about this set?" — e.g. tracks
without devices, MIDI tracks with no notes, sets without a master limiter,
sparse arrangements.

Everything here is pure-Python and stdlib-only.
"""

from __future__ import annotations

from dataclasses import dataclass

from .schema import LiveSet, Track

_LIMITER_HINTS = ("Limiter", "MaxForLive", "GlueCompressor", "Compressor2")
_MASTER_BUS_HINTS = ("Limiter", "GlueCompressor")


@dataclass(slots=True)
class Suggestion:
    severity: str        # "info" | "warn"
    code: str            # stable machine-readable id
    message: str
    track: str | None = None


@dataclass(slots=True)
class SetSummary:
    path: str
    tempo: float
    time_signature: str
    track_count: int
    midi_track_count: int
    audio_track_count: int
    clip_count: int
    midi_note_count: int
    scene_count: int
    has_master_processing: bool


def summarize(live_set: LiveSet) -> SetSummary:
    note_count = sum(len(c.notes) for t in live_set.tracks for c in t.clips)
    has_master = _has_master_processing(live_set)
    return SetSummary(
        path=live_set.path,
        tempo=live_set.tempo,
        time_signature=f"{live_set.time_signature_numerator}/{live_set.time_signature_denominator}",
        track_count=len(live_set.tracks),
        midi_track_count=len(live_set.midi_tracks),
        audio_track_count=len(live_set.audio_tracks),
        clip_count=live_set.total_clips,
        midi_note_count=note_count,
        scene_count=len(live_set.scenes),
        has_master_processing=has_master,
    )


def _has_master_processing(live_set: LiveSet) -> bool:
    if live_set.master_track is None:
        return False
    return any(
        any(h in d.kind or h in d.name for h in _MASTER_BUS_HINTS)
        for d in live_set.master_track.devices
    )


def find_unfinished(live_set: LiveSet) -> list[Suggestion]:
    """Return prioritized suggestions about what looks unfinished."""
    out: list[Suggestion] = []

    if not live_set.tracks:
        out.append(Suggestion("warn", "empty_set", "Set has no tracks."))
        return out

    if not _has_master_processing(live_set):
        out.append(
            Suggestion(
                "warn",
                "no_master_processing",
                "Master track has no limiter or bus compressor — final loudness will be uncontrolled.",
            )
        )

    for t in live_set.tracks:
        if t.kind in {"master", "return"}:
            continue
        out.extend(_suggest_for_track(t))

    if live_set.scenes and all((s.tempo is None or s.tempo < 0) for s in live_set.scenes):
        out.append(
            Suggestion(
                "info",
                "static_tempo",
                "No scene defines a tempo override; arrangement is fixed at one BPM.",
            )
        )

    return out


def _suggest_for_track(t: Track) -> list[Suggestion]:
    out: list[Suggestion] = []
    if t.kind == "midi" and not t.devices:
        out.append(
            Suggestion(
                "warn",
                "midi_track_no_instrument",
                "MIDI track has no instrument loaded.",
                track=t.name or f"track_{t.index}",
            )
        )
    if t.kind == "midi" and t.clips and all(not c.notes for c in t.clips):
        out.append(
            Suggestion(
                "warn",
                "midi_track_no_notes",
                "MIDI track has clips but no notes.",
                track=t.name or f"track_{t.index}",
            )
        )
    if t.kind == "audio" and not t.clips:
        out.append(
            Suggestion(
                "info",
                "audio_track_empty",
                "Audio track has no clips.",
                track=t.name or f"track_{t.index}",
            )
        )
    if t.muted:
        out.append(
            Suggestion(
                "info",
                "track_muted",
                "Track is muted — confirm this is intentional before bouncing.",
                track=t.name or f"track_{t.index}",
            )
        )
    return out
