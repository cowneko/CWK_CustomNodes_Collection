"""
CWK Checkpoints Preset Manager — REST / SSE API routes.
"""

import asyncio
import json
import os
import hashlib
import re
from typing import Optional

import aiohttp
from aiohttp import web

import folder_paths
from .nodes import (
    load_presets, save_presets, default_preset,
    get_clip_list, get_vae_list,
    resolve_sampler, resolve_scheduler,
    get_last_used_model, save_last_used_model,
    RESOLUTION_PRESETS, MODEL_SAMPLING_TYPES_WITH_DEFAULT, RNG_TYPES_WITH_DEFAULT, _get_clip_types,
)

# ─── Constants ────────────────────────────────────────────────────────────────

CIVITAI_API_BASE  = "https://civitai.com/api/v1"
NODE_DIR          = os.path.dirname(__file__)
THUMBNAILS_CACHE  = os.path.join(NODE_DIR, "thumbnails_cache.json")
HASH_CACHE_FILE   = os.path.join(NODE_DIR, "hash_cache.json")
LOCAL_THUMBS_DIR  = os.path.join(NODE_DIR, "local_thumbnails")
MODEL_META_DIR    = os.path.join(NODE_DIR, "model_metadata")

_CONCURRENCY = 5
_USER_AGENT  = "CWK-PresetManager/2.0 (ComfyUI custom node)"
_REQ_TIMEOUT = aiohttp.ClientTimeout(total=20)
_DL_TIMEOUT  = aiohttp.ClientTimeout(total=3600)


# ─── NSFW normalisation ───────────────────────────────────────────────────────

def _normalize_nsfw_level(raw) -> int:
    if isinstance(raw, str):
        mapping = {"none": 0, "soft": 1, "mature": 2, "x": 3, "explicit": 3, "xxx": 4}
        return mapping.get(raw.lower().strip(), 0)
    if isinstance(raw, int):
        if raw <= 1:  return 0
        if raw <= 2:  return 1
        if raw <= 4:  return 2
        if raw <= 8:  return 3
        return 4
    return 0


# ─── JSON helpers ─────────────────────────────────────────────────────────────

def _load_json(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_json(path: str, data: dict) -> None:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[CWK] save_json error ({os.path.basename(path)}): {e}")


# ─── Per-model metadata ───────────────────────────────────────────────────────

def _safe_filename(model_name: str) -> str:
    safe = re.sub(r'[<>:"/\\|?*]', '_', model_name)
    return safe + ".json"


def _meta_path(model_name: str) -> str:
    return os.path.join(MODEL_META_DIR, _safe_filename(model_name))


def _load_meta(model_name: str) -> dict:
    path = _meta_path(model_name)
    if os.path.exists(path):
        return _load_json(path)
    legacy = _load_json(THUMBNAILS_CACHE)
    if model_name in legacy:
        data = legacy[model_name]
        _save_meta(model_name, data)
        return data
    return {}


def _save_meta(model_name: str, data: dict) -> None:
    os.makedirs(MODEL_META_DIR, exist_ok=True)
    _save_json(_meta_path(model_name), data)


def _delete_meta(model_name: str) -> None:
    path = _meta_path(model_name)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


# ─── Hash cache ───────────────────────────────────────────────────────────────

def _hash_cache_get(path: str) -> Optional[str]:
    entry = _load_json(HASH_CACHE_FILE).get(path)
    if not entry:
        return None
    try:
        st = os.stat(path)
        if st.st_mtime == entry["mtime"] and st.st_size == entry["size"]:
            return entry["sha256"]
    except OSError:
        pass
    return None


def _hash_cache_set(path: str, sha256: str) -> None:
    cache = _load_json(HASH_CACHE_FILE)
    try:
        st = os.stat(path)
        cache[path] = {"mtime": st.st_mtime, "size": st.st_size, "sha256": sha256}
    except OSError:
        cache[path] = {"mtime": 0, "size": 0, "sha256": sha256}
    _save_json(HASH_CACHE_FILE, cache)


# ─── Model file helpers ───────────────────────────────────────────────────────

def _all_models() -> list:
    models = []
    seen = set()
    for name in folder_paths.get_filename_list("checkpoints"):
        model_type = "gguf" if name.lower().endswith(".gguf") else "checkpoint"
        models.append({"name": name, "type": model_type})
        seen.add(name)
    try:
        for name in folder_paths.get_filename_list("diffusion_models"):
            if name in seen:
                continue
            model_type = "gguf" if name.lower().endswith(".gguf") else "diffusion_model"
            models.append({"name": name, "type": model_type})
            seen.add(name)
    except Exception:
        pass
    # Also include .gguf files from city96's "unet_gguf" folder type
    try:
        for name in folder_paths.get_filename_list("unet_gguf"):
            if name in seen:
                continue
            models.append({"name": name, "type": "gguf"})
            seen.add(name)
    except Exception:
        pass
    return models


def _full_path(model_name: str) -> Optional[str]:
    # Check all folder types including unet_gguf
    for folder_type in ("checkpoints", "diffusion_models", "unet_gguf"):
        try:
            result = folder_paths.get_full_path(folder_type, model_name)
            if result and os.path.exists(result):
                return result
        except Exception:
            pass

    basename = os.path.basename(model_name)
    for folder_type in ("checkpoints", "diffusion_models"):
        try:
            roots = folder_paths.get_folder_paths(folder_type)
        except Exception:
            continue
        for root in roots:
            for dirpath, _, filenames in os.walk(root):
                if basename in filenames:
                    return os.path.join(dirpath, basename)
    return None

def _clean_name(filename: str) -> str:
    return os.path.splitext(os.path.basename(filename))[0]


def _model_save_dir(model_name: str) -> str:
    p = _full_path(model_name)
    if p:
        return os.path.dirname(p)
    dirs = folder_paths.get_folder_paths("checkpoints")
    return dirs[0] if dirs else os.getcwd()

def _bust_folder_cache() -> None:
    """Force ComfyUI to rescan model folders on the next list request."""
    try:
        for folder_type in ("checkpoints", "diffusion_models", "unet_gguf"):
            folder_paths.filename_list_cache.pop(folder_type, None)
    except Exception as e:
        print(f"[CWK] Warning: could not bust folder_paths cache: {e}")


# ─── Hash computation ─────────────────────────────────────────────────────────

def _sha256_sync(path: str) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                h.update(chunk)
        result = h.hexdigest().upper()
        _hash_cache_set(path, result)
        return result
    except Exception as e:
        print(f"[CWK] SHA256 error {path}: {e}")
        return None


async def _get_hash(model_name: str, loop) -> Optional[str]:
    path = _full_path(model_name)
    if not path or not os.path.exists(path):
        return None
    cached = _hash_cache_get(path)
    if cached:
        return cached
    print(f"[CWK] Hashing (first time): {model_name}")
    return await loop.run_in_executor(None, _sha256_sync, path)


async def _get_hash_by_path(abs_path: str, loop) -> Optional[str]:
    """Hash by absolute path — used for freshly downloaded files not yet
    registered in folder_paths."""
    if not abs_path or not os.path.exists(abs_path):
        return None
    cached = _hash_cache_get(abs_path)
    if cached:
        return cached
    print(f"[CWK] Hashing new file: {abs_path}")
    return await loop.run_in_executor(None, _sha256_sync, abs_path)


# ─── CivitAI HTTP helpers ─────────────────────────────────────────────────────

class CivitAIAuthError(Exception):
    pass


def _headers(api_key: str) -> dict:
    h = {"User-Agent": _USER_AGENT}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


async def _cget(session: aiohttp.ClientSession, url: str) -> dict:
    async with session.get(url, timeout=_REQ_TIMEOUT) as r:
        if r.status == 403:
            raise CivitAIAuthError("CivitAI returned 403 — API key required or invalid.")
        if r.status == 404:
            return {}
        if r.status == 429:
            raise aiohttp.ClientResponseError(
                r.request_info, r.history, status=429, message="Rate limited by CivitAI"
            )
        r.raise_for_status()
        return await r.json(content_type=None)


def _parse_version(data: dict, filename: str) -> dict:
    if not data:
        return {
            "thumbnail":    None,
            "civitai_name": _clean_name(filename),
            "nsfw_level":   0,
            "tags":         [],
        }

    images    = data.get("images", [])
    model_blk = data.get("model", {})

    norm_images = []
    for img in images:
        lvl = _normalize_nsfw_level(img.get("nsfwLevel", 0))
        norm_images.append({**img, "nsfwLevel": lvl})

    non_video  = [img for img in norm_images
                  if not img.get("url", "").lower().endswith(".mp4")]
    candidates = non_video if non_video else norm_images
    thumb_img  = min(candidates, key=lambda i: i["nsfwLevel"]) if candidates else None
    nsfw_level = thumb_img["nsfwLevel"] if thumb_img else 0

    raw_tags = model_blk.get("tags", [])
    tags = [t for t in raw_tags if isinstance(t, str)] if isinstance(raw_tags, list) else []

    return {
        "thumbnail":    thumb_img["url"] if thumb_img else None,
        "nsfw_level":   nsfw_level,
        "civitai_name": model_blk.get("name") or data.get("name") or _clean_name(filename),
        "base_model":   data.get("baseModel", ""),
        "description":  (model_blk.get("description") or "")[:300],
        "tags":         tags,
        "images":       norm_images,
        "model_id":     data.get("modelId"),
        "version_id":   data.get("id"),
        "version_name": data.get("name", ""),
    }


async def _lookup(model_name: str, session, loop) -> dict:
    file_hash = await _get_hash(model_name, loop)
    if not file_hash:
        return {"thumbnail": None, "civitai_name": _clean_name(model_name), "nsfw_level": 0, "tags": []}
    data = await _cget(session, f"{CIVITAI_API_BASE}/model-versions/by-hash/{file_hash}")
    return _parse_version(data, model_name)


async def _lookup_by_path(abs_path: str, model_name: str, session, loop) -> dict:
    """Lookup by hashing an absolute path directly — for freshly downloaded files."""
    file_hash = await _get_hash_by_path(abs_path, loop)
    if not file_hash:
        return {"thumbnail": None, "civitai_name": _clean_name(model_name), "nsfw_level": 0, "tags": []}
    data = await _cget(session, f"{CIVITAI_API_BASE}/model-versions/by-hash/{file_hash}")
    return _parse_version(data, model_name)


def _keep_manual_overrides(new_info: dict, existing: dict) -> dict:
    # Preserve local thumbnail
    existing_thumb = existing.get("thumbnail") or ""
    if existing_thumb.startswith("/cwk/local_thumbnails/"):
        new_info["thumbnail"] = existing["thumbnail"]
    # Preserve manual NSFW override
    if existing.get("nsfw_manual") is not None:
        new_info["nsfw_manual"] = existing["nsfw_manual"]
    # Preserve favorite flag
    if existing.get("favorite"):
        new_info["favorite"] = True
    # Preserve tags if new data doesn't have them
    existing_tags = existing.get("tags")
    if isinstance(existing_tags, list) and existing_tags and not new_info.get("tags"):
        new_info["tags"] = existing_tags
    # Preserve update check results
    if existing.get("update_available"):
        new_info["update_available"] = existing["update_available"]
        new_info["latest_version_id"] = existing.get("latest_version_id")

    # ── NEW: Preserve manually-edited fields ──────────────────────────────────
    manual_fields = existing.get("_manual_overrides", [])
    if isinstance(manual_fields, list):
        for field in manual_fields:
            if field in existing:
                new_info[field] = existing[field]
        if manual_fields:
            new_info["_manual_overrides"] = manual_fields

    return new_info


# ─── Preset auto-population from CivitAI image metadata ───────────────────────

_PRESET_META_KEYS = ["sampler", "scheduler", "cfgScale", "steps", "clipSkip"]
_PRESET_SIZE_KEYS = ["Size", "size"]


def _extract_best_image_metadata(images: list) -> dict:
    """
    Pick the example image with the most generation metadata available
    and return a preset-compatible dict.
    """
    if not images:
        return {}

    best_img  = None
    best_count = 0

    for img in images:
        meta = img.get("meta") or img.get("metadata") or {}
        if not meta or not isinstance(meta, dict):
            continue
        count = sum(1 for k in _PRESET_META_KEYS if meta.get(k) is not None)
        # Also count size
        for sk in _PRESET_SIZE_KEYS:
            if meta.get(sk):
                count += 1
                break
        if count > best_count:
            best_count = count
            best_img = meta

    if not best_img or best_count == 0:
        return {}

    preset = {}

    # Sampler — resolve through fallback system
    raw_sampler = best_img.get("sampler")
    if raw_sampler and isinstance(raw_sampler, str) and raw_sampler.strip():
        preset["sampler_name"] = resolve_sampler(raw_sampler.strip())

    # Scheduler — resolve through fallback system
    raw_scheduler = best_img.get("scheduler")
    if raw_scheduler and isinstance(raw_scheduler, str) and raw_scheduler.strip():
        preset["scheduler"] = resolve_scheduler(raw_scheduler.strip())

    # CFG
    cfg_val = best_img.get("cfgScale")
    if cfg_val is not None:
        try:
            preset["cfg"] = round(float(cfg_val), 2)
        except (ValueError, TypeError):
            pass

    # Steps
    steps_val = best_img.get("steps")
    if steps_val is not None:
        try:
            preset["steps"] = int(steps_val)
        except (ValueError, TypeError):
            pass

    # Clip skip
    clip_val = best_img.get("clipSkip")
    if clip_val is not None:
        try:
            cs = int(clip_val)
            preset["clip_skip"] = -cs if cs > 0 else cs
        except (ValueError, TypeError):
            pass

    # Resolution from "Size" field (e.g. "832x1216")
    for sk in _PRESET_SIZE_KEYS:
        size_str = best_img.get(sk)
        if size_str and isinstance(size_str, str) and "x" in size_str.lower():
            parts = size_str.lower().split("x")
            if len(parts) == 2:
                try:
                    w = int(parts[0].strip())
                    h = int(parts[1].strip())
                    if 64 <= w <= 8192 and 64 <= h <= 8192:
                        preset["width"]  = w
                        preset["height"] = h
                except (ValueError, TypeError):
                    pass
            break

    return preset


def _auto_populate_preset(model_name: str, images: list) -> bool:
    """
    Extract generation metadata from CivitAI example images and save
    as a preset for the model. Returns True if a preset was written.
    """
    extracted = _extract_best_image_metadata(images)
    if not extracted:
        return False

    presets  = load_presets()
    existing = presets.get(model_name, default_preset())
    existing.update(extracted)
    presets[model_name] = existing
    save_presets(presets)
    print(f"[CWK] Auto-populated preset for {model_name}: {extracted}")
    return True


# ─── SSE helper ───────────────────────────────────────────────────────────────

async def _sse(resp: web.StreamResponse, payload: dict) -> None:
    try:
        await resp.write(f"data: {json.dumps(payload)}\n\n".encode())
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════════
# Route handlers
# ═══════════════════════════════════════════════════════════════════════════════

async def handle_list_models(req: web.Request) -> web.Response:
    models  = _all_models()
    presets = load_presets()
    result  = []
    for m in models:
        full_path = _full_path(m["name"])
        try:
            file_size = os.path.getsize(full_path) if full_path else 0
        except OSError:
            file_size = 0
        meta = _load_meta(m["name"])
        result.append({
            "name":      m["name"],
            "type":      m["type"],
            "preset":    presets.get(m["name"], default_preset()),
            "civitai":   meta if meta else None,
            "file_path": full_path or "",
            "file_size": file_size,
        })
    return web.json_response(result)


async def handle_get_preset(req: web.Request) -> web.Response:
    name = req.rel_url.query.get("model", "")
    if not name:
        return web.json_response({"error": "model parameter required"}, status=400)
    presets = load_presets()
    return web.json_response({"model": name, "preset": presets.get(name, default_preset())})


async def handle_save_preset(req: web.Request) -> web.Response:
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    name = body.get("model", "")
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    presets       = load_presets()
    existing      = presets.get(name, default_preset())
    existing.update(body.get("preset", {}))
    presets[name] = existing
    save_presets(presets)
    return web.json_response({"ok": True, "model": name, "preset": existing})


async def handle_validate_key(req: web.Request) -> web.Response:
    key = req.rel_url.query.get("key", "")
    if not key:
        return web.json_response({"ok": False, "error": "No key provided."})
    try:
        async with aiohttp.ClientSession(headers=_headers(key)) as s:
            await _cget(s, f"{CIVITAI_API_BASE}/models?limit=1")
        return web.json_response({"ok": True})
    except CivitAIAuthError as e:
        return web.json_response({"ok": False, "error": str(e)})
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)})


# ── Favourite ─────────────────────────────────────────────────────────────────

async def handle_set_favorite(req: web.Request) -> web.Response:
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    name     = body.get("model", "")
    favorite = bool(body.get("favorite", False))
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    meta = _load_meta(name)
    if favorite:
        meta["favorite"] = True
    else:
        meta.pop("favorite", None)
    _save_meta(name, meta)
    return web.json_response({"ok": True, "favorite": favorite})


# ── Bulk SSE fetch ─────────────────────────────────────────────────────────────

async def _run_sse_fetch(req, names, api_key, force, rebuild=False):
    resp = web.StreamResponse(headers={
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(req)

    if not api_key:
        await _sse(resp, {
            "error":   "api_key_required",
            "message": "A CivitAI API key is required. Click 🔑 in the browser panel.",
            "done":    True,
        })
        await resp.write_eof()
        return resp

    if not names:
        await _sse(resp, {"done": True, "total": 0})
        await resp.write_eof()
        return resp

    total       = len(names)
    loop        = asyncio.get_event_loop()
    sem         = asyncio.Semaphore(_CONCURRENCY)
    completed   = [0]
    auth_failed = [False]
    presets_populated = [0]

    try:
        async with aiohttp.ClientSession(headers=_headers(api_key)) as session:

            async def _bounded(name: str):
                if auth_failed[0]:
                    return

                existing = _load_meta(name)

                if not force and not rebuild and existing.get("thumbnail"):
                    completed[0] += 1
                    # Even for cached models, try to auto-populate preset if
                    # the model doesn't have one yet
                    images = existing.get("images", [])
                    if images:
                        current_presets = load_presets()
                        if name not in current_presets:
                            try:
                                if _auto_populate_preset(name, images):
                                    presets_populated[0] += 1
                            except Exception as e:
                                print(f"[CWK] Preset auto-populate error for {name}: {e}")
                    await _sse(resp, {
                        "model": name, "info": existing,
                        "index": completed[0], "total": total,
                        "done":  False,
                    })
                    return

                async with sem:
                    if auth_failed[0]:
                        return
                    try:
                        info = await _lookup(name, session, loop)
                    except CivitAIAuthError as e:
                        auth_failed[0] = True
                        await _sse(resp, {"error": "api_key_invalid", "message": str(e), "done": True})
                        return
                    except Exception as e:
                        print(f"[CWK] Lookup error for {name}: {e}")
                        info = existing if existing else {
                            "thumbnail":    None,
                            "civitai_name": _clean_name(name),
                            "nsfw_level":   0,
                            "tags":         [],
                        }

                try:
                    info = _keep_manual_overrides(info, existing)
                except Exception as e:
                    print(f"[CWK] _keep_manual_overrides error for {name}: {e}")

                _save_meta(name, info)

                # Auto-populate preset from example images
                images = info.get("images", [])
                if images:
                    try:
                        if _auto_populate_preset(name, images):
                            presets_populated[0] += 1
                    except Exception as e:
                        print(f"[CWK] Preset auto-populate error for {name}: {e}")

                completed[0] += 1
                await _sse(resp, {
                    "model": name, "info": info,
                    "index": completed[0], "total": total,
                    "done":  False,
                })

            results = await asyncio.gather(
                *[_bounded(n) for n in names],
                return_exceptions=True,
            )
            # Log any unexpected exceptions that slipped through
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    print(f"[CWK] Unhandled error in _bounded for {names[i]}: {result}")

    except Exception as e:
        print(f"[CWK] SSE fetch outer error: {e}")

    # Always send the terminal done event and close cleanly
    if not auth_failed[0]:
        await _sse(resp, {
            "done": True, "total": total,
            "presets_populated": presets_populated[0],
        })

    try:
        await resp.write_eof()
    except Exception:
        pass

    return resp


async def handle_fetch_stream(req: web.Request) -> web.StreamResponse:
    try:
        body = await req.json()
    except Exception:
        return web.Response(status=400, text="invalid JSON")
    names   = body.get("models") or [m["name"] for m in _all_models()]
    api_key = body.get("api_key", "")
    force   = bool(body.get("force", False))
    rebuild = bool(body.get("rebuild", False))
    return await _run_sse_fetch(req, names, api_key, force=force, rebuild=rebuild)


async def handle_refresh_all_stream(req: web.Request) -> web.StreamResponse:
    try:
        body = await req.json()
    except Exception:
        return web.Response(status=400, text="invalid JSON")
    names   = [m["name"] for m in _all_models()]
    api_key = body.get("api_key", "")
    return await _run_sse_fetch(req, names, api_key, force=True, rebuild=False)


async def handle_get_cache(req: web.Request) -> web.Response:
    result = {}
    for m in _all_models():
        meta = _load_meta(m["name"])
        if meta:
            result[m["name"]] = meta
    return web.json_response(result)


async def handle_clear_cache(req: web.Request) -> web.Response:
    deleted = 0
    if os.path.isdir(MODEL_META_DIR):
        for fname in os.listdir(MODEL_META_DIR):
            if fname.endswith(".json"):
                try:
                    os.remove(os.path.join(MODEL_META_DIR, fname))
                    deleted += 1
                except OSError:
                    pass
    return web.json_response({"ok": True, "deleted": deleted})


async def handle_list_images(req: web.Request) -> web.Response:
    name  = req.rel_url.query.get("model", "")
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    entry = _load_meta(name)
    return web.json_response({"model": name, "images": entry.get("images", [])})


async def handle_set_thumbnail(req: web.Request) -> web.Response:
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    name = body.get("model", "")
    url  = body.get("url",   "")
    if not name or not url:
        return web.json_response({"error": "model and url required"}, status=400)
    meta = _load_meta(name)
    meta["thumbnail"] = url
    _save_meta(name, meta)
    return web.json_response({"ok": True, "thumbnail": url})


async def handle_set_local_thumbnail(req: web.Request) -> web.Response:
    try:
        os.makedirs(LOCAL_THUMBS_DIR, exist_ok=True)
        reader     = await req.multipart()
        model_name = None
        saved_url  = None
        async for part in reader:
            if part.name == "model":
                model_name = (await part.read()).decode("utf-8").strip()
            elif part.name == "file":
                filename  = part.filename or "thumb.jpg"
                safe_stem = (model_name or "unknown").replace("/", "_").replace("\\", "_")
                ext       = os.path.splitext(filename)[1] or ".jpg"
                dest      = os.path.join(LOCAL_THUMBS_DIR, f"{safe_stem}{ext}")
                with open(dest, "wb") as f:
                    while True:
                        chunk = await part.read_chunk(65536)
                        if not chunk:
                            break
                        f.write(chunk)
                saved_url = f"/cwk/local_thumbnails/{safe_stem}{ext}"
        if not model_name or not saved_url:
            return web.json_response({"error": "model and file required"}, status=400)
        meta = _load_meta(model_name)
        meta["thumbnail"] = saved_url
        _save_meta(model_name, meta)
        return web.json_response({"ok": True, "thumbnail": saved_url})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_list_versions(req: web.Request) -> web.Response:
    name    = req.rel_url.query.get("model",   "")
    api_key = req.rel_url.query.get("api_key", "")
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    entry    = _load_meta(name)
    model_id = entry.get("model_id")
    if not model_id:
        return web.json_response(
            {"error": "No model_id cached — run Fetch Thumbnails first."}, status=404
        )
    try:
        async with aiohttp.ClientSession(headers=_headers(api_key)) as s:
            data = await _cget(s, f"{CIVITAI_API_BASE}/models/{model_id}")
        if not data:
            return web.json_response({"error": "Model not found on CivitAI."}, status=404)

        versions    = sorted(data.get("modelVersions", []),
                             key=lambda v: v.get("createdAt", ""), reverse=True)
        current_vid = entry.get("version_id")

        # ── Build set of ALL locally installed version IDs for this model ─────
        # This detects versions installed under different filenames
        installed_version_ids = set()
        for m in _all_models():
            m_meta = _load_meta(m["name"])
            m_model_id = m_meta.get("model_id")
            m_version_id = m_meta.get("version_id")
            if m_model_id == model_id and m_version_id:
                installed_version_ids.add(m_version_id)

        # ── Fetch per-version details in parallel to get earlyAccessEndsAt ───
        sem = asyncio.Semaphore(_CONCURRENCY)

        async def _fetch_version_detail(version_id: int) -> dict:
            async with sem:
                try:
                    async with aiohttp.ClientSession(headers=_headers(api_key)) as s:
                        detail = await _cget(s, f"{CIVITAI_API_BASE}/model-versions/{version_id}")
                    return detail or {}
                except Exception as e:
                    print(f"[CWK] version detail fetch error for {version_id}: {e}")
                    return {}

        version_ids     = [v.get("id") for v in versions if v.get("id")]
        version_details = await asyncio.gather(*[_fetch_version_detail(vid) for vid in version_ids])
        detail_map      = {d.get("id"): d for d in version_details if d.get("id")}

        result = []
        for v in versions:
            files = v.get("files", [])
            mfile = next(
                (f for f in files if f.get("type") == "Model" and f.get("primary")),
                files[0] if files else {},
            )
            detail  = detail_map.get(v.get("id"), {})
            ea_ends = detail.get("earlyAccessEndsAt") or detail.get("earlyAccessDeadline") or None

            vid = v.get("id")
            result.append({
                "id":                 vid,
                "name":               v.get("name", ""),
                "created_at":         v.get("createdAt", ""),
                "base_model":         v.get("baseModel", ""),
                "download_url":       mfile.get("downloadUrl", "").replace("civitai.red/", "civitai.com/"),
                "filename":           mfile.get("name", ""),
                "size_kb":            mfile.get("sizeKB", 0),
                "is_installed":       vid in installed_version_ids,
                "is_current":         vid == current_vid,
                "images":             v.get("images", [])[:1],
                "early_access_ends":  ea_ends,
            })

        return web.json_response({"model_name": name, "versions": result})
    except CivitAIAuthError as e:
        return web.json_response({"error": str(e)}, status=403)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_model_description(req: web.Request) -> web.Response:
    name    = req.rel_url.query.get("model",   "")
    api_key = req.rel_url.query.get("api_key", "")
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    entry    = _load_meta(name)
    model_id = entry.get("model_id")
    if not model_id:
        return web.json_response(
            {"error": "No model_id cached — run Fetch Thumbnails first."}, status=404
        )
    try:
        async with aiohttp.ClientSession(headers=_headers(api_key)) as s:
            data = await _cget(s, f"{CIVITAI_API_BASE}/models/{model_id}")
        if not data:
            return web.json_response({"error": "Model not found on CivitAI."}, status=404)
        description = data.get("description") or ""
        raw_tags = data.get("tags", [])
        tags = [t for t in raw_tags if isinstance(t, str)] if isinstance(raw_tags, list) else []
        if tags:
            entry["tags"] = tags
            _save_meta(name, entry)
        return web.json_response({"description": description, "tags": tags})
    except CivitAIAuthError as e:
        return web.json_response({"error": str(e)}, status=403)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_check_updates(req: web.Request) -> web.Response:
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    api_key = body.get("api_key", "")
    if not api_key:
        return web.json_response({"error": "api_key required"}, status=400)

    models   = _all_models()
    results  = []
    sem      = asyncio.Semaphore(_CONCURRENCY)

    # ── Pre-build a map: model_id → set of installed version_ids ──────────────
    # This lets us detect that the "latest" version is already installed
    # under a different filename.
    installed_by_model_id = {}
    for m in models:
        m_meta = _load_meta(m["name"])
        mid = m_meta.get("model_id")
        vid = m_meta.get("version_id")
        if mid and vid:
            installed_by_model_id.setdefault(mid, set()).add(vid)

    async def _check_one(m):
        meta       = _load_meta(m["name"])
        model_id   = meta.get("model_id")
        current_id = meta.get("version_id")
        if not model_id or not current_id:
            return
        async with sem:
            try:
                async with aiohttp.ClientSession(headers=_headers(api_key)) as s:
                    data = await _cget(s, f"{CIVITAI_API_BASE}/models/{model_id}")
                if not data:
                    return
                versions = sorted(data.get("modelVersions", []),
                                   key=lambda v: v.get("createdAt", ""), reverse=True)
                if not versions:
                    return
                latest_id = versions[0].get("id")
                # Check if the latest version is installed under ANY local file
                all_installed = installed_by_model_id.get(model_id, set())
                has_update = (latest_id not in all_installed)
                meta["update_available"]  = has_update
                meta["latest_version_id"] = latest_id if has_update else None
                _save_meta(m["name"], meta)
                if has_update:
                    results.append({
                        "name":              m["name"],
                        "current_version":   meta.get("version_name", ""),
                        "latest_version":    versions[0].get("name", ""),
                        "latest_version_id": latest_id,
                    })
            except Exception as e:
                print(f"[CWK] Update check error for {m['name']}: {e}")

    await asyncio.gather(*[_check_one(m) for m in models])
    return web.json_response({"ok": True, "updates": results, "count": len(results)})


async def handle_delete_model(req: web.Request) -> web.Response:
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    name = body.get("model", "")
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    errors = []
    full   = _full_path(name)
    if full and os.path.exists(full):
        try:
            os.remove(full)
            _bust_folder_cache()
        except OSError as e:
            errors.append(str(e))
    _delete_meta(name)
    presets = load_presets()
    if name in presets:
        del presets[name]
        save_presets(presets)
    return web.json_response({"ok": not errors, "errors": errors})


async def handle_refresh_civitai(req: web.Request) -> web.Response:
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    name    = body.get("model",   "")
    api_key = body.get("api_key", "")
    if not name:
        return web.json_response({"error": "model required"}, status=400)
    loop = asyncio.get_event_loop()
    try:
        async with aiohttp.ClientSession(headers=_headers(api_key)) as session:
            info = await _lookup(name, session, loop)
        existing = _load_meta(name)
        info     = _keep_manual_overrides(info, existing)
        _save_meta(name, info)

        # Auto-populate preset from example images
        images = info.get("images", [])
        preset_populated = False
        if images:
            preset_populated = _auto_populate_preset(name, images)

        return web.json_response({
            "ok": True, "info": info,
            "preset_populated": preset_populated,
        })
    except CivitAIAuthError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=403)
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


async def handle_get_meta(req: web.Request) -> web.Response:
    name = req.rel_url.query.get("model", "")
    if not name:
        return web.json_response({}, status=400)
    return web.json_response(_load_meta(name))


# ─── CLIP / VAE list endpoints ────────────────────────────────────────────────

async def handle_list_clips(req: web.Request) -> web.Response:
    """Return list of available CLIP models (with 'embedded' first)."""
    return web.json_response({"clips": get_clip_list()})


async def handle_list_vaes(req: web.Request) -> web.Response:
    """Return list of available VAE models (with 'embedded' first)."""
    return web.json_response({"vaes": get_vae_list()})


async def handle_sampler_scheduler_list(req: web.Request) -> web.Response:
    """Return the real ComfyUI sampler/scheduler lists, plus clip type and
    model sampling options, for populating the preset editor dropdowns."""
    import comfy.samplers
    return web.json_response({
        "samplers":             list(comfy.samplers.KSampler.SAMPLERS),
        "schedulers":           list(comfy.samplers.KSampler.SCHEDULERS),
        "clip_types":           _get_clip_types(),
        "model_sampling_types": MODEL_SAMPLING_TYPES_WITH_DEFAULT,
        "rng_types":            RNG_TYPES_WITH_DEFAULT,
    })


# ─── Download handler (SSE progress stream) ───────────────────────────────────

async def handle_download_version(req: web.Request) -> web.StreamResponse:
    try:
        body = await req.json()
    except Exception:
        return web.Response(status=400, text="invalid JSON")

    model_name   = body.get("model",        "")
    download_url = body.get("download_url", "").replace("civitai.red/", "civitai.com/")
    filename     = body.get("filename",     "")
    api_key      = body.get("api_key",      "")

    if not download_url or not filename:
        return web.Response(status=400, text="download_url and filename required")

    save_dir  = _model_save_dir(model_name)
    save_path = os.path.join(save_dir, filename)

    resp = web.StreamResponse(headers={
        "Content-Type":      "text/event-stream",
        "Cache-Control":     "no-cache",
        "X-Accel-Buffering": "no",
    })
    await resp.prepare(req)

    try:
        dl_headers = _headers(api_key)
        url = download_url
        if api_key and "token=" not in url:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}token={api_key}"

        async with aiohttp.ClientSession(headers=dl_headers, timeout=_DL_TIMEOUT) as session:
            async with session.get(url) as r:
                if r.status == 401 or r.status == 403:
                    reason = "check your API key."
                    try:
                        err_data = await r.json(content_type=None)
                        err_msg  = err_data.get("message") or err_data.get("error") or ""
                        if err_msg:
                            reason = err_msg
                        elif r.status == 401:
                            reason = "This model requires early access — you need to purchase access on CivitAI before downloading."
                    except Exception:
                        if r.status == 401:
                            reason = "This model requires early access — you need to purchase access on CivitAI before downloading."
                    await _sse(resp, {"error": f"⚠ Download not available: {reason}"})
                    await resp.write_eof()
                    return resp

                if not r.ok:
                    await _sse(resp, {"error": f"CivitAI returned HTTP {r.status}"})
                    await resp.write_eof()
                    return resp

                total_bytes    = int(r.headers.get("Content-Length", 0))
                received_bytes = 0
                last_progress  = -1

                os.makedirs(save_dir, exist_ok=True)
                with open(save_path, "wb") as f:
                    async for chunk in r.content.iter_chunked(1024 * 256):
                        f.write(chunk)
                        received_bytes += len(chunk)
                        if total_bytes > 0:
                            progress = int(received_bytes / total_bytes * 100)
                            if progress != last_progress:
                                last_progress = progress
                                await _sse(resp, {"progress": progress})

        print(f"[CWK] Downloaded: {filename} → {save_path}")

        # ── Bust folder cache so the new file is visible immediately ──────────
        _bust_folder_cache()

        # ── Fetch CivitAI metadata right now using the absolute path ──────────
        loop = asyncio.get_event_loop()
        try:
            async with aiohttp.ClientSession(headers=_headers(api_key)) as session:
                info = await _lookup_by_path(save_path, filename, session, loop)
            if info.get("thumbnail"):
                registered_name = filename
                for folder_type in ("checkpoints", "diffusion_models"):
                    try:
                        roots = folder_paths.get_folder_paths(folder_type)
                    except Exception:
                        continue
                    for root in roots:
                        root_norm = os.path.normpath(root)
                        dir_norm  = os.path.normpath(save_dir)
                        if dir_norm.startswith(root_norm):
                            rel = os.path.relpath(save_path, root_norm)
                            registered_name = rel
                            break
                _save_meta(registered_name, info)

                # Auto-populate preset for the newly downloaded model
                images = info.get("images", [])
                if images:
                    _auto_populate_preset(registered_name, images)

                await _sse(resp, {"progress": 100, "done": True, "civitai": info, "registered_name": registered_name})
            else:
                await _sse(resp, {"progress": 100, "done": True})
        except Exception as e:
            print(f"[CWK] Post-download metadata fetch error: {e}")
            await _sse(resp, {"progress": 100, "done": True})

    except asyncio.CancelledError:
        if os.path.exists(save_path):
            try:
                os.remove(save_path)
            except OSError:
                pass
    except Exception as e:
        print(f"[CWK] Download error: {e}")
        if os.path.exists(save_path):
            try:
                os.remove(save_path)
            except OSError:
                pass
        await _sse(resp, {"error": str(e)})

    try:
        await resp.write_eof()
    except Exception:
        pass

    return resp
    

async def handle_last_model(req: web.Request) -> web.Response:
    """GET /cwk/last_model — Return the last-used model name and its preset + meta."""
    model_name = get_last_used_model()
    if not model_name:
        return web.json_response({"model_name": None})
    presets = load_presets()
    preset  = presets.get(model_name, default_preset())
    meta    = _load_meta(model_name)
    return web.json_response({
        "model_name": model_name,
        "preset":     preset,
        "meta":       meta if meta else None,
    })


async def handle_save_last_model(req: web.Request) -> web.Response:
    """POST /cwk/last_model — Persist the last-used model name."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    model_name = body.get("model_name", "")
    if not model_name:
        return web.json_response({"error": "model_name required"}, status=400)
    save_last_used_model(model_name)
    return web.json_response({"ok": True})


async def handle_resolution_presets(req: web.Request) -> web.Response:
    """GET /cwk/resolution_presets — Return all resolution preset labels and values."""
    result = []
    for label, (w, h) in RESOLUTION_PRESETS.items():
        result.append({"label": label, "width": w, "height": h})
    return web.json_response(result)
    
# ─── Manual metadata edit endpoint ────────────────────────────────────────

async def handle_edit_meta(req: web.Request) -> web.Response:
    """POST /cwk/civitai/meta/edit — Manually set metadata fields for models
    that don't have CivitAI data (or override existing values).
    Accepted fields: civitai_name, version_name, base_model.
    These are flagged as manual overrides so they survive CivitAI refreshes."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    model_name = body.get("model", "")
    if not model_name:
        return web.json_response({"error": "model required"}, status=400)

    edits = body.get("edits", {})
    if not edits or not isinstance(edits, dict):
        return web.json_response({"error": "edits required"}, status=400)

    ALLOWED_FIELDS = {"civitai_name", "version_name", "base_model"}
    filtered = {k: v for k, v in edits.items() if k in ALLOWED_FIELDS and isinstance(v, str)}
    if not filtered:
        return web.json_response({"error": "no valid fields to edit"}, status=400)

    meta = _load_meta(model_name)

    # Apply edits
    for key, val in filtered.items():
        meta[key] = val.strip()

    # Track which fields were manually overridden so they survive CivitAI refreshes
    manual = meta.get("_manual_overrides", [])
    if not isinstance(manual, list):
        manual = []
    for key in filtered:
        if key not in manual:
            manual.append(key)
    meta["_manual_overrides"] = manual

    _save_meta(model_name, meta)

    print(f"[CWK] Manual metadata edit for {model_name}: {filtered}")
    return web.json_response({"ok": True, "meta": meta})    

# ─── Route registration ───────────────────────────────────────────────────────

def register_routes(app: web.Application) -> None:
    os.makedirs(LOCAL_THUMBS_DIR, exist_ok=True)
    os.makedirs(MODEL_META_DIR,   exist_ok=True)
    r = app.router
    r.add_get   ("/cwk/models",                       handle_list_models)
    r.add_get   ("/cwk/preset",                       handle_get_preset)
    r.add_post  ("/cwk/preset",                       handle_save_preset)
    r.add_post  ("/cwk/civitai/fetch/stream",         handle_fetch_stream)
    r.add_post  ("/cwk/civitai/refresh/all",          handle_refresh_all_stream)
    r.add_get   ("/cwk/civitai/cache",                handle_get_cache)
    r.add_delete("/cwk/civitai/cache",                handle_clear_cache)
    r.add_get   ("/cwk/civitai/validate",             handle_validate_key)
    r.add_get   ("/cwk/civitai/images",               handle_list_images)
    r.add_post  ("/cwk/civitai/thumbnail/set",        handle_set_thumbnail)
    r.add_post  ("/cwk/civitai/thumbnail/local",      handle_set_local_thumbnail)
    r.add_get   ("/cwk/civitai/versions",             handle_list_versions)
    r.add_get   ("/cwk/civitai/model-description",    handle_model_description)
    r.add_post  ("/cwk/civitai/check-updates",        handle_check_updates)
    r.add_post  ("/cwk/civitai/download",             handle_download_version)
    r.add_post  ("/cwk/model/favorite",               handle_set_favorite)
    r.add_delete("/cwk/model",                        handle_delete_model)
    r.add_post  ("/cwk/civitai/refresh",              handle_refresh_civitai)
    r.add_static("/cwk/local_thumbnails",             LOCAL_THUMBS_DIR, show_index=False)
    r.add_get   ("/cwk/civitai/meta",                 handle_get_meta)
    r.add_get   ("/cwk/clips",                        handle_list_clips)
    r.add_get   ("/cwk/vaes",                         handle_list_vaes)
    r.add_get   ("/cwk/sampler_scheduler_list",       handle_sampler_scheduler_list)
    r.add_get   ("/cwk/last_model",                   handle_last_model)
    r.add_post  ("/cwk/last_model",                   handle_save_last_model)
    r.add_get   ("/cwk/resolution_presets",           handle_resolution_presets)
    r.add_post  ("/cwk/civitai/meta/edit",            handle_edit_meta)
    print("[CWK_PresetManager] Routes registered.")