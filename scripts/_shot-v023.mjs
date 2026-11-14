/**
 * v0.23.0 真机形态截图：完全用 dist 里的真实产物渲染，不注入任何样式。
 * 只做「点按钮」这种用户也会做的操作，用来确认顶部悬浮栏、气泡、等宽胶囊的落地效果。
 *
 * 前置：Edge 用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 * 用法：node scripts/_shot-v023.mjs
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

// ---- 画 3 个对象，然后停在箭头工具 ----
const drawn = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const cw = Number(svg.getAttribute('width')) || 1200;
    const ch = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x / cw * rect.width, clientY: rect.top + y / ch * rect.height});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY}));
    const pick = (tool) => {
        const btn = document.querySelector('.annot-mobile-rail [data-tool="' + tool + '"]');
        if (btn) btn.click();
        return !!btn;
    };
    const draw = (tool, x1, y1, x2, y2) => {
        if (!pick(tool)) return;
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    draw('arrow', 240, 640, 560, 340);
    draw('rect', 720, 240, 1100, 480);
    draw('ellipse', 940, 580, 1140, 740);
    pick('arrow');
    return {
        objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
        topbar: !!document.querySelector('[data-role="mobile-topbar"]'),
        topbarHidden: document.querySelector('[data-role="mobile-topbar"]')?.hidden,
        buttons: [...document.querySelectorAll('.annot-mobile-topbar__btn')].map((b) => b.textContent.trim() + '[' + b.className + ']'),
        pills: [...document.querySelectorAll('.annot-fab-pill')].map((b) => b.textContent.trim()),
        groups: [...document.querySelectorAll('[data-group]')].map((g) => g.dataset.group),
    };
})()`);
console.log("实时状态:", JSON.stringify(drawn));

await sleep(300);
await shot("v023-1-常态.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

// 点开「箭头样式」气泡
const opened = await evaluate(`(() => {
    document.querySelector('.annot-mobile-topbar__btn[data-pop="arrowStyle"]')?.click();
    const pop = document.querySelector('[data-role="mobile-pop"]');
    const items = [...document.querySelectorAll('.annot-mobile-pop__item')];
    const r = pop?.getBoundingClientRect();
    return {open: !!pop, count: items.length, texts: items.map((i) => i.textContent.trim()),
        box: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null};
})()`);
console.log("气泡:", JSON.stringify(opened));
await sleep(300);
await shot("v023-2-箭头气泡.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});
await shot("v023-3-顶部栏特写.png", {x: 0, y: 50, width: 390, height: 300, scale: 3});

// 选一项，确认收起 + 生效
const picked = await evaluate(`(() => {
    document.querySelector('.annot-mobile-pop__item[data-value="modern"]')?.click();
    return new Promise((resolve) => setTimeout(() => {
        const active = document.querySelector('.annot-mobile-topbar__btn[data-pop="arrowStyle"]');
        resolve({popClosed: !document.querySelector('[data-role="mobile-pop"]'),
                 iconTouched: !!active});
    }, 60));
})()`);
console.log("选完:", JSON.stringify(picked));

// 切矩形：顶栏应该只剩「圆角」
const rectState = await evaluate(`(() => {
    document.querySelector('.annot-mobile-rail [data-tool="rect"]')?.click();
    return new Promise((resolve) => setTimeout(() => resolve({
        buttons: [...document.querySelectorAll('.annot-mobile-topbar__btn')].map((b) => b.textContent.trim()),
    }), 60));
})()`);
console.log("矩形工具:", JSON.stringify(rectState));

ws.close();
server.close();
process.exit(0);
