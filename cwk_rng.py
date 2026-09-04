"""
CWK self-contained RNG — adapted from ComfyUI_smZNodes (shiimizu/ComfyUI_smZNodes).

Provides prepare_noise() that reads RNG options from model_options['smZ_opts']
and supports cpu/gpu/nv noise generation plus k-diffusion default_noise_sampler
hijacking. Fully self-contained — no smZNodes dependency required.
"""

import torch
import numpy as np
from comfy.model_patcher import ModelPatcher
from . import cwk_rng_shared as shared
from . import cwk_rng_philox as rng_philox


class TorchHijack:
    """Replaces torch.randn_like used by k-diffusion samplers.

    k-diffusion has a random_sampler argument for most samplers but not all,
    so this is needed to properly replace every use of torch.randn_like.
    Ensures images generated in batches match images generated individually.
    """

    def __init__(self, generator, randn_source, init=True):
        self.generator = generator
        self.randn_source = randn_source
        self.init = init

    def __getattr__(self, item):
        if item == 'randn_like':
            return self.randn_like
        if hasattr(torch, item):
            return getattr(torch, item)
        raise AttributeError(
            f"'{type(self).__name__}' object has no attribute '{item}'"
        )

    def randn_like(self, x):
        return randn_without_seed(
            x, generator=self.generator, randn_source=self.randn_source
        )


def randn_without_seed(x, generator=None, randn_source="cpu"):
    """Generate a tensor with random numbers from a normal distribution
    using a previously initialised generator."""
    if randn_source == "nv":
        return torch.asarray(generator.randn(x.size()), device=x.device)
    else:
        return torch.randn(
            x.size(), dtype=x.dtype, layout=x.layout,
            device=generator.device, generator=generator,
        ).to(device=x.device)


def prepare_noise(latent_image, seed, noise_inds=None, device='cpu'):
    """Drop-in replacement for comfy.sample.prepare_noise.

    Reads RNG options from model_options['smZ_opts'] via stack introspection.
    Falls back to default CPU generation when no options are found.
    """
    opts = None
    opts_found = False

    # Try to find the model from the calling stack
    model = _find_outer_instance('model', ModelPatcher)
    if (model is not None
            and (opts := model.model_options.get(shared.Options.KEY)) is None) \
            or opts is None:
        import comfy.samplers
        guider = _find_outer_instance('guider', comfy.samplers.CFGGuider)
        model = getattr(guider, 'model_patcher', None)
    if (model is not None
            and (opts := model.model_options.get(shared.Options.KEY)) is None) \
            or opts is None:
        pass

    opts_found = opts is not None
    if not opts_found:
        opts = shared.opts_default
        device = torch.device("cpu")

    if opts.randn_source == 'gpu':
        import comfy.model_management
        device = comfy.model_management.get_torch_device()

    device_orig = device
    device = torch.device("cpu") if opts.randn_source == "cpu" else device_orig

    def get_generator(seed):
        nonlocal device, opts
        if opts.randn_source == 'nv':
            return rng_philox.Generator(seed)
        else:
            return torch.Generator(device=device).manual_seed(seed)

    def get_generator_obj(seed):
        nonlocal opts
        generator = generator_eta = get_generator(seed)
        if opts.eta_noise_seed_delta > 0:
            seed = min(
                int(seed + opts.eta_noise_seed_delta),
                int(0xffffffffffffffff),
            )
            generator_eta = get_generator(seed)
        return generator, generator_eta

    generator, generator_eta = get_generator_obj(seed)
    randn_source = opts.randn_source

    # ── Hijack k-diffusion default_noise_sampler ──────────────────────────────
    import comfy.k_diffusion.sampling

    if not hasattr(comfy.k_diffusion.sampling, 'default_noise_sampler_orig'):
        comfy.k_diffusion.sampling.default_noise_sampler_orig = (
            comfy.k_diffusion.sampling.default_noise_sampler
        )

    if opts_found:
        th = TorchHijack(generator_eta, randn_source)

        def default_noise_sampler(x, seed=None, *args, **kwargs):
            nonlocal th
            return lambda sigma, sigma_next: th.randn_like(x)

        default_noise_sampler.init = True
        comfy.k_diffusion.sampling.default_noise_sampler = default_noise_sampler
    else:
        comfy.k_diffusion.sampling.default_noise_sampler = (
            comfy.k_diffusion.sampling.default_noise_sampler_orig
        )
    # ──────────────────────────────────────────────────────────────────────────

    if noise_inds is None:
        shape = latent_image.size()
        if opts.randn_source == 'nv':
            noise = torch.asarray(
                generator.randn(shape), dtype=latent_image.dtype, device=device
            )
        else:
            noise = torch.randn(
                shape, dtype=latent_image.dtype, layout=latent_image.layout,
                device=device, generator=generator,
            )
        return noise.to(device=device_orig)

    unique_inds, inverse = np.unique(noise_inds, return_inverse=True)
    noises = []
    for i in range(unique_inds[-1] + 1):
        shape = [1] + list(latent_image.size())[1:]
        if opts.randn_source == 'nv':
            noise = torch.asarray(
                generator.randn(shape), dtype=latent_image.dtype, device=device
            )
        else:
            noise = torch.randn(
                shape, dtype=latent_image.dtype, layout=latent_image.layout,
                device=device, generator=generator,
            )
        noise = noise.to(device=device_orig)
        if i in unique_inds:
            noises.append(noise)
    noises = [noises[i] for i in inverse]
    return torch.cat(noises, axis=0)


def _find_outer_instance(target: str, target_type=None, callback=None, max_len=10):
    """Walk the call stack looking for a local variable of the given type."""
    import inspect
    frame = inspect.currentframe()
    i = 0
    while frame and i < max_len:
        if target in frame.f_locals:
            if callback is not None:
                return callback(frame)
            else:
                found = frame.f_locals[target]
                if isinstance(found, target_type):
                    return found
        frame = frame.f_back
        i += 1
    return None