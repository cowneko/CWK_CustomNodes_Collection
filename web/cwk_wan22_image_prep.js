/**
 * CWK Wan2.2 Image Prep — ComfyUI Frontend Extension
 * Interactive image cropping with fixed aspect ratio and parameter output.
 *
 * Fixes applied:
 *  #1 – Remove the IMAGE input slot so the node works without a connection.
 *  #2 – Crop frame interior is now 25 % opacity so the photo shows through.
 *  #3 – Combo dropdowns and number widgets now use the same DOM overlay
 *       style / behaviour as cwk_preset_manager.js.
 *  #4 – Auto-scale node height to fit all controls, reduce output gap.
 *  #5 – Persist loaded image as base64 in node data so it survives tab switches.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "CWK Wan2.2 Image Prep";

// ─── Colour palette (shared with preset-manager) ───────────────
const C = {
  bg:       "#1a1f2e",
  bgFull:   "#141824",
  surface:  "#1e2335",
  border:   "#313552",
  text:     "#cdd6f4",
  textDim:  "#6c7086",
  textBlue: "#89b4fa",
  hoverBg:  "#2a2f45",
  arrowHov: "#89b4fa",
  purple:   "#cba6f7",
  yellow:   "#f9e2af",
};

const NODE_COLOR   = "#141824";
const NODE_BGCOLOR = "#1e2335";

// ─── Layout constants ──────────────────────────────────────────
const PAD           = 10;
const TITLE_H       = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H        = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;
const BTN_H         = 26;
const CONTROL_H     = 24;
const SECTION_H     = 20;   // height of a section label row
const ARROW_W       = 20;
const OUTPUT_LABEL_W = 140; // width reserved on the right for output pin labels
const NODE_MIN_W    = 520;
const NODE_MIN_H    = 500;
const PREVIEW_MAX_H = 300;

// ─── Per-node state ────────────────────────────────────────────
function initState(node) {
  if (node._cwk_wan) return node._cwk_wan;
  node._cwk_wan = {
    image: null, imageLoaded: false,
    cropFrame: { x: 0, y: 0, width: 512, height: 512 },
    aspectRatio: 16 / 9,
    isDragging: false, dragHandle: null,
    dragStart: { x: 0, y: 0 },
    previewW: 0, previewH: 0,
    previewOffsetX: 0, previewOffsetY: 0,
    lastComputedHeight: NODE_MIN_H,
  };
  
  return node._cwk_wan;
}

// FIX #5: Load persisted image from filename widget
function restoreImageFromFilename(node) {
  // Only restore if image isn't already loaded
  if (node._cwk_wan.imageLoaded) return;
  
  const imgFilenameWidget = getWidget(node, "image_filename");
  if (!imgFilenameWidget || !imgFilenameWidget.value) return;
  
  const filename = imgFilenameWidget.value;
  const url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&rand=${Math.random()}`);
  
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    node._cwk_wan.image = img;
    node._cwk_wan.imageLoaded = true;
    
    const asp = node._cwk_wan.aspectRatio;
    node._cwk_wan.cropFrame.width  = Math.min(img.naturalWidth, img.naturalHeight * asp);
    node._cwk_wan.cropFrame.height = node._cwk_wan.cropFrame.width / asp;
    node._cwk_wan.cropFrame.x      = (img.naturalWidth  - node._cwk_wan.cropFrame.width)  / 2;
    node._cwk_wan.cropFrame.y      = (img.naturalHeight - node._cwk_wan.cropFrame.height) / 2;
    
    updateWidgetsFromState(node);
    app.canvas.setDirty(true, true);
  };
  img.onerror = () => {
    console.warn("[CWK] Failed to load image:", filename);
  };
  img.src = url;
}

// ─── Helpers ───────────────────────────────────────────────────
function getSlotsBottom(node) {
  const nIn = node.inputs ? node.inputs.length : 0;
  return TITLE_H() + nIn * SLOT_H() + 6;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);         ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getWidget(node, name) {
  return node.widgets?.find(w => w.name === name);
}

// ─── Widget sync ───────────────────────────────────────────────
function updateWidgetsFromState(node) {
  const st = node._cwk_wan;
  if (!st.image) return;
  const map = {
    crop_x:      Math.round(st.cropFrame.x),
    crop_y:      Math.round(st.cropFrame.y),
    crop_width:  Math.round(st.cropFrame.width),
    crop_height: Math.round(st.cropFrame.height),
  };
  for (const [name, val] of Object.entries(map)) {
    const w = getWidget(node, name);
    if (w) w.value = val;
  }
}

// ─── Resolution preset ─────────────────────────────────────────
function applyResolutionPreset(node, preset) {
  const map = {
    "16:9 (832x480)":  16 / 9,
    "16:9 (1280x720)": 16 / 9,
    "9:16 (480x832)":  9  / 16,
    "9:16 (720x1280)": 9  / 16,
    "1:1 (1024x1024)": 1,
  };
  const aspect = map[preset];
  if (!aspect) return;
  const st = node._cwk_wan;
  st.aspectRatio = aspect;
  if (st.image) {
    const img = st.image;
    st.cropFrame.width  = Math.min(img.naturalWidth, img.naturalHeight * aspect);
    st.cropFrame.height = st.cropFrame.width / aspect;
    st.cropFrame.x      = (img.naturalWidth  - st.cropFrame.width)  / 2;
    st.cropFrame.y      = (img.naturalHeight - st.cropFrame.height) / 2;
    updateWidgetsFromState(node);
  }
  app.canvas.setDirty(true, true);
}

// ─── Image upload ──────────────────────────────────────────────
function handleImageUpload(node) {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*";
  input.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Upload to ComfyUI backend immediately
    try {
      const formData = new FormData();
      formData.append("image", file, file.name);
      formData.append("overwrite", "true");
      const res = await fetch("/upload/image", { method: "POST", body: formData });
      if (res.ok) {
        const data = await res.json();
        const filename = data.subfolder
          ? `${data.subfolder}/${data.name}`
          : data.name;
        
        // Set the filename widget so it persists
        const w = getWidget(node, "image_filename");
        if (w) {
          w.value = filename;
          w.callback?.(filename);
        }
        
        // Now load it for preview
        const reader = new FileReader();
        reader.onload = ev => {
          const img = new Image();
          img.onload = () => {
            const st = node._cwk_wan;
            st.image = img; 
            st.imageLoaded = true;
            
            const asp = st.aspectRatio;
            st.cropFrame.width  = Math.min(img.naturalWidth, img.naturalHeight * asp);
            st.cropFrame.height = st.cropFrame.width / asp;
            st.cropFrame.x      = (img.naturalWidth  - st.cropFrame.width)  / 2;
            st.cropFrame.y      = (img.naturalHeight - st.cropFrame.height) / 2;
            updateWidgetsFromState(node);
            app.canvas.setDirty(true, true);
          };
          img.src = ev.target?.result;
        };
        reader.readAsDataURL(file);
      } else {
        console.warn("[CWK] Image upload failed:", res.status);
      }
    } catch (err) {
      console.warn("[CWK] Image upload error:", err);
    }
  });
  input.click();
}

// ══════════════════════════════════════════════════════════════════
// FIX #3 — DOM overlays matching cwk_preset_manager.js style
// ══════════════════════════════════════════════════════════════════

function _blockCanvasEvents(el) {
  for (const ev of ["mousedown","mouseup","click","pointerdown","pointerup",
                     "dblclick","contextmenu","wheel","touchstart","touchend"]) {
    el.addEventListener(ev, e => e.stopPropagation());
  }
}

function _canvasToScreen(node, localX, localY, localW, localH) {
  const bbox = app.canvas.canvas.getBoundingClientRect();
  const zoom = app.canvas.ds?.scale  ?? 1;
  const off  = app.canvas.ds?.offset ?? [0, 0];
  return {
    x: (node.pos[0] + localX) * zoom + off[0] * zoom + bbox.left,
    y: (node.pos[1] + localY) * zoom + off[1] * zoom + bbox.top,
    w: localW  * zoom,
    h: localH  * zoom,
  };
}

// ── Dropdown (combo) ──
let _wanDropdownOutside = null;

function closeWanDropdown() {
  document.getElementById("cwk-wan-dropdown")?.remove();
  if (_wanDropdownOutside) {
    document.removeEventListener("pointerdown", _wanDropdownOutside, { capture: true });
    _wanDropdownOutside = null;
  }
}

function openWanDropdown(node, widgetName, options, localX, localY, localW, localH) {
  closeWanDropdown();
  closeWanInlineEditor();

  const w   = getWidget(node, widgetName);
  const cur = w?.value ?? options[0];
  const sc  = _canvasToScreen(node, localX, localY, localW, localH);
  const zoom = app.canvas.ds?.scale ?? 1;

  const maxVisible = Math.min(options.length, 12);
  const optionH    = Math.max(16, Math.round(18 * zoom));
  const listH      = maxVisible * optionH + 4;
  const spaceBelow = window.innerHeight - sc.y - sc.h - 4;
  const dropTop    = (spaceBelow >= listH || spaceBelow >= sc.y - 4)
    ? sc.y + sc.h + 1
    : sc.y - listH - 1;

  const sel = document.createElement("select");
  sel.id   = "cwk-wan-dropdown";
  sel.size = maxVisible;
  Object.assign(sel.style, {
    position:    "fixed",
    left:        sc.x + "px",
    top:         dropTop + "px",
    width:       sc.w + "px",
    height:      listH + "px",
    fontSize:    Math.max(11, Math.round(11 * zoom)) + "px",
    fontFamily:  "Inter,system-ui,sans-serif",
    background:  C.bgFull,
    color:       C.text,
    border:      `1px solid ${C.arrowHov}`,
    borderRadius:"4px",
    outline:     "none",
    zIndex:      "99999",
    cursor:      "pointer",
    padding:     "2px 0",
    overflow:    "auto",
  });

  for (const opt of options) {
    const o = document.createElement("option");
    o.value       = opt;
    o.textContent = opt;
    Object.assign(o.style, {
      padding:    "2px 8px",
      background: String(cur) === opt ? C.hoverBg    : "transparent",
      color:      String(cur) === opt ? C.arrowHov   : C.text,
    });
    if (String(cur) === opt) o.selected = true;
    sel.appendChild(o);
  }

  _blockCanvasEvents(sel);
  document.body.appendChild(sel);
  sel.focus();
  sel.querySelector("option:checked")?.scrollIntoView({ block: "nearest" });

  let committed = false;
  const commit = val => {
    if (committed) return; committed = true;
    closeWanDropdown();
    if (w) {
      w.value = val;
      w.callback?.(val);
      if (widgetName === "resolution_preset") applyResolutionPreset(node, val);
    }
    app.canvas.setDirty(true, true);
  };

  sel.addEventListener("click",   () => commit(sel.value));
  sel.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter")  { e.preventDefault(); commit(sel.value); }
    if (e.key === "Escape") { committed = true; closeWanDropdown(); app.canvas.setDirty(true, false); }
  });

  _wanDropdownOutside = e => {
    if (e.target !== sel && !sel.contains(e.target)) {
      if (!committed) { committed = true; closeWanDropdown(); app.canvas.setDirty(true, false); }
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", _wanDropdownOutside, { capture: true }), 50);
}

// ── Inline number editor ──
function closeWanInlineEditor() {
  document.getElementById("cwk-wan-inline-backdrop")?.remove();
}

function clampWanValue(ctrl, raw) {
  let v = ctrl.type === "int" ? Math.round(Number(raw)) : Number(raw);
  if (isNaN(v)) return raw;
  if (ctrl.min !== undefined) v = Math.max(ctrl.min, v);
  if (ctrl.max !== undefined) v = Math.min(ctrl.max, v);
  return ctrl.type === "float" ? parseFloat(v.toFixed(2)) : v;
}

function openWanInlineEditor(node, ctrl, localX, localY, localW, localH) {
  closeWanInlineEditor();
  closeWanDropdown();

  const w   = getWidget(node, ctrl.widget);
  const cur = w?.value ?? 0;
  const sc  = _canvasToScreen(node, localX, localY, localW, localH);
  const zoom = app.canvas.ds?.scale ?? 1;

  const backdrop = document.createElement("div");
  backdrop.id = "cwk-wan-inline-backdrop";
  Object.assign(backdrop.style, {
    position: "fixed", inset: "0", zIndex: "99998", background: "transparent",
  });

  const input = document.createElement("input");
  input.type      = "text";
  input.inputMode = "decimal";
  input.value     = ctrl.type === "float"
    ? parseFloat(cur).toFixed(1)
    : String(parseInt(cur));
  Object.assign(input.style, {
    position:    "fixed",
    left:        sc.x + "px",
    top:         sc.y + "px",
    width:       sc.w + "px",
    height:      sc.h + "px",
    fontSize:    Math.max(11, Math.round(11 * zoom)) + "px",
    fontFamily:  "Inter,system-ui,sans-serif",
    background:  C.bgFull,
    color:       C.text,
    border:      `1px solid ${C.arrowHov}`,
    borderRadius:"3px",
    outline:     "none",
    zIndex:      "99999",
    padding:     "0 6px",
    textAlign:   "center",
    boxSizing:   "border-box",
  });

  _blockCanvasEvents(input);
  _blockCanvasEvents(backdrop);

  let committed = false;
  const commit = () => {
    if (committed) return; committed = true;
    const raw = input.value.trim();
    closeWanInlineEditor();
    if (raw !== "" && w) {
      w.value = clampWanValue(ctrl, raw);
      w.callback?.(w.value);
    }
    app.canvas.setDirty(true, false);
  };
  const cancel = () => { if (committed) return; committed = true; closeWanInlineEditor(); app.canvas.setDirty(true, false); };

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

// ── Arrow step helpers ──
function stepWanValue(node, ctrl, direction) {
  const w = getWidget(node, ctrl.widget);
  if (!w) return;
  const step = ctrl.type === "float" ? 0.1 : 1;
  w.value = clampWanValue(ctrl, Number(w.value) + direction * step);
  w.callback?.(w.value);
  app.canvas.setDirty(true, false);
}

// ══════════════════════════════════════════════════════════════════
// Control rows — two named sections
// ══════════════════════════════════════════════════════════════════
function buildControls(node) {
  const gw = name => getWidget(node, name);
  return [
    { section: "Crop Settings" },
    { label:"Resolution",  widget:"resolution_preset", type:"list",
      options:["16:9 (832x480)","16:9 (1280x720)","9:16 (480x832)","9:16 (720x1280)","1:1 (1024x1024)"],
      value: () => gw("resolution_preset")?.value ?? "16:9 (832x480)" },
    { label:"Upscale",     widget:"upscale_method",    type:"list",
      options:["nearest-exact","bilinear","area","bicubic","lanczos"],
      value: () => gw("upscale_method")?.value ?? "nearest-exact" },
    { section: "Output Settings" },
    { label:"Frame Rate",  widget:"frame_rate",         type:"float", min:1,   max:60,
      value: () => parseFloat(gw("frame_rate")?.value   ?? 8).toFixed(1) },
    { label:"Total Steps", widget:"total_steps",        type:"int",   min:1,   max:1000,
      value: () => gw("total_steps")?.value  ?? 50 },
    { label:"Split Steps", widget:"split_steps",        type:"int",   min:1,   max:1000,
      value: () => gw("split_steps")?.value  ?? 25 },
    { label:"CFG Scale",   widget:"cfg_scale",          type:"float", min:0,   max:30,
      value: () => parseFloat(gw("cfg_scale")?.value    ?? 7.5).toFixed(1) },
    { label:"Scheduler",   widget:"scheduler",          type:"list",
      options:["simple","sgm_uniform","karras","exponential","ddim_uniform",
               "beta","normal","linear_quadratic","kl_optimal"],
      value: () => gw("scheduler")?.value  ?? "karras" },
    { label:"Sampler",     widget:"sampler",            type:"list",
      options:["euler","euler_cfg_pp","euler_ancestral","euler_ancestral_cfg_pp",
               "heun","heunpp2","exp_heun_2_x0","exp_heun_2_x0_sde",
               "dpm_2","dpm_2_ancestral","lms","dpm_fast","dpm_adaptive",
               "dpmpp_2s_ancestral","dpmpp_2s_ancestral_cfg_pp","dpmpp_sde","dpmpp_sde_gpu",
               "dpmpp_2m","dpmpp_2m_cfg_pp","dpmpp_2m_sde","dpmpp_2m_sde_gpu",
               "dpmpp_2m_sde_heun","dpmpp_2m_sde_heun_gpu","dpmpp_3m_sde","dpmpp_3m_sde_gpu",
               "ddpm","lcm","ipndm","ipndm_v","deis","res_multistep","res_multistep_cfg_pp",
               "res_multistep_ancestral","res_multistep_ancestral_cfg_pp","gradient_estimation",
               "gradient_estimation_cfg_pp","er_sde","seeds_2","seeds_3","sa_solver",
               "sa_solver_pece","ddim","uni_pc","uni_pc_bh2"],
      value: () => gw("sampler")?.value ?? "euler" },
  ];
}

// ─── Control row drawing ────────────────────────────────────────
function drawControlRow(ctx, node, ctrl, x, y, w) {
  const h       = CONTROL_H;
  const hover   = node._cwk_wan_hoveredControl;
  const isHov   = hover?.widget === ctrl.widget;
  const hovPart = isHov ? hover.part : null;

  roundRect(ctx, x, y, w, h, 4);
  ctx.fillStyle = isHov ? C.hoverBg : C.surface;
  ctx.fill();
  ctx.strokeStyle = isHov ? C.border : "transparent";
  ctx.lineWidth = 1;
  if (isHov) ctx.stroke();

  const labelW = 100;
  ctx.fillStyle    = C.textDim;
  ctx.font         = "11px Inter,system-ui,sans-serif";
  ctx.textAlign    = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(ctrl.label, x + 6, y + h / 2);

  const vx = x + labelW;
  const vw = w - labelW - 2;

  if (ctrl.type === "list") {
    ctx.fillStyle = isHov ? C.arrowHov : C.textDim;
    ctx.font      = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("▾", vx + vw - 5, y + h / 2);
    ctx.fillStyle = C.text;
    ctx.font      = "11px Inter,system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(String(ctrl.value()), vx + 4, y + h / 2, vw - 16);
  } else {
    ctx.font         = "10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle    = hovPart === "left"   ? C.arrowHov : C.textDim;
    ctx.textAlign    = "left";
    ctx.fillText("◀", vx + 2, y + h / 2);
    ctx.fillStyle    = hovPart === "right"  ? C.arrowHov : C.textDim;
    ctx.textAlign    = "right";
    ctx.fillText("▶", vx + vw - 2, y + h / 2);
    ctx.fillStyle    = (hovPart === "center" || hovPart === null && isHov) ? C.arrowHov : C.text;
    ctx.font         = "11px Inter,system-ui,sans-serif";
    ctx.textAlign    = "center";
    ctx.fillText(String(ctrl.value()), vx + vw / 2, y + h / 2, vw - ARROW_W * 2 - 4);
  }
}

// ─── Image preview ─────────────────────────────────────────────
function drawImagePreview(node, ctx, x, y, maxW, maxH) {
  const st = node._cwk_wan;

  roundRect(ctx, x, y, maxW, maxH, 6);
  ctx.fillStyle   = C.surface;
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  if (!st.image || !st.imageLoaded) {
    ctx.fillStyle    = C.textDim;
    ctx.font         = "12px Inter,system-ui,sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("📷 No Image Loaded",         x + maxW / 2, y + maxH / 2 - 10);
    ctx.font = "10px Inter,system-ui,sans-serif";
    ctx.fillText("Use the Upload button below", x + maxW / 2, y + maxH / 2 + 8);
    return;
  }

  const img        = st.image;
  const imgAspect  = img.naturalWidth / img.naturalHeight;
  const prevAspect = maxW / maxH;

  let previewW, previewH, offsetX, offsetY;
  if (imgAspect > prevAspect) {
    previewW = maxW; previewH = maxW / imgAspect;
    offsetX  = 0;    offsetY  = (maxH - previewH) / 2;
  } else {
    previewH = maxH; previewW = maxH * imgAspect;
    offsetX  = (maxW - previewW) / 2; offsetY = 0;
  }

  st.previewW = previewW; st.previewH = previewH;
  st.previewOffsetX = offsetX; st.previewOffsetY = offsetY;

  const scaleX = previewW / img.naturalWidth;
  const scaleY = previewH / img.naturalHeight;
  const frameX = x + offsetX + st.cropFrame.x * scaleX;
  const frameY = y + offsetY + st.cropFrame.y * scaleY;
  const frameW = st.cropFrame.width  * scaleX;
  const frameH = st.cropFrame.height * scaleY;

  ctx.save();
  roundRect(ctx, x, y, maxW, maxH, 6);
  ctx.clip();
  ctx.drawImage(img, x + offsetX, y + offsetY, previewW, previewH);

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x, y, maxW, frameY - y);
  ctx.fillRect(x, frameY, frameX - x, frameH);
  ctx.fillRect(frameX + frameW, frameY, (x + maxW) - (frameX + frameW), frameH);
  ctx.fillRect(x, frameY + frameH, maxW, (y + maxH) - (frameY + frameH));

  ctx.restore();

  ctx.strokeStyle = C.purple;
  ctx.lineWidth   = 2.5;
  roundRect(ctx, frameX, frameY, frameW, frameH, 4);
  ctx.stroke();

  const HS = 10;
  const handles = [
    { type:"nw", x: frameX,          y: frameY          },
    { type:"ne", x: frameX + frameW, y: frameY          },
    { type:"sw", x: frameX,          y: frameY + frameH },
    { type:"se", x: frameX + frameW, y: frameY + frameH },
  ];
  handles.forEach(h => {
    ctx.fillStyle = st.isDragging && st.dragHandle === h.type ? C.yellow : C.purple;
    roundRect(ctx, h.x - HS / 2, h.y - HS / 2, HS, HS, 3);
    ctx.fill();
  });

  node._cwk_wan_hitAreas = {
    preview: { x, y, w: maxW, h: maxH },
    frame:   { x: frameX, y: frameY, w: frameW, h: frameH },
    handles,
  };
}

// ─── Hit-test crop frame ───────────────────────────────────────
function hitTestCropFrame(node, lx, ly) {
  const areas = node._cwk_wan_hitAreas;
  if (!areas) return null;
  for (const h of areas.handles) {
    if (Math.abs(lx - h.x) < 14 && Math.abs(ly - h.y) < 14) return h.type;
  }
  const f = areas.frame;
  if (lx >= f.x && lx <= f.x + f.w && ly >= f.y && ly <= f.y + f.h) return "move";
  const p = areas.preview;
  if (lx >= p.x && lx <= p.x + p.w && ly >= p.y && ly <= p.y + p.h) return "preview";
  return null;
}

// ─── Crop-frame drag ───────────────────────────────────────────
function dragCropFrame(node, lx, ly, type, lastLx, lastLy) {
  const st  = node._cwk_wan;
  const img = st.image;
  if (!img) return;
  const scaleX = img.naturalWidth  / st.previewW;
  const scaleY = img.naturalHeight / st.previewH;
  const dx = (lx - lastLx) * scaleX;
  const dy = (ly - lastLy) * scaleY;
  const minW = 50, minH = 50;

  switch (type) {
    case "move":
      st.cropFrame.x = Math.max(0, Math.min(st.cropFrame.x + dx, img.naturalWidth  - st.cropFrame.width));
      st.cropFrame.y = Math.max(0, Math.min(st.cropFrame.y + dy, img.naturalHeight - st.cropFrame.height));
      break;
    case "nw":
      st.cropFrame.x     += dx; st.cropFrame.width  -= dx;
      st.cropFrame.y     += dy; st.cropFrame.height  = st.cropFrame.width / st.aspectRatio;
      break;
    case "ne":
      st.cropFrame.y     += dy; st.cropFrame.width  += dx;
      st.cropFrame.height = st.cropFrame.width / st.aspectRatio;
      break;
    case "sw":
      st.cropFrame.x     += dx; st.cropFrame.width  -= dx;
      st.cropFrame.height = st.cropFrame.width / st.aspectRatio;
      break;
    case "se":
      st.cropFrame.width  += dx;
      st.cropFrame.height  = st.cropFrame.width / st.aspectRatio;
      break;
  }
  st.cropFrame.width  = Math.max(minW, Math.min(st.cropFrame.width,  img.naturalWidth));
  st.cropFrame.height = Math.max(minH, Math.min(st.cropFrame.height, img.naturalHeight));
  st.cropFrame.x      = Math.max(0,    Math.min(st.cropFrame.x,      img.naturalWidth  - st.cropFrame.width));
  st.cropFrame.y      = Math.max(0,    Math.min(st.cropFrame.y,      img.naturalHeight - st.cropFrame.height));
  updateWidgetsFromState(node);
}

// ─── Compute natural node height ────────────────────────────────
function computeNaturalHeight(node) {
  initState(node);
  // Top zone: preview + upload button (starts at TITLE_H + PAD)
  let cy = TITLE_H() + PAD;
  cy += PREVIEW_MAX_H + 4;
  cy += BTN_H + PAD;
  // Control sections
  cy += SECTION_H + 2;          // "Crop Settings"
  cy += 2 * (CONTROL_H + 2);   // Resolution, Upscale
  cy += SECTION_H + 2;          // "Output Settings"
  cy += 6 * (CONTROL_H + 2);   // Frame Rate…Sampler
  cy += PAD;
  return Math.max(NODE_MIN_H, cy);
}

// ─── Main draw ─────────────────────────────────────────────────
function drawNode(node, ctx) {
  initState(node);
  restoreImageFromFilename(node);

  const w = node.size[0], h = node.size[1];
  const cornerR = LiteGraph.NODE_BORDER_RADIUS ?? 8;

  ctx.save();
  roundRect(ctx, 0, 0, w, h, cornerR); ctx.clip();

  // ── Background layers ────────────────────────────────────────
  // Full node base
  ctx.fillStyle = "#141824"; ctx.fillRect(0, 0, w, h);

  // Top zone (title + preview row): same #141824 per mockup
  const topZoneH = TITLE_H() + PAD + PREVIEW_MAX_H + 4 + BTN_H + PAD;
  ctx.fillStyle = "#141824"; ctx.fillRect(0, TITLE_H(), w, topZoneH - TITLE_H());

  // Bottom zone (controls): standard bg
  ctx.fillStyle = C.bg; ctx.fillRect(0, topZoneH, w, h - topZoneH);

  // ── Preview — left column, beside output pin labels ──────────
  // Right OUTPUT_LABEL_W px are reserved for LiteGraph's output labels.
  const previewMaxW = w - OUTPUT_LABEL_W - PAD * 2;
  const previewX    = PAD;
  let cy = TITLE_H() + PAD;
  drawImagePreview(node, ctx, previewX, cy, Math.max(60, previewMaxW), PREVIEW_MAX_H);
  cy += PREVIEW_MAX_H + 4;

  // ── Upload button ────────────────────────────────────────────
  const btnW = Math.min(200, Math.max(60, previewMaxW));
  const btnX = previewX + (Math.max(60, previewMaxW) - btnW) / 2;
  ctx.fillStyle    = node._cwk_wan_uploadHover ? "#6ea0e0" : C.textBlue;
  roundRect(ctx, btnX, cy, btnW, BTN_H, 4); ctx.fill();
  ctx.fillStyle    = "#141824";
  ctx.font         = "bold 12px Inter,system-ui,sans-serif";
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("📁 Upload Image", btnX + btnW / 2, cy + BTN_H / 2);
  node._cwk_wan_uploadBtn = { x: previewX, y: cy, w: Math.max(60, previewMaxW), h: BTN_H };
  cy += BTN_H + PAD;

  // ── Control rows with section headers ────────────────────────
  const ctrlW = w - PAD * 2 - 10;
  const ctrlX = PAD + 5;
  const controls = buildControls(node);
  node._cwk_wan_controls = [];

  for (const ctrl of controls) {
    if (ctrl.section) {
      ctx.fillStyle    = C.textDim;
      ctx.font         = "bold 10px Inter,system-ui,sans-serif";
      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(ctrl.section, ctrlX, cy + SECTION_H / 2);
      cy += SECTION_H + 2;
      continue;
    }
    drawControlRow(ctx, node, ctrl, ctrlX, cy, ctrlW);
    node._cwk_wan_controls.push({
      ...ctrl,
      localX: ctrlX, localY: cy, localW: ctrlW, localH: CONTROL_H,
      valueX: ctrlX + 100,
      valueW: ctrlW - 100,
    });
    cy += CONTROL_H + 2;
  }

  cy += PAD;
  node._cwk_wan.lastComputedHeight = cy;

  // Resize corner gadget removed — LiteGraph handles resizing natively
  ctx.restore();
}

// ─── Attach all node behaviours ────────────────────────────────
function attachBehaviors(node) {
  initState(node);
  node.color     = NODE_COLOR;
  node.bgcolor   = NODE_BGCOLOR;
  node.resizable = true;

  node.onDrawForeground = ctx => {
    // FIX #5: Restore before drawing
    restoreImageFromFilename(node);
    drawNode(node, ctx);
  };

  node.onResize = size => {
    size[0] = Math.max(NODE_MIN_W, size[0]);
    size[1] = Math.max(NODE_MIN_H, size[1]);
  };

  const origOnDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function(ctx) {
    origOnDrawForeground?.call(this, ctx);
    
    const st = this._cwk_wan;
    const naturalH = st.lastComputedHeight || NODE_MIN_H;
    
    if (naturalH > this.size[1] - 20) {
      this.size[1] = Math.max(NODE_MIN_H, Math.ceil(naturalH + 10));
      app.canvas.setDirty(true, true);
    }
  };

  node.onMouseDown = function(e, pos) {
    const st = this._cwk_wan;
    const [lx, ly] = pos;

    const ub = this._cwk_wan_uploadBtn;
    if (ub && lx >= ub.x && lx <= ub.x + ub.w && ly >= ub.y && ly <= ub.y + ub.h) {
      handleImageUpload(this); return true;
    }

    for (const ctrl of (this._cwk_wan_controls ?? [])) {
      if (lx < ctrl.localX || lx > ctrl.localX + ctrl.localW) continue;
      if (ly < ctrl.localY || ly > ctrl.localY + ctrl.localH) continue;

      if (ctrl.type === "list") {
        openWanDropdown(this, ctrl.widget, ctrl.options,
          ctrl.localX, ctrl.localY, ctrl.localW, ctrl.localH);
        return true;
      }

      const vx = ctrl.valueX, vw = ctrl.valueW;
      if (lx >= ctrl.localX && lx < vx + ARROW_W) {
        stepWanValue(this, ctrl, -1); return true;
      }
      if (lx >= vx + vw - ARROW_W && lx <= ctrl.localX + ctrl.localW) {
        stepWanValue(this, ctrl, +1); return true;
      }
      openWanInlineEditor(this, ctrl,
        ctrl.localX, ctrl.localY, ctrl.localW, ctrl.localH);
      return true;
    }

    const hit = hitTestCropFrame(this, lx, ly);
    if (hit && hit !== "preview") {
      st.isDragging = true; st.dragHandle = hit;
      st.dragStart  = { x: lx, y: ly };
      return true;
    }
    return false;
  };

  node.onMouseMove = function(e, pos) {
    const st = this._cwk_wan;
    const [lx, ly] = pos;
    let dirty = false;

    const ub = this._cwk_wan_uploadBtn;
    const upHov = ub && lx >= ub.x && lx <= ub.x + ub.w && ly >= ub.y && ly <= ub.y + ub.h;
    if (upHov !== this._cwk_wan_uploadHover) { this._cwk_wan_uploadHover = upHov; dirty = true; }

    let hovCtrl = null;
    for (const ctrl of (this._cwk_wan_controls ?? [])) {
      if (lx >= ctrl.localX && lx <= ctrl.localX + ctrl.localW &&
          ly >= ctrl.localY && ly <= ctrl.localY + ctrl.localH) {
        let part = "center";
        if (ctrl.type !== "list") {
          const vx = ctrl.valueX, vw = ctrl.valueW;
          if (lx < vx + ARROW_W)            part = "left";
          else if (lx >= vx + vw - ARROW_W) part = "right";
        }
        hovCtrl = { widget: ctrl.widget, part };
        break;
      }
    }
    const prev = this._cwk_wan_hoveredControl;
    if (JSON.stringify(prev) !== JSON.stringify(hovCtrl)) {
      this._cwk_wan_hoveredControl = hovCtrl; dirty = true;
    }

    if (dirty) app.canvas.setDirty(true, false);

    if (st.isDragging && st.dragHandle) {
      dragCropFrame(this, lx, ly, st.dragHandle, st.dragStart.x, st.dragStart.y);
      st.dragStart = { x: lx, y: ly };
      app.canvas.setDirty(true, false);
      return true;
    }
    return false;
  };

  node.onMouseUp    = function() { const st = this._cwk_wan; st.isDragging = false; st.dragHandle = null; return false; };
  node.onMouseLeave = function() {
    const st = this._cwk_wan;
    st.isDragging = false; st.dragHandle = null;
    this._cwk_wan_uploadHover    = false;
    this._cwk_wan_hoveredControl = null;
  };
}

// ─── FIX #1 – remove any IMAGE input slot ─────────────────────
function removeImageInputs(node) {
  if (!node.inputs) return;
  for (let i = node.inputs.length - 1; i >= 0; i--) {
    if (node.inputs[i].type === "IMAGE" || node.inputs[i].name === "image") {
      node.removeInput(i);
    }
  }
}

// ─── Extension registration ────────────────────────────────────
app.registerExtension({
  name: "cwk.wan_image_prep",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function() {
      const node = this;
      attachBehaviors(node);

      setTimeout(() => {
        removeImageInputs(node);

        for (const w of node.widgets ?? []) {
          w.type        = "hidden";
          w.hidden      = true;
          w.computeSize = () => [0, -4];
        }

        if (node.size[0] < NODE_MIN_W) node.size[0] = NODE_MIN_W;
        const naturalH = computeNaturalHeight(node);
        node.size[1] = Math.max(NODE_MIN_H, naturalH);
        
        app.canvas.setDirty(true, true);
      }, 50);
    };
  },

  afterConfigureGraph() {
    setTimeout(() => {
      for (const node of app.graph._nodes) {
        if (node.type !== NODE_TYPE) continue;
        attachBehaviors(node);
        removeImageInputs(node);
        for (const w of node.widgets ?? []) {
          w.type        = "hidden";
          w.hidden      = true;
          w.computeSize = () => [0, -4];
        }
        if (node.size[0] < NODE_MIN_W) node.size[0] = NODE_MIN_W;
        const naturalH = computeNaturalHeight(node);
        node.size[1] = Math.max(NODE_MIN_H, naturalH);
      }
    }, 500);
  },
});