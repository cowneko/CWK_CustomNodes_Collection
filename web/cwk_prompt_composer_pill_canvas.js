// ── Category → color map ─────────────────────────────────────────────────────
export const CATEGORY_COLORS = {
    quality:   "#f9e2af",
	style:     "#a6e3a1",
    aesthetic: "#cba6f7",
    main:      "#89dceb",
    negative:  "#f38ba8",
    embedding: "#a6e3a1",
    wildcard:  "#94e2d5",
    custom:    "#cdd6f4",
};

export function categoryColor(category) {
    if (!category) return CATEGORY_COLORS.custom;
    const key = category.toLowerCase();
    for (const [k, v] of Object.entries(CATEGORY_COLORS)) {
        if (key.includes(k)) return v;
    }
    return CATEGORY_COLORS.custom;
}

// ── Pill Canvas ──────────────────────────────────────────────────────────────
export class PillCanvas {
    constructor(onChange) {
        this.pills          = [];
        this.selected       = new Set();
        this.onChange        = onChange;
        this._dragIdx        = null;
        this._dragOver       = null;
        this._weightPopover  = null;
        this._ctxMenu        = null;
        this._undoStack      = [];
        this._redoStack      = [];

        this.onAddToList     = null;

        this.el = document.createElement("div");
        Object.assign(this.el.style, {
            minHeight:    "80px",
            overflowY:    "auto",
            background:   "#141824",
            border:       "1px solid #313552",
            borderRadius: "8px",
            padding:      "8px",
            display:      "flex",
            flexWrap:     "wrap",
            gap:          "6px",
            alignContent: "flex-start",
            flexShrink:   "0",
        });

        document.addEventListener("mousedown", (e) => {
            if (this._weightPopover && !this._weightPopover.contains(e.target)) this._closePopover();
            if (this._ctxMenu       && !this._ctxMenu.contains(e.target))       this._closeCtxMenu();
        });
    }

    // ── Snapshot helpers ───────────────────────────────────────────────────
    _snapshot() {
        this._undoStack.push(JSON.stringify(this.pills));
        if (this._undoStack.length > 100) this._undoStack.shift();
        this._redoStack = [];
    }

    undo() {
        if (!this._undoStack.length) return;
        this._redoStack.push(JSON.stringify(this.pills));
        this.pills = JSON.parse(this._undoStack.pop());
        this.selected.clear(); this._closePopover(); this._closeCtxMenu();
        this._render(); this.onChange(this.getValue());
    }

    redo() {
        if (!this._redoStack.length) return;
        this._undoStack.push(JSON.stringify(this.pills));
        this.pills = JSON.parse(this._redoStack.pop());
        this.selected.clear(); this._closePopover(); this._closeCtxMenu();
        this._render(); this.onChange(this.getValue());
    }

    // ── Mutations ──────────────────────────────────────────────────────────
    _nextId() { return Math.random().toString(36).slice(2); }

    addTag(text, category = "custom") {
        this._snapshot();
        this.pills.push({ id: this._nextId(), text, category, weight: 1.0 });
        this._render(); this.onChange(this.getValue());
    }

    removeId(id) {
        this._snapshot();
        this.pills = this.pills.filter(p => p.id !== id);
        this.selected.delete(id);
        this._render(); this.onChange(this.getValue());
    }

    clear() {
        this._snapshot();
        this.pills = []; this.selected.clear();
        this._closePopover(); this._closeCtxMenu();
        this._render(); this.onChange(this.getValue());
    }

    toggleSelect(id) {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
        this._render();
    }

    joinSelected() {
        const ids = [...this.selected];
        if (ids.length < 2) return;
        this._snapshot();
        const indices = ids.map(id => this.pills.findIndex(p => p.id === id)).sort((a, b) => a - b);
        const texts   = indices.map(i => this.pills[i].text);
        const joined  = { id: this._nextId(), text: texts.join("_"), category: this.pills[indices[0]].category, weight: 1.0 };
        this.pills[indices[0]] = joined;
        for (let i = indices.length - 1; i >= 1; i--) this.pills.splice(indices[i], 1);
        this.selected.clear(); this._render(); this.onChange(this.getValue());
    }

    splitSelected() {
        if (this.selected.size !== 1) return;
        const id  = [...this.selected][0];
        const idx = this.pills.findIndex(p => p.id === id);
        if (idx === -1) return;
        const parts = this.pills[idx].text.split("_").filter(Boolean);
        if (parts.length < 2) return;
        this._snapshot();
        const cat = this.pills[idx].category;
        this.pills.splice(idx, 1, ...parts.map(t => ({ id: this._nextId(), text: t, category: cat, weight: 1.0 })));
        this.selected.clear(); this._render(); this.onChange(this.getValue());
    }

    setLucky(pills) {
        this._snapshot();
        this.pills = pills; this.selected.clear();
        this._closePopover(); this._closeCtxMenu();
        this._render(); this.onChange(this.getValue());
    }

    getValue() {
        return this.pills.map(p => {
            const w = Math.round(p.weight * 10) / 10;
            return w !== 1.0 ? `(${p.text}:${w.toFixed(1)})` : p.text;
        }).join(", ");
    }

    setValue(str, classifyFn = null) {
        this._undoStack = []; this._redoStack = [];
        this.pills = str
            ? str.split(/,\s*/).filter(Boolean).map(token => {
                const weighted = token.match(/^\((.+):(\d+(?:\.\d+)?)\)$/);
                const text     = weighted ? weighted[1] : token.trim();
                const weight   = weighted ? parseFloat(weighted[2]) : 1.0;
                const category = classifyFn ? classifyFn(text) : "custom";
                return { id: this._nextId(), text, category, weight };
            })
            : [];
        this.selected.clear(); this._closePopover(); this._closeCtxMenu(); this._render();
    }

    // ── Context menu ──────────────────────────────────────────��────────────
    _closeCtxMenu() {
        if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
    }

    _openCtxMenu(pill, pillEl, e) {
        this._closeCtxMenu();
        this._closePopover();

        const menu = document.createElement("div");
        this._ctxMenu = menu;
        Object.assign(menu.style, {
            position: "fixed", zIndex: "99999", background: "#1e2335",
            border: "1px solid #313552", borderRadius: "8px", padding: "4px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.6)", display: "flex",
            flexDirection: "column", gap: "2px", minWidth: "180px",
        });

        const mkItem = (icon, label, onClick) => {
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
            item.addEventListener("click", () => { this._closeCtxMenu(); onClick(); });
            return item;
        };

        const divider = document.createElement("hr");
        Object.assign(divider.style, { border: "none", borderTop: "1px solid #313552", margin: "2px 0" });

        const header = document.createElement("div");
        header.textContent = pill.text;
        Object.assign(header.style, {
            padding: "5px 10px 3px", fontSize: "11px", color: "#6c7086",
            fontStyle: "italic", userSelect: "none", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
        });

        menu.appendChild(header);
        menu.appendChild(divider.cloneNode());
        menu.appendChild(mkItem("⚖", "Set Weight", () => this._openWeightPopover(pill, pillEl)));

        if (this.onEnhanceCtxMenu) {
            this.onEnhanceCtxMenu(menu, pill, divider);
        }

        document.body.appendChild(menu);

        const mw = 180;
        let left = e.clientX + 4, top = e.clientY + 4;
        if (left + mw > window.innerWidth - 8) left = e.clientX - mw - 4;
        if (top + 120 > window.innerHeight - 8) top = e.clientY - 120;
        menu.style.left = left + "px";
        menu.style.top  = top  + "px";
    }

    // ── Weight popover ─────────────────────────────────────────────────────
    _closePopover() {
        if (this._weightPopover) { this._weightPopover.remove(); this._weightPopover = null; }
    }

    _openWeightPopover(pill, pillEl) {
        this._closePopover();
        const popover = document.createElement("div");
        this._weightPopover = popover;
        Object.assign(popover.style, {
            position: "fixed", zIndex: "99999", background: "#1e2335",
            border: "1px solid #313552", borderRadius: "8px", padding: "10px 14px",
            boxShadow: "0 4px 20px rgba(0,0,0,0.6)", display: "flex",
            flexDirection: "column", gap: "8px", minWidth: "200px",
        });

        const label = document.createElement("div");
        Object.assign(label.style, { color: "#cdd6f4", fontSize: "12px", fontWeight: "bold", fontFamily: "Inter, system-ui, sans-serif" });
        label.textContent = `⚖ Weight: ${pill.text}`;

        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px" });

        const slider = document.createElement("input");
        slider.type = "range"; slider.min = "0.1"; slider.max = "2.0"; slider.step = "0.1";
        slider.value = pill.weight.toFixed(1);
        Object.assign(slider.style, { flex: "1", accentColor: "#89b4fa", cursor: "pointer" });

        const valueLabel = document.createElement("span");
        Object.assign(valueLabel.style, { color: "#89b4fa", fontSize: "13px", fontWeight: "bold", minWidth: "28px", textAlign: "right" });
        valueLabel.textContent = pill.weight.toFixed(1);

        let _snapDone = false;
        slider.addEventListener("mousedown", () => { _snapDone = false; });
        slider.addEventListener("input", () => {
            if (!_snapDone) { this._snapshot(); _snapDone = true; }
            const w = parseFloat(slider.value);
            pill.weight = w; valueLabel.textContent = w.toFixed(1);
            this._render(); this.onChange(this.getValue());
        });

        const resetBtn = document.createElement("button");
        resetBtn.textContent = "Reset";
        Object.assign(resetBtn.style, { padding: "3px 8px", background: "#1a1f2e", color: "#cdd6f4", border: "1px solid #313552", borderRadius: "4px", cursor: "pointer", fontSize: "11px" });
        resetBtn.addEventListener("click", () => {
            this._snapshot();
            pill.weight = 1.0; slider.value = "1.0"; valueLabel.textContent = "1.0";
            this._render(); this.onChange(this.getValue());
        });

        row.append(slider, valueLabel);
        popover.append(label, row, resetBtn);
        document.body.appendChild(popover);

        const rect = pillEl.getBoundingClientRect();
        let left = rect.left, top = rect.bottom + 6;
        if (left + 200 > window.innerWidth  - 10) left = window.innerWidth  - 210;
        if (top  + 110 > window.innerHeight - 10) top  = rect.top - 116;
        popover.style.left = left + "px";
        popover.style.top  = top  + "px";
    }

    // ── Render ─────────────────────────────────────────────────────────────
    _render() {
        this.el.innerHTML = "";
        if (this.pills.length === 0) {
            const placeholder = document.createElement("span");
            Object.assign(placeholder.style, { color: "#313552", fontSize: "12px", padding: "4px" });
            placeholder.textContent = "No tags yet — switch to text mode to add some…";
            this.el.appendChild(placeholder);
            return;
        }

        this.pills.forEach((pill, idx) => {
            const selected  = this.selected.has(pill.id);
            const color     = categoryColor(pill.category);
            const hasWeight = Math.round(pill.weight * 10) / 10 !== 1.0;
            const isEmbed   = pill.text.startsWith("embedding:");
            const isWild    = pill.text.startsWith("__") && pill.text.endsWith("__");

            const pillEl = document.createElement("div");
            pillEl.draggable = true;
            Object.assign(pillEl.style, {
                display: "inline-flex", alignItems: "center", gap: "4px",
                padding: "3px 8px", borderRadius: "12px",
                background: selected ? `${color}22` : "#1e2335",
                border: `1px ${isWild ? "dashed" : "solid"} ${selected ? color : color + "88"}`,
                cursor: "grab", fontSize: "12px",
                color: selected ? color : color + "cc",
                userSelect: "none", transition: "all 0.1s",
            });

            if (isEmbed) {
                const badge = document.createElement("span");
                badge.textContent = "E";
                Object.assign(badge.style, { fontSize: "8px", background: "#a6e3a133", color: "#a6e3a1", borderRadius: "3px", padding: "0 3px", fontWeight: "bold" });
                pillEl.appendChild(badge);
            }

            const labelEl = document.createElement("span");
            labelEl.textContent = isEmbed ? pill.text.replace("embedding:", "") : pill.text;
            labelEl.addEventListener("click", (e) => { e.stopPropagation(); this.toggleSelect(pill.id); });

            if (hasWeight) {
                const wBadge = document.createElement("span");
                wBadge.textContent = pill.weight.toFixed(1);
                Object.assign(wBadge.style, { fontSize: "9px", background: "#1a1f2e", color: "#89b4fa", borderRadius: "4px", padding: "1px 3px", fontWeight: "bold", lineHeight: "1.2" });
                pillEl.appendChild(wBadge);
            }

            const xBtn = document.createElement("span");
            xBtn.textContent = "×";
            Object.assign(xBtn.style, { cursor: "pointer", color: "#f38ba8", fontWeight: "bold", fontSize: "14px", lineHeight: "1", padding: "0 2px" });
            xBtn.addEventListener("click", (e) => { e.stopPropagation(); this.removeId(pill.id); });

            pillEl.append(labelEl, xBtn);

            pillEl.addEventListener("contextmenu", (e) => {
                e.preventDefault(); e.stopPropagation();
                this._openCtxMenu(pill, pillEl, e);
            });

            pillEl.addEventListener("dragstart", ()  => { this._dragIdx  = idx; });
            pillEl.addEventListener("dragover",  (e) => { e.preventDefault(); this._dragOver = idx; });
            pillEl.addEventListener("drop",      ()  => {
                if (this._dragIdx === null || this._dragIdx === this._dragOver) return;
                this._snapshot();
                const moved = this.pills.splice(this._dragIdx, 1)[0];
                this.pills.splice(this._dragOver, 0, moved);
                this._dragIdx = this._dragOver = null;
                this._render(); this.onChange(this.getValue());
            });

            this.el.appendChild(pillEl);
        });
    }
}