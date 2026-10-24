#!/usr/bin/env python3
"""
NIGHTDRIVE — headlight overlay rebuild (Phase 1).

The shipped `headlights.jpg` is a stock beam render with hard, cartoon-like
emitter rings and a ring of stray light around the lamps. Composited at
72 % with `mix-blend-mode: screen` over the plates it produced a floating
glare disc and a visible bright rectangle over the car.

Every scene plate already has convincing, correctly positioned lamps baked
in, so the overlay only has to add the part that cannot be baked in: the
volumetric light cone and the spill on the wet road. This script

  * dissolves the sharp emitter geometry (the cartoon rings),
  * dims the emitters so they add glow rather than white blobs,
  * warms the beam to ~3000 K so it reads like the plate's own headlights,
  * applies a highlight roll-off so nothing clips to flat white.

The result is written next to each night period as `headlights.jpg`.
Usage:  python3 scripts/build-headlights.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"
W, H = 1376, 768

# Source plates for the three night periods, in priority order.
SOURCE_CANDIDATES = ["night/headlights.jpg", "dusk/headlights.jpg", "midnight/headlights.jpg"]
OUTPUT_PERIODS = ["dusk", "night", "midnight"]

JPEG_KW = dict(quality=95, subsampling=0, optimize=True, progressive=True)


def soft_ellipse(xx, yy, cx, cy, rx, ry, feather):
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    return np.clip((1 - d) / feather, 0, 1)


def main() -> int:
    source = next((ASSETS / p for p in SOURCE_CANDIDATES if (ASSETS / p).exists()), None)
    if source is None:
        print("No headlight beam plate found — nothing to do.", file=sys.stderr)
        return 1

    base = Image.open(source).convert("RGB")
    if base.size != (W, H):
        base = base.resize((W, H), Image.LANCZOS)

    yy, xx = np.mgrid[0:H, 0:W]
    # Region holding the two lamp clusters and the DRL strip between them.
    core = np.maximum(
        soft_ellipse(xx, yy, 520, 470, 330, 150, 0.55),
        soft_ellipse(xx, yy, 430, 470, 170, 140, 0.60),
    )
    core = np.maximum(core, soft_ellipse(xx, yy, 700, 465, 150, 130, 0.60))
    core_img = Image.fromarray((core * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(28))
    core = np.asarray(core_img, dtype=np.float32) / 255.0
    core3 = core[:, :, None]

    arr = np.asarray(base, dtype=np.float32)

    # 1. Dissolve the sharp emitter geometry into a soft bloom.
    softened = np.asarray(
        Image.fromarray(arr.astype(np.uint8)).filter(ImageFilter.GaussianBlur(9)),
        dtype=np.float32,
    )
    arr = arr * (1 - core3) + softened * core3
    # 2. Dim the emitters: their glow is already baked into the plate.
    arr = arr * (1 - 0.80 * core3)
    # 3. Warm the beam toward the incandescent lamps in the plates.
    arr = np.clip(arr * np.array([1.0, 0.93, 0.82], dtype=np.float32), 0, 255)
    # 4. Highlight roll-off so beams never clip to flat white.
    arr = 255.0 * np.power(arr / 255.0, 1.12)

    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    for period in OUTPUT_PERIODS:
        dest = ASSETS / period / "headlights.jpg"
        out.save(dest, **JPEG_KW)
        print(f"  wrote {period}/headlights.jpg  ({dest.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
