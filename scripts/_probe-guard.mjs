/**
 * 双指防误画的逻辑验证（不依赖 CDP 的触摸注入，改用页面内合成真实事件对象）。
 *
 * 为什么要这样：CDP 的 Input.dispatchTouchEvent 在这台机器的 headless 里时灵时不灵，
 * 之前一次能改 zoom、之后全空。改成在页面里 new TouchEvent / new PointerEvent 派发，
 * 事件语义（touches.length、pointerType、冒泡路径）和真机一致，能稳定复跑。
 *
 * 前置：Edge 用 --headless=new --remote-debugging-port=9222 启动；dist 已构建。
 */
import http from "node:http";
import {readFile, access} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const harnessFile = path.join(root, "scripts", "browser-harness.html");
const dayFile = "D:/WorkBuddy/siyuan-plugin/siyuan-src/siyuan-master/app/appearance/themes/daylight/theme.css";
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

// 页面内的合成工具：统一维护「当前在屏幕上的手指」
await evaluate(`(() => {
    const stage = document.querySelector('.annot-stage');
    const svg = document.querySelector('[data-role="svg"]');
    const state = {live: [], next: 1};
    const mkTouch = (id, x, y) => new Touch({
        identifier: id, target: svg, clientX: x, clientY: y, pageX: x, pageY: y,
        radiusX: 12, radiusY: 12, force: 1,
    });
    const ptr = (type, id, x, y) => new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: id, pointerType: "touch", isPrimary: id === 1,
        button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y,
    });
    const touchEvt = (type, list, changed) => new TouchEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        touches: list.map((p) => mkTouch(p.id, p.x, p.y)),
        targetTouches: list.map((p) => mkTouch(p.id, p.x, p.y)),
        changedTouches: changed.map((p) => mkTouch(p.id, p.x, p.y)),
    });
    // down: [[x,y], ...] ；up: [id, ...] ；move: 全量坐标
    window.__finger = {
        down(points) {
            const added = points.map(([x, y]) => ({id: state.next++, x, y}));
            state.live.push(...added);
            for (const p of added) svg.dispatchEvent(ptr("pointerdown", p.id, p.x, p.y));
            stage.dispatchEvent(touchEvt("touchstart", state.live, added));
            return added.map((p) => p.id);
        },
        move(coords) {
            state.live.forEach((p, i) => {
                if (!coords[i]) return;
                p.x = coords[i][0]; p.y = coords[i][1];
                svg.dispatchEvent(ptr("pointermove", p.id, p.x, p.y));
            });
            stage.dispatchEvent(touchEvt("touchmove", state.live, state.live));
        },
        up(ids) {
            const gone = state.live.filter((p) => ids.includes(p.id));
            state.live = state.live.filter((p) => !ids.includes(p.id));
            for (const p of gone) {
                // 派发给 <svg>：它既在 stage 内（stage 的捕获监听收得到），
                // 又能一路冒泡到 window（endTouch 挂在 window 上）
                svg.dispatchEvent(ptr("pointerup", p.id, p.x, p.y));
            }
            stage.dispatchEvent(touchEvt("touchend", state.live, gone));
        },
        reset() { state.live = []; state.next = 1; },
    };
    window.__probe = () => {
        const ed = window.__plugin && window.__plugin.editor;
        return {
            objects: (ed && ed.scene && ed.scene.objects) ? ed.scene.objects.length : -1,
            draft: !!document.querySelector('[data-layer="overlay"] [data-draft], .annot-draft'),
            locked: ed ? ed.gestureLocked : null,
            touches: ed ? ed.touchPoints.size : null,
            zoom: Number((((ed && ed.viewport.zoom) || 1) * 100).toFixed(1)),
        };
    };
    window.__pick = (tool) => {
        document.querySelector('.annot-fab[data-action="mobile-select"]')?.click();
        if (tool && tool !== 'select') document.querySelector('.annot-mobile-rail [data-tool="' + tool + '"]')?.click();
        return true;
    };
    window.__clear = () => {
        const ed = window.__plugin && window.__plugin.editor;
        if (ed && ed.scene && ed.scene.objects.length) {
            ed.scene.objects.length = 0;
            ed.render();
        }
        window.__finger.reset();
        return window.__probe();
    };
    return true;
})()`);

const probe = () => evaluate("window.__probe()");
const results = [];
const log = (name, data) => { results.push({name, ...data}); console.log(name, JSON.stringify(data)); };

const clear = () => evaluate("window.__clear()");
const pick = (t) => evaluate(`window.__pick(${JSON.stringify(t)})`);
const down = (pts) => evaluate(`window.__finger.down(${JSON.stringify(pts)})`);
const move = (pts) => evaluate(`window.__finger.move(${JSON.stringify(pts)})`);
const up = (ids) => evaluate(`window.__finger.up(${JSON.stringify(ids)})`);

// ---- 场景一：单指拖出一截 → 第二指落下 → 张开 → 松手，全程不许落笔 ----
await clear();
await pick("rect");
await down([[140, 420]]);
await move([[160, 430]]);
const beforePinch = await probe();
await down([[260, 400]]);
const afterPinch = await probe();
await move([[110, 420], [290, 400]]);
await move([[80, 420], [320, 400]]);
await up([1]);
await up([2]);
const afterPinchUp = await probe();
log("场景一 双指中途加入", {beforePinch, afterPinch, afterPinchUp});

// ---- 场景二：纯单指必须能画出来 ----
await clear();
await pick("rect");
await down([[120, 360]]);
await move([[160, 390]]);
await move([[200, 420]]);
await up([1]);
log("场景二 纯单指拖拽", await probe());

// ---- 场景三：锁着的时候，就算 pointerdown 从别处漏进来也不能建草稿 ----
await clear();
await pick("rect");
await down([[150, 420]]);
await down([[280, 420]]);
const lockedNow = await probe();
await evaluate(`(() => {
    const svg = document.querySelector('[data-role="svg"]');
    for (const [type, x, y] of [["pointerdown", 200, 400], ["pointermove", 260, 460]]) {
        svg.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true,
            pointerId: 9, pointerType: "touch", button: 0, buttons: 1, clientX: x, clientY: y}));
    }
    return true;
})()`);
const forced = await probe();
await up([1]);
await up([2]);
const unlocked = await probe();
log("场景三 锁定期强行派发 pointerdown", {lockedNow, forced, unlocked});

// ---- 场景四：解锁之后单指还能画 ----
await clear();
await pick("rect");
await down([[200, 500]]);
await move([[250, 540]]);
await up([1]);
log("场景四 解锁后再单指画", await probe());

// ---- 场景五：一指按住不动 + 另一指滑动 = 类 Shift 约束（矩形应变正方形） ----
await clear();
await pick("rect");
const st = () => evaluate(`(() => {
    const ed = window.__plugin.editor;
    return {mode: ed.gestureMode, locked: ed.gestureLocked,
        start: [...ed.gestureStart.entries()].map(([k, v]) => k + ":" + Math.round(v.x) + "," + Math.round(v.y)),
        cur: [...ed.touchPoints.entries()].map(([k, v]) => k + ":" + Math.round(v.x) + "," + Math.round(v.y)),
        drag: !!ed.drag, zoom: Number((ed.viewport.zoom * 100).toFixed(1))};
})()`);
await down([[100, 400]]);
console.log("  step1 一指", JSON.stringify(await st()));
await down([[300, 300]]);
console.log("  step2 两指", JSON.stringify(await st()));
await move([[100, 400], [360, 360]]);
console.log("  step3 move", JSON.stringify(await st()));
await move([[100, 400], [420, 420]]);
console.log("  step4 move", JSON.stringify(await st()));
const constrainNow = await probe();
await up([2]);
await up([1]);
const constrainDone = await evaluate(`(() => {
    const ed = window.__plugin.editor;
    const o = ed.scene.objects[0];
    return {count: ed.scene.objects.length,
        geometry: o ? JSON.stringify(o.geometry) : null,
        mode: ed.gestureMode, forceShift: ed.forceShift};
})()`);
log("场景五 一指按住+一指滑动（矩形）", {constrainNow, constrainDone});

// ---- 场景六：两指都在动 = 缩放，不许落笔 ----
await clear();
await pick("rect");
await down([[100, 400]]);
await down([[300, 400]]);
await move([[80, 400], [330, 400]]);
await move([[60, 400], [360, 400]]);
const pinchNow = await probe();
await up([2]);
await up([1]);
const pinchDone = await evaluate(`(() => {
    const ed = window.__plugin.editor;
    return {count: ed.scene.objects.length, mode: ed.gestureMode,
        zoom: Number((ed.viewport.zoom * 100).toFixed(1))};
})()`);
log("场景六 两指都动（缩放）", {pinchNow, pinchDone});

// ---- 场景七：约束中抬起「按住」那根 → 解除约束、这一笔继续 ----
await clear();
await pick("rect");
await down([[100, 400]]);
await down([[300, 300]]);
await move([[100, 400], [360, 360]]);
const beforeRelease = await probe();
await up([1]);                     // 抬起按住不动的那根
const afterRelease = await evaluate(`(() => {
    const ed = window.__plugin.editor;
    return {mode: ed.gestureMode, forceShift: ed.forceShift, locked: ed.gestureLocked};
})()`);
await move([[500, 330]]);          // 只剩一根，自由拖（不再 1:1）
await up([2]);
const afterFree = await evaluate(`(() => {
    const ed = window.__plugin.editor;
    const o = ed.scene.objects[0];
    return {count: ed.scene.objects.length, geometry: o ? JSON.stringify(o.geometry) : null};
})()`);
log("场景七 抬起按住手指", {beforeRelease, afterRelease, afterFree});

ws.close();
server.close();
process.exit(0);
