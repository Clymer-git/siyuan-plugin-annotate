/**
 * 手柄在缩放下的实际尺寸诊断：放大 3 倍前后，量手柄的「图片单位半径」和「屏幕像素半径」。
 * 期望：图片单位半径随 zoom 反比变小，屏幕像素半径恒定。
 *
 * 用法：node scripts/_probe-handle-zoom.mjs
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
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
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
    document.querySelector('.annot-mobile-rail button[data-tool="rect"]')?.click();
    fire('pointerdown', at(300, 260));
    fire('pointermove', at(500, 380));
    fire('pointerup', at(700, 520));
    return true;
})()`);
await sleep(400);

const probe = `(() => {
    const ed = window.__plugin?.editor;
    const zoom = ed?.viewport?.zoom ?? null;
    const dot = document.querySelector('[data-role="handles"] [data-handle="resize:se"] circle:last-of-type');
    const move = document.querySelector('[data-role="handles"] [data-handle="move"]');
    const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10];
    };
    const rAttr = (el) => (el ? Number(el.getAttribute("r")) : null);
    return {
        zoom: zoom ? Math.round(zoom * 1000) / 1000 : null,
        dotR_image: rAttr(dot),
        dotBox_css: box(dot),
        moveR_image: rAttr(move?.querySelector("circle")),
        moveBox_css: box(move?.querySelector("circle")),
        handlesCount: document.querySelectorAll('[data-role="handles"] [data-handle]').length,
        selectedIds: ed ? [...(ed.selectedIds || [])] : null,
        objects: ed && ed.scene ? ed.scene.objects.length : null,
        editingText: ed ? ed.editingTextId : null,
        activeTool: ed ? ed.activeTool : null,
    };
})()`;

console.log("初始:", JSON.stringify(await evaluate(probe)));
const pinch = async (times) => {
    for (let i = 0; i < times; i++) {
        await evaluate(`(() => {
            const svg = document.querySelector('[data-role="svg"]');
            const ptr = (type, x, y, id) => {
                const e = new PointerEvent(type, {bubbles: true, cancelable: true,
                    pointerId: id, pointerType: 'touch', button: 0, buttons: 1,
                    clientX: x, clientY: y});
                svg.dispatchEvent(e);
            };
            const touch = (type, count) => {
                const e = new Event(type, {bubbles: true, cancelable: true});
                Object.assign(e, {touches: Array.from({length: count}, (_, k) => ({clientX: 120 + k * 60, clientY: 400})),
                    targetTouches: [], changedTouches: []});
                document.querySelector('.annot-stage').dispatchEvent(e);
            };
            touch('touchstart', 1); ptr('pointerdown', 150, 400, 1);
            touch('touchstart', 2); ptr('pointerdown', 240, 400, 2);
            for (const [x1, x2] of [[120, 270], [90, 300], [60, 330], [30, 360]]) {
                ptr('pointermove', x1, 400, 1);
                ptr('pointermove', x2, 400, 2);
            }
            ptr('pointerup', 30, 400, 1); ptr('pointerup', 360, 400, 2);
            touch('touchend', 0);
            return true;
        })()`);
        await sleep(420);
        console.log(`捏合第 ${i + 1} 次:`, JSON.stringify(await evaluate(probe)));
    }
};
await pinch(3);

ws.close();
server.close();
process.exit(0);
