# ABLE-MCP

Right-click MIDI tools for Ableton Live 12, plus an MCP server for `.als` analysis.

Two artifacts in one repo:

1. **AbleMCP.ablx** — a native Ableton Live 12 extension. Drag it in, right-click any MIDI clip, get 17 instant transformations. No Python, no LLM, no API key, no internet, no waiting.
2. **`able-mcp` (Python)** — an MCP server for parsing and analyzing `.als` project files offline. Plug into Claude Desktop / VS Code / Cursor and ask questions about your sets.

## The extension (ship target for v0.1.0)

Built on `@ableton-extensions/sdk` 1.0.0-beta.0. Runs inside Live's own process — not Max for Live. Tested on Live 12.4.5b3.

### Install

1. Download `dist/AbleMCP.ablx`
2. Open Live → **Settings → Library → Extensions**
3. Drag the `.ablx` file in
4. Restart Live

### What you get

Right-click any MIDI clip (session or arrangement) → **ABLE-MCP** menu:

| Action | What it does |
|---|---|
| Variation | 30% chance per note: bump ±octave; 15% chance: drop the note. |
| Octave double | Add a quieter octave-up layer. |
| Humanize | Jitter timing ±0.05 beats and velocity ±10. |
| Reverse | Mirror notes around the clip's midpoint in time. |
| Invert (mirror) | Mirror pitch around the median note. |
| Transpose +1 / -1 | Semitone up / down. |
| Legato | Extend each pitch's note to the next one's start. |
| Staccato | Cut every note to 25% of its length. |
| Thin (every other) | Drop every other note in time order. |
| Double-time | Compress timing 2× and play the pattern twice. |
| Half-time | Stretch to 2×; first half plays at half speed. |
| Strum chords | Stagger simultaneous notes by 1/64 each (instant strum). |
| Accent downbeats | Boost on-beat notes, duck off-beat. |
| Top voice only | Keep the highest note of each chord. |
| Bass voice (drop 8va) | Keep the lowest note of each chord, drop an octave. |
| **Shift…** | Modal: shift notes by N beats and/or N semitones, with optional wrap-around. Quick-bump preset buttons for common values. |

Every action also works on **time-range selections in arrangement view** — right-click a selection across one or more MIDI tracks and pick `ABLE-MCP (range): …`. Only notes inside the range are transformed.

Every action is a single Cmd-Z undo.

### Why it's fast

These are pure deterministic functions running in-process. Typical action: **~1ms**. No LLM call, no JSON round-trip, no network, no cost per click. The intelligence lives in the transform, not in a chat window.

### Building from source

```sh
cd extension
npm install
npm run build      # tsc + esbuild → dist/extension.cjs
npm run package    # → ../dist/AbleMCP.ablx
```

## The MCP server

Python 3.11, stdio transport. Parses Live's gzipped `.als` files and exposes structure as MCP tools. Useful when you want an LLM to read a project without opening Live.

### Install

```sh
uv sync
```

### Run

```sh
uv run able-mcp
```

### Hook into a client

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "able-mcp": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/ABLE-MCP", "run", "able-mcp"]
    }
  }
}
```

**VS Code (Copilot Chat)** — your user or workspace `mcp.json`:

```json
{
  "servers": {
    "able-mcp": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/ABLE-MCP", "run", "able-mcp"]
    }
  }
}
```

### Tools

| Tool | What it does |
|------|--------------|
| `als_summary(path)` | Tempo, time sig, track/clip/note counts, master-bus state. |
| `als_list_tracks(path)` | Per-track kind, name, mute/solo, device & clip counts. |
| `als_list_clips(path, track_index?)` | Clip metadata across one or all tracks. |
| `als_extract_midi(path, track_index, clip_index)` | Note-level MIDI dump. |
| `als_find_unfinished(path)` | Heuristic suggestions for things that look incomplete. |

## Roadmap

- **v0.2** — bring back the Ask-AI flow with persisted API key (Anthropic / OpenAI / Google / Ollama). The scaffolding is already in [extension/src/llm.ts](extension/src/llm.ts) and [extension/src/config.ts](extension/src/config.ts), pulled from v1 to keep the release tight.
- **v0.3** — extension ↔ MCP-server bridge. The extension already runs a localhost WebSocket JSON-RPC server on `127.0.0.1:9831`; the Python side just needs to consume it for read/write tools.
- **v0.4** — audio-clip primitives (the `audioclipactions.ts` + `wav.ts` work is in tree, gated off until the chop-on-arrangement bug is solved).

## Develop

```sh
uv run pytest         # Python tests
uv run ruff check .   # Python lint
```

Python tests use synthetic `.als` fixtures (gzipped XML) generated in [tests/fixtures/__init__.py](tests/fixtures/__init__.py). When a real Live 12 file becomes available, drop it under `tests/fixtures/real/` and add parity tests — the parser is best-effort against an undocumented schema.

## Supply-chain hygiene

- `uv.lock` is committed; review every diff.
- All Python deps pinned with `==`.
- The extension has exactly one runtime dep (`@ableton-extensions/sdk`), pinned in [extension/package.json](extension/package.json).

## License

MIT (extension and Python server).
