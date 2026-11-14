"""生成集市 release 用的 package.zip。

与 make_zip.py 的区别（两个包不能混用）：
- make_zip.py：给用户手动安装，zip 内套一层 `siyuan-plugin-annotate/` 目录；
- 本脚本：给 GitHub Release 当附件，集市下载后直接解压进 `data/plugins/<name>/`，
  所以**文件必须全部在 zip 根**（plugin-sample 的 package.zip 就是这个结构）。

打包前按集市规范自检（依据 plugin-sample README）：
- 必需文件：plugin.json / index.js / index.css / README.md
- icon ≤ 64 KiB，preview ≤ 512 KiB
- 条目名用正斜杠（避免思源 validateInstallRelativePath 报错）

用法：node scripts/build.mjs && python scripts/make_release_zip.py
"""
from pathlib import Path
import posixpath
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "dist"
OUT = ROOT / "deliverables" / "milestone-6" / "package.zip"

REQUIRED = ["plugin.json", "index.js", "index.css", "README.md"]
ICON_LIMIT = 64 * 1024
PREVIEW_LIMIT = 512 * 1024


def check_name(name: str) -> str | None:
    """复刻 Go validateInstallRelativePath 的规则。"""
    trimmed = name[:-1] if name.endswith("/") else name
    if not trimmed or trimmed == "." or posixpath.normpath(trimmed) != trimmed:
        return "路径未规范化"
    if trimmed.startswith("/"):
        return "绝对路径"
    if any(ch in trimmed for ch in ("\\", ":", "\x00")):
        return "含反斜杠/冒号/空字节"
    for part in trimmed.split("/"):
        if part == ".." or part.rstrip(". ") != part:
            return f"非法路径分段：{part!r}"
    return None


if not SRC.is_dir():
    raise SystemExit(f"构建产物不存在：{SRC}（先跑 node scripts/build.mjs）")

files = sorted(p for p in SRC.rglob("*") if p.is_file())
names = {p.relative_to(SRC).as_posix() for p in files}

missing = [f for f in REQUIRED if f not in names]
if missing:
    raise SystemExit(f"FAIL  dist 缺少必需文件：{missing}")

icon = SRC / "icon.png"
if icon.is_file() and icon.stat().st_size > ICON_LIMIT:
    raise SystemExit(f"FAIL  icon.png {icon.stat().st_size} 字节，超过集市 64 KiB 上限")
preview = SRC / "preview.png"
if preview.is_file() and preview.stat().st_size > PREVIEW_LIMIT:
    raise SystemExit(f"FAIL  preview.png {preview.stat().st_size} 字节，超过集市 512 KiB 上限")

OUT.parent.mkdir(parents=True, exist_ok=True)
if OUT.exists():
    OUT.unlink()

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for path in files:
        name = path.relative_to(SRC).as_posix()
        problem = check_name(name)
        if problem:
            raise SystemExit(f"FAIL  {name} -> {problem}")
        zf.write(path, name)

print(f"已生成 {OUT}")
print(f"  条目 {len(files)} 个，体积 {OUT.stat().st_size / 1024:.0f} KB（根级结构）")
for f in REQUIRED:
    print(f"  - {f}")
