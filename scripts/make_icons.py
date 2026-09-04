from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SIZE = 512

img = Image.new("RGBA", (SIZE, SIZE), (17, 11, 24, 255))
pixels = img.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = (x + y) / (2 * (SIZE - 1))
        # very subtle purple tint in the background
        pixels[x, y] = (17 + int(8 * t), 11 + int(5 * t), 24 + int(15 * t), 255)

draw = ImageDraw.Draw(img)

def gradient_color(t):
    a = (255, 47, 156)
    b = (127, 61, 255)
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3)) + (255,)

# border
for i in range(8):
    c = gradient_color(i / 7)
    draw.rounded_rectangle((18 + i, 18 + i, SIZE - 19 - i, SIZE - 19 - i), radius=104 - i, outline=c, width=1)

# broken ring
for i in range(18):
    c = gradient_color(i / 17)
    draw.arc((96 + i//5, 86 + i//6, 416 - i//5, 426 - i//6), start=208, end=332, fill=c, width=3)
    draw.arc((96 + i//5, 86 + i//6, 416 - i//5, 426 - i//6), start=28, end=152, fill=c, width=3)

font_candidates = [
    Path("C:/Windows/Fonts/segoeuib.ttf"),
    Path("C:/Windows/Fonts/arialbd.ttf"),
]
font = None
for candidate in font_candidates:
    if candidate.exists():
        font = ImageFont.truetype(str(candidate), 102)
        break
if font is None:
    font = ImageFont.load_default()

text = "TuneC"
bbox = draw.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
text_mask = Image.new("L", (SIZE, SIZE), 0)
mask_draw = ImageDraw.Draw(text_mask)
mask_draw.text(((SIZE - tw) / 2, (SIZE - th) / 2 - 10), text, font=font, fill=255)
text_gradient = Image.new("RGBA", (SIZE, SIZE))
tp = text_gradient.load()
for x in range(SIZE):
    c = gradient_color(x / (SIZE - 1))
    for y in range(SIZE):
        tp[x, y] = c
img.alpha_composite(Image.composite(text_gradient, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), text_mask))

build_dir = ROOT / "build"
build_dir.mkdir(parents=True, exist_ok=True)
img.save(build_dir / "icon.ico", sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])

# App UI icon
app_icon = ROOT / "electron" / "assets" / "icon.png"
app_icon.parent.mkdir(parents=True, exist_ok=True)
img.save(app_icon, format="PNG", optimize=True)

# Browser-extension icons
for folder in [ROOT / "extension" / "icons", ROOT / "extension-firefox" / "icons"]:
    folder.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        out = img.resize((size, size), Image.Resampling.LANCZOS)
        out.save(folder / f"icon{size}.png", format="PNG", optimize=True)
