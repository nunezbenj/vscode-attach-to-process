"""Generates images/icon.png (256x256). Run: python3 generate_icon.py"""
from PIL import Image, ImageDraw

SIZE = 256
S = SIZE / 128
s = lambda v: round(v * S)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Background gradient, same family as the Evaluate extension
for y in range(s(4), s(124)):
    t = (y - s(4)) / s(120)
    d.line([(s(4), y), (s(123), y)], fill=(int(43 + (26 - 43) * t), int(94 + (58 - 94) * t), int(167 + (110 - 167) * t), 255))
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([s(4), s(4), s(124), s(124)], radius=s(20), fill=255)
img.putalpha(mask)
d = ImageDraw.Draw(img)

WHITE = (240, 244, 250, 255)
DARK = (27, 40, 56, 255)
EDGE = (61, 90, 128, 255)
RED = (232, 76, 61, 255)

# Cable from the left edge, curving into the plug
pts = [(s(10), s(96)), (s(22), s(96)), (s(32), s(80)), (s(38), s(64))]
d.line(pts, fill=WHITE, width=s(5), joint="curve")
# Plug body + prongs (pointing right)
d.rounded_rectangle([s(30), s(52), s(58), s(76)], radius=s(5), fill=WHITE)
d.rectangle([s(58), s(57), s(70), s(61)], fill=WHITE)
d.rectangle([s(58), s(67), s(70), s(71)], fill=WHITE)

# The running process: a terminal-ish window with a prompt and a breakpoint
d.rounded_rectangle([s(72), s(30), s(116), s(98)], radius=s(7), fill=DARK, outline=EDGE, width=max(1, s(1.5)))
d.rounded_rectangle([s(72), s(30), s(116), s(41)], radius=s(7), fill=EDGE)
d.rectangle([s(72), s(36), s(116), s(41)], fill=EDGE)
# code lines
for i, (x1, x2) in enumerate([(80, 104), (84, 110), (84, 98), (80, 106)]):
    y = s(50 + i * 11)
    col = WHITE if i != 2 else (255, 205, 120, 255)
    d.rounded_rectangle([s(x1), y, s(x2), y + s(4)], radius=s(2), fill=col)
# breakpoint dot on the highlighted line
d.ellipse([s(75), s(70), s(81), s(76)], fill=RED)
# socket holes on the window's left edge where the prongs go
d.rectangle([s(72), s(57), s(76), s(61)], fill=WHITE)
d.rectangle([s(72), s(67), s(76), s(71)], fill=WHITE)

img.save("images/icon.png")
print("wrote images/icon.png")
