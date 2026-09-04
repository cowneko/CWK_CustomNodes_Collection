/**
 * CWK Live Preview — ComfyUI frontend extension.
 * Receives live image updates via WebSocket and displays them on canvas.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── CWK Palette (matches existing nodes) ──────────────────────────────
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

app.registerExtension({
  name: "cwk.live_preview",

  async setup() {
    // Listen for live preview image updates from backend
    api.addEventListener("cwk_live_preview", (event) => {
      const { image } = event.detail || {};
      if (!image) return;

      for (const node of app.graph._nodes) {
        if (node.comfyClass === CWKLivePreview) {
          node._cwkHasPreview = true;
          if (node._cwkImgEl) node._cwkImgEl.src = image;
          // Keep a plain Image object too, for canvas fallback drawing
          if (!node._cwkImgObj) node._cwkImgObj = new Image();
          node._cwkImgObj.onload = () => { app.canvas.setDirty(true, false); };
          node._cwkImgObj.src = image;
        }
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onDrawBackground = nodeType.prototype.onDrawBackground;

    nodeType.prototype.onNodeCreated = function () {
      // Create a DOM image element for the widget
      const img = document.createElement("img");
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "contain";
      img.style.display = "block";
      img.style.pointerEvents = "none";
      img.style.background = "transparent";

      // hideOnZoom: false keeps the DOM widget visible at any zoom level
      // instead of the default behavior (hidden below ~0.5 scale).
      const widget = this.addCustomWidget({
        hideOnZoom: false,
        element: img,
      });

      this.size = this.size && this.size[1] >= 260 ? this.size : [320, 320];
      this._cwkImgEl = img;
      this._cwkHasPreview = false;

      // Canvas-level fallback: if the DOM widget's own CSS scaling ever
      // makes it unreadable/invisible at extreme zoom-out, also paint
      // the image directly to canvas.
      this.onDrawBackground = function (ctx) {
        onDrawBackground?.apply(this, arguments);
        if (this.flags?.collapsed) return;

        const margin = 4;
        const titleGap = 20; // leave room for title area
        const w = this.size[0] - margin * 2;
        const h = this.size[1] - margin * 2 - titleGap;
        if (w <= 0 || h <= 0) return;

        const hasImage =
          this._cwkImgObj && this._cwkImgObj.complete && this._cwkImgObj.naturalWidth > 0;

        if (hasImage) {
          ctx.drawImage(this._cwkImgObj, margin, margin + titleGap, w, h);
          return;
        }

        // No preview received yet — draw a placeholder box + label
        // matching CWK's color scheme.
        ctx.save();
        
        // Placeholder background
        ctx.fillStyle = "rgba(26, 31, 46, 0.6)";
        ctx.fillRect(margin, margin + titleGap, w, h);
        
        // Border
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(margin + 0.5, margin + titleGap + 0.5, w - 1, h - 1);

        // Placeholder text
        ctx.fillStyle = C.textDim;
        ctx.font = "12px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No preview yet", margin + w / 2, margin + titleGap + h / 2);
        
        ctx.restore();
      };
    };

    nodeType.prototype.onNodeCreated?.call(nodeType.prototype);
  },

  async afterConfigureGraph() {
    // Restore node colors and styles when loading from saved workflow
    for (const node of app.graph._nodes) {
      if (node.comfyClass !== NODE_TYPE) continue;
      
      node.color = NODE_COLOR;
      node.bgcolor = NODE_BGCOLOR;
      node.size = node.size && node.size[1] >= 260 ? node.size : [320, 320];
      
      if (!node._cwkImgEl) {
        const img = document.createElement("img");
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "contain";
        img.style.display = "block";
        img.style.pointerEvents = "none";
        img.style.background = "transparent";
        
        const widget = node.addCustomWidget({
          hideOnZoom: false,
          element: img,
        });
        
        node._cwkImgEl = img;
        node._cwkHasPreview = false;
      }
    }
  },
});