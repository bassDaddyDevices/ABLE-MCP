// Tiny WAV decoder + onset detector. No deps — reads enough of the file
// to find the first strong transient, converts to seconds. Used by the
// "Snap first hit to 1.1.1" audio-clip action.
//
// Supports: PCM 16-bit, PCM 24-bit, PCM 32-bit, IEEE float 32-bit.
// Mono or stereo. Anything else returns null.

import * as fs from "node:fs";

interface DecodedHead {
    sampleRate: number;
    channels: number;
    /** Mono mix of the first N samples, normalized to roughly [-1, 1]. */
    mono: Float32Array;
}

export interface GuideNote {
    pitch: number;
    startSec: number;
    durationSec: number;
    velocity: number;
}

export interface ComplementOptions {
    similarity: number;
    density: number;
    register: "low" | "mid" | "high";
    callResponse: boolean;
    seed: number | null;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** Read first `maxSeconds` of a WAV file, return mono samples. Returns null on unsupported format. */
export function readWavHead(filePath: string, maxSeconds: number): DecodedHead | null {
    let fd: number;
    try {
        fd = fs.openSync(filePath, "r");
    } catch (e) {
        console.error("[able-mcp] open failed:", e);
        return null;
    }
    try {
        // Read RIFF header + fmt chunk (typically within first 64 bytes).
        const headBuf = Buffer.alloc(64);
        fs.readSync(fd, headBuf, 0, 64, 0);
        if (headBuf.toString("ascii", 0, 4) !== "RIFF") return null;
        if (headBuf.toString("ascii", 8, 12) !== "WAVE") return null;

        // Walk chunks starting at byte 12.
        let cursor = 12;
        let format = 0;
        let channels = 0;
        let sampleRate = 0;
        let bitsPerSample = 0;
        let dataOffset = 0;
        let dataSize = 0;

        // We may need a larger buffer to find the data chunk header — read in passes.
        const scanBuf = Buffer.alloc(1024);
        const scanRead = fs.readSync(fd, scanBuf, 0, 1024, 0);

        while (cursor + 8 <= scanRead) {
            const id = scanBuf.toString("ascii", cursor, cursor + 4);
            const size = scanBuf.readUInt32LE(cursor + 4);
            if (id === "fmt ") {
                format = scanBuf.readUInt16LE(cursor + 8);
                channels = scanBuf.readUInt16LE(cursor + 10);
                sampleRate = scanBuf.readUInt32LE(cursor + 12);
                bitsPerSample = scanBuf.readUInt16LE(cursor + 22);
                if (format === FORMAT_EXTENSIBLE && size >= 24) {
                    // SubFormat first 2 bytes match the actual format code.
                    format = scanBuf.readUInt16LE(cursor + 32);
                }
            } else if (id === "data") {
                dataOffset = cursor + 8;
                dataSize = size;
                break;
            }
            cursor += 8 + size + (size % 2); // chunks are word-aligned
        }

        if (!sampleRate || !channels || !bitsPerSample || !dataOffset) {
            console.error("[able-mcp] unsupported or malformed WAV");
            return null;
        }

        const bytesPerSample = bitsPerSample / 8;
        const frameBytes = bytesPerSample * channels;
        const wantBytes = Math.min(
            dataSize,
            Math.floor(maxSeconds * sampleRate) * frameBytes,
        );
        if (wantBytes <= 0) return null;
        const data = Buffer.alloc(wantBytes);
        fs.readSync(fd, data, 0, wantBytes, dataOffset);

        const frames = Math.floor(wantBytes / frameBytes);
        const mono = new Float32Array(frames);

        const decode: (b: Buffer, off: number) => number = (() => {
            if (format === FORMAT_PCM && bitsPerSample === 16) {
                return (b, o) => b.readInt16LE(o) / 32768;
            }
            if (format === FORMAT_PCM && bitsPerSample === 24) {
                return (b, o) => {
                    const v = b.readUIntLE(o, 3);
                    const signed = v & 0x800000 ? v - 0x1000000 : v;
                    return signed / 8388608;
                };
            }
            if (format === FORMAT_PCM && bitsPerSample === 32) {
                return (b, o) => b.readInt32LE(o) / 2147483648;
            }
            if (format === FORMAT_FLOAT && bitsPerSample === 32) {
                return (b, o) => b.readFloatLE(o);
            }
            return null as unknown as (b: Buffer, o: number) => number;
        })();
        if (!decode) {
            console.error(`[able-mcp] unsupported WAV format=${format} bits=${bitsPerSample}`);
            return null;
        }

        for (let f = 0; f < frames; f++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
                sum += decode(data, f * frameBytes + c * bytesPerSample);
            }
            mono[f] = sum / channels;
        }
        return { sampleRate, channels, mono };
    } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
    }
}

/**
 * Find the first strong onset in seconds from the file start.
 *
 * Algorithm: split signal into ~10 ms windows, compute energy (RMS²),
 * then look for the window whose energy is N× the recent moving median.
 * Skips initial silence. Returns null if no clear onset.
 */
export function findFirstOnset(head: DecodedHead, opts?: { thresholdRatio?: number; minSilenceFloor?: number }): number | null {
    const { sampleRate, mono } = head;
    const winSamples = Math.max(1, Math.floor(sampleRate * 0.01)); // 10 ms
    const numWin = Math.floor(mono.length / winSamples);
    if (numWin < 4) return null;

    const energies = new Float32Array(numWin);
    for (let w = 0; w < numWin; w++) {
        let e = 0;
        const base = w * winSamples;
        for (let i = 0; i < winSamples; i++) {
            const s = mono[base + i];
            e += s * s;
        }
        energies[w] = e / winSamples;
    }

    const ratio = opts?.thresholdRatio ?? 8;
    const floor = opts?.minSilenceFloor ?? 1e-6;
    // Look at first 5 windows to estimate noise floor; use the minimum.
    let noise = Infinity;
    for (let w = 0; w < Math.min(5, numWin); w++) {
        if (energies[w] < noise) noise = energies[w];
    }
    noise = Math.max(noise, floor);

    for (let w = 1; w < numWin; w++) {
        if (energies[w] > noise * ratio && energies[w] > floor * 10) {
            // refine: scan back inside the window for the first sample that
            // crosses 30% of the window's peak — gets us much closer to
            // the actual transient.
            const base = w * winSamples;
            let peak = 0;
            for (let i = 0; i < winSamples; i++) {
                const a = Math.abs(mono[base + i]);
                if (a > peak) peak = a;
            }
            const threshAmp = peak * 0.3;
            for (let i = 0; i < winSamples; i++) {
                if (Math.abs(mono[base + i]) >= threshAmp) {
                    return (base + i) / sampleRate;
                }
            }
            return base / sampleRate;
        }
    }
    return null;
}

function autocorrPitchHz(frame: Float32Array, sampleRate: number, minHz = 80, maxHz = 1000): number | null {
    if (frame.length < 64) return null;
    let mean = 0;
    for (let i = 0; i < frame.length; i++) mean += frame[i];
    mean /= frame.length;
    const x = new Float32Array(frame.length);
    let e0 = 0;
    for (let i = 0; i < frame.length; i++) {
        const v = frame[i] - mean;
        x[i] = v;
        e0 += v * v;
    }
    if (e0 <= 1e-9) return null;

    const minLag = Math.max(1, Math.floor(sampleRate / maxHz));
    const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / minHz));
    if (maxLag <= minLag) return null;

    let bestLag = -1;
    let bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
        let num = 0;
        let denB = 0;
        const upper = frame.length - lag;
        for (let i = 0; i < upper; i++) {
            const a = x[i];
            const b = x[i + lag];
            num += a * b;
            denB += b * b;
        }
        const den = denB > 0 ? Math.sqrt(e0 * denB) : 0;
        const score = den > 0 ? num / den : 0;
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
        }
    }
    if (bestLag <= 0 || bestScore < 0.35) return null;
    return sampleRate / bestLag;
}

function hzToMidi(hz: number): number {
    return Math.round(69 + 12 * Math.log2(Math.max(1e-6, hz) / 440));
}

export function extractGuideMelody(head: DecodedHead, opts?: { minNote?: number; maxNote?: number }): GuideNote[] {
    const minNote = opts?.minNote ?? 45;
    const maxNote = opts?.maxNote ?? 88;
    const frameSize = Math.max(64, Math.floor(head.sampleRate * 0.04));
    const hop = Math.max(16, Math.floor(head.sampleRate * 0.01));

    const probeCount = Math.min(head.mono.length, head.sampleRate);
    let probeEnergy = 0;
    for (let i = 0; i < probeCount; i++) probeEnergy += head.mono[i] * head.mono[i];
    const energyThreshold = Math.max(0.01, Math.sqrt(probeEnergy / Math.max(1, probeCount)) * 0.35);

    const pitches: Array<number | null> = [];
    for (let s = 0; s + frameSize <= head.mono.length; s += hop) {
        const frame = head.mono.subarray(s, s + frameSize);
        let e = 0;
        for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
        const rms = Math.sqrt(e / frame.length);
        if (rms < energyThreshold) {
            pitches.push(null);
            continue;
        }
        const hz = autocorrPitchHz(frame, head.sampleRate);
        if (hz == null) {
            pitches.push(null);
            continue;
        }
        const p = hzToMidi(hz);
        pitches.push(p >= minNote && p <= maxNote ? p : null);
    }

    // Median smooth voiced regions.
    const smooth = pitches.slice();
    for (let i = 0; i < pitches.length; i++) {
        if (pitches[i] == null) continue;
        const vals: number[] = [];
        for (let j = Math.max(0, i - 2); j <= Math.min(pitches.length - 1, i + 2); j++) {
            if (pitches[j] != null) vals.push(pitches[j] as number);
        }
        vals.sort((a, b) => a - b);
        smooth[i] = vals[Math.floor(vals.length / 2)] ?? pitches[i];
    }

    const notes: GuideNote[] = [];
    let curPitch: number | null = null;
    let curStart = 0;
    const flush = (endFrame: number): void => {
        if (curPitch == null) return;
        const startSec = (curStart * hop) / head.sampleRate;
        const endSec = ((endFrame * hop) + frameSize) / head.sampleRate;
        const dur = Math.max(0, endSec - startSec);
        if (dur >= 0.08) {
            notes.push({ pitch: curPitch, startSec, durationSec: dur, velocity: 100 });
        }
        curPitch = null;
    };

    for (let i = 0; i < smooth.length; i++) {
        const p = smooth[i];
        if (p == null) {
            flush(i);
            continue;
        }
        if (curPitch == null) {
            curPitch = p;
            curStart = i;
            continue;
        }
        if (Math.abs(p - curPitch) <= 1) {
            curPitch = Math.round(curPitch * 0.7 + p * 0.3);
            continue;
        }
        flush(i);
        curPitch = p;
        curStart = i;
    }
    flush(smooth.length);
    return notes;
}

export function guideSecondsToBeats(notes: GuideNote[], tempoBpm: number): Array<{ pitch: number; start: number; duration: number; velocity: number }> {
    if (tempoBpm <= 0) throw new Error("tempoBpm must be > 0");
    const bps = tempoBpm / 60;
    return notes.map((n) => ({
        pitch: n.pitch,
        start: n.startSec * bps,
        duration: n.durationSec * bps,
        velocity: n.velocity,
    }));
}

export function generateComplement(
    guide: Array<{ pitch: number; start: number; duration: number; velocity: number }>,
    options: ComplementOptions,
): Array<{ pitch: number; start: number; duration: number; velocity: number }> {
    if (guide.length === 0) return [];
    const sim = Math.max(0, Math.min(1, options.similarity));
    const den = Math.max(0, Math.min(1, options.density));
    const rng = (() => {
        let s = options.seed ?? ((Date.now() >>> 0) ^ 0x9e3779b9);
        return () => {
            s = (1664525 * s + 1013904223) >>> 0;
            return s / 0x100000000;
        };
    })();

    const range = options.register === "low" ? [36, 60] : options.register === "high" ? [67, 96] : [52, 76];
    const intervals = [3, 4, 7, 9, -3, -4, -5, 10];
    const out: Array<{ pitch: number; start: number; duration: number; velocity: number }> = [];
    const avgDur = guide.reduce((a, n) => a + Math.max(0.05, n.duration), 0) / guide.length;
    const delay = options.callResponse ? Math.min(0.5, Math.max(0.125, avgDur * 0.6)) : 0;

    for (let i = 0; i < guide.length; i++) {
        const g = guide[i];
        if (rng() > den) continue;
        let interval = intervals[i % intervals.length];
        if (rng() > sim) interval = intervals[Math.floor(rng() * intervals.length)];
        let p = g.pitch + interval;
        if (Math.abs(p - g.pitch) <= 1) p += 3;
        p = Math.max(range[0], Math.min(range[1], p));

        let start = g.start + delay;
        if (rng() > sim) {
            const offs = [-0.125, 0, 0.125, 0.25];
            start += offs[Math.floor(rng() * offs.length)] ?? 0;
        }
        start = Math.max(0, start);

        let duration = g.duration * (options.callResponse ? 0.75 : 0.9);
        if (rng() > sim) {
            const mult = [0.5, 0.75, 1, 1.25];
            duration *= mult[Math.floor(rng() * mult.length)] ?? 1;
        }
        duration = Math.max(0.05, duration);
        const velocity = Math.max(1, Math.min(127, Math.round(g.velocity * 0.88 + (rng() * 16 - 8))));

        out.push({ pitch: p, start, duration, velocity });
    }

    out.sort((a, b) => (a.start - b.start) || (a.pitch - b.pitch));
    const cleaned: Array<{ pitch: number; start: number; duration: number; velocity: number }> = [];
    for (const n of out) {
        if (cleaned.length === 0) {
            cleaned.push(n);
            continue;
        }
        const prev = cleaned[cleaned.length - 1];
        const prevEnd = prev.start + prev.duration;
        if (n.start < prevEnd) {
            if (n.velocity > prev.velocity) {
                prev.duration = Math.max(0.05, n.start - prev.start);
                cleaned.push(n);
            } else {
                cleaned.push({ ...n, start: prevEnd + 0.01 });
            }
        } else {
            cleaned.push(n);
        }
    }
    return cleaned;
}
