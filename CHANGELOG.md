# Changelog

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
