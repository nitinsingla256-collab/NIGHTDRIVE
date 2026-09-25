#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::Manager;

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let window = app.get_window("main").unwrap();

      #[cfg(target_os = "macos")]
      {
          use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior, NSWindowLevel};
          use cocoa::base::id;
          let ns_window = window.ns_window().unwrap() as id;
          unsafe {
              // Set to Desktop level
              ns_window.setLevel_((NSWindowLevel::CGDesktopWindowLevel - 1) as i64);
              // Make sure it doesn't move with Spaces/Expose
              ns_window.setCollectionBehavior_(NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle);
          }
      }

      #[cfg(target_os = "linux")]
      {
          // On Linux (X11), we could use xwininfo and xdotool to reparent the window to the root window (desktop), 
          // or set X11 window hints _NET_WM_WINDOW_TYPE_DESKTOP.
          // Tauri doesn't have a direct wrapper for setting X11 hints yet natively without external crates like x11rb.
          // We print instructions for Linux users to use a helper script or rely on Wayland wallpaper daemons.
          println!("Linux: To run as a wallpaper, use a tool like xwinwrap or set X11 properties.");
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
