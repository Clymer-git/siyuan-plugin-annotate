/**
 * 手柄在缩放下的实际尺寸诊断：放大 3 倍前后，量手柄的「图片单位半径」和「屏幕像素半径」。
 * 期望：图片单位半径随 zoom 反比变小，屏幕像素半径恒定。
 *
 * 用法：node scripts/_probe-handle-zoom.mjs
 */
import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";

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
        } else {
            res.statusCode = 404;
            res.end("not found");
        }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
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
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/?r=${Date.now()}`});
for (let i = 0; i < 90; i++) {
    if (await evaluate("window.__ready === true")) break;
    await sleep(100);
}
await sleep(400);

// 画一个矩形（画完自动选中）
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1024;
    const h = Number(svg.getAttribute('height')) || 1024;
    const at = (x, y) => ({clientX: rect.left + x / w * rect.width, clientY: rect.top + y / h * rect.height});
    const fire = (type, p) => {
        const hit = document.elementFromPoint(p.clientX, p.clientY) || svg;
        hit.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
            pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
            clientX: p.clientX, clientY: p.clientY}));
    };
    document.querySelector('button[data-tool="rect"]')?.click();
    fire('pointerdown', at(300, 260));
    fire('pointermove', at(500, 380));
    fire('pointerup', at(700, 520));
    return true;
})()`);
await sleep(400);

const probe = `(() => {
    const ed = window.__plugin?.editor;
    const stage = document.querySelector('.annot-stage');
    const tl = document.querySelector('[data-role="transform"]');
    return {
        stage: [stage?.offsetWidth, stage?.offsetHeight, stage?.clientWidth, stage?.clientHeight],
        transform: !!tl,
        tfStyle: tl ? [tl.style.width, tl.style.height, tl.style.transform] : null,
        viewport: ed ? [ed.viewport?.zoom, ed.viewport?.panX, ed.viewport?.panY] : null,
        viewBox: document.querySelector('[data-role="svg"]')?.getAttribute('viewBox'),
        initialFit: ed ? ed.initialFitDone : null,
    };
})()`;

console.log("初始:", JSON.stringify(await evaluate(probe)));
// 直接跳到 354%（用户截图里的缩放），看手柄是不是被光栅化放大
await evaluate(`(() => {
    const ed = window.__plugin.editor;
    const stage = document.querySelector('.annot-stage');
    const cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
    const k = 3.54 / ed.viewport.zoom;
    ed.viewport = {...ed.viewport, zoom: ed.viewport.zoom * k,
        panX: cx - (cx - ed.viewport.panX) * k,
        panY: cy - (cy - ed.viewport.panY) * k};
    ed.applyViewport();
    return true;
})()`);
await sleep(420);
console.log("跳到 354%:", JSON.stringify(await evaluate(probe)));

// 放到 4 倍左右，截一张特写看图标是否还锐
const spot = await evaluate(`(() => {
    const box = document.querySelector('[data-role="handles"] [data-handle="move"] circle');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return {x: Math.round(r.left - 150), y: Math.round(r.top - 150)};
})()`);
console.log("截图区域:", JSON.stringify(spot));
// A/B：把 will-change 加回去截图，和当前版本对比（证明差异来自光栅化）
await evaluate(`(() => {
    const st = document.createElement('style');
    st.id = 'probe-willchange';
    st.textContent = '.annot-transform{will-change: transform !important}';
    document.head.append(st);
    return true;
})()`);
await sleep(300);
await evaluate(`(() => { const ed = window.__plugin.editor; ed.applyViewport(); return true; })()`);
await sleep(400);
const bad = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false, fromSurface: true,
    clip: {x: 0, y: 0, width: 1440, height: 900, scale: 2},
});
await writeFile(path.join(root, "deliverables", "mobile-ui-prototype", "shots",
    "v0266-对比-有willchange.png"), Buffer.from(bad.data, "base64"));
await evaluate(`document.getElementById('probe-willchange')?.remove()`);
await sleep(300);
await evaluate(`(() => { const ed = window.__plugin.editor; ed.applyViewport(); return true; })()`);
await sleep(400);
console.log("已截图：有/无 will-change 两张");

const shot = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false, fromSurface: true,
    clip: {x: 0, y: 0, width: 1440, height: 900, scale: 2},
});
await writeFile(path.join(root, "deliverables", "mobile-ui-prototype", "shots",
    "v0266-对比-无willchange.png"), Buffer.from(shot.data, "base64"));
console.log("已截图: v0265-放大4倍-手柄.png");

ws.close();
server.close();
process.exit(0);
