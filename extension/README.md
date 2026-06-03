# ABLE-MCP Ableton Extension (`.ablx`)

This is the official **Ableton Extension API 1.0** bridge for ABLE-MCP. It runs
inside Live's Extension Host (Node 22) and exposes a WebSocket JSON-RPC 2.0
server that the Python MCP server connects to.

It is the recommended bridge for Live 12 with the Extensions feature enabled.
The legacy [Max for Live bridge](../m4l-bridge/README.md) remains available for
older setups and for transport-control workflows.

## Wire protocol

- Endpoint: `ws://127.0.0.1:9831` (override with `ABLE_MCP_BRIDGE_HOST` /
  `ABLE_MCP_BRIDGE_PORT` env vars in Live).
- On connect the server sends a notification:
  `{"jsonrpc":"2.0","method":"bridge.hello","params":{"protocol":"able-mcp/0.2-ext","version":"0.1.0"}}`
- Identical method names to the M4L bridge so the Python `BridgeClient` is
  unchanged.

## Methods

Stable across both bridges:

- `ping`
- `song.getTempo`, `song.setTempo`
- `song.getState` (transport fields are `null` in the extension; see below)
- `song.listTracks`
- `track.create` (the M4L `index` arg is rejected — extension always appends)
- `track.delete`, `track.rename`
- `clip.createMidi` (session slot only; `index` arg rejected)
- `clip.setNotes` (replaces all notes — server normalizes input)
- `clip.delete`

Extension-only (not in the M4L bridge):

- `audio.import` — import a WAV/AIFF into the project, place in session slot
  or arrangement
- `audio.renderTrack` — render pre-FX audio of an arrangement track to WAV
- `arrangement.createMidiClip` — create empty MIDI clip in arrangement
- `scene.create`
- `env.info` — storage/temp dirs, Live UI language

Not supported by the SDK 1.0 beta (the methods exist but return JSON-RPC error
`-32000`):

- Transport: `transport.isPlaying`, `transport.play`, `transport.stop`,
  `transport.continue`
- View selection: `view.getSelection`
- `song.undo`, `song.redo` (the SDK auto-undoes mutations and groups them via
  `withinTransaction`)

Use the M4L bridge for those workflows until the API exposes them.

## Build

Requires Node 22+ and `npm`. The Ableton SDK and CLI tarballs in
`../extensions-sdk-1.0.0-beta.0/` are loaded via `file:` deps; no SDK access
to npm registry is needed.

```bash
cd extension
npm install
npm run build         # dev bundle with sourcemaps -> dist/extension.cjs
npm run build:prod    # minified bundle
npm run package       # production build + ../dist/AbleMCP.ablx
```

`npm audit` should report **0 vulnerabilities**. We pin `ws` ≥ 8.21.0 and
`tsx` ≥ 4.22.4 to clear known CVEs.

## Smoke test (no Live required)

`tests/smoke.js` boots the same `RpcServer` on port 9842 with stub methods
and round-trips: `bridge.hello`, `ping`, error mapping, method-not-found, and
a fake `song.getTempo`.

```bash
npm run smoke
```

## Install in Live

1. Copy `dist/AbleMCP.ablx` to Live's Extensions directory (see Live's
   "Extensions" preference page for the platform-specific path).
2. Restart Live. The extension activates automatically.
3. Live's Extension log should show `bridge listening on ws://127.0.0.1:9831`.
4. From the Python side, run the `live_check_bridge` MCP tool — you should see
   `protocol: "able-mcp/0.2-ext"`.

## Environment variables (read at activation)

- `ABLE_MCP_BRIDGE_HOST` (default `127.0.0.1`)
- `ABLE_MCP_BRIDGE_PORT` (default `9831`)

Bind to localhost only. The bridge has no authentication; do not expose it on
a network interface.

## Layout

```
extension/
  manifest.json        # Ableton extension manifest
  package.json
  tsconfig.json
  build.ts             # esbuild bundler (CJS, node22, all deps inlined)
  src/
    extension.ts       # activate() entry point
    rpc.ts             # WebSocket JSON-RPC 2.0 server
    methods.ts         # SDK-typed method implementations
  tests/
    smoke.js           # offline wire-protocol smoke test
```
