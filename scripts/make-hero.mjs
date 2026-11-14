/**
 * 生成两张宣传效果图（按用户参考稿：手机竖立在左、笔记本正面直视、键盘面只露薄边、纯白底柔和投影）。
 *
 * 两张界面图都不是画的，是 dist 里真插件在浏览器里跑出来截的；
 * 样机用页面内 canvas 画（不走 Page.captureScreenshot——这个 Edge 在带大图的合成页上等不到帧）。
 *
 * 输出：
 *   hero-combo.png  1024×768  笔记本 + 手机组合（README 首图）
 *   hero-phone.png  1024×768  手机单机放大（移动端介绍用）
 *
 * 前置：Edge 已用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 * 用法：node scripts/make-hero.mjs
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

const shots = {pc: null, phone: null};

const server = http.createServer(async (req, res) => {
    try {
        const url = (req.url || "/").split("?")[0];
        if (url === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(await readFile(harnessFile));
        } else if (url === "/compose") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end("<!doctype html><meta charset='utf-8'><body></body>");
        } else if (url === "/shot/pc.png" || url === "/shot/phone.png") {
            const buf = shots[url.includes("pc") ? "pc" : "phone"];
            if (!buf) { res.statusCode = 404; res.end("no"); return; }
            res.setHeader("Content-Type", "image/png");
            res.end(buf);
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
            // 底图用设计原稿（真实插画），不要用 harness 的合成占位图
            const p = path.join(root, "design", "icon-source.jpg");
            if (!(await exists(p))) { res.statusCode = 404; res.end("no"); return; }
            res.setHeader("Content-Type", "image/jpeg");
            res.end(await readFile(p));
        } else {
            res.statusCode = 404;
            res.end("not found");
        }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const capture = async (clip, label = "") => {
    const t0 = Date.now();
    const result = await Promise.race([
        send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false, clip, fromSurface: true}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("capture timeout: " + label)), 25000)),
    ]);
    console.log(`  [截图 ${label}] ${Date.now() - t0}ms`);
    return Buffer.from(result.data, "base64");
};
const boot = async (width, height, mobile, dsf) => {
    await send("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: dsf, mobile});
    await send("Page.navigate", {url: `http://127.0.0.1:${port}/?r=${Date.now()}`});
    for (let i = 0; i < 90; i++) {
        if (await evaluate("window.__ready === true")) break;
        await sleep(100);
    }
    await evaluate(`fetch('/theme.css').then(r => r.text()).then(t => {
        const el = document.createElement('style'); el.id = 'theme-inject';
        el.textContent = t; document.head.append(el);
    })`);
    // 棋盘格是「透明区域」的提示，宣传图里留着像没画满，换成纯白
    await evaluate(`(() => {
        const st = document.createElement('style');
        st.textContent = '.annot-stage{background-image:none!important;background:#FFFFFF!important}';
        document.head.append(st);
        return true;
    })()`);
    await sleep(400);
};

await send("Page.enable");
await send("Runtime.enable");

// ---------------------------------------------------------------- 1) 电脑界面
await boot(1440, 900, false, 1.5);
const pcDrawn = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1024;
    const h = Number(svg.getAttribute('height')) || 1194;
    const at = (x, y) => ({clientX: rect.left + x / w * rect.width, clientY: rect.top + y / h * rect.height});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY}));
    const tool = (t) => document.querySelector('.annot-imagebar [data-tool="' + t + '"]')?.click();
    const draw = (t, x1, y1, x2, y2) => {
        tool(t);
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    // 与正文预览图完全一致：同一张猫图、同一个红圈（圈住右爪）、同一条线宽
    document.querySelector('[data-preset="lineWidth"][data-value="8"]')?.click();
    draw('ellipse', 548, 452, 866, 772);
    tool('ellipse');
    return {size: {w, h}, objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length};
})()`);
console.log("电脑端:", JSON.stringify(pcDrawn));
await sleep(300);
shots.pc = await capture({x: 0, y: 0, width: 1440, height: 900, scale: 1.5}, "pc");

// ---------------------------------------------------------------- 2) 手机界面
await boot(390, 844, true, 2);
const phoneDrawn = await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    const rect = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || 1024;
    const h = Number(svg.getAttribute('height')) || 1194;
    const at = (x, y) => ({clientX: rect.left + x / w * rect.width, clientY: rect.top + y / h * rect.height});
    const fire = (type, p) => svg.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: p.clientX, clientY: p.clientY}));
    const tool = (t) => document.querySelector('.annot-mobile-rail [data-tool="' + t + '"]')?.click();
    const draw = (t, x1, y1, x2, y2) => {
        tool(t);
        fire('pointerdown', at(x1, y1));
        fire('pointermove', at((x1 + x2) / 2, (y1 + y2) / 2));
        fire('pointerup', at(x2, y2));
    };
    // 手机缩放约 36%，线宽拉到最大一档才看得见；圈的是同一只爪
    document.querySelector('[data-preset="lineWidth"][data-value="14"]')?.click();
    draw('ellipse', 548, 452, 866, 772);
    // 画布再放大一点，画面才不至于缩成一小块白底里的小图
    const ed = window.__plugin?.editor;
    if (ed && ed.viewport) {
        const stage = document.querySelector('.annot-stage').getBoundingClientRect();
        const cx = stage.width / 2, cy = stage.height / 2;
        const k = 1.55;
        ed.viewport = {...ed.viewport, zoom: ed.viewport.zoom * k,
            panX: cx - (cx - ed.viewport.panX) * k,
            panY: cy - (cy - ed.viewport.panY) * k};
        ed.applyViewport?.();
    }
    // 停在箭头工具上，顶部参数栏（箭头样式 / 圆线）才会出现
    tool('arrow');
    return {objects: document.querySelectorAll('[data-layer="objects"] g.annot-object').length,
        topbar: [...document.querySelectorAll('.annot-mobile-topbar__btn')].map((b) => b.textContent.trim())};
})()`);
console.log("手机端:", JSON.stringify(phoneDrawn));
await sleep(300);
shots.phone = await capture({x: 0, y: 0, width: 390, height: 844, scale: 2}, "phone");

// ---------------------------------------------------------------- 3) 合成
await send("Emulation.setDeviceMetricsOverride", {width: 1024, height: 768, deviceScaleFactor: 1, mobile: false});
await send("Page.navigate", {url: `http://127.0.0.1:${port}/compose`});
await sleep(600);

const renderHero = (mode) => evaluate(`(async () => {
    const MODE = "${mode}";
    const load = (src) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("load " + src));
        img.src = src;
    });
    const [pc, phone] = await Promise.all([load("/shot/pc.png"), load("/shot/phone.png")]);

    const W = 1024, H = 768;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    const rr = (x, y, w, h, r) => {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
        else ctx.rect(x, y, w, h);
    };
    const shadow = (on, blur, dy, alpha) => {
        ctx.shadowColor = on ? "rgba(15,23,42," + alpha + ")" : "transparent";
        ctx.shadowBlur = on ? blur : 0;
        ctx.shadowOffsetY = on ? dy : 0;
    };
    // 地面柔影：椭圆径向渐变（比 shadowBlur 更可控，也不会拖慢合成）
    const groundShadow = (cx, cy, rx, ry, alpha) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        g.addColorStop(0, "rgba(24,32,48," + alpha + ")");
        g.addColorStop(0.5, "rgba(24,32,48," + (alpha * 0.42) + ")");
        g.addColorStop(1, "rgba(24,32,48,0)");
        ctx.save();
        ctx.translate(cx, cy); ctx.scale(1, ry / rx); ctx.translate(-cx, -cy);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, rx, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
    };

    // 纯白底（参考图就是白底，不要渐变和光斑）
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);

    // ---------- 透视贴图：把矩形图贴到任意四边形上（逐列仿射切片，等价于真透视） ----------
    const lerpP = (a, b, t) => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
    const quadPath = (p, r) => {
        ctx.beginPath();
        ctx.moveTo(p.tl.x + r, p.tl.y);
        ctx.lineTo(p.tr.x - r, p.tr.y);
        ctx.quadraticCurveTo(p.tr.x, p.tr.y, p.tr.x, p.tr.y + r);
        ctx.lineTo(p.br.x, p.br.y - r);
        ctx.quadraticCurveTo(p.br.x, p.br.y, p.br.x - r, p.br.y);
        ctx.lineTo(p.bl.x + r, p.bl.y);
        ctx.quadraticCurveTo(p.bl.x, p.bl.y, p.bl.x, p.bl.y - r);
        ctx.lineTo(p.tl.x, p.tl.y + r);
        ctx.quadraticCurveTo(p.tl.x, p.tl.y, p.tl.x + r, p.tl.y);
        ctx.closePath();
    };
    const quadFill = (p, r, style) => {
        quadPath(p, r);
        ctx.fillStyle = style;
        ctx.fill();
    };
    const drawQuadImage = (img, q, steps) => {
        const W = img.width, H = img.height, colW = W / steps;
        ctx.save();
        quadPath(q, 2);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        // ① 先用整块仿射铺一层底（只当补缝用）：逐列切片之间哪怕漏 0.2px，
        //    露出的也是这层底图的颜色，而不是白底。
        const ax = (q.tr.x - q.tl.x) / W, ay = (q.tr.y - q.tl.y) / W;
        const cx = (q.bl.x - q.tl.x) / H, cy = (q.bl.y - q.tl.y) / H;
        ctx.save();
        ctx.transform(ax, ay, cx, cy, q.tl.x, q.tl.y);
        ctx.drawImage(img, 0, 0);
        ctx.restore();

        // ② 逐列精修：源图按整数像素取，目标不重叠 —— 重叠会让同一列被采样两次，
        //    在陡斜的边上就是那一片片斜向摩尔纹。
        for (let i = 0; i < steps; i++) {
            const u0 = i / steps, u1 = (i + 1) / steps;
            const t0 = lerpP(q.tl, q.tr, u0), t1 = lerpP(q.tl, q.tr, u1);
            const b0 = lerpP(q.bl, q.br, u0), b1 = lerpP(q.bl, q.br, u1);
            const sx0 = Math.round(i * colW);
            const sx1 = Math.round((i + 1) * colW);
            const sw = Math.max(1, sx1 - sx0);
            const a = (t1.x - t0.x) / sw, b = (t1.y - t0.y) / sw;
            const c = (b0.x - t0.x) / H, d = (b0.y - t0.y) / H;
            ctx.save();
            ctx.transform(a, b, c, d, t0.x, t0.y);
            ctx.drawImage(img, sx0, 0, sw, H, 0, 0, sw, H);
            ctx.restore();
        }
        ctx.restore();
    };
    // 在四边形内按 (u,v) 取点：u 沿上/下边，v 从后沿到前沿
    const qPoint = (q, u, v) => lerpP(lerpP(q.tl, q.tr, u), lerpP(q.bl, q.br, u), v);

    // ---------- 笔记本：照参考稿量四角（黑边框、屏幕向右掠过去、键盘面完整可见） ----------
    const drawLaptop = () => {
        // 参考稿是 1080×657，按本画布等比缩放后量出来的四个角
        const frame = {
            tl: {x: 224, y: 159}, tr: {x: 716, y: 173},
            br: {x: 810, y: 556}, bl: {x: 229, y: 530},
        };
        // 屏幕可视区：在边框里按 (u,v) 内缩，透视下四边看起来才等厚
        const scr = {
            tl: qPoint(frame, 0.030, 0.035), tr: qPoint(frame, 0.970, 0.035),
            br: qPoint(frame, 0.970, 0.950), bl: qPoint(frame, 0.030, 0.950),
        };
        // 键盘面：后沿 = 外框底边，前沿更宽更低（俯视透视）
        const deck = {
            tl: {x: 229, y: 530}, tr: {x: 810, y: 556},
            br: {x: 893, y: 608}, bl: {x: 205, y: 585},
        };

        groundShadow(512, 612, 386, 18, 0.15);

        // ---- 底座（键盘面 + 前沿厚度） ----
        const deckGrad = ctx.createLinearGradient(0, 530, 0, 610);
        deckGrad.addColorStop(0, "#C6CAD1");
        deckGrad.addColorStop(0.45, "#B9BDC5");
        deckGrad.addColorStop(1, "#A7ABB3");
        quadFill(deck, 6, deckGrad);

        // 键位：15 列 × 5 行白键，最后一排中间让给空格
        const cols = 15, rows = 5;
        const uPad = 0.11, vPad = 0.12;
        const uStep = (1 - uPad * 2) / cols;
        const vStep = (1 - vPad * 2) / rows;
        const keyPaint = (u0, u1, v0, v1, alpha) => {
            const kq = {
                tl: qPoint(deck, u0, v0), tr: qPoint(deck, u1, v0),
                br: qPoint(deck, u1, v1), bl: qPoint(deck, u0, v1),
            };
            quadFill(kq, 1.2, "rgba(255,255,255," + alpha.toFixed(3) + ")");
        };
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (r === rows - 1 && c >= 4 && c <= 10) continue;
                const u0 = uPad + c * uStep + 0.003, u1 = u0 + uStep - 0.006;
                const v0 = vPad + r * vStep + 0.010, v1 = v0 + vStep - 0.022;
                keyPaint(u0, u1, v0, v1, 0.99 - r * 0.025);
            }
        }
        {
            const v0 = vPad + (rows - 1) * vStep + 0.010;
            const v1 = v0 + vStep - 0.022;
            keyPaint(uPad + 4 * uStep + 0.003, uPad + 11 * uStep - 0.006, v0, v1, 0.98);
        }

        // 键盘两侧的扬声器格栅（真机都有，缺了就像没开孔）
        for (const [uA, uB] of [[0.025, 0.095], [0.905, 0.975]]) {
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 3; c++) {
                    const u = uA + (uB - uA) * (c / 2);
                    const v = 0.14 + (0.72) * (r / 6);
                    const pt = qPoint(deck, u, v);
                    ctx.fillStyle = "rgba(104,110,120,0.55)";
                    ctx.beginPath();
                    ctx.arc(pt.x, pt.y, 1.25, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // 前沿厚度
        quadFill({
            tl: deck.bl, tr: deck.br,
            br: {x: deck.br.x - 4, y: deck.br.y + 8}, bl: {x: deck.bl.x + 5, y: deck.bl.y + 8},
        }, 3, "#8D9299");

        // ---- 屏幕：黑边框 ----
        shadow(true, 32, 16, 0.22);
        const bez = ctx.createLinearGradient(frame.tl.x, frame.tl.y, frame.br.x, frame.br.y);
        bez.addColorStop(0, "#3E4248");
        bez.addColorStop(0.35, "#24272C");
        bez.addColorStop(0.75, "#191C20");
        bez.addColorStop(1, "#2B2F35");
        quadFill(frame, 10, bez);
        shadow(false, 0, 0, 0);
        quadPath(frame, 10);
        ctx.strokeStyle = "rgba(255,255,255,0.20)";
        ctx.lineWidth = 1.1;
        ctx.stroke();

        // 屏幕内容（真透视贴图）
        drawQuadImage(pc, scr, 900);

        // 边框内侧的暗边，把画面压进玻璃里
        quadPath(scr, 2);
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // 玻璃反光
        ctx.save();
        quadPath(scr, 2);
        ctx.clip();
        const gl = ctx.createLinearGradient(scr.tl.x, scr.tl.y, scr.bl.x + 460, scr.bl.y);
        gl.addColorStop(0, "rgba(255,255,255,0.13)");
        gl.addColorStop(0.24, "rgba(255,255,255,0.04)");
        gl.addColorStop(0.5, "rgba(255,255,255,0)");
        ctx.fillStyle = gl;
        ctx.fillRect(0, 0, 1024, 768);
        ctx.restore();

        // 摄像头：上边框正中一个点
        const camY = (frame.tl.y + frame.tr.y) / 2;
        ctx.fillStyle = "#0A0C0F";
        ctx.beginPath();
        ctx.arc((frame.tl.x + frame.tr.x) / 2, camY + 6.5, 2.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(120,150,190,0.75)";
        ctx.beginPath();
        ctx.arc((frame.tl.x + frame.tr.x) / 2, camY + 6.5, 0.9, 0, Math.PI * 2);
        ctx.fill();
    };

    // ---------- 手机：黑边框全面屏（无刘海、无挖孔），顺时针微倾 ----------
    const drawPhone = (cx, bottom, PW, tilt) => {
        const pPad = Math.round(PW * 0.038);
        const innerW = PW - pPad * 2;
        const innerH = innerW * 844 / 390;
        const PH = innerH + pPad * 2;
        ctx.save();
        ctx.translate(cx, bottom - PH / 2);
        ctx.rotate(tilt);
        const hw = PW / 2, hh = PH / 2;
        const rad = PW * 0.115;

        groundShadow(2, hh + 12, PW * 0.56, 15, 0.16);

        // 机身厚度（右侧露一点）
        ctx.fillStyle = "#5E636B";
        rr(-hw + 3.5, -hh + 3, PW, PH, rad);
        ctx.fill();

        // 黑色前框（不锈钢黑）
        shadow(true, 24, 12, 0.28);
        const frame = ctx.createLinearGradient(-hw, -hh, hw, hh);
        frame.addColorStop(0, "#33373E");
        frame.addColorStop(0.3, "#1B1E23");
        frame.addColorStop(0.7, "#12151A");
        frame.addColorStop(1, "#2A2E35");
        ctx.fillStyle = frame;
        rr(-hw, -hh, PW, PH, rad);
        ctx.fill();
        shadow(false, 0, 0, 0);
        ctx.strokeStyle = "rgba(255,255,255,0.26)";
        ctx.lineWidth = 1;
        rr(-hw + 0.5, -hh + 0.5, PW - 1, PH - 1, rad);
        ctx.stroke();

        // 侧键
        ctx.fillStyle = "#4A4F57";
        rr(hw - 1.6, -hh + PH * 0.235, 2.4, PH * 0.095, 1.2); ctx.fill();
        rr(-hw - 0.9, -hh + PH * 0.185, 2.4, PH * 0.06, 1.2); ctx.fill();
        rr(-hw - 0.9, -hh + PH * 0.265, 2.4, PH * 0.06, 1.2); ctx.fill();

        // 屏幕（全面屏，无刘海）
        const ix = -innerW / 2, iy = -innerH / 2;
        ctx.save();
        rr(ix, iy, innerW, innerH, PW * 0.098);
        ctx.clip();
        ctx.drawImage(phone, ix, iy, innerW, innerH);
        const pg = ctx.createLinearGradient(ix, iy, ix + innerW, iy + innerH * 0.5);
        pg.addColorStop(0, "rgba(255,255,255,0.10)");
        pg.addColorStop(0.3, "rgba(255,255,255,0.025)");
        pg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = pg;
        ctx.fillRect(ix, iy, innerW, innerH);
        ctx.save();
        ctx.translate(ix, iy);
        ctx.rotate(-0.5);
        const band = ctx.createLinearGradient(-innerW * 0.1, 0, innerW * 0.55, 0);
        band.addColorStop(0, "rgba(255,255,255,0)");
        band.addColorStop(0.45, "rgba(255,255,255,0.05)");
        band.addColorStop(0.62, "rgba(255,255,255,0.085)");
        band.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = band;
        ctx.fillRect(-innerW, -innerH, innerW * 2.4, innerH * 2.6);
        ctx.restore();
        ctx.restore();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1.4;
        rr(ix, iy, innerW, innerH, PW * 0.098);
        ctx.stroke();

        ctx.restore();
    };

    if (MODE === "combo") {
        drawLaptop();
        drawPhone(168, 562, 160, 0.067);
    } else {
        drawPhone(512, 704, 268, 0);
    }

    window.__lastCanvas = canvas;
    return canvas.toDataURL("image/png");
})()`);

const save = async (dataUrl, name) => {
    const base64 = String(dataUrl).split(",")[1] || "";
    const buf = Buffer.from(base64, "base64");
    await writeFile(path.join(outDir, name), buf);
    console.log("合成图:", name, (buf.length / 1024).toFixed(0) + "KB");
};

for (const [mode, name] of [["combo", "hero-combo"], ["phone", "hero-phone"]]) {
    await save(await renderHero(mode), name + ".png");
    // 集市预览图上限 512KB：再压一版 JPEG，打包时按体积二选一
    const jpg = await evaluate(`window.__lastCanvas.toDataURL("image/jpeg", 0.92)`);
    await save(jpg, name + ".jpg");
}

ws.close();
server.close();
process.exit(0);
