/**
 * CWK Live Preview — ComfyUI frontend extension.
 * Receives live image updates via WebSocket and displays them on canvas.
 *
 * Video latents arrive as vertical FRAME STRIPS (all timesteps of the
 * current step stacked in one image, "frames" count in the payload).
 * The handler splits strips into per-frame canvases and ANIMATES them
 * (VHS-style: continuously cycling through the latest frame set).
 * Image workflows send "frames": 1 → behaves exactly like before.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── CWK Palette ───────────────────────────────────────────────────────
const C = {
  bg:         "#1a1f2e",
  bgFull:     "#141824",
  surface:    "#1e2335",
  border:     "#313552",
  text:       "#cdd6f4",
  textDim:    "#6c7086",
  textBlue:   "#89b4fa",
  hoverBg:    "#2a2f45",
  purple:     "#cba6f7",
  green:      "#a6e3a1",
};

const NODE_TYPE = "CWKLivePreview";
const NODE_COLOR = "#141824";
const NODE_BGCOLOR = "#1e2335";

const PREVIEW_MARGIN = 4;
const PREVIEW_TITLE_GAP = 20;
const MIN_NODE_HEIGHT = 260;

const ANIM_FPS = 8;   // VHS-like cycling speed through the frames

// ── Settings sync (unchanged) ─────────────────────────────────────────
const CWK_LIVE_PREVIEW_SETTING_KEY = "cwk.LivePreview.enabled";

async function _readLivePreviewSetting() {
  try {
    const sv = app.ui?.settings?.settingsValues;
    if (sv && CWK_LIVE_PREVIEW_SETTING_KEY in sv) return Boolean(sv[CWK_LIVE_PREVIEW_SETTING_KEY]);
  } catch { /**/ }
  try {
    const resp = await api.fetchApi(`/api/settings/${encodeURIComponent(CWK_LIVE_PREVIEW_SETTING_KEY)}`);
    if (resp.ok) { const val = await resp.json(); return val === true; }
  } catch { /**/ }
  return false;
}

async function _syncLivePreviewSetting() {
  const enabled = await _readLivePreviewSetting();
  try {
    await api.fetchApi("/cwk_live_preview/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  } catch (e) {
    console.warn("[CWK Live Preview] Failed to sync setting to backend:", e);
  }
}

// ── Strip splitting ────────────────────────────────────────────────────
/** Split a vertical frame strip into an array of per-frame canvases.
 *  Falls back to [image] when frames <= 1 or the geometry doesn't add up. */
function _splitStrip(img, frameCount) {
  if (!frameCount || frameCount <= 1 || img.naturalHeight < frameCount * 2) {
    return [img];
  }
  const fh = Math.floor(img.naturalHeight / frameCount);
  if (fh < 1) return [img];
  const frames = [];
  const w = img.naturalWidth;
  for (let i = 0; i < frameCount; i++) {
    // last frame absorbs any rounding remainder
    const h = (i === frameCount - 1) ? (img.naturalHeight - fh * i) : fh;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img, 0, fh * i, w, h, 0, 0, w, h);
    frames.push(cv);
  }
  return frames;
}

// ── Shared animation ticker ────────────────────────────────────────────
let _animNodes = new Set();
let _animActive = false;
let _animLast = 0;
let _animAccum = 0;

function _animTick(ts) {
  if (_animNodes.size === 0) { _animActive = false; return; }
  requestAnimationFrame(_animTick);
  const dt = ts - _animLast;
  _animLast = ts;
  _animAccum += dt;
  const interval = 1000 / ANIM_FPS;
  if (_animAccum < interval) return;
  _animAccum = 0;
  for (const node of _animNodes) {
    node._cwkAnimIndex = (node._cwkAnimIndex + 1) % node._cwkAnimFrames.length;
    node._cwkAnimAt = ts;                       // mark for redraw
  }
  try { app.canvas.setDirty(true, false); } catch { /**/ }
}

function _ensureTicker(node) {
  _animNodes.add(node);
  if (!_animActive) {
    _animActive = true;
    _animLast = performance.now();
    _animAccum = 0;
    requestAnimationFrame(_animTick);
  }
}

app.registerExtension({
  name: "cwk.live_preview",

  settings: [{
    id: CWK_LIVE_PREVIEW_SETTING_KEY,
    name: "CWK Live Preview: Enable forced preview",
    type: "boolean",
    defaultValue: false,
    category: ["CWK", "Live Preview", "Enable forced preview"],
    onChange: async (value) => {
      try {
        await api.fetchApi("/cwk_live_preview/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: value }),
        });
      } catch (e) {
        console.warn("[CWK Live Preview] Failed to sync setting to backend:", e);
      }
    },
  }],

  async setup() {
    _syncLivePreviewSetting();

    api.addEventListener("cwk_live_preview", (event) => {
      const { image, frames } = event.detail || {};
      if (!image) return;

      for (const node of app.graph._nodes) {
        if (node.comfyClass !== NODE_TYPE) continue;

        // The _cwkImgObj is our decode + frame-split workhorse:
        // the DOM widget img keeps showing the full strip (cheap), while
        // the canvas fallback animates the split frames.
        if (!node._cwkImgObj) node._cwkImgObj = new Image();
        node._cwkImgObj.onload = () => {
          const parts = _splitStrip(node._cwkImgObj, frames);
          if (parts.length > 1) {
            node._cwkAnimFrames = parts;
            node._cwkAnimIndex  = 0;
            _ensureTicker(node);               // VHS behaviour: keep animating
          } else {
            node._cwkAnimFrames = null;
          }
          app.canvas.setDirty(true, true);
        };
        node._cwkImgObj.src = image;

        if (node._cwkImgEl) node._cwkImgEl.src = image;
        node._cwkHasPreview = true;
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onDrawBackground = nodeType.prototype.onDrawBackground;

    nodeType.prototype.onNodeCreated = function () {
      const img = document.createElement("img");
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "contain";
      img.style.display = "block";
      img.style.pointerEvents = "none";
      img.style.background = "transparent";

      this.addCustomWidget({ hideOnZoom: false, element: img });

      this.size = this.size && this.size[1] >= MIN_NODE_HEIGHT ? this.size : [320, 320];
      this._cwkImgEl = img;
      this._cwkHasPreview = false;
      this._cwkAnimFrames = null;
      this._cwkAnimIndex  = 0;

      this.onDrawBackground = function (ctx) {
        onDrawBackground?.apply(this, arguments);
        if (this.flags?.collapsed) return;

        const margin = PREVIEW_MARGIN;
        const titleGap = PREVIEW_TITLE_GAP;
        const w = this.size[0] - margin * 2;
        const h = this.size[1] - margin * 2 - titleGap;
        if (w <= 0 || h <= 0) return;

        // Animated (video) mode: draw the current animation frame
        if (this._cwkAnimFrames && this._cwkAnimFrames.length) {
          const src = this._cwkAnimFrames[this._cwkAnimIndex % this._cwkAnimFrames.length];
          const iw = src.width, ih = src.height;
          const boxAspect = w / h, imgAspect = iw / ih;
          let drawW, drawH, offsetX, offsetY;
          if (imgAspect > boxAspect) { drawW = w; drawH = w / imgAspect; offsetX = 0; offsetY = (h - drawH) / 2; }
          else                       { drawH = h; drawW = h * imgAspect; offsetX = (w - drawW) / 2; offsetY = 0; }
          ctx.drawImage(src, margin + offsetX, margin + titleGap + offsetY, drawW, drawH);
          return;
        }

        const hasImage =
          this._cwkImgObj && this._cwkImgObj.complete && this._cwkImgObj.naturalWidth > 0;

        if (hasImage) {
          const im = this._cwkImgObj;
          const imgAspect = im.naturalWidth / im.naturalHeight;
          const boxAspect = w / h;
          let drawW, drawH, offsetX, offsetY;
          if (imgAspect > boxAspect) { drawW = w; drawH = w / imgAspect; offsetX = 0; offsetY = (h - drawH) / 2; }
          else                       { drawH = h; drawW = h * imgAspect; offsetX = (w - drawW) / 2; offsetY = 0; }
          ctx.drawImage(im, margin + offsetX, margin + titleGap + offsetY, drawW, drawH);
          return;
        }

        // No preview received yet
        ctx.save();
        ctx.fillStyle = "rgba(26, 31, 46, 0.6)";
        ctx.fillRect(margin, margin + titleGap, w, h);
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(margin + 0.5, margin + titleGap + 0.5, w - 1, h - 1);
        ctx.fillStyle = C.textDim;
        ctx.font = "12px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No preview yet", margin + w / 2, margin + titleGap + h / 2);
        ctx.restore();
      };
    };
  },

  async afterConfigureGraph() {
    for (const node of app.graph._nodes) {
      if (node.comfyClass !== NODE_TYPE) continue;
      node.color = NODE_COLOR;
      node.bgcolor = NODE_BGCOLOR;
      node.size = node.size && node.size[1] >= MIN_NODE_HEIGHT ? node.size : [320, 320];
      if (!node._cwkImgEl) {
        const img = document.createElement("img");
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "contain";
        img.style.display = "block";
        img.style.pointerEvents = "none";
        img.style.background = "transparent";
        node.addCustomWidget({ hideOnZoom: false, element: img });
        node._cwkImgEl = img;
        node._cwkHasPreview = false;
      }
    }
  },
});
