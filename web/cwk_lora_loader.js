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
 * Widget rows: [✓] [LoRA dropdown] [ℹ info] [weight slider] [✕]
 * Header: master activate/deactivate toggle, LoRA count, 🔎 Browser, ＋ Add LoRA.
 */

import { getBaseModelMatchers } from "./cwk_base_models.js";
import { app } from "../../scripts/app.js";
import { getLoraBrowser, injectLoraStyles, getTriggersFor, triggerCache }
  from "./cwk_lora_panel.js";

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

function injectLoraSettingsStyles() {
  if (document.getElementById("cwk-lora-settings-styles")) return;
  const st = document.createElement("style");
  st.id = "cwk-lora-settings-styles";
  st.textContent = `
    .cwk-lora-widget .cwkl-w-gear {
      background: transparent; border: none; cursor: pointer;
      color: #9aa4b8; font-size: 14px; line-height: 1;
      padding: 2px 5px; border-radius: 4px;
    }
    .cwk-lora-widget .cwkl-w-gear:hover {
      color: #fff; background: rgba(255,255,255,.12);
    }
  `;
  document.head.appendChild(st);
}

// ─── Installed-LoRA name list (for the row dropdowns) ────────────────────────

let _loraList    = null;   // [{name, base_model, civitai}] from /cwk/loras
let _loraNames   = null;   // derived: names only (kept for legacy references)
let _loraNamesAt = 0;
let _loraSettings = null;

async function ensureLoraSettings() {
  if (_loraSettings) return _loraSettings;
  try {
    const r = await fetch("/cwk/loras/settings");
    if (r.ok) _loraSettings = await r.json();
  } catch {}
  _loraSettings ??= { default_strength: 1, strength_step: 0.05,
                       keep_in_memory: false, truncate_names: false };
  return _loraSettings;
}

// ─── ⚙ LoRA Loader settings popup (cloned from CWK Save Image) ──────────────

let _loraSetPanel = null, _loraSetBackdrop = null;

function _blockLoraCanvasEvents(el) {
  for (const evt of ["mousedown","mouseup","click","pointerdown","pointerup",
                     "dblclick","contextmenu","wheel","touchstart","touchend"]) {
    el.addEventListener(evt, e => e.stopPropagation());
  }
}

function closeLoraSettingsPopup() {
  _loraSetPanel?.remove(); _loraSetBackdrop?.remove();
  _loraSetPanel = null; _loraSetBackdrop = null;
  app.canvas?.setDirty?.(true, false);   // ← add (parity with closeSaveSettingsPopup)
}

async function openLoraSettingsPopup(onChange) {
  closeLoraSettingsPopup();
  await ensureLoraSettings();
  let s = { ..._loraSettings };
  let postTimer = null;

  const persist = () => {
    clearTimeout(postTimer);
    postTimer = setTimeout(async () => {
      try {
        const res = await fetch("/cwk/loras/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(_loraSettings),
        });
        if (res.ok) {
          const j = await res.json();
          if (j?.settings) _loraSettings = j.settings;   // server-clamped truth
        }
      } catch {}
    }, 350);
  };

  const apply = patch => {
    s = { ...s, ...patch };
    _loraSettings = s;
    onChange?.();      // rows re-render → new slider step / labels / defaults
    persist();
  };

  _loraSetBackdrop = document.createElement("div");
  Object.assign(_loraSetBackdrop.style, { position:"fixed", inset:"0", background:"rgba(0,0,0,.5)", zIndex:"100001" });
  _blockLoraCanvasEvents(_loraSetBackdrop);
  _loraSetBackdrop.addEventListener("mousedown", () => closeLoraSettingsPopup());

  _loraSetPanel = document.createElement("div");
  Object.assign(_loraSetPanel.style, {
    position:"fixed", left:"50%", top:"50%", transform:"translate(-50%,-50%)",
    width:"min(92vw, 430px)", background:"#141824", border:"1px solid #313552",
    borderRadius:"10px", color:"#cdd6f4", fontFamily:"Inter,system-ui,sans-serif",
    fontSize:"13px", zIndex:"100002", boxShadow:"0 24px 80px rgba(0,0,0,.7)", userSelect:"none",
  });
  _blockLoraCanvasEvents(_loraSetPanel);

  // header — same pattern as "⚙ Save Settings"
  const header = document.createElement("div");
  Object.assign(header.style, { display:"flex", alignItems:"center", padding:"12px 16px",
    background:"#1a2035", borderBottom:"1px solid #2a2f45", borderRadius:"10px 10px 0 0" });
  const title = document.createElement("span");
  title.textContent = "⚙ LoRA Loader Settings"; title.style.cssText = "font-weight:600; flex:1;";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none; border:none; color:#6c7086; font-size:16px; cursor:pointer; line-height:1;";
  closeBtn.onmouseenter = () => closeBtn.style.color = "#f38ba8";
  closeBtn.onmouseleave = () => closeBtn.style.color = "#6c7086";
  closeBtn.onclick = closeLoraSettingsPopup;
  header.append(title, closeBtn);

  const body = document.createElement("div");
  Object.assign(body.style, { padding: "14px 16px", display: "flex", flexDirection: "column", gap: "13px" });

  const row = () => {
    const r = document.createElement("div");
    Object.assign(r.style, { display:"flex", alignItems:"center", gap:"10px" });
    body.appendChild(r);
    return r;
  };
  const labelCss = "width:175px; flex-shrink:0; color:#cdd6f4;";
  const sliderCss = "flex:1; accent-color:#89b4fa; cursor:pointer;";

  // Default strength — slider row (pattern: JPG quality)
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "Default strength"; l.style.cssText = labelCss;
    const sl = document.createElement("input"); sl.type = "range"; sl.min = -2; sl.max = 2; sl.step = 0.05;
    sl.value = s.default_strength ?? 1;
    sl.style.cssText = sliderCss;
    const v = document.createElement("span"); v.textContent = Number(sl.value).toFixed(2);
    v.style.cssText = "width:28px; text-align:right; color:#89b4fa; font-weight:600;";
    sl.addEventListener("input", () => {
      v.textContent = Number(sl.value).toFixed(2);
      apply({ default_strength: Number(sl.value) });
    });
    r.append(l, sl, v);
  }

  // Strength step — number input (pattern: Counter digits)
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "Strength step"; l.style.cssText = labelCss;
    const inp = document.createElement("input"); inp.type = "number";
    inp.min = 0.001; inp.max = 1; inp.step = 0.001;
    inp.value = s.strength_step ?? 0.05;
    inp.style.cssText = "width:64px; background:#1e2335; border:1px solid #313552; border-radius:6px; color:#cdd6f4; padding:4px 8px; outline:none; font-size:13px;";
    inp.addEventListener("change", () => {
      let v = parseFloat(inp.value);
      if (!Number.isFinite(v)) v = 0.05;
      v = Math.min(1, Math.max(0.001, v));
      inp.value = v;
      apply({ strength_step: v });
    });
    r.append(l, inp);
  }

  // Keep all LoRAs loaded in memory — checkbox (pattern: WebP lossless)
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "Keep all LoRAs in memory"; l.style.cssText = labelCss;
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !!s.keep_in_memory;
    cb.style.accentColor = "#89b4fa"; cb.style.cursor = "pointer";
    cb.addEventListener("change", () => apply({ keep_in_memory: cb.checked }));
    r.append(l, cb);
  }

  // Truncate LoRA names — checkbox (pattern: Save workflow)
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "Truncate LoRA names"; l.style.cssText = labelCss;
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !!s.truncate_names;
    cb.style.accentColor = "#89b4fa"; cb.style.cursor = "pointer";
    cb.addEventListener("change", () => apply({ truncate_names: cb.checked }));
    r.append(l, cb);
  }

  // Done — same button
  {
    const r = row(); r.style.justifyContent = "flex-end";
    const b = document.createElement("button"); b.textContent = "Done";
    b.style.cssText = "background:#313552; color:#cdd6f4; border:1px solid #313552; border-radius:6px; padding:6px 20px; font-weight:600; cursor:pointer; font-size:13px;";
    b.onmouseenter = () => b.style.filter = "brightness(1.15)";
    b.onmouseleave = () => b.style.filter = "";
    b.onclick = closeLoraSettingsPopup;
    r.appendChild(b);
  }

  _loraSetPanel.append(header, body);
  document.body.append(_loraSetBackdrop, _loraSetPanel);
}

async function ensureLoraNames(force = false) {
  if (!force && _loraList && (Date.now() - _loraNamesAt) < 30000) return _loraList;
  try {
    const res = await fetch("/cwk/loras");
    if (res.ok) {
      _loraList = await res.json();
      _loraNames = _loraList.map(l => l.name);
      _loraNamesAt = Date.now();
      _loraList.forEach(l => {
        if (l.civitai?.trigger_words?.length) {
          triggerCache.set(l.name, l.civitai.trigger_words);
        }
      });
    }
    await ensureBaseMatchers();
  } catch {}
  return _loraList ?? [];
}

let _baseMatchers = null;

async function ensureBaseMatchers() {
  if (!_baseMatchers) {
    try { _baseMatchers = await getBaseModelMatchers(); } catch {}
    _baseMatchers = Array.isArray(_baseMatchers) ? _baseMatchers : [];
  }
  return _baseMatchers;
}

/** Same bucketing rule as the browser panel's filter: a LoRA belongs to the
 * first matcher whose keywords appear in its resolved base_model string;
 * anything else (including empty) → "Others". */
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

function _groupedLoras() {
  const groups = new Map();          // insertion order = matcher order, Others last
  for (const l of (_loraList ?? [])) {
    const raw = (l.base_model ?? l.civitai?.base_model ?? "").toLowerCase();
    const g    = _bucketFor(base);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(l);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === "Others") - (b[0] === "Others")
                  || a[0].localeCompare(b[0]))
    .map(([g, items]) => [g, items.sort((a, b) => a.name.localeCompare(b.name))]);
}

function _displayName(n) {
  return _loraSettings?.truncate_names
    ? n.split("/").pop().replace(/\.[^.]+$/, "")
    : n;
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
    injectLoraStyles();   // panel + node-overlay CSS (incl. .cwk-lora-dom-hidden)
    injectLoraSettingsStyles();

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
        <button class="cwkl-w-gear" title="Loader settings">⚙</button>
        <button class="cwkl-w-browser"
          title="Open the LoRA browser (infos, trigger words, thumbnails)">🔎 Browser</button>
        <button class="cwkl-w-add" title="Add an empty LoRA slot">＋ Add LoRA</button>
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
    const gearBtn     = root.querySelector(".cwkl-w-gear");
    const settingsEl  = root.querySelector(".cwkl-w-settings");
    const setStrength = root.querySelector(".cwkl-w-set-strength");
    const setStep     = root.querySelector(".cwkl-w-set-step");
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
      let w = Number(it.weight ?? it.model_weight ?? 1);
      if (!Number.isFinite(w)) w = 1;
      return { name: String(it.name ?? ""), weight: w, enabled: it.enabled !== false };
    }

    function _commit() {
      const json = JSON.stringify(state.list);
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
      for (const [group, items] of _groupedLoras()) {
        const og = document.createElement("optgroup");
        og.label = group;
        for (const l of items) {
          const o = document.createElement("option");
          o.value = l.name;                    // full path — required
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

    function _buildRow(l, i) {
      const row = document.createElement("div");
      row.className = "cwkl-w-row" + (l.enabled ? "" : " disabled");
      row.innerHTML = `
        <input type="checkbox" class="cwkl-w-en" ${l.enabled ? "checked" : ""}
               title="Activate / deactivate this LoRA"/>
        <select class="cwkl-w-select" title="LoRA file"></select>
        <button class="cwkl-w-info"
          title="Open the LoRA browser with this LoRA selected">ℹ</button>
        <input type="range" class="cwkl-w-weight" min="-2" max="2" step="${_loraSettings?.strength_step ?? 0.05}" value="${l.weight}" title="LoRA weight"/>
        <span class="cwkl-w-wval">${_fmt(l.weight)}</span>
        <button class="cwkl-w-del" title="Remove this LoRA">✕</button>
      `;

      const sel = row.querySelector(".cwkl-w-select");
      _fillSelect(sel, l.name);
      sel.addEventListener("change", () => {
        l.name = sel.value;
        _commit();
        _refreshTriggers();
      });

      row.querySelector(".cwkl-w-info").addEventListener("click", () => {
        if (!l.name) return;
        _openBrowser(`Slot ${i + 1}`, l.name);
      });

      row.querySelector(".cwkl-w-en").addEventListener("change", e => {
        l.enabled = e.target.checked;
        row.classList.toggle("disabled", !l.enabled);
        _updateHeader();
        _commit();
        _refreshTriggers();
      });

      const slider = row.querySelector(".cwkl-w-weight");
      slider.addEventListener("input", () => {
        l.weight = Number(slider.value);
        row.querySelector(".cwkl-w-wval").textContent = _fmt(l.weight);
        _commit();
      });

      row.querySelector(".cwkl-w-del").addEventListener("click", () => {
        state.list.splice(i, 1);
        _render();
      });

      return row;
    }

    // ── Browser interaction ──────────────────────────────────────────────────
    function _addLora(name) {
      const exists = state.list.findIndex(l => l.name === name);
      if (exists >= 0) state.list[exists].enabled = true;
      else             state.list.push({ name, weight: _loraSettings?.default_strength ?? 1, enabled: true });
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
      state.list.push({ name: "", weight: _loraSettings?.default_strength ?? 1, enabled: true });
      _render();
      const sels = rowsEl.querySelectorAll(".cwkl-w-select");
      sels[sels.length - 1]?.focus();
    });

    browserBtn.addEventListener("click", () => _openBrowser());

    allToggle.addEventListener("change", e => {
      ensureLoraSettings().then(() => _render());
      const on = e.target.checked;
      state.list.forEach(l => { l.enabled = on; });
      _render();
    });

    // ── ⚙ Settings (popup, same behaviour as CWK Save Image) ────────────────
    gearBtn.addEventListener("click", () => openLoraSettingsPopup(() => _render()));
    ensureLoraSettings().then(() => _render());   // rows pick up step/labels once loaded

    // ── Trigger-word preview (mirrors the node's STRING output) ─────────────
    let trigTimer = null;
    function _refreshTriggers() {
      clearTimeout(trigTimer);
      trigTimer = setTimeout(async () => {
        const names = [...new Set(state.list.filter(l => l.enabled && l.name).map(l => l.name))];
        const lists = await Promise.all(names.map(getTriggersFor));
        const words = [...new Set(lists.flat())];
        trigEl.textContent = words.length ? `trigger: ${words.join(", ")}` : "trigger: —";
        trigEl.title = words.join(", ") || "No trigger words";
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
    node.__cwkLoraApplyJson = _applyJson;
    node.__cwkLoraDestroy   = () => {
      state.destroyed = true;
      _stopLoop();
      overlay?.remove();
    };

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
