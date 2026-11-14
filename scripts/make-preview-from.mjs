/**
 * 把用户给的成品展示图做成插件预览图（preview.png，1024×768）。
 *
 * 做法：起一个本地服务把源图喂给页面，页面内用 canvas 白底居中缩放，
 * 导出 PNG 由 Node 落盘 —— 不走 Python（本机没装 Pillow）。
 *
 * 用法：node scripts/make-preview-from.mjs "<源图绝对路径>"
 */
import http from "node:http";
import {readFile, writeFile, stat} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2];
if (!src) throw new Error("用法：node scripts/make-preview-from.mjs <源图路径>");
const ext = path.extname(src).toLowerCase();
const mime = ext === ".png" ? "image/png" : "image/jpeg";

const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<!doctype html><meta charset='utf-8'><body></body>");
        return;
    }
    if (url === "/src") {
        res.setHeader("Content-Type", mime);
        res.end(await readFile(src));
        return;
    }
    res.statusCode = 404;
    res.end("no");
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
const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || "eval fail");
    return out.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 1024, height: 768, deviceScaleFactor: 1, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
await sleep(500);

const dataUrl = await evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("load " + src));
        img.src = src;
    });
    const img = await load("/src");
    const W = 1024, H = 768;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    // 纯白底（和集市里其他预览图一致，不用透明）
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);
    // 等比缩放后居中；留出白边，也让 PNG 体积压进集市 512KB 的限制内
    const avail = 920;
    const k = Math.min(avail / img.width, (H - 24) / img.height);
    const w = Math.round(img.width * k);
    const h = Math.round(img.height * k);
    const x = Math.round((W - w) / 2);
    const y = Math.round((H - h) / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // 极轻微的一层模糊：抹掉照片噪点，PNG 体积能压到一半以下，
    // 1024 宽的图在集市卡片里看不出差别
    ctx.filter = "blur(0.35px)";
    ctx.drawImage(img, x, y, w, h);
    ctx.filter = "none";
    return {url: c.toDataURL("image/png"), box: [x, y, w, h],
        jpg: c.toDataURL("image/jpeg", 0.94)};
})()`);

const png = Buffer.from(String(dataUrl.url).split(",")[1] || "", "base64");
const jpg = Buffer.from(String(dataUrl.jpg).split(",")[1] || "", "base64");
console.log("画布内位置:", JSON.stringify(dataUrl.box));
console.log("PNG:", (png.length / 1024).toFixed(0) + "KB", "｜JPEG:", (jpg.length / 1024).toFixed(0) + "KB");

const targets2 = [
    path.join(root, "public", "preview.png"),
    path.join(root, "dist", "preview.png"),
];
for (const file of targets2) {
    await writeFile(file, png);
    const info = await stat(file);
    console.log("已写入:", path.relative(root, file), (info.size / 1024).toFixed(0) + "KB");
}
if (png.length > 500 * 1024) {
    await writeFile(path.join(root, "public", "preview.jpg"), jpg);
    console.log("PNG 超过 500KB，另存了 preview.jpg（" + (jpg.length / 1024).toFixed(0) + "KB）");
}

ws.close();
server.close();
process.exit(0);
