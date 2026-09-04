/**
 * CWK Wan2.2 Prompt Composer — ComfyUI frontend extension.
 * v8.5: Narrower blocks (+25%), taller prompt (+50%), wider LoRA weight control
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Color palette ─────────────────────────────────────────────────────────────
const C = {
  bg:         "#141824",
  bgPanel:    "#1a1f2e",
  surface:    "#1e2335",
  border:     "#313552",
  text:       "#cdd6f4",
  textDim:    "#6c7086",
  textBlue:   "#89b4fa",
  textGreen:  "#a6e3a1",
  textRed:    "#f38ba8",
  textYellow: "#f9e2af",
  textPurple: "#cba6f7",
  hoverBg:    "#2a2f45",
  accent:     "#89b4fa",
};

const NODE_TYPE        = "CWK_Wan22PromptComposer";
const SPLIT_TYPE       = "CWK_Wan22PipelineSplitter";
const LORA_APPL_TYPE   = "CWK_Wan22LoraApplier";
const LOOP_OPEN_TYPE   = "CWK_Wan22LoopOpen";
const LOOP_CLOSE_TYPE  = "CWK_Wan22LoopClose";
const NODE_COLOR       = "#141824";
const NODE_BGCOLOR     = "#1e2335";

// ── Layout constants ──────────────────────────────────────────────────────────
const PAD              = 10;
const INNER_PAD        = 6;
const TITLE_H          = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H           = () => LiteGraph.NODE_SLOT_HEIGHT  ?? 20;

const COLS             = 3;
const BLOCK_W_MIN      = 360;  // 25% narrower than original 480
const BLOCK_PAD_H      = 8;
const NODE_MIN_W       = PAD * 2 + COLS * BLOCK_W_MIN + BLOCK_PAD_H * (COLS - 1);  // 1116

const BLOCK_HEADER_H   = 28;
const PROMPT_H         = 90;  // 50% taller than original 60
const CTRL_ROW_H       = 24;
const LORA_LABEL_H     = 18;
const LORA_ROW_H       = 22;
const ADD_LORA_H       = 18;
const BLOCK_PAD_B      = 8;

const ADD_BLOCK_H      = 30;
const BOTTOM_PAD       = 14;
const BULK_ROW_H       = 26;  // height of the disable-all / enable-all / invert toolbar row

const BTN_W            = 18;
const BTN_GAP          = 3;
const DRAG_HANDLE_W    = 18;
const DISABLE_BTN_GAP  = 8;  // extra space between drag handle area and disable button

// ── LoRA list ─────────────────────────────────────────────────────────────────
let _loraList = [];

async function _loadLoraList() {
  try {
    const res  = await fetch("/object_info/LoraLoader");
    if (!res.ok) return;
    const data = await res.json();
    const list = data?.LoraLoader?.input?.required?.lora_name?.[0];
    if (Array.isArray(list) && list.length) _loraList = list;
  } catch (e) {
    console.warn("[CWK Wan22] Could not load LoRA list:", e);
  }
}
_loadLoraList();

function getFilteredLoraList() {
  const hasWan = _loraList.some(n =>
    n.replace(/\\/g, "/").split("/").slice(0, -1).some(p => p.toLowerCase().includes("wan"))
  );
  if (!hasWan) return _loraList;
  return _loraList.filter(n =>
    n.replace(/\\/g, "/").split("/").slice(0, -1).some(p => p.toLowerCase().includes("wan"))
  );
}

// ── Preset storage — file-based via ComfyUI /api/userdata/ ───────────────────
// ComfyUI's /api/userdata/{file} route only accepts a SINGLE path segment —
// no subdirectories. We map the user's "collection name" to a flat filename:
//   collection "cwk_presets"   →  user/default/cwk_presets.json
//   collection "action_scenes" →  user/default/action_scenes.json
// The active collection name is remembered in localStorage.
const PRESET_COLLECTION_KEY = "cwk_wan22_preset_collection";

function getPresetCollection() {
  const raw = (localStorage.getItem(PRESET_COLLECTION_KEY) ?? "cwk_presets").trim();
  // strip any path separators — only a plain name is valid
  return raw.replace(/[\/\\]+/g, "_").replace(/^_+|_+$/g, "") || "cwk_presets";
}

function setPresetCollection(name) {
  const clean = name.trim().replace(/[\/\\]+/g, "_").replace(/^_+|_+$/g, "") || "cwk_presets";
  localStorage.setItem(PRESET_COLLECTION_KEY, clean);
}

function _presetFileUrl(collection) {
  // Route: POST/GET /api/userdata/{file}  — single segment, no slashes
  const filename = encodeURIComponent((collection ?? getPresetCollection()) + ".json");
  return `/api/userdata/${filename}`;
}

async function loadPresetsFromFile(collection) {
  try {
    const res = await fetch(_presetFileUrl(collection));
    if (!res.ok) return {};
    const parsed = await res.json();
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
}

async function savePresetsToFile(presets, collection) {
  try {
    const res = await fetch(_presetFileUrl(collection), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(presets, null, 2),
    });
    if (!res.ok) console.warn("[CWK Wan22] Preset save failed:", res.status, await res.text());
    else console.log("[CWK Wan22] Presets saved to", (collection ?? getPresetCollection()) + ".json");
  } catch(e) { console.warn("[CWK Wan22] Could not save presets file:", e); }
}

// ── Styles ────────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("cwk-wan22-styles")) return;
  const s = document.createElement("style");
  s.id = "cwk-wan22-styles";
  s.textContent = `
    .cwk-wan22-backdrop { position:fixed; inset:0; z-index:99998; background:transparent; }
    .cwk-wan22-textarea {
      font-family:Inter,system-ui,sans-serif;
      background:#141824; color:#cdd6f4; border:1px solid #89b4fa;
      border-radius:4px; outline:none; resize:none;
      box-sizing:border-box; line-height:1.5; padding:4px 8px;
    }
    .cwk-wan22-input {
      font-family:Inter,system-ui,sans-serif;
      background:#141824; color:#cdd6f4; border:1px solid #89b4fa;
      border-radius:3px; outline:none; box-sizing:border-box;
      text-align:center; padding:0 6px;
    }
    .cwk-wan22-search {
      font-family:Inter,system-ui,sans-serif;
      background:#141824; color:#cdd6f4;
      border:none; border-bottom:1px solid #313552;
      outline:none; box-sizing:border-box;
      padding:5px 10px; width:100%; text-align:left;
    }
    .cwk-wan22-loradrop {
      background:#141824; border:1px solid #89b4fa;
      border-radius:6px; box-shadow:0 8px 32px rgba(0,0,0,.65);
      display:flex; flex-direction:column; overflow:hidden;
    }
    .cwk-wan22-lorasel {
      font-family:Inter,system-ui,sans-serif;
      background:#141824; color:#cdd6f4;
      border:none; outline:none; cursor:pointer; overflow:auto; flex:1;
    }
    .cwk-wan22-preset-panel {
      background:#141824; border:1px solid #89b4fa;
      border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,.75);
      display:flex; flex-direction:column; overflow:hidden; min-width:320px;
    }
    .cwk-wan22-preset-header {
      font-family:Inter,system-ui,sans-serif; font-size:11px; font-weight:bold;
      color:#cdd6f4; padding:8px 12px 6px; border-bottom:1px solid #313552;
      display:flex; align-items:center; justify-content:space-between;
    }
    .cwk-wan22-preset-list {
      overflow-y:auto; flex:1; max-height:260px;
    }
    .cwk-wan22-preset-item {
      font-family:Inter,system-ui,sans-serif; font-size:11px;
      color:#cdd6f4; padding:7px 12px; cursor:pointer;
      display:flex; align-items:center; justify-content:space-between;
      border-bottom:1px solid #1e2335; transition:background .1s;
    }
    .cwk-wan22-preset-item:hover { background:#2a2f45; }
    .cwk-wan22-preset-item.selected { background:#1e2c44; color:#89b4fa; }
    .cwk-wan22-preset-item-del {
      font-size:10px; color:#6c7086; cursor:pointer; padding:2px 4px;
      border-radius:3px; flex-shrink:0;
    }
    .cwk-wan22-preset-item-del:hover { color:#f38ba8; background:rgba(243,139,168,.15); }
    .cwk-wan22-preset-footer {
      display:flex; gap:6px; padding:8px 10px; border-top:1px solid #313552;
    }
    .cwk-wan22-preset-btn {
      font-family:Inter,system-ui,sans-serif; font-size:10px; font-weight:bold;
      border:1px solid #313552; border-radius:4px; cursor:pointer;
      padding:4px 10px; flex:1; text-align:center;
    }
    .cwk-wan22-preset-btn.primary {
      background:rgba(137,180,250,.15); color:#89b4fa; border-color:#89b4fa;
    }
    .cwk-wan22-preset-btn.primary:hover { background:rgba(137,180,250,.3); }
    .cwk-wan22-preset-btn.danger {
      background:transparent; color:#6c7086; border-color:#313552;
    }
    .cwk-wan22-preset-btn.danger:hover { background:rgba(243,139,168,.15); color:#f38ba8; border-color:#f38ba8; }
    .cwk-wan22-preset-empty {
      font-family:Inter,system-ui,sans-serif; font-size:10px; color:#6c7086;
      font-style:italic; padding:20px; text-align:center;
    }
    .cwk-wan22-name-input {
      font-family:Inter,system-ui,sans-serif; font-size:11px;
      background:#141824; color:#cdd6f4; border:1px solid #89b4fa;
      border-radius:4px; outline:none; padding:5px 10px; width:100%; box-sizing:border-box;
    }
    .cwk-wan22-name-panel {
      background:#141824; border:1px solid #89b4fa;
      border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,.75);
      display:flex; flex-direction:column; gap:8px; padding:14px; min-width:280px;
    }
    .cwk-wan22-name-label {
      font-family:Inter,system-ui,sans-serif; font-size:11px; font-weight:bold; color:#cdd6f4;
    }
  `;
  document.head.appendChild(s);
}

// ── Overlay / keyboard-block lifecycle ────────────────────────────────────────
const _activeCleanups = [];

function closeAllOverlays() {
  document.querySelectorAll(".cwk-wan22-backdrop").forEach(el => el.remove());
  while (_activeCleanups.length) (_activeCleanups.pop())();
}

function _installKeyBlock() {
  const block = e => { e.stopPropagation(); };
  document.addEventListener("keydown",  block, true);
  document.addEventListener("keyup",    block, true);
  document.addEventListener("keypress", block, true);
  return () => {
    document.removeEventListener("keydown",  block, true);
    document.removeEventListener("keyup",    block, true);
    document.removeEventListener("keypress", block, true);
  };
}

// ── Serialization ─────────────────────────────────────────────────────────────
function getFps(node) {
  const w = node.widgets?.find(w => w.name === "frame_rate");
  const v = parseFloat(w?.value);
  return isNaN(v) ? 16.0 : v;
}

function computeFrameCount(duration, fps) {
  return Math.round(parseFloat(duration) * fps) + 1;
}

function serialize(node) {
  const w = node.widgets?.find(w => w.name === "pipeline_data");
  if (!w) return;
  const val = JSON.stringify(node._cwkBlocks ?? []);
  w.value = val; w.callback?.(val);
}

function deserialize(node) {
  const w = node.widgets?.find(w => w.name === "pipeline_data");
  if (!w?.value) return;
  try {
    const parsed = JSON.parse(w.value);
    if (Array.isArray(parsed)) node._cwkBlocks = parsed;
  } catch { /**/ }
}

// ── Layout ────────────────────────────────────────────────────────────────────
function getBulkRowY(node) { return TITLE_H() + SLOT_H() + PAD; }
function getContentStartY(node) { return getBulkRowY(node) + BULK_ROW_H + 4; }

function computeBlockWidth(nodeW) {
  return Math.max(BLOCK_W_MIN, (nodeW - PAD * 2 - BLOCK_PAD_H * (COLS - 1)) / COLS);
}

function computeLayout(node) {
  const nodeW = node.size[0];
  const blockW = computeBlockWidth(nodeW);
  const blocksTotal = node._cwkBlocks?.length ?? 0;
  const rows = Math.ceil(blocksTotal / COLS);

  let blockLayouts = [];
  let maxY = getContentStartY(node);

  for (let row = 0; row < rows; row++) {
    let rowMaxY = maxY;

    for (let col = 0; col < COLS; col++) {
      const blockIdx = row * COLS + col;
      if (blockIdx >= blocksTotal) break;

      const block = node._cwkBlocks[blockIdx];
      const bx = PAD + col * (blockW + BLOCK_PAD_H);
      let by = maxY;

      let y = by + INNER_PAD;
      const headerY = y; y += BLOCK_HEADER_H;
      const promptY = y; y += PROMPT_H;
      
      // Duration and Seed on same Y (side by side)
      const durY = y;
      const seedY = y;
      y += CTRL_ROW_H;
      
      y += INNER_PAD;

      // LoRA sections side-by-side with shared Y coordinates
      const highLabelY = y;
      const lowLabelY = y;
      y += LORA_LABEL_H;

      const highLoraRows = [];
      const lowLoraRows = [];
      const maxLoraCount = Math.max((block.loras_high ?? []).length, (block.loras_low ?? []).length);
      
      for (let li = 0; li < maxLoraCount; li++) {
        const loraY = y;
        if (li < (block.loras_high ?? []).length) {
          highLoraRows.push({ idx: li, y: loraY });
        }
        if (li < (block.loras_low ?? []).length) {
          lowLoraRows.push({ idx: li, y: loraY });
        }
        y += LORA_ROW_H;
      }

      const addHighLoraY = y;
      const addLowLoraY = y;
      y += ADD_LORA_H;

      y += BLOCK_PAD_B;
      const endY = y;

      blockLayouts.push({
        idx: blockIdx,
        col, row,
        bx, by,
        blockW,
        headerY, promptY, durY, seedY,
        highLabelY, highLoraRows, addHighLoraY,
        lowLabelY,  lowLoraRows,  addLowLoraY,
        endY,
      });

      rowMaxY = Math.max(rowMaxY, endY);
    }

    maxY = rowMaxY;
  }

  const addBlockY = maxY + 6;
  const totalH = addBlockY + ADD_BLOCK_H + BOTTOM_PAD;
  return { blockLayouts, addBlockY, totalH };
}

function calcNodeHeight(node) { return computeLayout(node).totalH; }

function calcNodeWidth(node, blocksCount) {
  const neededBlocks = Math.max(blocksCount, 1);
  const displayCols = Math.min(neededBlocks, COLS);
  const computed = PAD * 2 + displayCols * BLOCK_W_MIN + BLOCK_PAD_H * (displayCols - 1);
  return Math.max(NODE_MIN_W, computed);
}

// ── Drag helpers ──────────────────────────────────────────────────────────────
function computeDragTarget(node, dragIdx, deltaX, deltaY) {
  const L = computeLayout(node);
  const dragBl = L.blockLayouts.find(b => b.idx === dragIdx);
  if (!dragBl) return dragIdx;

  const cX = dragBl.bx + dragBl.blockW / 2 + deltaX;
  const cY = dragBl.by + (dragBl.endY - dragBl.by) / 2 + deltaY;

  let closest = dragIdx;
  let minDist = Infinity;

  for (const bl of L.blockLayouts) {
    if (bl.idx === dragIdx) continue;
    const blCx = bl.bx + bl.blockW / 2;
    const blCy = bl.by + (bl.endY - bl.by) / 2;
    const dist = (cX - blCx) ** 2 + (cY - blCy) ** 2;
    if (dist < minDist) {
      minDist = dist;
      closest = bl.idx;
    }
  }

  return closest;
}

function applyDrag(node, dragIdx, targetIdx) {
  if (dragIdx === targetIdx) return;
  
  const blocks = node._cwkBlocks;
  const dragged = blocks[dragIdx];
  const newBlocks = [...blocks];
  
  // Remove the dragged item first
  newBlocks.splice(dragIdx, 1);
  
  // When dragging forward (targetIdx > dragIdx), items after dragIdx shift
  // down by one after removal — but we want the block to land AT the target's
  // original position, so we still insert at targetIdx (no adjustment needed).
  // When dragging backward (targetIdx < dragIdx), no shift occurs for indices
  // below dragIdx, so insert directly at targetIdx.
  newBlocks.splice(targetIdx, 0, dragged);
  
  node._cwkBlocks = newBlocks;
}

// ── Canvas → screen ───────────────────────────────────────────────────────────
function c2s(node, cx, cy, cw, ch) {
  const bbox = app.canvas.canvas.getBoundingClientRect();
  const zoom = app.canvas.ds?.scale ?? 1;
  const off  = app.canvas.ds?.offset ?? [0, 0];
  return {
    x: (node.pos[0] + cx + off[0]) * zoom + bbox.left,
    y: (node.pos[1] + cy + off[1]) * zoom + bbox.top,
    w: cw * zoom, h: ch * zoom,
  };
}

function blockEvents(el) {
  const stop = e => e.stopPropagation();
  [
    "mousedown","mouseup","click","pointerdown","pointerup",
    "dblclick","contextmenu","wheel","touchstart","touchend",
  ].forEach(t => el.addEventListener(t, stop));
  ["keydown","keyup","keypress"].forEach(t =>
    el.addEventListener(t, stop, true)
  );
}

// ── Hit testing ───────────────────────────────────────────────────────────────
function hitTest(node, lx, ly) {
  const L = computeLayout(node);
  const nodeW = node.size[0];

  // Bulk toolbar — left group: preset buttons; right group: block-state buttons
  const bulkY = getBulkRowY(node);
  if (ly >= bulkY && ly <= bulkY + BULK_ROW_H) {
    const btnH = BULK_ROW_H - 6, by2 = bulkY + 3;
    // Left group: Clear All | Save Preset | Load Preset
    const lBtnW = 90, lBtnGap = 6;
    const lStart = PAD;
    const lTypes = ["bulk_clear_all", "bulk_save_preset", "bulk_load_preset"];
    for (let i = 0; i < 3; i++) {
      const bx2 = lStart + i * (lBtnW + lBtnGap);
      if (lx >= bx2 && lx <= bx2 + lBtnW && ly >= by2 && ly <= by2 + btnH)
        return { type: lTypes[i] };
    }
    // Right group: Disable All | Enable All | Invert
    const rBtnW = 90, rBtnGap = 6;
    const rStart = nodeW - PAD - rBtnW * 3 - rBtnGap * 2;
    const rTypes = ["bulk_disable_all", "bulk_enable_all", "bulk_invert"];
    for (let i = 0; i < 3; i++) {
      const bx2 = rStart + i * (rBtnW + rBtnGap);
      if (lx >= bx2 && lx <= bx2 + rBtnW && ly >= by2 && ly <= by2 + btnH)
        return { type: rTypes[i] };
    }
  }

  if (ly >= L.addBlockY && ly <= L.addBlockY + ADD_BLOCK_H) {
    const apBtnW = 26;
    const apBtnX = nodeW - PAD - apBtnW;
    if (lx >= apBtnX && lx <= apBtnX + apBtnW) return { type: "anim_preview_toggle" };
    if (lx >= PAD && lx <= apBtnX - 4)         return { type: "add_block" };
  }

  for (const bl of L.blockLayouts) {
    const bi = bl.idx;
    const bx = bl.bx;
    const by = bl.by;
    const bw = bl.blockW;

    if (lx < bx || lx > bx + bw || ly < by) continue;

    if (ly >= bl.headerY && ly <= bl.headerY + BLOCK_HEADER_H) {
      const rmX      = bx + bw - INNER_PAD - BTN_W;
      const dupX     = rmX - BTN_GAP - BTN_W;
      const disX     = dupX - DISABLE_BTN_GAP - BTN_W;
      if (lx >= rmX)                             return { type: "remove_block",  blockIdx: bi };
      if (lx >= dupX && lx < rmX - BTN_GAP)     return { type: "dup_block",     blockIdx: bi };
      if (lx >= disX && lx < dupX - BTN_GAP)    return { type: "toggle_block",  blockIdx: bi };
      if (lx >= bx + INNER_PAD + 2 && lx <= bx + INNER_PAD + 2 + DRAG_HANDLE_W)
                                                 return { type: "drag_handle",   blockIdx: bi };
      return { type: "block_header", blockIdx: bi };
    }

    if (ly >= bl.promptY && ly <= bl.promptY + PROMPT_H &&
        lx >= bx + INNER_PAD + 2 && lx <= bx + bw - INNER_PAD - 2)
      return { type: "prompt", blockIdx: bi };

    // Duration and Seed (side by side)
    if (ly >= bl.durY && ly <= bl.durY + CTRL_ROW_H) {
      const durX = bx + INNER_PAD;
      const durW = bw / 2 - INNER_PAD;
      const seedX = bx + bw / 2;
      const seedW = bw / 2 - INNER_PAD;

      // Duration side
      if (lx >= durX && lx < durX + durW) {
        const labelW = 35;
        const ctrlW = durW - labelW - 2;
        const vx = durX + labelW;
        if (lx >= vx && lx <= vx + BTN_W)           return { type: "dur_left",   blockIdx: bi };
        if (lx >= vx + ctrlW - BTN_W && lx <= vx + ctrlW) return { type: "dur_right",  blockIdx: bi };
        if (lx >= vx && lx <= vx + ctrlW)           return { type: "dur_center", blockIdx: bi };
      }

      // Seed side
      if (lx >= seedX && lx < seedX + seedW) {
        const labelW = 30;
        const ctrlW = seedW - labelW - BTN_W * 2 - BTN_GAP * 2 - 4;
        const vx = seedX + labelW;
        const btn1X = vx + ctrlW + BTN_GAP;
        const btn2X = btn1X + BTN_W + BTN_GAP;

        if (lx >= vx && lx <= vx + BTN_W)                  return { type: "seed_left",   blockIdx: bi };
        if (lx >= vx + ctrlW - BTN_W && lx <= vx + ctrlW)  return { type: "seed_right",  blockIdx: bi };
        if (lx >= vx && lx <= vx + ctrlW)                  return { type: "seed_center", blockIdx: bi };
        if (lx >= btn1X && lx <= btn1X + BTN_W)            return { type: "seed_randomize", blockIdx: bi };
        if (lx >= btn2X && lx <= btn2X + BTN_W)            return { type: "seed_new_fixed", blockIdx: bi };
      }
    }

    // LoRA sections - check which side
    const loraHighX = bx + INNER_PAD;
    const loraHighW = bw / 2 - INNER_PAD;
    const loraLowX = bx + bw / 2;
    const loraLowW = bw / 2 - INNER_PAD;

    // Check High section
    if (lx >= loraHighX && lx < loraHighX + loraHighW) {
      for (const lr of bl.highLoraRows) {
        if (ly >= lr.y && ly <= lr.y + LORA_ROW_H) {
          const li = lr.idx;
          const rmX = loraHighX + loraHighW - 2 - BTN_W;
          const wCtrlW = 60;
          const wCtrlX = rmX - wCtrlW - 2;
          const nameX = loraHighX + 2;
          const nameW = wCtrlX - nameX - 2;

          if (lx >= rmX && lx <= loraHighX + loraHighW)                  return { type: "remove_lora",   blockIdx: bi, loraIdx: li, stack: "high" };
          if (lx >= wCtrlX && lx <= wCtrlX + BTN_W)                      return { type: "lora_w_left",   blockIdx: bi, loraIdx: li, stack: "high" };
          if (lx >= wCtrlX + wCtrlW - BTN_W && lx <= wCtrlX + wCtrlW)    return { type: "lora_w_right",  blockIdx: bi, loraIdx: li, stack: "high" };
          if (lx >= wCtrlX && lx <= wCtrlX + wCtrlW)                     return { type: "lora_w_center", blockIdx: bi, loraIdx: li, stack: "high" };
          if (lx >= nameX && lx <= nameX + nameW)                        return { type: "lora_name",     blockIdx: bi, loraIdx: li, stack: "high" };
        }
      }
      if (ly >= bl.addHighLoraY && ly <= bl.addHighLoraY + ADD_LORA_H)
        return { type: "add_lora", blockIdx: bi, stack: "high" };
    }

    // Check Low section
    if (lx >= loraLowX && lx < loraLowX + loraLowW) {
      for (const lr of bl.lowLoraRows) {
        if (ly >= lr.y && ly <= lr.y + LORA_ROW_H) {
          const li = lr.idx;
          const rmX = loraLowX + loraLowW - 2 - BTN_W;
          const wCtrlW = 60;
          const wCtrlX = rmX - wCtrlW - 2;
          const nameX = loraLowX + 2;
          const nameW = wCtrlX - nameX - 2;

          if (lx >= rmX && lx <= loraLowX + loraLowW)                    return { type: "remove_lora",   blockIdx: bi, loraIdx: li, stack: "low" };
          if (lx >= wCtrlX && lx <= wCtrlX + BTN_W)                      return { type: "lora_w_left",   blockIdx: bi, loraIdx: li, stack: "low" };
          if (lx >= wCtrlX + wCtrlW - BTN_W && lx <= wCtrlX + wCtrlW)    return { type: "lora_w_right",  blockIdx: bi, loraIdx: li, stack: "low" };
          if (lx >= wCtrlX && lx <= wCtrlX + wCtrlW)                     return { type: "lora_w_center", blockIdx: bi, loraIdx: li, stack: "low" };
          if (lx >= nameX && lx <= nameX + nameW)                        return { type: "lora_name",     blockIdx: bi, loraIdx: li, stack: "low" };
        }
      }
      if (ly >= bl.addLowLoraY && ly <= bl.addLowLoraY + ADD_LORA_H)
        return { type: "add_lora", blockIdx: bi, stack: "low" };
    }
  }
  return null;
}

// ── Drawing helpers ───────────────────────────────────────────────────────────
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function wrapText(ctx, text, maxW, maxLines) {
  const words = (text || "").split(" ");
  const lines = []; let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line); line = word;
      if (lines.length >= maxLines) break;
    } else line = test;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(last + "…").width > maxW && last.length > 1) last = last.slice(0, -1);
    if (last !== lines[maxLines - 1]) lines[maxLines - 1] = last + "…";
  }
  return lines;
}

function drawNumCtrl(ctx, vx, vy, vw, vh, display, hovAny, hovL, hovR, hovC) {
  rr(ctx, vx, vy, vw, vh, 3);
  ctx.fillStyle = C.bg; ctx.strokeStyle = hovAny ? C.border : "transparent";
  ctx.lineWidth = 1; ctx.fill(); if (hovAny) ctx.stroke();
  ctx.font = "8px sans-serif"; ctx.textBaseline = "middle";
  ctx.fillStyle = hovL ? C.accent : C.textDim; ctx.textAlign = "left";
  ctx.fillText("◀", vx + 2, vy + vh / 2);
  ctx.fillStyle = hovR ? C.accent : C.textDim; ctx.textAlign = "right";
  ctx.fillText("▶", vx + vw - 2, vy + vh / 2);
  ctx.fillStyle = hovC ? C.accent : C.text;
  ctx.font = "9px Inter,system-ui,sans-serif"; ctx.textAlign = "center";
  ctx.fillText(display, vx + vw / 2, vy + vh / 2, vw - BTN_W * 2 - 3);
}

function drawSmallBtn(ctx, x, y, w, h, label, hovering) {
  rr(ctx, x, y, w, h, 2);
  ctx.fillStyle = hovering ? "rgba(137,180,250,.3)" : "rgba(137,180,250,.1)";
  ctx.fill();
  ctx.fillStyle = hovering ? C.accent : C.textBlue;
  ctx.font = "7px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2);
}

function drawLoraSection(ctx, node, bi, bl, stack, labelY, loraRows, addLoraY, loraX, loraW, hover, isFloating) {
  const blocks  = node._cwkBlocks;
  const loras   = blocks[bi][stack === "high" ? "loras_high" : "loras_low"] ?? [];
  const color   = stack === "high" ? C.textBlue : C.textPurple;
  const label   = stack === "high" ? "⬆ High" : "⬇ Low";

  ctx.fillStyle = color; ctx.font = "bold 7px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(label, loraX + 2, labelY + LORA_LABEL_H / 2);

  for (const lr of loraRows) {
    const li     = lr.idx;
    const lora   = loras[li];
    const loraY  = lr.y;
    const rmX    = loraX + loraW - 2 - BTN_W;
    const wCtrlW = 60;
    const wCtrlX = rmX - wCtrlW - 2;
    const nameX  = loraX + 2;
    const nameW  = wCtrlX - nameX - 2;

    const lHovNm = !isFloating && hover?.type === "lora_name"     && hover.blockIdx === bi && hover.loraIdx === li && hover.stack === stack;
    const lHovWL = !isFloating && hover?.type === "lora_w_left"   && hover.blockIdx === bi && hover.loraIdx === li && hover.stack === stack;
    const lHovWR = !isFloating && hover?.type === "lora_w_right"  && hover.blockIdx === bi && hover.loraIdx === li && hover.stack === stack;
    const lHovWC = !isFloating && hover?.type === "lora_w_center" && hover.blockIdx === bi && hover.loraIdx === li && hover.stack === stack;
    const lHovW  = lHovWL || lHovWR || lHovWC;
    const lHovRm = !isFloating && hover?.type === "remove_lora"   && hover.blockIdx === bi && hover.loraIdx === li && hover.stack === stack;

    if (lHovNm || lHovW || lHovRm) {
      rr(ctx, loraX, loraY, loraW, LORA_ROW_H, 2);
      ctx.fillStyle = C.hoverBg; ctx.fill();
    }

    ctx.fillStyle = color; ctx.font = "8px sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("⧬", loraX + 3, loraY + LORA_ROW_H / 2);

    const displayName = lora.name
      ? lora.name.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "")
      : "select";
    rr(ctx, nameX, loraY + 1, nameW, LORA_ROW_H - 2, 2);
    ctx.fillStyle   = lHovNm ? C.hoverBg : C.bg;
    ctx.strokeStyle = lHovNm ? C.accent  : C.border;
    ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
    ctx.fillStyle = lora.name ? C.text : C.textDim;
    ctx.font = "7px Inter,system-ui,sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(displayName, nameX + 2, loraY + LORA_ROW_H / 2, nameW - 4);

    drawNumCtrl(ctx, wCtrlX, loraY + 1, wCtrlW, LORA_ROW_H - 2,
      (lora.weight ?? 1.0).toFixed(2), lHovW, lHovWL, lHovWR, lHovWC);

    rr(ctx, rmX, loraY + 1, BTN_W, LORA_ROW_H - 2, 2);
    ctx.fillStyle = lHovRm ? "rgba(243,139,168,.2)" : "transparent"; ctx.fill();
    ctx.fillStyle = lHovRm ? C.textRed : C.textDim;
    ctx.font = "8px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("✕", rmX + BTN_W / 2, loraY + LORA_ROW_H / 2);
  }

  const alHov = !isFloating && hover?.type === "add_lora" && hover.blockIdx === bi && hover.stack === stack;
  rr(ctx, loraX, addLoraY, loraW, ADD_LORA_H, 2);
  ctx.fillStyle   = alHov ? C.hoverBg : "transparent";
  ctx.strokeStyle = alHov ? color     : C.border;
  ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
  ctx.fillStyle = alHov ? color : C.textDim;
  ctx.font = "bold 7px Inter,system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("+ Add", loraX + loraW / 2, addLoraY + ADD_LORA_H / 2);
}

function drawBlock(ctx, node, bi, bl, hover, isPlaceholder, isFloating) {
  const block  = node._cwkBlocks[bi];
  const dur    = parseFloat(block.duration ?? 2.0);
  const fps    = getFps(node);
  const fc     = computeFrameCount(dur, fps);
  const seed   = block.seed ?? 0;

  const bx = bl.bx;
  const by = bl.by;
  const bw = bl.blockW;

  const headerY    = bl.headerY;
  const promptY    = bl.promptY;
  const durY       = bl.durY;
  const seedY      = bl.seedY;
  const highLabelY = bl.highLabelY;
  const highRows   = bl.highLoraRows;
  const addHighY   = bl.addHighLoraY;
  const lowLabelY  = bl.lowLabelY;
  const lowRows    = bl.lowLoraRows;
  const addLowY    = bl.addLowLoraY;

  const blockVisH = bl.endY - bl.by;

  if (isPlaceholder) {
    rr(ctx, bx + INNER_PAD, by + 2, bw - INNER_PAD * 2, blockVisH - 4, 6);
    ctx.setLineDash([5, 4]); ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.textDim; ctx.font = "italic 8px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("dragging…", bx + bw / 2, by + blockVisH / 2);
    return;
  }

  const isDisabled = !isFloating && (block.disabled ?? false);
  const isActive   = !isFloating && (node._cwkActiveClip === bi);

  rr(ctx, bx + INNER_PAD, by + 2, bw - INNER_PAD * 2, blockVisH - 4, 6);
  ctx.fillStyle   = isFloating ? C.bgPanel : isDisabled ? C.bg : C.surface;
  ctx.strokeStyle = isFloating ? C.accent  : isActive ? C.textGreen : isDisabled ? C.textDim : C.border;
  ctx.lineWidth = (isFloating || isActive) ? 2 : 1; ctx.fill(); ctx.stroke();

  // ── Header ───────────────────────────────────────────────────────────────
  ctx.fillStyle = C.textBlue; ctx.font = "11px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("⠿", bx + INNER_PAD + 2 + DRAG_HANDLE_W / 2, headerY + BLOCK_HEADER_H / 2);

  ctx.fillStyle = C.textBlue; ctx.font = "bold 9px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(`${bi + 1}`, bx + INNER_PAD + 2 + DRAG_HANDLE_W + 3, headerY + BLOCK_HEADER_H / 2);

  ctx.fillStyle = C.textDim; ctx.font = "7px Inter,system-ui,sans-serif";
  ctx.fillText(`${dur.toFixed(1)}s · ${fc}f`, bx + INNER_PAD + 2 + DRAG_HANDLE_W + 22, headerY + BLOCK_HEADER_H / 2);

  const rmX  = bx + bw - INNER_PAD - BTN_W;
  const dupX = rmX - BTN_GAP - BTN_W;
  const disX = dupX - DISABLE_BTN_GAP - BTN_W;
  const rmHov  = !isFloating && hover?.type === "remove_block" && hover.blockIdx === bi;
  const dupHov = !isFloating && hover?.type === "dup_block"    && hover.blockIdx === bi;
  const disHov = !isFloating && hover?.type === "toggle_block" && hover.blockIdx === bi;

  // Disable/enable toggle button (⊘ when active, ◎ when disabled)
  rr(ctx, disX, headerY + 4, BTN_W, 18, 2);
  ctx.fillStyle = isDisabled
    ? (disHov ? "rgba(249,226,175,.35)" : "rgba(249,226,175,.15)")
    : (disHov ? "rgba(166,227,161,.15)" : "transparent");
  ctx.fill();
  ctx.fillStyle = isDisabled ? C.textYellow : (disHov ? C.textGreen : C.textDim);
  ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(isDisabled ? "⊘" : "◎", disX + BTN_W / 2, headerY + BLOCK_HEADER_H / 2);

  rr(ctx, dupX, headerY + 4, BTN_W, 18, 2);
  ctx.fillStyle = dupHov ? "rgba(137,180,250,.25)" : "rgba(137,180,250,.08)"; ctx.fill();
  ctx.fillStyle = dupHov ? C.accent : C.textBlue;
  ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("⧉", dupX + BTN_W / 2, headerY + BLOCK_HEADER_H / 2);

  rr(ctx, rmX, headerY + 4, BTN_W, 18, 2);
  ctx.fillStyle = rmHov ? "rgba(243,139,168,.25)" : "transparent"; ctx.fill();
  ctx.fillStyle = rmHov ? C.textRed : C.textDim;
  ctx.font = "10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("✕", rmX + BTN_W / 2, headerY + BLOCK_HEADER_H / 2);

  ctx.strokeStyle = isDisabled ? C.textDim : C.border; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx + INNER_PAD + 3, headerY + BLOCK_HEADER_H);
  ctx.lineTo(bx + bw - INNER_PAD - 3, headerY + BLOCK_HEADER_H);
  ctx.stroke();

  // ── Disabled overlay ──────────────────────────────────────────────────────
  if (isDisabled) {
    const bodyTop = headerY + BLOCK_HEADER_H + 1;
    const bodyH   = bl.endY - bodyTop - 3;
    rr(ctx, bx + INNER_PAD + 1, bodyTop, bw - INNER_PAD * 2 - 2, bodyH, 4);
    ctx.fillStyle = "rgba(20,24,36,0.55)";
    ctx.fill();
    ctx.fillStyle = C.textDim;
    ctx.font = "italic 9px Inter,system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("disabled", bx + bw / 2, bodyTop + bodyH / 2);
    if (isActive) _drawActiveFrame(ctx, bx, by, bw, blockVisH);
    return;
  }

  // ── Prompt ────────────────────────────────────────────────────────────────
  const pHov = !isFloating && hover?.type === "prompt" && hover.blockIdx === bi;
  rr(ctx, bx + INNER_PAD + 2, promptY + 2, bw - INNER_PAD * 2 - 4, PROMPT_H - 4, 3);
  ctx.fillStyle = C.bg; ctx.fill();
  ctx.strokeStyle = pHov ? C.accent : C.border; ctx.lineWidth = 1; ctx.stroke();

  const prompt = block.prompt ?? "";
  if (prompt.trim()) {
    ctx.fillStyle = C.text; ctx.font = "8px Inter,system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const pW = bw - INNER_PAD * 2 - 4 - 6;
    const maxLines = Math.max(3, Math.floor((PROMPT_H - 6) / 12));
    wrapText(ctx, prompt, pW, maxLines).forEach((ln, i) =>
      ctx.fillText(ln, bx + INNER_PAD + 4, promptY + 3 + i * 12, pW));
  } else {
    ctx.fillStyle = C.textDim; ctx.font = "italic 8px Inter,system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("Click…", bx + INNER_PAD + 4, promptY + 4);
  }

  // ── Duration and Seed (side by side) ───────────────────────────────────────
  const durX = bx + INNER_PAD;
  const durW = bw / 2 - INNER_PAD;
  const seedX = bx + bw / 2;
  const seedW = bw / 2 - INNER_PAD;

  // Duration
  const dHL = !isFloating && hover?.type === "dur_left"   && hover.blockIdx === bi;
  const dHR = !isFloating && hover?.type === "dur_right"  && hover.blockIdx === bi;
  const dHC = !isFloating && hover?.type === "dur_center" && hover.blockIdx === bi;
  const dH  = dHL || dHR || dHC;
  if (dH) { rr(ctx, durX + 1, durY, durW - 2, CTRL_ROW_H, 2); ctx.fillStyle = C.hoverBg; ctx.fill(); }
  
  const durLabelW = 30;
  ctx.fillStyle = C.textDim; ctx.font = "8px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Dur", durX + 3, durY + CTRL_ROW_H / 2);
  
  const dVx = durX + durLabelW, dVw = durW - durLabelW - 2;
  drawNumCtrl(ctx, dVx, durY + 2, dVw, CTRL_ROW_H - 4, `${dur.toFixed(1)}s`, dH, dHL, dHR, dHC);

  // Seed
  const sHL = !isFloating && hover?.type === "seed_left"   && hover.blockIdx === bi;
  const sHR = !isFloating && hover?.type === "seed_right"  && hover.blockIdx === bi;
  const sHC = !isFloating && hover?.type === "seed_center" && hover.blockIdx === bi;
  const sHRand = !isFloating && hover?.type === "seed_randomize" && hover.blockIdx === bi;
  const sHNew  = !isFloating && hover?.type === "seed_new_fixed" && hover.blockIdx === bi;
  const sH  = sHL || sHR || sHC;
  if (sH || sHRand || sHNew) { rr(ctx, seedX + 1, seedY, seedW - 2, CTRL_ROW_H, 2); ctx.fillStyle = C.hoverBg; ctx.fill(); }
  
  const seedLabelW = 24;
  ctx.fillStyle = C.textDim; ctx.font = "8px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Seed", seedX + 3, seedY + CTRL_ROW_H / 2);
  
  const sCtrlW = seedW - seedLabelW - BTN_W * 2 - BTN_GAP * 2 - 4;
  const sVx = seedX + seedLabelW;
  drawNumCtrl(ctx, sVx, seedY + 2, sCtrlW, CTRL_ROW_H - 4, String(seed), sH, sHL, sHR, sHC);
  
  const btn1X = sVx + sCtrlW + BTN_GAP;
  const btn2X = btn1X + BTN_W + BTN_GAP;
  drawSmallBtn(ctx, btn1X, seedY + 3, BTN_W, 16, "🔄", sHRand);
  drawSmallBtn(ctx, btn2X, seedY + 3, BTN_W, 16, "⊕", sHNew);

  // ── LoRA stacks (side by side) ────────────────────────────────────────────
  const loraHighX = bx + INNER_PAD;
  const loraHighW = bw / 2 - INNER_PAD;
  const loraLowX = bx + bw / 2;
  const loraLowW = bw / 2 - INNER_PAD;

  drawLoraSection(ctx, node, bi, bl, "high", highLabelY, highRows, addHighY, loraHighX, loraHighW, hover, isFloating);
  drawLoraSection(ctx, node, bi, bl, "low",  lowLabelY,  lowRows,  addLowY,  loraLowX,  loraLowW,  hover, isFloating);

  if (isActive) _drawActiveFrame(ctx, bx, by, bw, blockVisH);
}

// ── Active-block frame helper ─────────────────────────────────────────────────
function _drawActiveFrame(ctx, bx, by, bw, blockVisH) {
  // Outer glow — soft green shadow
  ctx.save();
  ctx.shadowColor  = "#a6e3a1";
  ctx.shadowBlur   = 10;
  rr(ctx, bx + INNER_PAD, by + 2, bw - INNER_PAD * 2, blockVisH - 4, 6);
  ctx.strokeStyle = "#a6e3a1";
  ctx.lineWidth   = 2;
  ctx.stroke();
  ctx.restore();

  // Corner "now generating" badge in top-left of header
  const badgeX = bx + INNER_PAD + 2;
  const badgeY = by + 4;
  ctx.save();
  ctx.fillStyle = "rgba(166,227,161,0.18)";
  rr(ctx, badgeX, badgeY, 44, 10, 3);
  ctx.fill();
  ctx.fillStyle = "#a6e3a1";
  ctx.font = "bold 6px Inter,system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("▶ generating", badgeX + 3, badgeY + 5);
  ctx.restore();
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function drawNode(node, ctx) {
  const W     = node.size[0];
  const H     = node.size[1];
  const L     = computeLayout(node);
  const hover = node._cwkHover ?? null;
  const drag  = node._cwkDrag  ?? null;
  const cr    = LiteGraph.NODE_BORDER_RADIUS ?? 8;

  ctx.save();
  rr(ctx, 0, 0, W, H, cr); ctx.clip();
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  const cY = getContentStartY(node) - PAD / 2;
  ctx.fillStyle = C.bgPanel; ctx.fillRect(0, cY, W, H - cY);

  // ── Bulk toolbar ──────────────────────────────────────────────────────────
  {
    const bulkY = getBulkRowY(node);
    const btnH = BULK_ROW_H - 6, by2 = bulkY + 3;

    // Left group: preset management
    const lBtnW = 90, lBtnGap = 6, lStart = PAD;
    const lLabels = ["✕ Clear All", "💾 Save Preset", "⬇ Load Preset"];
    const lTypes  = ["bulk_clear_all", "bulk_save_preset", "bulk_load_preset"];
    const lColors = [C.textRed, C.textGreen, C.textBlue];
    const lBgHov  = ["rgba(243,139,168,.25)", "rgba(166,227,161,.25)", "rgba(137,180,250,.25)"];
    const lBgNorm = ["rgba(243,139,168,.08)", "rgba(166,227,161,.08)", "rgba(137,180,250,.08)"];
    for (let i = 0; i < 3; i++) {
      const bx2 = lStart + i * (lBtnW + lBtnGap);
      const isHov = hover?.type === lTypes[i];
      rr(ctx, bx2, by2, lBtnW, btnH, 4);
      ctx.fillStyle = isHov ? lBgHov[i] : lBgNorm[i]; ctx.fill();
      ctx.strokeStyle = lColors[i]; ctx.lineWidth = isHov ? 1 : 0.5; ctx.stroke();
      ctx.fillStyle = lColors[i];
      ctx.font = "bold 8px Inter,system-ui,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(lLabels[i], bx2 + lBtnW / 2, by2 + btnH / 2);
    }

    // Centre stats: enabled blocks + total duration
    {
      const enabledBlocks = (node._cwkBlocks ?? []).filter(b => !(b.disabled ?? false));
      const enabledCount  = enabledBlocks.length;
      const totalCount    = (node._cwkBlocks ?? []).length;
      const fps           = getFps(node);
      const totalDur      = enabledBlocks.reduce((sum, b) => sum + parseFloat(b.duration ?? 0), 0);
      const statsText     = `${enabledCount} / ${totalCount} blocks  ·  ${totalDur.toFixed(1)}s`;
      const lGroupEnd     = lStart + 3 * lBtnW + 2 * lBtnGap;
      const rGroupStart   = W - PAD - 90 * 3 - 6 * 2;
      const midX          = (lGroupEnd + rGroupStart) / 2;
      ctx.fillStyle       = C.textDim;
      ctx.font            = "bold 8px Inter,system-ui,sans-serif";
      ctx.textAlign       = "center";
      ctx.textBaseline    = "middle";
      ctx.fillText(statsText, midX, by2 + btnH / 2);
    }

    // Right group: block-state management
    const rBtnW = 90, rBtnGap = 6;
    const rStart = W - PAD - rBtnW * 3 - rBtnGap * 2;
    const rLabels = ["⊘ Disable All", "◎ Enable All", "⇄ Invert"];
    const rTypes  = ["bulk_disable_all", "bulk_enable_all", "bulk_invert"];
    const rColors = [C.textYellow, C.textGreen, C.textBlue];
    const rBgHov  = ["rgba(249,226,175,.25)", "rgba(166,227,161,.25)", "rgba(137,180,250,.25)"];
    const rBgNorm = ["rgba(249,226,175,.08)", "rgba(166,227,161,.08)", "rgba(137,180,250,.08)"];
    for (let i = 0; i < 3; i++) {
      const bx2 = rStart + i * (rBtnW + rBtnGap);
      const isHov = hover?.type === rTypes[i];
      rr(ctx, bx2, by2, rBtnW, btnH, 4);
      ctx.fillStyle = isHov ? rBgHov[i] : rBgNorm[i]; ctx.fill();
      ctx.strokeStyle = rColors[i]; ctx.lineWidth = isHov ? 1 : 0.5; ctx.stroke();
      ctx.fillStyle = rColors[i];
      ctx.font = "bold 8px Inter,system-ui,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(rLabels[i], bx2 + rBtnW / 2, by2 + btnH / 2);
    }
  }

  // ── Blocks ────────────────────────────────────────────────────────────────
  for (const bl of L.blockLayouts) {
    const isDragging = drag && drag.blockIdx === bl.idx;
    drawBlock(ctx, node, bl.idx, bl, hover, isDragging, false);
  }

  // ── Drag overlay ──────────────────────────────────────────────────────────
  if (drag) {
    const { blockIdx, startLx, startLy, currentLx, currentLy } = drag;
    const bl = L.blockLayouts.find(b => b.idx === blockIdx);
    if (bl) {
      const deltaX = currentLx - startLx;
      const deltaY = currentLy - startLy;
      const floatBl = {
        ...bl,
        bx:           bl.bx           + deltaX,
        by:           bl.by           + deltaY,
        headerY:      bl.headerY      + deltaY,
        promptY:      bl.promptY      + deltaY,
        durY:         bl.durY         + deltaY,
        seedY:        bl.seedY        + deltaY,
        highLabelY:   bl.highLabelY   + deltaY,
        lowLabelY:    bl.lowLabelY    + deltaY,
        addHighLoraY: bl.addHighLoraY + deltaY,
        addLowLoraY:  bl.addLowLoraY  + deltaY,
        endY:         bl.endY         + deltaY,
        highLoraRows: bl.highLoraRows.map(r => ({ ...r, y: r.y + deltaY })),
        lowLoraRows:  bl.lowLoraRows.map(r  => ({ ...r, y: r.y + deltaY })),
      };
      ctx.globalAlpha = 0.93;
      drawBlock(ctx, node, blockIdx, floatBl, null, false, true);
      ctx.globalAlpha = 1.0;
    }
  }

  // ── Add block button + animated preview toggle ───────────────────────────
  const apBtnW  = 26;
  const apBtnX  = W - PAD - apBtnW;
  const addBtnW = apBtnX - PAD - 4;
  const apOn    = node._cwkAnimPreview === true;
  const abHov   = hover?.type === "add_block";
  const apHov   = hover?.type === "anim_preview_toggle";

  // Add block
  rr(ctx, PAD, L.addBlockY, addBtnW, ADD_BLOCK_H, 6);
  ctx.fillStyle   = abHov ? C.hoverBg : C.surface;
  ctx.strokeStyle = abHov ? C.accent  : C.border;
  ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
  ctx.fillStyle = abHov ? C.accent : C.text;
  ctx.font = "bold 9px Inter,system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("＋ Add Prompt Block", PAD + addBtnW / 2, L.addBlockY + ADD_BLOCK_H / 2);

  // Animated preview toggle
  rr(ctx, apBtnX, L.addBlockY, apBtnW, ADD_BLOCK_H, 6);
  ctx.fillStyle   = apOn  ? (apHov ? "rgba(166,227,161,.35)" : "rgba(166,227,161,.18)")
                          : (apHov ? C.hoverBg : C.surface);
  ctx.strokeStyle = apOn  ? C.textGreen : (apHov ? C.accent : C.border);
  ctx.lineWidth = 1; ctx.fill(); ctx.stroke();
  ctx.fillStyle = apOn ? C.textGreen : (apHov ? C.accent : C.textDim);
  ctx.font = "13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("▶", apBtnX + apBtnW / 2, L.addBlockY + ADD_BLOCK_H / 2 + 1);

  ctx.restore();
}

// ── Overlays ──────────────────────────────────────────────────────────────────
function openPromptEditor(node, blockIdx, onCommit) {
  closeAllOverlays();

  const L = computeLayout(node), bl = L.blockLayouts.find(b => b.idx === blockIdx);
  if (!bl) return;

  const removeKeyBlock = _installKeyBlock();
  _activeCleanups.push(removeKeyBlock);

  const sc   = c2s(node, bl.bx + INNER_PAD + 2, bl.promptY + 2, bl.blockW - INNER_PAD * 2 - 4, PROMPT_H - 4);
  const bd   = document.createElement("div"); bd.className = "cwk-wan22-backdrop"; blockEvents(bd);
  const ta   = document.createElement("textarea"); ta.className = "cwk-wan22-textarea";
  ta.value = node._cwkBlocks[blockIdx].prompt ?? "";
  Object.assign(ta.style, {
    position: "fixed", left: sc.x + "px", top: sc.y + "px",
    width: sc.w + "px", height: sc.h + "px",
    fontSize: "11px",
    zIndex: "99999",
  });
  blockEvents(ta);

  let done = false;
  const commit = () => {
    if (done) return; done = true;
    closeAllOverlays();
    onCommit(ta.value);
    app.canvas.setDirty(true, false);
  };
  const cancel = () => {
    if (done) return; done = true;
    closeAllOverlays();
    app.canvas.setDirty(true, false);
  };

  ta.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") cancel();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
  });
  bd.addEventListener("pointerdown", e => {
    if (e.target === bd) { e.stopPropagation(); e.preventDefault(); commit(); }
  });

  bd.appendChild(ta);
  document.body.appendChild(bd);
  requestAnimationFrame(() => setTimeout(() => { ta.focus(); ta.select(); }, 0));
}

function openNumberEditor(node, sx, sy, sw, sh, current, step, min, max, onCommit) {
  closeAllOverlays();

  const removeKeyBlock = _installKeyBlock();
  _activeCleanups.push(removeKeyBlock);

  const bd   = document.createElement("div"); bd.className = "cwk-wan22-backdrop"; blockEvents(bd);
  const inp  = document.createElement("input"); inp.className = "cwk-wan22-input";
  inp.type = "text"; inp.inputMode = "decimal"; inp.value = String(current);
  Object.assign(inp.style, {
    position: "fixed", left: sx + "px", top: sy + "px",
    width: sw + "px", height: sh + "px",
    fontSize: "11px",
    zIndex: "99999",
  });
  blockEvents(inp);

  const clamp = raw => {
    let n = parseFloat(raw); if (isNaN(n)) return current;
    n = Math.round(n / step) * step;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return parseFloat(n.toFixed(4));
  };

  let done = false;
  const commit = () => {
    if (done) return; done = true;
    closeAllOverlays();
    onCommit(clamp(inp.value));
    app.canvas.setDirty(true, false);
  };
  const cancel = () => {
    if (done) return; done = true;
    closeAllOverlays();
    app.canvas.setDirty(true, false);
  };

  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") cancel();
  });
  bd.addEventListener("pointerdown", e => {
    if (e.target === bd) { e.stopPropagation(); e.preventDefault(); commit(); }
  });

  bd.appendChild(inp);
  document.body.appendChild(bd);
  requestAnimationFrame(() => setTimeout(() => { inp.focus(); inp.select(); }, 0));
}

function openLoraDropdown(node, blockIdx, loraIdx, stack, sc, onCommit) {
  closeAllOverlays();

  const removeKeyBlock = _installKeyBlock();
  _activeCleanups.push(removeKeyBlock);

  const loraList = getFilteredLoraList();
  const visible  = Math.min(Math.max(loraList.length, 1), 12);
  const optH     = 20;
  const bd       = document.createElement("div"); bd.className = "cwk-wan22-backdrop"; blockEvents(bd);
  const wrap     = document.createElement("div"); wrap.className = "cwk-wan22-loradrop";
  Object.assign(wrap.style, {
    position: "fixed", left: sc.x + "px", top: (sc.y + sc.h + 2) + "px",
    width: Math.max(240, sc.w) + "px",
    maxHeight: (visible * optH + 40) + "px",
    zIndex: "99999",
  });
  blockEvents(wrap);

  const si = document.createElement("input"); si.type = "text"; si.className = "cwk-wan22-search";
  si.placeholder = loraList.length ? `Search ${loraList.length} LoRAs…` : "No LoRAs found";
  Object.assign(si.style, { fontSize: "11px" });

  const sel = document.createElement("select"); sel.className = "cwk-wan22-lorasel"; sel.size = visible;
  Object.assign(sel.style, { fontSize: "11px" });

  const curName = node._cwkBlocks[blockIdx]?.[stack === "high" ? "loras_high" : "loras_low"]?.[loraIdx]?.name ?? "";
  const populate = f => {
    sel.innerHTML = "";
    (f ? loraList.filter(n => n.toLowerCase().includes(f.toLowerCase())) : loraList).forEach(name => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name.replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "");
      opt.title = name;
      if (name === curName) { opt.selected = true; opt.style.color = C.accent; }
      sel.appendChild(opt);
    });
    sel.querySelector("option:checked")?.scrollIntoView({ block: "nearest" });
  };
  populate("");
  si.addEventListener("input", () => populate(si.value));

  let done = false;
  const commit = val => {
    if (done) return; done = true;
    closeAllOverlays();
    onCommit(val);
    app.canvas.setDirty(true, false);
  };
  const cancel = () => {
    if (done) return; done = true;
    closeAllOverlays();
    app.canvas.setDirty(true, false);
  };

  sel.addEventListener("click", () => commit(sel.value));
  sel.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(sel.value); }
    if (e.key === "Escape") cancel();
  });
  si.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") cancel();
    if (e.key === "Enter" && sel.options.length > 0) {
      e.preventDefault();
      commit(sel.options[sel.selectedIndex]?.value ?? "");
    }
    if (e.key === "ArrowDown") { e.preventDefault(); sel.focus(); }
  });
  bd.addEventListener("pointerdown", e => {
    if (!wrap.contains(e.target)) { e.stopPropagation(); e.preventDefault(); cancel(); }
  });

  wrap.appendChild(si); wrap.appendChild(sel); bd.appendChild(wrap);
  document.body.appendChild(bd);

  requestAnimationFrame(() => {
    const r = wrap.getBoundingClientRect();
    if (r.bottom > window.innerHeight) wrap.style.top = (sc.y - r.height - 2) + "px";
    if (r.right  > window.innerWidth)  wrap.style.left = (window.innerWidth - r.width - 8) + "px";
    si.focus();
  });
}

// ── Preset overlays ───────────────────────────────────────────────────────────
function openSavePresetOverlay(node, anchorScreenX, anchorScreenY) {
  closeAllOverlays();
  const removeKeyBlock = _installKeyBlock();
  _activeCleanups.push(removeKeyBlock);

  const bd = document.createElement("div"); bd.className = "cwk-wan22-backdrop"; blockEvents(bd);
  const panel = document.createElement("div"); panel.className = "cwk-wan22-name-panel";
  Object.assign(panel.style, {
    position: "fixed",
    left: anchorScreenX + "px",
    top:  anchorScreenY + "px",
    zIndex: "99999",
  });
  blockEvents(panel);

  // ── Folder row ────────────────────────────────────────────────────────────
  const folderLbl = document.createElement("div"); folderLbl.className = "cwk-wan22-name-label";
  folderLbl.textContent = "Preset collection name";
  const folderInp = document.createElement("input"); folderInp.className = "cwk-wan22-name-input";
  folderInp.type = "text"; folderInp.placeholder = "cwk_presets";
  folderInp.value = getPresetCollection();

  // ── Preset name row ───────────────────────────────────────────────────────
  const nameLbl = document.createElement("div"); nameLbl.className = "cwk-wan22-name-label";
  nameLbl.textContent = "Save preset as…";
  const nameInp = document.createElement("input"); nameInp.className = "cwk-wan22-name-input";
  nameInp.type = "text"; nameInp.placeholder = "Preset name";

  // status line (shown during async save)
  const statusEl = document.createElement("div");
  Object.assign(statusEl.style, {
    fontSize: "9px", color: C.textDim, minHeight: "13px", textAlign: "center",
  });

  // populate a suggested name once we know the existing count
  loadPresetsFromFile(folderInp.value.trim() || "cwk_presets").then(existing => {
    if (!nameInp.value) nameInp.value = `Preset ${Object.keys(existing).length + 1}`;
  });

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, { display: "flex", gap: "6px" });

  const btnSave   = document.createElement("button"); btnSave.className = "cwk-wan22-preset-btn primary";
  btnSave.textContent = "💾 Save";
  const btnCancel = document.createElement("button"); btnCancel.className = "cwk-wan22-preset-btn danger";
  btnCancel.textContent = "Cancel";

  btnRow.appendChild(btnSave); btnRow.appendChild(btnCancel);
  panel.appendChild(folderLbl); panel.appendChild(folderInp);
  panel.appendChild(nameLbl);   panel.appendChild(nameInp);
  panel.appendChild(statusEl);  panel.appendChild(btnRow);
  bd.appendChild(panel); document.body.appendChild(bd);

  let done = false;
  const commit = async () => {
    if (done) return;
    const folder = folderInp.value.trim() || "cwk_presets";
    const name   = nameInp.value.trim();
    if (!name) { nameInp.focus(); return; }
    done = true;
    btnSave.disabled = true;
    statusEl.textContent = "Saving…";
    statusEl.style.color = C.textDim;
    setPresetCollection(folder);
    const presets = await loadPresetsFromFile(folder);
    presets[name]  = JSON.parse(JSON.stringify(node._cwkBlocks));
    await savePresetsToFile(presets, folder);
    closeAllOverlays();
    app.canvas.setDirty(true, false);
  };
  const cancel = () => {
    if (done) return; done = true;
    closeAllOverlays();
    app.canvas.setDirty(true, false);
  };

  btnSave.addEventListener("click",   e => { e.stopPropagation(); commit(); });
  btnCancel.addEventListener("click", e => { e.stopPropagation(); cancel(); });
  // Tab from folder → name field naturally; Enter commits from either field
  [folderInp, nameInp].forEach(inp => {
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter")  { e.preventDefault(); commit(); }
      if (e.key === "Escape") cancel();
    });
  });
  bd.addEventListener("pointerdown", e => {
    if (!panel.contains(e.target)) { e.stopPropagation(); e.preventDefault(); cancel(); }
  });

  requestAnimationFrame(() => {
    const r = panel.getBoundingClientRect();
    if (r.right  > window.innerWidth)  panel.style.left = (window.innerWidth  - r.width  - 8) + "px";
    if (r.bottom > window.innerHeight) panel.style.top  = (window.innerHeight - r.height - 8) + "px";
    folderInp.focus(); folderInp.select();
  });
}

function openLoadPresetOverlay(node, anchorScreenX, anchorScreenY) {
  closeAllOverlays();
  const removeKeyBlock = _installKeyBlock();
  _activeCleanups.push(removeKeyBlock);

  const bd = document.createElement("div"); bd.className = "cwk-wan22-backdrop"; blockEvents(bd);
  const panel = document.createElement("div"); panel.className = "cwk-wan22-preset-panel";
  Object.assign(panel.style, {
    position: "fixed",
    left: anchorScreenX + "px",
    top:  anchorScreenY + "px",
    zIndex: "99999",
  });
  blockEvents(panel);

  // ── Header ────────────────────────────────────────────────────────────────
  const header = document.createElement("div"); header.className = "cwk-wan22-preset-header";
  const headerTitle = document.createElement("span"); headerTitle.textContent = "Load & Manage Presets";

  const folderWrap = document.createElement("div");
  Object.assign(folderWrap.style, { display: "flex", alignItems: "center", gap: "4px" });
  const folderLbl = document.createElement("span");
  folderLbl.textContent = "\u{1F4C1}"; folderLbl.title = "Collection name (= filename in ComfyUI/user/default/)";
  Object.assign(folderLbl.style, { fontSize: "10px", cursor: "default" });
  const folderInp = document.createElement("input");
  Object.assign(folderInp.style, {
    fontFamily: "Inter,system-ui,sans-serif", fontSize: "9px",
    background: C.bg, color: C.textDim, border: "1px solid " + C.border,
    borderRadius: "3px", outline: "none", padding: "2px 5px", width: "120px",
  });
  folderInp.value = getPresetCollection();
  folderInp.title = "Collection name — press Enter to refresh";
  folderWrap.appendChild(folderLbl); folderWrap.appendChild(folderInp);
  header.appendChild(headerTitle); header.appendChild(folderWrap);

  const list = document.createElement("div"); list.className = "cwk-wan22-preset-list";

  let selectedName = null;
  let _cachedPresets = {};
  // track which item is currently being renamed
  let _renamingName = null;

  const buildList = async (folder) => {
    list.innerHTML = "";
    const loading = document.createElement("div"); loading.className = "cwk-wan22-preset-empty";
    loading.textContent = "Loading\u2026"; list.appendChild(loading);

    const f = (folder ?? getPresetCollection()).trim() || "cwk_presets";
    _cachedPresets = await loadPresetsFromFile(f);
    list.innerHTML = "";

    const names = Object.keys(_cachedPresets);
    if (!names.length) {
      const empty = document.createElement("div"); empty.className = "cwk-wan22-preset-empty";
      empty.textContent = "No presets in this collection.";
      list.appendChild(empty);
      return;
    }
    names.sort();

    for (const name of names) {
      const item = document.createElement("div"); item.className = "cwk-wan22-preset-item";
      if (name === selectedName) item.classList.add("selected");

      // ── name / rename input ────────────────────────────────────────────
      const nameSpan = document.createElement("span");
      nameSpan.textContent = name;
      nameSpan.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;margin-right:4px;cursor:pointer;";
      nameSpan.title = "Double-click to rename";

      const renameInp = document.createElement("input");
      Object.assign(renameInp.style, {
        display: "none", flex: "1", minWidth: "0", marginRight: "4px",
        fontFamily: "Inter,system-ui,sans-serif", fontSize: "10px",
        background: C.bg, color: C.text, border: "1px solid " + C.accent,
        borderRadius: "3px", outline: "none", padding: "1px 5px",
      });
      renameInp.value = name;

      // ── meta ───────────────────────────────────────────────────────────
      const blockCount = _cachedPresets[name]?.length ?? 0;
      const meta = document.createElement("span");
      meta.textContent = `${blockCount} block${blockCount !== 1 ? "s" : ""}`;
      meta.style.cssText = "font-size:9px;color:#6c7086;margin-right:4px;flex-shrink:0;white-space:nowrap;";

      // ── ✎ rename button ────────────────────────────────────────────────
      const renameBtn = document.createElement("span");
      renameBtn.textContent = "\u270E"; renameBtn.title = "Rename preset";
      renameBtn.style.cssText = "cursor:pointer;font-size:10px;color:#6c7086;margin-right:2px;flex-shrink:0;user-select:none;padding:1px 3px;border-radius:3px;";
      renameBtn.addEventListener("mouseenter", () => { renameBtn.style.color = C.text; });
      renameBtn.addEventListener("mouseleave", () => { renameBtn.style.color = "#6c7086"; });

      // ── ✕ delete button ────────────────────────────────────────────────
      const del = document.createElement("span"); del.className = "cwk-wan22-preset-item-del";
      del.textContent = "\u2715"; del.title = "Delete preset";

      // ── rename logic ───────────────────────────────────────────────────
      const startRename = (e) => {
        e && e.stopPropagation();
        if (_renamingName === name) return;
        _renamingName = name;
        nameSpan.style.display = "none";
        renameInp.style.display = "";
        meta.style.display = "none";
        renameInp.focus(); renameInp.select();
      };
      const commitRename = async () => {
        const newName = renameInp.value.trim();
        _renamingName = null;
        if (!newName || newName === name) { buildList(folderInp.value.trim() || "cwk_presets"); return; }
        const f = folderInp.value.trim() || "cwk_presets";
        const presets = await loadPresetsFromFile(f);
        presets[newName] = presets[name];
        delete presets[name];
        await savePresetsToFile(presets, f);
        if (selectedName === name) selectedName = newName;
        buildList(f);
      };
      const cancelRename = () => {
        _renamingName = null;
        buildList(folderInp.value.trim() || "cwk_presets");
      };

      renameBtn.addEventListener("click", startRename);
      nameSpan.addEventListener("dblclick", e => { e.stopPropagation(); startRename(); });
      renameInp.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.key === "Enter")  { e.preventDefault(); commitRename(); }
        if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
      });
      renameInp.addEventListener("blur", () => {
        // small delay so click on another button wins first
        setTimeout(() => { if (_renamingName === name) cancelRename(); }, 150);
      });

      // ── delete logic ───────────────────────────────────────────────────
      del.addEventListener("click", async e => {
        e.stopPropagation();
        if (confirm(`Delete preset "${name}"?`)) {
          const f = folderInp.value.trim() || "cwk_presets";
          const presets = await loadPresetsFromFile(f);
          delete presets[name];
          await savePresetsToFile(presets, f);
          if (selectedName === name) selectedName = null;
          buildList(f);
        }
      });

      // ── row selection ──────────────────────────────────────────────────
      item.addEventListener("click", e => {
        e.stopPropagation();
        if (_renamingName) return;
        selectedName = name;
        list.querySelectorAll(".cwk-wan22-preset-item").forEach(el => el.classList.remove("selected"));
        item.classList.add("selected");
      });
      item.addEventListener("dblclick", e => {
        e.stopPropagation();
        if (_renamingName) return;
        selectedName = name;
        commitLoad();
      });

      item.appendChild(nameSpan); item.appendChild(renameInp);
      item.appendChild(meta); item.appendChild(renameBtn); item.appendChild(del);
      list.appendChild(item);
    }
  };

  // Reload list when folder field changes
  let _folderDebounce = null;
  folderInp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") cancel();
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(_folderDebounce);
      buildList(folderInp.value.trim() || "cwk_presets");
    }
  });
  folderInp.addEventListener("blur", () => {
    clearTimeout(_folderDebounce);
    _folderDebounce = setTimeout(() => buildList(folderInp.value.trim() || "cwk_presets"), 200);
  });

  const footer = document.createElement("div"); footer.className = "cwk-wan22-preset-footer";
  const btnLoad   = document.createElement("button"); btnLoad.className = "cwk-wan22-preset-btn primary";
  btnLoad.textContent = "\u2B07 Load";
  const btnCancel = document.createElement("button"); btnCancel.className = "cwk-wan22-preset-btn danger";
  btnCancel.textContent = "Close";
  footer.appendChild(btnLoad); footer.appendChild(btnCancel);

  panel.appendChild(header); panel.appendChild(list); panel.appendChild(footer);
  bd.appendChild(panel); document.body.appendChild(bd);

  // kick off the initial list load now that panel is in the DOM
  buildList();

  let done = false;
  const commitLoad = () => {
    if (done) return;
    if (!selectedName) return;
    done = true;
    const folder = folderInp.value.trim() || "cwk_presets";
    setPresetCollection(folder);
    const blocks = _cachedPresets[selectedName];
    if (blocks) {
      node._cwkBlocks = JSON.parse(JSON.stringify(blocks));
      for (const b of node._cwkBlocks) {
        if (!b.loras_high) b.loras_high = [];
        if (!b.loras_low)  b.loras_low  = [];
        if (b.seed === undefined) b.seed = Math.floor(Math.random() * 0x3FFFFFFFFFFFFFF);
        if (b.disabled === undefined) b.disabled = false;
      }
      const blocksCount = node._cwkBlocks.length;
      node.size[0] = Math.max(NODE_MIN_W, calcNodeWidth(node, blocksCount));
      node.size[1] = calcNodeHeight(node);
      serialize(node);
    }
    closeAllOverlays();
    app.canvas.setDirty(true, true);
  };
  const cancel = () => {
    if (done) return; done = true;
    closeAllOverlays();
    app.canvas.setDirty(true, false);
  };

  btnLoad.addEventListener("click",   e => { e.stopPropagation(); commitLoad(); });
  btnCancel.addEventListener("click", e => { e.stopPropagation(); cancel(); });
  bd.addEventListener("pointerdown", e => {
    if (!panel.contains(e.target)) { e.stopPropagation(); e.preventDefault(); cancel(); }
  });
  bd.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") cancel();
    if (e.key === "Enter" && !_renamingName) commitLoad();
  });

  requestAnimationFrame(() => {
    const r = panel.getBoundingClientRect();
    if (r.right  > window.innerWidth)  panel.style.left = (window.innerWidth  - r.width  - 8) + "px";
    if (r.bottom > window.innerHeight) panel.style.top  = (window.innerHeight - r.height - 8) + "px";
  });
}
// ── Animated-preview toggle ───────────────────────────────────────────────────
// ── VHS AnimateLatentPreview helpers ─────────────────────────────────────────
// The correct setting key is VHS.LatentPreview ("Display animated previews when sampling").
// VHS.AnimateLatentPreview exists in settingsValues but is NOT the one the
// Settings panel checkbox is bound to — that one is VHS.LatentPreview.
// settingsValues is a Vue Proxy, so assigning to it triggers reactive UI updates.
const VHS_SETTING_KEY = "VHS.LatentPreview";

async function _readAnimPreviewSetting() {
  try {
    const sv = app.ui?.settings?.settingsValues;
    if (sv && VHS_SETTING_KEY in sv) return Boolean(sv[VHS_SETTING_KEY]);
  } catch { /**/ }
  try {
    const resp = await fetch(`/api/settings/${encodeURIComponent(VHS_SETTING_KEY)}`);
    if (resp.ok) { const val = await resp.json(); return val === true; }
  } catch { /**/ }
  return false;
}

async function _writeAnimPreviewSetting(value) {
  // 1. Mutate the Vue reactive Proxy directly → updates the Settings panel checkbox instantly
  try {
    const sv = app.ui?.settings?.settingsValues;
    if (sv) {
      sv[VHS_SETTING_KEY] = value;
      console.log(`[CWK VHS] settingsValues['${VHS_SETTING_KEY}'] = ${value} ✓`);
    }
  } catch(e) { console.warn("[CWK VHS] settingsValues mutation failed:", e); }

  // 2. Persist to server so it survives page reload
  try {
    await fetch(`/api/settings/${encodeURIComponent(VHS_SETTING_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    console.log(`[CWK VHS] POST /api/settings/${VHS_SETTING_KEY} = ${value} ✓`);
  } catch(e) { console.warn("[CWK VHS] server persist failed:", e); }

  // 3. Also fire through the official APIs in case they trigger onChange callbacks
  try { app.extensionManager?.setting?.set(VHS_SETTING_KEY, value); } catch { /**/ }
  try { app.ui?.settings?.setSettingValue(VHS_SETTING_KEY, value); } catch { /**/ }
}

async function syncAnimPreview(node) {
  node._cwkAnimPreview = await _readAnimPreviewSetting();
  app.canvas.setDirty(true, false);
  setTimeout(async () => {
    const v = await _readAnimPreviewSetting();
    if (v !== node._cwkAnimPreview) {
      node._cwkAnimPreview = v;
      app.canvas.setDirty(true, false);
    }
  }, 2000);
}

async function toggleAnimPreview(node) {
  const next = !(node._cwkAnimPreview === true);
  node._cwkAnimPreview = next;
  app.canvas.setDirty(true, false);
  await _writeAnimPreviewSetting(next);
}

// ── Mutations ─────────────────────────────────────────────────────────────────
const touch = (node, resize = false) => {
  serialize(node);
  if (resize) {
    const blocksCount = node._cwkBlocks?.length ?? 0;
    node.size[0] = calcNodeWidth(node, blocksCount);
    node.size[1] = calcNodeHeight(node);
  }
  app.canvas.setDirty(true, resize);
};

const getStack = (node, bi, stack) =>
  node._cwkBlocks[bi][stack === "high" ? "loras_high" : "loras_low"];

function addBlock(node) {
  const seed = Math.floor(Math.random() * 0x3FFFFFFFFFFFFFF);
  node._cwkBlocks.push({
    prompt: "",
    duration: 2.0,
    seed: seed,
    disabled: false,
    loras_high: [],
    loras_low: []
  });
  touch(node, true);
}

function dupBlock(node, bi) {
  const original = node._cwkBlocks[bi];
  const newBlock = JSON.parse(JSON.stringify(original));
  newBlock.seed = Math.floor(Math.random() * 0x3FFFFFFFFFFFFFF);
  node._cwkBlocks.splice(bi + 1, 0, newBlock);
  touch(node, true);
}

function removeBlock(node, bi)     { node._cwkBlocks.splice(bi, 1); touch(node, true); }
function toggleBlock(node, bi)     { node._cwkBlocks[bi].disabled = !node._cwkBlocks[bi].disabled; touch(node); }
function disableAllBlocks(node)    { node._cwkBlocks.forEach(b => { b.disabled = true; }); touch(node); }
function enableAllBlocks(node)     { node._cwkBlocks.forEach(b => { b.disabled = false; }); touch(node); }
function invertBlocks(node)        { node._cwkBlocks.forEach(b => { b.disabled = !b.disabled; }); touch(node); }
function clearAllBlocks(node)      { node._cwkBlocks = []; touch(node, true); }
function setPrompt(node, bi, t)    { node._cwkBlocks[bi].prompt = t; touch(node); }
function setDuration(node, bi, v)  { node._cwkBlocks[bi].duration = Math.max(0.1, parseFloat(parseFloat(v).toFixed(1))); touch(node); }
function setSeed(node, bi, v)      { node._cwkBlocks[bi].seed = Math.max(0, Math.min(0x3FFFFFFFFFFFFFF, Math.floor(v))); touch(node); }
function randomizeBlockSeed(node, bi) { node._cwkBlocks[bi].seed = Math.floor(Math.random() * 0x3FFFFFFFFFFFFFF); touch(node); }
function newFixedSeed(node, bi)    { node._cwkBlocks[bi].seed = Math.floor(Math.random() * 0x3FFFFFFFFFFFFFF); touch(node); }
function setFps(node, v)           { const w = node.widgets?.find(w => w.name === "frame_rate"); if (w) { const c = parseFloat(Math.max(1, Math.min(120, v)).toFixed(1)); w.value = c; w.callback?.(c); } app.canvas.setDirty(true, false); }
function addLora(node, bi, stack)  { getStack(node, bi, stack).push({ name: "", weight: 1.0, clip_weight: 1.0 }); touch(node, true); }
function removeLora(node, bi, li, st) { getStack(node, bi, st).splice(li, 1); touch(node, true); }
function setLoraName(node, bi, li, st, name) { const l = getStack(node, bi, st)[li]; l.name = name; l.clip_weight = l.weight; touch(node); }
function setLoraWeight(node, bi, li, st, v)  { const w2 = parseFloat(Math.max(0, Math.min(10, v)).toFixed(2)); const l = getStack(node, bi, st)[li]; l.weight = w2; l.clip_weight = w2; touch(node); }

// ── Mouse handler ─────────────────────────────────────────────────────────────
function handleMouseDown(node, pos) {
  const lx = pos[0], ly = pos[1];
  const hit = hitTest(node, lx, ly);
  if (!hit) return false;
  const L = computeLayout(node);

  if (hit.type === "add_block")           { addBlock(node);                 return true; }
  if (hit.type === "bulk_clear_all")      {
    if (node._cwkBlocks.length === 0 || confirm("Remove all prompt blocks?")) {
      clearAllBlocks(node);
    }
    return true;
  }
  if (hit.type === "bulk_save_preset") {
    // anchor the popup just below the toolbar row
    const bulkY = getBulkRowY(node);
    const sc = c2s(node, PAD, bulkY + BULK_ROW_H + 2, 0, 0);
    openSavePresetOverlay(node, sc.x, sc.y);
    return true;
  }
  if (hit.type === "bulk_load_preset") {
    const bulkY = getBulkRowY(node);
    const sc = c2s(node, PAD, bulkY + BULK_ROW_H + 2, 0, 0);
    openLoadPresetOverlay(node, sc.x, sc.y);
    return true;
  }
  if (hit.type === "bulk_disable_all")    { disableAllBlocks(node);         return true; }
  if (hit.type === "bulk_enable_all")     { enableAllBlocks(node);          return true; }
  if (hit.type === "bulk_invert")         { invertBlocks(node);             return true; }
  if (hit.type === "anim_preview_toggle") { toggleAnimPreview(node);        return true; }
  if (hit.type === "dup_block")    { dupBlock(node, hit.blockIdx);   return true; }
  if (hit.type === "remove_block")  { removeBlock(node,  hit.blockIdx); return true; }
  if (hit.type === "toggle_block")  { toggleBlock(node,  hit.blockIdx); return true; }
  if (hit.type === "drag_handle") {
    closeAllOverlays();
    node._cwkDrag = { blockIdx: hit.blockIdx, startLx: lx, startLy: ly, currentLx: lx, currentLy: ly };
    app.canvas.canvas.style.cursor = "grabbing";
    return true;
  }
  if (hit.type === "prompt") {
    openPromptEditor(node, hit.blockIdx, t => setPrompt(node, hit.blockIdx, t));
    return true;
  }
  if (hit.type === "dur_left")  { setDuration(node, hit.blockIdx, (node._cwkBlocks[hit.blockIdx].duration ?? 2.0) - 0.5); return true; }
  if (hit.type === "dur_right") { setDuration(node, hit.blockIdx, (node._cwkBlocks[hit.blockIdx].duration ?? 2.0) + 0.5); return true; }
  if (hit.type === "dur_center") {
    const bi = hit.blockIdx, dur = node._cwkBlocks[bi].duration ?? 2.0, bl = L.blockLayouts.find(b => b.idx === bi);
    if (!bl) return true;
    const durX = bl.bx + INNER_PAD;
    const durW = bl.blockW / 2 - INNER_PAD;
    const labelW = 30;
    const vx = durX + labelW, vw = durW - labelW - 2;
    const sc = c2s(node, vx, bl.durY + 2, vw, CTRL_ROW_H - 4);
    openNumberEditor(node, sc.x, sc.y, sc.w, sc.h, dur, 0.1, 0.1, 9999, v => setDuration(node, bi, v));
    return true;
  }
  if (hit.type === "seed_left")  { randomizeBlockSeed(node, hit.blockIdx); return true; }
  if (hit.type === "seed_right") { randomizeBlockSeed(node, hit.blockIdx); return true; }
  if (hit.type === "seed_randomize") { randomizeBlockSeed(node, hit.blockIdx); return true; }
  if (hit.type === "seed_new_fixed") { newFixedSeed(node, hit.blockIdx); return true; }
  if (hit.type === "seed_center") {
    const bi = hit.blockIdx, seed = node._cwkBlocks[bi].seed ?? 0, bl = L.blockLayouts.find(b => b.idx === bi);
    if (!bl) return true;
    const seedX = bl.bx + bl.blockW / 2;
    const seedW = bl.blockW / 2 - INNER_PAD;
    const labelW = 24;
    const ctrlW = seedW - labelW - BTN_W * 2 - BTN_GAP * 2 - 4;
    const vx = seedX + labelW;
    const sc = c2s(node, vx, bl.seedY + 2, ctrlW, CTRL_ROW_H - 4);
    openNumberEditor(node, sc.x, sc.y, sc.w, sc.h, seed, 1, 0, 0x3FFFFFFFFFFFFFF, v => setSeed(node, bi, v));
    return true;
  }
  if (hit.type === "lora_w_left")  { setLoraWeight(node, hit.blockIdx, hit.loraIdx, hit.stack, (getStack(node, hit.blockIdx, hit.stack)[hit.loraIdx].weight ?? 1.0) - 0.05); return true; }
  if (hit.type === "lora_w_right") { setLoraWeight(node, hit.blockIdx, hit.loraIdx, hit.stack, (getStack(node, hit.blockIdx, hit.stack)[hit.loraIdx].weight ?? 1.0) + 0.05); return true; }
  if (hit.type === "lora_w_center") {
    const { blockIdx: bi, loraIdx: li, stack: st } = hit;
    const curW = getStack(node, bi, st)[li].weight ?? 1.0, bl = L.blockLayouts.find(b => b.idx === bi);
    if (!bl) return true;
    const lr = (st === "high" ? bl.highLoraRows : bl.lowLoraRows).find(r => r.idx === li);
    if (!lr) return true;
    const wCtrlW = 60;
    const loraX = st === "high" ? bl.bx + INNER_PAD : bl.bx + bl.blockW / 2;
    const loraW = bl.blockW / 2 - INNER_PAD;
    const rmX = loraX + loraW - 2 - BTN_W;
    const wCtrlX = rmX - wCtrlW - 2;
    const sc = c2s(node, wCtrlX, lr.y + 1, wCtrlW, LORA_ROW_H - 2);
    openNumberEditor(node, sc.x, sc.y, sc.w, sc.h, curW, 0.01, 0, 10, v => setLoraWeight(node, bi, li, st, v));
    return true;
  }
  if (hit.type === "lora_name") {
    const { blockIdx: bi, loraIdx: li, stack: st } = hit, bl = L.blockLayouts.find(b => b.idx === bi);
    if (!bl) return true;
    const lr = (st === "high" ? bl.highLoraRows : bl.lowLoraRows).find(r => r.idx === li);
    if (!lr) return true;
    const wCtrlW = 60;
    const loraX = st === "high" ? bl.bx + INNER_PAD : bl.bx + bl.blockW / 2;
    const loraW = bl.blockW / 2 - INNER_PAD;
    const rmX = loraX + loraW - 2 - BTN_W;
    const wCtrlX = rmX - wCtrlW - 2;
    const nameX = loraX + 2, nameW = wCtrlX - nameX - 2;
    const sc = c2s(node, nameX, lr.y + 1, nameW, LORA_ROW_H - 2);
    openLoraDropdown(node, bi, li, st, sc, name => setLoraName(node, bi, li, st, name));
    return true;
  }
  if (hit.type === "remove_lora") { removeLora(node, hit.blockIdx, hit.loraIdx, hit.stack); return true; }
  if (hit.type === "add_lora")    { addLora(node, hit.blockIdx, hit.stack);                 return true; }
  return false;
}

// ── Loop continuation listener ────────────────────────────────────────────────
api.addEventListener("cwk_wan22_loop_continue", () => {
  console.log("[CWK Wan22] Loop continue signal received — re-queuing…");
  setTimeout(() => app.queuePrompt(0, 1), 150);
});

// ── Active-clip highlight listener ────────────────────────────────────────────
// Receives clip_index (0-based) from LoopOpen while running, -1 when done.
api.addEventListener("cwk_wan22_clip_active", (e) => {
  const idx = e.detail?.clip_index ?? -1;
  for (const node of app.graph._nodes ?? []) {
    if (node.type === NODE_TYPE) {
      node._cwkActiveClip = idx >= 0 ? idx : null;
    }
  }
  app.canvas.setDirty(true, false);
});

// ── Extension — Prompt Composer ───────────────────────────────────────────────
app.registerExtension({
  name: "CWK.Wan22PromptComposer",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      injectStyles();
      this._cwkBlocks = []; this._cwkHover = null; this._cwkDrag = null; this._cwkAnimPreview = null; this._cwkActiveClip = null;
      syncAnimPreview(this);
      this.color = NODE_COLOR; this.bgcolor = NODE_BGCOLOR;

      const hideWidgets = () => {
        for (const w of this.widgets ?? []) { w.type = "hidden"; w.hidden = true; w.computeSize = () => [0, -4]; }
        this.size[0] = NODE_MIN_W;
        this.size[1] = calcNodeHeight(this);
        app.canvas.setDirty(true, true);
      };
      hideWidgets(); setTimeout(hideWidgets, 0); setTimeout(hideWidgets, 100);

      this.onDrawForeground = ctx => drawNode(this, ctx);
      this.onResize = function () {
        this.size[0] = Math.max(NODE_MIN_W, this.size[0]);
        this.size[1] = calcNodeHeight(this);
      };

      this.onMouseDown = (e, pos) => {
        if (this._cwkDrag) return false;
        return handleMouseDown(this, pos);
      };

      this.onMouseMove = (e, pos) => {
        const [lx, ly] = pos;
        if (this._cwkDrag) {
          this._cwkDrag.currentLx = lx;
          this._cwkDrag.currentLy = ly;
          app.canvas.setDirty(true, false);
          return;
        }
        const hit = hitTest(this, lx, ly);
        if (hit?.type === "drag_handle") app.canvas.canvas.style.cursor = "grab";
        else if (hit)                    app.canvas.canvas.style.cursor = "default";
        if (JSON.stringify(this._cwkHover) !== JSON.stringify(hit ?? null)) {
          this._cwkHover = hit ?? null;
          app.canvas.setDirty(true, false);
        }
      };

      this.onMouseUp = (e, pos) => {
        if (!this._cwkDrag) return false;
        const { blockIdx, startLx, startLy, currentLx, currentLy } = this._cwkDrag;
        const targetIdx = computeDragTarget(this, blockIdx, currentLx - startLx, currentLy - startLy);
        
        this._cwkDrag = null;
        app.canvas.canvas.style.cursor = "";
        
        if (targetIdx !== blockIdx) {
          applyDrag(this, blockIdx, targetIdx);
          serialize(this);
          const blocksCount = this._cwkBlocks?.length ?? 0;
          this.size[0] = Math.max(NODE_MIN_W, this.size[0]);
          this.size[1] = calcNodeHeight(this);
        }
        
        app.canvas.setDirty(true, true);
        return true;
      };

      this.onMouseLeave = () => {
        if (this._cwkDrag) {
          this._cwkDrag = null;
          app.canvas.canvas.style.cursor = "";
        }
        if (this._cwkHover !== null) { this._cwkHover = null; }
        app.canvas.setDirty(true, false);
      };
    };

    nodeType.prototype.onConfigure = function () {
      setTimeout(() => {
        deserialize(this);
        for (const b of this._cwkBlocks) {
          if (!b.loras_high && b.loras) { b.loras_high = b.loras; delete b.loras; }
          if (!b.loras_high) b.loras_high = [];
          if (!b.loras_low)  b.loras_low  = [];
          if (b.seed === undefined) b.seed = Math.floor(Math.random() * 0x3FFFFFFFFFFFFFF);
          if (b.disabled === undefined) b.disabled = false;
        }
        const blocksCount = this._cwkBlocks?.length ?? 0;
        this.size[0] = calcNodeWidth(this, blocksCount);
        this.size[1] = calcNodeHeight(this);
        for (const w of this.widgets ?? []) { w.type = "hidden"; w.hidden = true; w.computeSize = () => [0, -4]; }
        syncAnimPreview(this);
        app.canvas.setDirty(true, true);
      }, 0);
    };
  },
});

// ── Extension — Pipeline Splitter ────────────────────────────────────────────
app.registerExtension({
  name: "CWK.Wan22PipelineSplitter",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== SPLIT_TYPE) return;
    nodeType.prototype.onNodeCreated = function () {
      this.color = NODE_COLOR; this.bgcolor = NODE_BGCOLOR;
    };
  },
});

// ── Extension — LoRA Applier ──────────────────────────────────────────────────
app.registerExtension({
  name: "CWK.Wan22LoraApplier",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== LORA_APPL_TYPE) return;
    nodeType.prototype.onNodeCreated = function () {
      this.color = NODE_COLOR; this.bgcolor = NODE_BGCOLOR;
    };
  },
});

// ── Extension — Loop Open ─────────────────────────────────────────────────────
app.registerExtension({
  name: "CWK.Wan22LoopOpen",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== LOOP_OPEN_TYPE) return;
    nodeType.prototype.onNodeCreated = function () {
      this.color = NODE_COLOR; this.bgcolor = NODE_BGCOLOR;
    };
  },
});

// ── Extension — Loop Close ────────────────────────────────────────────────────
app.registerExtension({
  name: "CWK.Wan22LoopClose",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== LOOP_CLOSE_TYPE) return;
    nodeType.prototype.onNodeCreated = function () {
      this.color = NODE_COLOR; this.bgcolor = NODE_BGCOLOR;
    };
  },
});