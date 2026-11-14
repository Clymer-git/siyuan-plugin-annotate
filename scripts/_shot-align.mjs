/**
 * 临时脚本：截「对齐模式」的多选与对齐面板，用于人眼走查。
 * 用法：node scripts/_shot-align.mjs [输出目录]
 */
import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + " :: " + JSON.stringify(result.exceptionDetails.exception?.description || ""));
    return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
for (let i = 0; i < 60; i++) {
    if (await evaluate("window.__ready === true")) break;
    await sleep(100);
}
await evaluate(`fetch('/theme.css').then(r => r.text()).then(t => {
    const el = document.createElement('style'); el.textContent = t; document.head.append(el); return true;
})`);
await sleep(300);

const shot = async (file) => {
    const result = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    await writeFile(path.join(outDir, file), Buffer.from(result.data, "base64"));
    console.log("已截图:", file);
};

// 三个散落的图形：矩形 / 椭圆 / 箭头
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY}));
    const draw = (tool, x1, y1, x2, y2) => {
        document.querySelector('button[data-tool="' + tool + '"]').click();
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    draw('rect', 180, 220, 460, 400);
    draw('ellipse', 560, 300, 860, 500);
    draw('arrow', 300, 620, 760, 560);
    document.querySelector('button[data-tool="select"]').click();
    return true;
})()`);
await sleep(200);

// 进对齐模式 + Ctrl 点选两个
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    document.querySelector('[data-action="align-mode"]').click();
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const ctrlClick = (back, x, y) => {
        const gs = groups();
        const hit = gs[gs.length - back]?.querySelector('[data-role="hit"]');
        if (!hit) return;
        const p = at(x, y);
        for (const type of ['pointerdown', 'pointerup']) {
            hit.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.clientX, clientY: p.clientY}));
        }
    };
    ctrlClick(3, 300, 300);
    ctrlClick(2, 700, 400);
    return true;
})()`);
await sleep(320);
await shot("对齐-1-多选与面板.png");

// 左对齐
await evaluate(`document.querySelector('[data-action="align-op"][data-value="left"]').click()`);
await sleep(320);
await shot("对齐-2-左对齐结果.png");

// 三个一起横向分布
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true}));
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const hit = groups()[groups().length - 1]?.querySelector('[data-role="hit"]');
    if (hit) {
        const p = at(520, 580);
        for (const type of ['pointerdown', 'pointerup']) {
            hit.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.clientX, clientY: p.clientY}));
        }
    }
    return true;
})()`);
await sleep(200);
await evaluate(`document.querySelector('[data-action="align-op"][data-value="distribute-x"]').click()`);
await sleep(320);
await shot("对齐-3-横向分布.png");

const report = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const bar = q('[data-role="context-bar"]');
    const align = q('.annot-context__align');
    return {
        alignButtons: document.querySelectorAll('[data-action="align-op"]').length,
        barWidth: Math.round(bar.getBoundingClientRect().width),
        barOverflow: bar.scrollWidth > bar.clientWidth + 1,
        alignWidth: align ? Math.round(align.getBoundingClientRect().width) : 0,
        selected: document.querySelectorAll('[data-layer="objects"] g.annot-object.is-selected').length,
        union: !!document.querySelector('[data-layer="overlay"] .annot-selection-union'),
        iconSize: (() => { const s = q('[data-action="align-op"] svg'); return s ? Math.round(s.getBoundingClientRect().width) : 0; })(),
    };
})()`);
console.log("状态:", JSON.stringify(report));
server.close();
ws.close();
