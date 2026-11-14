/**
 * 实验脚本：复刻思源内核的静态资源响应方式（无 Cache-Control，只有 Last-Modified +
 * 支持 If-Modified-Since 304），验证「覆盖同名图片后，正文里的 <img> 怎样才能显示新图」。
 *
 * 三种策略各用一张独立的图（各自 URL、各自 mtime）：
 *   A. 只改 srcset（v0.10.6 的做法）
 *   B. 摘掉 src → 强制布局 → 写回同一地址
 *   C. 把 src 换成带 ?v= 的新地址（v0.10.5 的做法，已知会让思源查看器白屏，仅作对照）
 *
 * 依据（siyuan-src/siyuan-master）：
 *   kernel/server/serve.go:1212  最终是 http.ServeFile，secureAssetContentHeaders 不设 Cache-Control
 *   app/src/protyle/preview/image.ts:29 查看器用 src.endsWith(资源路径) 定初始索引
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-reload-probe.mjs
 */
import http from "node:http";
import zlib from "node:zlib";

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}
function solidPng(r, g, b, size = 60) {
    const raw = Buffer.alloc((size * 3 + 1) * size);
    let o = 0;
    for (let y = 0; y < size; y++) {
        raw[o++] = 0;
        for (let x = 0; x < size; x++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body), 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const RED = solidPng(220, 60, 60);
const BLUE = solidPng(60, 80, 220);
// 每张图独立维护版本与 mtime，模拟「刚刚被 putFile 覆盖」
const assets = new Map();
for (const name of ["a.png", "b.png", "c.png"]) {
    assets.set(name, {version: 1, mtime: Date.now() - 60000});
}

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<img id="a" src="/assets/a.png"><img id="b" src="/assets/b.png"><img id="c" src="/assets/c.png">
<script>
window.probe = (id) => {
  const img = document.getElementById(id);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(10, 10, 1, 1).data;
  return [d[0], d[1], d[2], img.naturalWidth];
};
</script></body></html>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
        res.end(page);
        return;
    }
    // 模拟 putFile 覆盖：内容换成蓝图、mtime 更新
    if (url.pathname === "/bump") {
        const name = url.searchParams.get("f");
        const item = assets.get(name);
        if (!item) { res.writeHead(404); res.end(); return; }
        item.version = 2;
        item.mtime = Date.now();   // 秒级精度，和 http.ServeFile 一致
        res.writeHead(200, {"Content-Type": "text/plain"});
        res.end("ok");
        return;
    }
    const name = url.pathname.replace("/assets/", "");
    const item = assets.get(name);
    if (!item) { res.writeHead(404); res.end(); return; }
    // 与 http.ServeFile 一致：只发 Last-Modified，支持 If-Modified-Since → 304
    const lastModified = new Date(Math.floor(item.mtime / 1000) * 1000);
    const since = req.headers["if-modified-since"];
    const body = item.version === 1 ? RED : BLUE;
    res.setHeader("Last-Modified", lastModified.toUTCString());
    res.setHeader("Content-Type", "image/png");
    if (since && new Date(since).getTime() >= lastModified.getTime()) {
        res.writeHead(304);
        res.end();
        return;
    }
    res.writeHead(200, {"Content-Length": body.length});
    res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find((t) => t.type === "page");
if (!target) { console.error("没有可用的页面，请先启动 Edge"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
});
const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
await wait(700);

for (const id of ["a", "b", "c"]) {
    console.log(`初始 ${id}:`, await evaluate(`window.probe("${id}")`));
}

// 三张图同时「被覆盖」
for (const f of ["a.png", "b.png", "c.png"]) {
    await fetch(`http://127.0.0.1:${port}/bump?f=${f}`);
}
await wait(1200);   // 跨过秒级 mtime 边界，让 Last-Modified 真的变大

const stamp = Date.now();
// A：只改 srcset
await evaluate(`(() => {
  const img = document.getElementById("a");
  img.setAttribute("srcset", "/assets/a.png?v=${stamp} 1x");
  return "ok";
})()`);
// B：摘掉 src → 强制布局 → 写回同一地址
await evaluate(`(() => {
  const img = document.getElementById("b");
  const src = img.getAttribute("src");
  img.removeAttribute("src");
  void img.offsetWidth;
  img.setAttribute("src", src);
  return "ok";
})()`);
// C：换成带 v 的新地址
await evaluate(`(() => {
  const img = document.getElementById("c");
  img.setAttribute("src", "/assets/c.png?v=${stamp}");
  return "ok";
})()`);

await wait(1200);

const a = await evaluate('window.probe("a")');
const b = await evaluate('window.probe("b")');
const c = await evaluate('window.probe("c")');
const isBlue = (p) => p[2] > 150 && p[0] < 120;
console.log("A 只改 srcset      :", a, isBlue(a) ? "新图 ✔" : "旧图 ✘");
console.log("B 摘 src 再写回    :", b, isBlue(b) ? "新图 ✔" : "旧图 ✘");
console.log("C 换成 ?v= 新地址  :", c, isBlue(c) ? "新图 ✔" : "旧图 ✘");
const srcA = await evaluate('document.getElementById("a").getAttribute("src")');
const srcB = await evaluate('document.getElementById("b").getAttribute("src")');
console.log("A 的 src 属性：", srcA);
console.log("B 的 src 属性：", srcB);

ws.close();
server.close();
