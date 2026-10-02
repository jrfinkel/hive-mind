"""Detect faces in photos_raw/, save hi-res crops + numbered contact sheets."""
import glob
import os
import sys

import cv2
from PIL import Image, ImageDraw

RAW = "photos_raw"
HI = "faces_hi"
os.makedirs(HI, exist_ok=True)

cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

paths = sorted(
    p
    for p in glob.glob(f"{RAW}/*")
    if p.lower().endswith((".jpg", ".jpeg", ".png"))
)

faces = []  # (crop_path)
for path in paths:
    img = cv2.imread(path)
    if img is None:
        continue
    h, w = img.shape[:2]
    scale = min(1.0, 1600 / max(h, w))
    small = cv2.resize(img, (int(w * scale), int(h * scale)))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    dets = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=6, minSize=(36, 36))
    stem = os.path.splitext(os.path.basename(path))[0].replace(" ", "_")
    for i, (x, y, fw, fh) in enumerate(dets):
        # back to original coords, with 55% margin around the face
        x0, y0, x1, y1 = x / scale, y / scale, (x + fw) / scale, (y + fh) / scale
        mx, my = (x1 - x0) * 0.55, (y1 - y0) * 0.55
        cx0, cy0 = max(0, int(x0 - mx)), max(0, int(y0 - my))
        cx1, cy1 = min(w, int(x1 + mx)), min(h, int(y1 + my))
        crop = img[cy0:cy1, cx0:cx1]
        if crop.size == 0:
            continue
        out = f"{HI}/{len(faces):03d}__{stem}.jpg"
        cv2.imwrite(out, crop)
        faces.append(out)

print(f"{len(paths)} photos, {len(faces)} faces detected")

# contact sheets: 8 cols, 140px cells, numbered
COLS, CELL = 8, 140
per_sheet = COLS * 6
for s in range(0, len(faces), per_sheet):
    batch = faces[s : s + per_sheet]
    rows = (len(batch) + COLS - 1) // COLS
    sheet = Image.new("RGB", (COLS * CELL, rows * (CELL + 18)), "black")
    d = ImageDraw.Draw(sheet)
    for j, fp in enumerate(batch):
        im = Image.open(fp)
        im.thumbnail((CELL - 4, CELL - 4))
        cx, cy = (j % COLS) * CELL, (j // COLS) * (CELL + 18)
        sheet.paste(im, (cx + 2, cy + 2))
        d.text((cx + 4, cy + CELL + 2), str(s + j), fill="yellow")
    sheet.save(f"/tmp/sheet_{s // per_sheet}.png")
    print(f"/tmp/sheet_{s // per_sheet}.png ({len(batch)} faces)")
