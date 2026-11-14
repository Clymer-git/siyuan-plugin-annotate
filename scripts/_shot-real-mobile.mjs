/**
 * 真实移动端界面截取：加载 dist 里的真实 index.js + index.css，
 * 在 390×844 触屏视口下渲染，截出来的就是代码当前版本的样子。
 *
 * 之前的设计稿是手写的静态 HTML，里面的数字（31%、对象 3）都是占位；
 * 用户拿真机截图一对就露馅了。这个脚本改成"只信代码"：
 * 结构、尺寸、颜色、文案全部由 dist 产物自己渲染，脚本不写任何样式。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/_shot-real-mobile.mjs [输出目录]
 */
import http from "node:http";
import {readFile, writeFile, access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
const outDir = process.argv[2] || path.join(root, "deliverables", "mobile-ui-prototype", "shots");

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
    const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error("CDP 超时: " + method)); }
    }, 15000);
    pending.get(id).timer = timer;
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
// 390×844 = iPhone 14 逻辑分辨率；mobile:true 会让 (pointer: coarse) 匹配，
// 插件的 isMobileRuntime() 才会走进移动端分支
await send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
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

const report = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
    const rootEl = q('.annot-root');
    const zoom = q('[data-role="mobile-zoom"]');
    return {
        mobileClass: !!q('.annot-root--mobile'),
        viewport: [innerWidth, innerHeight],
        coarse: matchMedia('(pointer: coarse)').matches,
        zoomText: zoom ? zoom.textContent : null,
        fabs: box(q('.annot-mobile-fabs')),
        fabCount: document.querySelectorAll('.annot-fab').length,
        zoomBox: box(q('.annot-mobile-zoom')),
        styleBar: box(q('.annot-mobile-style')),
        rail: box(q('.annot-mobile-rail')),
        imagebar: box(q('.annot-imagebar')),
        titlebar: box(q('.annot-titlebar')),
        status: box(q('.annot-status')),
        styleButtons: [...document.querySelectorAll('.annot-mobile-style .annot-preset-button, .annot-mobile-style [data-preset]')]
            .map(el => (el.textContent || '').trim()).slice(0, 30),
        styleGroups: [...document.querySelectorAll('.annot-mobile-style .annot-group')].map(el => ({
            label: (el.querySelector('.annot-group__label')||{}).textContent || '',
            box: box(el),
        })),
        tools: [...document.querySelectorAll('.annot-mobile-rail .annot-mobile-tool')]
            .map(el => (el.getAttribute('data-tool') || el.getAttribute('data-action') || el.textContent || '').trim()),
        rootBox: box(rootEl),
        cssVar: (() => { const cs = getComputedStyle(document.documentElement);
            return {accent: cs.getPropertyValue('--annot-accent').trim(),
                    panel: cs.getPropertyValue('--annot-panel').trim(),
                    railH: cs.getPropertyValue('--annot-rail-h').trim(),
                    styleH: cs.getPropertyValue('--annot-style-h').trim()}; })(),
    };
})()`);
console.log("=== dist 真实移动端渲染结果 ===");
console.log(JSON.stringify(report, null, 2));

const shot = async (file, clip) => {
    const result = await send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false, clip, fromSurface: true,
    });
    const buf = Buffer.from(result.data, "base64");
    await writeFile(path.join(outDir, file), buf);
    console.log("已截图:", path.join(outDir, file), (buf.length / 1024).toFixed(0) + "KB");
};

await shot("真实移动端-01-当前界面.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

ws.close();
server.close();
process.exit(0);
