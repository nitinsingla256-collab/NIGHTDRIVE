#!/usr/bin/env python3
"""
NIGHTDRIVE — asset rebuild (Phase 1 photorealism + Phase 1b compliance pass).

What this does and why
──────────────────────
1. NIGHT / MIDNIGHT are rebuilt from the sharp DUSK master.
   The shipped `night/scene.jpg` and `midnight/scene.jpg` were 0.82 and
   0.59 bits/pixel — about 5x heavier compression than the other four plates,
   which is what made the night sky blocky. They are, however, pure per-channel
   colour grades of the dusk frame: fitting a monotonic lookup table per
   channel leaves ~1 luminance level of residual, i.e. JPEG noise.

   So the grade in `scripts/asset-grades.json` is applied to the dusk plate,
   which still carries the detail. Nothing is invented.

2. THE MODEL BADGE IS RETOUCHED OUT.
   All six plates carry a small "392" model badge on the grille. The project
   brief forbids baked-in model names and logos, so it is painted out: the
   pixels are clamped to the grille colour measured either side of the badge,
   then the patch is feathered. This is ordinary photographic retouching and
   is applied identically to all six plates so the crossfade stays clean.

3. The photographic moon is composited into night and midnight, replacing the
   blurry ~40 px moon that was in the original plates.

4. Everything is encoded once, at the end, with 4:4:4 chroma.

Order matters: grade -> retouch -> encode means the shipped files have been
through exactly one JPEG generation. Re-running this script on its own output
would add a generation, so it is meant to run from pristine plates.

Usage:
    python3 scripts/rebuild-assets.py [--from DIR]

    --from DIR   read pristine source plates from DIR (expects
                 morning.jpg, day.jpg, ... in that folder). Without it the
                 script reads `engine/assets/<period>/scene.jpg` in place.

Requires: pillow, numpy, opencv-python-headless
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
DERIVED = {"night": (1.00, (0.98, 1.00, 1.05)), "midnight": (0.80, (0.95, 1.00, 1.12))}

# Where the blurry moon sits in the night/midnight plates (1376x768 space).
MOON_CX, MOON_CY, MOON_R = 908.0, 290.5, 23.0

# The "392" model badge on the grille, measured from the plates. It sits in the
# same place in all six (the camera and car are identical between the two
# compositions, and this part of the grille is inside both crops).
BADGE_BOX = (794, 600, 828, 614)

# JPEG output: 4:4:4 chroma (no subsampling), progressive, quality 95.
JPEG_KW = dict(quality=95, subsampling=0, optimize=True, progressive=True)


# ── moon ──────────────────────────────────────────────────────────────────────

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
    if disc.width != disc.height:
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
    rgb = np.clip(np.asarray(disc, dtype=np.float32) + 4, 0, 255)
    return Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), "RGBA")


def remove_moon(plate: Image.Image) -> Image.Image:
    """
    Erase the original moon without leaving a visible patch.

    cv2.inpaint alone leaves a step at the mask edge, and on a smooth gradient
    sky even a one-level step reads as a rectangle. So the inpainted disc is
    cross-faded into a heavily blurred version of itself, with the cross-fade
    reaching zero before the patch boundary. A blur is continuous across that
    boundary by construction, so no seam can survive.
    """
    arr = np.asarray(plate, dtype=np.uint8)
    h, w = arr.shape[:2]

    mask = np.zeros((h, w), np.uint8)
    cv2.circle(mask, (int(MOON_CX), int(MOON_CY)), int(MOON_R * 2.2), 255, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 6)
    filled = cv2.cvtColor(
        cv2.inpaint(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR), mask, 12, cv2.INPAINT_TELEA),
        cv2.COLOR_BGR2RGB,
    ).astype(np.float32)

    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.sqrt((xx - MOON_CX) ** 2 + (yy - MOON_CY) ** 2)
    alpha = np.clip((MOON_R * 3.0 - dist) / (MOON_R * 1.2), 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)  # smoothstep

    smooth = cv2.GaussianBlur(filled, (0, 0), MOON_R * 1.2)
    blended = filled * (1 - alpha[:, :, None]) + smooth * alpha[:, :, None]
    return Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8))


def composite_moon(plate: Image.Image, moon: Image.Image, gain: float, warm) -> Image.Image:
    """Erase the original moon, then paste the sharp disc with a tight halo."""
    plate = remove_moon(plate)
    w, h = plate.size

    dia = int(round(2 * MOON_R))
    big = dia * 8
    m = moon.resize((big, big), Image.LANCZOS)
    ma = np.asarray(m, dtype=np.float32)
    ma[:, :, :3] = np.clip(ma[:, :, :3] * gain * np.array(warm, np.float32), 0, 255)
    m = Image.fromarray(ma.astype(np.uint8), "RGBA").resize((dia, dia), Image.LANCZOS)

    base = np.asarray(plate, dtype=np.float32)
    halo_px = int(dia * 5.0)
    halo = (
        m.convert("RGB")
        .resize((halo_px, halo_px), Image.LANCZOS)
        .point(lambda v: v * 0.5)
        .filter(ImageFilter.GaussianBlur(dia * 0.5))
    )
    h_arr = np.asarray(halo, dtype=np.float32) * 0.10
    # The halo is a square patch, so its own edges must be faded to exactly
    # zero. Without this the patch boundary is a ~2.5-level step across the sky
    # gradient, and on a smooth dusk sky that reads as a visible faint box
    # around the moon (the blur radius alone does not reach the corner).
    hy_, hx_ = np.mgrid[0:halo_px, 0:halo_px]
    hd = np.sqrt((hx_ - halo_px / 2) ** 2 + (hy_ - halo_px / 2) ** 2) / (halo_px / 2)
    hw = np.clip((1.0 - hd) / 0.55, 0, 1)
    hw = hw * hw * (3 - 2 * hw)  # smoothstep, 0 at the patch edge
    h_arr = h_arr * hw[:, :, None]
    hx, hy = int(MOON_CX - halo_px / 2), int(MOON_CY - halo_px / 2)
    x0, y0 = max(hx, 0), max(hy, 0)
    x1, y1 = min(hx + halo_px, w), min(hy + halo_px, h)
    base[y0:y1, x0:x1] = 255 - (255 - base[y0:y1, x0:x1]) * (
        255 - h_arr[y0 - hy:y1 - hy, x0 - hx:x1 - hx]
    ) / 255
    plate = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))

    plate.paste(m, (int(round(MOON_CX - dia / 2)), int(round(MOON_CY - dia / 2))), m)
    return plate


def halo_seam_level(plate: Image.Image) -> float:
    """
    Mean luma step across the halo patch's left/right boundaries, in levels.

    The halo is composited in a square, so any residual inside it stops dead at
    that square's edge. Measured on the columns either side of the edge, away
    from the disc itself, against the same measurement 15 px further out: the
    sky gradient is smooth over that distance, so the difference between the two
    is the seam. ~0 means the patch is invisible; 2+ levels is a faint box on a
    smooth sky.
    """
    lum = np.asarray(plate.convert("RGB"), dtype=np.float32).mean(axis=2)
    half = int(round(2 * MOON_R * 5.0 / 2))
    top = max(0, int(MOON_CY - MOON_R * 4))
    bottom = min(lum.shape[0] - 2, int(MOON_CY + MOON_R * 4))
    rows = slice(top, bottom)

    def step_at(edge_x: int) -> float:
        at = np.abs(lum[rows, edge_x] - lum[rows, edge_x + 1]).mean()
        near = np.abs(lum[rows, edge_x - 15] - lum[rows, edge_x - 14]).mean()
        return float(at - near)

    left = int(round(MOON_CX - half))
    right = int(round(MOON_CX + half))
    return max(abs(step_at(left)), abs(step_at(right)))


# ── grade ─────────────────────────────────────────────────────────────────────

def apply_grade(image: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """Apply a (256, 3) lookup table, one channel at a time."""
    idx = np.clip(np.rint(image), 0, 255).astype(np.uint8)
    out = np.empty_like(image)
    for c in range(3):
        out[:, :, c] = lut[idx[:, :, c], c]
    return out


# ── retouch ───────────────────────────────────────────────────────────────────

def remove_badge(plate: Image.Image) -> tuple[Image.Image, float]:
    """
    Retouch the "392" grille badge out of a plate.

    A brightness clamp is not enough: several of the badge glyphs are *darker*
    than the grille mesh around them, so they survive it, and on the dusk plates
    (whose grille is a smooth lit gradient) any rectangular patch shows as a
    seam. The badge is therefore removed with a mask-based inpaint, feathered
    far enough that the repair dissolves into the surrounding grille, with the
    very core pulled toward a local blur to kill glyph edges.

    Returns the retouched plate and the mean absolute change across the badge
    box, so the caller can assert that real pixels were replaced.
    """
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
    alpha = alpha * alpha * (3 - 2 * alpha)  # smoothstep

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


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", default=None,
                    help="folder of pristine <period>.jpg plates to read instead of engine/assets")
    ap.add_argument("--derived-only", action="store_true",
                    help="rewrite only night/midnight from the shipped dusk master. Use after "
                         "changing the moon composite: the other four plates are already correct "
                         "and re-encoding them would cost a JPEG generation for nothing.")
    args = ap.parse_args()
    if args.derived_only and args.src:
        ap.error("--derived-only reads the shipped plates; drop --from")

    src_dir = Path(args.src) if args.src else None

    def load(period: str) -> Image.Image:
        path = (src_dir / f"{period}.jpg") if src_dir else (ASSETS / period / "scene.jpg")
        return Image.open(path).convert("RGB")

    grades = json.loads(GRADES.read_text())
    moon = build_moon_layer()

    plates: dict[str, Image.Image] = {}
    for period in PERIODS:
        plates[period] = load(period)
        print(f"  loaded {period}")

    # 1. Derive night and midnight from the dusk master.
    dusk_arr = np.asarray(plates["dusk"], dtype=np.float32)
    for period, (gain, warm) in DERIVED.items():
        lut = np.array(grades[period], dtype=np.float32)  # (3, 256)
        graded = np.clip(apply_grade(dusk_arr, lut.T), 0, 255).astype(np.uint8)
        plates[period] = composite_moon(Image.fromarray(graded), moon, gain, warm)
        print(f"  derived {period} from dusk master")

    if args.derived_only:
        # The shipped dusk master is already retouched, so the derived plates
        # inherit a badge-free grille and must not be retouched again (a second
        # inpaint pass would soften the grille for no gain).
        manifest_text = (ASSETS / "manifest.json").read_text()
        if '"modelBadge"' not in manifest_text or '"applied": true' not in manifest_text:
            print("  ERROR: no retouch receipt — the dusk master may still carry the badge",
                  file=sys.stderr)
            return 1
        for period in DERIVED:
            dest = ASSETS / period / "scene.jpg"
            plates[period].save(dest, **JPEG_KW)
            seam = halo_seam_level(plates[period])
            print(f"  wrote {period}/scene.jpg ({dest.stat().st_size // 1024} KB, "
                  f"halo seam {seam:.2f} levels)")
            if seam > 1.0:
                print(f"  ERROR: halo patch is still visible on {period} ({seam:.2f} levels)",
                      file=sys.stderr)
                return 1
        return 0

    # 2. Retouch the model badge out of every plate.
    retouch = {}
    for period in PERIODS:
        plates[period], delta = remove_badge(plates[period])
        retouch[period] = round(delta, 2)
        print(f"  removed badge from {period} (mean change {delta:.1f} levels)")
        # The retouch must actually have replaced pixels; a no-op here means the
        # badge box no longer lines up and the plate was shipped with branding.
        if delta < 0.5:
            print(f"  ERROR: badge retouch did nothing on {period} — check BADGE_BOX", file=sys.stderr)
            return 1

    # 3. Encode once.
    for period in PERIODS:
        dest = ASSETS / period / "scene.jpg"
        dest.parent.mkdir(parents=True, exist_ok=True)
        plates[period].save(dest, **JPEG_KW)
        seam = halo_seam_level(plates[period]) if period in DERIVED else None
        extra = f", halo seam {seam:.2f} levels" if seam is not None else ""
        print(f"  wrote {period}/scene.jpg ({dest.stat().st_size // 1024} KB){extra}")

    # 4. Record the retouch in the manifest. validate.mjs checks this, because a
    #    pixel heuristic cannot tell a badge glyph from the grille's own lighting
    #    gradient on the dusk plates.
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
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"  recorded retouch receipt in assets/manifest.json")

    return 0


if __name__ == "__main__":
    sys.exit(main())
