// Persistent config for the extension (BYO LLM key, model preference, etc).
// Stored as JSON in __dirname/../config.json so it lives next to the bundle
// and survives Live restarts (but disappears if the user uninstalls the .ablx).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Provider = "anthropic" | "openai" | "google" | "ollama";

export interface Config {
    provider: Provider;
    apiKey: string;
    model: string;
    ollamaUrl?: string;
}

const DEFAULTS: Config = {
    provider: "anthropic",
    apiKey: "",
    model: "claude-sonnet-4-20250514",
    ollamaUrl: "http://localhost:11434",
};

function configPath(): string {
    // TODO(v2): pin to ~/Library/Application Support/Ableton/able-mcp.config.json
    // only. The current multi-candidate search returns different paths across
    // Live restarts because Live's Extension Host resolves __dirname to varying
    // sandbox paths — that's why the API key didn't persist between sessions.
    // Sit next to the installed bundle. extension.cjs lives in dist/.
    const candidates = [
        process.env.ABLE_MCP_CONFIG,
        typeof __dirname === "string" ? path.join(__dirname, "..", "config.json") : undefined,
        typeof __dirname === "string" ? path.join(__dirname, "config.json") : undefined,
        path.join(os.homedir(), "Library", "Application Support", "Ableton", "able-mcp.config.json"),
        path.join(os.homedir(), ".able-mcp.config.json"),
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    // Prefer first that already exists.
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* */ }
    }
    // Otherwise prefer first that's writable.
    for (const p of candidates) {
        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.accessSync(path.dirname(p), fs.constants.W_OK);
            return p;
        } catch { /* */ }
    }
    return candidates[candidates.length - 1] ?? "";
}

export function loadConfig(): Config {
    const p = configPath();
    if (!p) return { ...DEFAULTS };
    try {
        const raw = fs.readFileSync(p, "utf8");
        const j = JSON.parse(raw) as Partial<Config>;
        return {
            provider: (j.provider ?? DEFAULTS.provider) as Provider,
            apiKey: typeof j.apiKey === "string" ? j.apiKey : "",
            model: typeof j.model === "string" && j.model ? j.model : DEFAULTS.model,
            ollamaUrl: typeof j.ollamaUrl === "string" && j.ollamaUrl ? j.ollamaUrl : DEFAULTS.ollamaUrl,
        };
    } catch {
        return { ...DEFAULTS };
    }
}

export function saveConfig(cfg: Config): string {
    const p = configPath();
    if (!p) return "";
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
        return p;
    } catch (e) {
        console.error("[able-mcp] saveConfig:", e);
        return "";
    }
}

export function defaultModelFor(provider: Provider): string {
    switch (provider) {
        case "anthropic": return "claude-sonnet-4-20250514";
        case "openai": return "gpt-5-mini";
        case "google": return "gemini-2.5-flash";
        case "ollama": return "llama3.1:8b";
    }
}
