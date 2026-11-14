"""把用户给的插画原稿做成集市图标 public/icon.png。

集市硬性限制（plugin-sample 规范）：
- 只收 PNG/JPEG/WebP/AVIF，图片体积 **不超过 64 KiB**，推荐 160×160。
- 之前输出 512×512 / 319 KB 会被集市直接拒收，所以这里降到 160。
体积优先策略：先 LANCZOS 缩到 160 存 optimize PNG；
若仍超 64 KiB（插画类图很容易超），再走 256 色调色板量化，图标是满铺不透明方块，量化后肉眼几乎无差别。

用法：python scripts/make_icon.py
源图：design/icon-source.jpg（换图时替换这个文件即可）
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "design" / "icon-source.jpg"
OUT = ROOT / "public" / "icon.png"
SIZE = 160
LIMIT = 64 * 1024

if not SRC.is_file():
    raise SystemExit(f"找不到源图：{SRC}")

image = Image.open(SRC).convert("RGB")
# 非正方形时从中心裁成正方形，保证图标满铺、不变形
w, h = image.size
if w != h:
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    image = image.crop((left, top, left + side, top + side))

image = image.resize((SIZE, SIZE), Image.LANCZOS)
image.save(OUT, format="PNG", optimize=True)

if OUT.stat().st_size > LIMIT:
    # 调色板量化：照片类插画在不透明小图上效果最划算
    image.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(
        OUT, format="PNG", optimize=True
    )

size_kb = OUT.stat().st_size / 1024
flag = "OK" if OUT.stat().st_size <= LIMIT else "仍然超限"
print(f"已生成 {OUT}  {SIZE}×{SIZE}  {size_kb:.1f} KB  [{flag}，上限 64 KiB]")
