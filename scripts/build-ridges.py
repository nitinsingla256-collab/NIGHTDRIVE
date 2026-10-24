#!/usr/bin/env python3
"""
NIGHTDRIVE — derive the skyline of each scene plate.

The depth-effect clock needs to know exactly where the terrain starts, so the
foreground can be painted back over the lower part of the clock. Guessing one
clip path for all six plates does not work: the ridge sits at a different
height in every frame, and a clip that is too high paints mountain colour over
sky (an obvious rectangle), while one that is too low lets the clock float in
front of the mountain.

This measures the ridge instead. For each column it takes the smooth sky
gradient from the top of the frame, extrapolates it downwards, and marks the
first row where the picture falls meaningfully below that prediction and stays
below it. Buildings, pine tops and the car all count as foreground, which is
what we want.

Output: engine/assets/ridges.json
  { "<period>": { "ridge": [[x, y], ...],   // normalised 0..1, left to right
                  "clock": { "x": 0.30, "y": 0.36, "size": 1.0 } } }

Coordinates are normalised so the engine can build a clip-path that works at
any viewport size (the plate is drawn with object-fit: cover).

Run:  python3 scripts/build-ridges.py [--preview]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"
OUT = ASSETS / "ridges.json"

PERIODS = ["morning", "day", "golden-hour", "dusk", "night", "midnight"]

SAMPLES = 48          # polygon points across the frame
SKY_BAND = 0.12       # top 12 % is assumed to be clear sky
DROP_LEVELS = 7.0     # how far below the predicted sky counts as "not sky"
RUN_PX = 12           # ...for at least this many rows, to reject thin poles


def skyline(lum: np.ndarray) -> np.ndarray:
    """
    Return ridge_y per column (pixels): the skyline of the plate.

    Three simpler tests were tried and rejected against these six plates:

      * brightness threshold — the hazy daylight ridge is nearly as bright as
        the sky above it, and at night the ridge is only a few levels darker;
      * local texture — cloud edges are as rough as rock, so the line jumped
        up into the clouds on the day plate;
      * connected smooth region from the top — clouds break the connection, so
        the line stopped at the cloud deck, well above the mountains.

    What actually defines a skyline is contrast: sky above, solid matter below.
    For each column this measures the mean luminance WIN px above against WIN px
    below every candidate row and takes the strongest transition. Cloud edges
    score near zero because it is bright on both sides; the mountain edge scores
    high because below it is forest or shadow. The result is then median
    filtered so single trees and poles cannot pull it around.
    """
    import cv2

    h, w = lum.shape
    win = max(24, int(h * 0.05))
    f = cv2.GaussianBlur(lum, (0, 0), 3).astype(np.float32)
    ii = cv2.integral(f)                                  # (h+1, w+1)

    ys = np.arange(h)
    lo, hi = int(h * 0.18), int(h * 0.92)

    def box_mean(y0, y1):
        y0c = np.clip(y0, 0, h)
        y1c = np.clip(y1, 0, h)
        total = ii[y1c] - ii[y0c]                          # (w + 1,)
        return total / np.maximum(1, (y1c - y0c))[:, None]

    above = box_mean(ys - win, ys)                         # (h, w+1)
    below = box_mean(ys, ys + win)
    score = above - below
    score[:lo] = -1e9
    score[hi:] = -1e9
    ridge = np.argmax(score, axis=0)[:w].astype(np.float32)

    k = 51
    pad = np.pad(ridge, (k // 2, k // 2), mode="edge")
    ridge = np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)
    return np.convolve(ridge, np.ones(9) / 9, mode="same").astype(np.float32)


def simplify(ridge: np.ndarray, samples: int) -> list[list[float]]:
    h = ridge.shape[0]
    w = h  # not used
    n = ridge.shape[0]
    idx = np.linspace(0, n - 1, samples)
    xs = np.arange(n)
    ys = np.interp(idx, xs, ridge)
    height = 1.0  # normalised below by caller
    return [[round(float(x / (n - 1)), 4), round(float(y), 2)] for x, y in zip(idx, ys)]


def clock_placement(ridge_px: np.ndarray, height: int, width: int) -> dict:
    """
    Choose where the clock sits, in image-normalised coordinates.

    Horizontal position is picked for a *clean cut*: among columns in the middle
    third of the frame, prefer the run where the ridge is flattest, because a
    flat ridge gives the horizontal edge the depth effect relies on. The clock
    is then placed so its lower third crosses that ridge — the engine derives
    the exact vertical offset from the same numbers, so it survives a resize.
    """
    lo, hi = int(width * 0.20), int(width * 0.46)
    best_x, best_var = lo, 1e9
    for x in range(lo + 30, hi - 30, 6):
        local = ridge_px[x - 30:x + 30]
        var = float(np.percentile(local, 75) - np.percentile(local, 25))
        # Prefer flat, and mildly prefer the ridge sitting low in the frame so
        # the clock has room above it.
        score = var + 0.15 * abs(float(np.mean(local)) - height * 0.58)
        if score < best_var:
            best_var, best_x = score, x
    return {"x": round((best_x + 0.0) / width, 4)}


def render_mock(img: Image.Image, ridge_px: np.ndarray, clock: dict) -> Image.Image:
    """
    Draw the planned compositing in PIL so the depth effect can be judged
    without a browser: clock text, then the plate pasted back over everything
    below the ridge. This mirrors what the engine does with clip-path.
    """
    from PIL import ImageFont

    vis = img.copy()
    w, h = vis.size
    d = ImageDraw.Draw(vis)
    d.line([(x, float(ridge_px[x])) for x in range(w)], fill=(255, 0, 0), width=2)

    size = int(h * 0.20)
    font = None
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        try:
            font = ImageFont.truetype(candidate, size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = "22:48"
    tw = d.textlength(text, font=font)
    cx = clock["x"] * w
    ridge_at = float(np.interp(cx, np.arange(w), ridge_px))
    top = ridge_at - size * 0.52
    d.text((cx - tw / 2, top), text, font=font, fill=(255, 255, 255))

    # Paste the foreground back over the clock.
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    for x in range(w):
        md.line([(x, float(ridge_px[x])), (x, h)], fill=255)
    vis.paste(img, (0, 0), mask)
    return vis


def format_data(out: dict[str, dict]) -> str:
    """
    Write the file one ridge point per line.

    `json.dumps(indent=2)` puts every number on its own line, which turns a
    48-point skyline into 100 lines of noise. This stays valid JSON (the tests
    parse it with a duplicate-key-rejecting reader) while keeping a readable
    diff when a plate is re-measured.
    """
    blocks = []
    for period, data in out.items():
        points = ",\n".join(f"      [{x:.4f}, {y:.4f}]" for x, y in data["ridge"])
        blocks.append(
            f'  "{period}": {{\n'
            f'    "source": {json.dumps(data["source"])},\n'
            f'    "sourceSha1": "{data["sourceSha1"]}",\n'
            f'    "ridge": [\n{points}\n    ],\n'
            f'    "clock": {json.dumps(data["clock"])}\n'
            f'  }}'
        )
    return "{\n" + ",\n".join(blocks) + "\n}\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--preview", action="store_true", help="also write .audit/ ridge overlays")
    args = ap.parse_args()

    out: dict[str, dict] = {}
    for period in PERIODS:
        path = ASSETS / period / "scene.jpg"
        if not path.exists():
            print(f"  ✗ {path} missing", file=sys.stderr)
            return 1
        img = Image.open(path).convert("RGB")
        w, h = img.size
        lum = np.asarray(img, dtype=np.float32).mean(axis=2)
        ridge = skyline(lum)
        pts = simplify(ridge, SAMPLES)
        pts_norm = [[x, round(y / h, 4)] for x, y in pts]
        clock = clock_placement(ridge, h, w)
        out[period] = {
            "source": f"assets/{period}/scene.jpg",
            # Ties the skyline to the exact file it was measured from: retouch a
            # plate and `npm test` notices the ridge is stale.
            "sourceSha1": hashlib.sha1(path.read_bytes()).hexdigest(),
            "ridge": pts_norm,
            "clock": clock,
        }
        ridge_at = float(np.interp(clock["x"] * w, np.arange(w), ridge))
        print(f"  {period:12s} ridge {ridge.min():.0f}-{ridge.max():.0f}px, "
              f"clock centred x={clock['x']:.2f}, ridge under it {ridge_at / h:.3f}")

        if args.preview:
            vis = img.copy()
            d = ImageDraw.Draw(vis)
            d.line([(x * w, y) for x, y in pts], fill=(255, 0, 0), width=3)
            mock = render_mock(img, ridge, clock)
            mock.save(f"/tmp/ridge-{period}.png")
            print(f"               preview: /tmp/ridge-{period}.png")

    OUT.write_text(format_data(out))
    print(f"\n  wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
