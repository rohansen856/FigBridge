"""Builds the extension icon (media/icon.png, 256x256) from the brand logo.

The logo is wide (2416x1435) with black outlines, so it is centred on a white rounded square:
the outlines stay visible on dark Marketplace and Extensions-view backgrounds.
Usage: python3 make-icon.py media/brand/logo.png media/icon.png
"""
import sys
from PIL import Image, ImageDraw

SIZE, S = 256, 4  # output size, supersampling
src, out = sys.argv[1], sys.argv[2]
W = SIZE * S
canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ImageDraw.Draw(canvas).rounded_rectangle([0, 0, W - 1, W - 1], radius=56 * S, fill=(255, 255, 255, 255))
logo = Image.open(src).convert("RGBA")
target_w = int(W * 0.80)
logo = logo.resize((target_w, round(logo.height * target_w / logo.width)), Image.LANCZOS)
canvas.alpha_composite(logo, ((W - logo.width) // 2, (W - logo.height) // 2))
canvas.resize((SIZE, SIZE), Image.LANCZOS).save(out)
