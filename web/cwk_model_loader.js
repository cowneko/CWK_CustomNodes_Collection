/**
 * CWK Model Loader — ComfyUI canvas node extension.
 * Simplified model loader with dynamic AIO / non-AIO layout.
 */

import { app }               from "../../scripts/app.js";
import { injectStyles }      from "./cwk_styles.js";
import { ModelBrowserPanel } from "./cwk_panel.js";
import { getBaseModelBadges, getBaseBadge as _getBaseBadgeFrom } from "./cwk_base_models.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_TYPE  = "CWK_ModelLoader";
const NODE_MIN_W = 320;

const PAD      = 10;
const THUMB_W  = 120;
const THUMB_H  = 180;
const ROW_H    = 26;
const LABEL_W  = 100;
const ARROW_W  = 20;
const BTN_H    = 26;
const BTN_PAD_V = 8;
const BTNS_AREA_H = BTN_PAD_V + BTN_H + BTN_PAD_V;   // single button
const GROUP_SEP_H = 10;

const QUICK_LOAD_H     = 28;
const QUICK_LOAD_GAP   = 6;
const QUICK_LOAD_PAD   = 6;
const QUICK_LOAD_TOTAL_H = QUICK_LOAD_PAD + QUICK_LOAD_H + QUICK_LOAD_PAD + GROUP_SEP_H;

const TITLE_H   = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H    = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;
const N_OUTPUTS = 1;   // single "pipe" output slot

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

const BTN_COLOR = { border: "#313552", hoverBorder: "#89b4fa", hoverText: "#89b4fa" };

// ─── Row options (loaded async) ───────────────────────────────────────────────

let CLIPS      = ["embedded"];
let CLIP_TYPES = ["stable_diffusion"];
let VAES       = ["embedded"];

// ─── Row descriptors ──────────────────────────────────────────────────────────

const ROWS_NON_AIO = [
  { key: "clip_name", label: "CLIP",      widget: "clip_name", type: "list", options: CLIPS      },
  { key: "clip_type", label: "Clip Type", widget: "clip_type", type: "list", options: CLIP_TYPES },
  { key: "vae_name",  label: "VAE",       widget: "vae_name",  type: "list", options: VAES       },
];

function getActiveRows(node) {
  return node._cwkIsAIO ? [] : ROWS_NON_AIO;
}

// ─── Base-model badge helpers (same as preset_manager.js) ────────────────────

// ─── Base-model badge helpers (dynamic, from CivitAI's base-model list) ──────

// Resolved once (module load) from the shared `cwk_base_models.js` helper;
// `_getBaseBadge()` falls back to grouping everything under "Other" until
// this resolves, then a later model-list refresh picks up proper grouping.
let _baseBadges = [];
getBaseModelBadges().then(list => {
  _baseBadges = list;
  // The quick-load model list is very likely already built (or in flight)
  // using the "Other"/"???" fallback badges by the time this resolves —
  // re-run it now so the dropdowns pick up correct grouping/badges without
  // requiring a manual reload.
  _loadQuickLoadModels();
}).catch(() => {});

function _getBaseBadge(baseModel) {
  return _getBaseBadgeFrom(baseModel, _baseBadges);
}

function _cleanDisplayName(name) {
  return name.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "");
}

// ─── Quick-load model list ────────────────────────────────────────────────────

let _quickLoadModels = null;
let _quickLoadReady  = false;

async function _loadQuickLoadModels() {
  try {
    const res = await fetch("/cwk/models");
    if (!res.ok) return;
    const models = await res.json();
    if (!Array.isArray(models)) return;

    const checkpoints = [];
    const diffusion   = [];
    for (const m of models) {
      const entry = {
        name:      m.name,
        display:   _cleanDisplayName(m.name),
        baseModel: m.civitai?.base_model ?? m.civitai?.baseModel ?? "",
        badge:     _getBaseBadge(m.civitai?.base_model ?? m.civitai?.baseModel ?? ""),
        type:      m.type ?? "checkpoint",
      };
      if (m.type === "diffusion_model" || m.type === "gguf") diffusion.push(entry);
      else checkpoints.push(entry);
    }
    const sorter = (a, b) => {
      const ba = a.badge.label.toLowerCase();
      const bb = b.badge.label.toLowerCase();
      if (ba !== bb) return ba < bb ? -1 : 1;
      return a.display.toLowerCase().localeCompare(b.display.toLowerCase());
    };
    checkpoints.sort(sorter);
    diffusion.sort(sorter);
    _quickLoadModels = { checkpoints, diffusion };
    _quickLoadReady  = true;
  } catch (e) {
    console.warn("[CWK Loader] Could not load quick-load model list:", e);
  }
}
_loadQuickLoadModels();

// ─── Async data loaders ───────────────────────────────────────────────────────

async function _loadOptions() {
  try {
    const [clipRes, vaeRes] = await Promise.all([
      fetch("/cwk/clips"),
      fetch("/cwk/vaes"),
    ]);
    if (clipRes.ok) {
      const { clips } = await clipRes.json();
      if (clips?.length) {
        CLIPS.length = 0; CLIPS.push(...clips);
        ROWS_NON_AIO.find(r => r.key === "clip_name").options = CLIPS;
      }
    }
    if (vaeRes.ok) {
      const { vaes } = await vaeRes.json();
      if (vaes?.length) {
        VAES.length = 0; VAES.push(...vaes);
        ROWS_NON_AIO.find(r => r.key === "vae_name").options = VAES;
      }
    }
  } catch (e) {
    console.warn("[CWK Loader] Could not load CLIP/VAE lists:", e);
  }
  try {
    const res = await fetch("/object_info/CWK_ModelLoader");
    if (!res.ok) return;
    const data = await res.json();
    const inputs = data?.CWK_ModelLoader?.input;
    const clipTypes = (inputs?.optional?.clip_type?.[0] ?? []);
    if (clipTypes.length) {
      CLIP_TYPES.length = 0; CLIP_TYPES.push(...clipTypes);
      ROWS_NON_AIO.find(r => r.key === "clip_type").options = CLIP_TYPES;
    }
  } catch (e) {
    console.warn("[CWK Loader] Could not load clip_type list:", e);
  }
}
_loadOptions();

// ─── Image cache ──────────────────────────────────────────────────────────────

const _imgCache = new Map();
function loadImage(url) {
  if (!url) return null;
  if (_imgCache.has(url)) return _imgCache.get(url);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => app.canvas.setDirty(true, false);
  img.src = url;
  _imgCache.set(url, img);
  return img;
}

function _isVideoUrl(url, type) {
  if (String(type ?? "").toLowerCase() === "video") return true;
  if (!url) return false;
  try { const p = new URL(url).pathname.toLowerCase(); return p.endsWith(".mp4") || p.endsWith(".webm"); }
  catch { const l = url.toLowerCase(); return l.includes(".mp4") || l.includes(".webm"); }
}

function _resolveThumb(meta) {
  const thumb = meta?.thumbnail;
  if (thumb && !_isVideoUrl(thumb)) return { url: thumb, blur: false };
  const images = meta?.images;
  if (!Array.isArray(images) || !images.length) return { url: null, blur: false };
  const stills = images.filter(img => img?.url && !_isVideoUrl(img.url, img.type));
  if (!stills.length) return { url: null, blur: false };
  const sfw = stills.find(img => (img.nsfwLevel ?? 0) <= 1);
  if (sfw) return { url: sfw.url, blur: false };
  const sorted = [...stills].sort((a, b) => (a.nsfwLevel ?? 0) - (b.nsfwLevel ?? 0));
  return { url: sorted[0].url, blur: true };
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function getThumbRect(node) {
  const regionTop    = TITLE_H();
  const regionBottom = getSlotsBottom();
  const regionH      = regionBottom - regionTop;
  if (THUMB_H <= regionH - PAD * 2) {
    const thumbY = regionTop + (regionH - THUMB_H) / 2;
    return { x: PAD, y: thumbY, w: THUMB_W, h: THUMB_H };
  }
  return { x: PAD, y: regionTop + PAD, w: THUMB_W, h: THUMB_H };
}

function _getBaseRowsY(node) {
  const thumbRect   = getThumbRect(node);
  const thumbBottom = thumbRect.y + thumbRect.h + PAD;
  const slotsBottom = getSlotsBottom() + PAD;
  return Math.max(thumbBottom, slotsBottom);
}

function getQuickLoadY(node)  { return _getBaseRowsY(node) + QUICK_LOAD_PAD; }

function getQuickLoadRects(node) {
  const y    = getQuickLoadY(node);
  const x    = PAD;
  const w    = node.size[0] - PAD * 2;
  const half = Math.floor((w - QUICK_LOAD_GAP) / 2);
  return [
    { x,                            y, w: half,                       h: QUICK_LOAD_H, kind: "checkpoint" },
    { x: x + half + QUICK_LOAD_GAP, y, w: w - half - QUICK_LOAD_GAP, h: QUICK_LOAD_H, kind: "diffusion"  },
  ];
}

function getRowsStartY(node) { return _getBaseRowsY(node) + QUICK_LOAD_TOTAL_H; }

function getRowY(node, i) {
  const y = getRowsStartY(node);
  return y + i * (ROW_H + 3);
}

function getButtonRect(node) {
  const baseY = node.size[1] - BTNS_AREA_H + BTN_PAD_V;
  return { x: PAD, y: baseY, w: node.size[0] - PAD * 2, h: BTN_H };
}

function getValueRect(node, i) {
  const ry = getRowY(node, i);
  const x  = PAD + LABEL_W;
  return { x, y: ry + 1, w: node.size[0] - x - PAD, h: ROW_H - 2 };
}

function calcNodeHeight(node) {
  const rows = getActiveRows(node);
  let h = getRowsStartY(node);
  h += rows.length * (ROW_H + 3);
  return h + PAD + BTNS_AREA_H;
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

function hitTestButton(node, lx, ly) {
  const r = getButtonRect(node);
  return (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) ? "load" : null;
}

function hitTestRow(node, lx, ly) {
  const rows = getActiveRows(node);
  for (let i = 0; i < rows.length; i++) {
    const ry  = getRowY(node, i);
    if (ly < ry || ly > ry + ROW_H) continue;
    const vr  = getValueRect(node, i);
    const row = rows[i];
    if (lx < PAD || lx > node.size[0] - PAD) return { rowIdx: i, part: null };
    if (row.type === "list") return { rowIdx: i, part: "center" };
    if (lx >= vr.x && lx <= vr.x + ARROW_W)               return { rowIdx: i, part: "left"   };
    if (lx >= vr.x + vr.w - ARROW_W && lx <= vr.x + vr.w) return { rowIdx: i, part: "right"  };
    if (lx >= vr.x && lx <= vr.x + vr.w)                   return { rowIdx: i, part: "center" };
    return { rowIdx: i, part: null };
  }
  return null;
}

function hitTestQuickLoad(node, lx, ly) {
  for (const qlr of getQuickLoadRects(node)) {
    if (lx >= qlr.x && lx <= qlr.x + qlr.w && ly >= qlr.y && ly <= qlr.y + qlr.h) return qlr.kind;
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
  return row.type === "float" ? parseFloat(v.toFixed(2)) : v;
}

// ─── Inline number editor ─────────────────────────────────────────────────────

function closeInlineEditor() {
  document.getElementById("cwk-loader-backdrop")?.remove();
  document.getElementById("cwk-loader-editor")?.remove();
}

function openInlineNumberEditor(node, rowIdx, currentValue, onCommit) {
  closeInlineEditor();
  closeDropdown();
  const rows = getActiveRows(node);
  const row  = rows[rowIdx];
  const vr   = getValueRect(node, rowIdx);
  const sc   = _canvasToScreen(node, vr);
  const zoom = app.canvas.ds?.scale ?? 1;

  const backdrop = document.createElement("div");
  backdrop.id = "cwk-loader-backdrop";
  Object.assign(backdrop.style, { position:"fixed", inset:"0", zIndex:"99998", background:"transparent" });

  const input = document.createElement("input");
  input.id = "cwk-loader-editor"; input.type = "text"; input.inputMode = "decimal";
  input.value = String(currentValue ?? "");
  Object.assign(input.style, {
    position:"fixed", left:sc.x+"px", top:sc.y+"px", width:sc.w+"px", height:sc.h+"px",
    fontSize:Math.max(11,Math.round(11*zoom))+"px", fontFamily:"Inter,system-ui,sans-serif",
    background:C.bgFull, color:C.text, border:`1px solid ${C.arrowHov}`,
    borderRadius:"3px", outline:"none", zIndex:"99999", padding:"0 6px",
    textAlign:"center", boxSizing:"border-box",
  });
  _blockCanvasEvents(input); _blockCanvasEvents(backdrop);
  let committed = false;
  const commit = () => {
    if (committed) return; committed = true;
    const raw = input.value.trim(); closeInlineEditor();
    if (raw !== "") onCommit(clampValue(row, raw));
    app.canvas.setDirty(true, false);
  };
  const cancel = () => { if (committed) return; committed = true; closeInlineEditor(); app.canvas.setDirty(true, false); };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") cancel();
  });
  backdrop.addEventListener("mousedown", e => { e.stopPropagation(); e.preventDefault(); commit(); });
  backdrop.addEventListener("pointerdown", e => { e.stopPropagation(); e.preventDefault(); commit(); });
  backdrop.appendChild(input);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => { setTimeout(() => { input.focus(); input.select(); }, 0); });
}

// ─── Dropdown ─────────────────────────────────────────────────────────────────

let _ddOutside = null;

function closeDropdown() {
  document.getElementById("cwk-loader-dropdown")?.remove();
  if (_ddOutside) { document.removeEventListener("pointerdown", _ddOutside, { capture:true }); _ddOutside = null; }
}

function openDropdown(node, rowIdx, currentValue, onCommit) {
  closeDropdown(); closeInlineEditor();
  const rows = getActiveRows(node);
  const row  = rows[rowIdx];
  const vr   = getValueRect(node, rowIdx);
  const sc   = _canvasToScreen(node, vr);
  const zoom = app.canvas.ds?.scale ?? 1;
  const maxV = Math.min(row.options.length, 12);
  const optH = Math.max(16, Math.round(18 * zoom));
  const listH = maxV * optH + 4;
  const spaceBelow = window.innerHeight - sc.y - sc.h - 4;
  const dropTop = (spaceBelow >= listH || spaceBelow >= sc.y - 4) ? sc.y + sc.h + 1 : sc.y - listH - 1;

  const sel = document.createElement("select");
  sel.id = "cwk-loader-dropdown"; sel.size = maxV;
  Object.assign(sel.style, {
    position:"fixed", left:sc.x+"px", top:dropTop+"px", width:sc.w+"px", height:listH+"px",
    fontSize:Math.max(11,Math.round(11*zoom))+"px", fontFamily:"Inter,system-ui,sans-serif",
    background:C.bgFull, color:C.text, border:`1px solid ${C.arrowHov}`,
    borderRadius:"4px", outline:"none", zIndex:"99999", cursor:"pointer", padding:"2px 0", overflow:"auto",
  });
  for (const opt of row.options) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    Object.assign(o.style, {
      padding:"2px 8px",
      background: String(currentValue) === opt ? C.hoverBg : "transparent",
      color:      String(currentValue) === opt ? C.arrowHov : C.text,
    });
    if (String(currentValue) === opt) o.selected = true;
    sel.appendChild(o);
  }
  _blockCanvasEvents(sel);
  document.body.appendChild(sel); sel.focus();
  sel.querySelector("option:checked")?.scrollIntoView({ block:"nearest" });

  let committed = false;
  const commit = val => {
    if (committed) return; committed = true;
    closeDropdown(); onCommit(val ?? sel.value); app.canvas.setDirty(true, false);
  };
  sel.addEventListener("click",   () => commit(sel.value));
  sel.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(sel.value); }
    if (e.key === "Escape") { committed = true; closeDropdown(); app.canvas.setDirty(true, false); }
  });
  _ddOutside = e => {
    if (e.target !== sel && !sel.contains(e.target)) {
      if (!committed) { committed = true; closeDropdown(); app.canvas.setDirty(true, false); }
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", _ddOutside, { capture:true }), 50);
}

// ─── Quick-load dropdown ──────────────────────────────────────────────────────

function closeQuickLoad() { document.getElementById("cwk-loader-ql-backdrop")?.remove(); }

function openQuickLoadDropdown(node, kind) {
  closeQuickLoad(); closeInlineEditor(); closeDropdown();
  if (!_quickLoadReady || !_quickLoadModels) return;
  const list = kind === "checkpoint" ? _quickLoadModels.checkpoints : _quickLoadModels.diffusion;
  if (!list.length) return;

  const rects = getQuickLoadRects(node);
  const qlr   = kind === "checkpoint" ? rects[0] : rects[1];
  const sc    = _canvasToScreen(node, qlr);

  const backdrop = document.createElement("div");
  backdrop.id = "cwk-loader-ql-backdrop";
  Object.assign(backdrop.style, { position:"fixed", inset:"0", zIndex:"99998", background:"transparent" });
  _blockCanvasEvents(backdrop);

  const drop = document.createElement("div");
  Object.assign(drop.style, {
    position:"fixed", left:sc.x+"px", top:(sc.y+sc.h+2)+"px",
    width:Math.max(280,sc.w)+"px", maxHeight:"320px", overflowY:"auto",
    background:C.bgFull, border:`1px solid ${C.border}`,
    borderRadius:"6px", boxShadow:"0 8px 32px rgba(0,0,0,.65)",
    zIndex:"99999", fontFamily:"Inter, system-ui, sans-serif", padding:"4px 0",
  });
  _blockCanvasEvents(drop);

  let lastBadge = "";
  for (const m of list) {
    if (m.badge.label !== lastBadge) {
      lastBadge = m.badge.label;
      const header = document.createElement("div");
      Object.assign(header.style, {
        padding:"4px 10px 2px 10px", fontSize:"10px", fontWeight:"700",
        color:m.badge.color, textTransform:"uppercase", letterSpacing:"0.5px",
        borderTop: lastBadge !== list[0].badge.label ? `1px solid ${C.border}` : "none",
        marginTop: lastBadge !== list[0].badge.label ? "2px" : "0",
      });
      header.textContent = m.badge.label;
      drop.appendChild(header);
    }
    const item = document.createElement("div");
    Object.assign(item.style, {
      padding:"5px 10px", fontSize:"12px", color:C.text, cursor:"pointer",
      display:"flex", alignItems:"center", gap:"6px", transition:"background .1s",
    });
    const badge = document.createElement("span");
    Object.assign(badge.style, {
      fontSize:"9px", fontWeight:"700", background:m.badge.color, color:"#1e1e2e",
      borderRadius:"3px", padding:"1px 4px", flexShrink:"0", minWidth:"32px", textAlign:"center",
    });
    badge.textContent = m.badge.label;
    const nameSpan = document.createElement("span");
    Object.assign(nameSpan.style, { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:"1" });
    nameSpan.textContent = m.display;
    item.appendChild(badge); item.appendChild(nameSpan); item.title = m.name;
    item.addEventListener("mouseenter", () => { item.style.background = C.hoverBg; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; });
    item.addEventListener("click", () => { closeQuickLoad(); _loadModelIntoNode(node, m.name, m.type); });
    drop.appendChild(item);
  }

  backdrop.addEventListener("pointerdown", () => closeQuickLoad());
  backdrop.appendChild(drop);
  document.body.appendChild(backdrop);

  requestAnimationFrame(() => {
    const r = drop.getBoundingClientRect();
    if (r.bottom > window.innerHeight) drop.style.top = (sc.y - r.height - 2) + "px";
    if (r.right  > window.innerWidth)  drop.style.left = (window.innerWidth - r.width - 8) + "px";
  });
}

// ─── Load model into node ─────────────────────────────────────────────────────

async function _loadModelIntoNode(node, modelName, modelType) {
  const getW = name => node.widgets?.find(w => w.name === name);

  // Set model_name widget
  const mw = getW("model_name");
  if (mw) { mw.value = modelName; mw.callback?.(modelName); }
  node._cwkModelName = modelName;

  // Determine AIO status
  let isAIO = true;
  if (modelType) {
    isAIO = (modelType !== "diffusion_model" && modelType !== "gguf");
  } else {
    // Fallback: look up from the cached quick-load list
    if (_quickLoadReady && _quickLoadModels) {
      const inDiff = _quickLoadModels.diffusion.find(m => m.name === modelName);
      if (inDiff) isAIO = false;
    }
    // Further fallback: file extension heuristic
    const lower = modelName.toLowerCase();
    if (lower.endsWith(".gguf")) isAIO = false;
  }

  const prevAIO = node._cwkIsAIO;
  node._cwkIsAIO = isAIO;

  // If AIO, force CLIP/VAE widgets back to embedded defaults
  if (isAIO) {
    const clipW = getW("clip_name"); if (clipW) { clipW.value = "embedded"; clipW.callback?.("embedded"); }
    const vaeW  = getW("vae_name");  if (vaeW)  { vaeW.value  = "embedded"; vaeW.callback?.("embedded"); }
    const ctW   = getW("clip_type"); if (ctW)   { ctW.value   = "stable_diffusion"; ctW.callback?.("stable_diffusion"); }
    if (!node._cwkValues) node._cwkValues = {};
    node._cwkValues.clip_name = "embedded";
    node._cwkValues.clip_type = "stable_diffusion";
    node._cwkValues.vae_name  = "embedded";
  }

  // Fetch CivitAI meta for thumbnail
  try {
    const res = await fetch(`/cwk/civitai/meta?model=${encodeURIComponent(modelName)}`);
    if (res.ok) node._cwkMeta = await res.json();
  } catch {}

  // Recalculate height if AIO state changed
  if (prevAIO !== node._cwkIsAIO) {
    node.size[0] = Math.max(NODE_MIN_W, node.size[0]);
    node.size[1] = calcNodeHeight(node);
  }

  node.setDirtyCanvas(true);
}

// ─── Apply row value ──────────────────────────────────────────────────────────

function applyRowValue(node, rowIdx, val) {
  const rows = getActiveRows(node);
  const row  = rows[rowIdx];
  if (!node._cwkValues) node._cwkValues = {};
  node._cwkValues[row.key] = val;
  const w = node.widgets?.find(w => w.name === row.widget);
  if (w) { w.value = val; w.callback?.(val); }
  app.canvas.setDirty(true, false);
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function drawNode(node, ctx) {
  const w      = node.size[0];
  const h      = node.size[1];
  const thumbR = getThumbRect(node);
  const infoX  = PAD + THUMB_W + PAD;
  const infoW  = w - infoX - PAD;
  const meta   = node._cwkMeta ?? {};
  const hover  = node._cwkHover;
  const vals   = node._cwkValues ?? {};
  const cornerR = LiteGraph.NODE_BORDER_RADIUS ?? 8;

  ctx.save();
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, cornerR); ctx.clip();

  // Background
  ctx.fillStyle = C.bgFull; ctx.fillRect(0, 0, w, h);
  const contentY = getRowsStartY(node) - PAD;
  ctx.fillStyle = C.bg; ctx.fillRect(0, contentY, w, h - contentY);

  // ── Thumbnail ──
  const resolved = _resolveThumb(meta);
  const img      = loadImage(resolved.url);
  roundRect(ctx, thumbR.x, thumbR.y, thumbR.w, thumbR.h, 6);
  ctx.fillStyle = C.surface; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();

  if (img?.complete && img.naturalWidth > 0) {
    ctx.save();
    roundRect(ctx, thumbR.x, thumbR.y, thumbR.w, thumbR.h, 6); ctx.clip();
    if (resolved.blur) ctx.filter = "blur(12px)";
    const ir = img.naturalWidth / img.naturalHeight;
    const tr = thumbR.w / thumbR.h;
    let sw, sh, sx, sy;
    if (ir > tr) { sh = img.naturalHeight; sw = sh*tr; sx = (img.naturalWidth-sw)/2; sy = 0; }
    else         { sw = img.naturalWidth; sh = sw/tr; sy = (img.naturalHeight-sh)/2; sx = 0; }
    ctx.drawImage(img, sx, sy, sw, sh, thumbR.x, thumbR.y, thumbR.w, thumbR.h);
    if (resolved.blur) ctx.filter = "none";
    ctx.restore();
  } else {
    ctx.fillStyle = C.textDim; ctx.font = "28px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("🖼", thumbR.x + thumbR.w/2, thumbR.y + thumbR.h/2);
  }

  // ── Model info text ──
  const ny = thumbR.y + 6;
  const displayName = meta.civitai_name
    ?? (node._cwkModelName ? _cleanDisplayName(node._cwkModelName) : "No model loaded");
  ctx.fillStyle = C.text; ctx.font = "bold 13px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(displayName, infoX, ny, infoW);
  if (meta.base_model) {
    ctx.fillStyle = C.textBlue; ctx.font = "11px Inter,system-ui,sans-serif";
    ctx.fillText(meta.base_model, infoX, ny + 20, infoW);
  }
  if (node._cwkModelName) {
    ctx.fillStyle = C.textDim; ctx.font = "9px Inter,system-ui,sans-serif";
    ctx.fillText(node._cwkModelName.replace(/^.*[/\\]/, ""), infoX, ny + 38, infoW);
  }

  // ── AIO indicator badge ──
  const aioLabel  = node._cwkIsAIO ? "AIO" : "DIFF";
  const aioColor  = node._cwkIsAIO ? "#a6e3a1" : "#89b4fa";
  ctx.fillStyle   = "rgba(20,24,36,0.8)";
  const badgeW    = 36; const badgeH = 16;
  roundRect(ctx, infoX, ny + 54, badgeW, badgeH, 3);
  ctx.fill();
  ctx.fillStyle = aioColor; ctx.font = "bold 9px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(aioLabel, infoX + badgeW/2, ny + 54 + badgeH/2);

  // ── Quick-load dropdowns ──
  const [ckptRect, diffRect] = getQuickLoadRects(node);
  for (const qlr of [ckptRect, diffRect]) {
    const hovered = (node._cwkHoverQL === qlr.kind);
    const label   = qlr.kind === "checkpoint" ? "⚡ Checkpoint" : "⚡ Diff / GGUF";
    roundRect(ctx, qlr.x, qlr.y, qlr.w, qlr.h, 4);
    ctx.fillStyle   = hovered ? C.hoverBg : C.surface;
    ctx.strokeStyle = hovered ? C.arrowHov : C.border;
    ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
    ctx.fillStyle    = hovered ? C.arrowHov : C.textDim;
    ctx.font         = "bold 10px Inter, system-ui, sans-serif";
    ctx.textAlign    = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, qlr.x + qlr.w/2, qlr.y + qlr.h/2);
    ctx.fillStyle = hovered ? C.arrowHov : C.textDim;
    ctx.textAlign = "right";
    ctx.fillText("▾", qlr.x + qlr.w - 6, qlr.y + qlr.h/2);
  }

  // ── Divider above rows ──
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  ctx.beginPath();
  const divY = getRowsStartY(node) - PAD/2;
  ctx.moveTo(PAD, divY); ctx.lineTo(w - PAD, divY); ctx.stroke();

  // ── Rows ──
  const rows = getActiveRows(node);
  for (let i = 0; i < rows.length; i++) {
    const row   = rows[i];
    const ry    = getRowY(node, i);
    const vr    = getValueRect(node, i);
    const val   = vals[row.key] ?? (row.options ? row.options[0] : "—");
    const isHov = hover?.rowIdx === i;
    const hovPart = isHov ? hover.part : null;

    if (isHov) {
      roundRect(ctx, PAD, ry, w - PAD*2, ROW_H, 3);
      ctx.fillStyle = C.hoverBg; ctx.fill();
    }
    // Label
    ctx.fillStyle = C.textDim; ctx.font = "11px Inter,system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(row.label, PAD + 4, ry + ROW_H/2);
    // Value box
    roundRect(ctx, vr.x, vr.y, vr.w, vr.h, 4);
    ctx.fillStyle   = C.surface;
    ctx.strokeStyle = isHov ? C.border : "transparent";
    ctx.lineWidth = 1; ctx.fill(); if (isHov) ctx.stroke();
    // Value content
    if (row.type === "list") {
      ctx.fillStyle = isHov ? C.arrowHov : C.textDim;
      ctx.font = "9px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText("▾", vr.x + vr.w - 5, ry + ROW_H/2);
      ctx.fillStyle = C.text; ctx.font = "11px Inter,system-ui,sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(String(val), vr.x + 6, ry + ROW_H/2, vr.w - 18);
    } else {
      ctx.font = "10px sans-serif"; ctx.textBaseline = "middle";
      ctx.fillStyle = (hovPart === "left")  ? C.arrowHov : C.textDim;
      ctx.textAlign = "left";  ctx.fillText("◀", vr.x + 4, ry + ROW_H/2);
      ctx.fillStyle = (hovPart === "right") ? C.arrowHov : C.textDim;
      ctx.textAlign = "right"; ctx.fillText("▶", vr.x + vr.w - 4, ry + ROW_H/2);
      ctx.fillStyle = (hovPart === "center") ? C.arrowHov : C.text;
      ctx.font = "11px Inter,system-ui,sans-serif"; ctx.textAlign = "center";
      ctx.fillText(String(val), vr.x + vr.w/2, ry + ROW_H/2, vr.w - ARROW_W*2 - 4);
    }
  }

  // ── Button ──
  const br    = getButtonRect(node);
  const isHov = hover?.key === "load";
  const isFlash = node._cwkFlash === "load";
  roundRect(ctx, br.x, br.y, br.w, br.h, 5);
  ctx.fillStyle   = isHov ? C.hoverBg : C.surface;
  ctx.strokeStyle = isHov ? BTN_COLOR.hoverBorder : BTN_COLOR.border;
  ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
  ctx.fillStyle = isFlash ? C.flashGreen : (isHov ? BTN_COLOR.hoverText : C.text);
  ctx.font = "bold 11px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("📂 Models Manager", br.x + br.w/2, br.y + br.h/2, br.w - 8);

  ctx.restore();
}

// ─── Singleton panel ──────────────────────────────────────────────────────────

let _panel = null;
function getPanel() {
  if (!_panel) _panel = new ModelBrowserPanel();
  return _panel;
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, { headers:{"Content-Type":"application/json"}, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Extension ────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "CWK.ModelLoader",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      injectStyles();
      const node = this;

      node._cwkHover     = null;
      node._cwkHoverQL   = null;
      node._cwkMeta      = null;
      node._cwkModelName = null;
      node._cwkIsAIO     = true;     // default: assume checkpoint (AIO)
      node._cwkValues    = {
        clip_name:      "embedded",
        clip_type:      "stable_diffusion",
        vae_name:       "embedded",
      };
      node._cwkFlash     = null;
      node.color   = NODE_COLOR;
      node.bgcolor = NODE_BGCOLOR;

      setTimeout(() => {
        // Hide all LiteGraph widgets
        for (const w of node.widgets ?? []) {
          w.type = "hidden"; w.hidden = true;
          w.computeSize = () => [0, -4];
        }
        // Set default widget values
        const getW = name => node.widgets?.find(w => w.name === name);

        node.size[0] = Math.max(node.size[0], NODE_MIN_W);
        node.size[1] = calcNodeHeight(node);
        app.canvas.setDirty(true, true);
      }, 0);

      // Restore last-used model
      setTimeout(async () => {
        if (node._cwkModelName) return;
        try {
          const res = await fetch("/cwk/last_model");
          if (!res.ok) return;
          const data = await res.json();
          if (data.model_name) await _loadModelIntoNode(node, data.model_name);
        } catch (e) {
          console.warn("[CWK Loader] Could not restore last model:", e);
        }
      }, 150);

      node.onDrawForeground = function (ctx) {
		if (this.flags?.collapsed) return;
		drawNode(this, ctx);
	  };

      node.onResize = function () {
        this.size[0] = Math.max(NODE_MIN_W, this.size[0]);
        this.size[1] = calcNodeHeight(this);
      };

      node.onMouseDown = function (e, pos) {
        const qlKind = hitTestQuickLoad(this, pos[0], pos[1]);
        if (qlKind) { openQuickLoadDropdown(node, qlKind); return true; }

        const btnKey = hitTestButton(this, pos[0], pos[1]);
        if (btnKey === "load") {
          getPanel().open(async modelName => {
            await _loadModelIntoNode(node, modelName);
          });
          return true;
        }

        const hit = hitTestRow(this, pos[0], pos[1]);
        if (!hit || hit.part === null) return false;
        const { rowIdx, part } = hit;
        const rows = getActiveRows(node);
        const row  = rows[rowIdx];
        const cur  = node._cwkValues?.[row.key];

        if (row.type === "list") {
          openDropdown(node, rowIdx, cur, val => applyRowValue(node, rowIdx, val));
          return true;
        }
        if (part === "left") {
          const step = row.type === "float" ? 0.1 : 1;
          applyRowValue(node, rowIdx, clampValue(row, Number(cur) - step)); return true;
        }
        if (part === "right") {
          const step = row.type === "float" ? 0.1 : 1;
          applyRowValue(node, rowIdx, clampValue(row, Number(cur) + step)); return true;
        }
        if (part === "center") {
          openInlineNumberEditor(node, rowIdx, cur, val => applyRowValue(node, rowIdx, val)); return true;
        }
        return false;
      };

      node.onMouseMove = function (e, pos) {
        const qlHover = hitTestQuickLoad(this, pos[0], pos[1]);
        if ((node._cwkHoverQL ?? null) !== qlHover) {
          node._cwkHoverQL = qlHover; app.canvas.setDirty(true, false);
        }
        const btnKey = hitTestButton(this, pos[0], pos[1]);
        if (btnKey) {
          if (!node._cwkHover || node._cwkHover.key !== btnKey) {
            node._cwkHover = { key: btnKey }; app.canvas.setDirty(true, false);
          }
          return;
        }
        const hit    = hitTestRow(this, pos[0], pos[1]);
        const newHov = hit ? { rowIdx: hit.rowIdx, part: hit.part } : null;
        if (JSON.stringify(node._cwkHover) !== JSON.stringify(newHov)) {
          node._cwkHover = newHov; app.canvas.setDirty(true, false);
        }
      };

      node.onMouseLeave = function () {
        if (node._cwkHover   !== null) { node._cwkHover   = null; app.canvas.setDirty(true, false); }
        if (node._cwkHoverQL !== null) { node._cwkHoverQL = null; app.canvas.setDirty(true, false); }
      };
    };
  },
});