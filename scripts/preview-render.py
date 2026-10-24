#!/usr/bin/env python3
"""
NIGHTDRIVE — offline preview renderer.

There is no browser or desktop runtime in this environment, so this script
reproduces the engine's compositing stack with the same CSS blend modes and
order, purely so changes can be inspected and measured:

    scene plate (object-fit: cover)
      → headlight overlay   (mix-blend-mode: screen, opacity 0.55)
      → colour-temperature  (mix-blend-mode: soft-light, rgba tint)
      → vignette            (.stage::after radial gradient)
      → dust               (not simulated)

This is NOT a browser screenshot: text rendering, backdrop-filter and the
compositor's own resampling are not reproduced. It is a sanity check on the
imagery and on the blend maths only.

Usage: python3 scripts/preview-render.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"
OUT = ROOT / "docs" / "preview"

W, H = 1920, 1080

# Straight from engine/script.js (PERIODS[*].ctColor) and styles.css.
CT = {
    "morning": (150, 190, 235, 0.00),
    "day": (255, 252, 244, 0.00),
    "golden-hour": (214, 160, 92, 0.09),
    "dusk": (118, 92, 146, 0.14),
    "night": (74, 104, 158, 0.16),
    "midnight": (44, 62, 104, 0.18),
}
HEADLIGHT_PERIODS = {"dusk", "night", "midnight"}
HEADLIGHT_OPACITY = 0.55


def cover(im: Image.Image, w: int, h: int) -> Image.Image:
    sw, sh = im.size
    s = max(w / sw, h / sh)
    im = im.resize((round(sw * s), round(sh * s)), Image.LANCZOS)
    left = (im.width - w) // 2
    top = (im.height - h) // 2
    return im.crop((left, top, left + w, top + h))


def headlight_layer(period: str) -> Image.Image | None:
    """Rebuild the CSS-transformed beam overlay for this period."""
    path = ASSETS / period / "headlights.jpg"
    if not path.exists():
        return None
    hl = Image.open(path).convert("RGB")

    # The CSS transform is expressed in percentages of the element box, which is
    # the full viewport once object-fit: cover has expanded the plate.
    scale = 0.49107
    origin = (0.366279, 0.39388)
    translate = (0.19186, 0.390625)

    ox, oy = origin[0] * W, origin[1] * H
    tx, ty = translate[0] * W, translate[1] * H
    left = tx + scale * (0 - ox) + ox
    top = ty + scale * (0 - oy) + oy

    sized = hl.resize((round(W * scale), round(H * scale)), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), (0, 0, 0))
    canvas.paste(sized, (round(left), round(top)))
    return canvas


def screen(base: np.ndarray, top: np.ndarray) -> np.ndarray:
    return 255 - (255 - base) * (255 - top) / 255


def soft_light(base: np.ndarray, blend: np.ndarray) -> np.ndarray:
    """W3C soft-light, on 0-1 floats."""
    d = base
    result = np.where(
        blend <= 0.5,
        d - (1 - 2 * blend) * d * (1 - d),
        d + (2 * blend - 1) * (np.where(d <= 0.25, ((16 * d - 12) * d + 4) * d, np.sqrt(d)) - d),
    )
    return result


def vignette(im: Image.Image, strength=0.20, inner=0.55) -> Image.Image:
    yy, xx = np.mgrid[0:H, 0:W]
    nx = (xx / W - 0.5) / 0.78
    ny = (yy / H - 0.46) / 0.72
    r = np.sqrt(nx * nx + ny * ny)
    mask = np.clip((r - inner) / (1 - inner), 0, 1) * strength
    arr = np.asarray(im, dtype=np.float32)
    arr = arr * (1 - mask[:, :, None])
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def render(period: str) -> Image.Image:
    plate = cover(Image.open(ASSETS / period / "scene.jpg").convert("RGB"), W, H)
    base = np.asarray(plate, dtype=np.float32)

    if period in HEADLIGHT_PERIODS:
        beams = headlight_layer(period)
        if beams is not None:
            top = np.asarray(beams, dtype=np.float32) * HEADLIGHT_OPACITY
            base = screen(base, top)

    r, g, b, a = CT[period]
    if a > 0:
        backdrop = base / 255.0
        blend = soft_light(backdrop, np.array([r, g, b], np.float32) / 255.0)
        base = (backdrop * (1 - a) + blend * a) * 255.0

    out = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    return vignette(out)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for period in ("morning", "day", "golden-hour", "dusk", "night", "midnight"):
        img = render(period)
        dest = OUT / f"{period}.jpg"
        img.save(dest, quality=92, subsampling=0, optimize=True, progressive=True)

        lum = np.asarray(img.convert("L"), dtype=np.float32)
        sky = lum[60:300, 300:800]
        print(
            f"  {period:12s} mean luma {lum.mean():5.1f}  "
            f"sky tones {len(np.unique(np.round(sky))):3d}  "
            f"clipped-black {(lum < 3).mean() * 100:4.1f}%  "
            f"({dest.stat().st_size // 1024} KB)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
