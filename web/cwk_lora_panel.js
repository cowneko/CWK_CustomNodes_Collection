/**
 * CWK LoRA Loader — LoraBrowserPanel.
 *
 * Mirrors the ModelBrowserPanel structure (drag/resize shell, thumbnail grid
 * with size slider, CivitAI fetch with SSE progress, footer with API-key
 * controls). Filters + favorites live in the top bar; the sidebar shows the
 * description, trigger words, editable Version / Base model, and custom
 * thumbnail + NSFW controls. "Load LorA" hands the selected LoRA back to the
 * calling node.
 */

import { injectStyles } from "./cwk_styles.js";
import { getBaseModelMatchers, OTHERS_MATCH } from "./cwk_base_models.js";

export const LORA_PANEL_ID = "cwk-lora-browser-panel";

const NSFW_R = 2;

// ─── Thumbnail size slider ───────────────────────────────────────────────────
const THUMB_KEY  = "cwk_lora_thumb_size";
const THUMB_MIN  = 64;
const THUMB_MAX  = 384;
const THUMB_STEP = 16;
const THUMB_GAP  = 10;
const THUMB_DEF  = 160;
const THUMB_AR_W = 2;
const THUMB_AR_H = 3;

const STATIC_BASE_MODEL_FILTERS = [
  { label: "All Types", match: null },
  { label: "Others",    match: OTHERS_MATCH },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" }, ...options,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${path}`);
  return res.json();
}

function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function makeDraggable(panel, handle, posKey) {
  let sx, sy, ol, ot;
  function _abs() {
    if (panel.style.transform) {
      const r = panel.getBoundingClientRect();
      panel.style.transform = "none";
      panel.style.left = r.left + "px";
      panel.style.top  = r.top  + "px";
    }
  }
  handle.addEventListener("mousedown", e => {
    if (e.target.closest(".cwk-close-btn")) return;
    e.preventDefault(); _abs();
    sx = e.clientX; sy = e.clientY;
    ol = parseFloat(panel.style.left) || 0;
    ot = parseFloat(panel.style.top)  || 0;
    handle.classList.add("dragging");
    const mv = ev => {
      panel.style.left = (ol + ev.clientX - sx) + "px";
      panel.style.top  = (ot + ev.clientY - sy) + "px";
    };
    const up = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("mousemove", mv);
      window.removeEventListener("mouseup", up);
      localStorage.setItem(posKey, JSON.stringify({
        x: parseFloat(panel.style.left),
        y: parseFloat(panel.style.top),
      }));
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
}

function isNsfwLora(l) {
  const c = l.civitai;
  if (!c) return false;
  if (c.nsfw_manual === true)  return true;
  if (c.nsfw_manual === false) return false;
  return (c.nsfw_level ?? 0) >= NSFW_R;
}

// ─── Shared trigger-word cache (used by the node widget preview) ─────────────

export const triggerCache = new Map();

export async function getTriggersFor(name) {
  if (triggerCache.has(name)) return triggerCache.get(name);
  let words = [];
  try {
    const res = await fetch(`/cwk/lora/trigger_words?lora=${encodeURIComponent(name)}`);
    if (res.ok) {
      const d = await res.json();
      words = Array.isArray(d.trigger_words) ? d.trigger_words : [];
    }
  } catch {}
  triggerCache.set(name, words);
  return words;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

export function injectLoraStyles() {
  if (document.getElementById("cwk-lora-styles")) return;
  injectStyles();  // base .cwk-* classes (cards, sidebar, footer, buttons…)
  const s = document.createElement("style");
  s.id = "cwk-lora-styles";
  s.textContent = `
    #cwkl-overlay { position:fixed; inset:0; background:rgba(0,0,0,.55);
      z-index:9998; display:none; }
    #cwkl-overlay.visible { display:block; }

    #${LORA_PANEL_ID} {
      position:fixed; top:5%; left:5%;
      width:min(90vw,1100px); height:min(88vh,780px);
      min-width:520px; min-height:400px;
      background:#141824; border:1px solid #2a2f45; border-radius:10px;
      display:none; flex-direction:column; z-index:9999; overflow:hidden;
      font-family:Inter,system-ui,sans-serif; color:#cdd6f4;
      box-shadow:0 24px 80px rgba(0,0,0,.7); box-sizing:border-box;
    }
    #${LORA_PANEL_ID}.visible { display:flex; }

    /* ── Top bar: filter + favorites ─────────────────────────────── */
    .cwk-search-bar .cwk-custom-select { width:170px; flex-shrink:0; }
    .cwk-search-bar .cwk-favorite-filter { flex-shrink:0; margin:0; }
    .cwk-search-bar .cwk-favorite-filter span { font-size:14px; }

    /* ── Sidebar description / trigger words ─────────────────────── */
    .cwk-lora-desc {
      max-height:200px; overflow-y:auto;
      font-size:12px; color:#cdd6f4; line-height:1.45;
      white-space:pre-wrap; word-break:break-word;
      background:#1e2335; border:1px solid #313552; border-radius:6px;
      padding:6px 8px;
    }
    .cwk-lora-desc::-webkit-scrollbar { width:5px; }
    .cwk-lora-desc::-webkit-scrollbar-thumb { background:#313552; border-radius:3px; }
    .cwk-lora-desc.empty { color:#6c7086; font-style:italic; border-style:dashed; }
    .cwk-lora-tags { display:flex; flex-wrap:wrap; gap:4px; }
    .cwk-lora-tag {
      padding:2px 7px; background:#1e2335; border:1px solid #313552;
      border-radius:4px; font-size:11px; color:#89b4fa; font-weight:600;
    }
    .cwk-lora-tag.custom { color:#a6e3a1; border-color:#3f5a45; }
    .cwk-lora-hint { font-size:11px; color:#6c7086; font-style:italic; }
    .cwk-source-badge {
      display:inline-block; padding:1px 7px; border-radius:4px;
      font-size:10px; font-weight:700; letter-spacing:.04em; margin-left:4px;
    }
    .cwk-source-badge.custom  { background:#1e2a20; color:#a6e3a1; border:1px solid #3f5a45; }
    .cwk-source-badge.civitai { background:#1a2035; color:#89b4fa; border:1px solid #313552; }
    .cwk-source-badge.none    { background:#1e2335; color:#6c7086; border:1px dashed #313552; }
    textarea.cwk-lora-edit {
      width:100%; box-sizing:border-box; min-height:70px; margin-top:4px;
      background:#1e2335; border:1px solid #313552; border-radius:6px;
      color:#cdd6f4; padding:6px 8px; font:12px Inter,system-ui,sans-serif;
      resize:vertical; outline:none;
    }
    textarea.cwk-lora-edit:focus { border-color:#89b4fa; }

    /* ── Thumbnail & NSFW section ────────────────────────────────── */
    .cwk-thumb-row { display:flex; gap:8px; align-items:flex-start; }
    .cwk-thumb-preview {
      width:72px; height:108px; object-fit:cover; border-radius:6px;
      border:1px solid #313552; background:#181d2e; flex-shrink:0;
    }
    .cwk-thumb-btns { display:flex; flex-direction:column; gap:5px; flex:1; min-width:0; }
    .cwk-thumb-btns .cwk-btn { font-size:11px; padding:4px 8px; }
    .cwk-nsfw-tick {
      display:flex; align-items:center; gap:6px; cursor:pointer;
      font-size:11px; color:#cdd6f4; user-select:none;
    }
    .cwk-nsfw-tick input { accent-color:#f38ba8; cursor:pointer; }

    .cwk-card-custom-badge {
      background:rgba(20,24,36,.8); border:1px solid #3f5a45; border-radius:4px;
      padding:1px 5px; font-size:10px; color:#a6e3a1; font-weight:700;
    }

    /* ── Node widget overlay (CWK LoRA Loader) ──────────────────── */
    .cwk-lora-overlay {
      position:fixed; left:0; top:0; z-index:100;
      transform-origin:0 0; display:none; pointer-events:auto;
    }
        /* native multiline widget of the LoRA node — hidden by the extension.
       !important beats the inline styles the frontend re-applies each frame. */
    .cwk-lora-dom-hidden { 
    display: none !important; 
    }
    .cwk-lora-widget {
      width:100%; height:100%; box-sizing:border-box;
      display:flex; flex-direction:column;
      background:#141824; border:none; border-radius:8px;   /* was: border:1px solid #2a2f45; */
      font:12px Inter,system-ui,sans-serif; color:#cdd6f4; overflow:hidden;
      user-select:none;
    }
    .cwkl-w-header {
      display:flex; align-items:center; gap:7px;
      padding:6px 9px; background:#141824;
      border-bottom:1px solid #2a2f45; flex-shrink:0;
    }
    .cwkl-w-header input[type=checkbox] { width:14px; height:14px; cursor:pointer; accent-color:#89b4fa; }
    .cwkl-w-title { font-size:12px; font-weight:700; color:#89b4fa; white-space:nowrap; }
    .cwkl-w-spacer { flex:1; }
    .cwkl-w-add, .cwkl-w-browser {
      background:#313552; color:#cdd6f4; border:none; border-radius:5px;
      padding:3px 10px; font:600 11px Inter,system-ui,sans-serif;
      cursor:pointer; transition:filter .15s; white-space:nowrap;
    }
    .cwkl-w-add:hover, .cwkl-w-browser:hover { filter:brightness(1.25); }
    .cwkl-w-rows { flex:1; overflow-y:auto; }
    .cwkl-w-rows::-webkit-scrollbar { width:5px; }
    .cwkl-w-rows::-webkit-scrollbar-thumb { background:#313552; border-radius:3px; }
    .cwkl-w-row {
      display:flex; align-items:center; gap:6px;
      padding:4px 8px; border-bottom:1px solid #20263a;
    }
    .cwkl-w-row:hover { background:#1a2035; }
    .cwkl-w-row.disabled .cwkl-w-select,
    .cwkl-w-row.disabled .cwkl-w-wval { opacity:.5; }
    .cwkl-w-row input[type=checkbox] { width:13px; height:13px; cursor:pointer; accent-color:#89b4fa; flex-shrink:0; }
    .cwkl-w-select {
      flex:1; min-width:50px; box-sizing:border-box;
      background:#1e2335; border:1px solid #313552; border-radius:5px;
      color:#cdd6f4; padding:2px 4px; font:12px Inter,system-ui,sans-serif;
      outline:none; cursor:pointer;
    }
    .cwkl-w-select:focus { border-color:#89b4fa; }
    .cwkl-w-info {
      background:none; border:none; cursor:pointer; padding:0 3px;
      color:#89b4fa; font-size:13px; line-height:1; flex-shrink:0; transition:color .15s;
    }
    .cwkl-w-info:hover { color:#cba6f7; }
    .cwkl-w-weight { width:70px; flex-shrink:0; accent-color:#89b4fa; cursor:pointer; }
    .cwkl-w-wval { min-width:32px; text-align:right; font-size:11px; color:#89b4fa; flex-shrink:0; }
    .cwkl-w-del {
      background:none; border:none; cursor:pointer; padding:0 3px;
      color:#6c7086; font-size:12px; line-height:1; flex-shrink:0; transition:color .15s;
    }
    .cwkl-w-del:hover { color:#f38ba8; }
    .cwkl-w-empty {
      flex:1; display:flex; align-items:center; justify-content:center;
      color:#6c7086; font-style:italic; font-size:11px; padding:10px; text-align:center;
    }
    .cwkl-w-footer {
      padding:4px 9px; background:#1a2035; border-top:1px solid #2a2f45;
      flex-shrink:0; max-height:40px; overflow:hidden;
    }
    .cwkl-w-trigger {
      display:block; font-size:10px; color:#6c7086;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
  `;
  document.head.appendChild(s);
}

// ─── LoraBrowserPanel ─────────────────────────────────────────────────────────

export class LoraBrowserPanel {
  constructor() {
    this._loras          = [];
    this._filtered       = [];
    this._selected       = null;
    this._editMode       = false;
    this._onLoadCallback = null;
    this._civitaiKey     = localStorage.getItem("cwk_civitai_key") || "";
    this._fetchAbort     = null;
    this._revealed       = JSON.parse(localStorage.getItem("cwk_lora_revealed") || "{}");
    this._filterMatch    = null;
    this._filterFavorite = false;
    this._thumbTarget = (() => {
      const v = Number(localStorage.getItem(THUMB_KEY));
      return Number.isFinite(v) ? Math.min(THUMB_MAX, Math.max(THUMB_MIN, v)) : THUMB_DEF;
    })();
    this._thumbObserver   = null;
    this._lastThumbUsable = -1;
    this._baseModelMatchers = STATIC_BASE_MODEL_FILTERS;
    this._baseModelFilters  = STATIC_BASE_MODEL_FILTERS;
    this._buildDOM();
    this._bindEvents();
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  _buildDOM() {
    this._overlay    = document.createElement("div");
    this._overlay.id = "cwkl-overlay";
    document.body.appendChild(this._overlay);

    this._panel    = document.createElement("div");
    this._panel.id = LORA_PANEL_ID;
    this._panel.innerHTML = `
      <div class="cwk-header" id="cwkl-drag-handle">
        <span style="font-size:18px;pointer-events:none">🧩</span>
        <h2>CWK LoRA Browser
          <span class="cwk-model-count" id="cwkl-total-count">0 loras</span>
        </h2>
        <button class="cwk-close-btn" id="cwkl-close-btn" title="Close">✕</button>
      </div>

      <div class="cwk-search-bar">
        <label for="cwkl-search">Search:</label>
        <input id="cwkl-search" type="text" placeholder="Filter by name…" autocomplete="off"/>
        <div class="cwk-custom-select">
          <button class="cwk-select-btn" id="cwkl-filter-type-btn">
            <span id="cwkl-filter-type-label">All Types</span>
            <span class="cwk-select-arrow">▾</span>
          </button>
          <div class="cwk-select-dropdown" id="cwkl-filter-type-menu">
            <div class="cwk-select-option active" data-idx="0">All Types</div>
          </div>
        </div>
        <label class="cwk-favorite-filter" title="Favorites only">
          <input type="checkbox" id="cwkl-filter-favorite"/>
          <span>⭐</span>
        </label>
        <span class="cwk-shown-count" id="cwkl-shown-count">0 shown</span>
      </div>

      <div class="cwk-body">
        <div class="cwk-grid-area" id="cwkl-grid"></div>

        <div class="cwk-sidebar" id="cwkl-sidebar">
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">LoRA name:</div>
            <div id="cwkl-lora-name" style="font-size:12px;color:#cdd6f4;word-break:break-all">—</div>
          </div>

          <div class="cwk-sidebar-row">
            <div class="cwk-sidebar-col">
              <div class="cwk-sidebar-title">Version:</div>
              <input class="cwk-sidebar-input" id="cwkl-version-edit"
                     placeholder="e.g. v1.0" title="Custom version (leave empty to use Civitai)"/>
            </div>
            <div class="cwk-sidebar-col">
              <div class="cwk-sidebar-title">Base Model:</div>
              <input class="cwk-sidebar-input" id="cwkl-base-edit" list="cwkl-base-list"
                     placeholder="e.g. SDXL 1.0" title="Custom base model (leave empty to use Civitai)"/>
            </div>
          </div>
          <datalist id="cwkl-base-list"></datalist>

          <hr class="cwk-sidebar-divider"/>

          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Description:
              <span id="cwkl-desc-source" class="cwk-source-badge none">no data</span>
            </div>
            <div id="cwkl-desc" class="cwk-lora-desc empty">—</div>
            <textarea id="cwkl-desc-edit" class="cwk-lora-edit" style="display:none"
              placeholder="Describe this LoRA… (leave empty to use the Civitai description)"></textarea>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Trigger Words:
              <span id="cwkl-trig-source" class="cwk-source-badge none">no data</span>
            </div>
            <div id="cwkl-triggers" class="cwk-lora-tags"></div>
            <textarea id="cwkl-triggers-edit" class="cwk-lora-edit" style="display:none"
              placeholder="Comma-separated trigger words… (leave empty to use Civitai values)"></textarea>
          </div>

          <hr class="cwk-sidebar-divider"/>

          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Thumbnail & NSFW:</div>
            <div class="cwk-thumb-row">
              <img id="cwkl-thumb-preview" class="cwk-thumb-preview" style="display:none" alt=""/>
              <div class="cwk-thumb-btns">
                <button class="cwk-btn cwk-btn-secondary" id="cwkl-thumb-set"
                  title="Upload a local image as custom thumbnail">🖼 Set…</button>
                <button class="cwk-btn cwk-btn-secondary" id="cwkl-thumb-reset"
                  title="Remove the custom thumbnail (falls back to Civitai)">✕ Reset</button>
                <label class="cwk-nsfw-tick" title="Blur this LoRA's thumbnail until revealed">
                  <input type="checkbox" id="cwkl-nsfw-toggle"/> NSFW
                </label>
              </div>
            </div>
          </div>

          <hr class="cwk-sidebar-divider"/>

          <div class="cwk-sidebar-section">
            <button class="cwk-btn cwk-btn-secondary" id="cwkl-refresh-btn" style="width:100%">
              🔄 Refresh Civitai Data
            </button>
          </div>
        </div>
      </div>

      <div class="cwk-footer">
        <div class="cwk-api-key-area">
          <span class="cwk-api-key-label" id="cwkl-api-key-label"
            title="Click to set CivitAI API Key">🔑 CivitAI API Key</span>
          <button class="cwk-icon-btn" id="cwkl-validate-key-btn" title="Test key">✓</button>
          <button class="cwk-icon-btn" id="cwkl-clear-cache-btn"  title="Clear LoRA cache">🗑</button>
        </div>
        <div class="cwk-fetch-wrap">
          <button class="cwk-btn cwk-btn-secondary" id="cwkl-fetch-btn">
            Fetch Thumbnails/Infos
          </button>
          <button class="cwk-btn cwk-btn-secondary" id="cwkl-rebuild-btn"
            title="Re-fetch ALL LoRA metadata from CivitAI, ignoring existing cache">
            ↺ Rebuild Cache
          </button>
          <button class="cwk-btn cwk-btn-secondary" id="cwkl-reload-btn"
            title="Reload the LoRA list from disk without fetching CivitAI data">
            🔄 Reload LoRAs
          </button>
        </div>
        <span class="cwk-footer-status" id="cwkl-status">No LoRA selected</span>
        <div class="cwk-progress-wrap" id="cwkl-progress-wrap">
          <div class="cwk-progress-bar" id="cwkl-progress-bar" style="width:0%"></div>
        </div>
        <div class="cwk-thumb-size" id="cwkl-thumb-size" title="Thumbnail size">
          <span class="cwk-ts-label">Size</span>
          <input type="range" id="cwkl-thumb-size-slider"
                 min="${THUMB_MIN}" max="${THUMB_MAX}" step="${THUMB_STEP}"/>
          <span class="cwk-ts-val" id="cwkl-thumb-size-val"></span>
        </div>
        <button class="cwk-btn cwk-btn-primary" id="cwkl-edit-btn">Edit Info</button>
        <button class="cwk-btn cwk-btn-primary" id="cwkl-save-btn">Save Info</button>
        <button class="cwk-btn cwk-btn-accent"  id="cwkl-load-btn">Load LorA</button>
      </div>
    `;
    document.body.appendChild(this._panel);
    makeDraggable(this._panel, document.getElementById("cwkl-drag-handle"),
                  "cwk_lora_panel_pos");

    // cache element refs (ids are unique to this panel)
    this._grid         = document.getElementById("cwkl-grid");
    this._searchEl     = document.getElementById("cwkl-search");
    this._shownEl      = document.getElementById("cwkl-shown-count");
    this._totalEl      = document.getElementById("cwkl-total-count");
    this._nameEl       = document.getElementById("cwkl-lora-name");
    this._versionEdit  = document.getElementById("cwkl-version-edit");
    this._baseEdit     = document.getElementById("cwkl-base-edit");
    this._descEl       = document.getElementById("cwkl-desc");
    this._descEdit     = document.getElementById("cwkl-desc-edit");
    this._tagsEl       = document.getElementById("cwkl-triggers");
    this._trigEdit     = document.getElementById("cwkl-triggers-edit");
    this._descSrcEl    = document.getElementById("cwkl-desc-source");
    this._trigSrcEl    = document.getElementById("cwkl-trig-source");
    this._thumbImg     = document.getElementById("cwkl-thumb-preview");
    this._thumbSet     = document.getElementById("cwkl-thumb-set");
    this._thumbReset   = document.getElementById("cwkl-thumb-reset");
    this._nsfwToggle   = document.getElementById("cwkl-nsfw-toggle");
    this._statusEl     = document.getElementById("cwkl-status");
    this._progressWrap = document.getElementById("cwkl-progress-wrap");
    this._progressBar  = document.getElementById("cwkl-progress-bar");
    this._editBtn      = document.getElementById("cwkl-edit-btn");
    this._keyLabel     = document.getElementById("cwkl-api-key-label");

    // datalist with the known base-model names
    getBaseModelMatchers().then(list => {
      const dl = document.getElementById("cwkl-base-list");
      if (dl) dl.innerHTML = (list || [])
        .filter(f => Array.isArray(f.match))
        .map(f => `<option value="${f.label}"></option>`).join("");
    }).catch(() => {});

    // ── Resize handle (same design as the model browser) ──
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "cwk-resize-handle";
    const resizeInner = document.createElement("div");
    resizeInner.className = "cwk-resize-inner";
    resizeHandle.appendChild(resizeInner);
    this._panel.appendChild(resizeHandle);

    let rStartX, rStartY, rStartW, rStartH;
    const onResizeMove = e => {
      this._panel.style.width  = Math.max(520, rStartW + e.clientX - rStartX) + "px";
      this._panel.style.height = Math.max(400, rStartH + e.clientY - rStartY) + "px";
    };
    const onResizeUp = () => {
      document.removeEventListener("mousemove", onResizeMove);
      document.removeEventListener("mouseup",   onResizeUp);
      document.body.style.userSelect = "";
      localStorage.setItem("cwk_lora_panel_size", JSON.stringify({
        w: parseFloat(this._panel.style.width),
        h: parseFloat(this._panel.style.height),
      }));
    };
    resizeHandle.addEventListener("mousedown", e => {
      e.preventDefault(); e.stopPropagation();
      const r = this._panel.getBoundingClientRect();
      if (this._panel.style.transform) {
        this._panel.style.left      = r.left + "px";
        this._panel.style.top       = r.top  + "px";
        this._panel.style.transform = "none";
      }
      rStartX = e.clientX; rStartY = e.clientY;
      rStartW = r.width;   rStartH = r.height;
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup",   onResizeUp);
    });

    this._bindFilterDropdown();
    this._updateKeyLabel();
    this._installThumbSizeSlider();
  }

  // ── Filter dropdown ────────────────────────────────────────────────────────

  _bindFilterDropdown() {
    const btn  = document.getElementById("cwkl-filter-type-btn");
    const menu = document.getElementById("cwkl-filter-type-menu");
    const lbl  = document.getElementById("cwkl-filter-type-label");
    if (!btn || !menu) return;

    btn.addEventListener("click", e => {
      e.stopPropagation();
      menu.classList.toggle("open");
    });
    menu.addEventListener("click", e => {
      const opt = e.target.closest(".cwk-select-option");
      if (!opt) return;
      menu.querySelectorAll(".cwk-select-option").forEach(o => o.classList.remove("active"));
      opt.classList.add("active");
      const idx   = parseInt(opt.dataset.idx, 10);
      const entry = this._baseModelFilters[idx];
      lbl.textContent = entry?.label ?? "All Types";
      this._filterMatch = entry?.match ?? null;
      menu.classList.remove("open");
      this._applyFilter(this._searchEl?.value ?? "");
    });
    document.addEventListener("click", () => menu.classList.remove("open"));

    getBaseModelMatchers().then(list => {
      this._baseModelMatchers = list;
      this._rebuildFilterDropdown();
    }).catch(() => {});
  }

  _rebuildFilterDropdown() {
    const menu = document.getElementById("cwkl-filter-type-menu");
    const lbl  = document.getElementById("cwkl-filter-type-label");
    if (!menu) return;

    const middle = (this._baseModelMatchers || STATIC_BASE_MODEL_FILTERS)
      .filter(f => Array.isArray(f.match));
    const middleLc = middle.map(f => f.match.map(s => s.toLowerCase()));

    const counts = new Array(middle.length).fill(0);
    let othersCount = 0;
    for (const l of this._loras) {
      const raw = (l.civitai?.base_model ?? "").toLowerCase();
      const idx = raw ? middleLc.findIndex(keywords => keywords.some(s => raw.includes(s))) : -1;
      if (idx === -1) othersCount++;
      else counts[idx]++;
    }

    const counted = middle
      .map((f, i) => ({ ...f, count: counts[i] }))
      .filter(f => f.count > 0);

    this._baseModelFilters = [
      { label: `All Types (${this._loras.length})`, match: null },
      ...counted.map(f => ({ ...f, label: `${f.label} (${f.count})` })),
      { label: `Others (${othersCount})`, match: OTHERS_MATCH },
    ];

    menu.innerHTML = this._baseModelFilters.map((f, i) =>
      `<div class="cwk-select-option" data-idx="${i}">${f.label}</div>`).join("");

    const activeIdx = this._baseModelFilters.findIndex(f => f.match === this._filterMatch);
    if (this._filterMatch !== null && activeIdx === -1) this._filterMatch = null;
    const selectedIdx = this._baseModelFilters.findIndex(f => f.match === this._filterMatch);
    if (lbl) lbl.textContent = this._baseModelFilters[selectedIdx]?.label ?? "All Types";
    menu.querySelectorAll(".cwk-select-option").forEach((o, i) => {
      o.classList.toggle("active", i === selectedIdx);
    });
  }

  // ── Key helpers ────────────────────────────────────────────────────────────

  _updateKeyLabel() {
    const el = this._keyLabel;
    if (!el) return;
    if (this._civitaiKey) {
      el.className   = "cwk-api-key-label has-key";
      el.textContent = "🔑 API Key set";
    } else {
      el.className   = "cwk-api-key-label no-key";
      el.textContent = "🔑 No API Key";
    }
  }

  _promptForKey(reason = "") {
    const msg = reason
      ? `${reason}\n\nEnter your CivitAI API key:`
      : "Enter your CivitAI API key (civitai.com → Account Settings → API Keys):";
    const key = prompt(msg, this._civitaiKey);
    if (key === null) return false;
    this._civitaiKey = key.trim();
    localStorage.setItem("cwk_civitai_key", this._civitaiKey);
    this._updateKeyLabel();
    return !!this._civitaiKey;
  }

  // ── Thumbnail size slider ──────────────────────────────────────────────────

  _installThumbSizeSlider() {
    if (!document.getElementById("cwkl-thumb-size-style")) {
      const s = document.createElement("style");
      s.id = "cwkl-thumb-size-style";
      s.textContent = `
        .cwk-thumb-size { display:inline-flex; align-items:center; gap:6px;
          height:28px; padding:0 10px; background:#1e2335;
          border:1px solid #313552; border-radius:6px; }
        .cwk-thumb-size .cwk-ts-label { font:11px Inter,system-ui,sans-serif;
          color:#6c7086; user-select:none; white-space:nowrap; }
        .cwk-thumb-size input[type=range] { -webkit-appearance:none; appearance:none;
          width:90px; height:4px; margin:0; background:#313552; border-radius:2px;
          outline:none; cursor:pointer; }
        .cwk-thumb-size input[type=range]::-webkit-slider-thumb { -webkit-appearance:none;
          width:12px; height:12px; border-radius:50%; background:#89b4fa;
          border:2px solid #141824; }
        .cwk-thumb-size input[type=range]::-moz-range-thumb { width:12px; height:12px;
          border-radius:50%; background:#89b4fa; border:2px solid #141824; }
        .cwk-thumb-size .cwk-ts-val { font:11px Inter,system-ui,sans-serif;
          color:#cdd6f4; min-width:44px; text-align:right; white-space:nowrap; }
        #cwkl-grid.cwk-sized .cwk-card {
          box-sizing: border-box;
          width: 100%;
          min-width: 0;
          aspect-ratio: ${THUMB_AR_W} / ${THUMB_AR_H};
        }
      `;
      document.head.appendChild(s);
    }

    const slider = document.getElementById("cwkl-thumb-size-slider");
    if (!slider) return;
    slider.value = String(this._thumbTarget);

    slider.addEventListener("input", () => {
      this._thumbTarget = Math.min(THUMB_MAX, Math.max(THUMB_MIN, Number(slider.value)));
      try { localStorage.setItem(THUMB_KEY, String(this._thumbTarget)); } catch {}
      this._applyThumbLayout();
    });

    this._thumbObserver = new ResizeObserver(() => {
      const l = this._thumbLayout();
      if (l && l.usable !== this._lastThumbUsable) this._applyThumbLayout();
    });
    if (this._grid) this._thumbObserver.observe(this._grid);

    this._applyThumbLayout();
  }

  _thumbLayout() {
    if (!this._grid) return null;
    const cs = getComputedStyle(this._grid);
    const usable = this._grid.clientWidth
      - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (usable < THUMB_MIN) return null;
    const maxCols = Math.max(1, Math.floor((usable + THUMB_GAP) / (THUMB_MIN + THUMB_GAP)));
    let cols = Math.round((usable + THUMB_GAP) / (this._thumbTarget + THUMB_GAP));
    cols = Math.max(1, Math.min(cols, maxCols));
    const size = Math.floor((usable - (cols - 1) * THUMB_GAP) / cols);
    return { cols, size, usable };
  }

  _applyThumbLayout() {
    const l = this._thumbLayout();
    if (!l || !this._grid) return;
    const h = Math.round(l.size * THUMB_AR_H / THUMB_AR_W);
    this._grid.classList.add("cwk-sized");
    this._grid.style.gridTemplateColumns = `repeat(${l.cols}, 1fr)`;
    this._grid.style.gridAutoRows = `${h}px`;
    this._grid.style.gap = `${THUMB_GAP}px`;
    this._lastThumbUsable = l.usable;
    const readout = document.getElementById("cwkl-thumb-size-val");
    if (readout) readout.textContent = `${l.size}×${h}`;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  _bindEvents() {
    document.getElementById("cwkl-close-btn").addEventListener("click", () => this.hide());
    this._overlay.addEventListener("click", () => this.hide());
    this._searchEl.addEventListener("input", debounce(e => this._applyFilter(e.target.value)));

    document.getElementById("cwkl-filter-favorite").addEventListener("change", e => {
      this._filterFavorite = e.target.checked;
      this._applyFilter(this._searchEl?.value ?? "");
    });

    this._keyLabel.addEventListener("click", () => this._promptForKey());

    document.getElementById("cwkl-validate-key-btn").addEventListener("click", async () => {
      if (!this._civitaiKey) { this._promptForKey("Set an API key first."); return; }
      this._setStatus("Validating API key…");
      try {
        const res = await apiFetch(
          `/cwk/civitai/validate?key=${encodeURIComponent(this._civitaiKey)}`);
        this._setStatus(res.ok ? "✓ API key is valid!" : `✗ ${res.error}`, !res.ok);
      } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
    });

    document.getElementById("cwkl-clear-cache-btn").addEventListener("click", async () => {
      if (!confirm("Clear all cached LoRA metadata, custom info and custom thumbnails?")) return;
      try { await fetch("/cwk/loras/cache", { method: "DELETE" }); }
      catch (e) { this._setStatus(`✗ ${e.message}`, true); return; }
      await this._reloadLoras();
      await this._fetchCivitAI(false);
    });

    document.getElementById("cwkl-fetch-btn")
      .addEventListener("click", () => this._fetchCivitAI(false));

    document.getElementById("cwkl-rebuild-btn").addEventListener("click", () => {
      if (!confirm(
        "Re-fetch ALL LoRA metadata from CivitAI?\n\nCustom descriptions, trigger words, base models and thumbnails are preserved."
      )) return;
      this._fetchCivitAI(true);
    });

    document.getElementById("cwkl-reload-btn").addEventListener("click", async () => {
      const btn = document.getElementById("cwkl-reload-btn");
      btn.disabled    = true;
      btn.textContent = "Reloading…";
      await this._reloadLoras();
      await this._fetchCivitAI(false);
      btn.disabled    = false;
      btn.textContent = "🔄 Reload LoRAs";
    });

    document.getElementById("cwkl-refresh-btn")
      .addEventListener("click", () => this._refreshSelected());

    this._editBtn.addEventListener("click", () => {
      if (!this._current()) { this._setStatus("⚠ Select a LoRA first", true); return; }
      this._setEditMode(!this._editMode);
    });
    document.getElementById("cwkl-save-btn").addEventListener("click", () => this._saveInfo());
    document.getElementById("cwkl-load-btn").addEventListener("click", () => this._loadLora());

    // ── Editable Version / Base / NSFW ──
    this._versionEdit.addEventListener("change", () =>
      this._saveField({ version: this._versionEdit.value }));
    this._baseEdit.addEventListener("change", () =>
      this._saveField({ base_model: this._baseEdit.value }));
    this._nsfwToggle.addEventListener("change", () =>
      this._saveField({ nsfw: this._nsfwToggle.checked }));

    // ── Custom thumbnail ──
    this._thumbSet.addEventListener("click", () => this._pickThumbnail());
    this._thumbReset.addEventListener("click", () => {
      if (this._current()?.civitai?.thumbnail_custom) {
        this._saveField({ clear_thumbnail: true });
      }
    });
  }

  // ── Open / close ───────────────────────────────────────────────────────────

  async open(onLoadCallback, hint = "", selectName = null) {
    this._onLoadCallback = onLoadCallback || null;

    try {
      const s = JSON.parse(localStorage.getItem("cwk_lora_panel_size") || "null");
      if (s?.w && s?.h) {
        this._panel.style.width  = Math.max(520, s.w) + "px";
        this._panel.style.height = Math.max(400, s.h) + "px";
      }
    } catch {}

    try {
      const p = JSON.parse(localStorage.getItem("cwk_lora_panel_pos") || "null");
      if (p?.x != null && p?.y != null) {
        this._panel.style.transform = "none";
        this._panel.style.left = Math.min(Math.max(0, p.x), window.innerWidth  - 80) + "px";
        this._panel.style.top  = Math.min(Math.max(0, p.y), window.innerHeight - 80) + "px";
      }
    } catch {}

    this._setStatus("Loading LoRAs…");
    this._panel.classList.add("visible");
    this._overlay.classList.add("visible");
    requestAnimationFrame(() => this._applyThumbLayout());
    try {
      this._loras = await apiFetch("/cwk/loras");
      this._loras.forEach(l => {
        if (l.civitai?.trigger_words?.length) {
          triggerCache.set(l.name, l.civitai.trigger_words);
        }
      });
      this._rebuildFilterDropdown();
      this._applyFilter("");
      this._totalEl.textContent =
        `${this._loras.length} lora${this._loras.length !== 1 ? "s" : ""}`;
      if (selectName) this._revealLora(selectName);
      const pending    = this._loras.filter(l => !l.civitai?.fetched).length;
      const withThumbs = this._loras.filter(l => l.civitai?.thumbnail).length;
      let status;
      if (!this._loras.length)          status = "No LoRAs found in models/loras";
      else if (pending)                 status = `${pending} LoRA(s) without metadata — click 'Fetch Thumbnails/Infos'`;
      else if (withThumbs)              status = `${withThumbs} / ${this._loras.length} with cached thumbnails`;
      else                              status = "Click 'Fetch Thumbnails/Infos' to load LoRA images.";
      if (!selectName || !this._loras.some(l => l.name === selectName)) {
        this._setStatus((hint ? `ⓘ ${hint} — ` : "") + status, !this._loras.length);
      }
    } catch (e) {
      this._setStatus(`Error: ${e.message}`, true);
    }
  }

  hide() {
    this._panel.classList.remove("visible");
    this._overlay.classList.remove("visible");
    this._setEditMode(false);
    this._onLoadCallback = null;
    this._fetchAbort?.abort();
    this._fetchAbort = null;
    this._setProgress(0, 0);
    document.getElementById("cwkl-filter-type-menu")?.classList.remove("open");
  }

  /** Reset filters, select `name` and scroll its card into view. */
  _revealLora(name) {
    this._filterMatch    = null;
    this._filterFavorite = false;
    const fav = document.getElementById("cwkl-filter-favorite");
    if (fav) fav.checked = false;
    if (this._searchEl) this._searchEl.value = "";
    const lbl  = document.getElementById("cwkl-filter-type-label");
    const menu = document.getElementById("cwkl-filter-type-menu");
    const idx  = this._baseModelFilters.findIndex(f => f.match === null);
    if (lbl)  lbl.textContent = this._baseModelFilters[idx]?.label ?? "All Types";
    if (menu) menu.querySelectorAll(".cwk-select-option").forEach((o, i) =>
      o.classList.toggle("active", i === idx));
    this._applyFilter("");
    this._selectLora(name);
    const card = this._grid?.querySelector(`.cwk-card[data-name="${CSS.escape(name)}"]`);
    card?.scrollIntoView({ block: "center" });
  }

  // ── List reload ────────────────────────────────────────────────────────────

  async _reloadLoras() {
    try {
      this._loras = await apiFetch("/cwk/loras");
      this._loras.forEach(l => {
        if (l.civitai?.trigger_words?.length) {
          triggerCache.set(l.name, l.civitai.trigger_words);
        }
      });
      this._rebuildFilterDropdown();
      this._applyFilter(this._searchEl?.value ?? "");
      this._totalEl.textContent =
        `${this._loras.length} lora${this._loras.length !== 1 ? "s" : ""}`;
      this._setStatus(`✓ ${this._loras.length} lora${this._loras.length !== 1 ? "s" : ""} loaded`);
    } catch (e) {
      this._setStatus(`✗ Reload failed: ${e.message}`, true);
    }
  }

  // ── CivitAI fetch (SSE) ────────────────────────────────────────────────────

  async _fetchCivitAI(rebuild = false) {
    if (!this._loras.length) { this._setStatus("No LoRAs to fetch", true); return; }
    const list = rebuild ? this._loras : this._loras.filter(l => !l.civitai?.fetched);
    if (!list.length) { this._setStatus("✓ All LoRAs already have metadata"); return; }

    this._fetchAbort?.abort();
    const abort = new AbortController();
    this._fetchAbort = abort;

    this._setStatus(rebuild ? "Rebuilding cache…" : `Fetching metadata for ${list.length} LoRA(s)…`);
    for (const l of list) { l._resolving = true; this._updateCard(l); }
    this._setProgress(0, list.length);

    let done = 0, found = 0, withTriggers = 0;
    try {
      const response = await fetch("/cwk/loras/fetch/stream", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          loras:   list.map(l => l.name),
          api_key: this._civitaiKey,
          rebuild,
        }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = "";

      outer: while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let p; try { p = JSON.parse(line.slice(5)); } catch { continue; }

          if (p.error === "api_key_invalid") {
            this._setStatus(`✗ ${p.message || "CivitAI rejected the API key"}`, true);
            this._civitaiKey = "";
            localStorage.removeItem("cwk_civitai_key");
            this._updateKeyLabel();
            break outer;
          }
          if (p.done) break outer;
          if (p.status === "hashing") {
            this._setStatus(`Hashing ${p.lora}… (first fetch only)`);
            continue;
          }

          const l = this._loras.find(x => x.name === p.lora);
          if (l) {
            l._resolving = false;
            if (p.ok) {
              l.civitai = p.info;
              found++;
              if (p.info?.trigger_words?.length) {
                withTriggers++;
                triggerCache.set(l.name, p.info.trigger_words);
              }
            } else {
              if (!l.civitai) l.civitai = {};
              l.civitai.fetched = true;
              if (p.error === "not found on Civitai") l.civitai.not_on_civitai = true;
              else l.civitai.error = p.error;
            }
            this._updateCard(l);
          }
          done++;
          this._setProgress(done, list.length);
          this._setStatus(
            `Fetching… ${done} / ${list.length}` +
            (found ? ` · ${found} 🖼` : "") +
            (withTriggers ? ` · ${withTriggers} triggers` : "")
          );
        }
      }

      this._setStatus(
        (found ? `✓ ${found} / ${list.length} LoRA(s) matched on CivitAI`
               : "✓ No LoRAs found on CivitAI") +
        (withTriggers ? ` · ${withTriggers} with trigger words` : "")
      );
      this._rebuildFilterDropdown();
      this._applyFilter(this._searchEl?.value ?? "");
    } catch (e) {
      if (e.name !== "AbortError") this._setStatus(`✗ Fetch failed: ${e.message}`, true);
    } finally {
      for (const l of list) { l._resolving = false; this._updateCard(l); }
      this._setProgress(0, 0);
      this._fetchAbort = null;
    }
  }

  async _refreshSelected() {
    const l = this._current();
    if (!l) { this._setStatus("⚠ Select a LoRA first", true); return; }
    this._setStatus(`Refreshing ${l.name}…`);
    try {
      const res = await apiFetch("/cwk/loras/refresh", {
        method: "POST",
        body:   JSON.stringify({ lora: l.name, api_key: this._civitaiKey }),
      });
      if (res.ok) {
        l.civitai = res.info;
        triggerCache.set(l.name, res.info?.trigger_words || []);
        this._updateCard(l);
        this._updateSidebarStatic();
        this._setStatus(`✓ Refreshed: ${l.name}`);
      } else {
        if (res.error === "api_key_invalid") {
          this._civitaiKey = "";
          localStorage.removeItem("cwk_civitai_key");
          this._updateKeyLabel();
        }
        this._setStatus(`✗ ${res.error}`, true);
      }
    } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
  }

  // ── Filter / grid / cards ──────────────────────────────────────────────────

  _applyFilter(query) {
    const q  = query.toLowerCase().trim();
    const fm = this._filterMatch;

    this._filtered = this._loras.filter(l => {
      if (q && !l.name.toLowerCase().includes(q)
           && !(l.civitai?.civitai_name || "").toLowerCase().includes(q)) return false;
      if (this._filterFavorite && !l.civitai?.favorite) return false;
      if (fm !== null) {
        const raw = (l.civitai?.base_model ?? "").toLowerCase();
        if (fm === OTHERS_MATCH) {
          const allKnown = (this._baseModelMatchers || [])
            .filter(f => Array.isArray(f.match)).flatMap(f => f.match);
          if (allKnown.some(s => raw.includes(s.toLowerCase()))) return false;
        } else if (!fm.some(s => raw.includes(s.toLowerCase()))) {
          return false;
        }
      }
      return true;
    });

    this._shownEl.textContent = `${this._filtered.length} shown`;
    this._renderGrid();
  }

  _renderGrid() {
    if (!this._grid) return;
    this._grid.innerHTML = "";
    for (const l of this._filtered) this._grid.appendChild(this._buildCard(l));
  }

  _buildCard(l) {
    const nsfw       = isNsfwLora(l);
    const revealed   = nsfw ? !!this._revealed[l.name] : true;
    const shouldBlur = nsfw && !revealed;

    const card      = document.createElement("div");
    card.className  = "cwk-card"
      + (l.name === this._selected ? " selected"  : "")
      + (l._resolving              ? " resolving" : "")
      + (shouldBlur                ? " blurred"   : "");
    card.dataset.name = l.name;

    const civ         = l.civitai || {};
    const thumb       = civ.thumbnail;
    const displayName = civ.civitai_name
      ?? l.name.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
    const baseModel   = civ.base_model   ?? "";
    const versionName = civ.version_name ?? "";
    const isFavorite  = !!civ.favorite;
    const hasCustom   = !!(civ.custom_description || "").trim()
                     || !!(civ.custom_triggers || "").trim()
                     || !!(civ.custom_base_model || "").trim()
                     || !!(civ.custom_version || "").trim()
                     || !!civ.thumbnail_custom;

    let mediaHtml = `<div class="cwk-card-placeholder">🧩</div>`;
    if (thumb) mediaHtml = `<img src="${thumb}" alt="${displayName}" loading="lazy"/>`;

    const eyeHtml = nsfw
      ? `<button class="cwk-eye-btn" title="${revealed ? "Blur image" : "Reveal image"}">${revealed ? "🙈" : "👁"}</button>`
      : "";
    const starHtml = `<button class="cwk-star-btn${isFavorite ? " active" : ""}"
      title="${isFavorite ? "Remove from favorites" : "Add to favorites"}">★</button>`;
    const customHtml = hasCustom
      ? `<div class="cwk-card-custom-badge" title="Custom info (description / triggers / base / thumbnail)">✎</div>`
      : "";

    card.innerHTML = `
      <div class="cwk-card-top-left">
        <div class="cwk-card-badge">LORA</div>
        ${customHtml}
        ${eyeHtml}
      </div>
      ${starHtml}
      ${mediaHtml}
      <div class="cwk-card-footer">
        <div class="cwk-card-name">${displayName}</div>
        ${versionName
          ? `<div class="cwk-card-version">${versionName}</div>`
          : (baseModel ? `<div class="cwk-card-version">${baseModel}</div>` : "")}
      </div>
    `;

    if (nsfw) {
      card.querySelector(".cwk-eye-btn").addEventListener("click", e => {
        e.stopPropagation();
        this._revealed[l.name] = !this._revealed[l.name];
        localStorage.setItem("cwk_lora_revealed", JSON.stringify(this._revealed));
        this._updateCard(l);
      });
    }

    card.querySelector(".cwk-star-btn").addEventListener("click", async e => {
      e.stopPropagation();
      const newFav = !l.civitai?.favorite;
      try {
        await apiFetch("/cwk/lora/favorite", {
          method: "POST",
          body:   JSON.stringify({ lora: l.name, favorite: newFav }),
        });
        if (!l.civitai) l.civitai = {};
        l.civitai.favorite = newFav;
        this._updateCard(l);
        if (this._filterFavorite) this._applyFilter(this._searchEl?.value ?? "");
      } catch (err) { this._setStatus(`✗ ${err.message}`, true); }
    });

    card.addEventListener("click",    () => this._selectLora(l.name));
    card.addEventListener("dblclick", () => { this._selectLora(l.name); this._loadLora(); });

    return card;
  }

  _updateCard(l) {
    const el = this._grid?.querySelector(`.cwk-card[data-name="${CSS.escape(l.name)}"]`);
    if (el) el.replaceWith(this._buildCard(l));
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────

  _current() {
    return this._loras.find(l => l.name === this._selected) || null;
  }

  _selectLora(name) {
    this._selected = name;
    this._setEditMode(false);
    if (this._grid) {
      this._grid.querySelectorAll(".cwk-card").forEach(c =>
        c.classList.toggle("selected", c.dataset.name === name));
    }
    this._updateSidebarStatic();
  }

  /** Fill the non-edit-mode sidebar controls (does not touch edit textareas). */
  _updateSidebarStatic() {
    const l = this._current();
    if (!l) return;
    const civ = l.civitai || {};

    this._nameEl.textContent      = l.name;
    this._versionEdit.value       = civ.version_name || "";
    this._baseEdit.value          = civ.base_model   || "";

    const desc = (civ.description || "").trim();
    this._descEl.textContent = desc || "No description — click “Edit Info” to write one.";
    this._descEl.classList.toggle("empty", !desc);
    const dCustom = !!(civ.custom_description || "").trim();
    const dCiv    = !!(civ.civitai_description || "").trim();
    this._descSrcEl.className   = "cwk-source-badge " + (dCustom ? "custom" : dCiv ? "civitai" : "none");
    this._descSrcEl.textContent = dCustom ? "custom" : dCiv ? "Civitai" : "no data";

    const words   = civ.trigger_words || [];
    const tCustom = !!(civ.custom_triggers || "").trim();
    this._tagsEl.innerHTML = "";
    if (words.length) {
      for (const w of words) {
        const chip = document.createElement("span");
        chip.className = "cwk-lora-tag" + (tCustom ? " custom" : "");
        chip.textContent = w;
        this._tagsEl.appendChild(chip);
      }
    } else {
      const hint = document.createElement("span");
      hint.className = "cwk-lora-hint";
      hint.textContent = "No trigger words — click “Edit Info” to define some.";
      this._tagsEl.appendChild(hint);
    }
    const tCiv = !!(civ.civitai_trigger_words || []).length;
    this._trigSrcEl.className   = "cwk-source-badge " + (tCustom ? "custom" : tCiv ? "civitai" : "none");
    this._trigSrcEl.textContent = tCustom ? "custom" : tCiv ? "Civitai" : "no data";

    const thumb = civ.thumbnail || "";
    this._thumbImg.src          = thumb;
    this._thumbImg.style.display = thumb ? "" : "none";
    this._thumbReset.disabled   = !civ.thumbnail_custom;
    this._nsfwToggle.checked    = isNsfwLora(l);

    this._setStatus(l.name);
  }

  _setEditMode(on) {
    this._editMode = on;
    this._descEl.style.display   = on ? "none" : "";
    this._tagsEl.style.display   = on ? "none" : "";
    this._descEdit.style.display = on ? "" : "none";
    this._trigEdit.style.display = on ? "" : "none";
    this._editBtn.textContent    = on ? "Cancel Edit" : "Edit Info";
    if (on) {
      const civ = this._current()?.civitai || {};
      this._descEdit.value = (civ.description || "").trim();
      this._trigEdit.value = (civ.trigger_words || []).join(", ");
    }
  }

  async _saveInfo() {
    if (!this._editMode) { this._setStatus("⚠ Click “Edit Info” first", true); return; }
    const l = this._current();
    if (!l) { this._setStatus("⚠ Select a LoRA first", true); return; }
    try {
      this._setStatus("Saving…");
      const res = await apiFetch("/cwk/lora/meta", {
        method: "POST",
        body:   JSON.stringify({
          lora:        l.name,
          description: this._descEdit.value,
          triggers:    this._trigEdit.value,
        }),
      });
      if (res.ok) {
        l.civitai = res.civitai || {};
        triggerCache.set(l.name, l.civitai.trigger_words || []);
        this._setEditMode(false);
        this._updateCard(l);
        this._updateSidebarStatic();
        this._setStatus(`✓ Custom info saved for ${l.name}`);
      } else {
        this._setStatus(`✗ ${res.error}`, true);
      }
    } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
  }

  /** Save a single field (version / base model / nsfw / clear thumbnail). */
  async _saveField(partial) {
    const l = this._current();
    if (!l) { this._setStatus("⚠ Select a LoRA first", true); return; }
    try {
      const res = await apiFetch("/cwk/lora/meta", {
        method: "POST",
        body:   JSON.stringify({ lora: l.name, ...partial }),
      });
      if (res.ok) {
        l.civitai = res.civitai || {};
        triggerCache.set(l.name, l.civitai.trigger_words || []);
        this._updateCard(l);
        this._updateSidebarStatic();
        this._rebuildFilterDropdown();   // custom base models feed the filter
        this._applyFilter(this._searchEl?.value ?? "");
        this._setStatus(`✓ Saved for ${l.name}`);
      } else {
        this._setStatus(`✗ ${res.error}`, true);
      }
    } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
  }

  _pickThumbnail() {
    const l = this._current();
    if (!l) { this._setStatus("⚠ Select a LoRA first", true); return; }
    const input = document.createElement("input");
    input.type   = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append("lora", l.name);
      fd.append("file", file, file.name);
      try {
        this._setStatus("Uploading thumbnail…");
        const res  = await fetch("/cwk/lora/thumbnail", { method: "POST", body: fd });
        const data = await res.json();
        if (data.ok) {
          l.civitai = data.civitai;
          this._updateCard(l);
          this._updateSidebarStatic();
          this._setStatus("✓ Custom thumbnail set");
        } else {
          this._setStatus(`✗ ${data.error}`, true);
        }
      } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
    };
    input.click();
  }

  _loadLora() {
    const l = this._current();
    if (!l) { this._setStatus("⚠ Select a LoRA first", true); return; }
    if (this._onLoadCallback) {
      this._onLoadCallback({ name: l.name, civitai: l.civitai });
      this._setStatus(`✓ Loaded “${l.name}” — pick more or close the browser`);
    } else {
      this.hide();
    }
  }

  // ── Status / progress ──────────────────────────────────────────────────────

  _setStatus(msg, isErr = false) {
    if (!this._statusEl) return;
    this._statusEl.textContent = msg;
    this._statusEl.classList.toggle("error", !!isErr);
  }

  _setProgress(cur, total) {
    if (!this._progressWrap || !this._progressBar) return;
    if (total > 0) {
      this._progressWrap.classList.add("active");
      this._progressBar.style.width = `${Math.round((cur / total) * 100)}%`;
    } else {
      this._progressWrap.classList.remove("active");
      this._progressBar.style.width = "0%";
    }
  }
}

// ─── Singleton accessor ──────────────────────────────────────────────────────

let _instance = null;
export function getLoraBrowser() {
  injectLoraStyles();
  if (!_instance) _instance = new LoraBrowserPanel();
  return _instance;
}
