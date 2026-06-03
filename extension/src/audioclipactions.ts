// AudioClip context-menu actions: chop a long arrangement audio clip into
// adjacent N-bar pieces, each cropped to its slice of the source file.
//
// Strategy: for each desired chunk, call track.createAudioClip with
// loopSettings.startMarker/endMarker set to that slice of the original
// crop region. Then delete the original. Each new clip references the
// SAME source file — no audio is rewritten on disk.

import {
    AudioClip,
    AudioTrack,
    Clip,
    type ExtensionContext,
    type Handle,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findFirstOnset, readWavHead } from "./wav";

type Ctx = ExtensionContext<"1.0.0">;

const LOG_PATH = process.env.ABLE_MCP_LOG ?? path.join(os.homedir(), "Library", "Application Support", "Ableton", "able-mcp.log");

function dbg(...parts: unknown[]): void {
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
    try {
        fs.appendFileSync(LOG_PATH, line);
    } catch {
        /* ignore */
    }
    console.log(line.trimEnd());
}

function asAudioClip(api: Ctx, arg: unknown): AudioClip<"1.0.0"> | null {
    const clip = api.getObjectFromHandle(arg as Handle, Clip);
    if (!(clip instanceof AudioClip)) {
        console.error("[able-mcp] not an AudioClip");
        return null;
    }
    return clip;
}

function getAudioTrack(clip: AudioClip<"1.0.0">): AudioTrack<"1.0.0"> | null {
    // Arrangement audio clips live on a TakeLane whose parent is the Track.
    // Walk up to a few levels to find an AudioTrack.
    let node: unknown = clip;
    for (let i = 0; i < 4; i++) {
        if (!node || typeof node !== "object") break;
        const p: unknown = (node as { parent?: unknown }).parent;
        const ctorName = p && typeof p === "object" ? (p.constructor as { name?: string } | undefined)?.name ?? "<no-ctor>" : String(p);
        dbg("getAudioTrack walk:", { level: i, parentClass: ctorName });
        if (p instanceof AudioTrack) return p;
        node = p;
    }
    dbg("getAudioTrack: AudioTrack ancestor not found");
    return null;
}

interface ChopDef {
    title: string;
    commandId: string;
    /** Chunk length, expressed in bars. Use 0.25 for a beat (in 4/4). */
    bars: number;
}

const CHOPS: ChopDef[] = [
    { title: "ABLE-MCP: Chop into beats (1/4 bar)", commandId: "able-mcp.audio.chop.beat", bars: 0.25 },
    { title: "ABLE-MCP: Chop into 1/2 bars", commandId: "able-mcp.audio.chop.half", bars: 0.5 },
    { title: "ABLE-MCP: Chop into 1-bar pieces", commandId: "able-mcp.audio.chop.1bar", bars: 1 },
    { title: "ABLE-MCP: Chop into 2-bar pieces", commandId: "able-mcp.audio.chop.2bar", bars: 2 },
    { title: "ABLE-MCP: Chop into 4-bar pieces", commandId: "able-mcp.audio.chop.4bar", bars: 4 },
    { title: "ABLE-MCP: Chop into 8-bar pieces", commandId: "able-mcp.audio.chop.8bar", bars: 8 },
];

async function chopClip(api: Ctx, clip: AudioClip<"1.0.0">, bars: number): Promise<void> {
    try {
        await chopClipInner(api, clip, bars);
    } catch (e) {
        // Never let an exception escape — Live's Extension Host treats an
        // unhandled rejection in a command callback as fatal and unloads us.
        console.error("[able-mcp] chopClip failed:", e);
    }
}

async function chopClipInner(api: Ctx, clip: AudioClip<"1.0.0">, bars: number): Promise<void> {
    dbg("chopClipInner: start", { bars });
    const track = getAudioTrack(clip);
    if (!track) return;

    // Snapshot everything we need BEFORE we touch the model.
    const filePath = clip.filePath;
    const arrStart = clip.startTime;          // arrangement position, beats
    const totalDur = clip.duration ?? 0;      // arrangement length, beats
    const cropStart = clip.startMarker;       // in-file crop, beats
    const cropEnd = clip.endMarker;           // in-file crop, beats
    const isWarped = clip.warping;
    const sourceColor = clip.color;
    const sourceName = clip.name;
    dbg("chopClipInner: clip snapshot", { filePath, arrStart, totalDur, cropStart, cropEnd, isWarped, sourceName });

    // Bar length in beats from the song's signature. Song doesn't expose
    // the signature directly in API v1.0; fall back to scene[0] (which
    // mirrors the project's default time signature) and finally to 4/4.
    const song = api.application.song;
    let num = 4;
    let den = 4;
    try {
        const scene0 = song.scenes[0];
        if (scene0) {
            num = scene0.signatureNumerator || 4;
            den = scene0.signatureDenominator || 4;
        }
    } catch {
        // ignore
    }
    const beatsPerBar = num * (4 / den);
    const chunkBeats = bars * beatsPerBar;
    dbg("chopClipInner: timing", { num, den, beatsPerBar, chunkBeats, songTempo: song.tempo });

    if (chunkBeats <= 0 || totalDur <= 0) {
        dbg("chopClipInner: invalid chunk size or empty clip");
        return;
    }

    // Number of full chunks + a possible short remainder.
    const fullChunks = Math.floor(totalDur / chunkBeats);
    const remainder = totalDur - fullChunks * chunkBeats;
    const chunks: { offset: number; length: number }[] = [];
    for (let i = 0; i < fullChunks; i++) {
        chunks.push({ offset: i * chunkBeats, length: chunkBeats });
    }
    if (remainder > 0.001) {
        chunks.push({ offset: fullChunks * chunkBeats, length: remainder });
    }

    if (chunks.length === 0) return;

    // Source crop scale: if the clip is warped or the crop window doesn't
    // equal totalDur (e.g. user already cropped), we map arrangement-beats
    // to crop-beats proportionally.
    const cropSpan = cropEnd - cropStart;
    const cropPerArrBeat = cropSpan / totalDur;
    dbg("chopClipInner: chunk plan", { count: chunks.length, cropSpan, cropPerArrBeat });

    // Lay down each chunk FIRST. If we can't create even one, bail without
    // touching the original clip.
    const created: AudioClip<"1.0.0">[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const arrChunkStart = arrStart + c.offset;
        const sliceStart = cropStart + c.offset * cropPerArrBeat;
        const sliceEnd = cropStart + (c.offset + c.length) * cropPerArrBeat;
        dbg("chopClipInner: creating slice", { i, arrChunkStart, length: c.length, sliceStart, sliceEnd });
        try {
            const newClip = await track.createAudioClip({
                filePath,
                startTime: arrChunkStart,
                duration: c.length,
                isWarped,
                loopSettings: {
                    looping: false,
                    startMarker: sliceStart,
                    endMarker: sliceEnd,
                    loopStart: sliceStart,
                    loopEnd: sliceEnd,
                },
            });
            try {
                newClip.color = sourceColor;
                newClip.name = sourceName ? `${sourceName} ${i + 1}` : `Chop ${i + 1}`;
            } catch {
                // best-effort; some setters may be restricted
            }
            created.push(newClip);
            dbg("chopClipInner: slice created", { i });
        } catch (e) {
            dbg(`chopClipInner: slice ${i} failed:`, String(e), (e as Error)?.stack);
        }
    }

    // Only delete the original after we have at least one chunk down.
    if (created.length === 0) {
        dbg("chopClipInner: no chunks created; original preserved");
        return;
    }
    try {
        await track.deleteClip(clip);
    } catch (e) {
        dbg("chopClipInner: deleteClip(original) failed:", String(e));
    }
    dbg(`chopClipInner: done — ${created.length} piece(s) of ${bars} bar(s)`);
}

// --- Snap first hit to bar ---------------------------------------------
// Goal: get the audio clip's first transient onto the nearest bar line so
// remixing on a project tempo is painless. We:
//   1. Read the source WAV header + first ~5 s of audio
//   2. Detect first onset (sample offset)
//   3. Convert to beats at project tempo (UNWARPED math: time*BPM/60)
//   4. Recreate the clip with startMarker advanced past the onset and
//      arrangement position quantized to the nearest bar.
// Forces warping=false on the new clip — works on raw samples / one-shots.
// Doesn't try to handle warped, tempo-modulated material.

async function snapFirstHit(api: Ctx, clip: AudioClip<"1.0.0">): Promise<void> {
    try {
        await snapFirstHitInner(api, clip);
    } catch (e) {
        console.error("[able-mcp] snapFirstHit failed:", e);
    }
}

async function snapFirstHitInner(api: Ctx, clip: AudioClip<"1.0.0">): Promise<void> {
    const track = getAudioTrack(clip);
    if (!track) return;

    const filePath = clip.filePath;
    if (!filePath || !filePath.toLowerCase().endsWith(".wav")) {
        console.error("[able-mcp] snap-first-hit only supports .wav sources");
        return;
    }

    const head = readWavHead(filePath, 5);
    if (!head) {
        console.error("[able-mcp] could not decode WAV head");
        return;
    }
    const onsetSec = findFirstOnset(head);
    if (onsetSec == null) {
        console.error("[able-mcp] no clear onset detected in first 5 s");
        return;
    }

    // Snapshot original.
    const arrStart = clip.startTime;
    const totalDur = clip.duration ?? 0;
    const cropStart = clip.startMarker;
    const cropEnd = clip.endMarker;
    const sourceColor = clip.color;
    const sourceName = clip.name;

    // Bar length.
    const song = api.application.song;
    let num = 4;
    let den = 4;
    try {
        const scene0 = song.scenes[0];
        if (scene0) {
            num = scene0.signatureNumerator || 4;
            den = scene0.signatureDenominator || 4;
        }
    } catch {
        /* ignore */
    }
    const beatsPerBar = num * (4 / den);

    // Convert onset seconds → beats at project tempo.
    const bpm = song.tempo || 120;
    const onsetBeats = onsetSec * bpm / 60;

    // New crop: skip the silence/lead-in. Keep tail length identical.
    const newCropStart = cropStart + onsetBeats;
    const newCropEnd = cropEnd; // unchanged
    if (newCropEnd - newCropStart < 0.01) {
        console.error("[able-mcp] onset is past clip end — refusing");
        return;
    }
    // Quantize arrangement position to the nearest bar so the first hit
    // lands on a downbeat in the project grid.
    const targetArrStart = Math.round(arrStart / beatsPerBar) * beatsPerBar;
    const newDuration = Math.max(0.01, totalDur - onsetBeats);

    await track.deleteClip(clip);
    try {
        const newClip = await track.createAudioClip({
            filePath,
            startTime: targetArrStart,
            duration: newDuration,
            isWarped: false,
            loopSettings: {
                looping: false,
                startMarker: newCropStart,
                endMarker: newCropEnd,
                loopStart: newCropStart,
                loopEnd: newCropEnd,
            },
        });
        try {
            newClip.color = sourceColor;
            if (sourceName) newClip.name = `${sourceName} (snapped)`;
        } catch {
            /* ignore */
        }
        console.log(
            `[able-mcp] snapped: onset=${onsetSec.toFixed(3)}s (${onsetBeats.toFixed(3)} beats @ ${bpm} BPM), arrStart ${arrStart.toFixed(3)} -> ${targetArrStart.toFixed(3)}`,
        );
    } catch (e) {
        console.error("[able-mcp] snap-first-hit failed:", e);
    }
}

export async function registerAudioClipActions(api: Ctx): Promise<void> {
    dbg(`registerAudioClipActions: build=${new Date().toISOString()} log=${LOG_PATH}`);
    for (const def of CHOPS) {
        api.commands.registerCommand(def.commandId, (arg: unknown) => {
            dbg("command invoked", { commandId: def.commandId, hasArg: !!arg });
            const clip = asAudioClip(api, arg);
            if (!clip) {
                dbg("command", def.commandId, "no audio clip resolved");
                return;
            }
            void chopClip(api, clip, def.bars);
        });
        try {
            await api.ui.registerContextMenuAction("AudioClip", def.title, def.commandId);
        } catch (e) {
            console.error(`[able-mcp] register ${def.title} failed:`, e);
        }
    }

    // Snap first hit to nearest bar.
    api.commands.registerCommand("able-mcp.audio.snap1", (arg: unknown) => {
        const clip = asAudioClip(api, arg);
        if (!clip) return;
        void snapFirstHit(api, clip);
    });
    try {
        await api.ui.registerContextMenuAction(
            "AudioClip",
            "ABLE-MCP: Snap first hit to bar",
            "able-mcp.audio.snap1",
        );
    } catch (e) {
        console.error("[able-mcp] register Snap first hit failed:", e);
    }
}
