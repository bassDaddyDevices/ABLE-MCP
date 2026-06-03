// Stand-alone smoke test for the WS JSON-RPC server. Skips the SDK entirely —
// imports rpc.ts directly via tsx and exercises the wire protocol with a
// tiny method table. Run with: `node --import tsx tests/smoke.js`
//
// Doubles as the regression test for wire-compat with the Python BridgeClient.

import WebSocket from "ws";
import { startRpcServer } from "../src/rpc.ts";

const PORT = 9842; // avoid collision with a real bridge

const server = startRpcServer({
    host: "127.0.0.1",
    port: PORT,
    protocolVersion: "able-mcp/test",
    methods: {
        ping: () => ({ pong: true }),
        echo: (p) => ({ echoed: p }),
        boom: () => {
            throw new Error("kaboom");
        },
        "song.getTempo": () => ({ tempo: 120 }),
    },
    onLog: (m) => console.log("[srv]", m),
    onError: (e) => console.error("[srv]", e),
});

await new Promise((r) => setTimeout(r, 100));

function rpc(ws, id, method, params) {
    return new Promise((resolve, reject) => {
        const onMsg = (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id !== id) return; // ignore notifications like bridge.hello
            ws.off("message", onMsg);
            resolve(msg);
        };
        ws.on("message", onMsg);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        setTimeout(() => reject(new Error(`timeout: ${method}`)), 4000);
    });
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
let helloOk = false;
ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === "bridge.hello" && m.params?.protocol === "able-mcp/test") {
        helloOk = true;
    }
});
await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
});
// give the hello a moment to land
await new Promise((r) => setTimeout(r, 100));
if (!helloOk) throw new Error("missing bridge.hello notification");
console.log("bridge.hello ok");

const ping = await rpc(ws, 1, "ping");
if (!ping.result?.pong) throw new Error("ping failed");
console.log("ping ok");

const echo = await rpc(ws, 2, "echo", { x: 7 });
if (echo.result?.echoed?.x !== 7) throw new Error("echo failed");
console.log("echo ok");

const boom = await rpc(ws, 3, "boom");
if (boom.error?.code !== -32000 || !boom.error.message.includes("kaboom")) {
    throw new Error("boom failed: " + JSON.stringify(boom));
}
console.log("error mapping ok");

const unknown = await rpc(ws, 4, "no.such");
if (unknown.error?.code !== -32601) throw new Error("expected method not found");
console.log("method-not-found ok");

const tempo = await rpc(ws, 5, "song.getTempo");
if (tempo.result?.tempo !== 120) throw new Error("tempo failed");
console.log("song.getTempo ok");

ws.close();
server.close();
console.log("ALL SMOKE CHECKS PASSED");
process.exit(0);
