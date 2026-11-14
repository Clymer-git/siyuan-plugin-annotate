"""生成思源集市可识别的本地插件包 zip，并自检条目名合规性。

背景（依据 kernel/bazaar/local.go 与 install_revision.go）：
- validateLocalPackageArchive() 会在解压前逐个校验 zip 条目名，
  validateInstallRelativePath() 明确拒绝含反斜杠 `\\`、冒号 `:` 的路径。
- PowerShell 的 Compress-Archive 在 Windows 上生成的条目名是
  `siyuan-plugin-annotate\\index.js`（反斜杠），会直接报
  "invalid marketplace package path"。
- 因此必须用正斜杠 `/` 写条目名；本脚本用 Python zipfile 完成。
- localPackageRoot() 允许「清单在 zip 根」或「清单在唯一顶层目录内」，
  这里采用后者，解压出来直接就是可复制的 `siyuan-plugin-annotate/` 文件夹。
"""
from pathlib import Path
import posixpath
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
# 用法：python scripts/make_zip.py [里程碑编号，默认 1]
MILESTONE = sys.argv[1] if len(sys.argv) > 1 else "1"
BASE = ROOT / "deliverables" / f"milestone-{MILESTONE}"
PKG_DIR = BASE / "siyuan-plugin-annotate"
OUT = BASE / "siyuan-plugin-annotate.zip"
PREFIX = PKG_DIR.name

if not PKG_DIR.is_dir():
    raise SystemExit(f"插件目录不存在：{PKG_DIR}")

files = sorted(p for p in PKG_DIR.rglob("*") if p.is_file())
if not files:
    raise SystemExit("插件目录里没有文件")

entries = [(f"{PREFIX}/{p.relative_to(PKG_DIR).as_posix()}", p) for p in files]


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


def self_check() -> None:
    seen = set()
    spellings = {}
    for name, _ in entries:
        problem = check_name(name)
        if problem:
            raise SystemExit(f"FAIL  {name} -> {problem}")
        key = name.lower()
        if key in seen:
            raise SystemExit(f"FAIL  重复条目：{name}")
        seen.add(key)
        parts = name.split("/")
        for i in range(len(parts)):
            prefix = "/".join(parts[: i + 1])
            folded = prefix.lower()
            if folded in spellings and spellings[folded] != prefix:
                raise SystemExit(f"FAIL  路径组件大小写冲突：{prefix}")
            spellings[folded] = prefix
        print(f"PASS  {name}")

    # 确认清单位置符合 localPackageRoot() 要求
    top = {name.split("/")[0] for name, _ in entries}
    has_root_manifest = f"plugin.json" in {name for name, _ in entries}
    has_single_top = len(top) == 1 and any(
        name == f"{PREFIX}/plugin.json" for name, _ in entries
    )
    if not (has_root_manifest or has_single_top):
        raise SystemExit("FAIL  plugin.json 不在 zip 根，也不在唯一顶层目录内")


self_check()
if OUT.exists():
    OUT.unlink()
with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for name, path in entries:
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.create_system = 3  # Unix，避免被识别成 FAT 特殊模式
        info.external_attr = (0o100644 << 16) | 0o644
        zf.writestr(info, path.read_bytes())

# 从磁盘重新读一遍，确认写进去的字节就是正斜杠
with zipfile.ZipFile(OUT) as zf:
    for info in zf.infolist():
        if check_name(info.orig_filename) is not None:
            raise SystemExit(f"FAIL  落盘后条目名不合规：{info.orig_filename!r}")
        if "\\" in info.orig_filename:
            raise SystemExit(f"FAIL  落盘后仍含反斜杠：{info.orig_filename!r}")
print(f"\nOK -> {OUT}  ({OUT.stat().st_size} bytes, {len(entries)} files)")
