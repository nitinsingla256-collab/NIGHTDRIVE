#!/usr/bin/env python3
"""
NIGHTDRIVE — asset rebuild (photorealism + atmospheric moon integration).

1. NIGHT / MIDNIGHT are derived from the sharp DUSK master via fitted per-channel
   lookup tables (`scripts/asset-grades.json`), keeping camera pose & detail 1:1.
2. The "392" grille badge is retouched out on full rebuilds (`--derived-only`
   inherits the already-retouched dusk master without adding a JPEG generation).
3. The photographic moon (`assets/moon.jpg`) is composited into night and
   midnight using physical atmospheric optical transmittance (sky radiance in
   front of the attenuated lunar disc + smooth multi-scale Mie halo windowed to
   zero at the patch boundary). Because lunar radiance adds through the sky
   rather than alpha-replacing sky with dark space, no dark cutout ring or box
   seam can ever appear.
4. Plates are encoded at 4:4:4 chroma, progressive, quality 95.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"
GRADES = Path(__file__).resolve().parent / "asset-grades.json"

PERIODS = ["morning", "day", "golden-hour", "dusk", "night", "midnight"]
# (transmittance gain, RGB atmospheric tint)
DERIVED = {
    "night": (0.72, (0.90, 0.95, 1.04)),
    "midnight": (0.58, (0.86, 0.93, 1.06)),
}

# Upper-right sky placement matching the final NIGHTDRIVE reference (clear of
# both the centered sky clock and the mountain silhouette).
MOON_CX, MOON_CY, MOON_R = 1090.0, 166.0, 31.0

BADGE_BOX = (794, 600, 828, 614)
JPEG_KW = dict(quality=95, subsampling=0, optimize=True, progressive=True)


def build_moon_disc(diameter: int) -> tuple[np.ndarray, np.ndarray]:
    """
    Extract the illuminated lunar disc strictly inside its true limb (0.985*r)
    so zero black background pixels from moon.jpg ever enter the disc, then
    supersample down to `diameter` with a smooth limb-darkened mask.
    """
    moon = Image.open(ASSETS / "moon.jpg").convert("RGB")
    arr = np.asarray(moon, dtype=np.float32)
    lum = arr.mean(axis=2)
    ys, xs = np.where(lum > 45)
    cx = (xs.min() + xs.max()) / 2.0
    cy = (ys.min() + ys.max()) / 2.0
    r = ((xs.max() - xs.min()) + (ys.max() - ys.min())) / 4.0 * 0.982

    box = (int(round(cx - r)), int(round(cy - r)), int(round(cx + r)), int(round(cy + r)))
    crop = moon.crop(box)
    big = diameter * 6
    hi = np.asarray(crop.resize((big, big), Image.LANCZOS), dtype=np.float32)

    yy, xx = np.mgrid[0:big, 0:big]
    c = (big - 1) / 2.0
    d = np.sqrt((xx - c) ** 2 + (yy - c) ** 2) / (big / 2.0)

    # Smooth limb mask: 1 inside d<=0.92, cosine-smoothstep down to 0 at d=1.00.
    t = np.clip((1.0 - d) / 0.08, 0.0, 1.0)
    mask_hi = t * t * (3.0 - 2.0 * t)
    # Subtle natural optical limb darkening near the edge of the sphere.
    limb_dark = np.clip(1.0 - 0.18 * (np.clip(d, 0.0, 1.0) ** 2.4), 0.75, 1.0)

    # Gentle local contrast compression so craters read clearly without harshness.
    norm = np.clip(hi / 255.0, 0.0, 1.0)
    tonemapped = np.power(norm, 0.92) * 255.0 * limb_dark[:, :, None]

    disc_img = Image.fromarray(np.clip(tonemapped, 0, 255).astype(np.uint8)).resize(
        (diameter, diameter), Image.LANCZOS
    )
    mask_img = Image.fromarray(np.clip(mask_hi * 255.0, 0, 255).astype(np.uint8)).resize(
        (diameter, diameter), Image.LANCZOS
    )
    return (
        np.asarray(disc_img, dtype=np.float32),
        np.asarray(mask_img, dtype=np.float32) / 255.0,
    )


def screen_blend(base: np.ndarray, light: np.ndarray) -> np.ndarray:
    return 255.0 - (255.0 - base) * (255.0 - np.clip(light, 0.0, 255.0)) / 255.0


def composite_moon(plate: Image.Image, gain: float, tint: tuple[float, float, float]) -> Image.Image:
    """
    Composite the lunar disc + two-scale atmospheric Mie scattering glow via
    screen transmittance so no pixel can ever drop below the surrounding sky.
    """
    base = np.asarray(plate.convert("RGB"), dtype=np.float32).copy()
    h, w = base.shape[:2]

    dia = int(round(2 * MOON_R))
    disc_rgb, disc_mask = build_moon_disc(dia)
    tint_vec = np.array(tint, dtype=np.float32)[None, None, :]

    # 1. Atmospheric halo (inner aureole + wide soft veil), strictly windowed to
    #    0 at the patch edge so halo_seam_level stays near 0.00.
    halo_px = int(round(dia * 6.0))
    if halo_px % 2 == 1:
        halo_px += 1
    hy, hx = np.mgrid[0:halo_px, 0:halo_px]
    hc = (halo_px - 1) / 2.0
    hr = np.sqrt((hx - hc) ** 2 + (hy - hc) ** 2) / (MOON_R)  # in lunar radii

    aureole = np.exp(-0.5 * (np.maximum(hr - 0.85, 0.0) / 0.55) ** 2) * 22.0
    veil = np.exp(-0.5 * (hr / 1.85) ** 2) * 11.0
    # Window reaches 0 smoothly by 92% of patch half-width.
    patch_r = hr / (halo_px / (2.0 * MOON_R))
    win = np.clip((0.92 - patch_r) / 0.42, 0.0, 1.0)
    win = win * win * (3.0 - 2.0 * win)

    halo_intensity = (aureole + veil) * win * gain
    halo_rgb = halo_intensity[:, :, None] * np.array([0.82, 0.90, 1.05], dtype=np.float32)

    px0 = int(round(MOON_CX - halo_px / 2))
    py0 = int(round(MOON_CY - halo_px / 2))
    x0, y0 = max(px0, 0), max(py0, 0)
    x1, y1 = min(px0 + halo_px, w), min(py0 + halo_px, h)
    base[y0:y1, x0:x1] = screen_blend(
        base[y0:y1, x0:x1],
        halo_rgb[y0 - py0:y1 - py0, x0 - px0:x1 - px0],
    )

    # 2. Lunar disc transmitted through the sky in front of it.
    mx0 = int(round(MOON_CX - dia / 2))
    my0 = int(round(MOON_CY - dia / 2))
    dx0, dy0 = max(mx0, 0), max(my0, 0)
    dx1, dy1 = min(mx0 + dia, w), min(my0 + dia, h)

    moon_light = disc_rgb * disc_mask[:, :, None] * gain * tint_vec
    base[dy0:dy1, dx0:dx1] = screen_blend(
        base[dy0:dy1, dx0:dx1],
        moon_light[dy0 - my0:dy1 - my0, dx0 - mx0:dx1 - mx0],
    )

    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def halo_seam_level(plate: Image.Image) -> float:
    lum = np.asarray(plate.convert("RGB"), dtype=np.float32).mean(axis=2)
    half = int(round(2 * MOON_R * 6.0 / 2))
    top = max(0, int(MOON_CY - MOON_R * 4))
    bottom = min(lum.shape[0] - 2, int(MOON_CY + MOON_R * 4))
    rows = slice(top, bottom)

    def step_at(edge_x: int) -> float:
        if edge_x <= 16 or edge_x >= lum.shape[1] - 2:
            return 0.0
        at = np.abs(lum[rows, edge_x] - lum[rows, edge_x + 1]).mean()
        near = np.abs(lum[rows, edge_x - 15] - lum[rows, edge_x - 14]).mean()
        return float(at - near)

    left = int(round(MOON_CX - half))
    right = int(round(MOON_CX + half))
    return max(abs(step_at(left)), abs(step_at(right)))


def apply_grade(image: np.ndarray, lut: np.ndarray) -> np.ndarray:
    idx = np.clip(np.rint(image), 0, 255).astype(np.uint8)
    out = np.empty_like(image)
    for c in range(3):
        out[:, :, c] = lut[idx[:, :, c], c]
    return out


def remove_badge(plate: Image.Image) -> tuple[Image.Image, float]:
    x0, y0, x1, y1 = BADGE_BOX
    arr = np.asarray(plate, dtype=np.uint8)
    h, w = arr.shape[:2]
    before = arr[y0:y1, x0:x1].astype(np.float32)

    mask = np.zeros((h, w), np.uint8)
    mask[y0:y1, x0:x1] = 255
    mask = cv2.GaussianBlur(mask, (0, 0), 2.5)
    filled = cv2.cvtColor(
        cv2.inpaint(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), mask, 5, cv2.INPAINT_NS),
        cv2.COLOR_BGR2RGB,
    ).astype(np.float32)

    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    feather = 11.0
    dx = np.maximum(np.abs(xx - cx) - ((x1 - x0) / 2 - 2), 0) / feather
    dy = np.maximum(np.abs(yy - cy) - ((y1 - y0) / 2 - 2), 0) / feather
    alpha = np.clip(1 - np.sqrt(dx * dx + dy * dy), 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)

    smooth = cv2.GaussianBlur(arr.astype(np.float32), (0, 0), 6)
    base = arr.astype(np.float32)
    out = base * (1 - alpha[:, :, None]) + filled * alpha[:, :, None]

    core = np.clip(
        1 - np.sqrt(
            (np.maximum(np.abs(xx - cx) - ((x1 - x0) / 2 - 4), 0) / 3) ** 2
            + (np.maximum(np.abs(yy - cy) - ((y1 - y0) / 2 - 3), 0) / 3) ** 2
        ),
        0, 1,
    )[:, :, None]
    out = out * (1 - core * 0.55) + smooth * core * 0.55

    delta = float(np.abs(out[y0:y1, x0:x1] - before).mean())
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)), delta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", default=None)
    ap.add_argument("--derived-only", action="store_true")
    args = ap.parse_args()
    if args.derived_only and args.src:
        ap.error("--derived-only reads the shipped plates; drop --from")

    src_dir = Path(args.src) if args.src else None

    def load(period: str) -> Image.Image:
        path = (src_dir / f"{period}.jpg") if src_dir else (ASSETS / period / "scene.jpg")
        return Image.open(path).convert("RGB")

    grades = json.loads(GRADES.read_text())

    plates: dict[str, Image.Image] = {}
    for period in PERIODS:
        plates[period] = load(period)
        print(f"  loaded {period}")

    dusk_arr = np.asarray(plates["dusk"], dtype=np.float32)
    for period, (gain, tint) in DERIVED.items():
        lut = np.array(grades[period], dtype=np.float32)
        graded = np.clip(apply_grade(dusk_arr, lut.T), 0, 255).astype(np.uint8)
        plates[period] = composite_moon(Image.fromarray(graded), gain, tint)
        print(f"  derived {period} from dusk master (atmospheric optical moon)")

    if args.derived_only:
        manifest_path = ASSETS / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        if not manifest.get("retouch", {}).get("modelBadge", {}).get("applied"):
            print("  ERROR: no retouch receipt — the dusk master may still carry the badge",
                  file=sys.stderr)
            return 1
        seams = {}
        for period in DERIVED:
            dest = ASSETS / period / "scene.jpg"
            plates[period].save(dest, **JPEG_KW)
            seam = halo_seam_level(plates[period])
            seams[period] = round(seam, 3)
            print(f"  wrote {period}/scene.jpg ({dest.stat().st_size // 1024} KB, "
                  f"halo seam {seam:.3f} levels)")
            if seam > 1.0:
                print(f"  ERROR: halo patch is still visible on {period} ({seam:.2f} levels)",
                      file=sys.stderr)
                return 1
        manifest.setdefault("retouch", {})["moonComposite"] = {
            "applied": True,
            "periods": ["night", "midnight"],
            "source": "assets/moon.jpg",
            "mode": "screen-transmittance + windowed Mie halo (zero dark limb ring)",
            "center": [MOON_CX, MOON_CY],
            "radius": MOON_R,
            "measuredSeamLevels": seams,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        return 0

    retouch = {}
    for period in PERIODS:
        plates[period], delta = remove_badge(plates[period])
        retouch[period] = round(delta, 2)
        print(f"  removed badge from {period} (mean change {delta:.1f} levels)")
        if delta < 0.5:
            print(f"  ERROR: badge retouch did nothing on {period}", file=sys.stderr)
            return 1

    seams = {}
    for period in PERIODS:
        dest = ASSETS / period / "scene.jpg"
        dest.parent.mkdir(parents=True, exist_ok=True)
        plates[period].save(dest, **JPEG_KW)
        if period in DERIVED:
            seam = halo_seam_level(plates[period])
            seams[period] = round(seam, 3)
            print(f"  wrote {period}/scene.jpg ({dest.stat().st_size // 1024} KB, halo seam {seam:.3f} levels)")
        else:
            print(f"  wrote {period}/scene.jpg ({dest.stat().st_size // 1024} KB)")

    manifest_path = ASSETS / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.setdefault("retouch", {})
    manifest["retouch"]["modelBadge"] = {
        "applied": True,
        "box": list(BADGE_BOX),
        "method": "mask-based inpaint, feathered into the grille, core pulled to a local blur",
        "meanChangePerPlate": retouch,
        "note": "The plates carried a small '392' model badge on the grille. The brief forbids baked-in model names and logos, so it was retouched out of all six."
    }
    manifest["retouch"]["moonComposite"] = {
        "applied": True,
        "periods": ["night", "midnight"],
        "source": "assets/moon.jpg",
        "mode": "screen-transmittance + windowed Mie halo (zero dark limb ring)",
        "center": [MOON_CX, MOON_CY],
        "radius": MOON_R,
        "measuredSeamLevels": seams,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
