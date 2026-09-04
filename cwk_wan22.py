"""
CWK Wan2.2 Nodes — ComfyUI node definitions.

Nodes:
  - CWK_Wan22PromptComposer
  - CWK_Wan22PipelineSplitter
  - CWK_Wan22LoraApplier
  - CWK_Wan22LoopOpen
  - CWK_Wan22LoopClose
  - CWKWanImagePrep
"""

import json
import os

import numpy as np
import torch
from PIL import Image

import folder_paths


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _to_lora_stack(loras: list) -> list:
    """Convert internal lora dict list → LORA_STACK tuples."""
    stack = []
    for lora in loras:
        name = str(lora.get("name", "")).strip()
        if not name:
            continue
        weight      = float(lora.get("weight", 1.0))
        clip_weight = float(lora.get("clip_weight", weight))
        stack.append((name, weight, clip_weight))
    return stack


def _blend_overlap(source_images, new_images, overlap: int = 5,
                   overlap_mode: str = "blend_linear",
                   overlap_side: str = "start"):
    """
    Blend overlap between source tail and new head, then concatenate.

    overlap_mode:
      "blend_linear" — linear cross-fade (default)
      "blend_sqrt"   — sqrt-weighted cross-fade (softer)
      "replace"      — no blending; hard cut

    overlap_side:
      "start" — blend the START of new_images with the END of source (continuation)
      "end"   — blend the END   of new_images with the START of source (loop)
    """
    if source_images is None:
        return new_images

    ov = min(overlap, source_images.shape[0], new_images.shape[0])
    if ov <= 0 or overlap_mode == "replace":
        return torch.cat([source_images, new_images], dim=0)

    t = torch.linspace(0.0, 1.0, ov,
                       device=new_images.device,
                       dtype=new_images.dtype)
    if overlap_mode == "blend_sqrt":
        t = t.sqrt()
    weights = t.view(-1, 1, 1, 1)   # new weight  (0→1)

    if overlap_side == "start":
        src_tail = source_images[-ov:]
        new_head = new_images[:ov]
        blended  = src_tail * (1.0 - weights) + new_head * weights
        return torch.cat([source_images[:-ov], blended, new_images[ov:]], dim=0)
    else:
        new_tail = new_images[-ov:]
        src_head = source_images[:ov]
        blended  = new_tail * (1.0 - weights) + src_head * weights
        return torch.cat([source_images[ov:], blended, new_images[:-ov]], dim=0)


def _pipeline_fingerprint(pipeline: list) -> str:
    """Cheap fingerprint to detect pipeline changes between re-queues."""
    if not pipeline:
        return ""
    return f"{len(pipeline)}:{pipeline[0].get('prompt', '')[:40]}"


# ─── 1. Composer ──────────────────────────────────────────────────────────────

class CWK_Wan22PromptComposer:
    """
    Wan 2.2 multi-clip prompt composer with per-block seed generation.
    The UI is handled by the JavaScript frontend.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "frame_rate": (
                    "FLOAT",
                    {"default": 16.0, "min": 1.0, "max": 120.0, "step": 0.5,
                     "forceInput": True},
                ),
                "pipeline_data": (
                    "STRING",
                    {"default": "[]", "multiline": False},
                ),
            }
        }

    RETURN_TYPES  = ("WAN22_PIPELINE",)
    RETURN_NAMES  = ("pipeline",)
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Wan2.2"
    OUTPUT_NODE   = False

    def execute(self, frame_rate: float, pipeline_data: str):
        try:
            blocks = json.loads(pipeline_data)
        except (json.JSONDecodeError, TypeError):
            print("[CWK Wan22] Warning: could not parse pipeline_data — using empty pipeline")
            blocks = []

        blocks = [b for b in blocks if not b.get("disabled", False)]

        pipeline = []

        for i, block in enumerate(blocks):
            duration    = float(block.get("duration", 1.0))
            frame_count = int(round(duration * frame_rate)) + 1
            block_seed  = int(block.get("seed", 0))

            def _clean(lora_list):
                out = []
                for lora in (lora_list or []):
                    name = str(lora.get("name", "")).strip()
                    if not name:
                        continue
                    weight      = float(lora.get("weight", 1.0))
                    clip_weight = float(lora.get("clip_weight", weight))
                    out.append({"name": name, "weight": weight,
                                "clip_weight": clip_weight})
                return out

            loras_high = _clean(block.get("loras_high", block.get("loras", [])))
            loras_low  = _clean(block.get("loras_low",  []))

            pipeline.append({
                "clip_index":  i + 1,
                "prompt":      str(block.get("prompt", "")),
                "duration":    duration,
                "frame_count": frame_count,
                "seed":        block_seed,
                "loras_high":  loras_high,
                "loras_low":   loras_low,
            })

            print(
                f"[CWK Wan22] Clip {i+1}: "
                f"duration={duration:.1f}s  frames={frame_count}  seed={block_seed}  "
                f"loras_high={len(loras_high)}  loras_low={len(loras_low)}"
            )

        return (pipeline,)


# ─── 2. Splitter ──────────────────────────────────────────────────────────────

class CWK_Wan22PipelineSplitter:
    """
    Wan 2.2 pipeline splitter — one per KSampler section.
    Useful for static (non-loop) multi-clip graphs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipeline":   ("WAN22_PIPELINE",),
                "clip_index": ("INT", {"default": 1, "min": 1,
                                       "max": 64, "step": 1}),
            }
        }

    RETURN_TYPES  = ("STRING", "INT", "LORA_STACK", "LORA_STACK", "INT")
    RETURN_NAMES  = ("prompt", "frame_count",
                     "lora_stack_high", "lora_stack_low", "seed")
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Wan2.2"
    OUTPUT_NODE   = False

    def execute(self, pipeline, clip_index: int):
        if not pipeline:
            print("[CWK Wan22 Splitter] Pipeline is empty.")
            return ("", 1, [], [], 0)

        idx = clip_index - 1
        if idx < 0 or idx >= len(pipeline):
            print(
                f"[CWK Wan22 Splitter] clip_index={clip_index} out of range "
                f"(pipeline has {len(pipeline)} clip(s)) — returning empty outputs."
            )
            return ("", 1, [], [], 0)

        block = pipeline[idx]
        lora_stack_high = _to_lora_stack(block.get("loras_high", []))
        lora_stack_low  = _to_lora_stack(block.get("loras_low",  []))
        seed            = block.get("seed", 0)

        print(
            f"[CWK Wan22 Splitter] Clip {clip_index}: "
            f"frames={block['frame_count']}  seed={seed}  "
            f"loras_high={len(lora_stack_high)}  "
            f"loras_low={len(lora_stack_low)}"
        )

        return (block["prompt"], block["frame_count"],
                lora_stack_high, lora_stack_low, seed)


# ─── 3. LoRA Applier ──────────────────────────────────────────────────────────

class CWK_Wan22LoraApplier:
    """
    Applies a LORA_STACK to a model+clip pair through ComfyUI's standard
    LoraLoader, one LoRA at a time. Safe to use inside a looping graph
    because it goes through the proper ComfyUI loader rather than
    manual cloning.

    Connect lora_stack_high → this node (model_high, clip) to get the
    patched high-noise model and the CLIP for prompt encoding.
    Connect lora_stack_low  → this node (model_low,  clip) to get the
    patched low-noise model (CLIP output can be left unconnected).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model":      ("MODEL",),
                "clip":       ("CLIP",),
                "lora_stack": ("LORA_STACK",),
            }
        }

    RETURN_TYPES  = ("MODEL", "CLIP")
    RETURN_NAMES  = ("model", "clip")
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Wan2.2"
    OUTPUT_NODE   = False

    def execute(self, model, clip, lora_stack):
        if not lora_stack:
            return (model, clip)

        from nodes import LoraLoader
        m, c = model, clip
        for (name, model_weight, clip_weight) in lora_stack:
            if not name:
                continue
            print(f"[CWK LoraApplier] Applying '{name}'  mw={model_weight}  cw={clip_weight}")
            m, c = LoraLoader().load_lora(m, c, name, model_weight, clip_weight)
        return (m, c)


# ─── 4. Loop Open ─────────────────────────────────────────────────────────────

class CWK_Wan22LoopOpen:
    """
    Loop entry point. Manages per-clip iteration state.
    Uses per-clip seeds from the pipeline instead of deriving from base seed.
    force_reset is a ONE-SHOT trigger: the session resets on the FIRST
    execution where it is True, then it is ignored on re-queues
    (re-queues never arrive with force_reset=True from the graph).
    """

    _session = None

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pipeline":     ("WAN22_PIPELINE",),
                "start_image":  ("IMAGE",),
                "overlap":      ("INT",   {"default": 5,
                                           "min": 0, "max": 32}),
                "overlap_mode": (["blend_linear", "blend_sqrt", "replace"],
                                 {"default": "blend_linear"}),
                "overlap_side": (["start", "end"],
                                 {"default": "start"}),
                # Keep this FALSE in normal use. Setting it TRUE resets the
                # session on the next run and immediately flips back to False
                # so re-queues never accidentally restart.
                "force_reset":  ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES  = (
        "IMAGE", "LATENT",
        "STRING", "INT",
        "LORA_STACK", "LORA_STACK",
        "INT",
        "WAN22_LOOP_STATE",
    )
    RETURN_NAMES  = (
        "current_image", "prev_latent",
        "prompt", "frame_count",
        "lora_stack_high", "lora_stack_low",
        "clip_seed",
        "loop_state",
    )
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Wan2.2"
    OUTPUT_NODE   = False

    def execute(self, pipeline, start_image,
                overlap, overlap_mode, overlap_side, force_reset):

        if not pipeline:
            raise ValueError(
                "[CWK LoopOpen] Pipeline is empty — connect a Prompt Composer."
            )

        s  = CWK_Wan22LoopOpen._session
        fp = _pipeline_fingerprint(pipeline)

        # ── Detect stale / changed session ────────────────────────────────
        if s is not None:
            stale = (
                force_reset
                or s.get("fingerprint") != fp
                or s["clip_index"] >= len(s["pipeline"])
            )
            if stale:
                reason = (
                    "force_reset"         if force_reset else
                    "pipeline changed"    if s.get("fingerprint") != fp else
                    "clip_index overflow"
                )
                print(f"[CWK LoopOpen] Resetting session ({reason}).")
                s = None
                CWK_Wan22LoopOpen._session = None

        # ── Initialise on first iteration ─────────────────────────────────
        if s is None:
            s = {
                "fingerprint":   fp,
                "pipeline":      pipeline,
                "clip_index":    0,
                "accumulated":   None,
                "current_image": start_image,
                "prev_latent":   None,
                "overlap":       overlap,
                "overlap_mode":  overlap_mode,
                "overlap_side":  overlap_side,
            }
            CWK_Wan22LoopOpen._session = s
            print(
                f"[CWK LoopOpen] Starting new loop — "
                f"{len(pipeline)} clip(s)."
            )

        # ── Emit current clip data ─────────────────────────────────────────
        idx       = s["clip_index"]
        clip_data = s["pipeline"][idx]
        clip_seed = clip_data.get("seed", 0)

        loras_high = _to_lora_stack(clip_data.get("loras_high", []))
        loras_low  = _to_lora_stack(clip_data.get("loras_low",  []))

        print(
            f"[CWK LoopOpen] ── Clip {idx + 1}/{len(pipeline)}  "
            f"seed={clip_seed}  frames={clip_data['frame_count']}  "
            f"prompt={clip_data['prompt'][:60]!r}"
        )

        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "cwk_wan22_clip_active", {"clip_index": idx}
            )
        except Exception as e:
            print(f"[CWK LoopOpen] WARNING: could not send clip_active signal: {e}")

        return (
            s["current_image"],
            s["prev_latent"],
            clip_data["prompt"],
            clip_data["frame_count"],
            loras_high,
            loras_low,
            clip_seed,
            s,
        )


# ─── 5. Loop Close ────────────────────────────────────────────────────────────

class CWK_Wan22LoopClose:
    """
    Loop exit / accumulator. Blends frames internally via _blend_overlap,
    then re-queues if more clips remain or returns the final result.

    final_only — when True (default), intermediate iterations output a single
    black placeholder frame so the video-combine node stays idle until the
    full accumulation is ready.  When False, the partial accumulation is
    output after every clip (useful to preview individual clips as they finish).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loop_state": ("WAN22_LOOP_STATE",),
                "new_images": ("IMAGE",),
                "new_latent": ("LATENT",),
                # True  → video combiner encodes once, after all clips done.
                # False → video combiner encodes after every clip (per-clip preview).
                "final_only": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES  = ("IMAGE", "LATENT")
    RETURN_NAMES  = ("images", "final_latent")
    FUNCTION      = "execute"
    CATEGORY      = "CWK/Wan2.2"
    OUTPUT_NODE   = True

    def execute(self, loop_state, new_images, new_latent, final_only=True):
        s = loop_state

        if s is None:
            print("[CWK LoopClose] WARNING: received null loop_state.")
            return (new_images, new_latent)

        # ── Blend new frames into accumulator ─────────────────────────────
        s["accumulated"] = _blend_overlap(
            s["accumulated"], new_images,
            overlap      = s["overlap"],
            overlap_mode = s["overlap_mode"],
            overlap_side = s["overlap_side"],
        )

        # ── Advance state ─────────────────────────────────────────────────
        s["clip_index"]   += 1
        s["current_image"] = new_images[-1:].clone()
        s["prev_latent"]   = new_latent

        total = len(s["pipeline"])
        done  = s["clip_index"] >= total

        print(
            f"[CWK LoopClose] Clip {s['clip_index']}/{total} done — "
            f"accumulated frames: {s['accumulated'].shape[0]}"
        )

        if done:
            final_images = s["accumulated"]
            CWK_Wan22LoopOpen._session = None
            print("[CWK LoopClose] ✓ Loop complete.")
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(
                    "cwk_wan22_clip_active", {"clip_index": -1}
                )
            except Exception as e:
                print(f"[CWK LoopClose] WARNING: could not send clip_done signal: {e}")
            return (final_images, new_latent)

        # ── More clips remain — trigger re-queue ──────────────────────────
        print(
            f"[CWK LoopClose] Re-queuing for clip "
            f"{s['clip_index'] + 1}/{total}…"
        )
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("cwk_wan22_loop_continue", {})
        except Exception as e:
            print(f"[CWK LoopClose] WARNING: could not send re-queue signal: {e}")

        if final_only:
            placeholder = torch.zeros(
                1,
                new_images.shape[1],
                new_images.shape[2],
                new_images.shape[3],
                dtype=new_images.dtype,
                device=new_images.device,
            )
            return (placeholder, new_latent)

        return (s["accumulated"], new_latent)


# ─── 6. Wan2.2 Image Prep ─────────────────────────────────────────────────────

class CWKWanImagePrep:
    """
    Prepares images for WAN 2.2 I2V generation with crop, resize, and parameter output.
    Provides interactive cropping in the UI with fixed aspect ratio maintenance.
    """

    SCHEDULERS = ["simple", "sgm_uniform", "karras", "exponential", "ddim_uniform",
                  "beta", "normal", "linear_quadratic", "kl_optimal"]

    SAMPLERS = ["euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp",
                "heun", "heunpp2", "exp_heun_2_x0", "exp_heun_2_x0_sde",
                "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive",
                "dpmpp_2s_ancestral", "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu",
                "dpmpp_2m", "dpmpp_2m_cfg_pp", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu",
                "dpmpp_2m_sde_heun", "dpmpp_2m_sde_heun_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu",
                "ddpm", "lcm", "ipndm", "ipndm_v", "deis", "res_multistep", "res_multistep_cfg_pp",
                "res_multistep_ancestral", "res_multistep_ancestral_cfg_pp", "gradient_estimation",
                "gradient_estimation_cfg_pp", "er_sde", "seeds_2", "seeds_3", "sa_solver",
                "sa_solver_pece", "ddim", "uni_pc", "uni_pc_bh2"]

    RETURN_TYPES  = ("IMAGE", "INT", "INT", "FLOAT", SCHEDULERS, SAMPLERS, "INT", "INT", "FLOAT")
    RETURN_NAMES  = ("image", "width", "height", "frame_rate", "scheduler",
                     "sampler_name", "total_steps", "split_steps", "cfg_scale")
    FUNCTION      = "prepare"
    CATEGORY      = "CWK/Wan2.2"
    OUTPUT_NODE   = False
    DESCRIPTION   = "Prepare image for WAN 2.2 I2V with interactive crop, resize, and generation parameters"

    @classmethod
    def INPUT_TYPES(cls):
        upscale_methods = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
        return {
            "required": {
                "resolution_preset": (
                    ["16:9 (832x480)", "16:9 (1280x720)",
                     "9:16 (480x832)", "9:16 (720x1280)",
                     "1:1 (1024x1024)"],
                ),
                "crop_x":      ("INT",   {"default": 0,    "min": 0,   "max": 65536}),
                "crop_y":      ("INT",   {"default": 0,    "min": 0,   "max": 65536}),
                "crop_width":  ("INT",   {"default": 512,  "min": 1,   "max": 65536}),
                "crop_height": ("INT",   {"default": 512,  "min": 1,   "max": 65536}),
                "upscale_method":  (upscale_methods,),
                "frame_rate":  ("FLOAT", {"default": 8.0,  "min": 1.0, "max": 60.0,  "step": 0.1}),
                "total_steps": ("INT",   {"default": 50,   "min": 1,   "max": 1000,  "step": 1}),
                "split_steps": ("INT",   {"default": 25,   "min": 1,   "max": 1000,  "step": 1}),
                "cfg_scale":   ("FLOAT", {"default": 7.5,  "min": 0.0, "max": 30.0,  "step": 0.1}),
                "scheduler":   (cls.SCHEDULERS,),
                "sampler":     (cls.SAMPLERS,),
                "image_filename": ("STRING", {"default": ""}),
            },
            "optional": {
                "image": ("IMAGE",),
            },
            "hidden": {
                "uid":           "UNIQUE_ID",
                "prompt":        "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def _parse_resolution_preset(self, preset: str):
        presets = {
            "16:9 (832x480)":  (832,  480),
            "16:9 (1280x720)": (1280, 720),
            "9:16 (480x832)":  (480,  832),
            "9:16 (720x1280)": (720,  1280),
            "1:1 (1024x1024)": (1024, 1024),
        }
        return presets.get(preset, (512, 512))

    def prepare(
        self,
        resolution_preset,
        crop_x, crop_y, crop_width, crop_height,
        upscale_method,
        frame_rate, total_steps, split_steps, cfg_scale,
        scheduler, sampler,
        image_filename="",
        image=None,
        uid=None, prompt=None, extra_pnginfo=None,
        **kwargs
    ):
        target_w, target_h = self._parse_resolution_preset(resolution_preset)

        # Priority: JS-uploaded file > connected IMAGE input > black placeholder
        if image_filename:
            try:
                filepath = folder_paths.get_annotated_filepath(image_filename)
                if not os.path.exists(filepath):
                    filepath = os.path.join(folder_paths.get_input_directory(), image_filename)
                if os.path.exists(filepath):
                    img_pil_loaded = Image.open(filepath).convert("RGB")
                    img_np_loaded  = np.array(img_pil_loaded).astype(np.float32) / 255.0
                    image = torch.from_numpy(img_np_loaded).unsqueeze(0)
            except Exception as e:
                print(f"[CWK] Could not load uploaded image '{image_filename}': {e}")

        if image is None:
            black = torch.zeros((1, target_h, target_w, 3), dtype=torch.float32)
            return (black, int(target_w), int(target_h), float(frame_rate),
                    scheduler, sampler, int(total_steps), int(split_steps), float(cfg_scale))

        # Convert first image in batch to PIL
        img_np = image[0].cpu().numpy()
        if img_np.dtype in (np.float32, np.float64):
            img_np = (img_np * 255).astype(np.uint8)
        else:
            img_np = img_np.astype(np.uint8)

        if len(img_np.shape) == 2:
            img_np = np.stack([img_np] * 3, axis=-1)
        elif img_np.shape[2] == 4:
            img_np = np.array(Image.fromarray(img_np, mode="RGBA").convert("RGB"))
        elif img_np.shape[2] != 3:
            img_np = img_np[:, :, :3]

        img_pil = Image.fromarray(img_np, mode="RGB")

        # Sanitize crop parameters
        crop_x      = max(0, min(crop_x,      img_pil.width  - 1))
        crop_y      = max(0, min(crop_y,      img_pil.height - 1))
        crop_width  = max(1, min(crop_width,  img_pil.width  - crop_x))
        crop_height = max(1, min(crop_height, img_pil.height - crop_y))

        img_cropped = img_pil.crop((crop_x, crop_y, crop_x + crop_width, crop_y + crop_height))

        # Proportional scale to fit target, then center-crop to exact size
        crop_aspect   = crop_width  / crop_height
        target_aspect = target_w    / target_h
        if crop_aspect > target_aspect:
            new_w = int(target_h * crop_aspect)
            new_h = target_h
        else:
            new_w = target_w
            new_h = int(target_w / crop_aspect)

        resample_map = {
            "lanczos":      Image.LANCZOS,
            "bicubic":      Image.BICUBIC,
            "bilinear":     Image.BILINEAR,
            "nearest-exact": Image.NEAREST,
            "area":         Image.NEAREST,
        }
        resample = resample_map.get(upscale_method, Image.NEAREST)
        img_scaled = img_cropped.resize((new_w, new_h), resample=resample)

        left = (img_scaled.width  - target_w) // 2
        top  = (img_scaled.height - target_h) // 2
        img_final = img_scaled.crop((left, top, left + target_w, top + target_h))

        img_out_np = np.array(img_final).astype(np.float32) / 255.0
        if len(img_out_np.shape) == 2:
            img_out_np = np.stack([img_out_np] * 3, axis=-1)
        img_out = torch.from_numpy(img_out_np).unsqueeze(0)

        return (img_out, int(target_w), int(target_h), float(frame_rate),
                scheduler, sampler, int(total_steps), int(split_steps), float(cfg_scale))


# ─── Registration ─────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS_WAN22 = {
    "CWK_Wan22PromptComposer":   CWK_Wan22PromptComposer,
    "CWK_Wan22PipelineSplitter": CWK_Wan22PipelineSplitter,
    "CWK_Wan22LoraApplier":      CWK_Wan22LoraApplier,
    "CWK_Wan22LoopOpen":         CWK_Wan22LoopOpen,
    "CWK_Wan22LoopClose":        CWK_Wan22LoopClose,
    "CWK Wan2.2 Image Prep":     CWKWanImagePrep,
}

NODE_DISPLAY_NAME_MAPPINGS_WAN22 = {
    "CWK_Wan22PromptComposer":   "CWK Wan2.2 Prompt Composer",
    "CWK_Wan22PipelineSplitter": "CWK Wan2.2 Pipeline Splitter",
    "CWK_Wan22LoraApplier":      "CWK Wan2.2 LoRA Applier",
    "CWK_Wan22LoopOpen":         "CWK Wan2.2 Loop Open",
    "CWK_Wan22LoopClose":        "CWK Wan2.2 Loop Close",
    "CWK Wan2.2 Image Prep":     "CWK Wan2.2 Image Prep",
}
