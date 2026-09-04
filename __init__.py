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