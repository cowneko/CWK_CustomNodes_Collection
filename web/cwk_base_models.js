/**
 * CWK Base-Model list — shared helper.
 *
 * Fetches the current list of CivitAI `baseModel` enum values from
 * `/cwk/civitai/base_models` (backed by `server.py`, which itself caches
 * CivitAI's `/api/v1/enums` response) and derives:
 *   - filter matchers for the Model Browser panel's "Base Model" dropdown
 *   - colour-coded badges for the Model Loader's quick-load dropdowns
 *
 * The fetched list (and derived matchers/badges) is cached in-memory for the
 * lifetime of the page session — callers should not need to re-fetch on every
 * panel open / dropdown build.
 */

// Small built-in fallback used only if the backend is unreachable.
const FALLBACK_BASE_MODELS = [
  "SD 1.5", "SDXL", "Pony", "Illustrious", "NoobAI", "Flux", "Chroma",
  "Qwen", "Wan Video", "Hunyuan Video", "ZImage", "Other",
];

export const OTHERS_MATCH = "__others__";

const OTHER_COLOR = "#6c7086";

// ─── Fetch + cache ─────────────────────────────────────────────────────────

let _listPromise = null;

async function _fetchBaseModelNames() {
  try {
    const res = await fetch("/cwk/civitai/base_models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.base_models) && data.base_models.length) {
      return data.base_models;
    }
  } catch (e) {
    console.warn("[CWK] Could not fetch CivitAI base-model list, using fallback:", e);
  }
  return FALLBACK_BASE_MODELS;
}

/**
 * Returns a (cached) promise resolving to the raw list of base-model name
 * strings, e.g. ["SD 1.5", "SDXL", "Pony", ...].
 */
export function getBaseModelList() {
  if (!_listPromise) _listPromise = _fetchBaseModelNames();
  return _listPromise;
}

// ─── Derivation helpers ────────────────────────────────────────────────────

function _deriveMatch(name) {
  const low = name.toLowerCase().trim();
  const match = [low];
  // "Wan Video" -> also match "wan"; "Hunyuan Video" -> also match "hunyuan".
  const suffixed = low.match(/^(.+?)\s+(video|image)$/);
  if (suffixed && suffixed[1]) match.push(suffixed[1]);
  return match;
}

function _deriveLabel(name) {
  const trimmed = name.trim();
  return trimmed.length > 16 ? trimmed.slice(0, 15) + "…" : trimmed;
}

function _hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Deterministic HSL colour for a given base-model name (stable across reloads). */
function _colorForName(name) {
  const hue = _hashString(name.toLowerCase()) % 360;
  return `hsl(${hue}, 65%, 68%)`;
}

function _isOtherName(name) {
  return (name || "").trim().toLowerCase() === "other";
}

// ─── Filter matchers (Model Browser panel) ────────────────────────────────

let _matchersPromise = null;

/**
 * Returns a (cached) promise resolving to the full filter-dropdown option
 * list: static "All Types" bookend, dynamic CivitAI-derived entries, static
 * "Others" bookend.
 */
export function getBaseModelMatchers() {
  if (!_matchersPromise) {
    _matchersPromise = getBaseModelList().then(names => {
      const middle = names
        .filter(n => n && !_isOtherName(n))
        .map(n => ({ label: _deriveLabel(n), match: _deriveMatch(n) }));
      return [
        { label: "All Types", match: null },
        ...middle,
        { label: "Others", match: OTHERS_MATCH },
      ];
    });
  }
  return _matchersPromise;
}

// ─── Badges (Model Loader quick-load dropdowns) ───────────────────────────

let _badgesPromise = null;

/**
 * Returns a (cached) promise resolving to the badge list used by
 * `getBaseBadge()` — one entry per non-"Other" CivitAI base model, each with
 * a `match` keyword array, a compact `label`, and a deterministic `color`.
 */
export function getBaseModelBadges() {
  if (!_badgesPromise) {
    _badgesPromise = getBaseModelList().then(names =>
      names
        .filter(n => n && !_isOtherName(n))
        .map(n => ({
          match: _deriveMatch(n),
          label: _deriveLabel(n),
          color: _colorForName(n),
        }))
    );
  }
  return _badgesPromise;
}

/**
 * Synchronous badge lookup used by callers that keep a locally-resolved copy
 * of `getBaseModelBadges()` (e.g. fetched once at module load). Falls back to
 * "???" / "Other" (grey, matching the pre-existing convention) when the
 * base-model string is empty or unrecognised, or when `badges` hasn't
 * resolved yet.
 */
export function getBaseBadge(baseModel, badges) {
  if (!baseModel) return { label: "???", color: OTHER_COLOR };
  const low = baseModel.toLowerCase();
  for (const b of badges || []) {
    for (const m of b.match) { if (low.includes(m)) return b; }
  }
  return { label: "Other", color: OTHER_COLOR };
}
