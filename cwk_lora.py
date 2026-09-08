"""
CWK LoRA Loader — node + CivitAI metadata routes.

Node:
- CWK_LoraLoader: applies a stack of LoRAs (per-LoRA weight + enable toggle;
  the global activate/deactivate toggle lives in the JS frontend) to a
  MODEL/CLIP pair and outputs the combined trigger words.

Server routes (registered on PromptServer, same pattern as nodes.py):
- GET    /cwk/loras                → installed LoRAs + cached CivitAI metadata
- GET    /cwk/lora/trigger_words   → resolved trigger words for one LoRA
- POST   /cwk/lora/meta            → custom description / triggers / base model /
                                      version / nsfw flag / clear thumbnail
- POST   /cwk/lora/favorite        → toggle favorite
- POST   /cwk/loras/refresh        → re-fetch one LoRA from CivitAI
- POST   /cwk/loras/fetch/stream   → SSE bulk fetch (SHA-256 hash lookup)
- POST   /cwk/lora/thumbnail       → upload a custom thumbnail (multipart)
- GET    /cwk/loras/thumb/{file}   → serve custom thumbnails
- DELETE /cwk/loras/cache          → wipe the LoRA metadata cache + thumbnails
"""

import asyncio
import hashlib
import json
import os
import re
from typing import Any, Dict, List, Tuple

import folder_paths

_NODE_DIR    = os.path.dirname(__file__)
_LORA_CACHE  = os.path.join(_NODE_DIR, "lora_cache.json")
_THUMB_DIR   = os.path.join(_NODE_DIR, "lora_thumbs")
_CIVITAI_API = "https://civitai.com/api/v1"

NSFW_R = 2  # thumbnails at/above this level are blurred until revealed

# User-defined values that must survive a CivitAI re-fetch
_KEEP_FIELDS = (
    "favorite", "nsfw_manual",
    "custom_description", "custom_triggers",
    "custom_base_model", "custom_version", "custom_thumbnail",
)


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


def _parse_version(ver: Dict[str, Any]) -> Dict[str, Any]:
    """Extract the fields we keep from a CivitAI model-version dict."""
    model   = ver.get("model") or {}
    entries = []   # (url, nsfwLevel)
    for img in (ver.get("images") or []):
        if (img.get("type") or "image") != "image":
            continue
        url = img.get("url")
        if not url:
            continue
        lvl = 0
        try:
            lvl = int(img.get("nsfwLevel") or 0)
        except (TypeError, ValueError):
            pass
        entries.append((url, lvl))

    nsfw_level = max((lvl for _, lvl in entries), default=0)
    try:
        nsfw_level = max(nsfw_level, int(model.get("nsfwLevel") or 0))
    except (TypeError, ValueError):
        pass

    images    = [u for u, _ in entries]
    thumbnail = next((u for _, lvl in entries if lvl < NSFW_R),
                     images[0] if images else None)

    return {
        "civitai_name":  model.get("name"),
        "model_id":      model.get("id"),
        "version_id":    ver.get("id"),
        "version_name":  ver.get("name"),
        "base_model":    ver.get("baseModel"),
        "description":   _html_to_text(ver.get("description")),
        "trigger_words": [str(t) for t in (ver.get("trainedWords") or []) if str(t).strip()],
        "images":        images,
        "thumbnail":     thumbnail,
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
        "error":              civ.get("error"),
    }


def _lora_triggers(name: str) -> List[str]:
    cache = _load_lora_cache().get("loras", {})
    civ   = cache.get(name, {}).get("civitai", {})
    return _resolve_triggers(civ)


def _lora_api_list() -> List[Dict[str, Any]]:
    cache = _load_lora_cache().get("loras", {})
    return [
        {"name": name, "type": "lora",
         "civitai": _public_civitai(cache.get(name, {}).get("civitai", {}))}
        for name in _list_loras()
    ]


async def _sse_write(resp, payload: Dict[str, Any]) -> None:
    await resp.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))


async def _civitai_lookup(session, sha: str, api_key: str) -> Tuple[bool, Any]:
    """CivitAI hash lookup → (True, parsed info) or (False, reason)."""
    url    = f"{_CIVITAI_API}/model-versions/by-hash/{sha}"
    params = {"token": api_key} if api_key else None
    try:
        async with session.get(url, params=params) as r:
            if r.status == 404:
                return False, "not found on Civitai"
            if r.status == 401:
                return False, "api_key_invalid"
            if r.status != 200:
                return False, f"CivitAI HTTP {r.status}"
            ver = await r.json()
    except Exception as e:
        return False, f"network error: {e}"
    try:
        return True, _parse_version(ver)
    except Exception as e:
        return False, f"parse error: {e}"


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
        if ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
            return web.json_response({"ok": False, "error": f"unsupported image type: {ext}"}, status=400)
        if len(data) > 16 * 1024 * 1024:
            return web.json_response({"ok": False, "error": "file too large (max 16 MB)"}, status=400)

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
            _save_lora_cache(cache)
            return web.json_response({"ok": False, "error": str(payload)})

        _apply_keep(civ, payload)
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
                        _apply_keep(civ, payload)
                        found += 1
                        await _sse_write(resp, {"lora": name, "ok": True,
                                                "info": _public_civitai(civ)})
                    elif payload == "not found on Civitai":
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

def _apply_lora(model, clip, lora_name: str, strength_model: float, strength_clip: float):
    """Apply one LoRA via ComfyUI's built-in LoraLoader. GGUF LoRAs go through
    ComfyUI-GGUF's LoraLoaderGGUF when it is installed."""
    lora_path = folder_paths.get_full_path("loras", lora_name)
    if not lora_path or not os.path.exists(lora_path):
        raise FileNotFoundError(f"LoRA file not found: {lora_name}")

    if lora_name.lower().endswith(".gguf"):
        return _apply_gguf_lora(model, clip, lora_name, strength_model, strength_clip)

    from nodes import LoraLoader
    # Newer ComfyUI returns (model, clip, vae) — handle both shapes.
    res = LoraLoader().load_lora(lora_name, strength_model, strength_clip, model, clip)
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
        res = LoraLoaderGGUF().load_lora(lora_name, strength_model, strength_clip, model, clip)
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
    # legacy alias so workflows saved with the old name keep loading
    "CWK_LorA_Prompt_Loader": CWK_LoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS_LORA = {
    "CWK_LorA_Loader": "CWK LoRA Loader",
    "CWK_LorA_Prompt_Loader": "CWK LoRA Loader",
}
