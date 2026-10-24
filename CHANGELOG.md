# Changelog

## [1.6.0] — 2026-10-24

Third visual pass: the image pipeline is now measurable, and the car is a
separate layer from the landscape. No framework, no new runtime dependency, no
customisation UI.

### Added
- **`scripts/check-candidate.py`** — scores any image against the brief before
  it is wired in: resolution against 1366/1920/2560-wide displays, mean
  saturation, and the five regions where licence plates, badges and watermarks
  hide. Exit 1 on a hard failure, so it works in a sourcing step. `npm run
  test:assets` runs it over the shipped plates.
- **An optional `.car-img` layer** in both scene layers, above the plate and
  below the headlight beams (`z-index: 1` vs `2`). It stays hidden until a
  period actually supplies `SCENE_ASSETS[*].cursor`, so the car and the
  background are independently replaceable without re-authoring six plates per
  car. `--car-fit` / `--car-position` place a cut-out instead of stretching it.
- **A measured art-direction reference** in `docs/reference/`: what the supplied
  image establishes (GT3 RS-style car, snowy alpine ledge, low warm sun) and the
  numbers that rule it out as a plate — 735×490, 3.48× upscale at 1440p, "GT11"
  licence plate baked in. The image is git-ignored, its licensing is unverified.

### Fixed
- **A visible box around the moon on the night plates.** The lunar glow was
  written into a square patch whose edges were never faded, leaving a measured
  ~2.5-level step across the sky gradient — faint at a glance, obvious on a
  smooth dusk sky. The patch is now windowed to exactly zero at its boundary
  (seam 0.41 / 0.31 levels on night / midnight) and `rebuild-assets.py` refuses
  to write a plate above 1.0. Only night and midnight were re-derived (new
  `--derived-only`); the other four plates are byte-identical, so they did not
  gain a JPEG generation.
- **The car layer painted over the headlight beams**, which would have occluded
  the cone that is supposed to fall across it. Paint order is now explicit and
  asserted, since no renderer is available to observe it.
- **`npm test` was time-dependent.** The period table is keyed on wall-clock
  minutes, so a run inside a 20-minute blend window saw layer B in the next
  period and four checks failed. The smoke harness now pins the clock to 10:00
  and asserts the blend separately at 15:50, where two plates must coexist.

### Changed
- `npm test` also fails on a plate narrower than 4:3, and on any period whose
  frame size differs from the others — a differently sized replacement would
  visibly shift the composition mid-crossfade.
- Version 1.6.0, service-worker cache `nightdrive-v1.6.0`, so clients pick up
  the new markup instead of a cached stylesheet without the car rule.

### Not done (deliberately)
- No car customisation interface, no system-control or engine-start redesign.
- No new plates. The six shipped plates still show a muscle car in a green
  valley, not the alpine GT3 RS direction; sourcing six identically composed
  2560×1440 plates needs assets this environment cannot generate.

## [1.5.0] — 2026-10-24

Second visual pass: brief-compliance and asset-pipeline work. No framework, no
architecture change, no new runtime dependency.

### Fixed
- **Baked-in branding removed.** All six plates carried a small "392" model
  badge on the grille, which the brief forbids. It is now retouched out with a
  feathered mask-based inpaint and the result is recorded in
  `assets/manifest.json`; `npm test` fails if that receipt is missing or if any
  plate shows no retouch. A brightness clamp was tried first and rejected: some
  glyphs are *darker* than the grille, and on the dusk plates the grille is a
  lit gradient, so any rectangular patch left a visible seam.
- **Portrait and tall assets are never stretched or blind-cropped.** A plate
  taller than 4:5 is now shown whole (`object-fit: contain`) over a blurred,
  dimmed copy of itself. Previously a 1080×1920 asset on a 1920×1080 screen
  would have been blown up 1.78× with 68 % of it thrown away.
- **The car stays framed on narrow viewports.** Each period has a `focus`
  point (the car's position in the plate) used as `object-position`. On a
  540×960 viewport the old centre crop cut the front wheel and both wheels'
  contact patches; the car-aware crop keeps the whole car.
- Aspect handling re-evaluates on resize and monitor rotation (debounced), so
  a portrait plate is picked up without reloading.

### Changed
- `ASSETS` is now derived from a new `SCENE_ASSETS` table that separates
  `landscape`, `portrait`, `cursor` (car layer) and `focus` per period, laying
  in the seams a customisation phase needs to swap car and environment
  independently. `ASSETS.scene` still resolves to the landscape list, so every
  existing consumer keeps working.
- `portrait` and `cursor` candidate lists are probed with the existing ordered
  fallback loader, so absent files cost one 404 the first time and are cached
  as unavailable.
- Scene plates regenerated from pristine sources in a single pass
  (grade → retouch → encode), so the shipped files have been through exactly
  one JPEG generation.

### Added
- `npm test` executes the engine under three viewport/asset combinations and
  asserts portrait selection, landscape fallback, contain-not-crop and the
  focal crop.
- `scripts/asset-grades.json` stores the fitted dusk→night/midnight grade as
  data, so the derived plates are reproducible without re-fitting.
- `scripts/rebuild-assets.py` takes `--from DIRECTORY` to rebuild from pristine
  plates, and records a retouch receipt in the manifest.
- `assets/README.md` documents the car/landscape slots and lists the missing
  assets explicitly.

### Not done (deliberately)
- No customisation UI. This phase only prepares the pipeline and the slots.
- No new plates: the target direction names Porsche GT3 RS-style cars and
  EV/sports photography that is not present in the repo, and inventing asset
  paths for files that do not exist would break the offline cache.

## [1.4.0] — 2026-10-24

Photorealism and visual-quality pass. No framework, no architecture change.

### Fixed
- **The engine never booted.** `script.js` called `logToHost()` on line 31, but
  `PLATFORM` is declared with `const` further down. The call threw
  `ReferenceError: Cannot access 'PLATFORM' before initialization` before a
  single scene line ran, so no image, clock, battery or weather code executed
  and the wallpaper fell back to its CSS gradients. The trace call now happens
  after `PLATFORM` exists, and `logToHost()` guards against the TDZ anyway.
- `rafTick()` called an undefined `formatTime()` on every frame, which threw
  once per animation frame and stopped the loop from re-scheduling itself. The
  dead dev-panel code that used it (and `#clock`, `#scene-name`, `#blend-info`,
  none of which exist in the DOM) is gone.
- `ASSETS[...].headlights` pointed only at the placeholder SVG, so the 588 KB
  photographic beam plates were downloaded, pre-cached and never displayed.
  The overlay drawn on screen was literally two 8 px white circles, about
  130 px left of the car's actual lamps. The `.jpg` plate is now preferred and
  the SVG is the fallback.

### Changed
- Night and midnight plates rebuilt from the sharp dusk master. They were
  shipped at 0.82 and 0.59 bits/pixel — roughly 5× heavier compression than
  the other four plates — which is what made the night sky blocky and
  posterised. Fitting a per-channel lookup table leaves ~1 luminance level of
  residual, i.e. they are pure colour grades of the dusk frame, so the grade is
  re-applied to the plate that still has the detail. See
  `scripts/rebuild-assets.py`.
- All scene plates re-encoded at 4:4:4 chroma, progressive, quality 95.
- Blurry 40 px moon replaced with a proper composite of the 2580×2452
  `assets/moon.jpg` plate (supersampled, feathered limb, tight halo).
- Headlight overlay rebuilt: emitter rings dissolved, emitters dimmed so they
  add glow instead of a second set of lamps, beam warmed toward the ~3000 K
  lamps baked into the plates, highlight roll-off to stop flat-white clipping.
  Overlay opacity 0.72 → 0.55.
- Colour grading overlay switched from `multiply` at 85 % (which compounded
  with the alpha already in each period's `rgba()` colour) to a gentle
  `soft-light` tint. Midnight previously had 5 distinct tones left in the sky;
  it now keeps 19, with no pixels clipped to black. Crossfades interpolate the
  tint colour instead of stepping between them.
- CRT scanline overlay removed — it put a 4 px light/dark pattern over every
  photograph at 60 % opacity and read as visible banding.
- Added a single soft corner vignette as the only overlay on the imagery.
- Dust particles: 70 → 26, dimmer, drawn at device pixel ratio in the beam
  wedges only, and driven by their own loop instead of the scene blend loop.
- Removed the permanent `engine-idle` shake (80 ms infinite translate) that
  kept the overlay off the pixel grid and forced constant re-rasterisation.
- Ignition flare no longer blows the lamps out with `brightness(1.8)` plus a
  20 px white drop shadow; the HUD entrance no longer uses RGB-split glitches.
- Blend loop writes layer opacity, tint and accent only when they actually
  change, instead of restyling the DOM every frame for 20-minute fades.
- Explicit `image-rendering: auto` on the scene images, and a car-biased crop
  (`object-position: 58%`) on portrait displays.
- HUD: removed the blue neon halo on the clock, and stopped the widget pills
  over-saturating the wallpaper behind them (`saturate(1.6)` → `1.05`).
- Service worker cache bumped to `nightdrive-v1.4.0` so existing installs pick
  up the new assets.

### Added
- MIT LICENSE (© 2026 Nitin Singla) — previously listed under "Unreleased".
- Offline support: `engine/sw.js` service worker pre-caches the page, styles,
  script and every scene/headlight asset, registered from `engine/index.html`.
  External fonts and weather APIs stay network-only — previously listed under
  "Unreleased".
- `npm test` validates the service worker: cache name, pre-cached files exist,
  and the registration in `index.html`.
- `npm test` now executes the engine in a DOM stub (`scripts/smoke.mjs`) and
  fails on any boot-time `ReferenceError`, checks the clock/date render, that
  scene images resolve from disk, and that the animation loop runs.
- `npm test` now validates scene images: ≥ 1280×720, 4:4:4 chroma, and
  ≥ 1.0 bits/pixel. The old night plates fail all three checks.
- `scripts/rebuild-assets.py` and `scripts/build-headlights.py` make the asset
  transformations reproducible.

## [1.3.1] - 2026-10-04

### Removed
- The per-OS theme system: `engine/themes.css`, the atmosphere switcher button and dialog, the mode-switcher logic in `script.js`, and the theme rules in `styles.css`.

### Changed
- All platforms show the same look — the wallpaper no longer mimics Windows, macOS or Linux desktop chrome, so every host renders the identical scene and HUD.

## [1.2.0] - 2026-10-04

### Added
- Windows host source (`hosts/windows/NightdriveHost/`): .NET 8 WPF + WebView2 wallpaper window, tray icon, and battery / Wi-Fi / Bluetooth / volume bridges.
- `engine/engine-start.wav` plus an ignition sound wired into the startup sequence (falls back to the first click when a browser blocks autoplay).
- `engine/assets/moon.jpg` restored from the cross-platform source bundle — still unreferenced, kept as a source asset.
- `.github/`: release workflow (source bundle + signed-out Windows host published to Releases on `v*` tags), issue templates (bug / feature) and a pull-request template.
- CI now compiles the Windows host on `windows-latest` and checks the host XML files.

### Changed
- `.gitignore` covers Windows host build output (`bin/`, `obj/`, `*.user`, `.vs/`); `.gitattributes` marks native binaries; `.editorconfig` gained C# / XAML / csproj rules.
- `npm test` additionally validates the Windows host project and the ignition asset.

## [1.1.0] - 2026-10-04

### Fixed
- Desktop hosts couldn't find the app: web files moved into `engine/`, which the Tauri, Linux and macOS hosts expect.
- Tauri build: added `build.rs`, labelled the `main` window, matched the `shell-open` feature to the allowlist, and removed unsupported window options.
- macOS host: allowed file access so the SVG scenes load; the settings buttons now open System Settings; the build script works from any directory.
- Linux host: allowed the local page to reach the weather APIs; battery shows right after launch.
- Settings buttons no longer open blank tabs on non-Windows browsers.
- The scene blend debug text was never written (missing assignment).
- Removed the red debug error overlay that could appear over the wallpaper.
- Removed the reference to a missing `engine-start.wav` (no more 404).
- CI: replaced the failing `npm ci`/`npm test` workflow with real validation.

### Added
- Responsive layout for phones, tablets, landscape, 4K, and notch safe areas.
- Accessibility: keyboard-navigable settings dialog (focus trap, Esc to close), ARIA labels, visible focus, reduced-motion and high-contrast support.
- Weather falls back to IP-based location and refreshes every 30 minutes.
- The default atmosphere follows your OS.
- `npm start` zero-dependency dev server and `npm test` validation.
- `.gitignore`, `.gitattributes`, `.editorconfig`, and a midnight entry in the asset manifest.

### Removed
- Duplicate screenshots in `docs/` and the unused `moon.jpg`.

## [1.0.0] - 2026-09-25
- Initial release.
