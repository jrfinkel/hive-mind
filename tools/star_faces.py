"""Cut selected Chris faces into many-pointed star PNGs, duotoned to match
the terminal aesthetic (green/amber on transparent), for use as backgrounds."""
import glob
import math
import os
import random

from PIL import Image, ImageDraw, ImageOps

# Face ids confirmed as Chris Manning from the contact sheets.
# One id per source photo (duplicate detections of the same shot excluded).
CHRIS = [
    4, 10, 17, 20, 31, 50, 78, 99, 101, 111, 114, 120, 128, 139,
    160, 168, 170, 175, 192, 211, 216, 218, 223, 229, 231, 233, 238,
    250, 252, 260, 269, 279, 288, 295, 303, 308, 316, 321, 330, 333, 338,
]

OUT = "public/faces"
os.makedirs(OUT, exist_ok=True)

SIZE = 400          # output png size
POINTS = 14         # star points ("many points")
INNER = 0.80        # inner/outer radius ratio — high = badge/burst look
SS = 4              # supersample factor for smooth star edges

# Phosphor-bright palette, cycled across the faces.
PALETTE = [
    (43, 255, 111),   # green
    (255, 176, 0),    # amber
    (64, 220, 255),   # cyan
    (255, 92, 230),   # magenta
    (255, 80, 80),    # red
    (130, 150, 255),  # blue
    (255, 235, 70),   # yellow
    (255, 130, 40),   # orange
]


def star_mask(size: int, rot_deg: float) -> Image.Image:
    big = size * SS
    m = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(m)
    cx = cy = big / 2
    R = big / 2 - SS  # leave a hair of padding
    r = R * INNER
    pts = []
    rot = math.radians(rot_deg)
    for i in range(POINTS * 2):
        rad = R if i % 2 == 0 else r
        a = rot + i * math.pi / POINTS - math.pi / 2
        pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    d.polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def duotone(img: Image.Image, color: tuple) -> Image.Image:
    """Map grayscale to black→color, like a phosphor monitor."""
    g = ImageOps.autocontrast(img.convert("L"), cutoff=2)
    return Image.merge(
        "RGB",
        [g.point([int(c * (i / 255) ** 1.1) for i in range(256)]) for c in color],
    )


random.seed(42)
made = []
for n, fid in enumerate(CHRIS):
    matches = glob.glob(f"faces_hi/{fid:03d}__*.jpg")
    if not matches:
        print(f"missing face {fid}")
        continue
    img = Image.open(matches[0])
    # square center crop
    w, h = img.size
    side = min(w, h)
    img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    color = PALETTE[n % len(PALETTE)]
    img = duotone(img, color)
    rot = random.uniform(-14, 14)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (0, 0), star_mask(SIZE, rot))
    path = f"{OUT}/star{n}.png"
    out.save(path, optimize=True)
    made.append(path)
    print(path, os.path.getsize(path) // 1024, "KB")

# preview grid
cell = SIZE // 2
cols = 8
rows = (len(made) + cols - 1) // cols
grid = Image.new("RGBA", (cell * cols, cell * rows), (10, 10, 10, 255))
for i, p in enumerate(made):
    im = Image.open(p).resize((cell, cell))
    grid.paste(im, ((i % cols) * cell, (i // cols) * cell), im)
grid.convert("RGB").save("/tmp/star_preview.png")
print("/tmp/star_preview.png")
