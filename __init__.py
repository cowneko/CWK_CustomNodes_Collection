"""
CWK Custom Nodes Collection — ComfyUI entry point.
Registers nodes and REST routes with the ComfyUI server.
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .server import register_routes

try:
    from server import PromptServer
    register_routes(PromptServer.instance.app)
except Exception as e:
    print(f"[CWK_CustomNodes_Collection] Could not register routes: {e}")

# ─── CWK Prompt Composer: LLM prompt enhancement routes ────────────────────
try:
    from . import cwk_prompt_llm   # registers the /cwk/pc/* routes on import
except Exception as e:
    print(f"[CWK_LLM] Failed to load cwk_prompt_llm: {e}")

# ─── CWK Live Preview: forced preview patch + toggle route ────────────────────
try:
    import base64
    from io import BytesIO

    import torch
    import latent_preview
    from PIL import Image
    from server import PromptServer

    # In-memory toggle, controlled from the ComfyUI Settings panel (see JS file).
    CWK_STATE = {"enabled": False}

    _original_prepare_callback = latent_preview.prepare_callback

    def _build_forced_previewer(model):
        """Build our own previewer independent of the global Preview Method,
        so it works even when the global setting is 'none'."""
        lf = model.model.latent_format
        if lf.latent_rgb_factors is None:
            return None
        return latent_preview.Latent2RGBPreviewer(
            lf.latent_rgb_factors,
            lf.latent_rgb_factors_bias,
            lf.latent_rgb_factors_reshape,
        )

    def _walk_latent_parts(t, out, prefix, depth=0):
        """Collect real tensors from nested/tree latent wrappers and lists."""
        if t is None or depth > 4:
            return
        if getattr(t, "is_nested", False):
            parts = getattr(t, "tensors", None)
            if parts is not None:
                for i, p in enumerate(parts):
                    _walk_latent_parts(p, out, f"{prefix}.tensors[{i}]", depth + 1)
                return
        if isinstance(t, (list, tuple)):
            for i, p in enumerate(t):
                _walk_latent_parts(p, out, f"{prefix}[{i}]", depth + 1)
            return
        if isinstance(t, torch.Tensor):
            out.append((prefix, t))

    def _pick_preview_latent(candidates):
        """Pick the tensor most likely to be the FULL evolving latent:
        prefer 5-D (video), then the largest by element count."""
        parts = []
        for c in candidates:
            _walk_latent_parts(c, parts, "cand")
        if not parts:
            return None
        tensors = [t for _, t in parts]
        vids = [t for t in tensors if t.ndim == 5]
        return max(vids or tensors, key=lambda t: t.numel())

    def _decode_one(previewer, t):
        """Shape-agnostic decode — handles 2- and 3-tuple returns."""
        out = previewer.decode_latent_to_preview_image("JPEG", t)
        if isinstance(out, (tuple, list)):
            return out[1] if len(out) > 1 else out[0]
        return out

    def _frames_from_latent(previewer, x0):
        """5-D video latent [B, C, T, H, W] → one PIL frame per timestep.
        The slice MUST be x[:, :, t]: time is dim 2. x[:, t] would index
        CHANNELS (wrong-channel-count tensor → matmul error) and dropping
        the batch first (x[0] then x[:, t]) leaves a 3-D tensor the
        previewer can't consume either. 4-D (image) latents pass through."""
        if x0.ndim == 5:
            return [_decode_one(previewer, x0[:, :, t]) for t in range(x0.shape[2])]
        return [_decode_one(previewer, x0)]

    def _send_preview(previewer, candidates, step=None):
        server = PromptServer.instance
        if server is None or previewer is None:
            return
        try:
            x0 = _pick_preview_latent(candidates)
            if x0 is None:
                return
            frames = _frames_from_latent(previewer, x0)
            frames = [f.convert("RGB") for f in frames if f is not None]
            if not frames:
                return

            # Upscale tiny latent-resolution frames (60px wide for 480×832)
            # so the preview is readable — same idea as VHS.
            min_side = min(frames[0].width, frames[0].height)
            if min_side < 160:
                scale = min(4, 640 // min_side)
                frames = [f.resize((f.width * scale, f.height * scale), Image.BILINEAR)
                          for f in frames]

            # Stack vertically into one strip; the JS splits it back into
            # frames and animates them. Cap for PIL's ~65k JPEG height limit.
            MAX_STRIP_H = 60000
            kept, strip_h = [], 0
            for f in frames:
                if kept and strip_h + f.height > MAX_STRIP_H:
                    break
                kept.append(f)
                strip_h += f.height
            if len(kept) == 1:
                strip = kept[0]
            else:
                strip = Image.new("RGB", (kept[0].width, strip_h))
                y = 0
                for f in kept:
                    strip.paste(f, (0, y))
                    y += f.height

            buf = BytesIO()
            strip.save(buf, format="JPEG", quality=80)
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            server.send_sync(
                "cwk_live_preview",
                {"image": f"data:image/jpeg;base64,{b64}", "frames": len(kept)},
                server.client_id,
            )
        except Exception as e:
            print(f"[CWK_LivePreview] preview error (step={step}): {e!r}")

    def _patched_prepare_callback(model, steps, x0_output_dict=None):
        # Returns None when the global method is 'none' — calling it anyway
        # crashed sampling in that mode.
        original_callback = _original_prepare_callback(model, steps, x0_output_dict)
        forced_previewer = _build_forced_previewer(model) if CWK_STATE["enabled"] else None

        def callback(step, x0, x, total_steps):
            if original_callback is not None:
                original_callback(step, x0, x, total_steps)
            if CWK_STATE["enabled"] and forced_previewer is not None:
                cands = []
                if x0_output_dict:
                    dx = x0_output_dict.get("x0")
                    if dx is not None:
                        cands.append(dx)
                cands.append(x0)
                _send_preview(forced_previewer, cands, step)

        return callback

    latent_preview.prepare_callback = _patched_prepare_callback

    routes = PromptServer.instance.routes

    @routes.post("/cwk_live_preview/toggle")
    async def cwk_toggle(request):
        from aiohttp import web
        data = await request.json()
        CWK_STATE["enabled"] = bool(data.get("enabled", False))
        return web.json_response({"enabled": CWK_STATE["enabled"]})
except Exception as e:
    print(f"[CWK_LivePreview] Failed to register route: {e}")

import folder_paths

_GGUF_EXT = {".gguf"}

for folder_type in ("checkpoints", "diffusion_models"):
    try:
        existing = folder_paths.folder_names_and_paths.get(folder_type)
        if existing and len(existing) >= 2 and isinstance(existing[1], set):
            existing[1].update(_GGUF_EXT)
            # Bust the cached file list so the next get_filename_list() rescans
            folder_paths.filename_list_cache.pop(folder_type, None)
            print(f"[CWK] Registered .gguf extension for '{folder_type}'")
    except Exception as e:
        print(f"[CWK] Warning: could not register .gguf for '{folder_type}': {e}")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

# Force clear any caching
#import sys
#if 'comfy.nodes' in sys.modules:
    #del sys.modules['comfy.nodes']
