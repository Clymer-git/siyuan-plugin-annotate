/**
 * 真实浏览器（Edge headless + CDP）截「扩展画布」面板，供交付预览与人眼走查。
 *
 * 这些细节 jsdom 看不出好坏：锁链图标的粗细、未选中方向整行淡下去的程度、
 * 自定义色块上十字的线宽与旁边的吸管图标是否协调。只能真截出来看。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-panel-shot.mjs [输出目录]
 */
import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
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
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
let ready = false;
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) { ready = true; break; }
    await sleep(100);
}
if (!ready) throw new Error("harness 未就绪：" + await evaluate("window.__error"));
await sleep(300);

const shotElement = async (selector, file, scale = 2, pad = 8) => {
    const box = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {x: r.left, y: r.top, width: r.width, height: r.height};
    })()`);
    if (!box) throw new Error("找不到元素：" + selector);
    const result = await send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false,
        clip: {
            x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
            width: box.width + pad * 2, height: box.height + pad * 2, scale,
        },
    });
    await writeFile(path.join(outDir, file), Buffer.from(result.data, "base64"));
    console.log("已截图:", path.join(outDir, file));
};

// 1) 打开扩展画布面板（默认四周同步：只有「上」可输入）
await evaluate(`document.querySelector('[data-canvas-op="extend"]').click()`);
await sleep(250);
await shotElement('[data-role="extend-pop"]', "扩展面板.png");

// 2) 只选「上」：其余三行整行锁死（淡灰、不能输入）
await evaluate(`(() => {
    // 先取消全选，再单独选上
    document.querySelector('[data-dir="all"]').click();
    document.querySelector('[data-dir="top"]').click();
})()`);
await sleep(250);
const locks = await evaluate(`(["top","bottom","left","right"]).map((d) => {
    const input = document.querySelector('[data-role="extend-' + d + '"]');
    const row = input?.closest(".annot-amount");
    return d + ":" + (input?.disabled ? "锁" : "可输入") + (row?.classList.contains("is-locked") ? "(灰)" : "");
}).join("  ")`);
console.log("锁定状态:", locks);
await shotElement('[data-role="extend-pop"]', "扩展面板-只选上方时其余锁死.png");

// 3) 放大看锁链图标与自定义色块的十字
await evaluate(`(() => {
    document.querySelector('[data-dir="all"]').click();
})()`);
await sleep(200);
await shotElement('[data-role="extend-bgs"]', "自定义色块细节.png", 5, 10);

ws.close();
server.close();
console.log("\n面板截图完成");
process.exit(0);
