# Runtime verification — 2026-10-24

Phase 2 review pass. Everything below is something that was actually run or
actually inspected; the last two sections list what could not be.

**Environment:** Debian 12 container, Linux 6.1, node v22.22.3, Python 3.11.2,
no display server, no browser, no .NET SDK, no Rust toolchain.

## 1. Commits on the intended branch — verified

```
$ gh api repos/.../branches/arena/ba654be4-nightdrive
arena/ba654be4-nightdrive -> 4391a6172b3c77b7b74903ed932fa9c94b596ef2
$ git rev-parse HEAD origin/arena/ba654be4-nightdrive
both 4391a61
```

Five commits (`c25661c`, `b8753f7`, `517351b`, `ab02b5d`, `6b059cd`) are on the
remote branch; the working tree is clean. A later commit in this pass adds the
behaviour tests and the honesty fix below.

## 2. Windows host build — blocked

The project targets `net8.0-windows10.0.19041.0` with `UseWPF` and
`UseWindowsForms` (`hosts/windows/NightdriveHost/NightdriveHost.csproj`).
WPF is Windows-only and cannot be compiled on Linux even with a complete SDK.

Concretely, in this environment:

| Requirement | State |
|---|---|
| `dotnet` / `msbuild` | **not installed** |
| Install from `packages.microsoft.com`, `dot.net` | **unreachable** (`curl` exit 000) |
| `apt` | present, but the process is non-root and Debian mirrors are outside the network allowlist |
| Windows 10 1809+/11 + WebView2 Runtime to *run* it | not present |

So: no binary was produced, and no native control was exercised.

## 3. Screenshots — not possible

No Chromium, Chrome or Firefox is installed. Installing one is blocked three
ways over:

- Playwright/Puppeteer download hosts (`cdn.playwright.dev`,
  `storage.googleapis.com`) are unreachable (`curl` 000).
- A Chromium taken from the npm registry instead would not start: `libnss3`,
  `libatk`, `libgbm`, `libxkbcommon`, `libpango`, `libcups` and `libasound`
  are all absent, and they cannot be installed (see above).

The two files `docs/preview/clock-depth-*.jpg` were produced offline by
`scripts/build-ridges.py --preview` from the real plates, the real ridge data
and the real clock geometry. They are labelled as renders, not screenshots.

## 4. Interaction behaviour — verified by executing the real handlers

`npm test` loads `engine/script.js` **and** `engine/app.js` into a DOM stub and
drives them. Results from this run:

| Behaviour | Result |
|---|---|
| Drawer closed at boot | pass |
| Opens on approach, only after the 90 ms delay | pass |
| Does not close the moment the pointer leaves; closes after the 380 ms grace | pass |
| Pin keeps it open after the pointer leaves | pass |
| Escape closes it | pass |
| Ctrl/Cmd+B opens and closes it | pass |
| File picker opens; wrong type refused with a reason | pass (`Unsupported file type. Use JPEG, PNG or WebP.`) |
| Oversized image refused with a reason | pass (`That image is 55 MB. The limit is 40 MB.`) |

Each of these was fault-injected once (open delay removed; startup sound
forced on boot) and the matching check failed, so the checks are not vacuous.

## 5. Refresh and restart — verified in the executed code path

Same harness, two boots sharing one storage:

| Check | Result |
|---|---|
| Sound while the wallpaper loads | **0 play calls** |
| Sound after a deliberate *Start engine* | **1 play call** |
| Second boot with the first boot's storage | boots clean, `audio.playCalls === 0` |
| Settings saved in session 1 restored in session 2 | pass (`clock24`, `drawerPinned`) |
| Blocked/full `localStorage` (throws `QuotaExceededError`) | boots clean, clock still renders |

What this does **not** prove: browser autoplay policy, the host's own reload
path, or GPU behaviour on wake.

## 6. Windows volume/mute and Wi-Fi/Bluetooth — not tested on Windows

Reviewed by reading the code, not by running it:

- `ConnectivityHelper.cs` handles `set_volume:NN` (strict `int.TryParse`, clamped
  0–100, applied through `IAudioEndpointVolume`), `set_mute:0|1`, the four
  `open_*_settings` actions and `{"action":"quit"}`.
- `engine/script.js` sends `set_volume` / `set_mute` only when a host has
  actually answered (`PLATFORM.webview2 && nativeHostActive`). In a plain
  browser those messages are never sent, so nothing is claimed.
- The chips do not attempt to toggle a radio. Clicking posts
  `open_wifi_settings` / `open_bt_settings`; if no host answers, the toast says
  the action is unsupported rather than pretending.

**Fixed in this pass:** the chip previously read `Connected` from
`navigator.onLine`, which is network reachability, not Wi-Fi. On Ethernet that
is a false claim about a radio. It now reads `Online`/`Offline` under a
`Network` label, and Bluetooth shows `n/a` until a host reports a real state.

**Open question, not a confirmed defect:** on Windows the volume slider sets
the app's own level *and* posts `set_volume` to the system mixer, so one drag
moves both. Untested on Windows; flagged rather than changed.

## 7. Missing or invalid files, reset, storage errors — partly verified

| Case | Status |
|---|---|
| Wrong file type / oversized upload | verified (executed) |
| Blocked or full localStorage | verified (executed) |
| Restore defaults (two-click confirm) | registered and clickable; no throw; the *visual* reset was not observed |
| Saved image whose blob no longer decodes | **not exercised** — needs IndexedDB and real image decoding |

## 8. Performance and image quality — measured facts only

| Measure | Value |
|---|---|
| Plate resolution | 1376×768 (1.06 MP), all six identical |
| Upscale at 1366×768 / 1920×1080 / 2560×1440 | 1.00× / 1.41× / 1.88× |
| Chroma | 4:4:4, no subsampling |
| Bits/pixel | 1.28 (midnight) – 2.43 (day) |
| Crop from `object-fit: cover` | ~1 % |

CPU, GPU and memory could not be measured: there is no compositor here. The
rAF callbacks and particle loop run in the stub, which says nothing about
frame time on a real desktop.

## Reproduce

```bash
npm test                          # 167 checks, all passing
python3 scripts/build-ridges.py --preview   # offline clock composites
```

## 9. Windows host changes on this branch — not executed here

This branch now contains the first five native-host patches; the Linux
container still cannot build or launch them:

- **P1:** `DesktopInteraction` registers `Ctrl+Alt+N`, raises the WPF HWND as
  a temporary top-level window for drawer input, posts `drawer:open`, and sinks
  it back into WorkerW on `drawer:closed`. The tray menu has an **Open
  settings** entry using the same route.
- **P2:** the edge affordance is permanent: a two-pixel rail and ten-pixel
  handle remain visible even when pointer activation is disabled. The hotkey
  and tray entry are the non-pointer routes for a WorkerW-backed window.
- **P3:** the Windows project copies the complete `engine/` tree to both build
  and publish output, and startup refuses a package missing `app.js`, `sw.js`
  or `assets/ridges.json`.
- **P4:** WebView2 navigation, DOM-ready and process-failure handlers are
  registered before `Navigate`; navigation success/error status is logged.
- **P5:** startup diagnostics now go to `Desktop/NIGHTDRIVE_STARTUP.log` and
  include the WebRoot, HWND/parent/visibility/rectangle state, WorkerW search,
  every `SetParent` result and Win32 error, WebView2 lifecycle events, and each
  page-to-host drawbridge action. The missing `assets/dusk/sky.jpg` fallback
  reference was also replaced with the shipped dusk plate.

The implementation has not been called a Windows build or runtime test in
this environment. On Windows, use:

```powershell
dotnet publish hosts\windows\NightdriveHost\NightdriveHost.csproj `
  -c Release -r win-x64 --self-contained false
& .\hosts\windows\NightdriveHost\bin\Release\net8.0-windows10.0.19041.0\win-x64\publish\NightdriveHost.exe
Get-Content "$env:USERPROFILE\Desktop\NIGHTDRIVE_STARTUP.log" -Tail 80
```

The visual clock and moon changes from the earlier P6/P7 proposal remain
intentionally untouched pending that interaction check.
