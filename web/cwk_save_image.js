/**
 * CWK Save Image — ComfyUI canvas node extension.
 *
 *   [ RGB | RGBA | ALPHA ]                [💾 Save] [▲]
 *   ┌─ settings panel (foldable) ─────────────────────┐
 *   │ File name  [ {model_name}_{sampler_name}_... ]  │
 *   │ (name)(model_name)(sampler_name)(cfg)...  ← toggle chips
 *   │ Preview    myModel_rgb_0000.png                 │
 *   │ Imprint infos  [✓]                              │
 *   │ Imprint text [ {name} | {model_name} | ... ]    │
 *   │ (name)(model_name)(cfg)...              ← toggle chips
 *   │ Format  [PNG ▾]  [⚙] → settings popup (quality, │
 *   │        lossless, workflow embed, counter digits)│
 *   │ Save folder / Subfolder / Whole batch           │
 *   └─────────────────────────────────────────────────┘
 *   image preview frame + batch navigation
 *   footer: status (center) + image resolution (right)
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const NODE_TYPE  = "CWK_Save_Image";
const WS_EVENT   = "cwk_save_image_data";
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

const FNAME_CHIP_MAX_ROWS = 3;
const IMPRINT_CHIP_MAX_ROWS = 2;

// Widget names harvested upstream of the infos link (matches pipe infos keys)
const UPSTREAM_TAG_KEYS = [
  "name", "model_name", "sampler_name", "scheduler", "cfg", "steps",
  "clip_skip", "rng", "model_sampling", "clip_name", "clip_type", "vae_name",
];

const TEMP_PREFIXES = ["cwkA_", "cwkN_"];

const C = {
  bg: "#1a1f2e", bgFull: "#141824", surface: "#1e2335", border: "#313552",
  text: "#cdd6f4", textDim: "#6c7086", textBlue: "#89b4fa", hoverBg: "#2a2f45",
  flashGreen: "#a6e3a1", warn: "#e5c07b", err: "#e78284",
};
const NODE_COLOR   = "#141824";
const NODE_BGCOLOR = "#1e2335";

const TITLE_H = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H  = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;
const N_INPUTS  = 3;
const N_OUTPUTS = 0;

// ─── Widget / value helpers ───────────────────────────────────────────────────

function getW(node, name) { return node.widgets?.find(w => w.name === name); }
function getVal(node, name, fb) { const w = getW(node, name); return w ? w.value : fb; }
function setVal(node, name, val) { const w = getW(node, name); if (w) { w.value = val; w.callback?.(val); } }
/** Sanitized numeric setting: finite & within [lo,hi], else the default. */
function _numSetting(node, name, fb, lo, hi) {
  const v = Number(getVal(node, name, fb));
  return (Number.isFinite(v) && v >= lo && v <= hi) ? Math.round(v) : fb;
}

/**
 * Repair widget values after loading a workflow saved with an older node
 * definition. ComfyUI applies saved widgets_values POSITIONALLY, so a save
 * from before widgets were added leaves shifted/stale values (e.g.
 * webp_quality = 0, output_format = "", booleans holding strings).
 * Everything invalid is reset to a type-safe default; the corrected values
 * persist the next time the workflow is saved.
 */
function _normalizeWidgets(node) {
  const str = (name, fb) => {
    const w = getW(node, name);
    if (w && typeof w.value !== "string") w.value = fb;
  };
  const bool = (name, fb) => {
    const w = getW(node, name);
    if (w && typeof w.value !== "boolean") w.value = fb;
  };
  const num = (name, lo, hi, fb) => {
    const w = getW(node, name);
    if (!w) return;
    if (typeof w.value !== "number" || !Number.isFinite(w.value)
        || w.value < lo || w.value > hi) w.value = fb;
    else w.value = Math.round(w.value);
  };
  const oneOf = (name, list, fb) => {
    const w = getW(node, name);
    if (w && !list.includes(String(w.value))) w.value = fb;
  };

  str("filename_template", "{model_name}_{sampler_name}_cfg{cfg}_steps{steps}");
  str("imprint_template",  "{name} | {model_name} | {sampler_name}/{scheduler} | cfg {cfg} steps {steps} seed {seed}");
  str("save_folder", "");
  str("subfolder_tag", "");
  bool("imprint_infos", false);
  bool("webp_lossless", false);
  bool("save_workflow", true);
  bool("save_entire_batch", true);
  bool("settings_folded", false);
  num("jpg_quality", 1, 100, 95);
  num("webp_quality", 1, 100, 95);
  num("counter_digits", 1, 8, 4);
  oneOf("output_format", FORMATS, "PNG");
  oneOf("channel", CHANNEL_KEYS, "RGB");
}

function channelKey(node) { return String(getVal(node, "channel", "RGB")).toUpperCase(); }
function isFolded(node)   { return !!getVal(node, "settings_folded", false); }
function getTags(node)    { return [...Object.keys(node._cwkInfos ?? {}), ...EXTRA_TAGS]; }

// ─── infos: live graph sync ──────────────────────────────────────────────────

function _getInfosSource(node) {
  const input = node.inputs?.find(i => i.name === "infos");
  if (!input || input.link == null) return null;
  const link = app.graph?.links?.[input.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id) ?? null;
}

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

  const merged = { ...(node._cwkExecInfos ?? {}), ...graphInfos };
  const j = JSON.stringify(merged);
  if (j !== node._cwkInfosJson) {
    node._cwkInfos = merged;
    node._cwkInfosJson = j;
    app.canvas.setDirty(true, false);
  }
}

// ─── Filename / imprint resolution ────────────────────────────────────────────

function sanitizeName(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[\s._-]+|[\s._-]+$/g, "") || "_";
}

function resolveTag(node, key) {   // sanitized (for file names)
  if (key === "date") {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  }
  if (key === "time") {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
  }
  let v = (node._cwkInfos ?? {})[key];
  if (v === undefined || v === null) return "";
  v = String(v);
  if (/_name$/.test(key)) v = v.replace(/\.(safetensors|ckpt|gguf|pt|bin|sft|pth)$/i, "");
  return sanitizeName(v);
}

function resolveTagRaw(node, key) {   // raw value (for imprint text)
  if (key === "date" || key === "time") return resolveTag(node, key);
  const v = (node._cwkInfos ?? {})[key];
  return v == null ? "" : String(v).trim();
}

function resolveTemplate(node, template) {
  return String(template ?? "").replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => resolveTag(node, k));
}

function buildImprintText(node) {
  const tpl = String(getVal(node, "imprint_template", "") ?? "");
  if (!tpl.trim()) return "";
  return tpl.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => resolveTagRaw(node, k))
            .replace(/\s{2,}/g, " ")
            .replace(/(\s*\|\s*){2,}/g, " | ")
            .trim();
}

function fmtExt(f) { return f === "JPG" ? "jpg" : String(f).toLowerCase(); }

function templateHas(node, widgetName, tag) {
  return String(getVal(node, widgetName, "") ?? "").includes(`{${tag}}`);
}

/** Toggle a {tag} token in/out of a template widget (chips are click-to-toggle). */
function toggleTag(node, widgetName, tag, sep) {
  const token = `{${tag}}`;
  let t = String(getVal(node, widgetName, "") ?? "");
  if (t.includes(token)) {
    t = t.split(token).join("");
    t = t.replace(/_{2,}/g, "_").replace(/\s{2,}/g, " ")
         .replace(/(\s*\|\s*){2,}/g, " | ").trim();
  } else {
    t = t.trim() ? t.replace(/[\s_]+$/, "") + sep + token : token;
  }
  setVal(node, widgetName, t);
}

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

function _layoutChips(tags, startX, startY, width, maxRows) {
  const chips = [];
  const chipH = 18, gap = 6;
  let cx = startX, cy = startY, rowCount = 1, hidden = 0;
  _measure.font = "10px Inter,system-ui,sans-serif";
  for (let ti = 0; ti < tags.length; ti++) {
    const tag = tags[ti];
    const cw = Math.ceil(_measure.measureText(tag).width) + 16;
    if (cx > startX && cx + cw > startX + width) {
      if (rowCount >= maxRows) { hidden = tags.length - ti; break; }
      cx = startX; cy += chipH + 4; rowCount++;
    }
    chips.push({ tag, x: cx, y: cy, w: cw, h: chipH });
    cx += cw + gap;
  }
  return { chips, hidden, endY: cy + chipH };
}

function getSettingsLayout(node) {
  const W = node.size[0] - PAD * 2;
  let y = getSettingsY();
  const rows = [];
  const tags = getTags(node);

  // 1) filename template (text)
  rows.push({ key: "filename_template", label: "File name", type: "text", x: PAD, y, w: W, h: ROW_H });
  y += ROW_H + 4;

  // 2) filename tag chips (toggle)
  const fl = _layoutChips(tags, PAD, y, W, FNAME_CHIP_MAX_ROWS);
  const chips = fl.chips;
  if (fl.hidden > 0 && fl.endY - 22 + 34 <= PAD + W) {
    chips.push({ tag: `+${fl.hidden}`, x: PAD + 0, y: fl.endY - 22, w: 30, h: 18, dim: true });
  }
  y = fl.endY + 6;

  // 3) filename preview
  rows.push({ key: "_fname_preview", label: "Preview", type: "preview", x: PAD, y, w: W, h: 16 });
  y += 22;

  // 4) imprint toggle + template + imprint chips (toggle)
  rows.push({ key: "imprint_infos", label: "Imprint infos", type: "toggle", x: PAD, y, w: W, h: ROW_H - 2 });
  y += ROW_H;
  rows.push({ key: "imprint_template", label: "Imprint text", type: "text", x: PAD, y, w: W, h: ROW_H - 2 });
  y += ROW_H + 2;
  const il = _layoutChips(tags, PAD, y, W, IMPRINT_CHIP_MAX_ROWS);
  const ichips = il.chips;
  y = il.endY + 6;

  // 5) simple rows (Format has a gear button)
  const simple = [
    { key: "output_format",     label: "Format",      type: "dropdown", gear: true },
    { key: "save_folder",       label: "Save folder", type: "text", placeholder: "(output)" },
    { key: "subfolder_tag",     label: "Subfolder",   type: "dropdown" },
    { key: "save_entire_batch", label: "Whole batch", type: "toggle" },
  ];
  for (const r of simple) { rows.push({ ...r, x: PAD, y, w: W, h: ROW_H - 2 }); y += ROW_H; }

  return { rows, chips, ichips, height: y - getSettingsY() };
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

function getGearRect(row) {
  const gearW = 24;
  const vx = row.x + LABEL_W, vw = row.w - LABEL_W - gearW;
  return { x: vx + vw + 4, y: row.y + 1, w: 20, h: row.h - 2 };
}

// ─── Screen coords / overlay editors ─────────────────────────────────────────

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
  Object.assign(backdrop.style, { position:"fixed", inset:"0", zIndex:"99998", background:"transparent" });

  const input = document.createElement("input");
  input.id = "cwk-si-editor"; input.type = "text";
  input.value = String(current ?? "");
  Object.assign(input.style, {
    position:"fixed", left: sc.x + "px", top: sc.y + "px", width: sc.w + "px", height: sc.h + "px",
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

// ─── Save-settings popup (gear) ───────────────────────────────────────────────

let _setPanel = null, _setBackdrop = null;

function closeSaveSettingsPopup() {
  _setPanel?.remove(); _setBackdrop?.remove();
  _setPanel = null; _setBackdrop = null;
  app.canvas?.setDirty?.(true, false);
}

function openSaveSettingsPopup(node) {
  closeSaveSettingsPopup();

  _setBackdrop = document.createElement("div");
  Object.assign(_setBackdrop.style, { position:"fixed", inset:"0", background:"rgba(0,0,0,.5)", zIndex:"100001" });
  _blockCanvasEvents(_setBackdrop);
  _setBackdrop.addEventListener("mousedown", () => closeSaveSettingsPopup());

  _setPanel = document.createElement("div");
  Object.assign(_setPanel.style, {
    position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
    width: "min(92vw, 400px)", background: "#141824", border: "1px solid #313552",
    borderRadius: "10px", color: "#cdd6f4", fontFamily: "Inter,system-ui,sans-serif",
    fontSize: "13px", zIndex: "100002", boxShadow: "0 24px 80px rgba(0,0,0,.7)", userSelect: "none",
  });
  _blockCanvasEvents(_setPanel);

  // header
  const header = document.createElement("div");
  Object.assign(header.style, { display:"flex", alignItems:"center", padding:"12px 16px",
    background:"#1a2035", borderBottom:"1px solid #2a2f45", borderRadius:"10px 10px 0 0" });
  const title = document.createElement("span");
  title.textContent = "⚙ Save Settings"; title.style.cssText = "font-weight:600; flex:1;";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none; border:none; color:#6c7086; font-size:16px; cursor:pointer; line-height:1;";
  closeBtn.onmouseenter = () => closeBtn.style.color = "#f38ba8";
  closeBtn.onmouseleave = () => closeBtn.style.color = "#6c7086";
  closeBtn.onclick = closeSaveSettingsPopup;
  header.append(title, closeBtn);

  const body = document.createElement("div");
  Object.assign(body.style, { padding: "14px 16px", display: "flex", flexDirection: "column", gap: "13px" });

  const row = () => {
    const r = document.createElement("div");
    Object.assign(r.style, { display: "flex", alignItems: "center", gap: "10px" });
    body.appendChild(r);
    return r;
  };
  const labelCss = "width:130px; flex-shrink:0; color:#cdd6f4;";
  const sliderCss = "flex:1; accent-color:#89b4fa; cursor:pointer;";

  // JPG quality
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "JPG quality"; l.style.cssText = labelCss;
    const s = document.createElement("input"); s.type = "range"; s.min = 1; s.max = 100;
    s.value = _numSetting(node, "jpg_quality", 95, 1, 100);
    setVal(node, "jpg_quality", s.value);
    s.style.cssText = sliderCss;
    const v = document.createElement("span"); v.textContent = s.value;
    v.style.cssText = "width:28px; text-align:right; color:#89b4fa; font-weight:600;";
    s.addEventListener("input", () => { setVal(node, "jpg_quality", Number(s.value)); v.textContent = s.value; });
    r.append(l, s, v);
  }

  // WebP quality (slider disabled when lossless)
  let webpSlider = null, webpVal = null;
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "WebP quality"; l.style.cssText = labelCss;
    webpSlider = document.createElement("input"); webpSlider.type = "range"; webpSlider.min = 1; webpSlider.max = 100;
    webpSlider.value = _numSetting(node, "webp_quality", 95, 1, 100);
    setVal(node, "webp_quality", webpSlider.value);
    webpSlider.style.cssText = sliderCss;
    webpVal = document.createElement("span"); webpVal.textContent = webpSlider.value;
    webpVal.style.cssText = "width:28px; text-align:right; color:#89b4fa; font-weight:600;";
    webpSlider.addEventListener("input", () => { setVal(node, "webp_quality", Number(webpSlider.value)); webpVal.textContent = webpSlider.value; });
    r.append(l, webpSlider, webpVal);
  }

  // WebP lossless
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "WebP lossless"; l.style.cssText = labelCss;
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !!getVal(node, "webp_lossless", false);
    cb.style.accentColor = "#89b4fa"; cb.style.cursor = "pointer";
    const sync = () => {
      webpSlider.disabled = cb.checked;
      webpVal.style.opacity = cb.checked ? ".45" : "1";
      webpSlider.style.opacity = cb.checked ? ".45" : "1";
    };
    cb.addEventListener("change", () => { setVal(node, "webp_lossless", cb.checked); sync(); });
    sync();
    r.append(l, cb);
  }

  // Save workflow with image (PNG)
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "Save workflow (PNG)"; l.style.cssText = labelCss;
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = !!getVal(node, "save_workflow", false);
    cb.style.accentColor = "#89b4fa"; cb.style.cursor = "pointer";
    cb.addEventListener("change", () => setVal(node, "save_workflow", cb.checked));
    r.append(l, cb);
  }

  // Counter digits
  {
    const r = row();
    const l = document.createElement("span"); l.textContent = "Counter digits"; l.style.cssText = labelCss;
    const inp = document.createElement("input"); inp.type = "number"; inp.min = 1; inp.max = 8; inp.step = 1;
    inp.value = _numSetting(node, "counter_digits", 4, 1, 8);
    setVal(node, "counter_digits", Number(inp.value));
    inp.style.cssText = "width:64px; background:#1e2335; border:1px solid #313552; border-radius:6px; color:#cdd6f4; padding:4px 8px; outline:none; font-size:13px;";
    inp.addEventListener("change", () => {
      const d = Math.min(8, Math.max(1, parseInt(inp.value, 10) || 4));
      inp.value = d;
      setVal(node, "counter_digits", d);
      app.canvas.setDirty(true, false);   // refresh filename preview
    });
    r.append(l, inp);
  }

  // Done
  {
    const r = row(); r.style.justifyContent = "flex-end";
    const b = document.createElement("button"); b.textContent = "Done";
    b.style.cssText = "background:#313552; color:#cdd6f4; border:1px solid #313552; border-radius:6px; padding:6px 20px; font-weight:600; cursor:pointer; font-size:13px;";
    b.onmouseenter = () => b.style.filter = "brightness(1.15)";
    b.onmouseleave = () => b.style.filter = "";
    b.onclick = closeSaveSettingsPopup;
    r.appendChild(b);
  }

  _setPanel.append(header, body);
  document.body.append(_setBackdrop, _setPanel);
}

// ─── Preview image loading ────────────────────────────────────────────────────

function viewUrl(entry, mode) {
  const qs = new URLSearchParams({
    filename: String(entry?.filename ?? ""),
    subfolder: String(entry?.subfolder ?? ""),
    type:      String(entry?.type ?? "temp"),
  }).toString();
  const plain = "/view?" + qs;
  if (mode === "plain" || typeof api?.apiURL !== "function") return plain;
  try {
    const u = api.apiURL("/view?" + qs);
    if (typeof u === "string" && u.includes("filename=")) return u;
    console.warn("[CWK SaveImage] api.apiURL mangled the /view URL, using plain form:", u);
  } catch (e) {
    console.warn("[CWK SaveImage] api.apiURL threw, using plain form:", e);
  }
  return plain;
}

function _makeImg(node, key, entry, mode) {
  const img = new Image();
  const url = viewUrl(entry, mode);
  img.onload = () => { app.canvas?.setDirty?.(true, true); };
  img.onerror = () => {
    if (mode === "api") {
      node._cwkImgCache[key] = _makeImg(node, key, entry, "plain");
      app.canvas?.setDirty?.(true, true);
      return;
    }
    node._cwkImgErrors.add(key);
    console.warn("[CWK SaveImage] preview load failed:", url, JSON.stringify(entry));
    fetch(url).then(r => {
      console.warn(`[CWK SaveImage]   → /view returned HTTP ${r.status}`);
      app.canvas?.setDirty?.(true, true);
    }).catch(err => console.warn("[CWK SaveImage]   → fetch probe failed:", err));
    app.canvas?.setDirty?.(true, true);
  };
  img.src = url;
  return img;
}

function getImg(node, ch, idx) {
  node._cwkImgCache  ?? (node._cwkImgCache  = {});
  node._cwkImgErrors ?? (node._cwkImgErrors = new Set());
  const entry = (node._cwkEntries?.[ch] ?? [])[idx];
  if (!entry) return null;
  const key = ch + ":" + idx;
  let img = node._cwkImgCache[key];
  if (!img) {
    img = _makeImg(node, key, entry, "api");
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

function _safeSerializeGraph() {
  try { return JSON.stringify(app.graph.serialize()); }
  catch (e) { console.warn("[CWK SaveImage] graph serialize failed:", e); return null; }
}

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
  const fmt = String(getVal(node, "output_format", "PNG"));
  const imprintOn = !!getVal(node, "imprint_infos", false);
  const saveWf = !!getVal(node, "save_workflow", false);

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
        format: fmt,
        imprint: imprintOn,
        imprint_text: imprintOn ? buildImprintText(node) : "",
        imprint_infos: node._cwkInfos ?? {},
        entire_batch: !!getVal(node, "save_entire_batch", true),
        batch_index: Math.max(0, node._cwkBatchIndex ?? 0),
        jpg_quality:    _numSetting(node, "jpg_quality", 95, 1, 100),
        webp_quality:   _numSetting(node, "webp_quality", 95, 1, 100),
        webp_lossless:  !!getVal(node, "webp_lossless", false),
        save_workflow:  saveWf,
        counter_digits: _numSetting(node, "counter_digits", 4, 1, 8),
        workflow_json:  (saveWf && fmt === "PNG") ? _safeSerializeGraph() : null,
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

function normalizePayload(message) {
  const out = { entries: null, cwk: null };
  if (!message || typeof message !== "object") return out;
  let ui = message;
  if (!ui.cwk && !ui.images && ui.output && typeof ui.output === "object") ui = ui.output;
  if (ui.cwk && Array.isArray(ui.cwk.rgb)) out.cwk = ui.cwk;
  if (Array.isArray(ui.images)) {
    const entries = ui.images.filter(e => e && typeof e.filename === "string" && e.filename);
    if (entries.length) out.entries = entries;
  }
  return out;
}

function _entriesFromImages(entries) {
  const rgb = [], rgba = [], alpha = [];
  let hasMasks = false;
  for (const e of entries) {
    const fn = String(e.filename ?? "");
    let tagged = false;
    for (const p of TEMP_PREFIXES) {
      if (fn.startsWith(p)) {
        tagged = true;
        if (p === "cwkA_") hasMasks = true;
        if (fn.startsWith(p + "rgba_"))       rgba.push(e);
        else if (fn.startsWith(p + "alpha_")) alpha.push(e);
        else                                   rgb.push(e);
        break;
      }
    }
    if (!tagged) rgb.push(e);
  }
  return { rgb, rgba, alpha, hasMasks };
}

function applyOutput(node, message, source) {
  const { entries, cwk } = normalizePayload(message);
  if (!cwk && !entries) return;

  const sig = cwk ? "cwk:" + JSON.stringify(cwk) : "img:" + JSON.stringify(entries);
  if (sig === node._cwkLastSig) return;
  node._cwkLastSig = sig;
  console.log("[CWK SaveImage] payload received via", source ?? (cwk ? "'cwk' ui key" : "'images' fallback"));

  if (cwk) {
    node._cwkExecInfos = (cwk.infos && typeof cwk.infos === "object") ? cwk.infos : {};
    node._cwkEntries = {
      rgb:   Array.isArray(cwk.rgb)   ? cwk.rgb   : [],
      rgba:  Array.isArray(cwk.rgba)  ? cwk.rgba  : [],
      alpha: Array.isArray(cwk.alpha) ? cwk.alpha : [],
    };
    node._cwkHasMasks  = !!cwk.has_masks;
    node._cwkBatchSize = cwk.batch_size ?? node._cwkEntries.rgb.length ?? 1;
  } else {
    const cls = _entriesFromImages(entries);
    node._cwkEntries  = { rgb: cls.rgb, rgba: cls.rgba, alpha: cls.alpha };
    node._cwkHasMasks = cls.hasMasks;
    node._cwkBatchSize = cls.rgb.length || 1;
  }

  node._cwkBatchIndex = 0;
  node._cwkImgCache   = {};
  node._cwkImgErrors  = new Set();
  node._cwkRes        = null;
  _refreshInfos(node);
  node.imageIndex = null;

  const n = node._cwkBatchSize;
  _setStatus(node, `✓ ${n} image${n === 1 ? "" : "s"} ready${node._cwkHasMasks ? "" : " (no masks)"} — press Save to write`);
  app.canvas.setDirty(true, true);
}

function _clearStockImages(node) { node.imageIndex = null; }

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

function _drawChips(node, ctx, chips, widgetName, hoverType) {
  const hover = node._cwkHover;
  for (const chip of chips) {
    const hov = hover?.type === hoverType && hover.key === chip.tag;
    if (chip.dim) {
      ctx.fillStyle = C.textDim; ctx.font = "10px Inter,system-ui,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(chip.tag, chip.x + chip.w / 2, chip.y + chip.h / 2 + 0.5);
      continue;
    }
    const active = templateHas(node, widgetName, chip.tag);
    roundRect(ctx, chip.x, chip.y, chip.w, chip.h, 8);
    ctx.fillStyle = (active || hov) ? C.hoverBg : C.surface; ctx.fill();
    ctx.strokeStyle = (active || hov) ? C.textBlue : C.border;
    ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = active ? C.textBlue : (hov ? C.text : C.text);
    ctx.font = "10px Inter,system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(chip.tag, chip.x + chip.w / 2, chip.y + chip.h / 2 + 0.5);
  }
}

function drawSettings(node, ctx) {
  const L = getSettingsLayout(node);
  const hover = node._cwkHover;

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
      const chl = channelKey(node).toLowerCase();
      const n = node._cwkEntries?.[chl]?.length ?? 0;
      const digits = Math.min(8, Math.max(1, Number(getVal(node, "counter_digits", 4)) || 4));
      const counter = (n > 1 && !!getVal(node, "save_entire_batch", true)) ? "_" + "0".repeat(digits) : "";
      const txt = sub + base + "_" + chl + counter + "." + fmtExt(getVal(node, "output_format", "PNG"));
      ctx.font = "10px Consolas,monospace"; ctx.fillStyle = C.textBlue;
      ctx.fillText(fitText(ctx, txt, row.w - LABEL_W), PAD + LABEL_W, row.y + row.h / 2);
      continue;
    }

    ctx.fillStyle = C.textDim; ctx.font = "10px Inter,system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(row.label, PAD + 4, row.y + row.h / 2);

    // value box (shrunk if a gear follows)
    const gearW = row.gear ? 24 : 0;
    const vx = PAD + LABEL_W, vw = row.w - LABEL_W - gearW;
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

    // gear button
    if (row.gear) {
      const g = getGearRect(row);
      const gHov = hover?.type === "gear";
      roundRect(ctx, g.x, g.y, g.w, g.h, 4);
      ctx.fillStyle = gHov ? C.hoverBg : C.surface; ctx.fill();
      ctx.strokeStyle = gHov ? C.textBlue : C.border; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = gHov ? C.textBlue : C.textDim;
      ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("⚙", g.x + g.w / 2, g.y + g.h / 2 + 0.5);
    }
  }

  _drawChips(node, ctx, L.chips, "filename_template", "chip");
  _drawChips(node, ctx, L.ichips, "imprint_template", "ichip");
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

function drawImprintSim(node, ctx, dx, dy, dw, dh, s) {
  const text = buildImprintText(node);
  if (!text) return;
  const origW = dw / (s || 1);
  const fsOrig = Math.max(13, Math.min(30, origW / 46));
  const fs = fsOrig * s;
  const lineH = (fsOrig + 8) * s;
  ctx.font = `${Math.max(7, Math.round(fs))}px Inter,system-ui,sans-serif`;
  const maxW = dw - 24 * s;
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 3);
  const footerH = shown.length * lineH + 12 * s;
  ctx.fillStyle = "rgba(0,0,0,.92)";
  ctx.fillRect(dx, dy + dh - footerH, dw, footerH);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  let y = dy + dh - footerH + 6 * s;
  for (const l of shown) {
    ctx.fillText(fitText(ctx, l, maxW), dx + 12 * s, y);
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

  roundRect(ctx, pr.x, pr.y, pr.w, pr.h, 5);
  ctx.fillStyle = "#10131f"; ctx.fill();
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();

  ctx.save();
  roundRect(ctx, pr.x + 1, pr.y + 1, pr.w - 2, pr.h - 2, 4);
  ctx.clip();

  if (!entries.length) {
    node._cwkRes = null;
    ctx.fillStyle = C.textDim; ctx.font = "11px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("No images yet — run the workflow", pr.x + pr.w / 2, pr.y + pr.h / 2);
  } else {
    const idx  = Math.min(node._cwkBatchIndex ?? 0, entries.length - 1);
    const ekey = ch + ":" + idx;
    const img  = getImg(node, ch, idx);

    if (node._cwkImgErrors?.has(ekey)) {
      ctx.fillStyle = C.warn; ctx.font = "11px Inter,system-ui,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("preview failed to load — see browser console", pr.x + pr.w / 2, pr.y + pr.h / 2);
    } else if (img && img.complete && img.naturalWidth) {
      node._cwkRes = `${img.naturalWidth}×${img.naturalHeight}`;   // footer resolution
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

  const fy = node.size[1] - STATUS_H / 2 - 2;

  // image resolution — right-aligned footer
  if (node._cwkRes) {
    ctx.fillStyle = C.textDim; ctx.font = "10px Inter,system-ui,sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(node._cwkRes, node.size[0] - PAD - 4, fy);
  }

  if (!text) return;
  const resRoom = node._cwkRes ? 80 : 0;
  ctx.fillStyle = color; ctx.font = "bold 10px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, text, node.size[0] - PAD * 2 - resRoom), node.size[0] / 2, fy);
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
  for (const chip of L.ichips) {
    if (contains(chip, lx, ly)) return { type: "ichip", key: chip.tag, tag: chip.tag };
  }
  for (const row of L.rows) {
    if (ly < row.y || ly > row.y + row.h) continue;
    if (lx < PAD || lx > PAD + row.w) continue;
    if (row.gear && contains(getGearRect(row), lx, ly)) return { type: "gear", key: "gear", row };
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

  async setup() {
    const onWs = ev => {
      try {
        let d = ev?.detail ?? ev?.data ?? ev;
        if (d && typeof d === "object" && d.type === WS_EVENT && d.data) d = d.data;
        if (!d || typeof d !== "object" || !Array.isArray(d.rgb)) return;

        const nid = d.node;
        let node = null;
        try { node = app.graph?.getNodeById?.(nid) ?? null; } catch { node = null; }
        if (!node || node.type !== NODE_TYPE) {
          const nodes = app.graph?._nodes ?? app.graph?.nodes ?? [];
          node = nodes.find(n => n?.type === NODE_TYPE && String(n.id) === String(nid)) ?? null;
        }
        if (!node) return;

        const { node: _route, ...rest } = d;
        applyOutput(node, { cwk: rest }, `websocket event ('${WS_EVENT}')`);
      } catch (e) {
        console.warn("[CWK SaveImage] ws payload error:", e);
      }
    };
    api.addEventListener(WS_EVENT, onWs);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      const node = this;
      node.color = NODE_COLOR;
      node.bgcolor = NODE_BGCOLOR;

      // stock image machinery: permanent neutralization
      try {
        const blackhole = { get: () => null, set: () => {}, configurable: true, enumerable: false };
        Object.defineProperty(node, "imgs", blackhole);
        Object.defineProperty(node, "images", blackhole);
      } catch (e) {
        console.warn("[CWK SaveImage] could not install property blackholes:", e);
      }

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
      node._cwkImgErrors = new Set();
      node._cwkHasMasks = false;
      node._cwkSaving = false;
      node._cwkRes = null;

      node.setSizeForImage = function () {};

      setTimeout(() => {
        // Repair values shifted in by workflows saved with an older node
        // definition (ComfyUI applies widgets_values positionally).
        _normalizeWidgets(node);
        for (const w of node.widgets ?? []) {
          w.type = "hidden"; w.hidden = true;
          w.computeSize = () => [0, -4];
        }
        
        node.size[0] = Math.max(node.size[0] ?? 0, 400);
        node.size[1] = Math.max(node.size[1] ?? 0, 560);
        _refreshInfos(node);
        app.canvas.setDirty(true, true);
      }, 0);

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

      node.onExecuted = function (message) {
        try { applyOutput(node, message); } catch (e) { console.warn("[CWK SaveImage] onExecuted:", e); }
      };

      node._cwkApiExec = ev => {
        try {
          const d = ev?.detail;
          if (!d) return;
          const nid = String(node.id);
          const viaNode    = d.node != null && String(d.node) === nid;
          const viaDisplay = d.display_node != null && String(d.display_node) === nid;
          if (!viaNode && !viaDisplay) return;
          applyOutput(node, d);
        } catch (e) { console.warn("[CWK SaveImage] executed event:", e); }
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
          if (st.type === "chip")  { toggleTag(node, "filename_template", st.tag, "_");    app.canvas.setDirty(true, false); return true; }
          if (st.type === "ichip") { toggleTag(node, "imprint_template",   st.tag, " | "); app.canvas.setDirty(true, false); return true; }
          if (st.type === "gear")  { openSaveSettingsPopup(node); return true; }
          if (st.type === "row") {
            const row = st.row;
            if (row.type === "toggle") {
              setVal(node, row.key, !getVal(node, row.key, false));
              app.canvas.setDirty(true, false);
              return true;
            }
            if (st.part === "value") {
              const gearW = row.gear ? 24 : 0;
              const rect = { x: row.x + LABEL_W, y: row.y + 1, w: row.w - LABEL_W - gearW, h: row.h - 2 };
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
        if ((prev?.type ?? null) !== (norm?.type ?? null) || (prev?.key ?? null) !== (norm?.key ?? null)) {
          this._cwkHover = norm;
          app.canvas.setDirty(true, false);
        }
      };

      node.onMouseLeave = function () {
        if (this._cwkHover !== null) { this._cwkHover = null; app.canvas.setDirty(true, false); }
      };
    };
  },
});
