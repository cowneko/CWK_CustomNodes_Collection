/**
 * CWK Model Loader Pipe — ComfyUI canvas node extension.
 * Pipeline companion for CWK_ModelLoader: sampler/scheduler/CFG/steps/clip-skip/
 * CLIP/VAE, auto-synced from the connected loader's stored preset, with
 * Reload/Edit/Update Presets buttons.
 */

import { app }          from "../../scripts/app.js";
import { api }          from "../../scripts/api.js";
import { injectStyles } from "./cwk_styles.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_TYPE  = "CWK_ModelLoaderPipe";
const NODE_MIN_W = 320;

const PAD       = 10;
const ROW_H     = 26;
const LABEL_W   = 100;
const ARROW_W   = 20;
const BTN_H     = 26;
const BTN_PAD_V = 8;
const BTN_GAP   = 6;
const STATUS_H  = 20;
const BTNS_AREA_H = BTN_PAD_V + BTN_H + BTN_PAD_V;

const TITLE_H    = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H     = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;
const N_INPUTS   = 3;   // pipe + latent + model_override
const N_OUTPUTS  = 10;  // pipe, model, clip, vae, latent, sampler, scheduler, cfg, steps, clip_skip, infos

// ─── Colour palette (identical) ──────────────────────────────────────────────

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

const BTN_COLOR = { border: "#313552", hoverBorder: "#a6e3a1", hoverText: "#a6e3a1" };

// ─── Row definitions ──────────────────────────────────────────────────────────

let SAMPLERS   = ["euler","euler_ancestral","dpmpp_2m","dpmpp_2m_sde","dpmpp_sde","ddim","uni_pc","lcm"];
let SCHEDULERS = ["normal","karras","exponential","sgm_uniform","simple","beta"];
let CLIPS      = ["embedded"];
let CLIP_TYPES = ["stable_diffusion"];
let VAES       = ["embedded"];

// Rows driven by the loaded preset. All are read-only unless node._cwkEditMode.
const PIPE_ROWS = [
  { key: "sampler_name", label: "Sampler",   widget: "sampler_name", type: "list",  options: null },
  { key: "scheduler",    label: "Scheduler", widget: "scheduler",    type: "list",  options: null },
  { key: "cfg",          label: "CFG",       widget: "cfg",          type: "float", min: 0, max: 30  },
  { key: "steps",        label: "Steps",     widget: "steps",        type: "int",   min: 1, max: 200 },
  { key: "clip_skip",    label: "Clip skip", widget: "clip_skip",    type: "int",   min: -24, max: 0  },
  { key: "clip_name",    label: "CLIP",      widget: "clip_name",    type: "list",  options: null },
  { key: "clip_type",    label: "Clip Type", widget: "clip_type",    type: "list",  options: null },
  { key: "vae_name",     label: "VAE",       widget: "vae_name",     type: "list",  options: null },
];

// Link options arrays (updated after async load)
function _syncRowOptions() {
  PIPE_ROWS.find(r => r.key === "sampler_name").options = SAMPLERS;
  PIPE_ROWS.find(r => r.key === "scheduler").options    = SCHEDULERS;
  PIPE_ROWS.find(r => r.key === "clip_name").options    = CLIPS;
  PIPE_ROWS.find(r => r.key === "clip_type").options    = CLIP_TYPES;
  PIPE_ROWS.find(r => r.key === "vae_name").options     = VAES;
}
_syncRowOptions();

// ─── Async data loader ────────────────────────────────────────────────────────

async function _loadPipeOptions() {
  try {
    const res = await fetch("/object_info/CWK_ModelLoaderPipe");
    if (!res.ok) return;
    const data   = await res.json();
    const inputs = data?.CWK_ModelLoaderPipe?.input;
    const samplers   = (inputs?.required?.sampler_name?.[0] ?? []);
    const schedulers = (inputs?.required?.scheduler?.[0]    ?? []);
    const clipTypes  = (inputs?.optional?.clip_type?.[0]    ?? []);
    if (samplers.length)   { SAMPLERS   = samplers;   }
    if (schedulers.length) { SCHEDULERS = schedulers; }
    if (clipTypes.length)  { CLIP_TYPES.length = 0; CLIP_TYPES.push(...clipTypes); }
    _syncRowOptions();
  } catch (e) {
    console.warn("[CWK Pipe] Could not load sampler/scheduler/clip_type options:", e);
  }
  try {
    const [clipRes, vaeRes] = await Promise.all([
      fetch("/cwk/clips"),
      fetch("/cwk/vaes"),
    ]);
    if (clipRes.ok) {
      const { clips } = await clipRes.json();
      if (clips?.length) { CLIPS.length = 0; CLIPS.push(...clips); _syncRowOptions(); }
    }
    if (vaeRes.ok) {
      const { vaes } = await vaeRes.json();
      if (vaes?.length) { VAES.length = 0; VAES.push(...vaes); _syncRowOptions(); }
    }
  } catch (e) {
    console.warn("[CWK Pipe] Could not load CLIP/VAE lists:", e);
  }
}
_loadPipeOptions();

// ─── Layout helpers ───────────────────────────────────────────────────────────

function getSlotsArea() {
  // Enough vertical space for the taller of inputs vs outputs slot list
  const inputsH  = TITLE_H() + N_INPUTS  * SLOT_H() + 6;
  const outputsH = TITLE_H() + N_OUTPUTS * SLOT_H() + 6;
  return Math.max(inputsH, outputsH);
}

function getRowsStartY() {
  return getSlotsArea() + PAD;
}

function getRowY(i) {
  let y = getRowsStartY();
  for (let r = 0; r < i; r++) y += ROW_H + 3;
  return y;
}

function getStatusY(node) {
  return node.size[1] - BTNS_AREA_H - STATUS_H / 2;
}

function getButtonRects(node) {
  const baseY  = node.size[1] - BTNS_AREA_H + BTN_PAD_V;
  const totalW = node.size[0] - PAD * 2;
  const btnW   = (totalW - BTN_GAP * 2) / 3;
  return [
    { key: "reload", x: PAD,                        y: baseY, w: btnW, h: BTN_H },
    { key: "edit",   x: PAD + (btnW + BTN_GAP),      y: baseY, w: btnW, h: BTN_H },
    { key: "update", x: PAD + (btnW + BTN_GAP) * 2,  y: baseY, w: btnW, h: BTN_H },
  ];
}

function getValueRect(node, i) {
  const ry = getRowY(i);
  const x  = PAD + LABEL_W;
  return { x, y: ry + 1, w: node.size[0] - x - PAD, h: ROW_H - 2 };
}

function calcNodeHeight() {
  let h = getRowsStartY();
  for (let i = 0; i < PIPE_ROWS.length; i++) h += ROW_H + 3;
  return h + PAD + STATUS_H + BTNS_AREA_H;
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

function hitTestButton(node, lx, ly) {
  for (const r of getButtonRects(node)) {
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) return r.key;
  }
  return null;
}

function hitTestRow(node, lx, ly) {
  if (!node._cwkEditMode) return null;
  for (let i = 0; i < PIPE_ROWS.length; i++) {
    const ry  = getRowY(i);
    if (ly < ry || ly > ry + ROW_H) continue;
    const vr  = getValueRect(node, i);
    const row = PIPE_ROWS[i];
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
  return row.type === "float" ? parseFloat(v.toFixed(2)) : v;
}

// ─── Inline number editor ─────────────────────────────────────────────────────

function closeInlineEditor() {
  document.getElementById("cwk-pipe-backdrop")?.remove();
  document.getElementById("cwk-pipe-editor")?.remove();
}

function openInlineNumberEditor(node, rowIdx, currentValue, onCommit) {
  closeInlineEditor(); closeDropdown();
  const row  = PIPE_ROWS[rowIdx];
  const vr   = getValueRect(node, rowIdx);
  const sc   = _canvasToScreen(node, vr);
  const zoom = app.canvas.ds?.scale ?? 1;

  const backdrop = document.createElement("div");
  backdrop.id = "cwk-pipe-backdrop";
  Object.assign(backdrop.style, { position:"fixed", inset:"0", zIndex:"99998", background:"transparent" });

  const input = document.createElement("input");
  input.id = "cwk-pipe-editor"; input.type = "text"; input.inputMode = "decimal";
  input.value = String(currentValue ?? "");
  Object.assign(input.style, {
    position:"fixed", left:sc.x+"px", top:sc.y+"px", width:sc.w+"px", height:sc.h+"px",
    fontSize:Math.max(11, Math.round(11*zoom))+"px", fontFamily:"Inter,system-ui,sans-serif",
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
  document.getElementById("cwk-pipe-dropdown")?.remove();
  if (_ddOutside) { document.removeEventListener("pointerdown", _ddOutside, { capture:true }); _ddOutside = null; }
}

function openDropdown(node, rowIdx, currentValue, onCommit) {
  closeDropdown(); closeInlineEditor();
  const row  = PIPE_ROWS[rowIdx];
  const vr   = getValueRect(node, rowIdx);
  const sc   = _canvasToScreen(node, vr);
  const zoom = app.canvas.ds?.scale ?? 1;
  const opts = row.options ?? [];
  const maxV = Math.min(opts.length, 12);
  const optH = Math.max(16, Math.round(18 * zoom));
  const listH = maxV * optH + 4;
  const spaceBelow = window.innerHeight - sc.y - sc.h - 4;
  const dropTop = (spaceBelow >= listH || spaceBelow >= sc.y - 4) ? sc.y + sc.h + 1 : sc.y - listH - 1;

  const sel = document.createElement("select");
  sel.id = "cwk-pipe-dropdown"; sel.size = maxV;
  Object.assign(sel.style, {
    position:"fixed", left:sc.x+"px", top:dropTop+"px", width:sc.w+"px", height:listH+"px",
    fontSize:Math.max(11, Math.round(11*zoom))+"px", fontFamily:"Inter,system-ui,sans-serif",
    background:C.bgFull, color:C.text, border:`1px solid ${C.arrowHov}`,
    borderRadius:"4px", outline:"none", zIndex:"99999", cursor:"pointer", padding:"2px 0", overflow:"auto",
  });
  for (const opt of opts) {
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

// ─── Apply row value ──────────────────────────────────────────────────────────

function applyRowValue(node, rowIdx, val) {
  const row = PIPE_ROWS[rowIdx];
  if (!node._cwkValues) node._cwkValues = {};
  node._cwkValues[row.key] = val;
  const w = node.widgets?.find(w => w.name === row.widget);
  if (w) { w.value = val; w.callback?.(val); }
  app.canvas.setDirty(true, false);
}

// ─── Walk upstream to find the CWK_ModelLoader that owns the model name ───────

function _findModelName(node, visited = new Set()) {
  if (!node || visited.has(node.id)) return null;
  visited.add(node.id);

  // If this node directly carries a model name (CWK_ModelLoader), we're done
  if (node._cwkModelName) return node._cwkModelName;

  // Otherwise look at its first input (slot 0 = pipe) and follow it upstream
  const pipeInput = node.inputs?.[0];
  if (!pipeInput) return null;

  const linkId = pipeInput.link;
  if (linkId == null) return null;

  const link = app.graph.links[linkId];
  if (!link) return null;

  const srcNode = app.graph.getNodeById(link.origin_id);
  return _findModelName(srcNode, visited);
}

// ─── Preset fetch / apply / status helpers ────────────────────────────────────

async function _fetchAndApplyPreset(node, modelName) {
  const res = await fetch(`/cwk/preset?model=${encodeURIComponent(modelName)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { preset } = await res.json();
  if (!preset) throw new Error("No preset found");

  node._cwkPreset = preset;

  const map = {
    sampler_name: preset.sampler_name,
    scheduler:    preset.scheduler,
    cfg:          preset.cfg,
    steps:        preset.steps,
    clip_skip:    preset.clip_skip,
    clip_name:    preset.clip_name,
    clip_type:    preset.clip_type,
    vae_name:     preset.vae_name,
  };
  for (let i = 0; i < PIPE_ROWS.length; i++) {
    const val = map[PIPE_ROWS[i].key];
    if (val !== undefined) applyRowValue(node, i, val);
  }

  return preset;
}

function _setStatus(node, text, color) {
  node._cwkStatus = text ? { text, color: color ?? C.flashGreen } : null;
  app.canvas.setDirty(true, false);
}

function _flashButton(node, label, color) {
  node._cwkFlash      = true;
  node._cwkFlashLabel = label;
  node._cwkFlashColor = color ?? C.flashGreen;
  app.canvas.setDirty(true, false);
  setTimeout(() => {
    node._cwkFlash = false; node._cwkFlashLabel = null; node._cwkFlashColor = null;
    app.canvas.setDirty(true, false);
  }, 1800);
}

// ─── "Reload Presets" — pull values from the upstream CWK_ModelLoader ─────────

async function handleReloadPresets(node) {
  const modelName = _findModelName(node) ?? node._cwkLastModelName;
  if (!modelName) { _flashButton(node, "⚠ No model found", C.red ?? "#e78284"); return; }
  node._cwkLastModelName = modelName;

  try {
    await _fetchAndApplyPreset(node, modelName);
    _setStatus(node, "✓ Model preset loaded");
    _flashButton(node, "✓ Preset loaded!");
  } catch (e) {
    console.warn("[CWK Pipe] Reload preset failed:", e);
    _flashButton(node, "✗ Fetch failed", "#e78284");
  }
}

// ─── Automatic sync when the upstream model changes ───────────────────────────

async function _checkAutoSync(node) {
  const modelName = _findModelName(node);
  if (!modelName || modelName === node._cwkLastModelName) return;
  node._cwkLastModelName = modelName;
  if (node._cwkEditMode) return; // don't clobber unsaved edits

  try {
    await _fetchAndApplyPreset(node, modelName);
    _setStatus(node, "✓ Model preset loaded");
  } catch (e) {
    console.warn("[CWK Pipe] Auto-sync preset failed:", e);
  }
}

// ─── "Edit Presets" — toggle read-only rows on/off ────────────────────────────

async function handleEditPresetsToggle(node) {
  if (!node._cwkEditMode) {
    node._cwkEditMode = true;
    _setStatus(node, null);
  } else {
    node._cwkEditMode = false;
    // Cancelling edit mode discards unsaved changes: reload the stored preset.
    const modelName = _findModelName(node) ?? node._cwkLastModelName;
    if (modelName) {
      try {
        await _fetchAndApplyPreset(node, modelName);
        _setStatus(node, "✓ Model preset loaded");
      } catch (e) {
        console.warn("[CWK Pipe] Reload on cancel failed:", e);
      }
    }
  }
  app.canvas.setDirty(true, false);
}

// ─── "Update Presets" — persist current row values to checkpoint_presets.json ─

async function handleUpdatePresets(node) {
  if (!node._cwkEditMode) { _flashButton(node, "⚠ Enter edit mode first", "#e5c07b"); return; }

  const modelName = _findModelName(node) ?? node._cwkLastModelName;
  if (!modelName) { _flashButton(node, "⚠ No model found", "#e78284"); return; }

  const vals   = node._cwkValues ?? {};
  const merged = {
    ...(node._cwkPreset ?? {}),
    sampler_name: vals.sampler_name,
    scheduler:    vals.scheduler,
    cfg:          vals.cfg,
    steps:        vals.steps,
    clip_skip:    vals.clip_skip,
    clip_name:    vals.clip_name,
    clip_type:    vals.clip_type,
    vae_name:     vals.vae_name,
  };

  try {
    const res = await fetch("/cwk/preset", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model: modelName, preset: merged }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    node._cwkPreset  = data.preset ?? merged;
    node._cwkEditMode = false;
    _flashButton(node, "✓ Preset updated!");
    _setStatus(node, "✓ Model preset loaded");
  } catch (e) {
    console.warn("[CWK Pipe] Update preset failed:", e);
    _flashButton(node, "✗ Update failed", "#e78284");
  }
}

// ─── Draw ─────────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function drawNode(node, ctx) {
  const w         = node.size[0];
  const h         = node.size[1];
  const hover     = node._cwkHover;
  const vals      = node._cwkValues ?? {};
  const editMode  = !!node._cwkEditMode;
  const cornerR   = LiteGraph.NODE_BORDER_RADIUS ?? 8;

  ctx.save();
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, cornerR); ctx.clip();

  // Background
  ctx.fillStyle = C.bgFull; ctx.fillRect(0, 0, w, h);
  const contentY = getRowsStartY() - PAD;
  ctx.fillStyle  = C.bg; ctx.fillRect(0, contentY, w, h - contentY);

  // Divider above rows
  ctx.strokeStyle = C.border; ctx.lineWidth = 1;
  ctx.beginPath();
  const divY = getRowsStartY() - PAD / 2;
  ctx.moveTo(PAD, divY); ctx.lineTo(w - PAD, divY); ctx.stroke();

  // ── Rows (read-only unless in edit mode) ──
  for (let i = 0; i < PIPE_ROWS.length; i++) {
    const row     = PIPE_ROWS[i];
    const ry      = getRowY(i);
    const vr      = getValueRect(node, i);
    const val     = vals[row.key] ?? (row.options ? row.options[0] : (row.type === "float" ? 7.0 : 1));
    const isHov   = editMode && hover?.rowIdx === i;
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
    ctx.fillStyle   = editMode ? C.surface : C.bg;
    ctx.strokeStyle = isHov ? C.border : "transparent";
    ctx.lineWidth = 1; ctx.fill(); if (isHov) ctx.stroke();
    // Value content
    if (row.type === "list") {
      if (editMode) {
        ctx.fillStyle = isHov ? C.arrowHov : C.textDim;
        ctx.font = "9px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ctx.fillText("▾", vr.x + vr.w - 5, ry + ROW_H/2);
      }
      ctx.fillStyle = editMode ? C.text : C.textDim;
      ctx.font = "11px Inter,system-ui,sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(String(val), vr.x + 6, ry + ROW_H/2, vr.w - 18);
    } else {
      ctx.font = "10px sans-serif"; ctx.textBaseline = "middle";
      if (editMode) {
        ctx.fillStyle = (hovPart === "left")  ? C.arrowHov : C.textDim;
        ctx.textAlign = "left";  ctx.fillText("◀", vr.x + 4, ry + ROW_H/2);
        ctx.fillStyle = (hovPart === "right") ? C.arrowHov : C.textDim;
        ctx.textAlign = "right"; ctx.fillText("▶", vr.x + vr.w - 4, ry + ROW_H/2);
      }
      ctx.fillStyle = editMode ? ((hovPart === "center") ? C.arrowHov : C.text) : C.textDim;
      ctx.font = "11px Inter,system-ui,sans-serif"; ctx.textAlign = "center";
      ctx.fillText(String(val), vr.x + vr.w/2, ry + ROW_H/2, vr.w - ARROW_W*2 - 4);
    }
  }

  // ── Status line (persistent "Model preset loaded" / transient flash) ──
  const flashActive = !!node._cwkFlash;
  const statusText  = flashActive ? node._cwkFlashLabel : (node._cwkStatus?.text ?? null);
  const statusColor = flashActive ? (node._cwkFlashColor ?? C.flashGreen) : (node._cwkStatus?.color ?? C.flashGreen);
  if (statusText) {
    ctx.fillStyle = statusColor;
    ctx.font = "bold 11px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(statusText, w / 2, getStatusY(node), w - PAD * 2);
  }

  // ── Buttons ──
  const labels = {
    reload: "🔄 Reload Presets",
    edit:   editMode ? "✖ Cancel Edit" : "✏️ Edit Presets",
    update: "💾 Update Presets",
  };
  for (const br of getButtonRects(node)) {
    const isHov      = hover?.key === br.key;
    const isActive   = br.key === "edit" && editMode;
    const isDisabled = br.key === "update" && !editMode;
    roundRect(ctx, br.x, br.y, br.w, br.h, 5);
    ctx.fillStyle   = isActive ? C.hoverBg : (isHov && !isDisabled ? C.hoverBg : C.surface);
    ctx.strokeStyle = isActive ? C.arrowHov : ((isHov && !isDisabled) ? BTN_COLOR.hoverBorder : BTN_COLOR.border);
    ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
    ctx.fillStyle = isDisabled ? C.textDim
                  : isActive   ? C.arrowHov
                  : (isHov ? BTN_COLOR.hoverText : C.text);
    ctx.font = "bold 11px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(labels[br.key], br.x + br.w/2, br.y + br.h/2, br.w - 8);
  }

  ctx.restore();
}

// ─── Extension ────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "CWK.ModelLoaderPipe",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      injectStyles();
      const node = this;

      node._cwkHover        = null;
      node._cwkFlash        = false;
      node._cwkFlashLabel   = null;
      node._cwkFlashColor   = null;
      node._cwkEditMode     = false;
      node._cwkLastModelName = null;
      node._cwkStatus       = null;
      node._cwkPreset       = null;
      node._cwkValues       = {
        sampler_name: "euler",
        scheduler:    "normal",
        cfg:          7.0,
        steps:        20,
        clip_skip:    -2,
        clip_name:    "embedded",
        clip_type:    "stable_diffusion",
        vae_name:     "embedded",
      };
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
        const sv = getW("sampler_name"); if (sv) sv.value = "euler";
        const sc = getW("scheduler");    if (sc) sc.value = "normal";
        const cv = getW("cfg");          if (cv) cv.value = 7.0;
        const st = getW("steps");        if (st) st.value = 20;
        const cs = getW("clip_skip");    if (cs) cs.value = -2;
        const cn = getW("clip_name");    if (cn) cn.value = "embedded";
        const vn = getW("vae_name");     if (vn) vn.value = "embedded";
        const ct = getW("clip_type");    if (ct) ct.value = "stable_diffusion";

        node.size[0] = Math.max(node.size[0], NODE_MIN_W);
        node.size[1] = calcNodeHeight();
        app.canvas.setDirty(true, true);
      }, 0);

      // Poll for upstream model changes and auto-sync the preset (unless editing).
      // Also react immediately whenever any node finishes executing (e.g. the
      // upstream CWK_ModelLoader loading a new model).
      node._cwkAutoSyncInterval = setInterval(() => _checkAutoSync(node), 500);
      const onExecuted = () => _checkAutoSync(node);
      api.addEventListener("executed", onExecuted);
      const prevOnRemoved = node.onRemoved;
      node.onRemoved = function () {
        if (node._cwkAutoSyncInterval) { clearInterval(node._cwkAutoSyncInterval); node._cwkAutoSyncInterval = null; }
        api.removeEventListener("executed", onExecuted);
        prevOnRemoved?.apply(this, arguments);
      };

      node.onDrawForeground = function (ctx) {
		if (this.flags?.collapsed) return;
		drawNode(this, ctx);
	  };

      node.onResize = function () {
        this.size[0] = Math.max(NODE_MIN_W, this.size[0]);
        this.size[1] = calcNodeHeight();
      };

      node.onMouseDown = function (e, pos) {
        const btnKey = hitTestButton(this, pos[0], pos[1]);
        if (btnKey === "reload") { handleReloadPresets(node); return true; }
        if (btnKey === "edit")   { handleEditPresetsToggle(node); return true; }
        if (btnKey === "update") { handleUpdatePresets(node); return true; }

        if (!node._cwkEditMode) return false; // rows are read-only outside edit mode

        const hit = hitTestRow(this, pos[0], pos[1]);
        if (!hit || hit.part === null) return false;
        const { rowIdx, part } = hit;
        const row = PIPE_ROWS[rowIdx];
        const cur = node._cwkValues?.[row.key];

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
        const btnKey = hitTestButton(this, pos[0], pos[1]);
        if (btnKey) {
          if (!node._cwkHover || node._cwkHover.key !== btnKey) {
            node._cwkHover = { key: btnKey }; app.canvas.setDirty(true, false);
          }
          return;
        }
        const hit    = node._cwkEditMode ? hitTestRow(this, pos[0], pos[1]) : null;
        const newHov = hit ? { rowIdx: hit.rowIdx, part: hit.part } : null;
        if (JSON.stringify(node._cwkHover) !== JSON.stringify(newHov)) {
          node._cwkHover = newHov; app.canvas.setDirty(true, false);
        }
      };

      node.onMouseLeave = function () {
        if (node._cwkHover !== null) { node._cwkHover = null; app.canvas.setDirty(true, false); }
      };
    };
  },
});