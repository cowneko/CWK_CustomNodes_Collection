"""
CWK self-contained RNG shared options.

Provides the Options class and default opts object that the RNG subsystem
reads from model_options.  This replaces the dependency on smZNodes'
modules.shared for RNG purposes.

All fields from smZNodes' shared.opts are included so that if smZNodes is
installed and intercepts the sampling pipeline, it finds every attribute
it expects on the opts object.
"""

from copy import deepcopy


class _SimpleNamespace:
    def __repr__(self):
        keys = sorted(self.__dict__)
        items = ("{}={!r}".format(k, self.__dict__[k]) for k in keys)
        return "{}({})".format(type(self).__name__, ", ".join(items))

    def __eq__(self, other):
        return self.__dict__ == other.__dict__


class Options(_SimpleNamespace):
    """Carrier object stored in model_options under KEY."""
    KEY = "smZ_opts"

    def clone(self):
        return deepcopy(self)

    def update(self, other):
        if isinstance(other, dict):
            self.__dict__ |= other
        else:
            self.__dict__ |= other.__dict__
        return self


# ── Default options — mirrors smZNodes modules/shared.py in full ──────────────
# Only randn_source is changed at runtime by CWK; the rest stay at defaults
# so that smZNodes (if installed) finds every attribute it needs.

opts = Options()

# --- Prompt / CLIP (not used by CWK, but smZNodes reads them) ---
opts.prompt_attention = "A1111 parser"
opts.prompt_mean_norm = True
opts.comma_padding_backtrack = 20
opts.CLIP_stop_at_last_layers = 1
opts.enable_emphasis = True
opts.use_old_emphasis_implementation = False
opts.disable_nan_check = True
opts.pad_cond_uncond = False
opts.s_min_uncond = 0.0
opts.s_min_uncond_all = False
opts.skip_early_cond = 0.0
opts.upcast_sampling = True
opts.upcast_attn = False
opts.textual_inversion_add_hashes_to_infotext = False
opts.encode_count = 0
opts.max_chunk_count = 0
opts.return_batch_chunks = False
opts.noise = None
opts.start_step = None
opts.pad_with_repeats = True

# --- RNG (the fields CWK actually controls) ---
opts.randn_source = "cpu"           # "cpu" | "gpu" | "nv"
opts.eta_noise_seed_delta = 0       # ENSD

# --- Sampler parameters (smZNodes reads these during sampling) ---
opts.eta = 1.0
opts.s_churn = 0.0
opts.s_tmin = 0.0
opts.s_tmax = float("inf")
opts.s_noise = 1.0

# --- Misc smZNodes fields ---
opts.lora_functional = False
opts.use_old_scheduling = True
opts.multi_conditioning = False
opts.use_CFGDenoiser = False
opts.sgm_noise_multiplier = True
opts.debug = False
opts.batch_cond_uncond = True

# --- SDXL fields ---
opts.sdxl_crop_top = 0
opts.sdxl_crop_left = 0
opts.sdxl_refiner_low_aesthetic_score = 2.5
opts.sdxl_refiner_high_aesthetic_score = 6.0

opts_default = opts.clone()