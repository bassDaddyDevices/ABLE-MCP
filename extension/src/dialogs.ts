// Modal dialogs shipped as inline data: URLs. The Extension Host's
// showModalDialog() loads the URL into a webview and waits for the page
// to post `{ method: "close_and_send", params: [resultString] }`.

const SHIFT_DIALOG_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Shift</title>
<style>
  html, body { background: #2b2b2b; color: #ddd; }
  body { font-family: -apple-system, system-ui, "Helvetica Neue", sans-serif; padding: 14px; margin: 0; font-size: 12px; }
  h2 { margin: 0 0 10px 0; font-size: 11px; color: #ff8c00; letter-spacing: 1px; font-weight: 600; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; min-width: 0; }
  label { display: block; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 8px; margin-bottom: 3px; }
  input[type=number] { width: 100%; background: #1c1c1c; color: #fff; border: 1px solid #444; padding: 5px 6px; box-sizing: border-box; font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
  input[type=number]:focus { outline: none; border-color: #ff8c00; }
  .presets { display: flex; gap: 3px; margin-top: 4px; flex-wrap: wrap; }
  .presets button { background: #3a3a3a; color: #ccc; border: 1px solid #555; padding: 2px 7px; cursor: pointer; font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
  .presets button:hover { background: #4a4a4a; color: #fff; }
  .checkrow { margin-top: 12px; font-size: 11px; color: #bbb; user-select: none; }
  .checkrow input { vertical-align: -2px; margin-right: 5px; }
  .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 14px; }
  .actions button { padding: 5px 14px; font-size: 11px; border: 1px solid #555; cursor: pointer; font-family: inherit; }
  .apply { background: #ff8c00; color: #000; border-color: #ff8c00; font-weight: 600; }
  .apply:hover { background: #ffa033; }
  .cancel { background: #3a3a3a; color: #ccc; }
  .cancel:hover { background: #4a4a4a; }
</style></head>
<body>
<h2>ABLE-MCP &middot; SHIFT NOTES</h2>
<div class="row">
  <div>
    <label>Time (beats)</label>
    <input type="number" id="time" step="0.0625" value="0">
    <div class="presets">
      <button data-t="-1">-1</button>
      <button data-t="-0.5">-1/2</button>
      <button data-t="-0.25">-1/4</button>
      <button data-t="-0.125">-1/8</button>
      <button data-t="0.125">+1/8</button>
      <button data-t="0.25">+1/4</button>
      <button data-t="0.5">+1/2</button>
      <button data-t="1">+1</button>
    </div>
  </div>
  <div>
    <label>Pitch (semitones)</label>
    <input type="number" id="pitch" step="1" value="0">
    <div class="presets">
      <button data-p="-12">-12</button>
      <button data-p="-7">-7</button>
      <button data-p="-5">-5</button>
      <button data-p="-2">-2</button>
      <button data-p="-1">-1</button>
      <button data-p="1">+1</button>
      <button data-p="2">+2</button>
      <button data-p="5">+5</button>
      <button data-p="7">+7</button>
      <button data-p="12">+12</button>
    </div>
  </div>
</div>
<label class="checkrow"><input type="checkbox" id="wrap" checked>Wrap notes around clip / range</label>
<div class="actions">
  <button class="cancel" id="btnCancel">Cancel</button>
  <button class="apply" id="btnApply">Apply</button>
</div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var t = $('time'), p = $('pitch'), w = $('wrap');
  function bump(input, by){ var v = parseFloat(input.value) || 0; input.value = (v + by); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-t]'), function(b){
    b.addEventListener('click', function(){ bump(t, parseFloat(b.getAttribute('data-t'))); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-p]'), function(b){
    b.addEventListener('click', function(){ bump(p, parseFloat(b.getAttribute('data-p'))); });
  });
  function post(resultString){
    var msg = { method: "close_and_send", params: [resultString] };
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) {
        window.webkit.messageHandlers.live.postMessage(msg); return;
      }
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(msg); return;
      }
    } catch(e) {}
  }
  function apply(){
    post(JSON.stringify({
      time: parseFloat(t.value) || 0,
      pitch: parseInt(p.value, 10) || 0,
      wrap: !!w.checked
    }));
  }
  function cancel(){ post(""); }
  $('btnApply').addEventListener('click', apply);
  $('btnCancel').addEventListener('click', cancel);
  document.addEventListener('keydown', function(e){
    if (e.key === 'Enter') apply();
    else if (e.key === 'Escape') cancel();
  });
  t.focus(); t.select();
})();
</script></body></html>`;

export function shiftDialogUrl(): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(SHIFT_DIALOG_HTML);
}

export interface ShiftParams {
  time: number;     // beats
  pitch: number;    // semitones
  wrap: boolean;
}

export function parseShiftResult(raw: string): ShiftParams | null {
  if (!raw) return null;
  try {
    const j: unknown = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    const o = j as Record<string, unknown>;
    const time = typeof o.time === "number" ? o.time : NaN;
    const pitch = typeof o.pitch === "number" ? o.pitch : NaN;
    if (!Number.isFinite(time) || !Number.isFinite(pitch)) return null;
    return { time, pitch: Math.round(pitch), wrap: !!o.wrap };
  } catch {
    return null;
  }
}

// --- Shared dialog chrome ----------------------------------------------

const COMMON_CSS = `
  html, body { background: #2b2b2b; color: #ddd; }
  body { font-family: -apple-system, system-ui, "Helvetica Neue", sans-serif; padding: 14px; margin: 0; font-size: 12px; }
  h2 { margin: 0 0 10px 0; font-size: 11px; color: #ff8c00; letter-spacing: 1px; font-weight: 600; }
  label { display: block; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 8px; margin-bottom: 3px; }
  input[type=text], input[type=password], input[type=url], select, textarea {
    width: 100%; background: #1c1c1c; color: #fff; border: 1px solid #444;
    padding: 5px 6px; box-sizing: border-box; font-size: 12px;
    font-family: ui-monospace, Menlo, monospace;
  }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #ff8c00; }
  textarea { resize: vertical; min-height: 60px; }
  .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 14px; }
  .actions button { padding: 5px 14px; font-size: 11px; border: 1px solid #555; cursor: pointer; font-family: inherit; }
  .apply { background: #ff8c00; color: #000; border-color: #ff8c00; font-weight: 600; }
  .apply:hover { background: #ffa033; }
  .cancel { background: #3a3a3a; color: #ccc; }
  .cancel:hover { background: #4a4a4a; }
  .hint { font-size: 10px; color: #777; margin-top: 4px; }
`;

const POST_JS = `
function ablePost(resultString){
  var msg = { method: "close_and_send", params: [resultString] };
  try {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) {
      window.webkit.messageHandlers.live.postMessage(msg); return;
    }
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage(msg); return;
    }
  } catch(e) {}
}
`;

// --- Settings dialog ----------------------------------------------------

function settingsHtml(currentJson: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ABLE-MCP Settings</title>
<style>${COMMON_CSS}</style></head><body>
<h2>ABLE-MCP &middot; SETTINGS</h2>
<label>Provider</label>
<select id="provider">
  <option value="anthropic">Anthropic (Claude)</option>
  <option value="openai">OpenAI (GPT)</option>
  <option value="google">Google (Gemini)</option>
  <option value="ollama">Ollama (local)</option>
</select>
<label>API key</label>
<input type="password" id="apiKey" placeholder="sk-..." autocomplete="off">
<div class="hint">Stored locally next to the extension. Not sent anywhere except the provider you pick. Leave blank for Ollama.</div>
<label>Model</label>
<input type="text" id="model" placeholder="claude-sonnet-4-...">
<label id="ollamaUrlLabel" style="display:none">Ollama URL</label>
<input type="url" id="ollamaUrl" placeholder="http://localhost:11434" style="display:none">
<div class="actions">
  <button class="cancel" id="btnCancel">Cancel</button>
  <button class="apply" id="btnSave">Save</button>
</div>
<script>${POST_JS}
(function(){
  var current = ${currentJson};
  var $ = function(id){ return document.getElementById(id); };
  var p = $('provider'), k = $('apiKey'), m = $('model');
  var ou = $('ollamaUrl'), oul = $('ollamaUrlLabel');
  var defaults = {
    anthropic: "claude-sonnet-4-20250514",
    openai:    "gpt-5-mini",
    google:    "gemini-2.5-flash",
    ollama:    "llama3.1:8b"
  };
  p.value = current.provider || "anthropic";
  k.value = current.apiKey || "";
  m.value = current.model || defaults[p.value];
  ou.value = current.ollamaUrl || "http://localhost:11434";
  function syncOllama(){
    var on = p.value === "ollama";
    oul.style.display = on ? "block" : "none";
    ou.style.display = on ? "block" : "none";
    k.disabled = on;
    k.placeholder = on ? "(not needed for Ollama)" : "sk-...";
  }
  p.addEventListener('change', function(){
    m.value = defaults[p.value] || "";
    syncOllama();
  });
  syncOllama();
  $('btnSave').addEventListener('click', function(){
    ablePost(JSON.stringify({
      provider: p.value,
      apiKey: k.value.trim(),
      model: m.value.trim() || defaults[p.value],
      ollamaUrl: ou.value.trim() || "http://localhost:11434"
    }));
  });
  $('btnCancel').addEventListener('click', function(){ ablePost(""); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') ablePost("");
  });
})();
</script></body></html>`;
}

export function settingsDialogUrl(currentConfig: unknown): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(settingsHtml(JSON.stringify(currentConfig)));
}

export interface SettingsResult {
  provider: string;
  apiKey: string;
  model: string;
  ollamaUrl?: string;
}

export function parseSettingsResult(raw: string): SettingsResult | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<SettingsResult>;
    if (typeof j.provider !== "string" || typeof j.model !== "string") return null;
    return {
      provider: j.provider,
      apiKey: typeof j.apiKey === "string" ? j.apiKey : "",
      model: j.model,
      ollamaUrl: typeof j.ollamaUrl === "string" ? j.ollamaUrl : undefined,
    };
  } catch { return null; }
}

// --- Ask dialog ---------------------------------------------------------

const ASK_DIALOG_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ask</title>
<style>${COMMON_CSS}
  .examples { font-size: 10px; color: #888; margin-top: 6px; line-height: 1.5; }
  .examples b { color: #aaa; cursor: pointer; }
  .examples b:hover { color: #ff8c00; }
</style></head><body>
<h2>ABLE-MCP &middot; ASK</h2>
<label>What should the AI do to these notes?</label>
<textarea id="prompt" placeholder="e.g. turn this into a shuffled garage UK groove" autofocus></textarea>
<div class="examples">
  Try:
  <b data-ex="turn this into a busier dnb pattern at 174 bpm feel">busier dnb feel</b> &middot;
  <b data-ex="reharmonize over a ii-V-I in C minor">reharmonize ii-V-I Cm</b> &middot;
  <b data-ex="add a counter melody an octave up that calls and responds">add counter-melody</b> &middot;
  <b data-ex="make this more sparse, ambient, leave space">make sparse</b>
</div>
<div class="actions">
  <button class="cancel" id="btnCancel">Cancel</button>
  <button class="apply" id="btnGo">Generate</button>
</div>
<script>${POST_JS}
(function(){
  var t = document.getElementById('prompt');
  Array.prototype.forEach.call(document.querySelectorAll('[data-ex]'), function(b){
    b.addEventListener('click', function(){ t.value = b.getAttribute('data-ex'); t.focus(); });
  });
  function go(){
    var v = t.value.trim();
    if (!v) { ablePost(""); return; }
    ablePost(JSON.stringify({ prompt: v }));
  }
  document.getElementById('btnGo').addEventListener('click', go);
  document.getElementById('btnCancel').addEventListener('click', function(){ ablePost(""); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go();
    else if (e.key === 'Escape') ablePost("");
  });
})();
</script></body></html>`;

export function askDialogUrl(): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(ASK_DIALOG_HTML);
}

export function parseAskResult(raw: string): { prompt: string } | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { prompt?: unknown };
    if (typeof j.prompt !== "string" || !j.prompt.trim()) return null;
    return { prompt: j.prompt };
  } catch { return null; }
}

// --- Vocal->MIDI complement dialog -------------------------------------

const VOCAL_COMPLEMENT_DIALOG_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Vocal Complement</title>
<style>${COMMON_CSS}
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; min-width: 0; }
  .checkrow { margin-top: 10px; font-size: 11px; color: #bbb; user-select: none; }
  .checkrow input { vertical-align: -2px; margin-right: 5px; }
</style></head><body>
<h2>ABLE-MCP &middot; VOCAL -> COMPLEMENT MIDI</h2>
<div class="row">
  <div>
    <label>Similarity (0..1)</label>
    <input type="text" id="similarity" value="0.55">
  </div>
  <div>
    <label>Density (0..1)</label>
    <input type="text" id="density" value="0.75">
  </div>
</div>
<div class="row">
  <div>
    <label>Register</label>
    <select id="register"><option value="low">Low</option><option value="mid" selected>Mid</option><option value="high">High</option></select>
  </div>
  <div>
    <label>Target MIDI track index (-1 = auto)</label>
    <input type="text" id="targetTrack" value="-1">
  </div>
</div>
<label class="checkrow"><input type="checkbox" id="callResponse" checked>Call & response timing offset</label>
<label>Seed (optional)</label>
<input type="text" id="seed" placeholder="leave blank for random behavior">
<div class="actions">
  <button class="cancel" id="btnCancel">Cancel</button>
  <button class="apply" id="btnApply">Generate</button>
</div>
<script>${POST_JS}
(function(){
  var $ = function(id){ return document.getElementById(id); };
  function apply(){
    ablePost(JSON.stringify({
      similarity: parseFloat($('similarity').value),
      density: parseFloat($('density').value),
      register: $('register').value,
      targetTrackIndex: parseInt($('targetTrack').value, 10),
      callResponse: !!$('callResponse').checked,
      seed: $('seed').value.trim() === '' ? null : parseInt($('seed').value, 10)
    }));
  }
  $('btnApply').addEventListener('click', apply);
  $('btnCancel').addEventListener('click', function(){ ablePost(''); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Enter') apply();
    else if (e.key === 'Escape') ablePost('');
  });
})();
</script></body></html>`;

export function vocalComplementDialogUrl(): string {
  return "data:text/html;charset=utf-8," + encodeURIComponent(VOCAL_COMPLEMENT_DIALOG_HTML);
}

export interface VocalComplementParams {
  similarity: number;
  density: number;
  register: "low" | "mid" | "high";
  targetTrackIndex: number;
  callResponse: boolean;
  seed: number | null;
}

export function parseVocalComplementResult(raw: string): VocalComplementParams | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const similarity = Number(j.similarity);
    const density = Number(j.density);
    const register = String(j.register ?? "mid");
    const targetTrackIndex = Number(j.targetTrackIndex);
    const seed = j.seed == null ? null : Number(j.seed);
    return {
      similarity: Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0.55,
      density: Number.isFinite(density) ? Math.max(0, Math.min(1, density)) : 0.75,
      register: register === "low" || register === "high" ? register : "mid",
      targetTrackIndex: Number.isFinite(targetTrackIndex) ? Math.trunc(targetTrackIndex) : -1,
      callResponse: Boolean(j.callResponse),
      seed: seed != null && Number.isFinite(seed) ? Math.trunc(seed) : null,
    };
  } catch {
    return null;
  }
}
