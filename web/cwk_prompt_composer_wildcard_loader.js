import { makeWindow } from "./cwk_prompt_composer_preset_manager.js";

// ── localStorage key for remembering last selection ──────────────────────────
const LAST_FILE_KEY  = "cwk_wildcard_last_file";
const LAST_KEY_KEY   = "cwk_wildcard_last_key";

// ── Minimal YAML wildcard parser ─────────────────────────────────────────────
function parseWildcardYaml(text) {
    const lines   = text.split(/\r?\n/);
    const result  = {};
    let curKey    = null;

    for (let raw of lines) {
        const line = raw.trimEnd();
        if (!line || line.trimStart().startsWith("#")) continue;

        const keyMatch = line.match(/^([A-Za-z0-9 _\-./]+):\s*$/);
        if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
            curKey = keyMatch[1].trim();
            if (!result[curKey]) result[curKey] = [];
            continue;
        }

        const listMatch = line.match(/^[\s]*-\s+(.+)$/);
        if (listMatch) {
            const val = listMatch[1].trim();
            if (curKey === null) {
                if (!result["__root__"]) result["__root__"] = [];
                result["__root__"].push(val);
            } else {
                result[curKey].push(val);
            }
            continue;
        }

        const inlineMatch = line.match(/^([A-Za-z0-9 _\-./]+):\s*\[(.+)\]$/);
        if (inlineMatch) {
            const k  = inlineMatch[1].trim();
            const vs = inlineMatch[2].split(",").map(s => s.trim()).filter(Boolean);
            result[k] = vs;
            curKey    = k;
            continue;
        }

        const bare = line.trim();
        if (bare && !bare.includes(":")) {
            if (!result["__root__"]) result["__root__"] = [];
            result["__root__"].push(bare);
        }
    }

    return result;
}

// ── Wildcard Loader Dialog ───────────────────────────────────────────────────
class WildcardLoader {
    constructor() {
        const { win, backdrop, body, closeBtn } = makeWindow({
            title:     "📂 Wildcards",
            width:     "500px",
            height:    "480px",
            minWidth:  "380px",
            minHeight: "300px",
            zIndex:    "10003",
        });
        this._win      = win;
        this._backdrop = backdrop;
        this._body     = body;
        closeBtn.addEventListener("click", () => this.hide());

        this._callback  = null;
        this._fileList  = [];
        this._data      = {};
        this._selected  = "";
        this._fileCache = {};
        this._loaded    = false;
    }

    async show(onTagSelected) {
        this._callback = onTagSelected;

        await this._loadFileList();

        const lastFile = localStorage.getItem(LAST_FILE_KEY) || "";
        if (lastFile && this._fileList.includes(lastFile)) {
            this._selected = lastFile;
        } else if (this._fileList.length > 0) {
            this._selected = this._fileList[0];
        } else {
            this._selected = "";
        }

        if (this._selected) {
            await this._loadFileData(this._selected);
        }

        this._render();
        this._backdrop.style.display = "block";
        this._win.style.display      = "flex";
        this._win.style.left         = "50%";
        this._win.style.top          = "160px";
        this._win.style.transform    = "translateX(-50%)";
    }

    hide() {
        this._backdrop.style.display = "none";
        this._win.style.display      = "none";
    }

    async _loadFileList() {
        try {
            const res = await fetch("/cwk/wildcards");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this._fileList = await res.json();
        } catch (e) {
            console.warn("[CWK] Failed to load wildcard file list:", e);
            this._fileList = [];
        }
        this._loaded = true;
    }

    async _loadFileData(filename) {
        if (this._fileCache[filename]) {
            this._data = this._fileCache[filename];
            return;
        }
        try {
            const res = await fetch(`/cwk/wildcards/${encodeURIComponent(filename)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            this._data = parseWildcardYaml(text);
            this._fileCache[filename] = this._data;
        } catch (e) {
            console.warn(`[CWK] Failed to load wildcard file "${filename}":`, e);
            this._data = {};
        }
    }

    _render() {
        this._body.innerHTML = "";
        // Make body a proper flex column so the entry list can grow
        Object.assign(this._body.style, {
            display: "flex", flexDirection: "column", flex: "1",
            minHeight: "0", overflowY: "hidden",
        });

        // ── File selector ────────────────────────────────────────────────
        const step1 = this._mkSection("Wildcard file");

        if (this._fileList.length === 0) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { color: "#6c7086", fontSize: "12px", padding: "8px 0", lineHeight: "1.6" });
            empty.innerHTML = 'No wildcard files found.<br>Place <code>.yaml</code> files in the <code>wildcards/</code> folder of this custom node.';
            step1.appendChild(empty);
            this._body.appendChild(step1);
            this._body.appendChild(this._mkCloseBtn());
            return;
        }

        const fileRow = document.createElement("div");
        Object.assign(fileRow.style, { display: "flex", gap: "8px", alignItems: "center" });

        const fileSelect = document.createElement("select");
        Object.assign(fileSelect.style, {
            flex: "1", padding: "6px 10px", background: "#1e2335", color: "#cdd6f4",
            border: "1px solid #313552", borderRadius: "6px", fontSize: "13px",
            cursor: "pointer", boxSizing: "border-box",
        });
        for (const f of this._fileList) {
            const opt = document.createElement("option");
            opt.value = f;
            const display = f.replace(/\.(yaml|yml)$/i, "").replace(/\//g, " › ");
            opt.textContent = display;
            if (f === this._selected) opt.selected = true;
            fileSelect.appendChild(opt);
        }

        const refreshBtn = document.createElement("button");
        refreshBtn.textContent = "🔄";
        refreshBtn.title = "Refresh file list";
        Object.assign(refreshBtn.style, {
            padding: "6px 10px", background: "#1a2535", color: "#89dceb",
            border: "1px solid #89dceb55", borderRadius: "6px",
            cursor: "pointer", fontSize: "13px", flexShrink: "0",
        });
        refreshBtn.addEventListener("click", async () => {
            this._fileCache = {};
            await this._loadFileList();
            if (this._selected && this._fileList.includes(this._selected)) {
                await this._loadFileData(this._selected);
            } else if (this._fileList.length > 0) {
                this._selected = this._fileList[0];
                await this._loadFileData(this._selected);
            } else {
                this._selected = "";
                this._data = {};
            }
            this._render();
        });

        fileSelect.addEventListener("change", async () => {
            this._selected = fileSelect.value;
            localStorage.setItem(LAST_FILE_KEY, this._selected);
            await this._loadFileData(this._selected);
            this._render();
        });

        fileRow.append(fileSelect, refreshBtn);
        step1.appendChild(fileRow);
        this._body.appendChild(step1);

        // ── No data ──────────────────────────────────────────────────────
        if (Object.keys(this._data).length === 0) {
            const empty = document.createElement("div");
            Object.assign(empty.style, { color: "#6c7086", fontSize: "12px", padding: "8px 0" });
            empty.textContent = "This file is empty or could not be parsed.";
            this._body.appendChild(empty);
            this._body.appendChild(this._mkCloseBtn());
            return;
        }

        // ── Category / key picker ────────────────────────────────────────
        const keys = Object.keys(this._data);
        const step2 = this._mkSection("Category");

        const keySelect = document.createElement("select");
        Object.assign(keySelect.style, {
            width: "100%", padding: "6px 10px", background: "#1e2335", color: "#cdd6f4",
            border: "1px solid #313552", borderRadius: "6px", fontSize: "13px",
            cursor: "pointer", boxSizing: "border-box",
        });

        const lastKey = localStorage.getItem(LAST_KEY_KEY + ":" + this._selected) || "";
        for (const k of keys) {
            const opt = document.createElement("option");
            opt.value = k;
            opt.textContent = k === "__root__"
                ? `(root list — ${this._data[k].length} entries)`
                : `${k}  (${this._data[k].length})`;
            if (k === lastKey) opt.selected = true;
            keySelect.appendChild(opt);
        }
        step2.appendChild(keySelect);
        this._body.appendChild(step2);

        // ── Entry list (this section grows on resize) ────────────────────
        const step3 = this._mkSection("Pick an entry");
        Object.assign(step3.style, { flex: "1", minHeight: "0", display: "flex", flexDirection: "column" });

        const listWrap = document.createElement("div");
        Object.assign(listWrap.style, {
            flex: "1", minHeight: "0", overflowY: "auto",
            background: "#141824", border: "1px solid #313552",
            borderRadius: "6px", padding: "6px",
            display: "flex", flexWrap: "wrap", gap: "4px",
            alignContent: "flex-start",
        });

        const renderList = (key) => {
            localStorage.setItem(LAST_KEY_KEY + ":" + this._selected, key);
            listWrap.innerHTML = "";
            const values = this._data[key] || [];
            if (values.length === 0) {
                const empty = document.createElement("span");
                empty.textContent = "(no entries)";
                Object.assign(empty.style, { color: "#313552", fontSize: "12px", padding: "4px" });
                listWrap.appendChild(empty);
                return;
            }
            for (const val of values) {
                const chip = document.createElement("div");
                chip.textContent = val;
                Object.assign(chip.style, {
                    padding: "2px 10px", borderRadius: "10px", background: "#1e2335",
                    border: "1px solid #94e2d555", color: "#94e2d5cc",
                    fontSize: "11px", cursor: "pointer", userSelect: "none", transition: "all 0.1s",
                });
                chip.addEventListener("mouseenter", () => { chip.style.background = "#94e2d522"; chip.style.borderColor = "#94e2d5"; chip.style.color = "#94e2d5"; });
                chip.addEventListener("mouseleave", () => { chip.style.background = "#1e2335";   chip.style.borderColor = "#94e2d555"; chip.style.color = "#94e2d5cc"; });
                chip.addEventListener("click", () => {
                    this._callback?.(val);
                    chip.style.background = "#94e2d544";
                    chip.style.borderColor = "#94e2d5";
                    setTimeout(() => { chip.style.background = "#1e2335"; chip.style.borderColor = "#94e2d555"; }, 300);
                });
                listWrap.appendChild(chip);
            }
        };

        renderList(keySelect.value);
        keySelect.addEventListener("change", () => renderList(keySelect.value));
        step3.appendChild(listWrap);

        // Random roll button
        const rollBtn = document.createElement("button");
        rollBtn.textContent = "🎲 Insert Random Entry";
        Object.assign(rollBtn.style, {
            marginTop: "8px", padding: "7px 16px", width: "100%",
            background: "#1f2040", color: "#cba6f7",
            border: "1px solid #cba6f7", borderRadius: "6px",
            cursor: "pointer", fontSize: "12px", fontWeight: "bold",
            fontFamily: "Inter, system-ui, sans-serif", flexShrink: "0",
        });
        rollBtn.addEventListener("click", () => {
            const values = this._data[keySelect.value] || [];
            if (!values.length) return;
            const pick = values[Math.floor(Math.random() * values.length)];
            this._callback?.(pick);
        });
        step3.appendChild(rollBtn);
        this._body.appendChild(step3);

        // ── Close ────────────────────────────────────────────────────────
        this._body.appendChild(this._mkCloseBtn());
    }

    _mkSection(labelText) {
        const wrap = document.createElement("div");
        Object.assign(wrap.style, { display: "flex", flexDirection: "column", gap: "6px", flexShrink: "0" });
        const lbl = document.createElement("div");
        lbl.textContent = labelText;
        Object.assign(lbl.style, {
            color: "#89b4fa", fontSize: "11px", fontWeight: "bold",
            letterSpacing: "0.04em", textTransform: "uppercase",
            fontFamily: "Inter, system-ui, sans-serif",
        });
        wrap.appendChild(lbl);
        return wrap;
    }

    _mkCloseBtn() {
        const wrap = document.createElement("div");
        Object.assign(wrap.style, { flexShrink: "0", display: "flex", justifyContent: "flex-end", paddingTop: "4px" });
        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Close";
        Object.assign(cancelBtn.style, {
            padding: "6px 18px", background: "#1e2335",
            color: "#cdd6f4", border: "1px solid #313552", borderRadius: "6px",
            cursor: "pointer", fontSize: "12px",
            fontFamily: "Inter, system-ui, sans-serif",
        });
        cancelBtn.addEventListener("click", () => this.hide());
        wrap.appendChild(cancelBtn);
        return wrap;
    }
}

export const wildcardLoader = new WildcardLoader();