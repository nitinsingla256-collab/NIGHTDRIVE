#!/usr/bin/env python3
import os
import shutil
import subprocess
import sys

def main():
    # Detect operating system
    if sys.platform != 'darwin':
        print("ERROR: This build script must be run on macOS (Darwin).")
        print("Current platform is:", sys.platform)
        sys.exit(1)

    print("--- Building NIGHTDRIVE for macOS ---")
    
    app_name = "NIGHTDRIVE.app"
    contents_dir = os.path.join(app_name, "Contents")
    macos_dir = os.path.join(contents_dir, "MacOS")
    resources_dir = os.path.join(contents_dir, "Resources")
    
    # 1. Create the App Bundle directory structure
    for d in [macos_dir, resources_dir]:
        os.makedirs(d, exist_ok=True)
    print(f"Created app bundle structure: {app_name}")

    # 2. Compile the Swift source code directly into the MacOS directory
    swift_source = "main.swift"
    if not os.path.exists(swift_source):
        print(f"ERROR: Could not find {swift_source}")
        sys.exit(1)

    executable_path = os.path.join(macos_dir, "Nightdrive")
    
    print("Compiling Swift source...")
    compile_cmd = [
        "swiftc", swift_source,
        "-o", executable_path,
        "-framework", "Cocoa",
        "-framework", "WebKit"
    ]
    
    try:
        subprocess.run(compile_cmd, check=True)
        print("Compilation successful.")
    except subprocess.CalledProcessError:
        print("ERROR: Swift compilation failed.")
        sys.exit(1)

    # 3. Create Info.plist
    info_plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Nightdrive</string>
    <key>CFBundleIdentifier</key>
    <string>com.nightdrive.wallpaper</string>
    <key>CFBundleName</key>
    <string>NIGHTDRIVE</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>LSUIElement</key>
    <true/> <!-- Hides the app from the Dock, ideal for wallpapers -->
</dict>
</plist>
"""
    with open(os.path.join(contents_dir, "Info.plist"), "w") as f:
        f.write(info_plist)
    print("Generated Info.plist")

    # 4. Copy the web engine into the Resources folder
    engine_src = os.path.join("..", "..", "..", "engine")
    engine_dest = os.path.join(resources_dir, "engine")
    
    if not os.path.exists(engine_src):
        # Fallback to local engine copy if running from flat directory
        engine_src = os.path.join("..", "..", "engine")
        if not os.path.exists(engine_src):
            print(f"ERROR: Could not find engine directory at {engine_src}")
            sys.exit(1)
        
    if os.path.exists(engine_dest):
        shutil.rmtree(engine_dest)
        
    shutil.copytree(engine_src, engine_dest)
    print(f"Copied HTML engine to {engine_dest}")

    print("\nSUCCESS: NIGHTDRIVE.app has been built successfully!")
    print("You can launch it by double-clicking the app bundle or running:")
    print(f"open {app_name}")

if __name__ == "__main__":
    main()
