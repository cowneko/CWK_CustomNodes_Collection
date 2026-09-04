// ── CWK Autocomplete Engine ──────────────────────────────────────────────────
// Builds a unified tag index from quality.json, aesthetic.json, negative.json,
// style tags, and danbooru-tags.txt (fetched from /cwk/danbooru_tags).
// Also indexes ComfyUI embeddings from /cwk/embeddings.

export const SECTION_COLORS = {
    quality:   "#f9e2af",
    style:     "#a6e3a1",       // ← NEW: green for Style
    aesthetic: "#cba6f7",
    main:      "#89dceb",
    negative:  "#fab387",
    embedding: "#a6e3a1",
    wildcard:  "#94e2d5",
    custom:    "#cdd6f4",
};

// ── Tag index entry: { tag, section, category, lowerTag } ────────────────────
let _index = [];
let _ready = false;
let _readyPromise = null;

export function isReady() { return _ready; }

export function waitReady() {
    if (_ready) return Promise.resolve();
    return _readyPromise || Promise.resolve();
}

export function getIndex() { return _index; }

// ── Build index ──────────────────────────────────────────────────────────────
export async function buildIndex(tagData) {
    _readyPromise = _buildInternal(tagData);
    await _readyPromise;
    _ready = true;
}

async function _buildInternal(tagData) {
    const entries = [];
    const seen = new Set();

    const add = (tag, section, category) => {
        const key = `${tag}|||${section}`;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ tag, section, category, lowerTag: tag.toLowerCase() });
    };

    // Quality tags
    if (tagData.quality) {
        for (const group of tagData.quality) {
            for (const sub of group.subcategories || []) {
                for (const t of sub.tags) add(t, "quality", sub.name);
            }
        }
    }

    // ── NEW: Style tags ──
    if (tagData.style) {
        for (const group of tagData.style) {
            for (const sub of group.subcategories || []) {
                for (const t of sub.tags) add(t, "style", sub.name);
            }
        }
    }

    // Aesthetic tags
    if (tagData.aesthetic) {
        for (const group of tagData.aesthetic) {
            for (const sub of group.subcategories || []) {
                for (const t of sub.tags) add(t, "aesthetic", sub.name);
            }
        }
    }

    // Negative tags
    if (tagData.negative) {
        for (const group of tagData.negative) {
            for (const sub of group.subcategories || []) {
                for (const t of sub.tags) add(t, "negative", sub.name);
            }
        }
    }

    // Danbooru tags (main prompt)
    try {
        const res = await fetch("/cwk/danbooru_tags");
        if (res.ok) {
            const text = await res.text();
            const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
            for (const t of lines) add(t, "main", "danbooru");
            console.log(`[CWK] Loaded ${lines.length} danbooru tags`);
        }
    } catch (e) {
        console.warn("[CWK] Failed to load danbooru tags:", e);
    }

    // Embeddings
    try {
        const res = await fetch("/cwk/embeddings");
        if (res.ok) {
            const names = await res.json();
            for (const name of names) add(`embedding:${name}`, "embedding", "embedding");
        }
    } catch (e) {
        console.warn("[CWK] Failed to load embeddings:", e);
    }

    _index = entries;
    console.log(`[CWK] Autocomplete index: ${_index.length} entries`);
}

// ── Search ───────────────────────────────────────────────────────────────────
export function search(query, { limit = 30, sections = null } = {}) {
    if (!query || !_ready) return [];
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const results = [];
    const prefixResults = [];
    const containsResults = [];

    for (const entry of _index) {
        if (sections && !sections.includes(entry.section)) continue;

        if (entry.lowerTag === q) {
            results.push({ ...entry, matchType: "exact" });
        } else if (entry.lowerTag.startsWith(q)) {
            prefixResults.push({ ...entry, matchType: "prefix" });
        } else if (entry.lowerTag.includes(q)) {
            containsResults.push({ ...entry, matchType: "contains" });
        }

        if (results.length + prefixResults.length + containsResults.length >= limit * 3) break;
    }

    prefixResults.sort((a, b) => a.tag.length - b.tag.length);
    containsResults.sort((a, b) => a.tag.length - b.tag.length);

    return [...results, ...prefixResults, ...containsResults].slice(0, limit);
}

// ── Determine section of a tag string ────────────────────���───────────────────
export function classifyTag(tagStr) {
    if (!_ready) return "custom";
    const lower = tagStr.toLowerCase().trim();

    // Special types
    if (lower.startsWith("embedding:")) return "embedding";
    if (lower.startsWith("__") && lower.endsWith("__")) return "wildcard";

    // Weighted tag: strip (tag:1.2) → tag
    let bare = lower;
    const weightMatch = bare.match(/^\((.+):[\d.]+\)$/);
    if (weightMatch) bare = weightMatch[1].trim();

    for (const entry of _index) {
        if (entry.lowerTag === bare) return entry.section;
    }
    return "custom";
}

// ── Get color for a section ──────────────────────────────────────────────────
export function sectionColor(section) {
    return SECTION_COLORS[section] || SECTION_COLORS.custom;
}