/**
 * CWK Preset Manager — CSS injection.
 */

export const PANEL_ID = "cwk-model-browser-panel";

export function injectStyles() {
  if (document.getElementById("cwk-styles")) return;
  const s = document.createElement("style");
  s.id = "cwk-styles";
  s.textContent = `
    #cwk-overlay {
      position:fixed; inset:0; background:rgba(0,0,0,.55);
      z-index:9998; display:none;
    }
    #cwk-overlay.visible { display:block; }

    #${PANEL_ID} {
      position:fixed; top:5%; left:5%;
      width:min(90vw,1100px); height:min(88vh,780px);
      min-width:520px; min-height:400px;
      background:#141824; border:1px solid #2a2f45; border-radius:10px;
      display:none; flex-direction:column; z-index:9999; overflow:hidden;
      font-family:Inter,system-ui,sans-serif; color:#cdd6f4;
      box-shadow:0 24px 80px rgba(0,0,0,.7);
      /*resize:both; box-sizing:border-box;*/
    }
    #${PANEL_ID}.visible { display:flex; }

    .cwk-header {
      display:flex; align-items:center; padding:12px 18px;
      background:#1a2035; border-bottom:1px solid #2a2f45; gap:10px;
      cursor:grab; user-select:none; flex-shrink:0;
    }
    .cwk-header.dragging { cursor:grabbing; }
    .cwk-header h2 {
      margin:0; font-size:15px; font-weight:600; flex:1;
      color:#cdd6f4; pointer-events:none;
    }
    .cwk-model-count { font-size:12px; color:#6c7086; pointer-events:none; }
    .cwk-close-btn {
      background:none; border:none; cursor:pointer;
      color:#6c7086; font-size:20px; line-height:1; padding:0 4px;
      transition:color .15s;
    }
    .cwk-close-btn:hover { color:#f38ba8; }

    .cwk-search-bar {
      display:flex; align-items:center; gap:10px;
      padding:10px 18px; background:#181d2e;
      border-bottom:1px solid #2a2f45; flex-shrink:0;
    }
    .cwk-search-bar label { font-size:13px; color:#89b4fa; font-weight:600; }
    .cwk-search-bar input {
      flex:1; background:#1e2335; border:1px solid #313552;
      border-radius:6px; color:#cdd6f4; padding:6px 10px;
      font-size:13px; outline:none;
    }
    .cwk-search-bar input:focus { border-color:#89b4fa; }
    .cwk-shown-count { font-size:12px; color:#6c7086; white-space:nowrap; }

    .cwk-body { display:flex; flex:1; overflow:hidden; min-height:0; }

    .cwk-grid-area {
      flex:1; overflow-y:auto; padding:14px;
      display:grid;
      grid-template-columns: repeat(auto-fill, minmax(275px, 1fr));
      grid-auto-rows: 400px;
      gap:10px; align-content:start; min-width:0;
    }
    .cwk-grid-area::-webkit-scrollbar { width:6px; }
    .cwk-grid-area::-webkit-scrollbar-track { background:#1a2035; }
    .cwk-grid-area::-webkit-scrollbar-thumb { background:#313552; border-radius:3px; }

    /* ── Cards ──────────────────────────────────────────────────── */
    .cwk-card {
      position:relative; background:#1e2335;
      border:2px solid transparent; border-radius:8px;
      overflow:hidden; cursor:pointer;
      transition:border-color .15s, transform .1s;
    }
    .cwk-card:hover    { border-color:#89b4fa; transform:scale(1.02); }
    .cwk-card.selected { border-color:#cba6f7; }

    .cwk-card img,
    .cwk-card video {
      width:100%; height:100%; object-fit:cover; display:block;
      transition:filter .25s;
    }
    .cwk-card.blurred img,
    .cwk-card.blurred video { filter:blur(16px) brightness(.6); }

    .cwk-card-placeholder {
      width:100%; height:100%;
      display:flex; align-items:center; justify-content:center;
      font-size:36px; color:#313552; background:#181d2e;
    }

    .cwk-card-footer {
      position:absolute; bottom:0; left:0; right:0;
      background:linear-gradient(transparent, rgba(10,12,20,.92));
      padding:22px 8px 7px;
    }
    .cwk-card-name {
      font-size:11px; font-weight:700; color:#cdd6f4;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .cwk-card-version {
      display:inline-block; margin-top:3px; padding:1px 6px;
      background:#1e2335; border:1px solid #313552; border-radius:4px;
      font-size:10px; color:#89b4fa; font-weight:600;
      max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }

    .cwk-card-video-icon {
      position:absolute; top:6px; right:6px;
      font-size:11px; opacity:.75; pointer-events:none; z-index:2;
    }

    .cwk-card.resolving .cwk-card-placeholder {
      animation:cwk-pulse 1.4s ease-in-out infinite;
    }
    @keyframes cwk-pulse { 0%,100%{opacity:.4} 50%{opacity:.9} }

    /* ── Top-left flex row: badge + update + eye ─────────────────── */
    .cwk-card-top-left {
      position:absolute; top:4px; left:4px;
      display:flex; align-items:center; gap:4px; z-index:3;
    }

    /* ── CKPT / DIFF badge ───────────────────────────────────────── */
    .cwk-card-badge {
      background:rgba(20,24,36,.8); border:1px solid #313552;
      border-radius:4px; padding:2px 6px;
      font-size:10px; font-weight:700; color:#89b4fa; letter-spacing:.04em;
    }

    /* ── Update available badge ──────────────────────────────────── */
    .cwk-update-badge {
      background:#1e66f5; border-radius:4px;
      width:18px; height:18px;
      display:flex; align-items:center; justify-content:center;
      font-size:11px; color:#fff; font-weight:700;
    }

    /* ── Eye (NSFW reveal) button — sits in top-left flex row ─────── */
    .cwk-eye-btn {
      background:rgba(20,24,36,.75); border:1px solid #313552;
      border-radius:4px; padding:1px 5px; font-size:11px; line-height:1.4;
      cursor:pointer; color:#cdd6f4; transition:background .15s;
    }
    .cwk-eye-btn:hover { background:rgba(137,180,250,.25); }

    /* ── Star (favourite) button — top-right, absolute ───────────── */
    .cwk-star-btn {
      position:absolute; top:4px; right:4px;
      background:rgba(20,24,36,.75); border:1px solid #313552;
      border-radius:4px; padding:1px 5px; font-size:14px; line-height:1.4;
      cursor:pointer; z-index:3; color:#6c7086;
      transition:color .15s, background .15s;
    }
    .cwk-star-btn:hover  { color:#f9e2af; background:rgba(249,226,175,.15); }
    .cwk-star-btn.active { color:#f9e2af; }

    /* ── Sidebar ─────────────────────────────────────────────────── */
    .cwk-sidebar {
      width:270px; flex-shrink:0; background:#181d2e;
      border-left:1px solid #2a2f45; padding:18px 16px;
      overflow-y:auto; display:flex; flex-direction:column; gap:6px;
      min-height:0;
    }
    .cwk-sidebar::-webkit-scrollbar { width:5px; }
    .cwk-sidebar::-webkit-scrollbar-track { background:#1a2035; }
    .cwk-sidebar::-webkit-scrollbar-thumb { background:#313552; border-radius:3px; }
    .cwk-sidebar-title {
      font-size:13px; font-weight:700; color:#89b4fa;
      text-decoration:underline; margin-bottom:2px;
    }
    .cwk-sidebar-row { display:flex; gap:12px; }
    .cwk-sidebar-col { flex:1; }
    .cwk-sidebar-input {
      width:100%; box-sizing:border-box;
      background:#1e2335; border:1px solid #313552;
      border-radius:6px; color:#cdd6f4; padding:5px 8px;
      font-size:13px; outline:none; transition:border-color .15s;
    }
    .cwk-sidebar-input:focus    { border-color:#89b4fa; }
    .cwk-sidebar-input:disabled { opacity:.6; cursor:default; }
    .cwk-sidebar select.cwk-sidebar-input { appearance:none; }

    /* ── Sidebar divider ─────────────────────────────────────────── */
    .cwk-sidebar-divider {
      border:none; border-top:1px solid #2a2f45; margin:4px 0;
    }
    .cwk-sidebar-section { margin-bottom:4px; }

    /* ── Favourite filter checkbox ───────────────────────────────── */
    .cwk-favorite-filter {
      display:flex; align-items:center; gap:7px;
      cursor:pointer; font-size:12px; color:#cdd6f4; user-select:none;
    }
    .cwk-favorite-filter input[type="checkbox"] {
      width:14px; height:14px; cursor:pointer; accent-color:#f9e2af;
    }

    /* ── Base model filter dropdown ──────────────────────────────── */
    .cwk-custom-select { position:relative; }
    .cwk-select-btn {
      width:100%; display:flex; align-items:center; justify-content:space-between;
      background:#1e2335; border:1px solid #313552; border-radius:6px;
      color:#cdd6f4; padding:5px 8px; font-size:12px;
      cursor:pointer; outline:none; transition:border-color .15s;
      white-space:nowrap; overflow:hidden;
    }
    .cwk-select-btn:hover { border-color:#89b4fa; }
    .cwk-select-btn span:first-child {
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;
    }
    .cwk-select-arrow { flex-shrink:0; margin-left:4px; font-size:10px; color:#6c7086; }
    .cwk-select-dropdown {
      display:none; position:absolute; top:calc(100% + 4px); left:0;
      min-width:100%; background:#1a2035; border:1px solid #313552;
      border-radius:7px; z-index:10001; padding:4px 0;
      box-shadow:0 8px 24px rgba(0,0,0,.6);
      max-height:260px; overflow-y:auto;
    }
    .cwk-select-dropdown.open { display:block; }
    .cwk-select-dropdown::-webkit-scrollbar { width:4px; }
    .cwk-select-dropdown::-webkit-scrollbar-track { background:#1a2035; }
    .cwk-select-dropdown::-webkit-scrollbar-thumb { background:#313552; border-radius:2px; }
    .cwk-select-option {
      padding:7px 12px; font-size:12px; cursor:pointer; color:#cdd6f4;
      transition:background .1s; white-space:nowrap;
    }
    .cwk-select-option:hover  { background:#2a2f45; }
    .cwk-select-option.active { color:#89b4fa; font-weight:600; }

    /* ── Footer ──────────────────────────────────────────────────── */
    .cwk-footer {
      display:flex; align-items:center; flex-wrap:wrap;
      padding:10px 18px; gap:8px; background:#1a2035;
      border-top:1px solid #2a2f45; flex-shrink:0;
    }
    .cwk-footer-status {
      flex:1; font-size:12px; color:#6c7086; min-width:80px;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    }
    .cwk-footer-status.error { color:#f38ba8; font-weight:600; }

    .cwk-progress-wrap {
      flex-basis:100%; height:3px;
      background:#2a2f45; border-radius:2px; display:none;
    }
    .cwk-progress-wrap.active { display:block; }
    .cwk-progress-bar {
      height:100%; background:#89b4fa; border-radius:2px;
      transition:width .3s ease;
    }

    /* ── Footer fetch button row ─────────────────────────────────── */
    .cwk-fetch-wrap { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }

    /* ── Buttons ─────────────────────────────────────────────────── */
    .cwk-btn {
      padding:7px 14px; border-radius:6px;
      font-size:13px; font-weight:600; border:none; cursor:pointer;
      transition:filter .15s, transform .1s; white-space:nowrap;
    }
    .cwk-btn:hover    { filter:brightness(1.15); }
    .cwk-btn:active   { transform:scale(.97); }
    .cwk-btn:disabled { opacity:.45; pointer-events:none; }
    .cwk-btn-secondary { background:#2a2f45; color:#cdd6f4; }
    .cwk-btn-primary   { background:#313552; color:#cdd6f4; }
    .cwk-btn-accent    { background:#f38ba8; color:#1e1e2e; }

    .cwk-api-key-area { display:flex; align-items:center; gap:6px; }
    .cwk-api-key-label {
      font-size:11px; color:#6c7086; cursor:pointer; transition:color .15s;
    }
    .cwk-api-key-label:hover   { color:#89b4fa; }
    .cwk-api-key-label.has-key { color:#a6e3a1; }
    .cwk-api-key-label.no-key  { color:#f38ba8; }
    .cwk-icon-btn {
      background:none; border:none; cursor:pointer;
      font-size:14px; padding:0 2px; line-height:1;
      color:#6c7086; transition:color .15s;
    }
    .cwk-icon-btn:hover { color:#cdd6f4; }
	
	    /* ── Resize handle ───────────────────────────────────────────── */
    #${PANEL_ID} {
      position:fixed; top:5%; left:5%;
      width:min(90vw,1100px); height:min(88vh,780px);
      min-width:520px; min-height:400px;
      background:#141824; border:1px solid #2a2f45; border-radius:10px;
      display:none; flex-direction:column; z-index:9999; overflow:hidden;
      font-family:Inter,system-ui,sans-serif; color:#cdd6f4;
      box-shadow:0 24px 80px rgba(0,0,0,.7);
      box-sizing:border-box;
    }

    /* ── Resize handle (same design as CWK_Prompt_Composer) ─────── */
    .cwk-resize-handle {
      position:absolute; right:0; bottom:0;
      width:0; height:0;
      border-style:solid; border-width:0 0 18px 18px;
      border-color:transparent transparent #45475a transparent;
      cursor:nwse-resize; z-index:10;
    }
    .cwk-resize-inner {
      position:absolute; right:1px; bottom:-17px;
      width:0; height:0;
      border-style:solid; border-width:0 0 12px 12px;
      border-color:transparent transparent #89b4fa transparent;
    }

    /* ── Spinner ─────────────────────────────────────────────────── */
    .cwk-spinner {
      display:inline-block; width:13px; height:13px;
      border:2px solid #313552; border-top-color:#89b4fa;
      border-radius:50%; animation:cwk-spin .7s linear infinite;
      vertical-align:middle; margin-right:5px;
    }
    @keyframes cwk-spin { to { transform:rotate(360deg) } }
  `;
  document.head.appendChild(s);
}