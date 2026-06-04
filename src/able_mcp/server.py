"""ABLE-MCP server entry point.

Exposes:

* Phase 1 tools — offline ``.als`` parsing and analysis.
* Phase 3 tools — live LOM access via the M4L bridge (require Live to be
  running with the AbleMCP bridge device loaded; configure host/port via the
  ``ABLE_MCP_BRIDGE_*`` environment variables).

Run with::

    uv run able-mcp
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import assist as assist_mod
from . import project as project_mod
from .als import analysis, parser
from .lom import BridgeClient, BridgeError, BridgeUnavailable
from .midi import analysis as midi_analysis
from .midi import complement as midi_complement

log = logging.getLogger("able_mcp")

mcp = FastMCP(
    name="able-mcp",
    instructions=(
        "Two tool families:\n"
        "  - als_*: offline analysis of Ableton .als project files. Pass an "
        "absolute path. No Live process required.\n"
        "  - live_*: live LOM access via the AbleMCP M4L bridge. Requires Live "
        "12 running with the bridge device loaded on a track. If a live_* tool "
        "errors with 'bridge not reachable', call live_check_bridge for setup "
        "guidance."
    ),
)


def _resolve(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_file():
        raise FileNotFoundError(f"No file at {p}")
    if p.suffix.lower() != ".als":
        raise ValueError(f"Expected an .als file, got {p.suffix!r}")
    return p


@mcp.tool(description="Summarize an Ableton .als file: tempo, time signature, track and clip counts.")
def als_summary(path: str) -> dict[str, Any]:
    p = _resolve(path)
    live_set = parser.parse(p)
    return asdict(analysis.summarize(live_set))


@mcp.tool(description="List all tracks in an .als file with their kind, name, mute/solo state, and device count.")
def als_list_tracks(path: str) -> list[dict[str, Any]]:
    p = _resolve(path)
    live_set = parser.parse(p)
    return [
        {
            "index": t.index,
            "kind": t.kind,
            "name": t.name,
            "muted": t.muted,
            "soloed": t.soloed,
            "device_count": len(t.devices),
            "clip_count": len(t.clips),
        }
        for t in live_set.tracks
    ]


@mcp.tool(description="List clips on one track (by index) or every track (omit track_index).")
def als_list_clips(path: str, track_index: int | None = None) -> list[dict[str, Any]]:
    p = _resolve(path)
    live_set = parser.parse(p)
    out: list[dict[str, Any]] = []
    tracks = (
        [live_set.tracks[track_index]]
        if track_index is not None and 0 <= track_index < len(live_set.tracks)
        else live_set.tracks
    )
    for t in tracks:
        for c in t.clips:
            out.append(
                {
                    "track_index": t.index,
                    "track_name": t.name,
                    "clip_name": c.name,
                    "is_midi": c.is_midi,
                    "start_beats": c.start,
                    "length_beats": c.length,
                    "looping": c.looping,
                    "note_count": len(c.notes),
                    "sample_path": c.sample_path,
                }
            )
    return out


@mcp.tool(
    description=(
        "Extract MIDI notes from one clip (by track index and clip index) "
        "as pitch/start/duration/velocity tuples."
    )
)
def als_extract_midi(path: str, track_index: int, clip_index: int) -> dict[str, Any]:
    p = _resolve(path)
    live_set = parser.parse(p)
    if not (0 <= track_index < len(live_set.tracks)):
        raise IndexError(f"track_index {track_index} out of range")
    track = live_set.tracks[track_index]
    if not (0 <= clip_index < len(track.clips)):
        raise IndexError(f"clip_index {clip_index} out of range on track {track_index}")
    clip = track.clips[clip_index]
    return {
        "track_index": track_index,
        "clip_index": clip_index,
        "clip_name": clip.name,
        "length_beats": clip.length,
        "notes": [
            {
                "pitch": n.pitch,
                "start": n.start,
                "duration": n.duration,
                "velocity": n.velocity,
            }
            for n in clip.notes
        ],
    }


@mcp.tool(
    description=(
        "Heuristic suggestions about what looks unfinished in a set: missing "
        "instruments, empty MIDI clips, no master limiter, etc."
    )
)
def als_find_unfinished(path: str) -> list[dict[str, Any]]:
    p = _resolve(path)
    live_set = parser.parse(p)
    return [asdict(s) for s in analysis.find_unfinished(live_set)]


# ---------------------------------------------------------------------------
# Live LOM tools (require the M4L bridge to be loaded inside Live 12)
# ---------------------------------------------------------------------------


_BRIDGE_HELP = (
    "The bridge wasn't reachable. ABLE-MCP supports two bridge generations:\n"
    "\n"
    "  Recommended (Live 12 with Extensions):\n"
    "    1. Build the extension: cd extension && npm install && npm run build:prod\n"
    "    2. Package: npm run package (writes dist/AbleMCP.ablx)\n"
    "    3. Install AbleMCP.ablx into Live's extensions directory and restart Live.\n"
    "    4. See extension/README.md for details.\n"
    "\n"
    "  Legacy (Max for Live, Live 11+):\n"
    "    Drop AbleMCP.amxd on a track. See m4l-bridge/README.md.\n"
    "\n"
    "Either way the bridge listens on ws://127.0.0.1:9831 by default. Override "
    "host/port via ABLE_MCP_BRIDGE_HOST / ABLE_MCP_BRIDGE_PORT.\n"
    "\n"
    "Note: transport-control tools (play/stop/continue/isPlaying) and "
    "song.undo/redo are not supported by the Extension API 1.0 beta — use the "
    "M4L bridge for those, or wait for a future API revision."
)


async def _bridge_call(method: str, params: dict[str, Any] | None = None) -> Any:
    client = BridgeClient.from_env()
    try:
        await client.connect()
    except BridgeUnavailable as e:
        raise BridgeUnavailable(f"{e}\n\n{_BRIDGE_HELP}") from e
    try:
        return await client.call(method, params)
    finally:
        await client.close()


@mcp.tool(
    description=(
        "Check whether the AbleMCP M4L bridge is running. Returns the bridge's "
        "ping payload on success, or guidance on how to install the device."
    )
)
async def live_check_bridge() -> dict[str, Any]:
    client = BridgeClient.from_env()
    try:
        await client.connect()
        pong = await client.ping()
        return {"reachable": True, "url": client.url, "pong": pong}
    except (BridgeUnavailable, BridgeError) as e:
        return {"reachable": False, "url": client.url, "error": str(e), "help": _BRIDGE_HELP}
    finally:
        await client.close()


@mcp.tool(description="Live transport state: tempo, time signature, playing flag, song position, track count.")
async def live_status() -> dict[str, Any]:
    return await _bridge_call("song.getState")


@mcp.tool(description="Current Live tempo in BPM.")
async def live_get_tempo() -> dict[str, Any]:
    return await _bridge_call("song.getTempo")


@mcp.tool(description="Whether Live's transport is currently playing.")
async def live_is_playing() -> dict[str, Any]:
    return await _bridge_call("transport.isPlaying")


@mcp.tool(description="List all tracks in the running Live set with kind, name, mute/solo/arm state.")
async def live_list_tracks() -> dict[str, Any]:
    return await _bridge_call("song.listTracks")


@mcp.tool(description="The currently selected track and scene in Live's view.")
async def live_get_selection() -> dict[str, Any]:
    return await _bridge_call("view.getSelection")


# ---------------------------------------------------------------------------
# Live write tools — every one defaults to confirm=True. Set confirm=False to
# skip the safety gate (useful when an outer agent has already confirmed).
# Live's undo stack covers all of these; pair with live_undo if needed.
# ---------------------------------------------------------------------------


_CONFIRM_HINT = (
    "This tool modifies the running Live set. Re-call with confirm=True to apply "
    "(default). Pass confirm=False only if you've already confirmed with the user."
)


def _require_confirm(confirm: bool, action: str) -> dict[str, Any] | None:
    if confirm:
        return None
    return {"applied": False, "action": action, "reason": _CONFIRM_HINT}


@mcp.tool(description="Set Live's tempo (BPM, 20..999). Defaults to confirm=True.")
async def live_set_tempo(bpm: float, confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "song.setTempo")
    if blocked is not None:
        return blocked
    result = await _bridge_call("song.setTempo", {"bpm": bpm})
    return {"applied": True, "action": "song.setTempo", "result": result}


@mcp.tool(description="Start Live's transport. Defaults to confirm=True.")
async def live_play(confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "transport.play")
    if blocked is not None:
        return blocked
    result = await _bridge_call("transport.play")
    return {"applied": True, "action": "transport.play", "result": result}


@mcp.tool(description="Stop Live's transport. Defaults to confirm=True.")
async def live_stop(confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "transport.stop")
    if blocked is not None:
        return blocked
    result = await _bridge_call("transport.stop")
    return {"applied": True, "action": "transport.stop", "result": result}


@mcp.tool(description="Continue playback from the current position.")
async def live_continue(confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "transport.continue")
    if blocked is not None:
        return blocked
    result = await _bridge_call("transport.continue")
    return {"applied": True, "action": "transport.continue", "result": result}


@mcp.tool(description="Trigger Live's undo. Reverts the last LOM-visible change.")
async def live_undo(confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "song.undo")
    if blocked is not None:
        return blocked
    result = await _bridge_call("song.undo")
    return {"applied": True, "action": "song.undo", "result": result}


@mcp.tool(description="Trigger Live's redo.")
async def live_redo(confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "song.redo")
    if blocked is not None:
        return blocked
    result = await _bridge_call("song.redo")
    return {"applied": True, "action": "song.redo", "result": result}


@mcp.tool(
    description=(
        "Create a new track. kind ∈ {'midi','audio','return'}; index defaults "
        "to the end. Returns the new track info."
    )
)
async def live_create_track(
    kind: str = "midi",
    index: int | None = None,
    confirm: bool = True,
) -> dict[str, Any]:
    if kind not in ("midi", "audio", "return"):
        raise ValueError("kind must be 'midi', 'audio', or 'return'")
    blocked = _require_confirm(confirm, "track.create")
    if blocked is not None:
        return blocked
    params: dict[str, Any] = {"kind": kind}
    if index is not None:
        params["index"] = index
    result = await _bridge_call("track.create", params)
    return {"applied": True, "action": "track.create", "result": result}


@mcp.tool(description="Delete a track by index. Use live_undo to recover.")
async def live_delete_track(index: int, confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "track.delete")
    if blocked is not None:
        return blocked
    result = await _bridge_call("track.delete", {"index": index})
    return {"applied": True, "action": "track.delete", "result": result}


@mcp.tool(description="Rename a track by index.")
async def live_rename_track(index: int, name: str, confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "track.rename")
    if blocked is not None:
        return blocked
    result = await _bridge_call("track.rename", {"index": index, "name": name})
    return {"applied": True, "action": "track.rename", "result": result}


@mcp.tool(
    description=(
        "Create an empty MIDI clip in the given session slot. length_beats "
        "defaults to 4."
    )
)
async def live_create_clip(
    track_index: int,
    scene_index: int,
    length_beats: float = 4.0,
    name: str | None = None,
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "clip.createMidi")
    if blocked is not None:
        return blocked
    params: dict[str, Any] = {
        "track_index": track_index,
        "scene_index": scene_index,
        "length_beats": length_beats,
    }
    if name is not None:
        params["name"] = name
    result = await _bridge_call("clip.createMidi", params)
    return {"applied": True, "action": "clip.createMidi", "result": result}


@mcp.tool(
    description=(
        "Replace the notes in a MIDI clip. notes is a list of dicts with "
        "{pitch, start, duration, velocity, mute?}. Existing notes are removed first."
    )
)
async def live_set_clip_notes(
    track_index: int,
    scene_index: int,
    notes: list[dict[str, Any]],
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "clip.setNotes")
    if blocked is not None:
        return blocked
    result = await _bridge_call(
        "clip.setNotes",
        {"track_index": track_index, "scene_index": scene_index, "notes": notes},
    )
    return {"applied": True, "action": "clip.setNotes", "result": result}


@mcp.tool(description="Delete a clip from a session slot.")
async def live_delete_clip(
    track_index: int,
    scene_index: int,
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "clip.delete")
    if blocked is not None:
        return blocked
    result = await _bridge_call(
        "clip.delete", {"track_index": track_index, "scene_index": scene_index}
    )
    return {"applied": True, "action": "clip.delete", "result": result}


# ---------------------------------------------------------------------------
# Extension-only capabilities (require the .ablx extension bridge — these
# methods do not exist in the legacy M4L bridge).
# ---------------------------------------------------------------------------


@mcp.tool(
    description=(
        "Import an audio file into the Live project and create an audio clip. "
        "If scene_index is given, places the clip in that session slot; "
        "otherwise places it on the arrangement at start_time. Requires the "
        ".ablx extension bridge."
    )
)
async def live_import_audio(
    file_path: str,
    track_index: int,
    scene_index: int | None = None,
    start_time: float = 0.0,
    duration: float | None = None,
    is_warped: bool | None = None,
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "audio.import")
    if blocked is not None:
        return blocked
    params: dict[str, Any] = {
        "file_path": file_path,
        "track_index": track_index,
        "start_time": start_time,
    }
    if scene_index is not None:
        params["scene_index"] = scene_index
    if duration is not None:
        params["duration"] = duration
    if is_warped is not None:
        params["is_warped"] = is_warped
    result = await _bridge_call("audio.import", params)
    return {"applied": True, "action": "audio.import", "result": result}


@mcp.tool(
    description=(
        "Render the pre-effects audio of an arrangement track to a WAV file in "
        "the extension's temp directory. Returns the WAV path."
    )
)
async def live_render_track(
    track_index: int,
    start_time: float,
    end_time: float,
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "audio.renderTrack")
    if blocked is not None:
        return blocked
    result = await _bridge_call(
        "audio.renderTrack",
        {"track_index": track_index, "start_time": start_time, "end_time": end_time},
    )
    return {"applied": True, "action": "audio.renderTrack", "result": result}


@mcp.tool(description="Create an empty MIDI clip in the arrangement timeline of a MIDI track.")
async def live_arrangement_create_midi_clip(
    track_index: int,
    start_time: float,
    duration: float,
    name: str | None = None,
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "arrangement.createMidiClip")
    if blocked is not None:
        return blocked
    params: dict[str, Any] = {
        "track_index": track_index,
        "start_time": start_time,
        "duration": duration,
    }
    if name is not None:
        params["name"] = name
    result = await _bridge_call("arrangement.createMidiClip", params)
    return {"applied": True, "action": "arrangement.createMidiClip", "result": result}


@mcp.tool(
    description=(
        "Replace notes in an arrangement MIDI clip. notes is a list of dicts "
        "with {pitch, start, duration, velocity, mute?}."
    )
)
async def live_arrangement_set_clip_notes(
    track_index: int,
    arrangement_index: int,
    notes: list[dict[str, Any]],
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "arrangement.setClipNotes")
    if blocked is not None:
        return blocked
    result = await _bridge_call(
        "arrangement.setClipNotes",
        {
            "track_index": track_index,
            "arrangement_index": arrangement_index,
            "notes": notes,
        },
    )
    return {"applied": True, "action": "arrangement.setClipNotes", "result": result}


@mcp.tool(description="Create a new scene. index defaults to -1 (append).")
async def live_create_scene(index: int = -1, confirm: bool = True) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "scene.create")
    if blocked is not None:
        return blocked
    result = await _bridge_call("scene.create", {"index": index})
    return {"applied": True, "action": "scene.create", "result": result}


@mcp.tool(description="Bridge environment info: storage/temp dirs and Live's UI language.")
async def live_env_info() -> dict[str, Any]:
    return await _bridge_call("env.info")


# ---------------------------------------------------------------------------
# MIDI analysis (offline, but works on any notes you supply)
# ---------------------------------------------------------------------------


@mcp.tool(
    description=(
        "Estimate the key of a MIDI clip in an .als file using the "
        "Krumhansl-Schmuckler algorithm. Returns tonic, mode, and confidence."
    )
)
def midi_estimate_key(path: str, track_index: int, clip_index: int) -> dict[str, Any]:
    p = _resolve(path)
    live_set = parser.parse(p)
    if not (0 <= track_index < len(live_set.tracks)):
        raise IndexError(f"track_index {track_index} out of range")
    track = live_set.tracks[track_index]
    if not (0 <= clip_index < len(track.clips)):
        raise IndexError(f"clip_index {clip_index} out of range on track {track_index}")
    clip = track.clips[clip_index]
    key = midi_analysis.estimate_key(clip.notes)
    return {
        "track_index": track_index,
        "clip_index": clip_index,
        "key": asdict(key) if key else None,
    }


@mcp.tool(description="Per-clip note stats: count, range, density, pitch-class histogram.")
def midi_note_stats(path: str, track_index: int, clip_index: int) -> dict[str, Any]:
    p = _resolve(path)
    live_set = parser.parse(p)
    clip = live_set.tracks[track_index].clips[clip_index]
    return asdict(midi_analysis.note_stats(clip.notes))


@mcp.tool(
    description=(
        "Guess chords across a MIDI clip with a sliding window. window_beats "
        "defaults to 1. Returns time-aligned [{start,end,chord}] segments."
    )
)
def midi_guess_chords(
    path: str,
    track_index: int,
    clip_index: int,
    window_beats: float = 1.0,
) -> list[dict[str, Any]]:
    p = _resolve(path)
    live_set = parser.parse(p)
    clip = live_set.tracks[track_index].clips[clip_index]
    return midi_analysis.guess_chords(clip.notes, window_beats=window_beats)


@mcp.tool(
    description=(
        "Extract a monophonic guide melody from a vocal WAV file with a "
        "dependency-free pitch tracker. Returns notes in both seconds and "
        "beats (requires tempo_bpm)."
    )
)
def midi_extract_vocal_guide(
    file_path: str,
    tempo_bpm: float,
    min_note: int = 45,
    max_note: int = 88,
    frame_ms: float = 40.0,
    hop_ms: float = 10.0,
    min_note_sec: float = 0.08,
) -> dict[str, Any]:
    notes, summary = midi_complement.extract_guide_melody_from_wav(
        file_path=file_path,
        min_note=min_note,
        max_note=max_note,
        frame_ms=frame_ms,
        hop_ms=hop_ms,
        min_note_sec=min_note_sec,
    )
    notes_beats = midi_complement.seconds_notes_to_beats(notes, tempo_bpm=tempo_bpm)
    notes_sec = [
        {
            "pitch": n.pitch,
            "start_sec": n.start_sec,
            "duration_sec": n.duration_sec,
            "velocity": n.velocity,
        }
        for n in notes
    ]
    return {
        "file_path": str(Path(file_path).expanduser()),
        "tempo_bpm": tempo_bpm,
        "summary": asdict(summary),
        "notes_seconds": notes_sec,
        "notes_beats": notes_beats,
    }


@mcp.tool(
    description=(
        "Generate a complementary MIDI melody (not a duplicate) from guide "
        "notes in beat-space. Input note dicts: {pitch,start,duration,velocity?}."
    )
)
def midi_generate_complement(
    guide_notes: list[dict[str, Any]],
    similarity: float = 0.55,
    density: float = 0.75,
    register: str = "mid",
    call_response: bool = True,
    seed: int | None = None,
) -> dict[str, Any]:
    generated = midi_complement.generate_complementary_melody(
        guide_notes=guide_notes,
        similarity=similarity,
        density=density,
        register=register,
        call_response=call_response,
        seed=seed,
    )
    return {
        "guide_count": len(guide_notes),
        "generated_count": len(generated),
        "notes": generated,
        "settings": {
            "similarity": max(0.0, min(1.0, similarity)),
            "density": max(0.0, min(1.0, density)),
            "register": register,
            "call_response": call_response,
            "seed": seed,
        },
    }


@mcp.tool(
    description=(
        "Convenience one-shot: extract vocal guide from WAV and immediately "
        "generate a complementary MIDI melody in beat-space."
    )
)
def midi_vocal_to_complement(
    file_path: str,
    tempo_bpm: float,
    similarity: float = 0.55,
    density: float = 0.75,
    register: str = "mid",
    call_response: bool = True,
    seed: int | None = None,
) -> dict[str, Any]:
    extracted = midi_extract_vocal_guide(file_path=file_path, tempo_bpm=tempo_bpm)
    generated = midi_generate_complement(
        guide_notes=extracted["notes_beats"],
        similarity=similarity,
        density=density,
        register=register,
        call_response=call_response,
        seed=seed,
    )
    return {
        "extraction": {
            "summary": extracted["summary"],
            "notes_beats": extracted["notes_beats"],
        },
        "complement": generated,
    }


@mcp.tool(
    description=(
        "End-to-end live flow: render audio from an arrangement audio track "
        "range, extract vocal guide, generate complementary melody, create a "
        "new arrangement MIDI clip, and write notes into it."
    )
)
async def live_vocal_to_complement_midi(
    source_audio_track_index: int,
    start_time: float,
    end_time: float,
    target_midi_track_index: int,
    similarity: float = 0.55,
    density: float = 0.75,
    register: str = "mid",
    call_response: bool = True,
    seed: int | None = None,
    clip_name: str = "Vocal Complement",
    confirm: bool = True,
) -> dict[str, Any]:
    blocked = _require_confirm(confirm, "live_vocal_to_complement_midi")
    if blocked is not None:
        return blocked
    if end_time <= start_time:
        raise ValueError("end_time must be greater than start_time")

    # 1) Render source audio region to WAV via extension bridge.
    rendered = await _bridge_call(
        "audio.renderTrack",
        {
            "track_index": source_audio_track_index,
            "start_time": start_time,
            "end_time": end_time,
        },
    )
    wav_path = rendered.get("wav_path")
    if not isinstance(wav_path, str) or not wav_path:
        raise RuntimeError("audio.renderTrack did not return wav_path")

    # 2) Get tempo from Live and extract guide + complement notes.
    tempo_res = await _bridge_call("song.getTempo")
    tempo = float(tempo_res.get("tempo", 120.0))
    pipeline = midi_vocal_to_complement(
        file_path=wav_path,
        tempo_bpm=tempo,
        similarity=similarity,
        density=density,
        register=register,
        call_response=call_response,
        seed=seed,
    )
    notes = pipeline["complement"]["notes"]

    # 3) Create destination arrangement clip and write notes.
    duration = end_time - start_time
    created = await _bridge_call(
        "arrangement.createMidiClip",
        {
            "track_index": target_midi_track_index,
            "start_time": start_time,
            "duration": duration,
            "name": clip_name,
        },
    )
    arrangement_index = created.get("arrangement_index")
    if not isinstance(arrangement_index, int) or arrangement_index < 0:
        raise RuntimeError("arrangement.createMidiClip did not return arrangement_index")

    await _bridge_call(
        "arrangement.setClipNotes",
        {
            "track_index": target_midi_track_index,
            "arrangement_index": arrangement_index,
            "notes": notes,
        },
    )

    return {
        "applied": True,
        "action": "live_vocal_to_complement_midi",
        "source": {
            "track_index": source_audio_track_index,
            "start_time": start_time,
            "end_time": end_time,
            "wav_path": wav_path,
            "tempo": tempo,
        },
        "target": {
            "track_index": target_midi_track_index,
            "arrangement_index": arrangement_index,
            "clip_name": clip_name,
        },
        "extraction": pipeline["extraction"],
        "complement": {
            "generated_count": pipeline["complement"]["generated_count"],
            "settings": pipeline["complement"]["settings"],
        },
    }


# ---------------------------------------------------------------------------
# Assist + project management (Phase 6)
# ---------------------------------------------------------------------------


@mcp.tool(
    description=(
        "Aggregate finishing suggestions for a set: missing instruments, empty "
        "clips, no master limiter, single-note placeholders, very-short clips."
    )
)
def assist_finishing(path: str) -> list[dict[str, Any]]:
    p = _resolve(path)
    live_set = parser.parse(p)
    return [asdict(s) for s in assist_mod.assist_finishing(live_set)]


@mcp.tool(
    description=(
        "Run key estimation and chord guessing across every MIDI clip in the "
        "set. Useful for a 'where am I harmonically' overview."
    )
)
def assist_harmonic_overview(path: str) -> dict[str, Any]:
    p = _resolve(path)
    live_set = parser.parse(p)
    return assist_mod.harmonic_overview(live_set)


@mcp.tool(
    description=(
        "Make a timestamped copy of an .als file in <project>/Backup/. "
        "Never modifies the source. Returns the backup path."
    )
)
def project_backup(path: str, backup_dir: str | None = None) -> dict[str, Any]:
    p = _resolve(path)
    bd = Path(backup_dir).expanduser() if backup_dir else None
    target = project_mod.make_backup(p, bd)
    return {"source": str(p), "backup": str(target)}


@mcp.tool(description="List timestamped backups for an .als file.")
def project_list_versions(path: str, backup_dir: str | None = None) -> list[dict[str, Any]]:
    p = _resolve(path)
    bd = Path(backup_dir).expanduser() if backup_dir else None
    return project_mod.list_versions(p, bd)


def main() -> None:
    """Stdio entry point used by the ``able-mcp`` console script."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    mcp.run()  # defaults to stdio transport


if __name__ == "__main__":
    main()
