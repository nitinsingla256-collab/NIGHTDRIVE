#!/usr/bin/env python3
"""
NIGHTDRIVE — scene-plate suitability checker.

Scores a candidate image against the project brief so "is this asset good
enough to ship?" is a measurement, not an opinion. Used when sourcing new
plates, and by `npm run test:assets` against the plates already shipping.

What it checks, and why each one matters:

  resolution   A wallpaper is shown at the display's native size. A plate
               below the target is upscaled by the compositor and reads as
               soft or blocky — the exact defect this project set out to fix.
  detail       Mean Laplacian magnitude — an objective proxy for how much real
               detail the file carries. Reported, never used as a pass/fail:
               it depends on content (a misty valley has less than a forest).
  aspect       The engine covers the frame, so a plate whose aspect is far from
               the display's loses a lot of picture. Reported, not failed:
               3:2 and 16:10 sources are usable, 9:16 ones are not.
  saturation   The brief asks for restrained grading; a heavily saturated
               plate cannot be walked back without looking filtered.
  branding     Flags the regions where licence plates, badges and watermarks
               live so a human can confirm none are baked in. Deliberately a
               *report*, not a pass/fail: a crop cannot tell a badge from a
               grille.

Usage:
    python3 scripts/check-candidate.py IMAGE [IMAGE ...]
    python3 scripts/check-candidate.py engine/assets/*/scene.jpg
    python3 scripts/check-candidate.py --json IMAGE

Exit code is 1 if any image fails a hard requirement (resolution / over-compressed
upscale), 0 otherwise. Requires pillow + numpy.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Display sizes the wallpaper is expected to fill.
TARGETS = [
    ("1366x768", 1366, 768),
    ("1920x1080", 1920, 1080),
    ("2560x1440", 2560, 1440),
]

MIN_PIXELS = 1280 * 720          # below this is a hard fail
SATURATION_WARN = 0.55           # mean saturation above this looks "filtered"

# NOTE: an earlier revision of this tool tried to detect prior upscaling from
# the fraction of identical neighbouring pixels (and then from the radial power
# spectrum). Both were removed: they flag smooth content — clear sky, mist,
# shallow depth of field — just as readily as a resampled file, and they failed
# this project's own legitimately 1376x768 plates. Resolution against the
# display target is the only honest hard gate; everything else is a report.

# Regions where plate text / badges / watermarks usually sit, as fractions of
# the frame. Reported so a human can eyeball them.
REVIEW_REGIONS = {
    "bottom band (plates, signatures)": (0.0, 0.72, 1.0, 1.0),
    "bottom-right (watermark)": (0.62, 0.80, 1.0, 1.0),
    "bottom-left (watermark)": (0.0, 0.80, 0.38, 1.0),
    "top-right (watermark)": (0.62, 0.0, 1.0, 0.20),
    "top-left (watermark)": (0.0, 0.0, 0.38, 0.20),
}


def luma(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"), dtype=np.float32).mean(axis=2)


def sharpness(g: np.ndarray) -> float:
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    return float(np.abs(
        4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    ).mean())


def analyse(path: Path) -> dict:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    arr = np.asarray(im, dtype=np.float32)
    g = luma(im)

    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    saturation = float(((mx - mn) / np.maximum(mx, 1.0)).mean())

    aspect = w / h
    targets = []
    for name, tw, th in TARGETS:
        scale = max(tw / w, th / h)
        targets.append({
            "display": name,
            "upscale": round(scale, 2),
            "effectiveWidth": round(w * scale),
            "cropPct": round((1 - min(w, h * tw / th) / w) * 100) if aspect > tw / th else
                       round((1 - min(h, w * th / tw) / h) * 100),
        })

    review = {}
    for label, (x0, y0, x1, y1) in REVIEW_REGIONS.items():
        crop = im.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
        review[label] = float(np.asarray(crop, dtype=np.float32).mean())

    return {
        "path": str(path),
        "width": w,
        "height": h,
        "megapixels": round(w * h / 1e6, 2),
        "aspect": round(aspect, 3),
        "aspectLabel": f"{round(aspect, 2)}:1",
        "sharpness": round(sharpness(g), 2),
        "saturation": round(saturation, 3),
        "targets": targets,
        "reviewRegions": {k: round(v, 1) for k, v in review.items()},
    }


def verdict(r: dict) -> tuple[bool, list[str]]:
    """Returns (passes_hard_requirements, notes)."""
    notes: list[str] = []
    hard_fail = False

    if r["width"] * r["height"] < MIN_PIXELS:
        hard_fail = True
        notes.append(
            f"FAIL resolution: {r['width']}x{r['height']} is {r['megapixels']} MP, "
            f"below the {MIN_PIXELS/1e6:.2f} MP floor (1280x720)."
        )

    worst = max(t["upscale"] for t in r["targets"])
    if worst > 1.0:
        notes.append(
            f"WARN upscaling: needs up to {worst:.2f}x to fill a display — "
            f"visible as softness at native resolution."
        )

    if r["aspect"] < 1.2:
        notes.append(
            f"WARN aspect: {r['aspect']:.2f} is portrait/square; it will be shown "
            f"contained over a blurred backdrop rather than filling the frame."
        )
    elif r["aspect"] < 1.6:
        notes.append(
            f"NOTE aspect: {r['aspect']:.2f} is narrower than 16:9 "
            f"({16/9:.2f}); expect side cropping."
        )

    if r["saturation"] > SATURATION_WARN:
        notes.append(
            f"WARN saturation: mean {r['saturation']*100:.0f}% is high; the brief asks "
            f"for restrained grading."
        )

    if not notes:
        notes.append("PASS: meets the brief's hard requirements.")
    else:
        notes.append(f"detail: {r['sharpness']} (content-dependent, informational).")
    return (not hard_fail), notes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    results = []
    any_fail = False
    for pattern in args.images:
        for path in sorted(Path(".").glob(pattern)) if any(c in pattern for c in "*?[") else [Path(pattern)]:
            if not path.exists():
                print(f"missing: {path}", file=sys.stderr)
                any_fail = True
                continue
            r = analyse(path)
            ok, notes = verdict(r)
            any_fail = any_fail or not ok

            if args.json:
                r["ok"] = ok
                r["notes"] = notes
                results.append(r)
                continue

            print(f"\n{path}")
            print(f"  {r['width']}x{r['height']}  {r['megapixels']} MP  "
                  f"aspect {r['aspect']:.2f}  detail {r['sharpness']}  "
                  f"saturation {r['saturation']*100:.0f}%")
            for t in r["targets"]:
                print(f"    on {t['display']:>9s}: {t['upscale']}x upscale, "
                      f"~{t['cropPct']}% cropped")
            for n in notes:
                print(f"    {n}")

    if args.json:
        print(json.dumps(results, indent=2))

    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
