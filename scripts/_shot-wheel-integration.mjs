import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""), "..");
const outDir = path.join(root, "deliverables", "milestone-6");
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile(path.join(root, "scripts/browser-harness.html"))); }
  else if (url === "/index.js") { res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(path.join(root, "dist/index.js"))); }
  else if (url === "/index.css") { res.setHeader("Content-Type", "text/css"); res.end(await readFile(path.join(root, "dist/index.css"))); }
  else { res.statusCode = 404; res.end("nf"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, {resolve, reject}); ws.send(JSON.stringify({id: i, method, params})); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expr) => { const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception?.description || "")); return r.result?.value; };
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", {type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1});
const shot = async (name) => { const d = await send("Page.captureScreenshot", {format: "png"}); await writeFile(path.join(outDir, name), Buffer.from(d.data, "base64")); console.log("shot", name); };

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 2, mobile: false});

const openEd = async () => {
  await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
  for (let i = 0; i < 60; i++) { if (await evaluate("window.__ready === true")) break; await sleep(100); }
  await sleep(350);
};

await openEd();
const svg = await evaluate(`(() => { const b = document.querySelector('[data-role="svg"]').getBoundingClientRect(); return {x: b.left, y: b.top, w: b.width, h: b.height}; })()`);
const at = (x, y) => [svg.x + x / 1200 * svg.w, svg.y + y / 800 * svg.h];
await evaluate(`document.querySelector('button[data-tool="rect"]').click()`);
let p = at(180, 150); let q = at(520, 380);
await mouse("mousePressed", p[0], p[1]); await mouse("mouseMoved", q[0], q[1]); await mouse("mouseReleased", q[0], q[1]);
await sleep(250);
await evaluate(`document.querySelector('[data-role="sidebar"] [data-role="object-item"]')?.click()`);
await sleep(200);

// 1) 顶栏圆球
await evaluate(`document.querySelector('[data-role="custom-color"]').click()`);
await sleep(500);
await shot("色轮-1-顶栏圆球.png");
await evaluate(`document.querySelector('[data-action="color-pop-close"]')?.click()`);
await sleep(200);

// 2) 属性面板
await evaluate(`document.querySelector('[data-role="sidebar"] .annot-color-input[data-prop="color"]').click()`);
await sleep(500);
await shot("色轮-2-属性面板.png");
await evaluate(`document.querySelector('[data-action="color-pop-close"]')?.click()`);
await sleep(200);

// 3) 预设色点
await evaluate(`document.querySelector('[data-action="settings"]').click()`);
await sleep(250);
await evaluate(`document.querySelector('[data-role="group-colors"] [data-index="2"]').click()`);
await sleep(450);
await shot("色轮-3-预设色点.png");
await evaluate(`document.querySelector('[data-action="preset-cancel"]')?.click()`);
await sleep(200);

// 4) 深色主题下打开顶栏圆球
await evaluate(`document.documentElement.setAttribute('data-theme-mode', 'dark')`);
await sleep(500);
await evaluate(`document.querySelector('[data-role="custom-color"]').click()`);
await sleep(500);
await shot("色轮-4-深色主题.png");
await evaluate(`document.documentElement.setAttribute('data-theme-mode', 'light')`);
await sleep(300);

// 5) 移动端
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
await openEd();
await evaluate(`document.querySelector('[data-action="mobile-color"]')?.click()`);
await sleep(500);
await shot("色轮-5-移动端.png");

ws.close(); server.close();
