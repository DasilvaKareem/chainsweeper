#!/usr/bin/env python3
"""Slice nullcore.png (1536x1024, 5 cols x 3 rows) into 15 frames,
find the luminous center of each frame, crop a consistent square
around that centroid, downscale to 32x32, and pack into a 160x96
sprite sheet at public/assets/sprites/nullcore.png.

The content-aware centering keeps the swirl locked in place across
frames — an even slice of the source wobbles because each cell's
art isn't pixel-identical in position within its cell."""
from pathlib import Path
from PIL import Image

SRC = Path.home() / "Documents" / "nullcore.png"
OUT = Path(__file__).resolve().parent.parent / "public" / "assets" / "sprites" / "nullcore.png"
COLS, ROWS, TILE = 5, 3, 32
LUMA_THRESHOLD = 40  # pixels brighter than this count as content

src = Image.open(SRC).convert("RGBA")
cw, ch = src.width // COLS, src.height // ROWS
# Small enough that centroid ± half always fits inside a cell — avoids
# the clamping that caused frames to bob when the art sat near a cell edge.
CROP_SIDE = 220

def content_center(cell_img: Image.Image) -> tuple[int, int]:
    """Return (cx, cy) of the bright content in the cell."""
    gray = cell_img.convert("L")
    px = gray.load()
    w, h = gray.size
    sx = sy = n = 0
    for y in range(h):
        for x in range(w):
            if px[x, y] > LUMA_THRESHOLD:
                sx += x; sy += y; n += 1
    if n == 0:
        return w // 2, h // 2
    return sx // n, sy // n

sheet = Image.new("RGBA", (COLS * TILE, ROWS * TILE), (0, 0, 0, 0))
half = CROP_SIDE // 2
for r in range(ROWS):
    for c in range(COLS):
        cell = src.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))
        cx, cy = content_center(cell)
        # Absolute coords into the source; no clamping — padding is black,
        # so going slightly past the cell boundary is harmless and keeps
        # the swirl visually pinned across all 15 frames.
        x0 = c * cw + cx - half
        y0 = r * ch + cy - half
        frame = src.crop((x0, y0, x0 + CROP_SIDE, y0 + CROP_SIDE)).resize((TILE, TILE), Image.LANCZOS)
        sheet.paste(frame, (c * TILE, r * TILE))

OUT.parent.mkdir(parents=True, exist_ok=True)
sheet.save(OUT)
print(f"wrote {OUT} ({sheet.width}x{sheet.height})")
