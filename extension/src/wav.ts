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
