import os
import shutil
import subprocess
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, "build")
ICONSET_DIR = os.path.join(BUILD_DIR, "icon.iconset")
PUBLIC_ICONS = os.path.join(ROOT, "public", "icons")

os.makedirs(BUILD_DIR, exist_ok=True)
os.makedirs(ICONSET_DIR, exist_ok=True)
os.makedirs(PUBLIC_ICONS, exist_ok=True)


def draw_ketabkhan_icon(size: int) -> Image.Image:
    # Draw at 2x supersampling then downsample with Lanczos for crisp anti-aliased edges
    s = size * 2
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Outer squircle background (warm mahogany #9a5b13)
    margin = int(s * 0.04)
    radius = int(s * 0.22)
    draw.rounded_rectangle(
        [margin, margin, s - margin, s - margin],
        radius=radius,
        fill=(154, 91, 19, 255),
    )

    # Subtle inner border highlight
    inset = int(s * 0.065)
    draw.rounded_rectangle(
        [inset, inset, s - inset, s - inset],
        radius=int(s * 0.19),
        outline=(214, 158, 92, 95),
        width=max(2, int(s * 0.008)),
    )

    # Book shadow
    bx1, by1 = int(s * 0.24), int(s * 0.20)
    bx2, by2 = int(s * 0.77), int(s * 0.80)
    sh = int(s * 0.022)
    draw.rounded_rectangle(
        [bx1 + sh, by1 + sh, bx2 + sh, by2 + sh],
        radius=int(s * 0.055),
        fill=(48, 25, 4, 110),
    )

    # Cream book cover (#fdfbf7)
    draw.rounded_rectangle(
        [bx1, by1, bx2, by2],
        radius=int(s * 0.055),
        fill=(253, 251, 247, 255),
    )

    # Book spine strip on left
    spine_x1 = int(s * 0.31)
    spine_x2 = spine_x1 + max(4, int(s * 0.026))
    draw.rectangle([spine_x1, by1, spine_x2, by2], fill=(125, 72, 12, 255))

    # Subtle typography lines on page
    line_x1 = int(s * 0.39)
    line_y = int(s * 0.38)
    line_h = max(3, int(s * 0.024))
    for w_frac in (0.27, 0.22, 0.25):
        draw.rounded_rectangle(
            [line_x1, line_y, line_x1 + int(s * w_frac), line_y + line_h],
            radius=line_h // 2,
            fill=(154, 91, 19, 70),
        )
        line_y += int(s * 0.065)

    # Golden bookmark ribbon (#f59e0b)
    rx = int(s * 0.59)
    rw = int(s * 0.10)
    rh = int(s * 0.24)
    draw.polygon(
        [
            (rx, by1),
            (rx + rw, by1),
            (rx + rw, by1 + rh),
            (rx + rw // 2, by1 + int(rh * 0.72)),
            (rx, by1 + rh),
        ],
        fill=(245, 158, 11, 255),
    )

    return img.resize((size, size), Image.Resampling.LANCZOS)


base_1024 = draw_ketabkhan_icon(1024)
icon_png_path = os.path.join(BUILD_DIR, "icon.png")
base_1024.save(icon_png_path, "PNG")

# Windows multi-size .ico
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
base_1024.save(os.path.join(BUILD_DIR, "icon.ico"), format="ICO", sizes=ico_sizes)

# macOS .iconset -> .icns
iconset_specs = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
for fname, px in iconset_specs:
    resized = base_1024 if px == 1024 else base_1024.resize((px, px), Image.Resampling.LANCZOS)
    resized.save(os.path.join(ICONSET_DIR, fname), "PNG")

icns_path = os.path.join(BUILD_DIR, "icon.icns")
if shutil.which("iconutil"):
    subprocess.run(["iconutil", "-c", "icns", ICONSET_DIR, "-o", icns_path], check=True)
    shutil.rmtree(ICONSET_DIR, ignore_errors=True)

# PWA / Web icons
base_1024.resize((192, 192), Image.Resampling.LANCZOS).save(os.path.join(PUBLIC_ICONS, "icon-192.png"), "PNG")
base_1024.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(PUBLIC_ICONS, "icon-512.png"), "PNG")

print("Generated icon.png, icon.ico, icon.icns, icon-192.png, icon-512.png")
