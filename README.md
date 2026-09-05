# CWK Custom Nodes Collection

A collection of ComfyUI custom nodes for model loading, preset management, prompt composition, and latent image generation — including a dedicated toolset for Wan2.2 video workflows.

## Installation

1. Navigate to your ComfyUI custom nodes folder:
   ```bash
   cd ComfyUI/custom_nodes
   ```
2. Clone this repository:
   ```bash
   git clone https://github.com/cowneko/CWK_CustomNodes_Collection.git
   ```
3. Restart ComfyUI. The nodes will appear under the `CWK` category in the node menu.

> Some Loader nodes support `.gguf` models and require [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) (city96) to be installed for GGUF checkpoint/CLIP loading.

To update:
```bash
cd ComfyUI/custom_nodes/CWK_CustomNodes_Collection
git pull
```

## Table of Contents

- [Loaders](#loaders)
  - [CWK Model Browser](#cwk-model-browser)
  - [CWK Model Loader](#cwk-model-loader)
  - [CWK Model Loader Pipe](#cwk-model-loader-pipe)
- [Utilities](#utilities)
  - [CWK Latent Image](#cwk-latent-image)
  - [CWK Batch Selector](#cwk-batch-selector)
  - [CWK Live Preview](#cwk-live-preview)
- [Prompting](#prompting)
  - [CWK Prompt Composer](#cwk-prompt-composer)
- [Wan2.2 Nodes](#wan22-nodes)
  - [CWK Wan2.2 Prompt Composer](#cwk-wan22-prompt-composer)
  - [CWK Wan2.2 Pipeline Splitter](#cwk-wan22-pipeline-splitter)
  - [CWK Wan2.2 LoRA Applier](#cwk-wan22-lora-applier)
  - [CWK Wan2.2 Loop Open](#cwk-wan22-loop-open)
  - [CWK Wan2.2 Loop Close](#cwk-wan22-loop-close)
  - [CWK Wan2.2 Image Prep](#cwk-wan22-image-prep)

---

## Loaders
*(Category: `CWK/Loaders`)*

### CWK Model Browser
*(Not a graph node — a frontend panel backed by REST/SSE routes in `server.py`)*

A visual model browser/manager integrated into the ComfyUI UI (via the `web/` frontend) for organizing and enriching your checkpoint/diffusion/GGUF model library, with built-in CivitAI integration.

- **Model listing** — `GET /cwk/models` lists all checkpoints, diffusion models, and `.gguf` files, along with file size, path, saved preset, and cached CivitAI metadata.
- **CivitAI metadata & thumbnails** — hashes each model file (SHA-256, cached in `hash_cache.json`) and looks it up against CivitAI's `model-versions/by-hash` API to fetch its name, base model, tags, NSFW level, and preview images.
  - `POST /cwk/civitai/fetch/stream` / `POST /cwk/civitai/refresh/all` — bulk fetch via Server-Sent Events, with progress streaming.
  - `POST /cwk/civitai/refresh` — refresh a single model's metadata.
  - `GET /cwk/civitai/images`, `GET /cwk/civitai/meta`, `GET /cwk/civitai/model-description` — fetch cached images, raw metadata, and the full CivitAI model description.
  - `POST /cwk/civitai/meta/edit` — manually override fields (`civitai_name`, `version_name`, `base_model`) that survive future CivitAI refreshes.
- **Thumbnails** — `POST /cwk/civitai/thumbnail/set` (from a CivitAI image URL) or `POST /cwk/civitai/thumbnail/local` (manual upload), served from `local_thumbnails/`.
- **Auto-populated presets** — when CivitAI example images include generation metadata (sampler, scheduler, CFG, steps, clip skip, resolution), it's automatically extracted and saved as that model's preset (via the same sampler/scheduler fuzzy-resolution system used by CWK Model Loader Pipe).
- **Version management** — `GET /cwk/civitai/versions` lists all CivitAI versions of a model and flags which are already installed; `POST /cwk/civitai/download` downloads a chosen version with SSE progress, then auto-fetches its metadata and preset once complete.
- **Update checking** — `POST /cwk/civitai/check-updates` compares installed versions against CivitAI to flag models with newer versions available.
- **Favorites & cleanup** — `POST /cwk/model/favorite` to star models; `DELETE /cwk/model` to delete a model file plus its cached metadata and preset; `DELETE /cwk/civitai/cache` to clear all cached metadata.
- **Last-used model** — `GET/POST /cwk/last_model` persists and restores the last model used in `CWK Model Loader` across sessions.
- **Supporting lookups** — `GET /cwk/clips`, `GET /cwk/vaes`, `GET /cwk/sampler_scheduler_list`, `GET /cwk/resolution_presets` feed the browser's and loader nodes' dropdown options.

> Requires a CivitAI API key (entered in the browser panel) for hash lookups, version listing, downloads, and update checks.

### CWK Model Loader
**Class:** `CWK_ModelLoader`

Simplified model loader that auto-detects checkpoint, diffusion-model (UNet), and GGUF formats from a single dropdown.

- **Inputs:**
  - `model_name` (required) — combined list of checkpoints, diffusion models, and `.gguf` models.
  - `clip_name` (optional) — external CLIP override (`embedded` by default). Supports `.gguf` CLIP via ComfyUI-GGUF.
  - `clip_type` (optional) — CLIP type (`stable_diffusion`, `flux`, `wan`, etc., dynamically read from `comfy.sd.CLIPType`).
  - `vae_name` (optional) — external VAE override (`embedded` by default).
- **Outputs:** `pipe` (`PIPE_LOADER`) — bundles model/clip/vae plus stored per-model preset data.
- **Notes:**
  - Persists the last-used model to `last_used_model.json`.
  - Loads a matching preset from `checkpoint_presets.json` if one exists for the selected model.
  - Automatically registers `.gguf` as a valid checkpoint/diffusion-model extension.

### CWK Model Loader Pipe
**Class:** `CWK_ModelLoaderPipe`

Companion pipeline node that expands a `PIPE_LOADER` into individual outputs, applying sampling/CLIP settings in one place.

- **Inputs:**
  - `pipe` (`PIPE_LOADER`, required) — from CWK Model Loader.
  - `latent` (`LATENT`, required) — passthrough.
  - `sampler_name`, `scheduler`, `cfg`, `steps`, `clip_skip` (required).
  - `model_override` (`MODEL`, optional) — bypasses the model from `pipe`.
  - `clip_name`, `clip_type`, `vae_name` (optional) — external overrides.
  - `rng` (optional) — `default | cpu | gpu | nv`, patches ComfyUI's noise generator (`cwk_rng`).
  - `model_sampling` (optional) — `default | eps | v_prediction | lcm | x0 | img_to_img` model-sampling patch.
- **Outputs:** `pipe`, `model`, `clip`, `vae`, `latent`, `sampler_name`, `scheduler`, `cfg`, `steps`, `clip_skip`, `infos` (JSON string summarizing all applied settings).
- **Notes:**
  - Includes a sampler/scheduler **fuzzy-matching fallback system** (handles aliases like `"DPM++ 2M Karras"`, `"Euler A"`, etc.) so stored presets or older workflow strings still resolve to valid ComfyUI sampler/scheduler names.
  - `clip_skip` supports a `"Disabled"` sentinel to pass CLIP through untouched.

---

## Utilities
*(Category: `CWK/Utilities`)*

### CWK Latent Image
**Class:** `CWK_LatentImage`

Resolution + batch-size node that outputs an empty `LATENT`, with built-in presets for SDXL, SD1.5, Flux, and Wan resolutions.

- **Inputs:** `resolution_preset` (dropdown of named presets, or `(preset)` for manual), `width`, `height`, `batch_size`.
- **Outputs:** `latent`, `width`, `height`.
- **Notes:** Selecting a named preset overrides the manual width/height fields.

### CWK Batch Selector
**Class:** `CWKBatchSelector`

Pauses workflow execution to let you manually pick which image(s) from a batch to keep, with live preview thumbnails in the UI.

- **Inputs:** `images` (required); `latents`, `graph_id` (optional); hidden `prompt`/`extra_pnginfo`/`uid`.
- **Outputs:** `images` (selected only), `latents` (matching selection), `indexes` (comma-separated string of chosen indices).
- **Behavior:**
  - If the batch size is 1, passes through automatically without pausing.
  - Sends preview URLs to the frontend and blocks until the user clicks **Send**, **Cancel**, or **Re-Generate**.
  - **Re-Generate** interrupts and re-queues the prompt; **Cancel** or an empty selection interrupts processing entirely.

### CWK Live Preview
**Class:** `CWKLivePreview`

Passive display node that shows real-time image previews during sampling, independent of ComfyUI's global "Preview Method" setting.

- **Inputs/Outputs:** none — it's a display-only node.
- **Notes:** Works via a WebSocket event (`cwk_live_preview`) patched into `latent_preview.prepare_callback` at import time; enabled/disabled globally through a toggle route (`/cwk_live_preview/toggle`) exposed to the ComfyUI Settings panel.

---

## Prompting
*(Category: `CWK/Prompting`)*

### CWK Prompt Composer
**Class:** `CWKPromptComposerNode`

Visual, pill-based prompt editor with an A1111-compatible attention-weight parser, tag/wildcard/preset browsing, and optional CLIP encoding — all handled through a custom JS frontend backed by REST endpoints.

- **Inputs:**
  - `positive_prompt`, `negative_prompt` (multiline strings, required).
  - `clip` (optional) — if connected, prompts are encoded to conditioning.
  - `parser` (optional) — `comfy` (default) or `A1111` attention-weight syntax (`(tag:1.3)`, `[tag]`, `BREAK`, escaped brackets, etc.).
  - `flux_guidance` (optional, default `3.5`) — sets the `guidance` value on positive conditioning (Flux models).
  - `zero_out_negative` (optional, default `False`) — zeroes negative conditioning (equivalent to ComfyUI's `ConditioningZeroOut`).
- **Outputs:** `positive_prompt`, `negative_prompt` (strings), `positive_cond`, `negative_cond` (`CONDITIONING`, empty lists if no CLIP is connected).
- **Backing REST endpoints** (used by the JS UI, not called directly by users):
  - `GET /cwk/tags/{key}` — serves tag lists (`quality`, `style`, `aesthetic`, `main`, `negative`); auto-downloads a Danbooru tag list for `main` on first use.
  - `POST /cwk/add_tag` — appends a new tag to a tag file, alphabetically.
  - `GET /cwk/embeddings` — lists available embedding files for autocomplete.
  - `GET /cwk/wildcards`, `GET /cwk/wildcards/{filename}` — lists/serves YAML wildcard files from `wildcards/`.
  - `GET|POST /cwk/presets`, `DELETE /cwk/presets/{name}` — list, save, and delete prompt presets stored in `presets/`.
  - `POST /cwk/export` — bundles selected tag files and/or presets into a single JSON export.

---

## Wan2.2 Nodes
*(Category: `CWK/Wan2.2`)*

A set of nodes for building multi-clip, looping Wan 2.2 image-to-video pipelines with per-clip prompts, seeds, and LoRA stacks.

### CWK Wan2.2 Prompt Composer
**Class:** `CWK_Wan22PromptComposer`

Converts a JSON block list (built by the JS frontend) into a `WAN22_PIPELINE` — one entry per clip, with prompt, duration→frame-count conversion, seed, and separate high/low-noise LoRA lists.

- **Inputs:** `frame_rate` (FLOAT, forced input), `pipeline_data` (STRING, JSON).
- **Outputs:** `pipeline` (`WAN22_PIPELINE`).
- **Notes:** Disabled blocks (`"disabled": true`) are filtered out before frame-count calculation.

### CWK Wan2.2 Pipeline Splitter
**Class:** `CWK_Wan22PipelineSplitter`

Extracts a single clip's data from a `WAN22_PIPELINE` by index — useful for static (non-looping) multi-KSampler graphs.

- **Inputs:** `pipeline` (`WAN22_PIPELINE`), `clip_index` (INT, 1-based).
- **Outputs:** `prompt`, `frame_count`, `lora_stack_high`, `lora_stack_low`, `seed`.

### CWK Wan2.2 LoRA Applier
**Class:** `CWK_Wan22LoraApplier`

Applies a `LORA_STACK` to a model/clip pair via ComfyUI's standard `LoraLoader`, one LoRA at a time — safe to use inside looping graphs.

- **Inputs:** `model` (MODEL), `clip` (CLIP), `lora_stack` (LORA_STACK).
- **Outputs:** `model`, `clip`.
- **Usage:** Connect once for the high-noise stack (keep the CLIP output), and once for the low-noise stack (CLIP output can be left unconnected).

### CWK Wan2.2 Loop Open
**Class:** `CWK_Wan22LoopOpen`

Loop entry point that tracks per-clip iteration state across re-queues, feeding one clip's prompt/seed/LoRAs at a time.

- **Inputs:** `pipeline` (`WAN22_PIPELINE`), `start_image` (IMAGE), `overlap` (INT, default 5), `overlap_mode` (`blend_linear | blend_sqrt | replace`), `overlap_side` (`start | end`), `force_reset` (BOOLEAN, one-shot session reset).
- **Outputs:** `current_image`, `prev_latent`, `prompt`, `frame_count`, `lora_stack_high`, `lora_stack_low`, `clip_seed`, `loop_state` (`WAN22_LOOP_STATE`).
- **Notes:** Automatically resets its internal session if the pipeline fingerprint changes or the clip index overflows; broadcasts a `cwk_wan22_clip_active` WebSocket event per clip for UI highlighting.

### CWK Wan2.2 Loop Close
**Class:** `CWK_Wan22LoopClose`

Loop exit / frame accumulator. Blends the new clip's frames into the running accumulation and either re-queues the graph for the next clip or returns the final video frames.

- **Inputs:** `loop_state` (`WAN22_LOOP_STATE`), `new_images` (IMAGE), `new_latent` (LATENT), `final_only` (BOOLEAN, default `True`).
- **Outputs:** `images`, `final_latent`.
- **Notes:**
  - `final_only=True`: outputs a black placeholder frame on intermediate iterations so downstream video-combine nodes stay idle until the full sequence is ready.
  - `final_only=False`: outputs the partial accumulation after every clip, for per-clip previewing.
  - Sends `cwk_wan22_loop_continue` to trigger re-queue, and `cwk_wan22_clip_active` (`-1`) on completion.

### CWK Wan2.2 Image Prep
**Class:** `CWKWanImagePrep`

Prepares a source image for WAN 2.2 I2V generation: interactive crop, aspect-correct resize to a target resolution, and passthrough of common generation parameters.

- **Inputs:** `resolution_preset` (`16:9 832x480 | 16:9 1280x720 | 9:16 480x832 | 9:16 720x1280 | 1:1 1024x1024`), `crop_x/y/width/height`, `upscale_method`, `frame_rate`, `total_steps`, `split_steps`, `cfg_scale`, `scheduler`, `sampler`, `image_filename` (JS-managed upload); optional `image` (IMAGE) input.
- **Outputs:** `image`, `width`, `height`, `frame_rate`, `scheduler`, `sampler_name`, `total_steps`, `split_steps`, `cfg_scale`.
- **Notes:** Priority order for the source image is JS-uploaded file → connected `IMAGE` input → black placeholder. Cropping is sanitized to stay within image bounds, then scaled/center-cropped to the exact target resolution.

---

## License

MIT — see [LICENSE](LICENSE).
