/**
 * 全屏验证：进全屏前后，顶栏那排按钮的屏幕位置必须一模一样。
 *
 * 之前用 --annot-fs-safe-right 给顶栏右侧「让位」给思源原生三键，
 * 结果按钮先右后左跳一段；那三个按钮全屏时本来就被 Chromium 撤掉了，
 * 根本不需要让位。这个脚本就是量这件事。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 * 用法：node scripts/_probe-fullscreen.mjs
 */
import http from "node:http";
import {readFile} from "node:fs/promises";
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
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/?r=${Date.now()}`});
for (let i = 0; i < 90; i++) {
    if (await evaluate("window.__ready === true")) break;
    await sleep(100);
}
await sleep(400);

const probe = `(() => {
    const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    };
    const bar = document.querySelector('.annot-titlebar');
    const save = document.querySelector('[data-action="save"]');
    return {
        win: [innerWidth, innerHeight],
        titlebar: box('.annot-titlebar'),
        paddingRight: bar ? getComputedStyle(bar).paddingRight : null,
        saveBtn: save ? (() => { const r = save.getBoundingClientRect();
            return [Math.round(r.x), Math.round(r.right), Math.round(r.width)]; })() : null,
        fullscreenBtn: box('[data-action="fullscreen"]'),
        safeRight: document.querySelector('.annot-root')?.style.getPropertyValue('--annot-fs-safe-right') || '(none)',
        isFullscreen: document.fullscreenElement ? document.fullscreenElement.tagName : null,
        overlayVisible: navigator.windowControlsOverlay ? navigator.windowControlsOverlay.visible : 'n/a',
    };
})()`;

const before = await evaluate(probe);
console.log("全屏前:", JSON.stringify(before));

await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
for (const wait of [300, 900, 1800, 2600]) {
    await sleep(wait === 300 ? 300 : 600);
    const now = await evaluate(probe);
    console.log(`全屏后 +${wait}ms:`, JSON.stringify(now));
}

await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
await sleep(900);
const after = await evaluate(probe);
console.log("还原后:", JSON.stringify(after));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log("结论：顶栏宽高一致 =", same(before.titlebar?.[2], after.titlebar?.[2]),
    "｜保存按钮右边缘 前/后 =", before.saveBtn?.[1], "/", after.saveBtn?.[1]);

ws.close();
server.close();
process.exit(0);
