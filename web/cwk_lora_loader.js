/**
 * CWK LoRA Loader — frontend node extension.
 *
 * Theming:
 * - Title bar / node background come from node.color / node.bgcolor (the same
 *   mechanism ComfyUI's "Colors" menu uses); they are re-asserted in
 *   onConfigure so old workflows can't restore grey defaults.
 * - The body is painted flat in onDrawBackground (fill only — no stroke, no
 *   accent line) and the interactive list is a DOM overlay positioned from
 *   the exact canvas transform captured while drawing the node.
 *
 * The native "lora_config" widget stays a fully serialisable, *normal* widget
 * (never hidden — hidden widgets can be dropped from the queue prompt by
 *   newer frontends) but renders nothing and takes no layout space:
 *   - canvas side:  draw = noop, computeSize = [0, -4]
 *   - DOM side:     multiline STRING widgets are real elements positioned over
 *                   the canvas; the element is hidden via the
 *                   .cwk-lora-dom-hidden { display:none !important } rule
 *                   from injectLoraStyles.
 *
 * Ghost / imprint prevention: a node's own "graph" reference can go stale
 * (ComfyUI abandons node instances when switching workflow tabs or loading
 * workflows, sometimes without clearing node.graph). Visibility therefore
 * depends on the *graph's* node list: the overlay shows only while the node
 * is actually contained in the graph the canvas is currently drawing.
 * Hidden overlays park their rAF loop after a grace period (onDrawBackground
 * re-arms it), and fully detached nodes are destroyed after the same grace.
 *
 * Minimum node size (MIN_W × dots + MIN_H_EXTRA) is enforced at every layer:
 * onResize (resize drags), computeSize (auto-fit paths), onDrawBackground and
 * the rAF positioning loop.
 *
 * Widget rows: [✓] [LoRA dropdown] [ℹ info] [weight slider] [✕]
 * Header: master activate/deactivate toggle, LoRA count, 🔎 Browser, ＋ Add LoRA.
 */

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

const ZOOM_HIDE           = 0.35;   // hide overlay below this zoom level
const PARK_FRAMES         = 600;    // ~10 s hidden → park the loop / destroy if detached
const MIN_W               = 440;    // minimum node width (canvas space)
const MIN_H_EXTRA         = 180;    // minimum body height below the dots
const ROUND_R             = 8;      // body corner radius (matches ComfyUI's)

function _fmt(v) { return (Math.round(v * 100) / 100).toFixed(2); }

// ─── Installed-LoRA name list (for the row dropdowns) ────────────────────────

let _loraNames   = null;
let _loraNamesAt = 0;

async function ensureLoraNames(force = false) {
  if (!force && _loraNames && (Date.now() - _loraNamesAt) < 30000) return _loraNames;
  try {
    const res = await fetch("/cwk/loras");
    if (res.ok) {
      const list = await res.json();
      _loraNames = list.map(l => l.name);
      _loraNamesAt = Date.now();
      list.forEach(l => {
        if (l.civitai?.trigger_words?.length) {
          triggerCache.set(l.name, l.civitai.trigger_words);
        }
      });
    }
  } catch {}
  return _loraNames ?? [];
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

    // …and litegraph's native one (graph.remove / graph.clear) — so nodes
    // dropped during workflow loads clean up immediately.
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

  // Called by litegraph *while the user drags the resize handle* — clamping
  // here means the canvas never renders a frame below the minimum.
  const prevOnResize = node.onResize;
  node.onResize = function () {
    try { _clampSize(); } catch {}
    return prevOnResize?.apply(this, arguments);
  };

  // Auto-fit / "size to content" paths: with lora_config at zero height,
  // computeSize() would report a tiny node — report our minimum instead.
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
    // Stash originals so the failure path can restore a usable raw widget.
    cfgWidget.origComputeSize ??= cfgWidget.computeSize;
    cfgWidget.origDraw        ??= cfgWidget.draw;
    // NOT hidden and type stays "STRING": it remains a fully serialisable
    // widget in every queue prompt. It renders nothing and takes no space —
    // the DOM overlay is its UI.
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

    // clicking the widget selects the node (like ComfyUI DOM widgets do)
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
      const names = _loraNames || [];
      sel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "— pick a LoRA —";
      sel.appendChild(ph);
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        sel.appendChild(o);
      }
      if (selected && !names.includes(selected)) {
        // keep the entry valid even if the file list is stale / not yet loaded
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
        <input type="range" class="cwkl-w-weight" min="-2" max="2" step="0.05"
               value="${l.weight}" title="LoRA weight"/>
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
      else             state.list.push({ name, weight: 1, enabled: true });
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
      state.list.push({ name: "", weight: 1, enabled: true });
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
    let rafActive   = false;

    function _startLoop() {
      if (state.destroyed || rafActive) return;
      rafActive = true;
      rafId     = requestAnimationFrame(_tick);
    }
    let rafId = 0;
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

        // Node not in any graph → it was deleted (possibly transiently during
        // a workflow load). Hide now, destroy after the grace period.
        if (node.graph == null) {
          _hide();
          if (hiddenFrames > PARK_FRAMES) {
            state.destroyed = true;
            _stopLoop();
            overlay.remove();
          }
          return;
        }

        // ── Ghost detection ────────────────────────────────────────────────
        // node.graph can go STALE: when ComfyUI switches tabs / loads a
        // workflow, abandoned node instances sometimes keep a reference that
        // still equals the canvas's graph object, so "node.graph != null"
        // and identity checks alone let their overlays through (the
        // "imprints"). The graph's own node list is the source of truth: if
        // this node is not in it, it is not on the canvas → hide.
        // Inactive tabs keep their graphs alive in the background — the
        // overlay is re-armed automatically if the node is drawn again later.
        const activeGraph = app.canvas?.graph ?? app.graph;
        const inGraph = !!activeGraph
          && (activeGraph._nodes_in_order?.includes(node)
           || activeGraph._nodes?.includes(node));
        if (node.graph !== activeGraph || !inGraph) {
          _hide();
          ctxTransform = null;                       // require a fresh draw
          if (hiddenFrames > PARK_FRAMES) _stopLoop(); // park; re-armed on draw
          return;
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
        // Capture the matrix ComfyUI is using to draw THIS node (DPR + view
        // pan/zoom + node position all included). The overlay is positioned
        // from it every frame, so it can never drift from the canvas.
        if (ctx.getTransform) ctxTransform = ctx.getTransform();

        // The node is being drawn right now → (re-)arm the positioning loop
        // (it parks itself while the overlay stays hidden for a long time).
        _startLoop();

        if (this.flags?.collapsed) return;
        this.__cwkClampSize?.();   // backstop (onResize/_tick normally handle it)

        const { titleH } = metrics();
        ctx.save();
        ctx.fillStyle = COLORS.body;
        ctx.beginPath();
        if (ctx.roundRect)
          ctx.roundRect(0.5, titleH + 1, this.size[0] - 1, this.size[1] - titleH - 2, ROUND_R);
        else
          ctx.rect(0.5, titleH + 1, this.size[0] - 1, this.size[1] - titleH - 2);
        ctx.fill();
        // Intentionally NO stroke / accent line — the node outline is
        // ComfyUI's own border.
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
    // Some frontends build widgets slightly after onNodeCreated — apply once
    // more, idempotently:
    setTimeout(_prepareJsonWidget, 800);

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
