#!/usr/bin/env python3
"""
NIGHTDRIVE — asset rebuild (Phase 1: photorealism pass).

What this does and why
──────────────────────
`night/scene.jpg` and `midnight/scene.jpg` were shipped at 0.6–0.8 bits/pixel
(q≈90 tables, but almost all AC energy discarded). That is roughly 5× heavier
compression than the other four plates and it is what produced the blocky,
posterised sky at night. The two plates are, however, *pure per-channel colour
grades of `dusk/scene.jpg`*: fitting a monotonic lookup table per channel
leaves a residual of ~1 luminance level, i.e. JPEG noise.

So this script rebuilds night and midnight from the sharp dusk master by
re-applying that exact grade. No detail is invented — the detail that the
original encodes threw away is simply carried over from the plate that still
has it. The 2.1 MP `moon.jpg` photographic plate is then composited in place
of the blurry 40 px moon.

Finally every plate is re-encoded with 4:4:4 chroma (no colour subsampling)
so the car's edges and the sky gradients survive, which 4:2:0 was smearing.

Usage:  python3 scripts/rebuild-assets.py
Requires: pillow, numpy, opencv-python-headless
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"

# Where the blurry moon sits in the night/midnight plates (1376×768 space).
MOON_CX, MOON_CY, MOON_R = 908.0, 290.5, 23.0

# JPEG output settings: 4:4:4 chroma, progressive, quality 90.
JPEG_KW = dict(quality=95, subsampling=0, optimize=True, progressive=True)


def build_moon_layer() -> Image.Image:
    """Cut the photographic moon disc out of moon.jpg with a feathered limb."""
    moon = Image.open(ASSETS / "moon.jpg").convert("RGB")
    lum = np.asarray(moon, dtype=np.float32).mean(axis=2)
    ys, xs = np.where(lum > 70)
    cx = (xs.min() + xs.max()) / 2
    cy = (ys.min() + ys.max()) / 2
    r = ((xs.max() - xs.min()) + (ys.max() - ys.min())) / 4

    pad = 10
    box = (int(cx - r - pad), int(cy - r - pad), int(cx + r + pad), int(cy + r + pad))
    disc = moon.crop(box)
    if disc.width != disc.height:  # normalise to a square
        s = max(disc.size)
        sq = Image.new("RGB", (s, s), (0, 0, 0))
        sq.paste(disc, ((s - disc.width) // 2, (s - disc.height) // 2))
        disc = sq

    n = disc.width
    yy, xx = np.mgrid[0:n, 0:n]
    d = np.sqrt((xx - n / 2) ** 2 + (yy - n / 2) ** 2) / (n / 2)
    alpha = np.clip((1.0 - d) * n / (2 * pad * 1.25), 0, 1)
    alpha = np.asarray(
        Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0)),
        dtype=np.float32,
    ) / 255.0
    # A touch of ambient lift so the disc does not sit on pure black.
    rgb = np.clip(np.asarray(disc, dtype=np.float32) + 4, 0, 255)
    return Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), "RGBA")


def fit_grade(source: np.ndarray, target: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Median per-channel lookup table from `source` to `target`."""
    luts = []
    for c in range(3):
        s = source[:, :, c]
        t = target[:, :, c]
        lut = np.full(256, np.nan, dtype=np.float32)
        for v in range(256):
            sel = (s == v) & mask
            if sel.sum() >= 30:
                lut[v] = np.median(t[sel])
        idx = np.arange(256)
        good = ~np.isnan(lut)
        luts.append(np.interp(idx, idx[good], lut[good]).astype(np.float32))
    return np.stack(luts, axis=1)  # (256, 3)


def apply_grade(image: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """Apply a (256, 3) lookup table, one channel at a time."""
    idx = np.clip(np.rint(image), 0, 255).astype(np.uint8)
    out = np.empty_like(image)
    for c in range(3):
        out[:, :, c] = lut[idx[:, :, c], c]
    return out


def remove_moon(plate: Image.Image) -> Image.Image:
    """
    Erase the original moon without leaving a visible patch.

    cv2.inpaint alone leaves a step at the mask edge, and on a smooth gradient
    sky even a one-level step reads as a rectangle — clearly visible against
    midnight. So the inpainted disc is then cross-faded into a heavily blurred
    version of itself, with the cross-fade reaching exactly zero before the
    patch boundary. A blur is continuous across that boundary by construction,
    so no seam can survive.
    """
    arr = np.asarray(plate, dtype=np.uint8)
    h, w = arr.shape[:2]

    # 1. Remove the disc + its halo. A tight mask keeps the inpaint local.
    mask = np.zeros((h, w), np.uint8)
    cv2.circle(mask, (int(MOON_CX), int(MOON_CY)), int(MOON_R * 2.2), 255, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 6)
    filled = cv2.cvtColor(
        cv2.inpaint(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), mask, 12, cv2.INPAINT_TELEA),
        cv2.COLOR_BGR2RGB,
    ).astype(np.float32)

    # 2. Blend that patch into a wide blur of itself, feathered to zero.
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xx - MOON_CX) ** 2 + (yy - MOON_CY) ** 2)
    alpha = np.clip((MOON_R * 3.0 - dist) / (MOON_R * 1.2), 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)  # smoothstep

    smooth = cv2.GaussianBlur(filled, (0, 0), MOON_R * 1.2)
    blended = filled * (1 - alpha[:, :, None]) + smooth * alpha[:, :, None]

    return Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8))


def composite_moon(plate: Image.Image, moon: Image.Image, gain: float, warm) -> Image.Image:
    """Erase the original moon, then paste the sharp disc with a tight halo."""
    arr = np.asarray(plate, dtype=np.uint8)
    h, w = arr.shape[:2]
    plate = remove_moon(plate)

    dia = int(round(2 * MOON_R))
    # Supersample: render large, let Lanczos do the reduction.
    big = dia * 8
    m = moon.resize((big, big), Image.LANCZOS)
    ma = np.asarray(m, dtype=np.float32)
    ma[:, :, :3] = np.clip(ma[:, :, :3] * gain * np.array(warm, np.float32), 0, 255)
    m = Image.fromarray(ma.astype(np.uint8), "RGBA").resize((dia, dia), Image.LANCZOS)

    base = np.asarray(plate, dtype=np.float32)
    halo_px = int(dia * 3.4)
    halo = (
        m.convert("RGB")
        .resize((halo_px, halo_px), Image.LANCZOS)
        .point(lambda v: v * 0.5)
        .filter(ImageFilter.GaussianBlur(dia * 0.5))
    )
    h_arr = np.asarray(halo, dtype=np.float32) * 0.10
    hx, hy = int(MOON_CX - halo_px / 2), int(MOON_CY - halo_px / 2)
    x0, y0 = max(hx, 0), max(hy, 0)
    x1, y1 = min(hx + halo_px, w), min(hy + halo_px, h)
    sub = h_arr[y0 - hy:y1 - hy, x0 - hx:x1 - hx]
    base[y0:y1, x0:x1] = 255 - (255 - base[y0:y1, x0:x1]) * (255 - sub) / 255
    plate = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))

    plate.paste(m, (int(round(MOON_CX - dia / 2)), int(round(MOON_CY - dia / 2))), m)
    return plate


def main() -> int:
    dusk_path = ASSETS / "dusk" / "scene.jpg"
    dusk = Image.open(dusk_path).convert("RGB")
    dusk_arr = np.asarray(dusk, dtype=np.float32)

    # The moon area must not influence the grade fit.
    mask = np.ones(dusk_arr.shape[:2], bool)
    mask[230:350, 860:960] = False

    moon = build_moon_layer()

    targets = {
        # period: (moon gain, warm bias)
        "night": (1.00, (0.98, 1.00, 1.05)),
        "midnight": (0.80, (0.95, 1.00, 1.12)),
    }

    for period, (gain, warm) in targets.items():
        target_path = ASSETS / period / "scene.jpg"
        target = np.asarray(Image.open(target_path).convert("RGB"), dtype=np.float32)
        lut = fit_grade(dusk_arr, target, mask)
        rebuilt = np.clip(apply_grade(dusk_arr, lut), 0, 255).astype(np.uint8)
        plate = composite_moon(Image.fromarray(rebuilt), moon, gain, warm)
        plate.save(target_path, **JPEG_KW)
        print(f"  rebuilt {period}/scene.jpg  ({target_path.stat().st_size // 1024} KB)")

    # Re-encode the untouched plates without chroma subsampling.
    for period in ("morning", "day", "golden-hour", "dusk"):
        p = ASSETS / period / "scene.jpg"
        Image.open(p).convert("RGB").save(p, **JPEG_KW)
        print(f"  re-encoded {period}/scene.jpg  ({p.stat().st_size // 1024} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
