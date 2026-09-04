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

# ─── CWK Live Preview: forced preview patch + toggle route ────────────────────
try:
    import base64
    from io import BytesIO

    import latent_preview
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

    def _send_preview(previewer, x0):
        server = PromptServer.instance
        if server is None or previewer is None:
            return
        if x0.is_nested:
            x0 = x0.tensors[0]

        _, pil_image, _ = previewer.decode_latent_to_preview_image("JPEG", x0)

        buf = BytesIO()
        pil_image.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        server.send_sync(
            "cwk_live_preview",
            {"image": f"data:image/jpeg;base64,{b64}"},
            server.client_id,
        )

    def _patched_prepare_callback(model, steps, x0_output_dict=None):
        # Preserve original behavior completely (respects global setting as before).
        original_callback = _original_prepare_callback(model, steps, x0_output_dict)

        forced_previewer = _build_forced_previewer(model) if CWK_STATE["enabled"] else None

        def callback(step, x0, x, total_steps):
            original_callback(step, x0, x, total_steps)
            if CWK_STATE["enabled"] and forced_previewer is not None:
                _send_preview(forced_previewer, x0)

        return callback

    # Apply the patch once at import time. Since nodes.py etc. call
    # `latent_preview.prepare_callback(...)` by attribute lookup on the module,
    # patching the module attribute affects ALL callers globally.
    latent_preview.prepare_callback = _patched_prepare_callback

    # --- Simple route so the frontend Settings toggle can sync to the backend ---
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
import sys
if 'comfy.nodes' in sys.modules:
    del sys.modules['comfy.nodes']