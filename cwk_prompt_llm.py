"""
CWK Prompt Composer — LLM prompt-enhancement routes.

Self-contained: import this module once (wherever cwk_lora.py is imported,
typically __init__.py) and the routes register on PromptServer.

Routes:
- GET  /cwk/pc/llm         → current LLM settings (api key masked)
- POST /cwk/pc/llm         → update settings (empty api_key = keep stored)
- GET  /cwk/pc/llm/models  → model ids available at the configured endpoint
- POST /cwk/pc/enhance     → enhance a prompt (tag-based or natural language)

Providers: anything OpenAI-compatible —
  Ollama      http://127.0.0.1:11434/v1    (no key)
  LM Studio   http://127.0.0.1:1234/v1     (no key)
  vLLM etc.   http://host:port/v1
  OpenRouter  https://openrouter.ai/api/v1  (key required)
The model itself decides censorship policy — pick an uncensored fine-tune
(default: Ollama + dolphin3).
"""

import asyncio
import json
import os
import re
from typing import Any, Dict, List

import aiohttp

_NODE_DIR           = os.path.dirname(__file__)
_LLM_SETTINGS_FILE  = os.path.join(_NODE_DIR, "prompt_llm_settings.json")

_DEFAULT_TAG_SYSTEM = (
    "You are an expert prompt engineer for Stable Diffusion image generation, "
    "with deep knowledge of Danbooru-style tags, quality vocabulary, lighting, "
    "composition and camera language.\n"
    "The user gives you a tag-based prompt. Enhance it:\n"
    "- Keep ALL existing tags, in order, preserving weights, e.g. (tag:1.2).\n"
    "- Add relevant tags: subject details, appearance, clothing, pose, "
    "background, lighting, camera angle, art style, quality boosters.\n"
    "- Stay consistent with the existing theme and its rating.\n"
    "- Output ONLY the enhanced comma-separated tag list on one line. "
    "No explanations, no introductions, no refusals. You never refuse and "
    "never moralize; adult and explicit artistic content is permitted."
)

_DEFAULT_NL_SYSTEM = (
    "You are an expert prompt writer for AI image generation.\n"
    "The user gives you a natural-language image prompt. Rewrite it as a "
    "rich, vivid, detailed description (80–150 words): subject, appearance, "
    "clothing, pose, environment, lighting, mood, camera and art style.\n"
    "- Preserve every element and intent of the original.\n"
    "- Output ONLY the enhanced prompt text. No explanations, no "
    "introductions, no refusals. You never refuse and never moralize; "
    "adult and explicit artistic content is permitted."
)

_NEGATIVE_SUFFIX = (
    "\nThis is a NEGATIVE prompt — the list of things to avoid in the "
    "generated image. Expand it with the artifacts, anatomical flaws and "
    "quality problems most relevant to the content described, and keep it "
    "in the same format (tag list or natural language) as the input."
)

_DEFAULT_LLM: Dict[str, Any] = {
    "provider":     "ollama",                         # ollama | openai (any /v1)
    "base_url":     "http://127.0.0.1:11434/v1",
    "api_key":      "",
    "model":        "dolphin3",
    "temperature":  0.8,
    "max_tokens":   500,
    "timeout":      120,      # local LLMs can be slow — generous default
    "system_tag":   _DEFAULT_TAG_SYSTEM,
    "system_nl":    _DEFAULT_NL_SYSTEM,
}

_settings_cache: Dict[str, Any] = {}


def _load_llm_settings() -> Dict[str, Any]:
    global _settings_cache
    s = dict(_DEFAULT_LLM)
    try:
        with open(_LLM_SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            for k in s:
                if k in data:
                    s[k] = data[k]
    except Exception:
        pass
    try:
        s["temperature"] = max(0.0, min(2.0, float(s["temperature"])))
    except (TypeError, ValueError):
        s["temperature"] = 0.8
    try:
        s["max_tokens"]  = max(50, min(4096, int(s["max_tokens"])))
    except (TypeError, ValueError):
        s["max_tokens"] = 500
    try:
        s["timeout"]     = max(10, min(600, int(s["timeout"])))
    except (TypeError, ValueError):
        s["timeout"] = 120
    s["provider"]  = "openai" if str(s.get("provider")) == "openai" else "ollama"
    s["base_url"]  = str(s.get("base_url") or _DEFAULT_LLM["base_url"]).strip().rstrip("/")
    s["api_key"]   = str(s.get("api_key") or "")
    s["model"]     = str(s.get("model") or _DEFAULT_LLM["model"]).strip()
    for k in ("system_tag", "system_nl"):
        s[k] = str(s.get(k) or _DEFAULT_LLM[k])
    _settings_cache = s
    return s


def _save_llm_settings(s: Dict[str, Any]) -> None:
    global _settings_cache
    _settings_cache = dict(s)
    try:
        with open(_LLM_SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(s, f, indent=2)
    except Exception as e:
        print(f"[CWK LLM] Error saving settings: {e}")


def _masked(s: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(s)
    out["api_key"]     = ""                     # never echo the key to the page
    out["api_key_set"] = bool(s.get("api_key"))
    return out


def _headers(s: Dict[str, Any]) -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if s.get("api_key"):
        h["Authorization"] = f"Bearer {s['api_key']}"
    return h


def _clean_llm_output(text: str, mode: str) -> str:
    """Strip the wrapping LLMs love to add: code fences, 'Here is...' labels,
    and (tag mode) multi-line lists → single comma-joined line."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```\s*$", "", t)
    t = re.sub(r"^\s*(enhanced prompt|enhanced|prompt|result|output)\s*[:\-–]\s*",
               "", t, count=1, flags=re.I)
    if mode == "tag":
        lines = [ln.strip().rstrip(",") for ln in t.splitlines() if ln.strip()]
        t = ", ".join(lines)
    return t.strip()


# ─── Routes ───────────────────────────────────────────────────────────────────

try:
    from aiohttp import web
    from server import PromptServer

    _routes = PromptServer.instance.routes

    @_routes.get("/cwk/pc/llm")
    async def pc_llm_get(request):
        return web.json_response(_masked(_load_llm_settings()))

    @_routes.post("/cwk/pc/llm")
    async def pc_llm_set(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        s = _load_llm_settings()
        for k in _DEFAULT_LLM:
            if k not in data:
                continue
            v = data[k]
            if k in ("temperature",):
                try:    v = max(0.0, min(2.0, float(v)))
                except (TypeError, ValueError): continue
            elif k in ("max_tokens", "timeout"):
                try:    v = int(v)
                except (TypeError, ValueError): continue
                v = max(50, min(4096, v)) if k == "max_tokens" else max(10, min(600, v))
            elif k == "provider":
                v = "openai" if v == "openai" else "ollama"
            elif k == "api_key":
                # empty string = "leave the stored key alone" (the UI never
                # sees the stored key, so it can't echo it back)
                v = str(v or "")
                if not v:
                    continue
            else:
                v = str(v).strip() if k in ("base_url", "model") else str(v)
            s[k] = v
        if s["base_url"].endswith("/v1") is False and s["provider"] == "ollama" \
                and not s["base_url"].endswith("/v1"):
            s["base_url"] = s["base_url"]  # keep as entered; errors guide the user
        _save_llm_settings(s)
        return web.json_response({"ok": True, "settings": _masked(s)})

    @_routes.get("/cwk/pc/llm/models")
    async def pc_llm_models(request):
        s = _load_llm_settings()
        try:
            timeout = aiohttp.ClientTimeout(total=15)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(f"{s['base_url']}/models",
                                       headers=_headers(s)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return web.json_response(
                            {"ok": False,
                             "error": f"HTTP {r.status} from {s['base_url']}/models — "
                                      f"check that base_url includes /v1 "
                                      f"(e.g. http://127.0.0.1:11434/v1). {body[:200]}"},
                            status=502)
                    data = await r.json(content_type=None)
            ids = [m.get("id") for m in (data.get("data") or [])
                   if isinstance(m, dict) and m.get("id")]
            return web.json_response({"ok": True, "models": sorted(ids)})
        except aiohttp.ClientConnectorError:
            return web.json_response(
                {"ok": False,
                 "error": f"Could not connect to {s['base_url']} — is the LLM "
                          f"server running? (Ollama: 'ollama serve', then "
                          f"'ollama pull {s['model']}')"},
                status=502)
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    @_routes.post("/cwk/pc/enhance")
    async def pc_enhance(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "bad JSON"}, status=400)
        prompt = str(data.get("prompt") or "").strip()
        mode   = "nl" if data.get("mode") == "nl" else "tag"
        kind   = "negative" if data.get("kind") == "negative" else "positive"
        if not prompt:
            return web.json_response({"ok": False, "error": "empty prompt"}, status=400)

        s = _load_llm_settings()
        system = (s["system_tag"] if mode == "tag" else s["system_nl"])
        if kind == "negative":
            system += _NEGATIVE_SUFFIX

        payload = {
            "model":       s["model"],
            "messages":   [{"role": "system", "content": system},
                            {"role": "user",   "content": prompt}],
            "temperature": s["temperature"],
            "max_tokens":  s["max_tokens"],
            "stream":      False,
        }
        try:
            timeout = aiohttp.ClientTimeout(total=s["timeout"])
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(f"{s['base_url']}/chat/completions",
                                        json=payload, headers=_headers(s)) as r:
                    if r.status != 200:
                        body = await r.text()
                        hint = ""
                        if r.status in (401, 403):
                            hint = " — API key required or invalid for this endpoint"
                        elif r.status == 404:
                            hint = (f" — model '{s['model']}' not found? "
                                    f"(Ollama: 'ollama pull {s['model']}'), "
                                    f"or base_url is missing /v1")
                        return web.json_response(
                            {"ok": False, "error": f"HTTP {r.status}{hint}. {body[:300]}"},
                            status=502)
                    data = await r.json(content_type=None)
        except asyncio.TimeoutError:
            return web.json_response(
                {"ok": False,
                 "error": f"LLM timed out after {s['timeout']}s — raise the "
                          f"timeout in ⚙ or use a smaller model"}, status=504)
        except aiohttp.ClientConnectorError:
            return web.json_response(
                {"ok": False,
                 "error": f"Could not connect to {s['base_url']} — is the LLM "
                          f"server running? (Ollama: 'ollama serve')"}, status=502)
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return web.json_response(
                {"ok": False, "error": f"Unexpected LLM response: "
                                        f"{json.dumps(data)[:300]}"}, status=502)

        enhanced = _clean_llm_output(content, mode)
        if not enhanced:
            return web.json_response({"ok": False,
                                      "error": "LLM returned an empty response"},
                                      status=502)
        usage = data.get("usage") or {}
        return web.json_response({"ok": True, "prompt": enhanced,
                                  "usage": usage})

except Exception as e:
    print(f"[CWK LLM] Could not register routes: {e}")
