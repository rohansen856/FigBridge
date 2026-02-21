"""Draws the 256x256 extension icon (media/icon.png): a frame linked to a code bracket."""
import sys
from PIL import Image, ImageDraw

S = 4  # supersample
W = 256 * S
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=56 * S, fill=(30, 30, 46, 255))
# design frame (top-left) and code panel (bottom-right)
d.rounded_rectangle([40 * S, 40 * S, 128 * S, 128 * S], radius=14 * S, outline=(162, 89, 255, 255), width=12 * S)
d.rounded_rectangle([128 * S, 128 * S, 216 * S, 216 * S], radius=14 * S, fill=(10, 207, 131, 255))
# link from frame to panel
d.line([(128 * S, 84 * S), (172 * S, 84 * S), (172 * S, 128 * S)], fill=(242, 78, 30, 255), width=12 * S, joint="curve")
# </> on the code panel
c = (30, 30, 46, 255)
d.line([(160 * S, 156 * S), (146 * S, 172 * S), (160 * S, 188 * S)], fill=c, width=8 * S, joint="curve")
d.line([(184 * S, 156 * S), (198 * S, 172 * S), (184 * S, 188 * S)], fill=c, width=8 * S, joint="curve")
img.resize((256, 256), Image.LANCZOS).save(sys.argv[1])
