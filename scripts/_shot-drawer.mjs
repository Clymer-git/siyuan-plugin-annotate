/**
 * 对象抽屉（底部上滑 + 顶部小横条）设计预览。
 * 仍在真实 dist 上做：先让插件自己把抽屉打开，再只改「位置 / 高度 / 圆角 / 抓手」这几处。
 *
 * 前置：Edge 用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 * 用法：node scripts/_shot-drawer.mjs
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
            const p = path.join(root, "public", "assets", "source.png");
            if (!(await exists(p))) { res.statusCode = 404; res.end("no"); return; }
            res.setHeader("Content-Type", "image/png");
            res.end(await readFile(p));
        } else { res.statusCode = 404; res.end("not found"); }
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
            JSON.stringify(result.exceptionDetails.exception?.description || ""));
    }
    return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
let ready = false;
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) { ready = true; break; }
    await sleep(100);
}
if (!ready) throw new Error("harness 未就绪：" + await evaluate("window.__error"));

await evaluate(`fetch('/theme.css').then(r => r.text()).then(t => {
    const el = document.createElement('style'); el.id = 'theme-inject';
    el.textContent = t; document.head.append(el);
})`);
await sleep(400);

const shot = async (file, clip) => {
    const result = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false, clip, fromSurface: true});
    const buf = Buffer.from(result.data, "base64");
    await writeFile(path.join(outDir, file), buf);
    console.log("已截图:", file, (buf.length / 1024).toFixed(0) + "KB");
};

// 画三个对象并选中其中一个（真实点击，不是伪造 state）
const state = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const cw = Number(svg.getAttribute('width')) || 1200;
    const ch = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x / cw * rect.width, clientY: rect.top + y / ch * rect.height});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY}));
    const pick = (tool) => document.querySelector('.annot-mobile-rail [data-tool="' + tool + '"]')?.click();
    const draw = (tool, x1, y1, x2, y2) => {
        pick(tool);
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    draw('arrow', 240, 640, 560, 340);
    draw('rect', 720, 240, 1100, 480);
    draw('ellipse', 940, 580, 1140, 740);
    document.querySelector('.annot-fab[data-action="mobile-select"]')?.click();
    // 点中矩形（画布坐标 910,360）。命中判定看的是 event.target 上的 [data-object-id]，
    // 直接派发给 <svg> 永远选不中 —— 必须先 elementFromPoint 拿到对象元素再派发。
    const center = at(910, 360);
    const hit = document.elementFromPoint(center.clientX, center.clientY) || svg;
    for (const type of ['pointerdown', 'pointerup', 'click']) {
        hit.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0,
            clientX: center.clientX, clientY: center.clientY}));
    }
    return {objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length};
})()`);
console.log("已画对象:", JSON.stringify(state));
await sleep(200);

// 用「对象」胶囊打开抽屉
const opened = await evaluate(`(() => {
    document.querySelector('.annot-fab-pill[data-action="mobile-props"]')?.click();
    const sheet = document.querySelector('[data-role="sidebar"]');
    const r = sheet?.getBoundingClientRect();
    return {open: sheet?.classList.contains('is-open'),
        box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
        rows: sheet ? sheet.querySelectorAll('.annot-object-list li, .annot-object-row').length : 0,
        text: sheet ? sheet.innerText.replace(/\\n+/g, ' | ').slice(0, 160) : ''};
})()`);
console.log("抽屉(改前):", JSON.stringify(opened));
await sleep(300);
await shot("drawer-0-改前.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

// 直接看真实产物：抽屉是否从底部上滑、抓手在不在、有没有盖住 dock
const real = await evaluate(`(() => {
    const sheet = document.querySelector('[data-role="sidebar"]');
    const grab = document.querySelector('[data-role="mobile-grab"]');
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    return {open: sheet?.classList.contains("is-open"), sheet: box(sheet), grab: box(grab),
        rail: box(document.querySelector('.annot-mobile-rail')),
        fabs: box(document.querySelector('.annot-mobile-fabs')),
        grabberColor: grab ? getComputedStyle(grab.querySelector("span")).backgroundColor : null,
        radius: sheet ? getComputedStyle(sheet).borderTopLeftRadius : null,
        zIndex: sheet ? getComputedStyle(sheet).zIndex : null};
})()`);
console.log("抽屉实测:", JSON.stringify(real));
await sleep(350);
await shot("v024-1-对象抽屉.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});
await shot("v024-2-抓手特写.png", {x: 0, y: 400, width: 390, height: 444, scale: 3});

// 拽抓手往下滑 150px（不松手）→ 面板跟手
const dragging = await evaluate(`(() => {
    const grab = document.querySelector('[data-role="mobile-grab"]');
    const r = grab.getBoundingClientRect();
    const at = (type, y) => grab.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch",
        clientX: r.left + r.width / 2, clientY: y}));
    at("pointerdown", r.top + 10);
    for (const dy of [40, 90, 150]) at("pointermove", r.top + 10 + dy);
    const sheet = document.querySelector('[data-role="sidebar"]');
    return {transform: sheet.style.transform, dragging: sheet.classList.contains("is-dragging"),
        box: (() => { const b = sheet.getBoundingClientRect();
            return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; })()};
})()`);
console.log("拖动中:", JSON.stringify(dragging));
await sleep(200);
await shot("v024-3-拖动中.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

// 松手 → 超过 1/4 高度，应该关闭
const released = await evaluate(`(() => new Promise((resolve) => {
    const grab = document.querySelector('[data-role="mobile-grab"]');
    if (!grab) { resolve({err: "grab gone"}); return; }
    const r = grab.getBoundingClientRect();
    grab.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch",
        clientX: r.left + r.width / 2, clientY: r.top + 10}));
    setTimeout(() => {
        const sheet = document.querySelector('[data-role="sidebar"]');
        resolve({open: sheet?.classList.contains("is-open"),
            pillOpen: document.querySelector('.annot-fab-pill[data-action="mobile-props"]')?.classList.contains("is-open")});
    }, 400);
}))()`);
console.log("松手后:", JSON.stringify(released));

ws.close();
server.close();
process.exit(0);
