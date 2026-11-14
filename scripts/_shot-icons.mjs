import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const outDir = process.argv[2] || path.join(root, "deliverables", "milestone-6");

const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/" || url === "/index.html") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile(harnessFile)); }
    else if (url === "/index.js") { res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(path.join(distDir, "index.js"))); }
    else if (url === "/index.css") { res.setHeader("Content-Type", "text/css"); res.end(await readFile(path.join(distDir, "index.css"))); }
    else { res.statusCode = 404; res.end("nf"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, {resolve, reject}); ws.send(JSON.stringify({id: i, method, params})); });
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + JSON.stringify(r.exceptionDetails.exception?.description || "")); return r.result?.value; };
const shot = async (name) => {
    const data = await send("Page.captureScreenshot", {format: "png"});
    await writeFile(path.join(outDir, name), Buffer.from(data.data, "base64"));
    console.log("shot:", name);
};
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
for (let i = 0; i < 80; i++) { if (await evaluate("window.__ready === true")) break; await sleep(100); }
await sleep(400);

// 量两颗图标的实际渲染尺寸与颜色来源
const probe = `(() => {
    const out = {};
    const read = (sel) => {
        const svg = document.querySelector(sel);
        const p = svg?.querySelector("path");
        const r = svg?.getBoundingClientRect();
        return {box: r ? [Math.round(r.width), Math.round(r.height)] : null,
            viewBox: svg?.getAttribute("viewBox") || "",
            pathFill: p ? getComputedStyle(p).fill : "missing",
            pathStroke: p ? getComputedStyle(p).stroke : "missing"};
    };
    out.extend = read('[data-canvas-op="extend"] svg');
    out.spotlight = read('button[data-tool="spotlight"] svg');
    out.crop = read('[data-canvas-op="crop"] svg');
    return out;
})()`;
console.log("light:", JSON.stringify(await evaluate(probe)));
await shot("图标-浅色.png");

await evaluate(`document.documentElement.setAttribute('data-theme-mode', 'dark')`);
await sleep(420);
console.log("dark:", JSON.stringify(await evaluate(probe)));
await shot("图标-深色.png");
await evaluate(`document.documentElement.setAttribute('data-theme-mode', 'light')`);
await sleep(300);

server.closeAllConnections?.(); server.close(); ws.close();
