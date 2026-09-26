#!/bin/bash
echo "=============================================="
echo "  NIGHTDRIVE — Linux Installer"
echo "=============================================="
echo ""

# Detect package manager and install dependencies
if command -v apt-get &> /dev/null; then
    echo "[1/3] Installing system dependencies (apt)..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq python3 python3-pip python3-pyqt5 python3-pyqt5.qtwebengine
elif command -v dnf &> /dev/null; then
    echo "[1/3] Installing system dependencies (dnf)..."
    sudo dnf install -y python3 python3-pip python3-qt5 python3-qt5-webengine
elif command -v pacman &> /dev/null; then
    echo "[1/3] Installing system dependencies (pacman)..."
    sudo pacman -Sy --noconfirm python python-pip python-pyqt5 python-pyqtwebengine
else
    echo "[1/3] Could not detect package manager. Installing via pip..."
    pip3 install --user PyQt5 PyQtWebEngine
fi

echo "[2/3] Installing Python dependencies..."
pip3 install --user psutil 2>/dev/null || pip install --user psutil 2>/dev/null

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIGHTDRIVE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "[3/3] Creating desktop entry..."
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/nightdrive.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=NIGHTDRIVE
Comment=Cinematic time-aware automotive wallpaper
Exec=python3 $SCRIPT_DIR/nightdrive.py
Icon=preferences-desktop-wallpaper
Terminal=false
Categories=Utility;
StartupNotify=false
X-GNOME-Autostart-enabled=true
EOF

# Also copy to autostart so it launches on login
mkdir -p "$HOME/.config/autostart"
cp "$HOME/.local/share/applications/nightdrive.desktop" "$HOME/.config/autostart/"

echo ""
echo "=============================================="
echo "  INSTALLATION COMPLETE!"
echo "=============================================="
echo ""
echo "  To run now:  python3 $SCRIPT_DIR/nightdrive.py"
echo ""
echo "  NIGHTDRIVE has been added to:"
echo "    • Applications menu"
echo "    • Startup applications (runs on login)"
echo ""
echo "  To uninstall, delete this folder and remove:"
echo "    ~/.local/share/applications/nightdrive.desktop"
echo "    ~/.config/autostart/nightdrive.desktop"
echo "=============================================="
