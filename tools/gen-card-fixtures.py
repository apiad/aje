"""Synthetic card images for the OCR check and the smoke test's fake camera.

    uv run --with pillow python tools/gen-card-fixtures.py <outdir>

Every number is made up; each names a real bank code so the scanner's rule accepts it.
Writes card-NN.png (the card alone) and camera.mjpeg (a 1280x720 frame with the card where
the viewfinder's frame sits).
"""

import io
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf"]
NUMBERS = ["9227959900000001", "9225069912345678", "9227129987654321"]
W, H = 856, 540


def card(number, font, blur=0, tilt=0, glare=False):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):  # a dark diagonal-ish gradient, like the bank cards
        d.line([(0, y), (W, y)], fill=(28 + y // 12, 52 + y // 14, 88 + y // 10))
    d.text((48, 40), "BANCO", font=ImageFont.truetype(font, 34), fill=(210, 220, 235))
    d.rounded_rectangle((48, 130, 150, 205), 10, fill=(196, 170, 96))
    groups = " ".join(number[i:i + 4] for i in range(0, 16, 4))
    d.text((48, 300), groups, font=ImageFont.truetype(font, 58), fill=(236, 240, 246))
    d.text((48, 420), "VENCE 10/29", font=ImageFont.truetype(font, 26), fill=(190, 200, 215))
    if glare:
        band = Image.new("L", (W, H), 0)
        ImageDraw.Draw(band).polygon([(300, 0), (420, 0), (240, H), (120, H)], fill=70)
        img = Image.composite(Image.new("RGB", (W, H), (255, 255, 255)), img, band)
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    if tilt:
        img = img.rotate(tilt, resample=Image.BICUBIC, fillcolor=(20, 20, 20))
    return img


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    cases = []
    variants = [{}, {"blur": 1.2}, {"tilt": 4}, {"glare": True}]
    for i, (number, font, variant) in enumerate((n, f, v) for n in NUMBERS for f in FONTS[:1] for v in variants):
        path = out / f"card-{i:02d}.png"
        card(number, font, **variant).save(path)
        cases.append({"file": path.name, "number": number, **variant})
    # Frames for Chromium's fake camera: the card inside the viewfinder's frame (inset 14% x 7%).
    frame = Image.new("RGB", (1280, 720), (12, 10, 8))
    frame.paste(card(NUMBERS[0], FONTS[1]).resize((1101, 518)), (90, 101))
    buf = io.BytesIO()
    frame.save(buf, "JPEG", quality=90)
    (out / "camera.mjpeg").write_bytes(buf.getvalue() * 30)
    (out / "cases.json").write_text(json.dumps(cases, indent=1))
    print(f"{len(cases)} cards and camera.mjpeg in {out}")


if __name__ == "__main__":
    main()
