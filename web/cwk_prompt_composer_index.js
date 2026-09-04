import { app } from "../../scripts/app.js";
import { PromptPanel, loadAllTags } from "./cwk_prompt_composer_prompt_panel.js";

// ── Colors ────────────────────────────────────────────────────────────
const NODE_COLOR   = "#141824";
const NODE_BGCOLOR = "#1a1f2e";
const C = {
    surface:  "#1e2335",
    border:   "#313552",
    text:     "#cdd6f4",
    textDim:  "#6c7086",
    textBlue: "#89b4fa",
};

const PARSERS = ["comfy", "A1111"];

// ── Extension ──────────────────────────────────────────────────────────
app.registerExtension({
    name: "CWK.PromptComposer",

    async setup() {
        await loadAllTags();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "CWKPromptComposerNode") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply?.(this, arguments);

            this.color   = NODE_COLOR;
            this.bgcolor = NODE_BGCOLOR;

            // ── Build widget map & hide native widgets ───────────────────
            const widgetMap = {};
            for (const w of (this.widgets ?? [])) {
                widgetMap[w.name] = w;
                if (["positive_prompt", "negative_prompt", "parser", "flux_guidance", "zero_out_negative"].includes(w.name)) {
                    w.type        = "converted-widget";
                    w.hidden      = true;
                    w.computeSize = () => [0, -4];
                }
            }

            // ── Main container ───────────────────────────────────────────
            const container = document.createElement("div");
            container.id = `cwk-composer-${this.id}`;
            Object.assign(container.style, {
                display:       "flex",
                flexDirection: "column",
                gap:           "6px",
                padding:       "8px",
                boxSizing:     "border-box",
                width:         "100%",
                height:        "100%",
                fontFamily:    "Inter, system-ui, sans-serif",
                overflow:      "hidden",
            });

            // ── Shared input style helper ────────────────────────────────
            const inputStyle = {
                padding: "2px 6px", background: C.surface, color: C.text,
                border: `1px solid ${C.border}`, borderRadius: "4px",
                fontSize: "11px", outline: "none",
            };
            const stopPropagation = (el) => {
                for (const evt of ["mousedown", "mouseup", "click", "keydown"]) {
                    el.addEventListener(evt, (e) => e.stopPropagation());
                }
            };

            // ── Parser row ───────────────────────────────────────────────
            const parserRow = document.createElement("div");
            Object.assign(parserRow.style, {
                display: "flex", alignItems: "center", gap: "8px",
                flexShrink: "0", flexWrap: "wrap",
            });

            // Parser label + select
            const parserLabel = document.createElement("span");
            parserLabel.textContent = "Parser";
            Object.assign(parserLabel.style, { color: C.textDim, fontSize: "11px" });

            const parserSelect = document.createElement("select");
            Object.assign(parserSelect.style, { ...inputStyle, cursor: "pointer" });
            for (const opt of PARSERS) {
                const o = document.createElement("option");
                o.value = opt; o.textContent = opt;
                if (widgetMap.parser?.value === opt) o.selected = true;
                parserSelect.appendChild(o);
            }
            parserSelect.addEventListener("change", () => {
                if (widgetMap.parser) { widgetMap.parser.value = parserSelect.value; widgetMap.parser.callback?.(parserSelect.value); }
            });
            stopPropagation(parserSelect);

            // ── Spacer ───────────────────────────────────────────────────
            const spacer = document.createElement("div");
            spacer.style.flex = "1";

            // ── Flux Guidance ────────────────────────────────────────────
            const guidanceLabel = document.createElement("span");
            guidanceLabel.textContent = "Flux Guidance";
            Object.assign(guidanceLabel.style, { color: C.textDim, fontSize: "11px" });

            const guidanceInput = document.createElement("input");
            guidanceInput.type = "number";
            guidanceInput.min = "0"; guidanceInput.max = "100"; guidanceInput.step = "0.1";
            guidanceInput.value = widgetMap.flux_guidance?.value ?? 3.5;
            Object.assign(guidanceInput.style, { ...inputStyle, width: "52px", textAlign: "center" });
            guidanceInput.addEventListener("change", () => {
                let val = parseFloat(guidanceInput.value);
                if (isNaN(val)) val = 3.5;
                val = Math.max(0, Math.min(100, val));
                guidanceInput.value = val;
                if (widgetMap.flux_guidance) {
                    widgetMap.flux_guidance.value = val;
                    widgetMap.flux_guidance.callback?.(val);
                }
            });
            stopPropagation(guidanceInput);

            // ── ConditioningZeroOut toggle ────────────────────────────────
            const zeroOutLabel = document.createElement("span");
            zeroOutLabel.textContent = "Zero Out Neg";
            Object.assign(zeroOutLabel.style, { color: C.textDim, fontSize: "11px" });

            const zeroOutCheckbox = document.createElement("input");
            zeroOutCheckbox.type = "checkbox";
            zeroOutCheckbox.checked = widgetMap.zero_out_negative?.value ?? false;
            Object.assign(zeroOutCheckbox.style, {
                accentColor: "#f38ba8", cursor: "pointer",
                width: "14px", height: "14px",
            });
            zeroOutCheckbox.addEventListener("change", () => {
                if (widgetMap.zero_out_negative) {
                    widgetMap.zero_out_negative.value = zeroOutCheckbox.checked;
                    widgetMap.zero_out_negative.callback?.(zeroOutCheckbox.checked);
                }
            });
            stopPropagation(zeroOutCheckbox);

            parserRow.append(
                parserLabel, parserSelect,
                spacer,
                guidanceLabel, guidanceInput,
                zeroOutLabel, zeroOutCheckbox,
            );
            container.appendChild(parserRow);

            // Separator
            const sep = document.createElement("hr");
            Object.assign(sep.style, { border: "none", borderTop: `1px solid ${C.border}`, margin: "0", flexShrink: "0" });
            container.appendChild(sep);

            // ── Panels container (flex-grow) ─────────────────────────────
            const panelsContainer = document.createElement("div");
            Object.assign(panelsContainer.style, {
                display:       "flex",
                flexDirection: "column",
                gap:           "6px",
                flex:          "1 1 0",
                minHeight:     "0",
                overflow:      "hidden",
            });

            // ── Flag to prevent onChange → widget → onChange loops ────────
            let _syncing = false;

            const positivePanel = new PromptPanel({
                kind: "positive",
                onChange: (val) => {
                    if (_syncing) return;
                    if (widgetMap.positive_prompt) widgetMap.positive_prompt.value = val;
                },
            });

            const negativePanel = new PromptPanel({
                kind: "negative",
                onChange: (val) => {
                    if (_syncing) return;
                    if (widgetMap.negative_prompt) widgetMap.negative_prompt.value = val;
                },
            });

            // Store panel refs directly on the node instance
            this._cwkPositivePanel = positivePanel;
            this._cwkNegativePanel = negativePanel;
            this._cwkWidgetMap     = widgetMap;
            this._cwkSyncing       = (fn) => { _syncing = true; try { fn(); } finally { _syncing = false; } };

            // Store UI control refs for state restore
            this._cwkGuidanceInput  = guidanceInput;
            this._cwkZeroOutCheckbox = zeroOutCheckbox;
            this._cwkParserSelect   = parserSelect;

            if (widgetMap.positive_prompt?.value) positivePanel.setValue(widgetMap.positive_prompt.value);
            if (widgetMap.negative_prompt?.value) negativePanel.setValue(widgetMap.negative_prompt.value);

            panelsContainer.append(positivePanel.el, negativePanel.el);
            container.appendChild(panelsContainer);

            // ── DOM widget ───────────────────────────────────────────────
            const nodeRef = this;
            const widget = this.addDOMWidget("cwk_composer_ui", "customtext", container, {
                getValue: () => "",
                setValue: () => {},
                getMinHeight: () => 200,
            });

            widget.computeSize = undefined;
            widget.serializeValue = () => undefined;

            this.size = [420, 520];
        };

        // ── Serialization: save panel state ──────────────────────────────
        const origSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            origSerialize?.apply?.(this, arguments);
            o.cwk_state = {
                positive: this._cwkPositivePanel?.getState() ?? null,
                negative: this._cwkNegativePanel?.getState() ?? null,
            };
        };

        // ── Configure: stash state for restore after node is added ───────
        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (o) {
            origConfigure?.apply?.(this, arguments);
            if (o.cwk_state) this._cwkPendingState = o.cwk_state;

            if (this._cwkPendingState && this._cwkPositivePanel) {
                this._restoreCwkState();
            }
        };

        // ── Helper: restore stashed state into panels ────────────────────
        nodeType.prototype._restoreCwkState = function () {
            const pending = this._cwkPendingState;
            if (!pending) return;

            const sync = this._cwkSyncing || ((fn) => fn());

            sync(() => {
                if (this._cwkPositivePanel && pending.positive) {
                    this._cwkPositivePanel.restoreState(pending.positive);
                }
                if (this._cwkNegativePanel && pending.negative) {
                    this._cwkNegativePanel.restoreState(pending.negative);
                }

                const wm = this._cwkWidgetMap || {};
                if (wm.positive_prompt && this._cwkPositivePanel) {
                    wm.positive_prompt.value = this._cwkPositivePanel.getValue();
                }
                if (wm.negative_prompt && this._cwkNegativePanel) {
                    wm.negative_prompt.value = this._cwkNegativePanel.getValue();
                }

                if (this._cwkParserSelect && wm.parser) {
                    this._cwkParserSelect.value = wm.parser.value;
                }
                if (this._cwkGuidanceInput && wm.flux_guidance) {
                    this._cwkGuidanceInput.value = wm.flux_guidance.value;
                }
                if (this._cwkZeroOutCheckbox && wm.zero_out_negative) {
                    this._cwkZeroOutCheckbox.checked = wm.zero_out_negative.value;
                }
            });

            delete this._cwkPendingState;
        };

        // ── onAdded: restore pending state once node is in the graph ─────
        const origOnAdded = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            origOnAdded?.apply?.(this, arguments);
            if (this._cwkPendingState) {
                this._restoreCwkState();
            }
        };

        // ── Resize hook ──────────────────────────────────────────────────
        const origOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function () {
            origOnResize?.apply?.(this, arguments);
            this.setDirtyCanvas?.(true, true);
        };
    },
});