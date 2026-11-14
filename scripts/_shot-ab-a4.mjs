/**
 * A/B 对照图：把「改前（dist 现状）」和「改后（方案 A4）」并排摆一张，
 * 两张截图同源、同视口、同对象，差异只来自界面改动。
 *
 * 前置：先跑 _shot-mock-a4.mjs 生成图，Edge 已在 9222 端口。
 * 用法：node scripts/_shot-ab-a4.mjs
 */
import http from "node:http";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shotsDir = path.join(root, "deliverables", "mobile-ui-prototype", "shots");

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:26px 30px 26px; background:#EEF1F6;
    font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color:#1F2937; }
  h1 { margin:0 0 3px; font-size:19px; font-weight:700; letter-spacing:.01em; }
  .sub { margin:0 0 20px; font-size:12.5px; color:#64748B; line-height:1.6; }
  .row { display:flex; gap:24px; align-items:flex-start; }
  .col { width:386px; }
  .cap { display:flex; align-items:baseline; gap:8px; margin:0 0 9px; }
  .tag { display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:700; }
  .tag.before { background:#E2E8F0; color:#475569; }
  .tag.after { background:#DBEAFE; color:#1D4ED8; }
  .cap b { font-size:13.5px; }
  .cap span.note { font-size:11px; color:#7C8798; }
  img { display:block; width:100%; border-radius:14px; box-shadow:0 4px 18px rgba(15,23,42,.13); }
  .legend { margin-top:20px; display:flex; flex-direction:column; gap:7px; font-size:12px; color:#475569; }
  .legend div { display:flex; align-items:flex-start; gap:7px; }
  .legend i { display:inline-block; flex:0 0 auto; width:10px; height:10px; border-radius:3px; margin-top:4px; }
  .dot-new { background:#2563EB; }
  .dot-keep { background:#CBD5E1; }
</style></head><body>
<h1>移动端 · 方案 A4 改前 / 改后对照</h1>
<p class="sub">两张图都是同一份代码（v0.22.2）在 390×844 触屏视口里真实渲染的结果。改后只在真实 DOM 上叠加：<br>
顶部悬浮栏、等宽的「缩放 / 对象」两颗按钮、五组属性框、整条底部 dock。</p>
<div class="row">
  <div class="col">
    <p class="cap"><span class="tag before">改前</span><b>当前 v0.22.2</b>
      <span class="note">参数只在底部一条，专属选项无处可放</span></p>
    <img src="/shots/方案A4-0-改前.png">
  </div>
  <div class="col">
    <p class="cap"><span class="tag after">改后</span><b>方案 A4</b>
      <span class="note">工具专属参数上浮为顶部栏</span></p>
    <img src="/shots/方案A4-1-常态.png">
  </div>
</div>
<div class="legend">
  <div><i class="dot-new"></i><span><b>新增顶部悬浮栏</b>：把 PC 悬浮条上的工具专属参数搬过来，每个参数一枚小方按钮；
    有多个选项的（箭头样式 / 编号格式 / 端点 / 圆角 / 放大倍数…）点开向下弹气泡，气泡里只留图案不带文字；开关型的（圆线）点一下直接切。</span></div>
  <div><i class="dot-new"></i><span><b>缩放 / 对象等宽</b>：两枚 80×36 同款按钮，整体相对屏幕居中，与两侧圆钮同一水平线。</span></div>
  <div><i class="dot-new"></i><span><b>属性栏补成五组</b>：颜色 / 粗细 / 线型 / 填充 / 字号，每类一个圆角矩形框（手机上原本没有「线型」）。</span></div>
  <div><i class="dot-keep"></i><span><b>底部合成一条 dock</b>：去掉每个按钮各自的小底，改成一整个圆角矩形。</span></div>
</div>
</body></html>`;

const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    try {
        if (url === "/" || url === "/index.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(PAGE);
            return;
        }
        if (url.startsWith("/shots/")) {
            const file = path.join(shotsDir, url.slice(7));
            res.setHeader("Content-Type", "image/png");
            res.end(await readFile(file));
            return;
        }
        res.statusCode = 404; res.end("no");
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0; const pending = new Map();
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
        const {resolve, reject} = pending.get(m.id); pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
});
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 900, height: 1240, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
await sleep(1500);
const metrics = await send("Page.getLayoutMetrics");
const fullHeight = Math.ceil(metrics.cssContentSize?.height || 1200);
console.log("页面高度:", fullHeight);
const shot = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: {x: 0, y: 0, width: 900, height: fullHeight, scale: 2},
});
const out = path.join(shotsDir, "方案A4-5-改前改后对照.png");
await writeFile(out, Buffer.from(shot.data, "base64"));
console.log("已截图:", out);
ws.close(); server.close(); process.exit(0);
