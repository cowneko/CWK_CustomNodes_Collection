import { PillCanvas, CATEGORY_COLORS, categoryColor } from "./cwk_prompt_composer_pill_canvas.js";
import { makeWindow } from "./cwk_prompt_composer_preset_manager.js";
import { wildcardLoader } from "./cwk_prompt_composer_wildcard_loader.js";

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
    bg:       "#1a1f2e",
    bgFull:   "#141824",
    surface:  "#1e2335",
    border:   "#313552",
    text:     "#cdd6f4",
    textDim:  "#6c7086",
    textBlue: "#89b4fa",
    hoverBg:  "#2a2f45",
};

const SECTION_COLORS = {
    quality:   "#f9e2af",
    style:     "#a6e3a1",
    aesthetic: "#cba6f7",
    main:      "#89dceb",
    negative:  "#f38ba8",
    wildcard:  "#94e2d5",
    custom:    "#cdd6f4",
};

const CATEGORY_ORDER = { quality: 0, style: 1, main: 2, custom: 3, wildcard: 3, aesthetic: 4, negative: 5 };

// ══════════════════════════════════════════════════════════════════════════════
//  TAG DATA CACHE
// ══════════════════════════════════════════════════════════════════════════════
const _tagCache = { quality: null, style: null, aesthetic: null, main: null, negative: null };
let _embeddingNames = null;

async function loadTagFile(key) {
    if (_tagCache[key]) return _tagCache[key];
    try {
        const res = await fetch(`/cwk/tags/${key}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        _tagCache[key] = text.split("\n").map(s => s.trim()).filter(Boolean);
    } catch (e) {
        console.error(`[CWK] Failed to load tags/${key}:`, e);
        _tagCache[key] = [];
    }
    return _tagCache[key];
}

export async function loadAllTags() {
    await Promise.all(["quality", "style", "aesthetic", "main", "negative"].map(k => loadTagFile(k)));
}

export function invalidateTagCache(key) {
    if (key) _tagCache[key] = null;
    else { _tagCache.quality = null; _tagCache.style = null; _tagCache.aesthetic = null; _tagCache.main = null; _tagCache.negative = null; }
}

async function loadEmbeddings() {
    if (_embeddingNames) return _embeddingNames;
    try {
        const res = await fetch("/cwk/embeddings");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _embeddingNames = await res.json();
    } catch (e) {
        console.error("[CWK] Failed to load embeddings:", e);
        _embeddingNames = [];
    }
    return _embeddingNames;
}

async function buildAutocompleteList() {
    const items = [];
    const seen  = new Set();
    for (const key of ["quality", "style", "aesthetic", "main", "negative"]) {
        const tags = await loadTagFile(key);
        for (const tag of tags) {
            if (seen.has(tag)) continue;
            seen.add(tag);
            items.push({ text: tag, category: key });
        }
    }
    const embeddings = await loadEmbeddings();
    for (const name of embeddings) {
        const t = `embedding:${name}`;
        if (!seen.has(t)) { seen.add(t); items.push({ text: t, category: "custom" }); }
    }
    return items;
}

// ── Caret position helper ────────────────────────────────────────────────────
function getCaretCoordinates(editableEl) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    const marker = document.createElement("span");
    marker.textContent = "\u200B";
    range.insertNode(marker);
    const rect   = marker.getBoundingClientRect();
    const coords = { left: rect.left, top: rect.bottom };
    marker.parentNode.removeChild(marker);
    sel.removeAllRanges();
    const restored = document.createRange();
    restored.setStart(range.startContainer, range.startOffset);
    restored.collapse(true);
    sel.addRange(restored);
    return coords;
}

// ── Clipboard helpers (non-secure-context fallback included) ────────────────
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for non-secure contexts (e.g. ComfyUI opened via LAN IP):
        // a detached textarea + execCommand still works everywhere.
        const ta = document.createElement("textarea");
        ta.value = text;
        Object.assign(ta.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch {}
        ta.remove();
        return ok;
    }
}

let _toastEl = null, _toastTimer = null;
function _toast(msg) {
    if (!_toastEl) {
        _toastEl = document.createElement("div");
        Object.assign(_toastEl.style, {
            position: "fixed", bottom: "16px", right: "16px", zIndex: "100001",
            background: "#1e2335", border: "1px solid #313552", borderRadius: "6px",
            padding: "6px 12px", fontSize: "12px", color: "#cdd6f4",
            fontFamily: "Inter, system-ui, sans-serif", pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)", display: "none",
        });
        document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.style.display = "block";
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { _toastEl.style.display = "none"; }, 1400);
}

// ══════════════════════════════════════════════════════════════════════════════
//  ✨ LLM PROMPT ENHANCEMENT — shared state & helpers
// ══════════════════════════════════════════════════════════════════════════════

let _llmSettings = null;   // global (server-persisted) settings; key never echoed
let _llmModels   = null;   // model ids from the endpoint (null = not fetched)

async function ensureLlmSettings() {
    if (_llmSettings) return _llmSettings;
    try {
        const r = await fetch("/cwk/pc/llm");
        if (r.ok) _llmSettings = await r.json();
    } catch {}
    _llmSettings ??= {
        provider: "ollama", base_url: "http://127.0.0.1:11434/v1",
        model: "dolphin3", temperature: 0.8, max_tokens: 500, timeout: 120,
    };
    return _llmSettings;
}

/** Tag-based vs natural-language — heuristic to preselect the dialog's mode. */
function detectPromptMode(text) {
    const t = (text || "").trim();
    if (!t) return "tag";
    if (/\.\s/.test(t)) return "nl";                          // sentence periods
    if (/\([^()]+:\d+(?:\.\d+)?\)/.test(t)) return "tag";      // weighted tags
    const segments = t.split(",").map(s => s.trim()).filter(Boolean);
    if (segments.length <= 1) return t.split(/\s+/).length > 8 ? "nl" : "tag";
    const avgWords = segments.reduce((a, s) => a + s.split(/\s+/).length, 0) / segments.length;
    return avgWords <= 4.5 ? "tag" : "nl";
}

// ══════════════════════════════════════════════════════════════════════════════
//  TAGGED PRESET SYSTEM — server-backed .json files
// ══════════════════════════════════════════════════════════════════════════════

async function loadTaggedPresets() {
    try {
        const res = await fetch("/cwk/presets");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.error("[CWK] Failed to load presets:", e);
        return {};
    }
}

async function saveTaggedPreset(name, category, pills) {
    try {
        const res = await fetch("/cwk/presets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, category, pills }),
        });
        return await res.json();
    } catch (e) {
        console.error("[CWK] Failed to save preset:", e);
        return { ok: false, error: e.message };
    }
}

async function deleteTaggedPreset(name) {
    try {
        const res = await fetch(`/cwk/presets/${encodeURIComponent(name)}`, { method: "DELETE" });
        return await res.json();
    } catch (e) {
        console.error("[CWK] Failed to delete preset:", e);
        return { ok: false, error: e.message };
    }
}

// ── Save Preset Dialog ───────────────────────────────────────────────────────
function openSavePresetDialog(pills, defaultCategory, onSaved) {
    const { win, backdrop, body, closeBtn } = makeWindow({
        title: "💾 Save Preset", width: "380px", height: "auto",
        minWidth: "300px", minHeight: "180px", zIndex: "10004",
    });
    Object.assign(win.style, { height: "auto" });

    const hide = () => { backdrop.style.display = "none"; win.style.display = "none"; win.remove(); backdrop.remove(); };
    closeBtn.addEventListener("click", hide);

    const mkLabel = (text) => {
        const l = document.createElement("label");
        l.textContent = text;
        Object.assign(l.style, { color: "#a6adc8", fontSize: "12px", fontWeight: "bold", fontFamily: "Inter, system-ui, sans-serif" });
        return l;
    };

    const nameInput = document.createElement("input");
    nameInput.type = "text"; nameInput.placeholder = "Preset name…";
    Object.assign(nameInput.style, {
        padding: "6px 10px", background: C.surface, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: "6px", fontSize: "13px",
        width: "100%", boxSizing: "border-box", outline: "none",
    });
    for (const evt of ["mousedown", "mouseup", "click", "keydown", "keyup"]) {
        nameInput.addEventListener(evt, (e) => e.stopPropagation());
    }

    const catSelect = document.createElement("select");
    Object.assign(catSelect.style, {
        padding: "6px 10px", background: C.surface, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: "6px", fontSize: "13px",
        cursor: "pointer", width: "100%",
    });
    for (const cat of ["quality", "style", "main", "aesthetic", "negative"]) {
        const o = document.createElement("option");
        o.value = cat;
        o.textContent = { quality: "⭐ Quality", style: "🎭 Style", main: "🖼️ Main", aesthetic: "🎨 Aesthetic", negative: "❌ Negative" }[cat];
        o.style.color = SECTION_COLORS[cat];
        if (cat === defaultCategory) o.selected = true;
        catSelect.appendChild(o);
    }
    for (const evt of ["mousedown", "mouseup", "click", "keydown"]) {
        catSelect.addEventListener(evt, (e) => e.stopPropagation());
    }

    const preview = document.createElement("div");
    Object.assign(preview.style, {
        display: "flex", flexWrap: "wrap", gap: "4px", padding: "6px",
        background: C.bgFull, borderRadius: "6px", border: `1px solid ${C.border}`,
        maxHeight: "80px", overflowY: "auto",
    });
    for (const p of pills) {
        const chip = document.createElement("span");
        const w = Math.round(p.weight * 10) / 10;
        chip.textContent = w !== 1.0 ? `(${p.text}:${w.toFixed(1)})` : p.text;
        Object.assign(chip.style, {
            padding: "2px 6px", borderRadius: "10px", fontSize: "11px",
            background: C.surface, color: SECTION_COLORS[p.category] || C.text,
            border: `1px solid ${(SECTION_COLORS[p.category] || C.text)}55`,
        });
        preview.appendChild(chip);
    }

    const status = document.createElement("div");
    Object.assign(status.style, { fontSize: "12px", minHeight: "16px", textAlign: "center" });

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "8px" });

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "💾 Save";
    Object.assign(saveBtn.style, {
        flex: "1", padding: "8px", background: "#89b4fa", color: "#141824",
        border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold",
        fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    Object.assign(cancelBtn.style, {
        flex: "1", padding: "8px", background: C.surface, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: "6px", cursor: "pointer",
        fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
    });
    cancelBtn.addEventListener("click", hide);

    saveBtn.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) { status.style.color = "#f9e2af"; status.textContent = "⚠️ Enter a name"; return; }

        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        status.textContent = "";

        const category = catSelect.value;
        const result = await saveTaggedPreset(name, category, pills.map(p => ({ text: p.text, weight: p.weight })));

        if (result.ok) {
            status.style.color = "#a6e3a1";
            status.textContent = `✅ Saved "${name}"`;
            if (onSaved) onSaved();
            setTimeout(hide, 800);
        } else if (result.duplicate) {
            status.style.color = "#f9e2af";
            status.textContent = "⚠️ Name already exists";
            saveBtn.disabled = false;
            saveBtn.textContent = "💾 Save";
        } else {
            status.style.color = "#f38ba8";
            status.textContent = `❌ ${result.error}`;
            saveBtn.disabled = false;
            saveBtn.textContent = "💾 Save";
        }
    });

    btnRow.append(saveBtn, cancelBtn);

    const grid = document.createElement("div");
    Object.assign(grid.style, { display: "flex", flexDirection: "column", gap: "10px" });
    grid.append(mkLabel("Name"), nameInput, mkLabel("Category"), catSelect, mkLabel("Tags"), preview, status, btnRow);
    body.appendChild(grid);

    backdrop.style.display = "block";
    win.style.display = "flex";
    win.style.left = "50%"; win.style.top = "140px"; win.style.transform = "translateX(-50%)";
    nameInput.focus();
}

// ── Preset Manager (tabbed) ──────────────────────────────────────────────────
function openPresetManager(onLoad) {
    const { win, backdrop, body, closeBtn } = makeWindow({
        title: "📋 Presets", width: "500px", height: "500px",
        minWidth: "380px", minHeight: "300px", zIndex: "10003",
    });

    const hide = () => { backdrop.style.display = "none"; win.style.display = "none"; win.remove(); backdrop.remove(); };
    closeBtn.addEventListener("click", hide);

    const TABS = [
        { key: "quality",   label: "⭐ Quality",   color: SECTION_COLORS.quality },
        { key: "style",     label: "🎭 Style",     color: SECTION_COLORS.style },
        { key: "main",      label: "🖼️ Main",      color: SECTION_COLORS.main },
        { key: "aesthetic", label: "🎨 Aesthetic", color: SECTION_COLORS.aesthetic },
        { key: "negative",  label: "❌ Negative",  color: SECTION_COLORS.negative },
    ];

    let activeTab = "quality";

    const tabBar = document.createElement("div");
    Object.assign(tabBar.style, { display: "flex", gap: "4px", flexShrink: "0", flexWrap: "wrap" });

    const tabBtns = {};
    for (const tab of TABS) {
        const btn = document.createElement("button");
        btn.textContent = tab.label;
        Object.assign(btn.style, {
            padding: "4px 12px", borderRadius: "6px 6px 0 0",
            border: `1px solid ${C.border}`, borderBottom: "none",
            fontSize: "11px", cursor: "pointer", fontWeight: "bold",
            fontFamily: "Inter, system-ui, sans-serif",
            background: C.surface, color: C.textDim,
        });
        btn.addEventListener("click", () => { activeTab = tab.key; renderTabs(); renderList(); });
        tabBar.appendChild(btn);
        tabBtns[tab.key] = btn;
    }

    const listContainer = document.createElement("div");
    Object.assign(listContainer.style, {
        flex: "1", minHeight: "0", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: "8px",
        borderTop: `1px solid ${C.border}`, paddingTop: "8px",
    });

    const loadingEl = document.createElement("div");
    Object.assign(loadingEl.style, { color: C.textDim, fontSize: "12px", textAlign: "center", padding: "20px 0" });
    loadingEl.textContent = "Loading presets…";

    let _presets = {};

    function renderTabs() {
        for (const tab of TABS) {
            const btn = tabBtns[tab.key];
            if (tab.key === activeTab) {
                btn.style.background = C.bgFull; btn.style.color = tab.color; btn.style.borderColor = tab.color;
            } else {
                btn.style.background = C.surface; btn.style.color = C.textDim; btn.style.borderColor = C.border;
            }
        }
    }

    function renderList() {
        listContainer.innerHTML = "";
        const filtered = Object.entries(_presets).filter(([_, v]) => v.category === activeTab);
        const tabColor = SECTION_COLORS[activeTab];

        if (filtered.length === 0) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { color: C.textDim, fontSize: "13px", textAlign: "center", padding: "30px 0" });
            empty.textContent = "No presets in this category";
            listContainer.appendChild(empty);
            return;
        }

        for (const [name, data] of filtered) {
            const card = document.createElement("div");
            Object.assign(card.style, {
                background: C.surface, borderRadius: "8px", border: `1px solid ${C.border}`, overflow: "hidden",
            });

            const header = document.createElement("div");
            Object.assign(header.style, { display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", cursor: "pointer" });

            const nameEl = document.createElement("span");
            nameEl.textContent = name;
            Object.assign(nameEl.style, {
                color: tabColor, fontSize: "13px", fontWeight: "bold",
                flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                fontFamily: "Inter, system-ui, sans-serif",
            });

            const countEl = document.createElement("span");
            countEl.textContent = `${data.pills.length} tags`;
            Object.assign(countEl.style, { color: C.textDim, fontSize: "11px", flexShrink: "0" });

            const loadBtn = document.createElement("button");
            loadBtn.textContent = "📥 Load";
            Object.assign(loadBtn.style, {
                padding: "3px 10px", background: "#1a2535", color: tabColor,
                border: `1px solid ${tabColor}55`, borderRadius: "4px",
                cursor: "pointer", fontSize: "11px", fontWeight: "bold",
                fontFamily: "Inter, system-ui, sans-serif", flexShrink: "0",
            });
            loadBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const pills = data.pills.map(p => ({ text: p.text, category: data.category, weight: p.weight }));
                onLoad(pills, data.category);
                loadBtn.textContent = "✅ Loaded";
                setTimeout(() => { loadBtn.textContent = "📥 Load"; }, 1000);
            });

            const delBtn = document.createElement("button");
            delBtn.textContent = "🗑";
            Object.assign(delBtn.style, {
                padding: "3px 8px", background: "#2a1525", color: "#f38ba8",
                border: "1px solid #f38ba855", borderRadius: "4px",
                cursor: "pointer", fontSize: "11px", flexShrink: "0",
            });
            delBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete preset "${name}"?`)) return;
                const result = await deleteTaggedPreset(name);
                if (result.ok) {
                    delete _presets[name];
                    renderList();
                } else {
                    alert(`❌ ${result.error || "Failed to delete"}`);
                }
            });

            header.append(nameEl, countEl, loadBtn, delBtn);

            const previewEl = document.createElement("div");
            Object.assign(previewEl.style, {
                display: "none", padding: "6px 10px", borderTop: `1px solid ${C.border}`,
                background: C.bgFull, flexWrap: "wrap", gap: "4px",
            });
            for (const p of data.pills) {
                const chip = document.createElement("span");
                const w = Math.round(p.weight * 10) / 10;
                chip.textContent = w !== 1.0 ? `(${p.text}:${w.toFixed(1)})` : p.text;
                Object.assign(chip.style, {
                    padding: "2px 6px", borderRadius: "10px", fontSize: "11px",
                    background: C.surface, color: tabColor,
                    border: `1px solid ${tabColor}55`, display: "inline-block",
                });
                previewEl.appendChild(chip);
            }

            let expanded = false;
            header.addEventListener("click", () => { expanded = !expanded; previewEl.style.display = expanded ? "flex" : "none"; });

            card.append(header, previewEl);
            listContainer.appendChild(card);
        }
    }

    const actionBar = document.createElement("div");
    Object.assign(actionBar.style, { display: "flex", gap: "6px", flexShrink: "0", flexWrap: "wrap" });

    const mkBtn = (text, bg, color, onClick) => {
        const btn = document.createElement("button");
        btn.textContent = text;
        Object.assign(btn.style, {
            padding: "4px 10px", background: bg, color,
            border: `1px solid ${C.border}`, borderRadius: "5px",
            cursor: "pointer", fontSize: "12px", fontFamily: "Inter, system-ui, sans-serif",
        });
        btn.addEventListener("click", onClick);
        return btn;
    };

    actionBar.appendChild(mkBtn("📦 Export All", "#1a2535", C.text, () => {
        const blob = new Blob([JSON.stringify(_presets, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = "cwk_presets.json"; a.click();
        URL.revokeObjectURL(url);
    }));

    actionBar.appendChild(mkBtn("📂 Import", "#1f2040", C.text, () => {
        const input = document.createElement("input"); input.type = "file"; input.accept = ".json";
        input.addEventListener("change", async () => {
            const file = input.files[0]; if (!file) return;
            try {
                const text = await file.text();
                const imported = JSON.parse(text);
                if (typeof imported !== "object" || Array.isArray(imported)) throw new Error("Invalid format");
                let count = 0, skipped = 0;
                for (const [k, v] of Object.entries(imported)) {
                    if (!v.category || !v.pills) continue;
                    if (_presets[k]) { skipped++; continue; }
                    const result = await saveTaggedPreset(k, v.category, v.pills);
                    if (result.ok) { _presets[k] = v; count++; }
                    else if (result.duplicate) skipped++;
                }
                alert(`✅ Imported ${count} preset(s).${skipped ? ` Skipped ${skipped} duplicate(s).` : ""}`);
                renderList();
            } catch (e) { alert("❌ Failed: " + e.message); }
        });
        input.click();
    }));

    body.append(tabBar, listContainer, actionBar);
    renderTabs();

    listContainer.appendChild(loadingEl);
    loadTaggedPresets().then(presets => {
        _presets = presets;
        renderList();
    });

    backdrop.style.display = "block";
    win.style.display = "flex";
    win.style.left = "50%"; win.style.top = "80px"; win.style.transform = "translateX(-50%)";
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXPORT DIALOG
// ══════════════════════════════════════════════════════════════════════════════
function openExportDialog() {
    const { win, backdrop, body, closeBtn } = makeWindow({
        title: "📤 Export Data", width: "400px", height: "auto",
        minWidth: "320px", minHeight: "200px", zIndex: "10004",
    });
    Object.assign(win.style, { height: "auto" });

    const hide = () => { backdrop.style.display = "none"; win.style.display = "none"; win.remove(); backdrop.remove(); };
    closeBtn.addEventListener("click", hide);

    const ITEMS = [
        { key: "quality",   label: "⭐ Quality Tags",   color: SECTION_COLORS.quality },
        { key: "style",     label: "🎭 Style Tags",     color: SECTION_COLORS.style },
        { key: "main",      label: "🖼️ Main Tags",      color: SECTION_COLORS.main },
        { key: "aesthetic", label: "🎨 Aesthetic Tags", color: SECTION_COLORS.aesthetic },
        { key: "negative",  label: "❌ Negative Tags",  color: SECTION_COLORS.negative },
        { key: "presets",   label: "📋 Prompt Presets", color: C.textBlue },
    ];

    const checkboxes = {};

    const grid = document.createElement("div");
    Object.assign(grid.style, { display: "flex", flexDirection: "column", gap: "8px" });

    const desc = document.createElement("div");
    desc.textContent = "Select items to export:";
    Object.assign(desc.style, { color: C.textDim, fontSize: "12px", fontFamily: "Inter, system-ui, sans-serif" });
    grid.appendChild(desc);

    for (const item of ITEMS) {
        const row = document.createElement("label");
        Object.assign(row.style, {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "6px 10px", borderRadius: "6px", cursor: "pointer",
            background: C.surface, border: `1px solid ${C.border}`,
            fontSize: "12px", color: item.color, fontFamily: "Inter, system-ui, sans-serif",
            userSelect: "none",
        });
        row.addEventListener("mouseenter", () => row.style.background = C.hoverBg);
        row.addEventListener("mouseleave", () => row.style.background = C.surface);

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.style.accentColor = item.color;
        for (const evt of ["mousedown", "mouseup", "click", "keydown"]) {
            cb.addEventListener(evt, (e) => e.stopPropagation());
        }

        const lbl = document.createElement("span");
        lbl.textContent = item.label;

        row.append(cb, lbl);
        grid.appendChild(row);
        checkboxes[item.key] = cb;
    }

    // Select All / None
    const selRow = document.createElement("div");
    Object.assign(selRow.style, { display: "flex", gap: "8px", justifyContent: "center" });

    const mkSmBtn = (text, onClick) => {
        const btn = document.createElement("button");
        btn.textContent = text;
        Object.assign(btn.style, {
            padding: "2px 10px", background: C.surface, color: C.textDim,
            border: `1px solid ${C.border}`, borderRadius: "4px",
            cursor: "pointer", fontSize: "11px", fontFamily: "Inter, system-ui, sans-serif",
        });
        btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return btn;
    };

    selRow.appendChild(mkSmBtn("Select All", () => {
        for (const cb of Object.values(checkboxes)) cb.checked = true;
    }));
    selRow.appendChild(mkSmBtn("Select None", () => {
        for (const cb of Object.values(checkboxes)) cb.checked = false;
    }));
    grid.appendChild(selRow);

    const status = document.createElement("div");
    Object.assign(status.style, { fontSize: "12px", minHeight: "16px", textAlign: "center" });

    const btnRow = document.createElement("div");
    Object.assign(btnRow.style, { display: "flex", gap: "8px" });

    const exportBtn = document.createElement("button");
    exportBtn.textContent = "📤 Export";
    Object.assign(exportBtn.style, {
        flex: "1", padding: "8px", background: "#89b4fa", color: "#141824",
        border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold",
        fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    Object.assign(cancelBtn.style, {
        flex: "1", padding: "8px", background: C.surface, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: "6px", cursor: "pointer",
        fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
    });
    cancelBtn.addEventListener("click", hide);

    exportBtn.addEventListener("click", async () => {
        const selected = Object.entries(checkboxes)
            .filter(([_, cb]) => cb.checked)
            .map(([key]) => key);

        if (selected.length === 0) {
            status.style.color = "#f9e2af";
            status.textContent = "⚠️ Select at least one item";
            return;
        }

        exportBtn.disabled = true;
        exportBtn.textContent = "Exporting…";
        status.textContent = "";

        try {
            const res = await fetch("/cwk/export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items: selected }),
            });
            const json = await res.json();

            if (!json.ok) {
                status.style.color = "#f38ba8";
                status.textContent = `❌ ${json.error}`;
                exportBtn.disabled = false;
                exportBtn.textContent = "📤 Export";
                return;
            }

            const data = json.data;
            let fileCount = 0;

            // Export each tag file as .txt
            for (const key of ["quality", "style", "main", "aesthetic", "negative"]) {
                if (data[key]) {
                    const content = data[key].join("\n") + "\n";
                    const blob = new Blob([content], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${key}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                    fileCount++;
                    // Small delay between downloads so browser doesn't block them
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            // Export presets as JSON
            if (data.presets) {
                const content = JSON.stringify(data.presets, null, 2);
                const blob = new Blob([content], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "cwk_presets.json";
                a.click();
                URL.revokeObjectURL(url);
                fileCount++;
            }

            status.style.color = "#a6e3a1";
            status.textContent = `✅ Exported ${fileCount} file(s)`;
            exportBtn.textContent = "✅ Done";
            setTimeout(hide, 1200);

        } catch (e) {
            status.style.color = "#f38ba8";
            status.textContent = `❌ ${e.message}`;
            exportBtn.disabled = false;
            exportBtn.textContent = "📤 Export";
        }
    });

    btnRow.append(exportBtn, cancelBtn);
    grid.append(status, btnRow);
    body.appendChild(grid);

    backdrop.style.display = "block";
    win.style.display = "flex";
    win.style.left = "50%"; win.style.top = "120px"; win.style.transform = "translateX(-50%)";
}

// ══════════════════════════════════════════════════════════════════════════════
//  TAG PICKER POPUP
// ══════════════════════════════════════════════════════════════════════════════
function openTagPicker({ title, key, onPick }) {
    const { win, backdrop, body, closeBtn } = makeWindow({
        title, width: "400px", height: "500px", minWidth: "300px", minHeight: "250px", zIndex: "10003",
    });
    const hide = () => { backdrop.style.display = "none"; win.style.display = "none"; win.remove(); backdrop.remove(); };
    closeBtn.addEventListener("click", hide);

    const searchInput = document.createElement("input");
    searchInput.type = "text"; searchInput.placeholder = "🔍 Filter tags…";
    Object.assign(searchInput.style, {
        padding: "6px 10px", background: C.bgFull, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: "6px", fontSize: "12px",
        width: "100%", boxSizing: "border-box", outline: "none", flexShrink: "0",
    });
    for (const evt of ["mousedown", "mouseup", "click", "keydown", "keyup"]) {
        searchInput.addEventListener(evt, (e) => e.stopPropagation());
    }

    const tagList = document.createElement("div");
    Object.assign(tagList.style, {
        flex: "1", minHeight: "0", overflowY: "auto", display: "flex",
        flexWrap: "wrap", gap: "4px", alignContent: "flex-start", padding: "4px 0",
    });

    const color = SECTION_COLORS[key] || C.text;
    const tags  = _tagCache[key] || [];

    function renderTags(filter) {
        tagList.innerHTML = "";
        const q = (filter || "").toLowerCase();
        for (const tag of tags) {
            if (q && !tag.toLowerCase().includes(q)) continue;
            const pill = document.createElement("div");
            Object.assign(pill.style, {
                display: "inline-flex", alignItems: "center", padding: "3px 8px",
                borderRadius: "12px", background: C.surface, border: `1px solid ${color}88`,
                color, fontSize: "11px", cursor: "pointer", userSelect: "none", transition: "all 0.1s",
            });
            pill.textContent = tag.replace(/_/g, " ");
            pill.addEventListener("mouseenter", () => { pill.style.background = `${color}22`; pill.style.borderColor = color; });
            pill.addEventListener("mouseleave", () => { pill.style.background = C.surface; pill.style.borderColor = `${color}88`; });
            pill.addEventListener("click", (e) => {
                e.stopPropagation(); onPick(tag);
                pill.style.background = `${color}44`;
                setTimeout(() => { pill.style.background = C.surface; }, 200);
            });
            tagList.appendChild(pill);
        }
        if (tagList.children.length === 0) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { color: C.textDim, fontSize: "12px", padding: "12px", textAlign: "center", width: "100%" });
            empty.textContent = q ? "No matching tags" : "No tags loaded";
            tagList.appendChild(empty);
        }
    }

    searchInput.addEventListener("input", () => renderTags(searchInput.value));
    renderTags("");

    body.append(searchInput, tagList);
    backdrop.style.display = "block";
    win.style.display = "flex";
    win.style.left = "50%"; win.style.top = "100px"; win.style.transform = "translateX(-50%)";
    searchInput.focus();
}

// ══════════════════════════════════════════════════════════════════════════════
//  PROMPT PANEL
// ══════════════════════════════════════════════════════════════════════════════

export class PromptPanel {
    constructor({ kind, onChange }) {
        this.kind     = kind;
        this.onChange  = onChange;
        this.mode     = "text";
        this._pills   = [];

        this._acData    = [];
        this._acResults = [];
        this._acIndex   = -1;
        this._acVisible = false;
        this._acReady   = false;
        this._renderTimer = null;
        this._weightSelIndices = null;
        this._weightSelTimer   = null;
        this._llmSaveTimer     = null;

        this.el = document.createElement("div");
        Object.assign(this.el.style, {
            display: "flex", flexDirection: "column", gap: "4px",
            flex: kind === "positive" ? "3 1 0" : "1 1 0",
            minHeight: "0", overflow: "hidden",
        });

        // ── Header wrapper (contains two rows) ──────────────────────────
        const headerWrapper = document.createElement("div");
        Object.assign(headerWrapper.style, {
            display: "flex", flexDirection: "column", gap: "3px", flexShrink: "0",
        });

        // ── Row 1: Title + Token counter ────────────────────────────────
        this._titleRow = document.createElement("div");
        Object.assign(this._titleRow.style, {
            display: "flex", alignItems: "center", gap: "6px",
        });

        const label = document.createElement("span");
        label.textContent = kind === "positive" ? "✅ POSITIVE" : "❌ NEGATIVE";
        Object.assign(label.style, {
            color: kind === "positive" ? "#a6e3a1" : "#f38ba8",
            fontSize: "11px", fontWeight: "bold",
            fontFamily: "Inter, system-ui, sans-serif", flex: "1",
        });
        this._titleRow.appendChild(label);

        // Token counter badge
        this._tokenBadge = document.createElement("span");
        Object.assign(this._tokenBadge.style, {
            fontSize: "10px", color: C.textDim, fontFamily: "monospace",
            padding: "1px 6px", background: C.surface, borderRadius: "8px",
            border: `1px solid ${C.border}`, flexShrink: "0", userSelect: "none",
        });
        this._tokenBadge.textContent = "0 tokens";
        this._titleRow.appendChild(this._tokenBadge);

        headerWrapper.appendChild(this._titleRow);

        // ── Row 2: Category buttons + Wildcards + Enhance + Edit Tags + ▼ ──
        this._btnRow = document.createElement("div");
        Object.assign(this._btnRow.style, {
            display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap",
        });

        if (kind === "positive") {
            this._btnRow.appendChild(this._mkHeaderBtn("⭐ Quality", SECTION_COLORS.quality, () => {
                openTagPicker({ title: "⭐ Quality Tags", key: "quality", onPick: (tag) => this._insertTag(tag, "quality") });
            }));
            this._btnRow.appendChild(this._mkHeaderBtn("🎭 Style", SECTION_COLORS.style, () => {
                openTagPicker({ title: "🎭 Style Tags", key: "style", onPick: (tag) => this._insertTag(tag, "style") });
            }));
            this._btnRow.appendChild(this._mkHeaderBtn("🎨 Aesthetic", SECTION_COLORS.aesthetic, () => {
                openTagPicker({ title: "🎨 Aesthetic Tags", key: "aesthetic", onPick: (tag) => this._insertTag(tag, "aesthetic") });
            }));
        } else {
            this._btnRow.appendChild(this._mkHeaderBtn("❌ Negative", SECTION_COLORS.negative, () => {
                openTagPicker({ title: "❌ Negative Tags", key: "negative", onPick: (tag) => this._insertTag(tag, "negative") });
            }));
        }

        this._btnRow.appendChild(this._mkHeaderBtn("📂 Wildcards", SECTION_COLORS.wildcard, () => {
            wildcardLoader.show((tag) => {
                if (tag) {
                    const wildcardTag = tag.startsWith("__") && tag.endsWith("__") ? tag : `__${tag}__`;
                    this._insertTag(wildcardTag, "wildcard");
                }
            });
        }));

        // ✨ AI Enhance (LLM)
        this._btnRow.appendChild(this._mkHeaderBtn("✨ Enhance", "#cba6f7", () => this._openEnhanceDialog()));

        this._toggleBtn = this._mkHeaderBtn("🏷 Edit Tags", C.textDim, () => this._toggleMode());
        this._toggleBtn.style.marginLeft = "auto";
        this._btnRow.appendChild(this._toggleBtn);

        // ▼ LLM options fold — extreme right, same convention as the other
        // CWK folds (▼ folded, ▲ unfolded)
        this._llmFoldBtn = this._mkHeaderBtn("▼", C.textDim, () => this._toggleLlmFold());
        this._llmFoldBtn.title = "AI Enhance (LLM) options";
        this._llmFoldBtn.style.padding = "2px 6px";
        this._btnRow.appendChild(this._llmFoldBtn);

        headerWrapper.appendChild(this._btnRow);

        // ── LLM settings fold (below the button row; collapsed by default.
        //    GLOBAL settings shared by every composer panel — values reload
        //    from the server on each open.) ──────────────────────────────
        this._llmFold = document.createElement("div");
        Object.assign(this._llmFold.style, {
            display: "none", flexDirection: "column", gap: "5px", flexShrink: "0",
            padding: "6px 8px", background: C.bgFull,
            border: `1px solid ${C.border}`, borderRadius: "6px",
            fontSize: "11px", fontFamily: "Inter, system-ui, sans-serif",
        });
        this._buildLlmFold();
        headerWrapper.appendChild(this._llmFold);

        this.el.appendChild(headerWrapper);

        // ── Toolbar ──────────────────────────────────────────────────────
        this._toolbar = document.createElement("div");
        Object.assign(this._toolbar.style, { display: "none", flexWrap: "wrap", gap: "4px", flexShrink: "0" });
        this._buildToolbar();
        this.el.appendChild(this._toolbar);

        // ── Text mode ────────────────────────────────────────────────────
        this._textContainer = document.createElement("div");
        Object.assign(this._textContainer.style, {
            position: "relative", flex: "1 1 0", minHeight: "0",
            display: "flex", flexDirection: "column", overflow: "hidden",
        });

        this._editor = document.createElement("div");
        this._editor.contentEditable = "true";
        this._editor.spellcheck = false;
        Object.assign(this._editor.style, {
            flex: "1 1 0", minHeight: "0", width: "100%",
            background: C.bgFull, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "6px",
            padding: "6px 8px", fontSize: "12px", fontFamily: "monospace",
            boxSizing: "border-box", outline: "none",
            overflowY: "auto", whiteSpace: "pre-wrap",
            wordBreak: "break-word", lineHeight: "1.6",
        });

        this._editor.addEventListener("input", () => this._onEditorInput());
        this._editor.addEventListener("keydown", (e) => this._onEditorKeydown(e));
        this._editor.addEventListener("blur", () => { setTimeout(() => this._hideAutocomplete(), 150); });
        for (const evt of ["mousedown", "mouseup", "click", "keydown", "keyup", "focus", "blur", "pointerdown"]) {
            this._editor.addEventListener(evt, (e) => e.stopPropagation());
        }

        // Text-mode right-click context menu
        this._textCtxMenu = null;
        this._editor.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._openTextCtxMenu(e);
        });

        this._acDropdown = document.createElement("div");
        Object.assign(this._acDropdown.style, {
            display: "none", position: "fixed", zIndex: "99999",
            maxHeight: "200px", width: "240px", overflowY: "auto",
            background: C.surface, border: `1px solid ${C.textBlue}`,
            borderRadius: "6px", boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        });
        document.body.appendChild(this._acDropdown);

        this._textContainer.appendChild(this._editor);
        this.el.appendChild(this._textContainer);

        // ── Pill mode ────────────────────────────────────────────────────
        this._pillCanvas = new PillCanvas((val) => {
            this._syncPillsFromCanvas();
            this.onChange(this.getValue());
            this._updateTokenCount();
        });

        // Unified context menu enhancer for pill canvas
        this._pillCanvas.onEnhanceCtxMenu = (menu, pill, divider) => {
            menu.appendChild(divider.cloneNode());

            // 📌 Add to Tag List (category submenu)
            this._appendAddToTagsSubmenu(menu, pill.text, pill.category);

            // Underscore ↔ Space toggle
            const hasUnderscore = pill.text.includes("_");
            const toggleItem = document.createElement("div");
            Object.assign(toggleItem.style, {
                display: "flex", alignItems: "center", gap: "8px",
                padding: "7px 10px", borderRadius: "5px", cursor: "pointer",
                fontSize: "12px", color: "#cdd6f4", userSelect: "none",
                fontFamily: "Inter, system-ui, sans-serif",
            });
            const tIcon = document.createElement("span"); tIcon.textContent = hasUnderscore ? "␣" : "_";
            const tLabel = document.createElement("span"); tLabel.textContent = hasUnderscore ? "Underscores → Spaces" : "Spaces → Underscores";
            toggleItem.append(tIcon, tLabel);
            toggleItem.addEventListener("mouseenter", () => toggleItem.style.background = "#2a2f45");
            toggleItem.addEventListener("mouseleave", () => toggleItem.style.background = "transparent");
            toggleItem.addEventListener("click", () => {
                this._pillCanvas._closeCtxMenu();
                if (hasUnderscore) pill.text = pill.text.replace(/_/g, " ");
                else pill.text = pill.text.replace(/ /g, "_");
                this._pillCanvas._render();
                this._syncPillsFromCanvas();
                this.onChange(this.getValue());
            });
            menu.appendChild(toggleItem);

            menu.appendChild(divider.cloneNode());

            // 💾 Save as Preset / 📋 Load Preset
            menu.appendChild(this._mkCtxItem("💾", "Save as Preset", () => {
                this._pillCanvas._closeCtxMenu();
                const selected = [...this._pillCanvas.selected];
                let pills = selected.length > 0
                    ? selected.map(id => this._pillCanvas.pills.find(p => p.id === id)).filter(Boolean)
                    : [pill];
                const defaultCat = pills[0]?.category || (this.kind === "negative" ? "negative" : "main");
                openSavePresetDialog(pills.map(p => ({ text: p.text, category: p.category, weight: p.weight })), defaultCat, null);
            }));
            menu.appendChild(this._mkCtxItem("📋", "Load Preset", () => {
                this._pillCanvas._closeCtxMenu();
                openPresetManager((pills, category) => this._smartInsertPills(pills, category));
            }));

            // ── 📋 Copy / Paste ──
            menu.appendChild(divider.cloneNode());
            const selIds     = [...this._pillCanvas.selected];
            const copyPills  = selIds.length > 0
                ? selIds.map(id => this._pillCanvas.pills.find(p => p.id === id)).filter(Boolean)
                : [pill];
            const copyLabel  = selIds.length > 1 ? `Copy Selected (${copyPills.length})` : "Copy Tag";
            menu.appendChild(this._mkCtxItem("📋", copyLabel, () => {
                this._pillCanvas._closeCtxMenu();
                this._copyToClipboard(
                    this._serializePills(copyPills),
                    selIds.length > 1 ? `${copyPills.length} tags` : "Tag");
            }));
            menu.appendChild(this._mkCtxItem("⧉", "Copy All", () => {
                this._pillCanvas._closeCtxMenu();
                this._copyToClipboard(this.getValue(), "Prompt");
            }));
            menu.appendChild(this._mkCtxItem("📥", "Paste", () => {
                this._pillCanvas._closeCtxMenu();
                this._pasteFromClipboard();
            }));
        };

        this._pillContainer = document.createElement("div");
        Object.assign(this._pillContainer.style, { display: "none", flex: "1 1 0", minHeight: "0", overflow: "hidden" });
        Object.assign(this._pillCanvas.el.style, { maxHeight: "none", flex: "1", minHeight: "0", overflowY: "auto" });
        this._pillContainer.appendChild(this._pillCanvas.el);
        this.el.appendChild(this._pillContainer);

        this._initAutocomplete();
    }

    destroy() {
        if (this._acDropdown && this._acDropdown.parentNode) {
            this._acDropdown.parentNode.removeChild(this._acDropdown);
        }
    }

    _mkCtxItem(icon, label, onClick) {
        const item = document.createElement("div");
        Object.assign(item.style, {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "7px 10px", borderRadius: "5px", cursor: "pointer",
            fontSize: "12px", color: "#cdd6f4", userSelect: "none",
            fontFamily: "Inter, system-ui, sans-serif",
        });
        const iconEl = document.createElement("span"); iconEl.textContent = icon;
        const labelEl = document.createElement("span"); labelEl.textContent = label;
        item.append(iconEl, labelEl);
        item.addEventListener("mouseenter", () => item.style.background = "#2a2f45");
        item.addEventListener("mouseleave", () => item.style.background = "transparent");
        item.addEventListener("click", () => onClick());
        return item;
    }

    // ── 📋 Clipboard operations ──────────────────────────────────────────────

    async _copyToClipboard(text, what) {
        const ok = await copyToClipboard(text);
        _toast(ok ? `📋 ${what} copied` : "❌ Copy failed");
    }

    async _pasteFromClipboard() {
        try {
            if (!(navigator.clipboard && window.isSecureContext)) throw new Error("no api");
            const text = await navigator.clipboard.readText();
            if (text && text.trim()) {
                this._insertClipboardText(text);
                _toast("📥 Pasted from clipboard");
            } else {
                _toast("⚠️ Clipboard is empty");
            }
        } catch {
            // readText denied or unavailable → manual paste dialog
            this._openPasteDialog();
        }
    }

    _insertClipboardText(text) {
        if (!text || !text.trim()) return;
        if (this.mode === "pill") {
            const pills = this._parseString(text);
            if (!pills.length) return;
            this._pillCanvas._snapshot?.();
            this._pillCanvas.pills.push(...pills.map(p => ({
                id: Math.random().toString(36).slice(2),
                text: p.text, category: p.category, weight: p.weight,
            })));
            this._syncPillsFromCanvas();
            this._pillCanvas._render();
        } else {
            this._pasteTextAtCaret(text.trim());
        }
        this.onChange(this.getValue());
        this._updateTokenCount();
    }

    _pasteTextAtCaret(text) {
        const wasFocused = document.activeElement === this._editor;
        this._editor.focus();
        if (wasFocused) {
            // Insert at caret / replace native selection — fires an input
            // event so the panel reparses; reparse defensively anyway.
            document.execCommand("insertText", false, text);
            this._onEditorInput();
        } else {
            // Editor wasn't focused (right-clicked without clicking in first)
            // → append at the end with a clean separator.
            const cur = this._getEditorPlainText().replace(/[,\s]+$/, "");
            const val = cur ? cur + ", " + text : text;
            this._pills = this._parseString(val);
            this._setEditorColored(val);
            this._setCaretOffset(val.length);
        }
    }

    _openPasteDialog() {
        const { win, backdrop, body, closeBtn } = makeWindow({
            title: "📥 Paste Prompt", width: "420px", height: "auto",
            minWidth: "300px", minHeight: "150px", zIndex: "10004",
        });
        Object.assign(win.style, { height: "auto" });
        const hide = () => { backdrop.style.display = "none"; win.style.display = "none"; win.remove(); backdrop.remove(); };
        closeBtn.addEventListener("click", hide);

        const desc = document.createElement("div");
        desc.textContent = "Clipboard access unavailable — paste below with Ctrl+V, then Insert:";
        Object.assign(desc.style, { color: "#a6adc8", fontSize: "12px", fontFamily: "Inter, system-ui, sans-serif" });

        const ta = document.createElement("textarea");
        ta.spellcheck = false;
        ta.placeholder = "tag1, (tag2:1.2), tag3…";
        Object.assign(ta.style, {
            width: "100%", boxSizing: "border-box", minHeight: "110px", resize: "vertical",
            background: C.bgFull, color: C.text, border: `1px solid ${C.border}`,
            borderRadius: "6px", padding: "6px 8px", fontSize: "12px",
            fontFamily: "monospace", outline: "none",
        });
        for (const evt of ["mousedown","mouseup","click","keydown","keyup","input","pointerdown"]) {
            ta.addEventListener(evt, (e) => e.stopPropagation());
        }

        const status = document.createElement("div");
        Object.assign(status.style, { fontSize: "12px", minHeight: "16px", textAlign: "center" });

        const btnRow = document.createElement("div");
        Object.assign(btnRow.style, { display: "flex", gap: "8px" });

        const insBtn = document.createElement("button");
        insBtn.textContent = "📥 Insert";
        Object.assign(insBtn.style, {
            flex: "1", padding: "8px", background: "#89b4fa", color: "#141824",
            border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold",
            fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
        });
        insBtn.addEventListener("click", () => {
            const text = ta.value.trim();
            if (!text) { status.style.color = "#f9e2af"; status.textContent = "⚠️ Nothing to paste"; return; }
            this._insertClipboardText(text);
            hide();
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        Object.assign(cancelBtn.style, {
            flex: "1", padding: "8px", background: C.surface, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "6px", cursor: "pointer",
            fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
        });
        cancelBtn.addEventListener("click", hide);

        ta.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); insBtn.click(); }
            if (e.key === "Escape") hide();
        });

        btnRow.append(insBtn, cancelBtn);
        body.append(desc, ta, status, btnRow);

        backdrop.style.display = "block";
        win.style.display = "flex";
        win.style.left = "50%"; win.style.top = "160px"; win.style.transform = "translateX(-50%)";
        ta.focus();
    }

    _mkHeaderBtn(text, color, onClick) {
        const btn = document.createElement("button");
        btn.textContent = text;
        Object.assign(btn.style, {
            padding: "2px 8px", background: C.surface, color,
            border: `1px solid ${C.border}`, borderRadius: "4px",
            cursor: "pointer", fontSize: "10px",
            fontFamily: "Inter, system-ui, sans-serif", flexShrink: "0",
        });
        btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
        return btn;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  ✨ LLM PROMPT ENHANCEMENT — fold (settings UI)
    // ══════════════════════════════════════════════════════════════════════

    _toggleLlmFold() {
        const open = this._llmFold.style.display === "none";
        this._llmFold.style.display = open ? "flex" : "none";
        this._llmFoldBtn.textContent = open ? "▲" : "▼";
        this._llmFoldBtn.title = open ? "Fold LLM options" : "Unfold LLM options";
        if (open) this._refreshLlmFold();   // always reload — settings are global
    }

    _buildLlmFold() {
        const inputCss = {
            flex: "1", padding: "3px 8px", background: C.surface, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "4px", fontSize: "11px",
            fontFamily: "Inter, system-ui, sans-serif", outline: "none",
            boxSizing: "border-box", minWidth: "0",
        };
        const blockEvents = (el) => {
            for (const evt of ["mousedown","mouseup","click","keydown","keyup",
                               "input","change","focus","blur","pointerdown"]) {
                el.addEventListener(evt, (e) => e.stopPropagation());
            }
        };
        const mkRow = (labelText) => {
            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px" });
            const l = document.createElement("span");
            Object.assign(l.style, { color: "#a6adc8", fontSize: "10px",
                                     fontWeight: "bold", width: "78px", flexShrink: "0" });
            l.textContent = labelText;
            row.appendChild(l);
            this._llmFold.appendChild(row);
            return row;
        };

        // Provider
        const provRow = mkRow("Provider");
        this._llmProvider = document.createElement("select");
        Object.assign(this._llmProvider.style, inputCss);
        for (const [val, label] of [["ollama", "Ollama (local)"], ["openai", "OpenAI-compatible"]]) {
            const o = document.createElement("option"); o.value = val; o.textContent = label;
            this._llmProvider.appendChild(o);
        }
        this._llmProvider.addEventListener("change", () => {
            // preset the typical base URL when switching provider
            this._llmUrl.value = this._llmProvider.value === "ollama"
                ? "http://127.0.0.1:11434/v1" : "https://openrouter.ai/api/v1";
            this._saveLlmDebounced();
            this._refreshLlmModels();
        });
        blockEvents(this._llmProvider);
        provRow.appendChild(this._llmProvider);

        // Base URL
        const urlRow = mkRow("Base URL");
        this._llmUrl = document.createElement("input");
        this._llmUrl.type = "text";
        Object.assign(this._llmUrl.style, inputCss);
        this._llmUrl.addEventListener("change", () => this._saveLlmDebounced());
        blockEvents(this._llmUrl);
        urlRow.appendChild(this._llmUrl);

        // API key (never echoed back by the server; empty = keep stored)
        const keyRow = mkRow("API Key");
        this._llmKey = document.createElement("input");
        this._llmKey.type = "password";
        Object.assign(this._llmKey.style, inputCss);
        this._llmKey.addEventListener("change", () => this._saveLlmDebounced());
        blockEvents(this._llmKey);
        keyRow.appendChild(this._llmKey);

        // Model + refresh
        const modelRow = mkRow("Model");
        this._llmModel = document.createElement("select");
        Object.assign(this._llmModel.style, inputCss);
        this._llmModel.addEventListener("change", () => this._saveLlmDebounced());
        blockEvents(this._llmModel);
        const modelRefresh = document.createElement("button");
        modelRefresh.textContent = "🔄";
        modelRefresh.title = "Fetch the model list from the endpoint";
        Object.assign(modelRefresh.style, {
            padding: "3px 8px", background: C.surface, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "4px",
            cursor: "pointer", fontSize: "11px", flexShrink: "0",
        });
        modelRefresh.addEventListener("click", (e) => { e.stopPropagation(); this._refreshLlmModels(); });
        blockEvents(modelRefresh);
        modelRow.append(this._llmModel, modelRefresh);

        // Temperature / Max tokens / Timeout — one row
        const tuneRow = mkRow("Sampling");
        const mkTiny = (txt, title) => {
            const sp = document.createElement("span");
            sp.textContent = txt; sp.title = title;
            Object.assign(sp.style, { fontSize: "10px", color: C.textDim, flexShrink: "0" });
            return sp;
        };
        const mkNum = (min, max, step, title) => {
            const inp = document.createElement("input");
            inp.type = "number"; inp.min = min; inp.max = max; inp.step = step;
            inp.title = title;
            Object.assign(inp.style, { ...inputCss, flex: "0 0 62px" });
            inp.addEventListener("change", () => this._saveLlmDebounced());
            blockEvents(inp);
            return inp;
        };
        this._llmTemp    = mkNum(0, 2, 0.1,    "Temperature (creativity)");
        this._llmMaxTok  = mkNum(50, 4096, 50, "Max tokens of the response");
        this._llmTimeout = mkNum(10, 600, 10,  "Timeout in seconds");
        tuneRow.append(mkTiny("T",   "Temperature"),        this._llmTemp,
                       mkTiny("Tok", "Max tokens"),          this._llmMaxTok,
                       mkTiny("s",   "Timeout (seconds)"),  this._llmTimeout);

        this._llmStatus = document.createElement("div");
        Object.assign(this._llmStatus.style, {
            fontSize: "10px", color: C.textDim, minHeight: "12px",
            textAlign: "left", paddingLeft: "84px", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
        });
        this._llmFold.appendChild(this._llmStatus);
    }

    async _refreshLlmFold() {
        await ensureLlmSettings();
        const s = _llmSettings;
        this._llmProvider.value = s.provider;
        this._llmUrl.value      = s.base_url;
        this._llmKey.value      = "";
        this._llmKey.placeholder = s.api_key_set ? "set — leave empty to keep" : "not set";
        this._llmTemp.value     = String(s.temperature);
        this._llmMaxTok.value   = String(s.max_tokens);
        this._llmTimeout.value  = String(s.timeout);
        this._fillLlmModelSelect();
        await this._refreshLlmModels();
    }

    _fillLlmModelSelect() {
        const cur = _llmSettings?.model || "";
        const ids = [...new Set([cur, ...(_llmModels ?? [])].filter(Boolean))].sort();
        this._llmModel.innerHTML = "";
        for (const id of ids) {
            const o = document.createElement("option");
            o.value = id; o.textContent = id;
            this._llmModel.appendChild(o);
        }
        this._llmModel.value = cur;
        if (this._llmModel.value !== cur && this._llmModel.options.length) {
            this._llmModel.selectedIndex = 0;
        }
    }

    async _refreshLlmModels() {
        if (!this._llmStatus) return;
        this._llmStatus.textContent = "Fetching models…";
        this._llmStatus.style.color = C.textDim;
        try {
            const res  = await fetch("/cwk/pc/llm/models");
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
            _llmModels = data.models || [];
            this._llmStatus.textContent = `✓ ${_llmModels.length} model(s) found`;
            this._llmStatus.style.color = "#a6e3a1";
        } catch (e) {
            _llmModels = null;
            this._llmStatus.textContent = `⚠ ${e.message}`;
            this._llmStatus.style.color = "#f38ba8";
        }
        this._fillLlmModelSelect();
    }

    _saveLlmDebounced() {
        clearTimeout(this._llmSaveTimer);
        this._llmSaveTimer = setTimeout(async () => {
            const payload = {
                provider:     this._llmProvider.value,
                base_url:    this._llmUrl.value.trim(),
                api_key:      this._llmKey.value,          // empty = keep stored
                model:        this._llmModel.value,
                temperature:  parseFloat(this._llmTemp.value),
                max_tokens:   parseInt(this._llmMaxTok.value, 10),
                timeout:      parseInt(this._llmTimeout.value, 10),
            };
            try {
                const res = await fetch("/cwk/pc/llm", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (res.ok) {
                    const j = await res.json();
                    if (j?.settings) _llmSettings = j.settings;
                    if (this._llmKey.value) {   // key now lives server-side only
                        this._llmKey.value = "";
                        this._llmKey.placeholder = "set — leave empty to keep";
                    }
                    if (this._llmStatus) {
                        this._llmStatus.textContent = "✓ Saved";
                        this._llmStatus.style.color = "#a6e3a1";
                    }
                }
            } catch {}
        }, 400);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  ✨ LLM PROMPT ENHANCEMENT — dialog
    // ══════════════════════════════════════════════════════════════════════

    async _openEnhanceDialog() {
        await ensureLlmSettings();
        const s = _llmSettings;
        const kindLabel = this.kind === "negative" ? "Negative" : "Positive";

        const { win, backdrop, body, closeBtn } = makeWindow({
            title: `✨ Enhance ${kindLabel} Prompt`, width: "580px", height: "auto",
            minWidth: "380px", minHeight: "220px", zIndex: "10004",
        });
        Object.assign(win.style, { height: "auto" });
        const hide = () => { backdrop.style.display = "none"; win.style.display = "none"; win.remove(); backdrop.remove(); };
        closeBtn.addEventListener("click", hide);

        const mkLabel = (text) => {
            const l = document.createElement("label");
            l.textContent = text;
            Object.assign(l.style, { color: "#a6adc8", fontSize: "12px", fontWeight: "bold",
                                     fontFamily: "Inter, system-ui, sans-serif" });
            return l;
        };
        const taCss = {
            width: "100%", boxSizing: "border-box", background: C.bgFull, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "6px", padding: "6px 8px",
            fontSize: "12px", fontFamily: "monospace", outline: "none", resize: "vertical",
        };
        const blockEvents = (el) => {
            for (const evt of ["mousedown","mouseup","click","keydown","keyup",
                               "input","change","focus","blur","pointerdown"]) {
                el.addEventListener(evt, (e) => e.stopPropagation());
            }
        };

        const modelInfo = document.createElement("div");
        modelInfo.textContent = `🤖 ${s.model} · ${s.temperature}° · ${s.max_tokens} tok — configure via ▼ in the panel header`;
        Object.assign(modelInfo.style, { color: C.textDim, fontSize: "11px",
                                         fontFamily: "Inter, system-ui, sans-serif" });

        const promptTa = document.createElement("textarea");
        promptTa.spellcheck = false;
        promptTa.value = this.getValue();
        promptTa.placeholder = "tag1, (tag2:1.2), … or a natural-language description";
        Object.assign(promptTa.style, { ...taCss, minHeight: "80px" });
        blockEvents(promptTa);

        const ctlRow = document.createElement("div");
        Object.assign(ctlRow.style, { display: "flex", gap: "8px", alignItems: "center" });

        const modeSel = document.createElement("select");
        Object.assign(modeSel.style, {
            flex: "1", padding: "4px 8px", background: C.surface, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "6px", fontSize: "12px",
            fontFamily: "Inter, system-ui, sans-serif", outline: "none", cursor: "pointer",
        });
        for (const [val, label] of [["tag", "🏷 Tag-based"], ["nl", "📝 Natural language"]]) {
            const o = document.createElement("option"); o.value = val; o.textContent = label;
            modeSel.appendChild(o);
        }
        modeSel.value = detectPromptMode(this.getValue());
        blockEvents(modeSel);

        const enhanceBtn = document.createElement("button");
        enhanceBtn.textContent = "✨ Enhance";
        Object.assign(enhanceBtn.style, {
            padding: "6px 16px", background: "#cba6f7", color: "#141824",
            border: "none", borderRadius: "6px", cursor: "pointer", fontWeight: "bold",
            fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif", flexShrink: "0",
        });

        ctlRow.append(modeSel, enhanceBtn);

        const status = document.createElement("div");
        Object.assign(status.style, { fontSize: "12px", minHeight: "16px", textAlign: "center" });

        const resultLabel = mkLabel("Enhanced result (editable):");
        resultLabel.style.display = "none";
        const resultTa = document.createElement("textarea");
        resultTa.spellcheck = false;
        Object.assign(resultTa.style, { ...taCss, minHeight: "100px", display: "none" });
        blockEvents(resultTa);

        const btnRow = document.createElement("div");
        Object.assign(btnRow.style, { display: "flex", gap: "8px" });

        const applyBtn = document.createElement("button");
        applyBtn.textContent = "✅ Apply (replaces the prompt)";
        applyBtn.disabled = true;
        applyBtn.style.opacity = "0.5";
        Object.assign(applyBtn.style, {
            flex: "1", padding: "8px", background: "#a6e3a1", color: "#141824",
            border: "none", borderRadius: "6px", fontWeight: "bold",
            fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif", cursor: "pointer",
        });

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Close";
        Object.assign(cancelBtn.style, {
            flex: "1", padding: "8px", background: C.surface, color: C.text,
            border: `1px solid ${C.border}`, borderRadius: "6px", cursor: "pointer",
            fontSize: "13px", fontFamily: "Inter, system-ui, sans-serif",
        });
        cancelBtn.addEventListener("click", hide);

        applyBtn.addEventListener("click", () => {
            const val = resultTa.value.trim();
            if (!val) return;
            this.setValue(val);              // re-parses: weights, categories
            this.onChange(this.getValue());  // notify the node
            hide();
        });

        enhanceBtn.addEventListener("click", async () => {
            const p = promptTa.value.trim();
            if (!p) { status.style.color = "#f9e2af"; status.textContent = "⚠️ Nothing to enhance"; return; }
            enhanceBtn.disabled = true;
            enhanceBtn.textContent = "⏳ …";
            const t0  = performance.now();
            const tick = setInterval(() => {
                status.style.color = C.textDim;
                status.textContent = `⏳ Enhancing with ${_llmSettings?.model}… ${Math.round((performance.now() - t0) / 1000)}s`;
            }, 500);
            status.textContent = `⏳ Enhancing with ${_llmSettings?.model}…`;
            try {
                const res = await fetch("/cwk/pc/enhance", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prompt: p, mode: modeSel.value, kind: this.kind }),
                });
                const data = await res.json();
                if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
                resultLabel.style.display = "";
                resultTa.style.display   = "";
                resultTa.value = data.prompt;
                applyBtn.disabled = false;
                applyBtn.style.opacity = "1";
                const secs  = Math.round((performance.now() - t0) / 1000);
                const usage = data.usage?.total_tokens ? ` · ${data.usage.total_tokens} tokens` : "";
                status.style.color = "#a6e3a1";
                status.textContent = `✓ Done in ${secs}s${usage} — review, then Apply`;
            } catch (e) {
                status.style.color = "#f38ba8";
                status.textContent = `❌ ${e.message}`;
            } finally {
                clearInterval(tick);
                enhanceBtn.disabled = false;
                enhanceBtn.textContent = "✨ Enhance";
            }
        });

        btnRow.append(applyBtn, cancelBtn);

        const grid = document.createElement("div");
        Object.assign(grid.style, { display: "flex", flexDirection: "column", gap: "8px" });
        grid.append(modelInfo, mkLabel("Prompt to enhance (editable):"),
                    promptTa, ctlRow, status, resultLabel, resultTa, btnRow);
        body.appendChild(grid);

        backdrop.style.display = "block";
        win.style.display = "flex";
        win.style.left = "50%"; win.style.top = "120px"; win.style.transform = "translateX(-50%)";
        promptTa.focus();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Serialization / value API
    // ══════════════════════════════════════════════════════════════════════

    _serializePills(pills) {
        return pills.map(p => {
            const w = Math.round(p.weight * 10) / 10;
            return w !== 1.0 ? `(${p.text}:${w.toFixed(1)})` : p.text;
        }).join(", ");
    }

    getValue() {
        return this._serializePills(this._pills);
    }

    setValue(str) {
        this._pills = this._parseString(str);
        this._syncToCurrentMode();
        this._updateTokenCount();
    }

    getState() {
        return { mode: this.mode, pills: JSON.parse(JSON.stringify(this._pills)) };
    }

    restoreState(state) {
        if (!state) return;
        this._pills = state.pills || [];
        this.mode = state.mode || "text";
        this._applyMode();
        this._syncToCurrentMode();
        this._updateTokenCount();
    }

    _findInsertIndex(category) {
        const targetOrder = CATEGORY_ORDER[category] ?? 3;
        if (targetOrder === 0) return 0;
        for (let i = 0; i < this._pills.length; i++) {
            const pillOrder = CATEGORY_ORDER[this._pills[i].category] ?? 3;
            if (pillOrder > targetOrder) return i;
        }
        return this._pills.length;
    }

    _smartInsertPills(pills, category) {
        const idx = this._findInsertIndex(category);
        this._pills.splice(idx, 0, ...pills);
        this.onChange(this.getValue());
        this._syncToCurrentMode();
        this._updateTokenCount();
    }

    _insertTag(tag, category) {
        const pill = { text: tag, category, weight: 1.0 };
        const idx  = this._findInsertIndex(category);
        this._pills.splice(idx, 0, pill);
        this.onChange(this.getValue());
        this._syncToCurrentMode();
        this._updateTokenCount();
    }

    _moveSelectedBlock(direction) {
        const pc      = this._pillCanvas;
        const selIds  = [...pc.selected];
        if (selIds.length === 0) return;
        const indices = selIds.map(id => pc.pills.findIndex(p => p.id === id)).filter(i => i !== -1).sort((a, b) => a - b);
        if (indices.length === 0) return;
        pc._snapshot();
        if (direction === "left") {
            if (indices[0] === 0) return;
            for (const idx of indices) { const temp = pc.pills[idx - 1]; pc.pills[idx - 1] = pc.pills[idx]; pc.pills[idx] = temp; }
        } else {
            if (indices[indices.length - 1] === pc.pills.length - 1) return;
            for (let i = indices.length - 1; i >= 0; i--) { const idx = indices[i]; const temp = pc.pills[idx + 1]; pc.pills[idx + 1] = pc.pills[idx]; pc.pills[idx] = temp; }
        }
        pc._render();
        pc.onChange(pc.getValue());
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Autocomplete
    // ══════════════════════════════════════════════════════════════════════

    async _initAutocomplete() {
        this._acData = await buildAutocompleteList();
        this._acReady = true;
    }

    _onEditorInput() {
        const raw = this._getEditorPlainText();
        this._pills = this._parseString(raw);
        this.onChange(this.getValue());
        clearTimeout(this._renderTimer);
        this._renderTimer = setTimeout(() => this._renderColoredText(), 500);
        const fragment = this._getCurrentFragment();
        if (fragment.length >= 2 && this._acReady) { this._showAutocomplete(fragment); }
        else { this._hideAutocomplete(); }
        this._updateTokenCount();
    }

    _getEditorPlainText() { return this._editor.innerText || ""; }

    _getCurrentFragment() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return "";
        const range = sel.getRangeAt(0);
        const preRange = document.createRange();
        preRange.setStart(this._editor, 0);
        preRange.setEnd(range.startContainer, range.startOffset);
        const before = preRange.toString();
        return before.substring(before.lastIndexOf(",") + 1).trim();
    }

    _showAutocomplete(query) {
        const q = query.toLowerCase().replace(/_/g, " ");
        const matches = [];
        const seen = new Set();
        for (const item of this._acData) {
            if (seen.has(item.text)) continue;
            const st = item.text.toLowerCase().replace(/_/g, " ");
            if (st.startsWith(q)) { seen.add(item.text); matches.push(item); }
            if (matches.length >= 50) break;
        }
        if (matches.length < 50) {
            for (const item of this._acData) {
                if (seen.has(item.text)) continue;
                const st = item.text.toLowerCase().replace(/_/g, " ");
                if (st.includes(q)) { seen.add(item.text); matches.push(item); }
                if (matches.length >= 50) break;
            }
        }
        if (matches.length === 0) { this._hideAutocomplete(); return; }

        this._acResults = matches;
        this._acIndex = -1;
        this._acVisible = true;
        this._acDropdown.innerHTML = "";

        const coords = getCaretCoordinates(this._editor);
        if (coords) {
            let left = coords.left;
            let top  = coords.top + 4;
            if (left + 240 > window.innerWidth - 8) left = window.innerWidth - 248;
            if (left < 4) left = 4;
            if (top + 200 > window.innerHeight - 8) top = coords.top - 204;
            this._acDropdown.style.left = left + "px";
            this._acDropdown.style.top  = top + "px";
        } else {
            const edRect = this._editor.getBoundingClientRect();
            this._acDropdown.style.left = edRect.left + "px";
            this._acDropdown.style.top  = (edRect.bottom + 4) + "px";
        }
        this._acDropdown.style.display = "block";

        matches.forEach((item, i) => {
            const row = document.createElement("div");
            Object.assign(row.style, {
                padding: "4px 8px", fontSize: "12px", cursor: "pointer",
                color: SECTION_COLORS[item.category] || C.text,
                fontFamily: "Inter, system-ui, sans-serif",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            });
            row.textContent = item.text.replace(/_/g, " ");
            const badge = document.createElement("span");
            badge.textContent = item.category;
            Object.assign(badge.style, { fontSize: "9px", color: C.textDim, marginLeft: "6px", fontStyle: "italic" });
            row.appendChild(badge);
            row.addEventListener("mouseenter", () => { this._acIndex = i; this._highlightAcItem(); });
            row.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); this._acceptAutocomplete(item); });
            this._acDropdown.appendChild(row);
        });
    }

    _hideAutocomplete() {
        this._acDropdown.style.display = "none";
        this._acVisible = false; this._acResults = []; this._acIndex = -1;
    }

    _highlightAcItem() {
        const ch = this._acDropdown.children;
        for (let i = 0; i < ch.length; i++) ch[i].style.background = i === this._acIndex ? C.hoverBg : "transparent";
    }

    _scrollAcIntoView() {
        const child = this._acDropdown.children[this._acIndex];
        if (child) child.scrollIntoView({ block: "nearest" });
    }

    _acceptAutocomplete(item) {
        const raw = this._getEditorPlainText();
        const caret = this._getCaretOffset();
        const before = raw.substring(0, caret);
        const after = raw.substring(caret);
        const lastComma = before.lastIndexOf(",");
        const prefix = before.substring(0, lastComma + 1);
        const needSpace = prefix.length > 0 && !prefix.endsWith(" ");
        const newVal = prefix + (needSpace ? " " : "") + item.text + ", " + after.replace(/^\s*,?\s*/, "");
        this._pills = this._parseString(newVal);
        this.onChange(this.getValue());
        this._setEditorColored(newVal);
        const newPos = prefix.length + (needSpace ? 1 : 0) + item.text.length + 2;
        this._setCaretOffset(newPos);
        this._hideAutocomplete();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Keydown / weight control
    // ══════════════════════════════════════════════════════════════════════

    _onEditorKeydown(e) {
        // Ctrl+Up/Down weight control in text mode
        if (e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !this._acVisible) {
            e.preventDefault();
            e.stopPropagation();
            const delta = e.key === "ArrowUp" ? 0.1 : -0.1;

            let indices = this._weightSelIndices;
            if (!indices || indices.length === 0) {
                indices = this._getSelectedTagIndices();
            }

            if (indices.length > 1) {
                this._weightSelIndices = indices;
                clearTimeout(this._weightSelTimer);
                this._weightSelTimer = setTimeout(() => { this._weightSelIndices = null; }, 2000);

                for (const idx of indices) {
                    if (idx >= 0 && idx < this._pills.length) {
                        this._pills[idx].weight = Math.round(
                            Math.max(0.1, Math.min(2.0, this._pills[idx].weight + delta)) * 10
                        ) / 10;
                    }
                }
                const newVal = this.getValue();
                const caret = this._getCaretOffset();
                this._setEditorColored(newVal);
                this._setCaretOffset(Math.min(caret, newVal.length));
                this.onChange(newVal);
                this._updateTokenCount();
            } else {
                this._weightSelIndices = null;
                this._adjustWeightAtCaret(delta);
            }
            return;
        }

        if (!(e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))) {
            this._weightSelIndices = null;
        }

        if (!this._acVisible) return;
        if (e.key === "ArrowDown") { e.preventDefault(); this._acIndex = Math.min(this._acIndex + 1, this._acResults.length - 1); this._highlightAcItem(); this._scrollAcIntoView(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this._acIndex = Math.max(this._acIndex - 1, 0); this._highlightAcItem(); this._scrollAcIntoView(); return; }
        if (e.key === "Enter" || e.key === "Tab") { if (this._acIndex >= 0) { e.preventDefault(); this._acceptAutocomplete(this._acResults[this._acIndex]); return; } }
        if (e.key === "Escape") { this._hideAutocomplete(); return; }
    }

    _getSelectedTagIndices() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
        const range = sel.getRangeAt(0);
        const preStart = document.createRange();
        preStart.setStart(this._editor, 0);
        preStart.setEnd(range.startContainer, range.startOffset);
        const selStart = preStart.toString().length;
        const preEnd = document.createRange();
        preEnd.setStart(this._editor, 0);
        preEnd.setEnd(range.endContainer, range.endOffset);
        const selEnd = preEnd.toString().length;
        if (selStart === selEnd) return [];
        const raw = this._getEditorPlainText();
        const segments = [];
        let pos = 0;
        for (const part of raw.split(",")) {
            const start = pos;
            const end = pos + part.length;
            segments.push({ start, end });
            pos = end + 1;
        }
        const indices = [];
        for (let i = 0; i < segments.length && i < this._pills.length; i++) {
            const seg = segments[i];
            if (seg.end > selStart && seg.start < selEnd) indices.push(i);
        }
        return indices;
    }

    _adjustWeightAtCaret(delta) {
        const raw = this._getEditorPlainText();
        if (!raw.trim()) return;
        const caret = this._getCaretOffset();
        const segments = [];
        let pos = 0;
        for (const part of raw.split(",")) {
            const start = pos; const end = pos + part.length;
            segments.push({ start, end, text: part });
            pos = end + 1;
        }
        let targetIdx = segments.length - 1;
        for (let i = 0; i < segments.length; i++) {
            if (caret <= segments[i].end) { targetIdx = i; break; }
        }
        if (targetIdx < 0 || targetIdx >= this._pills.length) return;
        const pill = this._pills[targetIdx];
        pill.weight = Math.round(Math.max(0.1, Math.min(2.0, pill.weight + delta)) * 10) / 10;
        const newVal = this.getValue();
        this._setEditorColored(newVal);
        let newCaret = 0;
        const newSegments = newVal.split(", ");
        for (let i = 0; i < targetIdx && i < newSegments.length; i++) { newCaret += newSegments[i].length + 2; }
        if (targetIdx < newSegments.length) {
            newCaret += Math.min(caret - (segments[targetIdx]?.start || 0), newSegments[targetIdx].length);
        }
        this._setCaretOffset(Math.min(newCaret, newVal.length));
        this.onChange(newVal);
        this._updateTokenCount();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Colored rendering / caret utilities
    // ══════════════════════════════════════════════════════════════════════

    _renderColoredText() {
        const raw = this._getEditorPlainText();
        if (!raw.trim()) return;
        const off = this._getCaretOffset();
        this._setEditorColored(raw);
        this._setCaretOffset(off);
    }

    _setEditorColored(str) {
        const pills = this._parseString(str);
        const tokens = str.split(/(,\s*)/);
        const frag = document.createDocumentFragment();
        let tagIdx = 0;
        for (const token of tokens) {
            if (/^,\s*$/.test(token)) {
                const sep = document.createElement("span");
                sep.textContent = token; sep.style.color = C.textDim;
                frag.appendChild(sep);
            } else if (token.trim()) {
                const pill = tagIdx < pills.length ? pills[tagIdx] : null;
                const color = pill ? (SECTION_COLORS[pill.category] || C.text) : C.text;
                const span = document.createElement("span");
                span.textContent = token; span.style.color = color;
                frag.appendChild(span);
                tagIdx++;
            } else {
                frag.appendChild(document.createTextNode(token));
            }
        }
        this._editor.innerHTML = "";
        this._editor.appendChild(frag);
    }

    _getCaretOffset() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        const pre = document.createRange();
        pre.setStart(this._editor, 0);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString().length;
    }

    _setCaretOffset(offset) {
        const sel = window.getSelection();
        if (!sel) return;
        let rem = offset;
        const walker = document.createTreeWalker(this._editor, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            if (rem <= node.textContent.length) {
                const r = document.createRange(); r.setStart(node, rem); r.collapse(true);
                sel.removeAllRanges(); sel.addRange(r); return;
            }
            rem -= node.textContent.length;
        }
        const r = document.createRange(); r.selectNodeContents(this._editor); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Mode switching
    // ══════════════════════════════════════════════════════════════════════

    _toggleMode() {
        if (this.mode === "text") {
            const raw = this._getEditorPlainText();
            this._pills = this._parseString(raw);
            this.mode = "pill";
        } else {
            this.mode = "text";
        }
        this._applyMode();
        this._syncToCurrentMode();
    }

    _applyMode() {
        if (this.mode === "text") {
            this._textContainer.style.display = "flex";
            this._pillContainer.style.display = "none";
            this._toolbar.style.display = "none";
            this._toggleBtn.textContent = "🏷 Edit Tags";
            this._toggleBtn.style.color = C.textDim;
            this._toggleBtn.style.borderColor = C.border;
        } else {
            this._textContainer.style.display = "none";
            this._pillContainer.style.display = "flex";
            this._toolbar.style.display = "flex";
            this._toggleBtn.textContent = "✏️ Edit Text";
            this._toggleBtn.style.color = C.textBlue;
            this._toggleBtn.style.borderColor = C.textBlue;
        }
    }

    _syncToCurrentMode() {
        if (this.mode === "text") {
            this._setEditorColored(this.getValue());
        } else {
            this._pillCanvas.pills = this._pills.map(p => ({
                id: Math.random().toString(36).slice(2),
                text: p.text, category: p.category, weight: p.weight,
            }));
            this._pillCanvas.selected.clear();
            this._pillCanvas._render();
        }
    }

    _syncPillsFromCanvas() {
        this._pills = this._pillCanvas.pills.map(p => ({
            text: p.text, category: p.category, weight: p.weight,
        }));
    }

    _parseString(str) {
        if (!str || !str.trim()) return [];
        return str.split(/,\s*/).filter(Boolean).map(token => {
            const t = token.trim();
            const wm = t.match(/^\((.+):(\d+(?:\.\d+)?)\)$/);
            if (wm) return { text: wm[1], category: this._lookupCategory(wm[1]), weight: parseFloat(wm[2]) };
            return { text: t, category: this._lookupCategory(t), weight: 1.0 };
        });
    }

    _lookupCategory(text) {
        if (text.startsWith("__") && text.endsWith("__")) return "wildcard";
        if (this._acReady) {
            const found = this._acData.find(a => a.text === text);
            if (found) return found.category;
        }
        for (const key of ["quality", "style", "aesthetic", "negative", "main"]) {
            if (_tagCache[key] && _tagCache[key].includes(text)) return key;
        }
        return "custom";
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Toolbar (pill mode)
    // ══════════════════════════════════════════════════════════════════════

    _buildToolbar() {
        const mkBtn = (text, bg, color, onClick) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            Object.assign(btn.style, {
                padding: "2px 6px", background: bg, color,
                border: `1px solid ${C.border}`, borderRadius: "4px",
                cursor: "pointer", fontSize: "10px",
                fontFamily: "Inter, system-ui, sans-serif",
            });
            btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
            return btn;
        };

        this._toolbar.append(
            mkBtn("🔗 Join",   C.surface, C.text,     () => this._pillCanvas.joinSelected()),
            mkBtn("✂ Split",   C.surface, C.text,     () => this._pillCanvas.splitSelected()),
            mkBtn("⬅ Move",    C.surface, C.textBlue, () => this._moveSelectedBlock("left")),
            mkBtn("Move ➡",    C.surface, C.textBlue, () => this._moveSelectedBlock("right")),
            mkBtn("↩ Undo",    C.surface, C.text,     () => this._pillCanvas.undo()),
            mkBtn("↪ Redo",    C.surface, C.text,     () => this._pillCanvas.redo()),
            mkBtn("🗑 Clear",  "#2a1525", "#f38ba8",   () => this._pillCanvas.clear()),
        );

        this._toolbar.appendChild(mkBtn("💾 Save Preset", C.surface, C.text, () => {
            const selected = [...this._pillCanvas.selected];
            let pills = selected.length > 0
                ? selected.map(id => this._pillCanvas.pills.find(p => p.id === id)).filter(Boolean)
                : this._pillCanvas.pills;
            if (pills.length === 0) return;
            const defaultCat = pills[0]?.category || (this.kind === "negative" ? "negative" : "main");
            openSavePresetDialog(pills.map(p => ({ text: p.text, category: p.category, weight: p.weight })), defaultCat, null);
        }));

        this._toolbar.appendChild(mkBtn("📋 Presets", "#1f2040", C.text, () => {
            openPresetManager((pills, category) => this._smartInsertPills(pills, category));
        }));

        this._toolbar.appendChild(mkBtn("📤 Export", "#1f2040", C.text, () => {
            openExportDialog();
        }));
    }

    // ── Token counter ────────────────────────────────────────────────────────
    _updateTokenCount() {
        const text = this.getValue();
        if (!text.trim()) {
            this._tokenBadge.textContent = "0 tokens";
            this._tokenBadge.style.color = C.textDim;
            this._tokenBadge.style.borderColor = C.border;
            return;
        }
        const cleaned = text.replace(/\(([^:]+):\d+(?:\.\d+)?\)/g, "$1");
        const words = cleaned.replace(/,/g, " ").replace(/_/g, " ").split(/\s+/).filter(w => w.length > 0);
        const count = words.length;
        const chunks = Math.ceil(count / 75);
        const label = chunks > 1 ? `${count} tokens (${chunks} chunks)` : `${count} tokens`;
        this._tokenBadge.textContent = label;
        if (count > 75) {
            this._tokenBadge.style.color = "#f9e2af";
            this._tokenBadge.style.borderColor = "#f9e2af55";
        } else {
            this._tokenBadge.style.color = C.textDim;
            this._tokenBadge.style.borderColor = C.border;
        }
    }

    // ── Text-mode context menu ───────────────────────────────────────────────
    _closeTextCtxMenu() {
        if (this._textCtxMenu) { this._textCtxMenu.remove(); this._textCtxMenu = null; }
    }

    _getTagAtCaret() {
        const raw = this._getEditorPlainText();
        if (!raw.trim()) return null;
        const caret = this._getCaretOffset();
        const segments = [];
        let pos = 0;
        for (const part of raw.split(",")) {
            const start = pos; const end = pos + part.length;
            segments.push({ start, end, text: part.trim() });
            pos = end + 1;
        }
        let targetIdx = segments.length - 1;
        for (let i = 0; i < segments.length; i++) {
            if (caret <= segments[i].end) { targetIdx = i; break; }
        }
        if (targetIdx < 0 || targetIdx >= this._pills.length) return null;
        return this._pills[targetIdx];
    }

    _openTextCtxMenu(e) {
        this._closeTextCtxMenu();
        const pill      = this._getTagAtCaret();
        const nativeSel = (window.getSelection()?.toString() ?? "").trim();

        const menu = document.createElement("div");
        this._textCtxMenu = menu;
        Object.assign(menu.style, {
            position: "fixed", zIndex: "99999", background: "#1e2335",
            border: "1px solid #313552", borderRadius: "8px", padding: "4px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.6)", display: "flex",
            flexDirection: "column", gap: "2px", minWidth: "200px",
        });

        const header = document.createElement("div");
        header.textContent = pill?.text || (this.kind === "positive" ? "✅ Positive prompt" : "❌ Negative prompt");
        Object.assign(header.style, {
            padding: "5px 10px 3px", fontSize: "11px", color: "#6c7086",
            fontStyle: "italic", userSelect: "none", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "220px",
        });
        menu.appendChild(header);

        const hr1 = document.createElement("hr");
        Object.assign(hr1.style, { border: "none", borderTop: "1px solid #313552", margin: "2px 0" });
        menu.appendChild(hr1);

        // ── 📋 Copy / Paste (always available, even on an empty prompt) ──
        if (nativeSel) {
            menu.appendChild(this._mkCtxItem("📋", "Copy Selection", () => {
                this._closeTextCtxMenu();
                this._copyToClipboard(nativeSel, "Selection");
            }));
        }
        if (pill && pill.text.trim()) {
            menu.appendChild(this._mkCtxItem("📋", "Copy Tag", () => {
                this._closeTextCtxMenu();
                this._copyToClipboard(this._serializePills([pill]), "Tag");
            }));
        }
        menu.appendChild(this._mkCtxItem("⧉", "Copy All", () => {
            this._closeTextCtxMenu();
            this._copyToClipboard(this.getValue(), "Prompt");
        }));
        menu.appendChild(this._mkCtxItem("📥", "Paste", () => {
            this._closeTextCtxMenu();
            this._pasteFromClipboard();
        }));

        // ── Tag-specific items (only when a tag is under the caret) ──
        if (pill && pill.text.trim()) {
            const hr2 = document.createElement("hr");
            Object.assign(hr2.style, { border: "none", borderTop: "1px solid #313552", margin: "2px 0" });
            menu.appendChild(hr2);

            this._appendAddToTagsSubmenu(menu, pill.text, pill.category);

            const hr3 = document.createElement("hr");
            Object.assign(hr3.style, { border: "none", borderTop: "1px solid #313552", margin: "2px 0" });
            menu.appendChild(hr3);

            const hasUnderscore = pill.text.includes("_");
            menu.appendChild(this._mkCtxItem(
                hasUnderscore ? "␣" : "_",
                hasUnderscore ? "Underscores → Spaces" : "Spaces → Underscores",
                () => {
                    this._closeTextCtxMenu();
                    if (hasUnderscore) pill.text = pill.text.replace(/_/g, " ");
                    else pill.text = pill.text.replace(/ /g, "_");
                    const newVal = this.getValue();
                    this._setEditorColored(newVal);
                    this.onChange(newVal);
                }
            ));
        }

        document.body.appendChild(menu);

        const mw = 220;
        let left = e.clientX + 4, top = e.clientY + 4;
        if (left + mw > window.innerWidth - 8) left = e.clientX - mw - 4;
        if (top + 240 > window.innerHeight - 8) top = e.clientY - 240;
        menu.style.left = left + "px";
        menu.style.top  = top  + "px";

        const closeHandler = (ev) => {
            if (this._textCtxMenu && !this._textCtxMenu.contains(ev.target)) {
                this._closeTextCtxMenu();
                window.removeEventListener("mousedown", closeHandler, true);
                window.removeEventListener("contextmenu", closeCtx, true);
            }
        };
        const closeCtx = (ev) => {
            if (this._textCtxMenu && !this._textCtxMenu.contains(ev.target)) {
                this._closeTextCtxMenu();
                window.removeEventListener("mousedown", closeHandler, true);
                window.removeEventListener("contextmenu", closeCtx, true);
            }
        };
        setTimeout(() => {
            window.addEventListener("mousedown", closeHandler, true);
            window.addEventListener("contextmenu", closeCtx, true);
        }, 0);
    }

    // ── Shared "Add to Tag List" submenu ─────────────────────────────────────
    _appendAddToTagsSubmenu(menu, tagText, tagCategory) {
        const addItem = document.createElement("div");
        Object.assign(addItem.style, {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "7px 10px", borderRadius: "5px", cursor: "pointer",
            fontSize: "12px", color: "#cdd6f4", userSelect: "none",
            fontFamily: "Inter, system-ui, sans-serif", position: "relative",
        });
        const addIcon = document.createElement("span"); addIcon.textContent = "📌";
        const addLabel = document.createElement("span"); addLabel.textContent = "Add to Tag List";
        addLabel.style.flex = "1";
        const addArrow = document.createElement("span"); addArrow.textContent = "▸";
        Object.assign(addArrow.style, { fontSize: "10px", color: "#6c7086" });
        addItem.append(addIcon, addLabel, addArrow);

        const subMenu = document.createElement("div");
        Object.assign(subMenu.style, {
            display: "none", position: "absolute", left: "100%", top: "0",
            background: "#1e2335", border: "1px solid #313552", borderRadius: "8px",
            padding: "4px", boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            minWidth: "150px", zIndex: "100000",
            flexDirection: "column", gap: "2px",
        });

        const categories = [
            { key: "quality",   label: "⭐ Quality",   color: SECTION_COLORS.quality },
            { key: "style",     label: "🎭 Style",     color: SECTION_COLORS.style },
            { key: "main",      label: "🖼️ Main",      color: SECTION_COLORS.main },
            { key: "aesthetic", label: "🎨 Aesthetic", color: SECTION_COLORS.aesthetic },
            { key: "negative",  label: "❌ Negative",  color: SECTION_COLORS.negative },
        ];

        for (const cat of categories) {
            const catItem = document.createElement("div");
            Object.assign(catItem.style, {
                display: "flex", alignItems: "center", gap: "8px",
                padding: "6px 10px", borderRadius: "5px", cursor: "pointer",
                fontSize: "12px", color: cat.color, userSelect: "none",
                fontFamily: "Inter, system-ui, sans-serif",
            });
            catItem.textContent = cat.label;
            if (cat.key === tagCategory) {
                catItem.style.fontWeight = "bold";
                catItem.style.background = "#2a2f45";
            }
            catItem.addEventListener("mouseenter", () => {
                if (cat.key !== tagCategory) catItem.style.background = "#2a2f45";
            });
            catItem.addEventListener("mouseleave", () => {
                if (cat.key !== tagCategory) catItem.style.background = "transparent";
            });
            catItem.addEventListener("click", (ev) => {
                ev.stopPropagation();
                this._closeTextCtxMenu();
                if (this._pillCanvas._ctxMenu) this._pillCanvas._closeCtxMenu();
                this._addTagToFile(tagText, cat.key);
            });
            subMenu.appendChild(catItem);
        }

        addItem.appendChild(subMenu);
        addItem.addEventListener("mouseenter", () => {
            addItem.style.background = "#2a2f45";
            subMenu.style.display = "flex";
            requestAnimationFrame(() => {
                const subRect = subMenu.getBoundingClientRect();
                if (subRect.right > window.innerWidth - 8) {
                    subMenu.style.left = "auto"; subMenu.style.right = "100%";
                }
                if (subRect.bottom > window.innerHeight - 8) {
                    subMenu.style.top = "auto"; subMenu.style.bottom = "0";
                }
            });
        });
        addItem.addEventListener("mouseleave", () => {
            addItem.style.background = "transparent";
            subMenu.style.display = "none";
        });

        menu.appendChild(addItem);
    }

    async _addTagToFile(tag, category) {
        let key = category;
        if (!["quality", "style", "aesthetic", "main", "negative"].includes(key)) {
            key = this.kind === "negative" ? "negative" : "main";
        }
        try {
            const res = await fetch("/cwk/add_tag", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key, tag }),
            });
            const json = await res.json();
            if (json.ok) {
                const savedTag = json.tag;
                const pill = this._pillCanvas.pills.find(p => p.text === tag);
                if (pill && savedTag !== tag) {
                    pill.text = savedTag;
                    this._pillCanvas._render();
                    this._syncPillsFromCanvas();
                    this.onChange(this.getValue());
                }
                invalidateTagCache(key);
                this._acData = await buildAutocompleteList();
                alert(`✅ "${savedTag}" added to ${key}.txt`);
            } else if (json.duplicate) {
                const sanitized = tag.replace(/ /g, "_");
                alert(`⚠️ "${sanitized}" already exists in ${key}.txt`);
            } else {
                alert(`❌ ${json.error}`);
            }
        } catch (e) { alert(`❌ Network error: ${e.message}`); }
    }
}

// ===== END OF FILE =====
