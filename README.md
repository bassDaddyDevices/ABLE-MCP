# ABLE-MCP

Right-click MIDI and audio tools for Ableton Live 12, plus an MCP server for `.als` analysis and live bridge orchestration.

Two artifacts in one repo:

1. **AbleMCP.ablx** — a native Ableton Live 12 extension. Drag it in, right-click clips, get fast deterministic transformations and vocal-to-complement generation. No API key, no cloud dependency.
2. **`able-mcp` (Python)** — an MCP server for parsing and analyzing `.als` project files offline. Plug into Claude Desktop / VS Code / Cursor and ask questions about your sets.

## The extension (shipping in v0.2)

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
| ABLE-MCP: Variation | 30% chance per note: bump ±octave; 15% chance: drop the note. |
| ABLE-MCP: Octave double | Add a quieter octave-up layer. |
| ABLE-MCP: Humanize | Jitter timing ±0.05 beats and velocity ±10. |
| ABLE-MCP: Reverse | Mirror notes around the clip's midpoint in time. |
| ABLE-MCP: Invert (mirror) | Mirror pitch around the median note. |
| ABLE-MCP: Transpose +1 / ABLE-MCP: Transpose -1 | Semitone up / down. |
| ABLE-MCP: Legato | Extend each pitch's note to the next one's start. |
| ABLE-MCP: Staccato | Cut every note to 25% of its length. |
| ABLE-MCP: Thin (every other) | Drop every other note in time order. |
| ABLE-MCP: Double-time | Compress timing 2× and play the pattern twice. |
| ABLE-MCP: Half-time | Stretch to 2×; first half plays at half speed. |
| ABLE-MCP: Strum chords | Stagger simultaneous notes by 1/64 each (instant strum). |
| ABLE-MCP: Accent downbeats | Boost on-beat notes, duck off-beat. |
| ABLE-MCP: Top voice only | Keep the highest note of each chord. |
| ABLE-MCP: Bass voice (drop 8va) | Keep the lowest note of each chord, drop an octave. |
| ABLE-MCP: Shift… | Modal: shift notes by N beats and/or N semitones, with optional wrap-around. Quick-bump preset buttons for common values. |

Every action also works on **time-range selections in arrangement view** — right-click a selection across one or more MIDI tracks and pick `ABLE-MCP (range): …`. Only notes inside the range are transformed.

Right-click any **audio clip** in arrangement view:

| Action | What it does |
|---|---|
| ABLE-MCP: Chop into beats (1/4 bar) / 1/2 / 1 / 2 / 4 / 8 bars | Splits a long audio clip into adjacent cropped chunks without rewriting source audio. |
| ABLE-MCP: Snap first hit to bar | Detects first onset in WAV and repositions crop/start so the first hit lands on a downbeat. |
| ABLE-MCP: Create complementary MIDI from vocal... | Renders the clip range, extracts guide melody from audio, generates a complementary line, and writes a new arrangement MIDI clip (modal controls: similarity, density, register, call/response, seed, target track). |

Every action is a single Cmd-Z undo.

### Why it's fast

Core MIDI/audio actions are pure deterministic functions running in-process. Typical transform actions are near-instant and fully undoable. No LLM call is required for the shipping extension feature set.

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
| `midi_extract_vocal_guide(file_path, tempo_bpm, ...)` | Extract monophonic guide melody from vocal WAV. |
| `midi_generate_complement(guide_notes, ...)` | Generate complementary (not duplicated) MIDI line. |
| `midi_vocal_to_complement(file_path, tempo_bpm, ...)` | One-shot extraction + complement generation pipeline. |
| `live_arrangement_set_clip_notes(...)` | Replace notes in arrangement MIDI clip by index. |
| `live_vocal_to_complement_midi(...)` | Render audio range in Live, generate complement, create/write arrangement MIDI clip in one call. |

## Roadmap

- **v0.2.x** — tighten vocal-to-complement quality (better vibrato handling, stronger anti-unison controls, warped-clip timing support).
- **v0.3** — richer bridge orchestration tools (multi-clip workflows and arrangement/session interoperability).
- **v0.4** — expand deterministic composition primitives (scale quantize, swing, density, stutter, chord-tone targeting).

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
