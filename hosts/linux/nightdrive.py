#!/usr/bin/env python3
"""
NIGHTDRIVE Linux Host (X11)
Requires: PyQt5, PyQtWebEngine, psutil
"""
import sys
import os
import json
import psutil
from PyQt5.QtCore import QUrl, QTimer, Qt
from PyQt5.QtWidgets import QApplication, QMainWindow
from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEngineSettings

class NightdriveWallpaper(QMainWindow):
    def __init__(self, url):
        super().__init__()

        # Set window flags for X11 wallpaper integration
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnBottomHint |
            Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_X11NetWmWindowTypeDesktop, True)

        self.view = QWebEngineView(self)
        self.setCentralWidget(self.view)
        
        self.view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)

        # The engine is loaded from file:// — allow it to read its own assets
        # and reach the weather / location APIs.
        settings = self.view.settings()
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(QWebEngineSettings.PlaybackRequiresUserGesture, False)

        # Push the first battery reading as soon as the page is ready
        self.view.loadFinished.connect(lambda ok: self.update_battery())
        
        self.view.setUrl(QUrl.fromLocalFile(url))
        
        self.battery_timer = QTimer(self)
        self.battery_timer.timeout.connect(self.update_battery)
        self.battery_timer.start(10000)

        self.showFullScreen()

    def update_battery(self):
        try:
            battery = psutil.sensors_battery()
            if battery:
                pct = int(battery.percent)
                plugged = battery.power_plugged
                status = "Charging" if plugged else ""
                
                msg = {
                    "pct": f"{pct}%",
                    "status": status
                }
                
                json_str = json.dumps(msg)
                # Dispatch standard message event
                js = f"window.dispatchEvent(new MessageEvent('message', {{ data: {json_str} }}));"
                self.view.page().runJavaScript(js)
        except Exception:
            pass

if __name__ == '__main__':
    app = QApplication(sys.argv)
    
    # Path to the shared engine index.html
    # Repo layout: <root>/hosts/linux/nightdrive.py  ->  <root>/engine/index.html
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    engine_path = os.environ.get('NIGHTDRIVE_ENGINE') or os.path.join(base_dir, 'engine', 'index.html')
    
    if not os.path.exists(engine_path):
        print(f"Error: Could not find engine at {engine_path}")
        print("Please ensure you are running this script from the correct directory.")
        sys.exit(1)
        
    window = NightdriveWallpaper(engine_path)
    sys.exit(app.exec_())
