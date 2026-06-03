// MidiClip context-menu actions. Each command receives the right-clicked
// clip's Handle as its first arg; we resolve it to a typed Clip and mutate
// notes in-place via `clip.notes = ...`.

import {
    Clip,
    MidiClip,
    MidiTrack,
    type ArrangementSelection,
    type ExtensionContext,
    type NoteDescription,
    type Handle,
} from "@ableton-extensions/sdk";

import {
    shiftDialogUrl, parseShiftResult, type ShiftParams,
    settingsDialogUrl, parseSettingsResult,
    askDialogUrl, parseAskResult
} from "./dialogs";
import { loadConfig, saveConfig, type Provider } from "./config";
import { askLLM } from "./llm";

type Ctx = ExtensionContext<"1.0.0">;

function asMidiClip(api: Ctx, arg: unknown): MidiClip<"1.0.0"> | null {
    const clip = api.getObjectFromHandle(arg as Handle, Clip);
    if (!(clip instanceof MidiClip)) {
        console.error("[able-mcp] not a MidiClip");
        return null;
    }
    return clip;
}

function cloneNote(n: NoteDescription): NoteDescription {
    return {
        pitch: n.pitch,
        startTime: n.startTime,
        duration: n.duration,
        velocity: n.velocity,
        muted: n.muted,
        probability: n.probability,
        velocityDeviation: n.velocityDeviation,
        releaseVelocity: n.releaseVelocity,
    };
}

// --- Generators ---------------------------------------------------------

function variation(notes: readonly NoteDescription[]): NoteDescription[] {
    // 30% chance per note: jump ±1 octave; 15% chance: drop the note.
    return notes.flatMap((n) => {
        const r = Math.random();
        if (r < 0.15) return [];
        const out = cloneNote(n);
        if (r < 0.45) {
            out.pitch = Math.max(0, Math.min(127, n.pitch + (Math.random() < 0.5 ? -12 : 12)));
        }
        return [out];
    });
}

function octaveDouble(notes: readonly NoteDescription[]): NoteDescription[] {
    const out: NoteDescription[] = notes.map(cloneNote);
    for (const n of notes) {
        if (n.pitch + 12 > 127) continue;
        const high = cloneNote(n);
        high.pitch = n.pitch + 12;
        high.velocity = Math.max(1, Math.round((n.velocity ?? 100) * 0.6));
        out.push(high);
    }
    return out;
}

function humanize(notes: readonly NoteDescription[]): NoteDescription[] {
    return notes.map((n) => {
        const out = cloneNote(n);
        const tJitter = (Math.random() - 0.5) * 0.1; // ±0.05 beats
        out.startTime = Math.max(0, n.startTime + tJitter);
        const vBase = n.velocity ?? 100;
        const vJitter = Math.round((Math.random() - 0.5) * 20); // ±10
        out.velocity = Math.max(1, Math.min(127, vBase + vJitter));
        return out;
    });
}

function reverse(notes: readonly NoteDescription[], duration: number): NoteDescription[] {
    return notes.map((n) => {
        const out = cloneNote(n);
        out.startTime = Math.max(0, duration - (n.startTime + n.duration));
        return out;
    });
}

function invert(notes: readonly NoteDescription[]): NoteDescription[] {
    if (notes.length === 0) return [];
    // Mirror pitch around the median pitch (preserves register).
    const sorted = [...notes].map((n) => n.pitch).sort((a, b) => a - b);
    const axis = sorted[Math.floor(sorted.length / 2)];
    return notes.map((n) => {
        const out = cloneNote(n);
        out.pitch = Math.max(0, Math.min(127, 2 * axis - n.pitch));
        return out;
    });
}

function transposeUp(notes: readonly NoteDescription[]): NoteDescription[] {
    return notes.map((n) => {
        const out = cloneNote(n);
        out.pitch = Math.min(127, n.pitch + 1);
        return out;
    });
}

function transposeDown(notes: readonly NoteDescription[]): NoteDescription[] {
    return notes.map((n) => {
        const out = cloneNote(n);
        out.pitch = Math.max(0, n.pitch - 1);
        return out;
    });
}

function legato(notes: readonly NoteDescription[]): NoteDescription[] {
    // For each pitch group, extend each note's duration to the next note's start.
    const byPitch = new Map<number, NoteDescription[]>();
    for (const n of notes) {
        const arr = byPitch.get(n.pitch) ?? [];
        arr.push(cloneNote(n));
        byPitch.set(n.pitch, arr);
    }
    const out: NoteDescription[] = [];
    for (const arr of byPitch.values()) {
        arr.sort((a, b) => a.startTime - b.startTime);
        for (let i = 0; i < arr.length; i++) {
            const next = arr[i + 1];
            if (next) arr[i].duration = Math.max(0.01, next.startTime - arr[i].startTime);
            out.push(arr[i]);
        }
    }
    return out;
}

function staccato(notes: readonly NoteDescription[]): NoteDescription[] {
    return notes.map((n) => {
        const out = cloneNote(n);
        out.duration = Math.max(0.05, n.duration * 0.25);
        return out;
    });
}

function thinHalf(notes: readonly NoteDescription[]): NoteDescription[] {
    // Drop every other note in time order — sparser groove.
    const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
    return sorted.filter((_, i) => i % 2 === 0).map(cloneNote);
}

function doubleTime(notes: readonly NoteDescription[]): NoteDescription[] {
    // Compress timing 2x and duplicate, so the clip plays the pattern twice as fast,
    // twice in a row across the same length.
    const out: NoteDescription[] = [];
    for (const n of notes) {
        const a = cloneNote(n);
        a.startTime = n.startTime / 2;
        a.duration = Math.max(0.01, n.duration / 2);
        out.push(a);
        const b = cloneNote(n);
        b.startTime = n.startTime / 2 + (notesMaxEnd(notes) / 2);
        b.duration = a.duration;
        out.push(b);
    }
    return out;
}

function halfTime(notes: readonly NoteDescription[]): NoteDescription[] {
    // Stretch to 2x — first half plays at half speed, second half empty.
    return notes.map((n) => {
        const out = cloneNote(n);
        out.startTime = n.startTime * 2;
        out.duration = n.duration * 2;
        return out;
    });
}

function notesMaxEnd(notes: readonly NoteDescription[]): number {
    let m = 0;
    for (const n of notes) m = Math.max(m, n.startTime + n.duration);
    return m;
}

function chordSpread(notes: readonly NoteDescription[]): NoteDescription[] {
    // For simultaneous notes (within 0.05 beats), stagger them by 1/64 each — instant strum.
    const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
    const out: NoteDescription[] = [];
    let i = 0;
    while (i < sorted.length) {
        const group: NoteDescription[] = [sorted[i]];
        let j = i + 1;
        while (j < sorted.length && Math.abs(sorted[j].startTime - sorted[i].startTime) < 0.05) {
            group.push(sorted[j]);
            j++;
        }
        group.sort((a, b) => a.pitch - b.pitch);
        for (let k = 0; k < group.length; k++) {
            const out_n = cloneNote(group[k]);
            out_n.startTime = group[0].startTime + k * (1 / 64);
            out.push(out_n);
        }
        i = j;
    }
    return out;
}

function accentDownbeats(notes: readonly NoteDescription[]): NoteDescription[] {
    return notes.map((n) => {
        const out = cloneNote(n);
        const onBeat = Math.abs(n.startTime - Math.round(n.startTime)) < 0.05;
        const base = n.velocity ?? 100;
        out.velocity = onBeat ? Math.min(127, base + 20) : Math.max(1, base - 10);
        return out;
    });
}

function extractTopVoice(notes: readonly NoteDescription[]): NoteDescription[] {
    // For each chord (notes within 0.05 beats), keep only the highest pitch.
    const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
    const out: NoteDescription[] = [];
    let i = 0;
    while (i < sorted.length) {
        let top = sorted[i];
        let j = i + 1;
        while (j < sorted.length && Math.abs(sorted[j].startTime - sorted[i].startTime) < 0.05) {
            if (sorted[j].pitch > top.pitch) top = sorted[j];
            j++;
        }
        out.push(cloneNote(top));
        i = j;
    }
    return out;
}

function extractBassVoice(notes: readonly NoteDescription[]): NoteDescription[] {
    const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
    const out: NoteDescription[] = [];
    let i = 0;
    while (i < sorted.length) {
        let bass = sorted[i];
        let j = i + 1;
        while (j < sorted.length && Math.abs(sorted[j].startTime - sorted[i].startTime) < 0.05) {
            if (sorted[j].pitch < bass.pitch) bass = sorted[j];
            j++;
        }
        const out_n = cloneNote(bass);
        out_n.pitch = Math.max(0, bass.pitch - 12); // drop an octave for bass feel
        out.push(out_n);
        i = j;
    }
    return out;
}

// --- Parametric: Shift (dialog-driven) ----------------------------------

function shiftNotes(
    notes: readonly NoteDescription[],
    duration: number,
    params: ShiftParams,
): NoteDescription[] {
    const { time, pitch, wrap } = params;
    const out: NoteDescription[] = [];
    for (const n of notes) {
        const c = cloneNote(n);
        c.pitch = Math.max(0, Math.min(127, n.pitch + pitch));
        let t = n.startTime + time;
        if (wrap && duration > 0) {
            t = ((t % duration) + duration) % duration;
            // If a wrapped note's tail spills past the end, clip it (Live treats
            // notes that exceed clip length as truncated on playback anyway).
            c.duration = Math.min(n.duration, Math.max(0.01, duration - t));
        } else if (duration > 0) {
            // Non-wrap: drop notes that fall fully outside, clamp tails inside.
            if (t + n.duration <= 0) continue;
            if (t >= duration) continue;
            if (t < 0) {
                c.duration = Math.max(0.01, n.duration + t);
                t = 0;
            } else if (t + n.duration > duration) {
                c.duration = Math.max(0.01, duration - t);
            }
        }
        c.startTime = Math.max(0, t);
        out.push(c);
    }
    return out;
}

// --- Registration -------------------------------------------------------

interface ActionDef {
    title: string;
    commandId: string;
    transform: (notes: readonly NoteDescription[], duration: number) => NoteDescription[];
}

const ACTIONS: ActionDef[] = [
    { title: "ABLE-MCP: Variation", commandId: "able-mcp.clip.variation", transform: (n) => variation(n) },
    { title: "ABLE-MCP: Octave double", commandId: "able-mcp.clip.octave", transform: (n) => octaveDouble(n) },
    { title: "ABLE-MCP: Humanize", commandId: "able-mcp.clip.humanize", transform: (n) => humanize(n) },
    { title: "ABLE-MCP: Reverse", commandId: "able-mcp.clip.reverse", transform: (n, d) => reverse(n, d) },
    { title: "ABLE-MCP: Invert (mirror)", commandId: "able-mcp.clip.invert", transform: (n) => invert(n) },
    { title: "ABLE-MCP: Transpose +1", commandId: "able-mcp.clip.up", transform: (n) => transposeUp(n) },
    { title: "ABLE-MCP: Transpose -1", commandId: "able-mcp.clip.down", transform: (n) => transposeDown(n) },
    { title: "ABLE-MCP: Legato", commandId: "able-mcp.clip.legato", transform: (n) => legato(n) },
    { title: "ABLE-MCP: Staccato", commandId: "able-mcp.clip.staccato", transform: (n) => staccato(n) },
    { title: "ABLE-MCP: Thin (every other)", commandId: "able-mcp.clip.thin", transform: (n) => thinHalf(n) },
    { title: "ABLE-MCP: Double-time", commandId: "able-mcp.clip.double", transform: (n) => doubleTime(n) },
    { title: "ABLE-MCP: Half-time", commandId: "able-mcp.clip.half", transform: (n) => halfTime(n) },
    { title: "ABLE-MCP: Strum chords", commandId: "able-mcp.clip.strum", transform: (n) => chordSpread(n) },
    { title: "ABLE-MCP: Accent downbeats", commandId: "able-mcp.clip.accent", transform: (n) => accentDownbeats(n) },
    { title: "ABLE-MCP: Top voice only", commandId: "able-mcp.clip.top", transform: (n) => extractTopVoice(n) },
    { title: "ABLE-MCP: Bass voice (drop 8va)", commandId: "able-mcp.clip.bass", transform: (n) => extractBassVoice(n) },
];

export async function registerMidiClipActions(api: Ctx): Promise<void> {
    for (const def of ACTIONS) {
        api.commands.registerCommand(def.commandId, (arg: unknown) => {
            const clip = asMidiClip(api, arg);
            if (!clip) return;
            const before = [...clip.notes];
            const after = def.transform(before, clip.duration ?? 0);
            api.withinTransaction(() => {
                clip.notes = after;
            });
            console.log(`[able-mcp] ${def.commandId}: ${before.length} -> ${after.length} notes`);
        });
        try {
            await api.ui.registerContextMenuAction("MidiClip", def.title, def.commandId);
        } catch (e) {
            console.error(`[able-mcp] register ${def.title} failed:`, e);
        }
    }
    await registerShiftDialogActions(api);
    // AI features (Ask…/Settings…) are deferred to v2 — see llm.ts and the
    // registerAskAction/registerSettingsAction below for the scaffolding.
    // await registerAskAction(api);
    // await registerSettingsAction(api);
    await registerArrangementActions(api);
}

// --- Settings… (modal) -------------------------------------------------

async function registerSettingsAction(api: Ctx): Promise<void> {
    api.commands.registerCommand("able-mcp.settings", () => {
        void (async () => {
            const cfg = loadConfig();
            const raw = await api.ui.showModalDialog(settingsDialogUrl(cfg), 460, 360);
            const r = parseSettingsResult(raw);
            if (!r) return;
            const provider: Provider =
                r.provider === "openai" || r.provider === "google" || r.provider === "ollama" || r.provider === "anthropic"
                    ? r.provider
                    : "anthropic";
            const path = saveConfig({
                provider,
                apiKey: r.apiKey,
                model: r.model,
                ollamaUrl: r.ollamaUrl,
            });
            console.log(`[able-mcp] settings saved -> ${path}`);
        })();
    });
    // Register on every scope where Live will accept it, so users can find it
    // from any right-click. Track scopes are the most natural home for "global" prefs.
    const scopes = ["MidiClip", "MidiTrack", "AudioTrack", "Scene"] as const;
    for (const s of scopes) {
        try {
            await api.ui.registerContextMenuAction(s, "ABLE-MCP: Settings…", "able-mcp.settings");
        } catch (e) {
            console.error(`[able-mcp] register Settings… on ${s} failed:`, e);
        }
    }
}

// --- Ask… (LLM) --------------------------------------------------------

async function registerAskAction(api: Ctx): Promise<void> {
    api.commands.registerCommand("able-mcp.clip.ask", (arg: unknown) => {
        const clip = asMidiClip(api, arg);
        if (!clip) return;
        void runAskOnClip(api, clip);
    });
    try {
        await api.ui.registerContextMenuAction("MidiClip", "ABLE-MCP: Ask AI…", "able-mcp.clip.ask");
    } catch (e) {
        console.error("[able-mcp] register Ask AI… failed:", e);
    }
}

async function runAskOnClip(api: Ctx, clip: MidiClip<"1.0.0">): Promise<void> {
    const cfg = loadConfig();
    if (cfg.provider !== "ollama" && !cfg.apiKey) {
        // Push them to settings first.
        const raw = await api.ui.showModalDialog(settingsDialogUrl(cfg), 460, 360);
        const r = parseSettingsResult(raw);
        if (!r) return;
        const provider: Provider =
            r.provider === "openai" || r.provider === "google" || r.provider === "ollama" || r.provider === "anthropic"
                ? r.provider : "anthropic";
        saveConfig({ provider, apiKey: r.apiKey, model: r.model, ollamaUrl: r.ollamaUrl });
    }
    const cfg2 = loadConfig();

    const askRaw = await api.ui.showModalDialog(askDialogUrl(), 520, 320);
    const ask = parseAskResult(askRaw);
    if (!ask) return;

    const before = [...clip.notes];
    const duration = clip.duration ?? 0;
    const tempo = api.application.song.tempo ?? 120;

    try {
        const result = await api.ui.withinProgressDialog(
            `Asking ${cfg2.provider}…`,
            { progress: 10 },
            async (update) => {
                await update("Sending notes to model…", 30);
                const res = await askLLM(cfg2, {
                    prompt: ask.prompt,
                    notes: before.map((n) => ({
                        pitch: n.pitch,
                        startTime: n.startTime,
                        duration: n.duration,
                        velocity: n.velocity,
                    })),
                    duration,
                    tempo,
                });
                await update("Applying…", 90);
                return res;
            },
        ) as { notes: Array<{ pitch: number; startTime: number; duration: number; velocity?: number }>; explanation?: string };

        if (!result || !Array.isArray(result.notes) || result.notes.length === 0) {
            console.error("[able-mcp] ask: empty result");
            return;
        }
        // Clamp to clip duration.
        const dur = clip.duration ?? 0;
        const newNotes = result.notes.map((n) => {
            const startTime = Math.max(0, Math.min(dur > 0 ? dur - 0.01 : n.startTime, n.startTime));
            const noteDur = Math.max(0.01, dur > 0 ? Math.min(n.duration, dur - startTime) : n.duration);
            return {
                pitch: n.pitch,
                startTime,
                duration: noteDur,
                velocity: n.velocity,
            };
        });
        api.withinTransaction(() => {
            clip.notes = newNotes;
        });
        console.log(`[able-mcp] ask: ${before.length} -> ${newNotes.length} notes${result.explanation ? " (" + result.explanation + ")" : ""}`);
    } catch (e) {
        console.error("[able-mcp] ask failed:", e);
    }
}

// --- Shift… (modal dialog) ---------------------------------------------
// A dedicated dialog-driven primitive: opens a small webview, collects
// time/pitch/wrap, applies to the clip (or arrangement range). This is the
// pattern for any future parametric primitive — keep the dialog HTML in
// dialogs.ts and add a sibling registerXxxDialogActions() here.

async function promptShift(api: Ctx): Promise<ShiftParams | null> {
    try {
        const raw = await api.ui.showModalDialog(shiftDialogUrl(), 460, 280);
        return parseShiftResult(raw);
    } catch (e) {
        console.error("[able-mcp] shift dialog error:", e);
        return null;
    }
}

async function registerShiftDialogActions(api: Ctx): Promise<void> {
    // Clip scope.
    api.commands.registerCommand("able-mcp.clip.shift", (arg: unknown) => {
        const clip = asMidiClip(api, arg);
        if (!clip) return;
        void (async () => {
            const params = await promptShift(api);
            if (!params) return;
            const before = [...clip.notes];
            const after = shiftNotes(before, clip.duration ?? 0, params);
            api.withinTransaction(() => {
                clip.notes = after;
            });
            console.log(
                `[able-mcp] able-mcp.clip.shift: t=${params.time} p=${params.pitch} wrap=${params.wrap} (${before.length} -> ${after.length} notes)`,
            );
        })();
    });
    try {
        await api.ui.registerContextMenuAction("MidiClip", "ABLE-MCP: Shift…", "able-mcp.clip.shift");
    } catch (e) {
        console.error("[able-mcp] register Shift… failed:", e);
    }

    // Arrangement-range scope.
    api.commands.registerCommand("able-mcp.clip.shift.arr", (arg: unknown) => {
        const sel = asArrangementSelection(arg);
        if (!sel) {
            console.error("[able-mcp] not an ArrangementSelection");
            return;
        }
        const start = sel.time_selection_start;
        const end = sel.time_selection_end;
        if (end <= start) return;
        void (async () => {
            const params = await promptShift(api);
            if (!params) return;
            let touchedClips = 0;
            let totalBefore = 0;
            let totalAfter = 0;
            api.withinTransaction(() => {
                for (const laneHandle of sel.selected_lanes) {
                    const track = api.getObjectFromHandle(laneHandle, MidiTrack);
                    if (!track) continue;
                    for (const clip of track.arrangementClips) {
                        if (!(clip instanceof MidiClip)) continue;
                        const result = applyToRangeInClip(
                            clip,
                            start,
                            end,
                            (notes, dur) => shiftNotes(notes, dur, params),
                        );
                        if (!result) continue;
                        clip.notes = result.notes;
                        touchedClips++;
                        totalBefore += result.before;
                        totalAfter += result.after;
                    }
                }
            });
            console.log(
                `[able-mcp] able-mcp.clip.shift.arr: t=${params.time} p=${params.pitch} wrap=${params.wrap} ${touchedClips} clip(s) ${totalBefore} -> ${totalAfter}`,
            );
        })();
    });
    try {
        await api.ui.registerContextMenuAction(
            "MidiTrack.ArrangementSelection",
            "ABLE-MCP (range): Shift…",
            "able-mcp.clip.shift.arr",
        );
    } catch (e) {
        console.error("[able-mcp] register Shift… (range) failed:", e);
    }
}

// --- Arrangement time-range actions -------------------------------------
// When the user right-clicks a time selection across one or more MIDI tracks
// in the Arrangement view, Live invokes our callback with an ArrangementSelection
// describing the time range and the affected track lanes. We slice each
// overlapping clip's notes into in-range and out-of-range buckets, transform
// the in-range bucket relative to t=0, then splice everything back.

function applyToRangeInClip(
    clip: MidiClip<"1.0.0">,
    rangeStartAbs: number,
    rangeEndAbs: number,
    transform: (notes: readonly NoteDescription[], duration: number) => NoteDescription[],
): { before: number; after: number; notes: NoteDescription[] } | null {
    const clipStart = clip.startTime;
    const clipDur = clip.duration ?? 0;
    const relStart = Math.max(0, rangeStartAbs - clipStart);
    const relEnd = Math.min(clipDur, rangeEndAbs - clipStart);
    if (relEnd <= relStart) return null;
    const inRange: NoteDescription[] = [];
    const outRange: NoteDescription[] = [];
    for (const n of clip.notes) {
        if (n.startTime >= relStart && n.startTime < relEnd) inRange.push(n);
        else outRange.push(n);
    }
    if (inRange.length === 0) return null;
    // Translate so transforms see t=0..rangeLength.
    const translated = inRange.map((n) => {
        const c = cloneNote(n);
        c.startTime = n.startTime - relStart;
        return c;
    });
    const transformed = transform(translated, relEnd - relStart);
    const back = transformed.map((n) => {
        const c = cloneNote(n);
        c.startTime = n.startTime + relStart;
        return c;
    });
    return { before: inRange.length, after: back.length, notes: [...outRange, ...back] };
}

function asArrangementSelection(arg: unknown): ArrangementSelection | null {
    if (!arg || typeof arg !== "object") return null;
    const a = arg as Partial<ArrangementSelection>;
    if (typeof a.time_selection_start !== "number") return null;
    if (typeof a.time_selection_end !== "number") return null;
    if (!Array.isArray(a.selected_lanes)) return null;
    return a as ArrangementSelection;
}

async function registerArrangementActions(api: Ctx): Promise<void> {
    for (const def of ACTIONS) {
        const arrCommandId = def.commandId + ".arr";
        const arrTitle = def.title.replace(/^ABLE-MCP: /, "ABLE-MCP (range): ");
        api.commands.registerCommand(arrCommandId, (arg: unknown) => {
            const sel = asArrangementSelection(arg);
            if (!sel) {
                console.error("[able-mcp] not an ArrangementSelection");
                return;
            }
            const start = sel.time_selection_start;
            const end = sel.time_selection_end;
            if (end <= start) return;
            let touchedClips = 0;
            let totalBefore = 0;
            let totalAfter = 0;
            api.withinTransaction(() => {
                for (const laneHandle of sel.selected_lanes) {
                    const track = api.getObjectFromHandle(laneHandle, MidiTrack);
                    if (!track) continue;
                    for (const clip of track.arrangementClips) {
                        if (!(clip instanceof MidiClip)) continue;
                        const result = applyToRangeInClip(clip, start, end, def.transform);
                        if (!result) continue;
                        clip.notes = result.notes;
                        touchedClips++;
                        totalBefore += result.before;
                        totalAfter += result.after;
                    }
                }
            });
            console.log(
                `[able-mcp] ${arrCommandId}: ${touchedClips} clip(s), ${totalBefore} -> ${totalAfter} notes in range [${start}, ${end}]`,
            );
        });
        try {
            await api.ui.registerContextMenuAction(
                "MidiTrack.ArrangementSelection",
                arrTitle,
                arrCommandId,
            );
        } catch (e) {
            console.error(`[able-mcp] register arr ${arrTitle} failed:`, e);
        }
    }
}
