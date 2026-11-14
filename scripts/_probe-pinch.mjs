/**
 * 复现 / 验证：移动端双指操作是否会误画出标注。
 *
 * 用 CDP 的 Input.dispatchTouchEvent 走真实事件链（浏览器会自己合成 pointer 事件），
 * 覆盖两种真实场景：
 *   A. 两根手指几乎同时落下
 *   B. 先一根手指落下滑动、隔 120ms 第二根才落下（最容易误画）
 *
 * 前置：Edge 用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 * 用法：node scripts/_probe-pinch.mjs [rect|arrow|line]
 */
import http from "node:http";
import {readFile, access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
const tool = process.argv[2] || "rect";
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
// CDP 的触摸点必须带 id，且坐标是视口 CSS 像素
const touch = (type, points) => send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p) => ({x: p.x, y: p.y, id: p.id, radiusX: 12, radiusY: 12, force: 1})),
});

await send("Page.enable");
await send("Runtime.enable");
await send("Page.bringToFront");
await send("Emulation.setFocusEmulationEnabled", {enabled: true});
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

await evaluate(`(() => {
    window.__ev = [];
    const push = (t) => (e) => window.__ev.push([t, e.pointerType || (e.touches ? e.touches.length : -1)]);
    document.addEventListener("pointerdown", push("pd"), true);
    document.addEventListener("pointermove", push("pm"), true);
    document.addEventListener("pointerup", push("pu"), true);
    document.addEventListener("touchstart", push("ts"), true);
    document.addEventListener("touchmove", push("tm"), true);
    document.addEventListener("touchend", push("te"), true);
    return true;
})()`);

const reset = () => evaluate(`(() => {
    // 清场：把对象删光、工具切回选择
    const ed = window.__plugin?.editor;
    document.querySelector('.annot-fab[data-action="mobile-select"]')?.click();
    return {objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
            zoom: ed?.viewport?.zoom ?? null};
})()`);

const pick = (name) => evaluate(`(() => {
    const btn = document.querySelector('.annot-mobile-rail [data-tool="${name}"]');
    if (btn) btn.click();
    return !!btn;
})()`);

const snapshot = () => evaluate(`(() => {
    const ed = window.__plugin?.editor;
    return {objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
            draft: !!document.querySelector('[data-layer="overlay"] [data-draft]'),
            zoom: Number(((ed?.viewport?.zoom ?? 1) * 100).toFixed(1)),
            panX: Math.round(ed?.viewport?.panX ?? 0),
            locked: ed?.gestureLocked ?? null,
            hasStage: !!ed?.stage, mobile: ed?.mobile ?? null,
            abort: ed?.abort?.signal?.aborted ?? null,
            touches: ed?.touchPoints?.size ?? null};
})()`);

async function scenarioA() {
    await reset();
    await pick(tool);
    await sleep(120);
    // 两指同时落下，然后张开（放大）
    await touch("touchStart", [{x: 150, y: 430, id: 1}, {x: 240, y: 430, id: 2}]);
    for (let i = 1; i <= 6; i++) {
        await touch("touchMove", [{x: 150 - i * 12, y: 430, id: 1}, {x: 240 + i * 12, y: 430, id: 2}]);
        await sleep(16);
    }
    await touch("touchEnd", []);
    await sleep(200);
    return snapshot();
}

async function scenarioB() {
    await reset();
    await pick(tool);
    await sleep(120);
    // 第一根手指先落下并拖一段（这段时间完全可能先画起来）
    await touch("touchStart", [{x: 150, y: 430, id: 1}]);
    for (let i = 1; i <= 4; i++) {
        await touch("touchMove", [{x: 150 + i * 10, y: 430 + i * 8, id: 1}]);
        await sleep(16);
    }
    // 第二根手指才落下
    await touch("touchStart", [{x: 150 + 40, y: 462, id: 1}, {x: 250, y: 430, id: 2}]);
    await sleep(60);
    for (let i = 1; i <= 6; i++) {
        await touch("touchMove", [{x: 150 + 40 - i * 10, y: 462, id: 1}, {x: 250 + i * 10, y: 430, id: 2}]);
        await sleep(16);
    }
    await touch("touchEnd", []);
    await sleep(250);
    return snapshot();
}

async function scenarioC() {
    // 单指正常绘制，必须画得出来（防止修过头）
    await reset();
    await pick(tool);
    await sleep(120);
    await touch("touchStart", [{x: 120, y: 360, id: 1}]);
    for (let i = 1; i <= 6; i++) {
        await touch("touchMove", [{x: 120 + i * 20, y: 360 + i * 12, id: 1}]);
        await sleep(16);
    }
    await touch("touchEnd", []);
    await sleep(200);
    return snapshot();
}

const seen = await evaluate("window.__ev.slice(0, 14)");
console.log("事件流:", JSON.stringify(seen), "总条数:", await evaluate("window.__ev.length"));

const base = await snapshot();
console.log("初始:", JSON.stringify(base));
console.log("场景A 同时双指:", JSON.stringify(await scenarioA()));
console.log("场景B 先后双指:", JSON.stringify(await scenarioB()));
console.log("场景C 单指绘制:", JSON.stringify(await scenarioC()));

ws.close();
server.close();
process.exit(0);
