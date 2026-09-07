/**
 * CWK Save Image — ComfyUI canvas node extension.
 *
 * Layout (node size is fixed; folding only shrinks the preview):
 *   [ RGB | RGBA | ALPHA ]                [💾 Save] [▲]
 *   ┌─ settings panel (foldable) ─────────────────────┐
 *   │ File name  [ {model_name}_{sampler_name}_... ]  │
 *   │ (model_name)(sampler_name)(scheduler)(cfg)...   │
 *   │ Preview    myModel_euler_cfg7.0_steps20.png     │
 *   │ Imprint infos  [✓]   Format  [PNG ▾]            │
 *   │ Save folder  [(output)]  Subfolder [(none) ▾]   │
 *   │ Whole batch [✓]                                 │
 *   └─────────────────────────────────────────────────┘
 *   ┌─ image preview (clipped to frame, channel +   ──┐
 *   │  batch navigation)                              │
 *   └─────────────────────────────────────────────────┘
 *   status line
 *
 * infos tags: refreshed LIVE from the graph (walks the infos link upstream,
 * collects widget values, finds the loader's model_name, searches downstream
 * for a KSampler seed) and merged with the values returned at execution.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_TYPE  = "CWK_Save_Image";
const NODE_MIN_W = 360;
const NODE_MIN_H = 460;

const PAD       = 10;
const TOPBAR_H  = 26;
const SAVE_W    = 86;
const FOLD_W    = 22;
const CH_GAP    = 6;
const ROW_H     = 24;
const LABEL_W   = 84;
const STATUS_H  = 20;

const FORMATS     = ["PNG", "JPG", "WebP"];
const CHANNEL_KEYS = ["RGB", "RGBA", "ALPHA"];
const EXTRA_TAGS   = ["date", "time"];

// Widget names we harvest upstream of the infos link (matches pipe infos keys)
const UPSTREAM_TAG_KEYS = [
  "model_name", "sampler_name", "scheduler", "cfg", "steps",
  "clip_skip", "rng", "model_sampling", "clip_name", "clip_type", "vae_name",
];

const C = {
  bg: "#1a1f2e", bgFull: "#141824", surface: "#1e2335", border: "#313552",
  text: "#cdd6f4", textDim: "#6c7086", textBlue: "#89b4fa", hoverBg: "#2a2f45",
  flashGreen: "#a6e3a1", warn: "#e5c07b", err: "#e78284",
};
const NODE_COLOR   = "#141824";
const NODE_BGCOLOR = "#1e2335";

const TITLE_H = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H  = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;
const N_INPUTS  = 3;   // images, masks, infos
const N_OUTPUTS = 0;   // sink node — no outputs

// ─── Widget / value helpers ───────────────────────────────────────────────────

function getW(node, name) { return node.widgets?.find(w => w.name === name); }
function getVal(node, name, fb) { const w = getW(node, name); return w ? w.value : fb; }
function setVal(node, name, val) { const w = getW(node, name); if (w) { w.value = val; w.callback?.(val); } }

function channelKey(node) { return String(getVal(node, "channel", "RGB")).toUpperCase(); }
function isFolded(node)   { return !!getVal(node, "settings_folded", false); }
function getTags(node)    { return [...Object.keys(node._cwkInfos ?? {}), ...EXTRA_TAGS]; }

// ─── infos: live graph sync (fixes tags not refreshing on connect) ───────────

function _getInfosSource(node) {
  const input = node.inputs?.find(i => i.name === "infos");
  if (!input || input.link == null) return null;
  const link = app.graph?.links?.[input.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id) ?? null;
}

/** BFS upstream through inputs, harvesting known widget values (closest first). */
function _collectInfosUpstream(startNode, maxNodes = 30) {
  const infos = {};
  if (!startNode) return infos;
  const queue = [startNode];
  const seen  = new Set();
  while (queue.length && seen.size < maxNodes) {
    const n = queue.shift();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    for (const w of n.widgets ?? []) {
      if (UPSTREAM_TAG_KEYS.includes(w.name)
          && infos[w.name] === undefined
          && w.value !== undefined && w.value !== null && w.value !== "") {
        infos[w.name] = w.value;
      }
    }
    for (const input of n.inputs ?? []) {
      if (input.link == null) continue;
      const link = app.graph?.links?.[input.link];
      if (!link) continue;
      queue.push(app.graph.getNodeById(link.origin_id));
    }
  }
  return infos;
}

/** BFS downstream through output links looking for a KSampler-style seed widget. */
function _findSeedDownstream(startNode, skipNodeId, maxNodes = 12) {
  if (!startNode) return null;
  const queue = [startNode];
  const seen  = new Set([skipNodeId]);
  let visited = 0;
  while (queue.length && visited < maxNodes) {
    const n = queue.shift();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id); visited++;
    for (const w of n.widgets ?? []) {
      if ((w.name === "seed" || w.name === "noise_seed")
          && w.value !== undefined && w.value !== null && w.value !== "") {
        return String(w.value);
      }
    }
    for (const out of n.outputs ?? []) {
      for (const linkId of out.links ?? []) {
        const link = app.graph?.links?.[linkId];
        if (!link) continue;
        queue.push(app.graph.getNodeById(link.target_id));
      }
    }
  }
  return null;
}

/** Recompute _cwkInfos = graph-derived values (win) merged over executed values. */
function _refreshInfos(node) {
  if (!app.graph) return;
  const graphInfos = {};
  const src = _getInfosSource(node);
  if (src) {
    Object.assign(graphInfos, _collectInfosUpstream(src));
    const seed = _findSeedDownstream(src, node.id);
    if (seed !== null && graphInfos.seed === undefined) graphInfos.seed = seed;
  }
  node._cwkGraphInfos = graphInfos;

  // graph values win (live edits); executed values fill the rest
  const merged = { ...(node._cwkExecInfos ?? {}), ...graphInfos };
  const j = JSON.stringify(merged);
  if (j !== node._cwkInfosJson) {
    node._cwkInfos = merged;
    node._cwkInfosJson = j;
    app.canvas.setDirty(true, false);
  }
}

// ─── Filename resolution ──────────────────────────────────────────────────────

function sanitizeName(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[\s._-]+|[\s._-]+$/g, "") || "_";
}

function resolveTag(node, key) {
  if (key === "date") {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }
  if (key === "time") {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  }
  let v = (node._cwkInfos ?? {})[key];
  if (v === undefined || v === null) return "";
  v = String(v);
  if (/_name$/.test(key)) v = v.replace(/\.(safetensors|ckpt|gguf|pt|bin|sft|pth)$/i, "");
  return sanitizeName(v);
}

function resolveTemplate(node, template) {
  return String(template ?? "").replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => resolveTag(node, k));
}

function fmtExt(f) { return f === "JPG" ? "jpg" : String(f).toLowerCase(); }

// ─── Layout ───────────────────────────────────────────────────────────────────

function getSlotsArea() {
  return Math.max(TITLE_H() + N_INPUTS * SLOT_H() + 6, TITLE_H() + N_OUTPUTS * SLOT_H() + 6);
}
function getTopBarY()  { return getSlotsArea() + PAD; }
function getSettingsY(){ return getTopBarY() + TOPBAR_H + 6; }

function getChannelRects(node) {
  const y = getTopBarY();
  const widths = { RGB: 50, RGBA: 62, ALPHA: 72 };
  let x = PAD;
  return CHANNEL_KEYS.map(k => {
    const r = { key: k, x, y, w: widths[k], h: TOPBAR_H - 2 };
    x += widths[k] + CH_GAP;
    return r;
  });
}
function getSaveRect(node) {
  return { x: node.size[0] - PAD - FOLD_W - 8 - SAVE_W, y: getTopBarY(), w: SAVE_W, h: TOPBAR_H - 2 };
}
function getFoldRect(node) {
  return { x: node.size[0] - PAD - FOLD_W, y: getTopBarY() + 1, w: FOLD_W, h: TOPBAR_H - 4 };
}

const _measure = document.createElement("canvas").getContext("2d");

function getSettingsLayout(node) {
  const W = node.size[0] - PAD * 2;
  let y = getSettingsY();
  const rows = [];

  // 1) filename template (text)
  rows.push({ key: "filename_template", label: "File name", type: "text", x: PAD, y, w: W, h: ROW_H });
  y += ROW_H + 4;

  // 2) info tag chips (wrapped, capped at 4 rows to protect the preview)
  const tags = getTags(node);
  const chips = [];
  const chipH = 18, gap = 6, maxRows = 4;
  let cx = PAD, cy = y, rowCount = 1, hidden = 0;
  _measure.font = "10px Inter,system-ui,sans-serif";
  for (let ti = 0; ti < tags.length; ti++) {
    const tag = tags[ti];
    const cw = Math.ceil(_measure.measureText(tag).width) + 16;
    if (cx > PAD && cx + cw > PAD + W) {
      if (rowCount >= maxRows) { hidden = tags.length - ti; break; }
      cx = PAD; cy += chipH + 4; rowCount++;
    }
    chips.push({ tag, x: cx, y: cy, w: cw, h: chipH });
    cx += cw + gap;
  }
  if (hidden > 0 && cx + 34 <= PAD + W) chips.push({ tag: `+${hidden}`, x: cx + gap, y: cy, w: 30, h: chipH, dim: true });
  y = cy + chipH + 6;

  // 3) filename preview
  rows.push({ key: "_fname_preview", label: "Preview", type: "preview", x: PAD, y, w: W, h: 16 });
  y += 22;

  // 4) simple rows
  const simple = [
    { key: "imprint_infos",     label: "Imprint infos", type: "toggle" },
    { key: "output_format",     label: "Format",        type: "dropdown" },
    { key: "save_folder",       label: "Save folder",   type: "text", placeholder: "(output)" },
    { key: "subfolder_tag",     label: "Subfolder",     type: "dropdown" },
    { key: "save_entire_batch", label: "Whole batch",   type: "toggle" },
  ];
  for (const r of simple) { rows.push({ ...r, x: PAD, y, w: W, h: ROW_H - 2 }); y += ROW_H; }

  return { rows, chips, height: y - getSettingsY() };
}

function getPreviewRect(node) {
  const top = isFolded(node) ? getSettingsY() : getSettingsY() + getSettingsLayout(node).height + 2;
  const bottom = node.size[1] - STATUS_H - 10;
  return { x: PAD, y: top, w: node.size[0] - PAD * 2, h: Math.max(24, bottom - top) };
}

function getNavRects(node) {
  const pr = getPreviewRect(node);
  const y = pr.y + 4, h = 16;
  return {
    next:  { key: "next",  x: pr.x + pr.w - 24, y, w: 20, h },
    label: { key: "label", x: pr.x + pr.w - 50, y, w: 24, h },
    prev:  { key: "prev",  x: pr.x + pr.w - 74, y, w: 20, h },
  };
}

// ─── Screen coords / overlay editors (same pattern as the Pipe node) ─────────

function _canvasToScreen(node, vr) {
  const bbox = app.canvas.canvas.getBoundingClientRect();
  const zoom = app.canvas.ds?.scale ?? 1;
  const off  = app.canvas.ds?.offset ?? [0, 0];
  return {
    x: (node.pos[0] + vr.x) * zoom + off[0] * zoom + bbox.left,
    y: (node.pos[1] + vr.y) * zoom + off[1] * zoom + bbox.top,
    w: vr.w * zoom, h: vr.h * zoom,
  };
}

function _blockCanvasEvents(el) {
  for (const evt of ["mousedown","mouseup","click","pointerdown","pointerup",
                     "dblclick","contextmenu","wheel","touchstart","touchend"]) {
    el.addEventListener(evt, e => e.stopPropagation());
  }
}

function closeInlineEditor() {
  document.getElementById("cwk-si-backdrop")?.remove();
  document.getElementById("cwk-si-editor")?.remove();
}

function openInlineTextEditor(node, rect, current, onCommit) {
  closeInlineEditor(); closeDropdown();
  const sc = _canvasToScreen(node, rect);
  const zoom = app.canvas.ds?.scale ?? 1;

  const backdrop = document.createElement("div");
  backdrop.id = "cwk-si-backdrop";
  Object.assign(backdrop.style, { position: "fixed", inset: "0", zIndex: "99998", background: "transparent" });

  const input = document.createElement("input");
  input.id = "cwk-si-editor"; input.type = "text";
  input.value = String(current ?? "");
  Object.assign(input.style, {
    position: "fixed", left: sc.x + "px", top: sc.y + "px", width: sc.w + "px", height: sc.h + "px",
    fontSize: Math.max(11, Math.round(11 * zoom)) + "px", fontFamily: "Inter,system-ui,sans-serif",
    background: C.bgFull, color: C.text, border: `1px solid ${C.textBlue}`,
    borderRadius: "3px", outline: "none", zIndex: "99999", padding: "0 6px", boxSizing: "border-box",
  });
  _blockCanvasEvents(input); _blockCanvasEvents(backdrop);

  let committed = false;
  const commit = () => { if (committed) return; committed = true; closeInlineEditor(); onCommit(input.value); app.canvas.setDirty(true, false); };
  const cancel = () => { if (committed) return; committed = true; closeInlineEditor(); app.canvas.setDirty(true, false); };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") cancel();
  });
  backdrop.addEventListener("mousedown", e => { e.stopPropagation(); e.preventDefault(); commit(); });
  backdrop.appendChild(input);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => setTimeout(() => { input.focus(); input.select(); }, 0));
}

let _ddOutside = null;

function closeDropdown() {
  document.getElementById("cwk-si-dropdown")?.remove();
  if (_ddOutside) { document.removeEventListener("pointerdown", _ddOutside, { capture: true }); _ddOutside = null; }
}

function openDropdown(node, rect, options, current, onCommit) {
  closeDropdown(); closeInlineEditor();
  const sc = _canvasToScreen(node, rect);
  const zoom = app.canvas.ds?.scale ?? 1;
  const maxV = Math.min(options.length, 10);
  const optH = Math.max(16, Math.round(18 * zoom));
  const listH = maxV * optH + 4;
  const spaceBelow = window.innerHeight - sc.y - sc.h - 4;
  const dropTop = (spaceBelow >= listH || spaceBelow >= sc.y - 4) ? sc.y + sc.h + 1 : sc.y - listH - 1;

  const sel = document.createElement("select");
  sel.id = "cwk-si-dropdown"; sel.size = maxV;
  Object.assign(sel.style, {
    position: "fixed", left: sc.x + "px", top: dropTop + "px", width: sc.w + "px", height: listH + "px",
    fontSize: Math.max(11, Math.round(11 * zoom)) + "px", fontFamily: "Inter,system-ui,sans-serif",
    background: C.bgFull, color: C.text, border: `1px solid ${C.textBlue}`,
    borderRadius: "4px", outline: "none", zIndex: "99999", cursor: "pointer", padding: "2px 0", overflow: "auto",
  });
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    Object.assign(o.style, {
      padding: "2px 8px",
      background: String(current) === String(opt) ? C.hoverBg : "transparent",
      color: String(current) === String(opt) ? C.textBlue : C.text,
    });
    if (String(current) === String(opt)) o.selected = true;
    sel.appendChild(o);
  }
  _blockCanvasEvents(sel);
  document.body.appendChild(sel); sel.focus();
  sel.querySelector("option:checked")?.scrollIntoView({ block: "nearest" });

  let committed = false;
  const commit = val => {
    if (committed) return; committed = true;
    closeDropdown(); onCommit(val ?? sel.value); app.canvas.setDirty(true, false);
  };
  sel.addEventListener("click", () => commit(sel.value));
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
  setTimeout(() => document.addEventListener("pointerdown", _ddOutside, { capture: true }), 50);
}

// ─── Preview image cache ──────────────────────────────────────────────────────

function viewUrl(entry) {
  const params = { filename: entry.filename, subfolder: entry.subfolder ?? "", type: entry.type ?? "temp" };
  if (typeof api.apiURL === "function") return api.apiURL("/view", params);
  return "/view?" + new URLSearchParams(params).toString();
}

function getImg(node, ch, idx) {
  node._cwkImgCache ?? (node._cwkImgCache = {});
  const entry = (node._cwkEntries?.[ch] ?? [])[idx];
  if (!entry) return null;
  const key = ch + ":" + idx;
  let img = node._cwkImgCache[key];
  if (!img) {
    img = new Image();
    img.onload = () => app.canvas.setDirty(true, false);
    img.src = viewUrl(entry);
    node._cwkImgCache[key] = img;
  }
  return img;
}

// ─── Status / flash ───────────────────────────────────────────────────────────

function _setStatus(node, text, color) {
  node._cwkStatus = text ? { text, color: color ?? C.textDim } : null;
  app.canvas.setDirty(true, false);
}
function _flash(node, label, color) {
  node._cwkFlash = true; node._cwkFlashLabel = label; node._cwkFlashColor = color ?? C.flashGreen;
  app.canvas.setDirty(true, false);
  setTimeout(() => {
    node._cwkFlash = false; node._cwkFlashLabel = null; node._cwkFlashColor = null;
    app.canvas.setDirty(true, false);
  }, 1800);
}

// ─── Save action ──────────────────────────────────────────────────────────────

async function handleSave(node) {
  const ch = channelKey(node).toLowerCase();
  const entries = node._cwkEntries?.[ch] ?? [];
  if (!entries.length) {
    _flash(node, "⚠ Run the workflow first", C.warn);
    _setStatus(node, "No images loaded — run the workflow first", C.warn);
    return;
  }
  if (node._cwkSaving) return;

  const base = resolveTemplate(node, getVal(node, "filename_template", "")).trim() || "ComfyUI";
  const subTag = String(getVal(node, "subfolder_tag", "") ?? "");
  const sub = (subTag && subTag !== "(none)") ? resolveTag(node, subTag) : "";

  node._cwkSaving = true; app.canvas.setDirty(true, false);
  try {
    const res = await fetch("/cwk_save_image/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: ch,
        images: entries,
        base_name: base,
        subfolder: sub,
        folder: String(getVal(node, "save_folder", "") ?? "").trim(),
        format: String(getVal(node, "output_format", "PNG")),
        imprint: !!getVal(node, "imprint_infos", false),
        imprint_infos: node._cwkInfos ?? {},
        entire_batch: !!getVal(node, "save_entire_batch", true),
        batch_index: Math.max(0, node._cwkBatchIndex ?? 0),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const n = data.count ?? 0;
    const where = data.saved?.length ? data.saved[data.saved.length - 1] : "";
    _flash(node, `✓ Saved ${n} file${n > 1 ? "s" : ""}!`);
    _setStatus(node, `✓ ${n} file${n > 1 ? "s" : ""} → ${where}`, C.flashGreen);
  } catch (e) {
    console.warn("[CWK SaveImage] save failed:", e);
    _flash(node, "✗ Save failed", C.err);
    _setStatus(node, `✗ ${e.message ?? e}`, C.err);
  } finally {
    node._cwkSaving = false; app.canvas.setDirty(true, false);
  }
}

// ─── Execution output → node state ────────────────────────────────────────────

function applyOutput(node, message) {
  const cwk = message?.cwk;
  if (!cwk) return;
  const sig = JSON.stringify(cwk);
  if (sig === node._cwkLastSig) return;   // guard double delivery (onExecuted + listener)
  node._cwkLastSig = sig;

  node._cwkExecInfos = (cwk.infos && typeof cwk.infos === "object") ? cwk.infos : {};
  node._cwkEntries = {
    rgb:   Array.isArray(cwk.rgb)   ? cwk.rgb   : [],
    rgba:  Array.isArray(cwk.rgba)  ? cwk.rgba  : [],
    alpha: Array.isArray(cwk.alpha) ? cwk.alpha : [],
  };
  node._cwkBatchSize  = cwk.batch_size ?? node._cwkEntries.rgb.length ?? 1;
  node._cwkBatchIndex = 0;
  node._cwkImgCache   = {};
  node._cwkHasMasks   = !!cwk.has_masks;
  _refreshInfos(node);
  const n = node._cwkBatchSize;
  _setStatus(node, `✓ ${n} image${n === 1 ? "" : "s"} ready${node._cwkHasMasks ? "" : " (no masks)"} — press Save to write`);
  app.canvas.setDirty(true, false);
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function fitText(ctx, text, maxW) {
  text = String(text);
  if (ctx.measureText(text).width <= maxW) return text;
  let half = Math.floor(text.length / 2);
  while (half > 1) {
    const t = text.slice(0, half) + "…" + text.slice(-half);
    if (ctx.measureText(t).width <= maxW) return t;
    half--;
  }
  return "…";
}

function drawTopBar(node, ctx) {
  const hover = node._cwkHover;
  const cur = channelKey(node);

  for (const r of getChannelRects(node)) {
    const active = r.key === cur;
    const hov = hover?.type === "channel" && hover.key === r.key;
    roundRect(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fillStyle = active ? C.hoverBg : C.surface; ctx.fill();
    ctx.strokeStyle = active ? C.textBlue : (hov ? C.textBlue : C.border);
    ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = active ? C.textBlue : (hov ? C.text : C.textDim);
    ctx.font = "bold 10px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(r.key, r.x + r.w / 2, r.y + r.h / 2);
  }

  const sr = getSaveRect(node);
  const sHover = hover?.type === "save";
  roundRect(ctx, sr.x, sr.y, sr.w, sr.h, 4);
  ctx.fillStyle = node._cwkSaving ? C.border : (sHover ? C.hoverBg : C.surface); ctx.fill();
  ctx.strokeStyle = C.flashGreen; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = C.flashGreen;
  ctx.font = "bold 11px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(node._cwkSaving ? "Saving…" : "💾 Save", sr.x + sr.w / 2, sr.y + sr.h / 2);

  const fr = getFoldRect(node);
  const fHover = hover?.type === "fold";
  roundRect(ctx, fr.x, fr.y, fr.w, fr.h, 4);
  ctx.fillStyle = fHover ? C.hoverBg : C.surface; ctx.fill();
  ctx.strokeStyle = fHover ? C.textBlue : C.border; ctx.stroke();
  ctx.fillStyle = fHover ? C.textBlue : C.textDim;
  ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(isFolded(node) ? "▼" : "▲", fr.x + fr.w / 2, fr.y + fr.h / 2 + 1);
}

function drawSettings(node, ctx) {
  const L = getSettingsLayout(node);
  const hover = node._cwkHover;

  // panel background
  roundRect(ctx, PAD - 2, getSettingsY() - 4, node.size[0] - 2 * (PAD - 2), L.height + 8, 5);
  ctx.fillStyle = "#171c2b"; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();

  for (const row of L.rows) {
    const hov = hover?.type === "row" && hover.key === row.key;

    if (row.type === "preview") {
      ctx.fillStyle = C.textDim; ctx.font = "10px Inter,system-ui,sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText("Preview", PAD + 4, row.y + row.h / 2);
      const base = resolveTemplate(node, getVal(node, "filename_template", "")) || "ComfyUI";
      const subTag = String(getVal(node, "subfolder_tag", "") ?? "");
      const sub = (subTag && subTag !== "(none)") ? resolveTag(node, subTag) + "/" : "";
      const txt = sub + base + "." + fmtExt(getVal(node, "output_format", "PNG"));
      ctx.font = "10px Consolas,monospace"; ctx.fillStyle = C.textBlue;
      ctx.fillText(fitText(ctx, txt, row.w - LABEL_W), PAD + LABEL_W, row.y + row.h / 2);
      continue;
    }

    // label
    ctx.fillStyle = C.textDim; ctx.font = "10px Inter,system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(row.label, PAD + 4, row.y + row.h / 2);

    // value box
    const vx = PAD + LABEL_W, vw = row.w - LABEL_W;
    roundRect(ctx, vx, row.y + 1, vw, row.h - 2, 4);
    ctx.fillStyle = C.surface; ctx.fill();
    ctx.strokeStyle = hov ? C.textBlue : C.border; ctx.lineWidth = 1; ctx.stroke();

    if (row.type === "text") {
      let val = String(getVal(node, row.key, "") ?? "");
      if (!val && row.placeholder) { ctx.fillStyle = C.textDim; val = row.placeholder; }
      else ctx.fillStyle = C.text;
      ctx.font = "10px Consolas,monospace"; ctx.textAlign = "left";
      ctx.fillText(fitText(ctx, val, vw - 12), vx + 6, row.y + row.h / 2);
    } else if (row.type === "toggle") {
      const on = !!getVal(node, row.key, false);
      const bx = vx + vw - 20, by = row.y + row.h / 2 - 7;
      roundRect(ctx, bx, by, 14, 14, 3);
      ctx.fillStyle = on ? C.textBlue : C.bgFull; ctx.fill();
      ctx.strokeStyle = on ? C.textBlue : C.border; ctx.stroke();
      if (on) {
        ctx.fillStyle = C.bgFull; ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("✓", bx + 7, by + 7 + 0.5);
      }
    } else if (row.type === "dropdown") {
      let val = String(getVal(node, row.key, "") ?? "");
      if (row.key === "subfolder_tag" && !val) val = "(none)";
      ctx.fillStyle = C.text; ctx.font = "10px Inter,system-ui,sans-serif"; ctx.textAlign = "left";
      ctx.fillText(fitText(ctx, val, vw - 18), vx + 6, row.y + row.h / 2);
      ctx.fillStyle = hov ? C.textBlue : C.textDim; ctx.font = "9px sans-serif"; ctx.textAlign = "right";
      ctx.fillText("▾", vx + vw - 6, row.y + row.h / 2);
    }
  }

  // tag chips
  for (const chip of L.chips) {
    const hov = hover?.type === "chip" && hover.key === chip.tag;
    roundRect(ctx, chip.x, chip.y, chip.w, chip.h, 8);
    ctx.fillStyle = chip.dim ? "transparent" : (hov ? C.hoverBg : C.surface);
    if (!chip.dim) ctx.fill();
    ctx.strokeStyle = chip.dim ? "transparent" : (hov ? C.textBlue : C.border);
    if (!chip.dim) ctx.stroke();
    ctx.fillStyle = chip.dim ? C.textDim : (hov ? C.textBlue : C.text);
    ctx.font = "10px Inter,system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(chip.tag, chip.x + chip.w / 2, chip.y + chip.h / 2 + 0.5);
  }
}

function drawCheckerboard(ctx, x, y, w, h) {
  const s = 8;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = "#232839"; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#2b3147";
  for (let yy = y; yy < y + h; yy += s) {
    const off = (Math.floor((yy - y) / s) % 2) * s;
    for (let xx = x + off; xx < x + w; xx += 2 * s) ctx.fillRect(xx, yy, s, s);
  }
  ctx.restore();
}

function buildImprintLines(node) {
  const g = k => { const v = (node._cwkInfos ?? {})[k]; return v == null ? "" : String(v).trim(); };
  const l1 = [];
  const model = g("model_name").replace(/\.(safetensors|ckpt|gguf|pt|bin|sft|pth)$/i, "");
  if (model) l1.push(model);
  const gen = [g("sampler_name"), g("scheduler")].filter(Boolean).join(" / ");
  if (gen) l1.push(gen);
  const params = ["cfg", "steps", "seed"].filter(k => g(k) !== "").map(k => `${k}: ${g(k)}`);
  if (params.length) l1.push(params.join("  "));
  const line1 = l1.join("  |  ");

  const rest = [];
  for (const k of ["clip_skip", "rng", "model_sampling", "clip_name", "vae_name", "clip_type"]) {
    if (g(k)) rest.push(`${k}: ${g(k)}`);
  }
  const known = new Set(["model_name","sampler_name","scheduler","cfg","steps","seed",
                         "clip_skip","rng","model_sampling","clip_name","vae_name","clip_type"]);
  for (const [k, v] of Object.entries(node._cwkInfos ?? {})) {
    if (!known.has(k) && v != null && String(v).trim()) rest.push(`${k}: ${v}`);
  }
  return [line1, rest.join("  |  ")].filter(Boolean);
}

function drawImprintSim(node, ctx, dx, dy, dw, dh, s) {
  // approximates the footer the backend will burn in at save time
  const lines = buildImprintLines(node);
  if (!lines.length) return;
  const origW = dw / (s || 1);
  const fsOrig = Math.max(13, Math.min(30, origW / 46));
  const fs = fsOrig * s;
  const lineH = (fsOrig + 10) * s;
  const footerH = lines.length * lineH + 12 * s;
  ctx.fillStyle = "rgba(0,0,0,.92)";
  ctx.fillRect(dx, dy + dh - footerH, dw, footerH);
  ctx.fillStyle = "#fff";
  ctx.font = `${Math.max(7, Math.round(fs))}px Inter,system-ui,sans-serif`;
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  let y = dy + dh - footerH + 6 * s;
  for (const l of lines) {
    ctx.fillText(fitText(ctx, l, dw - 24 * s), dx + 12 * s, y);
    y += lineH;
  }
}

function drawNav(node, ctx, idx, total) {
  const { prev, label, next } = getNavRects(node);
  const hover = node._cwkHover;
  for (const r of [prev, next]) {
    const hov = hover?.type === "nav" && hover.key === r.key;
    roundRect(ctx, r.x, r.y, r.w, r.h, 3);
    ctx.fillStyle = hov ? C.hoverBg : "rgba(20,24,36,.8)"; ctx.fill();
    ctx.strokeStyle = hov ? C.textBlue : C.border; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = hov ? C.textBlue : C.textDim; ctx.font = "10px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(r.key === "prev" ? "◀" : "▶", r.x + r.w / 2, r.y + r.h / 2);
  }
  ctx.fillStyle = C.text; ctx.font = "10px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(`${idx + 1}/${total}`, label.x + label.w / 2, label.y + label.h / 2 + 1);
}

function drawPreview(node, ctx) {
  const pr = getPreviewRect(node);
  const ch = channelKey(node).toLowerCase();
  const entries = node._cwkEntries?.[ch] ?? [];

  // frame
  roundRect(ctx, pr.x, pr.y, pr.w, pr.h, 5);
  ctx.fillStyle = "#10131f"; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();

  // ── everything below is hard-clipped to the frame ──
  ctx.save();
  roundRect(ctx, pr.x + 1, pr.y + 1, pr.w - 2, pr.h - 2, 4);
  ctx.clip();

  if (!entries.length) {
    ctx.fillStyle = C.textDim; ctx.font = "11px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("No images yet — run the workflow", pr.x + pr.w / 2, pr.y + pr.h / 2);
  } else {
    const idx = Math.min(node._cwkBatchIndex ?? 0, entries.length - 1);
    const img = getImg(node, ch, idx);

    if (img && img.complete && img.naturalWidth) {
      const pad = 6;
      const availW = pr.w - pad * 2, availH = pr.h - pad * 2;
      const s = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      const dx = pr.x + pad + (availW - dw) / 2, dy = pr.y + pad + (availH - dh) / 2;
      if (ch === "rgba") drawCheckerboard(ctx, dx, dy, dw, dh);
      ctx.drawImage(img, dx, dy, dw, dh);
      if (ch !== "alpha" && !!getVal(node, "imprint_infos", false)) drawImprintSim(node, ctx, dx, dy, dw, dh, s);
    } else {
      ctx.fillStyle = C.textDim; ctx.font = "11px Inter,system-ui,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("loading preview…", pr.x + pr.w / 2, pr.y + pr.h / 2);
    }

    if (ch !== "rgb" && node._cwkEntries && !node._cwkHasMasks) {
      ctx.fillStyle = C.warn; ctx.font = "9px Inter,system-ui,sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("no masks connected", pr.x + 6, pr.y + 4);
    }

    if (entries.length > 1) drawNav(node, ctx, idx, entries.length);
  }

  ctx.restore();
}

function drawStatus(node, ctx) {
  const flashActive = !!node._cwkFlash;
  let text  = flashActive ? node._cwkFlashLabel : (node._cwkStatus?.text ?? null);
  let color = flashActive ? (node._cwkFlashColor ?? C.flashGreen) : (node._cwkStatus?.color ?? C.textDim);
  if (!text && channelKey(node) === "RGBA" && String(getVal(node, "output_format", "PNG")) === "JPG") {
    text = "note: JPG flattens the alpha channel"; color = C.warn;
  }
  if (!text) return;
  ctx.fillStyle = color; ctx.font = "bold 10px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, text, node.size[0] - PAD * 2), node.size[0] / 2, node.size[1] - STATUS_H / 2 - 2);
}

function drawNode(node, ctx) {
  const w = node.size[0], h = node.size[1];
  const cornerR = LiteGraph.NODE_BORDER_RADIUS ?? 8;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, cornerR); ctx.clip();

  ctx.fillStyle = C.bgFull; ctx.fillRect(0, 0, w, h);
  const contentY = getTopBarY() - PAD;
  ctx.fillStyle = C.bg; ctx.fillRect(0, contentY, w, h - contentY);

  drawTopBar(node, ctx);
  if (!isFolded(node)) drawSettings(node, ctx);
  drawPreview(node, ctx);
  drawStatus(node, ctx);

  ctx.restore();
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

function contains(r, x, y) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function hitTestTop(node, lx, ly) {
  for (const r of getChannelRects(node)) if (contains(r, lx, ly)) return { type: "channel", key: r.key };
  if (contains(getSaveRect(node), lx, ly)) return { type: "save", key: "save" };
  if (contains(getFoldRect(node), lx, ly)) return { type: "fold", key: "fold" };
  return null;
}

function hitTestSettings(node, lx, ly) {
  if (isFolded(node)) return null;
  const L = getSettingsLayout(node);
  for (const chip of L.chips) {
    if (!chip.dim && contains(chip, lx, ly)) return { type: "chip", key: chip.tag, tag: chip.tag };
  }
  for (const row of L.rows) {
    if (ly < row.y || ly > row.y + row.h) continue;
    if (lx < PAD || lx > PAD + row.w) continue;
    const part = lx >= PAD + LABEL_W ? "value" : "label";
    return { type: "row", key: row.key, part, row };
  }
  return null;
}

function hitTestNav(node, lx, ly) {
  const entries = node._cwkEntries?.[channelKey(node).toLowerCase()] ?? [];
  if (entries.length < 2) return null;
  const { prev, next } = getNavRects(node);
  if (contains(prev, lx, ly)) return { type: "nav", key: "prev" };
  if (contains(next, lx, ly)) return { type: "nav", key: "next" };
  return null;
}

// ─── Extension ────────────────────────────────────────────────────────────────

app.registerExtension({
  name: "CWK.SaveImage",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      const node = this;
      node.color = NODE_COLOR;
      node.bgcolor = NODE_BGCOLOR;

      node._cwkHover = null;
      node._cwkStatus = null;
      node._cwkFlash = false; node._cwkFlashLabel = null; node._cwkFlashColor = null;
      node._cwkGraphInfos = {};
      node._cwkExecInfos = {};
      node._cwkInfos = {};
      node._cwkInfosJson = "{}";
      node._cwkLastSig = null;
      node._cwkEntries = { rgb: [], rgba: [], alpha: [] };
      node._cwkBatchIndex = 0;
      node._cwkImgCache = {};
      node._cwkHasMasks = false;
      node._cwkSaving = false;

      setTimeout(() => {
        // hide all widgets (values still persist in the workflow)
        for (const w of node.widgets ?? []) {
          w.type = "hidden"; w.hidden = true;
          w.computeSize = () => [0, -4];
        }
        const tpl = getW(node, "filename_template");
        if (tpl && (tpl.value === undefined || tpl.value === null || tpl.value === "")) {
          tpl.value = "{model_name}_{sampler_name}_cfg{cfg}_steps{steps}";
        }
        node.size[0] = Math.max(node.size[0] ?? 0, 400);
        node.size[1] = Math.max(node.size[1] ?? 0, 500);
        _refreshInfos(node);
        app.canvas.setDirty(true, true);
      }, 0);

      // ── infos live sync: on link changes + light polling ──
      node.onConnectionsChange = function (side, slotIndex, connected) {
        setTimeout(() => {
          _refreshInfos(node);
          const src = _getInfosSource(node);
          if (src && !(node._cwkEntries?.rgb?.length)) {
            const n = Object.keys(node._cwkInfos ?? {}).length;
            _setStatus(node, n ? `✓ Infos connected — ${n} tags available` : "Infos connected — no tags found yet", n ? C.flashGreen : C.warn);
          }
        }, 20);
      };
      node._cwkInfoSyncInterval = setInterval(() => _refreshInfos(node), 500);

      // ── receive execution results (ui.cwk payload) ──
      node.onExecuted = function (message) {
        try {
          applyOutput(node, message);
          // belt & braces: never let any stock preview machinery draw here
          if (this.images) this.images = null;
        } catch (e) { console.warn("[CWK SaveImage] onExecuted:", e); }
      };
      // fallback listener (guarded by signature inside applyOutput)
      node._cwkApiExec = ev => {
        if (String(ev?.detail?.node) !== String(node.id)) return;
        if (ev?.detail?.output) applyOutput(node, ev.detail.output);
      };
      api.addEventListener("executed", node._cwkApiExec);

      const prevOnRemoved = node.onRemoved;
      node.onRemoved = function () {
        if (node._cwkInfoSyncInterval) { clearInterval(node._cwkInfoSyncInterval); node._cwkInfoSyncInterval = null; }
        if (node._cwkApiExec) { api.removeEventListener("executed", node._cwkApiExec); node._cwkApiExec = null; }
        prevOnRemoved?.apply(this, arguments);
      };

      node.onDrawForeground = function (ctx) {
        if (this.flags?.collapsed) return;
        drawNode(this, ctx);
      };

      node.onResize = function () {
        this.size[0] = Math.max(NODE_MIN_W, this.size[0]);
        this.size[1] = Math.max(NODE_MIN_H, this.size[1]);
      };

      node.onMouseDown = function (e, pos) {
        const top = hitTestTop(this, pos[0], pos[1]);
        if (top) {
          if (top.type === "channel") { setVal(node, "channel", top.key); app.canvas.setDirty(true, false); return true; }
          if (top.type === "save")    { handleSave(node); return true; }
          if (top.type === "fold")    { setVal(node, "settings_folded", !isFolded(node)); app.canvas.setDirty(true, false); return true; }
        }

        const st = hitTestSettings(this, pos[0], pos[1]);
        if (st) {
          if (st.type === "chip") {
            const t = String(getVal(node, "filename_template", "") ?? "");
            setVal(node, "filename_template", t + `{${st.tag}}`);
            app.canvas.setDirty(true, false);
            return true;
          }
          if (st.type === "row") {
            const row = st.row;
            if (row.type === "toggle") {
              setVal(node, row.key, !getVal(node, row.key, false));
              app.canvas.setDirty(true, false);
              return true;
            }
            if (st.part === "value") {
              const rect = { x: row.x + LABEL_W, y: row.y + 1, w: row.w - LABEL_W, h: row.h - 2 };
              if (row.type === "dropdown") {
                const opts = row.key === "subfolder_tag" ? ["(none)", ...getTags(node)] : FORMATS;
                let cur = String(getVal(node, row.key, "") ?? "");
                if (row.key === "subfolder_tag" && !cur) cur = "(none)";
                openDropdown(node, rect, opts, cur, val => {
                  if (row.key === "subfolder_tag" && val === "(none)") val = "";
                  setVal(node, row.key, val);
                });
                return true;
              }
              if (row.type === "text") {
                openInlineTextEditor(node, rect, String(getVal(node, row.key, "") ?? ""), val => setVal(node, row.key, val));
                return true;
              }
            }
          }
          return false;
        }

        const nav = hitTestNav(this, pos[0], pos[1]);
        if (nav) {
          const entries = node._cwkEntries?.[channelKey(node).toLowerCase()] ?? [];
          const n = entries.length;
          if (n > 1) {
            node._cwkBatchIndex = ((node._cwkBatchIndex ?? 0) + (nav.key === "next" ? 1 : -1) + n) % n;
            app.canvas.setDirty(true, false);
          }
          return true;
        }
        return false;
      };

      node.onMouseMove = function (e, pos) {
        const h = hitTestTop(this, pos[0], pos[1]) || hitTestSettings(this, pos[0], pos[1]) || hitTestNav(this, pos[0], pos[1]);
        const norm = h ? { type: h.type, key: h.key ?? h.tag ?? null } : null;
        const prev = this._cwkHover;
        if ((prev?.type ?? null) !== (norm?.type ?? null) || (
