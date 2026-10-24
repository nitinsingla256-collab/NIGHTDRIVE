#!/usr/bin/env python3
"""
NIGHTDRIVE — native 1376x768 coordinate-locked headlight overlays.

Generates `engine/assets/{dusk,night,midnight}/headlights.jpg` in the exact
1376x768 coordinate space of `scene.jpg` (`transform: none`, `object-fit: cover`,
matching `object-position: var(--focus)`), eliminating any misaligned second
grille or aspect-ratio drift.

Each plate combines:
  1. Warm-white core bloom + subtle optical horizontal flare locked to the four
     measured Challenger headlamp centres in `dusk/scene.jpg`:
     passenger `(657, 603), (678, 604)` and driver `(849, 603), (879, 601)`.
  2. Forward-left volumetric mist cones following the car's three-quarter heading.
  3. Wet-asphalt specular reflections modulated by the real road micro-texture of
     `dusk/scene.jpg` so puddles and damp tarmac catch the warm beam naturally.

Pure black `(0, 0, 0)` outside the light field ensures `mix-blend-mode: screen`
leaves sky, mountains, and car bodywork untouched.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"

LAMPS_LEFT = [(657.0, 603.0), (678.0, 604.0)]
LAMPS_RIGHT = [(849.0, 603.0), (879.0, 601.0)]

# Per-period intensity & colour warmth (R, G, B multipliers).
PERIOD_GAIN = {
    "dusk": (0.72, (1.00, 0.84, 0.60)),
    "night": (0.95, (1.00, 0.86, 0.64)),
    "midnight": (1.06, (1.00, 0.88, 0.68)),
}

JPEG_KW = dict(quality=94, subsampling=0, optimize=True, progressive=True)


def cone_field(
    xx: np.ndarray,
    yy: np.ndarray,
    origin: tuple[float, float],
    target: tuple[float, float],
    half_angle_deg: float,
    reach_px: float,
    near_soft_px: float = 8.0,
) -> np.ndarray:
    """Smooth 2-D projected volumetric cone from `origin` toward `target`."""
    ox, oy = origin
    tx, ty = target
    vx, vy = tx - ox, ty - oy
    vlen = float(np.hypot(vx, vy))
    ux, uy = vx / vlen, vy / vlen
    px, py = -uy, ux  # perpendicular

    dx = xx - ox
    dy = yy - oy
    along = dx * ux + dy * uy
    perp = dx * px + dy * py

    # Only forward of the lamp housing.
    forward = np.clip(along / near_soft_px, 0.0, 1.0)
    forward = forward * forward * (3.0 - 2.0 * forward)

    # Beam width expands linearly with distance from a tight 7px aperture.
    tan_a = float(np.tan(np.deg2rad(half_angle_deg)))
    sigma_perp = 6.5 + np.maximum(along, 0.0) * tan_a
    lateral = np.exp(-0.5 * (perp / sigma_perp) ** 2)

    # Smooth longitudinal attenuation.
    dist_norm = np.maximum(along, 0.0) / reach_px
    longitudinal = np.exp(-1.55 * (dist_norm ** 1.35)) * np.clip(1.0 - 0.65 * dist_norm, 0.0, 1.0)

    return forward * lateral * longitudinal


def build_base_light_layers(road_plate: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Return `(core_rgb, mist_rgb, road_rgb)` in float32 [0..255] at 1376x768.
    """
    h, w = road_plate.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)

    # 1. Lamp core blooms + subtle horizontal lens flare at exact lamp coords.
    core = np.zeros((h, w), dtype=np.float32)
    for lx, ly in LAMPS_LEFT + LAMPS_RIGHT:
        r2 = (xx - lx) ** 2 + (yy - ly) ** 2
        core += 175.0 * np.exp(-0.5 * r2 / (5.2 ** 2))
        core += 68.0 * np.exp(-0.5 * r2 / (14.5 ** 2))
        # Subtle anamorphic horizontal streak centered on each lamp.
        core += 34.0 * np.exp(-0.5 * (((xx - lx) / 26.0) ** 2 + ((yy - ly) / 2.6) ** 2))

    core_rgb = (
        core[:, :, None] * np.array([1.00, 0.93, 0.80], dtype=np.float32)
    )

    # 2. Volumetric mist cones (left pair + right pair), angled forward-left
    #    along the Challenger's chassis perspective.
    left_origin = (667.5, 603.5)
    right_origin = (864.0, 602.0)

    cone_l_wide = cone_field(xx, yy, left_origin, (250.0, 742.0), half_angle_deg=14.5, reach_px=520.0)
    cone_l_hot = cone_field(xx, yy, left_origin, (295.0, 736.0), half_angle_deg=6.8, reach_px=450.0)

    cone_r_wide = cone_field(xx, yy, right_origin, (470.0, 760.0), half_angle_deg=15.5, reach_px=520.0)
    cone_r_hot = cone_field(xx, yy, right_origin, (515.0, 756.0), half_angle_deg=7.2, reach_px=455.0)

    mist = 54.0 * (cone_l_wide + 1.08 * cone_r_wide) + 62.0 * (cone_l_hot + 1.08 * cone_r_hot)
    # Keep volumetric beam strictly below horizon/hood line so sky stays untouched.
    sky_guard = np.clip((yy - 586.0) / 22.0, 0.0, 1.0)
    sky_guard = sky_guard * sky_guard * (3.0 - 2.0 * sky_guard)
    mist *= sky_guard
    mist = cv2.GaussianBlur(mist, (0, 0), 5.0)
    mist_rgb = mist[:, :, None] * np.array([1.00, 0.84, 0.58], dtype=np.float32)

    # 3. Wet-asphalt specular reflections modulated by actual scene road texture.
    road_luma = road_plate.mean(axis=2)
    # High-pass + mid-tone reflectance of wet asphalt / puddles in dusk/scene.jpg.
    local_mean = cv2.GaussianBlur(road_luma, (0, 0), 18.0) + 1e-4
    texture_boost = np.clip(road_luma / local_mean, 0.45, 2.15) ** 1.35

    # Road plane mask (starts beneath front bumper / splitter line y ~ 658..768).
    road_mask = np.clip((yy - 654.0) / 26.0, 0.0, 1.0)
    road_mask = road_mask * road_mask * (3.0 - 2.0 * road_mask)

    road_pool_l = cone_field(xx, yy, (662.0, 640.0), (240.0, 765.0), half_angle_deg=19.0, reach_px=520.0, near_soft_px=18.0)
    road_pool_r = cone_field(xx, yy, (852.0, 646.0), (485.0, 768.0), half_angle_deg=21.0, reach_px=500.0, near_soft_px=18.0)

    road_energy = (78.0 * road_pool_l + 92.0 * road_pool_r) * road_mask * texture_boost
    road_energy = cv2.GaussianBlur(road_energy, (0, 0), 2.2)
    road_rgb = road_energy[:, :, None] * np.array([1.00, 0.78, 0.46], dtype=np.float32)

    return core_rgb, mist_rgb, road_rgb


def main() -> int:
    dusk_path = ASSETS / "dusk" / "scene.jpg"
    dusk_arr = np.asarray(Image.open(dusk_path).convert("RGB"), dtype=np.float32)
    core_rgb, mist_rgb, road_rgb = build_base_light_layers(dusk_arr)

    for period, (gain, tint) in PERIOD_GAIN.items():
        tint_vec = np.array(tint, dtype=np.float32)[None, None, :]
        # Screen-combine the three physical components so overlapping zones never clip harshly.
        combined = np.zeros_like(core_rgb)
        for layer in (core_rgb * gain, mist_rgb * gain * tint_vec, road_rgb * gain * tint_vec):
            clamped = np.clip(layer, 0.0, 255.0)
            combined = 255.0 - (255.0 - combined) * (255.0 - clamped) / 255.0

        # Clean zero floor so JPEG macroblocks outside the light cone stay pure (0,0,0).
        combined = np.where(combined < 1.2, 0.0, combined)
        out = Image.fromarray(np.clip(combined, 0, 255).astype(np.uint8))
        dest = ASSETS / period / "headlights.jpg"
        out.save(dest, **JPEG_KW)
        print(f"  wrote {period}/headlights.jpg ({out.size[0]}x{out.size[1]}, {dest.stat().st_size // 1024} KB)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
