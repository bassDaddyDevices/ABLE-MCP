// SDK-backed JSON-RPC method implementations. Method names match the legacy
// m4l-bridge so the Python BridgeClient and MCP tools work unchanged.
//
// Capabilities the SDK 1.0 beta does NOT expose, marked below as "unsupported":
// - transport: play / stop / continue / isPlaying
// - song time: signature numerator/denominator, current song time
// - LOM view selection (only available via context-menu callbacks)
// We surface these as -32000 errors with a clear message so callers can
// degrade gracefully.

import {
    AudioTrack,
    MidiTrack,
    type ExtensionContext,
    type NoteDescription,
} from "@ableton-extensions/sdk";

import type { RpcMethodTable } from "./rpc";

type Ctx = ExtensionContext<"1.0.0">;

function unsupported(method: string): never {
    throw new Error(
        `${method} is not supported by Ableton Extension API 1.0 (no transport/view API yet).`,
    );
}

function asNumber(v: unknown, name: string): number {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got ${String(v)}`);
    return n;
}

function asInt(v: unknown, name: string): number {
    const n = asNumber(v, name);
    if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${n}`);
    return n;
}

function asString(v: unknown, name: string): string {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    return v;
}

function trackKind(t: unknown): "audio" | "midi" | "other" {
    if (t instanceof MidiTrack) return "midi";
    if (t instanceof AudioTrack) return "audio";
    return "other";
}

function trackInfo(track: import("@ableton-extensions/sdk").Track<"1.0.0">, index: number): Record<string, unknown> {
    return {
        index,
        name: track.name,
        kind: trackKind(track),
        muted: track.mute,
        soloed: track.solo,
        muted_via_solo: track.mutedViaSolo,
        arm: track.arm,
        is_grouped: track.groupTrack !== null,
        clip_slot_count: track.clipSlots.length,
        device_count: track.devices.length,
    };
}

export function buildMethods(context: Ctx, protocolVersion: string): RpcMethodTable {
    const song = () => context.application.song;

    const requireMidiTrack = (i: number): MidiTrack<"1.0.0"> => {
        const tracks = song().tracks;
        if (i < 0 || i >= tracks.length) throw new Error(`track_index ${i} out of range`);
        const t = tracks[i]!;
        if (!(t instanceof MidiTrack)) throw new Error(`track ${i} is not a MIDI track`);
        return t;
    };

    const requireAudioTrack = (i: number): AudioTrack<"1.0.0"> => {
        const tracks = song().tracks;
        if (i < 0 || i >= tracks.length) throw new Error(`track_index ${i} out of range`);
        const t = tracks[i]!;
        if (!(t instanceof AudioTrack)) throw new Error(`track ${i} is not an audio track`);
        return t;
    };

    return {
        // --- Bridge meta -----------------------------------------------
        ping: () => ({ pong: true, protocol: protocolVersion, ts: Date.now() }),

        // --- Read --------------------------------------------------------
        "song.getTempo": () => ({ tempo: song().tempo }),

        "song.getState": () => {
            const s = song();
            return {
                tempo: s.tempo,
                track_count: s.tracks.length,
                return_track_count: s.returnTracks.length,
                scene_count: s.scenes.length,
                cue_point_count: s.cuePoints.length,
                grid_quantization: s.gridQuantization,
                grid_is_triplet: s.gridIsTriplet,
                root_note: Number(s.rootNote),
                scale_name: s.scaleName,
                scale_mode: s.scaleMode,
                scale_intervals: s.scaleIntervals.map((v) => Number(v)),
                // unsupported in extension API 1.0:
                signature_numerator: null,
                signature_denominator: null,
                is_playing: null,
                current_song_time: null,
            };
        },

        "song.listTracks": () => {
            return {
                tracks: song().tracks.map((t, i) => trackInfo(t, i)),
                main_track: { name: song().mainTrack.name },
                return_tracks: song().returnTracks.map((t, i) => trackInfo(t, i)),
            };
        },

        "track.listClips": (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const tracks = song().tracks;
            if (ti < 0 || ti >= tracks.length) throw new Error(`track_index ${ti} out of range`);
            const track = tracks[ti]!;
            const session = track.clipSlots.map((slot, si) => {
                const c = slot.clip;
                if (!c) return { kind: "session", scene_index: si, has_clip: false };
                const isMidi = "notes" in c;
                return {
                    kind: "session",
                    scene_index: si,
                    has_clip: true,
                    is_midi: isMidi,
                    name: c.name,
                    duration: c.duration ?? null,
                    note_count: isMidi ? (c as import("@ableton-extensions/sdk").MidiClip<"1.0.0">).notes.length : null,
                };
            });
            const arrangement = (track.arrangementClips ?? []).map((c, i) => {
                const isMidi = "notes" in c;
                return {
                    kind: "arrangement",
                    index: i,
                    is_midi: isMidi,
                    name: c.name,
                    start_time: c.startTime ?? null,
                    end_time: c.endTime ?? null,
                    note_count: isMidi ? (c as import("@ableton-extensions/sdk").MidiClip<"1.0.0">).notes.length : null,
                };
            });
            return { track_index: ti, session_clips: session, arrangement_clips: arrangement };
        },

        "clip.getNotes": (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const track = requireMidiTrack(ti);
            let clip: import("@ableton-extensions/sdk").MidiClip<"1.0.0"> | null = null;
            if (params["scene_index"] !== undefined && params["scene_index"] !== null) {
                const si = asInt(params["scene_index"], "scene_index");
                const slot = track.clipSlots[si];
                if (!slot) throw new Error(`scene_index ${si} out of range`);
                const c = slot.clip;
                if (!c || !("notes" in c)) throw new Error("no MIDI clip at that slot");
                clip = c as import("@ableton-extensions/sdk").MidiClip<"1.0.0">;
            } else if (params["arrangement_index"] !== undefined && params["arrangement_index"] !== null) {
                const ai = asInt(params["arrangement_index"], "arrangement_index");
                const c = track.arrangementClips[ai];
                if (!c || !("notes" in c)) throw new Error(`no arrangement MIDI clip at index ${ai}`);
                clip = c as import("@ableton-extensions/sdk").MidiClip<"1.0.0">;
            } else {
                throw new Error("specify scene_index OR arrangement_index");
            }
            return {
                name: clip.name,
                duration: clip.duration ?? null,
                notes: clip.notes.map((n) => ({
                    pitch: n.pitch,
                    start: n.startTime,
                    duration: n.duration,
                    velocity: n.velocity ?? null,
                    muted: n.muted ?? false,
                })),
            };
        },

        "transport.isPlaying": () => unsupported("transport.isPlaying"),
        "view.getSelection": () => unsupported("view.getSelection"),

        // --- Write -------------------------------------------------------
        "song.setTempo": (params) => {
            const bpm = asNumber(params["bpm"], "bpm");
            if (bpm < 20 || bpm > 999) throw new Error("bpm out of range (20..999)");
            // Single-property writes are auto-undoable; transaction is optional.
            context.withinTransaction(() => {
                song().tempo = bpm;
            });
            return { tempo: song().tempo };
        },

        "transport.play": () => unsupported("transport.play"),
        "transport.stop": () => unsupported("transport.stop"),
        "transport.continue": () => unsupported("transport.continue"),
        "song.undo": () => unsupported("song.undo"),
        "song.redo": () => unsupported("song.redo"),

        "track.create": async (params) => {
            const kind = (params["kind"] as string | undefined) ?? "midi";
            if (params["index"] !== undefined && params["index"] !== null) {
                throw new Error(
                    "track.create: 'index' is not supported by Extension API 1.0; new tracks are appended.",
                );
            }
            const s = song();
            // No index argument — appends, or inserts after the selected track.
            let track: import("@ableton-extensions/sdk").Track<"1.0.0">;
            if (kind === "midi") {
                track = await s.createMidiTrack();
            } else if (kind === "audio") {
                track = await s.createAudioTrack();
            } else {
                throw new Error("kind must be 'midi' or 'audio' (return tracks not in API 1.0)");
            }
            const idx = s.tracks.indexOf(track);
            return { track: trackInfo(track, idx) };
        },

        "track.delete": async (params) => {
            const index = asInt(params["index"], "index");
            const s = song();
            if (index < 0 || index >= s.tracks.length) throw new Error(`index ${index} out of range`);
            const t = s.tracks[index]!;
            await s.deleteTrack(t);
            return { ok: true, index };
        },

        "track.rename": (params) => {
            const index = asInt(params["index"], "index");
            const name = asString(params["name"] ?? "", "name");
            const s = song();
            if (index < 0 || index >= s.tracks.length) throw new Error(`index ${index} out of range`);
            context.withinTransaction(() => {
                s.tracks[index]!.name = name;
            });
            return { ok: true, index, name };
        },

        "clip.createMidi": async (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const si = asInt(params["scene_index"], "scene_index");
            const length = params["length_beats"] !== undefined ? asNumber(params["length_beats"], "length_beats") : 4.0;
            const track = requireMidiTrack(ti);
            if (si < 0 || si >= track.clipSlots.length) {
                throw new Error(`scene_index ${si} out of range (track has ${track.clipSlots.length} slots)`);
            }
            const slot = track.clipSlots[si]!;
            const clip = await slot.createMidiClip(length);
            if (typeof params["name"] === "string") {
                context.withinTransaction(() => {
                    clip.name = params["name"] as string;
                });
            }
            return {
                track_index: ti,
                scene_index: si,
                length_beats: clip.duration,
                name: clip.name,
            };
        },

        "clip.setNotes": (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const si = asInt(params["scene_index"], "scene_index");
            const ns = (params["notes"] as unknown[]) ?? [];
            const track = requireMidiTrack(ti);
            const slot = track.clipSlots[si];
            if (!slot) throw new Error(`scene_index ${si} out of range`);
            const clip = slot.clip;
            if (!clip || !("notes" in clip)) throw new Error("no MIDI clip at that slot");
            const notes: NoteDescription[] = (ns as Array<Record<string, unknown>>).map((n) => ({
                pitch: asInt(n["pitch"], "note.pitch"),
                startTime: asNumber(n["start"] ?? n["startTime"] ?? 0, "note.start"),
                duration: asNumber(n["duration"], "note.duration"),
                velocity: n["velocity"] !== undefined ? asNumber(n["velocity"], "note.velocity") : 100,
                muted: Boolean(n["mute"] ?? n["muted"] ?? false),
            }));
            context.withinTransaction(() => {
                // The SDK setter replaces the entire note list.
                (clip as import("@ableton-extensions/sdk").MidiClip<"1.0.0">).notes = notes;
            });
            return { added: notes.length };
        },

        "clip.delete": async (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const si = asInt(params["scene_index"], "scene_index");
            const tracks = song().tracks;
            if (ti < 0 || ti >= tracks.length) throw new Error(`track_index ${ti} out of range`);
            const slot = tracks[ti]!.clipSlots[si];
            if (!slot) throw new Error(`scene_index ${si} out of range`);
            await slot.deleteClip();
            return { ok: true };
        },

        // --- New SDK-only capabilities --------------------------------
        "audio.import": async (params) => {
            const filePath = asString(params["file_path"], "file_path");
            const ti = asInt(params["track_index"], "track_index");
            const track = requireAudioTrack(ti);
            const imported = await context.resources.importIntoProject(filePath);

            if (params["scene_index"] !== undefined && params["scene_index"] !== null) {
                const si = asInt(params["scene_index"], "scene_index");
                const slot = track.clipSlots[si];
                if (!slot) throw new Error(`scene_index ${si} out of range`);
                const clip = await slot.createAudioClip({
                    filePath: imported,
                    isWarped: Boolean(params["is_warped"] ?? false),
                });
                return { mode: "session", track_index: ti, scene_index: si, file_path: imported, name: clip.name };
            }

            const startTime = asNumber(params["start_time"] ?? 0, "start_time");
            const clip = await track.createAudioClip({
                filePath: imported,
                startTime,
                isWarped: params["is_warped"] !== undefined ? Boolean(params["is_warped"]) : undefined,
                duration: params["duration"] !== undefined ? asNumber(params["duration"], "duration") : undefined,
            });
            return { mode: "arrangement", track_index: ti, start_time: startTime, file_path: imported, name: clip.name };
        },

        "audio.renderTrack": async (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const startTime = asNumber(params["start_time"], "start_time");
            const endTime = asNumber(params["end_time"], "end_time");
            const track = requireAudioTrack(ti);
            const path = await context.resources.renderPreFxAudio(track, startTime, endTime);
            return { wav_path: path, track_index: ti, start_time: startTime, end_time: endTime };
        },

        "arrangement.createMidiClip": async (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const startTime = asNumber(params["start_time"], "start_time");
            const duration = asNumber(params["duration"], "duration");
            const track = requireMidiTrack(ti);
            const clip = await track.createMidiClip(startTime, duration);
            const arrangementIndex = track.arrangementClips.indexOf(clip);
            if (typeof params["name"] === "string") {
                context.withinTransaction(() => {
                    clip.name = params["name"] as string;
                });
            }
            return {
                track_index: ti,
                arrangement_index: arrangementIndex,
                start_time: startTime,
                duration,
                name: clip.name,
            };
        },

        "arrangement.setClipNotes": (params) => {
            const ti = asInt(params["track_index"], "track_index");
            const ai = asInt(params["arrangement_index"], "arrangement_index");
            const ns = (params["notes"] as unknown[]) ?? [];
            const track = requireMidiTrack(ti);
            const clip = track.arrangementClips[ai];
            if (!clip || !("notes" in clip)) {
                throw new Error(`no arrangement MIDI clip at index ${ai}`);
            }
            const notes: NoteDescription[] = (ns as Array<Record<string, unknown>>).map((n) => ({
                pitch: asInt(n["pitch"], "note.pitch"),
                startTime: asNumber(n["start"] ?? n["startTime"] ?? 0, "note.start"),
                duration: asNumber(n["duration"], "note.duration"),
                velocity: n["velocity"] !== undefined ? asNumber(n["velocity"], "note.velocity") : 100,
                muted: Boolean(n["mute"] ?? n["muted"] ?? false),
            }));
            context.withinTransaction(() => {
                (clip as import("@ableton-extensions/sdk").MidiClip<"1.0.0">).notes = notes;
            });
            return { added: notes.length, track_index: ti, arrangement_index: ai };
        },

        "scene.create": async (params) => {
            const index = params["index"] !== undefined ? asInt(params["index"], "index") : -1;
            const scene = await song().createScene(index);
            return { name: scene.name, tempo: scene.tempo };
        },

        "env.info": () => ({
            storage_directory: context.environment.storageDirectory ?? null,
            temp_directory: context.environment.tempDirectory ?? null,
            language: context.environment.language ?? null,
        }),
    };
}
