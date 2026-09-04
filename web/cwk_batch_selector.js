/**
 * CWK Batch Selector — ComfyUI frontend extension.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Constants ─────────────────────────────
const NODE_TYPE = "CWKBatchSelector";
const PAD = 10, ROW_H = 26, LABEL_W = 90, ARROW_W = 20;
const BTN_H = 28, BTN_GAP = 6, THUMB_GAP = 8;
const NODE_MIN_W = 320, NODE_MIN_H = 200;
const TITLE_H = () => LiteGraph.NODE_TITLE_HEIGHT ?? 30;
const SLOT_H  = () => LiteGraph.NODE_SLOT_HEIGHT ?? 20;

// CWK palette
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
  purple:     "#cba6f7",
  green:      "#a6e3a1",
  red:        "#f38ba8",
  yellow:     "#f9e2af",
};

const NODE_COLOR   = "#141824";
const NODE_BGCOLOR = "#1e2335";

const CANCEL     = "-3";
const REGENERATE = "-4";

// ── Per-node state ─────────────────────────
function initState(node) {
  if (node._cwkbs) return node._cwkbs;
  node._cwkbs = {
    urls:       [],
    images:     [],
    picked:     new Set(),
    batchSize:  0,
    waiting:    false,
    hoverIndex: -1,
    hoverBtn:   null,
    sizeSetByUser: false,
  };
  return node._cwkbs;
}

// ── Helpers ──
function getFullUrl(urlObj) {
  return api.apiURL(
    `/view?filename=${encodeURIComponent(urlObj.filename)}&type=${urlObj.type || "temp"}&subfolder=${urlObj.subfolder || ""}&r=${Math.random()}`
  );
}

function getW(node, name) {
  return node.widgets?.find(w => w.name === name);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function sendResponse(node, msg = {}) {
  const gw = getW(node, "graph_id");
  msg.graph_id = gw?.value || `${app.graph.id}` || `${node.id}`;
  if (!msg.special) {
    msg.selection = Array.from(node._cwkbs.picked);
  }
  const body = new FormData();
  body.append("response", JSON.stringify(msg));
  api.fetchApi("/cwk-batch-selector-message", { method: "POST", body });
  node._cwkbs.waiting = false;
  app.canvas.setDirty(true, true);
}

// ── Layout and Draw ────────────────────────
function getSlotsBottom(node) {
  const nIn  = node.inputs  ? node.inputs.length  : 0;
  const nOut = node.outputs ? node.outputs.length  : 0;
  return TITLE_H() + Math.max(nIn, nOut) * SLOT_H() + 6;
}

// Compute layout metrics
function getLayout(node) {
  const st = node._cwkbs;
  const nodeW = node.size[0];
  const nodeH = node.size[1];
  const availW = nodeW - PAD * 2;

  // ── Grid area ──
  const gridStartY = getSlotsBottom(node) + PAD;
  const nImages = st.urls.length;

  // ── Info bar ──
  const infoH = nImages > 0 ? 18 : 0;
  const infoY = gridStartY;
  const gridY = gridStartY + infoH + (nImages > 0 ? PAD / 2 : 0);

  // ── Bottom area ──
  const btnRowH = nImages > 0 ? BTN_H : 0;
  const waitH = st.waiting ? 20 : 0;
  const bottomReserved = btnRowH + (waitH > 0 ? PAD + waitH : 0) + PAD + 4;

  // ── Available space for image grid ──
  const availGridH = Math.max(40, nodeH - gridY - bottomReserved);

  // ── Find best columns to maximize thumb size ──
  let bestCols = 1;
  let bestThumbSize = 0;

  if (nImages > 0) {
    for (let tryC = 1; tryC <= nImages; tryC++) {
      const tryR = Math.ceil(nImages / tryC);

      // Max thumbnail width/height
      const maxTW = Math.floor((availW - (tryC - 1) * THUMB_GAP) / tryC);
      const maxTH = Math.floor((availGridH - (tryR - 1) * THUMB_GAP) / tryR);
      const thumbSize = Math.min(maxTW, maxTH);

      if (thumbSize > bestThumbSize) {
        bestThumbSize = thumbSize;
        bestCols = tryC;
      }
    }
  }

  const thumbSize = Math.max(40, bestThumbSize);
  const cols = bestCols;
  const gridRows = nImages > 0 ? Math.ceil(nImages / cols) : 0;
  const thumbW = thumbSize;
  const thumbH = thumbSize;
  const gridH = gridRows > 0 ? gridRows * (thumbH + THUMB_GAP) - THUMB_GAP : 0;

  const totalGridW = cols * thumbW + (cols - 1) * THUMB_GAP;
  const gridOffsetX = Math.max(0, Math.floor((availW - totalGridW) / 2));

  const btnRowY_afterGrid = gridY + (nImages > 0 ? gridH + PAD : 0);
  const btnRowY_pinBottom = nodeH - bottomReserved;
  const btnRowY = nImages > 0
    ? Math.max(btnRowY_afterGrid, btnRowY_pinBottom)
    : gridY;
  const naturalH = btnRowY_afterGrid + btnRowH + (waitH > 0 ? PAD + waitH : 0) + PAD;
  const effectiveH = Math.max(NODE_MIN_H, nodeH);

  return {
    gridY, infoY,
    cols, thumbW, thumbH,
    gridRows, gridH, availW,
    gridOffsetX,
    btnRowY, btnRowH,
    naturalH, effectiveH,
    nImages,
    waitH,
    bottomReserved,
  };
}

function calcNaturalHeight(node) {
  return getLayout(node).naturalH;
}

function drawNode(node, ctx) {
  const st = node._cwkbs;
  if (!st) return;

  const w = node.size[0];
  const h = node.size[1];
  const cornerR = LiteGraph.NODE_BORDER_RADIUS ?? 8;
  const layout = getLayout(node);

  ctx.save();
  // Use the helper instead of ctx.roundRect (not available in some Electron builds)
  roundRect(ctx, 0, 0, w, h, cornerR);
  ctx.clip();

  // Background
  ctx.fillStyle = C.bgFull;
  ctx.fillRect(0, 0, w, h);

  const contentY = getSlotsBottom(node);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, contentY, w, h - contentY);

  // ── If no images yet, show placeholder
  if (st.urls.length === 0) {
    ctx.fillStyle = C.textDim;
    ctx.font = "12px Inter,system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Awaiting batch images\u2026", w / 2, layout.gridY + 30);
    ctx.restore();
    return;
  }

  // ── Info bar ──
  ctx.fillStyle = C.textDim;
  ctx.font = "11px Inter,system-ui,sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`${st.batchSize} images`, PAD, layout.infoY + 9);

  ctx.fillStyle = C.purple;
  ctx.textAlign = "right";
  ctx.fillText(`${st.picked.size} selected`, PAD + layout.availW, layout.infoY + 9);

  // ── Image grid ──
  const { cols, thumbW, thumbH } = layout;
  for (let i = 0; i < st.urls.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx = PAD + layout.gridOffsetX + col * (thumbW + THUMB_GAP);
    const ty = layout.gridY + row * (thumbH + THUMB_GAP);
    const isSelected = st.picked.has(`${i}`);
    const isHover = st.hoverIndex === i;

    // Clip to visible area (don't draw if below node bottom)
    if (ty > h) continue;
    if (ty + thumbH < layout.gridY) continue;

    // Card background
    ctx.fillStyle = C.surface;
    roundRect(ctx, tx, ty, thumbW, thumbH, 6);
    ctx.fill();
    ctx.strokeStyle = isSelected ? C.purple : (isHover ? C.textBlue : C.border);
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.stroke();

    // Image
    const img = st.images[i];
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, tx, ty, thumbW, thumbH, 6);
      ctx.clip();
      const ir = img.naturalWidth / img.naturalHeight;
      const tr = thumbW / thumbH;
      let sw, sh, sx, sy;
      if (ir > tr) { sh = img.naturalHeight; sw = sh * tr; sx = (img.naturalWidth - sw) / 2; sy = 0; }
      else         { sw = img.naturalWidth;  sh = sw / tr;  sy = (img.naturalHeight - sh) / 2; sx = 0; }
      ctx.drawImage(img, sx, sy, sw, sh, tx, ty, thumbW, thumbH);
      ctx.restore();
    } else {
      ctx.fillStyle = C.textDim;
      ctx.font = "24px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u{1F5BC}", tx + thumbW / 2, ty + thumbH / 2);
    }

    // Selection tick (top-right)
    const tickR = 11;
    const tickX = tx + thumbW - tickR - 4;
    const tickY2 = ty + tickR + 4;
    ctx.beginPath();
    ctx.arc(tickX, tickY2, tickR, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? C.purple : "rgba(20,24,36,.75)";
    ctx.fill();
    ctx.strokeStyle = isSelected ? C.purple : C.border;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (isSelected) {
      ctx.fillStyle = "#1e1e2e";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("\u2713", tickX, tickY2 + 1);
    }

    // Index badge (top-left)
    const badge = `#${i}`;
    ctx.font = "bold 9px Inter,system-ui,sans-serif";
    const bw = ctx.measureText(badge).width + 8;
    ctx.fillStyle = "rgba(20,24,36,.8)";
    roundRect(ctx, tx + 4, ty + 4, bw, 16, 3);
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.textBlue;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(badge, tx + 8, ty + 12);
  }

  // ── Button row ────────────────────────────────────────────────
  if (st.urls.length > 0) {
    const buttons = [
      { id: "select_all", label: "Select All",
        bg: C.border, text: C.text, hoverBg: C.hoverBg },
      { id: "regen", label: "\u{1F504} Re-Generate",
        bg: C.textBlue, text: "#1e1e2e", hoverBg: "#6ea0e0" },
      { id: "cancel", label: "\u2715 Cancel",
        bg: C.red, text: "#1e1e2e", hoverBg: "#d07090" },
      { id: "send", label: "\u2713 Send",
        bg: st.picked.size > 0 ? C.green : "#3a3f55",
        text: "#1e1e2e", hoverBg: st.picked.size > 0 ? "#80c880" : "#3a3f55" },
    ];

    ctx.font = "bold 11px Inter,system-ui,sans-serif";
    const btnWidths = buttons.map(b => ctx.measureText(b.label).width + 20);
    const totalBtnW = btnWidths.reduce((a, b) => a + b, 0) + (buttons.length - 1) * BTN_GAP;
    let bx = PAD + (layout.availW - totalBtnW) / 2;

    node._cwkbs_buttons = [];

    buttons.forEach((b, bi) => {
      const bw = btnWidths[bi];
      const isHov2 = st.hoverBtn === b.id;

      ctx.fillStyle = isHov2 ? b.hoverBg : b.bg;
      roundRect(ctx, bx, layout.btnRowY, bw, BTN_H, 5);
      ctx.fill();

      ctx.fillStyle = b.text;
      ctx.font = "bold 11px Inter,system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.label, bx + bw / 2, layout.btnRowY + BTN_H / 2);

      node._cwkbs_buttons.push({ id: b.id, x: bx, y: layout.btnRowY, w: bw, h: BTN_H });
      bx += bw + BTN_GAP;
    });

    // Waiting indicator
    if (st.waiting) {
      ctx.fillStyle = C.yellow;
      ctx.font = "bold 11px Inter,system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        "\u23F3 Waiting for selection\u2026",
        w / 2, layout.btnRowY + BTN_H + 12
      );
    }
  }

  // ── Resize handle ──
  ctx.fillStyle = "#45475a";
  ctx.beginPath();
  ctx.moveTo(w, h);
  ctx.lineTo(w - 18, h);
  ctx.lineTo(w, h - 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.textBlue;
  ctx.beginPath();
  ctx.moveTo(w - 1, h - 1);
  ctx.lineTo(w - 13, h - 1);
  ctx.lineTo(w - 1, h - 13);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ── Hit testing ──────────────────────────────────────────────
function hitTestImage(node, lx, ly) {
  const st = node._cwkbs;
  if (!st || st.urls.length === 0) return -1;
  const layout = getLayout(node);
  for (let i = 0; i < st.urls.length; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const tx = PAD + (layout.gridOffsetX || 0) + col * (layout.thumbW + THUMB_GAP);
    const ty = layout.gridY + row * (layout.thumbH + THUMB_GAP);
    if (lx >= tx && lx <= tx + layout.thumbW && ly >= ty && ly <= ty + layout.thumbH) {
      return i;
    }
  }
  return -1;
}

function hitTestButton(node, lx, ly) {
  if (!node._cwkbs_buttons) return null;
  for (const btn of node._cwkbs_buttons) {
    if (lx >= btn.x && lx <= btn.x + btn.w && ly >= btn.y && ly <= btn.y + btn.h) {
      return btn.id;
    }
  }
  return null;
}

function hitTestResize(node, lx, ly) {
  const w = node.size[0];
  const h = node.size[1];
  return (lx >= w - 20 && ly >= h - 20);
}

// ── Zoom overlay ────────────────────────────────────────────────────────────

let zoomOverlay = null;
let zoomState = { urls: [], index: 0, node: null };

function ensureZoomOverlay() {
  if (zoomOverlay) return;
  const s = document.createElement("style");
  s.textContent = `
    #cwk-bs-zoom { position:fixed; inset:0; z-index:10001; background:rgba(0,0,0,.88);
      display:none; align-items:center; justify-content:center; cursor:zoom-out; }
    #cwk-bs-zoom.visible { display:flex; }
    #cwk-bs-zoom img { max-width:92vw; max-height:92vh; border-radius:8px;
      box-shadow:0 12px 48px rgba(0,0,0,.6); }
    .cwk-bz-nav { position:absolute; top:50%; transform:translateY(-50%);
      background:rgba(20,24,36,.8); border:1px solid ${C.border}; border-radius:8px;
      padding:12px 16px; cursor:pointer; color:${C.text}; font-size:24px;
      transition:background .15s; z-index:10002; user-select:none; font-family:sans-serif; }
    .cwk-bz-nav:hover { background:rgba(137,180,250,.25); }
    .cwk-bz-nav.prev { left:16px; }
    .cwk-bz-nav.next { right:16px; }
    .cwk-bz-counter { position:absolute; bottom:20px; left:50%; transform:translateX(-50%);
      background:rgba(20,24,36,.8); border:1px solid ${C.border}; border-radius:6px;
      padding:4px 14px; font-size:13px; color:${C.text}; font-weight:600;
      font-family:Inter,system-ui,sans-serif; }
  `;
  document.head.appendChild(s);

  zoomOverlay = document.createElement("div");
  zoomOverlay.id = "cwk-bs-zoom";
  zoomOverlay.innerHTML = `
    <span class="cwk-bz-nav prev" id="cwk-bz-prev">\u25C0</span>
    <img id="cwk-bz-img" />
    <span class="cwk-bz-nav next" id="cwk-bz-next">\u25B6</span>
    <span class="cwk-bz-counter" id="cwk-bz-counter"></span>
  `;
  document.body.appendChild(zoomOverlay);

  zoomOverlay.addEventListener("click", (e) => { if (e.target === zoomOverlay) closeZoom(); });
  document.getElementById("cwk-bz-prev").addEventListener("click", (e) => { e.stopPropagation(); zoomNav(-1); });
  document.getElementById("cwk-bz-next").addEventListener("click", (e) => { e.stopPropagation(); zoomNav(1); });
  document.getElementById("cwk-bz-img").addEventListener("click", (e) => { e.stopPropagation(); closeZoom(); });

  document.addEventListener("keydown", (e) => {
    if (!zoomOverlay.classList.contains("visible")) return;
    if (e.key === "Escape")     { closeZoom(); e.preventDefault(); }
    if (e.key === "ArrowLeft")  { zoomNav(-1); e.preventDefault(); }
    if (e.key === "ArrowRight") { zoomNav(1);  e.preventDefault(); }
  });
}

function openZoom(node, idx) {
  ensureZoomOverlay();
  zoomState.urls = node._cwkbs.urls;
  zoomState.index = idx;
  zoomState.node = node;
  renderZoom();
  zoomOverlay.classList.add("visible");
}
function closeZoom() { zoomOverlay?.classList.remove("visible"); }
function renderZoom() {
  document.getElementById("cwk-bz-img").src = getFullUrl(zoomState.urls[zoomState.index]);
  document.getElementById("cwk-bz-counter").textContent = `${zoomState.index + 1} / ${zoomState.urls.length}`;
}
function zoomNav(dir) {
  const len = zoomState.urls.length;
  zoomState.index = (zoomState.index + dir + len) % len;
  renderZoom();
}

// ── Attach behaviors to the node ─────────────────────────────
function attachBehaviors(node) {
  initState(node);
  node.color   = NODE_COLOR;
  node.bgcolor = NODE_BGCOLOR;

  node.resizable = true;
  node.onDrawForeground = function (ctx) { drawNode(this, ctx); };

  node.onResize = function (size) {
    size[0] = Math.max(NODE_MIN_W, size[0]);
    size[1] = Math.max(NODE_MIN_H, size[1]);
    if (this._cwkbs) this._cwkbs.sizeSetByUser = true;
  };

  // Mouse down
  node.onMouseDown = function (e, pos) {
    const st = this._cwkbs;
    if (!st) return false;
    const [lx, ly] = pos;

    // Buttons
    const btnId = hitTestButton(this, lx, ly);
    if (btnId) {
      if (btnId === "select_all") {
        if (st.picked.size >= st.urls.length) st.picked.clear();
        else for (let i = 0; i < st.urls.length; i++) st.picked.add(`${i}`);
        app.canvas.setDirty(true, false);
        return true;
      }
      if (btnId === "send" && st.picked.size > 0) {
        sendResponse(this);
        return true;
      }
      if (btnId === "cancel") {
        sendResponse(this, { special: CANCEL });
        return true;
      }
      if (btnId === "regen") {
        // 1) Tell backend to abort the current run.
        sendResponse(this, { special: REGENERATE });
        // 2) Re-queue the prompt so upstream nodes execute again.
        //    Tiny delay lets the interrupt propagate first.
        setTimeout(() => {
          try { app.queuePrompt(0, 1); }
          catch (err) { console.warn("[CWK Batch Selector] regen queue failed:", err); }
        }, 150);
        return true;
      }
      return true;
    }

    // Image clicks
    const idx = hitTestImage(this, lx, ly);
    if (idx >= 0) {
      const key = `${idx}`;
      if (st.picked.has(key)) st.picked.delete(key);
      else st.picked.add(key);
      app.canvas.setDirty(true, false);
      return true;
    }

    // Empty area — let LiteGraph handle drag/marquee/etc.
    return false;
  };

  // Double-click for zoom
  node.onDblClick = function (e, pos) {
    const st = this._cwkbs;
    if (!st || st.urls.length === 0) return false;
    const idx = hitTestImage(this, pos[0], pos[1]);
    if (idx >= 0) { openZoom(this, idx); return true; }
    return false;
  };

  // Mouse move for hover
  node.onMouseMove = function (e, pos) {
    const st = this._cwkbs;
    if (!st) return;
    const [lx, ly] = pos;

    const newBtn = hitTestButton(this, lx, ly);
    if (newBtn !== st.hoverBtn) { st.hoverBtn = newBtn; app.canvas.setDirty(true, false); }

    const newImg = hitTestImage(this, lx, ly);
    if (newImg !== st.hoverIndex) { st.hoverIndex = newImg; app.canvas.setDirty(true, false); }
  };

  node.onMouseLeave = function () {
    const st = this._cwkbs;
    if (!st) return;
    st.hoverIndex = -1;
    st.hoverBtn = null;
    app.canvas.setDirty(true, false);
  };
}

// ── ComfyUI Extension ─────────────────────
app.registerExtension({
  name: "cwk.batch_selector",

  setup() {
    // Image payload from Python backend
    api.addEventListener("cwk-batch-selector-images", (message) => {
      const d = message.detail;
      if (!d.urls) return;

      const uid = `${d.uid}`;
      let targetNode = null;

      for (const n of app.graph._nodes) {
        if (n.type !== NODE_TYPE) continue;
        if (`${n.id}` === uid) { targetNode = n; break; }
        const uidParts = uid.split(":");
        if (`${n.id}` === uidParts[uidParts.length - 1]) { targetNode = n; break; }
      }
      if (!targetNode) {
        for (const n of app.graph._nodes) {
          if (n.type === NODE_TYPE) { targetNode = n; break; }
        }
      }
      if (!targetNode) return;

      const st = initState(targetNode);
      st.urls = d.urls;
      st.batchSize = d.batch_size || d.urls.length;
      st.picked.clear();
      st.waiting = true;
      st.hoverIndex = -1;

      // Load images
      st.images = [];
      d.urls.forEach((urlObj, i) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => { app.canvas.setDirty(true, false); };
        img.src = getFullUrl(urlObj);
        st.images[i] = img;
      });

      // Enforce minimum width
      targetNode.size[0] = Math.max(NODE_MIN_W, targetNode.size[0]);
      // Auto-grow height only if needed
      const natural = calcNaturalHeight(targetNode);
      if (targetNode.size[1] < natural) {
        targetNode.size[1] = natural;
      }
      app.canvas.setDirty(true, true);
    });

    // Tick — kept only as a keepalive; no UI side-effects.
    api.addEventListener("cwk-batch-selector-tick", (_message) => {
      // No-op. Backend pings every 0.5s while waiting; we don't display it.
    });

    // Execution interrupted
    api.addEventListener("execution_interrupted", () => {
      for (const n of app.graph._nodes) {
        if (n.type === NODE_TYPE && n._cwkbs) {
          n._cwkbs.waiting = false;
          app.canvas.setDirty(true, true);
        }
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    nodeType.prototype.onNodeCreated = function () {
      const node = this;
      attachBehaviors(node);

      // Hide all standard widgets
      setTimeout(() => {
        for (const w of node.widgets ?? []) {
          w.type = "hidden";
          w.hidden = true;
          w.computeSize = () => [0, -4];
        }
        const gw = getW(node, "graph_id");
        if (gw) gw.value = `${app.graph.id}` || `${node.id}`;
        if (node.size[0] < NODE_MIN_W) node.size[0] = NODE_MIN_W;
        if (node.size[1] < NODE_MIN_H) node.size[1] = Math.max(NODE_MIN_H, calcNaturalHeight(node));
        app.canvas.setDirty(true, true);
      }, 100);
    };
  },

  afterConfigureGraph() {
    // Restore behaviors on nodes loaded from saved workflow
    setTimeout(() => {
      for (const node of app.graph._nodes) {
        if (node.type !== NODE_TYPE) continue;

        attachBehaviors(node);

        // Hide widgets
        for (const w of node.widgets ?? []) {
          w.type = "hidden"; w.hidden = true;
          w.computeSize = () => [0, -4];
        }
        const gw = getW(node, "graph_id");
        if (gw) gw.value = `${app.graph.id}` || `${node.id}`;

        // Enforce minimums but KEEP the user's saved size
        node.size[0] = Math.max(NODE_MIN_W, node.size[0]);
        node.size[1] = Math.max(NODE_MIN_H, node.size[1]);
      }
    }, 1000);
  },
});