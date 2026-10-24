# Assets

The six time-of-day plates used by the NIGHTDRIVE wallpaper engine.

**CURRENT STATUS:** the plates are AI-generated photographic renders at
1376×768, encoded at 4:4:4 chroma / quality 95. They share two camera poses:

- `morning`, `day`, `golden-hour` — closer, front-on three-quarter view.
- `dusk`, `night`, `midnight` — the same frame, progressively darker.

`night` and `midnight` are rebuilt from the `dusk` master by
`scripts/rebuild-assets.py` (a fitted per-channel colour grade plus a
composited moon), because the originals shipped at 0.59–0.82 bits/pixel and
were visibly blocky. Regenerating them keeps the camera pose identical, which
is what makes the dusk → night → midnight crossfades seamless.

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

## What an ideal replacement set looks like

The engine picks these up automatically if you overwrite them in place:

- Six **identically composed** frames — same camera position, same car scale,
  same parked position — so nothing "jumps" at a crossfade.
- **2560×1440 or larger.** 1376×768 is a true 1:1 match at 1366×768 but is
  upscaled on 1440p and 4K displays; higher-resolution masters are the single
  biggest remaining quality win. Keep 16:9.
- The car lit **as it should be for that time of day**, lamps already lit at
  dusk/night/midnight. The engine only adds the volumetric beam.
- Export JPEG at quality ≥ 90 with **4:4:4 chroma** (no subsampling).
  `npm test` fails the build if a plate is under 1280×720, subsampled, or
  compresses below 1.0 bits/pixel.

## Regenerating

```bash
python3 scripts/rebuild-assets.py    # night + midnight from dusk, re-encode all
python3 scripts/build-headlights.py  # beam overlay for dusk/night/midnight
```

Both need `pillow`, `numpy` and `opencv-python-headless`.

The JavaScript loads these paths itself (see `ASSETS` in `engine/script.js`);
you only need to edit that table if you add a new file format. Do not use
official Dodge marks unless you have rights to them.
