"""
CWK Save Image — manual image saver node (CWK Custom Nodes Collection).

    CWK_ModelLoaderPipe "infos" ──┐
    IMAGE (batch) ────────────────┤→ CWK_Save_Image  (sink node, no outputs)
    MASK  (batch, optional) ──────┘        │
                                           └─ Save button → POST /cwk_save_image/save

There is NO autosave: execute() only writes temp preview files; real files are
written exclusively through the REST route when the user clicks Save.

Delivery (primary): a dedicated WebSocket event "cwk_save_image_data", pushed
with server.send_sync() exactly like the collection's CWKLivePreview node does
with "cwk_live_preview". Custom ui keys are filtered out by some frontends
before reaching the JS, and the standard "images" ui key engages the stock
node-image machinery (which draws over the UI, resizes the node and CONSUMES
pointer events across the whole body). A dedicated ws event avoids both
problems and is proven to work in this collection. Secondary (redundant,
deduped): the custom "cwk" ui key, received via onExecuted / the "executed"
event on frontends that forward it.

Temp filenames carry channel/mask prefixes (cwkA_/cwkN_ + rgb/rgba/alpha) so
the JS fallback parser can rebuild the channels from a standard "images"
payload in case of a Python/JS version mismatch.

Settings live as (JS-hidden) widgets so they persist inside the workflow:
filename_template, imprint_infos, output_format, save_folder, subfolder_tag,
save_entire_batch, channel, settings_folded.
"""

import json
import os
import re
import time
import uuid
from typing import Any, Dict, Optional, Tuple

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

import folder_paths

# ─── Constants ────────────────────────────────────────────────────────────────

OUTPUT_FORMATS = ["PNG", "JPG", "WebP"]
CHANNELS       = ["RGB", "RGBA", "ALPHA"]

_WS_EVENT = "cwk_save_image_data"

_IMPRINT_KEYS = [
    "model_name", "sampler_name", "scheduler", "cfg", "steps", "seed",
    "clip_skip", "rng", "model_sampling", "clip_name", "vae_name", "clip_type",
]
_KNOWN_KEYS = set(_IMPRINT_KEYS)

# Temp filename tags: A = masks connected, N = no masks (used by the JS
# fallback parser — see module docstring).
_MASK_TAG = {"A": "cwkA", "N": "cwkN"}

# ─── Small helpers ────────────────────────────────────────────────────────────

def _sanitize_component(name) -> str:
    """Make a string safe as a single path component."""
    s = str(name or "").strip()
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s)
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"_{2,}", "_", s).strip("._")
    return "" if s in ("", ".", "..") else s


def _strip_model_ext(value) -> str:
    s = str(value or "")
    return re.sub(r"\.(safetensors|ckpt|gguf|pt|pth|bin|sft)$", "", s, flags=re.IGNORECASE)


_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
]
_font_cache: Dict[int, Any] = {}

def _load_font(size: int):
    size = max(8, int(size))
    if size in _font_cache:
        return _font_cache[size]
    font = None
    for p in _FONT_CANDIDATES:
        try:
            if os.path.exists(p):
                font = ImageFont.truetype(p, size)
                break
        except Exception:
            pass
    if font is None:
        try:
            font = ImageFont.load_default(size=size)   # Pillow >= 10.1
        except TypeError:
            font = ImageFont.load_default()
    _font_cache[size] = font
    return font


def _masks_to_numpy(masks, batch: int) -> Optional[np.ndarray]:
    """Normalise a MASK input to a float array [B, H, W, 1] in 0..1."""
    if masks is None:
        return None
    if torch.is_tensor(masks):
        m = masks.detach().float().cpu().numpy()
    else:
        m = np.asarray(masks, dtype=np.float32)
    m = np.clip(m, 0.0, 1.0)
    if m.ndim == 2:                       # [H,W]
        m = m[None, ..., None]
    elif m.ndim == 3:                     # [B,H,W]
        m = m[..., None]
    elif m.ndim == 4:                     # [B,H,W,1] / [B,1,H,W] / [B,H,W,C]
        if m.shape[-1] == 1:
            pass
        elif m.shape[1] == 1:
            m = m[:, 0][..., None]
        else:
            m = m[..., 0:1]
    else:
        raise ValueError(f"[CWK SaveImage] unsupported mask shape {m.shape}")
    if m.shape[0] == 1 and batch > 1:
        m = np.repeat(m, batch, axis=0)
    if m.shape[0] != batch:
        raise ValueError(f"[CWK SaveImage] mask batch ({m.shape[0]}) != image batch ({batch})")
    return m


def _build_item_images(img_t, alpha_u8: Optional[np.ndarray]) -> Tuple[Image.Image, Image.Image, Image.Image]:
    """Build the (RGB, RGBA, ALPHA) PIL images for one batch item."""
    a = np.clip(img_t.float().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    if a.ndim == 2:
        a = a[..., None]
    if a.shape[-1] == 1:
        a = np.repeat(a, 3, axis=-1)
    rgb_arr = a[..., :3]
    if alpha_u8 is None:
        # no mask → use image's own alpha (if any) or fully opaque
        alpha_u8 = a[..., 3] if a.shape[-1] > 3 else np.full(rgb_arr.shape[:2], 255, dtype=np.uint8)
    rgb       = Image.fromarray(rgb_arr, mode="RGB")
    rgba      = Image.merge("RGBA", (*rgb.split(), Image.fromarray(alpha_u8, mode="L")))
    alpha_img = Image.fromarray(alpha_u8, mode="L")
    return rgb, rgba, alpha_img


def _save_temp(img: Image.Image, prefix: str) -> Dict[str, str]:
    """Save a PIL image into ComfyUI's temp folder; return a /view entry.

    The prefix encodes mask state + channel (cwkA_/cwkN_ + rgb/rgba/alpha) so
    the frontend's fallback parser can classify entries if a standard
    "images" payload ever appears (version mismatch).
    """
    temp_dir = folder_paths.get_temp_directory()
    fname = f"{prefix}_{time.strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:6]}.png"
    img.save(os.path.join(temp_dir, fname))
    return {"filename": fname, "subfolder": "", "type": "temp"}


def _send_node_payload(unique_id, cwk_payload: Dict[str, Any]) -> None:
    """Push the preview payload to the frontend over a dedicated WebSocket event.

    Same pattern as the collection's CWKLivePreview node: server.send_sync()
    is safe to call from the execution worker thread and arrives at the
    frontend as an api event ("cwk_save_image_data") that the JS routes by
    node id. This bypasses ui-payload filtering entirely and never touches
    node.imgs / node.images, so the stock image machinery cannot engage.
    """
    try:
        from server import PromptServer
        server = PromptServer.instance
        if server is None:
            return
        sid = getattr(server, "client_id", None)
        payload = dict(cwk_payload)
        payload["node"] = str(unique_id)
        server.send_sync(_WS_EVENT, payload, sid)
    except Exception as e:
        print(f"[CWK SaveImage] send_sync failed: {e}")

# ─── Imprint (black footer / white text) ──────────────────────────────────────

def _format_infos_lines(infos: Dict[str, Any]) -> Tuple[str, str]:
    def g(k):
        v = infos.get(k)
        return "" if v is None else str(v).strip()

    l1 = []
    model = _strip_model_ext(g("model_name"))
    if model:
        l1.append(model)
    gen = " / ".join(p for p in (g("sampler_name"), g("scheduler")) if p)
    if gen:
        l1.append(gen)
    params = [f"{k}: {g(k)}" for k in ("cfg", "steps", "seed") if g(k) != ""]
    if params:
        l1.append("  ".join(params))
    line1 = "  |  ".join(l1)

    l2 = []
    for key in ("clip_skip", "rng", "model_sampling", "clip_name", "vae_name", "clip_type"):
        v = g(key)
        if v:
            if key.endswith("_name"):
                v = _strip_model_ext(v)
            l2.append(f"{key}: {v}")
    for k, v in infos.items():          # any extra tags present in infos
        if k not in _KNOWN_KEYS and v is not None and str(v).strip():
            l2.append(f"{k}: {str(v).strip()}")
    line2 = "  |  ".join(l2)
    return line1, line2


def _apply_imprint(img: Image.Image, infos: Dict[str, Any]) -> Image.Image:
    """Add a black footer with the generation infos in white text."""
    line1, line2 = _format_infos_lines(infos)
    lines = [l for l in (line1, line2) if l]
    if not lines:
        return img

    w, h = img.size
    fs = max(13, min(30, w // 46))
    font = _load_font(fs)
    line_h = fs + 10
    footer_h = len(lines) * line_h + 12

    mode = img.mode
    if mode == "RGBA":
        canvas = Image.new("RGBA", (w, h + footer_h), (0, 0, 0, 255))
        canvas.paste(img, (0, 0))
        fill = (255, 255, 255, 255)
    elif mode == "L":
        canvas = Image.new("L", (w, h + footer_h), 0)
        canvas.paste(img, (0, 0))
        fill = 255
    else:
        canvas = Image.new("RGB", (w, h + footer_h), (0, 0, 0))
        canvas.paste(img.convert("RGB"), (0, 0))
        fill = (255, 255, 255)

    d = ImageDraw.Draw(canvas)
    y = h + 6
    for text in lines:
        txt = text
        try:
            while len(txt) > 4 and d.textlength(txt, font=font) > w - 24:
                txt = txt[:-2].rstrip() + "…"
        except Exception:
            pass
        d.text((12, y), txt, fill=fill, font=font)
        y += line_h
    return canvas

# ─── Save utilities ───────────────────────────────────────────────────────────

def _resolve_target_dir(folder: str, subfolder: str) -> str:
    """Resolve the final save directory.

    folder:    ""       → ComfyUI output dir (default)
               "sub"    → <output>/sub
               absolute → used as-is
    subfolder: sanitized ("a/b" allowed), usually one resolved tag value.
    """
    out_root = folder_paths.get_output_directory()
    base = out_root
    folder = (folder or "").strip()
    if folder:
        base = folder if os.path.isabs(folder) else os.path.normpath(os.path.join(out_root, folder))
    parts = [_sanitize_component(p) for p in str(subfolder or "").replace("\\", "/").split("/")]
    parts = [p for p in parts if p]
    full = os.path.join(base, *parts) if parts else base
    os.makedirs(full, exist_ok=True)
    return full


def _unique_path(directory: str, filename: str) -> str:
    p = os.path.join(directory, filename)
    if not os.path.exists(p):
        return p
    stem, ext = os.path.splitext(filename)
    i = 1
    while True:
        p = os.path.join(directory, f"{stem}_{i:04d}{ext}")
        if not os.path.exists(p):
            return p
        i += 1


def _save_channel_image(img: Image.Image, fmt: str, path: str) -> None:
    if fmt == "PNG":
        img.save(path, compress_level=4)
    elif fmt == "JPG":
        if img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))   # flatten on white
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.save(path, quality=95)
    elif fmt == "WebP":
        img.save(path, quality=95, method=4)
    else:
        raise ValueError(f"unknown format {fmt}")

# ─── Node ─────────────────────────────────────────────────────────────────────

class CWK_SaveImage:
    """
    CWK Save Image — manual image saver (sink node, no outputs).

    execute() prepares RGB / RGBA / ALPHA previews (temp files), pushes them
    to the frontend over the "cwk_save_image_data" WebSocket event, and also
    returns them under the custom "cwk" ui key (secondary channel).
    Files are written only when the user presses the Save button
    (POST /cwk_save_image/save).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                # ── settings (drawn by the JS frontend, hidden as widgets) ──
                "filename_template": ("STRING", {
                    "default": "{model_name}_{sampler_name}_cfg{cfg}_steps{steps}",
                    "multiline": False,
                }),
                "imprint_infos":     ("BOOLEAN", {"default": False}),
                "output_format":     (OUTPUT_FORMATS, {"default": "PNG"}),
                "save_folder":       ("STRING", {"default": "", "multiline": False}),
                "subfolder_tag":     ("STRING", {"default": "", "multiline": False}),
                "save_entire_batch": ("BOOLEAN", {"default": True}),
                "channel":           (CHANNELS, {"default": "RGB"}),
                "settings_folded":   ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "masks": ("MASK",),
                "infos": ("STRING", {"forceInput": True, "tooltip": "infos output of CWK_ModelLoaderPipe"}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION     = "execute"
    CATEGORY     = "CWK/Save"
    OUTPUT_NODE  = True
    DESCRIPTION  = ("Manual image saver: preview RGB / RGBA (mask→alpha) / ALPHA, "
                    "tag-based filenames from the pipe infos, optional info imprint. "
                    "Files are only written when you press Save — no autosave.")

    def execute(self, images, filename_template, imprint_infos, output_format,
                save_folder, subfolder_tag, save_entire_batch, channel,
                settings_folded, masks=None, infos="", unique_id=0):

        if images is None:
            raise ValueError("[CWK SaveImage] no images received")
        batch = int(images.shape[0])
        if batch == 0:
            raise ValueError("[CWK SaveImage] empty image batch")

        m = _masks_to_numpy(masks, batch)

        # ── Parse infos JSON (from CWK_ModelLoaderPipe) ──
        infos_dict: Dict[str, Any] = {}
        if isinstance(infos, dict):
            infos_dict = infos
        elif isinstance(infos, str) and infos.strip():
            try:
                parsed = json.loads(infos)
                if isinstance(parsed, dict):
                    infos_dict = parsed
            except Exception:
                infos_dict = {}

        # ── Build & save the three preview channels per batch item ──
        tag = _MASK_TAG["A" if m is not None else "N"]
        rgb_entries, rgba_entries, alpha_entries = [], [], []
        for i in range(batch):
            alpha = None
            if m is not None:
                alpha = (np.clip(m[i, ..., 0], 0.0, 1.0) * 255.0).astype(np.uint8)
            rgb, rgba, alpha_img = _build_item_images(images[i], alpha)
            rgb_entries.append(_save_temp(rgb,   f"{tag}_rgb"))
            rgba_entries.append(_save_temp(rgba, f"{tag}_rgba"))
            alpha_entries.append(_save_temp(alpha_img, f"{tag}_alpha"))

        cwk_payload = {
            "rgb":        rgb_entries,
            "rgba":       rgba_entries,
            "alpha":      alpha_entries,
            "infos":      infos_dict,
            "batch_size": batch,
            "has_masks":  m is not None,
        }

        # PRIMARY transport: dedicated WebSocket event (like CWKLivePreview).
        _send_node_payload(unique_id, cwk_payload)

        print(f"[CWK SaveImage] node {unique_id}: {batch} image(s) ready | "
              f"masks={'yes' if m is not None else 'no'} | "
              f"infos tags={list(infos_dict.keys())}")

        # SECONDARY transport: custom "cwk" ui key (used automatically on
        # frontends that forward unknown ui keys; deduped with the ws event).
        # Deliberately NO standard "images" key — that's what engages the
        # stock node-image machinery (overlay drawing + click interception).
        return {
            "ui": {"cwk": cwk_payload},
            "result": (),
        }

# ─── REST route (manual save — no autosave) ───────────────────────────────────

try:
    from aiohttp import web
    from server import PromptServer

    _routes = PromptServer.instance.routes

    @_routes.post("/cwk_save_image/save")
    async def cwk_save_image_save(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid JSON"}, status=400)

        channel    = str(data.get("channel", "rgb")).lower()
        entries    = data.get("images") or []
        base_name  = _sanitize_component(data.get("base_name")) or "ComfyUI"
        subfolder  = str(data.get("subfolder") or "")
        folder     = str(data.get("folder") or "").strip()
        fmt        = str(data.get("format") or "PNG").upper()
        imprint    = bool(data.get("imprint", False))
        infos      = data.get("imprint_infos") if isinstance(data.get("imprint_infos"), dict) else {}
        entire     = bool(data.get("entire_batch", True))
        b_index    = int(data.get("batch_index", 0) or 0)

        if channel not in ("rgb", "rgba", "alpha"):
            return web.json_response({"ok": False, "error": f"unknown channel: {channel}"}, status=400)
        if not entries or not isinstance(entries[0], dict):
            return web.json_response({"ok": False, "error": "no images — run the workflow first"}, status=400)
        if fmt not in OUTPUT_FORMATS:
            fmt = "PNG"

        # ── Which batch items to save ──
        if entire or len(entries) == 1:
            items = list(enumerate(entries))
        else:
            idx = max(0, min(b_index, len(entries) - 1))
            items = [(idx, entries[idx])]

        # ── Resolve & validate the temp preview files ──
        temp_dir = os.path.normcase(os.path.realpath(folder_paths.get_temp_directory()))
        sources = []
        for i, entry in items:
            fn  = os.path.basename(str(entry.get("filename", "")).replace("\\", "/"))
            sub = [p for p in str(entry.get("subfolder", "") or "").replace("\\", "/").split("/")
                   if p not in ("", ".", "..")]
            if not fn:
                return web.json_response({"ok": False, "error": "missing preview filename"}, status=400)
            path = os.path.realpath(os.path.join(temp_dir, *sub, fn))
            if os.path.normcase(path) != temp_dir and not os.path.normcase(path).startswith(temp_dir + os.sep):
                return web.json_response({"ok": False, "error": "preview path outside temp folder"}, status=400)
            if not os.path.isfile(path):
                return web.json_response({"ok": False, "error": f"preview not found: {fn}"}, status=404)
            sources.append((i, path))

        # ── Target directory ──
        try:
            out_dir = _resolve_target_dir(folder, subfolder)
        except Exception as e:
            return web.json_response({"ok": False, "error": f"cannot create save folder: {e}"}, status=400)

        ext      = {"PNG": ".png", "JPG": ".jpg", "WebP": ".webp"}[fmt]
        multiple = len(sources) > 1
        saved    = []
        try:
            for i, src in sources:
                img = Image.open(src)
                img.load()

                if channel == "alpha":
                    if img.mode != "L":
                        img = img.convert("L")
                elif channel == "rgba":
                    if img.mode != "RGBA":
                        img = img.convert("RGBA")
                else:
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")

                # imprint = black footer + white infos text (not on pure masks)
                if imprint and channel in ("rgb", "rgba"):
                    img = _apply_imprint(img, infos)

                name  = base_name + (f"_{i:03d}" if multiple else "") + ext
                final = _unique_path(out_dir, name)
                _save_channel_image(img, fmt, final)
                saved.append(final)
                print(f"[CWK SaveImage] saved {final}")
        except Exception as e:
            return web.json_response({"ok": False, "error": f"save failed: {e}"}, status=500)

        return web.json_response({"ok": True, "count": len(saved), "saved": saved})

except Exception as _e:
    print(f"[CWK_Save_Image] Could not register save route: {_e}")

# ─── Node mappings ────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS_SAVE_IMAGE = {
    "CWK_Save_Image": CWK_SaveImage,
}
NODE_DISPLAY_NAME_MAPPINGS_SAVE_IMAGE = {
    "CWK_Save_Image": "CWK Save Image",
}
