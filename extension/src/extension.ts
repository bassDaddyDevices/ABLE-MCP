// ABLE-MCP extension entry. Activates inside Live's Extension Host, spins up a
// loopback WebSocket JSON-RPC server on 127.0.0.1:9831, and translates RPC
// calls into typed Ableton SDK operations.
//
// Wire-compatible with the legacy m4l-bridge: the Python BridgeClient does
// not need any changes.

import {
    initialize,
    type ActivationContext,
    type ExtensionContext,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startRpcServer, type RpcServer } from "./rpc";
import { buildMethods } from "./methods";
import { registerMidiClipActions } from "./midiclipactions";
// Audio actions are disabled in v1 (MIDI-only). Keep import path commented
// for easy resurrection in v2.
// import { registerAudioClipActions } from "./audioclipactions";

// Find a writable place to log. The Extension Host is sandboxed, so we try
// a few candidates and use the first one we can write to.
function pickLogPath(): string {
    const candidates = [
        process.env.ABLE_MCP_LOG,
        // __dirname points at dist/ inside the installed bundle.
        typeof __dirname === "string" ? path.join(__dirname, "able-mcp.log") : undefined,
        path.join(os.homedir(), "Library", "Application Support", "Ableton", "able-mcp.log"),
        path.join(os.homedir(), "Desktop", "able-mcp.log"),
        path.join(os.homedir(), "able-mcp.log"),
        path.join(os.tmpdir(), "able-mcp.log"),
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    for (const p of candidates) {
        try {
            fs.appendFileSync(p, `[${new Date().toISOString()}] [boot] log path = ${p}\n`);
            return p;
        } catch {
            // try the next one
        }
    }
    return ""; // no writable path
}
const LOG_PATH = pickLogPath();
function bootLog(msg: string): void {
    if (!LOG_PATH) return;
    try {
        fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [boot] ${msg}\n`);
    } catch {
        /* ignore */
    }
}
bootLog(`module loaded; pid=${process.pid} home=${os.homedir()} dirname=${typeof __dirname === "string" ? __dirname : "<undef>"}`);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9831;
const PROTOCOL_VERSION = "able-mcp/0.2-ext";

let server: RpcServer | null = null;

export function activate(activation: ActivationContext): void {
    bootLog("activate() called");
    const context = initialize(activation, "1.0.0") as ExtensionContext<"1.0.0">;

    const host = process.env.ABLE_MCP_BRIDGE_HOST ?? DEFAULT_HOST;
    const port = Number(process.env.ABLE_MCP_BRIDGE_PORT ?? DEFAULT_PORT);

    const methods = buildMethods(context, PROTOCOL_VERSION);

    server = startRpcServer({
        host,
        port,
        protocolVersion: PROTOCOL_VERSION,
        methods,
        onError: (e) => console.error("[able-mcp] rpc:", e),
        onLog: (m) => console.log("[able-mcp]", m),
    });

    // The Extension Host has no documented `deactivate` hook in beta.0. We at
    // least try to release the port on process exit so a Live restart doesn't
    // leak a listener.
    const shutdown = (): void => {
        if (server) {
            try {
                server.close();
            } catch (e) {
                console.error("[able-mcp] shutdown error:", e);
            }
            server = null;
        }
    };
    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    context.commands.registerCommand("able-mcp.ping", () => {
        console.log("[able-mcp] manual ping triggered");
    });

    // Register context-menu actions so Live keeps the Extension Host alive
    // when our extension is installed normally (without Developer Mode).
    // Without at least one UI hook, Live unloads the host shortly after
    // activation, taking the WS bridge down with it.
    // void registerAudioClipActions(context); // disabled for v1 (MIDI-only)
    void registerMidiClipActions(context);
}

async function registerContextMenus(
    context: ExtensionContext<"1.0.0">,
): Promise<void> {
    const scopes = [
        "AudioTrack",
        "MidiTrack",
        "ClipSlot",
        "Scene",
    ] as const;
    for (const scope of scopes) {
        try {
            await context.ui.registerContextMenuAction(
                scope,
                "ABLE-MCP: bridge status",
                "able-mcp.ping",
            );
        } catch (e) {
            console.error(`[able-mcp] register ${scope} menu failed:`, e);
        }
    }
}
