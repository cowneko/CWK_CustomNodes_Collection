"""
CWK Batch Selector — ComfyUI node.
Receives a batch of images, pauses execution for user selection,
then outputs only the selected images. If batch == 1, passes through automatically.
"""

import torch

from nodes import PreviewImage
from comfy.model_management import InterruptProcessingException

from .cwk_batch_messaging import (
    send_images_and_wait,
    CancelledResponse,
    RegenerateResponse,
)


class CWKBatchSelector(PreviewImage):
    RETURN_TYPES = ("IMAGE", "LATENT", "STRING")
    RETURN_NAMES = ("images", "latents", "indexes")
    FUNCTION     = "execute"
    CATEGORY     = "CWK"
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

    # ────────────────────────────────────────────────────────────────────
    def execute(self, images, uid, graph_id="", latents=None,
                prompt=None, extra_pnginfo=None, **_ignored):
        B = images.shape[0]

        # Pass-through for single image
        if B == 1:
            out_latents = {"samples": latents["samples"]} if latents is not None else None
            return (images, out_latents, "0")

        # Save preview thumbnails using PreviewImage's machinery
        saved = self.save_images(
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