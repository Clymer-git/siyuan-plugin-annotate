/**
 * 真实浏览器复现台（Chromium CDP）。
 *
 * jsdom 不会模拟浏览器在 mousedown 时的默认焦点转移，因此文字输入框
 * 「闪一下就消失」这类问题只能靠真实浏览器抓。这里用 Edge Headless +
 * Input.dispatchMouseEvent 产生完整的真实鼠标事件序列，记录事件日志与
 * 输入框出现/消失时刻，用来定位根因并验证修复。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-repro.mjs
 */
import http from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");

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

let targets;
try {
    targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
} catch {
    throw new Error("找不到 Edge 远程调试端口 9222，请先启动 headless 浏览器");
}
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
};
const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", {type: "mousePressed", x, y, button: "left", clickCount: 1});
    await send("Input.dispatchMouseEvent", {type: "mouseReleased", x, y, button: "left", clickCount: 1});
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 1000, height: 700, deviceScaleFactor: 1, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});

let ready = false;
for (let i = 0; i < 60; i++) {
    if (await evaluate("window.__ready === true")) { ready = true; break; }
    await sleep(100);
}
if (!ready) throw new Error("harness 未就绪：" + await evaluate("window.__error"));
const bootError = await evaluate("window.__error");
if (bootError) console.log("harness 启动异常：", bootError);

let canvasReady = false;
for (let i = 0; i < 60; i++) {
    if (await evaluate("!!document.querySelector('.annot-svg') && !document.querySelector('[data-role=\"transform\"]')?.hidden")) {
        canvasReady = true;
        break;
    }
    await sleep(100);
}
console.log("画布就绪：", canvasReady);

await evaluate("window.__log.length = 0");
const toolPoint = await evaluate(`(() => {
    const e = document.querySelector('button[data-tool="text"]');
    const r = e.getBoundingClientRect();
    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
})()`);
await click(toolPoint.x, toolPoint.y);
await sleep(150);

const canvasPoint = await evaluate(`(() => {
    const r = document.querySelector('.annot-svg').getBoundingClientRect();
    return {x: Math.round(r.left + 260), y: Math.round(r.top + 200)};
})()`);
await click(canvasPoint.x, canvasPoint.y);
await sleep(80);
const immediate = await evaluate(`({
    has: !!document.querySelector('.annot-text-editor'),
    active: document.activeElement?.tagName || 'none',
    value: document.querySelector('.annot-text-editor')?.value ?? null
})`);
await sleep(700);
const later = await evaluate(`({
    has: !!document.querySelector('.annot-text-editor'),
    active: document.activeElement?.tagName || 'none',
    objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length
})`);
const events = await evaluate("window.__log");

console.log("\n=== 点击文字工具并在画布点一下 ===");
console.log("点击坐标：工具", JSON.stringify(toolPoint), "画布", JSON.stringify(canvasPoint));
console.log("80ms 后 ：", JSON.stringify(immediate));
console.log("780ms 后：", JSON.stringify(later));
console.log("\n=== 真实事件序列 ===");
console.log(events.join("\n"));

// 文档内预览：验证真实浏览器里 :has() 定位与覆盖层尺寸严格贴合图片
await sleep(300);
const preview = await evaluate(`(() => {
    const overlay = document.querySelector('.annot-doc-overlay');
    const image = document.querySelector('.protyle-wysiwyg img[data-src="assets/demo.png"]');
    if (!overlay || !image) return null;
    const a = overlay.getBoundingClientRect();
    const b = image.getBoundingClientRect();
    return {
        objects: overlay.querySelectorAll('[data-object-id]').length,
        hostPosition: getComputedStyle(image.parentElement).position,
        dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height),
        dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
        pointerEvents: getComputedStyle(overlay).pointerEvents,
        imageSrcUnchanged: image.getAttribute('data-src') === 'assets/demo.png',
    };
})()`);
console.log("\n=== 文档内标注预览 ===");
console.log(JSON.stringify(preview));
const previewOk = preview && preview.objects === 1 && preview.hostPosition === "relative" &&
    preview.dw < 1 && preview.dh < 1 && preview.dx < 1 && preview.dy < 1 &&
    preview.pointerEvents === "none" && preview.imageSrcUnchanged;

const ok = immediate.has && later.has && later.active === "TEXTAREA" && previewOk;
console.log("\n结论：", ok
    ? "PASS 文字输入框稳定 + 文档预览对齐且只读"
    : "FAIL 文字输入框或文档预览异常（见上）");
ws.close();
server.close();
process.exit(ok ? 0 : 1);
