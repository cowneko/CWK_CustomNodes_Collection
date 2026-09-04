/**
 * CWK Preset Manager — Model Info Modal
 */

function _fmtBytes(bytes) {
  if (!bytes) return "N/A";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function _esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _isVideo(url) {
  if (!url) return false;
  const l = url.toLowerCase();
  return l.includes(".mp4") || l.includes(".webm");
}

// Blur threshold for gallery images:
//   0=None, 1=Soft, 2=Mature, 3=X/Explicit, 4=XXX
// Only blur X and above (level >= 3)
const _INFO_NSFW_BLUR = 3;

// ─── Known base model values for the dropdown ─────────────────────────────────
const _BASE_MODEL_OPTIONS = [
  "SDXL 1.0", "SDXL Turbo", "SDXL Lightning",
  "SD 1.5", "SD 1.5 LCM", "SD 1.5 Hyper",
  "Illustrious", "NoobAI",
  "Pony",
  "Flux.1 D", "Flux.1 S",
  "Chroma",
  "Wan Video",
  "Qwen",
  "ZImageBase", "ZImageTurbo",
  "Other",
];

function _makeOverlay() {
  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,.75);
    z-index:100000; display:flex; align-items:center; justify-content:center;
  `;
  return el;
}

function _injectInfoStyles() {
  if (document.getElementById("cwk-info-styles")) return;
  const st = document.createElement("style");
  st.id = "cwk-info-styles";
  st.textContent = `
    .cwk-info-box {
      background:#141824; border:1px solid #2a2f45; border-radius:12px;
      width:min(92vw,860px); max-height:88vh;
      display:flex; flex-direction:column;
      font-family:Inter,system-ui,sans-serif; color:#cdd6f4;
      box-shadow:0 24px 80px rgba(0,0,0,.75); overflow:hidden;
    }
    .cwk-info-header {
      background:#1a2035; border-bottom:1px solid #2a2f45;
      padding:16px 20px 12px; flex-shrink:0;
    }
    .cwk-info-title-row {
      display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
    }
    .cwk-info-model-name { font-size:20px; font-weight:700; color:#cdd6f4; flex:1; }
    .cwk-info-header-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
    .cwk-info-civitai-btn {
      display:inline-flex; align-items:center; gap:5px;
      padding:5px 12px; border-radius:6px;
      background:#313552; color:#89b4fa;
      font-size:12px; font-weight:600; text-decoration:none;
      border:1px solid #89b4fa; transition:background .15s;
    }
    .cwk-info-civitai-btn:hover { background:#2a2f45; }
    .cwk-info-close-btn {
      background:none; border:none; cursor:pointer;
      color:#6c7086; font-size:22px; line-height:1; padding:0 4px;
      transition:color .15s;
    }
    .cwk-info-close-btn:hover { color:#f38ba8; }

    .cwk-info-tags { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
    .cwk-info-tag {
      padding:2px 9px; border-radius:4px;
      background:#1e2335; border:1px solid #313552;
      font-size:11px; color:#89b4fa;
    }
    .cwk-info-tags-loading { font-size:11px; color:#6c7086; margin-top:10px; font-style:italic; }

    .cwk-info-body {
      flex:1; overflow-y:auto; padding:16px 20px;
      display:flex; flex-direction:column; gap:12px; min-height:0;
    }
    .cwk-info-body::-webkit-scrollbar { width:6px; }
    .cwk-info-body::-webkit-scrollbar-track { background:#141824; }
    .cwk-info-body::-webkit-scrollbar-thumb { background:#313552; border-radius:3px; }

    .cwk-info-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .cwk-info-cell {
      background:#1e2335; border:1px solid #313552; border-radius:8px;
      padding:10px 14px; min-width:0; overflow:hidden;
    }
    .cwk-info-cell-wide { grid-column:1/-1; }
    .cwk-info-cell-split {
      display:flex; background:#1e2335; border:1px solid #313552;
      border-radius:8px; overflow:hidden;
    }
    .cwk-info-cell-split > div { flex:1; padding:10px 14px; min-width:0; }
    .cwk-info-cell-split > div + div { border-left:1px solid #313552; }
    .cwk-info-label {
      font-size:10px; color:#6c7086; font-weight:700;
      text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px;
      display:flex; align-items:center; gap:6px;
    }
    .cwk-info-value {
      font-size:13px; color:#cdd6f4; font-weight:500;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .cwk-info-path { font-size:11px; color:#89b4fa; word-break:break-all; white-space:normal; }

    .cwk-info-about {
      background:#1e2335; border:1px solid #313552; border-radius:8px; padding:12px 14px;
    }
    .cwk-info-about-text {
      font-size:12px; color:#a6adc8; margin-top:6px; line-height:1.6; white-space:pre-wrap;
    }

    .cwk-info-tabs { display:flex; border-bottom:2px solid #2a2f45; flex-shrink:0; }
    .cwk-info-tab {
      padding:9px 20px; background:none; border:none; border-bottom:2px solid transparent;
      margin-bottom:-2px; color:#6c7086; font-size:13px; font-weight:600;
      cursor:pointer; transition:color .15s, border-color .15s;
    }
    .cwk-info-tab:hover { color:#cdd6f4; }
    .cwk-info-tab.active { color:#89b4fa; border-bottom-color:#89b4fa; }
    .cwk-info-tab-pane { display:none; padding-top:10px; }
    .cwk-info-tab-pane.active { display:block; }

    .cwk-info-image-grid {
      display:grid; grid-template-columns:repeat(auto-fill, minmax(130px,1fr)); gap:8px;
    }
    .cwk-info-image-card {
      position:relative; border-radius:6px; overflow:hidden; background:#1e2335;
      aspect-ratio:2/3; border:2px solid transparent; cursor:pointer; transition:border-color .15s;
    }
    .cwk-info-image-card:hover { border-color:#89b4fa; }
    .cwk-info-image-card img, .cwk-info-image-card video {
      width:100%; height:100%; object-fit:cover; display:block; transition:filter .2s;
    }
    .cwk-info-image-card.blurred img,
    .cwk-info-image-card.blurred video { filter:blur(14px) brightness(.6); }

    /* Eye button — always visible on NSFW cards, top-left corner */
    .cwk-info-eye-btn {
      position:absolute; top:5px; left:5px;
      background:rgba(20,24,36,.80); border:1px solid #313552;
      border-radius:4px; padding:2px 5px; font-size:12px;
      cursor:pointer; z-index:2; color:#cdd6f4;
      transition:background .15s; line-height:1.4;
      pointer-events:all;
    }
    .cwk-info-eye-btn:hover { background:rgba(137,180,250,.3); }

    /* Metadata button — bottom-right of each image card */
    .cwk-info-meta-btn {
      position:absolute; bottom:5px; right:5px;
      background:rgba(20,24,36,.85); border:1px solid #313552;
      border-radius:4px; padding:2px 6px; font-size:11px;
      cursor:pointer; z-index:2; color:#89b4fa;
      transition:background .15s, color .15s; line-height:1.4;
      pointer-events:all;
    }
    .cwk-info-meta-btn:hover { background:rgba(137,180,250,.25); color:#cdd6f4; }

    /* Metadata popup overlay */
    .cwk-meta-popup-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,.7);
      z-index:100002; display:flex; align-items:center; justify-content:center;
    }
    .cwk-meta-popup {
      background:#141824; border:1px solid #2a2f45; border-radius:10px;
      padding:20px; max-width:640px; width:90vw; max-height:80vh;
      overflow-y:auto; font-family:Inter,system-ui,sans-serif; color:#cdd6f4;
      box-shadow:0 16px 60px rgba(0,0,0,.8);
    }
    .cwk-meta-popup::-webkit-scrollbar { width:5px; }
    .cwk-meta-popup::-webkit-scrollbar-track { background:#141824; }
    .cwk-meta-popup::-webkit-scrollbar-thumb { background:#313552; border-radius:3px; }
    .cwk-meta-popup-header {
      display:flex; align-items:center; justify-content:space-between;
      margin-bottom:14px;
    }
    .cwk-meta-popup-title { font-size:15px; font-weight:700; color:#89b4fa; }
    .cwk-meta-popup-close {
      background:none; border:none; color:#6c7086; font-size:20px;
      cursor:pointer; transition:color .15s;
    }
    .cwk-meta-popup-close:hover { color:#f38ba8; }
    .cwk-meta-row { margin-bottom:12px; }
    .cwk-meta-row-label {
      font-size:10px; color:#6c7086; font-weight:700;
      text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px;
      display:flex; align-items:center; gap:6px;
    }
    .cwk-meta-row-value {
      background:#1e2335; border:1px solid #313552; border-radius:6px;
      padding:8px 10px; font-size:12px; color:#cdd6f4; line-height:1.5;
      white-space:pre-wrap; word-break:break-word;
    }
    .cwk-meta-copy-btn {
      background:none; border:1px solid #313552; border-radius:3px;
      color:#6c7086; font-size:11px; cursor:pointer; padding:1px 5px;
      transition:color .15s, border-color .15s;
    }
    .cwk-meta-copy-btn:hover { color:#89b4fa; border-color:#89b4fa; }
    .cwk-meta-params-grid {
      display:grid; grid-template-columns:repeat(auto-fill, minmax(120px,1fr)); gap:8px;
    }
    .cwk-meta-param {
      background:#1e2335; border:1px solid #313552; border-radius:6px;
      padding:8px 10px; text-align:center;
    }
    .cwk-meta-param-label {
      font-size:10px; color:#6c7086; font-weight:700;
      text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px;
    }
    .cwk-meta-param-value { font-size:13px; color:#cdd6f4; font-weight:600; }

    .cwk-info-desc-wrap { font-size:13px; color:#a6adc8; line-height:1.7; }
    .cwk-info-desc-wrap h1,.cwk-info-desc-wrap h2,.cwk-info-desc-wrap h3 {
      color:#cdd6f4; margin:.6em 0 .3em;
    }
    .cwk-info-desc-wrap p  { margin:.4em 0; }
    .cwk-info-desc-wrap a  { color:#89b4fa; }
    .cwk-info-desc-wrap img { max-width:100%; border-radius:4px; }
    .cwk-info-desc-wrap ul,.cwk-info-desc-wrap ol { padding-left:1.4em; }

    .cwk-info-placeholder { padding:24px; text-align:center; color:#6c7086; font-size:13px; }

    .cwk-lightbox {
      position:fixed; inset:0; background:rgba(0,0,0,.92);
      z-index:100001; display:flex; align-items:center; justify-content:center;
    }
    .cwk-lightbox img,.cwk-lightbox video {
      max-width:90vw; max-height:90vh; object-fit:contain; border-radius:6px;
    }
    .cwk-lightbox-close {
      position:absolute; top:20px; right:24px;
      background:none; border:none; color:#fff; font-size:28px; cursor:pointer;
    }

    /* ── NEW: Edit button for editable info cells ──────────────────────────── */
    .cwk-info-edit-btn {
      background:none; border:1px solid #313552; border-radius:3px;
      color:#6c7086; font-size:10px; cursor:pointer; padding:1px 5px;
      transition:color .15s, border-color .15s; margin-left:auto;
    }
    .cwk-info-edit-btn:hover { color:#89b4fa; border-color:#89b4fa; }
    .cwk-info-edit-input {
      width:100%; background:#141824; border:1px solid #89b4fa;
      border-radius:4px; color:#cdd6f4; font-size:13px; font-weight:500;
      padding:3px 6px; outline:none; font-family:Inter,system-ui,sans-serif;
      box-sizing:border-box;
    }
    .cwk-info-edit-select {
      width:100%; background:#141824; border:1px solid #89b4fa;
      border-radius:4px; color:#cdd6f4; font-size:13px; font-weight:500;
      padding:3px 6px; outline:none; font-family:Inter,system-ui,sans-serif;
      box-sizing:border-box; appearance:none; cursor:pointer;
    }
    .cwk-info-save-bar {
      display:flex; align-items:center; gap:8px; margin-top:8px;
    }
    .cwk-info-save-btn {
      padding:5px 14px; border-radius:5px; border:1px solid #a6e3a1;
      background:#1e2335; color:#a6e3a1; font-size:12px; font-weight:600;
      cursor:pointer; transition:background .15s;
    }
    .cwk-info-save-btn:hover { background:#2a2f45; }
    .cwk-info-save-btn:disabled { opacity:.5; cursor:default; }
    .cwk-info-save-status {
      font-size:11px; color:#a6e3a1; font-style:italic;
    }
  `;
  document.head.appendChild(st);
}

// ─── Tag rendering helper ─────────────────────────────────────────────────────

function _renderTagsInto(el, tags) {
  if (!el) return;
  if (!Array.isArray(tags) || !tags.length) {
    el.innerHTML = "";
    el.className = "";
    return;
  }
  el.className = "cwk-info-tags";
  el.innerHTML = tags.map(t => `<span class="cwk-info-tag">${_esc(t)}</span>`).join("");
}

// ─── Metadata popup for a single image ────────────────────────────────────────

function _showImageMetadata(imgObj) {
  const meta = imgObj?.meta;
  if (!meta || typeof meta !== "object") {
    alert("No generation metadata available for this image.");
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "cwk-meta-popup-overlay";

  const popup = document.createElement("div");
  popup.className = "cwk-meta-popup";

  // Header
  const header = document.createElement("div");
  header.className = "cwk-meta-popup-header";
  header.innerHTML = `
    <span class="cwk-meta-popup-title">📋 Image Generation Metadata</span>
    <button class="cwk-meta-popup-close" title="Close">✕</button>
  `;
  popup.appendChild(header);

  header.querySelector(".cwk-meta-popup-close").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  // ── Prompt fields (with copy button) ──────────────────────────────────────
  const prompt = meta.prompt || meta.Prompt || "";
  const negPrompt = meta.negativePrompt || meta.NegativePrompt || meta.negative_prompt || "";

  function _addPromptRow(label, text) {
    if (!text) return;
    const row = document.createElement("div");
    row.className = "cwk-meta-row";

    const labelEl = document.createElement("div");
    labelEl.className = "cwk-meta-row-label";
    labelEl.innerHTML = `${_esc(label)} `;

    const copyBtn = document.createElement("button");
    copyBtn.className = "cwk-meta-copy-btn";
    copyBtn.textContent = "📋 Copy";
    copyBtn.title = `Copy ${label} to clipboard`;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "✓ Copied!";
        setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 1500);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        copyBtn.textContent = "✓ Copied!";
        setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 1500);
      }
    });
    labelEl.appendChild(copyBtn);

    const valueEl = document.createElement("div");
    valueEl.className = "cwk-meta-row-value";
    valueEl.textContent = text;

    row.appendChild(labelEl);
    row.appendChild(valueEl);
    popup.appendChild(row);
  }

  _addPromptRow("Positive Prompt", prompt);
  _addPromptRow("Negative Prompt", negPrompt);

  // ── Generation parameters (grid of small cards) ───────────────────────────
  const params = [];

  const sampler = meta.sampler || meta.Sampler;
  if (sampler) params.push({ label: "Sampler", value: sampler });

  const scheduler = meta.scheduler || meta["Schedule type"] || meta.Scheduler;
  if (scheduler) params.push({ label: "Scheduler", value: scheduler });

  const cfg = meta.cfgScale ?? meta.CfgScale ?? meta.cfg;
  if (cfg !== undefined && cfg !== null) params.push({ label: "CFG Scale", value: String(cfg) });

  const steps = meta.steps ?? meta.Steps;
  if (steps !== undefined && steps !== null) params.push({ label: "Steps", value: String(steps) });

  const clipSkip = meta.clipSkip ?? meta.ClipSkip ?? meta.clip_skip;
  if (clipSkip !== undefined && clipSkip !== null) params.push({ label: "Clip Skip", value: String(clipSkip) });

  const seed = meta.seed ?? meta.Seed;
  if (seed !== undefined && seed !== null) params.push({ label: "Seed", value: String(seed) });

  const size = meta.Size || meta.size;
  if (size) params.push({ label: "Size", value: size });

  if (params.length > 0) {
    const paramsLabel = document.createElement("div");
    paramsLabel.className = "cwk-meta-row-label";
    paramsLabel.style.marginBottom = "8px";
    paramsLabel.textContent = "Generation Parameters";
    popup.appendChild(paramsLabel);

    const grid = document.createElement("div");
    grid.className = "cwk-meta-params-grid";

    for (const p of params) {
      const cell = document.createElement("div");
      cell.className = "cwk-meta-param";
      cell.innerHTML = `
        <div class="cwk-meta-param-label">${_esc(p.label)}</div>
        <div class="cwk-meta-param-value">${_esc(p.value)}</div>
      `;
      grid.appendChild(cell);
    }
    popup.appendChild(grid);
  }

  // ── No metadata at all ────────────────────────────────────────────────────
  if (!prompt && !negPrompt && params.length === 0) {
    const noData = document.createElement("div");
    noData.className = "cwk-info-placeholder";
    noData.textContent = "No generation metadata available for this image.";
    popup.appendChild(noData);
  }

  overlay.appendChild(popup);
  document.body.appendChild(overlay);
}

// ─── Check if image has metadata ──────────────────────────────────────────────

function _hasMetadata(imgObj) {
  const meta = imgObj?.meta;
  if (!meta || typeof meta !== "object") return false;
  return !!(
    meta.prompt || meta.Prompt ||
    meta.negativePrompt || meta.NegativePrompt || meta.negative_prompt ||
    meta.sampler || meta.Sampler ||
    meta.steps || meta.Steps ||
    meta.cfgScale || meta.CfgScale || meta.cfg ||
    meta.seed || meta.Seed
  );
}

// ─── Editable cell helper ─────────────────────────────────────────────────────

/**
 * Makes a cell's value editable. When the edit button is clicked, the value
 * element is replaced with an input (or select for base_model).
 * Returns an object { getValue } to read the current edited value.
 */
function _makeEditable(cell, fieldKey, currentValue, pendingEdits) {
  const labelEl = cell.querySelector(".cwk-info-label");
  const valueEl = cell.querySelector(".cwk-info-value");
  if (!labelEl || !valueEl) return;

  const editBtn = document.createElement("button");
  editBtn.className = "cwk-info-edit-btn";
  editBtn.textContent = "✏️";
  editBtn.title = "Edit this field";
  labelEl.appendChild(editBtn);

  editBtn.addEventListener("click", e => {
    e.stopPropagation();
    // Already editing?
    if (cell.querySelector(".cwk-info-edit-input, .cwk-info-edit-select")) return;

    const curVal = pendingEdits[fieldKey] ?? currentValue;

    if (fieldKey === "base_model") {
      // Render a <select> with known base model options + the current value
      const select = document.createElement("select");
      select.className = "cwk-info-edit-select";

      const options = [..._BASE_MODEL_OPTIONS];
      // If current value isn't in the list, add it at the top
      if (curVal && !options.some(o => o.toLowerCase() === curVal.toLowerCase())) {
        options.unshift(curVal);
      }
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        if (opt.toLowerCase() === curVal.toLowerCase()) o.selected = true;
        select.appendChild(o);
      }

      valueEl.textContent = "";
      valueEl.style.overflow = "visible";
      valueEl.appendChild(select);

      select.addEventListener("change", () => {
        pendingEdits[fieldKey] = select.value;
      });
      select.focus();
    } else {
      // Render a text <input>
      const input = document.createElement("input");
      input.type = "text";
      input.className = "cwk-info-edit-input";
      input.value = curVal;

      valueEl.textContent = "";
      valueEl.style.overflow = "visible";
      valueEl.appendChild(input);

      input.addEventListener("input", () => {
        pendingEdits[fieldKey] = input.value;
      });
      input.addEventListener("keydown", e => {
        if (e.key === "Escape") {
          // Revert
          delete pendingEdits[fieldKey];
          valueEl.textContent = currentValue;
          valueEl.style.overflow = "";
        }
        e.stopPropagation();
      });
      input.focus();
      input.select();
    }

    // Mark as dirty immediately
    if (!(fieldKey in pendingEdits)) {
      pendingEdits[fieldKey] = curVal;
    }

    editBtn.textContent = "↩";
    editBtn.title = "Cancel edit";
    editBtn._editing = true;

    // Replace click handler for cancel
    const origHandler = editBtn.onclick;
    editBtn.onclick = (ev) => {
      ev.stopPropagation();
      delete pendingEdits[fieldKey];
      valueEl.textContent = currentValue;
      valueEl.style.overflow = "";
      editBtn.textContent = "✏️";
      editBtn.title = "Edit this field";
      editBtn._editing = false;
      editBtn.onclick = null; // reset to let the addEventListener handle it again
    };
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function showModelInfo(model, civitaiApiKey = "") {
  _injectInfoStyles();

  const overlay = _makeOverlay();
  document.body.appendChild(overlay);

  const c           = model.civitai ?? {};
  const displayName = c.civitai_name
    ?? model.name.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  const baseModel   = c.base_model   ?? "Unknown";
  const versionName = c.version_name ?? "N/A";
  const shortDesc   = c.description  ?? "";
  const modelId     = c.model_id;
  const images      = c.images       ?? [];
  const fileName    = model.name.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "");
  const fullPath    = model.file_path || model.name;
  const sizeStr     = _fmtBytes(model.file_size ?? 0);
  const civitaiUrl  = modelId ? `https://civitai.com/models/${modelId}` : null;

  // NEW — [] is treated as "unknown, fetch to confirm":
  const tagsState = (Array.isArray(c.tags) && c.tags.length > 0) ? "ready" : "fetch";
  const initialTags = tagsState === "ready" ? c.tags : [];

  // ── Pending edits tracker ──────────────────────────────────────────────────
  const pendingEdits = {};

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const box = document.createElement("div");
  box.className = "cwk-info-box";

  box.innerHTML = `
    <div class="cwk-info-header">
      <div class="cwk-info-title-row">
        <span class="cwk-info-model-name">${_esc(displayName)}</span>
        <div class="cwk-info-header-actions">
          ${civitaiUrl
            ? `<a class="cwk-info-civitai-btn" href="${civitaiUrl}" target="_blank" rel="noopener">🌐 View on CivitAI</a>`
            : ""}
          <button class="cwk-info-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="cwk-tags-el" class="${initialTags.length ? "cwk-info-tags" : (tagsState === "fetch" && modelId ? "cwk-info-tags-loading" : "")}">
        ${initialTags.length
          ? initialTags.map(t => `<span class="cwk-info-tag">${_esc(t)}</span>`).join("")
          : (tagsState === "fetch" && modelId ? "Loading tags…" : "")}
      </div>
    </div>

    <div class="cwk-info-body">
      <div class="cwk-info-grid">
        <div class="cwk-info-cell" id="cwk-info-cell-version">
          <div class="cwk-info-label">Version</div>
          <div class="cwk-info-value">${_esc(versionName)}</div>
        </div>
        <div class="cwk-info-cell" id="cwk-info-cell-displayname">
          <div class="cwk-info-label">Display Name</div>
          <div class="cwk-info-value">${_esc(displayName)}</div>
        </div>
        <div class="cwk-info-cell cwk-info-cell-wide">
          <div class="cwk-info-label">Location</div>
          <div class="cwk-info-value cwk-info-path">${_esc(fullPath)}</div>
        </div>
        <div class="cwk-info-cell-split">
          <div id="cwk-info-cell-basemodel">
            <div class="cwk-info-label">Base Model</div>
            <div class="cwk-info-value">${_esc(baseModel)}</div>
          </div>
          <div>
            <div class="cwk-info-label">Size</div>
            <div class="cwk-info-value">${_esc(sizeStr)}</div>
          </div>
        </div>
      </div>

      <!-- Save bar for manual edits -->
      <div class="cwk-info-save-bar" id="cwk-info-save-bar" style="display:none;">
        <button class="cwk-info-save-btn" id="cwk-info-save-btn">💾 Save Changes</button>
        <span class="cwk-info-save-status" id="cwk-info-save-status"></span>
      </div>

      ${shortDesc ? `
        <div class="cwk-info-about">
          <div class="cwk-info-label">About this version</div>
          <div class="cwk-info-about-text">${_esc(shortDesc)}</div>
        </div>` : ""}

      <div class="cwk-info-tabs">
        <button class="cwk-info-tab active" data-tab="examples">Examples</button>
        <button class="cwk-info-tab" data-tab="description">Model Description</button>
      </div>

      <div id="cwk-info-pane-examples" class="cwk-info-tab-pane active">
        <div class="cwk-info-image-grid" id="cwk-info-image-grid">
          <div class="cwk-info-placeholder">Loading images…</div>
        </div>
      </div>

      <div id="cwk-info-pane-description" class="cwk-info-tab-pane">
        <div class="cwk-info-desc-wrap" id="cwk-info-desc-wrap">
          <div class="cwk-info-placeholder">Click to load description…</div>
        </div>
      </div>
    </div>
  `;

  overlay.appendChild(box);

  const tagsEl   = box.querySelector("#cwk-tags-el");
  const descWrap = box.querySelector("#cwk-info-desc-wrap");

  // ── Make cells editable ────────────────────────────────────────────────────
  const versionCell     = box.querySelector("#cwk-info-cell-version");
  const displayNameCell = box.querySelector("#cwk-info-cell-displayname");
  const baseModelCell   = box.querySelector("#cwk-info-cell-basemodel");

  _makeEditable(versionCell,     "version_name", versionName, pendingEdits);
  _makeEditable(displayNameCell, "civitai_name",  displayName, pendingEdits);
  _makeEditable(baseModelCell,   "base_model",    baseModel,   pendingEdits);

  // ── Show save bar when edits are pending ────────────────────────────────────
  const saveBar    = box.querySelector("#cwk-info-save-bar");
  const saveBtn    = box.querySelector("#cwk-info-save-btn");
  const saveStatus = box.querySelector("#cwk-info-save-status");

  // Use a MutationObserver + input events to detect when fields are being edited
  const _checkDirty = () => {
    const hasPending = Object.keys(pendingEdits).length > 0;
    saveBar.style.display = hasPending ? "flex" : "none";
  };

  // Poll for changes (simple approach — runs on user interactions within the grid)
  box.querySelector(".cwk-info-grid").addEventListener("input",  _checkDirty);
  box.querySelector(".cwk-info-grid").addEventListener("change", _checkDirty);
  box.querySelector(".cwk-info-grid").addEventListener("click",  () => setTimeout(_checkDirty, 50));

  saveBtn.addEventListener("click", async () => {
    const edits = { ...pendingEdits };
    if (Object.keys(edits).length === 0) return;

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    saveStatus.textContent = "";

    try {
      const res = await fetch("/cwk/civitai/meta/edit", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ model: model.name, edits }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      // Update the in-memory model object so the panel grid reflects changes
      if (!model.civitai) model.civitai = {};
      for (const [k, v] of Object.entries(edits)) {
        model.civitai[k] = v;
      }

      // Update the displayed values in the cells (revert from input to text)
      if (edits.version_name) {
        const ve = versionCell.querySelector(".cwk-info-value");
        ve.textContent = edits.version_name;
        ve.style.overflow = "";
      }
      if (edits.civitai_name) {
        const de = displayNameCell.querySelector(".cwk-info-value");
        de.textContent = edits.civitai_name;
        de.style.overflow = "";
        // Also update the header title
        box.querySelector(".cwk-info-model-name").textContent = edits.civitai_name;
      }
      if (edits.base_model) {
        const be = baseModelCell.querySelector(".cwk-info-value");
        be.textContent = edits.base_model;
        be.style.overflow = "";
      }

      // Clear pending edits
      for (const k of Object.keys(pendingEdits)) delete pendingEdits[k];
      saveBar.style.display = "none";

      saveStatus.textContent = "✓ Saved!";
      saveBtn.textContent = "💾 Save Changes";
      saveBtn.disabled = false;
      setTimeout(() => { saveStatus.textContent = ""; }, 2000);
    } catch (e) {
      saveStatus.textContent = `✗ ${e.message}`;
      saveStatus.style.color = "#f38ba8";
      saveBtn.textContent = "💾 Save Changes";
      saveBtn.disabled = false;
      setTimeout(() => {
        saveStatus.textContent = "";
        saveStatus.style.color = "";
      }, 3000);
    }
  });

  // ── Close ──────────────────────────────────────────────────────────────────
  box.querySelector(".cwk-info-close-btn").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  // ── Tags: fetch live from model-description endpoint when not in cache ──────
  if (tagsState === "fetch" && modelId) {
    const tagUrl = `/cwk/civitai/model-description?model=${encodeURIComponent(model.name)}`
      + (civitaiApiKey ? `&api_key=${encodeURIComponent(civitaiApiKey)}` : "");

    fetch(tagUrl)
      .then(r => r.json())
      .then(d => {
        console.log("[CWK] model-description response for tags:", d);
        const tags = Array.isArray(d.tags) ? d.tags : [];
        if (model.civitai) model.civitai.tags = tags;
        _renderTagsInto(tagsEl, tags);
      })
      .catch(err => {
        console.warn("[CWK] Failed to fetch tags:", err);
        if (tagsEl) tagsEl.innerHTML = "";
      });
  }

  // ── Tabs ──────────────────────────────────────────────────────────────────
  let descLoaded = false;

  box.querySelectorAll(".cwk-info-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      box.querySelectorAll(".cwk-info-tab").forEach(b => b.classList.remove("active"));
      box.querySelectorAll(".cwk-info-tab-pane").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      box.querySelector(`#cwk-info-pane-${btn.dataset.tab}`)?.classList.add("active");

      if (btn.dataset.tab === "description" && !descLoaded) {
        descLoaded = true;
        descWrap.innerHTML = `<div class="cwk-info-placeholder">Loading description…</div>`;

        if (!modelId) {
          descWrap.innerHTML = `<div class="cwk-info-placeholder">No CivitAI data — run Fetch Thumbnails first.</div>`;
          return;
        }

        const url = `/cwk/civitai/model-description?model=${encodeURIComponent(model.name)}`
          + (civitaiApiKey ? `&api_key=${encodeURIComponent(civitaiApiKey)}` : "");

        fetch(url)
          .then(r => r.json())
          .then(d => {
            if (d.error) {
              descWrap.innerHTML = `<div class="cwk-info-placeholder">⚠ ${_esc(d.error)}</div>`;
              return;
            }
            descWrap.innerHTML = d.description
              ? d.description
              : `<div class="cwk-info-placeholder">No description available on CivitAI.</div>`;
            if (tagsState === "fetch" && Array.isArray(d.tags) && tagsEl) {
              if (model.civitai) model.civitai.tags = d.tags;
              _renderTagsInto(tagsEl, d.tags);
            }
          })
          .catch(e => {
            descWrap.innerHTML = `<div class="cwk-info-placeholder">Failed to load: ${_esc(e.message)}</div>`;
          });
      }
    });
  });

  // ── Image grid ────────────────────────────────────────────────────────────
  const gridEl = box.querySelector("#cwk-info-image-grid");

  function _renderImages(imgs) {
    if (!imgs?.length) {
      gridEl.innerHTML = `<div class="cwk-info-placeholder">No example images available.</div>`;
      return;
    }
    gridEl.innerHTML = "";

    for (const img of imgs) {
      const url    = typeof img === "string" ? img : img.url;
      const lvl    = img?.nsfwLevel ?? 0;
      const isNsfw = lvl >= _INFO_NSFW_BLUR;
      const hasMeta = _hasMetadata(img);

      const card   = document.createElement("div");
      card.className = "cwk-info-image-card" + (isNsfw ? " blurred" : "");

      const mediaSrc = _isVideo(url)
        ? `<video src="${_esc(url)}" muted autoplay loop playsinline></video>`
        : `<img src="${_esc(url)}" loading="lazy"/>`;

      let buttonsHtml = "";
      if (isNsfw) {
        buttonsHtml += `<button class="cwk-info-eye-btn" title="Toggle blur">🙈</button>`;
      }
      if (hasMeta) {
        buttonsHtml += `<button class="cwk-info-meta-btn" title="View generation metadata">📋</button>`;
      }

      card.innerHTML = mediaSrc + buttonsHtml;

      if (isNsfw) {
        const eye = card.querySelector(".cwk-info-eye-btn");
        eye.addEventListener("click", e => {
          e.stopPropagation();
          const blurred = card.classList.toggle("blurred");
          eye.textContent = blurred ? "🙈" : "👁";
          eye.title       = blurred ? "Reveal image" : "Blur image";
        });
      }

      if (hasMeta) {
        const metaBtn = card.querySelector(".cwk-info-meta-btn");
        metaBtn.addEventListener("click", e => {
          e.stopPropagation();
          _showImageMetadata(img);
        });
      }

      // Click card → lightbox (only when not blurred)
      card.addEventListener("click", () => {
        if (card.classList.contains("blurred")) return;
        const lb = document.createElement("div");
        lb.className = "cwk-lightbox";
        lb.innerHTML = _isVideo(url)
          ? `<video src="${_esc(url)}" controls autoplay loop></video>`
          : `<img src="${_esc(url)}"/>`;
        const cls = document.createElement("button");
        cls.className = "cwk-lightbox-close"; cls.textContent = "✕";
        cls.onclick = () => lb.remove();
        lb.appendChild(cls);
        lb.addEventListener("click", e => { if (e.target === lb) lb.remove(); });
        document.body.appendChild(lb);
      });

      gridEl.appendChild(card);
    }
  }

  if (images.length > 0) {
    _renderImages(images);
  } else {
    fetch(`/cwk/civitai/images?model=${encodeURIComponent(model.name)}`)
      .then(r => r.json())
      .then(d => _renderImages(d.images ?? []))
      .catch(() => _renderImages([]));
  }
}