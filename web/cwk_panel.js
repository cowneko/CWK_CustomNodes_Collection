/**
 * CWK Preset Manager — ModelBrowserPanel
 */

import { PANEL_ID }                        from "./cwk_styles.js";
import { isVideoUrl, showContextMenu,
         showImagePicker,
         showVersionChecker }              from "./cwk_context_menu.js";
import { showModelInfo }                   from "./cwk_model_info.js";

const DEFAULTS = {
  sampler_name: "euler", scheduler: "normal",
  cfg: 7.0, steps: 20, clip_skip: -2,
  width: 1024, height: 1024, rng: "cpu",
  model_sampling: "eps",
  clip_name: "embedded", clip_type: "stable_diffusion", vae_name: "embedded",
};

const NSFW_R = 2;

function isNsfwModel(model) {
  const c = model.civitai;
  if (!c) return false;
  if (c.nsfw_manual === true)  return true;
  if (c.nsfw_manual === false) return false;
  return (c.nsfw_level ?? 0) >= NSFW_R;
}

// ─── Base-model filters ───────────────────────────────────────────────────────

const BASE_MODEL_FILTERS = [
  { label: "All Types",   match: null },
  { label: "SDXL",        match: ["sdxl"] },
  { label: "SD15",        match: ["sd 1.5"] },
  { label: "Illustrious", match: ["illustrious"] },
  { label: "Pony",        match: ["pony"] },
  { label: "NoobAI",      match: ["noobai"] },
  { label: "Qwen",        match: ["qwen"] },
  { label: "Flux",        match: ["flux"] },
  { label: "Chroma",      match: ["chroma"] },
  { label: "Wan",         match: ["wan video", "wan"] },
  { label: "ZImage",      match: ["zimage"] },
  { label: "Others",      match: "__others__" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeDraggable(panel, handle) {
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
      localStorage.setItem("cwk_panel_pos", JSON.stringify({
        x: parseFloat(panel.style.left),
        y: parseFloat(panel.style.top),
      }));
    };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });
}

// ─── ModelBrowserPanel ────────────────────────────────────────────────────────

export class ModelBrowserPanel {
  constructor() {
    this._models         = [];
    this._filtered       = [];
    this._selected       = null;
    this._editMode       = false;
    this._onLoadCallback = null;
    this._civitaiKey     = localStorage.getItem("cwk_civitai_key") || "";
    this._fetchAbort     = null;
    this._revealed       = JSON.parse(localStorage.getItem("cwk_revealed") || "{}");
    this._filterMatch    = null;
    this._filterFavorite = false;
    this._buildDOM();
    this._bindEvents();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────────

  _buildDOM() {
    this._overlay    = document.createElement("div");
    this._overlay.id = "cwk-overlay";
    document.body.appendChild(this._overlay);

    this._panel    = document.createElement("div");
    this._panel.id = PANEL_ID;
    this._panel.innerHTML = `
      <div class="cwk-header" id="cwk-drag-handle">
        <span style="font-size:18px;pointer-events:none">🗂</span>
        <h2>CWK Model Browser
          <span class="cwk-model-count" id="cwk-total-count">0 models</span>
        </h2>
        <button class="cwk-close-btn" id="cwk-close-btn" title="Close">✕</button>
      </div>

      <div class="cwk-search-bar">
        <label for="cwk-search">Search:</label>
        <input id="cwk-search" type="text" placeholder="Filter by name…" autocomplete="off"/>
        <span class="cwk-shown-count" id="cwk-shown-count">0 shown</span>
      </div>

      <div class="cwk-body">
        <div class="cwk-grid-area" id="cwk-grid"></div>

        <div class="cwk-sidebar" id="cwk-sidebar">

          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Base Model</div>
            <div class="cwk-custom-select">
              <button class="cwk-select-btn" id="cwk-filter-type-btn">
                <span id="cwk-filter-type-label">All Types</span>
                <span class="cwk-select-arrow">▾</span>
              </button>
              <div class="cwk-select-dropdown" id="cwk-filter-type-menu">
                ${BASE_MODEL_FILTERS.map((f, i) =>
                  `<div class="cwk-select-option" data-idx="${i}">${f.label}</div>`
                ).join("")}
              </div>
            </div>
          </div>

          <div class="cwk-sidebar-section">
            <label class="cwk-favorite-filter">
              <input type="checkbox" id="cwk-filter-favorite"/>
              <span>⭐ Favorites only</span>
            </label>
          </div>

          <hr class="cwk-sidebar-divider"/>

          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Model name:</div>
            <div id="sb-model-name"
              style="font-size:12px;color:#cdd6f4;word-break:break-all">—</div>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Sampler Name:</div>
            <select class="cwk-sidebar-input" id="sb-sampler" disabled></select>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Scheduler:</div>
            <select class="cwk-sidebar-input" id="sb-scheduler" disabled></select>
          </div>
          <div class="cwk-sidebar-row">
            <div class="cwk-sidebar-col">
              <div class="cwk-sidebar-title">CFG:</div>
              <input class="cwk-sidebar-input" id="sb-cfg"
                type="number" step="0.1" min="0" max="30" disabled/>
            </div>
            <div class="cwk-sidebar-col">
              <div class="cwk-sidebar-title">Steps:</div>
              <input class="cwk-sidebar-input" id="sb-steps"
                type="number" step="1" min="1" max="200" disabled/>
            </div>
          </div>
          <div class="cwk-sidebar-row">
            <div class="cwk-sidebar-col">
              <div class="cwk-sidebar-title">Clip skip:</div>
              <input class="cwk-sidebar-input" id="sb-clip-skip"
                type="number" step="1" min="-24" max="-1" disabled/>
            </div>
            <div class="cwk-sidebar-col">
              <div class="cwk-sidebar-title">RNG:</div>
              <select class="cwk-sidebar-input" id="sb-rng" disabled>
                <option value="cpu">cpu</option>
                <option value="gpu">gpu</option>
                <option value="nv">nv</option>
              </select>
            </div>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Model Sampling:</div>
            <select class="cwk-sidebar-input" id="sb-model-sampling" disabled>
              <option value="eps">eps</option>
              <option value="v_prediction">v_prediction</option>
              <option value="lcm">lcm</option>
              <option value="x0">x0</option>
              <option value="img_to_img">img_to_img</option>
            </select>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">Resolution:</div>
            <div class="cwk-sidebar-row" style="margin-top:6px">
              <div class="cwk-sidebar-col">
                <div style="font-size:12px;color:#6c7086;margin-bottom:4px">Width</div>
                <input class="cwk-sidebar-input" id="sb-width"
                  type="number" step="8" min="64" max="8192" disabled/>
              </div>
              <div class="cwk-sidebar-col">
                <div style="font-size:12px;color:#6c7086;margin-bottom:4px">Height</div>
                <input class="cwk-sidebar-input" id="sb-height"
                  type="number" step="8" min="64" max="8192" disabled/>
              </div>
            </div>
          </div>

          <hr class="cwk-sidebar-divider"/>

          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">CLIP:</div>
            <select class="cwk-sidebar-input" id="sb-clip-name" disabled>
              <option value="embedded">embedded</option>
            </select>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">CLIP Type:</div>
            <select class="cwk-sidebar-input" id="sb-clip-type" disabled>
              <option value="stable_diffusion">stable_diffusion</option>
            </select>
          </div>
          <div class="cwk-sidebar-section">
            <div class="cwk-sidebar-title">VAE:</div>
            <select class="cwk-sidebar-input" id="sb-vae-name" disabled>
              <option value="embedded">embedded</option>
            </select>
          </div>
        </div>
      </div>

      <div class="cwk-footer">
        <div class="cwk-api-key-area">
          <span class="cwk-api-key-label" id="cwk-api-key-label"
            title="Click to set CivitAI API Key">🔑 CivitAI API Key</span>
          <button class="cwk-icon-btn" id="cwk-validate-key-btn" title="Test key">✓</button>
          <button class="cwk-icon-btn" id="cwk-clear-cache-btn"  title="Clear cache">🗑</button>
        </div>
        <div class="cwk-fetch-wrap">
          <button class="cwk-btn cwk-btn-secondary" id="cwk-fetch-btn">
            Fetch Thumbnails/Infos
          </button>
          <button class="cwk-btn cwk-btn-secondary" id="cwk-rebuild-btn"
            title="Re-fetch ALL metadata from CivitAI, ignoring existing cache">
            ↺ Rebuild Cache
          </button>
          <button class="cwk-btn cwk-btn-secondary" id="cwk-reload-btn"
            title="Reload the model list from disk without fetching CivitAI data">
            🔄 Reload Models
          </button>
          <button class="cwk-btn cwk-btn-secondary" id="cwk-updates-btn"
            title="Check CivitAI for newer versions of your models">
            🔍 Check Updates
          </button>
        </div>
        <span class="cwk-footer-status" id="cwk-footer-status">No model selected</span>
        <div class="cwk-progress-wrap" id="cwk-progress-wrap">
          <div class="cwk-progress-bar" id="cwk-progress-bar" style="width:0%"></div>
        </div>
        <button class="cwk-btn cwk-btn-primary" id="cwk-edit-btn">Edit Preset</button>
        <button class="cwk-btn cwk-btn-primary" id="cwk-save-preset-btn">Save Preset</button>
        <button class="cwk-btn cwk-btn-accent"  id="cwk-load-model-btn">Load Model</button>
      </div>
    `;

    document.body.appendChild(this._panel);
    makeDraggable(this._panel, document.getElementById("cwk-drag-handle"));

    // ── Resize handle ──────────────────────────────────────────────────────────
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
      localStorage.setItem("cwk_panel_size", JSON.stringify({
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
    this._populateDropdowns();
    this._updateKeyLabel();
  }

  // ── Filter dropdown ───────────────────────────────────────────────────────────

  _bindFilterDropdown() {
    const btn  = document.getElementById("cwk-filter-type-btn");
    const menu = document.getElementById("cwk-filter-type-menu");
    const lbl  = document.getElementById("cwk-filter-type-label");

    btn.addEventListener("click", e => {
      e.stopPropagation();
      menu.classList.toggle("open");
    });

    menu.addEventListener("click", e => {
      const opt = e.target.closest(".cwk-select-option");
      if (!opt) return;
      menu.querySelectorAll(".cwk-select-option").forEach(o => o.classList.remove("active"));
      opt.classList.add("active");
      const idx         = parseInt(opt.dataset.idx, 10);
      lbl.textContent   = BASE_MODEL_FILTERS[idx].label;
      this._filterMatch = BASE_MODEL_FILTERS[idx].match;
      menu.classList.remove("open");
      this._applyFilter(document.getElementById("cwk-search")?.value ?? "");
    });

    document.addEventListener("click", () => menu.classList.remove("open"));
  }

  // ── Key helpers ───────────────────────────────────────────────────────────────

  _updateKeyLabel() {
    const el = document.getElementById("cwk-api-key-label");
    if (!el) return;
    if (this._civitaiKey) {
      el.className   = "cwk-api-key-label has-key";
      el.textContent = "🔑 API Key set";
    } else {
      el.className   = "cwk-api-key-label no-key";
      el.textContent = "🔑 No API Key — required!";
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

  // ── Dropdowns ─────────────────────────────────────────────────────────────────

  async _populateDropdowns() {
    try {
      const info       = await apiFetch("/object_info/CWK_ModelPresetManager");
      const inputs     = info?.CWK_ModelPresetManager?.input;
      const samplers   = (inputs?.optional?.override_sampler?.[0]   ?? []).filter(v => v !== "(preset)");
      const schedulers = (inputs?.optional?.override_scheduler?.[0] ?? []).filter(v => v !== "(preset)");
      this._fillSelect("sb-sampler",   samplers);
      this._fillSelect("sb-scheduler", schedulers);
      const clipTypes = (inputs?.optional?.override_clip_type?.[0] ?? []).filter(v => v !== "(preset)");
      if (clipTypes.length) this._fillSelect("sb-clip-type", clipTypes);
      const modelSamplingOpts = (inputs?.optional?.override_model_sampling?.[0] ?? []).filter(v => v !== "(preset)");
      if (modelSamplingOpts.length) this._fillSelect("sb-model-sampling", modelSamplingOpts);
    } catch {
      this._fillSelect("sb-sampler",   ["euler","euler_ancestral","dpmpp_2m","dpmpp_sde","ddim"]);
      this._fillSelect("sb-scheduler", ["normal","karras","exponential","sgm_uniform","simple"]);
    }

    // Populate CLIP and VAE dropdowns from dedicated endpoints
    try {
      const [clipRes, vaeRes] = await Promise.all([
        apiFetch("/cwk/clips"),
        apiFetch("/cwk/vaes"),
      ]);
      if (clipRes.clips?.length) this._fillSelect("sb-clip-name", clipRes.clips);
      if (vaeRes.vaes?.length)   this._fillSelect("sb-vae-name",  vaeRes.vaes);
    } catch (e) {
      console.warn("[CWK] Could not load CLIP/VAE lists:", e);
    }
  }

  _fillSelect(id, opts) {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = opts.map(o => `<option value="${o}">${o}</option>`).join("");
  }

  // ── Events ────────────────────────────────────────────────────────────────────

  _bindEvents() {
    document.getElementById("cwk-close-btn")
      .addEventListener("click", () => this.hide());
    this._overlay
      .addEventListener("click", () => this.hide());
    document.getElementById("cwk-search")
      .addEventListener("input", debounce(e => this._applyFilter(e.target.value)));

    document.getElementById("cwk-filter-favorite")
      .addEventListener("change", e => {
        this._filterFavorite = e.target.checked;
        this._applyFilter(document.getElementById("cwk-search")?.value ?? "");
      });

    document.getElementById("cwk-api-key-label")
      .addEventListener("click", () => this._promptForKey());

    document.getElementById("cwk-validate-key-btn")
      .addEventListener("click", async () => {
        if (!this._civitaiKey) { this._promptForKey("Set an API key first."); return; }
        this._setStatus("Validating API key…");
        try {
          const res = await apiFetch(
            `/cwk/civitai/validate?key=${encodeURIComponent(this._civitaiKey)}`
          );
          this._setStatus(res.ok ? "✓ API key is valid!" : `✗ ${res.error}`, !res.ok);
        } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
      });

    document.getElementById("cwk-clear-cache-btn")
      .addEventListener("click", async () => {
        if (!confirm("Clear all cached metadata?")) return;
        try { await fetch("/cwk/civitai/cache", { method: "DELETE" }); }
        catch (e) { this._setStatus(`✗ ${e.message}`, true); return; }
        this._fetchCivitAI(false, false);
      });

    document.getElementById("cwk-fetch-btn")
      .addEventListener("click", () => this._fetchCivitAI(false, false));

    document.getElementById("cwk-rebuild-btn")
      .addEventListener("click", () => {
        if (!confirm(
          "Re-fetch ALL metadata from CivitAI?\n\nThis ignores the local cache and overwrites everything (favorites and manual overrides are preserved)."
        )) return;
        this._fetchCivitAI(true, true);
      });

    // ── Reload Models button ───────────────────────────────────────────────────
    document.getElementById("cwk-reload-btn")
      .addEventListener("click", async () => {
        const btn = document.getElementById("cwk-reload-btn");
        btn.disabled    = true;
        btn.textContent = "Reloading…";
        await this._reloadModels();
        await this._fetchNewModelThumbnails();
        btn.disabled    = false;
        btn.textContent = "🔄 Reload Models";
      });

    document.getElementById("cwk-updates-btn")
      .addEventListener("click", () => this._checkUpdates());

    document.getElementById("cwk-edit-btn")
      .addEventListener("click", () => this._toggleEdit());
    document.getElementById("cwk-save-preset-btn")
      .addEventListener("click", () => this._savePreset());
    document.getElementById("cwk-load-model-btn")
      .addEventListener("click", () => this._loadModel());
  }

  // ── Open / close ──────────────────────────────────────────────────────────────

  async open(onLoadCallback) {
    this._onLoadCallback = onLoadCallback;

    try {
      const s = JSON.parse(localStorage.getItem("cwk_panel_size") || "null");
      if (s?.w && s?.h) {
        this._panel.style.width  = Math.max(520, s.w) + "px";
        this._panel.style.height = Math.max(400, s.h) + "px";
      }
    } catch {}

    try {
      const p = JSON.parse(localStorage.getItem("cwk_panel_pos") || "null");
      if (p?.x != null && p?.y != null) {
        this._panel.style.transform = "none";
        this._panel.style.left = Math.min(Math.max(0, p.x), window.innerWidth  - 80) + "px";
        this._panel.style.top  = Math.min(Math.max(0, p.y), window.innerHeight - 80) + "px";
      }
    } catch {}

    this._setStatus("Loading models…");
    this._panel.classList.add("visible");
    this._overlay.classList.add("visible");
    try {
      this._models = await apiFetch("/cwk/models");
      this._applyFilter("");
      document.getElementById("cwk-total-count").textContent =
        `${this._models.length} model${this._models.length !== 1 ? "s" : ""}`;
      const withThumbs = this._models.filter(m => m.civitai?.thumbnail).length;
      if (!this._civitaiKey) {
        this._setStatus("⚠ Set a CivitAI API key (🔑) — required for fetching.", true);
      } else if (withThumbs) {
        this._setStatus(`${withThumbs} / ${this._models.length} with cached thumbnails`);
      } else {
        this._setStatus("Click 'Fetch Thumbnails/Infos' to load model images.");
      }
    } catch (e) {
      this._setStatus(`Error: ${e.message}`, true);
    }
  }

  hide() {
    this._panel.classList.remove("visible");
    this._overlay.classList.remove("visible");
    this._setEditMode(false);
    this._fetchAbort?.abort();
    this._fetchAbort = null;
    this._setProgress(0, 0);
    document.getElementById("cwk-filter-type-menu")?.classList.remove("open");
  }

  // ── Reload model list ─────────────────────────────────────────────────────────

  async _reloadModels() {
    try {
      this._models = await apiFetch("/cwk/models");
      this._applyFilter(document.getElementById("cwk-search")?.value ?? "");
      document.getElementById("cwk-total-count").textContent =
        `${this._models.length} model${this._models.length !== 1 ? "s" : ""}`;
      this._setStatus(`✓ ${this._models.length} model${this._models.length !== 1 ? "s" : ""} loaded`);
    } catch (e) {
      this._setStatus(`✗ Reload failed: ${e.message}`, true);
    }
  }

  // ── Fetch thumbnails only for new models ──────────────────────────────────────

  async _fetchNewModelThumbnails() {
    if (!this._civitaiKey) return;

    const newModels = this._models.filter(m => !m.civitai?.thumbnail);
    if (!newModels.length) {
      this._setStatus("✓ All models already have thumbnails");
      return;
    }

    this._setStatus(`Fetching thumbnails for ${newModels.length} new model${newModels.length !== 1 ? "s" : ""}…`);

    this._fetchAbort?.abort();
    const abort = new AbortController();
    this._fetchAbort = abort;

    const total = newModels.length;
    for (const m of newModels) { m._resolving = true; this._updateCard(m); }
    this._setProgress(0, total);

    let resolved = 0, thumbsFound = 0, presetsPopulated = 0;

    try {
      const response = await fetch("/cwk/civitai/fetch/stream", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          models:  newModels.map(m => m.name),
          api_key: this._civitaiKey,
          force:   false,
          rebuild: false,
        }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let p; try { p = JSON.parse(line.slice(5)); } catch { continue; }

          if (p.error === "api_key_required" || p.error === "api_key_invalid") {
            this._setStatus(`✗ ${p.message}`, true);
            this._civitaiKey = "";
            localStorage.removeItem("cwk_civitai_key");
            this._updateKeyLabel();
            for (const m of newModels) { m._resolving = false; this._updateCard(m); }
            this._setProgress(0, 0);
            this._fetchAbort = null;
            return;
          }
          if (p.done && !p.model) break outer;

          const model = this._models.find(m => m.name === p.model);
          if (model) {
            model.civitai    = p.info;
            model._resolving = false;
            if (p.info?.thumbnail) thumbsFound++;
            if (p.preset_extracted) {
              presetsPopulated++;
              model.preset = { ...(model.preset || {}), ...p.preset_extracted };
            }
            this._updateCard(model);
          }
          resolved++;
          this._setProgress(resolved, total);
          this._setStatus(
            `Fetching… ${resolved} / ${total}` +
            (thumbsFound ? ` · ${thumbsFound} 🖼` : "") +
            (presetsPopulated ? ` · ${presetsPopulated} presets` : "")
          );
        }
      }

      this._setStatus(
        thumbsFound
          ? `✓ ${thumbsFound} thumbnail${thumbsFound !== 1 ? "s" : ""} fetched for new models` +
            (presetsPopulated ? ` · ${presetsPopulated} preset${presetsPopulated !== 1 ? "s" : ""} auto-populated` : "")
          : `✓ No thumbnails found for new models (not on CivitAI)`
      );

      // ── Auto-reload model list to refresh sidebar presets ─────────────
      await this._reloadModels();

    } catch (e) {
      if (e.name !== "AbortError") {
        this._setStatus(`✗ Thumbnail fetch failed: ${e.message}`, true);
      }
    } finally {
      for (const m of newModels) { m._resolving = false; }
      this._setProgress(0, 0);
      this._fetchAbort = null;
    }
  }

  // ── Filter ────────────────────────────────────────────────────────────────────

  _applyFilter(query) {
    const q  = query.toLowerCase().trim();
    const fm = this._filterMatch;

    this._filtered = this._models.filter(m => {
      if (q && !m.name.toLowerCase().includes(q)) return false;
      if (this._filterFavorite && !m.civitai?.favorite) return false;
      if (fm !== null) {
        const raw = (m.civitai?.base_model ?? "").toLowerCase();
        if (fm === "__others__") {
          const allKnown = BASE_MODEL_FILTERS
            .filter(f => Array.isArray(f.match))
            .flatMap(f => f.match);
          if (allKnown.some(s => raw.includes(s.toLowerCase()))) return false;
        } else {
          if (!fm.some(s => raw.includes(s.toLowerCase()))) return false;
        }
      }
      return true;
    });

    document.getElementById("cwk-shown-count").textContent =
      `${this._filtered.length} shown`;
    this._renderGrid();
  }

  _renderGrid() {
    const grid = document.getElementById("cwk-grid");
    grid.innerHTML = "";
    for (const m of this._filtered) grid.appendChild(this._buildCard(m));
  }

  // ── Card ──────────────────────────────────────────────────────────────────────

  _buildCard(model) {
    const nsfw       = isNsfwModel(model);
    const revealed   = nsfw ? !!this._revealed[model.name] : true;
    const shouldBlur = nsfw && !revealed;

    const card      = document.createElement("div");
    card.className  = "cwk-card"
      + (model.name === this._selected ? " selected"  : "")
      + (model._resolving              ? " resolving" : "")
      + (shouldBlur                    ? " blurred"   : "");
    card.dataset.name = model.name;

    const thumb       = model.civitai?.thumbnail;
    const badge       = model.type === "checkpoint" ? "CKPT" : "DIFF";
    const baseModel   = model.civitai?.base_model   ?? "";
    const versionName = model.civitai?.version_name ?? "";
    const displayName = model.civitai?.civitai_name
      ?? model.name.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
    const isFavorite  = !!model.civitai?.favorite;
    const hasUpdate   = !!model.civitai?.update_available;

    let mediaHtml = `<div class="cwk-card-placeholder">🖼</div>`;
    let videoIcon = "";
    if (thumb) {
      if (isVideoUrl(thumb)) {
        mediaHtml = `<video src="${thumb}" autoplay muted loop playsinline preload="metadata"></video>`;
        videoIcon = `<div class="cwk-card-video-icon">🎬</div>`;
      } else {
        mediaHtml = `<img src="${thumb}" alt="${displayName}" loading="lazy"/>`;
      }
    }

    const eyeHtml = nsfw
      ? `<button class="cwk-eye-btn" title="${revealed ? "Blur image" : "Reveal image"}">${revealed ? "🙈" : "👁"}</button>`
      : "";

    const starHtml = `<button class="cwk-star-btn${isFavorite ? " active" : ""}"
      title="${isFavorite ? "Remove from favorites" : "Add to favorites"}">★</button>`;

    const updateHtml = hasUpdate
      ? `<div class="cwk-update-badge" title="Update available on CivitAI">⬇</div>`
      : "";

    card.innerHTML = `
      <div class="cwk-card-top-left">
        <div class="cwk-card-badge">${badge}</div>
        ${updateHtml}
        ${eyeHtml}
      </div>
      ${starHtml}
      ${mediaHtml}
      ${videoIcon}
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
        this._revealed[model.name] = !this._revealed[model.name];
        localStorage.setItem("cwk_revealed", JSON.stringify(this._revealed));
        this._updateCard(model);
      });
    }

    card.querySelector(".cwk-star-btn").addEventListener("click", async e => {
      e.stopPropagation();
      const newFav = !model.civitai?.favorite;
      try {
        await apiFetch("/cwk/model/favorite", {
          method: "POST",
          body:   JSON.stringify({ model: model.name, favorite: newFav }),
        });
        if (!model.civitai) model.civitai = {};
        model.civitai.favorite = newFav;
        this._updateCard(model);
        if (this._filterFavorite) {
          this._applyFilter(document.getElementById("cwk-search")?.value ?? "");
        }
      } catch (err) { this._setStatus(`✗ ${err.message}`, true); }
    });

    card.addEventListener("click", () => this._selectModel(model.name));
    card.addEventListener("contextmenu", e => {
      e.preventDefault();
      this._showCardMenu(e.clientX, e.clientY, model);
    });

    return card;
  }

  _updateCard(model) {
    const el = document.querySelector(`.cwk-card[data-name="${CSS.escape(model.name)}"]`);
    if (el) el.replaceWith(this._buildCard(model));
  }

  // ── Context menu ──────────────────────────────────────────────────────────────

  _showCardMenu(x, y, model) {
    const hasImages  = (model.civitai?.images?.length ?? 0) > 0;
    const hasModelId = !!model.civitai?.model_id;
    const key        = this._civitaiKey;

    showContextMenu(x, y, [
      {
        icon: "ℹ️", label: "Model Info",
        action: () => showModelInfo(model, key),
      },
      "---",
      {
        icon: "🖼", label: "Pick thumbnail from CivitAI",
        disabled: !hasImages,
        action: async () => {
          let images = model.civitai?.images ?? [];
          if (!images.length) {
            try {
              const d = await apiFetch(
                `/cwk/civitai/images?model=${encodeURIComponent(model.name)}`
              );
              images = d.images ?? [];
            } catch { return; }
          }
          if (!images.length) { alert("No images available for this model."); return; }
          showImagePicker(model.name, images, async url => {
            try {
              await apiFetch("/cwk/civitai/thumbnail/set", {
                method: "POST",
                body:   JSON.stringify({ model: model.name, url }),
              });
              if (model.civitai) model.civitai.thumbnail = url;
              this._updateCard(model);
            } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
          });
        },
      },
      {
        icon: "📁", label: "Set local thumbnail…",
        action: () => {
          const input  = document.createElement("input");
          input.type   = "file";
          input.accept = "image/*,video/mp4,video/webm";
          input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            const fd = new FormData();
            fd.append("model", model.name);
            fd.append("file",  file, file.name);
            try {
              const res  = await fetch("/cwk/civitai/thumbnail/local",
                                       { method: "POST", body: fd });
              const data = await res.json();
              if (data.ok) {
                if (model.civitai) model.civitai.thumbnail = data.thumbnail;
                else model.civitai = { thumbnail: data.thumbnail };
                this._updateCard(model);
                this._setStatus("✓ Local thumbnail set");
              } else {
                this._setStatus(`✗ ${data.error}`, true);
              }
            } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
          };
          input.click();
        },
      },
      "---",
      {
        icon: "🔄", label: "Check for updates",
        disabled: !hasModelId,
        action: () => showVersionChecker(model.name, key, async (action, civitai, registeredName) => {
          if (action === "deleted") {
            this._setStatus("✓ Deleted — model removed from list");
            await this._reloadModels();
          } else {
            await new Promise(r => setTimeout(r, 500));
            await this._reloadModels();
            if (civitai && registeredName) {
              const m = this._models.find(m => m.name === registeredName);
              if (m) {
                m.civitai = civitai;
                this._updateCard(m);
                this._setStatus("✓ Download complete — thumbnail fetched");
              } else {
                this._setStatus("✓ Download complete — restart ComfyUI to load the model");
              }
            } else {
              this._setStatus("✓ Download complete — fetching thumbnail…");
              await this._fetchNewModelThumbnails();
            }
          }
        }),
      },
      {
        icon: "☁️", label: "Refresh CivitAI data",
        action: async () => {
          if (!key) { this._promptForKey("API key required to refresh."); return; }
          this._setStatus(`Refreshing ${model.name}…`);
          try {
            const res = await apiFetch("/cwk/civitai/refresh", {
              method: "POST",
              body:   JSON.stringify({ model: model.name, api_key: key }),
            });
            if (res.ok) {
              model.civitai = res.info;
              this._updateCard(model);
              this._setStatus(`✓ Refreshed: ${model.name}`);
            } else {
              this._setStatus(`✗ ${res.error}`, true);
            }
          } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
        },
      },
      "---",
      {
        icon: "🗑", label: "Delete model…", danger: true,
        action: async () => {
          if (!confirm(
            `Permanently delete "${model.name}" and all its cached data?\n\nThis cannot be undone.`
          )) return;
          try {
            const res = await apiFetch("/cwk/model", {
              method: "DELETE",
              body:   JSON.stringify({ model: model.name }),
            });
            if (res.ok) {
              this._models = this._models.filter(m => m.name !== model.name);
              this._applyFilter(document.getElementById("cwk-search")?.value ?? "");
              document.getElementById("cwk-total-count").textContent =
                `${this._models.length} model${this._models.length !== 1 ? "s" : ""}`;
              if (this._selected === model.name) this._selected = null;
              this._setStatus(`✓ Deleted: ${model.name}`);
            } else {
              this._setStatus(`✗ ${res.errors?.join(", ") || "Delete failed"}`, true);
            }
          } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
        },
      },
    ]);
  }

  // ── Sidebar preset ────────────────────────────────────────────────────────────

  _selectModel(name) {
    this._selected = name;
    this._setEditMode(false);
    document.querySelectorAll(".cwk-card").forEach(c =>
      c.classList.toggle("selected", c.dataset.name === name));
    const model = this._models.find(m => m.name === name);
    if (!model) return;
    const p = { ...DEFAULTS, ...model.preset };
    document.getElementById("sb-model-name").textContent = name;
    document.getElementById("sb-cfg").value              = p.cfg;
    document.getElementById("sb-steps").value            = p.steps;
    document.getElementById("sb-clip-skip").value        = p.clip_skip;
    document.getElementById("sb-width").value            = p.width;
    document.getElementById("sb-height").value           = p.height;
    this._setSelectValue("sb-sampler",         p.sampler_name);
    this._setSelectValue("sb-scheduler",       p.scheduler);
    this._setSelectValue("sb-rng",             p.rng ?? "cpu");
    this._setSelectValue("sb-model-sampling",  p.model_sampling ?? "eps");
    this._setSelectValue("sb-clip-name",       p.clip_name ?? "embedded");
    this._setSelectValue("sb-clip-type",       p.clip_type ?? "stable_diffusion");
    this._setSelectValue("sb-vae-name",        p.vae_name  ?? "embedded");
    this._setStatus(name);
  }

  _setSelectValue(id, value) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const opt = [...sel.options].find(o => o.value === value);
    if (opt) sel.value = value;
  }

  _getSidebarPreset() {
    return {
      sampler_name:   document.getElementById("sb-sampler").value,
      scheduler:      document.getElementById("sb-scheduler").value,
      cfg:            parseFloat(document.getElementById("sb-cfg").value),
      steps:          parseInt(document.getElementById("sb-steps").value, 10),
      clip_skip:      parseInt(document.getElementById("sb-clip-skip").value, 10),
      rng:            document.getElementById("sb-rng").value,
      model_sampling: document.getElementById("sb-model-sampling").value,
      width:          parseInt(document.getElementById("sb-width").value, 10),
      height:         parseInt(document.getElementById("sb-height").value, 10),
      clip_name:      document.getElementById("sb-clip-name").value,
      clip_type:      document.getElementById("sb-clip-type").value,
      vae_name:       document.getElementById("sb-vae-name").value,
    };
  }

  _toggleEdit() { this._setEditMode(!this._editMode); }

  _setEditMode(on) {
    this._editMode = on;
    for (const id of ["sb-sampler","sb-scheduler","sb-cfg","sb-steps",
                       "sb-clip-skip","sb-rng","sb-model-sampling","sb-width","sb-height",
                       "sb-clip-name","sb-clip-type","sb-vae-name"]) {
      const el = document.getElementById(id);
      if (el) el.disabled = !on;
    }
    document.getElementById("cwk-edit-btn").textContent = on ? "Cancel Edit" : "Edit Preset";
  }

  async _savePreset() {
    if (!this._selected) { this._setStatus("⚠ Select a model first", true); return; }
    try {
      this._setStatus("Saving…");
      await apiFetch("/cwk/preset", {
        method: "POST",
        body:   JSON.stringify({ model: this._selected, preset: this._getSidebarPreset() }),
      });
      const m = this._models.find(m => m.name === this._selected);
      if (m) m.preset = this._getSidebarPreset();
      this._setStatus(`✓ Preset saved for ${this._selected}`);
      this._setEditMode(false);
    } catch (e) { this._setStatus(`✗ ${e.message}`, true); }
  }

  _loadModel() {
    if (!this._selected) { this._setStatus("⚠ Select a model first", true); return; }
    this._onLoadCallback?.(this._selected);
    this.hide();
  }
  
    async _reloadModels() {
    try {
      const freshModels = await apiFetch("/cwk/models");
      // Preserve in-memory civitai data and resolving state
      for (const fresh of freshModels) {
        const existing = this._models.find(m => m.name === fresh.name);
        if (existing) {
          // Keep the civitai data we just fetched (it may be newer than server cache)
          fresh.civitai = existing.civitai || fresh.civitai;
          fresh._resolving = existing._resolving;
        }
      }
      this._models = freshModels;
      this._applyFilter(document.getElementById("cwk-search")?.value || "");
      document.getElementById("cwk-total-count").textContent =
        `${this._models.length} model${this._models.length !== 1 ? "s" : ""}`;
      // Re-select the currently selected model to refresh the sidebar
      if (this._selected) {
        const stillExists = this._models.find(m => m.name === this._selected);
        if (stillExists) {
          this._selectModel(this._selected);
        }
      }
    } catch (e) {
      console.warn("[CWK] Failed to reload models after fetch:", e);
    }
  }

  // ── Check Updates ──────────────────────────────────────────────────────────────

  async _checkUpdates() {
    if (!this._civitaiKey) {
      if (!this._promptForKey("CivitAI API key required to check updates.")) return;
    }
    const btn = document.getElementById("cwk-updates-btn");
    btn.disabled    = true;
    btn.textContent = "Checking…";
    this._setStatus("Checking for updates…");

    try {
      const res = await apiFetch("/cwk/civitai/check-updates", {
        method: "POST",
        body:   JSON.stringify({ api_key: this._civitaiKey }),
      });

      for (const m of this._models) {
        const meta = m.civitai;
        if (!meta) continue;
        const updated = res.updates?.find(u => u.name === m.name);
        if (updated) {
          meta.update_available  = true;
          meta.latest_version_id = updated.latest_version_id;
        } else if (meta.update_available !== undefined) {
          meta.update_available = false;
        }
        this._updateCard(m);
      }

      const count = res.count ?? 0;
      this._setStatus(
        count > 0
          ? `🔵 ${count} update${count !== 1 ? "s" : ""} available — cards marked with ⬇`
          : "✓ All models are up to date"
      );
    } catch (e) {
      this._setStatus(`✗ Update check failed: ${e.message}`, true);
    } finally {
      btn.disabled    = false;
      btn.textContent = "🔍 Check Updates";
    }
  }

  // ── CivitAI SSE fetch ─────────────────────────────────────────────────────────

  async _fetchCivitAI(force = false, rebuild = false) {
    if (!this._civitaiKey) {
      if (!this._promptForKey("CivitAI API key required.")) return;
    }

    this._fetchAbort?.abort();
    const abort = new AbortController();
    this._fetchAbort = abort;

    const btn  = document.getElementById("cwk-fetch-btn");
    const rBtn = document.getElementById("cwk-rebuild-btn");
    const orig  = btn.textContent;
    btn.innerHTML = `<span class="cwk-spinner"></span>Fetching…`;
    btn.disabled  = true;
    rBtn.disabled = true;

    const total = this._models.length;
    for (const m of this._models) { if (!m.civitai?.thumbnail) m._resolving = true; }
    this._renderGrid();
    this._setProgress(0, total);

    let resolved = 0, thumbsFound = 0, presetsPopulated = 0;

    try {
      const response = await fetch("/cwk/civitai/fetch/stream", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          models:  this._models.map(m => m.name),
          api_key: this._civitaiKey,
          force,
          rebuild,
        }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop();

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          let p; try { p = JSON.parse(line.slice(5)); } catch { continue; }

          if (p.error === "api_key_required" || p.error === "api_key_invalid") {
            this._setStatus(`✗ ${p.message}`, true);
            this._civitaiKey = "";
            localStorage.removeItem("cwk_civitai_key");
            this._updateKeyLabel();
            for (const m of this._models) { m._resolving = false; }
            this._renderGrid();
            this._setProgress(0, 0);
            this._fetchAbort = null;
            btn.innerHTML = orig; btn.disabled = false; rBtn.disabled = false;
            return;
          }
          if (p.done && !p.model) break outer;

          const model = this._models.find(m => m.name === p.model);
          if (model) {
            model.civitai    = p.info;
            model._resolving = false;
            if (p.info?.thumbnail) thumbsFound++;
            if (p.preset_extracted) {
              presetsPopulated++;
              // Update the in-memory preset so the sidebar shows new values
              model.preset = { ...(model.preset || {}), ...p.preset_extracted };
            }
            this._updateCard(model);
          }
          resolved++;
          this._setProgress(resolved, total);
          this._setStatus(
            `Fetching… ${resolved} / ${total}` +
            (thumbsFound ? ` · ${thumbsFound} 🖼` : "") +
            (presetsPopulated ? ` · ${presetsPopulated} presets` : "")
          );
        }
      }
      this._setStatus(
        `✓ Done — ${thumbsFound} thumbnail${thumbsFound !== 1 ? "s" : ""} found` +
        (presetsPopulated ? ` · ${presetsPopulated} preset${presetsPopulated !== 1 ? "s" : ""} auto-populated` : "") +
        (thumbsFound < total ? ` · ${total - thumbsFound} not on CivitAI` : "")
      );

      // ── Auto-reload model list to refresh sidebar presets ─────────────
      await this._reloadModels();

    } catch (e) {
      if (e.name !== "AbortError") {
        this._setStatus(`✗ Fetch failed: ${e.message}`, true);
        console.error("[CWK] SSE fetch error:", e);
      }
    } finally {
      for (const m of this._models) m._resolving = false;
      btn.innerHTML = orig; btn.disabled = false; rBtn.disabled = false;
      this._setProgress(0, 0); this._fetchAbort = null;
    }
  }

  // ── Status / progress ─────────────────────────────────────────────────────────

  _setStatus(msg, isError = false) {
    const el = document.getElementById("cwk-footer-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("error", isError);
  }

  _setProgress(current, total) {
    const wrap = document.getElementById("cwk-progress-wrap");
    const bar  = document.getElementById("cwk-progress-bar");
    if (!wrap || !bar) return;
    if (total === 0) {
      wrap.classList.remove("active"); bar.style.width = "0%";
    } else {
      wrap.classList.add("active");
      bar.style.width = `${Math.round(current / total * 100)}%`;
    }
  }
}