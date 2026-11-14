/**
 * 真实浏览器（Edge headless + CDP）验证新增的「画线」工具。
 *
 * jsdom 能证明数据对，证明不了真实内核里图标有没有被主题染成实心块、
 * 鼠标事件会不会真的画出线、以及折线能不能写进成品 PNG。这里全走一遍。
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/browser-line-check.mjs [输出目录]
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

function crc32(buf) {
    let c = ~0;
    for (const byte of buf) {
        c ^= byte;
        for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return (~c) >>> 0;
}
function makePng(width, height) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0;
        for (let x = 0; x < width; x++) {
            raw[o++] = 216; raw[o++] = 221; raw[o++] = 230;
        }
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
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
const png = makePng(1200, 800);

/**
 * 花纹底图：用来验证放大镜「真的把画面放大了」。
 * 画布是浅灰网格 + 几个纯色块 + 斜纹，放大后色块边界会明显错位，
 * 用像素就能判定「镜片里是锚点附近的内容」而不是一片纯色。
 */
function makePatternPng(width, height, dark = false) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    const set = (o, r, g, b) => { raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; };
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0;
        for (let x = 0; x < width; x++) {
            let r = dark ? 26 : 232, g = dark ? 34 : 238, b = dark ? 54 : 247;
            if (x % 80 === 0 || y % 80 === 0) { r = dark ? 55 : 200; g = dark ? 70 : 210; b = dark ? 96 : 224; }
            if (x >= 100 && x < 160 && y >= 100 && y < 160) { r = 219; g = 39; b = 119; }
            if (x >= 360 && x < 520 && y >= 120 && y < 240) { r = 59; g = 130; b = 246; }
            if (x >= 620 && x < 780 && y >= 300 && y < 420) { r = 16; g = 185; b = 129; }
            if (x >= 200 && y >= 560 && x < 520 && y < 700 && ((x + y) % 40 < 20)) { r = 245; g = 158; b = 11; }
            set(o, r, g, b);
            o += 3;
        }
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
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
const patternPng = makePatternPng(1200, 800);
const darkPng = makePatternPng(1200, 800, true);
let servePattern = false;
let serveDark = false;

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || "/").split("?")[0];
        if (url === "/__pattern") {
            servePattern = true;
            res.end("ok");
        } else if (url === "/__dark") {
            serveDark = true;
            servePattern = false;
            res.end("ok");
        } else if (url === "/" || url === "/index.html") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(await readFile(harnessFile));
        } else if (url === "/index.js") {
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.end(await readFile(path.join(distDir, "index.js")));
        } else if (url === "/index.css") {
            res.setHeader("Content-Type", "text/css; charset=utf-8");
            res.end(await readFile(path.join(distDir, "index.css")));
        } else if (url.startsWith("/assets/") && url.endsWith(".png")) {
            res.setHeader("Content-Type", "image/png");
            if (url.includes("dark") || serveDark) res.end(darkPng);
            else res.end(url.includes("pattern") || servePattern ? patternPng : png);
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
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

// ---- 1) 按钮位置与图标（真实浏览器里最容易被主题样式染坏） ----
const icon = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.annot-imagebar button[data-tool]'));
    const order = buttons.map((b) => b.getAttribute('data-tool'));
    const svg = document.querySelector('button[data-tool="line"] svg');
    const path = svg?.querySelector('path');
    return {
        order: order.join(','),
        afterEllipse: order.indexOf('line') === order.indexOf('ellipse') + 1,
        viewBox: svg?.getAttribute('viewBox') || '',
        fillAttr: path?.getAttribute('fill') || '',
        computedFill: path ? getComputedStyle(path).fill : '',
        label: document.querySelector('button[data-tool="line"]')?.getAttribute('title') || '',
    };
})()`);
check("真实浏览器：画线按钮紧跟画圆",
    icon.afterEllipse === true, icon.order);
check("真实浏览器：图标是用户给的原稿且用 currentColor",
    icon.viewBox === "0 0 1706 1024" && icon.fillAttr === "currentColor" &&
    icon.label.includes("画线"), JSON.stringify(icon));

// 三颗用过原稿的图标：画线（1706）、扩展画布（1024 嵌套方框）、聚光灯（1024 灯头）
const fillProbe = `(() => {
    const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fill : "missing";
    };
    return {
        line: pick('button[data-tool="line"] svg path'),
        extend: pick('[data-canvas-op="extend"] svg path'),
        spotlight: pick('button[data-tool="spotlight"] svg path'),
    };
})()`;
await evaluate(`document.documentElement.setAttribute('data-theme-mode', 'dark')`);
await sleep(250);
const darkFills = await evaluate(fillProbe);
await evaluate(`document.documentElement.setAttribute('data-theme-mode', 'light')`);
await sleep(250);
const lightFills = await evaluate(fillProbe);
const darkFill = darkFills.line;
const lightFill = lightFills.line;
check("真实浏览器：图标颜色跟随思源深浅主题",
    !!darkFill && !!lightFill && darkFill !== lightFill, `${lightFill} / ${darkFill}`);
check("真实浏览器：扩展画布与聚光灯两颗新图标也跟随深浅主题（fill 取 currentColor）",
    ["extend", "spotlight"].every((key) =>
        lightFills[key] !== "missing" && darkFills[key] !== "missing" &&
        lightFills[key] === lightFills.line && darkFills[key] === darkFills.line &&
        lightFills[key] !== darkFills[key]),
    JSON.stringify({light: lightFills, dark: darkFills}));

// ---- 2) 真实鼠标拖拽、Shift 约束、连续折线 ----
const drawing = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, extra = {}) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY, ...extra,
    }));
    const clickAt = (x, y) => { fire('pointerdown', at(x, y)); fire('pointerup', at(x, y)); };
    const objects = () => document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)').length;
    const lastD = () => {
        const gs = document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)');
        return gs[gs.length - 1]?.querySelector('path.annot-shape')?.getAttribute('d') || '';
    };
    document.querySelector('[data-role="group-colors"] button[data-value="#EF4444"]')?.click();
    document.querySelector('button[data-tool="line"]').click();

    // 普通拖拽直线
    fire('pointerdown', at(100, 200));
    fire('pointermove', at(160, 240));
    fire('pointerup', at(220, 280));
    const afterDrag = objects();
    const dragPath = lastD();
    const dragColor = (() => {
        const gs = document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)');
        return gs[gs.length - 1]?.querySelector('path.annot-shape')?.getAttribute('stroke') || '';
    })();

    // Shift：斜拉应被锁成水平 / 垂直 / 45°
    fire('pointerdown', at(300, 200));
    fire('pointermove', at(360, 220), {shiftKey: true});
    fire('pointerup', at(420, 230), {shiftKey: true});
    const shiftD = lastD();
    const nums = (shiftD.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
    const dx = Math.abs((nums[2] || 0) - (nums[0] || 0));
    const dy = Math.abs((nums[3] || 0) - (nums[1] || 0));
    const locked = dy < 0.01 || dx < 0.01 || Math.abs(dx - dy) < 0.01;

    // 连续折线：点起点 → 点两个折点 → 双击结束
    clickAt(500, 200);
    const beforePolyline = objects();
    fire('pointermove', at(560, 260));
    clickAt(560, 260);
    fire('pointermove', at(620, 190));
    clickAt(620, 190);
    const duringPolyline = objects();
    svg.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true, ...at(620, 190)}));
    const afterPolyline = objects();
    const polylineD = lastD();

    return {afterDrag, dragPath, dragColor, locked, shiftD,
        beforePolyline, duringPolyline, afterPolyline, polylineD,
        segments: (polylineD.match(/ L /g) || []).length};
})()`);
check("真实浏览器：拖鼠标画出一条独立直线",
    drawing.afterDrag === 1 && /^M .* L /.test(drawing.dragPath) &&
    /^#[0-9A-Fa-f]{6}$/.test(drawing.dragColor),
    JSON.stringify({count: drawing.afterDrag, d: drawing.dragPath, color: drawing.dragColor}));
check("真实浏览器：按住 Shift 只画水平 / 垂直 / 45°",
    drawing.locked === true, drawing.shiftD);
check("真实浏览器：折线收尾前不提前生成零散对象",
    drawing.duringPolyline === drawing.beforePolyline,
    `${drawing.beforePolyline} → ${drawing.duringPolyline}`);
check("真实浏览器：双击结束折线并得到多段线",
    drawing.afterPolyline === drawing.beforePolyline + 1 && drawing.segments >= 2,
    drawing.polylineD);
await sleep(250);
const shot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "画线-真实浏览器.png"), Buffer.from(shot.data, "base64"));

// ---- 2.5) PC 界面重构：真实浏览器里逐项点一遍 ----
const pcLayout = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => Array.from(document.querySelectorAll(s));
    const left = q('.annot-imagebar').getBoundingClientRect();
    const stage = q('.annot-stage').getBoundingClientRect();
    const side = q('[data-role="sidebar"]').getBoundingClientRect();
    const handle = q('.annot-side-handle').getBoundingClientRect();
    return {
        leftTools: all('.annot-imagebar [data-role="tool-buttons"] button[data-tool]').length,
        leftOps: all('.annot-imagebar [data-canvas-op]').length,
        topTools: all('.annot-toolbar button[data-tool]').length,
        topGroups: q('.annot-toolbar [data-role="group-colors"]')?.querySelectorAll('[data-preset="color"]').length === 5 &&
            q('.annot-toolbar [data-role="group-widths"]')?.querySelectorAll('[data-preset="lineWidth"]').length === 4 &&
            q('.annot-toolbar [data-role="group-lines"]')?.querySelectorAll('[data-preset="lineDash"]').length === 4 &&
            q('.annot-toolbar [data-role="group-fills"]')?.querySelectorAll('[data-preset="fillOpacity"]').length === 4 &&
            q('.annot-toolbar [data-role="group-fonts"]')?.querySelectorAll('[data-preset="fontSize"]').length === 4,
        sections: ['objects','layers']
            .every((k) => !!q('.annot-side-section[data-section="' + k + '"]')) &&
            !q('.annot-side-section[data-section="props"]'),
        leftBeforeStage: left.right <= stage.left + 1,
        sideAfterStage: side.left >= stage.right - 1,
        handleVisible: handle.width > 0 && getComputedStyle(q('.annot-side-handle')).display !== 'none',
        handleProtrudes: handle.left < side.left && handle.right > side.left - 20,
    };
})()`);
check("真实浏览器：左侧竖栏上下两组（11 个绘图工具）、顶部只剩通用属性、右侧对象 / 层级两块",
    pcLayout.leftTools === 11 && pcLayout.leftOps === 6 && pcLayout.topTools === 0 &&
    pcLayout.topGroups && pcLayout.sections, JSON.stringify(pcLayout));
check("真实浏览器：左侧栏在画布左边、右侧面板在画布右边、拉手凸出可见",
    pcLayout.leftBeforeStage && pcLayout.sideAfterStage &&
    pcLayout.handleVisible && pcLayout.handleProtrudes, JSON.stringify(pcLayout));

const ctxFlow = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => Array.from(document.querySelectorAll(s));
    const bar = q('[data-role="context-bar"]');
    q('button[data-tool="mosaic"]').click();
    const mosaic = {shown: !bar.hidden, block: !!bar.querySelector('[data-ctx="blockSize"]'),
        opacity: !!bar.querySelector('[data-ctx="opacity"]')};
    q('button[data-tool="blur"]').click();
    const blur = {shown: !bar.hidden, radius: !!bar.querySelector('[data-ctx="blurRadius"]')};
    q('button[data-tool="arrow"]').click();
    const picker = bar.querySelector('[data-role="arrow-picker"]');
    const items = Array.from(picker?.querySelectorAll('.annot-arrow-picker__item') || []);
    const rounded = bar.querySelector('[data-action="arrow-rounded"]');
    const arrow = {
        shown: !bar.hidden,
        hasPicker: !!picker,
        options: items.length,
        keys: items.map((i) => i.getAttribute('data-value')).join(','),
        noSelect: !bar.querySelector('select[data-action="arrow-style-select"]'),
        noButtons: all('[data-action="arrow-style"]').length === 0,
        labelsAndIcons: items.length > 0 && items.every((i) =>
            !!i.querySelector('.annot-arrow-picker__item-label')?.textContent.trim() &&
            !!i.querySelector('.annot-arrow-picker__icon > svg.annot-arrow-style-icon')),
        buttonText: picker?.querySelector('.annot-arrow-picker__label')?.textContent || '',
        buttonIcon: !!picker?.querySelector('.annot-arrow-picker__button svg.annot-arrow-style-icon'),
        hasRounded: !!rounded,
        roundedOn: rounded?.getAttribute('aria-pressed') === 'true',
        roundedBg: rounded ? getComputedStyle(rounded).backgroundColor : '',
    };
    q('button[data-tool="rect"]').click();
    const cornerItems = Array.from(bar.querySelectorAll('.annot-corner-picker__item'));
    const corner = {
        shown: !bar.hidden,
        hasPicker: !!bar.querySelector('[data-role="corner-picker"]'),
        options: cornerItems.length,
        keys: cornerItems.map((i) => i.getAttribute('data-value')).join(','),
        icon: !!bar.querySelector('.annot-corner-picker__button svg.annot-corner-icon'),
        labels: cornerItems.length > 0 && cornerItems.every((i) => i.textContent.trim().length > 0),
        value: bar.querySelector('[data-role="corner-value"]')?.textContent || '',
        ellipseless: true,
    };
    q('button[data-tool="ellipse"]').click();
    corner.ellipseless = !bar.querySelector('[data-role="corner-picker"]');
    return {mosaic, blur, arrow, corner};
})()`);
check("真实浏览器：悬浮条按工具切换（马赛克 / 模糊 / 箭头下拉 + 圆角开关）",
    ctxFlow.mosaic.shown && ctxFlow.mosaic.block && ctxFlow.mosaic.opacity &&
    ctxFlow.blur.shown && ctxFlow.blur.radius &&
    ctxFlow.arrow.shown && ctxFlow.arrow.hasPicker && ctxFlow.arrow.options === 7 &&
    ctxFlow.arrow.noSelect && ctxFlow.arrow.noButtons && ctxFlow.arrow.hasRounded,
    JSON.stringify(ctxFlow));
check("真实浏览器：下拉按钮与每个选项都是「文字 + 图案」",
    ctxFlow.arrow.buttonText.length > 0 && ctxFlow.arrow.buttonIcon && ctxFlow.arrow.labelsAndIcons,
    JSON.stringify({text: ctxFlow.arrow.buttonText, icon: ctxFlow.arrow.buttonIcon}));
check("真实浏览器：矩形工具下悬浮条出现圆角下拉（十档，图案 + 数值）",
    ctxFlow.corner.shown && ctxFlow.corner.hasPicker && ctxFlow.corner.options === 10 &&
    ctxFlow.corner.keys === '0,2,4,6,8,10,15,20,25,30' &&
    ctxFlow.corner.icon && ctxFlow.corner.labels && ctxFlow.corner.value === '0',
    JSON.stringify(ctxFlow.corner));
check("真实浏览器：椭圆工具下没有圆角控件（只有矩形有）",
    ctxFlow.corner.ellipseless === true, String(ctxFlow.corner.ellipseless));
check("真实浏览器：下拉里是 ShareX 五种 + 保留的两种竖线连接线（基础排第一）",
    ctxFlow.arrow.keys === 'basic,classic,modern,double,line,bar,barDouble',
    ctxFlow.arrow.keys);
check("真实浏览器：圆角开关默认开启且有高亮背景",
    ctxFlow.arrow.roundedOn && ctxFlow.arrow.roundedBg !== 'rgba(0, 0, 0, 0)' &&
    ctxFlow.arrow.roundedBg !== 'transparent', JSON.stringify(ctxFlow.arrow));

const variants = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const pick = (style) => {
        q('button[data-tool="arrow"]').click();
        const picker = q('[data-role="arrow-picker"]');
        if (!picker) return;
        if (!picker.classList.contains('is-open')) q('[data-action="arrow-picker-toggle"]').click();
        q('.annot-arrow-picker__item[data-value="' + style + '"]').click();
    };
    const out = {};
    let y = 240;
    for (const style of ['classic','modern','double','basic','line','bar','barDouble']) {
        pick(style);
        fire('pointerdown', at(660, y));
        fire('pointermove', at(770, y + 26));
        fire('pointerup', at(870, y + 48));
        const gs = document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)');
        const last = gs[gs.length - 1];
        const heads = Array.from(last?.querySelectorAll('path.annot-head') || []);
        const bars = Array.from(last?.querySelectorAll('line.annot-bar') || []);
        const shaft = last?.querySelector('path.annot-shape');
        // Modern 直线没有独立主干：杆与头是同一个闭合图形
        const primary = shaft || heads[0];
        const d = primary?.getAttribute('d') || '';
        const nums = (d.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
        const shaftNums = (shaft?.getAttribute('d') || '').match(/-?\\d+(?:\\.\\d+)?/g)?.map(Number) || [];
        const seamless = bars.length === 2 && shaftNums.length >= 4 && bars.every((line) => {
            const mx = (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2;
            const my = (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2;
            return Math.hypot(mx - shaftNums[0], my - shaftNums[1]) < 0.01 ||
                Math.hypot(mx - shaftNums[2], my - shaftNums[3]) < 0.01;
        });
        out[style] = {
            heads: heads.length,
            bars: bars.length,
            curved: heads.some((n) => (n.getAttribute('d') || '').includes('Q')),
            openHead: heads.some((n) => !(n.getAttribute('d') || '').includes('Z')),
            hollow: heads.some((n) => n.getAttribute('fill') === 'none'),
            filled: heads.every((n) => n.getAttribute('fill') !== 'none'),
            strokeWidths: heads.map((n) => n.getAttribute('stroke-width')),
            barWidths: bars.map((n) => n.getAttribute('stroke-width')),
            closedModern: !shaft && heads.length === 1 && (d.match(/L/g) || []).length >= 5,
            seamless: seamless,
            d: d,
            nums: nums,
            mids: bars.map((line) => [
                (Number(line.getAttribute('x1')) + Number(line.getAttribute('x2'))) / 2,
                (Number(line.getAttribute('y1')) + Number(line.getAttribute('y2'))) / 2,
            ]),
        };
        y += 64;
    }
    return out;
})()`);
check("真实浏览器：七种箭头都渲染正确（经典背弧 / 现代一体 / 双头 / 基础 / 开放 V / 两种竖线）",
    variants.classic.heads === 1 && variants.classic.curved &&
    variants.modern.closedModern && variants.double.heads === 2 &&
    variants.basic.heads === 1 && !variants.basic.curved && !variants.basic.openHead &&
    variants.line.heads === 1 && variants.line.openHead && variants.line.hollow &&
    variants.bar.bars === 2 && variants.bar.seamless &&
    variants.barDouble.bars === 2 && variants.barDouble.heads === 2,
    JSON.stringify(variants));
check("真实浏览器：头部轮廓按线宽描边（尖端不会露出主干线头），竖线也同宽",
    variants.classic.strokeWidths.every((w) => w === '4') &&
    variants.double.strokeWidths.every((w) => w === '4') &&
    variants.basic.strokeWidths.every((w) => w === '4') &&
    variants.barDouble.barWidths.every((w) => w === '4') &&
    variants.bar.barWidths.every((w) => w === '4'),
    JSON.stringify({classic: variants.classic.strokeWidths, bars: variants.bar.barWidths}));

const roundedFlow = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    q('button[data-tool="arrow"]').click();
    q('[data-action="arrow-picker-toggle"]').click();
    q('.annot-arrow-picker__item[data-value="basic"]').click();
    q('[data-action="arrow-rounded"]').click();
    const off = q('[data-action="arrow-rounded"]').getAttribute('aria-pressed');
    fire('pointerdown', at(660, 700));
    fire('pointermove', at(770, 726));
    fire('pointerup', at(870, 748));
    const gs = document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)');
    const last = gs[gs.length - 1];
    const cap = last?.querySelector('path.annot-shape')?.getAttribute('stroke-linecap');
    const join = last?.querySelector('path.annot-head')?.getAttribute('stroke-linejoin');
    // SVG 默认 miter limit 只有 4，燕尾尾部尖角（比值约 4.35）会被削成平头
    const limit = last?.querySelector('path.annot-head')?.getAttribute('stroke-miterlimit');
    // 关闭圆角时 miter 会让尖头外伸，竖线双头必须按溢出量内缩，否则戳出竖线
    q('[data-action="arrow-picker-toggle"]').click();
    q('.annot-arrow-picker__item[data-value="barDouble"]').click();
    fire('pointerdown', at(660, 780));
    fire('pointermove', at(770, 780));
    fire('pointerup', at(870, 780));
    const gs2 = document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)');
    const last2 = gs2[gs2.length - 1];
    const nums = (d) => (d || '').match(/-?\\d+(?:\\.\\d+)?/g)?.map(Number) || [];
    const shaft2 = nums(last2?.querySelector('path.annot-shape')?.getAttribute('d'));
    const head2 = nums(Array.from(last2?.querySelectorAll('path.annot-head') || []).pop()?.getAttribute('d'));
    const inset = (shaft2.length >= 4 && head2.length >= 2)
        ? Math.hypot(shaft2[2] - head2[0], shaft2[3] - head2[1]) : -1;
    q('[data-action="arrow-rounded"]').click();
    const on = q('[data-action="arrow-rounded"]').getAttribute('aria-pressed');
    return {off, on, cap, join, limit, inset};
})()`);
check("真实浏览器：圆角开关关掉后箭头变平头尖角，再打开恢复",
    roundedFlow.off === 'false' && roundedFlow.on === 'true' &&
    roundedFlow.cap === 'butt' && roundedFlow.join === 'miter', JSON.stringify(roundedFlow));
check("真实浏览器：关闭圆角时 miter limit 取 10，燕尾尖角不会被削平",
    roundedFlow.limit === '10', String(roundedFlow.limit));
check("真实浏览器：关闭圆角时竖线双头的尖头内缩 (线宽/2)/sin(半角)，不会戳出竖线",
    Math.abs(roundedFlow.inset - 6.32) < 0.25, String(roundedFlow.inset));

// 真实绘制：矩形画完仍选中时，改圆角应当立刻改这一支
const cornerFlow = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const lastRect = () => {
        const rs = Array.from(document.querySelectorAll('[data-layer="objects"] rect.annot-shape'));
        return rs[rs.length - 1];
    };
    q('button[data-tool="rect"]').click();
    fire('pointerdown', at(660, 660));
    fire('pointermove', at(760, 700));
    fire('pointerup', at(900, 760));
    const before = {rx: lastRect()?.getAttribute('rx'), value: q('[data-role="corner-value"]')?.textContent};
    q('[data-action="corner-picker-toggle"]').click();
    const opened = q('[data-role="corner-picker"]').classList.contains('is-open');
    q('.annot-corner-picker__item[data-value="15"]').click();
    const after = {
        rx: lastRect()?.getAttribute('rx'),
        ry: lastRect()?.getAttribute('ry'),
        value: q('[data-role="corner-value"]')?.textContent,
        closed: !q('[data-role="corner-picker"]').classList.contains('is-open'),
    };
    return {before, opened, after};
})()`);
check("真实浏览器：画完矩形点圆角档位，这一支当场变圆角",
    cornerFlow.before.rx === '0' && cornerFlow.before.value === '0' &&
    cornerFlow.after.rx === '15' && cornerFlow.after.ry === '15' &&
    cornerFlow.after.value === '15' && cornerFlow.after.closed,
    JSON.stringify(cornerFlow));

// ---- 2.55) 画完箭头仍选中时，换样式当场改这一支（与矩形圆角同一套逻辑）----
const arrowTargetFlow = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const lastGroup = () => groups()[groups().length - 1];
    const heads = () => lastGroup()?.querySelectorAll('path.annot-head').length ?? 0;
    // 每次点完样式悬浮条会整块重画，必须重新 query
    const pick = (key) => {
        const bar = q('[data-role="context-bar"]');
        const picker = bar.querySelector('[data-role="arrow-picker"]');
        if (!picker.classList.contains('is-open')) {
            picker.querySelector('[data-action="arrow-picker-toggle"]').click();
        }
        bar.querySelector('.annot-arrow-picker__item[data-value="' + key + '"]').click();
    };
    q('button[data-tool="arrow"]').click();
    pick('double');
    fire('pointerdown', at(200, 620));
    fire('pointermove', at(280, 640));
    fire('pointerup', at(360, 660));
    const drawnHeads = heads();
    // 仍选中：切经典应当当场把这一支改成单头
    pick('classic');
    const afterPick = heads();
    const label = q('[data-role="context-bar"] .annot-arrow-picker__label')?.textContent || '';
    // 点空白取消选中（不会凭空画出对象）
    const beforeBlank = groups().length;
    fire('pointerdown', at(80, 500));
    fire('pointerup', at(80, 500));
    const afterBlank = groups().length;
    // 没选中时切基础：上一支必须不动
    pick('basic');
    const afterDeselectPick = heads();
    // 下一支按基础样式画出来
    fire('pointerdown', at(200, 700));
    fire('pointermove', at(280, 720));
    fire('pointerup', at(360, 740));
    const nextHeads = heads();
    return {drawnHeads, afterPick, label, beforeBlank, afterBlank, afterDeselectPick, nextHeads};
})()`);
check("真实浏览器：画完箭头仍选中时，切样式当场改这一支（双头 → 经典单头）",
    arrowTargetFlow.drawnHeads === 2 && arrowTargetFlow.afterPick === 1 && arrowTargetFlow.label === '经典',
    JSON.stringify({drawnHeads: arrowTargetFlow.drawnHeads, afterPick: arrowTargetFlow.afterPick, label: arrowTargetFlow.label}));
check("真实浏览器：点空白取消选中后换样式只改默认值，上一支保持原样",
    arrowTargetFlow.afterBlank === arrowTargetFlow.beforeBlank && arrowTargetFlow.afterDeselectPick === 1,
    JSON.stringify({before: arrowTargetFlow.beforeBlank, after: arrowTargetFlow.afterBlank, heads: arrowTargetFlow.afterDeselectPick}));
check("真实浏览器：取消选中时选的样式用在下一次绘制的箭头上",
    arrowTargetFlow.nextHeads === 1, `${arrowTargetFlow.nextHeads} 个头部`);

// ---- 2.7) v0.14.0：箭头顺序 / 点划线 / 画线圆线端 / 自定义颜色预设 ----
const v14 = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const drag = (a, b) => { fire('pointerdown', at(a.x, a.y)); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const lastGroup = () => groups()[groups().length - 1];

    // 1) 箭头下拉顺序
    q('button[data-tool="arrow"]').click();
    drag({x: 120, y: 620}, {x: 260, y: 680});
    await wait(60);
    q('[data-action="arrow-picker-toggle"]').click();
    const items = Array.from(document.querySelectorAll('.annot-arrow-picker__item'));
    const arrowOrder = items.map((el) => el.getAttribute('data-value'));
    const arrowLabels = items.map((el) => el.textContent.trim());
    const activeLabels = items.filter((el) => el.classList.contains('is-active'))
        .map((el) => el.textContent.trim());
    const activeLabel = document.querySelector('.annot-arrow-picker__label')?.textContent.trim() || '';
    q('[data-action="arrow-picker-toggle"]').click();

    // 2) 点划线
    q('button[data-tool="rect"]').click();
    const dashBtn = q('button[data-preset="lineDash"][data-value="dashdot"]');
    const dashLabel = dashBtn ? dashBtn.textContent.trim() : '';
    dashBtn?.click();
    drag({x: 320, y: 620}, {x: 470, y: 690});
    await wait(60);
    const dashRect = lastGroup()?.querySelector('rect.annot-shape');
    const dashAttrs = {
        pattern: dashRect?.getAttribute('stroke-dasharray') || '',
        cap: dashRect?.getAttribute('stroke-linecap') || '',
    };
    q('button[data-preset="lineDash"][data-value="solid"]')?.click();

    // 3) 画线悬浮条 + 圆线开关
    q('button[data-tool="line"]').click();
    drag({x: 520, y: 640}, {x: 680, y: 700});
    await wait(60);
    const bar = q('[data-role="context-bar"]');
    const barText = bar.textContent.trim();
    const roundBtn = bar.querySelector('[data-action="line-round"]');
    const roundLabel = roundBtn ? roundBtn.textContent.trim() : '';
    const pressedBefore = roundBtn?.getAttribute('aria-pressed');
    const capBefore = lastGroup()?.querySelector('path.annot-shape')?.getAttribute('stroke-linecap') || '';
    roundBtn?.click();
    await wait(60);
    const capAfter = lastGroup()?.querySelector('path.annot-shape')?.getAttribute('stroke-linecap') || '';
    const joinAfter = lastGroup()?.querySelector('path.annot-shape')?.getAttribute('stroke-linejoin') || '';
    const pressedAfter = q('[data-action="line-round"]')?.getAttribute('aria-pressed');

    // 4) 自定义颜色圆球 + 预设（圆球就摆在顶栏颜色那一组里，不用先展开）
    await wait(80);
    const ball = () => q('[data-role="custom-color"]');
    const ballBefore = {
        isBall: ball()?.classList.contains('annot-custom-color') || false,
        cross: !!ball()?.querySelector('.annot-custom-color__cross'),
        bg: getComputedStyle(ball()).backgroundColor,
        ink: getComputedStyle(ball()).getPropertyValue('--annot-ball-ink').trim(),
        size: (() => { const r = ball().getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; })(),
    };
    ball().click();
    await wait(60);
    const pop = () => q('[data-role="color-pop"]');
    const popOpen = {
        hidden: pop()?.hidden ?? true,
        hasWheel: !!q('[data-role="color-wheel"] .annot-cw'),
        readouts: q('[data-role="color-wheel"]')?.querySelectorAll('.annot-cw__readout').length ?? 0,
        hasHex: !!q('[data-role="color-wheel"] .annot-cw__hex-input'),
        hasRgb: (() => {
            q('[data-role="color-wheel"] [data-cw-mode="rgb"]')?.click();
            const shown = !!q('[data-role="color-wheel"] .annot-cw__rgb') &&
                !q('[data-role="color-wheel"] .annot-cw__rgb').hidden &&
                q('[data-role="color-wheel"]')?.querySelectorAll('.annot-cw__cell input').length === 3;
            q('[data-role="color-wheel"] [data-cw-mode="hex"]')?.click();
            return shown;
        })(),
        hasSave: !!q('[data-action="color-save"]'),
        inViewport: (() => {
            const r = pop().getBoundingClientRect();
            return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
        })(),
        box: (() => { const r = pop().getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; })(),
    };
    const setHex = async (hex) => {
        const field = q('[data-role="color-wheel"] .annot-cw__hex-input');
        field.value = hex;
        field.dispatchEvent(new Event('change', {bubbles: true}));
        await wait(60);
    };
    await setHex('#1D4ED8');
    const afterPick = {
        bg: getComputedStyle(ball()).backgroundColor,
        ink: getComputedStyle(ball()).getPropertyValue('--annot-ball-ink').trim(),
        cross: !!ball()?.querySelector('.annot-custom-color__cross'),
        wheelWidth: Math.round(q('[data-role="color-wheel"] .annot-cw__wheel')?.getBoundingClientRect().width || 0),
        hexValue: String(q('[data-role="color-wheel"] .annot-cw__hex-input')?.value || '').toUpperCase(),
        readouts: Array.from(q('[data-role="color-wheel"]')?.querySelectorAll('.annot-cw__readout b') ?? [])
            .map((el) => el.textContent),
        strokeOfLastLine: lastGroup()?.querySelector('path.annot-shape')?.getAttribute('stroke') || '',
    };

    // 真拖色环：从环上换一个色相，画布上的线要跟着变
    const wheelBox = q('[data-role="color-wheel"] .annot-cw__wheel')?.getBoundingClientRect();
    const hueProbe = (() => {
        if (!wheelBox) return null;
        const cx = wheelBox.left + wheelBox.width / 2;
        const cy = wheelBox.top + wheelBox.height / 2;
        const ringR = wheelBox.width / 2 - 10;
        const fireAt = (type, x, y) => document.querySelector('[data-role="color-wheel"] .annot-cw__wheel')
            .dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y}));
        fireAt('pointerdown', cx, cy - ringR);
        fireAt('pointermove', cx + ringR, cy);
        fireAt('pointerup', cx + ringR, cy);
        return {hex: q('[data-role="color-wheel"] .annot-cw__hex-input')?.value || '',
            stroke: lastGroup()?.querySelector('path.annot-shape')?.getAttribute('stroke') || '',
            ball: ball()?.style.getPropertyValue('--annot-ball') || ''};
    })();
    q('[data-action="color-save"]').click();
    await wait(60);
    await setHex('#F59E0B');
    q('[data-action="color-save"]').click();
    await wait(60);
    await setHex('#0F766E');
    q('[data-action="color-save"]').click();
    await wait(60);
    const chips = () => Array.from(document.querySelectorAll('[data-role="color-preset"]'));
    const chipCount = () => chips().length;
    const chipOrder = () => chips().map((el) => el.getAttribute('data-value'));
    const stored = JSON.parse(localStorage.getItem('siyuan-plugin-annotate:colors') || '{}');
    const savedChips = chipCount();
    const beforeReorder = chipOrder();

    // 真拖动：把第一个色点拖到第二个色点上（真实布局，坐标是真的）
    const first = chips()[0];
    const second = chips()[1];
    const from = first.getBoundingClientRect();
    const to = second.getBoundingClientRect();
    const pev = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y,
    }));
    pev(first, 'pointerdown', from.left + from.width / 2, from.top + from.height / 2);
    pev(q('[data-role="color-presets"]'), 'pointermove',
        to.left + to.width / 2, to.top + to.height / 2);
    pev(q('[data-role="color-presets"]'), 'pointerup', to.left + to.width / 2, to.top + to.height / 2);
    await wait(80);
    const afterReorder = chipOrder();
    const storedAfterReorder = JSON.parse(localStorage.getItem('siyuan-plugin-annotate:colors') || '{}');

    // 删除第一个预设
    const beforeRemove = chipCount();
    chips()[0]?.querySelector('[data-action="color-preset-remove"]')?.click();
    await wait(60);
    const afterRemove = chipCount();
    const storedAfterRemove = JSON.parse(localStorage.getItem('siyuan-plugin-annotate:colors') || '{}');

    // 截图前再存一个紫色，凑够三个色点，交付图看得更清楚
    await setHex('#7C3AED');
    q('[data-action="color-save"]').click();
    await wait(80);

    return {
        arrowOrder, arrowLabels, activeLabels, activeLabel,
        dashLabel, dashAttrs,
        barText, roundLabel, pressedBefore, pressedAfter, capBefore, capAfter, joinAfter,
        ballBefore, popOpen, afterPick, hueProbe,
        attrPopOpen: q('[data-role="attr-pop"]')?.hidden === false,
        savedChips, beforeReorder, afterReorder, stored,
        afterRemove, beforeRemove, storedAfterReorder, storedAfterRemove,
        custom: stored.custom,
    };
})()`);

check("真实浏览器：箭头下拉第一项是「基础」（顺序与名字都对）",
    v14.arrowOrder.join(",") === "basic,classic,modern,double,line,bar,barDouble" &&
    v14.arrowLabels[0] === "基础",
    `${v14.arrowLabels.join(" / ")}`);
check("真实浏览器：高亮的那一项与按钮上写的样式名一致（排序不影响默认值）",
    v14.activeLabels.length === 1 && v14.activeLabels[0] === v14.activeLabel,
    `${v14.activeLabels.join("/")} vs ${v14.activeLabel}`);
check("真实浏览器：顶部线型里有「中心线」，并真的写进矩形",
    v14.dashLabel.includes("中心线") &&
    v14.dashAttrs.pattern.split(/\s+/).length === 4 &&
    v14.dashAttrs.cap === "round",
    `${v14.dashLabel} / ${v14.dashAttrs.pattern} / ${v14.dashAttrs.cap}`);
check("真实浏览器：画线时悬浮条出现「圆线」开关，默认是圆头",
    v14.barText.includes("圆线") && v14.roundLabel === "圆线" &&
    v14.pressedBefore === "true" && v14.capBefore === "round",
    `${v14.barText} / ${v14.capBefore}`);
check("真实浏览器：关掉圆线后这条线当场变方头（join 也跟着变尖）",
    v14.pressedAfter === "false" && v14.capAfter === "butt" && v14.joinAfter === "miter",
    `${v14.capAfter} / ${v14.joinAfter}`);
check("真实浏览器：自定义颜色是一颗 22px 的圆球，未取色时是白底 + 十字",
    v14.ballBefore.isBall && v14.ballBefore.cross &&
    v14.ballBefore.size.w === 22 && v14.ballBefore.size.h === 22 &&
    v14.ballBefore.bg === "rgb(255, 255, 255)",
    JSON.stringify(v14.ballBefore));
check("真实浏览器：点圆球打开色轮弹窗（色环 + 三格读数 + HEX/RGB 开关），完整落在可视区内",
    v14.popOpen.hidden === false && v14.popOpen.hasWheel && v14.popOpen.readouts === 3 &&
    v14.popOpen.hasHex && v14.popOpen.hasRgb && v14.popOpen.hasSave && v14.popOpen.inViewport,
    JSON.stringify({...v14.popOpen, box: v14.popOpen.box}));
check("真实浏览器：色号框填 #1D4ED8 后球面变成该颜色，色轮同步、十字一直保留",
    v14.afterPick.bg === "rgb(29, 78, 216)" && v14.afterPick.cross === true &&
    v14.afterPick.ink === "#FFFFFF" && v14.afterPick.hexValue === "1D4ED8" &&
    v14.afterPick.wheelWidth === 236 && v14.afterPick.readouts.length === 3,
    JSON.stringify(v14.afterPick));
check("真实浏览器：拖色环换色相后，画布上的线跟着变色、圆球也更新",
    !!v14.hueProbe && v14.hueProbe.hex !== "1D4ED8" &&
    v14.hueProbe.stroke.toUpperCase() === `#${v14.hueProbe.hex.toUpperCase()}` &&
    (v14.hueProbe.ball || "").toUpperCase() === `#${v14.hueProbe.hex.toUpperCase()}`,
    JSON.stringify(v14.hueProbe));
check("真实浏览器：取到的颜色同时应用到选中对象（画布上的线当场变色）",
    v14.afterPick.strokeOfLastLine.toUpperCase() === "#1D4ED8",
    v14.afterPick.strokeOfLastLine);
check("真实浏览器：可以连续保存颜色预设，写进本地存储",
    v14.savedChips === 3 && (v14.stored.saved || []).length === 3,
    JSON.stringify(v14.stored));
check("真实浏览器：真实指针拖动可以给色点排序，顺序也落盘",
    v14.afterReorder.join(",") !== v14.beforeReorder.join(",") &&
    (v14.storedAfterReorder.saved || []).join(",") === v14.afterReorder.join(","),
    `${v14.beforeReorder.join(",")} → ${v14.afterReorder.join(",")}`);
check("真实浏览器：色点可以删除，删除结果也落盘",
    v14.afterRemove === v14.beforeRemove - 1 &&
    (v14.storedAfterRemove.saved || []).length === v14.afterRemove,
    `${v14.beforeRemove} → ${v14.afterRemove}`);

// 实拍：取色弹窗 + 顶部属性栏新档位
const popShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "颜色预设-弹窗.png"), Buffer.from(popShot.data, "base64"));
await evaluate(`document.querySelector('[data-action="color-pop-close"]')?.click()`);
await sleep(150);
const barShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "属性栏-新档位与点划线.png"), Buffer.from(barShot.data, "base64"));

// 实拍：点划线矩形 + 圆头 / 方头两根粗线（对照「圆线」开关）
// 注意：切换「圆线」在选中状态下会改这一支，所以每画一根都先取消选中再切，
// 否则两根线会一起变成方头，截图就看不出区别了。
await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const drag = (a, b) => { fire('pointerdown', at(a.x, a.y)); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const deselect = async () => {
        q('button[data-tool="select"]').click();
        fire('pointerdown', at(560, 90));
        fire('pointerup', at(560, 90));
        await wait(40);
    };
    const roundBtn = () => q('[data-role="context-bar"] [data-action="line-round"]');

    // 常态没有滑块：直接点对应的线宽档位
    const setWidth = (n) => {
        q('button[data-preset="lineWidth"][data-value="' + n + '"]')?.click();
    };
    q('button[data-tool="rect"]').click();
    q('button[data-preset="lineDash"][data-value="dashdot"]').click();
    drag({x: 90, y: 90}, {x: 330, y: 210});
    await deselect();
    q('button[data-preset="lineDash"][data-value="solid"]').click();

    q('button[data-tool="line"]').click();
    setWidth(14);
    if (roundBtn()?.getAttribute('aria-pressed') !== 'true') roundBtn()?.click();
    await wait(60);
    drag({x: 110, y: 265}, {x: 330, y: 265});
    await deselect();
    q('button[data-tool="line"]').click();
    if (roundBtn()?.getAttribute('aria-pressed') === 'true') roundBtn()?.click();
    await wait(60);
    drag({x: 110, y: 330}, {x: 330, y: 330});
    await deselect();
    await wait(80);
})()`);
await sleep(200);
const dashShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "点划线与线端对照.png"), Buffer.from(dashShot.data, "base64"));

// 实拍像素：圆头线在端点外侧 4px 处应当已经是实色（半圆突出），
// 方头线同一位置还是底色——这是「圆线」开关真的生效的直接证据
const capPoints = await evaluate(`(() => {
    const gs = Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'))
        .filter((g) => g.querySelector('path.annot-shape'))
        .slice(-2);
    return gs.map((g) => {
        const path = g.querySelector('path.annot-shape');
        const r = path.getBoundingClientRect();
        return {
            cap: path.getAttribute('stroke-linecap'),
            inside: {x: r.left - 4, y: r.top},
            outside: {x: r.left - 9, y: r.top},
        };
    });
})()`);
const capPixels = await evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${dashShot.data}";
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const points = ${JSON.stringify(capPoints)};
    return points.map((p) => ({
        cap: p.cap,
        inside: Array.from(ctx.getImageData(Math.round(p.inside.x), Math.round(p.inside.y), 1, 1).data),
        outside: Array.from(ctx.getImageData(Math.round(p.outside.x), Math.round(p.outside.y), 1, 1).data),
    }));
})()`);
const isInk = (px) => px[0] < 200 && px[2] > 100 && px[2] - px[1] > 20;
const roundPx = capPixels.find((p) => p.cap === "round");
const buttPx = capPixels.find((p) => p.cap === "butt");
check("真实浏览器实拍：圆头线端点外侧 4px 已是实色（半圆真的画出来了）",
    !!roundPx && isInk(roundPx.inside) && !isInk(roundPx.outside),
    JSON.stringify(capPixels));
check("真实浏览器实拍：方头线端点外侧同一位置是底色（平齐截断，与圆头形成对照）",
    !!buttPx && !isInk(buttPx.inside) && !isInk(buttPx.outside),
    JSON.stringify(capPixels));

// ---- 2.75) v0.15.0：悬浮条基座（选择 / 平移）+ 序号专属参数 ----
const v15 = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const bar = q('[data-role="context-bar"]');
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const drag = (a, b) => { fire('pointerdown', at(a.x, a.y)); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const last = () => groups()[groups().length - 1];

    // 0) 选择工具 + 没选中对象：悬浮条只有两颗按钮，没有分割线
    q('button[data-tool="select"]').click();
    await wait(60);
    fire('pointerdown', at(20, 20));
    fire('pointerup', at(20, 20));
    await wait(60);
    const sepInSelect = bar.querySelectorAll('.annot-context__sep').length;
    const kidsInSelect = bar.children.length;

    // 1) 基座：两个按钮、顺序、图形
    const baseButtons = Array.from(bar.querySelectorAll('.annot-context__base button[data-tool]'));
    const base = {
        order: baseButtons.map((b) => b.getAttribute('data-tool')).join(','),
        first: bar.firstElementChild?.className || '',
        visible: bar.hidden === false,
        beforeParams: bar.firstElementChild?.contains(baseButtons[0]),
    };
    const selIcon = bar.querySelector('[data-tool="select"] svg');
    const selPath = selIcon?.querySelector('path');
    const panIcon = bar.querySelector('[data-tool="pan"] svg');
    const panPath = panIcon?.querySelector('path');
    const icons = {
        selectViewBox: selIcon?.getAttribute('viewBox') || '',
        selectFill: selPath ? getComputedStyle(selPath).fill : 'missing',
        selectStroke: selPath ? getComputedStyle(selPath).stroke : 'missing',
        selectBox: (() => { const r = selIcon.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; })(),
        panViewBox: panIcon?.getAttribute('viewBox') || '',
        panFill: panPath ? getComputedStyle(panPath).fill : 'missing',
        panBox: (() => { const r = panIcon.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; })(),
    };
    const barRect = bar.getBoundingClientRect();
    const stageRect = q('.annot-stage').getBoundingClientRect();
    const centered = Math.abs((barRect.left + barRect.right) / 2 - (stageRect.left + stageRect.right) / 2) < 2;

    // 2) 平移：拖 80/50，画面跟着走，对象数量不变
    const before = {
        objects: groups().length,
        transform: q('[data-role="transform"]').style.transform,
    };
    bar.querySelector('[data-tool="pan"]').click();
    await wait(80);
    const panActive = bar.querySelector('[data-tool="pan"]').classList.contains('is-active');
    const panSep = bar.querySelectorAll('.annot-context__sep').length;
    const panKids = bar.children.length;
    const cursor = getComputedStyle(svg).cursor;
    fire('pointerdown', at(600, 400));
    fire('pointermove', at(680, 450));
    fire('pointerup', at(680, 450));
    await wait(80);
    const after = {
        objects: groups().length,
        transform: q('[data-role="transform"]').style.transform,
    };

    // 3) 序号：专属参数 + 格式 + 端点
    q('button[data-tool="number"]').click();
    await wait(80);
    const numberBar = {
        formats: Array.from(bar.querySelectorAll('[data-action="number-format-pick"]')).map((b) => b.getAttribute('data-value')),
        styles: Array.from(bar.querySelectorAll('[data-action="number-style-pick"]')).map((b) => b.getAttribute('data-value')),
        tips: Array.from(bar.querySelectorAll('[data-action="number-tip"]')).map((b) => b.getAttribute('data-value')),
        rounded: !!bar.querySelector('[data-action="arrow-rounded"]'),
        sep: bar.querySelectorAll('.annot-context__sep').length,
        barH: Math.round(bar.getBoundingClientRect().height),
        formatLabel: (bar.querySelector('[data-action="number-format-toggle"] .annot-arrow-picker__label')?.textContent || '').trim(),
        legacyChips: bar.querySelectorAll('[data-action="number-format"]').length,
        // 基座必须是第一个子元素，编号参数必须排在它后面（悬浮条会重建，按当前 DOM 算）
        paramsRightOfBase: (() => {
            const kids = Array.from(bar.children);
            const baseIndex = kids.findIndex((el) => el.classList.contains("annot-context__base"));
            const paramIndex = kids.findIndex((el) => el.querySelector('[data-action="number-format-toggle"]'));
            return baseIndex === 0 && paramIndex > baseIndex;
        })(),
    };
    const pickFormat = async (value) => {
        q('[data-action="number-format-toggle"]').click();
        await wait(50);
        const open = bar.querySelector('[data-role="number-format-picker"]').classList.contains('is-open');
        q('[data-action="number-format-pick"][data-value="' + value + '"]').click();
        await wait(50);
        return open;
    };
    const formatLabel = () => (bar.querySelector('[data-action="number-format-toggle"] .annot-arrow-picker__label')?.textContent || '').trim();
    const drop = async (x, y) => { fire('pointerdown', at(x, y)); fire('pointerup', at(x, y)); await wait(40); };
    const lastText = () => last()?.querySelector('text.annot-shape')?.textContent || '';
    const formatMenuOpened = await pickFormat('roman');
    const romanLabel = formatLabel();
    await drop(120, 300);
    await drop(220, 300);
    const romanTexts = Array.from(groups()).slice(-2).map((g) => g.querySelector('text.annot-shape')?.textContent);
    await pickFormat('chinese');
    await drop(320, 300);
    const chineseText = lastText();
    await pickFormat('alphaUpper');
    const alphaLabel = formatLabel();
    await drop(420, 300);
    const alphaText = lastText();

    // 圆点 / 方点端点（带引线）
    q('[data-action="number-tip"][data-value="dot"]').click();
    await wait(60);
    const roundedHidden = !bar.querySelector('[data-action="arrow-rounded"]');
    fire('pointerdown', at(120, 420));
    fire('pointermove', at(180, 460));
    fire('pointerup', at(240, 500));
    await wait(60);
    const dotMark = {
        circle: !!last()?.querySelector('circle.annot-head'),
        path: !!last()?.querySelector('path.annot-head'),
    };
    q('[data-action="number-tip"][data-value="square"]').click();
    fire('pointerdown', at(320, 420));
    fire('pointermove', at(380, 460));
    fire('pointerup', at(440, 500));
    await wait(60);
    const squareMark = {
        rect: !!last()?.querySelector('rect.annot-head'),
        circle: !!last()?.querySelector('circle.annot-head'),
    };

    // 4) 箭头端点：与箭头工具同一条路径（同起点同终点）
    q('[data-action="number-tip"][data-value="arrow"]').click();
    q('button[data-tool="arrow"]').click();
    q('[data-action="arrow-picker-toggle"]').click();
    q('.annot-arrow-picker__item[data-value="classic"]').click();
    await wait(60);
    fire('pointerdown', at(760, 300));
    fire('pointermove', at(820, 300));
    fire('pointerup', at(880, 300));
    await wait(60);
    const arrowHead = last()?.querySelector('path.annot-head')?.getAttribute('d') || '';
    const arrowWidth = last()?.querySelector('path.annot-head')?.getAttribute('stroke-width') || '';
    q('button[data-tool="number"]').click();
    fire('pointerdown', at(760, 300));
    fire('pointermove', at(820, 300));
    fire('pointerup', at(880, 300));
    await wait(60);
    const numberHead = last()?.querySelector('path.annot-head')?.getAttribute('d') || '';
    const numberWidth = last()?.querySelector('path.annot-head')?.getAttribute('stroke-width') || '';
    const hasPolygon = !!last()?.querySelector('polygon');

    // 5) 引线的箭头样式下拉：换成「双头」当场生效
    const headCount = () => last()?.querySelectorAll('path.annot-head').length ?? 0;
    const headsBefore = headCount();
    q('[data-action="number-style-toggle"]').click();
    await wait(50);
    const styleMenuOpened = bar.querySelector('[data-role="number-style-picker"]').classList.contains('is-open');
    q('[data-action="number-style-pick"][data-value="double"]').click();
    await wait(60);
    const headsDouble = headCount();
    const styleLabel = (bar.querySelector('[data-role="number-style-label"]')?.textContent || '').trim();
    q('[data-action="number-style-toggle"]').click();
    await wait(50);
    q('[data-action="number-style-pick"][data-value="classic"]').click();
    await wait(60);
    const headsBack = headCount();

    return {
        base, icons, centered, sepInSelect, kidsInSelect, panActive, panSep, panKids, cursor,
        before, after, numberBar, formatMenuOpened, romanLabel, alphaLabel,
        romanTexts, chineseText, alphaText, roundedHidden, dotMark, squareMark,
        arrowHead, numberHead, arrowWidth, numberWidth, hasPolygon,
        styleMenuOpened, headsBefore, headsDouble, styleLabel, headsBack,
    };
})()`);

check("真实浏览器：悬浮条最左侧是「选择」+「平移」两个常驻按钮",
    v15.base.visible && v15.base.order === "select,pan" &&
    v15.base.first.includes("annot-context__base") && v15.base.beforeParams,
    JSON.stringify(v15.base));
check("真实浏览器：悬浮条整条居中在画布上方",
    v15.centered === true);
check("真实浏览器：选择是空心指针（fill=none、描边跟随主题）",
    v15.icons.selectViewBox === "0 0 48 48" && v15.icons.selectFill === "none" &&
    v15.icons.selectStroke !== "none",
    JSON.stringify(v15.icons));
check("真实浏览器：平移是实心手型（1024 视图、fill 未被样式清成 none）",
    v15.icons.panViewBox === "0 0 1024 1024" && v15.icons.panFill !== "none" &&
    v15.icons.panFill !== "missing" && v15.icons.panBox.w === 19,
    JSON.stringify({fill: v15.icons.panFill, box: v15.icons.panBox}));
check("真实浏览器：选择工具且没选中对象时，悬浮条只有两颗按钮（无分割线）",
    v15.sepInSelect === 0 && v15.kidsInSelect === 1,
    `分割线 ${v15.sepInSelect} 条 / ${v15.kidsInSelect} 个子元素`);
check("真实浏览器：点「平移」后按钮高亮、画布显示抓手，悬浮条同样只剩两颗按钮",
    v15.panActive && v15.panSep === 0 && v15.panKids === 1 && v15.cursor === "grab",
    `${v15.panSep} 条分割线 / ${v15.panKids} 个子元素 / ${v15.cursor}`);
check("真实浏览器：按住拖动 80/50 像素，整张画布跟着平移",
    v15.after.transform !== v15.before.transform && v15.after.objects === v15.before.objects,
    `${v15.before.transform} → ${v15.after.transform}`);
check("真实浏览器：序号工具有参数时分割线才出现",
    v15.numberBar.sep === 1, String(v15.numberBar.sep));
check("真实浏览器：序号参数再多也排成一行（不会因为 left:50% 提前折行）",
    v15.numberBar.barH <= 48, `${v15.numberBar.barH}px 高`);
check("真实浏览器：编号格式是下拉框（5 个选项、无旧小按钮），默认显示「阿拉伯数字」",
    v15.numberBar.formats.join(",") === "arabic,roman,alphaLower,alphaUpper,chinese" &&
    v15.numberBar.legacyChips === 0 && v15.numberBar.formatLabel === "阿拉伯数字",
    `${v15.numberBar.formats.join(",")} / 旧按钮 ${v15.numberBar.legacyChips} 个 / ${v15.numberBar.formatLabel}`);
check("真实浏览器：端点 3 项，箭头样式下拉 7 项，均排在平移按钮右侧",
    v15.numberBar.tips.join(",") === "arrow,dot,square" &&
    v15.numberBar.styles.join(",") === "basic,classic,modern,double,line,bar,barDouble" &&
    v15.numberBar.paramsRightOfBase,
    JSON.stringify(v15.numberBar));
check("真实浏览器：点编号格式按钮真的展开菜单，选完按钮上的字跟着变",
    v15.formatMenuOpened === true && v15.romanLabel === "罗马数字" && v15.alphaLabel === "大写字母",
    `${v15.formatMenuOpened} / ${v15.romanLabel} / ${v15.alphaLabel}`);
check("真实浏览器：罗马数字与中文数字真的显示成对应格式",
    v15.romanTexts.every((t) => /^[IVX]+$/.test(t || "")) && /^[一二三四五六七八九十]+$/.test(v15.chineseText),
    `${v15.romanTexts.join("/")} · ${v15.chineseText}`);
check("真实浏览器：大写字母格式生效",
    /^[A-Z]+$/.test(v15.alphaText), v15.alphaText);
check("真实浏览器：切到圆点端点后「圆线」开关消失，末端是圆点",
    v15.roundedHidden && v15.dotMark.circle && !v15.dotMark.path, JSON.stringify(v15.dotMark));
check("真实浏览器：方点端点末端是方块",
    v15.squareMark.rect && !v15.squareMark.circle, JSON.stringify(v15.squareMark));
check("真实浏览器：序号引线的箭头与箭头工具一字不差（同起点同终点）",
    !!v15.arrowHead && v15.arrowHead === v15.numberHead,
    `${v15.arrowHead.slice(0, 26)} | ${v15.numberHead.slice(0, 26)}`);
check("真实浏览器：序号引线头部按线宽描边，也没有自拼的多边形残留",
    v15.numberWidth === v15.arrowWidth && !v15.hasPolygon,
    `${v15.arrowWidth} / ${v15.numberWidth}`);
check("真实浏览器：引线箭头样式的下拉能展开，选「双头」当场变两个头部，再换回经典",
    v15.styleMenuOpened === true && v15.headsBefore === 1 && v15.headsDouble === 2 &&
    v15.styleLabel === "双头" && v15.headsBack === 1,
    `${v15.headsBefore} → ${v15.headsDouble} → ${v15.headsBack} · ${v15.styleLabel}`);

// ---- 2.8) v0.18.0：聚光灯 / 放大镜 ----
const v18 = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const bar = q('[data-role="context-bar"]');
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    // 真实的按下要落在「这一点的元素」上：手柄、命中框、锚点都在 SVG 里，
    // 一律派发给 svg 的话 e.target 永远是 svg，永远命中不到对象
    const press = (a) => {
        const pt = at(a.x, a.y);
        const el = document.elementFromPoint(pt.clientX, pt.clientY) || svg;
        el.dispatchEvent(new MouseEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, clientX: pt.clientX, clientY: pt.clientY,
        }));
    };
    const drag = (a, b) => { press(a); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const last = () => groups()[groups().length - 1];
    // 聚光灯的遮罩远大于画布，量 group 的屏幕框没有意义；这里读命中框（= 亮区）的几何
    const spotBox = () => {
        const r = last()?.querySelector('rect[data-role="hit"]');
        return r ? {x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')),
            w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height'))} : null;
    };

    // 0) 工具入口与图标
    const spotBtn = q('button[data-tool="spotlight"]');
    const magBtn = q('button[data-tool="magnifier"]');
    const spotPath = spotBtn?.querySelector('svg path');
    const tools = {
        spotIcon: spotBtn?.querySelector('svg')?.getAttribute('viewBox') || '',
        spotPaths: spotBtn?.querySelectorAll('svg path').length ?? 0,
        spotFill: spotPath ? getComputedStyle(spotPath).fill : '',
        spotStroke: spotPath ? getComputedStyle(spotPath).stroke : '',
        magIcon: magBtn?.querySelector('svg')?.getAttribute('viewBox') || '',
        magPaths: magBtn?.querySelectorAll('svg path').length ?? 0,
        magStroke: magBtn?.querySelector('svg')?.getAttribute('stroke') || '',
    };

    // 1) 聚光灯：拖一个区域
    q('button[data-tool="spotlight"]').click();
    await wait(60);
    drag({x: 120, y: 120}, {x: 460, y: 340});
    await wait(120);
    const spot = last();
    const spotMask = spot?.querySelector('path.annot-shape');
    const spot1 = {
        type: spot?.getAttribute('data-object-id') ? 'ok' : 'missing',
        maskD: spotMask?.getAttribute('d') || '',
        fillRule: spotMask?.getAttribute('fill-rule') || '',
        fill: spotMask?.getAttribute('fill') || '',
        barDark: (bar.querySelector('[data-ctx="spotlightOpacity"]')?.value ?? ''),
        shapes: Array.from(bar.querySelectorAll('[data-action="spotlight-shape"]')).map((b) => b.getAttribute('data-value')).join(','),
        activeShape: bar.querySelector('[data-action="spotlight-shape"].is-active')?.getAttribute('data-value') || '',
    };

    // 2) 拖框挪位置
    const spotBefore = spotBox();
    drag({x: 300, y: 230}, {x: 360, y: 290});
    await wait(80);
    const spotAfter = spotBox();

    // 3) 拖角点改大小
    const handle = document.querySelector('[data-handle="resize:se"]');
    const handlePt = handle ? {x: hh(handle), y: vv(handle)} : null;
    function hh(el) { const b = el.getBoundingClientRect(); return (b.left + b.width / 2 - rect.left) * w / rect.width; }
    function vv(el) { const b = el.getBoundingClientRect(); return (b.top + b.height / 2 - rect.top) * h / rect.height; }
    let spotResized = null;
    if (handlePt) {
        drag({x: handlePt.x, y: handlePt.y}, {x: handlePt.x + 90, y: handlePt.y + 60});
        await wait(80);
        spotResized = spotBox();
    }

    // 4) 切形状
    q('[data-action="spotlight-shape"][data-value="ellipse"]').click();
    await wait(80);
    const ellipseD = last()?.querySelector('path.annot-shape')?.getAttribute('d') || '';
    q('[data-action="spotlight-shape"][data-value="rect"]').click();
    await wait(80);
    const rectD = last()?.querySelector('path.annot-shape')?.getAttribute('d') || '';

    // 5) 暗度滑杆
    const slider = q('[data-ctx="spotlightOpacity"]');
    slider.value = '80';
    slider.dispatchEvent(new Event('input', {bubbles: true}));
    await wait(80);
    const darkFill = last()?.querySelector('path.annot-shape')?.getAttribute('fill') || '';
    const badge = q('[data-role="ctx-spotlightOpacity"]')?.textContent || '';

    // 6) 放大镜：拖出显示框
    q('button[data-tool="magnifier"]').click();
    await wait(60);
    drag({x: 640, y: 120}, {x: 860, y: 340});
    await wait(200);
    const lens = last();
    const mag1 = {
        image: (lens?.querySelector('image')?.getAttribute('href') || '').slice(0, 22),
        hasClip: !!lens?.querySelector('clipPath'),
        border: !!lens?.querySelector('ellipse[stroke], rect[stroke]'),
        anchorDots: lens?.querySelectorAll('circle').length ?? 0,
        line: !!lens?.querySelector('line'),
        barZooms: Array.from(bar.querySelectorAll('[data-action="magnifier-zoom"]')).map((b) => b.getAttribute('data-value')).join(','),
        activeZoom: bar.querySelector('[data-action="magnifier-zoom"].is-active')?.getAttribute('data-value') || '',
        shapes: Array.from(bar.querySelectorAll('[data-action="magnifier-shape"]')).map((b) => b.getAttribute('data-value')).join(','),
        activeShape: bar.querySelector('[data-action="magnifier-shape"].is-active')?.getAttribute('data-value') || '',
    };
    const anchorAttr = () => {
        const circles = Array.from(last()?.querySelectorAll('circle') || []);
        const dot = circles[circles.length - 1];
        return dot ? {cx: Number(dot.getAttribute('cx')), cy: Number(dot.getAttribute('cy'))} : null;
    };
    const lensBox = () => {
        const img = last()?.querySelector('image');
        return img ? {x: Number(img.getAttribute('x')), y: Number(img.getAttribute('y')),
            w: Number(img.getAttribute('width')), h: Number(img.getAttribute('height'))} : null;
    };
    const magA0 = anchorAttr();
    const magL0 = lensBox();

    // 7) 拖锚点：镜框不动、内容重采
    const magImg0 = last()?.querySelector('image')?.getAttribute('href') || '';
    drag({x: magA0.cx, y: magA0.cy}, {x: magA0.cx - 150, y: magA0.cy + 120});
    await wait(160);
    const magA1 = anchorAttr();
    const magL1 = lensBox();
    const magImg1 = last()?.querySelector('image')?.getAttribute('href') || '';

    // 8) 拖镜框：锚点不动、连线跟随
    drag({x: magL1.x + magL1.w / 2, y: magL1.y + magL1.h / 2}, {x: magL1.x + magL1.w / 2 + 60, y: magL1.y + magL1.h / 2 + 40});
    await wait(160);
    const magA2 = anchorAttr();
    const magL2 = lensBox();
    const line2 = last()?.querySelector('line');
    const magLine = line2 ? {
        x1: Number(line2.getAttribute('x1')), y1: Number(line2.getAttribute('y1')),
        x2: Number(line2.getAttribute('x2')), y2: Number(line2.getAttribute('y2')),
    } : null;

    // 9) 倍数/形状切换
    q('[data-action="magnifier-zoom"][data-value="3"]').click();
    await wait(160);
    const magImg3 = last()?.querySelector('image')?.getAttribute('href') || '';
    const activeZoom3 = bar.querySelector('[data-action="magnifier-zoom"].is-active')?.getAttribute('data-value') || '';
    q('[data-action="magnifier-shape"][data-value="rect"]').click();
    await wait(120);
    const rectLens = !!last()?.querySelector('rect[stroke]');
    const ellipseLens = !!last()?.querySelector('ellipse[stroke]');

    return {
        tools, spot1, spotBefore, spotAfter, spotResized, ellipseD, rectD, darkFill, badge,
        mag1, magA0, magA1, magA2, magL0, magL1, magL2, magLine,
        magImgChanged: magImg0 !== magImg1, magZoomChanged: magImg1 !== magImg3,
        activeZoom3, rectLens, ellipseLens,
    };
})()`);

check("真实浏览器：左侧工具栏出现聚光灯与放大镜，聚光灯为单段实心原稿、放大镜为四段描边",
    v18.tools.spotIcon === "0 0 1024 1024" && v18.tools.spotPaths === 1 &&
    v18.tools.spotStroke === "none" && v18.tools.spotFill !== "none" &&
    v18.tools.magIcon === "0 0 48 48" && v18.tools.magPaths === 4 &&
    v18.tools.magStroke === "currentColor",
    JSON.stringify(v18.tools));
check("真实浏览器：拖出聚光灯后，四周压暗、中间留亮（evenodd 挖洞）",
    v18.spot1.maskD.includes("M-20000") && v18.spot1.fillRule === "evenodd" &&
    v18.spot1.fill.startsWith("rgba(0, 0, 0"),
    v18.spot1.fill);
check("真实浏览器：聚光灯悬浮条有暗度滑杆与两种形状，默认矩形",
    v18.spot1.barDark === "60" && v18.spot1.shapes === "rect,ellipse" &&
    v18.spot1.activeShape === "rect",
    JSON.stringify(v18.spot1));
check("真实浏览器：拖聚光灯本体可以挪位置",
    Math.abs(v18.spotAfter.x - v18.spotBefore.x - 60) < 4 &&
    Math.abs(v18.spotAfter.y - v18.spotBefore.y - 60) < 4,
    `${JSON.stringify(v18.spotBefore)} → ${JSON.stringify(v18.spotAfter)}`);
check("真实浏览器：拖角点能把聚光灯拉大",
    !!v18.spotResized && v18.spotResized.w > v18.spotAfter.w + 60 &&
    v18.spotResized.h > v18.spotAfter.h + 40,
    JSON.stringify(v18.spotResized));
check("真实浏览器：把聚光灯切成椭圆后，洞口变成椭圆弧，切回矩形又变直边",
    v18.ellipseD.includes("a") && !v18.rectD.includes("a"),
    `${v18.ellipseD.slice(-40)} | ${v18.rectD.slice(-40)}`);
check("真实浏览器：暗度滑杆真的改遮罩颜色，读数也跟着变",
    v18.darkFill.includes("0.8") && v18.badge.trim() === "80%",
    `${v18.darkFill} / ${v18.badge}`);
check("真实浏览器：放大镜包含镜片、镜框、锚点与连线",
    v18.mag1.image.startsWith("data:image/png") && v18.mag1.hasClip && v18.mag1.border &&
    v18.mag1.anchorDots >= 2 && v18.mag1.line,
    JSON.stringify(v18.mag1));
check("真实浏览器：放大镜悬浮条有 4 档倍数与两种形状，默认 2x 圆形",
    v18.mag1.barZooms === "1.5,2,3,4" && v18.mag1.activeZoom === "2" &&
    v18.mag1.shapes === "ellipse,rect" && v18.mag1.activeShape === "ellipse",
    JSON.stringify(v18.mag1));
check("真实浏览器：新建放大镜时锚点在镜框外（点与连线一眼可见）",
    v18.magA0.cx < v18.magL0.x || v18.magA0.cy < v18.magL0.y ||
    v18.magA0.cx > v18.magL0.x + v18.magL0.w || v18.magA0.cy > v18.magL0.y + v18.magL0.h,
    `anchor=${JSON.stringify(v18.magA0)} lens=${JSON.stringify(v18.magL0)}`);
check("真实浏览器：拖锚点只换「看哪儿」——镜框一点没动，锚点跟手走了",
    Math.abs(v18.magL1.x - v18.magL0.x) < 1 && Math.abs(v18.magL1.y - v18.magL0.y) < 1 &&
    Math.abs(v18.magA1.cx - v18.magA0.cx) > 100 &&
    Math.abs(v18.magA1.cx - (v18.magA0.cx - 150)) < 2,
    `lens ${JSON.stringify(v18.magL0)} → ${JSON.stringify(v18.magL1)} anchor ${v18.magA1.cx},${v18.magA1.cy}`);
check("真实浏览器：拖镜框只挪框——锚点不动、连线两端仍分别连着锚点与镜框",
    Math.abs(v18.magA2.cx - v18.magA1.cx) < 1 && Math.abs(v18.magA2.cy - v18.magA1.cy) < 1 &&
    Math.abs(v18.magL2.x - v18.magL1.x - 60) < 4 &&
    !!v18.magLine &&
    Math.abs(v18.magLine.x1 - v18.magA2.cx) < 1 && Math.abs(v18.magLine.y1 - v18.magA2.cy) < 1 &&
    Math.abs(v18.magLine.x2 - (v18.magL2.x + v18.magL2.w / 2)) < 1 &&
    Math.abs(v18.magLine.y2 - (v18.magL2.y + v18.magL2.h / 2)) < 1,
    `anchor ${JSON.stringify(v18.magA2)} lens ${JSON.stringify(v18.magL2)} line ${JSON.stringify(v18.magLine)}`);
check("真实浏览器：倍数能切到 3x，形状能切成矩形",
    v18.activeZoom3 === "3" && v18.rectLens && !v18.ellipseLens,
    `${v18.activeZoom3} / ${v18.rectLens}`);

// ---- 2.85) v0.18.1：聚光灯镂空图标 / 遮罩黑白 / 放大镜 Shift 约束 ----
const v181 = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const bar = q('[data-role="context-bar"]');
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, shift = false) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, shiftKey: shift,
        clientX: p.clientX, clientY: p.clientY,
    }));
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const last = () => groups()[groups().length - 1];

    // 1) 聚光灯图标：必须是镂空描边，不能有实心填充
    const spotSvg = q('button[data-tool="spotlight"] svg');
    const spotPaths = Array.from(spotSvg?.querySelectorAll('path') || []);
    const icon = {
        viewBox: spotSvg?.getAttribute('viewBox') || '',
        count: spotPaths.length,
        fills: spotPaths.map((el) => getComputedStyle(el).fill),
        strokes: spotPaths.map((el) => getComputedStyle(el).stroke),
        widths: spotPaths.map((el) => el.getAttribute('stroke-width')),
        svgStrokeWidth: getComputedStyle(spotSvg).strokeWidth,
    };

    // 2) 遮罩颜色：黑 → 白 → 黑
    q('button[data-tool="spotlight"]').click();
    await wait(60);
    fire('pointerdown', at(160, 150));
    fire('pointermove', at(520, 380));
    fire('pointerup', at(520, 380));
    await wait(150);
    const maskFill = () => last()?.querySelector('path.annot-shape')?.getAttribute('fill') || '';
    const chipValues = Array.from(bar.querySelectorAll('[data-action="spotlight-color"]'))
        .map((el) => el.getAttribute('data-value') + ':' + el.classList.contains('is-active'));
    const blackFill = maskFill();
    q('[data-action="spotlight-color"][data-value="white"]').click();
    await wait(150);
    const whiteFill = maskFill();
    const whiteActive = bar.querySelector('[data-action="spotlight-color"].is-active')?.getAttribute('data-value') || '';
    q('[data-action="spotlight-color"][data-value="black"]').click();
    await wait(120);
    const backFill = maskFill();

    // 3) Shift 拖拽：起点 (620,520) → 终点 (860,650)，X 240 / Y 130，应当变成 240×240
    q('button[data-tool="magnifier"]').click();
    await wait(60);
    q('[data-action="magnifier-shape"][data-value="ellipse"]')?.click();
    await wait(50);
    fire('pointerdown', at(620, 520), true);
    fire('pointermove', at(860, 650), true);
    fire('pointerup', at(860, 650), true);
    await wait(220);
    const shiftLens = last()?.querySelector('ellipse.annot-shape');
    const shiftBox = shiftLens
        ? {rx: Number(shiftLens.getAttribute('rx')), ry: Number(shiftLens.getAttribute('ry'))}
        : null;

    // 4) 拖到一半才按 Shift：鼠标不动也要立刻变正方形，松开立刻还原
    q('button[data-tool="magnifier"]').click();
    await wait(60);
    fire('pointerdown', at(300, 620));
    fire('pointermove', at(520, 740));
    await wait(60);
    const previewBox = () => {
        const g = document.querySelector('g.is-preview');
        const el = g?.querySelector('ellipse.annot-shape') || g?.querySelector('rect.annot-shape');
        if (!el) return null;
        return el.tagName === 'ellipse'
            ? {w: Number(el.getAttribute('rx')) * 2, h: Number(el.getAttribute('ry')) * 2}
            : {w: Number(el.getAttribute('width')), h: Number(el.getAttribute('height'))};
    };
    const freeBox = previewBox();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Shift', bubbles: true}));
    await wait(90);
    const heldBox = previewBox();
    document.dispatchEvent(new KeyboardEvent('keyup', {key: 'Shift', bubbles: true}));
    await wait(90);
    const releasedBox = previewBox();
    fire('pointerup', at(520, 740));
    await wait(150);
    const committed = last()?.querySelector('ellipse.annot-shape');
    const committedBox = committed
        ? {w: Number(committed.getAttribute('rx')) * 2, h: Number(committed.getAttribute('ry')) * 2}
        : null;

    return {
        icon, chipValues, blackFill, whiteFill, whiteActive, backFill,
        shiftBox, freeBox, heldBox, releasedBox, committedBox,
    };
})()`);

check("真实浏览器：聚光灯图标是单段实心原稿（fill 跟随主题、不描边）",
    v181.icon.viewBox === "0 0 1024 1024" && v181.icon.count === 1 &&
    v181.icon.fills.every((v) => v !== "none" && v !== "") &&
    v181.icon.strokes.every((v) => v === "none"),
    JSON.stringify(v181.icon));
check("真实浏览器：聚光灯悬浮条有「黑色 / 白色」两颗按钮，默认黑色高亮",
    v181.chipValues.join(",") === "black:true,white:false" &&
    v181.blackFill.startsWith("rgba(0, 0, 0"),
    JSON.stringify({chips: v181.chipValues, fill: v181.blackFill}));
check("真实浏览器：点「白色」后遮罩当场变半透明白，高亮跟过去",
    v181.whiteFill.startsWith("rgba(255, 255, 255") && v181.whiteActive === "white",
    `${v181.whiteFill} / ${v181.whiteActive}`);
check("真实浏览器：点回「黑色」后遮罩恢复压暗",
    v181.backFill.startsWith("rgba(0, 0, 0"), v181.backFill);
check("真实浏览器：放大镜按住 Shift 拖出 240×130，得到 240×240 的正圆镜片",
    !!v181.shiftBox && Math.abs(v181.shiftBox.rx - 120) < 0.6 &&
    Math.abs(v181.shiftBox.ry - 120) < 0.6,
    JSON.stringify(v181.shiftBox));
check("真实浏览器：拖拽中途按 Shift，鼠标没动预览也立刻变正方形",
    Math.abs(v181.freeBox.w - v181.freeBox.h) > 60 &&
    Math.abs(v181.heldBox.w - v181.heldBox.h) < 0.6 &&
    Math.abs(v181.heldBox.w - v181.freeBox.w) < 1.5,
    `${JSON.stringify(v181.freeBox)} → ${JSON.stringify(v181.heldBox)}`);
check("真实浏览器：松开 Shift 立刻回到自由比例，松手后留下的也是自由比例",
    Math.abs(v181.releasedBox.w - v181.releasedBox.h) > 60 &&
    Math.abs(v181.committedBox.w - v181.committedBox.h) > 60,
    `${JSON.stringify(v181.releasedBox)} / ${JSON.stringify(v181.committedBox)}`);
// ---- 2.9) 自定义预设：点哪一档，小窗只改那一档 ----
const v19 = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const drag = (a, b) => { fire('pointerdown', at(a.x, a.y)); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const groups = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const last = () => groups()[groups().length - 1];
    const shapeOf = () => last()?.querySelector('rect.annot-shape');
    const pop = () => q('[data-role="attr-pop"]');
    const slot = (role, i) => q('[data-role="' + role + '"] [data-index="' + i + '"]');
    const head = () => (pop()?.querySelector('.annot-attr-panel__head')?.textContent || '').trim();
    const openSlot = async (role, i) => { slot(role, i).click(); await wait(120); };
    const setInput = (el, value) => {
        el.value = String(value);
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
    };
    const presets = () => JSON.parse(localStorage.getItem('siyuan-plugin-annotate:presets') || '{}');
    const dots = () => Array.from(document.querySelectorAll('[data-role="group-colors"] [data-preset="color"]'))
        .map((el) => el.getAttribute('data-value'));

    // 0) 常态点档位：直接生效，没有小窗
    q('button[data-preset="lineWidth"][data-index="1"]').click();
    await wait(80);
    const normalNoPop = pop().hidden === true;

    // 1) 进入编辑模式
    q('[data-action="settings"]').click();
    await wait(120);
    const enterEdit = {editing: q('.annot-root').classList.contains('is-preset-edit'),
        three: !!q('[data-action="preset-cancel"]') && !!q('[data-action="preset-apply"]') &&
            !!q('[data-action="preset-reset"]')};

    // 2) 第 2 档线宽：小窗贴在它正下方，且只含一个滑块
    await openSlot('group-widths', 1);
    const box = slot('group-widths', 1).getBoundingClientRect();
    const pr = pop().getBoundingClientRect();
    const layout = {
        open: pop().hidden === false,
        title: head(),
        onlyWidth: !!pop().querySelector('[data-range="lineWidth"]') && !pop().querySelector('[data-range="fontSize"]'),
        marked: slot('group-widths', 1).classList.contains('is-editing-slot'),
        heights: Array.from(document.querySelectorAll('.annot-toolbar .annot-group'))
            .map((el) => Math.round(el.getBoundingClientRect().height)),
        slotHeight: Math.round(q('[data-role="preset-slot"]').getBoundingClientRect().height),
        hasAttrLabel: !!q('.annot-toolbar__label'),
        labels: Array.from(document.querySelectorAll('.annot-toolbar .annot-group__label'))
            .map((el) => el.textContent.trim()).join(','),
        insideRoot: (() => {
            const rb = q('.annot-root').getBoundingClientRect();
            return pr.left >= rb.left - 0.5 && pr.right <= rb.right + 0.5 &&
                pr.top >= rb.top - 0.5 && pr.bottom <= rb.bottom + 0.5;
        })(),
        below: pr.top >= box.bottom - 1 && Math.abs((pr.left + pr.right) / 2 - (box.left + box.right) / 2) < 40,
        position: getComputedStyle(pop()).position,
        z: Number(getComputedStyle(pop()).zIndex),
        shadow: getComputedStyle(pop()).boxShadow !== 'none',
        inViewport: pr.left >= 0 && pr.right <= innerWidth + 0.5 && pr.bottom <= innerHeight + 0.5,
    };

    // 3) 先画一个矩形（点画布会把小窗收起），再点第 2 档调它：滑块 ↔ 数字框 ↔ 画布
    q('button[data-tool="rect"]').click();
    drag({x: 300, y: 200}, {x: 470, y: 320});
    await wait(150);
    await openSlot('group-widths', 1);
    const wRange = pop()?.querySelector('[data-range="lineWidth"]');
    const wNum = pop()?.querySelector('[data-number="lineWidth"]');
    if (!wRange || !wNum) {
        return {error: 'no-width-slider', hidden: pop()?.hidden,
            html: (pop()?.innerHTML || '').slice(0, 160), title: head(),
            editing: q('.annot-root').classList.contains('is-preset-edit')};
    }
    const strokeBefore = shapeOf()?.getAttribute('stroke-width');
    wRange.value = '13';
    wRange.dispatchEvent(new Event('input', {bubbles: true}));
    await wait(140);
    const byRange = {num: wNum.value, stroke: shapeOf()?.getAttribute('stroke-width'), before: strokeBefore};
    setInput(wNum, 9);
    await wait(140);
    const byNumber = {range: pop().querySelector('[data-range="lineWidth"]').value,
        stroke: shapeOf()?.getAttribute('stroke-width'),
        widths: (presets().lineWidths || []).join(',')};

    // 4) 第 1 个颜色：只有它变
    const before = dots();
    await openSlot('group-colors', 0);
    const picker = pop().querySelector('.annot-cw__hex-input');
    picker.value = '#123456';
    picker.dispatchEvent(new Event('change', {bubbles: true}));
    await wait(160);
    const colorChange = {title: head(), before: before.join(','), after: dots().join(','),
        saved: (presets().colors || [])[0]};

    // 5) 虚线间距：只改虚线
    q('button[data-tool="rect"]').click();
    drag({x: 300, y: 420}, {x: 470, y: 520});
    await wait(120);
    await openSlot('group-lines', 1);
    setInput(pop().querySelector('[data-number="lineDashGap"]'), 16);
    await wait(160);
    const dash = {title: head(), pattern: shapeOf()?.getAttribute('stroke-dasharray') || '',
        gaps: JSON.stringify(presets().dashGaps || {})};
    await openSlot('group-lines', 2);
    const otherGap = pop().querySelector('[data-number="lineDashGap"]').value;

    // 6) 第 3 档填充
    await openSlot('group-fills', 2);
    setInput(pop().querySelector('[data-number="fillOpacity"]'), 70);
    await wait(160);
    const fillSaved = (presets().fillOpacities || [])[2];

    // 7) 点画布 / Esc 收起
    const outside = at(60, 700);
    fire('pointerdown', outside);
    fire('pointerup', outside);
    await wait(120);
    const closedByOutside = pop().hidden;
    await openSlot('group-fonts', 0);
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await wait(120);
    const closedByEsc = pop().hidden;

    // 8) 应用退出：再点档位不弹窗
    q('[data-action="preset-apply"]').click();
    await wait(140);
    const exitEdit = {popHidden: pop().hidden, gear: !!q('[data-action="settings"]'),
        threeGone: !q('[data-action="preset-cancel"]'),
        editing: q('.annot-root').classList.contains('is-preset-edit')};
    const widthsAfterApply = (presets().lineWidths || []).join(',');
    q('button[data-preset="lineWidth"][data-index="0"]').click();
    await wait(100);
    const noPopAfterExit = pop().hidden;

    // 9) 取消：档位复原
    q('[data-action="settings"]').click();
    await wait(120);
    await openSlot('group-widths', 0);
    setInput(pop().querySelector('[data-number="lineWidth"]'), 30);
    await wait(140);
    const duringCancel = (presets().lineWidths || []).join(',');
    q('[data-action="preset-cancel"]').click();
    await wait(160);
    const afterCancel = {widths: (presets().lineWidths || []).join(','), gear: !!q('[data-action="settings"]')};

    // 10) 恢复默认
    q('[data-action="settings"]').click();
    await wait(120);
    q('[data-action="preset-reset"]').click();
    await wait(160);
    const afterReset = {widths: (presets().lineWidths || []).join(','),
        colors: (presets().colors || []).length, gear: !!q('[data-action="settings"]')};

    return {normalNoPop, enterEdit, layout, byRange, byNumber, colorChange, dash, otherGap,
        fillSaved, closedByOutside, closedByEsc, exitEdit, noPopAfterExit,
        widthsAfterApply, duringCancel, afterCancel, afterReset};
})()`);

check("真实浏览器：常态点档位直接生效、不弹小窗；点「自定义预设」才进入编辑模式",
    !!v19.normalNoPop && !!v19.enterEdit?.editing && !!v19.enterEdit?.three,
    JSON.stringify(v19).slice(0, 300));
check("真实浏览器：点第 2 档线宽，小窗贴在它正下方且只含这一档的滑块",
    v19.layout.open && v19.layout.below && v19.layout.onlyWidth && v19.layout.marked &&
    v19.layout.title.includes("第 2 个线条粗细"),
    JSON.stringify(v19.layout));
check("真实浏览器：小窗是容器内 absolute + 高层级 + 阴影，整个落在插件矩形里",
    v19.layout.position === "absolute" && v19.layout.z >= 80 &&
    v19.layout.shadow && v19.layout.insideRoot,
    `${v19.layout.position} z=${v19.layout.z} inside=${v19.layout.insideRoot}`);
check("真实浏览器：五个分组框等高、与自定义预设那一格等高；「属性」已去掉、五组都有标题",
    v19.layout.heights.length === 6 &&
    v19.layout.heights.every((h) => h === v19.layout.heights[0]) &&
    v19.layout.slotHeight === v19.layout.heights[0] &&
    !v19.layout.hasAttrLabel &&
    v19.layout.labels === "颜色,粗细,线型,填充,字号",
    JSON.stringify({heights: v19.layout.heights, slot: v19.layout.slotHeight,
        labels: v19.layout.labels, attrLabel: v19.layout.hasAttrLabel}));
check("真实浏览器：拖滑块 → 数字框与画布同时变",
    v19.byRange.num === "13" && v19.byRange.stroke === "13",
    JSON.stringify(v19.byRange));
check("真实浏览器：输入 9 → 滑块与画布同步，且只改第 2 档",
    v19.byNumber.range === "9" && v19.byNumber.stroke === "9" && v19.byNumber.widths === "2,9,8,14",
    JSON.stringify(v19.byNumber));
check("真实浏览器：改第 1 个圆点，只有它变色",
    v19.colorChange.after.split(",")[0] === "#123456" &&
    v19.colorChange.after.split(",").slice(1).join(",") ===
        v19.colorChange.before.split(",").slice(1).join(",") &&
    v19.colorChange.saved === "#123456",
    JSON.stringify(v19.colorChange));
check("真实浏览器：虚线间距改 16，只有虚线变（点线仍是 6）",
    / 16$/.test(v19.dash.pattern.trim()) && v19.otherGap === "6" &&
    JSON.parse(v19.dash.gaps).dashed === 16 && JSON.parse(v19.dash.gaps).dotted === 6,
    `${v19.dash.pattern} / ${v19.dash.gaps} / 点线=${v19.otherGap}`);
check("真实浏览器：改第 3 档填充到 70% 会写进预设",
    Math.abs(v19.fillSaved - 0.7) < 1e-6, String(v19.fillSaved));
check("真实浏览器：点画布空白处或按 Esc，小窗收起",
    v19.closedByOutside === true && v19.closedByEsc === true,
    `outside=${v19.closedByOutside} esc=${v19.closedByEsc}`);
check("真实浏览器：点「应用」退出编辑模式，再点档位不再弹窗",
    v19.exitEdit.popHidden && v19.exitEdit.gear && v19.exitEdit.threeGone &&
    !v19.exitEdit.editing && v19.noPopAfterExit &&
    v19.widthsAfterApply === "2,9,8,14",
    JSON.stringify({exit: v19.exitEdit, widths: v19.widthsAfterApply}));
check("真实浏览器：点「取消」把改过的档位还原（30 → 回去）",
    v19.duringCancel === "30,9,8,14" && v19.afterCancel.widths === "2,9,8,14" &&
    v19.afterCancel.gear, `${v19.duringCancel} → ${v19.afterCancel.widths}`);
check("真实浏览器：点「恢复默认」五组档位回到出厂值",
    v19.afterReset.widths === "2,4,8,14" && v19.afterReset.colors === 5 && v19.afterReset.gear,
    JSON.stringify(v19.afterReset));

// ---- 2.6) 思源真实的 svg 全局填充规则下，线性图标必须仍然是线条 ----
// 思源 app/src/assets/scss/util/_reset.scss 有一条 svg { fill: currentColor }，
// 它加载在插件样式之前、优先级却高于 <svg fill="none"> 这个属性。
// 这里把这条规则原样注入，逐档读 computed fill，再实拍像素做反证。
const outlineAudit = await evaluate(`(() => {
    if (!document.getElementById('siyuan-reset')) {
        document.head.insertAdjacentHTML('afterbegin',
            '<style id="siyuan-reset">svg{fill:currentColor;display:inline-block}</style>');
    }
    const bar = document.querySelector('[data-role="context-bar"]');
    if (!bar.querySelector('[data-role="corner-picker"]')) {
        document.querySelector('button[data-tool="rect"]').click();
    }
    const picker = bar.querySelector('[data-role="corner-picker"]');
    picker.querySelector('[data-action="corner-picker-toggle"]').click();
    const items = Array.from(bar.querySelectorAll('.annot-corner-picker__item'));
    const cornerFills = items.map((item) => {
        const path = item.querySelector('svg.annot-corner-icon path');
        return {v: item.getAttribute('data-value'), fill: path ? getComputedStyle(path).fill : 'missing'};
    });
    const chevron = getComputedStyle(picker.querySelector('svg.annot-chevron path')).fill;
    const tool = getComputedStyle(document.querySelector('button[data-tool="rect"] svg.annot-icon path')).fill;
    const solidPath = document.querySelector('button[data-tool="mosaic"] svg.annot-icon path[fill="currentColor"]');
    const solid = solidPath ? getComputedStyle(solidPath).fill : 'missing';
    // 反证：同样的结构，只要不挂插件的图标类，就会被思源这条规则填成实心
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    probe.setAttribute('class', 'siyuan-probe');
    probe.setAttribute('viewBox', '0 0 20 20');
    probe.setAttribute('width', '20');
    probe.setAttribute('height', '20');
    probe.innerHTML = '<path d="M3 17 L3 3 L17 3"/>';
    picker.querySelector('.annot-corner-picker__menu').appendChild(probe);
    const probeFill = getComputedStyle(probe.querySelector('path')).fill;
    probe.remove();
    return {cornerFills, chevron, tool, solid, probeFill, opened: picker.classList.contains('is-open')};
})()`);
check("真实浏览器：思源 svg{fill:currentColor} 下，圆角十档图案的 fill 全是 none",
    outlineAudit.opened && outlineAudit.cornerFills.length === 10 &&
    outlineAudit.cornerFills.every((f) => f.fill === 'none'),
    outlineAudit.cornerFills.map((f) => f.v + ':' + f.fill).join(' '));
check("真实浏览器：同一规则下下拉折角与工具图标也没被填实",
    outlineAudit.chevron === 'none' && outlineAudit.tool === 'none',
    `chevron=${outlineAudit.chevron} tool=${outlineAudit.tool}`);
check("真实浏览器：实心图标（马赛克）仍然保留填充",
    outlineAudit.solid !== 'none' && outlineAudit.solid !== 'missing', String(outlineAudit.solid));
check("真实浏览器：反证——不挂插件图标类的同样图形确实被思源规则填成实心",
    outlineAudit.probeFill !== 'none', String(outlineAudit.probeFill));

// 实拍像素：圆角 0 / 2 档图案内部应当是空白，只有描边是深色
const iconPoints = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.annot-corner-picker__item'));
    const pick = (v) => {
        const icon = items.find((i) => i.getAttribute('data-value') === v).querySelector('svg.annot-corner-icon');
        const r = icon.getBoundingClientRect();
        return {
            inner: {x: r.left + r.width * 0.355, y: r.top + r.height * 0.355},
            edge: {x: r.left + r.width * 0.15, y: r.top + r.height * 0.5},
            box: {w: r.width, h: r.height},
        };
    };
    return {zero: pick('0'), two: pick('2')};
})()`);
const iconPixels = await (async () => {
    const shotNow = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    await writeFile(path.join(outDir, "矩形圆角-思源样式.png"), Buffer.from(shotNow.data, "base64"));
    return evaluate(`(async () => {
        const img = new Image();
        img.src = "data:image/png;base64,${shotNow.data}";
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const points = ${JSON.stringify(iconPoints)};
        const out = {};
        for (const key of ["zero", "two"]) {
            out[key] = {};
            for (const spot of ["inner", "edge"]) {
                const p = points[key][spot];
                out[key][spot] = Array.from(ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data);
            }
            out[key].box = points[key].box;
        }
        return out;
    })()`);
})();
const lum = (c) => (c ? 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] : 999);
check("真实浏览器实拍：圆角图案内部是空白（没有被填成实心块）",
    lum(iconPixels.zero.inner) > 150 && lum(iconPixels.two.inner) > 150,
    `0 档内部 ${Math.round(lum(iconPixels.zero.inner))}，2 档内部 ${Math.round(lum(iconPixels.two.inner))}`);
check("真实浏览器实拍：同一点旁边的描边确实是深色（图案没被画没）",
    lum(iconPixels.zero.edge) < 140 && lum(iconPixels.two.edge) < 140,
    `0 档描边 ${Math.round(lum(iconPixels.zero.edge))}，2 档描边 ${Math.round(lum(iconPixels.two.edge))}`);
// 复原：后续用例按没有思源全局样式的干净环境继续跑
await evaluate(`document.getElementById('siyuan-reset')?.remove();
    document.querySelector('[data-action="corner-picker-toggle"]').click();`);

// 左侧工具栏：窗口高度够时单列，压矮后自动双列，恢复后再回单列
await evaluate(`(() => { const r = document.querySelector('.annot-root');
    r.style.flex = '0 0 auto'; r.style.height = '900px'; })()`);
await sleep(260);
const tallBar = await evaluate(`(() => { const b = document.querySelector('.annot-imagebar');
    return {twoCol: b.classList.contains('is-two-col'),
        cols: getComputedStyle(b.querySelector('.annot-imagebar__group')).gridTemplateColumns}; })()`);
await evaluate(`document.querySelector('.annot-root').style.height = '300px'`);
await sleep(260);
const shortBar = await evaluate(`(() => { const b = document.querySelector('.annot-imagebar');
    return {twoCol: b.classList.contains('is-two-col'),
        cols: getComputedStyle(b.querySelector('.annot-imagebar__group')).gridTemplateColumns}; })()`);
check("真实浏览器：窗口够高时左侧工具栏是单列，压矮后自动变双列",
    tallBar.twoCol === false && tallBar.cols === 'none' &&
    shortBar.twoCol === true && shortBar.cols.split(' ').length === 2,
    JSON.stringify({tallBar, shortBar}));
await evaluate(`(() => { const r = document.querySelector('.annot-root');
    r.style.height = ''; r.style.flex = ''; })()`);
await sleep(260);

const panelRoles = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => Array.from(document.querySelectorAll(s));
    return {
        layerButtons: all('[data-role="layers"] button').map((b) => b.textContent.trim()).join(','),
        noLayerList: all('[data-role="layer-item"]').length === 0,
        objectDraggable: all('[data-role="object-item"]').length > 0 &&
            all('[data-role="object-item"]').every((i) => i.draggable === true),
        actionsInObjects: all('[data-role="object-item"] [data-action="duplicate"]').length > 0 &&
            all('[data-role="object-item"] [data-action="delete-object"]').length > 0,
        notInProps: all('[data-role="props"] [data-action="duplicate"]').length === 0 &&
            all('[data-role="props"] [data-action="layer-top"]').length === 0,
    };
})()`);
check("真实浏览器：层级只留四个按钮，对象栏目承担拖拽 + 复制 / 删除",
    panelRoles.layerButtons === '置顶,上移,下移,置底' && panelRoles.noLayerList &&
    panelRoles.objectDraggable && panelRoles.actionsInObjects && panelRoles.notInProps,
    JSON.stringify(panelRoles));

const rowButtons = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-role="object-item"]'));
    return {
        rows: rows.length,
        everyRowHasTwo: rows.length > 0 && rows.every((r) => {
            const b = Array.from(r.querySelectorAll('[data-action="duplicate"], [data-action="delete-object"]'));
            return b.length === 2 && b.every((x) => x.dataset.id === r.dataset.id);
        }),
        noTypeText: document.querySelectorAll('.annot-object-item__type').length === 0,
        noBottomRow: document.querySelectorAll('[data-role="object-actions"]').length === 0 &&
            !document.querySelector('.annot-object-actions__label'),
    };
})()`);
check("真实浏览器：每个对象行末都有复制 / 删除，类型名称与「选中对象」行都没了",
    rowButtons.everyRowHasTwo && rowButtons.noTypeText && rowButtons.noBottomRow,
    JSON.stringify(rowButtons));

const sectionHeights = await evaluate(`(() => {
    const h = (k) => {
        const el = document.querySelector('.annot-side-section[data-section="' + k + '"]');
        return el ? Math.round(el.getBoundingClientRect().height) : 0;
    };
    return {objects: h('objects'), layers: h('layers'), props: h('props'),
        sections: document.querySelectorAll('.annot-side-section').length};
})()`);
check("真实浏览器：属性栏目已移除，只剩对象 / 层级两块，层级仍只占一行",
    sectionHeights.props === 0 && sectionHeights.sections === 2 &&
    sectionHeights.layers > 0 && sectionHeights.layers < 90 &&
    sectionHeights.objects > sectionHeights.layers,
    JSON.stringify(sectionHeights));

const hollowIcons = await evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('[data-role="object-item"] button'));
    return {
        count: btns.length,
        allHollow: btns.every((b) => {
            const svg = b.querySelector('svg');
            const paths = Array.from(b.querySelectorAll('path'));
            return !!svg && getComputedStyle(svg).fill === 'none' &&
                paths.length >= 2 && paths.every((p) => getComputedStyle(p).fill === 'none');
        }),
    };
})()`);
check("真实浏览器：复制 / 删除图标是纯线条镂空（没有实心填充）",
    hollowIcons.count >= 2 && hollowIcons.count % 2 === 0 && hollowIcons.allHollow,
    JSON.stringify(hollowIcons));

const panels = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    const sec = q('.annot-side-section[data-section="objects"]');
    const before = sec.getBoundingClientRect().height;
    sec.querySelector('.annot-section-toggle').click();
    const after = sec.getBoundingClientRect().height;
    const folded = sec.classList.contains('is-folded');
    sec.querySelector('.annot-section-toggle').click();
    const handle = q('.annot-side-handle');
    handle.click();
    const collapsed = q('[data-role="sidebar"]').classList.contains('is-collapsed');
    const position = getComputedStyle(handle).position;
    // 把插件容器临时收窄，验证拉手贴的是插件右边缘而不是整个屏幕右边缘
    const root = q('.annot-root');
    const oldFlex = root.style.flex, oldWidth = root.style.width;
    root.style.flex = '0 0 auto';
    root.style.width = Math.min(900, window.innerWidth - 120) + 'px';
    void root.offsetWidth;
    const r = handle.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const atPluginRight = Math.abs(r.right - rr.right) < 3;
    const notAtScreenRight = r.right < window.innerWidth - 20;
    root.style.flex = oldFlex; root.style.width = oldWidth;
    handle.click();
    return {before, after, folded, collapsed, position, atPluginRight, notAtScreenRight};
})()`);
check("真实浏览器：区块折叠后高度真的收窄",
    panels.folded && panels.after < panels.before, JSON.stringify(panels));
check("真实浏览器：面板收起后拉手用 absolute 贴在插件右边缘，不会跑到思源窗口最右",
    panels.collapsed && panels.position === 'absolute' &&
    panels.atPluginRight && panels.notAtScreenRight, JSON.stringify(panels));

const dragFlow = await evaluate(`(() => {
    const objs = () => Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'))
        .map((g) => g.getAttribute('data-object-id')).join(',');
    const items = Array.from(document.querySelectorAll('[data-role="object-item"]'));
    const before = objs();
    const dt = new DataTransfer();
    items[items.length - 1].dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
    items[0].dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
    items[0].dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
    return {before, after: objs(), count: items.length};
})()`);
check("真实浏览器：拖拽「对象」列表真的改变了绘制顺序",
    dragFlow.count >= 2 && dragFlow.after !== dragFlow.before,
    `${dragFlow.count} 层 / ${dragFlow.before.slice(0, 40)} → ${dragFlow.after.slice(0, 40)}`);
await sleep(250);
const layoutShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "PC界面-重构后.png"), Buffer.from(layoutShot.data, "base64"));

// ---- 3) 保存：画线要跟着工程数据一起写进 PNG ----
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(900);
const saved = await evaluate(`(() => ({
    objects: (window.__savedPackage?.scene?.objects || []).map((o) => o.type),
    hasPng: (window.__savedPng || '').startsWith('data:image/png;base64,'),
    puts: window.__puts.slice(-1)[0] || '',
}))()`);
check("真实浏览器：保存后工程数据里有画线对象",
    saved.objects.filter((t) => t === "line").length >= 2 && saved.hasPng,
    JSON.stringify(saved.objects));
check("真实浏览器：保存仍是覆盖同一个资源",
    saved.puts === "data/assets/demo.png", saved.puts);

// ---- 3.5) 交付截图：重开一个干净的编辑器，只画这次要展示的内容 ----
await send("Page.reload", {});
let readyAgain = false;
for (let i = 0; i < 80; i++) {
    if (await evaluate("window.__ready === true")) { readyAgain = true; break; }
    await sleep(100);
}
if (!readyAgain) throw new Error("重载后 harness 未就绪");
await sleep(400);
const shotDiag = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const drag = (a, b) => { fire('pointerdown', at(a.x, a.y)); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const deselect = async () => {
        q('button[data-tool="select"]').click();
        fire('pointerdown', at(1150, 730));
        fire('pointerup', at(1150, 730));
        await wait(40);
    };
    q('[data-role="group-colors"] button[data-value="#EF4444"]')?.click();
    // 点划线矩形（机械制图中心线）
    q('button[data-tool="rect"]').click();
    q('button[data-preset="lineDash"][data-value="dashdot"]').click();
    drag({x: 80, y: 80}, {x: 430, y: 220});
    await deselect();
    q('button[data-preset="lineDash"][data-value="solid"]').click();
    // 圆线 / 方头 两根粗线
    q('button[data-tool="line"]').click();
    // 常态没有滑块：直接点对应的线宽档位
    const setWidth = (n) => {
        q('button[data-preset="lineWidth"][data-value="' + n + '"]')?.click();
    };
    setWidth(14);
    const roundBtn = () => q('[data-role="context-bar"] [data-action="line-round"]');
    if (roundBtn()?.getAttribute('aria-pressed') !== 'true') roundBtn()?.click();
    await wait(50);
    drag({x: 90, y: 300}, {x: 420, y: 300});
    await deselect();
    q('button[data-tool="line"]').click();
    if (roundBtn()?.getAttribute('aria-pressed') === 'true') roundBtn()?.click();
    await wait(50);
    drag({x: 90, y: 360}, {x: 420, y: 360});
    await deselect();

    // 序号：五种编号格式 + 三种引线端点（交付截图用）
    // 注意：切换格式在「有选中」时会改这一支，所以每放一个都先取消选中，
    // 让五个徽章各自保留自己的格式，截图才对得上
    // 序号用 4px 线宽（14px 的引线箭头会显得很笨重），此时没有选中对象，只改默认值
    setWidth(4);
    const dropNumber = async (x, y) => {
        fire("pointerdown", at(x, y));
        fire("pointerup", at(x, y));
        await wait(30);
    };
    const pickFormat = async (format) => {
        q('[data-action="number-format-toggle"]').click();
        await wait(40);
        q('[data-action="number-format-pick"][data-value="' + format + '"]').click();
        await wait(40);
    };
    const pickNumber = async (format, x, y) => {
        q('button[data-tool="number"]').click();
        await pickFormat(format);
        await dropNumber(x, y);
        await deselect();
    };
    await pickNumber("roman", 560, 120);
    await pickNumber("roman", 660, 120);
    await pickNumber("chinese", 760, 120);
    await pickNumber("alphaLower", 860, 120);
    await pickNumber("alphaUpper", 960, 120);
    // 端点对照：箭头 / 圆点 / 方点（同样每放一个先取消选中，让默认值生效）
    const leader = async (tip, x1, y1, x2, y2) => {
        q('button[data-tool="number"]').click();
        await pickFormat("arabic");
        q('[data-action="number-tip"][data-value="' + tip + '"]').click();
        await wait(40);
        fire("pointerdown", at(x1, y1));
        fire("pointermove", at((x1 + x2) / 2, (y1 + y2) / 2));
        fire("pointerup", at(x2, y2));
        await wait(40);
        await deselect();
    };
    await leader("arrow", 560, 240, 660, 320);
    await leader("dot", 740, 240, 840, 320);
    await leader("square", 920, 240, 1020, 320);
    // 截图前把端点切回「箭头」，这样悬浮条上两个下拉都在（编号格式 + 箭头样式）
    q('button[data-tool="number"]').click();
    q('[data-action="number-tip"][data-value="arrow"]').click();
    await wait(80);
    const bar = q('[data-role="context-bar"]');
    return {
        tips: Array.from(bar.querySelectorAll('[data-action="number-tip"]'))
            .map((b) => b.getAttribute('data-value') + ':' + b.getAttribute('aria-pressed')),
        hasStyle: !!bar.querySelector('[data-role="number-style-picker"]'),
        hasRounded: !!bar.querySelector('[data-action="arrow-rounded"]'),
    };
})()`);
await sleep(400);
const cleanBarShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "序号-格式与端点.png"), Buffer.from(cleanBarShot.data, "base64"));

// 编号格式下拉展开的样子
await evaluate(`document.querySelector('[data-action="number-format-toggle"]')?.click()`);
await sleep(250);
const formatShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "序号-编号格式下拉.png"), Buffer.from(formatShot.data, "base64"));
await evaluate(`document.querySelector('[data-action="number-format-toggle"]')?.click()`);
await sleep(150);
// 箭头样式下拉展开的样子
await evaluate(`document.querySelector('[data-action="number-style-toggle"]')?.click()`);
await sleep(250);
const styleShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "序号-箭头样式下拉.png"), Buffer.from(styleShot.data, "base64"));
await evaluate(`document.querySelector('[data-action="number-style-toggle"]')?.click()`);
await sleep(150);
await evaluate(`document.querySelector('[data-role="context-bar"] [data-tool="select"]')?.click()`);
await sleep(200);
const baseBarShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "悬浮条-选择与平移.png"), Buffer.from(baseBarShot.data, "base64"));
await evaluate(`document.querySelector('button[data-tool="number"]')?.click()`);
await sleep(200);
const cleanBar2 = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "属性栏-新档位与点划线.png"), Buffer.from(cleanBar2.data, "base64"));
await evaluate(`document.querySelector('[data-action="color-pop-toggle"]')?.click()`);
await sleep(250);
const cleanPopShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "颜色预设-弹窗.png"), Buffer.from(cleanPopShot.data, "base64"));
await evaluate(`document.querySelector('[data-action="color-pop-close"]')?.click()`);

// ---- 3.55) v0.20.2：真实浏览器里按住 Shift 画 箭头 / 矩形 / 椭圆 / 聚光灯 ----
const shiftDraw = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, extra = {}) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY, ...extra,
    }));
    const lastGroup = () => {
        const gs = document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)');
        return gs[gs.length - 1];
    };
    const draw = (tool, a, b, shift) => {
        document.querySelector('button[data-tool="' + tool + '"]').click();
        fire('pointerdown', at(a[0], a[1]));
        fire('pointermove', at(b[0], b[1]), shift ? {shiftKey: true} : {});
        fire('pointerup', at(b[0], b[1]), shift ? {shiftKey: true} : {});
    };
    draw('arrow', [100, 100], [300, 124], true);
    const d = lastGroup()?.querySelector('path.annot-shape')?.getAttribute('d') || '';
    const nums = (d.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
    const arrow = {
        dx: Math.abs((nums[2] || 0) - (nums[0] || 0)),
        dy: Math.abs((nums[3] || 0) - (nums[1] || 0)),
    };
    draw('arrow', [100, 140], [300, 190], false);
    const freeD = lastGroup()?.querySelector('path.annot-shape')?.getAttribute('d') || '';
    const freeNums = (freeD.match(/-?\\d+(?:\\.\\d+)?/g) || []).map(Number);
    const freeArrow = {
        dx: Math.abs((freeNums[2] || 0) - (freeNums[0] || 0)),
        dy: Math.abs((freeNums[3] || 0) - (freeNums[1] || 0)),
    };
    draw('rect', [100, 300], [260, 380], true);
    const r = lastGroup()?.querySelector('rect.annot-shape');
    const rectBox = {w: Number(r?.getAttribute('width')), h: Number(r?.getAttribute('height'))};
    draw('ellipse', [400, 300], [560, 380], true);
    const e = lastGroup()?.querySelector('ellipse.annot-shape');
    const ellipseBox = {w: Number(e?.getAttribute('rx')) * 2, h: Number(e?.getAttribute('ry')) * 2};
    draw('spotlight', [700, 300], [860, 380], true);
    const sd = lastGroup()?.querySelector('path.annot-shape')?.getAttribute('d') || '';
    const hole = sd.match(/h([\\d.]+)v([\\d.]+)/);
    document.querySelector('button[data-tool="select"]').click();
    return {arrow, freeArrow, rectBox, ellipseBox, hole: hole ? [Number(hole[1]), Number(hole[2])] : null};
})()`);
check("真实浏览器：箭头按住 Shift 拖拽被锁成水平（不按 Shift 仍是斜线）",
    shiftDraw.arrow.dy < 0.01 && shiftDraw.arrow.dx > 150 &&
    shiftDraw.freeArrow.dy > 30, JSON.stringify({shift: shiftDraw.arrow, free: shiftDraw.freeArrow}));
check("真实浏览器：矩形按住 Shift 拖拽是正方形",
    Math.abs(shiftDraw.rectBox.w - shiftDraw.rectBox.h) < 0.01 && shiftDraw.rectBox.w > 100,
    JSON.stringify(shiftDraw.rectBox));
check("真实浏览器：椭圆按住 Shift 拖拽是正圆",
    Math.abs(shiftDraw.ellipseBox.w - shiftDraw.ellipseBox.h) < 0.01 && shiftDraw.ellipseBox.w > 100,
    JSON.stringify(shiftDraw.ellipseBox));
check("真实浏览器：聚光灯按住 Shift 拖拽洞口是正方形（矩形形状）",
    !!shiftDraw.hole && Math.abs(shiftDraw.hole[0] - shiftDraw.hole[1]) < 0.01 && shiftDraw.hole[0] > 100,
    JSON.stringify(shiftDraw.hole));

// ---- 3.56) v0.21.0：多选对齐 / 分布（真实浏览器） ----
const alignRun = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p, extra = {}) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY, ...extra,
    }));
    const drawRect = (a, b) => {
        document.querySelector('button[data-tool="rect"]').click();
        fire('pointerdown', at(a[0], a[1]));
        fire('pointermove', at(b[0], b[1]));
        fire('pointerup', at(b[0], b[1]));
    };
    drawRect([100, 100], [200, 160]);
    drawRect([400, 220], [500, 280]);
    drawRect([900, 340], [1000, 400]);
    document.querySelector('button[data-tool="select"]').click();
    // 每画一个对象 DOM 都会重建，所以每次都重新按索引取（顺序＝场景顺序，不会变）
    const groupAt = (back) => {
        const gs = Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
        return gs[gs.length - back];
    };
    const rectsX = () => Array.from(document.querySelectorAll('[data-layer="objects"] rect.annot-shape'))
        .slice(-3).map((el) => ({x: Number(el.getAttribute('x')), w: Number(el.getAttribute('width'))}));
    const selectedNow = () => document.querySelectorAll('[data-layer="objects"] g.annot-object.is-selected').length;
    // 点空白清空，再进对齐模式
    fire('pointerdown', at(30, 780));
    fire('pointerup', at(30, 780));
    document.querySelector('[data-action="align-mode"]').click();
    const alignActive = document.querySelector('[data-action="align-mode"]').classList.contains('is-active');
    const ctrlClick = (back, x, y) => {
        const g = groupAt(back);
        const hit = g ? g.querySelector('[data-role="hit"]') : null;
        if (!hit) return false;
        const p = at(x, y);
        for (const type of ['pointerdown', 'pointerup']) {
            hit.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: p.clientX, clientY: p.clientY,
            }));
        }
        return true;
    };
    const clickThree = ctrlClick(3, 150, 130);
    const selAfterFirst = selectedNow();
    const clickOne = ctrlClick(1, 950, 370);
    const selected2 = selectedNow();
    const alignButtons = Array.from(document.querySelectorAll('[data-action="align-op"]'))
        .map((el) => el.getAttribute('data-value'));
    const unionFirst = !!document.querySelector('[data-layer="overlay"] .annot-selection-union');
    // 左对齐
    document.querySelector('[data-action="align-op"][data-value="left"]')?.click();
    const leftX = rectsX().map((r) => Math.round(r.x));
    // Ctrl+Z 撤销，回原位
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true}));
    const afterUndo = rectsX().map((r) => Math.round(r.x));
    // 三个一起横向分布
    ctrlClick(2, 450, 250);
    const selected3 = selectedNow();
    document.querySelector('[data-action="align-op"][data-value="distribute-x"]')?.click();
    const dist = rectsX();
    const gap1 = dist[1].x - (dist[0].x + dist[0].w);
    const gap2 = dist[2].x - (dist[1].x + dist[1].w);
    // Esc 退出对齐模式
    document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    const alignOff = !document.querySelector('[data-action="align-mode"]').classList.contains('is-active');
    document.querySelector('button[data-tool="select"]').click();
    return {
        alignActive, clickThree, clickOne, selAfterFirst, selected2, selected3,
        alignButtons, unionFirst, leftX, afterUndo,
        dist: dist.map((r) => Math.round(r.x)), gap1: Math.round(gap1), gap2: Math.round(gap2), alignOff,
    };
})()`);
check("真实浏览器：点【对齐】进入多选模式",
    alignRun.alignActive === true, String(alignRun.alignActive));
check("真实浏览器：Ctrl 点选两个对象都被选中，悬浮条展开 8 个对齐按钮与联合包围框",
    alignRun.selAfterFirst === 1 && alignRun.selected2 === 2 && alignRun.unionFirst &&
    alignRun.alignButtons.length === 8 &&
    alignRun.alignButtons.join(",") === "left,center-x,right,top,middle,bottom,distribute-x,distribute-y",
    JSON.stringify({sel: [alignRun.selAfterFirst, alignRun.selected2], btns: alignRun.alignButtons}));
check("真实浏览器：点左对齐后两个矩形左边缘都到 100",
    alignRun.leftX.slice(-3).filter((x) => x === 100).length === 2 &&
    Math.min(...alignRun.leftX.slice(-3)) === 100,
    JSON.stringify(alignRun.leftX));
check("真实浏览器：Ctrl+Z 撤销后位置复原",
    alignRun.afterUndo.slice(-3).every((x, i) => Math.abs(x - [100, 400, 900][i]) <= 1),
    JSON.stringify(alignRun.afterUndo));
check("真实浏览器：三个对象横向分布后间隙相等",
    alignRun.selected3 === 3 && Math.abs(alignRun.gap1 - alignRun.gap2) <= 1,
    JSON.stringify({sel: alignRun.selected3, x: alignRun.dist, gap: [alignRun.gap1, alignRun.gap2]}));
check("真实浏览器：Esc 退出对齐模式（按钮不再高亮）", alignRun.alignOff === true, String(alignRun.alignOff));

// ---- 3.6) v0.16.0：顶栏按钮换位 / 文案 / 全屏与还原 ----

const readShell = `(() => {
    const shell = document.querySelector(".b3-dialog");
    const root = document.querySelector(".annot-root");
    const stage = document.querySelector(".annot-stage");
    const layer = document.querySelector('[data-role="transform"]');
    const svg = document.querySelector('[data-role="svg"]');
    const box = (el) => {
        const b = el.getBoundingClientRect();
        return {w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y)};
    };
    // 用 DOMMatrix 读视口，别用字符串切分（translate3d 里的 "3d" 会干扰取数）
    const raw = getComputedStyle(layer).transform;
    const mtx = raw && raw !== "none" ? new DOMMatrixReadOnly(raw) : new DOMMatrixReadOnly();
    return {
        shell: box(shell), root: box(root), stage: box(stage), svg: box(svg),
        panX: mtx.e, panY: mtx.f, zoom: mtx.a,
        canvasW: parseFloat(layer.style.width) || 0,
        canvasH: parseFloat(layer.style.height) || 0,
        viewport: {w: innerWidth, h: innerHeight},
        buttonPaths: document.querySelectorAll('[data-action="fullscreen"] svg path').length,
        pressed: document.querySelector('[data-action="fullscreen"]').getAttribute("aria-pressed"),
        title: document.querySelector('[data-action="fullscreen"]').getAttribute("title") || "",
        shellZ: getComputedStyle(shell).zIndex,
        shellPosition: getComputedStyle(shell).position,
        corner: (() => {
            const el = document.elementFromPoint(innerWidth - 6, innerHeight - 6);
            return {
                tag: el?.tagName || "",
                inFake: !!el?.closest?.("#siyuan-fake-controls"),
                inRoot: !!el?.closest?.(".annot-root"),
            };
        })(),
        shellStyle: shell.getAttribute("style") || "",
        containerStyle: document.querySelector(".b3-dialog__container").getAttribute("style") || "",
        transformRaw: layer.style.transform,
        layerSize: {w: layer.style.width, h: layer.style.height},
        container: box(document.querySelector(".b3-dialog__container")),
    };
})()`;

const topbar = await evaluate(`(() => {
    const bar = document.querySelector(".annot-titlebar");
    const kids = Array.from(bar.children);
    const label = (el) => (el.textContent || "").trim();
    return {
        texts: kids.map((el) => el.getAttribute("data-action")
            ? el.getAttribute("data-action") + ":" + label(el)
            : (el.tagName === "SELECT" ? "theme" : "other")),
        closeLeftOfSave: kids.findIndex((el) => el.getAttribute("data-action") === "close") <
            kids.findIndex((el) => el.getAttribute("data-action") === "save"),
        lastIsFullscreen: kids[kids.length - 1]?.getAttribute("data-action") === "fullscreen",
        saveText: label(document.querySelector('[data-action="save"]')),
        closeText: label(document.querySelector('[data-action="close"]')),
    };
})()`);
check("真实浏览器：顶栏是「取消」在左、「保存」在右，全屏按钮排最右",
    topbar.saveText === "保存" && topbar.closeText === "取消" &&
    topbar.closeLeftOfSave && topbar.lastIsFullscreen, topbar.texts.join(" | "));

// 造一块「思源原生窗口按钮」：右下角、fixed、z-index 99999。
// 全屏之后鼠标落在这里必须打到插件里，而不是这块假按钮——这就是「不再误触关闭」的判据。
await evaluate(`(() => {
    if (document.getElementById('siyuan-fake-controls')) return;
    const el = document.createElement('div');
    el.id = 'siyuan-fake-controls';
    el.style.cssText = 'position:fixed;right:0;bottom:0;width:120px;height:36px;z-index:99999;' +
        'background:#123456;display:flex;align-items:center;justify-content:center;' +
        'color:#fff;font:12px sans-serif';
    el.textContent = 'SIYUAN CONTROLS';
    document.body.appendChild(el);
})()`);
await sleep(150);
const beforeFs = await evaluate(readShell);
check("真实浏览器：全屏前，右下角那块「思源窗口按钮」是能被点到的（反证用）",
    beforeFs.corner.inFake === true, JSON.stringify(beforeFs.corner));
await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
await sleep(700);
const afterFs = await evaluate(readShell);
const fsShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "全屏-编辑器.png"), Buffer.from(fsShot.data, "base64"));

check("真实浏览器：点全屏后编辑器铺满整个窗口（外壳 = 窗口尺寸）",
    Math.abs(afterFs.shell.w - afterFs.viewport.w) <= 2 &&
    Math.abs(afterFs.shell.h - afterFs.viewport.h) <= 2 &&
    afterFs.root.w > beforeFs.root.w + 20 && afterFs.stage.h > beforeFs.stage.h,
    `${beforeFs.shell.w}×${beforeFs.shell.h} → ${afterFs.shell.w}×${afterFs.shell.h}`);
check("真实浏览器：全屏后外壳层级极高、fixed 铺满，压住思源原生窗口按钮",
    Number(afterFs.shellZ) >= 999999 && afterFs.shellPosition === "fixed" &&
    afterFs.shell.w === afterFs.viewport.w && afterFs.shell.h === afterFs.viewport.h,
    `z-index=${afterFs.shellZ} position=${afterFs.shellPosition} ${afterFs.shell.w}×${afterFs.shell.h}`);
check("真实浏览器：全屏后右下角（原思源窗口按钮处）点到的只有插件，不会再误触",
    afterFs.corner.inRoot === true && afterFs.corner.inFake === false,
    JSON.stringify(afterFs.corner));
check("真实浏览器：全屏后按钮变成四角向内的还原图标",
    afterFs.buttonPaths === 1 && afterFs.pressed === "true" && afterFs.title.includes("还原"),
    `${beforeFs.buttonPaths} → ${afterFs.buttonPaths}`);
check("真实浏览器：全屏后画布按比例重新适应并居中（没有拉伸变形）",
    afterFs.canvasW > 0 && Math.abs(afterFs.canvasW / afterFs.canvasH - beforeFs.canvasW / beforeFs.canvasH) < 0.01 &&
    afterFs.zoom > beforeFs.zoom &&
    afterFs.canvasW * afterFs.zoom <= afterFs.stage.w + 1 &&
    afterFs.canvasH * afterFs.zoom <= afterFs.stage.h + 1 &&
    Math.abs(afterFs.panX - (afterFs.stage.w - afterFs.canvasW * afterFs.zoom) / 2) < 3 &&
    Math.abs(afterFs.panY - (afterFs.stage.h - afterFs.canvasH * afterFs.zoom) / 2) < 3 &&
    Math.abs(afterFs.svg.w / afterFs.svg.h - afterFs.canvasW / afterFs.canvasH) < 0.02,
    `zoom ${beforeFs.zoom.toFixed(3)}→${afterFs.zoom.toFixed(3)} pan=${afterFs.panX.toFixed(0)},${afterFs.panY.toFixed(0)}`);

await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
await sleep(700);
const restoredFs = await evaluate(readShell);
check("真实浏览器：点还原后回到原来的窗口大小与缩放",
    Math.abs(restoredFs.shell.w - beforeFs.shell.w) <= 2 &&
    Math.abs(restoredFs.shell.h - beforeFs.shell.h) <= 2 &&
    Math.abs(restoredFs.zoom - beforeFs.zoom) < 0.01 &&
    restoredFs.buttonPaths === beforeFs.buttonPaths && restoredFs.pressed === "false",
    `${afterFs.shell.w}×${afterFs.shell.h} → ${restoredFs.shell.w}×${restoredFs.shell.h}`);
check("真实浏览器：还原后右下角交还给思源（假按钮重新露出来），没有残留遮挡",
    restoredFs.corner.inFake === true && restoredFs.corner.inRoot === false,
    JSON.stringify(restoredFs.corner));
check("真实浏览器：还原后内联样式写回原样，没有残留 important 覆盖",
    restoredFs.containerStyle === beforeFs.containerStyle, restoredFs.containerStyle.slice(0, 60));

// ---- 3.7) v0.20.1：Windows 原生窗口按钮（Electron 浮层）必须彻底消失 ----
// 思源桌面端的右上角三颗按钮是 titleBarOverlay 画的，不在 DOM 里，z-index 盖不住；
// 唯一解法是让窗口进系统全屏。这里把 requestFullscreen / exitFullscreen 换成探针
// （真跑会打乱 headless 视口），验证调用参数、<html> 标记与安全边距。
await evaluate(`(() => {
    window.__fsLog = {req: 0, exit: 0, opts: null};
    window.__fsEl = null;
    const doc = document.documentElement;
    try {
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get: () => window.__fsEl,
        });
    } catch (e) {}
    doc.requestFullscreen = function (opts) {
        window.__fsLog.req++;
        window.__fsLog.opts = opts || null;
        window.__fsEl = doc;
        return Promise.resolve();
    };
    document.exitFullscreen = function () {
        window.__fsLog.exit++;
        window.__fsEl = null;
        return Promise.resolve();
    };
})()`);
await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
await sleep(600);
const nativeFs = await evaluate(`(() => {
    const btn = document.querySelector('[data-action="fullscreen"]');
    const box = btn.getBoundingClientRect();
    return {
        log: window.__fsLog,
        htmlClass: document.documentElement.classList.contains('annot-fs'),
        rootClass: document.querySelector('.annot-root').classList.contains('is-fullscreen'),
        shellZ: getComputedStyle(document.querySelector('.b3-dialog')).zIndex,
        gapRight: Math.round(innerWidth - box.right),
        gapTop: Math.round(box.top),
        btnW: Math.round(box.width),
    };
})()`);
check("真实浏览器：点全屏会请求系统全屏（navigationUI: hide），原生窗口按钮随之被撤掉",
    nativeFs.log.req === 1 && nativeFs.log.opts && nativeFs.log.opts.navigationUI === "hide",
    JSON.stringify(nativeFs.log));
check("真实浏览器：全屏期间 <html> 打上 annot-fs（思源自己的窗口按钮被藏起来）",
    nativeFs.htmlClass === true && nativeFs.rootClass === true,
    `html=${nativeFs.htmlClass} root=${nativeFs.rootClass}`);
check("真实浏览器：全屏层级为 z-index 上限 2147483647",
    nativeFs.shellZ === "2147483647", nativeFs.shellZ);
check("真实浏览器：全屏时「还原」按钮离屏幕右上角至少 20×10 的安全边距",
    nativeFs.gapRight >= 20 && nativeFs.gapTop >= 10 && nativeFs.btnW > 0,
    `右 ${nativeFs.gapRight}px / 上 ${nativeFs.gapTop}px`);

await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
await sleep(600);
const nativeFsExit = await evaluate(`({
    log: window.__fsLog,
    htmlClass: document.documentElement.classList.contains('annot-fs'),
})`);
check("真实浏览器：点还原会退出系统全屏，并清掉 annot-fs（思源按钮恢复显示）",
    nativeFsExit.log.exit === 1 && nativeFsExit.htmlClass === false,
    JSON.stringify(nativeFsExit));

// 兜底：假设系统全屏失效、原生按钮还在（navigator.windowControlsOverlay.visible = true），
// 顶栏必须自动让出那一段宽度，插件按钮永远不压在原生按钮底下
await evaluate(`(() => {
    Object.defineProperty(navigator, 'windowControlsOverlay', {
        configurable: true,
        get: () => ({
            visible: true,
            getTitlebarAreaRect: () => ({x: 0, y: 0, width: innerWidth - 138, height: 31, right: innerWidth - 138, bottom: 31}),
        }),
    });
})()`);
const padBefore = await evaluate(`getComputedStyle(document.querySelector('.annot-titlebar')).paddingRight`);
await evaluate(`document.querySelector('[data-action="fullscreen"]').click()`);
await sleep(700);
const fallback = await evaluate(`(() => {
    const bar = document.querySelector('.annot-titlebar');
    const btn = document.querySelector('[data-action="fullscreen"]').getBoundingClientRect();
    return {
        safe: document.querySelector('.annot-root').style.getPropertyValue('--annot-fs-safe-right').trim(),
        pad: getComputedStyle(bar).paddingRight,
        gapRight: Math.round(innerWidth - btn.right),
    };
})()`);
check("真实浏览器：系统全屏没生效时，顶栏自动让开原生按钮那一段（兜底不误触）",
    fallback.safe === "148px" && fallback.gapRight >= 140 && parseFloat(fallback.pad) >= 150,
    `safe=${fallback.safe} padding=${fallback.pad} 右距=${fallback.gapRight}px（原 ${padBefore}）`);
await evaluate(`(() => {
    document.querySelector('[data-action="fullscreen"]').click();
    delete navigator.windowControlsOverlay;
})()`);
await sleep(400);

await evaluate(`document.getElementById('siyuan-fake-controls')?.remove()`);

// ---- 4) v0.18.0：换一张「有花纹」的底图，像素级验证放大镜 / 聚光灯，并出交付截图 ----
await fetch(`http://127.0.0.1:${port}/__pattern`);
await send("Page.navigate", {url: `http://127.0.0.1:${port}/?asset=pattern.png`});
let patternReady = false;
for (let i = 0; i < 120; i++) {
    // 光看 __ready 会读到「还没换掉的上一个页面」；再确认 URL 已经带上 asset 参数
    const state = await evaluate(`({ready: window.__ready === true, search: location.search})`);
    if (state && state.ready && String(state.search).includes("asset=pattern")) {
        patternReady = true;
        break;
    }
    await sleep(100);
}
if (!patternReady) throw new Error("花纹底图页面未就绪");
await sleep(600);

// Shift 约束实拍：拖 220×120，按住 Shift 应当得到 220×220 的正圆镜框
const shiftShot = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, shiftKey: true,
        clientX: p.clientX, clientY: p.clientY,
    }));
    q('button[data-tool="magnifier"]').click();
    await wait(60);
    // 用矩形镜片出图：正方形外形一眼看得出「被 Shift 约束住了」
    q('[data-action="magnifier-shape"][data-value="rect"]')?.click();
    q('[data-action="magnifier-zoom"][data-value="2"]')?.click();
    await wait(60);
    // 起点压在蓝色块里，镜片里就能看到被放大的色块与网格
    fire('pointerdown', at(440, 180));
    fire('pointermove', at(660, 300));
    fire('pointerup', at(660, 300));
    await wait(250);
    const gs = Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const el = gs[gs.length - 1]?.querySelector('rect.annot-shape');
    return el ? {w: Number(el.getAttribute('width')), h: Number(el.getAttribute('height'))} : null;
})()`);
await sleep(300);
const shiftShotPng = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "放大镜-正方形.png"), Buffer.from(shiftShotPng.data, "base64"));
check("真实浏览器：Shift 约束的实拍截图已生成，镜片是正方形（220×220）",
    !!shiftShot && Math.abs(shiftShot.w - 220) < 1 && Math.abs(shiftShot.h - 220) < 1,
    JSON.stringify(shiftShot));
// 删掉这一支，免得它挡在后面 2x 取景与截图里
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Delete", bubbles: true, cancelable: true}))`);
await sleep(250);

const patternGeom = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const press = (a) => {
        const pt = at(a.x, a.y);
        const el = document.elementFromPoint(pt.clientX, pt.clientY) || svg;
        el.dispatchEvent(new MouseEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, clientX: pt.clientX, clientY: pt.clientY,
        }));
    };
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    const drag = (a, b) => { press(a); fire('pointermove', at(b.x, b.y)); fire('pointerup', at(b.x, b.y)); };
    const last = () => {
        const gs = Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
        return gs[gs.length - 1];
    };
    const anchorOf = () => {
        const cs = Array.from(last()?.querySelectorAll('circle') || []);
        const dot = cs[cs.length - 1];
        return {cx: Number(dot.getAttribute('cx')), cy: Number(dot.getAttribute('cy'))};
    };

    // 放大镜：镜框 200×200，锚点拖到玫红色块中心（120,120 那块是 100..160）
    q('button[data-tool="magnifier"]').click();
    await wait(60);
    drag({x: 700, y: 180}, {x: 900, y: 380});
    await wait(150);
    const a0 = anchorOf();
    drag({x: a0.cx, y: a0.cy}, {x: 130, y: 130});
    await wait(200);
    // 倍数 / 形状会被上一次测试存进本地，这里显式点回 2x 圆形，保证基准与观感固定
    q('[data-action="magnifier-shape"][data-value="ellipse"]')?.click();
    q('[data-action="magnifier-zoom"][data-value="2"]')?.click();
    await wait(250);
    const img = last()?.querySelector('image');
    const lens = {
        x: Number(img.getAttribute('x')), y: Number(img.getAttribute('y')),
        w: Number(img.getAttribute('width')), h: Number(img.getAttribute('height')),
    };
    const cx = lens.x + lens.w / 2;
    const cy = lens.y + lens.h / 2;
    const zoom2 = {
        center: at(cx, cy),
        // 距镜片中心 85px：2 倍时对应原图 130+42.5=172.5（色块外），4 倍时对应 151（色块内）
        edge: at(cx + 85, cy),
    };
    return {lens, anchor: anchorOf(), zoom2, dpr: window.devicePixelRatio || 1};
})()`);

const readPixels = async (shot, pts) => evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${shot}";
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const dpr = ${patternGeom.dpr};
    const pts = ${JSON.stringify(pts)};
    return pts.map((p) => Array.from(ctx.getImageData(
        Math.round((p.x ?? p.clientX) * dpr), Math.round((p.y ?? p.clientY) * dpr), 1, 1).data).slice(0, 3));
})()`);

const shot2x = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "放大镜-锚点与显示框.png"), Buffer.from(shot2x.data, "base64"));
const px2x = await readPixels(shot2x.data, [patternGeom.zoom2.center, patternGeom.zoom2.edge]);

await evaluate(`document.querySelector('[data-action="magnifier-zoom"][data-value="4"]')?.click()`);
await sleep(400);
const shot4x = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "放大镜-4倍.png"), Buffer.from(shot4x.data, "base64"));
const px4x = await readPixels(shot4x.data, [patternGeom.zoom2.center, patternGeom.zoom2.edge]);

const isMagenta = (px) => Math.abs(px[0] - 219) < 26 && Math.abs(px[1] - 39) < 26 && Math.abs(px[2] - 119) < 26;
check("真实浏览器实拍：镜片中心就是锚点处的玫红色块（放大镜真的在采锚点周围的像素）",
    isMagenta(px2x[0]), JSON.stringify(px2x[0]));
check("真实浏览器实拍：距中心 85px 处 2 倍时已是底色、4 倍时被同一色块盖住（倍数真的生效）",
    !isMagenta(px2x[1]) && isMagenta(px4x[1]),
    `2x=${JSON.stringify(px2x[1])} 4x=${JSON.stringify(px4x[1])}`);

// 聚光灯：矩形 / 椭圆两种遮挡形态各来一张。
// 先重开一个新场景，否则放大镜会留在画面上，截图里看着像「聚光灯把放大镜也压暗了」。
await send("Page.reload", {});
let spotReady = false;
for (let i = 0; i < 120; i++) {
    const state = await evaluate(`({ready: window.__ready === true, search: location.search})`);
    if (state && state.ready && String(state.search).includes("asset=pattern")) {
        spotReady = true;
        break;
    }
    await sleep(100);
}
if (!spotReady) throw new Error("聚光灯截图页面未就绪");
await sleep(500);

const spotShots = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    q('button[data-tool="spotlight"]').click();
    await wait(60);
    fire('pointerdown', at(300, 470));
    fire('pointermove', at(600, 700));
    fire('pointerup', at(900, 700));
    await wait(120);
    q('[data-action="spotlight-shape"][data-value="rect"]')?.click();
    // 暗度会被上一次测试存成 80%，这里调回默认的 60% 再出图
    const slider = q('[data-ctx="spotlightOpacity"]');
    if (slider) {
        slider.value = '60';
        slider.dispatchEvent(new Event('input', {bubbles: true}));
    }
    await wait(150);
    return {ok: true};
})()`);
await sleep(400);
const shotSpotRect = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "聚光灯-矩形.png"), Buffer.from(shotSpotRect.data, "base64"));
await evaluate(`document.querySelector('[data-action="spotlight-shape"][data-value="ellipse"]')?.click()`);
await sleep(400);
const shotSpotEllipse = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "聚光灯-椭圆.png"), Buffer.from(shotSpotEllipse.data, "base64"));
check("真实浏览器：聚光灯矩形 / 椭圆两种形态的截图都已生成", spotShots.ok === true);

// 顶栏档位小窗 + 三段式：交付截图（编辑模式 → 点某一档）
// 注意：这里全部用同步 evaluate + Node 侧 sleep，避免页面里的 setTimeout 被节流时把流程挂住
await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    if (!q('[data-action="preset-cancel"]')) q('[data-action="settings"]')?.click();
    return true;
})()`);
await sleep(320);
await evaluate(`(() => {
    document.querySelector('[data-role="group-widths"] [data-index="2"]')?.click();
    return true;
})()`);
await sleep(420);
console.log("截图：属性悬浮条-线宽");
const widthPopShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "属性悬浮条-线宽.png"), Buffer.from(widthPopShot.data, "base64"));

await evaluate(`(() => {
    document.querySelector('[data-role="group-lines"] [data-index="1"]')?.click();
    return true;
})()`);
await sleep(420);
console.log("截图：属性悬浮条-线型");
const dashPopShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "属性悬浮条-线型.png"), Buffer.from(dashPopShot.data, "base64"));

await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    return true;
})()`);
await sleep(360);
console.log("截图：自定义预设-三段式");
const presetShot = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "自定义预设-三段式.png"), Buffer.from(presetShot.data, "base64"));
await evaluate(`document.querySelector('[data-action="preset-cancel"]')?.click()`);
await sleep(200);

// 白色遮罩：换成深色底图单独出一张（白色遮罩在深色图上才看得出效果）
await fetch(`http://127.0.0.1:${port}/__dark`);
await send("Page.navigate", {url: `http://127.0.0.1:${port}/?asset=dark.png`});
let darkReady = false;
for (let i = 0; i < 120; i++) {
    const state = await evaluate(`({ready: window.__ready === true, search: location.search})`);
    if (state && state.ready && String(state.search).includes("asset=dark")) {
        darkReady = true;
        break;
    }
    await sleep(100);
}
if (!darkReady) throw new Error("深色底图页面未就绪");
await sleep(500);
const whiteMaskShot = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const svg = q('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1200;
    const h = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x * rect.width / w, clientY: rect.top + y * rect.height / h});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY,
    }));
    q('button[data-tool="spotlight"]').click();
    await wait(60);
    fire('pointerdown', at(320, 210));
    fire('pointermove', at(700, 540));
    fire('pointerup', at(900, 540));
    await wait(150);
    q('[data-action="spotlight-shape"][data-value="rect"]')?.click();
    const slider = q('[data-ctx="spotlightOpacity"]');
    if (slider) {
        slider.value = '60';
        slider.dispatchEvent(new Event('input', {bubbles: true}));
    }
    q('[data-action="spotlight-color"][data-value="white"]')?.click();
    await wait(180);
    const gs = Array.from(document.querySelectorAll('[data-layer="objects"] g.annot-object:not(.is-preview)'));
    const mask = gs[gs.length - 1]?.querySelector('path.annot-shape');
    return {fill: mask?.getAttribute('fill') || ''};
})()`);
await sleep(400);
const whiteMaskPng = await send("Page.captureScreenshot", {format: "png"});
await writeFile(path.join(outDir, "聚光灯-白色遮罩.png"), Buffer.from(whiteMaskPng.data, "base64"));
check("真实浏览器：白色遮罩的实拍截图已生成（遮罩真的是半透明白）",
    whiteMaskShot.fill.startsWith("rgba(255, 255, 255"), whiteMaskShot.fill);

ws.close();
server.closeAllConnections?.();
server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n真实浏览器画线校验：${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
