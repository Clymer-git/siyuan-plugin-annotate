/**
 * 移动端键盘弹出测试：模拟软键盘（压缩视口高度），验证
 *  ① 底部三栏与顶部参数条全部隐藏
 *  ② 画布上的标注**一格都不动**（这是 bug 的核心）
 *  ③ 输入框被抬到键盘上方
 *  ④ 退出编辑后全部还原
 *
 * 用法：node scripts/_probe-keyboard.mjs
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
            res.end("no");
        }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pend = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id);
        pend.delete(m.id);
        m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result);
    }
};
const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id;
    pend.set(i, {r, j});
    ws.send(JSON.stringify({id: i, method, params}));
});
const ev = async (expr) => {
    const out = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true});
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || "eval fail");
    return out.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
for (let i = 0; i < 80; i++) {
    if (await ev("window.__ready === true")) break;
    await sleep(100);
}
await sleep(400);

// 画一个矩形 + 一段文字（文字放在画布下方，方便验证「被键盘挡住时会不会抬起来」）
await ev(`(() => {
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
    fire('pointerdown', at(200, 200));
    fire('pointermove', at(400, 320));
    fire('pointerup', at(600, 460));
    document.querySelector('.annot-mobile-rail button[data-tool="text"]')?.click();
    fire('pointerdown', at(220, 700));
    fire('pointerup', at(220, 700));
    return true;
})()`);
await sleep(500);

const snap = `(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    const ed = window.__plugin?.editor;
    return {
        win: [innerWidth, innerHeight],
        vv: window.visualViewport ? [Math.round(visualViewport.width), Math.round(visualViewport.height)] : null,
        shape: box(document.querySelector('[data-layer="objects"] g.annot-object')),
        handles: box(q('[data-role="handles"] [data-handle="resize:se"] circle:last-of-type')),
        editor: box(q('.annot-text-editor')),
        editorTransform: q('.annot-text-editor')?.style.transform || '',
        rail: q('.annot-mobile-rail') ? getComputedStyle(q('.annot-mobile-rail')).display : null,
        styleBar: q('.annot-mobile-style') ? getComputedStyle(q('.annot-mobile-style')).display : null,
        topbar: q('.annot-mobile-topbar') ? getComputedStyle(q('.annot-mobile-topbar')).display : null,
        fabs: q('.annot-mobile-fabs') ? getComputedStyle(q('.annot-mobile-fabs')).display : null,
        keyboardClass: !!q('.annot-root')?.classList.contains('is-keyboard'),
        rootH: Math.round(q('.annot-root')?.getBoundingClientRect().height || 0),
        stageH: Math.round(q('.annot-stage')?.getBoundingClientRect().height || 0),
        lockH: q('.annot-root')?.style.getPropertyValue('--annot-lock-h') || '(none)',
        rootW: Math.round(q('.annot-root')?.getBoundingClientRect().width || 0),
        stageW: Math.round(q('.annot-stage')?.getBoundingClientRect().width || 0),
        mainW: Math.round(q('.annot-main')?.getBoundingClientRect().width || 0),
        svgStyle: (() => { const el = q('[data-role="svg"]'); if (!el) return null;
            const cs = getComputedStyle(el); return [cs.width, cs.height, cs.position]; })(),
        svgBox: (() => { const el = q('[data-role="svg"]'); if (!el) return null;
            const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
        viewBox: q('[data-role="svg"]')?.getAttribute('viewBox'),
        zoom: ed ? Math.round(ed.viewport.zoom * 1000) / 1000 : null,
        pan: ed ? [Math.round(ed.viewport.panX), Math.round(ed.viewport.panY)] : null,
    };
})()`;

console.log("① 编辑中（键盘未弹）:", JSON.stringify(await ev(snap)));

// 模拟软键盘：视口高度压到 500（真实设备上由系统改，这里是同一套事件）
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 500, deviceScaleFactor: 2, mobile: true});
await sleep(600);
console.log("② 键盘弹出:", JSON.stringify(await ev(snap)));

// 收起键盘
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
await sleep(600);
console.log("③ 键盘收起:", JSON.stringify(await ev(snap)));

ws.close();
server.close();
process.exit(0);
