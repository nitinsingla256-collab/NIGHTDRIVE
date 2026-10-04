# Changelog

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
