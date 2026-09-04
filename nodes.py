"""
CWK Custom Nodes Collection — Node definitions.

Includes:
- CWK_ModelLoader: Simplified model loader
- CWK_ModelLoaderPipe: Pipeline companion node
- CWK_LatentImage: Resolution & batch selector
- CWKBatchSelector: Batch image selector with preview
- CWK_LivePreview: Real-time image preview
"""

import json
import os
import re
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Tuple

import torch
import folder_paths
import comfy.samplers
import comfy.sd

# ─── Preset file path ─────────────────────────────────────────────────────────

_NODE_DIR          = os.path.dirname(__file__)
_PRESETS_FILE      = os.path.join(_NODE_DIR, "checkpoint_presets.json")
_LAST_MODEL_FILE   = os.path.join(_NODE_DIR, "last_used_model.json")


# ─── Last-used model persistence ───────────────────────────────────────────────

def get_last_used_model() -> Optional[str]:
    """Return the last-used model name, or None."""
    if os.path.exists(_LAST_MODEL_FILE):
        try:
            with open(_LAST_MODEL_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("model_name")
        except Exception:
            pass
    return None


def save_last_used_model(model_name: str) -> None:
    """Persist the last-used model name to disk."""
    try:
        with open(_LAST_MODEL_FILE, "w", encoding="utf-8") as f:
            json.dump({"model_name": model_name}, f)
    except Exception as e:
        print(f"[CWK] Error saving last model: {e}")


# ─── Model Sampling types ──────────────────────────────────────────────────────

MODEL_SAMPLING_TYPES = ["eps", "v_prediction", "lcm", "x0", "img_to_img"]
# "default" sentinel = no model_sampling patch applied (pass model through untouched)
MODEL_SAMPLING_TYPES_WITH_DEFAULT = ["default"] + MODEL_SAMPLING_TYPES

# ─── RNG types ──────────────────────────────────────────────────────────────────

RNG_TYPES = ["cpu", "gpu", "nv"]
# "default" sentinel = no RNG patch applied (pass model through untouched)
RNG_TYPES_WITH_DEFAULT = ["default"] + RNG_TYPES

# ─── Clip skip options ──────────────────────────────────────────────────────────

# "Disabled" sentinel = skip clip.clip_layer() entirely (pass clip through untouched)
CLIP_SKIP_OPTIONS = ["Disabled"] + [str(i) for i in range(-1, -25, -1)]


# ─── Resolution presets ────────────────────────────────────────────────────────

RESOLUTION_PRESETS: Dict[str, Tuple[int, int]] = {
    # ── Custom / passthrough ──
    "(preset)":               (0, 0),
    # ── SDXL / SD3 / Pony (1024px base) ──
    "SDXL 1:1  (1024×1024)":  (1024, 1024),
    "SDXL 3:4  (896×1152)":   (896,  1152),
    "SDXL 4:3  (1152×896)":   (1152, 896),
    "SDXL 2:3  (832×1216)":   (832,  1216),
    "SDXL 3:2  (1216×832)":   (1216, 832),
    "SDXL 9:16 (768×1344)":   (768,  1344),
    "SDXL 16:9 (1344×768)":   (1344, 768),
    "SDXL 9:21 (640×1536)":   (640,  1536),
    "SDXL 21:9 (1536×640)":   (1536, 640),
    # ── SD 1.5 (512px base) ──
    "SD1.5 1:1  (512×512)":   (512,  512),
    "SD1.5 3:4  (448×576)":   (448,  576),
    "SD1.5 4:3  (576×448)":   (576,  448),
    "SD1.5 2:3  (416×608)":   (416,  608),
    "SD1.5 3:2  (608×416)":   (608,  416),
    "SD1.5 9:16 (384×672)":   (384,  672),
    "SD1.5 16:9 (672×384)":   (672,  384),
    # ── Flux / Large models (1024+ base) ──
    "Flux 1:1  (1024×1024)":  (1024, 1024),
    "Flux 3:4  (896×1152)":   (896,  1152),
    "Flux 4:3  (1152×896)":   (1152, 896),
    "Flux 2:3  (832×1216)":   (832,  1216),
    "Flux 3:2  (1216×832)":   (1216, 832),
    "Flux 9:16 (768×1344)":   (768,  1344),
    "Flux 16:9 (1344×768)":   (1344, 768),
    # ── Wan / Video models (1280+ base) ──
    "Wan 16:9  (832×480)":    (832, 480),
    "Wan 9:16  (480×832)":    (480,  832),
    "Wan 16:9  (1280×720)":   (1280, 720),
    "Wan 9:16  (720×1280)":   (720,  1280),
}

RESOLUTION_PRESET_NAMES = list(RESOLUTION_PRESETS.keys())


# ─── Public helpers ───────────────────────────────────────────────────────────

def get_clip_list():
    """Return list of available CLIP models with 'embedded' as first entry."""
    clips = set()
    try:
        clips.update(folder_paths.get_filename_list("clip"))
    except Exception:
        pass
    # Also include city96's clip_gguf folder type
    try:
        clips.update(folder_paths.get_filename_list("clip_gguf"))
    except Exception:
        pass
    return ["embedded"] + sorted(clips)
    
    
def _get_clip_types() -> list:
    """Build list of available CLIPType values from comfy.sd.CLIPType enum."""
    clip_types = []
    try:
        for attr in dir(comfy.sd.CLIPType):
            if not attr.startswith("_"):
                clip_types.append(attr.lower())
    except Exception:
        pass
    if not clip_types:
        clip_types = ["stable_diffusion", "stable_cascade", "sd3", "stable_audio", "flux", "flux2",
                      "hunyuan_video", "mochi", "ltxv", "wan", "cosmos"]
    return sorted(set(clip_types))    


def _default_clip_type(clip_types: list) -> str:
    """Return the correct default clip_type, falling back gracefully if 'stable_diffusion'
    isn't present in the (dynamically built) clip_types list."""
    if "stable_diffusion" in clip_types:
        return "stable_diffusion"
    return clip_types[0] if clip_types else "stable_diffusion"


def get_vae_list():
    """Return list of available VAE models with 'embedded' as first entry."""
    try:
        vaes = folder_paths.get_filename_list("vae")
    except Exception:
        vaes = []
    return ["embedded"] + sorted(vaes)


def default_preset() -> Dict[str, Any]:
    samplers   = list(comfy.samplers.KSampler.SAMPLERS)
    schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
    return {
        "sampler_name":    samplers[0]   if samplers   else "euler",
        "scheduler":       schedulers[0] if schedulers else "normal",
        "cfg":             7.0,
        "steps":           20,
        "clip_skip":       "-2",
        "width":           1024,
        "height":          1024,
        "rng":             "default",
        "model_sampling":  "default",
        "clip_name":       "embedded",
        "vae_name":        "embedded",
        "clip_type":       "stable_diffusion",
    }


def load_presets() -> Dict[str, Any]:
    if os.path.exists(_PRESETS_FILE):
        try:
            with open(_PRESETS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[CWK] Error loading presets: {e}")
    return {}


def save_presets(presets: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(_PRESETS_FILE), exist_ok=True)
        with open(_PRESETS_FILE, "w", encoding="utf-8") as f:
            json.dump(presets, f, indent=2)
    except Exception as e:
        print(f"[CWK] Error saving presets: {e}")


# ─── Sampler / Scheduler fallback system ───────────────────────────────────────

_SAMPLER_ALIASES: Dict[str, str] = {
    "euler a": "euler_ancestral",
    "euler_a": "euler_ancestral",
    "eulera": "euler_ancestral",
    "heun": "heun",
    "heunpp2": "heunpp2",
    "dpm2": "dpm_2",
    "dpm2 a": "dpm_2_ancestral",
    "dpm2_a": "dpm_2_ancestral",
    "dpm2 ancestral": "dpm_2_ancestral",
    "dpm++ 2s a": "dpmpp_2s_ancestral",
    "dpm++ 2s ancestral": "dpmpp_2s_ancestral",
    "dpmpp_2s_a": "dpmpp_2s_ancestral",
    "dpm++ 2m": "dpmpp_2m",
    "dpm++ sde": "dpmpp_sde",
    "dpm++ 2m sde": "dpmpp_2m_sde",
    "dpm++ 3m sde": "dpmpp_3m_sde",
    "dpm fast": "dpm_fast",
    "dpm adaptive": "dpm_adaptive",
    "lms": "lms",
    "restart": "restart",
    "ddim": "ddim",
    "plms": "plms",
    "uni_pc": "uni_pc",
    "uni_pc_bh2": "uni_pc_bh2",
    "unipc": "uni_pc",
    "lcm": "lcm",
    "dpm++ 2m karras": "dpmpp_2m",
    "dpm++ 2m sde karras": "dpmpp_2m_sde",
    "dpm++ sde karras": "dpmpp_sde",
    "dpm++ 3m sde karras": "dpmpp_3m_sde",
    "dpm++ 2s a karras": "dpmpp_2s_ancestral",
    "dpm++ 2m sde exponential": "dpmpp_2m_sde",
    "dpm++ 3m sde exponential": "dpmpp_3m_sde",
    "euler_cfg++": "euler_cfg_pp",
    "euler_ancestral_cfg++": "euler_ancestral_cfg_pp",
    "euler cfg++": "euler_cfg_pp",
    "euler ancestral cfg++": "euler_ancestral_cfg_pp",
    "euler_a_cfg++": "euler_ancestral_cfg_pp",
}

_SCHEDULER_ALIASES: Dict[str, str] = {
    "karras": "karras",
    "exponential": "exponential",
    "normal": "normal",
    "simple": "simple",
    "sgm_uniform": "sgm_uniform",
    "sgm uniform": "sgm_uniform",
    "ddim_uniform": "ddim_uniform",
    "beta": "beta",
    "linear": "normal",
    "uniform": "normal",
}


def _normalise(name: str) -> str:
    """Lowercase, collapse whitespace, strip."""
    return re.sub(r'\s+', ' ', name.strip().lower())


def _strip_for_fuzzy(name: str) -> str:
    """Remove all non-alphanumeric chars for fuzzy comparison."""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def _fuzzy_match(name: str, candidates: List[str], threshold: float = 0.6) -> Optional[str]:
    """Find the best fuzzy match among candidates. Returns None if below threshold."""
    stripped = _strip_for_fuzzy(name)
    best_score = 0.0
    best_match = None
    for c in candidates:
        c_stripped = _strip_for_fuzzy(c)
        score = SequenceMatcher(None, stripped, c_stripped).ratio()
        if stripped in c_stripped or c_stripped in stripped:
            score = max(score, 0.8)
        if score > best_score:
            best_score = score
            best_match = c
    if best_score >= threshold:
        return best_match
    return None


def resolve_sampler(name: str, available: Optional[List[str]] = None) -> str:
    if available is None:
        available = list(comfy.samplers.KSampler.SAMPLERS)
    if not name or not available:
        fb = available[0] if available else "euler"
        return fb
    if name in available:
        return name
    normed = _normalise(name)
    alias = _SAMPLER_ALIASES.get(normed)
    if alias and alias in available:
        print(f"[CWK] Sampler alias: '{name}' → '{alias}'")
        return alias
    pp_sub = name.replace("++", "_pp").replace(" ", "_").lower()
    if pp_sub in available:
        print(f"[CWK] Sampler ++ fix: '{name}' → '{pp_sub}'")
        return pp_sub
    underscore = _normalise(name).replace(" ", "_").replace("++", "_pp")
    if underscore in available:
        print(f"[CWK] Sampler normalised: '{name}' → '{underscore}'")
        return underscore
    fuzzy = _fuzzy_match(name, available)
    if fuzzy:
        print(f"[CWK] Sampler fuzzy match: '{name}' → '{fuzzy}'")
        return fuzzy
    fallback = "euler" if "euler" in available else available[0]
    print(f"[CWK] ⚠ Sampler '{name}' not found — falling back to '{fallback}'")
    return fallback


def resolve_scheduler(name: str, available: Optional[List[str]] = None) -> str:
    if available is None:
        available = list(comfy.samplers.KSampler.SCHEDULERS)
    if not name or not available:
        fb = available[0] if available else "simple"
        return fb
    if name in available:
        return name
    normed = _normalise(name)
    alias = _SCHEDULER_ALIASES.get(normed)
    if alias and alias in available:
        print(f"[CWK] Scheduler alias: '{name}' → '{alias}'")
        return alias
    underscore = normed.replace(" ", "_")
    if underscore in available:
        print(f"[CWK] Scheduler normalised: '{name}' → '{underscore}'")
        return underscore
    fuzzy = _fuzzy_match(name, available)
    if fuzzy:
        print(f"[CWK] Scheduler fuzzy match: '{name}' → '{fuzzy}'")
        return fuzzy
    fallback = "simple" if "simple" in available else available[0]
    print(f"[CWK] ⚠ Scheduler '{name}' not found — falling back to '{fallback}'")
    return fallback


def resolve_sampler_scheduler(
    sampler_name: str,
    scheduler: str,
    available_samplers: Optional[List[str]] = None,
    available_schedulers: Optional[List[str]] = None,
) -> Tuple[str, str]:
    if available_samplers is None:
        available_samplers = list(comfy.samplers.KSampler.SAMPLERS)
    if available_schedulers is None:
        available_schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
    normed_sampler = _normalise(sampler_name)
    scheduler_hint = None
    for sched_name in sorted(available_schedulers, key=len, reverse=True):
        sn_lower = sched_name.lower()
        if normed_sampler.endswith(" " + sn_lower):
            scheduler_hint = sched_name
            stripped = sampler_name[:-(len(sched_name))].strip()
            if stripped:
                test = _SAMPLER_ALIASES.get(_normalise(stripped))
                if test and test in available_samplers:
                    sampler_name = stripped
                elif _normalise(stripped).replace(" ", "_").replace("++", "_pp") in available_samplers:
                    sampler_name = stripped
            break
    resolved_sampler = resolve_sampler(sampler_name, available_samplers)
    if scheduler_hint and (not scheduler or scheduler in ("normal", "simple")):
        scheduler = scheduler_hint
    resolved_scheduler = resolve_scheduler(scheduler, available_schedulers)
    return resolved_sampler, resolved_scheduler


# ─── RNG application ──────────────────────────────────────────────────────────

def _apply_rng(model, rng: str):
    from . import cwk_rng_shared, cwk_rng
    model = model.clone()
    model.model_options = dict(model.model_options)
    opts = cwk_rng_shared.opts_default.clone()
    opts.randn_source = rng
    model.model_options[cwk_rng_shared.Options.KEY] = opts
    import comfy.sample
    if not hasattr(comfy.sample, '_cwk_original_prepare_noise'):
        comfy.sample._cwk_original_prepare_noise = comfy.sample.prepare_noise
    comfy.sample.prepare_noise = cwk_rng.prepare_noise
    print(f"[CWK] RNG set: randn_source={rng}")
    return model


# ─── Model Sampling type application ──────────────────────────────────────

def _apply_model_sampling(model, sampling_type: str):
    """Apply a model sampling type override (eps, v_prediction, lcm, x0, img_to_img).
    Uses ComfyUI's built-in ModelSamplingDiscrete / LCM / etc. from comfy_extras."""
    if sampling_type == "eps":
        print(f"[CWK] Model sampling: eps (default, no patch)")
        return model

    try:
        import comfy.model_sampling as ms
    except ImportError:
        print(f"[CWK] ⚠ comfy.model_sampling not available — skipping sampling override")
        return model

    model = model.clone()

    if sampling_type == "v_prediction":
        class VPredSampling(ms.ModelSamplingDiscrete, ms.V_PREDICTION):
            pass
        sampling = VPredSampling(model.model.model_config)
        model.add_object_patch("model_sampling", sampling)
        print(f"[CWK] Model sampling: v_prediction")

    elif sampling_type == "lcm":
        try:
            from comfy_extras.nodes_model_advanced import ModelSamplingDiscreteDistilled
            class LCMSampling(ModelSamplingDiscreteDistilled, ms.EPS):
                pass
            sampling = LCMSampling(model.model.model_config)
            model.add_object_patch("model_sampling", sampling)
            print(f"[CWK] Model sampling: lcm (distilled)")
        except ImportError:
            print(f"[CWK] ⚠ LCM sampling not available (ModelSamplingDiscreteDistilled not found)")

    elif sampling_type == "x0":
        class X0Sampling(ms.ModelSamplingDiscrete, ms.X0):
            pass
        sampling = X0Sampling(model.model.model_config)
        model.add_object_patch("model_sampling", sampling)
        print(f"[CWK] Model sampling: x0")

    elif sampling_type == "img_to_img":
        print(f"[CWK] Model sampling: img_to_img (eps-based, tag only)")

    else:
        print(f"[CWK] ⚠ Unknown sampling type '{sampling_type}' — using default")

    return model


# ─── External CLIP / VAE loaders ──────────────────────────────────────────────

def _load_external_clip(clip_name: str, clip_type_str: str = "stable_diffusion"):
    """Load an external CLIP model. Uses city96's CLIPLoaderGGUF for .gguf files,
    otherwise ComfyUI's built-in CLIPLoader."""
    import sys
    import types

    clip_path = None
    for folder_type in ("clip", "clip_gguf"):
        try:
            clip_path = folder_paths.get_full_path(folder_type, clip_name)
            if clip_path and os.path.exists(clip_path):
                break
            clip_path = None
        except Exception:
            pass
    if not clip_path:
        raise FileNotFoundError(f"[CWK] CLIP file not found: {clip_name}")

    if clip_name.lower().endswith(".gguf"):
        CLIPLoaderGGUF = None
        for mod_name, mod in list(sys.modules.items()):
            if mod is None or not isinstance(mod, types.ModuleType):
                continue
            if mod_name.startswith("torch") or mod_name.startswith("_"):
                continue
            try:
                cls = getattr(mod, "CLIPLoaderGGUF", None)
                if cls is not None and isinstance(cls, type) and hasattr(cls, "load_clip"):
                    CLIPLoaderGGUF = cls
                    break
            except Exception:
                continue

        if CLIPLoaderGGUF is None:
            raise RuntimeError(
                f"[CWK] Cannot load GGUF CLIP '{clip_name}' — "
                f"ComfyUI-GGUF (city96) is required. "
                f"Install it from: https://github.com/city96/ComfyUI-GGUF"
            )

        try:
            loader = CLIPLoaderGGUF()
            (clip,) = loader.load_clip(clip_name, type=clip_type_str)
            print(f"[CWK] GGUF CLIP loaded via ComfyUI-GGUF: {clip_name} (type={clip_type_str})")
            return clip
        except Exception as e:
            raise RuntimeError(
                f"[CWK] ComfyUI-GGUF found but failed to load CLIP '{clip_name}': {e}"
            ) from e

    from nodes import CLIPLoader
    loader = CLIPLoader()
    (clip,) = loader.load_clip(clip_name, type=clip_type_str)
    return clip


def _load_external_vae(vae_name: str):
    """Load an external VAE using ComfyUI's built-in VAELoader."""
    vae_path = folder_paths.get_full_path("vae", vae_name)
    if not vae_path:
        raise FileNotFoundError(f"[CWK] VAE file not found: {vae_name}")
    try:
        from nodes import VAELoader
        loader = VAELoader()
        (vae,) = loader.load_vae(vae_name)
        return vae
    except Exception as e:
        print(f"[CWK] VAELoader failed for '{vae_name}': {e}")
        import safetensors.torch
        if vae_path.endswith(".safetensors"):
            sd = safetensors.torch.load_file(vae_path)
        else:
            sd = comfy.utils.load_torch_file(vae_path)
        vae = comfy.sd.VAE(sd=sd)
        return vae
    

# ─── GGUF detection helper ─────────────────────────────────────────────────────

def _is_gguf(model_name: str) -> bool:
    """Check if a model name points to a .gguf file."""
    return model_name.lower().endswith(".gguf")


def _get_gguf_models() -> list:
    """Return list of .gguf model names from unet_gguf folder type (city96)
    and from checkpoints/diffusion_models (if .gguf was registered there)."""
    gguf_names = set()
    try:
        for name in folder_paths.get_filename_list("unet_gguf"):
            gguf_names.add(name)
    except Exception:
        pass
    for folder_type in ("checkpoints", "diffusion_models"):
        try:
            for name in folder_paths.get_filename_list(folder_type):
                if name.lower().endswith(".gguf"):
                    gguf_names.add(name)
        except Exception:
            pass
    return sorted(gguf_names)


def _resolve_gguf_path(model_name: str) -> str:
    """Find the absolute path for a .gguf model, checking all possible folder types."""
    for folder_type in ("unet_gguf", "diffusion_models", "checkpoints"):
        try:
            p = folder_paths.get_full_path(folder_type, model_name)
            if p and os.path.exists(p):
                return p
        except Exception:
            pass
    raise FileNotFoundError(f"[CWK] GGUF model file not found: {model_name}")


def _load_gguf_model(model_name: str):
    """Load a GGUF model. Requires city96/ComfyUI-GGUF.
    Dynamically discovers the module name by scanning sys.modules."""
    import sys
    import types

    UnetLoaderGGUF = None
    for mod_name, mod in list(sys.modules.items()):
        if mod is None or not isinstance(mod, types.ModuleType):
            continue
        if mod_name.startswith("torch") or mod_name.startswith("_"):
            continue
        try:
            cls = getattr(mod, "UnetLoaderGGUF", None)
            if cls is not None and isinstance(cls, type) and hasattr(cls, "load_unet"):
                UnetLoaderGGUF = cls
                print(f"[CWK] Found UnetLoaderGGUF in module: {mod_name}")
                break
        except Exception:
            continue

    if UnetLoaderGGUF is None:
        raise RuntimeError(
            f"[CWK] Cannot load GGUF model '{model_name}' — "
            f"ComfyUI-GGUF (city96) is required but could not be found. "
            f"Install it from: https://github.com/city96/ComfyUI-GGUF"
        )

    try:
        loader = UnetLoaderGGUF()
        (model,) = loader.load_unet(model_name)
        print(f"[CWK] GGUF model loaded via ComfyUI-GGUF: {model_name}")
        return model
    except Exception as e:
        raise RuntimeError(
            f"[CWK] ComfyUI-GGUF found but failed to load '{model_name}': {e}\n"
            f"Make sure the file is in your ComfyUI/models/unet or diffusion_models folder."
        ) from e


# ─── Node: CWK_ModelLoader ────────────────────────────────────────────────────

class CWK_ModelLoader:
    """
    CWK Model Loader — simplified model loader node.

    Always outputs a PIPE_LOADER. External CLIP / VAE dropdowns are only
    meaningful for diffusion / GGUF models (non-AIO); for checkpoints the
    embedded values are used unless explicitly overridden.
    """

    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = folder_paths.get_filename_list("checkpoints")
        try:
            diffusion = folder_paths.get_filename_list("diffusion_models")
        except Exception:
            diffusion = []
        gguf_models = _get_gguf_models()
        all_models  = sorted(set(checkpoints + diffusion + gguf_models))

        clip_list  = get_clip_list()
        vae_list   = get_vae_list()
        clip_types = _get_clip_types()

        return {
            "required": {
                "model_name":     (all_models if all_models else [""], {}),
            },
            "optional": {
                "clip_name": (clip_list,),
                "clip_type": (clip_types, {"default": _default_clip_type(clip_types)}),
                "vae_name":  (vae_list,),
            },
        }

    RETURN_TYPES  = ("PIPE_LOADER",)
    RETURN_NAMES  = ("pipe",)
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Loaders"
    OUTPUT_NODE   = False

    def execute(
        self,
        model_name:     str,
        clip_name:      str = "embedded",
        clip_type:      str = "stable_diffusion",
        vae_name:       str = "embedded",
    ) -> tuple:
        save_last_used_model(model_name)

        # ── Detect and load model ──────────────────────────────────────────────
        is_gguf       = _is_gguf(model_name)
        is_checkpoint = (not is_gguf
                         and folder_paths.get_full_path("checkpoints", model_name) is not None)
        is_diffusion  = (not is_checkpoint and not is_gguf
                         and folder_paths.get_full_path("diffusion_models", model_name) is not None)

        if is_gguf:
            model = _load_gguf_model(model_name)
            clip  = None
            vae   = None
        elif is_checkpoint:
            from nodes import CheckpointLoaderSimple
            loader           = CheckpointLoaderSimple()
            model, clip, vae = loader.load_checkpoint(model_name)
        elif is_diffusion:
            diff_path = folder_paths.get_full_path("diffusion_models", model_name)
            model     = comfy.sd.load_diffusion_model(diff_path)
            clip      = None
            vae       = None
        else:
            raise FileNotFoundError(f"[CWK] Model file not found: {model_name}")

        # ── External CLIP ──────────────────────────────────────────────────────
        if clip_name and clip_name != "embedded":
            try:
                clip = _load_external_clip(clip_name, clip_type)
                print(f"[CWK Loader] External CLIP: {clip_name} (type={clip_type})")
            except Exception as e:
                print(f"[CWK Loader] Warning: could not load CLIP '{clip_name}': {e}")

        # ── External VAE ───────────────────────────────────────────────────────
        if vae_name and vae_name != "embedded":
            try:
                vae = _load_external_vae(vae_name)
                print(f"[CWK Loader] External VAE: {vae_name}")
            except Exception as e:
                print(f"[CWK Loader] Warning: could not load VAE '{vae_name}': {e}")

        # ── Load stored preset (passed downstream) ─────────────────────────────
        presets = load_presets()
        preset  = {**default_preset(), **presets.get(model_name, {})}

        pipe = {
            "model":          model,
            "clip":           clip,
            "vae":            vae,
            "model_name":     model_name,
            "clip_name":      clip_name,
            "vae_name":       vae_name,
            "clip_type":      clip_type,
            "preset":         preset,
        }

        print(
            f"[CWK Loader] Loaded: {model_name} | "
            f"clip={clip_name} vae={vae_name}"
        )
        return (pipe,)


# ─── Node: CWK_ModelLoaderPipe ────────────────────────────────────────────────

class CWK_ModelLoaderPipe:
    """
    CWK Model Loader Pipe — companion pipeline node.

    Accepts a PIPE_LOADER + LATENT, applies clip_skip, resolves sampler/scheduler,
    and fans out all values. Optional model/clip inputs override what comes
    from the pipe.
    """

    @classmethod
    def INPUT_TYPES(cls):
        samplers   = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
        return {
            "required": {
                "pipe":         ("PIPE_LOADER",  {"forceInput": True}),
                "latent":       ("LATENT",       {"forceInput": True}),
                "sampler_name": (samplers,),
                "scheduler":    (schedulers,),
                "cfg":          ("FLOAT", {"default": 7.0,  "min": 0.0, "max": 30.0, "step": 0.1}),
                "steps":        ("INT",   {"default": 20,   "min": 1,   "max": 200,  "step": 1}),
                "clip_skip":    (CLIP_SKIP_OPTIONS, {"default": "-2"}),
            },
            "optional": {
                "model_override": ("MODEL", {}),
                "clip_name": (get_clip_list(),),
                "clip_type": (_get_clip_types(), {"default": _default_clip_type(_get_clip_types())}),
                "vae_name":  (get_vae_list(),),
                "rng":            (RNG_TYPES_WITH_DEFAULT,),
                "model_sampling": (MODEL_SAMPLING_TYPES_WITH_DEFAULT,),
            },
        }

    RETURN_TYPES  = (
        "PIPE_LOADER",
        "MODEL", "CLIP", "VAE",
        "LATENT",
        comfy.samplers.KSampler.SAMPLERS,
        comfy.samplers.KSampler.SCHEDULERS,
        "FLOAT", "INT", "INT",
        "STRING",
    )
    RETURN_NAMES  = (
        "pipe",
        "model", "clip", "vae",
        "latent",
        "sampler_name", "scheduler",
        "cfg", "steps", "clip_skip",
        "infos",
    )
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Loaders"
    OUTPUT_NODE   = False

    def execute(
        self,
        pipe:          dict,
        latent:        dict,
        sampler_name:  str,
        scheduler:     str,
        cfg:           float,
        steps:         int,
        clip_skip:     str,
        model_override = None,
        clip_name:      str = "embedded",
        clip_type:      str = "stable_diffusion",
        vae_name:       str = "embedded",
        rng:            str = "default",
        model_sampling: str = "default",
    ) -> tuple:
        # ── Override model from optional input ─────────────────────────────────
        model = model_override if model_override is not None else pipe.get("model")
        clip  = pipe.get("clip")
        vae   = pipe.get("vae")

        # ── Apply RNG & model sampling (centralized here for both pipe/override paths) ──
        # NOTE: this patches whatever model is resolved above, whether it came from
        # `pipe` or `model_override`. Feeding in a model that has already been
        # patched (e.g. re-using a previous CWK_ModelLoaderPipe output as
        # model_override) will apply the patch on top of the existing one; pass an
        # unpatched model (raw CheckpointLoaderSimple output) via model_override
        # for the documented "identical to plain checkpoint" behavior.
        if rng and rng != "default":
            model = _apply_rng(model, rng)
        if model_sampling and model_sampling != "default":
            model = _apply_model_sampling(model, model_sampling)

        # ── External CLIP ──────────────────────────────────────────────────────
        clip_overridden = bool(clip_name and clip_name != "embedded")
        if clip_overridden:
            try:
                clip = _load_external_clip(clip_name, clip_type)
                print(f"[CWK Pipe] External CLIP: {clip_name} (type={clip_type})")
            except Exception as e:
                print(f"[CWK Pipe] Warning: could not load CLIP '{clip_name}': {e}")

        # ── External VAE ────────────────────────────────────────────────────────
        vae_overridden = bool(vae_name and vae_name != "embedded")
        if vae_overridden:
            try:
                vae = _load_external_vae(vae_name)
                print(f"[CWK Pipe] External VAE: {vae_name}")
            except Exception as e:
                print(f"[CWK Pipe] Warning: could not load VAE '{vae_name}': {e}")

        # ── Apply clip_skip ────────────────────────────────────────────────────
        if clip_skip == "Disabled":
            clip_skip_applied = "Disabled"
            if clip is not None:
                print("[CWK Pipe] clip_skip: Disabled (clip passed through untouched)")
        else:
            # Old workflows/presets may hold clip_skip as an int — normalize to str
            clip_skip_applied = str(clip_skip)
            if clip is not None:
                try:
                    clip = clip.clone()
                    clip.clip_layer(int(clip_skip_applied))
                    pipe = {**pipe, "clip": clip}
                except Exception as e:
                    print(f"[CWK Pipe] Warning: could not apply clip_skip={clip_skip_applied}: {e}")

        # ── Resolve sampler / scheduler ────────────────────────────────────────
        sampler_name, scheduler = resolve_sampler_scheduler(sampler_name, scheduler)

        # ── Build infos JSON string (reflect what was actually applied) ────────
        applied_vae_name  = vae_name  if vae_overridden  else pipe.get("vae_name",  "embedded")
        applied_clip_name = clip_name if clip_overridden else pipe.get("clip_name", "embedded")
        applied_clip_type = clip_type if clip_overridden else pipe.get("clip_type", "stable_diffusion")
        infos = json.dumps({
            "model_name":     pipe.get("model_name",    ""),
            "vae_name":       applied_vae_name,
            "clip_name":      applied_clip_name,
            "clip_type":      applied_clip_type,
            "sampler_name":   sampler_name,
            "scheduler":      scheduler,
            "cfg":            cfg,
            "steps":          steps,
            "clip_skip":      clip_skip_applied,
            "rng":            rng,
            "model_sampling": model_sampling,
        })

        print(
            f"[CWK Pipe] model={pipe.get('model_name','?')} | "
            f"sampler={sampler_name} sched={scheduler} cfg={cfg} "
            f"steps={steps} clip_skip={clip_skip_applied} "
            f"rng={rng} model_sampling={model_sampling}"
        )
        return (pipe, model, clip, vae, latent, sampler_name, scheduler, cfg, steps, clip_skip_applied, infos)


# ─── Node: CWK_LatentImage ────────────────────────────────────────────────────

class CWK_LatentImage:
    """
    CWK Latent Image — resolution + batch selector that outputs an empty LATENT.

    Mirrors the Res Preset / Width / Height / Batch section from
    CWK_ModelPresetManager. The four widgets are hidden by the JS frontend
    and drawn as custom rows on the canvas, identical in style.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "resolution_preset": (RESOLUTION_PRESET_NAMES,),
                "width":      ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "height":     ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "batch_size": ("INT", {"default": 1,    "min": 1,  "max": 64,   "step": 1}),
            },
        }

    RETURN_TYPES  = ("LATENT", "INT", "INT")
    RETURN_NAMES  = ("latent", "width", "height")
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Utilities"
    OUTPUT_NODE   = False

    def execute(
        self,
        resolution_preset: str,
        width:      int,
        height:     int,
        batch_size: int,
    ) -> tuple:
        # Apply resolution preset if one is chosen
        if resolution_preset and resolution_preset != "(preset)":
            res = RESOLUTION_PRESETS.get(resolution_preset)
            if res and res[0] > 0 and res[1] > 0:
                width, height = res

        width  = max(64, int(width))
        height = max(64, int(height))
        batch  = max(1, int(batch_size))

        latent = torch.zeros(
            [batch, 4, height // 8, width // 8],
            device="cpu", dtype=torch.float32,
        )

        print(f"[CWK LatentImage] {width}×{height} batch={batch} preset={resolution_preset!r}")
        return ({"samples": latent}, width, height)


# ─── Node: CWKBatchSelector ───────────────────────────────────────────────────

class CWKBatchSelector:
    """
    CWK Batch Selector — Receives a batch of images, pauses execution for user selection,
    then outputs only the selected images. If batch == 1, passes through automatically.
    """

    RETURN_TYPES = ("IMAGE", "LATENT", "STRING")
    RETURN_NAMES = ("images", "latents", "indexes")
    FUNCTION     = "execute"
    CATEGORY     = "CWK/Utilities"
    OUTPUT_NODE  = False
    DESCRIPTION  = "Pauses to let you pick which image(s) of a batch to keep. Batch=1 passes through."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                "latents":  ("LATENT",  {"tooltip": "Optional latents to pass through"}),
                "graph_id": ("STRING",  {"default": ""}),
            },
            "hidden": {
                "prompt":        "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "uid":           "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-run so the selector pauses every queue.
        return float("NaN")

    def execute(self, images, uid, graph_id="", latents=None,
                prompt=None, extra_pnginfo=None, **_ignored):
        from .cwk_batch_messaging import send_images_and_wait, RegenerateResponse
        from comfy.model_management import InterruptProcessingException

        B = images.shape[0]

        # Pass-through for single image
        if B == 1:
            out_latents = {"samples": latents["samples"]} if latents is not None else None
            return (images, out_latents, "0")

        # Save preview thumbnails using PreviewImage's machinery
        from nodes import PreviewImage
        preview_node = PreviewImage()
        saved = preview_node.save_images(
            images=images,
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
        )
        urls = saved["ui"]["images"]

        # Block until the user clicks Send / Cancel / Re-Generate
        response = send_images_and_wait(
            payload={"urls": urls, "batch_size": B},
            uid=str(uid),
            graph_id=str(graph_id) if graph_id else str(uid),
        )

        if isinstance(response, RegenerateResponse):
            # The frontend will re-queue the prompt after we abort this run.
            raise InterruptProcessingException()

        # CancelledResponse is already converted to InterruptProcessingException
        # inside send_images_and_wait().

        indices = response.selection or []
        if not indices:
            # Treat empty selection as cancel rather than producing an empty tensor.
            raise InterruptProcessingException()

        out_images = torch.stack([images[i] for i in indices])
        out_latents = None
        if latents is not None:
            out_latents = {
                "samples": torch.stack([latents["samples"][i] for i in indices])
            }
        return (out_images, out_latents, ",".join(str(i) for i in indices))


# ─── Node: CWK_LivePreview ────────────────────────────────────────────────────

class CWKLivePreview:
    """
    CWK Live Preview — Displays live image updates during generation.
    
    Receives image data via the 'cwk_live_preview' WebSocket event and
    displays it in real-time on the canvas. No inputs/outputs; works as
    a passive display node.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {},
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "execute"
    CATEGORY = "CWK/Utilities"
    OUTPUT_NODE = True
    DESCRIPTION = "Displays live image preview during generation. Add to your workflow to see real-time updates."

    def execute(self) -> tuple:
        """No-op execute; all work is done via WebSocket events."""
        return ()


# ─── Node mappings ────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "CWK_ModelLoader":        CWK_ModelLoader,
    "CWK_ModelLoaderPipe":    CWK_ModelLoaderPipe,
    "CWK_LatentImage":        CWK_LatentImage,
    "CWKBatchSelector":       CWKBatchSelector,
    "CWKLivePreview":        CWKLivePreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CWK_ModelLoader":        "CWK Model Loader",
    "CWK_ModelLoaderPipe":    "CWK Model Loader Pipe",
    "CWK_LatentImage":        "CWK Latent Image",
    "CWKBatchSelector":       "CWK Batch Selector",
    "CWKLivePreview":        "CWK Live Preview",
}

from .cwk_prompt_composer import (
    NODE_CLASS_MAPPINGS_PROMPT_COMPOSER,
    NODE_DISPLAY_NAME_MAPPINGS_PROMPT_COMPOSER,
)

# Merge with existing mappings
NODE_CLASS_MAPPINGS.update(NODE_CLASS_MAPPINGS_PROMPT_COMPOSER)
NODE_DISPLAY_NAME_MAPPINGS.update(NODE_DISPLAY_NAME_MAPPINGS_PROMPT_COMPOSER)

from .cwk_wan22 import (
    NODE_CLASS_MAPPINGS_WAN22,
    NODE_DISPLAY_NAME_MAPPINGS_WAN22,
)

# Merge Wan22 nodes with existing mappings
NODE_CLASS_MAPPINGS.update(NODE_CLASS_MAPPINGS_WAN22)
NODE_DISPLAY_NAME_MAPPINGS.update(NODE_DISPLAY_NAME_MAPPINGS_WAN22)