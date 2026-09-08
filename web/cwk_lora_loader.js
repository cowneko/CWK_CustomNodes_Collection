/**
 * CWK LoRA Prompt Loader — frontend node extension.
 *
 * Replaces the raw "lora_config" JSON widget with an interactive DOM widget:
 *  - per-LoRA row: enable checkbox, name (click = replace via browser),
 *    weight slider (-2 … 2), remove button
 *  - master "activate / deactivate all" checkbox
 *  - "＋ Add LoRA" opens the LoRA browser panel ("Load LorA" adds to the list)
 *  - footer preview of the trigger words the node will output
 *
 * The widget serialises to the same JSON the Python side parses, so the
 * list is stored in the workflow like any other widget value.
 */

import { app } from "../../scripts/app.js";
import { getLoraBrowser, injectLoraStyles, getTriggersFor } from "./cwk_lora_panel.js";

const LORA_NODE = "CWK_LorA_Prompt_Loader";
const WIDGET_H  = 244;   // fixed DOM widget height (rows scroll internally)

function _fmt(v) { return (Math.round(v * 100) / 100).toFixed(2); }

app.registerExtension({
  name: "CWK.LoraPromptLoader",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== LORA_NODE) return;

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

    // Fallback restore (in case the DOM widget's setValue isn't invoked)
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      try {
        const vals = info?.widgets_values;
        let v;
        if (Array.isArray(vals))              v = vals[0];
        else if (vals && typeof vals === "object") v = vals.lora_config;
        if (v === undefined || v === null) return r;
        this.__cwkLoraApplyJson?.(typeof v === "string" ? v : JSON.stringify(v));
      } catch {}
      return r;
    };

    const onNodeRemoved = nodeType.prototype.onNodeRemoved;
    nodeType.prototype.onNodeRemoved = function () {
      const r = onNodeRemoved?.apply(this, arguments);
      try { this.__cwkLoraRoot?.remove(); } catch {}
      return r;
    };
  },
});

function _setupLoraNode(node) {
  if (typeof node.addDOMWidget !== "function") {
    console.warn("[CWK] addDOMWidget unavailable — " + LORA_NODE +
                 " falls back to the raw JSON widget");
    return;
  }

  const state = { list: [], editIndex: -1 };
  let lastJson = null;

  // ── 1. Remove the native lora_config widget (we replace it) ──────────────
  const native = node.widgets?.find(w => w.name === "lora_config");
  let initial = "[]";
  if (native) {
    initial = String(native.value ?? "[]");
    const i = node.widgets.indexOf(native);
    if (i >= 0) node.widgets.splice(i, 1);
    try { native.onRemove?.(); } catch {}
  }

  // ── 2. Build the DOM UI ──────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "cwk-lora-widget";
  root.style.height = WIDGET_H + "px";
  node.__cwkLoraRoot = root;

  root.innerHTML = `
    <div class="cwkl-w-header">
      <input type="checkbox" class="cwkl-w-all" title="Activate / deactivate all LoRAs"/>
      <span class="cwkl-w-title">LoRAs (<span class="cwkl-w-count">0</span>)</span>
      <span class="cwkl-w-spacer"></span>
      <button class="cwkl-w-add" title="Open the LoRA browser">＋ Add LoRA</button>
    </div>
    <div class="cwkl-w-rows"></div>
    <div class="cwkl-w-empty">No LoRAs yet — click “＋ Add LoRA” to open the browser.</div>
    <div class="cwkl-w-footer">
      <span class="cwkl-w-trigger" title="Trigger words of the active LoRAs">trigger: —</span>
    </div>
  `;

  const rowsEl    = root.querySelector(".cwkl-w-rows");
  const emptyEl   = root.querySelector(".cwkl-w-empty");
  const countEl   = root.querySelector(".cwkl-w-count");
  const allToggle = root.querySelector(".cwkl-w-all");
  const addBtn    = root.querySelector(".cwkl-w-add");
  const trigEl    = root.querySelector(".cwkl-w-trigger");

  // ── 3. DOM widget (serialises to the Python "lora_config" input) ─────────
  const widget = node.addDOMWidget("lora_config", "cwk_lora_list", root, {
    getValue:     () => JSON.stringify(state.list),
    setValue:     v => _applyJson(String(v ?? "[]")),
    getMinHeight: () => WIDGET_H,
  });

  function _applyJson(json) {
    json = String(json ?? "[]");
    if (json === lastJson) return;
    lastJson = json;
    try {
      const parsed = JSON.parse(json);
      state.list = Array.isArray(parsed) ? parsed.map(_normalise).filter(Boolean) : [];
    } catch { state.list = []; }
    _render();
  }

  function _normalise(it) {
    if (!it || typeof it !== "object") return null;
    const name = String(it.name ?? "").trim();
    if (!name) return null;
    let w = Number(it.weight ?? it.model_weight ?? 1);
    if (!Number.isFinite(w)) w = 1;
    return { name, weight: w, enabled: it.enabled !== false };
  }

  function _commit() {
    const json = JSON.stringify(state.list);
    if (json !== lastJson) {
      lastJson = json;
      try { widget.value = json; } catch {}   // keep the stored value in sync
    }
    node.setDirtyCanvas(true, true);
  }

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

  function _buildRow(l, i) {
    const row = document.createElement("div");
    row.className = "cwkl-w-row" + (l.enabled ? "" : " disabled");
    row.innerHTML = `
      <input type="checkbox" class="cwkl-w-en" ${l.enabled ? "checked" : ""}
             title="Activate / deactivate this LoRA"/>
      <span class="cwkl-w-name" title="Click to replace via the LoRA browser"></span>
      <input type="range" class="cwkl-w-weight" min="-2" max="2" step="0.05"
             value="${l.weight}" title="LoRA weight"/>
      <span class="cwkl-w-wval">${_fmt(l.weight)}</span>
      <button class="cwkl-w-del" title="Remove this LoRA">✕</button>
    `;
    const nameEl = row.querySelector(".cwkl-w-name");
    nameEl.textContent = l.name.replace(/^.*[/\\]/, "") || l.name;
    nameEl.title = `${l.name} (click to replace via browser)`;

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
      if (state.editIndex === i)      state.editIndex = -1;
      else if (state.editIndex > i)   state.editIndex--;
      _render();
    });

    nameEl.addEventListener("click", () => {
      state.editIndex = i;
      _openBrowser(`Replace LoRA in slot ${i + 1}`);
    });

    return row;
  }

  function _openBrowser(hint) {
    const browser = getLoraBrowser();
    browser.open(lora => {
      const name = lora?.name;
      if (!name) return;
      if (state.editIndex >= 0 && state.editIndex < state.list.length) {
        state.list[state.editIndex].name = name;   // replace slot (keep weight)
      } else {
        const exists = state.list.findIndex(l => l.name === name);
        if (exists >= 0) state.list[exists].enabled = true;
        else             state.list.push({ name, weight: 1, enabled: true });
      }
      state.editIndex = -1;
      _render();
    }, hint);
  }

  addBtn.addEventListener("click", () => {
    state.editIndex = -1;
    _openBrowser();
  });

  allToggle.addEventListener("change", e => {
    const on = e.target.checked;
    state.list.forEach(l => { l.enabled = on; });
    _render();
  });

  // ── 4. Trigger-word preview (mirrors the node's STRING output) ───────────
  let trigTimer = null;
  function _refreshTriggers() {
    clearTimeout(trigTimer);
    trigTimer = setTimeout(async () => {
      const names = [...new Set(state.list.filter(l => l.enabled).map(l => l.name))];
      const lists = await Promise.all(names.map(getTriggersFor));
      const words = [...new Set(lists.flat())];
      trigEl.textContent = words.length ? `trigger: ${words.join(", ")}` : "trigger: —";
      trigEl.title = words.join(", ") || "No trigger words";
    }, 150);
  }

  // ── 5. Init ───────────────────────────────────────────────────────────────
  node.__cwkLoraApplyJson = _applyJson;
  _applyJson(initial);
  if (!node.size || node.size[0] < 440 || node.size[1] < 350) {
    node.size = [Math.max(node.size?.[0] ?? 440, 440),
                 Math.max(node.size?.[1] ?? 350, 350)];
  }
}
