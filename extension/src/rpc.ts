// Minimal JSON-RPC 2.0 server over a loopback WebSocket. Mirrors the wire
// contract of m4l-bridge/src/bridge.js so the existing Python BridgeClient
// works unchanged.

import { WebSocketServer, type WebSocket } from "ws";

export type RpcMethod = (params: Record<string, unknown>) => unknown | Promise<unknown>;
export type RpcMethodTable = Record<string, RpcMethod>;

export interface RpcServerOptions {
    host: string;
    port: number;
    protocolVersion: string;
    methods: RpcMethodTable;
    onError?: (e: unknown) => void;
    onLog?: (msg: string) => void;
}

export interface RpcServer {
    close(): void;
}

interface JsonRpcRequest {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32000;

function rpcError(id: number | string | null | undefined, code: number, message: string): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code, message },
    });
}

export function startRpcServer(opts: RpcServerOptions): RpcServer {
    const wss = new WebSocketServer({ host: opts.host, port: opts.port });
    const log = opts.onLog ?? (() => { });
    const onError = opts.onError ?? (() => { });

    wss.on("listening", () => {
        log(`bridge listening on ws://${opts.host}:${opts.port}`);
    });

    wss.on("error", (e) => onError(e));

    wss.on("connection", (ws: WebSocket, req) => {
        const remote = req.socket.remoteAddress ?? "unknown";
        log(`client connected from ${remote}`);

        // Hello notification — clients can use this to detect the bridge
        // generation without an explicit ping.
        try {
            ws.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    method: "bridge.hello",
                    params: { protocol: opts.protocolVersion, ts: Date.now() },
                }),
            );
        } catch (e) {
            onError(e);
        }

        ws.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
            const raw = data.toString();
            let msg: JsonRpcRequest;
            try {
                msg = JSON.parse(raw) as JsonRpcRequest;
            } catch {
                ws.send(rpcError(null, PARSE_ERROR, "parse error"));
                return;
            }
            if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
                ws.send(rpcError(msg.id, INVALID_REQUEST, "invalid request"));
                return;
            }

            const isNotification = msg.id === undefined || msg.id === null;
            const fn = opts.methods[msg.method];
            if (!fn) {
                if (!isNotification) {
                    ws.send(rpcError(msg.id, METHOD_NOT_FOUND, `method not found: ${msg.method}`));
                }
                return;
            }
            try {
                const result = await fn(msg.params ?? {});
                if (isNotification) return;
                ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                if (isNotification) {
                    onError(e);
                    return;
                }
                ws.send(rpcError(msg.id, INTERNAL_ERROR, message));
            }
        });

        ws.on("error", (e) => onError(e));
    });

    return {
        close: () => {
            wss.close();
        },
    };
}
