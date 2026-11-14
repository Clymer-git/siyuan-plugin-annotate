/**
 * v0.26.1 手柄截图：完全用 dist 里的真实产物渲染，不注入任何样式。
 * 只做用户真的会做的操作（画矩形 / 写文字 / 选中），用来确认
 * 「移动抓手」「文字再编辑角标」「四角等比缩放」在当前代码里的实际长相。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 * 用法：node scripts/_shot-handles.mjs
 */
import http from "node:http";
import {readFile, writeFile, access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
const outDir = path.join(root, "deliverables", "mobile-ui-prototype", "shots");
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

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
            const p = path.join(root, "design", "icon-source.jpg");
            if (!(await exists(p))) { res.statusCode = 404; res.end("no"); return; }
            res.setHeader("Content-Type", "image/jpeg");
            res.end(await readFile(p));
        } else {
            res.statusCode = 404;
            res.end("not found");
        }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("没有可用的页面 target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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

const boot = async (width, height, mobile, dsf) => {
    await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: dsf, mobile});
    await send("Emulation.setTouchEmulationEnabled", {enabled: mobile, maxTouchPoints: mobile ? 5 : 1});
    await send("Page.navigate", {url: `http://127.0.0.1:${port}/?r=${Date.now()}`});
    for (let i = 0; i < 90; i++) {
        if (await evaluate("window.__ready === true")) break;
        await sleep(100);
    }
    await evaluate(`fetch('/theme.css').then(r => r.text()).then(t => {
        const el = document.createElement('style'); el.id = 'theme-inject';
        el.textContent = t; document.head.append(el);
    })`);
    await sleep(450);
};

const shot = async (file, clip) => {
    const result = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false, clip, fromSurface: true});
    const buf = Buffer.from(result.data, "base64");
    await writeFile(path.join(outDir, file), buf);
    console.log("已截图:", file, (buf.length / 1024).toFixed(0) + "KB");
};

const prelude = `(async () => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1024;
    const h = Number(svg.getAttribute('height')) || 1024;
    window.__at = (x, y) => ({clientX: rect.left + x / w * rect.width, clientY: rect.top + y / h * rect.height});
    window.__fire = (type, p) => {
        const hit = document.elementFromPoint(p.clientX, p.clientY) || svg;
        hit.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
            pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
            clientX: p.clientX, clientY: p.clientY}));
    };
    window.__handles = () => [...document.querySelectorAll('[data-role="handles"] [data-handle]')]
        .map((el) => el.getAttribute('data-handle'));
    return true;
})()`;

/** ① 画一个矩形（画完自动选中，手柄立刻出现） */
const drawRect = (tool) => `(async () => {
    document.querySelector(${JSON.stringify(tool)})?.click();
    __fire('pointerdown', __at(300, 250));
    __fire('pointermove', __at(500, 380));
    __fire('pointerup', __at(700, 520));
    await new Promise((r) => setTimeout(r, 220));
    return {objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length, handles: __handles()};
})()`;

/** ② 写字 → 结束编辑 → 切回选择工具 → 点中文字 */
const writeTextAndSelect = (textTool, selectTool) => `(async () => {
    document.querySelector(${JSON.stringify(textTool)})?.click();
    __fire('pointerdown', __at(310, 610));
    __fire('pointerup', __at(310, 610));
    const editor = document.querySelector('.annot-text-editor');
    if (editor) {
        editor.value = '此处是重点，别漏';
        editor.dispatchEvent(new Event('input', {bubbles: true}));
        editor.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
    }
    await new Promise((r) => setTimeout(r, 260));
    document.querySelector(${JSON.stringify(selectTool)})?.click();
    await new Promise((r) => setTimeout(r, 120));
    __fire('pointerdown', __at(340, 618));
    __fire('pointerup', __at(340, 618));
    await new Promise((r) => setTimeout(r, 240));
    return {objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
        handles: __handles(), editing: !!document.querySelector('.annot-text-editor')};
})()`;

// ---------------------------------------------------------------- 1) 电脑端：矩形
await boot(1440, 900, false, 1.5);
await evaluate(prelude);
console.log("电脑端·矩形:", JSON.stringify(await evaluate(drawRect('button[data-tool="rect"]'))));
await sleep(220);
await shot("v0261-1-PC-矩形抓手.png", {x: 0, y: 0, width: 1440, height: 900, scale: 1});

// ---------------------------------------------------------------- 2) 电脑端：文字
console.log("电脑端·文字:", JSON.stringify(await evaluate(writeTextAndSelect(
    'button[data-tool="text"]', '[data-tool="select"]'))));
await sleep(220);
await shot("v0261-2-PC-文字角标.png", {x: 380, y: 200, width: 800, height: 520, scale: 2});

// ---------------------------------------------------------------- 3) 手机端：文字
await boot(390, 844, true, 2);
await evaluate(prelude);
console.log("手机端·矩形:", JSON.stringify(await evaluate(drawRect('.annot-mobile-rail button[data-tool="rect"]'))));
console.log("手机端·文字:", JSON.stringify(await evaluate(writeTextAndSelect(
    '.annot-mobile-rail button[data-tool="text"]', '.annot-fab[data-action="mobile-select"]'))));
await sleep(220);
await shot("v0261-3-手机-文字角标.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});
// 文字周围那圈手柄放大 4 倍，看清每个控件的形状与间距
await shot("v0261-4-手机-文字手柄特写.png", {x: 70, y: 370, width: 280, height: 150, scale: 4});

ws.close();
server.close();
process.exit(0);
