"""
CWK LoRA Loader — node + CivitAI metadata routes.

Node:
- CWK_LoraLoader: applies a stack of LoRAs (per-LoRA weight + enable toggle;
  the global activate/deactivate toggle lives in the JS frontend) to a
  MODEL/CLIP pair and outputs the combined trigger words.

Server routes (registered on PromptServer, same pattern as nodes.py):
- GET    /cwk/loras                → installed LoRAs + resolved base model
                                      (custom → CivitAI → safetensors metadata)
                                      + cached CivitAI metadata
- GET    /cwk/loras/settings       → LoRA Loader settings
- POST   /cwk/loras/settings        → update LoRA Loader settings
- GET    /cwk/lora/trigger_words    → resolved trigger words for one LoRA
- POST   /cwk/lora/meta             → custom description / triggers / base model /
                                      version / nsfw flag / clear thumbnail
- POST   /cwk/lora/favorite         → toggle favorite
- POST   /cwk/loras/refresh         → re-fetch one LoRA from CivitAI (hash →
                                      fallback chain: .civitai.info sidecar →
                                      filename search)
- POST   /cwk/loras/fetch/stream    → SSE bulk fetch (hash lookup with 429
                                      backoff, model-page image fallback,
                                      local thumbnail caching)
- POST   /cwk/lora/lookup_by_id     → manual rescue: match a LoRA to a CivitAI
                                      model by URL / id (civitai.red downloads
                                      of models deleted from civitai.com)
- POST   /cwk/lora/thumbnail        → upload a custom thumbnail (multipart)
- GET    /cwk/loras/thumb/{file}   → serve custom + cached thumbnails
- DELETE /cwk/loras/cache           → wipe the LoRA metadata cache + thumbnails
"""

import asyncio
import hashlib
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import folder_paths

_NODE_DIR    = os.path.dirname(__file__)
_LORA_CACHE  = os.path.join(_NODE_DIR, "lora_cache.json")
_THUMB_DIR   = os.path.join(_NODE_DIR, "lora_thumbs")
_CIVITAI_API = "https://civitai.com/api/v1"
_LORA_SETTINGS_FILE = os.path.join(_NODE_DIR, "lora_settings.json")

NSFW_R = 2  # thumbnails at/above this level are blurred until revealed

# User-defined values that must survive a CivitAI re-fetch
_KEEP_FIELDS = (
    "favorite", "nsfw_manual",
    "custom_description", "custom_triggers",
    "custom_base_model", "custom_version", "custom_thumbnail",
)


# ─── Loader settings (⚙ popup; global, persisted as lora_settings.json) ──────

_DEFAULT_LORA_SETTINGS: Dict[str, Any] = {
    "default_strength": 1.0,    # weight pre-filled on new LoRA rows
    "strength_step":    0.05,   # slider step in the loader rows
    "keep_in_memory":   False,  # keep loaded LoRA weights in RAM between runs
    "truncate_names":   False,  # display-only: strip folders/extension in dropdowns
}

_settings_cache: Optional[Dict[str, Any]] = None


def _load_lora_settings(force: bool = False) -> Dict[str, Any]:
    global _settings_cache
    if _settings_cache is not None and not force:
        return _settings_cache
    s = dict(_DEFAULT_LORA_SETTINGS)
    try:
        with open(_LORA_SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in s:
                if k in data:
                    s[k] = data[k]
    except Exception:
        pass
    try:
        s["default_strength"] = max(-2.0, min(2.0, float(s["default_strength"])))
    except (TypeError, ValueError):
        s["default_strength"] = 1.0
    try:
        s["strength_step"] = max(0.001, min(1.0, float(s["strength_step"])))
    except (TypeError, ValueError):
        s["strength_step"] = 0.05
    s["keep_in_memory"] = bool(s["keep_in_memory"])
    s["truncate_names"] = bool(s["truncate_names"])
    _settings_cache = s
    return s


def _save_lora_settings(s: Dict[str, Any]) -> None:
    global _settings_cache
    _settings_cache = dict(s)
    try:
        with open(_LORA_SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(s, f, indent=2)
    except Exception as e:
        print(f"[CWK LoRA] Error saving settings: {e}")


# ─── Cache handling ──────────────────────────────────────────────────────────

def _load_lora_cache() -> Dict[str, Any]:
    if os.path.exists(_LORA_CACHE):
        try:
            with open(_LORA_CACHE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data.get("loras"), dict):
                return data
        except Exception as e:
            print(f"[CWK LoRA] Error loading cache: {e}")
    return {"loras": {}}


def _save_lora_cache(cache: Dict[str, Any]) -> None:
    try:
        with open(_LORA_CACHE, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2)
    except Exception as e:
        print(f"[CWK LoRA] Error saving cache: {e}")


def _list_loras() -> List[str]:
    try:
        return folder_paths.get_filename_list("loras")
    except Exception:
        return []


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_hash(path: str, entry: dict) -> str:
    """SHA-256 of a LoRA file, cached by (size, mtime) inside the entry."""
    try:
        st = os.stat(path)
    except OSError:
        return ""
    key = [st.st_size, int(st.st_mtime)]
    if entry.get("_hash_key") == key and entry.get("sha256"):
        return entry["sha256"]
    try:
        sha = _sha256(path)
    except Exception as e:
        print(f"[CWK LoRA] Hashing failed for {path}: {e}")
        return ""
    entry["_hash_key"] = key
    entry["sha256"]    = sha
    return sha


# ─── Metadata resolution (custom override → CivitAI → empty) ────────────────

def _html_to_text(html: str) -> str:
    import html as _html
    text = _html.unescape(str(html or ""))
    text = re.sub(r"<br\s*/?>",     "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|li)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _split_triggers(text: str) -> List[str]:
    out, seen = [], set()
    for p in re.split(r"[,\n]+", text or ""):
        p = p.strip()
        if p and p.lower() not in seen:
            seen.add(p.lower())
            out.append(p)
    return out


def _resolve_description(civ: Dict[str, Any]) -> str:
    custom = (civ.get("custom_description") or "").strip()
    return custom or (civ.get("description") or "").strip()


def _resolve_triggers(civ: Dict[str, Any]) -> List[str]:
    custom = (civ.get("custom_triggers") or "").strip()
    if custom:
        return _split_triggers(custom)
    return [str(t).strip() for t in civ.get("trigger_words", []) if str(t).strip()]


def _resolve_base(civ: Dict[str, Any]) -> str:
    custom = (civ.get("custom_base_model") or "").strip()
    return custom or (civ.get("base_model") or "")


def _resolve_version(civ: Dict[str, Any]) -> str:
    custom = (civ.get("custom_version") or "").strip()
    return custom or (civ.get("version_name") or "")


def _resolve_thumbnail(civ: Dict[str, Any]) -> str:
    return civ.get("custom_thumbnail") or civ.get("thumbnail") or ""


def _is_video_media(img: Dict[str, Any]) -> bool:
    """CivitAI flags video entries via `type: "video"`; the URL usually (but
    not always — some CDN/transcode URLs carry no recognisable extension)
    also ends in .mp4/.webm. Check both so a video isn't mis-filed as a still."""
    if str(img.get("type") or "").lower() == "video":
        return True
    url = (img.get("url") or "").lower()
    return url.endswith(".mp4") or url.endswith(".webm")


def _extract_media_entries(ver: Dict[str, Any]) -> Tuple[List[Tuple[str, int]], List[Tuple[str, int]]]:
    """(url, nsfwLevel) lists for the still images and the videos of a version."""
    imgs: List[Tuple[str, int]] = []
    vids: List[Tuple[str, int]] = []
    for img in (ver.get("images") or []):
        url = img.get("url")
        if not url:
            continue
        t = str(img.get("type") or "").lower()
        if t not in ("", "image", "video"):
            continue
        try:
            lvl = int(img.get("nsfwLevel") or 0)
        except (TypeError, ValueError):
            lvl = 0
        (vids if _is_video_media(img) else imgs).append((url, lvl))
    return imgs, vids


def _parse_version(ver: Dict[str, Any]) -> Dict[str, Any]:
    """Extract the fields we keep from a CivitAI model-version dict."""
    model = ver.get("model") or {}
    img_entries, vid_entries = _extract_media_entries(ver)

    nsfw_level = max([lvl for _, lvl in img_entries + vid_entries], default=0)
    try:
        nsfw_level = max(nsfw_level, int(model.get("nsfwLevel") or 0))
    except (TypeError, ValueError):
        pass

    images = [u for u, _ in img_entries]
    videos = [u for u, _ in vid_entries]

    # still image preferred; video only when the version has no images at all
    if images:
        thumbnail, thumb_is_video = (
            next((u for u, lvl in img_entries if lvl < NSFW_R), images[0]), False)
    elif videos:
        thumbnail, thumb_is_video = (
            next((u for u, lvl in vid_entries if lvl < NSFW_R), videos[0]), True)
    else:
        thumbnail, thumb_is_video = None, False

    return {
        "civitai_name":  model.get("name"),
        "model_id":      model.get("id"),
        "version_id":    ver.get("id"),
        "version_name":  ver.get("name"),
        "base_model":    ver.get("baseModel"),
        "description":   _html_to_text(ver.get("description")),
        "trigger_words": [str(t) for t in (ver.get("trainedWords") or []) if str(t).strip()],
        "images":        images,
        "videos":        videos,
        "thumbnail":     thumbnail,
        "thumbnail_is_video": thumb_is_video,
        "nsfw_level":    nsfw_level,
    }


def _public_civitai(civ: Dict[str, Any]) -> Dict[str, Any]:
    """Shape returned to the frontend (mirrors the model browser's civitai dict)."""
    return {
        "fetched":            bool(civ.get("fetched")),
        # resolved values (custom override → CivitAI → empty)
        "thumbnail":          _resolve_thumbnail(civ),
        "version_name":       _resolve_version(civ),
        "base_model":         _resolve_base(civ),
        "description":        _resolve_description(civ),
        "trigger_words":      _resolve_triggers(civ),
        "thumbnail_custom":   bool(civ.get("custom_thumbnail")),
        # raw values (for edit-mode pre-fill / source badges)
        "images":             civ.get("images", []),
        "videos":            civ.get("videos", []),
        "thumbnail_is_video": ((not civ.get("custom_thumbnail")
                                and bool(civ.get("thumbnail_is_video")))
                               or _resolve_thumbnail(civ).lower().split("?")[0]
                                   .endswith((".mp4", ".webm"))),
        "civitai_name":       civ.get("civitai_name"),
        "model_id":           civ.get("model_id"),
        "version_id":         civ.get("version_id"),
        "civitai_description":  (civ.get("description") or ""),
        "civitai_trigger_words": [str(t) for t in civ.get("trigger_words", [])],
        "custom_description":   (civ.get("custom_description") or ""),
        "custom_triggers":      (civ.get("custom_triggers") or ""),
        "custom_base_model":    (civ.get("custom_base_model") or ""),
        "custom_version":       (civ.get("custom_version") or ""),
        "favorite":           bool(civ.get("favorite")),
        "nsfw_level":         civ.get("nsfw_level", 0),
        "nsfw_manual":        civ.get("nsfw_manual"),
        "not_on_civitai":     bool(civ.get("not_on_civitai")),
        # data provenance for hash-miss rescues:
        # "sidecar" (.civitai.info) | "filename" (search, unverified) |
        # "manual" (linked by URL) | None (hash-verified / no data)
        "match":              civ.get("match"),
        "error":              civ.get("error"),
    }


def _lora_triggers(name: str) -> List[str]:
    cache = _load_lora_cache().get("loras", {})
    civ   = cache.get(name, {}).get("civitai", {})
    return _resolve_triggers(civ)


# ─── Base-model fallback from safetensors __metadata__ ──────────────────────

_SF_BASE_PATTERNS: List[Tuple[str, Tuple[str, ...]]] = [
    # CivitAI's baseModel always wins when present — embedded metadata can't
    # tell Pony/Illustrious apart from plain SDXL (they all report
    # sd_xl_base_1.0), so this is only a fallback for CivitAI-miss LoRAs.
    ("Flux", ("flux",)), ("Chroma", ("chroma",)), ("SD 3.5", ("sd3",)),
    ("Illustrious", ("illustrious", "noob")), ("Pony", ("pony",)),
    ("SDXL", ("sdxl", "sd_xl")),
    ("SD 2.1", ("sd2", "v2-1", "v2.1")),
    ("SD 1.5", ("sd15", "sd1.5", "sd_1.5", "sd-v1", "v1-5", "v1.5",
                "stable-diffusion-v1")),
    ("Wan Video", ("wan",)), ("Qwen", ("qwen",)), ("Hunyuan", ("hunyuan",)),
]


def _safetensors_meta(path: str) -> Dict[str, Any]:
    """Read the __metadata__ dict from a safetensors header (no full load)."""
    import struct
    try:
        with open(path, "rb") as f:
            (n,) = struct.unpack("<Q", f.read(8))
            if n <= 0 or n > 16 * 1024 * 1024:
                return {}
            header = json.loads(f.read(n))
        meta = header.get("__metadata__") if isinstance(header, dict) else None
        return meta if isinstance(meta, dict) else {}
    except Exception:
        return {}


def _base_from_sf_meta(meta: Dict[str, Any]) -> str:
    for key in ("ss_base_model_version", "base_model", "base_model_version",
                "ss_sd_model_name"):
        val = str(meta.get(key) or "").lower()
        if not val:
            continue
        for label, needles in _SF_BASE_PATTERNS:
            if any(n in val for n in needles):
                return label
    return ""


def _sf_base_for(name: str, entry: Dict[str, Any]) -> Tuple[str, bool]:
    """→ (base_model, cache_changed). Cached by (size, mtime) in the entry."""
    if not name.lower().endswith(".safetensors"):
        return entry.get("sf_base_model", ""), False
    path = folder_paths.get_full_path("loras", name)
    if not path or not os.path.exists(path):
        return entry.get("sf_base_model", ""), False
    try:
        st = os.stat(path)
        key = [st.st_size, int(st.st_mtime)]
    except OSError:
        return entry.get("sf_base_model", ""), False
    if entry.get("_sf_key") == key and "sf_base_model" in entry:
        return entry["sf_base_model"], False
    base = _base_from_sf_meta(_safetensors_meta(path))
    entry["_sf_key"]       = key
    entry["sf_base_model"] = base
    return base, True


def _lora_api_list() -> List[Dict[str, Any]]:
    cache = _load_lora_cache()
    loras = cache.get("loras", {})
    out, dirty = [], False
    for name in _list_loras():
        entry = loras.setdefault(name, {"civitai": {}})
        civ   = entry.get("civitai", {})
        base  = _resolve_base(civ)                # custom → CivitAI
        if not base:                              # → safetensors metadata
            base, changed = _sf_base_for(name, entry)
            dirty = dirty or changed
        out.append({"name": name, "type": "lora", "base_model": base,
                    "civitai": _public_civitai(civ)})
    if dirty:
        _save_lora_cache(cache)
    return out


async def _sse_write(resp, payload: Dict[str, Any]) -> None:
    await resp.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))


# ─── CivitAI HTTP helpers ───────────────────────────────────────────────────

async def _civitai_get_json(session, url: str, params=None, tries: int = 3):
    """GET → (status, json|None). Retries 429s (and timeouts) with exponential
    backoff — CivitAI rate-limits bursts and a single 429 used to poison a
    whole bulk fetch."""
    delay = 2.0
    for attempt in range(tries):
        try:
            async with session.get(url, params=params) as r:
                if r.status == 429 and attempt < tries - 1:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                if r.status != 200:
                    return r.status, None
                return 200, await r.json(content_type=None)
        except asyncio.TimeoutError:
            if attempt < tries - 1:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            raise
    return 0, None


async def _fill_from_model_page(session, info: Dict[str, Any], api_key: str) -> None:
    """A version can have zero images while the model page has plenty —
    borrow them from the model's other versions (fixes 'description only').
    Still images are preferred; videos are used when no version has any."""
    model_id = info.get("model_id")
    if not model_id:
        return
    params = {"token": api_key} if api_key else None
    try:
        status, data = await _civitai_get_json(
            session, f"{_CIVITAI_API}/models/{model_id}", params)
    except Exception as e:
        print(f"[CWK LoRA] model-page fallback error: {e}")
        return
    if status != 200 or not isinstance(data, dict):
        return
    versions = [v for v in (data.get("modelVersions") or []) if isinstance(v, dict)]
    versions.sort(key=lambda v: (v.get("id") == info.get("version_id"),
                                 str(v.get("createdAt") or "")), reverse=True)

    img_pick = None   # (entries, version)
    vid_pick = None
    for v in versions:
        img_entries, vid_entries = _extract_media_entries(v)
        if img_entries and img_pick is None:
            img_pick = (img_entries, v)
        if vid_entries and vid_pick is None:
            vid_pick = (vid_entries, v)

    pick = img_pick or vid_pick
    if pick:
        entries, v = pick
        is_video = pick is vid_pick
        urls = [u for u, _ in entries]
        if is_video:
            info["videos"] = urls
            info["images"] = info.get("images") or []
        else:
            info["images"] = urls
            info.setdefault("videos", [])
        info["thumbnail"] = next((u for u, lvl in entries if lvl < NSFW_R), urls[0])
        info["thumbnail_is_video"] = is_video
        info["nsfw_level"] = max(int(info.get("nsfw_level") or 0),
                                 max((lvl for _, lvl in entries), default=0))
        if not info.get("trigger_words"):
            info["trigger_words"] = [str(t) for t in (v.get("trainedWords") or [])
                                     if str(t).strip()]

    if not info.get("description"):
        desc = _html_to_text(data.get("description") or "")
        if desc:
            info["description"] = desc[:4000]


async def _civitai_lookup(session, sha: str, api_key: str) -> Tuple[bool, Any]:
    """CivitAI hash lookup → (True, parsed info) or (False, reason).
    404s are reported as 'not found on Civitai' so callers can run the
    fallback chain (sidecar → filename search)."""
    url    = f"{_CIVITAI_API}/model-versions/by-hash/{sha}"
    params = {"token": api_key} if api_key else None
    try:
        status, ver = await _civitai_get_json(session, url, params)
    except Exception as e:
        return False, f"network error: {e}"
    if status == 404:
        return False, "not found on Civitai"
    if status == 401:
        return False, "api_key_invalid"
    if status != 200 or not isinstance(ver, dict):
        return False, f"CivitAI HTTP {status}"
    try:
        info = _parse_version(ver)
    except Exception as e:
        return False, f"parse error: {e}"
    if not info.get("images"):
        await _fill_from_model_page(session, info, api_key)
    return True, info


def _clean_query_name(name: str) -> str:
    stem = os.path.splitext(os.path.basename(name))[0]
    stem = re.sub(r"[_\s-]*v\d+(\.\d+)*$", "", stem)   # trailing version
    stem = re.sub(r"\b[0-9a-f]{8,}\b", "", stem)        # embedded hash fragments
    stem = re.sub(r"\(\d+\)", "", stem)
    return stem.strip(" _-")


def _sidecar_lookup(name: str, sha: str) -> Optional[Dict[str, Any]]:
    """'<file>.civitai.info' sidecars (A1111 CivitAI Helper, many download
    managers) contain the full model JSON — they work even for civitai.red
    downloads of models deleted from civitai.com."""
    path = folder_paths.get_full_path("loras", name)
    if not path:
        return None
    for cand in (path + ".civitai.info",
                 os.path.splitext(path)[0] + ".civitai.info"):
        if not os.path.isfile(cand):
            continue
        try:
            with open(cand, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        versions = [v for v in (data.get("modelVersions") or []) if isinstance(v, dict)]
        chosen = None
        if sha:
            for v in versions:                       # exact: match by SHA256
                for fdef in (v.get("files") or []):
                    if (isinstance(fdef, dict)
                            and str(fdef.get("SHA256") or "").upper() == sha.upper()):
                        chosen = v
                        break
                if chosen:
                    break
        if chosen is None and versions:
            chosen = versions[0]
        if chosen is None:
            return None
        chosen = dict(chosen)
        chosen.setdefault("model", {"id": data.get("id"), "name": data.get("name"),
                                    "nsfwLevel": data.get("nsfwLevel")})
        info = _parse_version(chosen)
        if not info.get("description"):
            desc = _html_to_text(data.get("description") or "")
            if desc:
                info["description"] = desc[:4000]
        info["match"] = "sidecar"
        return info
    return None


async def _filename_search(session, name: str, api_key: str) -> Optional[Dict[str, Any]]:
    """by-hash 404'd → search by filename, accept only near-exact matches
    (≥ 0.85 similarity). Badged 'unverified' in the UI via info["match"]."""
    import difflib
    import urllib.parse
    q = _clean_query_name(name)
    if len(q) < 3:
        return None
    params = {"query": q, "types": "LORA", "limit": 20}
    if api_key:
        params["token"] = api_key
    try:
        status, data = await _civitai_get_json(session, f"{_CIVITAI_API}/models", params)
    except Exception:
        return None
    if status != 200 or not isinstance(data, dict):
        return None
    target = os.path.splitext(os.path.basename(name))[0].lower()
    best, best_score = None, 0.0
    for item in (data.get("items") or []):
        if not isinstance(item, dict):
            continue
        for ver in (item.get("modelVersions") or [])[:5]:
            if not isinstance(ver, dict):
                continue
            for fdef in (ver.get("files") or []):
                if not isinstance(fdef, dict):
                    continue
                cand = os.path.splitext(str(fdef.get("name") or ""))[0].lower()
                score = difflib.SequenceMatcher(None, target, cand).ratio()
                if score > best_score:
                    best_score, best = score, (item, ver)
    if not best or best_score < 0.85:
        return None
    item, ver = best
    ver = dict(ver)
    ver.setdefault("model", {"id": item.get("id"), "name": item.get("name"),
                             "nsfwLevel": item.get("nsfwLevel")})
    info = _parse_version(ver)
    info["match"] = "filename"
    if not info.get("images"):
        await _fill_from_model_page(session, info, api_key)
    return info


async def _lookup_fallback(session, name: str, sha: str,
                           api_key: str) -> Optional[Dict[str, Any]]:
    """Sidecar first (local, exact), then filename search (remote, fuzzy)."""
    try:
        info = _sidecar_lookup(name, sha)
    except Exception as e:
        print(f"[CWK LoRA] sidecar error for {name}: {e}")
        info = None
    if info is None:
        info = await _filename_search(session, name, api_key)
    return info


_THUMB_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
               ".mp4", ".webm")
_VIDEO_EXTS = (".mp4", ".webm")


async def _cache_thumbnail(session, info: Dict[str, Any], api_key: str) -> None:
    """Download the thumbnail (image OR video) into _THUMB_DIR (served by the
    existing /cwk/loras/thumb/ route) so the browser never needs civitai.com.
    Videos can be large — they get a dedicated long-timeout session, a 64 MB
    cap and a Content-Type-based extension fix for extensionless CDN URLs."""
    url = info.get("thumbnail") or ""
    if not url.startswith("http"):
        return
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    ext_known = ext in _THUMB_EXTS
    if not ext_known:
        ext = ".mp4" if info.get("thumbnail_is_video") else ".jpg"
    fname = "c_" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:20] + ext
    dest  = os.path.join(_THUMB_DIR, fname)
    if os.path.isfile(dest):
        info["thumbnail"] = f"/cwk/loras/thumb/{fname}"
        return

    is_video = ext in _VIDEO_EXTS
    cap = 64 * 1024 * 1024 if is_video else 16 * 1024 * 1024
    ses = session
    if is_video:
        import aiohttp
        ses = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300))
    try:
        fetch_url = url
        if api_key and "token=" not in fetch_url:
            fetch_url += ("&" if "?" in fetch_url else "?") + "token=" + api_key
        async with ses.get(fetch_url) as r:
            if r.status != 200:
                return
            if not ext_known:
                # extension was a guess — refine it from the real Content-Type
                ctype = (r.headers.get("Content-Type") or "").lower()
                for needle, e in (("webm", ".webm"), ("mp4", ".mp4"),
                                  ("webp", ".webp"), ("png", ".png"),
                                  ("gif", ".gif"), ("jpeg", ".jpg"), ("jpg", ".jpg")):
                    if needle in ctype:
                        ext = e
                        break
                fname = "c_" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:20] + ext
                dest  = os.path.join(_THUMB_DIR, fname)
                if os.path.isfile(dest):
                    info["thumbnail"] = f"/cwk/loras/thumb/{fname}"
                    return
                is_video = ext in _VIDEO_EXTS
                cap = 64 * 1024 * 1024 if is_video else 16 * 1024 * 1024
            data = await r.read()
        if not data or len(data) > cap:
            return
        os.makedirs(_THUMB_DIR, exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
        info["thumbnail"] = f"/cwk/loras/thumb/{fname}"
    except Exception as e:
        print(f"[CWK LoRA] thumbnail cache error: {e}")
    finally:
        if ses is not session:
            await ses.close()


def _apply_keep(civ: Dict[str, Any], fresh: Dict[str, Any]) -> None:
    """Replace civ with fresh CivitAI data but preserve user-defined values."""
    keep = {k: civ[k] for k in _KEEP_FIELDS if k in civ}
    civ.clear()
    civ.update(fresh)
    civ.update(keep)
    civ["fetched"] = True
    civ.pop("error", None)
    civ.pop("not_on_civitai", None)


# ─── Server routes ───────────────────────────────────────────────────────────

try:
    from aiohttp import web
    from server import PromptServer
    import aiohttp

    _lora_routes = PromptServer.instance.routes

    @_lora_routes.get("/cwk/loras")
    async def cwk_lora_list(request):
        return web.json_response(_lora_api_list())

    @_lora_routes.get("/cwk/loras/settings")
    async def cwk_lora_get_settings(request):
        return web.json_response(_load_lora_settings())

    @_lora_routes.post("/cwk/loras/settings")
    async def cwk_lora_set_settings(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        s = _load_lora_settings()
        for k in _DEFAULT_LORA_SETTINGS:
            if k not in data:
                continue
            v = data[k]
            if k in ("default_strength", "strength_step"):
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    continue
                v = (max(-2.0, min(2.0, v)) if k == "default_strength"
                     else max(0.001, min(1.0, v)))
            else:
                v = bool(v)
            s[k] = v
        _save_lora_settings(s)
        if not s["keep_in_memory"]:
            _LORA_MEM_CACHE.clear()
        return web.json_response({"ok": True, "settings": s})

    @_lora_routes.get("/cwk/lora/trigger_words")
    async def cwk_lora_get_triggers(request):
        name = request.rel_url.query.get("lora", "")
        return web.json_response({"trigger_words": _lora_triggers(name)})

    @_lora_routes.post("/cwk/lora/meta")
    async def cwk_lora_set_meta(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        name = str(data.get("lora", ""))
        if not name:
            return web.json_response({"ok": False, "error": "missing 'lora'"}, status=400)
        cache = _load_lora_cache()
        civ   = cache["loras"].setdefault(name, {"civitai": {}})["civitai"]
        if "description" in data:
            civ["custom_description"] = str(data.get("description") or "")
        if "triggers" in data:
            civ["custom_triggers"]    = str(data.get("triggers") or "")
        if "base_model" in data:
            civ["custom_base_model"]  = str(data.get("base_model") or "").strip()
        if "version" in data:
            civ["custom_version"]     = str(data.get("version") or "").strip()
        if "nsfw" in data:
            civ["nsfw_manual"]        = bool(data.get("nsfw"))
        if data.get("clear_thumbnail"):
            civ.pop("custom_thumbnail", None)
        _save_lora_cache(cache)
        return web.json_response({"ok": True, "civitai": _public_civitai(civ)})

    @_lora_routes.post("/cwk/lora/favorite")
    async def cwk_lora_set_favorite(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        name = str(data.get("lora", ""))
        if not name:
            return web.json_response({"ok": False, "error": "missing 'lora'"}, status=400)
        cache = _load_lora_cache()
        civ   = cache["loras"].setdefault(name, {"civitai": {}})["civitai"]
        civ["favorite"] = bool(data.get("favorite"))
        _save_lora_cache(cache)
        return web.json_response({"ok": True, "favorite": civ["favorite"]})

    @_lora_routes.post("/cwk/lora/thumbnail")
    async def cwk_lora_set_thumbnail(request):
        """Upload a custom thumbnail: multipart fields 'lora' + 'file'."""
        lora_name, data, ext = None, None, ""
        try:
            reader = await request.multipart()
            async for part in reader:
                if part.name == "lora":
                    lora_name = (await part.text()).strip()
                elif part.name == "file":
                    ext  = os.path.splitext(part.filename or "")[1].lower()
                    data = await part.read()
        except Exception as e:
            return web.json_response({"ok": False, "error": f"bad multipart: {e}"}, status=400)

        if not lora_name:
            return web.json_response({"ok": False, "error": "missing 'lora'"}, status=400)
        if not data:
            return web.json_response({"ok": False, "error": "missing file"}, status=400)
        if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
                       ".mp4", ".webm"):
            return web.json_response({"ok": False, "error": f"unsupported media type: {ext}"}, status=400)
        cap = 64 * 1024 * 1024 if ext in (".mp4", ".webm") else 16 * 1024 * 1024
        if len(data) > cap:
            return web.json_response({"ok": False, "error": f"file too large (max {cap // (1024 * 1024)} MB)"}, status=400)
        try:
            os.makedirs(_THUMB_DIR, exist_ok=True)
            fname = hashlib.md5(lora_name.encode("utf-8")).hexdigest()[:12] + ext
            with open(os.path.join(_THUMB_DIR, fname), "wb") as f:
                f.write(data)
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

        cache = _load_lora_cache()
        civ   = cache["loras"].setdefault(lora_name, {"civitai": {}})["civitai"]
        civ["custom_thumbnail"] = f"/cwk/loras/thumb/{fname}"
        _save_lora_cache(cache)
        print(f"[CWK LoRA] Custom thumbnail set for {lora_name}")
        return web.json_response({"ok": True, "civitai": _public_civitai(civ)})

    @_lora_routes.get("/cwk/loras/thumb/{fname}")
    async def cwk_lora_thumb(request):
        fname = os.path.basename(request.match_info.get("fname", ""))
        path  = os.path.join(_THUMB_DIR, fname)
        if not fname or not os.path.isfile(path):
            return web.json_response({"error": "not found"}, status=404)
        return web.FileResponse(path)

    @_lora_routes.delete("/cwk/loras/cache")
    async def cwk_lora_clear_cache(request):
        try:
            import shutil
            if os.path.exists(_LORA_CACHE):
                os.remove(_LORA_CACHE)
            shutil.rmtree(_THUMB_DIR, ignore_errors=True)
            _LORA_MEM_CACHE.clear()
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)
        return web.json_response({"ok": True})

    @_lora_routes.post("/cwk/loras/refresh")
    async def cwk_lora_refresh(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        name    = str(data.get("lora", ""))
        api_key = str(data.get("api_key") or "")
        if not name:
            return web.json_response({"ok": False, "error": "missing 'lora'"}, status=400)
        path = folder_paths.get_full_path("loras", name)
        if not path or not os.path.exists(path):
            return web.json_response({"ok": False, "error": "LoRA file not found"}, status=404)

        cache = _load_lora_cache()
        entry = cache["loras"].setdefault(name, {"civitai": {}})
        civ   = entry["civitai"]
        loop  = asyncio.get_running_loop()
        sha   = await loop.run_in_executor(None, _file_hash, path, entry)
        if not sha:
            _save_lora_cache(cache)
            return web.json_response({"ok": False, "error": "could not hash file"}, status=500)

        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            ok, payload = await _civitai_lookup(session, sha, api_key)
            if not ok:
                if payload == "not found on Civitai":
                    payload = await _lookup_fallback(session, name, sha, api_key)
                if not isinstance(payload, dict):
                    _save_lora_cache(cache)
                    return web.json_response({"ok": False, "error": str(payload)})
            await _cache_thumbnail(session, payload, api_key)

        _apply_keep(civ, payload)
        _save_lora_cache(cache)
        return web.json_response({"ok": True, "info": _public_civitai(civ)})

    @_lora_routes.post("/cwk/lora/lookup_by_id")
    async def cwk_lora_lookup_by_id(request):
        """Manual rescue: match a LoRA to a CivitAI model by URL / model id /
        version id — the only remedy for civitai.red items deleted from
        civitai.com (no API exists on the mirror)."""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        name    = str(data.get("lora") or "")
        api_key = str(data.get("api_key") or "")
        if not name:
            return web.json_response({"ok": False, "error": "missing 'lora'"}, status=400)

        version_id = data.get("version_id")
        model_id   = data.get("model_id")
        raw_url    = str(data.get("url") or "")
        if raw_url:
            m = re.search(r"models/(\d+)", raw_url)
            if m and not model_id:
                model_id = m.group(1)
            m = re.search(r"modelVersionId=(\d+)", raw_url)
            if m and not version_id:
                version_id = m.group(1)
        if not version_id and not model_id:
            return web.json_response(
                {"ok": False, "error": "no model/version id found in request"}, status=400)

        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
                params = {"token": api_key} if api_key else None
                if version_id:
                    status, ver = await _civitai_get_json(
                        session, f"{_CIVITAI_API}/model-versions/{version_id}", params)
                    if status == 404:
                        return web.json_response({"ok": False, "error": "version not found on CivitAI"})
                    if status != 200:
                        return web.json_response({"ok": False, "error": f"CivitAI HTTP {status}"})
                    info = _parse_version(ver)
                else:
                    status, mdata = await _civitai_get_json(
                        session, f"{_CIVITAI_API}/models/{model_id}", params)
                    if status == 404:
                        return web.json_response({"ok": False, "error": "model not found on CivitAI"})
                    if status != 200:
                        return web.json_response({"ok": False, "error": f"CivitAI HTTP {status}"})
                    versions = [v for v in (mdata.get("modelVersions") or [])
                                if isinstance(v, dict)]
                    if not versions:
                        return web.json_response({"ok": False, "error": "model has no versions"})
                    versions.sort(key=lambda v: str(v.get("createdAt") or ""), reverse=True)
                    ver = dict(versions[0])
                    ver.setdefault("model", {"id": mdata.get("id"), "name": mdata.get("name"),
                                             "nsfwLevel": mdata.get("nsfwLevel")})
                    info = _parse_version(ver)
                if not info.get("images"):
                    await _fill_from_model_page(session, info, api_key)
                await _cache_thumbnail(session, info, api_key)
        except Exception as e:
            return web.json_response({"ok": False, "error": f"network error: {e}"})

        info["match"] = "manual"
        cache = _load_lora_cache()
        civ   = cache["loras"].setdefault(name, {"civitai": {}})["civitai"]
        _apply_keep(civ, info)
        _save_lora_cache(cache)
        return web.json_response({"ok": True, "info": _public_civitai(civ)})

    @_lora_routes.post("/cwk/loras/fetch/stream")
    async def cwk_loras_fetch_stream(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        api_key = str(data.get("api_key") or "")
        names   = data.get("loras")
        rebuild = bool(data.get("rebuild", False))

        installed = _list_loras()
        if names is not None:
            wanted  = {str(n) for n in names}
            targets = [n for n in installed if n in wanted]
        else:
            targets = installed

        cache = _load_lora_cache()
        loras = cache["loras"]
        if rebuild:
            todo = list(targets)
        else:
            todo = [n for n in targets
                    if not loras.get(n, {}).get("civitai", {}).get("fetched")]

        resp = web.StreamResponse(status=200, headers={
            "Content-Type":      "text/event-stream",
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
        })
        await resp.prepare(request)
        await _sse_write(resp, {"total": len(todo), "skipped": len(targets) - len(todo)})

        loop  = asyncio.get_running_loop()
        found = 0
        try:
            timeout = aiohttp.ClientTimeout(total=30)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                for name in todo:
                    path  = folder_paths.get_full_path("loras", name)
                    entry = loras.setdefault(name, {"civitai": {}})
                    civ   = entry["civitai"]

                    if not path or not os.path.exists(path):
                        await _sse_write(resp, {"lora": name, "ok": False,
                                                "error": "file not found on disk"})
                        continue

                    await _sse_write(resp, {"lora": name, "status": "hashing"})
                    try:
                        sha = await loop.run_in_executor(None, _file_hash, path, entry)
                    except Exception as e:
                        await _sse_write(resp, {"lora": name, "ok": False,
                                                "error": f"hash failed: {e}"})
                        continue
                    if not sha:
                        await _sse_write(resp, {"lora": name, "ok": False, "error": "hash failed"})
                        continue

                    ok, payload = await _civitai_lookup(session, sha, api_key)

                    if payload == "api_key_invalid":
                        await _sse_write(resp, {"error": "api_key_invalid",
                                                "message": "CivitAI rejected the API key"})
                        return resp

                    if ok:
                        await _cache_thumbnail(session, payload, api_key)
                        _apply_keep(civ, payload)
                        found += 1
                        await _sse_write(resp, {"lora": name, "ok": True,
                                                "info": _public_civitai(civ)})
                    elif payload == "not found on Civitai":
                        # Fallback chain: .civitai.info sidecar → filename search
                        fb = await _lookup_fallback(session, name, sha, api_key)
                        if fb is not None:
                            await _cache_thumbnail(session, fb, api_key)
                            _apply_keep(civ, fb)
                            found += 1
                            await _sse_write(resp, {"lora": name, "ok": True,
                                                    "info": _public_civitai(civ)})
                        else:
                            civ["fetched"] = True
                            civ["not_on_civitai"] = True
                            civ.pop("error", None)
                            await _sse_write(resp, {"lora": name, "ok": False,
                                                    "error": "not found on Civitai"})
                    else:
                        civ["error"] = str(payload)
                        await _sse_write(resp, {"lora": name, "ok": False,
                                                "error": str(payload)})

                    _save_lora_cache(cache)
                    await asyncio.sleep(0.05)

            await _sse_write(resp, {"done": True, "found": found, "total": len(todo)})
        except Exception as e:
            try:
                await _sse_write(resp, {"done": True, "error": str(e)})
            except Exception:
                pass
        finally:
            try:
                _save_lora_cache(cache)
            except Exception:
                pass
            try:
                await resp.write_eof()
            except Exception:
                pass
        return resp

except Exception as e:
    print(f"[CWK LoRA] Could not register server routes: {e}")


# ─── LoRA application ────────────────────────────────────────────────────────

_LORA_MEM_CACHE: Dict[str, Dict[str, Any]] = {}
_LORA_MEM_CACHE_ON  = False
_LORA_MEM_CACHE_MAX = 24   # hard FIFO cap — dozens of large LoRAs ≈ GBs of RAM


def _comfy_load_lora(path: str):
    """Strength-neutral load via the low-level API. A single-argument call is
    compatible with every ComfyUI generation: modern builds take no strengths
    (they are applied by load_lora_for_models), legacy builds default them
    to 1.0."""
    import comfy.sd
    return comfy.sd.load_lora(path)


def _load_lora_cached(path: str):
    """Load a LoRA, honouring the ⚙ 'Keep all LoRAs loaded in memory' setting.
    Entries are keyed by (size, mtime) so updated files re-load. The cache is
    cleared when the setting is off, when settings are saved with it off, and
    when the LoRA cache is wiped."""
    global _LORA_MEM_CACHE_ON
    if not _load_lora_settings()["keep_in_memory"]:
        if _LORA_MEM_CACHE_ON:
            _LORA_MEM_CACHE.clear()
        _LORA_MEM_CACHE_ON = False
        return _comfy_load_lora(path)
    _LORA_MEM_CACHE_ON = True
    try:
        st = os.stat(path)
        key = [st.st_size, int(st.st_mtime)]
    except OSError:
        return _comfy_load_lora(path)
    entry = _LORA_MEM_CACHE.get(path)
    if entry and entry.get("key") == key:
        return entry["lora"]
    lora = _comfy_load_lora(path)
    while len(_LORA_MEM_CACHE) >= _LORA_MEM_CACHE_MAX:
        _LORA_MEM_CACHE.pop(next(iter(_LORA_MEM_CACHE)))
    _LORA_MEM_CACHE[path] = {"key": key, "lora": lora}
    return lora


def _apply_lora(model, clip, lora_name: str, strength_model: float, strength_clip: float):
    """Apply one LoRA via the low-level API (+ optional in-RAM cache). GGUF
    LoRAs go through ComfyUI-GGUF's LoraLoaderGGUF when it is installed.

    NOTE: calls are deliberately made with KEYWORD arguments — ComfyUI has
    changed the *order* of these parameters between releases (recent builds
    added `lora_on_gpu` as the 2nd positional of load_lora), and a positional
    call then silently maps a weight onto the wrong parameter. The TypeError
    fallback defers to the core LoraLoader node, which always matches the
    installed ComfyUI.
    """
    lora_path = folder_paths.get_full_path("loras", lora_name)
    if not lora_path or not os.path.exists(lora_path):
        raise FileNotFoundError(f"LoRA file not found: {lora_name}")

    if lora_name.lower().endswith(".gguf"):
        return _apply_gguf_lora(model, clip, lora_name, strength_model, strength_clip)

    try:
        import comfy.sd
        lora = _load_lora_cached(lora_path)
        return comfy.sd.load_lora_for_models(
            model, clip, lora,
            strength_model=strength_model, strength_clip=strength_clip)
    except TypeError:
        from nodes import LoraLoader
        res = LoraLoader().load_lora(
            lora_name=lora_name,
            strength_model=strength_model,
            strength_clip=strength_clip,
            model=model,
            clip=clip,
        )
        if isinstance(res, (list, tuple)):
            if len(res) >= 2:
                return res[0], res[1]
            return res[0], clip
        return model, clip


def _apply_gguf_lora(model, clip, lora_name: str, strength_model: float, strength_clip: float):
    import sys
    import types

    LoraLoaderGGUF = None
    for mod_name, mod in list(sys.modules.items()):
        if mod is None or not isinstance(mod, types.ModuleType):
            continue
        if mod_name.startswith("torch") or mod_name.startswith("_"):
            continue
        try:
            cls = getattr(mod, "LoraLoaderGGUF", None)
            if cls is not None and isinstance(cls, type) and hasattr(cls, "load_lora"):
                LoraLoaderGGUF = cls
                break
        except Exception:
            continue

    if LoraLoaderGGUF is None:
        raise RuntimeError(
            f"[CWK LoRA] Cannot load GGUF LoRA '{lora_name}' — "
            f"ComfyUI-GGUF (city96) is required. "
            f"Install it from: https://github.com/city96/ComfyUI-GGUF"
        )

    try:
        # Keywords, same reason as _apply_lora (order-proof).
        res = LoraLoaderGGUF().load_lora(
            lora_name=lora_name,
            strength_model=strength_model,
            strength_clip=strength_clip,
            model=model,
            clip=clip,
        )
        if isinstance(res, (list, tuple)) and len(res) >= 2:
            return res[0], res[1]
        return model, clip
    except Exception as e:
        raise RuntimeError(f"[CWK LoRA] ComfyUI-GGUF failed to load '{lora_name}': {e}") from e


# ─── Node: CWK_LoraLoader ────────────────────────────────────────────────────

class CWK_LoraLoader:
    """
    CWK LoRA Loader — stackable LoRA applier with trigger-word output.

    The "lora_config" widget is fully managed by the JS frontend (rows with a
    LoRA dropdown, per-LoRA weight + enable toggle, master activate/deactivate
    toggle, LoRA browser panel). It serialises to a JSON array:

        [{"name": "my_lora.safetensors", "weight": 1.0, "enabled": true}, ...]

    Python applies every enabled LoRA in list order and outputs the combined
    trigger words (custom overrides first, then CivitAI values) as a STRING.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model":       ("MODEL",  {"forceInput": True, "tooltip": "Base model"}),
                "clip":        ("CLIP",   {"forceInput": True, "tooltip": "CLIP to patch"}),
                "lora_config": ("STRING", {"default": "[]", "multiline": True}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("model", "clip", "trigger_words")
    FUNCTION     = "execute"
    CATEGORY     = "CWK/Loaders"
    DESCRIPTION  = ("Applies a stack of LoRAs (weight + on/off per LoRA, global "
                    "on/off switch) and outputs the combined trigger words.")

    @staticmethod
    def _parse_config(raw: Any) -> List[Dict[str, Any]]:
        items = raw if isinstance(raw, list) else []
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw or "[]")
                items  = parsed if isinstance(parsed, list) else []
            except Exception:
                print("[CWK LoRA] ⚠ Could not parse lora_config — ignoring it")
                items = []
        out = []
        for it in items:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name", "")).strip()
            if not name:
                continue   # empty slot row from the dropdown UI
            try:
                mw = float(it.get("weight", it.get("model_weight", 1.0)))
            except (TypeError, ValueError):
                mw = 1.0
            try:
                cw = float(it.get("clip_weight", mw))
            except (TypeError, ValueError):
                cw = mw
            out.append({
                "name":         name,
                "model_weight": mw,
                "clip_weight":  cw,
                "enabled":      bool(it.get("enabled", True)),
            })
        return out

    def execute(self, model, clip, lora_config):
        entries  = self._parse_config(lora_config)
        triggers: List[str] = []
        applied:  List[str] = []

        if not entries:
            raw = lora_config if isinstance(lora_config, str) else json.dumps(lora_config)
            print(f"[CWK LoRA] ⚠ lora_config is empty — model/clip pass through "
                  f"(received: {raw[:200]!r})")

        for e in entries:
            if not e["enabled"]:
                continue
            name, mw, cw = e["name"], e["model_weight"], e["clip_weight"]
            if mw == 0 and cw == 0:
                continue   # weight 0 = LoRA inactive (no trigger words either)
            try:
                model, clip = _apply_lora(model, clip, name, mw, cw)
                applied.append(f"{name} (m:{mw:g}, c:{cw:g})")
            except Exception as ex:
                print(f"[CWK LoRA] ⚠ Skipping '{name}': {ex}")
            for t in _lora_triggers(name):
                if t not in triggers:
                    triggers.append(t)

        trigger_str = ", ".join(triggers)
        print(f"[CWK LoRA] Applied {len(applied)}/{len(entries)} LoRA(s)"
              + (f": {'; '.join(applied)}" if applied else "")
              + (f" | trigger words: {trigger_str}" if trigger_str else ""))
        return (model, clip, trigger_str)


NODE_CLASS_MAPPINGS_LORA = {
    "CWK_LorA_Loader": CWK_LoraLoader,
    # legacy alias so workflows saved with the old name keep loading even
    # without the JS-side remap (e.g. workflows sent through the API)
    "CWK_LorA_Prompt_Loader": CWK_LoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS_LORA = {
    "CWK_LorA_Loader":         "CWK LoRA Loader",
    "CWK_LorA_Prompt_Loader":  "CWK LoRA Loader",
}
