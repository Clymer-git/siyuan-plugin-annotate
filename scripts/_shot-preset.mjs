/**
 * 临时脚本：截「自定义预设编辑模式」的顶栏与参数悬浮窗，用于人眼走查。
 * 用法：node scripts/_shot-preset.mjs [输出目录]
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

// 画一个矩形和一个箭头，让「实时预览」看得见
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
    draw('rect', 420, 260, 720, 470);
    draw('arrow', 260, 600, 560, 340);
    return true;
})()`);
await sleep(200);
await shot("预设模式-0-常态顶栏.png");

// 进入编辑模式：齿轮 → 取消 / 应用 / 恢复默认
await evaluate(`document.querySelector('[data-action="settings"]').click()`);
await sleep(200);
await shot("预设模式-1-顶栏按钮.png");

// 点第 3 档线宽：小窗里是滑块 + 数字框
await evaluate(`document.querySelector('[data-role="group-widths"] [data-index="2"]').click()`);
await sleep(260);
await shot("预设模式-2-粗细.png");

// 点第 1 个颜色：小窗里是色板 + 取色器
await evaluate(`document.querySelector('[data-role="group-colors"] [data-index="0"]').click()`);
await sleep(260);
await shot("预设模式-3-颜色.png");

// 点「虚线」：只调虚线的间距
await evaluate(`document.querySelector('[data-role="group-lines"] [data-index="1"]').click()`);
await sleep(200);
await evaluate(`(() => {
    const gap = document.querySelector('[data-number="lineDashGap"]');
    gap.value = '16';
    gap.dispatchEvent(new Event('input', {bubbles: true}));
    gap.dispatchEvent(new Event('change', {bubbles: true}));
    return true;
})()`);
await sleep(320);
await shot("预设模式-4-线型间距.png");

// 退出：应用
await evaluate(`document.querySelector('[data-action="preset-apply"]').click()`);
await sleep(260);
await shot("预设模式-5-应用后.png");

const report = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const pop = q('[data-role="attr-pop"]');
    const bar = q('.annot-toolbar');
    return {
        editing: q('.annot-root').classList.contains('is-preset-edit'),
        popHidden: pop.hidden,
        barHeight: Math.round(bar.getBoundingClientRect().height),
        barScroll: bar.scrollWidth > bar.clientWidth,
        rectStroke: document.querySelector('[data-layer="objects"] rect.annot-shape')?.getAttribute('stroke-dasharray'),
    };
})()`);
console.log("状态:", JSON.stringify(report));
server.close();
ws.close();
