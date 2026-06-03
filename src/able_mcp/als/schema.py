"""Typed dataclasses describing the subset of an Ableton ``.als`` set we model.

These types are intentionally thin: they record only the attributes our tools
and heuristics actually consume. They are not a faithful representation of the
full Live schema, which is large, undocumented, and version-dependent.

All time values are in beats unless noted otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

TrackKind = Literal["midi", "audio", "return", "group", "master", "unknown"]


@dataclass(slots=True, frozen=True)
class MidiNote:
    pitch: int            # 0..127
    start: float          # beats
    duration: float       # beats
    velocity: float       # 0..127 (Live stores as float)
    off_velocity: float = 64.0


@dataclass(slots=True)
class Clip:
    name: str
    is_midi: bool
    start: float          # beats; meaning differs for arrangement vs session clips
    length: float         # beats
    looping: bool = False
    color_index: int | None = None
    notes: list[MidiNote] = field(default_factory=list)
    sample_path: str | None = None  # absolute or hint path for audio clips
    # `slot_index` is only meaningful for session clips; None means arrangement.
    slot_index: int | None = None


@dataclass(slots=True)
class DeviceParameter:
    name: str
    value: float | None = None
    min: float | None = None
    max: float | None = None


@dataclass(slots=True)
class Device:
    name: str
    kind: str             # e.g. "Operator", "Wavetable", "PluginDevice", "AudioEffectGroupDevice"
    is_plugin: bool = False
    parameters: list[DeviceParameter] = field(default_factory=list)


@dataclass(slots=True)
class Track:
    index: int
    kind: TrackKind
    name: str
    color_index: int | None = None
    muted: bool = False
    soloed: bool = False
    devices: list[Device] = field(default_factory=list)
    clips: list[Clip] = field(default_factory=list)


@dataclass(slots=True)
class Scene:
    index: int
    name: str
    tempo: float | None = None      # -1 in Live means "no tempo override"
    time_signature: str | None = None


@dataclass(slots=True)
class LiveSet:
    path: str
    schema_version: str | None
    creator: str | None
    tempo: float
    time_signature_numerator: int
    time_signature_denominator: int
    tracks: list[Track] = field(default_factory=list)
    scenes: list[Scene] = field(default_factory=list)
    master_track: Track | None = None

    # Convenience views ---------------------------------------------------

    @property
    def midi_tracks(self) -> list[Track]:
        return [t for t in self.tracks if t.kind == "midi"]

    @property
    def audio_tracks(self) -> list[Track]:
        return [t for t in self.tracks if t.kind == "audio"]

    @property
    def total_clips(self) -> int:
        return sum(len(t.clips) for t in self.tracks)
