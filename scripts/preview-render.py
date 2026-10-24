#!/usr/bin/env python3
"""
NIGHTDRIVE — offline compositor & UI layout verification renderer.

Reproduces the engine's exact CSS cover geometry, 1:1 coordinate-locked screen
headlights, soft-light colour temperature, unclipped translucent sky clock
clamped above the measured ridge (`ridges.json`), taskbar-safe bottom dock, and
left frosted Quick Settings drawer at both 1920x1080 and 1366x768.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "engine" / "assets"
OUT = ROOT / "docs" / "preview"

CT = {
    "morning": (150, 190, 235, 0.00),
    "day": (255, 252, 244, 0.00),
    "golden-hour": (214, 160, 92, 0.07),
    "dusk": (92, 108, 162, 0.08),
    "night": (64, 96, 154, 0.08),
    "midnight": (38, 58, 104, 0.10),
}
FOCUS = {
    "morning": (0.62, 0.74),
    "day": (0.62, 0.74),
    "golden-hour": (0.62, 0.74),
    "dusk": (0.58, 0.74),
    "night": (0.58, 0.74),
    "midnight": (0.58, 0.74),
}
HEADLIGHT_PERIODS = {"dusk", "night", "midnight"}
HEADLIGHT_OPACITY = 0.76 * (75.0 / 85.0)


def cover(im: Image.Image, w: int, h: int, fx: float = 0.58, fy: float = 0.74) -> Image.Image:
    sw, sh = im.size
    s = max(w / sw, h / sh)
    nw, nh = round(sw * s), round(sh * s)
    im_r = im.resize((nw, nh), Image.LANCZOS)
    left = round((nw - w) * fx)
    top = round((nh - h) * fy)
    return im_r.crop((left, top, left + w, top + h))


def screen(base: np.ndarray, top: np.ndarray) -> np.ndarray:
    return 255.0 - (255.0 - base) * (255.0 - top) / 255.0


def soft_light(base: np.ndarray, blend: np.ndarray) -> np.ndarray:
    d = base
    return np.where(
        blend <= 0.5,
        d - (1.0 - 2.0 * blend) * d * (1.0 - d),
        d + (2.0 * blend - 1.0) * (np.where(d <= 0.25, ((16.0 * d - 12.0) * d + 4.0) * d, np.sqrt(d)) - d),
    )


def load_ui_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
        if bold
        else [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]
    )
    for c in candidates:
        if Path(c).exists():
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def draw_frosted_box(
    canvas: Image.Image,
    box: tuple[int, int, int, int],
    radius: int,
    tint_rgba: tuple[int, int, int, int],
    border_rgba: tuple[int, int, int, int] = (255, 255, 255, 32),
    blur_px: int = 16,
) -> Image.Image:
    x0, y0, x1, y1 = box
    crop = canvas.crop((max(0, x0), max(0, y0), min(canvas.width, x1), min(canvas.height, y1)))
    blurred = crop.filter(ImageFilter.GaussianBlur(radius=blur_px)).convert("RGBA")

    overlay = Image.new("RGBA", blurred.size, tint_rgba)
    frosted = Image.alpha_composite(blurred, overlay)

    mask = Image.new("L", blurred.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, blurred.width - 1, blurred.height - 1), radius=radius, fill=255)

    out = canvas.convert("RGBA")
    out.paste(frosted, (max(0, x0), max(0, y0)), mask)
    d = ImageDraw.Draw(out)
    d.rounded_rectangle(box, radius=radius, outline=border_rgba, width=1)
    return out.convert("RGB")


def draw_reference_clock(canvas: Image.Image, w: int, h: int, skyline_norm: float, fx: float, fy: float) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """
    Render the tall condensed translucent clock + editorial date using the exact
    `placeClock()` clamping math from engine/script.js.
    """
    scale_cover = max(w / 1376.0, h / 768.0)
    pw, ph = 1376.0 * scale_cover, 768.0 * scale_cover
    ptop = (h - ph) * fy
    skyline_px = ptop + skyline_norm * ph

    num_px = min(148.0, max(78.0, w * 0.118))
    date_px = min(20.0, max(14.0, w * 0.0132))
    half_box = (num_px * 0.90 + date_px + 10.0) * 0.5

    desired_y = h * 0.225
    min_safe = 22.0 + half_box
    max_safe = max(min_safe, skyline_px - half_box - 22.0)
    center_y = max(min_safe, min(max_safe, desired_y))

    # Render tall condensed numerals via vertical supersampling (1.42x height ratio
    # matching Oswald condensed geometry).
    raw_font = load_ui_font(int(round(num_px * 0.76)), bold=True)
    tmp = Image.new("RGBA", (int(w * 0.6), int(num_px * 1.4)), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    time_txt = "12:52"
    tb = td.textbbox((0, 0), time_txt, font=raw_font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    td.text((-tb[0], -tb[1]), time_txt, font=raw_font, fill=(255, 255, 255, 255))
    glyph = tmp.crop((0, 0, tw, th))
    # Condense horizontally (0.76x) + tall vertical stretch (1.26x) for crisp Oswald look
    cw = int(round(tw * 0.78))
    ch = int(round(th * 1.24))
    glyph = glyph.resize((cw, ch), Image.LANCZOS)

    g_arr = np.asarray(glyph, dtype=np.float32)
    alpha = g_arr[:, :, 3] / 255.0
    t_grad = np.linspace(0.0, 1.0, ch, dtype=np.float32)[:, None]
    # Vertical translucent sky glass gradient from styles.css
    r_col = 248.0 * (1 - t_grad) + 170.0 * t_grad
    g_col = 251.0 * (1 - t_grad) + 198.0 * t_grad
    b_col = 255.0 * (1 - t_grad) + 236.0 * t_grad
    a_col = (0.97 * (1 - t_grad * 0.40)) * 0.90 * alpha

    grad_rgba = np.dstack([
        np.broadcast_to(r_col, (ch, cw)),
        np.broadcast_to(g_col, (ch, cw)),
        np.broadcast_to(b_col, (ch, cw)),
        a_col * 255.0,
    ]).astype(np.uint8)
    clock_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    date_font = load_ui_font(int(round(date_px)), bold=False)
    dd = ImageDraw.Draw(clock_layer)
    date_txt = "Sat, Oct 24 · 2026"
    db = dd.textbbox((0, 0), date_txt, font=date_font)
    dw, dh = db[2] - db[0], db[3] - db[1]

    total_h = dh + 8 + ch
    top_y = int(round(center_y - total_h / 2.0))
    dd.text(((w - dw) // 2, top_y), date_txt, font=date_font, fill=(235, 243, 255, 224))

    gx = (w - cw) // 2
    gy = top_y + dh + 8
    clock_layer.paste(Image.fromarray(grad_rgba, "RGBA"), (gx, gy), Image.fromarray(grad_rgba, "RGBA"))

    out = Image.alpha_composite(canvas.convert("RGBA"), clock_layer).convert("RGB")
    return out, (gx, top_y, gx + cw, gy + ch)


def draw_bottom_dock_and_drawer(
    canvas: Image.Image, w: int, h: int, show_drawer: bool = False, show_taskbar: bool = False
) -> Image.Image:
    taskbar_h = 48
    safe_bottom = 50 if h <= 800 else 52
    dock_y1 = h - safe_bottom
    dock_y0 = dock_y1 - 38

    # Bottom status pill + compact music bar
    pill_w = 166
    music_w = 248
    total_w = pill_w + 10 + music_w
    sx = (w - total_w) // 2

    canvas = draw_frosted_box(canvas, (sx, dock_y0, sx + pill_w, dock_y1), 19, (10, 15, 28, 178))
    canvas = draw_frosted_box(canvas, (sx + pill_w + 10, dock_y0, sx + total_w, dock_y1), 19, (10, 15, 28, 178))

    d = ImageDraw.Draw(canvas)
    f_sm = load_ui_font(13, bold=True)
    f_xs = load_ui_font(11, bold=False)
    d.text((sx + 20, dock_y0 + 11), "20°C   |   83%", font=f_sm, fill=(242, 247, 255))
    mx = sx + pill_w + 24
    d.text((mx, dock_y0 + 6), "No media playing", font=f_xs, fill=(242, 247, 255))
    d.text((mx, dock_y0 + 20), "Windows Media / Audio", font=load_ui_font(9), fill=(154, 170, 198))
    d.text((sx + total_w - 66, dock_y0 + 11), "|<  >  >|", font=f_xs, fill=(208, 226, 255))

    if show_drawer:
        pad = 10 if h <= 800 else 14
        dw = 340 if h <= 800 else 352
        dy0, dy1 = pad, h - safe_bottom - 6
        canvas = draw_frosted_box(canvas, (pad, dy0, pad + dw, dy1), 22, (11, 16, 28, 192), (255, 255, 255, 38), blur_px=22)

        # Cards inside drawer
        cards = [
            (pad + 12, dy0 + 48, pad + dw // 2 - 4, dy0 + 96),
            (pad + dw // 2 + 4, dy0 + 48, pad + dw - 12, dy0 + 96),
            (pad + 12, dy0 + 106, pad + dw - 12, dy0 + 162),
            (pad + 12, dy0 + 172, pad + dw - 12, dy0 + 278),
            (pad + 12, dy0 + 288, pad + dw - 12, dy0 + 408),
            (pad + 12, dy0 + 418, pad + dw // 2 - 4, dy0 + 474),
            (pad + dw // 2 + 4, dy0 + 418, pad + dw - 12, dy0 + 474),
        ]
        for cb in cards:
            if cb[3] < dy1 - 68:
                canvas = draw_frosted_box(canvas, cb, 14, (255, 255, 255, 16), (255, 255, 255, 28), blur_px=4)

        d = ImageDraw.Draw(canvas)
        d.text((pad + 16, dy0 + 16), "NIGHTDRIVE", font=load_ui_font(12, bold=True), fill=(244, 248, 255))
        d.text((pad + dw - 72, dy0 + 15), "⚙  📌  ✕", font=load_ui_font(12), fill=(205, 218, 240))
        d.text((pad + 24, dy0 + 58), "Wi-Fi / Net", font=load_ui_font(11, bold=True), fill=(244, 248, 255))
        d.text((pad + 24, dy0 + 74), "Connected", font=load_ui_font(10), fill=(130, 182, 255))
        d.text((pad + dw // 2 + 16, dy0 + 58), "Bluetooth", font=load_ui_font(11, bold=True), fill=(244, 248, 255))
        d.text((pad + dw // 2 + 16, dy0 + 74), "On", font=load_ui_font(10), fill=(130, 182, 255))
        d.text((pad + 22, dy0 + 114), "AUDIO                                          70%", font=load_ui_font(10, bold=True), fill=(170, 186, 214))
        d.rounded_rectangle((pad + 24, dy0 + 138, pad + dw - 54, dy0 + 144), radius=3, fill=(79, 134, 247))
        d.text((pad + 22, dy0 + 182), "MUSIC                                 Windows SMTC", font=load_ui_font(10, bold=True), fill=(170, 186, 214))
        d.text((pad + 22, dy0 + 204), "Midnight City · M83", font=load_ui_font(12, bold=True), fill=(244, 248, 255))
        d.rounded_rectangle((pad + 22, dy0 + 232, pad + dw - 24, dy0 + 236), radius=2, fill=(60, 76, 104))
        d.rounded_rectangle((pad + 22, dy0 + 232, pad + 168, dy0 + 236), radius=2, fill=(110, 162, 255))
        d.text((pad + 112, dy0 + 248), "|<     ||     >|", font=load_ui_font(12, bold=True), fill=(244, 248, 255))
        d.text((pad + 22, dy0 + 298), "SCENE & TIME                           Schedule…", font=load_ui_font(10, bold=True), fill=(170, 186, 214))
        d.text((pad + 22, dy0 + 322), "<         Cascade Overlook · Night         >", font=load_ui_font(11, bold=True), fill=(244, 248, 255))
        d.text((pad + 22, dy0 + 352), "[Auto by time]   [Lights: Auto]   [Motion]", font=load_ui_font(10), fill=(190, 212, 255))
        if dy0 + 470 < dy1 - 68:
            d.text((pad + 22, dy0 + 432), "Wallpaper Studio", font=load_ui_font(11, bold=True), fill=(244, 248, 255))
            d.text((pad + 22, dy0 + 450), "12 scenes + Search", font=load_ui_font(9), fill=(175, 195, 228))
            d.text((pad + dw // 2 + 14, dy0 + 432), "Car Studio", font=load_ui_font(11, bold=True), fill=(244, 248, 255))
            d.text((pad + dw // 2 + 14, dy0 + 450), "4 vehicles + Lights", font=load_ui_font(9), fill=(175, 195, 228))

        # Footer primary button
        canvas = draw_frosted_box(canvas, (pad + 12, dy1 - 56, pad + dw - 12, dy1 - 28), 10, (79, 134, 247, 225), (154, 190, 255, 120), blur_px=2)
        d = ImageDraw.Draw(canvas)
        d.text((pad + dw // 2 - 52, dy1 - 49), "Studio & Settings", font=load_ui_font(11, bold=True), fill=(255, 255, 255))

    if show_taskbar:
        canvas = draw_frosted_box(canvas, (0, h - taskbar_h, w, h), 0, (8, 11, 18, 228), (255, 255, 255, 24), blur_px=14)
        d = ImageDraw.Draw(canvas)
        d.text((w // 2 - 68, h - 31), "⊞   🔍   🗂   🌐   🎵", font=load_ui_font(13), fill=(210, 222, 242))
        d.text((w - 94, h - 34), "12:52\n24-10-2026", font=load_ui_font(10), fill=(210, 222, 242))

    return canvas


def render_stage(period: str, w: int = 1920, h: int = 1080) -> Image.Image:
    fx, fy = FOCUS[period]
    plate = cover(Image.open(ASSETS / period / "scene.jpg").convert("RGB"), w, h, fx, fy)
    base = np.asarray(plate, dtype=np.float32)

    if period in HEADLIGHT_PERIODS:
        hl_path = ASSETS / period / "headlights.jpg"
        if hl_path.exists():
            beams = cover(Image.open(hl_path).convert("RGB"), w, h, fx, fy)
            base = screen(base, np.asarray(beams, dtype=np.float32) * HEADLIGHT_OPACITY)

    r, g, b, a = CT[period]
    if a > 0:
        backdrop = base / 255.0
        blend = soft_light(backdrop, np.array([r, g, b], np.float32) / 255.0)
        base = (backdrop * (1.0 - a) + blend * a) * 255.0

    return Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    ridges = json.loads((ASSETS / "ridges.json").read_text())

    for period in ("morning", "day", "golden-hour", "dusk", "night", "midnight"):
        img = render_stage(period, 1920, 1080)
        dest = OUT / f"{period}.jpg"
        img.save(dest, quality=92, subsampling=0, optimize=True, progressive=True)
        lum = np.asarray(img.convert("L"), dtype=np.float32)
        print(f"  {period:12s} 1920x1080 stage -> {dest.relative_to(ROOT)} (mean luma {lum.mean():.1f}, {dest.stat().st_size // 1024} KB)")

    # Render full UI verification screenshots at 1366x768 (with Windows taskbar) & 1920x1080!
    night_ridge = min(pt[1] for pt in ridges["night"]["ridge"] if 0.30 <= pt[0] <= 0.70)

    # 1. 1366x768 closed drawer + Windows taskbar clearance check
    s_1366 = render_stage("night", 1366, 768)
    s_1366, cbox_1366 = draw_reference_clock(s_1366, 1366, 768, night_ridge, 0.58, 0.74)
    s_1366_closed = draw_bottom_dock_and_drawer(s_1366.copy(), 1366, 768, show_drawer=False, show_taskbar=True)
    s_1366_closed.save("/tmp/verify-1366x768-desktop.jpg", quality=94, subsampling=0)

    # 2. 1366x768 open Quick Settings drawer + Windows taskbar clearance check
    s_1366_open = draw_bottom_dock_and_drawer(s_1366.copy(), 1366, 768, show_drawer=True, show_taskbar=True)
    s_1366_open.save("/tmp/verify-1366x768-drawer.jpg", quality=94, subsampling=0)

    # 3. 1920x1080 full reference view matching image-1.png
    s_1080 = render_stage("night", 1920, 1080)
    s_1080, cbox_1080 = draw_reference_clock(s_1080, 1920, 1080, night_ridge, 0.58, 0.74)
    s_1080_open = draw_bottom_dock_and_drawer(s_1080, 1920, 1080, show_drawer=True, show_taskbar=False)
    s_1080_open.save("/tmp/verify-1920x1080-reference.jpg", quality=94, subsampling=0)

    print(f"  1366x768 clock bbox={cbox_1366}, ridge_px={768 * night_ridge:.1f} (clearance={768 * night_ridge - cbox_1366[3]:.1f}px)")
    print(f"  1920x1080 clock bbox={cbox_1080}, ridge_px={1080 * night_ridge:.1f} (clearance={1080 * night_ridge - cbox_1080[3]:.1f}px)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
