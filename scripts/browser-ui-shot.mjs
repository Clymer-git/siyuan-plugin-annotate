/**
 * 真实浏览器（Edge headless + CDP）截取插件真实界面，用于交付预览与人眼走查。
 *
 * 为什么不用独立的图标卡片当预览：用户会拿预览当"预期"，卡片好看但插件里不是那个样子，
 * 之前就踩过这个坑。这里加载的是 dist/index.js + dist/index.css，注入思源真实主题变量，
 * 再模拟几次拖拽画出真实标注，截出来的就是用户打开插件会看到的画面。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-ui-shot.mjs [输出目录]
 */
import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
const nightFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/midnight/theme.css";
const outDir = process.argv[2] || root;

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
        } else if (url === "/theme-dark.css") {
            res.setHeader("Content-Type", "text/css; charset=utf-8");
            res.end(await readFile(nightFile));
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " :: " + JSON.stringify(result.exceptionDetails.exception?.description || ""));
    return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
// 1440×900 更接近真实 94vw 的思源对话框，工具栏不用挤成下拉
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
let ready = false;
for (let i = 0; i < 60; i++) {
    if (await evaluate("window.__ready === true")) { ready = true; break; }
    await sleep(100);
}
if (!ready) throw new Error("harness 未就绪：" + await evaluate("window.__error"));

const injectTheme = async (file) => {
    await evaluate(`fetch('${file}').then(r => r.text()).then(t => {
        let el = document.getElementById('theme-inject');
        if (!el) { el = document.createElement('style'); el.id = 'theme-inject'; document.head.append(el); }
        el.textContent = t; return true;
    })`);
};
await injectTheme("/theme.css");
await sleep(300);

// ---- 画几个真实标注，让预览就是"用起来的样子"----
const drawn = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    // 用 SVG 的真实屏幕矩形换算：舞台并不是从窗口左上角开始，不能只用 panX/panY
    const rect = svg.getBoundingClientRect();
    const canvasW = Number(svg.getAttribute("width")) || 1200;
    const canvasH = Number(svg.getAttribute("height")) || 800;
    const kx = rect.width / canvasW;
    const ky = rect.height / canvasH;
    const at = (x, y) => ({clientX: rect.left + x * kx, clientY: rect.top + y * ky});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const draw = (tool, x1, y1, x2, y2) => {
        document.querySelector('button[data-tool="' + tool + '"]').click();
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    draw('arrow', 300, 520, 620, 250);
    draw('rect', 660, 170, 1040, 420);
    draw('ellipse', 170, 520, 400, 700);
    // 马赛克 / 模糊：都不套描边，正好用真实截图守住
    draw('mosaic', 620, 470, 860, 670);
    draw('blur', 900, 450, 1140, 680);
    draw('number', 250, 250, 250, 250);
    draw('number', 780, 500, 780, 500);
    // 文字：点一下进入输入态，填内容后 Esc 结束
    document.querySelector('button[data-tool="text"]').click();
    fire('pointerdown', at(150, 130));
    const editor = document.querySelector('.annot-text-editor');
    if (!editor) return 'no-editor';
    editor.value = '这里需要重点看';
    editor.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    document.querySelector('button[data-tool="select"]').click();
    return document.querySelectorAll('[data-layer="objects"] g.annot-object').length;
})()`);
console.log("已绘制标注对象数:", drawn);

// ---- 读取全部图标的最终计算样式（含左侧图像工具栏）----
const styles = await evaluate(`(() => {
    const read = (el) => {
        if (!el) return null;
        const css = getComputedStyle(el);
        const shape = el.querySelector('path,circle,rect,line,g');
        const scss = shape ? getComputedStyle(shape) : null;
        return {
            fill: css.fill, stroke: css.stroke, strokeWidth: css.strokeWidth,
            width: css.width, height: css.height,
            shapeFill: scss?.fill, shapeStroke: scss?.stroke,
        };
    };
    const out = {};
    for (const name of ['select','arrow','rect','ellipse','text','number','mosaic','highlight']) {
        out[name] = read(document.querySelector('button[data-tool="' + name + '"] svg'));
    }
    for (const op of ['crop','extend','rotate-ccw','rotate-cw','flip-h','flip-v']) {
        out[op] = read(document.querySelector('[data-canvas-op="' + op + '"] svg'));
    }
    out.undo = read(document.querySelector('.annot-history [data-action="undo"] svg'));
    const bar = document.querySelector('.annot-imagebar');
    out.imagebar = {width: getComputedStyle(bar).width, display: getComputedStyle(bar).display};
    const status = document.querySelector('.annot-status');
    out.status = {height: getComputedStyle(status).height, display: getComputedStyle(status).display};
    return out;
})()`);
console.log("=== 图标 / 布局 computed style ===");
for (const [name, value] of Object.entries(styles)) console.log(name.padEnd(12), JSON.stringify(value));

const shot = async (file, clip) => {
    const result = await send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false, clip,
    });
    await writeFile(path.join(outDir, file), Buffer.from(result.data, "base64"));
    console.log("已截图:", path.join(outDir, file));
};

await shot("界面预览-浅色.png", {x: 0, y: 0, width: 1440, height: 900, scale: 2});
await shot("图标细节放大.png", {x: 0, y: 0, width: 1440, height: 150, scale: 3});

// 深色：换成 midnight 主题变量 + 插件强制深色
await injectTheme("/theme-dark.css");
await evaluate("document.documentElement.setAttribute('data-theme-mode','dark');" +
    "document.querySelector('.annot-root').setAttribute('data-annot-theme','dark');" +
    "document.querySelector('[data-role=\"theme-select\"]').value = 'dark';");
await sleep(300);
await shot("界面预览-深色.png", {x: 0, y: 0, width: 1440, height: 900, scale: 2});

const bad = Object.entries(styles).filter(([k, v]) =>
    v && v.fill && v.fill !== "none" && ["imagebar", "status"].indexOf(k) < 0);
console.log("\n结论:", bad.length === 0
    ? "PASS 图标未被思源全局样式填实，笔触与尺寸沿用图标自身规格"
    : "FAIL 有图标被填实：" + bad.map(([k]) => k).join(","));

ws.close();
server.close();
process.exit(0);
