// Direct-from-extension LLM client. Called by the "Ask…" command when no
// MCP client is connected to the WS bridge. BYO API key.
//
// All providers are reduced to the same input/output: a JSON-only request
// where the model returns a transformation plan we can apply locally.

import type { Config } from "./config";

export interface AskInput {
    prompt: string;             // user's free-text ask
    notes: NoteShape[];         // current clip notes
    duration: number;           // clip / range length in beats
    tempo: number;
}

export interface NoteShape {
    pitch: number;
    startTime: number;
    duration: number;
    velocity?: number;
}

export interface AskResult {
    notes: NoteShape[];         // replacement notes
    explanation?: string;
}

const SYSTEM_PROMPT = `You are an assistant inside an Ableton Live extension. The user has a MIDI clip and asks you to transform it.

You receive: prompt, current notes (pitch 0-127, startTime in beats, duration in beats, velocity 1-127), clip duration in beats, song tempo.

Respond with ONLY a JSON object of this exact shape, no markdown, no prose, no code fences:
{"notes":[{"pitch":N,"startTime":N,"duration":N,"velocity":N}, ...], "explanation":"one short sentence"}

Constraints:
- All startTime + duration must fit in [0, clip duration].
- pitch in 0..127, velocity in 1..127.
- Return the FULL replacement set of notes (you are not patching, you are replacing).
- Keep musicality: don't return empty unless the user explicitly asks.`;

export async function askLLM(cfg: Config, input: AskInput): Promise<AskResult> {
    if (cfg.provider !== "ollama" && !cfg.apiKey) {
        throw new Error("No API key set. Open ABLE-MCP: Settings… and paste your key.");
    }
    const userMsg = JSON.stringify({
        prompt: input.prompt,
        duration: input.duration,
        tempo: input.tempo,
        notes: input.notes.map((n) => ({
            pitch: n.pitch,
            startTime: round(n.startTime, 4),
            duration: round(n.duration, 4),
            velocity: n.velocity ?? 100,
        })),
    });

    let raw: string;
    switch (cfg.provider) {
        case "anthropic": raw = await callAnthropic(cfg, userMsg); break;
        case "openai": raw = await callOpenAI(cfg, userMsg); break;
        case "google": raw = await callGoogle(cfg, userMsg); break;
        case "ollama": raw = await callOllama(cfg, userMsg); break;
    }
    return parseResult(raw);
}

function round(n: number, d: number): number {
    const m = Math.pow(10, d);
    return Math.round(n * m) / m;
}

function parseResult(raw: string): AskResult {
    const cleaned = stripFences(raw).trim();
    let obj: unknown;
    try {
        obj = JSON.parse(cleaned);
    } catch {
        // try to extract first {...} block
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("Model did not return JSON: " + cleaned.slice(0, 200));
        obj = JSON.parse(m[0]);
    }
    if (!obj || typeof obj !== "object") throw new Error("Model response not an object");
    const o = obj as Record<string, unknown>;
    if (!Array.isArray(o.notes)) throw new Error("Model response missing 'notes' array");
    const notes: NoteShape[] = [];
    for (const item of o.notes) {
        if (!item || typeof item !== "object") continue;
        const n = item as Record<string, unknown>;
        const pitch = typeof n.pitch === "number" ? Math.round(n.pitch) : NaN;
        const startTime = typeof n.startTime === "number" ? n.startTime : NaN;
        const duration = typeof n.duration === "number" ? n.duration : NaN;
        const velocity = typeof n.velocity === "number" ? Math.round(n.velocity) : 100;
        if (!Number.isFinite(pitch) || !Number.isFinite(startTime) || !Number.isFinite(duration)) continue;
        if (pitch < 0 || pitch > 127) continue;
        if (duration <= 0) continue;
        notes.push({
            pitch,
            startTime: Math.max(0, startTime),
            duration: Math.max(0.01, duration),
            velocity: Math.max(1, Math.min(127, velocity)),
        });
    }
    const explanation = typeof o.explanation === "string" ? o.explanation : undefined;
    return { notes, explanation };
}

function stripFences(s: string): string {
    return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
}

async function callAnthropic(cfg: Config, userMsg: string): Promise<string> {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": cfg.apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: cfg.model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMsg }],
        }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const j = await r.json() as { content?: Array<{ type: string; text?: string }> };
    const text = j.content?.find((c) => c.type === "text")?.text ?? "";
    return text;
}

async function callOpenAI(cfg: Config, userMsg: string): Promise<string> {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            model: cfg.model,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
        }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return j.choices?.[0]?.message?.content ?? "";
}

async function callGoogle(cfg: Config, userMsg: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: userMsg }] }],
            generationConfig: { responseMimeType: "application/json" },
        }),
    });
    if (!r.ok) throw new Error(`Google ${r.status}: ${await r.text()}`);
    const j = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callOllama(cfg: Config, userMsg: string): Promise<string> {
    const base = cfg.ollamaUrl ?? "http://localhost:11434";
    const r = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: cfg.model,
            stream: false,
            format: "json",
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMsg },
            ],
        }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
    const j = await r.json() as { message?: { content?: string } };
    return j.message?.content ?? "";
}
