/**
 * CWK Batch Selector — size lock extension.
 *
 * The node must only be resized MANUALLY (corner drag). All programmatic
 * resizing is blocked:
 *   - node.setSizeForImage()  (stock frontend call when images arrive /
 *     when the selection is re-applied on Send)  → no-op
 *   - direct node.size / setSize changes (from ComfyUI or the selector's own
 *     JS)                                        → reverted by the watchdog
 * Manual corner-drags are detected via a pointer window (down on the node →
 * up); the size at pointer-up becomes the new pinned size. Preview images
 * then adapt themselves to the available space (letterboxed by the frontend).
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "CWKBatchSelector";

app.registerExtension({
  name: "CWK.BatchSelectorSizeLock",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origCreated?.apply(this, arguments);
      try { installSizeLock(this); } catch (e) { console.warn("[CWK BatchLock]", e); }
      return r;
    };
  },
});

function installSizeLock(node) {
  if (node._cwkSizeLock) return;
  node._cwkSizeLock = true;

  node._cwkPinned   = null;   // [w, h] — the user's chosen size
  node._cwkDragging = false;  // true while the user holds the pointer on this node

  // 1) stock "resize node to fit image" → no-op
  node.setSizeForImage = function () {};

  // 2) manual-resize window: pointerdown on the node → pointerup
  const canvasEl = app.canvas?.canvas;
  const onDown = e => {
    try {
      if (node._cwkPinned === null) return;
      let p = null;
      try { if (typeof app.canvas.convertEventToCanvas === "function") p = app.canvas.convertEventToCanvas(e); } catch {}
      if (!p || !Array.isArray(p) || p.length < 2) p = app.canvas.graph_mouse;
      if (!p) return;
      const inside = p[0] >= node.pos[0] && p[0] <= node.pos[0] + node.size[0]
                  && p[1] >= node.pos[1] && p[1] <= node.pos[1] + node.size[1];
      if (inside) node._cwkDragging = true;
    } catch {}
  };
  const onUp = () => {
    if (!node._cwkDragging) return;
    node._cwkDragging = false;
    node._cwkPinned = [node.size[0], node.size[1]];   // adopt the user's result
  };
  if (canvasEl) {
    canvasEl.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
  }

  // 3) pin the initial size once the node's own JS has done its first layout
  setTimeout(() => {
    if (node._cwkPinned === null) node._cwkPinned = [node.size[0], node.size[1]];
  }, 1000);

  // 4) watchdog: revert any other programmatic size change
  node._cwkSizeWatch = setInterval(() => {
    try {
      if (node._cwkDragging || node._cwkPinned === null) return;
      if (node.flags?.collapsed) return;
      const [w, h] = node._cwkPinned;
      if (node.size[0] !== w || node.size[1] !== h) {
        node.size[0] = w;
        node.size[1] = h;
        app.canvas?.setDirty?.(true, false);
      }
    } catch {}
  }, 100);

  // 5) cleanup
  const prevOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (node._cwkSizeWatch) { clearInterval(node._cwkSizeWatch); node._cwkSizeWatch = null; }
    if (canvasEl) {
      canvasEl.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    }
    prevOnRemoved?.apply(this, arguments);
  };
}
