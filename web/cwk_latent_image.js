/**
 * CWK Latent Image — ComfyUI canvas node extension.
 * Resolution preset + width / height / batch selector outputting a LATENT.
 * Style is identical to CWK Model Preset Manager.
 */

import { app }          from "../../scripts/app.js";
import { injectStyles } from "./cwk_styles.js";

// ─── Node identity ────────────────────────────────────────────────────────────

const NODE_TYPE  = "CWK_LatentImage";
const NODE_MIN_W = 260;

// ─── Layout constants (same values as cwk_preset_manager.js) ─────────────────

const PAD       = 10;
const ROW_H     = 26;
const LABEL_W   = 90;
const ARROW_W   = 20;
const GROUP_SEP_H = 12;

const BTN_H     = 0;   // no button on this node
const BTN_PAD_V = 0;
const BTNS_AREA_H = 0;

const TITLE_H   = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H    = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;
const N_OUTPUTS = 3;   // latent, width, height

function getSlotsBottom() {
  return TITLE_H() + N_OUTPUTS * SLOT_H() + 6;
}

// ─── Colour palette (identical to cwk_preset_manager.js) ─────────────────────

const C = {
  bg:         "#1a1f2e",
  bgFull:     "#141824",
  surface:    "#1e2335",
  border:     "#313552",
  text:       "#cdd6f4",
  textDim:    "#6c7086",
  textBlue:   "#89b4fa",
  hoverBg:    "#2a2f45",
  arrowHov:   "#89b4fa",
  flashGreen: "#a6e3a1",
};
const NODE_COLOR   = "#141824";
const NODE_BGCOLOR = "#1e2335";

// ─── Resolution presets (loaded async from server) ────────────────────────────

let RES_PRESETS     = ["(preset)"];
let RES_PRESETS_MAP = {};   // label → { width, height }

async function _loadResolutionPresets() {
  try {
    const res = await fetch("/cwk/resolution_presets");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      RES_PRESETS = data.map(d => d.label);
      RES_PRESETS_MAP = {};
      for (const d of data) {
        RES_PRESETS_MAP[d.label] = { width: d.width, height: d.height };
      }
      // Patch the live options array on the row descriptor
      const r = LATENT_ROWS.find(r => r.key === "res_preset");
      if (r) r.options = RES_PRESETS;
    }
  } catch (e) {
    console.warn("[CWK LatentImage] Could not load resolution presets:", e);
  }
}

// ─── Row descriptors ──────────────────────────────────────────────────────────
//  Matches the four rows from CWK_ModelPresetManager exactly:
//  res_preset (list), width (int), height (int), batch_size (int)
//  A group separator is drawn before width (same visual grouping as the parent node).

const LATENT_ROWS = [
  { key: "res_preset", label: "Res Preset", widget: "resolution_preset", type: "list", options: RES_PRESETS },
  { key: "width",      label: "Width",      widget: "width",             type: "int",  min: 64,  max: 8192  },
  { key: "height",     label: "Height",     widget: "height",            type: "int",  min: 64,  max: 8192  },
  { key: "batch_size", label: "Batch",      widget: "batch_size",        type: "int",  min: 1,   max: 64    },
];

// Separator before row index 1 (between res_preset and width/height/batch block)
const SEP_BEFORE = new Set([1]);

// ─── Fire async loader ────────────────────────────────────────────────────────

_loadResolutionPresets();

// ─── Settings persistence (survives reloads / browser restarts) ──────────────

const LS_KEY   = "CWK_LatentImage_settings";
const DEFAULTS = { res_preset: "(preset)", width: 1024, height: 1024, batch_size: 1 };

function loadPersistedSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return null;
    const out = { ...DEFAULTS };
    if (typeof d.res_preset === "string" && d.res_preset) out.res_preset = d.res_preset;
    for (const k of ["width", "height", "batch_size"]) {
      const v = Number(d[k]);
      if (Number.isFinite(v)) out[k] = Math.round(v);
    }
    return out;
  } catch { return null; }
}

let _persistTimer = null;
function persistSettings(node) {
  const v = node?._cwkValues ?? DEFAULTS;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try { localStorage.setItem(LS_KEY, JSON.stringify(v)); }
    catch (e) { console.warn("[CWK LatentImage] Could not persist settings:", e); }
  }, 200);
}

// Adopt widget values (restored by LiteGraph from a saved workflow or a clone)
// into the canvas-drawn state.
function syncFromWidgets(node) {
  if (!node._cwkValues) node._cwkValues = { ...DEFAULTS };
  for (const row of LATENT_ROWS) {
    const w = node.widgets?.find(w => w.name === row.widget);
    if (w && w.value !== undefined && w.value !== null && w.value !== "") {
      node._cwkValues[row.key] = row.type === "int" ? Number(w.value) : String(w.value);
    }
  }
}

// Apply last-used settings to a freshly created node (widgets + canvas state).
function applyPersistedToNode(node) {
  const saved = loadPersistedSettings();
  if (!saved) return;
  node._cwkValues = { ...DEFAULTS, ...saved };
  for (const row of LATENT_ROWS) {
    const w = node.widgets?.find(w => w.name === row.widget);
    const val = node._cwkValues[row.key];
    if (w && val !== undefined) { w.value = val; w.callback?.(val); }
  }
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function getRowsStartY() {
  // Start rows just below the output slots area
  return getSlotsBottom() + PAD;
}

function getRowY(i) {
  let y = getRowsStartY();
  for (let r = 0; r < i; r++) {
    y += ROW_H + 3;
    if (SEP_BEFORE.has(r + 1)) y += GROUP_SEP_H;
  }
  return y;
}

function getValueRect(node, i) {
  const ry = getRowY(i);
  const x  = PAD + LABEL_W;
  return { x, y: ry + 1, w: node.size[0] - x - PAD, h: ROW_H - 2 };
}

function calcNodeHeight() {
  let h = getRowsStartY();
  for (let i = 0; i < LATENT_ROWS.length; i++) {
    if (SEP_BEFORE.has(i)) h += GROUP_SEP_H;
    h += ROW_H + 3;
  }
  return h + PAD;
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

function hitTestRow(node, lx, ly) {
  for (let i = 0; i < LATENT_ROWS.length; i++) {
    const ry  = getRowY(i);
    if (ly < ry || ly > ry + ROW_H) continue;
    const vr  = getValueRect(node, i);
    const row = LATENT_ROWS[i];
    if (lx < PAD || lx > node.size[0] - PAD) return { rowIdx: i, part: null };
    if (row.type === "list") return { rowIdx: i, part: "center" };
    if (lx >= vr.x && lx <= vr.x + ARROW_W)               return { rowIdx: i, part: "left"   };
    if (lx >= vr.x + vr.w - ARROW_W && lx <= vr.x + vr.w) return { rowIdx: i, part: "right"  };
    if (lx >= vr.x && lx <= vr.x + vr.w)                   return { rowIdx: i, part: "center" };
    return { rowIdx: i, part: null };
  }
  return null;
}

// ─── Screen coordinate helper ─────────────────────────────────────────────────

function _canvasToScreen(node, vr) {
  const bbox = app.canvas.canvas.getBoundingClientRect();
  const zoom = app.canvas.ds?.scale ?? 1;
  const off  = app.canvas.ds?.offset ?? [0, 0];
  return {
    x: (node.pos[0] + vr.x) * zoom + off[0] * zoom + bbox.left,
    y: (node.pos[1] + vr.y) * zoom + off[1] * zoom + bbox.top,
    w: vr.w * zoom,
    h: vr.h * zoom,
  };
}

function _blockCanvasEvents(el) {
  for (const evt of ["mousedown","mouseup","click","pointerdown","pointerup",
                      "dblclick","contextmenu","wheel","touchstart","touchend"]) {
    el.addEventListener(evt, e => e.stopPropagation());
  }
}

// ─── Value helpers ────────────────────────────────────────────────────────────

function clampValue(row, val) {
  let v = row.type === "int" ? Math.round(Number(val)) : Number(val);
  if (isNaN(v)) return val;
  if (row.min !== undefined) v = Math.max(row.min, v);
  if (row.max !== undefined) v = Math.min(row.max, v);
  return v;
}

function applyRowValue(node, rowIdx, val) {
  const row = LATENT_ROWS[rowIdx];
  if (!node._cwkValues) node._cwkValues = {};
  node._cwkValues[row.key] = val;
  const w = node.widgets?.find(w => w.name === row.widget);
  if (w) { w.value = val; w.callback?.(val); }
  persistSettings(node);               // ← NEW: remember last-used values
  app.canvas.setDirty(true, false);
}

// ─── Inline number editor ─────────────────────────────────────────────────────

function closeInlineEditor() {
  document.getElementById("cwk-latent-backdrop")?.remove();
  document.getElementById("cwk-latent-editor")?.remove();
}

function openInlineNumberEditor(node, rowIdx, currentValue, onCommit) {
  closeInlineEditor();
  closeDropdown();
  const row  = LATENT_ROWS[rowIdx];
  const vr   = getValueRect(node, rowIdx);
  const sc   = _canvasToScreen(node, vr);
  const zoom = app.canvas.ds?.scale ?? 1;

  const backdrop = document.createElement("div");
  backdrop.id = "cwk-latent-backdrop";
  Object.assign(backdrop.style, {
    position: "fixed", inset: "0", zIndex: "99998", background: "transparent",
  });

  const input = document.createElement("input");
  input.id = "cwk-latent-editor";
  input.type = "text"; input.inputMode = "numeric";
  input.value = String(currentValue ?? "");
  Object.assign(input.style, {
    position: "fixed",
    left: sc.x + "px", top: sc.y + "px",
    width: sc.w + "px", height: sc.h + "px",
    fontSize: Math.max(11, Math.round(11 * zoom)) + "px",
    fontFamily: "Inter,system-ui,sans-serif",
    background: C.bgFull, color: C.text,
    border: `1px solid ${C.arrowHov}`,
    borderRadius: "3px", outline: "none",
    zIndex: "99999", padding: "0 6px",
    textAlign: "center", boxSizing: "border-box",
  });

  _blockCanvasEvents(input);
  _blockCanvasEvents(backdrop);

  let committed = false;
  const commit = () => {
    if (committed) return; committed = true;
    const raw = input.value.trim();
    closeInlineEditor();
    if (raw !== "") onCommit(clampValue(row, raw));
    app.canvas.setDirty(true, false);
  };
  const cancel = () => {
    if (committed) return; committed = true;
    closeInlineEditor();
    app.canvas.setDirty(true, false);
  };

  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { cancel(); }
  });
  backdrop.addEventListener("mousedown",   e => { e.stopPropagation(); e.preventDefault(); commit(); });
  backdrop.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); commit(); });

  backdrop.appendChild(input);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => { setTimeout(() => { input.focus(); input.select(); }, 0); });
}

// ─── Dropdown (for list-type rows) ────────────────────────────────────────────

let _ddOutside = null;

function closeDropdown() {
  document.getElementById("cwk-latent-dropdown")?.remove();
  if (_ddOutside) {
    document.removeEventListener("pointerdown", _ddOutside, { capture: true });
    _ddOutside = null;
  }
}

function openDropdown(node, rowIdx, currentValue, onCommit) {
  closeDropdown();
  closeInlineEditor();
  const row  = LATENT_ROWS[rowIdx];
  const vr   = getValueRect(node, rowIdx);
  const sc   = _canvasToScreen(node, vr);
  const zoom = app.canvas.ds?.scale ?? 1;
  const opts = row.options ?? [];

  const maxVisible = Math.min(opts.length, 12);
  const optionH    = Math.max(16, Math.round(18 * zoom));
  const listH      = maxVisible * optionH + 4;
  const spaceBelow = window.innerHeight - sc.y - sc.h - 4;
  const dropTop    = (spaceBelow >= listH || spaceBelow >= sc.y - 4)
    ? sc.y + sc.h + 1
    : sc.y - listH - 1;

  const sel = document.createElement("select");
  sel.id   = "cwk-latent-dropdown";
  sel.size = maxVisible;
  Object.assign(sel.style, {
    position: "fixed",
    left: sc.x + "px", top: dropTop + "px",
    width: sc.w + "px", height: listH + "px",
    fontSize: Math.max(11, Math.round(11 * zoom)) + "px",
    fontFamily: "Inter,system-ui,sans-serif",
    background: C.bgFull, color: C.text,
    border: `1px solid ${C.arrowHov}`,
    borderRadius: "4px", outline: "none",
    zIndex: "99999", cursor: "pointer",
    padding: "2px 0", overflow: "auto",
  });

  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    Object.assign(o.style, {
      padding: "2px 8px",
      background: String(currentValue) === opt ? C.hoverBg : "transparent",
      color:      String(currentValue) === opt ? C.arrowHov : C.text,
    });
    if (String(currentValue) === opt) o.selected = true;
    sel.appendChild(o);
  }

  _blockCanvasEvents(sel);
  document.body.appendChild(sel);
  sel.focus();
  sel.querySelector("option:checked")?.scrollIntoView({ block: "nearest" });

  let committed = false;
  const commit = val => {
    if (committed) return; committed = true;
    closeDropdown();
    onCommit(val ?? sel.value);
    app.canvas.setDirty(true, false);
  };

  sel.addEventListener("click",   ()  => { commit(sel.value); });
  sel.addEventListener("keydown", e   => {
    e.stopPropagation();
    if (e.key === "Enter")  { e.preventDefault(); commit(sel.value); }
    if (e.key === "Escape") { committed = true; closeDropdown(); app.canvas.setDirty(true, false); }
  });

  _ddOutside = e => {
    if (e.target !== sel && !sel.contains(e.target)) {
      if (!committed) { committed = true; closeDropdown(); app.canvas.setDirty(true, false); }
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", _ddOutside, { capture: true });
  }, 50);
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function drawNode(node, ctx) {
  const w       = node.size[0];
  const h       = node.size[1];
  const hover   = node._cwkHover;
  const vals    = node._cwkValues ?? {};
  const cornerR = LiteGraph.NODE_BORDER_RADIUS ?? 8;

  ctx.save();
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, cornerR); ctx.clip();

  // ── Background ──
  ctx.fillStyle = C.bgFull;
  ctx.fillRect(0, 0, w, h);

  // Slightly lighter bg for the rows area (same two-tone split as preset manager)
  const contentY = getRowsStartY() - PAD;
  ctx.fillStyle  = C.bg;
  ctx.fillRect(0, contentY, w, h - contentY);

  // ── Divider above rows ──
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  ctx.beginPath();
  const divY = getRowsStartY() - PAD / 2;
  ctx.moveTo(PAD, divY); ctx.lineTo(w - PAD, divY); ctx.stroke();

/*  // ── Size preview chip (shows current resolution in the header area) ──
  {
    const curW = vals.width  ?? 1024;
    const curH = vals.height ?? 1024;
    const label = `${curW} × ${curH}`;
    const chipX = PAD;
    const chipY = TITLE_H() + PAD / 2;
    const chipH = 18;

    ctx.fillStyle = C.surface;
    roundRect(ctx, chipX, chipY, w - PAD * 2, chipH, 4);
    ctx.fill();
    ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();

    ctx.fillStyle    = C.textBlue;
    ctx.font         = "bold 11px Inter,system-ui,sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, w / 2, chipY + chipH / 2, w - PAD * 4);
  }*/

  // ── Rows ──
  for (let i = 0; i < LATENT_ROWS.length; i++) {
    const row     = LATENT_ROWS[i];
    const ry      = getRowY(i);
    const vr      = getValueRect(node, i);
    const val     = vals[row.key] ?? (row.type === "list" ? row.options?.[0] : (row.key === "batch_size" ? 1 : 1024));
    const isHov   = hover?.rowIdx === i;
    const hovPart = isHov ? hover.part : null;

    // Group separator before width row
    if (SEP_BEFORE.has(i)) {
      const sepY = ry - GROUP_SEP_H / 2 - 1;
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD, sepY); ctx.lineTo(w - PAD, sepY); ctx.stroke();
    }

    // Row hover highlight
    if (isHov) {
      roundRect(ctx, PAD, ry, w - PAD * 2, ROW_H, 3);
      ctx.fillStyle = C.hoverBg; ctx.fill();
    }

    // Label
    ctx.fillStyle    = C.textDim;
    ctx.font         = "11px Inter,system-ui,sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(row.label, PAD + 4, ry + ROW_H / 2);

    // Value box
    roundRect(ctx, vr.x, vr.y, vr.w, vr.h, 4);
    ctx.fillStyle   = C.surface;
    ctx.strokeStyle = isHov ? C.border : "transparent";
    ctx.lineWidth   = 1;
    ctx.fill();
    if (isHov) ctx.stroke();

    // Value content
    if (row.type === "list") {
      // Dropdown arrow
      ctx.fillStyle    = isHov ? C.arrowHov : C.textDim;
      ctx.font         = "9px sans-serif";
      ctx.textAlign    = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("▾", vr.x + vr.w - 5, ry + ROW_H / 2);
      // Value text
      ctx.fillStyle = C.text;
      ctx.font      = "11px Inter,system-ui,sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(val), vr.x + 6, ry + ROW_H / 2, vr.w - 18);
    } else {
      // ◀ ▶ stepper
      ctx.font         = "10px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillStyle    = (hovPart === "left")  ? C.arrowHov : C.textDim;
      ctx.textAlign    = "left";
      ctx.fillText("◀", vr.x + 4, ry + ROW_H / 2);
      ctx.fillStyle = (hovPart === "right") ? C.arrowHov : C.textDim;
      ctx.textAlign = "right";
      ctx.fillText("▶", vr.x + vr.w - 4, ry + ROW_H / 2);
      ctx.fillStyle = (hovPart === "center") ? C.arrowHov : C.text;
      ctx.font      = "11px Inter,system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(val), vr.x + vr.w / 2, ry + ROW_H / 2, vr.w - ARROW_W * 2 - 4);
    }
  }

  ctx.restore();
}

// ─── Extension ────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "CWK.LatentImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      injectStyles();
      const node = this;

      node._cwkHover  = null;
      node._cwkValues = {
        res_preset: "(preset)",
        width:      1024,
        height:     1024,
        batch_size: 1,
      };

      node.color   = NODE_COLOR;
      node.bgcolor = NODE_BGCOLOR;

            // Hide all LiteGraph widgets — canvas draws everything.
      setTimeout(() => {
        for (const w of node.widgets ?? []) {
          w.type = "hidden"; w.hidden = true;
          w.computeSize = () => [0, -4];
        }

        if (!node._cwkFromGraph) {
          // Freshly added node (not restored from a workflow):
          // start from the last-used settings.
          applyPersistedToNode(node);
        }
        // Nodes restored from a workflow already have their widget values set
        // by configure(); onConfigure/afterConfigureGraph synced them.

        node.size[0] = Math.max(node.size[0], NODE_MIN_W);
        node.size[1] = calcNodeHeight();
        app.canvas.setDirty(true, true);
      }, 0);

      // LiteGraph calls this whenever serialized data is applied to the node
      // (workflow load, copy/paste, clone). Widget values are already restored
      // at this point — adopt them into the canvas state.
      node.onConfigure = function () {
        this._cwkFromGraph = true;
        syncFromWidgets(this);
      };
		
      node.onDrawForeground = function (ctx) {
		if (this.flags?.collapsed) return;
		drawNode(this, ctx);
	  };

      node.onResize = function () {
        this.size[0] = Math.max(NODE_MIN_W, this.size[0]);
        this.size[1] = calcNodeHeight();
      };

      // ── Mouse interaction ──────────────────────────────────────────────────

      node.onMouseDown = function (e, pos) {
        const hit = hitTestRow(this, pos[0], pos[1]);
        if (!hit || hit.part === null) return false;
        const { rowIdx, part } = hit;
        const row = LATENT_ROWS[rowIdx];
        const cur = node._cwkValues?.[row.key];

        if (row.type === "list") {
          openDropdown(node, rowIdx, cur, val => {
            applyRowValue(node, rowIdx, val);
            // When a res preset is chosen, auto-fill width and height
            if (row.key === "res_preset" && val !== "(preset)") {
              const dims = RES_PRESETS_MAP[val];
              if (dims && dims.width > 0 && dims.height > 0) {
                const wi = LATENT_ROWS.findIndex(r => r.key === "width");
                const hi = LATENT_ROWS.findIndex(r => r.key === "height");
                if (wi >= 0) applyRowValue(node, wi, dims.width);
                if (hi >= 0) applyRowValue(node, hi, dims.height);
              }
            }
          });
          return true;
        }

        if (part === "left") {
          const step = row.key === "width" || row.key === "height" ? 8 : 1;
          applyRowValue(node, rowIdx, clampValue(row, Number(cur) - step));
          return true;
        }
        if (part === "right") {
          const step = row.key === "width" || row.key === "height" ? 8 : 1;
          applyRowValue(node, rowIdx, clampValue(row, Number(cur) + step));
          return true;
        }
        if (part === "center") {
          openInlineNumberEditor(node, rowIdx, cur, val => applyRowValue(node, rowIdx, val));
          return true;
        }
        return false;
      };

      node.onMouseMove = function (e, pos) {
        const hit    = hitTestRow(this, pos[0], pos[1]);
        const newHov = hit ? { rowIdx: hit.rowIdx, part: hit.part } : null;
        if (JSON.stringify(node._cwkHover) !== JSON.stringify(newHov)) {
          node._cwkHover = newHov;
          app.canvas.setDirty(true, false);
        }
      };

      node.onMouseLeave = function () {
        if (node._cwkHover !== null) {
          node._cwkHover = null;
          app.canvas.setDirty(true, false);
        }
      };
	  
	  afterConfigureGraph() {
    // Workflow finished loading: make sure every node of this type shows the
    // values it was saved with (onConfigure normally already did), and treat
    // the loaded values as the new "last used".
    for (const node of app.graph._nodes) {
      if (node.type !== NODE_TYPE) continue;
      node._cwkFromGraph = true;
      syncFromWidgets(node);
      persistSettings(node);   // delete this line if you want only explicit
                               // edits (not opened workflows) to update defaults
    }
    // Late re-sync in case the frontend restores widget values asynchronously.
    setTimeout(() => {
      for (const node of app.graph._nodes) {
        if (node.type === NODE_TYPE) syncFromWidgets(node);
      }
      app.canvas?.setDirty?.(true, true);
    }, 500);
  },
    };
  },
});
