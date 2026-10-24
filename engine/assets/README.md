# Assets

The six time-of-day plates used by the NIGHTDRIVE wallpaper engine.

**CURRENT STATUS:** AI-generated photographic renders at 1376×768, encoded at
4:4:4 chroma / quality 95. They share two camera poses:

- `morning`, `day`, `golden-hour` — closer, front-on three-quarter view.
- `dusk`, `night`, `midnight` — the same frame, progressively darker.

`night` and `midnight` are rebuilt from the `dusk` master by
`scripts/rebuild-assets.py` (a fitted per-channel colour grade plus a
composited moon), because the originals shipped at 0.59–0.82 bits/pixel and
were visibly blocky. Regenerating them keeps the camera pose identical, which
is what makes the dusk → night → midnight crossfades seamless.

## Retouching

All six plates carried a small **"392" model badge** on the grille. The brief
forbids baked-in model names and logos, so `scripts/rebuild-assets.py` paints it
out with a feathered mask-based inpaint. The manifest records the retouch and
the measured effect per plate (`retouch.modelBadge`), and `npm test` fails if
that receipt is missing.

`.audit2/`-style corner and edge crops were checked for watermarks, signatures
and UI chrome: none found.

## Files

| File | Used for |
|---|---|
| `morning/scene.jpg` | 05:00–09:00 |
| `day/scene.jpg` | 09:00–16:00 |
| `golden-hour/scene.jpg` | 16:00–18:30 |
| `dusk/scene.jpg` | 18:30–20:00 (master for night/midnight) |
| `night/scene.jpg` | 20:00–00:00 (derived) |
| `midnight/scene.jpg` | 00:00–05:00 (derived) |
| `dusk|night|midnight/headlights.jpg` | Beam overlay, `mix-blend-mode: screen` at 0.55 |
| `*/scene.svg` | Placeholder, used only if the `.jpg` is missing |
| `*/headlights.svg` | Placeholder, used only if the `.jpg` is missing |
| `moon.jpg` | 2580×2452 source plate for the composited moon |

## Car and landscape are separate slots

`SCENE_ASSETS` in `engine/script.js` already separates what a customisation
phase needs to swap independently:

```js
day: {
  landscape: ['assets/day/scene.jpg', ...],       // environment + car together
  portrait:  ['assets/day/scene-portrait.jpg'],   // optional tall version
  cursor:    ['assets/day/car.png'],              // optional transparent car layer
  focus:     ['62%', '74%'],                      // where the car sits in the plate
  headlights: ['assets/day/headlights.svg']
}
```

- **`landscape`** — the wide plate. Preferred, and what ships today.
- **`portrait`** — optional. On portrait displays the engine shows it whole
  over a blurred copy of itself. If absent, the landscape plate is used the
  same way.
- **`cursor`** — optional transparent car layer drawn over the plate. Empty
  today; the car is part of the photograph. Filling this in is what enables
  "pick a car, pick a backdrop" without re-authoring six plates per car.
- **`focus`** — the car's position as `x% y%`. Used as `object-position`, so
  narrow and portrait viewports crop *toward the car* instead of the middle of
  the valley.

## Missing / unsuitable assets

Nothing is referenced that does not exist. The gaps, in priority order:

1. **No higher-resolution masters.** 1376×768 is 1:1 at 1366×768 and a slight
   downscale at 1080p, but 1440p and 4K upscale it. This is the single biggest
   remaining quality limit. Needed: six identically composed 2560×1440 plates.
2. **No portrait variants.** The engine handles them gracefully, but none ship.
   Needed for phones and vertical side-monitors.
3. **No independent car layer.** `cursor` is empty, so the car cannot yet be
   swapped without re-rendering the plate.
4. **Two camera poses.** morning/day/golden-hour are closer and front-on;
   dusk/night/midnight share the other frame. Composition is consistent within
   each group but the car's scale shifts at the midday→dusk boundary.
5. **No EV/sports car** in the current plates — they show a muscle car. The
   target direction names Porsche GT3 RS-style vehicles; that needs new plates,
   not retouching.

## What an ideal replacement set looks like

The engine picks these up automatically if you overwrite them in place:

- Six **identically composed** frames — same camera position, same car scale,
  same parked position — so nothing jumps at a crossfade.
- **2560×1440 or larger**, 16:9. Landscape orientation.
- **No baked-in text, model names, badges, logos or watermarks.**
- The car lit **as it should be for that time of day**, lamps already lit at
  dusk/night/midnight. The engine only adds the volumetric beam.
- Export JPEG at quality ≥ 90 with **4:4:4 chroma** (no subsampling).
  `npm test` fails the build if a plate is under 1280×720, subsampled, or
  compresses below 1.0 bits/pixel.
- Portrait variants go beside them as `scene-portrait.jpg`.

## Regenerating

```bash
# rebuild night/midnight from dusk, retouch the badge, re-encode
python3 scripts/rebuild-assets.py

# regenerate the beam overlay for dusk/night/midnight
python3 scripts/build-headlights.py

# re-render docs/preview/ to inspect the compositing result
python3 scripts/preview-render.py
```

The rebuild script is idempotent in *intent* but not in *bytes*: running it on
its own output adds a JPEG generation. Run it from pristine plates (pass
`--from DIRECTORY` containing `morning.jpg`, `day.jpg`, …) when you have them.

All three scripts need `pillow`, `numpy` and `opencv-python-headless`.

The JavaScript loads these paths itself (see `SCENE_ASSETS` in
`engine/script.js`); you only need to edit that table if you add a new file
format. Do not use official manufacturer marks unless you have rights to them.
