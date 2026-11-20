/**
 * 真实浏览器（Edge headless + CDP）验证「覆盖同名 PNG + 内嵌工程数据」这条链路。
 *
 * jsdom 只能证明代码跑了，证明不了浏览器真的认我们写回去的 PNG：
 * PNG 块写坏、CRC 算错、成品画面没烘焙上，落到用户眼里都是一张白图。
 * 这里在 Chromium 里走完整流程：
 *   打开编辑器 → 画标注 → 保存 → 拿到写回去的 PNG 字节 →
 *   把它当普通 <img> 加载 → 量 naturalWidth / 采样像素 / 截图人眼走查 →
 *   再从 tEXt 里读回工程数据，确认能继续编辑、旋转、裁剪与扩回外围。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-svg-check.mjs [输出目录]
 */
import http from "node:http";
import zlib from "node:zlib";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-svg-harness.html");
const outDir = process.argv[2] || root;

// ---- 造一张 1200×800 的底图（灰底 + 两块色块），避免依赖外部素材 ----
function makePng(width, height) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0;
        for (let x = 0; x < width; x++) {
            const inBlockA = x > 150 && x < 450 && y > 150 && y < 420;
            const inBlockB = x > 700 && x < 1050 && y > 380 && y < 700;
            const [r, g, b] = inBlockA ? [154, 166, 187] : inBlockB ? [187, 166, 154] : [216, 221, 230];
            raw[o++] = r;
            raw[o++] = g;
            raw[o++] = b;
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body), 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function crc32(buf) {
    let c = ~0;
    for (const byte of buf) {
        c ^= byte;
        for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return (~c) >>> 0;
}

const png = makePng(1200, 800);

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
        } else if (url === "/assets/demo.png" || url === "/assets/fresh.png" || url === "/assets/crop.png" || url === "/assets/text.png") {
            res.setHeader("Content-Type", "image/png");
            res.end(png);
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
await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
});
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
await send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
let ready = false;
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) { ready = true; break; }
    await sleep(100);
}
if (!ready) throw new Error("harness 未就绪：" + await evaluate("window.__error"));
await sleep(400);

const results = [];
const check = (name, ok, detail = "") => {
    results.push({name, ok: Boolean(ok), detail});
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
};

/**
 * 实拍像素取样：先截当前页面，再把 PNG 交回浏览器自己解码读点。
 * DOM 断言只能证明尺寸数字对了，证明不了「画面真的只剩裁出来的那一块」——
 * 之前反复出问题的正是这里：数字是 400×300，画面却还整张铺着。
 */
// 测试页里可能叠着好几个对话框，正在操作的那个被挤到首屏之外。
// 截图前临时把它固定到视口最上层，截完立刻还原（不改插件状态）。
const pinDialog = () => evaluate(`(() => {
    const layer = document.querySelector('[data-role="transform"]');
    const dialog = layer?.closest('.b3-dialog');
    if (!dialog) return false;
    window.__savedDialogStyle = dialog.getAttribute("style") || "";
    dialog.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:9998;background:#fff";
    return true;
})()`);
const unpinDialog = () => evaluate(`(() => {
    const dialog = document.querySelector('[data-role="transform"]')?.closest('.b3-dialog');
    if (dialog) dialog.setAttribute("style", window.__savedDialogStyle || "");
    return true;
})()`);
const saveShot = async (name) => {
    await pinDialog();
    await sleep(220);
    const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    await writeFile(path.join(outDir, name), Buffer.from(shot.data, "base64"));
    console.log("已截图:", path.join(outDir, name));
    await unpinDialog();
};
const samplePixels = async (pointsExpression) => {
    await pinDialog();
    await sleep(220);
    const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    const sampled = await evaluate(`(async () => {
        const img = new Image();
        img.src = "data:image/png;base64,${shot.data}";
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const points = (${pointsExpression});
        const out = {};
        for (const name of Object.keys(points)) {
            const p = points[name];
            out[name] = Array.from(ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data);
        }
        return out;
    })()`);
    await unpinDialog();
    return sampled;
};

/** 取两个点：画布里原图 (200,200) 的深色块、画布右外侧的舞台背景 */
const CROP_PIXEL_POINTS = `(() => {
    const layer = document.querySelector('[data-role="transform"]');
    const svg = document.querySelector('[data-role="svg"]');
    const r = layer.getBoundingClientRect();
    const zoom = r.width / (Number(svg.getAttribute("width")) || 1);
    return {
        inside: {x: r.left + 190 * zoom, y: r.top + 190 * zoom},
        outside: {x: r.right + 24, y: r.top + r.height / 2},
    };
})()`;
const isBlockA = (c) => !!c && Math.abs(c[0] - 154) <= 14 && Math.abs(c[1] - 166) <= 14 && Math.abs(c[2] - 187) <= 14;
const isStage = (c) => !!c && c[0] > 205 && c[2] < 228;

// ---- 1) 画三个标注（红矩形 / 文字 / 箭头）----
const drawn = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const draw = (tool, x1, y1, x2, y2) => {
        document.querySelector('button[data-tool="' + tool + '"]').click();
        fire("pointerdown", at(x1, y1));
        fire("pointermove", at((x1 + x2) / 2, (y1 + y2) / 2));
        fire("pointerup", at(x2, y2));
    };
    // 用纯红，方便后面按像素验证"标注真的画进 SVG 了"
    document.querySelector('[data-role="group-colors"] button[data-value="#E53935"]')?.click();
    draw("rect", 500, 150, 900, 350);
    document.querySelector('[data-tool="text"]').click();
    fire("pointerdown", at(120, 700));
    const editor = document.querySelector(".annot-text-editor");
    if (!editor) return "no-editor";
    editor.value = "这里需要重点看";
    editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    draw("arrow", 300, 620, 700, 520);
    document.querySelector('button[data-tool="select"]').click();
    return document.querySelectorAll('[data-layer="objects"] g.annot-object').length;
})()`);
check("真实浏览器里画出了 3 个标注", drawn === 3, String(drawn));

// ---- 2) 点保存 ----
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(900);
const saved = await evaluate(`({
    puts: window.__puts,
    uploads: window.__uploads,
    updates: window.__updates,
    hasPng: window.__savedPng.startsWith("data:image/png;base64,"),
    length: window.__savedPng.length,
    pkg: window.__savedPackage ? {
        version: window.__savedPackage.version,
        objects: window.__savedPackage.scene?.objects?.length,
        canvas: window.__savedPackage.scene?.canvas,
        baseHead: (window.__savedPackage.base?.dataUrl || "").slice(0, 24),
    } : null,
})`);
check("保存时就地覆盖原来的 PNG（不上传任何新资源）",
    saved.puts.includes("data/assets/demo.png") && saved.uploads.length === 0,
    `写入=${saved.puts.join(",")} 上传=${saved.uploads.length}`);
check("保存不改笔记内容（不需要 updateBlock）", saved.updates.length === 0, String(saved.updates.length));
check("写回的是一张自带工程数据的 PNG",
    saved.hasPng && saved.pkg?.version === 1 && saved.pkg?.objects === 3,
    `${saved.length} 字符 / ${JSON.stringify(saved.pkg)}`);
check("工程数据里留着完整原始底图（所以裁剪能扩回）",
    String(saved.pkg?.baseHead || "").startsWith("data:image/png;base64,"), String(saved.pkg?.baseHead));

// ---- 3) 把这张 PNG 当普通图片加载（浏览器是否真的能渲染成品）----
const rendered = await evaluate(`(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("保存出的 PNG 无法作为图片加载"));
        img.src = window.__savedPng;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    // 采样点：空白底 / 底图里的色块 / 红色矩形上边框
    const blank = at(60, 60);
    const block = at(260, 260);
    const stroke = at(700, 150);
    // 统计红色像素，确认标注真的进来了（不是只有底图）
    let red = 0;
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < all.length; i += 4) {
        if (all[i] > 180 && all[i + 1] < 90 && all[i + 2] < 90) red++;
    }
    return {naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, blank, block, stroke, red};
})()`);
check("浏览器能直接把这张 PNG 当图片加载", rendered?.naturalWidth === 1200 && rendered?.naturalHeight === 800,
    `${rendered?.naturalWidth}×${rendered?.naturalHeight}`);
check("成品 PNG 里确实画着底图（采样到底图色块）",
    String(rendered?.block?.[0]) === "154" && String(rendered?.block?.[1]) === "166",
    JSON.stringify(rendered?.block));
check("标注也烘焙进成品 PNG（红色矩形描边可见）", (rendered?.red || 0) > 300, `红色像素 ${rendered?.red}`);

// 截图人眼走查：把保存出的成品 PNG 铺在白纸上
await evaluate(`(() => {
    const old = document.getElementById("svg-proof");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "svg-proof";
    box.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999;display:flex;align-items:center;justify-content:center";
    const img = new Image();
    img.id = "svg-proof-img";
    img.style.cssText = "max-width:96vw;max-height:96vh;box-shadow:0 4px 24px rgba(0,0,0,.18)";
    img.src = window.__savedPng;
    box.append(img);
    document.body.append(box);
})()`);
await sleep(400);
const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
await writeFile(path.join(outDir, "保存后的成品图.png"), Buffer.from(shot.data, "base64"));
console.log("已截图:", path.join(outDir, "保存后的成品图.png"));
await evaluate(`document.getElementById("svg-proof")?.remove()`);

// ---- 4) 重新打开同一张 PNG 继续编辑，旋转后再保存 ----
await evaluate(`document.querySelector('.annot-dialog [data-action="close"]')?.click()`);
await sleep(300);
await evaluate(`window.__openImage("assets/demo.png")`);
await sleep(600);
const reopened = await evaluate(`({
    count: document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)').length,
    baseSrc: (document.querySelector('[data-role="base"]')?.getAttribute("src") || "").slice(0, 24),
})`);
check("重新打开 PNG 能还原 3 个标注", reopened?.count === 3, String(reopened?.count));
check("重新打开时底图取的是内嵌原图（不是成品图，否则标注会叠两遍）",
    String(reopened?.baseSrc || "").startsWith("data:image/png;base64"), String(reopened?.baseSrc));

await evaluate(`document.querySelector('[data-canvas-op="rotate-cw"]').click()`);
await sleep(300);
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(900);
const rotated = await evaluate(`(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("旋转后的 PNG 无法加载"));
        img.src = window.__savedPng;
    });
    return {
        width: img.naturalWidth, height: img.naturalHeight,
        updates: window.__updates.length,
        lastData: (window.__updates[window.__updates.length - 1] || {}).data || "",
        canvas: window.__savedPackage?.scene?.canvas,
    };
})()`);
check("旋转后保存出来的成品 PNG 是竖版且浏览器能加载",
    rotated?.width === 800 && rotated?.height === 1200 && rotated?.updates === 0,
    `${rotated?.width}×${rotated?.height} / ${JSON.stringify(rotated?.canvas)}`);

// ---- 5) 马赛克也要能进成品 PNG（它是现采的位图，容易被安全策略挡掉）----
await evaluate(`document.querySelector('.annot-dialog [data-action="close"]')?.click()`);
await sleep(300);
// 从没动过的原图开始（旋转后的成品是竖版，坐标体系不一样，不适合量马赛克）
await evaluate(`window.__openImage("assets/demo.png")`);
await sleep(600);
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="mosaic"]').click();
    fire("pointerdown", at(120, 180));
    fire("pointermove", at(240, 290));
    fire("pointerup", at(320, 380));
    document.querySelector('button[data-tool="select"]').click();
})()`);
await sleep(300);
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(800);
const mosaic = await evaluate(`(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("带马赛克的 PNG 无法加载"));
        img.src = window.__savedPng;
    });
    const objects = window.__savedPackage?.scene?.objects || [];
    return {
        width: img.naturalWidth,
        types: objects.map((o) => o.type),
        hasBase: !!window.__savedPackage?.base?.dataUrl,
    };
})()`);
check("马赛克烘焙进成品 PNG，工程数据里仍是可编辑对象",
    mosaic?.width === 800 && mosaic?.types?.includes("mosaic") && mosaic?.hasBase === true,
    JSON.stringify(mosaic?.types));

// ---- 6) 把所有标注删掉再保存：笔记里的图不能还留着上一版的标注 ----
await evaluate(`window.__openImage("assets/demo.png")`);
await sleep(600);
await evaluate(`(() => {
    for (let i = 0; i < 8; i++) {
        const item = document.querySelector('[data-role="object-item"]');
        if (!item) break;
        item.click();
        document.body.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Delete", bubbles: true, cancelable: true,
        }));
    }
})()`);
await sleep(300);
const remaining = await evaluate(`document.querySelectorAll('[data-layer="objects"] g.annot-object').length`);
check("删掉全部标注后画布上没有对象", remaining === 0, String(remaining));
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(800);
const cleared = await evaluate(`(async () => {
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("清空后的 PNG 无法加载"));
        img.src = window.__savedPng;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    for (let i = 0; i < all.length; i += 4) {
        if (all[i] > 180 && all[i + 1] < 90 && all[i + 2] < 90) red++;
    }
    return {width: img.naturalWidth, height: img.naturalHeight, red};
})()`);
check("标注全删后保存出来的图是干净的底图（没有残留红框）",
    cleared?.red === 0 && cleared?.width === 800 && cleared?.height === 1200,
    `${cleared?.width}×${cleared?.height} 红色像素 ${cleared?.red}`);

// ---- 7) 正文里被拖窄过的图片：路径不变，宽度与笔记内容都不会被动 ----
await evaluate(`window.__openImage("assets/demo.png", "320px")`);
await sleep(600);
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 800;
    const h = Number(svg.getAttribute("height")) || 1200;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (target, type, p) => target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="rect"]').click();
    fire(svg, "pointerdown", at(100, 100));
    fire(svg, "pointermove", at(200, 200));
    fire(svg, "pointerup", at(300, 300));
    document.querySelector('button[data-tool="select"]').click();
    document.querySelector('[data-action="save"]').click();
})()`);
await sleep(800);
const widthKept = await evaluate(`(() => ({
    updates: window.__updates.length,
    lastData: (window.__updates[window.__updates.length - 1] || {}).data || "",
    lastPut: window.__puts[window.__puts.length - 1],
    savedPath: window.__savedPath,
    hasPng: window.__savedPng.startsWith("data:image/png;base64,"),
}))()`);
check("正文里拖窄过的图片，保存后宽度和笔记内容都不变（不换链接）",
    widthKept?.updates === 0 && widthKept?.lastPut === "data/assets/demo.png" && widthKept?.hasPng,
    JSON.stringify(widthKept));

// ---- 8) 模糊：框选区域要真的被虚化（不是盖一层白雾），并存进 SVG ----
await evaluate('document.querySelector(\'.annot-dialog [data-action="close"]\')?.click()');
await sleep(300);
await evaluate('window.__openImage("assets/fresh.png", null, "202611080000000-blurtest")');
await sleep(600);
const blurBox = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="blur"]').click();
    fire("pointerdown", at(120, 120));
    fire("pointermove", at(220, 220));
    fire("pointerup", at(420, 360));
    const group = document.querySelector('[data-layer="objects"] g.annot-object');
    const image = group?.querySelector("image");
    return {
        box: {x: 130, y: 130, w: 280, h: 220},
        hasImage: !!image,
        hrefHead: (image?.getAttribute("href") || "").slice(0, 22),
        stroked: !!group?.querySelector("[stroke]"),
        html: (group?.innerHTML || "").slice(0, 260),
        filterOk: (() => {
            const c = document.createElement("canvas");
            const x = c.getContext("2d");
            return typeof x.filter === "string" ? x.filter : "no-filter";
        })(),
    };
})()`);
check("模糊区域用「现采位图」呈现（不是白雾）",
    blurBox?.hasImage === true, `${blurBox?.hrefHead} | filter=${blurBox?.filterOk}`);
check("模糊同样没有描边", blurBox?.stroked === false);

await evaluate('document.querySelector(\'[data-action="save"]\')?.click()');
await sleep(900);
const blurMetrics = await evaluate(`(async () => {
    const box = {x: 130, y: 130, w: 280, h: 220};
    const load = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("load failed: " + src));
        image.src = src;
    });
    const draw = async (src) => {
        const image = await load(src);
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(box.x, box.y, box.w, box.h).data;
    };
    // 统计「相邻像素亮度差 > 24」的次数：越大越锐利，模糊后应该明显变小
    const edges = (data, w, h) => {
        let count = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 1; x < w; x++) {
                const i = (y * w + x) * 4;
                const j = i - 4;
                const a = (data[i] + data[i + 1] + data[i + 2]) / 3;
                const b = (data[j] + data[j + 1] + data[j + 2]) / 3;
                if (Math.abs(a - b) > 24) count++;
            }
        }
        return count;
    };
    const base = await draw("/assets/demo.png");
    const out = await draw(window.__savedPng);
    return {
        baseEdges: edges(base, box.w, box.h),
        blurEdges: edges(out, box.w, box.h),
        types: (window.__savedPackage?.scene?.objects || []).map((o) => o.type),
        hasBase: !!window.__savedPackage?.base?.dataUrl,
    };
})()`);
check("保存出来的成品 PNG 里模糊区域变糊了（边缘数大幅下降）",
    (blurMetrics?.blurEdges ?? 1) < (blurMetrics?.baseEdges ?? 0) * 0.5,
    `原图边缘 ${blurMetrics?.baseEdges} → 模糊后 ${blurMetrics?.blurEdges}`);
check("工程数据里保留可编辑的模糊对象与完整底图",
    blurMetrics?.types?.includes("blur") === true && blurMetrics?.hasBase === true,
    JSON.stringify(blurMetrics?.types));

// 重新打开这张带模糊的图：模糊对象要被还原，并且重新从底图算出一张位图
await evaluate('window.__openImage("assets/fresh.png", null, "202611080000000-blurtest")');
await sleep(700);
const blurReopened = await evaluate(`(() => {
    const groups = document.querySelectorAll('[data-layer="objects"] g.annot-object');
    const image = groups[0]?.querySelector("image");
    return {
        count: groups.length,
        hasImage: !!image,
        head: (image?.getAttribute("href") || "").slice(0, 16),
    };
})()`);
check("重新打开带模糊的图仍能还原（位图重新算出来）",
    blurReopened?.count === 1 && blurReopened?.hasImage === true,
    `${blurReopened?.count} 个 / ${blurReopened?.head}`);

// ---- 9) 图片带图注：图注不能被当成「同段还有文字」，否则永远不写回 ----
await evaluate('document.querySelector(\'.annot-dialog [data-action="close"]\')?.click()');
await sleep(300);
await evaluate('window.__openImageWithCaption("assets/demo.png", "图注文字", "202611080000000-caption", "340px")');
await sleep(800);
const captionBox = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="rect"]').click();
    fire("pointerdown", at(100, 100));
    fire("pointermove", at(200, 200));
    fire("pointerup", at(300, 300));
    document.querySelector('[data-action="save"]').click();
    return document.querySelectorAll('[data-layer="objects"] g.annot-object').length;
})()`);
await sleep(1200);
const captionUpdate = await evaluate(`(() => {
    const img = document.querySelector('img[data-title]');
    return {
        updates: window.__updates.length,
        lastData: (window.__updates[window.__updates.length - 1] || {}).data || "",
        title: img?.getAttribute("data-title") || "",
        width: img?.parentElement?.style?.width || "",
        lastPut: window.__puts[window.__puts.length - 1],
        savedPath: window.__savedPath,
        saved: window.__savedPng.startsWith("data:image/png;base64,"),
    };
})()`);
check("图片带图注时照常就地写回（图注不算正文文字）",
    captionUpdate?.updates === 0 && captionUpdate?.lastPut === "data/assets/demo.png" && captionUpdate?.saved,
    JSON.stringify(captionUpdate));
check("图注与自定义宽度都原样留在笔记里（根本不用换链接）",
    captionUpdate?.title === "图注文字" && captionUpdate?.width === "340px",
    `${captionUpdate?.title} / ${captionUpdate?.width}`);

// ---- 裁剪 round-trip：保存后再次编辑，还能把范围扩回上次裁剪之外 ----
// jsdom 只能证明数据对得上，这一段在真实 Chromium 里把整条链路点一遍。
await evaluate(`document.querySelector('.annot-dialog [data-action="close"]')?.click()`);
await sleep(300);
await evaluate('window.__openImage("assets/crop.png")');
await sleep(800);
await evaluate(`document.querySelector('[data-canvas-op="crop"]').click()`);
await saveShot("裁剪-1-进入即整图.png");
const cropFirst = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    // 参考插件：默认框铺满整张图，要重新框选先按 Delete 把框清掉
    document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "Delete", bubbles: true, cancelable: true}));
    fire("pointerdown", at(10, 10));
    fire("pointermove", at(210, 160));
    fire("pointerup", at(410, 310));
    document.querySelector('[data-action="crop-apply"]').click();
    const layer = document.querySelector('[data-role="transform"]');
    return {width: parseFloat(layer?.style.width), height: parseFloat(layer?.style.height)};
})()`);
// 真实坐标经过视口缩放反算，边缘可能差 1px，这里按「接近 400 × 300」判定
const nearCrop = (v, target) => Math.abs(Number(v) - target) <= 2;
check("真实浏览器里裁剪生效（画布变成约 400 × 300）",
    nearCrop(cropFirst?.width, 400) && nearCrop(cropFirst?.height, 300), JSON.stringify(cropFirst));

// 实拍像素：画布里还能看到框内的深色块，画布外只剩舞台背景（框外底图已被剪掉）
await sleep(350);
await saveShot("裁剪-2-应用后只剩框内.png");
const cropPixels = await samplePixels(CROP_PIXEL_POINTS);
check("真实浏览器：裁剪后画布里显示的确实是框内那一块（实拍像素）",
    isBlockA(cropPixels?.inside), JSON.stringify(cropPixels?.inside));
check("真实浏览器：裁剪后框外的底图不再露在画布外（实拍像素）",
    isStage(cropPixels?.outside), JSON.stringify(cropPixels?.outside));
const cropView = await evaluate(`(() => {
    const v = document.querySelector('[data-role="viewport"]');
    const style = getComputedStyle(v);
    return {overflow: style.overflow, width: v.style.width, height: v.style.height,
        holdsImage: v.contains(document.querySelector('[data-role="base"]'))};
})()`);
check("真实浏览器：可视窗口真的在剪底图（overflow hidden 且包着底图）",
    cropView?.overflow === "hidden" && cropView?.holdsImage &&
    nearCrop(parseFloat(cropView?.width), cropFirst?.width) &&
    nearCrop(parseFloat(cropView?.height), cropFirst?.height),
    JSON.stringify(cropView));

// 反证：临时放开可视窗口，同一个取样点立刻变成底图颜色，说明上面的像素点
// 真的落在「本该被裁掉」的区域，这个检测不是碰巧通过的。
await evaluate(`(() => {
    document.querySelector('[data-role="viewport"]').style.overflow = "visible";
    return true;
})()`);
const leaked = await samplePixels(CROP_PIXEL_POINTS);
await evaluate(`(() => {
    document.querySelector('[data-role="viewport"]').style.overflow = "";
    return true;
})()`);
check("真实浏览器：反证——放开可视窗口，框外底图立刻露出来（检测点有效）",
    !isStage(leaked?.outside), JSON.stringify(leaked?.outside));

await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(1000);
const cropSave = await evaluate(`(() => ({
    savedPath: window.__savedPath,
    lastPut: window.__puts[window.__puts.length - 1],
    uploads: window.__uploads.length,
    crop: window.__savedPackage?.scene?.crop,
    hasBase: !!window.__savedPackage?.base?.dataUrl,
}))()`);
check("裁剪后的结果就地覆盖同一张 PNG，没有新增资源",
    cropSave?.lastPut === "data/assets/crop.png" && cropSave?.uploads === 0 &&
    Math.abs(cropSave?.crop?.width - cropFirst?.width) <= 2 && cropSave?.hasBase === true,
    JSON.stringify(cropSave));

await evaluate(`document.querySelector('.annot-dialog [data-action="close"]')?.click()`);
await sleep(300);
await evaluate(`window.__openImage("assets/crop.png")`);
await sleep(900);
const reopenedCrop = await evaluate(`(() => {
    const layer = document.querySelector('[data-role="transform"]');
    return {width: parseFloat(layer?.style.width), height: parseFloat(layer?.style.height)};
})()`);
check("保存后重新打开，看到的仍是裁好的成品",
    nearCrop(reopenedCrop?.width, cropFirst?.width) && nearCrop(reopenedCrop?.height, cropFirst?.height),
    JSON.stringify(reopenedCrop));
await sleep(300);
const reopenedPixels = await samplePixels(CROP_PIXEL_POINTS);
check("真实浏览器：保存后重新打开，插件里也只看得到裁后的画面（实拍像素）",
    isBlockA(reopenedPixels?.inside) && isStage(reopenedPixels?.outside),
    `框内=${JSON.stringify(reopenedPixels?.inside)} 框外=${JSON.stringify(reopenedPixels?.outside)}`);

const recrop = await evaluate(`(() => {
    document.querySelector('[data-canvas-op="crop"]').click();
    const layer = document.querySelector('[data-role="transform"]');
    const size = document.querySelector('[data-role="crop-size"]')?.textContent || "";
    return {width: parseFloat(layer?.style.width), height: parseFloat(layer?.style.height), size};
})()`);
check("保存后再次裁剪，画面扩回完整原图 1200 × 800",
    recrop?.width === 1200 && recrop?.height === 800, JSON.stringify(recrop));
await saveShot("裁剪-3-再裁剪铺回完整原图.png");
const keptSize = /保留 (\d+) × (\d+) px/.exec(recrop?.size || "");
check("再次裁剪的框正好是上次保留的那块",
    !!keptSize && Math.abs(Number(keptSize[1]) - cropFirst?.width) <= 1
    && Math.abs(Number(keptSize[2]) - cropFirst?.height) <= 1,
    String(recrop?.size));

const restored = await evaluate(`(() => {
    document.querySelector('[data-action="crop-full"]').click();
    const full = document.querySelector('[data-role="crop-size"]')?.textContent || "";
    document.querySelector('[data-action="crop-apply"]').click();
    const layer = document.querySelector('[data-role="transform"]');
    return {full, width: parseFloat(layer?.style.width), height: parseFloat(layer?.style.height)};
})()`);
check("点「恢复整张原图」可一次找回裁掉的外围并应用",
    /1200 × 800/.test(restored?.full || "") && restored?.width === 1200 && restored?.height === 800,
    JSON.stringify(restored));

// ---- 10) 文字输入所见即所得：透明输入框、颜色就是成品颜色 ----
await evaluate(`document.querySelector('.annot-dialog [data-action="close"]')?.click()`);
await sleep(300);
await evaluate('window.__openImage("assets/text.png")');
await sleep(700);
const textEdit = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="text"]').click();
    fire("pointerdown", at(300, 300));
    fire("pointerup", at(300, 300));
    const editor = document.querySelector('.annot-text-editor');
    if (!editor) return null;
    editor.value = "测试";
    editor.dispatchEvent(new Event("input", {bubbles: true}));
    const s = getComputedStyle(editor);
    const r = editor.getBoundingClientRect();
    const editing = document.querySelector('.annot-object.is-editing');
    return {
        background: s.backgroundColor, border: s.borderTopWidth,
        boxShadow: s.boxShadow, padding: s.paddingLeft,
        blend: s.mixBlendMode, color: s.color, caret: s.caretColor, shadow: s.textShadow,
        frame: (() => {
            const f = document.querySelector('.annot-text-frame');
            if (!f) return null;
            const fs = getComputedStyle(f);
            return {blend: fs.mixBlendMode, outline: fs.outlineWidth, outlineColor: fs.outlineColor};
        })(),
        placeholder: editor.getAttribute("placeholder"),
        hidden: editing ? getComputedStyle(editing).visibility : "missing",
        rect: {x: r.left, y: r.top, w: r.width, h: r.height},
    };
})()`);
check("真实浏览器：文字输入框没有白底 / 边框 / 阴影 / 内边距",
    textEdit?.background === "rgba(0, 0, 0, 0)" && textEdit?.border === "0px" &&
    textEdit?.boxShadow === "none" && textEdit?.padding === "0px",
    JSON.stringify(textEdit));
check("真实浏览器：输入框没有任何占位提示，文字本身不反色",
    textEdit?.placeholder === null && textEdit?.blend === "normal",
    `placeholder=${textEdit?.placeholder} blend=${textEdit?.blend}`);
check("真实浏览器：打字过程中显示的就是红字 + 白影（不等到提交才变回来）",
    /239, 68, 68/.test(textEdit?.color || "") && textEdit?.shadow !== "none",
    `color=${textEdit?.color} shadow=${String(textEdit?.shadow).slice(0, 30)}`);
check("真实浏览器：只有细框那一层用反色，边框在任何底色上都看得见",
    textEdit?.frame?.blend === "difference" && textEdit?.frame?.outline === "1px",
    JSON.stringify(textEdit?.frame));
check("真实浏览器：深色块上的光标自动用白色",
    /255, 255, 255/.test(textEdit?.caret || ""), String(textEdit?.caret));
check("真实浏览器：编辑中的原文字已隐藏（不会和输入框叠成双影）",
    textEdit?.hidden === "hidden", String(textEdit?.hidden));

// 实拍像素：编辑框内的空白处必须还是底图颜色，不能是白色方块
const TEXT_PIXEL_POINTS = `(() => {
    const e = document.querySelector('.annot-text-editor');
    const r = e.getBoundingClientRect();
    return {
        inside: {x: r.left + r.width - 10, y: r.top + r.height / 2},
        outside: {x: r.left - 20, y: r.top + r.height / 2},
    };
})()`;
const textPixels = await samplePixels(TEXT_PIXEL_POINTS);
await saveShot("文字输入-透明无底.png");
// 底图只有三种颜色：空白浅灰蓝、色块 A 深蓝灰、色块 B 暖灰。
// 输入框是透明的，两个取样点都应落在这些颜色里；白色方块 / 蓝框 / 阴影都会被排除。
const baseColors = [[216, 221, 230], [154, 166, 187], [187, 166, 154]];
const isBaseColor = (c) => !!c && baseColors.some((b) =>
    Math.abs(c[0] - b[0]) < 25 && Math.abs(c[1] - b[1]) < 25 && Math.abs(c[2] - b[2]) < 25);
check("真实浏览器：输入时画面里没有白色方块（实拍像素）",
    isBaseColor(textPixels?.inside) && isBaseColor(textPixels?.outside),
    `框内=${JSON.stringify(textPixels?.inside)} 框外=${JSON.stringify(textPixels?.outside)}`);

// 网格采样文字区域：字芯必须还是标注的颜色，不能被白边糊成一片白
const TEXT_GRID = `(() => {
    const e = document.querySelector('.annot-text-editor');
    const r = e.getBoundingClientRect();
    const pts = {};
    let i = 0;
    for (let y = r.top + 2; y < r.top + Math.min(r.height, 46); y += 2) {
        for (let x = r.left + 2; x < r.left + 90; x += 2) pts["p" + (i++)] = {x, y};
    }
    return pts;
})()`;
const textGrid = await samplePixels(TEXT_GRID);
const gridCells = Object.values(textGrid || {}).filter(Boolean);
// 输入阶段就是红字：直接数红色的字芯像素，证明过程中没有被反色成黑/白
const inkTyping = gridCells.filter((c) => c[0] > 170 && c[1] < 120 && c[2] < 120).length;
check("真实浏览器：打字过程中画面上就是红字（实拍像素）",
    inkTyping >= 5, `红色采样点 ${inkTyping} / ${gridCells.length}`);

// 提交后：文字应落在输入框原来的位置附近，不能「跳一下」
const afterCommit = await evaluate(`(() => {
    const editor = document.querySelector('.annot-text-editor');
    const before = editor.getBoundingClientRect();
    editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    const text = document.querySelector('[data-layer="objects"] text.annot-shape');
    const r = text?.getBoundingClientRect();
    return {
        hasEditor: !!document.querySelector('.annot-text-editor'),
        before: {x: before.left, y: before.top},
        after: r ? {x: r.left, y: r.top} : null,
        value: text?.textContent || "",
        fill: text?.getAttribute("fill") || "",
    };
})()`);
await sleep(250);
await saveShot("文字输入-提交后.png");
check("真实浏览器：提交后文字落在输入框原来的位置（没有跳位）",
    !!afterCommit?.after && Math.abs(afterCommit.before.x - afterCommit.after.x) < 12 &&
    Math.abs(afterCommit.before.y - afterCommit.after.y) < 12,
    `${JSON.stringify(afterCommit?.before)} → ${JSON.stringify(afterCommit?.after)}`);
check("真实浏览器：输入框提交后消失，文字内容写入画布",
    afterCommit?.hasEditor === false && afterCommit?.value === "测试", String(afterCommit?.value));
check("真实浏览器：提交后文字仍是所选颜色（不是自动黑白）",
    String(afterCommit?.fill).toUpperCase() === "#EF4444", String(afterCommit?.fill));

// 提交后再采一次像素：画面上看到的确实变成红字了（不只是属性对了）
const committedGrid = await samplePixels(`(() => {
    const t = document.querySelector('[data-layer="objects"] text.annot-shape');
    const r = t.getBoundingClientRect();
    const pts = {};
    let i = 0;
    for (let y = r.top + 1; y < r.bottom - 1; y += 2) {
        for (let x = r.left + 1; x < Math.min(r.right, r.left + 80); x += 2) pts["p" + (i++)] = {x, y};
    }
    return pts;
})()`);
const committedCells = Object.values(committedGrid || {}).filter(Boolean);
const redAfter = committedCells.filter((c) => c[0] > 170 && c[1] < 120 && c[2] < 120).length;
check("真实浏览器：提交后画面上确实显示红字（实拍像素）",
    redAfter >= 5, `红色采样点 ${redAfter} / ${committedCells.length}`);

// 换到浅色区域再点一次：光标应该自动变成黑色
const lightCaret = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="text"]').click();
    // (700, 160) 是浅灰蓝的空白处
    fire("pointerdown", at(700, 160));
    fire("pointerup", at(700, 160));
    const editor = document.querySelector('.annot-text-editor');
    if (!editor) return null;
    const color = getComputedStyle(editor).caretColor;
    editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    return {caret: color};
})()`);
check("真实浏览器：浅色区域的光标自动用黑色",
    /0, 0, 0/.test(lightCaret?.caret || ""), String(lightCaret?.caret));

// ---- 11) 自动换行：长文字碰到画布右边缘折行，拖动时实时重排 ----
const wrapSetup = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="text"]').click();
    fire("pointerdown", at(100, 620));
    fire("pointerup", at(100, 620));
    const editor = document.querySelector('.annot-text-editor');
    if (!editor) return null;
    editor.value = "拼".repeat(90);
    editor.dispatchEvent(new Event("input", {bubbles: true}));
    editor.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    const texts = document.querySelectorAll('[data-layer="objects"] text.annot-shape');
    const text = texts[texts.length - 1];
    const lineCount = () => new Set(Array.from(text.querySelectorAll("tspan"))
        .map((t) => t.getAttribute("y")).filter(Boolean)).size;
    const maxRight = Math.max.apply(null, Array.from(text.querySelectorAll("tspan")).map((t) => {
        const r = t.getBoundingClientRect();
        return r.right;
    }));
    return {lines: lineCount(), canvasRight: rect.right, maxRight: maxRight};
})()`);
check("真实浏览器：90 个字自动折成多行（没有冲出画布）",
    (wrapSetup?.lines || 0) >= 3 && wrapSetup.maxRight <= wrapSetup.canvasRight + 2,
    `行数 ${wrapSetup?.lines} 右缘 ${wrapSetup?.maxRight?.toFixed(0)} / 画布 ${wrapSetup?.canvasRight?.toFixed(0)}`);

const dragResult = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    document.querySelector('button[data-tool="select"]').click();
    const texts = () => document.querySelectorAll('[data-layer="objects"] text.annot-shape');
    const lineCount = () => {
        const list = texts();
        const text = list[list.length - 1];
        return new Set(Array.from(text.querySelectorAll("tspan"))
            .map((t) => t.getAttribute("y")).filter(Boolean)).size;
    };
    // 拖对象必须从对象本身按下（e.target 决定拖的是谁），移动与松手用画布坐标即可
    const hit = () => {
        const list = texts();
        const text = list[list.length - 1];
        return text.closest("g").querySelector('[data-role="hit"]');
    };
    const before = lineCount();
    hit().dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0,
        clientX: at(110, 640).clientX, clientY: at(110, 640).clientY,
    }));
    fire("pointermove", at(500, 640));
    fire("pointerup", at(900, 640));
    const afterRight = lineCount();
    hit().dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true, cancelable: true, button: 0,
        clientX: at(910, 640).clientX, clientY: at(910, 640).clientY,
    }));
    fire("pointermove", at(500, 640));
    fire("pointerup", at(100, 640));
    const backLeft = lineCount();
    return {before, afterRight, backLeft};
})()`);
check("真实浏览器：文字往右拖后被画布边缘挤压，行数变多",
    (dragResult?.afterRight || 0) > (dragResult?.before || 0),
    `${dragResult?.before} → ${dragResult?.afterRight}（拖回后 ${dragResult?.backLeft}）`);
check("真实浏览器：拖回左边后行数恢复", dragResult?.backLeft === dragResult?.before,
    `${dragResult?.afterRight} → ${dragResult?.backLeft}`);
await saveShot("文字-自动换行.png");

await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(1200);
const savedText = await evaluate(`(() => ({
    hasPackage: !!window.__savedPackage,
    objects: (window.__savedPackage?.scene?.objects || []).length,
}))()`);
check("真实浏览器：带换行文字的图能正常保存（工程数据仍在）",
    !!savedText?.hasPackage && savedText.objects === 2, JSON.stringify(savedText));
await sleep(300);

// ---- 13) 移动端：390×844 手机视口 + 触摸，验证上下双栏与双指缩放 ----
await send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});
await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/`});
let mobileReady = false;
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) { mobileReady = true; break; }
    await sleep(100);
}
if (!mobileReady) throw new Error("移动端视口下 harness 未就绪：" + await evaluate("window.__error"));
await sleep(600);
const mobileLayout = await evaluate(`(() => {
    const root = document.querySelector(".annot-root");
    const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
    };
    const rail = document.querySelector(".annot-mobile-rail");
    const style = document.querySelector(".annot-mobile-style");
    const toolBtn = rail?.querySelector(".annot-mobile-tool");
    const r = toolBtn?.getBoundingClientRect();
    const box = (el) => el ? el.getBoundingClientRect() : null;
    const stage = box(document.querySelector(".annot-stage"));
    const styleBox = box(style);
    const railBox = box(rail);
    return {
        mobileClass: !!root?.classList.contains("annot-root--mobile"),
        hasTop: !!document.querySelector(".annot-mobile-top"),
        hasStyle: !!style,
        hasRail: !!rail,
        tools: rail ? rail.querySelectorAll("button[data-tool]").length : 0,
        ops: rail ? rail.querySelectorAll("button[data-canvas-op]").length : 0,
        labels: rail ? Array.from(rail.querySelectorAll(".annot-mobile-tool__label")).map((n) => n.textContent) : [],
        titlebar: cs(".annot-titlebar")?.display || "missing",
        imagebar: cs(".annot-imagebar")?.display || "missing",
        status: cs(".annot-status")?.display || "missing",
        toolSize: r ? {w: Math.round(r.width), h: Math.round(r.height)} : null,
        styleScroll: style ? getComputedStyle(style.querySelector(".annot-mobile-style__scroll")).overflowX : "",
        railScroll: rail ? getComputedStyle(rail.querySelector(".annot-mobile-rail__scroll")).overflowX : "",
        groups: Array.from(document.querySelectorAll('[data-role="mobile-style"] [data-group]')).map((el) => el.getAttribute("data-group")),
        zoomChip: document.querySelector('[data-role="mobile-zoom"]')?.textContent || "",
        stacked: !!stage && !!styleBox && !!railBox &&
            styleBox.top >= stage.bottom - 1.5 && railBox.top >= styleBox.bottom - 1.5,
        styleHeight: styleBox ? Math.round(styleBox.height) : 0,
        railHeight: railBox ? Math.round(railBox.height) : 0,
        viewportHeight: window.innerHeight,
    };
})()`);
check("真实浏览器（手机视口）：顶部导航 + 上栏参数 + 下栏工具三块齐备",
    mobileLayout?.mobileClass && mobileLayout?.hasTop && mobileLayout?.hasStyle && mobileLayout?.hasRail,
    JSON.stringify(mobileLayout));
check("真实浏览器（手机视口）：画布在上、参数栏居中、工具条在下（上下双栏）",
    mobileLayout?.stacked === true,
    `stage→style→rail 顺序=${mobileLayout?.stacked}，高 ${mobileLayout?.styleHeight}+${mobileLayout?.railHeight} / 屏 ${mobileLayout?.viewportHeight}`);
check("真实浏览器（手机视口）：PC 的标题栏 / 左侧栏 / 底栏都已隐藏",
    mobileLayout?.titlebar === "none" && mobileLayout?.imagebar === "none" && mobileLayout?.status === "none",
    `titlebar=${mobileLayout?.titlebar} imagebar=${mobileLayout?.imagebar} status=${mobileLayout?.status}`);
check("真实浏览器（手机视口）：两栏都能横向滑动，工具按钮够手指点",
    mobileLayout?.styleScroll === "auto" && mobileLayout?.railScroll === "auto" &&
    (mobileLayout?.toolSize?.w || 0) >= 44 && (mobileLayout?.toolSize?.h || 0) >= 44 &&
    mobileLayout?.tools === 11 && mobileLayout?.ops === 6,
    `工具按钮 ${mobileLayout?.toolSize?.w}×${mobileLayout?.toolSize?.h}，工具 ${mobileLayout?.tools} / 图像 ${mobileLayout?.ops}`);
check("真实浏览器（手机视口）：下栏每个按钮都有中文标签",
    (mobileLayout?.labels || []).length === 17 &&
    (mobileLayout?.labels || []).every((t) => (t || "").length >= 2),
    (mobileLayout?.labels || []).join("/"));
check("真实浏览器（手机视口）：打开时上栏就是颜色 + 粗细",
    (mobileLayout?.groups || []).join(",") === "colors,widths", (mobileLayout?.groups || []).join(","));
check("真实浏览器（手机视口）：缩放比例显示在画布底部正中的胶囊里",
    /^\d+%$/.test(mobileLayout?.zoomChip || ""), String(mobileLayout?.zoomChip));
// 全屏尺寸、顶部按钮居中 / 不重叠、固定区不随滚动、图标不被填实
const mobileChrome = await evaluate(`(() => {
    const dialog = document.querySelector(".annot-dialog");
    const r = dialog.getBoundingClientRect();
    const top = document.querySelector(".annot-mobile-top");
    const buttons = Array.from(top.querySelectorAll("button")).map((b) => {
        const br = b.getBoundingClientRect();
        return {
            action: b.getAttribute("data-action") || b.getAttribute("data-tool"),
            left: Math.round(br.left), right: Math.round(br.right),
            cy: Math.round(br.top + br.height / 2),
        };
    });
    const close = buttons.find((b) => b.action === "close");
    const save = buttons.find((b) => b.action === "save");
    const rectIcon = document.querySelector('.annot-mobile-tool[data-tool="rect"] svg.annot-icon');
    const iconStyle = rectIcon ? getComputedStyle(rectIcon) : null;
    // 两颗独立圆钮：左「选择」右「对齐」
    const fabs = Array.from(document.querySelectorAll('[data-role="mobile-fabs"] .annot-fab')).map((el) => {
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            action: el.getAttribute("data-action"),
            left: Math.round(b.left), right: Math.round(b.right),
            top: Math.round(b.top), bottom: Math.round(b.bottom),
            w: Math.round(b.width), h: Math.round(b.height),
            radius: cs.borderTopLeftRadius,
            active: el.classList.contains("is-active"),
            bg: cs.backgroundColor, color: cs.color,
        };
    });
    const railBox = document.querySelector(".annot-mobile-rail").getBoundingClientRect();
    const selectedLeft = fabs.find((f) => f.action === "mobile-select")?.left ?? -1;
    const railLeft = Math.round(railBox.left);
    const activeBg = fabs.find((f) => f.active)?.bg || "";
    const activeColor = fabs.find((f) => f.active)?.color || "";
    // 缩放缓胶囊：v0.22.1 起从右下角挪到画布底部正中，两侧圆钮因此可以压低
    const zoomEl = document.querySelector(".annot-mobile-zoom");
    const zb = zoomEl ? zoomEl.getBoundingClientRect() : null;
    const zoom = zb ? {
        left: Math.round(zb.left), right: Math.round(zb.right),
        top: Math.round(zb.top), bottom: Math.round(zb.bottom),
    } : null;
    const zoomMid = Math.round(innerWidth / 2);
    const styleTop = Math.round(document.querySelector(".annot-mobile-style").getBoundingClientRect().top);
    const fabGap = fabs.length ? styleTop - fabs[0].bottom : -1;
    // v0.22.2：两条栏取消底板 → 容器透明；按钮自带毛玻璃小底
    const csOf = (sel) => getComputedStyle(document.querySelector(sel));
    const railCs = csOf(".annot-mobile-rail");
    const styleCs = csOf(".annot-mobile-style");
    const toolCs = csOf(".annot-mobile-tool");
    const glass = {
        railBg: railCs.backgroundColor, railBorder: railCs.borderTopWidth, railShadow: railCs.boxShadow,
        styleBg: styleCs.backgroundColor, styleBorder: styleCs.borderTopWidth,
        toolBg: toolCs.backgroundColor, toolRadius: toolCs.borderTopLeftRadius,
        toolBlur: toolCs.backdropFilter || toolCs.webkitBackdropFilter || "",
    };
    // 圆角：容器 / body / root / 顶栏都不该有
    const radius = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).borderTopLeftRadius : "missing";
    };
    // 思源自带的关闭按钮（真机上会压在「完成」上）：注入一个探针看有没有被隐藏
    const dialogRoot = document.querySelector(".b3-dialog.annot-dialog-fullscreen");
    let closeDisplay = "no-dialog";
    if (dialogRoot) {
        const probe = document.createElement("button");
        probe.className = "b3-dialog__close";
        probe.textContent = "x";
        probe.style.cssText = "position:absolute;top:8px;right:8px;width:32px;height:32px";
        dialogRoot.append(probe);
        closeDisplay = getComputedStyle(probe).display;
        probe.remove();
    }
    return {
        activeBg, activeColor, closeDisplay,
        inlineShell: (() => {
            const el = document.querySelector(".b3-dialog");
            return el ? {padding: el.style.padding, borderRadius: el.style.borderRadius} : null;
        })(),
        inlineContainer: (() => {
            const el = document.querySelector(".annot-dialog");
            return el ? {width: el.style.width, borderRadius: el.style.borderRadius} : null;
        })(),
        radii: {
            container: radius(".annot-dialog"),
            body: radius(".b3-dialog__body"),
            root: radius(".annot-root"),
            top: radius(".annot-mobile-top"),
        },
        dialog: {w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top)},
        viewport: {w: window.innerWidth, h: window.innerHeight},
        buttons,
        overlap: close && save ? close.right > save.left : null,
        centers: Array.from(new Set(buttons.map((b) => b.cy))),
        iconFill: iconStyle ? iconStyle.fill : "",
        iconStroke: iconStyle ? iconStyle.stroke : "",
        saveText: (document.querySelector('.annot-mobile-top [data-action="save"]')?.textContent || "").trim(),
        fabs, selectedLeft, railLeft, railRight: Math.round(railBox.right),
        zoom, zoomMid, styleTop, fabGap, glass,
    };
})()`);
check("真实浏览器（手机视口）：真机上外壳的内边距与容器圆角都被清零",
    mobileChrome?.inlineShell?.padding === "0px" &&
    mobileChrome?.inlineShell?.borderRadius === "0px" &&
    mobileChrome?.inlineContainer?.width === "100vw" &&
    mobileChrome?.inlineContainer?.borderRadius === "0px",
    `外壳 padding=${mobileChrome?.inlineShell?.padding} 圆角=${mobileChrome?.inlineShell?.borderRadius}；容器 ${mobileChrome?.inlineContainer?.width} 圆角=${mobileChrome?.inlineContainer?.borderRadius}`);
check("真实浏览器（手机视口）：编辑器铺满整屏（无 94vw/90vh 留白）",
    Math.abs((mobileChrome?.dialog?.w || 0) - (mobileChrome?.viewport?.w || 0)) <= 1 &&
    Math.abs((mobileChrome?.dialog?.h || 0) - (mobileChrome?.viewport?.h || 0)) <= 1 &&
    mobileChrome?.dialog?.left === 0 && mobileChrome?.dialog?.top === 0,
    JSON.stringify(mobileChrome?.dialog) + " / 视口 " + JSON.stringify(mobileChrome?.viewport));
check("真实浏览器（手机视口）：顶部按钮垂直居中对齐，保存按钮不压到关闭按钮",
    (mobileChrome?.centers || []).length === 1 && mobileChrome?.overlap === false,
    `中心y=${JSON.stringify(mobileChrome?.centers)} 重叠=${mobileChrome?.overlap} 按钮=${JSON.stringify(mobileChrome?.buttons)}`);
check("真实浏览器（手机视口）：顶部按钮文案是短「完成」，不会挤爆整行",
    mobileChrome?.saveText === "保存", String(mobileChrome?.saveText));
check("真实浏览器（手机视口）：下栏图标没被思源全局样式填实（矩形仍是空心框）",
    mobileChrome?.iconFill === "none", `fill=${mobileChrome?.iconFill} stroke=${mobileChrome?.iconStroke}`);
check("真实浏览器（手机视口）：两颗圆钮都是正圆 48px，当前模式那颗填充主色",
    (mobileChrome?.fabs || []).length === 2 &&
    mobileChrome.fabs.every((f) => f.radius === "50%" && f.w === 48 && f.h === 48) &&
    mobileChrome.fabs.filter((f) => f.active).length === 1 &&
    /rgb\(53, 117, 240\)|rgb\(53,117,240\)/.test(mobileChrome?.activeBg || ""),
    JSON.stringify(mobileChrome?.fabs));
check("真实浏览器（手机视口）：顶部四个角都是直角（容器 / body / root / 顶栏无圆角）",
    Object.values(mobileChrome?.radii || {}).every((v) => v === "0px"),
    JSON.stringify(mobileChrome?.radii));
check("真实浏览器（手机视口）：思源自带的关闭按钮已隐藏（不再压住「完成」）",
    mobileChrome?.closeDisplay === "none", String(mobileChrome?.closeDisplay));
check("真实浏览器（手机视口）：左圆钮贴左、右圆钮贴右，像两颗悬浮按钮",
    Math.abs((mobileChrome?.fabs?.[0]?.left || 0) - (mobileChrome?.railLeft || 0)) <= 8 &&
    Math.abs((mobileChrome?.fabs?.[1]?.right || 0) - (mobileChrome?.railRight || 0)) <= 8,
    `左 ${mobileChrome?.fabs?.[0]?.left} / 轨道 left ${mobileChrome?.railLeft}；右 ${mobileChrome?.fabs?.[1]?.right} / 轨道 right ${mobileChrome?.railRight}`);

check("真实浏览器（手机视口）：缩放胶囊在画布底部正中，两侧圆钮不与它重叠",
    !!mobileChrome?.zoom &&
    Math.abs((mobileChrome.zoom.left + mobileChrome.zoom.right) / 2 - mobileChrome.zoomMid) <= 3 &&
    mobileChrome.fabs[0].right < mobileChrome.zoom.left &&
    mobileChrome.fabs[1].left > mobileChrome.zoom.right,
    `胶囊 ${JSON.stringify(mobileChrome?.zoom)} 中心 ${mobileChrome?.zoomMid}；圆钮右 ${mobileChrome?.fabs?.[0]?.right} / 左 ${mobileChrome?.fabs?.[1]?.left}`);
check("真实浏览器（手机视口）：两颗圆钮压低到属性卡片上方（间距 6~30px，不再为胶囊让位）",
    mobileChrome?.fabGap >= 6 && mobileChrome?.fabGap <= 30 &&
    mobileChrome.fabs[0].top === mobileChrome.fabs[1].top,
    `间距 ${mobileChrome?.fabGap}px，圆钮 top ${mobileChrome?.fabs?.[0]?.top}/${mobileChrome?.fabs?.[1]?.top}`);

check("真实浏览器（手机视口）：两条栏没有底板（透明、无边框、无投影）",
    mobileChrome?.glass?.railBg === "rgba(0, 0, 0, 0)" &&
    mobileChrome?.glass?.styleBg === "rgba(0, 0, 0, 0)" &&
    mobileChrome?.glass?.railBorder === "0px" && mobileChrome?.glass?.styleBorder === "0px" &&
    mobileChrome?.glass?.railShadow === "none",
    JSON.stringify(mobileChrome?.glass));
check("真实浏览器（手机视口）：每个工具按钮自带半透明毛玻璃底，不是裸图标",
    /^(?:rgba?|color)\(/.test(mobileChrome?.glass?.toolBg || "") &&
    mobileChrome.glass.toolBg !== "rgba(0, 0, 0, 0)" &&
    !/transparent/.test(mobileChrome.glass.toolBg) &&
    /blur/.test(mobileChrome?.glass?.toolBlur || "") &&
    mobileChrome?.glass?.toolRadius === "14px",
    `底=${mobileChrome?.glass?.toolBg} 模糊=${mobileChrome?.glass?.toolBlur} 圆角=${mobileChrome?.glass?.toolRadius}`);
await saveShot("移动端-界面.png");

// 上栏跟着工具变：文字 → 字号；矩形 → 填充
const pickTool = (tool) => evaluate(`document.querySelector('.annot-mobile-rail button[data-tool="${tool}"]')?.click()`);
const readStyle = () => evaluate(`(() => ({
    groups: Array.from(document.querySelectorAll('[data-role="mobile-style"] [data-group]'))
        .map((el) => el.getAttribute("data-group")).join(","),
    text: document.querySelector('[data-role="mobile-style"]')?.textContent || "",
}))()`);
await pickTool("text");
await sleep(200);
const styleText = await readStyle();
check("真实浏览器（手机视口）：切到文字后上栏换成颜色 + 字号",
    styleText?.groups === "colors,fonts" && styleText.text.includes("字号") && !styleText.text.includes("粗细"),
    `${styleText?.groups}`);
await saveShot("移动端-上栏随工具变.png");
await pickTool("rect");
await sleep(200);
const styleRect = await readStyle();
check("真实浏览器（手机视口）：切到矩形后上栏多出填充与圆角",
    styleRect?.groups === "colors,widths,fills,corners" &&
    styleRect.text.includes("填充") && styleRect.text.includes("圆角"), `${styleRect?.groups}`);
await pickTool("mosaic");
await sleep(200);
const styleMosaic = await readStyle();
check("真实浏览器（手机视口）：切到马赛克后上栏只给提示",
    styleMosaic?.groups === "hint" && styleMosaic.text.includes("拖出"), `${styleMosaic?.groups}`);
await pickTool("arrow");
await sleep(150);

// 点色点：真正生效并高亮
const swatchPick = await evaluate(`(() => {
    const list = () => Array.from(document.querySelectorAll('[data-role="mobile-style"] button[data-preset="color"]'));
    const before = list().findIndex((b) => b.classList.contains("is-active"));
    list()[1]?.click();
    const after = list().findIndex((b) => b.classList.contains("is-active"));
    return {before, after, count: list().length, value: list()[1]?.getAttribute("data-value")};
})()`);
check("真实浏览器（手机视口）：点上栏色点会切换并高亮",
    swatchPick?.after === 1 && swatchPick?.before !== 1 && swatchPick?.count === 5,
    JSON.stringify(swatchPick));

// 单指画一笔 + 双指捏合：都用 pointerType=touch 的事件，等价于手指落在页面上
const touchDraw = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const r = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: r.left + x * r.width / w, clientY: r.top + y * r.height / h});
    const fire = (type, p) => {
        const e = new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch",
            clientX: p.clientX, clientY: p.clientY, button: 0, isPrimary: true,
        });
        svg.dispatchEvent(e);
    };
    document.querySelector('.annot-mobile-rail button[data-tool="arrow"]').click();
    fire("pointerdown", at(150, 150));
    fire("pointermove", at(300, 260));
    fire("pointerup", at(460, 380));
    const count = document.querySelectorAll('[data-layer="objects"] .annot-shape').length;
    return {count};
})()`);
check("真实浏览器（手机视口）：单指可以画出箭头", (touchDraw?.count || 0) >= 1, JSON.stringify(touchDraw));

// 触摸手柄：命中区应放大到屏幕 60px 直径，点在节点旁边 12px 也能抓住
const touchHandle = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const r = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const at = (x, y) => ({clientX: r.left + x * r.width / w, clientY: r.top + y * r.height / h});
    const fire = (type, p, id) => svg.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: id, pointerType: "touch",
        clientX: p.clientX, clientY: p.clientY, button: 0, isPrimary: true,
    }));
    document.querySelector('[data-action="mobile-select"]').click();
    const hit = document.querySelector('[data-layer="objects"] g.annot-object [data-role="hit"]');
    const mid = at(305, 265);
    if (hit) {
        hit.dispatchEvent(new PointerEvent("pointerdown", {
            bubbles: true, cancelable: true, pointerId: 9, pointerType: "touch",
            button: 0, isPrimary: true, clientX: mid.clientX, clientY: mid.clientY,
        }));
        fire("pointerup", mid, 9);
    }
    const handle = document.querySelector('[data-role="handles"] g[data-handle="end"]');
    const box = handle?.getBoundingClientRect();
    if (!box) return null;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // 浏览器真实 hit-testing：点在节点中心偏 12px 处，应该仍然命中的是手柄
    const probe = document.elementFromPoint(cx + 12, cy + 10);
    return {
        size: {w: Math.round(box.width), h: Math.round(box.height)},
        probeIsHandle: !!probe?.closest?.('[data-handle="end"]'),
        probeTag: probe?.tagName || "",
        center: {x: cx, y: cy},
    };
})()`);
check("真实浏览器（手机视口）：手柄命中区放大到 60px 直径",
    (touchHandle?.size?.w || 0) >= 54 && (touchHandle?.size?.h || 0) >= 54,
    JSON.stringify(touchHandle?.size));
check("真实浏览器（手机视口）：手指点在节点旁边 12px 仍抓到手柄（不会变成拖整个对象）",
    touchHandle?.probeIsHandle === true, `命中元素=${touchHandle?.probeTag}`);

const pinch = await evaluate(`(() => {
    const stage = document.querySelector(".annot-stage");
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const fire = (type, x, y, id) => {
        stage.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: id, pointerType: "touch",
            clientX: x, clientY: y, button: 0, isPrimary: id === 1,
        }));
    };
    const readZoom = () => {
        const m = /scale\\(([-\\d.]+)\\)/.exec(document.querySelector('[data-role="transform"]').style.transform || "");
        return m ? Number(m[1]) : 0;
    };
    const before = readZoom();
    fire("pointerdown", cx - 60, cy, 1);
    fire("pointerdown", cx + 60, cy, 2);
    fire("pointermove", cx - 120, cy, 1);
    fire("pointermove", cx + 120, cy, 2);
    const after = readZoom();
    fire("pointerup", cx - 120, cy, 1);
    fire("pointerup", cx + 120, cy, 2);
    return {before, after};
})()`);
check("真实浏览器（手机视口）：双指捏合会放大画布",
    (pinch?.after || 0) > (pinch?.before || 0) * 1.3,
    `${pinch?.before?.toFixed(2)} → ${pinch?.after?.toFixed(2)}`);
await saveShot("移动端-双指缩放.png");

// 选中刚画的箭头：抽屉不自动弹，点「属性」才展开
const sheetFlow = await evaluate(`(() => {
    document.querySelector('[data-action="mobile-select"]').click();
    const hit = document.querySelector('[data-layer="objects"] g.annot-object [data-role="hit"]');
    const svg = document.querySelector('[data-role="svg"]');
    const r = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute("width")) || 1200;
    const h = Number(svg.getAttribute("height")) || 800;
    const fire = (type, x, y) => svg.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch",
        clientX: r.left + x * r.width / w, clientY: r.top + y * r.height / h, button: 0, isPrimary: true,
    }));
    hit?.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", button: 0, isPrimary: true,
        clientX: r.left + 200 * r.width / w, clientY: r.top + 200 * r.height / h,
    }));
    fire("pointerup", 200, 200);
    const autoOpen = document.querySelector('[data-role="sidebar"]')?.classList.contains("is-open");
    const more = document.querySelector('[data-action="mobile-props"]');
    const moreVisible = more ? !more.hidden : false;
    more?.click();
    const opened = document.querySelector('[data-role="sidebar"]')?.classList.contains("is-open");
    const layerGroups = Array.from(document.querySelectorAll('[data-role="mobile-style"] [data-group]'))
        .map((el) => el.getAttribute("data-group")).join(",");
    return {autoOpen, moreVisible, opened, layerGroups};
})()`);
check("真实浏览器（手机视口）：选中对象后抽屉不自动弹，点「属性」才展开",
    sheetFlow?.autoOpen === false && sheetFlow?.moreVisible === true && sheetFlow?.opened === true,
    JSON.stringify(sheetFlow));
check("真实浏览器（手机视口）：选中箭头后上栏显示颜色 + 粗细",
    sheetFlow?.layerGroups === "colors,widths", String(sheetFlow?.layerGroups));
await sleep(350);
await saveShot("移动端-属性抽屉.png");
await evaluate(`document.querySelector('[data-action="mobile-props"]')?.click()`);
await sleep(200);

// 收尾：恢复桌面视口，避免影响其它工具
await send("Emulation.setTouchEmulationEnabled", {enabled: false});
await send("Emulation.clearDeviceMetricsOverride");

const summary = results.filter((r) => r.ok).length;
console.log(`\n真实浏览器 PNG 封装校验：${summary}/${results.length} 通过\n`);
ws.close();
server.close();
process.exit(summary === results.length ? 0 : 1);
