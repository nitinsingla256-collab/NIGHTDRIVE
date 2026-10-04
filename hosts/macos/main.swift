import Cocoa
import WebKit

class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var windows: [NSWindow] = []
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Iterate through all connected screens and spawn a wallpaper window on each
        for screen in NSScreen.screens {
            setupWallpaperWindow(for: screen)
        }
    }
    
    func setupWallpaperWindow(for screen: NSScreen) {
        let window = NSWindow(contentRect: screen.frame,
                              styleMask: [.borderless],
                              backing: .buffered,
                              defer: false)
        
        // CRITICAL: Push window strictly to the desktop background layer (behind icons)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenPrimary]
        window.isOpaque = true
        window.backgroundColor = .black
        window.hasShadow = false
        
        // Setup WKWebView Configuration
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = [] // Allow audio autoplay
        config.userContentController.add(self, name: "nightdrive")
        // Engine loads its SVG scenes via XHR from file:// — allow it.
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        
        let webView = WKWebView(frame: screen.frame, configuration: config)
        
        // Transparent background before render
        webView.isOpaque = false
        webView.backgroundColor = .clear
        
        window.contentView = webView
        
        // Dynamically locate the bundled "engine/index.html"
        if let engineURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "engine") {
            let engineDir = engineURL.deletingLastPathComponent()
            webView.loadFileURL(engineURL, allowingReadAccessTo: engineDir)
        } else {
            print("ERROR: Could not find engine/index.html in the App Bundle.")
        }
        
        window.makeKeyAndOrderFront(nil)
        windows.append(window)
    }
    
    // Handle IPC messages from the JavaScript engine
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let msgStr = message.body as? String else { return }
        
        // Side buttons open the matching System Settings pane.
        let panes: [String: String] = [
            "open_wifi_settings":  "x-apple.systempreferences:com.apple.preference.network",
            "open_bt_settings":    "x-apple.systempreferences:com.apple.preferences.Bluetooth",
            "open_sound_settings": "x-apple.systempreferences:com.apple.preference.sound",
            "open_focus_settings": "x-apple.systempreferences:com.apple.preference.notifications"
        ]
        if let action = panes.keys.first(where: { msgStr.contains($0) }),
           let url = URL(string: panes[action]!) {
            NSWorkspace.shared.open(url)
        } else if msgStr.contains("hide_fallback") {
            print("[macOS Host] Engine reported ready.")
        } else if msgStr.contains("log_time") {
            print("[macOS Host Log] \(msgStr)")
        }
    }
    
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
