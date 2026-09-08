/**
 * CWK LoRA Loader — frontend node extension.
 *
 * The node body is painted on the canvas (CWK palette) via onDrawBackground,
 * and the interactive list is a DOM overlay positioned every animation frame
 * from the node's position/size — so it always sits below the connection
 * dots, follows pan/zoom, and resizes with the node.
 *
 * Widget rows: [✓] [LoRA dropdown] [ℹ info] [weight slider] [✕]
 * Header: master activate/deactivate toggle, LoRA count, 🔎 Browser, ＋ Add LoRA.
 */

import { app } from "../../scripts/app.js";
import { getLoraBrowser, injectLoraStyles, getTriggersFor, triggerCache }
  from "./cwk_lora_panel.js";

const LORA_NODES = ["CWK_LorA_Loader", "CWK_LorA_Prompt_Loader"];

const COLORS = { body: "#141824", border: "#2a2f45" };

function _fmt(v) { return (Math.round(v * 100) / 100).toFixed(2); }

// ─── Installed-LoRA name list (for the row dropdowns) ────────────────────────

let _loraNames = null;
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

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!LORA_NODES.includes(nodeData?.name)) return;
    injectLoraStyles();

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

    const onNodeRemoved = nodeType.prototype.onNodeRemoved;
    nodeType.prototype.onNodeRemoved = function () {
      const r = onNodeRemoved?.apply(this, arguments);
      try { this.__cwkLoraDestroy?.(); } catch {}
      return r;
    };
  },
});

// ─── Node setup ──────────────────────────────────────────────────────────────

function _setupLoraNode(node) {
  const state = { list: [], destroyed: false };
  let lastJson = null;

  // ── Hide the native JSON widget (kept for serialisation / prompt input) ──
  const cfgWidget = node.widgets?.find(w => w.name === "lora_config");
  if (cfgWidget) {
    cfgWidget.hidden = true;
    cfgWidget.computeSize = () => [0, -4];
    cfgWidget.serializeValue = () => JSON.stringify(state.list);
  }

  // ── Layout metrics: DOM starts below all connection dots ──────────────────
  const metrics = () => {
    const LG = window.LiteGraph || {};
    const titleH = LG.NODE_TITLE_HEIGHT || 30;
    const slotH  = LG.NODE_SLOT_HEIGHT  || 20;
    const rows   = Math.max(node.inputs?.length ?? 0, node.outputs?.length ?? 0, 1);
    return { titleH, domY: titleH + rows * slotH + 10 };
  };

  // ── DOM overlay ────────────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "cwk-lora-overlay";
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

  const rowsEl    = root.querySelector(".cwkl-w-rows");
  const emptyEl   = root.querySelector(".cwkl-w-empty");
  const countEl   = root.querySelector(".cwkl-w-count");
  const allToggle = root.querySelector(".cwkl-w-all");
  const addBtn    = root.querySelector(".cwkl-w-add");
  const browserBtn= root.querySelector(".cwkl-w-browser");
  const trigEl    = root.querySelector(".cwkl-w-trigger");

  // clicking the widget selects the node (like ComfyUI DOM widgets do)
  root.addEventListener("mousedown", () => {
    try {
      if (typeof app.canvas?.selectNode === "function") app.canvas.selectNode(node);
      else app.canvas?.selectNodes?.([node]);
    } catch {}
  });

  // ── Serialisation helpers ──────────────────────────────────────────────────
  function _applyJson(json) {
    json = String(json ?? "[]");
    if (json === lastJson) return;
    lastJson = json;
    try {
      const parsed = JSON.parse(json);
      state.list = Array.isArray(parsed) ? parsed.map(_normalise) : [];
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
    node.setDirtyCanvas(true, true);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
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

  // ── Browser interaction ────────────────────────────────────────────────────
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

  // ── Trigger-word preview (mirrors the node's STRING output) ───────────────
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

  // ── Canvas body: CWK palette + size clamps ────────────────────────────────
  const prevOnDrawBackground = node.onDrawBackground;
  node.onDrawBackground = function (ctx) {
    prevOnDrawBackground?.apply(this, arguments);
    if (this.flags.collapsed) return;
    const { titleH, domY } = metrics();
    const w = this.size[0], h = this.size[1];
    const minW = 440, minH = domY + 180;
    if (w < minW) this.size[0] = minW;
    if (h < minH) this.size[1] = minH;

    ctx.save();
    ctx.fillStyle = COLORS.body;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(0.5, titleH + 1, this.size[0] - 1, this.size[1] - titleH - 2, 10);
    else               ctx.rect(0.5, titleH + 1, this.size[0] - 1, this.size[1] - titleH - 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  };

  // ── Overlay positioning loop (survives resize / pan / zoom / culling) ─────
  let rafId = 0;
  function _tick() {
    if (state.destroyed || node.graph == null) { overlay.remove(); return; }
    rafId = requestAnimationFrame(_tick);

    const c = app.canvas;
    if (!c?.canvas || !c.ds) return;
    if (node.flags.collapsed) { overlay.style.display = "none"; return; }
    const scale = c.ds.scale;
    if (!scale || scale < 0.35) { overlay.style.display = "none"; return; }

    const { domY } = metrics();
    const canvas = c.canvas;
    const rect   = canvas.getBoundingClientRect();
    const dpr    = rect.width > 0 ? canvas.width / rect.width : 1;

    let px, py;
    if (typeof c.ds.convertOffsetToCanvas === "function") {
      const p = c.ds.convertOffsetToCanvas([node.pos[0], node.pos[1] + domY]);
      px = p[0]; py = p[1];
    } else {
      px = node.pos[0] * scale + c.ds.offset[0];
      py = (node.pos[1] + domY) * scale + c.ds.offset[1];
    }

    overlay.style.display   = "";
    overlay.style.transform = `translate(${px / dpr + rect.left}px, ${py / dpr + rect.top}px) scale(${scale / dpr})`;
    overlay.style.width     = Math.max(200, node.size[0] - 12) + "px";
    overlay.style.height    = Math.max(120, node.size[1] - domY - 14) + "px";  // keep resize corner free
  }
  rafId = requestAnimationFrame(_tick);

  // ── Init ───────────────────────────────────────────────────────────────────
  node.__cwkLoraApplyJson = _applyJson;
  node.__cwkLoraDestroy   = () => {
    state.destroyed = true;
    cancelAnimationFrame(rafId);
    overlay.remove();
  };

  node.size = [Math.max(node.size?.[0] ?? 0, 470), Math.max(node.size?.[1] ?? 0, 380)];
  _applyJson(String(cfgWidget?.value ?? "[]"));
}
