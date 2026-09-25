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
        
        // Currently, macOS doesn't integrate with native Wi-Fi/Volume via IPC due to App Sandbox limits,
        // but this bridge allows future expansion or logging.
        if msgStr.contains("hide_fallback") {
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
