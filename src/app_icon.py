# -*- coding: utf-8 -*-
"""程序图标：全部在运行时用 Pillow 绘制，不依赖任何外部资源文件。"""

from PIL import Image, ImageDraw, ImageFont

BRAND = (77, 107, 254, 255)      # DeepSeek 蓝
BRAND_DARK = (40, 62, 190, 255)
WHITE = (255, 255, 255, 255)


def _font(size):
    """拿一个可用的粗体字体，找不到就退化成 Pillow 默认字体。"""
    for name in ("arialbd.ttf", "segoeuib.ttf", "Arial Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def make_icon(size=256):
    """画一个圆角方块 + 字母 D 的图标。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(size * 0.06)
    radius = int(size * 0.24)

    # 渐变底：用横向叠色近似
    for i in range(size):
        r = int(BRAND[0] + (BRAND_DARK[0] - BRAND[0]) * i / max(size - 1, 1))
        g = int(BRAND[1] + (BRAND_DARK[1] - BRAND[1]) * i / max(size - 1, 1))
        b = int(BRAND[2] + (BRAND_DARK[2] - BRAND[2]) * i / max(size - 1, 1))
        d.line([(i, 0), (i, size)], fill=(r, g, b, 255))

    # 把渐变裁成圆角方块
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [pad, pad, size - pad, size - pad], radius=radius, fill=255
    )
    img.putalpha(mask)

    # 白色字母 D
    d = ImageDraw.Draw(img)
    font = _font(int(size * 0.62))
    text = "D"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(
        ((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1] - size * 0.02),
        text,
        font=font,
        fill=WHITE,
    )

    # 右下角一个小圆点，做个辨识度
    r = size * 0.075
    cx, cy = size * 0.735, size * 0.735
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 235))

    return img


def save_ico(path, size=256):
    img = make_icon(size)
    img.save(
        path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    return path


if __name__ == "__main__":
    import os
    import sys

    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "assets", "app.ico"
    )
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    save_ico(out)
    print("icon written:", out)
