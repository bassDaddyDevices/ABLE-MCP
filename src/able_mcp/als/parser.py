"""Parser for Ableton Live ``.als`` files.

An ``.als`` file is gzip-compressed XML. The exact element layout has shifted
between Live versions and is not officially documented; this parser therefore:

* Uses a small set of XPath-ish lookups against ``ElementTree``.
* Treats most fields as best-effort (``None`` if not present).
* Reads attributes from a ``<Foo Value="..."/>`` pattern that is pervasive in
  Live's XML, with a fallback to text content.

Public surface:

* :func:`parse` — parse a path or file-like and return :class:`LiveSet`.
* :func:`open_als` — yield the decompressed XML bytes (useful for tests).

The parser is deliberately tolerant: unknown track types collapse to
``"unknown"`` rather than raising. Treat the result as a *summary*, not a
faithful round-trip representation.
"""

from __future__ import annotations

import gzip
from pathlib import Path
from typing import IO
from xml.etree import ElementTree as ET

from .schema import (
    Clip,
    Device,
    DeviceParameter,
    LiveSet,
    MidiNote,
    Scene,
    Track,
    TrackKind,
)

# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------


def open_als(path: str | Path) -> bytes:
    """Return the decompressed XML bytes of an ``.als`` file.

    Raises :class:`OSError` if the file is missing, :class:`gzip.BadGzipFile`
    if it is not a valid gzip stream.
    """
    with gzip.open(Path(path), "rb") as f:
        return f.read()


def _val(elem: ET.Element | None, default: str | None = None) -> str | None:
    """Read the ``Value`` attribute (Live's convention) or fallback to text."""
    if elem is None:
        return default
    v = elem.get("Value")
    if v is not None:
        return v
    if elem.text is not None and elem.text.strip():
        return elem.text.strip()
    return default


def _val_float(elem: ET.Element | None, default: float | None = None) -> float | None:
    v = _val(elem)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _val_int(elem: ET.Element | None, default: int | None = None) -> int | None:
    v = _val(elem)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        try:
            return int(float(v))
        except ValueError:
            return default


def _val_bool(elem: ET.Element | None, default: bool = False) -> bool:
    v = _val(elem)
    if v is None:
        return default
    return v.strip().lower() == "true"


def _find_first(elem: ET.Element, *tags: str) -> ET.Element | None:
    """Return the first descendant matching any of *tags* (depth-first)."""
    for tag in tags:
        found = elem.find(f".//{tag}")
        if found is not None:
            return found
    return None


# ---------------------------------------------------------------------------
# Element extractors
# ---------------------------------------------------------------------------


_TRACK_TAG_KIND: dict[str, TrackKind] = {
    "MidiTrack": "midi",
    "AudioTrack": "audio",
    "ReturnTrack": "return",
    "GroupTrack": "group",
    "MasterTrack": "master",  # legacy (Live 11 and earlier)
    "MainTrack": "master",    # Live 12+ renamed Master to Main
}


def _extract_midi_notes(track_elem: ET.Element) -> list[tuple[Clip, list[MidiNote]]]:
    """Return ``[(clip, notes)]`` for every MIDI clip under a track element.

    Live nests MIDI clips inside ``ClipSlot`` (session) or ``Events`` (arrangement)
    differently across versions. We scan for any element whose tag contains
    ``MidiClip`` and pull notes out of its ``KeyTracks``/``MidiNoteEvent``.
    """
    out: list[tuple[Clip, list[MidiNote]]] = []
    for clip_elem in track_elem.iter():
        if "MidiClip" not in clip_elem.tag:
            continue
        clip = _build_midi_clip(clip_elem)
        notes: list[MidiNote] = []
        # Two common shapes:
        #   <KeyTracks><KeyTrack><MidiKey Value="60"/><Notes><MidiNoteEvent .../></Notes></KeyTrack></KeyTracks>
        #   <Notes><MidiNoteEvent Pitch="60" .../></Notes>
        for kt in clip_elem.iter():
            if kt.tag != "KeyTrack":
                continue
            pitch_elem = kt.find("MidiKey")
            pitch = _val_int(pitch_elem)
            for ev in kt.iter("MidiNoteEvent"):
                start = _attr_float(ev, "Time", 0.0)
                dur = _attr_float(ev, "Duration", 0.0)
                vel = _attr_float(ev, "Velocity", 100.0)
                off = _attr_float(ev, "OffVelocity", 64.0)
                p = pitch if pitch is not None else _attr_int(ev, "Pitch", 60) or 60
                notes.append(
                    MidiNote(
                        pitch=p,
                        start=start or 0.0,
                        duration=dur or 0.0,
                        velocity=vel or 0.0,
                        off_velocity=off or 64.0,
                    )
                )
        # Fallback: notes directly under <Notes> with explicit Pitch attribute.
        if not notes:
            for ev in clip_elem.iter("MidiNoteEvent"):
                p = _attr_int(ev, "Pitch")
                if p is None:
                    continue
                notes.append(
                    MidiNote(
                        pitch=p,
                        start=_attr_float(ev, "Time", 0.0) or 0.0,
                        duration=_attr_float(ev, "Duration", 0.0) or 0.0,
                        velocity=_attr_float(ev, "Velocity", 100.0) or 0.0,
                        off_velocity=_attr_float(ev, "OffVelocity", 64.0) or 64.0,
                    )
                )
        clip.notes = notes
        out.append((clip, notes))
    return out


def _attr_float(elem: ET.Element, name: str, default: float | None = None) -> float | None:
    v = elem.get(name)
    if v is None:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _attr_int(elem: ET.Element, name: str, default: int | None = None) -> int | None:
    v = elem.get(name)
    if v is None:
        return default
    try:
        return int(v)
    except ValueError:
        try:
            return int(float(v))
        except ValueError:
            return default


def _build_midi_clip(clip_elem: ET.Element) -> Clip:
    name = _val(clip_elem.find("Name"), "") or ""
    start = _val_float(clip_elem.find("CurrentStart"), 0.0) or 0.0
    end = _val_float(clip_elem.find("CurrentEnd"), start) or start
    looping = _val_bool(clip_elem.find("Loop/LoopOn"))
    color = _val_int(clip_elem.find("ColorIndex"))
    return Clip(
        name=name,
        is_midi=True,
        start=start,
        length=max(0.0, end - start),
        looping=looping,
        color_index=color,
    )


def _build_audio_clip(clip_elem: ET.Element) -> Clip:
    name = _val(clip_elem.find("Name"), "") or ""
    start = _val_float(clip_elem.find("CurrentStart"), 0.0) or 0.0
    end = _val_float(clip_elem.find("CurrentEnd"), start) or start
    looping = _val_bool(clip_elem.find("Loop/LoopOn"))
    color = _val_int(clip_elem.find("ColorIndex"))
    sample_path = None
    file_ref = clip_elem.find(".//SampleRef/FileRef")
    if file_ref is not None:
        sample_path = (
            _val(file_ref.find("Path"))
            or _val(file_ref.find("RelativePath"))
            or _val(file_ref.find("Name"))
        )
    return Clip(
        name=name,
        is_midi=False,
        start=start,
        length=max(0.0, end - start),
        looping=looping,
        color_index=color,
        sample_path=sample_path,
    )


def _extract_audio_clips(track_elem: ET.Element) -> list[Clip]:
    clips: list[Clip] = []
    for clip_elem in track_elem.iter():
        if "AudioClip" not in clip_elem.tag:
            continue
        clips.append(_build_audio_clip(clip_elem))
    return clips


def _extract_devices(track_elem: ET.Element) -> list[Device]:
    """Pull user-loaded devices from a track's inner DeviceChain.

    Live nests devices as ``<Track>/<DeviceChain>/<DeviceChain>/<Devices>``.
    The outer ``DeviceChain`` carries routing/mixer/sequencer state; the inner
    one holds the user's device rack. We deliberately do not use a descendant
    search because ``FreezeSequencer`` and modulation routings also expose
    ``Devices`` children that would pollute the result.
    """
    devices: list[Device] = []
    outer = track_elem.find("DeviceChain")
    if outer is None:
        return devices
    inner = outer.find("DeviceChain")
    chain = inner.find("Devices") if inner is not None else None
    # Fallback for older/synthetic schemas that placed Devices directly under
    # the outer DeviceChain.
    if chain is None:
        chain = outer.find("Devices")
    if chain is None:
        return devices
    for dev_elem in list(chain):
        kind = dev_elem.tag
        name = (
            _val(dev_elem.find(".//UserName"))
            or _val(dev_elem.find(".//Name"))
            or kind
        )
        is_plugin = kind in {
            "PluginDevice",
            "AuPluginDevice",
            "Vst3PluginDevice",
            "VstPluginDevice",
        }
        params: list[DeviceParameter] = []
        for p in dev_elem.findall(".//DeviceParameters/*"):
            pname = _val(p.find("Name")) or p.tag
            pval = _val_float(p.find("Manual"))
            params.append(DeviceParameter(name=pname, value=pval))
        devices.append(Device(name=name, kind=kind, is_plugin=is_plugin, parameters=params))
    return devices


def _track_kind(elem: ET.Element) -> TrackKind:
    return _TRACK_TAG_KIND.get(elem.tag, "unknown")


def _build_track(elem: ET.Element, index: int) -> Track:
    kind = _track_kind(elem)
    name = _val(elem.find(".//Name/EffectiveName")) or _val(elem.find(".//Name/UserName")) or ""
    color = _val_int(elem.find("ColorIndex"))
    muted = _val_bool(elem.find(".//Mute"))
    soloed = _val_bool(elem.find(".//Solo"))
    devices = _extract_devices(elem)

    clips: list[Clip] = []
    if kind == "midi":
        clips = [c for c, _ in _extract_midi_notes(elem)]
    elif kind == "audio":
        clips = _extract_audio_clips(elem)

    return Track(
        index=index,
        kind=kind,
        name=name,
        color_index=color,
        muted=muted,
        soloed=soloed,
        devices=devices,
        clips=clips,
    )


def _build_scenes(live_set_elem: ET.Element) -> list[Scene]:
    scenes: list[Scene] = []
    for i, s in enumerate(live_set_elem.findall(".//Scenes/Scene")):
        name = _val(s.find("Name"), "") or ""
        tempo = _val_float(s.find("Tempo"))
        ts_num = _val_int(s.find("TimeSignatureId"))
        ts_str = str(ts_num) if ts_num is not None else None
        scenes.append(Scene(index=i, name=name, tempo=tempo, time_signature=ts_str))
    return scenes


# ---------------------------------------------------------------------------
# Top-level parse
# ---------------------------------------------------------------------------


def parse(source: str | Path | IO[bytes]) -> LiveSet:
    """Parse an ``.als`` file or already-opened gzip stream into a :class:`LiveSet`."""
    if isinstance(source, (str, Path)):
        path = str(source)
        data = open_als(source)
        root = ET.fromstring(data)
    else:
        path = getattr(source, "name", "<stream>")
        # Allow callers to hand us either gzipped or already-decompressed bytes.
        raw = source.read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        root = ET.fromstring(raw)

    schema_version = root.get("SchemaChangeCount") or root.get("MinorVersion")
    creator = root.get("Creator")

    live_set = root.find("LiveSet")
    if live_set is None:
        # Some test fixtures may use the LiveSet as the root directly.
        live_set = root if root.tag == "LiveSet" else root

    tempo = _val_float(live_set.find(".//Tempo/Manual")) or _val_float(
        live_set.find(".//MasterTrack//Tempo/Manual")
    ) or 120.0

    ts_num = _val_int(live_set.find(".//TimeSignatureNumerator")) or 4
    ts_den = _val_int(live_set.find(".//TimeSignatureDenominator")) or 4

    tracks: list[Track] = []
    # Iterate children in document order so track index reflects Live's order.
    for parent in live_set.iter():
        if parent.tag != "Tracks":
            continue
        for i, t in enumerate(list(parent)):
            if _track_kind(t) == "unknown" and t.tag not in _TRACK_TAG_KIND:
                continue
            tracks.append(_build_track(t, i))
        break

    master_elem = live_set.find("MainTrack") or live_set.find("MasterTrack")
    master_track = _build_track(master_elem, -1) if master_elem is not None else None

    return LiveSet(
        path=path,
        schema_version=schema_version,
        creator=creator,
        tempo=tempo,
        time_signature_numerator=ts_num,
        time_signature_denominator=ts_den,
        tracks=tracks,
        scenes=_build_scenes(live_set),
        master_track=master_track,
    )
