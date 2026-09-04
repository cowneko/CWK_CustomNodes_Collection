// ── Preset Storage ───────────────────────────────────────────────────────────
const PRESET_KEY = (k) => `cwk_presets_${k}`;
export function loadPresets(k)          { try { return JSON.parse(localStorage.getItem(PRESET_KEY(k)) || "{}"); } catch { return {}; } }
export function savePresets(k, presets) { localStorage.setItem(PRESET_KEY(k), JSON.stringify(presets)); }

// ── Shared window builder helper ─────────────────────────────────────────────
export function makeWindow({ title, width = "500px", height = "500px", minWidth = "380px", minHeight = "300px", zIndex = "10001" }) {
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, { position: "fixed", inset: "0", zIndex: String(parseInt(zIndex) - 1), display: "none" });

    const win = document.createElement("div");
    Object.assign(win.style, {
        position: "fixed", top: "120px", left: "50%", transform: "translateX(-50%)",
        width, height, minWidth, minHeight,
        zIndex, display: "none", flexDirection: "column",
        background: "#1a1f2e", border: "1px solid #313552", borderRadius: "10px",
        boxShadow: "0 8px 40px rgba(0,0,0,0.8)", overflow: "hidden", boxSizing: "border-box",
    });

    // Title bar
    const titleBar = document.createElement("div");
    Object.assign(titleBar.style, {
        height: "36px", flexShrink: "0", cursor: "move", background: "#1e2335",
        borderBottom: "1px solid #313552", display: "flex", alignItems: "center",
        padding: "0 12px", userSelect: "none", borderRadius: "10px 10px 0 0", gap: "6px",
    });

    const titleLabel = document.createElement("span");
    Object.assign(titleLabel.style, { color: "#cdd6f4", fontSize: "13px", fontWeight: "bold", flex: "1", fontFamily: "Inter, system-ui, sans-serif" });
    titleLabel.textContent = title;
    titleBar.appendChild(titleLabel);

    const closeBtn = document.createElement("div");
    closeBtn.textContent = "✕";
    Object.assign(closeBtn.style, { cursor: "pointer", color: "#6c7086", fontSize: "16px", lineHeight: "1", padding: "2px 6px", borderRadius: "4px", userSelect: "none" });
    closeBtn.addEventListener("mouseenter", () => { closeBtn.style.color = "#cdd6f4"; closeBtn.style.background = "#f38ba820"; });
    closeBtn.addEventListener("mouseleave", () => { closeBtn.style.color = "#6c7086";  closeBtn.style.background = "transparent"; });
    titleBar.appendChild(closeBtn);

    // Body
    const body = document.createElement("div");
    Object.assign(body.style, {
        display: "flex", flexDirection: "column", flex: "1", minHeight: "0",
        padding: "14px", gap: "10px", boxSizing: "border-box", overflowY: "auto",
    });

    // SE resize handle
    const resizeHandle = document.createElement("div");
    Object.assign(resizeHandle.style, { position: "absolute", right: "0", bottom: "0", width: "0", height: "0", borderStyle: "solid", borderWidth: "0 0 18px 18px", borderColor: "transparent transparent #313552 transparent", cursor: "nwse-resize", zIndex: "10" });
    const resizeInner = document.createElement("div");
    Object.assign(resizeInner.style, { position: "absolute", right: "1px", bottom: "-17px", width: "0", height: "0", borderStyle: "solid", borderWidth: "0 0 12px 12px", borderColor: "transparent transparent #89b4fa transparent" });
    resizeHandle.appendChild(resizeInner);

    win.appendChild(titleBar);
    win.appendChild(body);
    win.appendChild(resizeHandle);
    document.body.appendChild(backdrop);
    document.body.appendChild(win);

    // Drag
    let startX, startY, startL, startT;
    const onDragMove = (e) => { win.style.left = (startL + e.clientX - startX) + "px"; win.style.top = (startT + e.clientY - startY) + "px"; win.style.transform = ""; };
    const onDragUp   = () => { document.removeEventListener("mousemove", onDragMove); document.removeEventListener("mouseup", onDragUp); document.body.style.userSelect = ""; };
    titleBar.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (win.style.transform) { const r = win.getBoundingClientRect(); win.style.left = r.left + "px"; win.style.top = r.top + "px"; win.style.transform = ""; }
        startX = e.clientX; startY = e.clientY;
        startL = parseFloat(win.style.left) || 0; startT = parseFloat(win.style.top) || 0;
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onDragMove); document.addEventListener("mouseup", onDragUp);
    });

    // Resize
    let rStartX, rStartY, rStartW, rStartH;
    const onResizeMove = (e) => { win.style.width = Math.max(parseInt(minWidth), rStartW + e.clientX - rStartX) + "px"; win.style.height = Math.max(parseInt(minHeight), rStartH + e.clientY - rStartY) + "px"; };
    const onResizeUp   = () => { document.removeEventListener("mousemove", onResizeMove); document.removeEventListener("mouseup", onResizeUp); document.body.style.userSelect = ""; };
    resizeHandle.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = win.getBoundingClientRect();
        rStartX = e.clientX; rStartY = e.clientY; rStartW = r.width; rStartH = r.height;
        win.style.left = r.left + "px"; win.style.top = r.top + "px"; win.style.transform = "";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", onResizeMove); document.addEventListener("mouseup", onResizeUp);
    });

    return { win, backdrop, body, closeBtn, titleLabel };
}

// ── Preset Manager ───────────────────────────────────────────────────────────
export class PresetManager {
    constructor() {
        this._panelKey = null;
        this._canvas   = null;
        const { win, backdrop, body, closeBtn } = makeWindow({ title: "📋 Manage Presets", zIndex: "10001" });
        this._win      = win;
        this._backdrop = backdrop;
        this._body     = body;
        closeBtn.addEventListener("click", () => this.hide());
    }

    show(panelKey, canvas) {
        this._panelKey = panelKey;
        this._canvas   = canvas;
        this._render();
        this._backdrop.style.display = "block";
        this._win.style.display      = "flex";
        this._win.style.left         = "50%";
        this._win.style.top          = "120px";
        this._win.style.transform    = "translateX(-50%)";
    }

    hide() {
        this._backdrop.style.display = "none";
        this._win.style.display      = "none";
    }

    _render() {
        this._body.innerHTML = "";
        const presets = loadPresets(this._panelKey);
        const names   = Object.keys(presets);

        const topBar = document.createElement("div");
        Object.assign(topBar.style, { display: "flex", gap: "8px", flexShrink: "0", flexWrap: "wrap" });
        topBar.appendChild(this._mkBtn("📦 Export All",       "#1a2535", () => this._exportJSON(presets, `cwk_presets_${this._panelKey}_all.json`)));
        topBar.appendChild(this._mkBtn("📂 Import from JSON", "#1f2040", () => this._importJSON()));
        this._body.appendChild(topBar);

        const hr = document.createElement("hr");
        Object.assign(hr.style, { border: "none", borderTop: "1px solid #313552", margin: "0", flexShrink: "0" });
        this._body.appendChild(hr);

        if (names.length === 0) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { color: "#313552", fontSize: "13px", textAlign: "center", padding: "20px 0" });
            empty.textContent = "No presets saved yet.";
            this._body.appendChild(empty);
            return;
        }

        const list = document.createElement("div");
        Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "8px" });

        names.forEach(name => {
            const wrapper = document.createElement("div");
            Object.assign(wrapper.style, { background: "#1e2335", borderRadius: "6px", border: "1px solid #313552", overflow: "hidden" });

            const row = document.createElement("div");
            Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", padding: "8px 10px" });

            let folded = true;
            const arrow = document.createElement("span");
            arrow.textContent = "▶";
            Object.assign(arrow.style, { fontSize: "10px", color: "#6c7086", cursor: "pointer", transition: "transform 0.15s", display: "inline-block", flexShrink: "0", userSelect: "none", padding: "2px 4px" });

            const preview = document.createElement("div");
            Object.assign(preview.style, { display: "none", padding: "8px 12px", borderTop: "1px solid #313552", fontSize: "11px", color: "#a6adc8", lineHeight: "1.6", wordBreak: "break-word", whiteSpace: "pre-wrap", background: "#141824", maxHeight: "120px", overflowY: "auto" });
            preview.textContent = presets[name] || "(empty)";

            const toggleFold = () => { folded = !folded; preview.style.display = folded ? "none" : "block"; arrow.style.transform = folded ? "" : "rotate(90deg)"; arrow.style.color = folded ? "#6c7086" : "#89b4fa"; };
            arrow.addEventListener("click", toggleFold);

            const nameEl = document.createElement("span");
            Object.assign(nameEl.style, { color: "#cdd6f4", fontSize: "13px", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" });
            nameEl.textContent = name;
            nameEl.addEventListener("click", toggleFold);

            const loadBtn   = this._mkBtn("Load",      "#1a2535", () => { this._canvas.setValue(presets[name]); this.hide(); });
            const renameBtn = this._mkBtn("✏️ Rename", "#1a2535", () => {
                const newName = window.prompt("New name:", name);
                if (!newName?.trim() || newName.trim() === name) return;
                const fresh = loadPresets(this._panelKey);
                if (fresh[newName.trim()]) { alert("A preset with that name already exists."); return; }
                fresh[newName.trim()] = fresh[name]; delete fresh[name];
                savePresets(this._panelKey, fresh); this._render();
            });
            const exportBtn = this._mkBtn("💾 Export", "#1a2535", () => this._exportJSON({ [name]: presets[name] }, `cwk_preset_${name}.json`));
            const delBtn    = this._mkBtn("🗑 Delete", "#2a1525", () => {
                if (!window.confirm(`Delete preset "${name}"?`)) return;
                const fresh = loadPresets(this._panelKey); delete fresh[name];
                savePresets(this._panelKey, fresh); this._render();
            });
            delBtn.style.color = "#f38ba8";

            row.append(arrow, nameEl, loadBtn, renameBtn, exportBtn, delBtn);
            wrapper.appendChild(row);
            wrapper.appendChild(preview);
            list.appendChild(wrapper);
        });

        this._body.appendChild(list);
    }

    _mkBtn(text, bg, onClick) {
        const btn = document.createElement("button");
        btn.textContent = text;
        Object.assign(btn.style, { padding: "4px 10px", background: bg, color: "#cdd6f4", border: "1px solid #313552", borderRadius: "5px", cursor: "pointer", fontSize: "12px", whiteSpace: "nowrap", flexShrink: "0", fontFamily: "Inter, system-ui, sans-serif" });
        btn.addEventListener("click", onClick);
        return btn;
    }

    _exportJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a"); a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
    }

    _importJSON() {
        const input = document.createElement("input"); input.type = "file"; input.accept = ".json";
        input.addEventListener("change", async () => {
            const file = input.files[0]; if (!file) return;
            try {
                const text     = await file.text();
                const imported = JSON.parse(text);
                if (typeof imported !== "object" || Array.isArray(imported)) throw new Error("Invalid format");
                const existing = loadPresets(this._panelKey);
                let imported_count = 0, skipped = 0;
                for (const [k, v] of Object.entries(imported)) {
                    if (typeof v !== "string") continue;
                    if (existing[k]) { skipped++; continue; }
                    existing[k] = v; imported_count++;
                }
                savePresets(this._panelKey, existing);
                alert(`✅ Imported ${imported_count} preset(s).${skipped ? ` Skipped ${skipped} duplicate(s).` : ""}`);
                this._render();
            } catch (e) { alert("❌ Failed to import: " + e.message); }
        });
        input.click();
    }
}

export const presetManager = new PresetManager();