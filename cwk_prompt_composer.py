"""
CWK Prompt Composer — Visual pill-based prompt editing node with A1111-compatible parsing.
Handles tag browsing, autocomplete, presets, wildcards, and CLIP encoding.
"""

import json
import os
import re
import torch
import logging

import server
from aiohttp import web
from comfy import model_management

logger = logging.getLogger("[CWK_Prompt_Composer]")

# ── Directories ────────────────────────────────────────────────────────────────
NODE_ROOT    = os.path.dirname(__file__)
TAG_DIR      = os.path.join(NODE_ROOT, "tags")
WILDCARD_DIR = os.path.join(NODE_ROOT, "wildcards")
PRESET_DIR   = os.path.join(NODE_ROOT, "presets")

os.makedirs(TAG_DIR, exist_ok=True)
os.makedirs(WILDCARD_DIR, exist_ok=True)
os.makedirs(PRESET_DIR, exist_ok=True)

# ── Danbooru tags (auto-downloaded into main.txt) ─────────────────────────────
DANBOORU_URL  = "https://gist.githubusercontent.com/pythongosssss/1d3efa6050356a08cea975183088159a/raw/a18fb2f94f9156cf4476b0c24a09544d6c0baec6/danbooru-tags.txt"
MAIN_TAG_FILE = os.path.join(TAG_DIR, "main.txt")

TAG_FILES = {
    "quality":   os.path.join(TAG_DIR, "quality.txt"),
    "style":     os.path.join(TAG_DIR, "style.txt"),
    "aesthetic": os.path.join(TAG_DIR, "aesthetic.txt"),
    "main":      MAIN_TAG_FILE,
    "negative":  os.path.join(TAG_DIR, "negative.txt"),
}


# ══════════════════════════════════════════════════════════════════════════════
#  TAG ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@server.PromptServer.instance.routes.get("/cwk/tags/{key}")
async def get_tags(request):
    """Serve any tag file as plain text. Auto-downloads main.txt on first use."""
    key = request.match_info["key"]
    if key not in TAG_FILES:
        return web.Response(text="", status=404)

    filepath = TAG_FILES[key]

    if key == "main" and not os.path.exists(filepath):
        try:
            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.get(DANBOORU_URL) as resp:
                    if resp.status == 200:
                        raw = await resp.text()
                        lines = []
                        for line in raw.split("\n"):
                            line = line.strip()
                            if not line:
                                continue
                            comma_idx = line.rfind(",")
                            if comma_idx != -1 and line[comma_idx + 1:].strip().isdigit():
                                line = line[:comma_idx].strip()
                            lines.append(line)
                        with open(filepath, "w", encoding="utf-8") as f:
                            f.write("\n".join(lines) + "\n")
                        logger.info(f"[CWK] Downloaded and cleaned main.txt ({len(lines)} tags)")
                    else:
                        return web.Response(text="", status=resp.status)
        except Exception as e:
            logger.error(f"[CWK] Failed to download main.txt: {e}")
            return web.Response(text="", status=500)

    if not os.path.exists(filepath):
        return web.Response(text="", status=404)

    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()
    return web.Response(text=text, content_type="text/plain")


@server.PromptServer.instance.routes.post("/cwk/add_tag")
async def add_tag(request):
    """Add a tag to a .txt tag file in alphabetical order."""
    try:
        data = await request.json()
        key  = data.get("key", "").strip()
        tag  = data.get("tag", "").strip().replace(" ", "_")

        if not key or not tag:
            return web.json_response({"ok": False, "error": "Missing key or tag"}, status=400)

        if key not in TAG_FILES:
            return web.json_response({"ok": False, "error": f"Unknown tag file: {key}"}, status=404)

        filepath = TAG_FILES[key]

        if not os.path.exists(filepath):
            with open(filepath, "w", encoding="utf-8") as f:
                f.write("")

        with open(filepath, "r", encoding="utf-8") as f:
            existing = [line.strip() for line in f if line.strip()]

        if tag in existing:
            return web.json_response({"ok": False, "duplicate": True, "tag": tag})

        # Insert alphabetically (case-insensitive)
        import bisect
        lower_list = [t.lower() for t in existing]
        insert_pos = bisect.bisect_left(lower_list, tag.lower())
        existing.insert(insert_pos, tag)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(existing) + "\n")

        return web.json_response({"ok": True, "tag": tag, "key": key})

    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
        
@server.PromptServer.instance.routes.post("/cwk/export")
async def export_data(request):
    """Export selected tag files and/or presets as a JSON bundle for download."""
    try:
        data = await request.json()
        items = data.get("items", [])

        result = {}

        for item in items:
            if item == "presets":
                presets = {}
                for f in os.listdir(PRESET_DIR):
                    if not f.lower().endswith(".json"):
                        continue
                    filepath = os.path.join(PRESET_DIR, f)
                    try:
                        with open(filepath, "r", encoding="utf-8") as fh:
                            pdata = json.load(fh)
                        name = pdata.get("name", os.path.splitext(f)[0])
                        presets[name] = {
                            "category": pdata.get("category", "main"),
                            "pills": pdata.get("pills", []),
                        }
                    except Exception:
                        pass
                result["presets"] = presets
            elif item in TAG_FILES:
                filepath = TAG_FILES[item]
                if os.path.exists(filepath):
                    with open(filepath, "r", encoding="utf-8") as fh:
                        tags = [line.strip() for line in fh if line.strip()]
                    result[item] = tags
                else:
                    result[item] = []

        return web.json_response({"ok": True, "data": result})

    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

# ══════════════════════════════════════════════════════════════════════════════
#  EMBEDDING ENDPOINT
# ══════════════════════════════════════════════════════════════════════════════

@server.PromptServer.instance.routes.get("/cwk/embeddings")
async def get_embeddings(request):
    """List available embedding names for autocomplete (recursive)."""
    import folder_paths
    embeddings = []
    try:
        emb_dirs = folder_paths.get_folder_paths("embeddings")
        for base_dir in emb_dirs:
            if not os.path.isdir(base_dir):
                continue
            for root, _dirs, files in os.walk(base_dir):
                for f in files:
                    name, ext = os.path.splitext(f)
                    if ext.lower() in (".pt", ".safetensors", ".bin"):
                        rel = os.path.relpath(os.path.join(root, f), base_dir)
                        rel_no_ext = os.path.splitext(rel)[0]
                        rel_no_ext = rel_no_ext.replace(os.sep, "/")
                        embeddings.append(rel_no_ext)
    except Exception as e:
        logger.warning(f"[CWK] Could not list embeddings: {e}")
    return web.json_response(sorted(set(embeddings)))


# ══════════════════════════════════════════════════════════════════════════════
#  WILDCARD ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@server.PromptServer.instance.routes.get("/cwk/wildcards")
async def list_wildcards(request):
    """List all .yaml/.yml files in the wildcards/ folder (recursive)."""
    files = []
    try:
        for root, _dirs, filenames in os.walk(WILDCARD_DIR):
            for f in filenames:
                if f.lower().endswith((".yaml", ".yml")):
                    rel = os.path.relpath(os.path.join(root, f), WILDCARD_DIR)
                    rel = rel.replace(os.sep, "/")
                    files.append(rel)
    except Exception as e:
        logger.warning(f"[CWK] Could not list wildcards: {e}")
    return web.json_response(sorted(files))


@server.PromptServer.instance.routes.get("/cwk/wildcards/{filename:.+}")
async def get_wildcard(request):
    """Serve a specific wildcard file as raw YAML text."""
    filename = request.match_info["filename"]
    safe_path = os.path.normpath(filename)
    if safe_path.startswith("..") or os.path.isabs(safe_path):
        return web.Response(text="Invalid path", status=400)

    filepath = os.path.join(WILDCARD_DIR, safe_path)
    if not os.path.exists(filepath):
        return web.Response(text="", status=404)
    if not filepath.lower().endswith((".yaml", ".yml")):
        return web.Response(text="Not a YAML file", status=400)

    with open(filepath, "r", encoding="utf-8") as f:
        text = f.read()
    return web.Response(text=text, content_type="text/plain")


# ══════════════════════════════════════════════════════════════════════════════
#  PRESET ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

def _safe_preset_name(name):
    """Sanitize preset name for use as filename."""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name.strip())
    safe = safe.strip('. ')
    if not safe:
        safe = "unnamed"
    return safe


@server.PromptServer.instance.routes.get("/cwk/presets")
async def list_presets(request):
    """List all saved presets."""
    presets = {}
    try:
        for f in os.listdir(PRESET_DIR):
            if not f.lower().endswith(".json"):
                continue
            filepath = os.path.join(PRESET_DIR, f)
            try:
                with open(filepath, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                name = data.get("name", os.path.splitext(f)[0])
                presets[name] = {
                    "category": data.get("category", "main"),
                    "pills":    data.get("pills", []),
                }
            except Exception as e:
                logger.warning(f"[CWK] Could not read preset {f}: {e}")
    except Exception as e:
        logger.warning(f"[CWK] Could not list presets: {e}")
    return web.json_response(presets)


@server.PromptServer.instance.routes.post("/cwk/presets")
async def save_preset(request):
    """Save a preset."""
    try:
        data = await request.json()
        name     = data.get("name", "").strip()
        category = data.get("category", "main")
        pills    = data.get("pills", [])

        if not name:
            return web.json_response({"ok": False, "error": "Missing name"}, status=400)

        safe_name = _safe_preset_name(name)
        filepath  = os.path.join(PRESET_DIR, f"{safe_name}.json")

        for f in os.listdir(PRESET_DIR):
            if not f.lower().endswith(".json"):
                continue
            try:
                with open(os.path.join(PRESET_DIR, f), "r", encoding="utf-8") as fh:
                    existing = json.load(fh)
                if existing.get("name") == name:
                    return web.json_response({"ok": False, "duplicate": True, "name": name})
            except Exception:
                pass

        preset_data = {
            "name":     name,
            "category": category,
            "pills":    pills,
        }

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(preset_data, f, indent=2, ensure_ascii=False)

        logger.info(f"[CWK] Saved preset: {name} → {filepath}")
        return web.json_response({"ok": True, "name": name})

    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.delete("/cwk/presets/{name}")
async def delete_preset(request):
    """Delete a preset by name."""
    target_name = request.match_info["name"]

    try:
        for f in os.listdir(PRESET_DIR):
            if not f.lower().endswith(".json"):
                continue
            filepath = os.path.join(PRESET_DIR, f)
            try:
                with open(filepath, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if data.get("name") == target_name:
                    os.remove(filepath)
                    logger.info(f"[CWK] Deleted preset: {target_name}")
                    return web.json_response({"ok": True})
            except Exception:
                pass

        return web.json_response({"ok": False, "error": "Preset not found"}, status=404)

    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)


# ══════════════════════════════════════════════════════════════════════════════
#  A1111-STYLE CLIP ENCODING — SELF-CONTAINED
# ══════════════════════════════════════════════════════════════════════════════

_re_attention = re.compile(r"""
\\\(|
\\\)|
\\\[|
\\]|
\\\\|
\\|
\(|
\[|
:\s*([+-]?[.\d]+)\s*\)|
\)|
]|
[^\\()\[\]:]+|
:
""", re.X)

_re_break = re.compile(r"\s*\bBREAK\b\s*", re.S)


def parse_prompt_attention(text):
    res = []
    round_brackets = []
    square_brackets = []
    round_bracket_multiplier = 1.1
    square_bracket_multiplier = 1 / 1.1

    def multiply_range(start_position, multiplier):
        for p in range(start_position, len(res)):
            res[p][1] *= multiplier

    for m in _re_attention.finditer(text):
        chunk = m.group(0)
        weight = m.group(1)

        if chunk.startswith('\\'):
            res.append([chunk[1:], 1.0])
        elif chunk == '(':
            round_brackets.append(len(res))
        elif chunk == '[':
            square_brackets.append(len(res))
        elif weight is not None and round_brackets:
            multiply_range(round_brackets.pop(), float(weight))
        elif chunk == ')' and round_brackets:
            multiply_range(round_brackets.pop(), round_bracket_multiplier)
        elif chunk == ']' and square_brackets:
            multiply_range(square_brackets.pop(), square_bracket_multiplier)
        else:
            parts = re.split(_re_break, chunk)
            for i, part in enumerate(parts):
                if i > 0:
                    res.append(["BREAK", -1])
                res.append([part, 1.0])

    for pos in round_brackets:
        multiply_range(pos, round_bracket_multiplier)
    for pos in square_brackets:
        multiply_range(pos, square_bracket_multiplier)

    if len(res) == 0:
        res = [["", 1.0]]

    i = 0
    while i + 1 < len(res):
        if res[i][1] == res[i + 1][1]:
            res[i][0] += res[i + 1][0]
            res.pop(i + 1)
        else:
            i += 1

    return res


CHUNK_LENGTH = 75


def _get_tokenizer_info(clip):
    tokenizer_wrapper = clip.tokenizer
    result = {}
    try:
        sample = tokenizer_wrapper.tokenize_with_weights("")
        if isinstance(sample, dict):
            for key in sample.keys():
                for attr_name in ["clip_" + key, key]:
                    obj = getattr(tokenizer_wrapper, attr_name, None)
                    if obj is not None and hasattr(obj, 'tokenizer') and hasattr(obj, 'start_token'):
                        result[key] = obj
                        break
    except Exception:
        pass

    if not result:
        for attr_name in dir(tokenizer_wrapper):
            if attr_name.startswith('_'):
                continue
            obj = getattr(tokenizer_wrapper, attr_name, None)
            if obj is not None and hasattr(obj, 'tokenizer') and hasattr(obj, 'start_token'):
                key = attr_name.replace('clip_', '')
                result[key] = obj

    return result


def _get_encoder_info(clip):
    encoder_wrapper = clip.cond_stage_model
    result = {}

    for attr_name in dir(encoder_wrapper):
        if attr_name.startswith('_'):
            continue
        obj = getattr(encoder_wrapper, attr_name, None)
        if obj is not None and hasattr(obj, 'encode') and hasattr(obj, 'special_tokens'):
            key = attr_name.replace('clip_', '')
            result[key] = obj

    return result


def _a1111_tokenize(inner_tokenizer, text):
    parsed = parse_prompt_attention(text)

    hf_tokenizer = inner_tokenizer.tokenizer
    start_token  = inner_tokenizer.start_token
    end_token    = inner_tokenizer.end_token
    pad_token    = getattr(inner_tokenizer, 'pad_token', end_token)

    try:
        vocab = hf_tokenizer.get_vocab()
        comma_token = vocab.get(',</w>', None)
    except Exception:
        comma_token = None

    text_fragments = [t for t, _ in parsed]
    tokenized = hf_tokenizer(text_fragments, truncation=False, add_special_tokens=False)["input_ids"]

    chunks = []
    cur_tokens = []
    cur_weights = []
    last_comma = -1

    def finish_chunk():
        nonlocal cur_tokens, cur_weights, last_comma

        to_add = CHUNK_LENGTH - len(cur_tokens)
        if to_add > 0:
            cur_tokens += [end_token] * to_add
            cur_weights += [1.0] * to_add

        final_tokens  = [start_token] + cur_tokens[:CHUNK_LENGTH] + [end_token]
        final_weights = [1.0]         + cur_weights[:CHUNK_LENGTH] + [1.0]

        chunks.append((final_tokens, final_weights))
        cur_tokens = []
        cur_weights = []
        last_comma = -1

    for frag_tokens, (text_frag, weight) in zip(tokenized, parsed):
        if text_frag == 'BREAK' and weight == -1:
            finish_chunk()
            continue

        pos = 0
        while pos < len(frag_tokens):
            token = frag_tokens[pos]

            if token == comma_token:
                last_comma = len(cur_tokens)
            elif (len(cur_tokens) == CHUNK_LENGTH
                  and last_comma != -1
                  and len(cur_tokens) - last_comma <= 20):
                brk = last_comma + 1
                reloc_t = cur_tokens[brk:]
                reloc_w = cur_weights[brk:]
                cur_tokens  = cur_tokens[:brk]
                cur_weights = cur_weights[:brk]
                finish_chunk()
                cur_tokens  = reloc_t
                cur_weights = reloc_w

            if len(cur_tokens) == CHUNK_LENGTH:
                finish_chunk()

            cur_tokens.append(token)
            cur_weights.append(weight)
            pos += 1

    if cur_tokens or not chunks:
        finish_chunk()

    return chunks


def _encode_single_clip_a1111(encoder, chunks, pad_token):
    target_device = model_management.intermediate_device()
    zs = []
    first_pooled = None

    for tokens_77, weights_77 in chunks:
        tokens_tensor = [tokens_77]

        end_token = encoder.special_tokens.get("end", tokens_77[-1])
        pt = encoder.special_tokens.get("pad", end_token)
        if pt != end_token:
            processed = list(tokens_77)
            try:
                end_idx = processed.index(end_token)
                for k in range(end_idx + 1, len(processed)):
                    processed[k] = pt
                tokens_tensor = [processed]
            except ValueError:
                pass

        o = encoder.encode(tokens_tensor)
        z = o[0]
        pooled = o[1] if len(o) > 1 else None

        if first_pooled is None and pooled is not None:
            first_pooled = pooled[0:1].to(target_device)

        weights_tensor = torch.tensor(
            [weights_77], dtype=z.dtype, device=z.device
        )

        original_mean = z.mean()
        z = z * weights_tensor.unsqueeze(-1).expand_as(z)
        new_mean = z.mean()
        if new_mean.abs() > 1e-8:
            z = z * (original_mean / new_mean)

        zs.append(z)

    if not zs:
        return None, None

    cond = torch.cat(zs, dim=1).to(target_device)
    return cond, first_pooled


def _encode_a1111(clip, text):
    tokenizer_map = _get_tokenizer_info(clip)
    encoder_map   = _get_encoder_info(clip)

    if not tokenizer_map or not encoder_map:
        logger.warning("[CWK] Could not discover CLIP internals, falling back to comfy")
        return _encode_comfy(clip, text)

    clip.load_model()

    clip.cond_stage_model.reset_clip_options()
    if clip.layer_idx is not None:
        clip.cond_stage_model.set_clip_options({"layer": clip.layer_idx})
    clip.cond_stage_model.set_clip_options({"execution_device": clip.patcher.load_device})

    all_chunks = {}
    for key, inner_tok in tokenizer_map.items():
        all_chunks[key] = _a1111_tokenize(inner_tok, text)

    results = {}
    for key in sorted(encoder_map.keys()):
        if key not in all_chunks:
            continue
        encoder = encoder_map[key]
        pad_token = encoder.special_tokens.get("pad", encoder.special_tokens.get("end", 0))
        cond, pooled = _encode_single_clip_a1111(encoder, all_chunks[key], pad_token)
        if cond is not None:
            results[key] = (cond, pooled)

    if not results:
        return _encode_comfy(clip, text)

    if len(results) == 1:
        key = list(results.keys())[0]
        final_cond, pooled = results[key]
    else:
        l_cond, l_pooled = results.get("l", (None, None))
        g_cond, g_pooled = results.get("g", (None, None))

        if l_cond is None or g_cond is None:
            return _encode_comfy(clip, text)

        cut_to = min(l_cond.shape[1], g_cond.shape[1])
        final_cond = torch.cat([l_cond[:, :cut_to], g_cond[:, :cut_to]], dim=-1)
        pooled = g_pooled

    out_dict = {}
    if pooled is not None:
        out_dict["pooled_output"] = pooled

    return [[final_cond, out_dict]]


def _encode_comfy(clip, text):
    tokens = clip.tokenize(text)
    output = clip.encode_from_tokens(tokens, return_pooled=True, return_dict=True)
    cond   = output.pop("cond")
    return [[cond, output]]


def _encode_with_parser(clip, text, parser):
    if parser == "A1111":
        return _encode_a1111(clip, text)
    else:
        return _encode_comfy(clip, text)


# ── Node ────────────────────────────────────────────────────────────────────

class CWKPromptComposerNode:
    PARSERS = ["comfy", "A1111"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "positive_prompt":  ("STRING", {"default": "", "multiline": True}),
                "negative_prompt":  ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "clip":           ("CLIP",),
                "parser":         (cls.PARSERS, {"default": "comfy"}),
                "flux_guidance":  ("FLOAT", {"default": 3.5, "min": 0.0, "max": 100.0, "step": 0.1}),
                "zero_out_negative": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt", "positive_cond", "negative_cond")
    FUNCTION     = "compose"
    CATEGORY     = "CWK/Prompting"

    def compose(self, positive_prompt, negative_prompt,
                clip=None, parser="comfy", flux_guidance=3.5, zero_out_negative=False):
        positive = positive_prompt.strip()
        negative = negative_prompt.strip()

        if clip is None:
            return (positive, negative, [], [])

        pos_cond = _encode_with_parser(clip, positive, parser)
        neg_cond = _encode_with_parser(clip, negative, parser)

        # ── Flux Guidance ──────────────────────────────────────────────────
        if flux_guidance != 3.5:
            pos_out = []
            for t in pos_cond:
                n = [t[0], t[1].copy()]
                n[1]["guidance"] = flux_guidance
                pos_out.append(n)
            pos_cond = pos_out

        # ── ConditioningZeroOut ────────────────────────────────────────────
        if zero_out_negative:
            neg_out = []
            for t in neg_cond:
                d = t[1].copy()
                pooled_output = d.get("pooled_output", None)
                if pooled_output is not None:
                    d["pooled_output"] = torch.zeros_like(pooled_output)
                neg_out.append([torch.zeros_like(t[0]), d])
            neg_cond = neg_out

        return (positive, negative, pos_cond, neg_cond)


# ── Node mappings ──────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS_PROMPT_COMPOSER = {
    "CWKPromptComposerNode": CWKPromptComposerNode,
}

NODE_DISPLAY_NAME_MAPPINGS_PROMPT_COMPOSER = {
    "CWKPromptComposerNode": "CWK Prompt Composer",
}