#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_window("main")
                .expect("window with label \"main\" is defined in tauri.conf.json");

            // macOS: pin the window to the desktop layer (behind icons) on every Space.
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
                use cocoa::base::id;

                // kCGDesktopWindowLevel = kCGMinimumWindowLevel + 20
                const DESKTOP_WINDOW_LEVEL: i64 = i32::MIN as i64 + 20;

                if let Ok(ptr) = window.ns_window() {
                    let ns_window = ptr as id;
                    unsafe {
                        ns_window.setLevel_(DESKTOP_WINDOW_LEVEL);
                        ns_window.setCollectionBehavior_(
                            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                        );
                    }
                }
            }

            // Windows / Linux: Tauri v1 has no desktop-layer API. The window runs
            // fullscreen and borderless; for a true behind-the-icons wallpaper use
            // the native Linux host (hosts/linux) or a wallpaper manager such as
            // Lively Wallpaper (Windows) pointed at engine/index.html.
            #[cfg(not(target_os = "macos"))]
            let _ = &window;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NIGHTDRIVE");
}
