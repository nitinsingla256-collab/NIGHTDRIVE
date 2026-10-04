# NIGHTDRIVE Native macOS Host

This directory contains the true, native macOS implementation of NIGHTDRIVE, built using Swift, AppKit, and `WKWebView`. 

Unlike standard cross-platform wrappers, this native host utilizes `CGWindowLevelForKey(.desktopWindow)` to push the web engine strictly to the background layer, allowing NIGHTDRIVE to render **behind** your desktop icons seamlessly across all connected monitors.

## Requirements
To compile this application, you must be running macOS. No Xcode installation is strictly required as long as the Swift command-line tools are installed (which are included by default in modern macOS versions or via `xcode-select --install`).

## Compilation Instructions
To build the `NIGHTDRIVE.app` bundle on your Mac:

1. Open Terminal.
2. Navigate to this directory (`cd NIGHTDRIVE/hosts/macos`).
3. Run the automated Python build script:
   ```bash
   python3 build_macos.py
   ```
4. The script will automatically compile `main.swift` using `swiftc`, generate the required `Info.plist`, package the HTML engine, and output a ready-to-run `NIGHTDRIVE.app` bundle.

## Features & Implementation
*   **Desktop Injection:** Implemented natively using `NSWindow.Level`.
*   **Multi-Monitor Support:** The Swift host iterates through `NSScreen.screens` and spawns a borderless window on every connected display.
*   **System Controls:** The Wi-Fi, Bluetooth, Volume and Focus buttons open the matching System Settings pane.
*   **Invisible App:** The `Info.plist` is configured with `LSUIElement` set to `true`, hiding NIGHTDRIVE from the Dock so it behaves truly as a background wallpaper service rather than an active window.
