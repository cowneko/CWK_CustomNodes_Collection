/**
 * CWK LoRA Loader — frontend node extension.
 *
 * Theming:
 * - Title bar / node background come from node.color / node.bgcolor; they are
 *   re-asserted in onConfigure so old workflows can't restore grey defaults.
 * - The body is painted flat in onDrawBackground (fill only) and the
 *   interactive list is a DOM overlay positioned from the exact canvas
 *   transform captured while drawing the node.
 *
 * The native "lora_config" widget stays a fully serialisable, *normal* widget
 * (never hidden — hidden widgets can be dropped from the queue prompt by
 *   newer frontends) but renders nothing and takes no layout space:
 *   - canvas side:  draw = noop, computeSize = [0, -4]
 *   - DOM side:     the multiline element is hidden via the
 *                   .cwk-lora-dom-hidden { display:none !important } rule
 *                   from injectLoraStyles.
 *
 * Ghost / imprint prevention (tab switches, workflow loads): a node's own
 * "graph" reference can go stale, so visibility is decided by, in order:
 *   1. the node was drawn within the last RECENT_MS  → on canvas (ground truth)
 *   2. any known node container (canvas visible list / graph node array —
 *      property names vary between litegraph builds) must contain the node
 *   3. fallback: node.graph identity only
 * Hidden overlays park their rAF loop after ~10 s (onDrawBackground re-arms
 * it), fully detached nodes are destroyed after the same grace.
 *
 * Minimum node size (MIN_W × dots + MIN_H_EXTRA) is enforced in onResize
 * (resize drags), computeSize (auto-fit), onDrawBackground and the loop.
 *
 * Widget rows: [✓] [LoRA dropdown — grouped by base model] [ℹ info]
 *              [◀ weight ▶]  (or  [M ◀ ▶][C ◀ ▶] with separate weights)
 *              [✕]
 * Header: master activate/deactivate toggle, LoRA count, ⚙ settings (fold),
 *         🔎 Browser, ＋ Add LoRA.
 *
 * ⚙ Settings — foldable inline panel (same interaction model as CWK Save
 * Image's ▲ settings fold), global and persisted server-side via
 * /cwk/loras/settings (lora_settings.json):
 *   - Default strength for new LoRAs  (default 1)
 *   - Strength step                   (default 0.05 — stepper increment)
 *   - Keep all LoRAs loaded in memory (default off — server-side RAM cache)
 *   - Truncate LoRA names             (default off — display only; the widget
 *     value always keeps the full relative path so loading never breaks)
 *   - Separate LoRA/CLIP weights      (default off — two steppers per row,
 *     serialised as model_weight + clip_weight instead of weight)
 *   - Trigger words separator         (default "," — joins the STRING output)
 */

import { app } from "../../scripts/app.js";
import { getLoraBrowser, injectLoraStyles, getTriggersFor, triggerCache }
  from "./cwk_lora_panel.js";
import { getBaseModelMatchers } from "./cwk_base_models.js";

const CANONICAL_NAME = "CWK_LorA_Loader";
const LEGACY_NAME    = "CWK_LorA_Prompt_Loader";   // only used by the load remap below
const LORA_NODES     = [CANONICAL_NAME];

const COLORS = {
  title: "#141824",   // title bar (node.color) — the strip at the very top
  body:  "#1A1F2E",   // everything below it (node.bgcolor + canvas paint + DOM overlay)
};

const ZOOM_HIDE   = 0.35;   // hide overlay below this zoom level
const RECENT_MS   = 300;    // "drawn within this window" = on canvas, ground truth
const PARK_FRAMES = 600;    // ~10 s hidden → park the loop / destroy if detached
const MIN_W       = 440;    // minimum node width (canvas space)
const MIN_H_EXTRA = 180;    // minimum body height below the dots
const ROUND_R     = 8;      // body corner radius (matches ComfyUI's)

function _fmt(v) { return (Math.round(v * 100) / 100).toFixed(2); }

let _probeLogged = false;   // one-time environment diagnostic

// ─── Installed-LoRA list + shared settings (row dropdowns & ⚙ fold) ──────────

let _loraList     = null;   // [{name, base_model, civitai}] from /cwk/loras
let _loraNames    = null;   // derived: names only (kept for legacy references)
let _loraNamesAt  = 0;
let _loraSettings = null;
let _baseMatchers = null;   // canonical base-model matchers (cwk_base_models.js)

async function ensureLoraSettings() {
  if (_loraSettings) return _loraSettings;
  try {
    const r = await fetch("/cwk/loras/settings");
    if (r.ok) _loraSettings = await r.json();
  } catch {}
  _loraSettings ??= {
    default_strength: 1, strength_step: 0.05,
    keep_in_memory: false, truncate_names: false,
    separate_weights: false, trigger_separator: ",",
  };
  return _loraSettings;
}

async function ensureBaseMatchers() {
  if (!_baseMatchers) {
    try { _baseMatchers = await getBaseModelMatchers(); } catch {}
    _baseMatchers = Array.isArray(_baseMatchers) ? _baseMatchers : [];
  }
  return _baseMatchers;
}

async function ensureLoraNames(force = false) {
  if (!force && _loraList && (Date.now() - _loraNamesAt) < 30000) {
    await ensureBaseMatchers();
    return _loraList;
  }
  try {
    const res = await fetch("/cwk/loras");
    if (res.ok) {
      _loraList     = await res.json();
      _loraNames    = _loraList.map(l => l.name);
      _loraNamesAt  = Date.now();
      _loraList.forEach(l => {
        if (l.civitai?.trigger_words?.length) {
          triggerCache.set(l.name, l.civitai.trigger_words);
        }
      });
    }
  } catch {}
  await ensureBaseMatchers();
  return _loraList ?? [];
}

/** Same bucketing rule as the browser panel's type filter: a LoRA belongs to
 *  the first matcher whose keywords appear in its resolved base_model string
 *  (custom → CivitAI → safetensors metadata, resolved server-side); anything
 *  else (including empty) → "Others". */
function _bucketFor(raw) {
  const r = String(raw ?? "").trim().toLowerCase();
  if (!r) return "Others";
  for (const f of _baseMatchers ?? []) {
    if (Array.isArray(f.match)
        && f.match.some(s => r.includes(String(s).toLowerCase()))) {
      return f.label;
    }
  }
  return "Others";
}

/** [ [groupLabel, [loras…]], … ] — groups alphabetical, "Others" pinned last,
 *  entries alphabetical inside each group. */
function _groupedLoras() {
  const groups = new Map();
  for (const l of (_loraList ?? [])) {
    const base = (l.base_model ?? l.civitai?.base_model ?? "").trim() || "Others";
    const g    = _bucketFor(base);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "Others") - (b[0] === "Others")
                  || a[0].localeCompare(b[0]))
    .map(([g, items]) => [g, items.sort((a, b) => a.name.localeCompare(b.name))]);
}

/** Display-only truncation — the widget value always keeps the full path. */
function _displayName(n) {
  return _loraSettings?.truncate_names
    ? n.split("/").pop().replace(/\.[^.]+$/, "")
    : n;
}

// ─── ⚙ gear button + fold panel + stepper styles ────────────────────────────

function injectLoraSettingsStyles() {
  if (document.getElementById("cwk-lora-gear-styles")) return;
  const st = document.createElement("style");
  st.id = "cwk-lora-gear-styles";
  st.textContent = `
    .cwk-lora-widget .cwkl-w-gear {
      background: transparent; border: none; cursor: pointer;
      color: #6c7086; font-size: 14px; line-height: 1;
      padding: 2px 5px; border-radius: 4px;
    }
    .cwk-lora-widget .cwkl-w-gear:hover,
    .cwk-lora-widget .cwkl-w-gear.open {
      color: #fff; background: rgba(255,255,255,.12);
    }

    /* ── Foldable settings panel (inline, like CWK Save Image's ▲ fold) ── */
    .cwk-lora-widget .cwkl-w-settings {
      display: flex; flex-direction: column; gap: 6px;
      margin: 0 9px; padding: 8px 9px;
      background: rgba(0,0,0,.28);
      border-bottom: 1px solid #2a2f45;
      flex-shrink: 0; font-size: 11px; color: #c7cede;
    }
    .cwk-lora-widget .cwkl-w-set-row {
      display: flex; align-items: center; gap: 8px;
    }
    .cwk-lora-widget .cwkl-w-set-row > span:first-child { flex: 1; }
    .cwk-lora-widget .cwkl-w-set-row input[type="number"],
    .cwk-lora-widget .cwkl-w-set-row input[type="text"] {
      width: 64px; padding: 2px 5px; font-size: 11px;
      background: #141824; color: #e8ecf4;
      border: 1px solid rgba(255,255,255,.14); border-radius: 4px;
      outline: none; box-sizing: border-box;
    }
    .cwk-lora-widget .cwkl-w-set-row input[type="text"] { width: 72px; }
    .cwk-lora-widget .cwkl-w-set-chk {
      display: flex; align-items: center; gap: 7px; cursor: pointer;
      user-select: none;
    }

    /* ── Double-arrow stepper widget (weights) ────────────────────────── */
    .cwk-lora-widget .cwkl-w-step {
      display: flex; align-items: center; flex-shrink: 0;
    }
    .cwk-lora-widget .cwkl-w-stepbtn {
      background: #313552; color: #cdd6f4; border: none;
      width: 20px; height: 20px; border-radius: 4px; cursor: pointer;
      font-size: 9px; line-height: 1; padding: 0;
      display: flex; align-items: center; justify-content: center;
      transition: filter .12s;
    }
    .cwk-lora-widget .cwkl-w-stepbtn:hover { filter: brightness(1.35); }
    .cwk-lora-widget .cwkl-w-stepbtn:active { filter: brightness(1.6); }
    .cwk-lora-widget .cwkl-w-stepval {
      width: 44px; height: 20px; box-sizing: border-box;
      text-align: center; font-size: 11px; color: #89b4fa;
      background: #1e2335; border: 1px solid #313552;
      border-radius: 4px; outline: none; margin: 0 3px;
    }
    .cwk-lora-widget .cwkl-w-stepval:focus { border-color: #89b4fa; }
    .cwk-lora-widget .cwkl-w-wlab {
      font-size: 10px; color: #6c7086; font-weight: 700;
      margin: 0 2px 0 4px; flex-shrink: 0;
    }
  `;
  document.head.appendChild(st);
}

// ─── Live registry: all open LoRA Loader nodes (cross-node sync) ─────────────

const _activeLoraNodes = new Set();

function _rerenderAllLoraNodes() {
  for (const n of _activeLoraNodes) {
    try { n.__cwkLoraRerender?.(); } catch {}
    try { n.__cwkLoraSyncSettingsUI?.(); } catch {}
  }
}

// ─── Node-container probes (names vary between litegraph builds) ─────────────

function _canvasVisibleNodes() {
  return app.canvas?.visible_nodes ?? app.canvas?.visibleNodes ?? null;
}

function _graphNodeList(g) {
  return g?._nodes_in_order ?? g?._nodesInOrder ?? g?._nodes ?? g?.nodes ?? null;
}

function _activeGraph() {
  return app.canvas?.graph ?? app.graph ?? null;
}

// ─── Extension ───────────────────────────────────────────────────────────────

app.registerExtension({
  name: "CWK.LoraLoader",

  init() {
    // OPTIONAL legacy compat: workflows saved with the old node name are
    // rewritten to the canonical one before the graph is configured. Delete
    // this whole init() block if you no longer have such workflows.
    const orig = app.loadGraphData;
    if (typeof orig !== "function") return;
    app.loadGraphData = function (data, ...rest) {
      try {
        if (Array.isArray(data?.nodes)) {
          for (const n of data.nodes) {
            if (n?.type === LEGACY_NAME) n.type = CANONICAL_NAME;
          }
        }
      } catch {}
      return orig.apply(this, [data, ...rest]);
    };
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!LORA_NODES.includes(nodeData?.name)) return;
    injectLoraStyles();           // panel + node-overlay CSS (incl. .cwk-lora-dom-hidden)
    injectLoraSettingsStyles();   // ⚙ gear + fold panel + steppers

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      if (!this.__cwkLoraInit) {
        this.__cwkLoraInit = true;
        _setupLoraNode(this);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      try {
        // re-assert the palette after configure() restored saved properties
        this.color   = COLORS.title;
        this.bgcolor = COLORS.body;

        let v;
        const vals = info?.widgets_values;
        if (Array.isArray(vals))                    v = vals[0];
        else if (vals && typeof vals === "object") v = vals.lora_config;
        if (v === undefined || v === null) {
          v = this.widgets?.find(w => w.name === "lora_config")?.value;
        }
        if (v !== undefined && v !== null) {
          this.__cwkLoraApplyJson?.(typeof v === "string" ? v : JSON.stringify(v));
        }
      } catch {}
      return r;
    };

    // ComfyUI's removal hook…
    const onNodeRemoved = nodeType.prototype.onNodeRemoved;
    nodeType.prototype.onNodeRemoved = function () {
      const r = onNodeRemoved?.apply(this, arguments);
      try { this.__cwkLoraDestroy?.(); } catch {}
      return r;
    };

    // …and litegraph's native one (graph.remove / graph.clear).
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      try { this.__cwkLoraDestroy?.(); } catch {}
      return r;
    };
  },
});

// ─── Node setup ──────────────────────────────────────────────────────────────

function _setupLoraNode(node) {
  const state = { list: [], destroyed: false };
  let lastJson     = null;
  let announced    = false;
  let overlay      = null;
  let ctxTransform = null;   // exact canvas matrix captured while drawing the node
  let lastDrawnAt  = 0;      // performance.now() of the last onDrawBackground call

  let cfgWidget = node.widgets?.find(w => w.name === "lora_config") ?? null;

  // ── CWK theme on the canvas node itself ───────────────────────────────────
  node.color   = COLORS.title;
  node.bgcolor = COLORS.body;
  try { node.setDirtyCanvas(true, true); } catch {}

  // ── Layout metrics: DOM starts below all connection dots ──────────────────
  const metrics = () => {
    const LG = window.LiteGraph || {};
    const titleH = LG.NODE_TITLE_HEIGHT || 30;
    const slotH  = LG.NODE_SLOT_HEIGHT  || 20;
    const rows   = Math.max(node.inputs?.length ?? 0, node.outputs?.length ?? 0, 1);
    return { titleH, domY: titleH + rows * slotH + 6 };   // 6px gap below the dots
  };

  // ── Size clamps (single source of truth for the minimum) ──────────────────
  function _clampSize() {
    const { domY } = metrics();
    if (node.size[0] < MIN_W)              node.size[0] = MIN_W;
    if (node.size[1] < domY + MIN_H_EXTRA) node.size[1] = domY + MIN_H_EXTRA;
  }
  node.__cwkClampSize = _clampSize;

  const prevOnResize = node.onResize;
  node.onResize = function () {
    try { _clampSize(); } catch {}
    return prevOnResize?.apply(this, arguments);
  };

  const prevComputeSize = node.computeSize?.bind(node);
  node.computeSize = function (...args) {
    const s = prevComputeSize ? prevComputeSize(...args) : [0, 0];
    const { domY } = metrics();
    s[0] = Math.max(s[0] ?? 0, MIN_W);
    s[1] = Math.max(s[1] ?? 0, domY + MIN_H_EXTRA);
    return s;
  };

  // ── Native widget: fully serialisable, but invisible ──────────────────────
  function _hideNativeWidgetElement() {
    // Multiline STRING widgets are DOM widgets: a real element positioned over
    // the canvas. draw/computeSize can't hide it — hide the element itself.
    const el = cfgWidget?.element;
    if (el && !el.classList.contains("cwk-lora-dom-hidden")) {
      el.classList.add("cwk-lora-dom-hidden");
      el.style.display = "none";
    }
  }

  function _prepareJsonWidget() {
    cfgWidget = cfgWidget || node.widgets?.find(w => w.name === "lora_config") || null;
    if (!cfgWidget) return;
    cfgWidget.origComputeSize ??= cfgWidget.computeSize;
    cfgWidget.origDraw        ??= cfgWidget.draw;
    // NOT hidden and type stays "STRING": fully serialisable in every queue
    // prompt. Renders nothing and takes no space — the DOM overlay is its UI.
    cfgWidget.computeSize    = () => [0, -4];
    cfgWidget.draw           = () => {};
    cfgWidget.serializeValue = () => JSON.stringify(state.list);
    _hideNativeWidgetElement();
  }

  function _markDirty() {
    try { node.setDirtyCanvas(true, true); }
    catch { try { app.canvas?.setDirty?.(true, true); } catch {} }
  }

  try {
    // ── DOM overlay ──────────────────────────────────────────────────────────
    overlay = document.createElement("div");
    overlay.className = "cwk-lora-overlay";
    overlay.style.display = "none";
    const root = document.createElement("div");
    root.className = "cwk-lora-widget";
    overlay.appendChild(root);
    document.body.appendChild(overlay);

    root.innerHTML = `
      <div class="cwkl-w-header">
        <input type="checkbox" class="cwkl-w-all" title="Activate / deactivate all LoRAs"/>
        <span class="cwkl-w-title">LoRAs (<span class="cwkl-w-count">0</span>)</span>
        <span class="cwkl-w-spacer"></span>
        <button class="cwkl-w-gear" title="Loader settings (fold)">⚙</button>
        <button class="cwkl-w-browser"
          title="Open the LoRA browser (infos, trigger words, thumbnails)">🔎 Browser</button>
        <button class="cwkl-w-add" title="Add an empty LoRA slot">＋ Add LoRA</button>
      </div>
      <div class="cwkl-w-settings" style="display:none">
        <div class="cwkl-w-set-row">
          <span>Default strength for new LoRAs</span>
          <input type="number" class="cwkl-w-set-strength" min="-2" max="2" step="0.05" value="1"/>
        </div>
        <div class="cwkl-w-set-row">
          <span>Strength step (arrow increment)</span>
          <input type="number" class="cwkl-w-set-step" min="0.001" max="1" step="0.001" value="0.05"/>
        </div>
        <div class="cwkl-w-set-row">
          <span>Trigger words separator</span>
          <input type="text" class="cwkl-w-set-sep" maxlength="8" placeholder=","/>
        </div>
        <label class="cwkl-w-set-chk">
          <input type="checkbox" class="cwkl-w-set-separate"/>
          Separate LoRA / CLIP weights
        </label>
        <label class="cwkl-w-set-chk">
          <input type="checkbox" class="cwkl-w-set-memory"/>
          Keep all LoRAs loaded in memory
        </label>
        <label class="cwkl-w-set-chk">
          <input type="checkbox" class="cwkl-w-set-truncate"/>
          Truncate LoRA names (folders &amp; extension)
        </label>
      </div>
      <div class="cwkl-w-rows"></div>
      <div class="cwkl-w-empty">No LoRAs yet — click “＋ Add LoRA”.</div>
      <div class="cwkl-w-footer">
        <span class="cwkl-w-trigger" title="Trigger words of the active LoRAs">trigger: —</span>
      </div>
    `;

    const rowsEl     = root.querySelector(".cwkl-w-rows");
    const emptyEl    = root.querySelector(".cwkl-w-empty");
    const countEl    = root.querySelector(".cwkl-w-count");
    const allToggle  = root.querySelector(".cwkl-w-all");
    const addBtn     = root.querySelector(".cwkl-w-add");
    const browserBtn = root.querySelector(".cwkl-w-browser");
    const trigEl     = root.querySelector(".cwkl-w-trigger");
    const gearBtn    = root.querySelector(".cwkl-w-gear");
    const settingsEl = root.querySelector(".cwkl-w-settings");
    const setStrength = root.querySelector(".cwkl-w-set-strength");
    const setStep     = root.querySelector(".cwkl-w-set-step");
    const setSep      = root.querySelector(".cwkl-w-set-sep");
    const setSeparate = root.querySelector(".cwkl-w-set-separate");
    const setMemory   = root.querySelector(".cwkl-w-set-memory");
    const setTruncate = root.querySelector(".cwkl-w-set-truncate");

    root.addEventListener("mousedown", () => {
      try {
        if (typeof app.canvas?.selectNode === "function") app.canvas.selectNode(node);
        else app.canvas?.selectNodes?.([node]);
      } catch {}
    });

    // ── Serialisation helpers ────────────────────────────────────────────────
    function _applyJson(json) {
      json = String(json ?? "[]");
      if (json === lastJson) return;
      lastJson = json;
      try {
        const parsed = JSON.parse(json);
        state.list = Array.isArray(parsed)
          ? parsed.map(_normalise).filter(Boolean)
          : [];
      } catch { state.list = []; }
      ensureLoraNames().then(() => _refreshRowSelects());
      _render();
    }

    function _normalise(it) {
      if (!it || typeof it !== "object") return null;
      let w  = Number(it.weight ?? it.model_weight ?? 1);
      let mw = Number(it.model_weight);
      let cw = Number(it.clip_weight);
      if (!Number.isFinite(w))  w  = 1;
      if (!Number.isFinite(mw)) mw = w;
      if (!Number.isFinite(cw)) cw = mw;
      return { name: String(it.name ?? ""), weight: w,
               model_weight: mw, clip_weight: cw,
               enabled: it.enabled !== false };
    }

    function _commit() {
      const sep = !!_loraSettings?.separate_weights;
      const items = state.list.map(l => sep
        ? { name: l.name, model_weight: l.model_weight,
            clip_weight: l.clip_weight, enabled: l.enabled }
        : { name: l.name, weight: l.weight, enabled: l.enabled });
      const json = JSON.stringify(items);
      if (json !== lastJson) {
        lastJson = json;
        if (cfgWidget) cfgWidget.value = json;
      }
      _markDirty();
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    function _updateHeader() {
      countEl.textContent = String(state.list.length);
      const n = state.list.length;
      allToggle.checked = n > 0 && state.list.every(l => l.enabled);
      allToggle.indeterminate = n > 0 && !allToggle.checked && state.list.some(l => l.enabled);
      allToggle.disabled = n === 0;
    }

    function _render() {
      rowsEl.innerHTML = "";
      if (!state.list.length) {
        rowsEl.style.display  = "none";
        emptyEl.style.display = "";
      } else {
        rowsEl.style.display  = "";
        emptyEl.style.display = "none";
        state.list.forEach((l, i) => rowsEl.appendChild(_buildRow(l, i)));
      }
      _updateHeader();
      _commit();
      _refreshTriggers();
    }

    function _fillSelect(sel, selected) {
      sel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "— pick a LoRA —";
      sel.appendChild(ph);
      // Grouped by base model (same bucketing as the browser panel filter).
      for (const [group, items] of _groupedLoras()) {
        const og = document.createElement("optgroup");
        og.label = group;
        for (const l of items) {
          const o = document.createElement("option");
          o.value = l.name;                    // full relative path — required
          o.textContent = _displayName(l.name);
          og.appendChild(o);
        }
        sel.appendChild(og);
      }
      if (selected && !(_loraNames || []).includes(selected)) {
        const o = document.createElement("option");
        o.value = selected;
        o.textContent = selected;
        sel.appendChild(o);
      }
      sel.value = selected || "";
    }

    function _refreshRowSelects() {
      const sels = rowsEl.querySelectorAll(".cwkl-w-select");
      state.list.forEach((l, i) => { if (sels[i]) _fillSelect(sels[i], l.name); });
    }

    // ── Double-arrow stepper widget ─────────────────────────────────────────
    function _stepSize(e) {
      const base = Number(_loraSettings?.strength_step) || 0.05;
      return e?.shiftKey ? base * 10 : base;
    }

    /** Build a [◀][value][▶] stepper bound to getter/setter. Shift+click =
     *  10× the step. The value is directly editable and clamped to [-2, 2]. */
    function _makeStepper(get, set) {
      const wrap = document.createElement("span");
      wrap.className = "cwkl-w-step";
      const dec = document.createElement("button");
      dec.className = "cwkl-w-stepbtn";
      dec.textContent = "◀";
      dec.title = "− step (Shift = 10×)";
      const val = document.createElement("input");
      val.className = "cwkl-w-stepval";
      val.type = "text";
      val.value = _fmt(get());
      const inc = document.createElement("button");
      inc.className = "cwkl-w-stepbtn";
      inc.textContent = "▶";
      inc.title = "+ step (Shift = 10×)";

      const apply = v => {
        v = Number(v);
        if (!Number.isFinite(v)) v = get();
        v = Math.max(-2, Math.min(2, Math.round(v * 100) / 100));
        set(v);
        val.value = _fmt(v);
        _commit();
      };
      dec.addEventListener("click", e => apply(get() - _stepSize(e)));
      inc.addEventListener("click", e => apply(get() + _stepSize(e)));
      val.addEventListener("change", () => apply(val.value));
      val.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); val.blur(); }
        if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); apply(get() + _stepSize(e)); }
        if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); apply(get() - _stepSize(e)); }
      });

      wrap.append(dec, val, inc);
      return wrap;
    }

    function _buildRow(l, i) {
      const row = document.createElement("div");
      row.className = "cwkl-w-row" + (l.enabled ? "" : " disabled");

      // left part: toggle + select + info
      const head = document.createElement("span");
      head.style.display = "contents";   // layout stays driven by .cwkl-w-row
      const en = document.createElement("input");
      en.type = "checkbox"; en.className = "cwkl-w-en";
      en.checked = l.enabled;
      en.title = "Activate / deactivate this LoRA";
      const sel = document.createElement("select");
      sel.className = "cwkl-w-select";
      sel.title = "LoRA file";
      const info = document.createElement("button");
      info.className = "cwkl-w-info";
      info.textContent = "ℹ";
      info.title = "Open the LoRA browser with this LoRA selected";
      head.append(en, sel, info);
      row.appendChild(head);

      // weights: one stepper, or M+C when "separate weights" is on
      if (_loraSettings?.separate_weights) {
        const labM = document.createElement("span");
        labM.className = "cwkl-w-wlab"; labM.textContent = "M";
        labM.title = "Model weight";
        row.appendChild(labM);
        row.appendChild(_makeStepper(
          () => l.model_weight,
          v => { l.model_weight = v; l.weight = v; }));   // keep unified in sync
        const labC = document.createElement("span");
        labC.className = "cwkl-w-wlab"; labC.textContent = "C";
        labC.title = "CLIP weight";
        row.appendChild(labC);
        row.appendChild(_makeStepper(
          () => l.clip_weight,
          v => { l.clip_weight = v; }));
      } else {
        row.appendChild(_makeStepper(
          () => l.weight,
          v => { l.weight = v; l.model_weight = v; l.clip_weight = v; }));
      }

      const del = document.createElement("button");
      del.className = "cwkl-w-del";
      del.textContent = "✕";
      del.title = "Remove this LoRA";
      row.appendChild(del);

      _fillSelect(sel, l.name);
      sel.addEventListener("change", () => {
        l.name = sel.value;
        _commit();
        _refreshTriggers();
      });

      info.addEventListener("click", () => {
        if (!l.name) return;
        _openBrowser(`Slot ${i + 1}`, l.name);
      });

      en.addEventListener("change", e => {
        l.enabled = e.target.checked;
        row.classList.toggle("disabled", !l.enabled);
        _updateHeader();
        _commit();
        _refreshTriggers();
      });

      del.addEventListener("click", () => {
        state.list.splice(i, 1);
        _render();
      });

      return row;
    }

    // ── Browser interaction ──────────────────────────────────────────────────
    function _addLora(name) {
      const def = Number(_loraSettings?.default_strength) || 1;
      const exists = state.list.findIndex(l => l.name === name);
      if (exists >= 0) state.list[exists].enabled = true;
      else state.list.push({ name, weight: def, model_weight: def,
                             clip_weight: def, enabled: true });
      _render();
    }

    function _openBrowser(hint, selectName) {
      const browser = getLoraBrowser();
      ensureLoraNames(true).then(() => _refreshRowSelects());
      browser.open(lora => {
        if (lora?.name) _addLora(lora.name);
      }, hint, selectName || null);
    }

    addBtn.addEventListener("click", async () => {
      await ensureLoraNames();
      await ensureLoraSettings();
      const def = Number(_loraSettings?.default_strength) || 1;
      state.list.push({ name: "", weight: def, model_weight: def,
                        clip_weight: def, enabled: true });
      _render();
      const sels = rowsEl.querySelectorAll(".cwkl-w-select");
      sels[sels.length - 1]?.focus();
    });

    browserBtn.addEventListener("click", () => _openBrowser());

    allToggle.addEventListener("change", e => {
      const on = e.target.checked;
      state.list.forEach(l => { l.enabled = on; });
      _render();
    });

    // ── ⚙ Settings — foldable inline panel ──────────────────────────────────
    function _syncSettingsInputs() {
      const s = _loraSettings ?? {};
      setStrength.value = String(s.default_strength ?? 1);
      setStep.value     = String(s.strength_step ?? 0.05);
      setSep.value      = s.trigger_separator ?? ",";
      setSeparate.checked = !!s.separate_weights;
      setMemory.checked   = !!s.keep_in_memory;
      setTruncate.checked = !!s.truncate_names;
    }

    let settingsTimer = null;
    function _onSettingChange() {
      const sv = parseFloat(setStrength.value);
      const st = parseFloat(setStep.value);
      _loraSettings = {
        ...(_loraSettings ?? {}),
        default_strength: Number.isFinite(sv) ? Math.max(-2, Math.min(2, sv)) : 1,
        strength_step:    (Number.isFinite(st) && st > 0) ? st : 0.05,
        trigger_separator: setSep.value,
        separate_weights: setSeparate.checked,
        keep_in_memory:   setMemory.checked,
        truncate_names:   setTruncate.checked,
      };
      _render();                       // rows pick up step/mode/labels now
      _rerenderAllLoraNodes();         // other open loader nodes follow suit

      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(async () => {
        try {
          const res = await fetch("/cwk/loras/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(_loraSettings),
          });
          if (res.ok) {
            const j = await res.json();
            if (j?.settings) {
              _loraSettings = j.settings;   // server-clamped truth
              _syncSettingsInputs();
            }
          }
        } catch {}
      }, 400);
    }

    setStrength.addEventListener("change", _onSettingChange);
    setStep.addEventListener("change", _onSettingChange);
    setSep.addEventListener("change", _onSettingChange);
    setSeparate.addEventListener("change", _onSettingChange);
    setMemory.addEventListener("change", _onSettingChange);
    setTruncate.addEventListener("change", _onSettingChange);

    gearBtn.addEventListener("click", () => {
      const open = settingsEl.style.display === "none";
      settingsEl.style.display = open ? "flex" : "none";
      gearBtn.classList.toggle("open", open);
      if (open) _syncSettingsInputs();
    });

    ensureLoraSettings().then(() => { _syncSettingsInputs(); _render(); });

    // ── Trigger-word preview (mirrors the node's STRING output) ─────────────
    let trigTimer = null;
    function _refreshTriggers() {
      clearTimeout(trigTimer);
      trigTimer = setTimeout(async () => {
        const names = [...new Set(state.list.filter(l => l.enabled && l.name).map(l => l.name))];
        const lists = await Promise.all(names.map(getTriggersFor));
        const words = [...new Set(lists.flat())];
        const sep = _loraSettings?.trigger_separator ?? ",";
        trigEl.textContent = words.length ? `trigger: ${words.join(sep)}` : "trigger: —";
        trigEl.title = words.join(sep) || "No trigger words";
      }, 150);
    }

    // ── Overlay positioning loop ────────────────────────────────────────────
    const PAD = 6;                 // horizontal inset of the widget inside the node body
    let hiddenFrames = 0;          // consecutive frames the overlay stayed hidden
    let rafActive    = false;
    let rafId        = 0;

    function _startLoop() {
      if (state.destroyed || rafActive) return;
      rafActive = true;
      rafId     = requestAnimationFrame(_tick);
    }

    function _stopLoop() {
      rafActive = false;
      cancelAnimationFrame(rafId);
    }

    function _hide() {
      overlay.style.display = "none";
      hiddenFrames++;
    }

    function _tick() {
      if (state.destroyed) { _stopLoop(); return; }
      rafId = requestAnimationFrame(_tick);
      try {
        _clampSize();
        _hideNativeWidgetElement();

        // 1) Node not in any graph → it was deleted (possibly transiently
        //    during a workflow load). Hide now, destroy after the grace.
        if (node.graph == null) {
          _hide();
          if (hiddenFrames > PARK_FRAMES) {
            state.destroyed = true;
            _stopLoop();
            overlay.remove();
          }
          return;
        }

        // 2) Ghost detection. A node's own "graph" reference can go stale
        //    (abandoned instances on tab switches keep a reference that still
        //    equals the canvas graph), so we decide by, in order:
        //      a. drawn within RECENT_MS  → the node is demonstrably being
        //         painted right now — ground truth, show it.
        //      b. otherwise, any node container this litegraph build exposes
        //         (canvas visible list / graph node array) must contain it.
        //      c. if no container exists at all, fall back to identity only —
        //         never worse than the previous behaviour.
        const drawnRecently = (performance.now() - lastDrawnAt) < RECENT_MS;
        if (!drawnRecently) {
          const activeGraph = _activeGraph();
          const visible     = _canvasVisibleNodes();
          const gNodes      = _graphNodeList(activeGraph);
          const hasProbe    = Array.isArray(visible) || Array.isArray(gNodes);
          const present     = (Array.isArray(visible) && visible.includes(node))
                           || (Array.isArray(gNodes)  && gNodes.includes(node));
          if (node.graph !== activeGraph || (hasProbe && !present)) {
            _hide();
            ctxTransform = null;                        // require a fresh draw
            if (hiddenFrames > PARK_FRAMES) _stopLoop(); // park; re-armed on draw
            return;
          }
        }

        if (node.flags?.collapsed || !ctxTransform) {
          _hide();
          return;
        }

        const canvasEl = app.canvas?.canvas;
        if (!canvasEl) { _hide(); return; }
        const rect = canvasEl.getBoundingClientRect();
        if (!rect.width || !rect.height) { _hide(); return; }

        // buffer px → CSS px (handles devicePixelRatio / styled canvases)
        const kx = rect.width  / (canvasEl.width  || 1);
        const ky = rect.height / (canvasEl.height || 1);

        const m    = ctxTransform;
        const zoom = m.a * kx;
        if (!(zoom > ZOOM_HIDE)) { _hide(); return; }

        const { domY } = metrics();
        // node-local (PAD, domY) → screen coordinates
        const x = (m.e + m.a * PAD) * kx + rect.left;
        const y = (m.f + m.d * domY) * ky + rect.top;

        // hide when the node is outside the canvas viewport
        const w = node.size[0] * zoom, h = node.size[1] * zoom;
        if (x + w < rect.left || x > rect.right || y + h < rect.top || y > rect.bottom) {
          _hide();
          return;
        }

        hiddenFrames = 0;
        overlay.style.display   = "block";
        overlay.style.transform =
          `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${zoom.toFixed(4)})`;
        overlay.style.width     = Math.max(200, node.size[0] - 2 * PAD) + "px";
        overlay.style.height    = Math.max(120, node.size[1] - domY - 14) + "px"; // keep resize corner free

        if (!announced) {
          announced = true;
          console.log("[CWK LoRA] Node UI active — overlay is tracking the node.");
        }
      } catch (e) {
        _hide();
      }
    }

    // ── Canvas body: flat CWK paint + transform capture ──────────────────────
    const prevOnDrawBackground = node.onDrawBackground;
    node.onDrawBackground = function (ctx) {
      try {
        prevOnDrawBackground?.apply(this, arguments);
        // The node is being painted right now → ground-truth "on canvas".
        lastDrawnAt = performance.now();
        // Capture the matrix ComfyUI is using to draw THIS node (DPR + view
        // pan/zoom + node position all included).
        if (ctx.getTransform) ctxTransform = ctx.getTransform();
        // …and (re-)arm the positioning loop (it parks itself while the
        // overlay stays hidden for a long time).
        _startLoop();

        if (this.flags?.collapsed) return;
        this.__cwkClampSize?.();   // backstop

        const { titleH } = metrics();
        ctx.save();
        ctx.fillStyle = COLORS.body;
        ctx.beginPath();
        if (ctx.roundRect)
          ctx.roundRect(0.5, titleH + 1, this.size[0] - 1, this.size[1] - titleH - 2, ROUND_R);
        else
          ctx.rect(0.5, titleH + 1, this.size[0] - 1, this.size[1] - titleH - 2);
        ctx.fill();
        ctx.restore();
      } catch (e) {
        console.error("[CWK LoRA] draw error:", e);
      }
    };

    _startLoop();

    // ── Init ─────────────────────────────────────────────────────────────────
    node.__cwkLoraApplyJson      = _applyJson;
    node.__cwkLoraRerender        = () => _render();
    node.__cwkLoraSyncSettingsUI = () => _syncSettingsInputs();
    node.__cwkLoraDestroy        = () => {
      state.destroyed = true;
      _stopLoop();
      _activeLoraNodes.delete(node);
      overlay?.remove();
    };
    _activeLoraNodes.add(node);

    node.size = [Math.max(node.size?.[0] ?? 0, 470), Math.max(node.size?.[1] ?? 0, 380)];
    _clampSize();
    _prepareJsonWidget();
    _applyJson(String(cfgWidget?.value ?? "[]"));
    setTimeout(_prepareJsonWidget, 800);

    // One-time environment diagnostic (browser console). Remove once
    // everything works — it reports which containers this build exposes.
    setTimeout(() => {
      if (_probeLogged) return;
      _probeLogged = true;
      try {
        const g       = _activeGraph();
        const visible = _canvasVisibleNodes();
        const gNodes  = _graphNodeList(g);
        console.log("[CWK LoRA] ghost-probe:", {
          identityOk:  node.graph === g,
          visibleList: Array.isArray(visible),
          graphList:   Array.isArray(gNodes),
          inVisible:   Array.isArray(visible) && visible.includes(node),
          inGraphList: Array.isArray(gNodes)  && gNodes.includes(node),
        });
      } catch {}
    }, 1500);

  } catch (e) {
    console.error("[CWK LoRA] Node UI setup failed — keeping the raw JSON widget visible:", e);
    try {
      overlay?.remove();
      const el = cfgWidget?.element;
      if (el) { el.classList.remove("cwk-lora-dom-hidden"); el.style.display = ""; }
      if (cfgWidget?.origDraw)        cfgWidget.draw        = cfgWidget.origDraw;
      if (cfgWidget?.origComputeSize) cfgWidget.computeSize = cfgWidget.origComputeSize;
    } catch {}
  }
}
