# Asset audit — NIGHTDRIVE scene imagery

Phase 2 of the visual brief: audit and improve the existing image pipeline and
scene assets, report what is missing or unsuitable, and keep car and background
independently replaceable. This is the report; the code changes that came out of
it are listed at the end.

## Method, and its limits

Measured with `scripts/check-candidate.py` (resolution against real display
sizes, upscaling factor, aspect and crop, mean saturation, Laplacian detail) and
`npm test` (dimensions, chroma subsampling, bits/pixel, uniform frame size).
Visual inspection used `scripts/preview-render.py`, which reproduces the
engine's compositing stack offline.

**There is no browser or desktop runtime in this environment.** Nothing here was
verified in a live window: no check of how the plates look after the compositor's
own resampling, no GPU colour management, no measurement of the animation. Every
number below comes from the files themselves, and every visual claim from the
offline render or from crops of the plates.

## What ships today

Six landscape plates, one per time-of-day period.

| Period | Size | MP | Aspect | bpp | Saturation | Detail | Upscale @1920 / @2560 |
|---|---|---|---|---|---|---|---|
| morning | 1376×768 | 1.06 | 1.79:1 | 1.89 | 19 % | 6.38 | 1.41× / 1.88× |
| day | 1376×768 | 1.06 | 1.79:1 | 2.43 | 34 % | 8.39 | 1.41× / 1.88× |
| golden-hour | 1376×768 | 1.06 | 1.79:1 | 2.14 | 62 % | 6.40 | 1.41× / 1.88× |
| dusk | 1376×768 | 1.06 | 1.79:1 | 1.86 | 64 % | 4.35 | 1.41× / 1.88× |
| night | 1376×768 | 1.06 | 1.79:1 | 1.62 | 66 % | 3.36 | 1.41× / 1.88× |
| midnight | 1376×768 | 1.06 | 1.79:1 | 1.28 | 68 % | 2.16 | 1.41× / 1.88× |

All six: JPEG, 4:4:4 chroma, progressive, quality 95. They are a 1:1 match at
1366×768, a 1.41× upscale at 1080p and 1.88× at 1440p, with ~1 % cropped at any
of those sizes because the aspect already matches 16:9.

Detail is content, not quality — a misty valley scores lower than a forest — so
it is reported and never gated. The night values are low because the picture is
dark, not because it is soft.

## Verdict, asset by asset

**Suitable, keep:** all six. None is stretched, pixelated, over-compressed, or
carrying baked-in branding. Frame size is identical across periods, which is what
makes the crossfades seamless, and no plate has a baked-in overlay — the clock,
date, temperature and labels are all live DOM.

**Unsuitable in content, needs replacement:** all six, eventually. They are
AI-generated renders of a black **Dodge Challenger-style muscle car** in a green
summer alpine valley. The direction names a **Porsche GT3 RS-style** car on a
snowy ledge at low sun. That is a different subject in a different place; it
cannot be retouched into the plates, and no amount of pipeline work produces it.

**Borderline, flagged not fixed:** `golden-hour`, `dusk`, `night` and `midnight`
are 62–68 % mean saturation. The brief asks for restrained grading and warns
against images that read as heavily filtered. `golden-hour` is close to
monochrome orange — the sun, sky, rock and road all land in one narrow hue band,
with little tonal separation in the shadows. Fixing it means re-grading or
replacing the plate; there is no safe global adjustment that would not also
flatten the parts that currently work.

## Defects found, and what happened to them

1. **A visible box around the moon** (`night`, `midnight`). The lunar glow was
   composited as a square patch whose edges were never faded. Measured: a
   ~2.5-level step inside vs outside the patch boundary — invisible in a
   thumbnail, a faint rectangle on a smooth dusk sky at 1:1. **Fixed:** the
   patch is now windowed to zero at its edge (seam 0.41 / 0.31 levels), and
   `scripts/rebuild-assets.py` measures the seam and refuses to write a plate
   above 1.0. Only those two plates were re-derived, via the new
   `--derived-only` flag; the other four are byte-identical.
2. **The car layer painted over the headlight beams.** Not visible today
   because no car layer ships, but it would have occluded the cone that is
   supposed to fall across the car. **Fixed:** explicit `z-index: 1` (car) vs
   `2` (beams), asserted in `npm test`, since paint order cannot be observed
   without a renderer.
3. **The car reads as a 3D render, not a photograph.** Glossy, uniform black
   paint with no micro-texture or dust, and reflections that are too clean. This
   is a property of the source images; it is the reason the brief's direction
   matters more than any post-processing. Not fixable in the pipeline.
4. **Two camera poses.** `morning`/`day`/`golden-hour` are closer and show more
   of the car; `dusk`/`night`/`midnight` sit further back. The car's scale
   visibly changes at the midday→dusk boundary. Cosmetic, tolerated, and it
   disappears the day the plates are replaced as one identically composed set.
5. **The moon does not light the scene.** A full moon that bright casts a cool
   rim light and a faint shadow; here the landscape is lit by the grade alone.
   Only worth fixing with a real plate.

## Missing assets

Exact specifications, so they can be sourced or commissioned:

| Missing | Spec | Why it matters |
|---|---|---|
| Higher-resolution masters | 6 × **2560×1440**, 16:9, identically composed, q≥90 at 4:4:4 | 1376×768 is a 1.88× upscale on a 1440p screen — the single biggest quality limit |
| Portrait variants | 6 × **1080×1920** (or the display's ratio), `assets/<period>/scene-portrait.jpg` | The engine handles their absence gracefully but a native render beats a contained letterbox |
| Independent car layer | transparent **PNG** at the plate's frame size, one per car, `assets/<period>/car.png` | The slot exists and is wired; without a cut-out, changing the car means re-rendering six plates per car |
| GT3 RS-style plates | Same 6 periods, same composition, car lit for each time of day | Matches the direction; the current car is a different class of vehicle |
| Snow/alpine setting | Plates on snow with rock and a valley below, low warm sun, pink sky | The reference's setting; nothing in the current set has snow |

Nothing in `SCENE_ASSETS` points at a file that does not exist, so there is no
broken reference to repair — the gaps above are absences, not errors.

## The supplied reference

Eight identical 735×490 PNGs, audited in `docs/reference/README.md`. Verdict:
**art direction only, not a shippable plate** — 0.36 MP, 3.48× upscale at
1440p, and a "GT11" licence plate baked in. It establishes the car, the setting,
the light and the composition to aim for. The file itself is git-ignored because
its licensing is unverified.

## What the pipeline now enforces

`npm test` fails if a plate is under 1280×720, loses 4:4:4 chroma, drops below
1.0 bits/pixel, is narrower than 4:3, or differs in frame size from the other
periods. `npm run test:assets` reports resolution, upscaling, saturation and the
five regions where plates, badges and watermarks hide, for any candidate image.
Both are automated so a replacement plate cannot silently regress the set.

## Changes made in this pass

- `scripts/check-candidate.py` — new suitability checker (`npm run test:assets`).
- Optional `.car-img` layer, above the plate and below the beams, driven by
  `SCENE_ASSETS[*].cursor`; hidden while no car layer ships.
- Moon patch seam fixed on `night`/`midnight`; `--derived-only` regeneration.
- Aspect and uniform-frame-size gates; the crossfade is now asserted at 15:50
  rather than depending on when the suite runs.
- `docs/reference/` — the direction, written down and measured.
