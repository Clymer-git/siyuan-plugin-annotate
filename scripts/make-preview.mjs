/**
 * 生成集市用的「预览图」：用插件真实界面渲染一张 1024×768 的效果图。
 *
 * 为什么不用拼图/宣传图：用户会拿预览图当「预期」，拼得好看但界面不是那样会很坑；
 * 这里加载的是 dist/index.js + dist/index.css，注入思源真实主题变量，
 * 再用真实鼠标事件画出各类标注，截出来就是打开插件看到的样子。
 *
 * 流程：Edge headless 里以 1024×768 @2x 截图（2048×1536，足够锐利）
 *      → 用 Pillow 缩到 1024×768（LANCZOS）并压体积，控制在集市要求的 512KB 内。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/make-preview.mjs [输出目录]
 */
import http from "node:http";
import {execFileSync} from "node:child_process";
import {readFile, writeFile, unlink} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
const outDir = process.argv[2] || root;
const target = path.join(outDir, "预览图.png");
const hugeFile = path.join(outDir, ".preview-2x.png");

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || "/").split("?")[0];
        if (url === "/" || url === "/index.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(await readFile(harnessFile));
        } else if (url === "/index.js") {
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.end(await readFile(path.join(distDir, "index.js")));
        } else if (url === "/index.css") {
            res.setHeader("Content-Type", "text/css; charset=utf-8");
            res.end(await readFile(path.join(distDir, "index.css")));
        } else if (url === "/theme.css") {
            res.setHeader("Content-Type", "text/css; charset=utf-8");
            res.end(await readFile(dayFile));
        } else if (url === "/assets/source.png") {
            // 画布上放的就是图标那张原图（用 1024 的原稿，缩小显示才锐利）
            res.setHeader("Content-Type", "image/jpeg");
            res.end(await readFile(path.join(root, "design", "icon-source.jpg")));
        } else {
            res.statusCode = 404;
            res.end("not found");
        }
    } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("没有可用的页面 target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const {resolve, reject} = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
    }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
});
const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text + " :: " +
            String(result.exceptionDetails.exception?.description || ""));
    }
    return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
// 集市预览图要求 1024×768（4:3）。这里按 1440×1080 排版（工具栏才不会挤到裁切），
// 2 倍渲染后用 Pillow 缩到 1024×768，文字边缘依然干净。
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1080, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
let ready = false;
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) { ready = true; break; }
    await sleep(100);
}
if (!ready) throw new Error("harness 未就绪：" + await evaluate("window.__error"));

await evaluate(`fetch('${"/theme.css"}').then(r => r.text()).then(t => {
    let el = document.getElementById('theme-inject');
    if (!el) { el = document.createElement('style'); el.id = 'theme-inject'; document.head.append(el); }
    el.textContent = t; return true;
})`);
await sleep(400);

// ---- 1) 往下扩一条留白放图注；底色取图片本身的纸色，接缝看不出来 ----
const extended = await evaluate(`(() => {
    const q = (sel) => document.querySelector(sel);
    q('[data-canvas-op="extend"]').click();
    // 只留「下」一个方向：先把其它已选中的方向关掉
    for (const dir of ["top", "left", "right"]) {
        const btn = q('button[data-dir="' + dir + '"]');
        if (btn?.classList.contains("is-active")) btn.click();
    }
    const bottom = q('button[data-dir="bottom"]');
    if (!bottom?.classList.contains("is-active")) bottom?.click();
    // 四向共用数值时只有第一个框可输入，先断开
    const link = q('[data-action="toggle-link"]');
    if (link?.getAttribute("aria-pressed") === "true") link.click();
    const input = q('[data-role="extend-bottom"]');
    input.value = "170";
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
    // 自定义底色 = 图片底边的纸色（#E8D6C5），扩出来的部分像纸的一部分
    const custom = q('[data-role="bg-custom1"]');
    if (custom) {
        custom.value = "#E8D6C5";
        custom.dispatchEvent(new Event("input", {bubbles: true}));
        custom.dispatchEvent(new Event("change", {bubbles: true}));
    }
    q('[data-action="extend-apply"]').click();
    const svg = q('[data-role="svg"]');
    return {w: Number(svg.getAttribute("width")), h: Number(svg.getAttribute("height")),
            bg: document.querySelector('[data-role="extend-bgs"] .is-active')?.getAttribute("data-bg")};
})()`);
console.log("扩展后画布:", extended);
await sleep(500);

// ---- 2) 右侧猫爪上圈一个圈 ----
const circled = await evaluate(`(() => {
    const q = (sel) => document.querySelector(sel);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1024;
    const h = Number(svg.getAttribute("height")) || 1194;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, target) => (target || svg).dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    // 线宽点成 8px，缩到 1024 宽也看得清
    q('[data-preset="lineWidth"][data-value="8"]')?.click();
    q('button[data-tool="ellipse"]').click();
    fire("pointerdown", at(608, 412));
    fire("pointermove", at(780, 590));
    fire("pointerup", at(958, 772));
    return document.querySelectorAll('[data-layer="objects"] g.annot-object').length;
})()`);
console.log("画圈后对象数:", circled);
await sleep(250);

// ---- 3) 图下方写一行图注 ----
const caption = await evaluate(`(() => {
    const q = (sel) => document.querySelector(sel);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1024;
    const h = Number(svg.getAttribute("height")) || 1194;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, target) => (target || svg).dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    q('button[data-tool="text"]')?.click();
    fire("pointerdown", at(240, 1060));
    const editor = q(".annot-text-editor");
    if (!editor) return {err: "no-editor"};
    editor.value = "此猫虽萌乱摸会抓人";
    editor.dispatchEvent(new Event("input", {bubbles: true}));
    editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
    // 画完切回选择工具，否则下一次点在画布上又会新建一个空文字
    q('button[data-tool="select"]')?.click();
    return {
        objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
        editorLeft: !!q(".annot-text-editor"),
    };
})()`);
console.log("写图注:", caption);
await sleep(250);

// ---- 4) 图注字号拉到 60，再挪到「横向居中、留白正中」 ----
const placed = await evaluate(`(() => {
    const q = (sel) => document.querySelector(sel);
    const items = Array.from(document.querySelectorAll('[data-role="object-item"]'));
    const item = items.find((el) => (el.textContent || "").includes("此猫")) || items[items.length - 1];
    item?.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    const size = q('[data-role="props"] input[data-prop="fontSize"]');
    if (size) {
        size.value = "60";
        size.dispatchEvent(new Event("input", {bubbles: true}));
        size.dispatchEvent(new Event("change", {bubbles: true}));
    }
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1024;
    const h = Number(svg.getAttribute("height")) || 1194;
    const toCanvas = (clientX, clientY) => ({
        x: (clientX - rect.left) / rect.width * w,
        y: (clientY - rect.top) / rect.height * h,
    });
    const toClient = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, target) => (target || svg).dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    // 改字号会重建对象图层，元素被换掉，必须重新取一次
    const text = q('[data-layer="objects"] text.annot-shape');
    if (!text) return {err: "no-text"};
    // 用屏幕矩形换回画布坐标：getBBox 在刚重建的图层上可能还是 0
    const r = text.getBoundingClientRect();
    const a = toCanvas(r.left, r.top);
    const b = toCanvas(r.right, r.bottom);
    const dx = w / 2 - (a.x + b.x) / 2;
    const dy = (1024 + 170 / 2) - (a.y + b.y) / 2;
    const hit = text.closest("g.annot-object")?.querySelector('[data-role="hit"]');
    const from = toClient((a.x + b.x) / 2, (a.y + b.y) / 2);
    fire("pointerdown", from, hit);
    fire("pointermove", {clientX: from.clientX + dx * rect.width / w, clientY: from.clientY + dy * rect.height / h});
    fire("pointerup", {clientX: from.clientX + dx * rect.width / w, clientY: from.clientY + dy * rect.height / h});
    const after = q('[data-layer="objects"] text.annot-shape')?.getBoundingClientRect();
    if (!after || after.width === 0) return {err: "text-gone"};
    const c = toCanvas(after.left, after.top);
    const d = toCanvas(after.right, after.bottom);
    return {
        fontSize: text.getAttribute("font-size"),
        box: [Math.round(c.x), Math.round(c.y), Math.round(d.x - c.x), Math.round(d.y - c.y)],
        center: [Math.round((c.x + d.x) / 2), Math.round((c.y + d.y) / 2)],
        canvas: w + "×" + h,
    };
})()`);
console.log("图注位置:", placed);
await sleep(250);

// 最后选中那个圈：圈上有手柄、右侧是它的属性，一眼看出「还能继续改」
await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('[data-role="object-item"]'));
    (items.find((el) => (el.textContent || "").includes("椭圆")) || items[0])
        ?.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
    return items.length;
})()`);
await sleep(300);

const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
await writeFile(hugeFile, Buffer.from(shot.data, "base64"));

// ---- 缩到 1024×768 并压体积（集市上限 512KB）----
// 这张图里有插画，PNG 可能超过 500KB；集市允许 jpg，所以「谁更小就用谁」。
// 结果同时同步进 public/（插件包里的 preview.png 就是集市详情页看到的预览图）。
const code = `
import json
import shutil
from pathlib import Path
from PIL import Image

out_dir = Path(r"${outDir}")
public_dir = Path(r"${path.join(root, "public")}")
src = Image.open(r"${hugeFile}").convert("RGB").resize((1024, 768), Image.LANCZOS)

png = out_dir / "预览图.png"
jpg = out_dir / "预览图.jpg"
src.save(png, format="PNG", optimize=True)
src.save(jpg, format="JPEG", quality=94, optimize=True, progressive=True)
png_kb, jpg_kb = png.stat().st_size / 1024, jpg.stat().st_size / 1024
print(f"预览图 PNG {png_kb:.0f} KB / JPEG {jpg_kb:.0f} KB（上限 512KB）")

if png_kb <= 500:
    jpg.unlink(missing_ok=True)
    src_name, keep, drop = "preview.png", png, out_dir / "预览图.jpg"
else:
    png.unlink()
    src_name, keep, drop = "preview.jpg", jpg, out_dir / "预览图.png"

# 同步进插件包：集市详情页读的就是这个文件
(public_dir / "preview.png").unlink(missing_ok=True)
(public_dir / "preview.jpg").unlink(missing_ok=True)
shutil.copyfile(keep, public_dir / src_name)

# 让 plugin.json 与 README 跟着实际文件名走
manifest_path = public_dir / "plugin.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["preview"] = src_name
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + chr(10), encoding="utf-8")

readme_path = public_dir / "README.md"
if readme_path.exists():
    md = readme_path.read_text(encoding="utf-8")
    md = md.replace("](preview.jpg)", "](preview.png)")
    md = md.replace("](preview.png)", "](preview.jpg)" if src_name.endswith("jpg") else "](preview.png)")
    readme_path.write_text(md, encoding="utf-8")

print("包内预览图:", public_dir / src_name, f"{keep.stat().st_size // 1024} KB")
`;
execFileSync("python", ["-c", code], {stdio: "inherit"});
await unlink(hugeFile).catch(() => {});

console.log("预览图目录:", outDir);
ws.close();
server.close();
process.exit(0);
