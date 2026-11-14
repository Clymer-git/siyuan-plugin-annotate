/**
 * 方案 A4 预览图：在【真实运行的 dist 界面】上做增量改动，再截图。
 *
 * 与 A3 的差别：
 *  - 「对象 / 缩放」改成两颗等宽按钮（80×36），不再随文字变宽；
 *  - 新增顶部悬浮栏：把 PC 悬浮条上的工具专属参数（箭头样式 / 圆线 / 圆角 /
 *    编号格式 / 端点…）搬到手机上，每个参数一枚小方按钮，点开像气泡一样向下展开。
 *
 * 界面基底仍由 dist/index.js 真实渲染，脚本只追加/覆盖。
 * 前置：Edge 用 --headless=new --remote-debugging-port=9222 启动。
 * 用法：node scripts/_shot-mock-a4.mjs
 */
import http from "node:http";
import {readFile, writeFile, access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
const outDir = path.join(root, "deliverables", "mobile-ui-prototype", "shots");
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
        } else { res.statusCode = 404; res.end("not found"); }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
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
            JSON.stringify(result.exceptionDetails.exception?.description || ""));
    }
    return result.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
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

// ---- 真实画 3 个对象，"对象 3" 由插件自己数出来 ----
const drawn = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const cw = Number(svg.getAttribute('width')) || 1200;
    const ch = Number(svg.getAttribute('height')) || 800;
    const at = (x, y) => ({clientX: rect.left + x / cw * rect.width, clientY: rect.top + y / ch * rect.height});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY}));
    const pick = (tool) => {
        const btn = document.querySelector('.annot-mobile-rail [data-tool="' + tool + '"]');
        if (btn) btn.click();
        return !!btn;
    };
    const draw = (tool, x1, y1, x2, y2) => {
        if (!pick(tool)) return;
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    draw('arrow', 240, 640, 560, 340);
    draw('rect', 720, 240, 1100, 480);
    draw('ellipse', 940, 580, 1140, 740);
    // 停在"箭头工具"：顶部悬浮栏要显示「箭头样式 / 圆线」两枚按钮
    document.querySelectorAll('.annot-mobile-rail [data-tool="arrow"]')[0].click();
    return {
        objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
        zoom: window.__plugin?.editor?.viewport?.zoom ?? null,
        tool: (document.querySelector('.annot-mobile-rail .annot-mobile-tool.is-active') || {}).dataset?.tool || '',
    };
})()`);
console.log("已画对象:", JSON.stringify(drawn));

const shot = async (file, clip) => {
    const result = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false, clip, fromSurface: true});
    const buf = Buffer.from(result.data, "base64");
    await writeFile(path.join(outDir, file), buf);
    console.log("已截图:", file, (buf.length / 1024).toFixed(0) + "KB");
};

await sleep(300);
await shot("方案A4-0-改前.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

// ---- 增量改动 ----
const applied = await evaluate(`(() => {`
    + `const ed = window.__plugin && window.__plugin.editor;`
    + `const presets = ed ? ed.presets : null;`
    + `const current = ed ? ed.current : null;`
    // ---- 图标（viewBox 24×16，线宽 2）----
    + `const I = {`
        + `arrow: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><path d="M3 13.5L14.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12.6 2.2L21.2 5.2L13.6 10.4Z" fill="currentColor"/></svg>',`
        + `round: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><path d="M3 8H21" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>',`
        + `corner: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><path d="M4 14V8a5 5 0 0 1 5-5h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',`
        + `num: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><rect x="8" y="1.5" width="9" height="12.5" rx="2.4" stroke="currentColor" stroke-width="1.8"/><path d="M11.4 10.6V5.6l-1.3.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',`
        + `tip: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><path d="M3 11c6 0 9-2 12-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="17.6" cy="4.6" r="2.4" fill="currentColor"/></svg>',`
        + `zoom: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><circle cx="9.5" cy="7.5" r="4.6" stroke="currentColor" stroke-width="2"/><path d="M13.2 11.2L18.6 14.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',`
        + `shape: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><ellipse cx="12" cy="8" rx="7.6" ry="5.6" stroke="currentColor" stroke-width="2"/></svg>',`
        + `grid: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><rect x="2.6" y="2.6" width="8" height="10.8" rx="1.4" stroke="currentColor" stroke-width="1.7"/><rect x="13.4" y="2.6" width="8" height="10.8" rx="1.4" stroke="currentColor" stroke-width="1.7"/></svg>',`
        + `blur: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><circle cx="12" cy="8" r="2.6" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="8" r="6.2" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2.4"/></svg>',`
        + `mask: '<svg viewBox="0 0 24 16" width="22" height="15" fill="none"><path d="M12 1.6a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" stroke="currentColor" stroke-width="1.7"/><path d="M12 1.6a6.4 6.4 0 0 0 0 12.8Z" fill="currentColor"/></svg>',`
    + `};`
    // 七种箭头样式的示意图案（统一水平基线 y=8；两端箭头收小，中间留出可见的连接线）
    + `const AS = [`
        + `['基础','<path d="M2 8H15"/><path d="M14 3L22 8L14 13Z" fill="currentColor"/>'],`
        + `['经典','<path d="M2 8H15"/><path d="M14 3L22 8L14 13Q16.6 8 14 3Z" fill="currentColor"/>'],`
        + `['现代','<path d="M2 8H13" stroke-width="4"/><path d="M12 2.5L22 8L12 13.5Z" fill="currentColor"/>'],`
        + `['双头','<path d="M9 4L4 8L9 12Z" fill="currentColor"/><path d="M15 4L20 8L15 12Z" fill="currentColor"/><path d="M5 8H19"/>'],`
        + `['线条','<path d="M2 8H16"/><path d="M15 3.5L22 8L15 12.5"/>'],`
        + `['两端竖线','<path d="M5 8H19"/><path d="M5 3V13"/><path d="M19 3V13"/>'],`
        + `['竖线双头','<path d="M9.5 5L6 8L9.5 11"/><path d="M14.5 5L18 8L14.5 11"/><path d="M4 8H20"/><path d="M4 3V13"/><path d="M20 3V13"/>'],`
    + `].map(([label, body]) => ({label, svg: '<svg viewBox="0 0 24 16" width="30" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>'}));`
    // ---- 1) 顶部悬浮栏：把 PC 悬浮条上的工具专属参数搬过来 ----
    + `const stage = document.querySelector('.annot-stage') || document.querySelector('[data-role="stage"]');`
    + `const bar = document.createElement('div');`
    + `bar.className = 'mock-topbar';`
    + `const btn = (icon, label, cls) => '<button type="button" class="mock-tb-btn' + (cls || '') + '">' + icon`
        + ` + '<span>' + label + '</span></button>';`
    + `bar.innerHTML = btn(I.arrow, '箭头') + btn(I.round, '圆线', ' is-on');`
    + `const pop = document.createElement('div');`
    + `pop.className = 'mock-pop';`
    + `pop.hidden = true;`
    + `pop.innerHTML = AS.map((item, i) => '<button type="button" class="mock-pop__item' + (i === 1 ? ' is-active' : '')`
        + ` + '" title="' + item.label + '" aria-label="' + item.label + '"><span class="mock-pop__icon">'`
        + ` + item.svg + '</span></button>').join('');`
    + `bar.append(pop);`
    + `document.querySelector('.annot-root').append(bar);`
    // ---- 2) 缩放 / 对象：两颗等宽 80×36 按钮 ----
    + `const fabs = document.querySelector('.annot-mobile-fabs');`
    + `const zoomBtn = document.querySelector('.annot-mobile-zoom');`
    + `const zoomText = zoomBtn ? zoomBtn.textContent.trim() : '100%';`
    + `const objCount = document.querySelectorAll('[data-layer="objects"] g.annot-object').length;`
    + `const pair = document.createElement('div');`
    + `pair.className = 'mock-pair';`
    + `pair.innerHTML = '<button type="button" class="mock-pill">缩放<b>' + zoomText + '</b></button>'`
        + ` + '<button type="button" class="mock-pill">对象<b>' + objCount + '</b></button>';`
    + `fabs.append(pair);`
    // ---- 3) 属性栏：按 PC 顶栏重建五个分组框 ----
    + `const scroll = document.querySelector('[data-role="mobile-style"]');`
    + `const colors = presets ? presets.colors : ['#EF4444','#F59E0B','#10B981','#06B6D4','#8B5CF6'];`
    + `const widths = presets ? presets.lineWidths : [2,4,8,14];`
    + `const fills = presets ? presets.fillOpacities : [0,0.15,0.5,0.85];`
    + `const fonts = presets ? presets.fontSizes : [18,28,42,64];`
    + `const dash = current ? current.lineDash : 'solid';`
    + `const curColor = current ? current.color : colors[0];`
    + `const curWidth = current ? current.lineWidth : 4;`
    + `const curFill = current ? current.fillOpacity : 0;`
    + `const curFont = current ? current.fontSize : 28;`
    + `const group = (key, label, inner) => '<div class="annot-mobile-style__group mock-group" data-group="' + key + '">'`
        + ` + '<span class="annot-mobile-style__label">' + label + '</span>' + inner + '</div>';`
    + `const swatches = colors.map(hex => '<button type="button" class="annot-mobile-swatch'`
        + ` + (hex.toLowerCase() === String(curColor).toLowerCase() ? ' is-active' : '')`
        + ` + '" style="--annot-swatch-color:' + hex + '"></button>').join('')`
        + ` + '<button type="button" class="annot-mobile-swatch annot-mobile-swatch--custom"></button>';`
    + `const widthChips = widths.map(w => '<button type="button" class="annot-mobile-chip'`
        + ` + (w === curWidth ? ' is-active' : '') + '">'`
        + ` + '<span class="annot-mobile-chip__line" style="height:' + Math.min(6, Math.max(1.5, w)) + 'px"></span>'`
        + ` + '<span class="annot-mobile-chip__num">' + w + '</span></button>').join('');`
    + `const dashChips = [['solid','solid'],['dashed','6 4'],['dotted','1.6 3.4'],['dashdot','8 3 1.6 3']]`
        + `.map(([k, pattern]) => '<button type="button" class="annot-mobile-chip' + (k === dash ? ' is-active' : '')`
        + ` + '"><span class="mock-dash"><svg viewBox="0 0 22 10" width="22" height="10" fill="none">'`
        + ` + '<path d="M1 5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="' + pattern + '"/></svg></span></button>').join('');`
    + `const fillChips = fills.map(v => '<button type="button" class="annot-mobile-chip'`
        + ` + (Math.abs(v - curFill) < 0.001 ? ' is-active' : '') + '">' + Math.round(v * 100) + '%</button>').join('');`
    + `const fontChips = fonts.map(v => '<button type="button" class="annot-mobile-chip'`
        + ` + (v === curFont ? ' is-active' : '') + '">' + v + '</button>').join('');`
    + `scroll.innerHTML = group('colors','颜色',swatches) + group('widths','粗细',widthChips)`
        + ` + group('lines','线型',dashChips) + group('fills','填充',fillChips) + group('fonts','字号',fontChips);`
    + `const more = document.querySelector('.annot-mobile-style__more'); if (more) more.setAttribute('hidden','');`
    // ---- 样式 ----
    + `const st = document.createElement('style'); st.id = 'mock-a4';`
    + `st.textContent = \``
    + `/* 顶部悬浮栏 */`
    + `.mock-topbar { position:absolute; left:50%; transform:translateX(-50%); top:68px; z-index:40;`
        + `display:flex; gap:4px; padding:4px; border-radius:16px;`
        + `border:1px solid rgba(127,127,127,.14);`
        + `background: color-mix(in srgb, var(--annot-panel) 90%, transparent);`
        + `-webkit-backdrop-filter: blur(16px) saturate(1.6); backdrop-filter: blur(16px) saturate(1.6);`
        + `box-shadow: 0 4px 16px rgba(15,23,42,.13); }`
    + `.mock-tb-btn { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;`
        + `width:48px; height:42px; padding:0; border:0; border-radius:12px; background:transparent;`
        + `color: var(--annot-text); font-size:10px; line-height:1; white-space:nowrap; }`
    + `.mock-tb-btn.is-open { background: var(--annot-accent-soft); color: var(--annot-accent); font-weight:600; }`
    + `.mock-tb-btn.is-on { color: var(--annot-accent); }`
    + `/* 气泡：只留图案，不带文字 —— 一行四个，末行自动居中 */`
    + `.mock-pop { position:absolute; top:calc(100% + 9px); left:0; width:220px; padding:6px;`
        + `display:flex; flex-wrap:wrap; justify-content:center; gap:4px; border-radius:14px;`
        + `border:1px solid rgba(127,127,127,.14);`
        + `background: color-mix(in srgb, var(--annot-panel) 97%, transparent);`
        + `-webkit-backdrop-filter: blur(22px) saturate(1.7); backdrop-filter: blur(22px) saturate(1.7);`
        + `box-shadow: 0 12px 34px rgba(15,23,42,.22); }`
    + `.mock-pop[hidden] { display:none; }`
    + `.mock-pop::before { content:''; position:absolute; top:-5.5px; left:var(--tip-left, 20px); width:10px; height:10px;`
        + `transform:rotate(45deg); border-left:1px solid rgba(127,127,127,.14); border-top:1px solid rgba(127,127,127,.14);`
        + `border-radius:2px 0 0 0; background: color-mix(in srgb, var(--annot-panel) 97%, transparent); }`
    + `.mock-pop__item { display:flex; align-items:center; justify-content:center; width:48px; height:46px; padding:0;`
        + `border:0; border-radius:10px; background:transparent; color: var(--annot-text); }`
    + `.mock-pop__icon { display:flex; }`
    + `.mock-pop__item.is-active { background: var(--annot-accent-soft); color: var(--annot-accent);`
        + `box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--annot-accent) 42%, transparent); }`
    + `/* 缩放 / 对象：等宽同款 */`
    + `.mock-pair { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; gap:8px; pointer-events:auto; }`
    + `.mock-pill { display:inline-flex; align-items:baseline; justify-content:center; gap:5px;`
        + `width:80px; height:36px; padding:0; border:1px solid rgba(127,127,127,.16); border-radius:11px;`
        + `background: color-mix(in srgb, var(--annot-panel) 88%, transparent);`
        + `-webkit-backdrop-filter: blur(14px) saturate(1.6); backdrop-filter: blur(14px) saturate(1.6);`
        + `box-shadow: 0 2px 8px rgba(15,23,42,.10); color: var(--annot-text-weak);`
        + `font-size:12px; line-height:34px; white-space:nowrap; }`
    + `.mock-pill b { font-size:13px; font-weight:700; color: var(--annot-text); }`
    + `.annot-root--mobile .annot-mobile-zoom { display:none !important; }`
    + `/* 属性栏五组 */`
    + `.annot-root--mobile .annot-mobile-style { margin: 0 10px 10px; }`
    + `.annot-root--mobile .annot-mobile-style__scroll { padding: 6px 10px; gap:0; }`
    + `.annot-root--mobile .mock-group { padding:0 7px; margin-right:7px; height:38px;`
        + `border:1px solid rgba(127,127,127,.15); border-radius:12px;`
        + `background: color-mix(in srgb, var(--annot-panel) 82%, transparent);`
        + `-webkit-backdrop-filter: blur(14px) saturate(1.6); backdrop-filter: blur(14px) saturate(1.6);`
        + `box-shadow: 0 2px 8px rgba(15,23,42,.07); }`
    + `.annot-root--mobile .mock-group:last-child { margin-right:0; }`
    + `.annot-root--mobile .mock-group > .annot-mobile-chip { border:0; background:transparent; box-shadow:none;`
        + `-webkit-backdrop-filter:none; backdrop-filter:none; min-width:34px; padding:0 7px; height:32px; border-radius:8px; }`
    + `.annot-root--mobile .mock-group > .annot-mobile-chip.is-active { background: var(--annot-accent-soft); color: var(--annot-accent); font-weight:700; }`
    + `.annot-root--mobile .mock-group > .annot-mobile-swatch { width:26px; height:26px; }`
    + `.annot-root--mobile .mock-group > .annot-mobile-swatch.is-active { box-shadow: inset 0 0 0 1px rgba(0,0,0,.14), 0 0 0 2px var(--annot-panel), 0 0 0 3.5px var(--annot-accent); }`
    + `/* 底部一整条 dock */`
    + `.annot-root--mobile .annot-mobile-rail { position:relative; }`
    + `.annot-root--mobile .annot-mobile-rail::before { content:''; position:absolute; inset:-3px 0 -1px; z-index:0;`
        + `border:1px solid rgba(127,127,127,.15); border-radius:22px;`
        + `background: color-mix(in srgb, var(--annot-panel) 88%, transparent);`
        + `-webkit-backdrop-filter: blur(18px) saturate(1.7); backdrop-filter: blur(18px) saturate(1.7);`
        + `box-shadow: 0 6px 22px rgba(15,23,42,.13); }`
    + `.annot-root--mobile .annot-mobile-rail > * { position:relative; z-index:1; }`
    + `.annot-root--mobile .annot-mobile-tool { background:transparent !important; box-shadow:none !important;`
        + `border:0 !important; backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }`
    + `.annot-root--mobile .annot-mobile-tool.is-active { background: var(--annot-accent-soft) !important; color: var(--annot-accent) !important; }`
    + `.mock-dash { display:flex; align-items:center; }`
    + `\`;`
    + `document.head.append(st);`
    // 气泡定位必须在样式落地之后算：样式还没注入时 .mock-topbar 不是 absolute，
    // getBoundingClientRect 会返回 left:0，气泡就会跑偏。
    + `const TB_W = 48, TB_PAD = 4, POP_W = 220;`
    + `const barRect = bar.getBoundingClientRect();`
    + `const popLeftAbs = (window.innerWidth - POP_W) / 2;`
    + `pop.style.left = Math.round(popLeftAbs - barRect.left) + 'px';`
    + `const btnCenterAbs = barRect.left + TB_PAD + TB_W / 2;`
    + `pop.style.setProperty('--tip-left', Math.round(btnCenterAbs - popLeftAbs - 5) + 'px');`
    + `const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();`
        + `return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };`
    + `return {`
        + `zoomText, objCount, tool: ${JSON.stringify(drawn.tool)},`
        + `centerX: (() => { const r = pair.getBoundingClientRect(); return Math.round(r.x + r.width/2); })(),`
        + `pillBox: box(pair.querySelector('.mock-pill')), pairBox: box(pair),`
        + `topbarBox: box(bar), popBox: box(pop), stageBox: box(stage),`
        + `groups: [...scroll.querySelectorAll('.mock-group')].map(g => g.dataset.group),`
        + `scrollWidth: scroll.scrollWidth, scrollClient: scroll.clientWidth,`
    + `};`
    + `})()`);
console.log("增量改动:", JSON.stringify(applied, null, 2));

await sleep(350);
await shot("方案A4-1-常态.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

// 点开「箭头」小按钮 → 气泡向下展开
await evaluate(`(() => {
    const pop = document.querySelector('.mock-pop');
    pop.hidden = false;
    document.querySelectorAll('.mock-tb-btn')[0].classList.add('is-open');
    return true;
})()`);
await sleep(300);
const popMeasured = await evaluate(`(() => {
    const pop = document.querySelector('.mock-pop');
    const bar = document.querySelector('.mock-topbar');
    const r = pop.getBoundingClientRect(), b = bar.getBoundingClientRect();
    const tip = getComputedStyle(pop).getPropertyValue('--tip-left');
    return {pop: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            bar: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
            inlineLeft: pop.style.left, tipLeft: tip, vw: innerWidth};
})()`);
console.log("气泡实测:", JSON.stringify(popMeasured));
await shot("方案A4-2-箭头样式气泡.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

// 顶部悬浮栏特写（放大看按钮与气泡）
await shot("方案A4-3-顶部栏特写.png", {x: 0, y: 50, width: 390, height: 300, scale: 3});

// 属性栏右段（字号）
await evaluate(`(() => { const s = document.querySelector('[data-role="mobile-style"]'); s.scrollLeft = s.scrollWidth; return s.scrollLeft; })()`);
await sleep(350);
await shot("方案A4-4-属性栏右段.png", {x: 0, y: 0, width: 390, height: 844, scale: 2});

ws.close();
server.close();
process.exit(0);
