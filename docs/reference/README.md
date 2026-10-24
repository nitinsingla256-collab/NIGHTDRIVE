# Art direction reference

The project owner supplied a reference image as visual direction for the
NIGHTDRIVE wallpaper. It is **not committed**: `docs/reference/*.png` is
git-ignored because its provenance and licensing are unverified, and the brief
rules out shipping assets of unclear provenance. To inspect it, drop the file
in this directory as `target-aesthetic-gt-snow-cliff-sunset.png`.

The written direction below is the part that is committed and can be acted on.

**This file is reference material, not a runtime asset.** It is not loaded by
`engine/`, is not in the service-worker pre-cache, and must not be shipped as a
scene plate. See the audit below for why.

## What it establishes

- **Vehicle direction:** a Porsche 911 GT3 RS-style car — rear three-quarter,
  parked, stationary. The current shipped plates show a muscle car, so this is
  a *content* change, not a retouch.
- **Setting character:** alpine — snow, exposed rock, a cliff edge falling away
  into a forested valley, a distant snow-capped range.
- **Light:** low sun, strong warm sky with reflected pink light on the snow.
  The car is lit consistently with the environment — no compositing mismatch.
- **Composition:** the car sits on the left third with negative sky above and
  the valley opening to the right. Calm, static, no motion cues.

## Why it cannot ship as a plate

Measured with `python3 scripts/check-candidate.py`:

| Property | Reference | Requirement |
|---|---|---|
| Resolution | 735 × 490 (0.36 MP) | ≥ 1280 × 720 (0.92 MP) |
| Upscale to 1920 × 1080 | **2.61×** | 1.0× |
| Upscale to 2560 × 1440 | **3.48×** | 1.0× |
| Aspect | 3:2 (1.50) | 16:9 (1.78) — 16 % side crop |
| Baked-in text | **"GT11" licence plate** | none permitted |

At 2.6× upscale the car's bodywork, the wheels and the snow texture would read
as soft and smeared — precisely the "artificial pixelation / plastic-looking
paint" the brief rules out. The licence plate is also a baked-in text element.

The 3:2 aspect is *not* a problem: the engine covers the frame for any landscape
ratio, and `npm test` asserts that 3:2 and 4:3 plates are covered rather than
letterboxed.

## What a shippable plate would need

Same subject, same light, at **2560 × 1440** (or larger), **16:9**, with **no
plate lettering, badges or watermarks**, provided once per time-of-day period in
an identically-composed series. See `engine/assets/README.md` for the full
contract and `scripts/check-candidate.py` to score a candidate before shipping.

## Rights

The provenance and licensing of this reference are unknown to the project. It is
kept only as internal art direction. Confirm rights before using it, or anything
derived from it, in any other way.
