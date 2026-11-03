#!/usr/bin/env python3
"""Pillow helpers for the studio.

  img.py fit <in> <out> <W> <H>                 center-crop to W:H, resize to W x H (Lanczos)
  img.py sheet <out.jpg> <cols> <thumbW> <label=file> ...   contact sheet with a caption under each image
  img.py probe <file>                           {"width": .., "height": ..}
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def fit(src, dst, w, h):
    im = Image.open(src).convert("RGB")
    target = w / h
    sw, sh = im.size
    if sw / sh > target:
        nw = round(sh * target)
        box = ((sw - nw) // 2, 0, (sw - nw) // 2 + nw, sh)
    else:
        nh = round(sw / target)
        box = (0, (sh - nh) // 2, sw, (sh - nh) // 2 + nh)
    im.crop(box).resize((w, h), Image.LANCZOS).save(dst)


def font(size):
    for name in ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheet(dst, cols, thumb_w, items):
    ims = []
    for item in items:
        label, _, path = item.partition("=")
        im = Image.open(path).convert("RGB")
        ratio = thumb_w / im.width
        ims.append((label, im.resize((thumb_w, round(im.height * ratio)), Image.LANCZOS)))
    th = max(im.height for _, im in ims)
    pad, cap = 12, 34
    rows = (len(ims) + cols - 1) // cols
    out = Image.new("RGB", (cols * (thumb_w + pad) + pad, rows * (th + cap + pad) + pad), (18, 18, 22))
    d = ImageDraw.Draw(out)
    f = font(20)
    for i, (label, im) in enumerate(ims):
        x = pad + (i % cols) * (thumb_w + pad)
        y = pad + (i // cols) * (th + cap + pad)
        out.paste(im, (x, y))
        d.text((x + 4, y + th + 6), label, fill=(235, 235, 240), font=f)
    out.save(dst, quality=88)


def main():
    cmd, *args = sys.argv[1:]
    if cmd == "fit":
        fit(args[0], args[1], int(args[2]), int(args[3]))
    elif cmd == "sheet":
        sheet(args[0], int(args[1]), int(args[2]), args[3:])
    elif cmd == "probe":
        im = Image.open(args[0])
        print(json.dumps({"width": im.width, "height": im.height}))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
