/**
 * 真实浏览器（Edge headless + CDP）：验证「自定义预设」的小窗永远不越出插件矩形。
 *
 * 单独成脚本的原因：它要把视口临时改窄（960×720），塞进长脚本里会打乱后面按
 * 1440×900 算坐标的实拍用例。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-pop-bounds.mjs
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

let failed = 0;
const check = (title, ok, detail = "") => {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${title}${detail ? `  [${detail}]` : ""}`);
};

await send("Page.enable");
await send("Runtime.enable");
// 故意用「小窗口」：插件只有 820 宽，最右侧的字号档一开小窗就必须往回挪
await send("Emulation.setDeviceMetricsOverride", {width: 820, height: 640, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) break;
    await sleep(100);
}

// 进入预设编辑模式
await evaluate(`(() => {
    document.querySelector('[data-action="settings"]')?.click();
    return true;
})()`);
await sleep(350);

// 最右侧一档（第 4 档字号）
await evaluate(`(() => {
    const list = document.querySelectorAll('[data-role="group-fonts"] [data-index]');
    list[list.length - 1].click();
    return true;
})()`);
await sleep(420);
const right = await evaluate(`(() => {
    const pop = document.querySelector('[data-role="attr-pop"]');
    const rb = document.querySelector('.annot-root').getBoundingClientRect();
    const pb = pop.getBoundingClientRect();
    return {
        inside: pb.left >= rb.left - 0.5 && pb.right <= rb.right + 0.5 &&
            pb.top >= rb.top - 0.5 && pb.bottom <= rb.bottom + 0.5,
        pop: [Math.round(pb.left), Math.round(pb.right)],
        root: [Math.round(rb.left), Math.round(rb.right)],
        position: getComputedStyle(pop).position,
        overflowRight: Math.round(pb.right - rb.right),
    };
})()`);
check("最右侧的属性档：小窗自动向左挪，右边缘不越界",
    right.inside && right.overflowRight <= 0 && right.position === "absolute",
    `pop=${JSON.stringify(right.pop)} root=${JSON.stringify(right.root)} ${right.position}`);

// 最左侧一档（第 1 个颜色圆点）
await evaluate(`(() => {
    document.querySelector('[data-role="group-colors"] [data-index="0"]').click();
    return true;
})()`);
await sleep(420);
const left = await evaluate(`(() => {
    const pop = document.querySelector('[data-role="attr-pop"]');
    const rb = document.querySelector('.annot-root').getBoundingClientRect();
    const pb = pop.getBoundingClientRect();
    return {
        inside: pb.left >= rb.left - 0.5 && pb.right <= rb.right + 0.5,
        pop: [Math.round(pb.left), Math.round(pb.right)],
        root: [Math.round(rb.left), Math.round(rb.right)],
        overflowLeft: Math.round(rb.left - pb.left),
    };
})()`);
check("最左侧的圆点：小窗不会探出左边界",
    left.inside && left.overflowLeft <= 0,
    `pop=${JSON.stringify(left.pop)} root=${JSON.stringify(left.root)}`);

// 填充小窗：只有不透明度，没有色板
await evaluate(`(() => {
    document.querySelector('[data-role="group-fills"] [data-index="1"]')?.click();
    return true;
})()`);
await sleep(380);
const fill = await evaluate(`(() => {
    const pop = document.querySelector('[data-role="attr-pop"]');
    const panel = pop.querySelector('[data-panel="fill"]');
    return {
        hasSlider: !!panel?.querySelector('[data-range="fillOpacity"]'),
        hasNumber: !!panel?.querySelector('[data-number="fillOpacity"]'),
        swatches: panel?.querySelectorAll('.annot-swatch2, [data-role="fill-picker"]').length || 0,
        title: (panel?.querySelector('.annot-attr-panel__head')?.textContent || "").trim(),
    };
})()`);
check("填充分组的小窗只有「滑块 + 数字框」，没有颜色面板",
    fill.hasSlider && fill.hasNumber && fill.swatches === 0 && fill.title.includes("填充"),
    JSON.stringify(fill));

await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
server.closeAllConnections?.();
server.close();
ws.close();
console.log(`\n小窗边界校验：${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
if (failed) process.exitCode = 1;
