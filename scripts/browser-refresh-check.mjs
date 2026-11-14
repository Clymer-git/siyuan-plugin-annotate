/**
 * 真实浏览器（Edge headless + CDP）验证「覆盖保存后正文立刻刷新」（v0.10.11 回到 v0.10.5 方案）。
 *
 * 做法：本地服务对同一路径第一次给红图、之后给蓝图；页面里放一个和思源正文结构
 * 一致的 <img src data-src>；把产物里的 refreshImageSrc 原样注入执行，
 * 然后采样像素 —— 变蓝才说明浏览器真的重新下载了新内容。
 *
 * 同时把这条方案的已知代价写成断言：src 带上 `?v=` 之后，
 * 思源双击看图用 `src.endsWith(资源路径)` 定位会失败（preview/image.ts:29）。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-refresh-check.mjs [输出目录]
 */
import http from "node:http";
import zlib from "node:zlib";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const js = (await readFile(path.join(root, "dist", "index.js"))).toString("utf8");

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}
function solidPng(r, g, b, size = 40) {
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

let assetHits = 0;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>refresh</title></head>
<body style="margin:0">
<div class="protyle-wysiwyg">
  <div data-node-id="202611090000000-abcdefg" data-type="NodeParagraph">
    <span contenteditable="false" data-type="img" class="img"><span> </span>
      <span><img id="pic" src="/assets/demo.png" data-src="assets/demo.png"></span>
    <span> </span></span>
  </div>
</div>
</body></html>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"});
        res.end(PAGE);
        return;
    }
    if (url.pathname === "/assets/demo.png") {
        assetHits++;
        // 第一次（页面自带 src 那次）给红图，之后（带 ?v= 的请求）给蓝图
        const body = assetHits === 1 ? RED : BLUE;
        res.writeHead(200, {"Content-Type": "image/png", "Content-Length": body.length, "Cache-Control": "no-cache"});
        res.end(body);
        return;
    }
    res.writeHead(404); res.end("no");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

/* ---------------- 从产物里抠出真实实现 ---------------- */
function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) return "";
    let depth = 0;
    let quote = "";
    for (let i = source.indexOf("{", start); i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === "\\") { i++; continue; }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return source.slice(start, i + 1); }
    }
    return "";
}
const names = ["normalizeAssetPath", "refreshImageSrc"];
const missing = names.filter((n) => !extractFunction(js, n));
if (missing.length) {
    console.error("抽取失败：产物里找不到 ", missing);
    process.exit(1);
}
const impl = names.map((n) => extractFunction(js, n)).join("\n");

/* ---------------- CDP ---------------- */
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
    const result = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text + " " + (result.exceptionDetails.exception?.description || ""));
    }
    return result.result.value;
};

const results = [];
const check = (name, ok, detail = "") => {
    results.push({name, ok, detail});
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
await new Promise((r) => setTimeout(r, 600));

await evaluate(`${impl}; window.__refresh = refreshImageSrc; window.__probe = () => {
    const img = document.getElementById("pic"), c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(5, 5, 1, 1).data;
    return [d[0], d[1], d[2], img.naturalWidth];
}; "ok"`);

const before = await evaluate(`({
    src: document.getElementById("pic").getAttribute("src"),
    dataSrc: document.getElementById("pic").getAttribute("data-src"),
    pixels: window.__probe(),
})`);
check("初始加载的是红图（服务端首次响应）",
    before.pixels[0] > 180 && before.pixels[2] < 120 && before.pixels[3] === 40,
    JSON.stringify(before.pixels));
check("起始 src 是干净资源路径", before.src === "/assets/demo.png", before.src);

await evaluate('window.__refresh("assets/demo.png"); "done"');
await new Promise((r) => setTimeout(r, 500));

const after = await evaluate(`({
    src: document.getElementById("pic").getAttribute("src"),
    dataSrc: document.getElementById("pic").getAttribute("data-src"),
    pixels: window.__probe(),
})`);
check("刷新后 src 挂上缓存串（正文会重新下载）",
    /^\/assets\/demo\.png\?v=\d+$/.test(after.src || ""), after.src);
check("刷新后像素变成新图（浏览器真的重新下载了）",
    after.pixels[2] > 150 && after.pixels[0] < 120, JSON.stringify(after.pixels));
check("data-src 保持干净（思源资源路径不被动）",
    after.dataSrc === "assets/demo.png", after.dataSrc);
check("确实发出了第二次请求", assetHits >= 2, `${assetHits} 次`);
check("已知代价：带 ?v= 的 src 匹配不到资源路径（双击看图可能定位不到）",
    !after.src.endsWith("assets/demo.png") && !"assets/demo.png?v=1".endsWith("assets/demo.png"));

ws.close();
server.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n真实浏览器刷新验证：${results.length - failed}/${results.length} 通过`);
// CDP 的 socket 与本地 server 会残留 keep-alive 连接，不显式退出进程会一直挂着
process.exit(failed ? 1 : 0);
