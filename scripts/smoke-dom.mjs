/**
 * 里程碑一的 DOM 级 smoke test（不需要真的启动思源）。
 * 用 jsdom 搭出思源 Dialog 的 DOM 结构，把打包后的 index.js 按
 * app/src/plugin/loader.ts 的 (require, module, exports) 方式执行，
 * 然后完整模拟「右键图片 → 点击菜单 → 打开编辑器 → 载入图片 → 关闭」三遍。
 * 同时验证主题跟随、SVG 图层、坐标视口和卸载清理。
 */
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const {JSDOM, VirtualConsole} = require("D:/WorkBuddy/siyuan-plugin/siyuan-plugin-BlockBar/node_modules/jsdom");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(root, process.argv[2] || "dist");
const js = (await readFile(path.join(target, "index.js"))).toString("utf8");
const css = (await readFile(path.join(target, "index.css"))).toString("utf8");

const virtualConsole = new VirtualConsole(); // 吞掉 jsdom 对 img / canvas 的无关提示
virtualConsole.on("jsdomError", (e) => { if (process.env.DEBUG_JSDOM) console.error("JSDOM-ERR", e?.stack || e?.message || e); });
virtualConsole.on("log", (...a) => { if (process.env.DEBUG_JSDOM) console.log("[jsdom]", ...a); });
const dom = new JSDOM(
    '<!doctype html><html data-theme-mode="dark"><head></head><body></body></html>',
    {url: "http://localhost/", pretendToBeVisual: true, virtualConsole},
);
const win = dom.window;

// ---- 把浏览器全局挂到 Node 全局， bundles 里直接引用 document/window ----
for (const key of [
    "window", "document", "HTMLElement", "Element", "Node", "Event", "CustomEvent",
    "MutationObserver", "SVGElement", "DOMParser",
]) {
    globalThis[key] = win[key];
}
globalThis.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}});
win.matchMedia = globalThis.matchMedia;
// 关键：AbortSignal 必须来自 jsdom 同源，否则 addEventListener({signal}) 会因跨 realm 被拒绝
globalThis.AbortController = win.AbortController;
globalThis.AbortSignal = win.AbortSignal;
win.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
globalThis.ResizeObserver = win.ResizeObserver;

// jsdom 不真正加载图片：固定原始尺寸，并在 src 赋值后异步派发 load
Object.defineProperty(win.HTMLImageElement.prototype, "naturalWidth", {configurable: true, get: () => 1200});
Object.defineProperty(win.HTMLImageElement.prototype, "naturalHeight", {configurable: true, get: () => 800});
const srcDesc = Object.getOwnPropertyDescriptor(win.HTMLImageElement.prototype, "src");
if (srcDesc && srcDesc.set) {
    Object.defineProperty(win.HTMLImageElement.prototype, "src", {
        configurable: true,
        get() { return srcDesc.get.call(this); },
        set(value) {
            srcDesc.set.call(this, value);
            setTimeout(() => this.dispatchEvent(new win.Event("load")), 0);
        },
    });
}
// jsdom 没有布局：手工模拟 stage 尺寸，并让 SVG 的 rect 与外层 transform 一致
function readViewport() {
    const layer = win.document.querySelector('[data-role="transform"]');
    const m = /translate(?:3d)?\(([-\d.]+)px, ([-\d.]+)px(?:, 0px)?\) scale\(([-\d.]+)\)/
        .exec(layer?.style.transform || "");
    if (!m) return {panX: 0, panY: 0, zoom: 1};
    return {panX: Number(m[1]), panY: Number(m[2]), zoom: Number(m[3])};
}
function rectOf(left, top, width, height) {
    return {x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {}};
}
win.__rootWidth = 1000;
win.Element.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains("annot-root")) return rectOf(0, 0, win.__rootWidth, 700);
    if (this.classList?.contains("annot-stage")) return rectOf(0, 0, win.__stageW || 1000, win.__stageH || 700);
    if (this.classList?.contains("annot-svg")) {
        // v0.26.6：标注层改用 viewBox 缩放，元素本身铺满舞台，不再跟随 transform
        return rectOf(0, 0, win.__stageW || 1000, win.__stageH || 700);
    }
    return rectOf(0, 0, 0, 0);
};
/** 图片像素坐标 → 模拟的屏幕 client 坐标 */
function toClient(x, y) {
    const {panX, panY, zoom} = readViewport();
    return {clientX: panX + x * zoom, clientY: panY + y * zoom};
}

// ---- 假的思源 API ----
const dialogs = [];
class FakeDialog {
    constructor(options) {
        const el = win.document.createElement("div");
        el.className = "b3-dialog";
        el.innerHTML = `
            <div class="b3-dialog__scrim"></div>
            <div class="b3-dialog__container ${options.containerClassName || ""}" style="width:${options.width};height:${options.height}">
                <div class="b3-dialog__header">${options.title || ""}</div>
                <div class="b3-dialog__body">${options.content || ""}</div>
            </div>`;
        win.document.body.append(el);
        this.element = el;
        this.options = options;
        this.destroyed = false;
        dialogs.push(this);
    }
    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.element.remove();
        this.options.destroyCallback?.();
    }
}
class FakePlugin {
    constructor(options) {
        Object.assign(this, options);
        this.i18n = options.i18n || {};
        this.data = {};
        this.eventBus = {
            on: (type, cb) => listeners.set(type, cb),
            off: (type) => listeners.delete(type),
            once: (type, cb) => listeners.set(type, cb),
        };
    }
}
const listeners = new Map();
const insertedContents = [];
const consoleErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => { consoleErrors.push(args.map(String).join(" ")); };
// 模拟思源主菜单：菜单项应直接加到这里，而不是 detail.menu（插件二级菜单）
const mainMenuItems = [];
const subMenuItems = [];
const mainMenuElement = win.document.createElement("div");
win.siyuan = {
    config: {appearance: {mode: 1, modeOS: false}},
    languages: {plugin: "插件"},
    menus: {
        menu: {
            element: mainMenuElement,
            addItem: (item) => { mainMenuItems.push(item); return win.document.createElement("button"); },
            append: () => {},
        },
    },
};
const fakeSiyuan = {
    Plugin: FakePlugin,
    Dialog: FakeDialog,
    getFrontend: () => "desktop",
    showMessage: () => {},
    insertContent: (options) => insertedContents.push(options),
};

// ---- 按思源加载器的方式执行产物 ----
const moduleObj = {exports: {}};
const exportsObj = moduleObj.exports;
new Function("require", "module", "exports", js)(
    (key) => (key === "siyuan" ? fakeSiyuan : {}), moduleObj, exportsObj,
);
const PluginClass = (moduleObj.exports || exportsObj).default || moduleObj.exports;

const results = [];
let failed = 0;
function check(name, condition, detail = "") {
    results.push({name, ok: Boolean(condition), detail});
    if (!condition) failed++;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

function makeDetail() {
    const fakeImg = {getAttribute: (n) => (n === "data-src" ? "assets/demo.png" : "assets/demo.png?v=2")};
    const fakeBlock = {getAttribute: () => "202611080000000-abcdefg"};
    const element = {
        querySelector: (s) => (s === "img" ? fakeImg : null),
        closest: (s) => (s === "[data-node-id]" ? fakeBlock : null),
    };
    const detail = {
        protyle: {},
        element,
        menu: {addItem: (i) => subMenuItems.push(i), addSeparator: () => {}},
    };
    // 菜单项应来自主菜单（第一层），不是插件 subMenu
    return {detail, getItem: () => mainMenuItems[mainMenuItems.length - 1]};
}

const plugin = new PluginClass({app: {}, name: "siyuan-plugin-annotate", displayName: "勾画阁·猫抓", i18n: {}});
plugin.onload();

// 反复打开关闭三次
for (let round = 1; round <= 3; round++) {
    // 每轮都从深色开始，保证断言可重复；第 1 轮内部会临时切到浅色
    win.document.documentElement.setAttribute("data-theme-mode", "dark");
    await tick();
    const {detail, getItem} = makeDetail();
    listeners.get("open-menu-image")?.({detail});
    const item = getItem();
    check(`第 ${round} 轮：菜单项已注入且带「编辑」`, item?.label === "勾画阁·猫抓 编辑", String(item?.label));
    check(`第 ${round} 轮：位于右键菜单第一层`, mainMenuItems.length === round && subMenuItems.length === 0,
        `主菜单 ${mainMenuItems.length} 项 / 插件子菜单 ${subMenuItems.length} 项`);
    item?.click();
    await tick();

    const rootEl = win.document.querySelector(".annot-root");
    check(`第 ${round} 轮：编辑器根节点已挂载`, !!rootEl);
    check(`第 ${round} 轮：跟随思源深色`, rootEl?.getAttribute("data-annot-theme") === "dark", String(rootEl?.getAttribute("data-annot-theme")));
    check(`第 ${round} 轮：工具栏有关闭按钮`, !!rootEl?.querySelector('[data-action="close"]'));
    check(`第 ${round} 轮：加载占位已移除`, !rootEl?.querySelector('[data-role="loading"]'));

    const svg = rootEl?.querySelector('[data-role="svg"]');
    // v0.26.6：标注层不再用 CSS 缩放，viewBox 表达「当前可见的图片区域」，
    // 屏幕 1px = 1/zoom 个图片单位，手柄按屏幕像素画出来才永远锐利
    const vb = (svg?.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    check(`第 ${round} 轮：SVG viewBox = 当前可见区域（宽高 = 视口 / zoom）`,
        vb.length === 4 && vb.every((n) => Number.isFinite(n)) && vb[2] > 0 && vb[3] > 0,
        String(svg?.getAttribute("viewBox")));
    check(`第 ${round} 轮：SVG 尺寸交给 CSS 铺满舞台`, !svg?.getAttribute("width") && !svg?.getAttribute("height"));
    const objects = rootEl?.querySelector('[data-layer="objects"]');
    check(`第 ${round} 轮：对象层存在且为空`, !!objects && objects.childElementCount === 0);
    check(`第 ${round} 轮：背景捕获层铺满画布`, rootEl?.querySelector('[data-layer="catcher"]')?.getAttribute("width") === "1200");
    check(`第 ${round} 轮：覆盖层存在`, !!rootEl?.querySelector('[data-layer="overlay"]'));

    const transform = rootEl?.querySelector('[data-role="transform"]');
    const ts = transform?.style.transform || "";
    check(`第 ${round} 轮：视口 transform 已被计算`, /translate\(/.test(ts) && ts.includes("scale("), ts);
    check(`第 ${round} 轮：transform 层尺寸 = 图片尺寸`, transform?.style.width === "1200px" && transform?.style.height === "800px");
    check(`第 ${round} 轮：状态栏显示原始尺寸`, rootEl?.querySelector('[data-role="dimensions"]')?.textContent === "1200 × 800 px");
    check(`第 ${round} 轮：状态栏显示缩放百分比`, /%$/.test(rootEl?.querySelector('[data-role="zoom"]')?.textContent || ""));

    if (round === 1) {
        // 主题实时跟随
        win.document.documentElement.setAttribute("data-theme-mode", "light");
        await tick();
        check("切换到浅色主题后编辑器跟随", rootEl?.getAttribute("data-annot-theme") === "light", String(rootEl?.getAttribute("data-annot-theme")));
    }

    rootEl?.querySelector('[data-action="close"]')?.click();
    await tick();
    check(`第 ${round} 轮：关闭后根节点被移除`, !win.document.querySelector(".annot-root"));
    check(`第 ${round} 轮：关闭后 Dialog 被移除`, !win.document.querySelector(".b3-dialog"));
}

// 再测一次「点思源原生 ✕」的清理路径
{
    const {detail, getItem} = makeDetail();
    listeners.get("open-menu-image")?.({detail});
    getItem()?.click();
    await tick();
    dialogs[dialogs.length - 1]?.destroy();
    await tick();
    check("点思源原生 ✕ 也能清理干净", !win.document.querySelector(".annot-root"));
}

// ---------------------------------------------------------------- 里程碑二：箭头交互
if (process.argv[3] === "--arrow") {
    const {detail: arrowDetail, getItem: arrowGetItem} = makeDetail();
    listeners.get("open-menu-image")?.({detail: arrowDetail});
    arrowGetItem()?.click();
    await tick();

    let svg = win.document.querySelector('[data-role="svg"]');
    const objectsLayer = () => win.document.querySelector('[data-layer="objects"]');
    const overlayLayer = () => win.document.querySelector('[data-layer="overlay"]');
    const shapeD = () => objectsLayer()?.querySelector(".annot-shape")?.getAttribute("d") || "";
    const objectCount = () => objectsLayer()?.querySelectorAll(".annot-object:not(.is-preview)").length ?? -1;
    const q = (selector) => win.document.querySelector(selector);
    const click = (selector) => q(selector)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const ptr = (type, pt, target) => {
        const c = toClient(pt.x, pt.y);
        (target || svg).dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
        }));
    };
    const key = (k, options = {}) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
        key: k, bubbles: true, cancelable: true, ...options,
    }));

    // 1) 切换工具
    click('button[data-tool="arrow"]');
    check("M2 切换到箭头工具", svg.getAttribute("data-active-tool") === "arrow");
    check("M2 箭头按钮高亮", q('button[data-tool="arrow"]')?.classList.contains("is-active"));

    // 2) 拖拽绘制
    ptr("pointerdown", {x: 100, y: 100});
    ptr("pointermove", {x: 250, y: 200});
    check("M2 拖拽时显示预览箭头", !!objectsLayer()?.querySelector(".annot-object.is-preview"));
    ptr("pointerup", {x: 400, y: 300});
    check("M2 松开后生成 1 个箭头", objectCount() === 1, `${objectCount()} 个`);
    check("M2 绘制后保持当前工具（不再自动回选择）", svg.getAttribute("data-active-tool") === "arrow");
    // 起点 / 终点 / 曲线 + 新增的「移动」抓手 = 4
    check("M2 新箭头自动选中并出现 4 个手柄（含移动抓手）",
        overlayLayer()?.querySelectorAll("[data-handle]").length === 4 &&
        !!overlayLayer()?.querySelector('[data-handle="move"]'),
        String(overlayLayer()?.querySelectorAll("[data-handle]").length));
    check("M2 直线路径为 L", shapeD().includes(" L "), shapeD());
    check("M2 撤销按钮变为可用", q('[data-action="undo"]')?.disabled === false);
    check("M2 重做按钮仍不可用", q('[data-action="redo"]')?.disabled === true);

    // 3) 拖起点手柄改长度方向
    const startHandle = overlayLayer()?.querySelector('[data-handle="start"] circle');
    ptr("pointerdown", {x: 100, y: 100}, startHandle);
    ptr("pointermove", {x: 150, y: 120});
    ptr("pointerup", {x: 150, y: 120});
    check("M2 拖起点后路径更新", shapeD().startsWith("M 150 120"), shapeD());
    check("M2 起点拖拽不影响终点", /L 3\d{2}/.test(shapeD()) || /L 4\d{2}/.test(shapeD()), shapeD());

    // 4) 拖中部手柄掰成二次贝塞尔
    const curveHandle = overlayLayer()?.querySelector('[data-handle="curve"] circle');
    const center = {x: (150 + 400) / 2, y: (120 + 300) / 2};
    ptr("pointerdown", center, curveHandle);
    ptr("pointermove", {x: 280, y: 80});
    ptr("pointerup", {x: 280, y: 80});
    check("M2 拖中部手柄变成曲线 Q", shapeD().includes(" Q "), shapeD());
    check("M2 曲线时出现中点引导虚线", !!overlayLayer()?.querySelector("line"));
    check("M2 箭头头部仍是三角形", !!objectsLayer()?.querySelector(".annot-head"));

    // 5) 撤销 / 重做
    key("z", {ctrlKey: true});
    check("M2 Ctrl+Z 恢复直线", !shapeD().includes(" Q "), shapeD());
    key("z", {ctrlKey: true, shiftKey: true});
    check("M2 Ctrl+Shift+Z 恢复曲线", shapeD().includes(" Q "), shapeD());

    // 6) 整体拖拽移动（需要选择模式，符合「需要选择时由用户自己点」的新逻辑）
    click('button[data-tool="select"]');
    check("M2 点选择后回到选择模式", svg.getAttribute("data-active-tool") === "select");
    const before = shapeD();
    const hit = objectsLayer()?.querySelector('[data-role="hit"]');
    ptr("pointerdown", {x: 277, y: 145}, hit);
    ptr("pointermove", {x: 307, y: 175});
    ptr("pointerup", {x: 307, y: 175});
    check("M2 拖对象本体可整体移动", shapeD() !== before && shapeD().includes(" Q "), shapeD());

    // 7) 删除与撤销删除
    key("Delete");
    check("M2 Delete 删除选中箭头", objectCount() === 0, `${objectCount()} 个`);
    key("z", {ctrlKey: true});
    check("M2 撤销后箭头恢复", objectCount() === 1, `${objectCount()} 个`);

    // 8) 关闭重开：本里程碑不持久化
    click('[data-action="close"]');
    await tick();
    const {detail: reopenDetail, getItem: reopenGetItem} = makeDetail();
    listeners.get("open-menu-image")?.({detail: reopenDetail});
    reopenGetItem()?.click();
    await tick();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M2 重开后不保留标注（尚未持久化，预期行为）", objectCount() === 0, `${objectCount()} 个`);
    check("M2 重开后对象层存在且为空", !!objectsLayer() && objectsLayer().childElementCount === 0);

    // 8.5) 现代样式掰弯：杆的粗细必须保持不变（几何杆换成加粗描边）
    {
        click('button[data-tool="arrow"]');
        click('[data-action="arrow-type-toggle"]');
        click('[data-role="arrow-type-picker"] .annot-arrow-picker__item[data-value="modern"]');
        ptr("pointerdown", {x: 100, y: 500});
        ptr("pointermove", {x: 300, y: 500});
        ptr("pointerup", {x: 500, y: 500});
        const lastObj = () => Array.from(
            objectsLayer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []).pop();
        const lw = Number(lastObj()?.querySelector(".annot-head")?.getAttribute("stroke-width"));
        click('button[data-tool="select"]');
        const mid = {x: 300, y: 500};
        ptr("pointerdown", mid, lastObj()?.querySelector('[data-role="hit"]'));
        ptr("pointerup", mid);
        const curveDot = overlayLayer()?.querySelector('[data-handle="curve"] circle');
        ptr("pointerdown", mid, curveDot);
        ptr("pointermove", {x: 300, y: 380});
        ptr("pointerup", {x: 300, y: 380});
        const shaftEl = lastObj()?.querySelector(".annot-shape");
        check("M2 现代箭头掰弯后杆是填色多边形（保留尾细头粗），不再靠加粗描边",
            !!shaftEl &&
            !!shaftEl.getAttribute("fill") && shaftEl.getAttribute("fill") !== "none" &&
            Number(shaftEl.getAttribute("stroke-width")) === lw &&
            (shaftEl.getAttribute("d")?.match(/L /g) || []).length > 20,
            `fill=${shaftEl?.getAttribute("fill")} width=${shaftEl?.getAttribute("stroke-width")}`);
        check("M2 掰弯后头部仍是三角形，尺寸未变",
            !!lastObj()?.querySelector(".annot-head") && !!shaftEl);
    }

    // 9) Esc：先退出当前操作，再按一次才关闭窗口
    click('button[data-tool="arrow"]');
    key("Escape");
    check("M2 Esc 先退出绘制工具且窗口保持",
        svg.getAttribute("data-active-tool") === "select" && !!win.document.querySelector(".annot-root"));
    key("Escape");
    await tick();
    check("M2 再按 Esc 关闭窗口", !win.document.querySelector(".annot-root"));
}

// ---------------------------------------------------------------- 里程碑三：全部工具 + 侧边栏
if (process.argv[3] === "--m3") {
    const openM3 = () => {
        const d = makeDetail();
        listeners.get("open-menu-image")?.({detail: d.detail});
        d.getItem()?.click();
    };
    openM3();
    await tick();

    let svg = win.document.querySelector('[data-role="svg"]');
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    const overlay = () => win.document.querySelector('[data-layer="overlay"]');
    const items = () => win.document.querySelectorAll('[data-role="object-item"]');
    const count = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? -1;
    const objectIds = () => Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? [])
        .map((g) => g.getAttribute("data-object-id"));
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const ptr = (type, pt, target) => {
        const c = toClient(pt.x, pt.y);
        (target || svg).dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
        }));
    };
    const key = (k, options = {}) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
        key: k, bubbles: true, cancelable: true, ...options,
    }));
    const fire = (el, type) => el?.dispatchEvent(new win.Event(type, {bubbles: true, cancelable: true}));
    const draw = (tool, a, b) => {
        click(`button[data-tool="${tool}"]`);
        ptr("pointerdown", a);
        ptr("pointermove", {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
        ptr("pointerup", b);
    };

    // 1) 布局与初始态
    check("M3 左侧竖栏有 12 个绘图工具（选择已移入悬浮条）、顶部栏不再放工具按钮",
        win.document.querySelectorAll(".annot-imagebar [data-tool]").length === 12 &&
        win.document.querySelectorAll(".annot-toolbar [data-tool]").length === 0,
        `左侧=${win.document.querySelectorAll(".annot-imagebar [data-tool]").length} 顶部=${win.document.querySelectorAll(".annot-toolbar [data-tool]").length}`);
    check("M3 侧边栏存在", !!q('[data-role="sidebar"]'));
    check("M3 初始对象列表为空", items().length === 0 && !!q(".annot-empty"));

    // 2) 逐个工具绘制
    draw("arrow", {x: 60, y: 60}, {x: 200, y: 120});
    check("M3 箭头可绘制", count() === 1, `${count()} 个`);
    draw("rect", {x: 250, y: 60}, {x: 400, y: 160});
    check("M3 矩形可绘制", count() === 2 && !!layer()?.querySelector("rect.annot-shape"));
    draw("ellipse", {x: 450, y: 60}, {x: 600, y: 160});
    check("M3 椭圆可绘制", count() === 3 && !!layer()?.querySelector("ellipse.annot-shape"));
    draw("number", {x: 80, y: 250}, {x: 80, y: 250});
    check("M3 序号可绘制且显示 1",
        count() === 4 && layer()?.querySelector('text[text-anchor="middle"]')?.textContent === "1");
    {
        // 序号四样式：实心圆 → 空心圆 → 定位气泡 → 纯数字，参数随样式切换
        const bar = () => q('[data-role="context-bar"]');
        const bubbleBtn = (val) => bar()?.querySelector(`button[data-action="number-bubble"][data-value="${val}"]`);
        const bubbleOrder = () => Array.from(
            bar()?.querySelectorAll('button[data-action="number-bubble"]') ?? [])
            .map((el) => el.getAttribute("data-value")).join(",");
        check("M3 四枚样式按钮按「实心 / 空心 / 定位 / 数字」排列",
            bubbleOrder() === "solid,hollow,pointer,plain", bubbleOrder());
        {
            // 图标就是「真的画了一遍序号」：每种样式里都有数字 1
            const iconOf = (val) => bubbleBtn(val)?.querySelector("svg");
            const digitOf = (val) => iconOf(val)?.querySelector("text")?.textContent ?? "";
            check("M3 四枚样式图标的圆里都有数字 1",
                digitOf("solid") === "1" && digitOf("hollow") === "1" &&
                digitOf("pointer") === "1" && digitOf("plain") === "1",
                ["solid", "hollow", "pointer", "plain"].map(digitOf).join("/"));
            check("M3 定位气泡图标带尖头路径，其余没有",
                !!iconOf("pointer")?.querySelector("path") &&
                !iconOf("solid")?.querySelector("path") &&
                !iconOf("hollow")?.querySelector("path"),
                iconOf("pointer")?.querySelector("path")?.getAttribute("d")?.slice(0, 30) ?? "没有路径");
            check("M3 图标是单色（currentColor），不跟当前标注色走",
                (iconOf("solid")?.querySelector("circle")?.getAttribute("style") ?? "")
                    .includes("var(--annot-badge-disc, currentColor)"),
                iconOf("solid")?.querySelector("circle")?.getAttribute("style") ?? "");
            check("M3 PC 端样式按钮只放图标、没有文字",
                !bubbleBtn("solid")?.querySelector("span") &&
                !!bubbleBtn("solid")?.getAttribute("title"),
                `span=${!!bubbleBtn("solid")?.querySelector("span")} / ${bubbleBtn("solid")?.getAttribute("title")}`);
        }
        check("M3 实心圆显示端点样式下拉、不显示引线 / 圆线 / 填充",
            !!bar()?.querySelector('[data-action="number-style-toggle"]') &&
            !bar()?.querySelector('button[data-action="number-leader"]') &&
            !bar()?.querySelector('button[data-action="number-round"]') &&
            !bar()?.querySelector('[data-action="number-color"]'));
        bubbleBtn("hollow")?.click();
        {
            const g = Array.from(layer()?.querySelectorAll("g.annot-object") ?? []).pop();
            const ink = g?.querySelector("text.annot-shape")?.getAttribute("fill") ?? "";
            const stroke = g?.querySelector("circle.annot-shape")?.getAttribute("stroke") ?? "";
            check("M3 白底空心圆的文字就是主色（和边框同色）",
                ink !== "" && ink === stroke, `${ink} / ${stroke}`);
        }
        check("M3 空心圆：有填充取色与端点，没有透明档 / 引线开关",
            !!bar()?.querySelector('[data-action="number-color"][data-value="fillColor"]') &&
            !bar()?.querySelector('[data-action="number-fill-none"]') &&
            !/透明/.test(bar()?.textContent ?? "") &&
            !!bar()?.querySelector('[data-action="number-style-toggle"]') &&
            !bar()?.querySelector('button[data-action="number-leader"]'),
            bar()?.textContent?.slice(0, 40) ?? "");
        bubbleBtn("plain")?.click();
        check("M3 纯数字：没有外框参数，但保留编号与端点样式",
            !!bar()?.querySelector('[data-action="number-style-toggle"]') &&
            !bar()?.querySelector('button[data-action="number-leader"]') &&
            !bar()?.querySelector('[data-action="number-color"]') &&
            !!bar()?.querySelector('[data-action="number-format-toggle"]'),
            bar()?.textContent?.slice(0, 40) ?? "");
        bubbleBtn("pointer")?.click();
        check("M3 定位气泡：隐藏端点，给出引线 / 圆线开关 / 填充",
            !bar()?.querySelector('button[data-action="number-tip"]') &&
            !!bar()?.querySelector('button[data-action="number-leader"]') &&
            !!bar()?.querySelector('button[data-action="number-round-toggle"]') &&
            !!bar()?.querySelector('[data-action="number-color"]'),
            bar()?.textContent?.slice(0, 40) ?? "");
        bubbleBtn("solid")?.click();
    }
    {
        // 拖动预览：还没松手就该是带尖头的气泡，不能先画个光秃秃的圆
        click('button[data-tool="number"]');
        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="pointer"]')?.click();
        const before = layer()?.querySelectorAll("g.annot-object").length ?? 0;
        ptr("pointerdown", {x: 300, y: 420});
        ptr("pointermove", {x: 390, y: 420});
        check("M3 拖动预览就显示带尖头的气泡",
            !!layer()?.querySelector("path.annot-head"),
            layer()?.querySelector("path.annot-head") ? "有尖头" : "没有");
        ptr("pointerup", {x: 390, y: 420});
        check("M3 松手后定位气泡成为正式对象",
            (layer()?.querySelectorAll("g.annot-object").length ?? 0) === before + 1,
            `${before} -> ${layer()?.querySelectorAll("g.annot-object").length ?? 0}`);
        // 撤掉这个测试对象，别影响后面按数量断言的用例
        q('[data-action="undo"]')?.click();
        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="solid"]')?.click();
    }
    {
        // 空心圆 / 纯数字也要能拉出引线（曾经只有实心圆能拉）
        // 注意：两个样式要画在不同位置，同一处按下会被「同类防重叠」拦成选中
        for (const [index, kind] of ["hollow", "plain"].entries()) {
            click('button[data-tool="number"]');
            q(`[data-role="context-bar"] button[data-action="number-bubble"][data-value="${kind}"]`)?.click();
            const before = layer()?.querySelectorAll("g.annot-object").length ?? 0;
            draw("number", {x: 120 + index * 140, y: 560}, {x: 220 + index * 140, y: 560});
            const groups = Array.from(layer()?.querySelectorAll("g.annot-object") ?? []);
            const last = groups[groups.length - 1];
            check(`M3 ${kind} 样式拖一下能拉出引线`,
                groups.length === before + 1 &&
                !!last?.querySelector("path.annot-shape") &&
                !!last?.querySelector("path.annot-head"),
                `${before} -> ${groups.length}`);
        }
        q('[data-action="undo"]')?.click();
        q('[data-action="undo"]')?.click();
        click('button[data-tool="number"]');
        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="solid"]')?.click();
    }
    {
        // 画一个拖出长尖的实心圆，再切成定位气泡：必须补上默认尖头，不能变成长刺或消失
        click('button[data-tool="number"]');
        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="solid"]')?.click();
        draw("number", {x: 140, y: 640}, {x: 280, y: 640});
        const center = {x: 140, y: 640};
        const lastGroup = () => {
            const groups = Array.from(layer()?.querySelectorAll("g.annot-object") ?? []);
            return groups[groups.length - 1];
        };
        const apexDist = () => {
            const d = lastGroup()?.querySelector("path.annot-head")?.getAttribute("d") ?? "";
            const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
                .map((m) => ({x: Number(m[1]), y: Number(m[2])}));
            return pts.length ? Math.max(...pts.map((p) => Math.hypot(p.x - center.x, p.y - center.y))) : NaN;
        };
        const solidCircle = () => lastGroup()?.querySelector("circle");
        const centerOf = (el) => ({
            x: Number(el?.getAttribute("cx") ?? NaN),
            y: Number(el?.getAttribute("cy") ?? NaN),
        });
        const solidFill = solidCircle()?.getAttribute("fill") ?? "";
        const solidInk = lastGroup()?.querySelector("text.annot-shape")?.getAttribute("fill") ?? "";
        check("M3 实心圆的文字用反差色（和圆底不同）",
            solidInk !== "" && solidInk !== solidFill, `${solidInk} vs ${solidFill}`);

        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="pointer"]')?.click();
        check("M3 实心圆切成定位气泡：自动补出默认尖头（约 1.5 倍半径）",
            apexDist() > 20 && apexDist() < 40,
            `尖头距圆心 ${Number.isNaN(apexDist()) ? "NaN" : apexDist().toFixed(1)}`);
        check("M3 切过来默认不带细引线",
            (lastGroup()?.querySelectorAll("line.annot-shape").length ?? -1) === 0);
        {
            const c = centerOf(lastGroup()?.querySelector("circle.annot-shape"));
            check("M3 切过来圆心没跑（仍在原来画的位置）",
                Math.abs(c.x - center.x) < 0.5 && Math.abs(c.y - center.y) < 0.5,
                `圆心 ${c.x},${c.y} / 原 ${center.x},${center.y}`);
            check("M3 切换后内部回到默认白底（实心圆的底色不当填充带过来）",
                (lastGroup()?.querySelector("circle.annot-shape")?.getAttribute("fill") ?? "") === "#FFFFFF",
                String(lastGroup()?.querySelector("circle.annot-shape")?.getAttribute("fill")));
            const ink = lastGroup()?.querySelector("text.annot-shape")?.getAttribute("fill") ?? "";
            const fillNow = lastGroup()?.querySelector("circle.annot-shape")?.getAttribute("fill") ?? "";
            check("M3 定位气泡的文字不会和底色撞在一起（红底上不会是红字）",
                ink !== "" && ink !== fillNow, `${ink} / 底 ${fillNow}`);
        }
        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="hollow"]')?.click();
        {
            const c = centerOf(lastGroup()?.querySelector("circle.annot-shape"));
            check("M3 再切到空心圆：圆心没动，内部仍是白底",
                Math.abs(c.x - center.x) < 0.5 && Math.abs(c.y - center.y) < 0.5 &&
                (lastGroup()?.querySelector("circle.annot-shape")?.getAttribute("fill") ?? "") === "#FFFFFF",
                `圆心 ${c.x},${c.y} / 填充 ${lastGroup()?.querySelector("circle.annot-shape")?.getAttribute("fill")}`);
            const hollowInk = lastGroup()?.querySelector("text.annot-shape")?.getAttribute("fill") ?? "";
            const hollowFill = lastGroup()?.querySelector("circle.annot-shape")?.getAttribute("fill") ?? "";
            check("M3 空心圆的文字同样不会和内部填充撞色",
                hollowInk !== "" && hollowInk !== hollowFill, `${hollowInk} / 底 ${hollowFill}`);
        }
        q('[data-role="context-bar"] button[data-action="number-bubble"][data-value="solid"]')?.click();
        check("M3 再切回实心圆：尖头与引线全部消失，只剩完整的圆",
            !lastGroup()?.querySelector("path.annot-head") &&
            (lastGroup()?.querySelectorAll("line.annot-shape").length ?? -1) === 0 &&
            !!lastGroup()?.querySelector("circle"));
        // 清理：撤回这把测试对象，别影响后面按数量断言的用例
        for (let i = 0; i < 10 && count() !== 4; i++) q('[data-action="undo"]')?.click();
    }
    draw("mosaic", {x: 180, y: 230}, {x: 330, y: 330});
    check("M3 马赛克可绘制", count() === 5);
    {
        const groups = Array.from(layer()?.querySelectorAll("g.annot-object") ?? []);
        const last = groups[groups.length - 1];
        const stroked = last?.querySelector("[stroke]");
        check("M3 马赛克没有描边（只有打糊的区域）", !!last && !stroked,
            stroked ? stroked.outerHTML.slice(0, 80) : "无描边元素");
        // 选中马赛克看属性面板：没有描边，线宽这一行也就没意义，应当整行消失
        win.document.querySelectorAll('[data-role="object-item"]')[4]
            ?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        check("M3 马赛克属性面板不再显示线宽与颜色",
            !win.document.querySelector('[data-role="props"] input[data-prop="lineWidth"]') &&
            !win.document.querySelector('[data-role="props"] input[data-prop="color"]'),
            String(win.document.querySelector('[data-role="props"]')?.innerHTML || "").slice(0, 60));
    }
    draw("highlight", {x: 400, y: 250}, {x: 600, y: 330});
    const highlightGroup = Array.from(layer()?.querySelectorAll("g.annot-object") ?? [])
        .find((g) => g.getAttribute("opacity") === "0.35");
    check("M3 高亮笔可绘制且默认半透明",
        count() === 6 && !!highlightGroup?.querySelector("path.annot-shape"));
    // 2b) 模糊：和马赛克同一套框选，但不描边、强度可调（v0.9.3）
    draw("blur", {x: 660, y: 230}, {x: 820, y: 330});
    check("M3 模糊可绘制", count() === 7, `${count()} 个`);
    {
        const groups = Array.from(layer()?.querySelectorAll("g.annot-object") ?? []);
        const last = groups[groups.length - 1];
        const stroked = last?.querySelector("[stroke]");
        check("M3 模糊没有描边", !!last && !stroked, stroked ? stroked.outerHTML.slice(0, 60) : "无描边元素");
        const items = win.document.querySelectorAll('[data-role="object-item"]');
        items[items.length - 1]?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        const sliderOf = () => win.document.querySelector('[data-role="context-bar"] [data-ctx="blurRadius"]');
        check("M3 模糊有「模糊强度」滑块（悬浮条，属性面板已移除）", !!sliderOf());
        check("M3 模糊不显示颜色与线宽控件",
            !win.document.querySelector('[data-role="props"]') &&
            !win.document.querySelector('[data-role="context-bar"] [data-ctx="opacity"]'));
        const slider = sliderOf();
        if (slider) {
            slider.value = "30";
            fire(slider, "input");
            fire(slider, "change");
            check("M3 模糊强度可调到 30",
                win.document.querySelector('[data-role="ctx-blurRadius"]')?.textContent === "30",
                String(win.document.querySelector('[data-role="ctx-blurRadius"]')?.textContent));
        }
    }
    check("M3 所有对象都应用统一透明度",
        Array.from(layer()?.querySelectorAll("g.annot-object") ?? []).every((g) => g.hasAttribute("opacity")));

    click('button[data-tool="text"]');
    {
        // 字体面板：点按钮展开；顶部是上传按钮，下面按「自定义 → 系统字体」分区
        const trigger = () => q('[data-role="context-bar"] button[data-action="font-pop"]');
        check("M3 文字工具悬浮栏有字体按钮", !!trigger(),
            trigger() ? trigger().textContent.trim() : "无");
        trigger()?.click();
        const pop = () => q('[data-role="font-pop"]');
        check("M3 字体面板顶部就是上传按钮",
            !!pop() && pop().firstElementChild?.getAttribute("data-action") === "font-upload");
        check("M3 字体面板没有「自定义字体」这类冗余文字",
            !/自定义字体/.test(pop()?.textContent ?? ""),
            (pop()?.textContent ?? "").slice(0, 30));
        check("M3 字体面板保留「系统字体」标题分组",
            (pop()?.querySelector(".annot-font-sep")?.textContent ?? "").includes("系统字体"));
        check("M3 字体面板有默认项（跟随思源）",
            Array.from(pop()?.querySelectorAll('[data-action="font-pick"]') ?? [])
                .some((el) => el.getAttribute("data-value") === ""));
        // 在面板上滚轮：面板自己滚，画布不缩放（曾经一点滚轮画面就跑）
        {
            const overPop = new win.WheelEvent("wheel", {deltaY: -120, bubbles: true, cancelable: true});
            pop()?.dispatchEvent(overPop);
            check("M3 字体面板上滚轮不再缩放画布", overPop.defaultPrevented === false);
            const overStage = new win.WheelEvent("wheel", {deltaY: -120, bubbles: true, cancelable: true});
            q(".annot-stage")?.dispatchEvent(overStage);
            check("M3 画布上滚轮仍然缩放", overStage.defaultPrevented === true);
        }
        trigger()?.click();
    }
    ptr("pointerdown", {x: 80, y: 420});
    let textArea = q(".annot-text-editor");
    check("M3 文字工具点一下即进入编辑态", !!textArea);
    check("M3 输入框透明无白底 / 边框 / 阴影（所见即所得）",
        /background:\s*transparent\s*!important/.test(css) &&
        /border:\s*0\s*!important/.test(css) &&
        /box-shadow:\s*none\s*!important/.test(css) &&
        /\.annot-object\.is-editing\s*\{\s*visibility:\s*hidden/.test(css), "");
    // 空文字时输入框宽度＝两个半字高（文字包围盒最小宽度 2 字 + 半字余量）
    const expectM3Width = 2.5 * Number.parseFloat(textArea?.style.fontSize || "0");
    check("M3 输入框不加内边距 / 底色，宽度贴着文字且允许自动换行",
        textArea?.wrap === "soft" && textArea?.style.lineHeight === "1.25" &&
        !textArea?.style.background && !textArea?.style.padding &&
        Math.abs(Number.parseFloat(textArea?.style.width || "0") - expectM3Width) < 0.6,
        `wrap=${textArea?.wrap} width=${textArea?.style.width} fs=${textArea?.style.fontSize} zoom=${readViewport().zoom} 期望 ${expectM3Width.toFixed(1)}`);
    // 真实浏览器回归：pointerup 之后会派发 click，target 是画布 SVG。
    // 工具栏点击委托绝不能把画布当成工具按钮，否则输入框会被立刻销毁。
    svg.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    check("M3 画布 click 不会误切工具导致输入框闪退", !!q(".annot-text-editor"));
    textArea.value = "测试标注";
    // 回归：真实浏览器会在 pointerdown 后把焦点交还画布并触发 blur，
    // 输入框必须保持存在，给用户留出打字时间
    textArea.dispatchEvent(new win.FocusEvent("blur"));
    check("M3 输入框不会因失焦闪退", !!q(".annot-text-editor"));
    win.document.body.dispatchEvent(new win.MouseEvent("pointerdown", {bubbles: true, cancelable: true, button: 0}));
    check("M3 点到别处才完成输入", !q(".annot-text-editor"));
    check("M3 文字内容写入对象",
        Array.from(layer()?.querySelectorAll("text.annot-shape") ?? []).some((e) => e.textContent === "测试标注"));
    check("M3 八个工具共 8 个对象", count() === 8, `${count()} 个`);

    // 3) 侧边栏 ↔ 画布双向高亮联动（先切回选择模式）
    click('button[data-tool="select"]');
    const ids = objectIds();
    click(`[data-role="object-item"][data-id="${ids[1]}"]`);
    check("M3 点侧栏项 → 画布对象高亮",
        !!layer()?.querySelector(`g.is-selected[data-object-id="${ids[1]}"]`));
    check("M3 侧栏项自身高亮",
        !!q(`[data-role="object-item"][data-id="${ids[1]}"].is-selected`));
    const firstHit = layer()?.querySelector(`g[data-object-id="${ids[0]}"] [data-role="hit"]`);
    ptr("pointerdown", {x: 100, y: 90}, firstHit);
    ptr("pointerup", {x: 100, y: 90});
    check("M3 点画布对象 → 侧栏项高亮",
        !!q(`[data-role="object-item"][data-id="${ids[0]}"].is-selected`));

    // 4) 序号自动递增 + 删除后重新编号
    draw("number", {x: 140, y: 250}, {x: 140, y: 250});
    draw("number", {x: 200, y: 250}, {x: 200, y: 250});
    const numberTexts = () => Array.from(layer()?.querySelectorAll('text[text-anchor="middle"]') ?? [])
        .map((e) => e.textContent).join(",");
    check("M3 三个序号为 1,2,3", numberTexts() === "1,2,3", numberTexts());
    const numberIds = Array.from(layer()?.querySelectorAll("g.annot-object") ?? [])
        .filter((g) => g.querySelector('text[text-anchor="middle"]'))
        .map((g) => g.getAttribute("data-object-id"));
    click(`[data-role="object-item"][data-id="${numberIds[1]}"]`);
    key("Delete");
    check("M3 删除中间的 2 后重排为 1,2", numberTexts() === "1,2", numberTexts());
    check("M3 侧栏序号徽章同步", Array.from(items()).filter((el) => el.querySelector(".annot-object-item__badge")?.style.background).length === 2);

    // 5) 手柄 8 点缩放 / 旋转 + 顶栏档位「选中谁改谁」（属性面板已在 v0.21.0 移除）
    click(`[data-role="object-item"][data-id="${ids[1]}"]`);
    check("M3 矩形有 8 点缩放手柄", overlay()?.querySelectorAll('[data-handle^="resize:"]').length === 8);
    check("M3 矩形有旋转手柄", !!overlay()?.querySelector('[data-handle="rotate"]'));
    check("M3 右侧面板只剩对象与层级（属性栏目已移除）",
        !q('[data-role="props"]') && !!q('[data-role="list"]') && !!q('[data-role="layers"]'));
    const rectShape = () => layer()?.querySelector(`g[data-object-id="${ids[1]}"] rect.annot-shape`);
    click('[data-role="group-colors"] button[data-value="#10B981"]');
    check("M3 点顶栏色点立即改选中矩形的颜色", rectShape()?.getAttribute("stroke") === "#10B981",
        String(rectShape()?.getAttribute("stroke")));
    click('button[data-preset="lineWidth"][data-index="3"]');
    check("M3 点顶栏第四档粗细，选中矩形的线宽跟着变成 14",
        rectShape()?.getAttribute("stroke-width") === "14",
        String(rectShape()?.getAttribute("stroke-width")));
    const seHandle = overlay()?.querySelector('[data-handle="resize:se"] circle');
    const widthBefore = rectShape()?.getAttribute("width");
    ptr("pointerdown", {x: 400, y: 160}, seHandle);
    ptr("pointermove", {x: 460, y: 210});
    ptr("pointerup", {x: 460, y: 210});
    check("M3 拖缩放角点改变尺寸", rectShape()?.getAttribute("width") !== widthBefore,
        `${widthBefore} → ${rectShape()?.getAttribute("width")}`);
    const rotateHandle = overlay()?.querySelector('[data-handle="rotate"] circle');
    ptr("pointerdown", {x: 325, y: 27}, rotateHandle);
    ptr("pointermove", {x: 430, y: 70});
    ptr("pointerup", {x: 430, y: 70});
    check("M3 拖旋转手柄加上旋转变换",
        !!layer()?.querySelector(`g[data-object-id="${ids[1]}"]`)?.getAttribute("transform"));

    // 6) 文字：双击再编辑、Esc 后仍可拖动和改色
    click('button[data-tool="select"]');
    let textShape = Array.from(layer()?.querySelectorAll("text.annot-shape") ?? [])
        .find((e) => e.textContent === "测试标注");
    const textId = textShape?.closest("[data-object-id]")?.getAttribute("data-object-id");
    textShape?.dispatchEvent(new win.MouseEvent("dblclick", {bubbles: true, cancelable: true}));
    check("M3 双击文字再次进入编辑态", !!q(".annot-text-editor"));
    textArea = q(".annot-text-editor");
    textArea.value = "改过的文字";
    textArea.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    check("M3 Esc 退出文字编辑态", !q(".annot-text-editor"));
    check("M3 编辑后文字内容更新",
        Array.from(layer()?.querySelectorAll("text.annot-shape") ?? []).some((e) => e.textContent === "改过的文字"));
    check("M3 右侧属性栏目已移除（字号改由顶栏档位调）",
        !q('[data-role="props"]') && !!q('button[data-preset="fontSize"]'));
    const textX = () => Number(layer()?.querySelector(`g[data-object-id="${textId}"] text.annot-shape`)?.getAttribute("x"));
    const beforeX = textX();
    const textHit = layer()?.querySelector(`g[data-object-id="${textId}"] [data-role="hit"]`);
    ptr("pointerdown", {x: 90, y: 430}, textHit);
    ptr("pointermove", {x: 130, y: 450});
    ptr("pointerup", {x: 130, y: 450});
    check("M3 Esc 退出后文字仍可拖动", textX() > beforeX + 10, `${beforeX} → ${textX()}`);
    click('[data-role="group-colors"] button[data-value="#8B5CF6"]');
    check("M3 Esc 退出后文字仍可改颜色",
        layer()?.querySelector(`g[data-object-id="${textId}"] text.annot-shape`)?.getAttribute("fill") === "#8B5CF6");

    // 6b) 单击「已选中的文字」直接进编辑：焦点在输入框、光标落在点击处
    const textAnchor = () => {
        const el = layer()?.querySelector(`g[data-object-id="${textId}"] text.annot-shape`);
        return {x: Number(el?.getAttribute("x")), y: Number(el?.getAttribute("y")), el};
    };
    const hitOf = () => layer()?.querySelector(`g[data-object-id="${textId}"] [data-role="hit"]`);
    const start = textAnchor();
    ptr("pointerdown", {x: start.x + 2, y: start.y + 12}, hitOf());
    ptr("pointerup", {x: start.x + 2, y: start.y + 12});
    let inlineEditor = q(".annot-text-editor");
    check("M3 单击已选中的文字会直接进入编辑", !!inlineEditor);
    await new Promise((resolve) => setTimeout(resolve, 40));
    check("M3 进入编辑后输入框拿到焦点",
        win.document.activeElement === inlineEditor,
        String(win.document.activeElement?.className || win.document.activeElement?.tagName || "none"));
    check("M3 光标落在点击处（点在文字左侧＝开头）",
        inlineEditor?.selectionStart === 0, String(inlineEditor?.selectionStart));

    // 直接改字（模拟键盘输入）→ 退出后写回画布
    inlineEditor.value = `${inlineEditor.value}！`;
    inlineEditor.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    check("M3 在画布上直接改的字会写回",
        Array.from(layer()?.querySelectorAll("text.annot-shape") ?? []).some((e) => e.textContent === "改过的文字！"),
        String(Array.from(layer()?.querySelectorAll("text.annot-shape") ?? []).map((e) => e.textContent)));

    // 再点文字右侧 → 光标落在末尾（6 个字）
    const tail = textAnchor();
    ptr("pointerdown", {x: tail.x + 400, y: tail.y + 12}, hitOf());
    ptr("pointerup", {x: tail.x + 400, y: tail.y + 12});
    let tailEditor = q(".annot-text-editor");
    check("M3 点文字右侧光标落在末尾",
        tailEditor?.selectionStart === (tailEditor?.value || "").length && (tailEditor?.value || "").length === 6,
        `${tailEditor?.selectionStart} / ${tailEditor?.value}`);
    tailEditor?.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    check("M3 连点两次不会把文字改没", !!textAnchor().el);

    // 7) 马赛克块大小：改用悬浮条上的滑杆（属性面板已移除）
    click(`[data-role="object-item"][data-id="${ids[4]}"]`);
    const blockInput = q('[data-role="context-bar"] [data-ctx="blockSize"]');
    check("M3 马赛克有块大小滑杆（悬浮条）", !!blockInput,
        q('[data-role="context-bar"]')?.textContent || "");
    blockInput.value = "40";
    fire(blockInput, "input");
    fire(blockInput, "change");
    check("M3 块大小调整为 40", q('[data-role="context-bar"] [data-ctx="blockSize"]')?.value === "40",
        String(q('[data-role="context-bar"] [data-ctx="blockSize"]')?.value));

    // 8) 侧栏折叠、删除与撤销
    click('[data-action="toggle-sidebar"]');
    check("M3 侧栏可折叠", q('[data-role="sidebar"]')?.classList.contains("is-collapsed"));
    click('[data-action="toggle-sidebar"]');
    click(`[data-role="object-item"][data-id="${ids[0]}"]`);
    const beforeDelete = count();
    key("Delete");
    check("M3 Delete 删除对象", count() === beforeDelete - 1, `${beforeDelete} → ${count()}`);
    key("z", {ctrlKey: true});
    check("M3 撤销恢复对象", count() === beforeDelete);

    // 9) 关闭重开：里程碑三仍不持久化
    click('[data-action="close"]');
    await tick();
    openM3();
    await tick();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M3 重开后不保留标注（未持久化）", count() === 0, `${count()} 个`);
    check("M3 重开后侧栏显示空列表", items().length === 0 && !!q(".annot-empty"));
    click('[data-action="close"]');
    await tick();

    // 10) 画线：拖拽直线 / Shift 约束 / 连续折线 / 双击与 Esc 收尾 / 拖端点 / 颜色线宽
    openM3();
    await tick();
    svg = win.document.querySelector('[data-role="svg"]');
    const lastLineD = () => {
        const groups = Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []);
        return groups[groups.length - 1]?.querySelector("path.annot-shape")?.getAttribute("d") || "";
    };
    const pointsOfD = (d) => {
        const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({x: nums[i], y: nums[i + 1]});
        return pts;
    };
    const ptrWith = (type, pt, options = {}, target) => {
        const c = toClient(pt.x, pt.y);
        (target || svg).dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY, ...options,
        }));
    };
    const clickAt = (pt, options = {}) => {
        ptrWith("pointerdown", pt, options);
        ptrWith("pointerup", pt, options);
    };

    click('button[data-tool="line"]');
    const baseCount = count();
    // 10a) 基础拖拽
    ptr("pointerdown", {x: 100, y: 400});
    ptr("pointermove", {x: 160, y: 435});
    ptr("pointerup", {x: 220, y: 470});
    check("画线：拖拽画出一条独立直线对象",
        count() === baseCount + 1 && /^M .* L /.test(lastLineD()),
        `count=${count()} d=${lastLineD()}`);
    check("画线：顶栏色板与粗细档位照常可用（属性面板已移除）",
        !!q('[data-role="group-colors"] button[data-value]') &&
        !!q('button[data-preset="lineWidth"][data-index="0"]'));

    // 10b) Shift 约束（水平 / 垂直 / 45°）
    ptr("pointerdown", {x: 300, y: 400});
    ptrWith("pointermove", {x: 360, y: 420}, {shiftKey: true});
    ptrWith("pointerup", {x: 420, y: 430}, {shiftKey: true});
    const snapped = pointsOfD(lastLineD());
    const s0 = snapped[0] || {x: 0, y: 0};
    const s1 = snapped[snapped.length - 1] || {x: 0, y: 0};
    const dx = Math.abs(s1.x - s0.x);
    const dy = Math.abs(s1.y - s0.y);
    check("画线：按 Shift 把斜线锁到水平 / 垂直 / 45°",
        count() === baseCount + 2 &&
        (dy < 0.01 || dx < 0.01 || Math.abs(dx - dy) < 0.01),
        `dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} d=${lastLineD()}`);

    // 10c) 连续折线：单击起点 → 点两次加折点 → 双击结束
    clickAt({x: 500, y: 400});
    const beforePolyline = count();
    ptr("pointermove", {x: 560, y: 440});
    clickAt({x: 560, y: 440});
    ptr("pointermove", {x: 620, y: 390});
    clickAt({x: 620, y: 390});
    check("画线：折线收尾之前不会提前生成一堆零散对象",
        count() === beforePolyline, `count=${count()}`);
    svg.dispatchEvent(new win.MouseEvent("dblclick", {bubbles: true, cancelable: true}));
    check("画线：双击结束折线，得到一个多段对象",
        count() === beforePolyline + 1 && (lastLineD().match(/ L /g) || []).length >= 2,
        `count=${count()} d=${lastLineD()}`);

    // 10d) Esc 也能收尾
    clickAt({x: 700, y: 400});
    ptr("pointermove", {x: 760, y: 450});
    clickAt({x: 760, y: 450});
    const beforeEsc = count();
    key("Escape");
    check("画线：按 Esc 结束折线并保留已连好的线段",
        count() === beforeEsc + 1 && /^M .* L /.test(lastLineD()),
        `count=${count()} d=${lastLineD()}`);

    // 10e) 拖端点改方向
    const endHandle = q('[data-layer="overlay"] [data-handle="point:1"]');
    check("画线：选中后两端都有可拖的圆点手柄",
        !!q('[data-layer="overlay"] [data-handle="point:0"]') && !!endHandle);
    const dBeforeDrag = lastLineD();
    if (endHandle) {
        ptrWith("pointerdown", {x: 760, y: 450}, {}, endHandle);
        ptr("pointermove", {x: 820, y: 520});
        ptr("pointerup", {x: 820, y: 520});
    }
    check("画线：拖端点后线段方向真的变了",
        lastLineD() !== dBeforeDrag && count() === beforeEsc + 1,
        `${dBeforeDrag} → ${lastLineD()}`);

    // 11) PC 界面重构：顶部通用属性 / 悬浮条 / 三区块 / 层级拖拽 / 图标按钮
    const contextBar = () => q('[data-role="context-bar"]');
    check("PC 顶部栏只放通用属性入口：颜色 / 线宽 / 线型 / 填充 / 字号",
        !!q('.annot-toolbar [data-role="group-colors"]') &&
        !!q('.annot-toolbar [data-role="group-widths"]') &&
        !!q('.annot-toolbar [data-role="group-lines"]') &&
        !!q('.annot-toolbar [data-role="group-fills"]') &&
        !!q('.annot-toolbar [data-role="group-fonts"]') &&
        win.document.querySelectorAll('.annot-toolbar button[data-tool]').length === 0);
    check("PC 左侧竖栏分上下两组：12 个绘图工具 + 6 个图像操作（选择不在竖栏里）",
        win.document.querySelectorAll('.annot-imagebar [data-role="tool-buttons"] button[data-tool]').length === 12 &&
        win.document.querySelectorAll('.annot-imagebar [data-canvas-op]').length === 6 &&
        !!q('.annot-imagebar__sep'));
    check("右侧面板只剩对象 / 层级两个区块（属性栏目已移除）",
        !!q('.annot-side-section[data-section="objects"]') &&
        !!q('.annot-side-section[data-section="layers"]') &&
        !q('.annot-side-section[data-section="props"]') &&
        win.document.querySelectorAll('.annot-section-toggle').length === 2);

    // 每个区块可单独折叠 / 展开
    click('.annot-section-toggle[data-section="objects"]');
    check("PC 对象区块能单独折叠",
        q('.annot-side-section[data-section="objects"]')?.classList.contains("is-folded") === true);
    click('.annot-section-toggle[data-section="objects"]');
    check("PC 对象区块能再展开",
        q('.annot-side-section[data-section="objects"]')?.classList.contains("is-folded") === false);

    // 整体收起拉手
    click('[data-action="toggle-sidebar"]');
    check("PC 拉手能收起整个右侧面板",
        q('[data-role="sidebar"]')?.classList.contains("is-collapsed") === true);
    click('[data-action="toggle-sidebar"]');
    check("PC 再点拉手右侧面板重新展开",
        q('[data-role="sidebar"]')?.classList.contains("is-collapsed") === false);

    // 画布悬浮条：马赛克 / 模糊 / 箭头各显示各的参数
    click('button[data-tool="mosaic"]');
    check("PC 悬浮条：马赛克只剩块大小，透明度滑块已移除",
        contextBar()?.hidden === false && !!contextBar()?.querySelector('[data-ctx="blockSize"]') &&
        !contextBar()?.querySelector('[data-ctx="opacity"]'));
    {
        // 选区识别开关：默认关，点一下进按下态（v1.1.0-alpha.4）
        const smartBtn = () => contextBar()?.querySelector('[data-action="smart-select"]');
        check("PC 悬浮条：马赛克有「选区识别」开关，默认未开启",
            !!smartBtn() && smartBtn().getAttribute("aria-pressed") === "false",
            String(smartBtn()?.getAttribute("aria-pressed")));
        smartBtn()?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        // jsdom 没有 canvas（getContext 返回 null），点下去会走「读不到像素」的兜底并安静退出；
        // 真机上是进入识别模式、在 overlay 上画出虚线框。这里只确认不抛错、不留脏状态。
        check("PC 点「选区识别」在无 canvas 环境安静退出，不留虚线框",
            smartBtn()?.getAttribute("aria-pressed") === "false" &&
            !win.document.querySelector("[data-smart-region]"),
            String(smartBtn()?.getAttribute("aria-pressed")));
    }
    click('button[data-tool="blur"]');
    check("PC 悬浮条：模糊显示模糊程度",
        contextBar()?.hidden === false && !!contextBar()?.querySelector('[data-ctx="blurRadius"]'));
    click('button[data-tool="arrow"]');
    const headGroup = () => q('[data-role="arrow-head-group"]');
    const typePickerEl = () => q('[data-role="arrow-type-picker"]');
    const pickType = (key) => {
        if (!typePickerEl()?.classList.contains("is-open")) click('[data-action="arrow-type-toggle"]');
        click(`[data-role="arrow-type-picker"] .annot-arrow-picker__item[data-value="${key}"]`);
    };
    const pickHead = (key) => click(`[data-role="arrow-head-group"] .annot-arrow-chip[data-value="${key}"]:not([disabled])`);
    const LEGACY_KIND = {
        classic: ["single", "classic"], modern: ["modern", "basic"], double: ["double", "classic"],
        basic: ["single", "basic"], line: ["single", "open"], bar: ["bar", "none"],
        barDouble: ["bar", "basic"],
    };
    const pickStyle = (key) => {
        const [type, head] = LEGACY_KIND[key] ?? ["single", "classic"];
        pickType(type);
        pickHead(head);
    };
    const headChips = () => Array.from(headGroup()?.querySelectorAll(".annot-arrow-chip") ?? []);
    const lastGroup = () => Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []).pop();
    check("PC 悬浮条：类型是下拉、样式是横排图标，没有原生 select",
        contextBar()?.hidden === false && !!typePickerEl() && !!headGroup() &&
        !!typePickerEl()?.querySelector(".annot-arrow-picker__menu") &&
        !contextBar()?.querySelector("select") &&
        css.includes(".annot-arrow-group") && css.includes(".annot-arrow-chip"));
    check("类型四项齐全，端点固定六格（无箭头也在，只是置灰）",
        ["single", "double", "modern", "bar"].every((k) =>
            !!typePickerEl()?.querySelector(`.annot-arrow-picker__item[data-value="${k}"]`)) &&
        headChips().map((el) => el.getAttribute("data-value")).join(",") ===
        "none,basic,classic,open,rhombus,circle",
        headChips().map((el) => el.getAttribute("data-value")).join(","));
    check("单头下「无箭头」置灰，菱形与圆形可用",
        !!headGroup()?.querySelector('.annot-arrow-chip[data-value="none"]:disabled') &&
        !headGroup()?.querySelector('.annot-arrow-chip[data-value="rhombus"]:disabled') &&
        !headGroup()?.querySelector('.annot-arrow-chip[data-value="circle"]:disabled'));
    check("每个样式格都带图案与提示文字",
        Array.from(headGroup()?.querySelectorAll(".annot-arrow-chip") ?? []).every((item) =>
            !!item.querySelector("svg.annot-arrow-style-icon") &&
            !!item.getAttribute("title") && !!item.getAttribute("aria-label")));

    // 切换类型：置灰项要跟着变，而不是消失
    pickStyle("double");
    check("切到双头后，下拉文字变成「双头」、样式高亮落在「燕尾」上",
        typePickerEl()?.querySelector(".annot-arrow-picker__label")?.textContent === "双头" &&
        !!headGroup()?.querySelector('.annot-arrow-chip[data-value="classic"].is-active'));
    {
        pickType("modern");
        const disabled = (key) => !!headGroup()?.querySelector(`.annot-arrow-chip[data-value="${key}"]:disabled`);
        check("尖尾下开放/菱形/圆形/无箭头全部置灰，但仍留在界面上",
            disabled("open") && disabled("rhombus") && disabled("circle") && disabled("none") &&
            !disabled("basic") && !disabled("classic") &&
            headChips().length === 6,
            headChips().map((el) => `${el.getAttribute("data-value")}${el.disabled ? "(灰)" : ""}`).join(","));
        pickType("bar");
        const disabledBar = (key) => !!headGroup()?.querySelector(`.annot-arrow-chip[data-value="${key}"]:disabled`);
        check("两端竖线下开放箭头也可用，菱形与圆形仍置灰",
            !disabledBar("none") && !disabledBar("basic") && !disabledBar("classic") &&
            !disabledBar("open") && disabledBar("rhombus") && disabledBar("circle"));
        // 还原成双头：后面的绘制用例依赖它
        pickType("double");
        pickHead("classic");
    }

    draw("arrow", {x: 700, y: 500}, {x: 820, y: 560});
    check("PC 双头箭头真的画出两个箭头头部",
        (lastGroup()?.querySelectorAll("path.annot-head").length ?? 0) === 2,
        String(lastGroup()?.querySelectorAll("path.annot-head").length));

    // v0.13.5：画完仍选中时，换样式要当场改这一支（与矩形圆角完全同一套逻辑）
    const headCount = () => lastGroup()?.querySelectorAll("path.annot-head").length ?? 0;
    const headD = () => lastGroup()?.querySelector("path.annot-head")?.getAttribute("d") || "";
    pickStyle("classic");
    check("M3 画完双头箭头仍选中时，切到经典当场把这一支改成单头",
        headCount() === 1, `${headCount()} 个头部`);
    const classicHeadD = headD();
    const countBeforeDeselect = count();
    ptr("pointerdown", {x: 60, y: 60});
    ptr("pointerup", {x: 60, y: 60});
    check("M3 点空白取消选中，不会凭空多出一个对象",
        count() === countBeforeDeselect, `${countBeforeDeselect} → ${count()}`);
    pickStyle("basic");
    check("M3 没选中时换样式只改默认值，已经画好的箭头不动",
        headCount() === 1 && headD() === classicHeadD, headD().slice(0, 24));
    ptr("pointerdown", {x: 300, y: 760});
    ptr("pointermove", {x: 400, y: 780});
    ptr("pointerup", {x: 460, y: 790});
    check("M3 没选中时选的样式用在下一支上（基础头部是直边，经典带背弧 Q）",
        headCount() === 1 && classicHeadD.includes(" Q ") && !headD().includes(" Q "),
        `${classicHeadD.slice(0, 16)} → ${headD().slice(0, 16)}`);

    // 圆角开关
    check("PC 悬浮条有圆角开关，默认开启",
        !!q('[data-action="arrow-rounded"]') &&
        q('[data-action="arrow-rounded"]')?.getAttribute("aria-pressed") === "true" &&
        q('[data-action="arrow-rounded"]')?.classList.contains("is-active") === true);
    click('[data-action="arrow-rounded"]');
    check("PC 圆角开关可关闭",
        q('[data-action="arrow-rounded"]')?.getAttribute("aria-pressed") === "false");
    draw("arrow", {x: 700, y: 620}, {x: 820, y: 680});
    check("PC 关掉圆角后新箭头是平头 / 尖角",
        lastGroup()?.querySelector("path.annot-shape")?.getAttribute("stroke-linecap") === "butt" &&
        lastGroup()?.querySelector("path.annot-head")?.getAttribute("stroke-linejoin") === "miter",
        String(lastGroup()?.querySelector("path.annot-shape")?.getAttribute("stroke-linecap")));
    click('[data-action="arrow-rounded"]');
    check("PC 圆角开关可再打开",
        q('[data-action="arrow-rounded"]')?.getAttribute("aria-pressed") === "true");

    // 顶部线型：虚线会写进对象渲染
    click('[data-preset="lineDash"][data-value="dashed"]');
    draw("rect", {x: 860, y: 480}, {x: 960, y: 560});
    const dashedRect = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []).pop();
    check("PC 顶部「虚线」样式作用到新画的图形",
        !!dashedRect?.getAttribute("stroke-dasharray"),
        String(dashedRect?.getAttribute("stroke-dasharray")));

    // 层级面板拖拽：把最后一个对象拖到第一个，画布绘制顺序要变
    const idsBefore = Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? [])
        .map((g) => g.getAttribute("data-object-id"));
    const layerButtons = Array.from(win.document.querySelectorAll('[data-role="layers"] button'));
    check("PC 层级栏目只有置顶 / 上移 / 下移 / 置底四个按钮，没有图层列表",
        layerButtons.length === 4 &&
        ["layer-top", "layer-up", "layer-down", "layer-bottom"].every((a) =>
            !!q(`[data-role="layers"] [data-action="${a}"]`)) &&
        win.document.querySelectorAll('[data-role="layer-item"]').length === 0,
        layerButtons.map((b) => b.textContent).join(","));
    const layerItems = Array.from(win.document.querySelectorAll('[data-role="object-item"]'));
    check("PC 对象栏目列出全部对象且每一行都能拖动",
        layerItems.length === idsBefore.length && layerItems.every((el) => el.draggable === true),
        `${layerItems.length} / ${idsBefore.length}`);
    if (layerItems.length >= 2) {
        const dragEvent = (type) => {
            const e = new win.Event(type, {bubbles: true, cancelable: true});
            Object.defineProperty(e, "dataTransfer", {value: {effectAllowed: "", dropEffect: ""}});
            return e;
        };
        layerItems[layerItems.length - 1].dispatchEvent(dragEvent("dragstart"));
        layerItems[0].dispatchEvent(dragEvent("dragover"));
        layerItems[0].dispatchEvent(dragEvent("drop"));
        const idsAfter = Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? [])
            .map((g) => g.getAttribute("data-object-id"));
        check("PC 拖拽对象列表真的改变了上下覆盖顺序",
            idsAfter.join(",") !== idsBefore.join(",") && idsAfter.length === idsBefore.length,
            `${idsBefore.slice(0, 2).join(",")} → ${idsAfter.slice(0, 2).join(",")}`);
    }

    // 复制 / 删除直接放在每个对象行末
    const iconButtons = Array.from(win.document.querySelectorAll(
        '[data-role="object-item"] [data-action="duplicate"], [data-role="object-item"] [data-action="delete-object"]'));
    const objectRows = Array.from(win.document.querySelectorAll('[data-role="object-item"]'));
    check("PC 每个对象行末都有复制 / 删除两个图标，且各带自己的对象编号",
        objectRows.length > 0 && iconButtons.length === objectRows.length * 2 &&
        objectRows.every((row) => {
            const btns = Array.from(row.querySelectorAll('[data-action="duplicate"], [data-action="delete-object"]'));
            return btns.length === 2 && btns.every((b) => b.dataset.id === row.dataset.id);
        }) &&
        win.document.querySelectorAll('[data-role="props"] [data-action="duplicate"], [data-role="props"] [data-action="delete-object"]').length === 0,
        `${objectRows.length} 行 / ${iconButtons.length} 个按钮`);
    check("PC 对象行不再重复显示类型名称，也没有「选中对象」那一行",
        win.document.querySelectorAll('.annot-object-item__type').length === 0 &&
        win.document.querySelectorAll('[data-role="object-actions"]').length === 0 &&
        !css.includes("annot-object-actions__label"));
    check("PC 层级栏目只占一行高度，剩余空间归属性栏目",
        /\.annot-side-section\[data-section="layers"\] \{[^}]*flex: 0 0 auto/.test(css) &&
        /\.annot-side-section\[data-section="props"\] \{[^}]*flex: 1 1 auto/.test(css));
    check("PC 复制 / 删除是纯线条镂空图标（svg 与 path 都是 fill=none，只描边）",
        iconButtons.every((el) => {
            const svg = el.querySelector("svg[viewBox='0 0 48 48']");
            const paths = Array.from(el.querySelectorAll("svg path"));
            return el.tagName === "BUTTON" && !!svg &&
                svg.getAttribute("fill") === "none" && svg.getAttribute("stroke") === "currentColor" &&
                paths.length >= 2 && paths.every((path) => path.getAttribute("fill") === "none") &&
                (el.textContent || "").trim() === "";
        }) && css.includes("fill: none !important"),
        iconButtons.map((b) => b.innerHTML.slice(0, 60)).join(" | "));
    if (iconButtons.length >= 2) {
        const beforeCopy = count();
        iconButtons[0].dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        check("PC 点行末复制图标能复制出新对象", count() === beforeCopy + 1, `${beforeCopy} → ${count()}`);
        const beforeDelete = count();
        const deleteBtn = q('[data-role="object-item"] [data-action="delete-object"]');
        deleteBtn?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        check("PC 点行末删除图标能删掉那一行对象", count() === beforeDelete - 1, `${beforeDelete} → ${count()}`);
    }

    // ---- v0.12.1：本轮五处修复 ----
    // 1) 左侧工具栏默认单列，高度不够自动双列
    const toolBar = q(".annot-imagebar");
    check("PC 左侧工具栏默认单列垂直排列（没加双列类）",
        css.includes(".annot-imagebar__group {") && css.includes("flex-direction: column") &&
        css.includes(".annot-imagebar.is-two-col") &&
        toolBar?.classList.contains("is-two-col") === false);
    if (toolBar) {
        Object.defineProperty(toolBar, "clientHeight", {configurable: true, value: 300});
        Object.defineProperty(toolBar, "scrollHeight", {configurable: true, value: 620});
        win.dispatchEvent(new win.Event("resize"));
        check("PC 窗口高度不够时，左侧工具栏自动切换为双列",
            toolBar.classList.contains("is-two-col") === true &&
            css.includes("grid-template-columns: repeat(2, 34px)"));
        Object.defineProperty(toolBar, "scrollHeight", {configurable: true, value: 280});
        win.dispatchEvent(new win.Event("resize"));
        check("PC 高度恢复后，左侧工具栏回到单列",
            toolBar.classList.contains("is-two-col") === false);
    }

    // 2) 折叠拉手：absolute 相对插件容器，绝不用 fixed
    check("PC 折叠拉手用 absolute 相对插件容器，不再用 fixed 跑到思源窗口最右",
        /\.annot-sidebar\.is-collapsed \.annot-side-handle \{[^}]*position: absolute/.test(css) &&
        !/\.annot-sidebar\.is-collapsed \.annot-side-handle \{[^}]*position: fixed/.test(css));

    // 3) 层级四按钮真的能改上下覆盖
    const layerIds = () => Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? [])
        .map((g) => g.getAttribute("data-object-id"));
    const beforeLayer = layerIds();
    if (beforeLayer.length >= 2) {
        const target = beforeLayer[0];
        click(`[data-role="object-item"][data-id="${target}"]`);
        click('[data-role="layers"] [data-action="layer-bottom"]');
        check("PC 层级栏目「置底」把选中对象移到最下层",
            layerIds()[0] === target,
            `${beforeLayer.slice(0, 2).join(",")} → ${layerIds().slice(0, 2).join(",")}`);
        click('[data-role="layers"] [data-action="layer-top"]');
        check("PC 层级栏目「置顶」把选中对象移回最上层",
            layerIds()[layerIds().length - 1] === target);
    }

    // 4) 两端竖线连接线：中间线与两端竖线严丝合缝，不再留空隙
    click('button[data-tool="arrow"]');
    pickStyle("bar");
    draw("arrow", {x: 1000, y: 520}, {x: 1120, y: 580});
    const barGroup = lastGroup();
    const shaftNums = (barGroup?.querySelector("path.annot-shape")?.getAttribute("d") || "")
        .match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const barLines = Array.from(barGroup?.querySelectorAll("line.annot-bar") ?? []);
    const barMid = (line) => ({
        x: (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2,
        y: (Number(line.getAttribute("y1")) + Number(line.getAttribute("y2"))) / 2,
    });
    check("PC 两端竖线的中间连接线直接连到竖线中点，没有空隙",
        barLines.length === 2 && shaftNums.length === 4 &&
        barLines.every((line) => {
            const m = barMid(line);
            return Math.hypot(m.x - shaftNums[0], m.y - shaftNums[1]) < 0.01 ||
                Math.hypot(m.x - shaftNums[2], m.y - shaftNums[3]) < 0.01;
        }),
        `d=${barGroup?.querySelector("path.annot-shape")?.getAttribute("d")} 竖线=${barLines.length}`);

    // 5) 竖线双头：两端竖线 + 两个箭头头部
    pickStyle("barDouble");
    draw("arrow", {x: 1000, y: 660}, {x: 1120, y: 720});
    const barDoubleGroup = lastGroup();
    check("PC「竖线双头」同时画出两端竖线与两个箭头头部",
        (barDoubleGroup?.querySelectorAll("line.annot-bar").length ?? 0) === 2 &&
        (barDoubleGroup?.querySelectorAll("path.annot-head").length ?? 0) === 2,
        `${barDoubleGroup?.querySelectorAll("line.annot-bar").length} 竖线 / ${barDoubleGroup?.querySelectorAll("path.annot-head").length} 箭头`);

    // 6) 高亮：画笔 / 矩形两种模式（v1.1.0）
    click('button[data-tool="highlight"]');
    const modeChips = Array.from(win.document.querySelectorAll(
        '[data-role="context-bar"] [data-action="highlight-mode"]'));
    check("v1.1.0 选中高亮工具后，悬浮条给出「画笔 / 矩形」两个模式",
        modeChips.length === 2 && modeChips.some((b) => b.getAttribute("data-value") === "rect"),
        `模式按钮=${modeChips.length}`);
    modeChips.find((b) => b.getAttribute("data-value") === "rect")
        ?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const beforeHighlightRect = count();
    draw("highlight", {x: 1000, y: 60}, {x: 1140, y: 160});
    const highlightRectGroup = lastGroup();
    const highlightRectShape = highlightRectGroup?.querySelector("rect.annot-shape");
    check("v1.1.0 矩形高亮画出来是一块矩形色块，且没有描边",
        count() === beforeHighlightRect + 1 && !!highlightRectShape &&
        highlightRectShape.getAttribute("stroke") === "none" &&
        /^rgba\(/.test(highlightRectShape.getAttribute("fill") || ""),
        `stroke=${highlightRectShape?.getAttribute("stroke")} fill=${highlightRectShape?.getAttribute("fill")}`);
    check("v1.1.0 矩形高亮是独立对象：画完自动选中，四角缩放手柄齐全且不带旋转手柄",
        !!highlightRectGroup?.getAttribute("data-object-id") &&
        !!win.document.querySelector('[data-handle="resize:nw"]') &&
        !!win.document.querySelector('[data-handle="resize:se"]') &&
        !!win.document.querySelector('[data-handle="move"]') &&
        !win.document.querySelector('[data-handle="rotate"]'),
        `id=${highlightRectGroup?.getAttribute("data-object-id")}`);
    // 切回画笔模式，确认两种画法互不干扰
    click('button[data-tool="highlight"]');
    Array.from(win.document.querySelectorAll('[data-role="context-bar"] [data-action="highlight-mode"]'))
        .find((b) => b.getAttribute("data-value") === "brush")
        ?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const beforeBrush = count();
    draw("highlight", {x: 1000, y: 220}, {x: 1140, y: 300});
    check("v1.1.0 切回画笔模式后画的仍是笔迹（不是矩形）",
        count() === beforeBrush + 1 &&
        !!lastGroup()?.querySelector("path.annot-shape") &&
        !lastGroup()?.querySelector("rect.annot-shape"),
        `${count()} 个对象`);

    // 7) 防重叠：手里拿着某个工具时，按在同类已有对象上就选中它，不再叠一个
    {
        const lastOf = () => {
            const groups = Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []);
            return groups[groups.length - 1];
        };
        const rectBefore = count();
        draw("rect", {x: 400, y: 640}, {x: 560, y: 740});
        const rectId = lastOf()?.getAttribute("data-object-id");
        check("v1.2.0-alpha.19 防重叠：先画一个矩形备用",
            count() === rectBefore + 1 && !!rectId, `${count()} 个`);

        // 工具仍是矩形，在刚才那个矩形内部起手
        click('button[data-tool="rect"]');
        ptr("pointerdown", {x: 450, y: 680});
        ptr("pointermove", {x: 520, y: 720});
        const previewing = !!layer()?.querySelector(".annot-object.is-preview");
        ptr("pointerup", {x: 520, y: 720});
        check("v1.2.0-alpha.19 同类对象内按下不再叠一个新矩形",
            !previewing && count() === rectBefore + 1, `预览=${previewing} / ${count()} 个`);
        check("v1.2.0-alpha.19 同类对象内按下改为选中原来那个",
            !!layer()?.querySelector(`g.annot-object.is-selected[data-object-id="${rectId}"]`),
            `选中=${layer()?.querySelectorAll("g.annot-object.is-selected").length}`);

        // 不同类型不拦：在同一个矩形上画箭头，照常预览并生成新对象
        const arrowBefore = count();
        click('button[data-tool="arrow"]');
        ptr("pointerdown", {x: 450, y: 680});
        ptr("pointermove", {x: 520, y: 720});
        check("v1.2.0-alpha.19 在矩形上画箭头照常进入绘制预览",
            !!layer()?.querySelector(".annot-object.is-preview"));
        ptr("pointerup", {x: 520, y: 720});
        check("v1.2.0-alpha.19 在矩形上画箭头正常生成新对象",
            count() === arrowBefore + 1, `${arrowBefore} -> ${count()}`);
        // 清掉这两个测试对象，别影响收尾
        q('[data-action="undo"]')?.click();
        q('[data-action="undo"]')?.click();
    }

    click('[data-action="close"]');
    await tick();
}

// ---------------------------------------------------------------- 里程碑四：sidecar 持久化 + PNG 导出
if (process.argv[3] === "--m4") {
    const INDEX_PATH = "data/storage/petal/siyuan-plugin-annotate/index.json";
    const files = new Map();
    const uploads = [];
    const blockUpdates = [];
    const attrSets = [];
    const putCalls = [];
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

    // 合法的最小 PNG（1×1）：保存链路会在 IEND 前插入 tEXt 工程数据
    const PNG_BYTES = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
    );
    // 另一张合法 PNG（1×1 蓝色）：jsdom 的 canvas 是假的，靠它模拟「画面变了」，
    // 让内容指纹（文件名里的哈希）真的会变
    const PNG_BYTES_ALT = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQy7sDAAIWAWlXT0K6AAAAAElFTkSuQmCC",
        "base64",
    );
    let pngVariant = 0;
    /** 用例在「这里内容应该变了」时调一次，模拟成品字节变化 */
    const bumpPng = () => { pngVariant += 1; };
    /** 从 PNG 的 tEXt 块里把工程数据解出来（与 imagePackage.ts 的格式一致） */
    const readPacked = (buf) => {
        const bytes = Uint8Array.from(buf);
        let offset = 8;
        while (offset + 12 <= bytes.length) {
            const length = (((bytes[offset] << 24) | (bytes[offset + 1] << 16)
                | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
            const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
            if (type === "tEXt" && length < bytes.length - offset) {
                const text = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length));
                const split = text.indexOf("\0");
                if (split > 0 && text.slice(0, split) === "siyuan-plugin-annotate") {
                    return JSON.parse(text.slice(split + 1));
                }
            }
            offset += 12 + length;
        }
        return null;
    };
    const packedAt = (assetPath) => {
        const buf = files.get("data/" + assetPath);
        return buf ? readPacked(buf) : null;
    };
    // v0.10.7：成品按内容哈希换文件名，断言不能写死路径，统一从这里取
    const lastWritten = () => {
        const filePath = putCalls[putCalls.length - 1] || "";
        return filePath.startsWith("data/") ? filePath.slice(5) : filePath;
    };
    const lastBlockImage = () => {
        const data = blockUpdates[blockUpdates.length - 1]?.data || "";
        const found = data.match(/\]\((assets\/[^)\s]+)/);
        return found ? found[1] : "";
    };
    // 一次保存的顺序是「先写文件、再改笔记」，所以最近一次写入就是本次成品
    const savedAsset = () => lastWritten() || lastBlockImage();
    const removedAssets = [];
    // 默认认为没有别处引用；个别用例可以改 refCount 模拟「被别的文档引用」
    let refCount = 0;

    // 模拟思源文件 API 与上传接口（资源内容是二进制，按字节存）
    globalThis.fetch = async (url, options = {}) => {
        const endpoint = String(url);
        if (endpoint === "/api/file/getFile") {
            const {path: filePath} = JSON.parse(options.body);
            const data = files.get(filePath);
            return new Response(data ?? "not found", {
                status: data === undefined ? 404 : 200,
                headers: {"Content-Type": "application/json"},
            });
        }
        if (endpoint === "/api/file/putFile") {
            const form = options.body;
            const filePath = form.get("path");
            const file = form.get("file");
            putCalls.push(filePath);
            files.set(filePath, Buffer.from(await file.arrayBuffer()));
            return new Response(JSON.stringify({code: 0, msg: "", data: null}), {status: 200});
        }
        if (endpoint === "/upload") {
            const form = options.body;
            const file = form.get("file[]");
            uploads.push(file);
            const name = file?.name || "upload.bin";
            const assetPath = "assets/" + name;
            files.set("data/" + assetPath, Buffer.from(await file.arrayBuffer()));
            return new Response(JSON.stringify({
                code: 0, msg: "", data: {succMap: {[name]: assetPath}},
            }), {status: 200});
        }
        if (endpoint === "/api/block/updateBlock") {
            const body = JSON.parse(options.body);
            blockUpdates.push(body);
            return new Response(JSON.stringify({code: 0, msg: "", data: null}), {status: 200});
        }
        if (endpoint === "/api/attr/getBlockAttrs") {
            const {id} = JSON.parse(options.body);
            return new Response(JSON.stringify({
                code: 0, msg: "", data: {id, updated: "20261108180000", style: "text-align: center;"},
            }), {status: 200});
        }
        if (endpoint === "/api/attr/setBlockAttrs") {
            attrSets.push(JSON.parse(options.body));
            return new Response(JSON.stringify({code: 0, msg: "", data: null}), {status: 200});
        }
        if (endpoint === "/api/file/removeFile") {
            const {path: filePath} = JSON.parse(options.body);
            removedAssets.push(filePath);
            files.delete(filePath);
            return new Response(JSON.stringify({code: 0, msg: "", data: null}), {status: 200});
        }
        // v0.10.10：清理旧成品改走内核的资源清理接口（会更新索引、留历史备份）
        if (endpoint === "/api/asset/getUnusedAssets") {
            const items = [...files.keys()]
                .filter((key) => /^data\/assets\/.*-annot-[0-9a-f]{8}\.png$/.test(key))
                .map((key) => ({item: key.slice(5), name: key.split("/").pop(), path: key.slice(5)}));
            return new Response(JSON.stringify({code: 0, msg: "", data: items}), {status: 200});
        }
        if (endpoint === "/api/asset/removeUnusedAsset") {
            const {path: assetPath} = JSON.parse(options.body);
            removedAssets.push(`data/${assetPath}`);
            files.delete(`data/${assetPath}`);
            return new Response(JSON.stringify({code: 0, msg: "", data: null}), {status: 200});
        }
        if (endpoint === "/api/query/sql") {
            return new Response(JSON.stringify({code: 0, msg: "", data: [{n: refCount}]}), {status: 200});
        }
        return new Response("not found", {status: 404});
    };

    // 普通底图资源：保存时会读它们的字节内嵌成完整原图
    for (const name of ["demo.png", "photo.png", "caption.png", "mixed.png", "list.png", "with-overlay.png", "bg.png", "renamed.png", "photo.jpg", "legacy-annot.svg"]) {
        files.set("data/assets/" + name, "FAKE-IMAGE-BYTES");
    }

    // jsdom 没有 Canvas / Image / XMLSerializer，导出链路需要最小替身
    globalThis.XMLSerializer = win.XMLSerializer;
    globalThis.Image = class {
        set src(value) {
            this._src = value;
            setTimeout(() => this.onload?.(), 0);
        }
        get src() { return this._src; }
    };
    win.HTMLCanvasElement.prototype.getContext = () => ({drawImage() {}, fillRect() {}, fillStyle: ""});
    win.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AAAA";
    win.HTMLCanvasElement.prototype.toBlob = function (callback) {
        callback(new Blob([pngVariant % 2 === 1 ? PNG_BYTES_ALT : PNG_BYTES], {type: "image/png"}));
    };

    const openWith = (assetPath, blockId) => {
        const fakeImg = {getAttribute: (n) => (n === "data-src" ? assetPath : assetPath + "?v=2")};
        const fakeBlock = {getAttribute: (n) => (n === "data-type" ? "NodeParagraph" : blockId)};
        const detail = {
            protyle: {},
            element: {
                querySelector: (s) => (s === "img" ? fakeImg : null),
                closest: (s) => (s === "[data-node-id]" ? fakeBlock : null),
            },
            menu: {addItem: () => {}, addSeparator: () => {}},
        };
        listeners.get("open-menu-image")?.({detail});
        return mainMenuItems[mainMenuItems.length - 1];
    };
    // 图文混排：段落里除图片还有文字
    const openMixed = (assetPath, blockId) => {
        const fakeImg = {getAttribute: (n) => (n === "data-src" ? assetPath : assetPath + "?v=2")};
        const fakeBlock = {
            getAttribute: (n) => (n === "data-type" ? "NodeParagraph" : blockId),
            textContent: "图 1：这是一段说明文字",
        };
        const detail = {
            protyle: {},
            element: {
                querySelector: (s) => (s === "img" ? fakeImg : null),
                closest: (s) => (s === "[data-node-id]" ? fakeBlock : null),
            },
            menu: {addItem: () => {}, addSeparator: () => {}},
        };
        listeners.get("open-menu-image")?.({detail});
        return mainMenuItems[mainMenuItems.length - 1];
    };
    let svg = null;
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    const count = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? -1;
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const ptr = (type, pt, target) => {
        const c = toClient(pt.x, pt.y);
        (target || svg).dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
        }));
    };
    const draw = (tool, a, b) => {
        click(`button[data-tool="${tool}"]`);
        ptr("pointerdown", a);
        ptr("pointermove", {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
        ptr("pointerup", b);
    };

    // 1) 首次打开，画三个不同类型的标注
    openWith("assets/demo.png", "block-A")?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M4 编辑器已打开", !!svg);
    check("M4 工具栏有保存按钮（v0.21.0 起不再有「导出为 PNG」）",
        !!q('[data-action="save"]') && !q('[data-action="export"]') &&
        !Array.from(win.document.querySelectorAll(".annot-titlebar .annot-btn"))
            .some((el) => (el.textContent || "").includes("导出")));
    draw("arrow", {x: 60, y: 60}, {x: 220, y: 140});
    draw("rect", {x: 260, y: 60}, {x: 420, y: 180});
    click('button[data-tool="text"]');
    ptr("pointerdown", {x: 80, y: 260});
    const textArea = q(".annot-text-editor");
    textArea.value = "持久化的文字";
    textArea.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    await settle();
    check("M4 保存前有三个标注", count() === 3, `${count()} 个`);

    // 2) 首次保存：就地覆盖同一个 PNG，不产生新资源 / 附档 / 笔记改动
    const firstAsset = "assets/demo.png";   // v0.10.11：路径始终不变
    const fileKeysBefore = new Set(files.keys());
    click('[data-action="save"]');
    await settle();
    const packed = packedAt("assets/demo.png");
    check("M4 保存时就地覆盖原来的 PNG（路径不变）",
        putCalls.includes("data/assets/demo.png") && packed !== null, putCalls.join(","));
    check("M4 保存没有上传任何新资源", uploads.length === 0, uploads.map((f) => f?.name).join(","));
    const newKeys = [...files.keys()].filter((key) => !fileKeysBefore.has(key));
    check("M4 保存没有生成任何附档 / 索引 / 额外文件",
        newKeys.length === 0 && !files.has(INDEX_PATH), newKeys.join(","));
    check("M4 保存没有改动笔记内容（不需要 updateBlock）",
        blockUpdates.length === 0, JSON.stringify(blockUpdates));
    const pngBuf = files.get("data/assets/demo.png");
    check("M4 写回去的仍是合法 PNG（PNG 签名 + IEND 收尾）",
        !!pngBuf && pngBuf.subarray(0, 8).equals(PNG_BYTES.subarray(0, 8)) &&
        pngBuf.subarray(-8, -4).toString() === "IEND",
        pngBuf ? `${pngBuf.length} 字节` : "missing");
    check("M4 PNG 的 tEXt 里带完整底图（不重压缩）",
        !!packed?.base?.dataUrl?.startsWith("data:image/png;base64,") && packed?.base?.width === 1200,
        packed ? `${packed.base?.width}×${packed.base?.height}` : "null");
    check("M4 PNG 里带 3 个矢量标注（含文字内容）",
        packed?.scene?.objects?.length === 3 &&
        JSON.stringify(packed.scene.objects).includes("持久化的文字"),
        `${packed?.scene?.objects?.length} 个`);
    check("M4 PNG 里带画布 / 块 ID / 封装版本号",
        packed?.version === 1 && packed?.scene?.canvas?.width === 1200 &&
        packed?.scene?.canvas?.height === 800 && packed?.scene?.blockId === "block-A",
        JSON.stringify(packed?.scene?.canvas || null));
    check("M4 保存后窗口自动关闭", !q(".annot-root"));

    // 2b) 非 PNG 底图：保存后换成 PNG 成品（带内容指纹的新名字），链接跟着改；
    //     内容没变时反复保存不会再多出文件
    blockUpdates.length = 0;
    const openResized = (assetPath, blockId, width) => {
        const fakeImg = {
            getAttribute: (n) => (n === "data-src" ? assetPath : n === "alt" ? "我的图注" : assetPath + "?v=2"),
            parentElement: {style: {width}},
            closest: () => null,
        };
        const fakeBlock = {getAttribute: (n) => (n === "data-type" ? "NodeParagraph" : blockId)};
        const detail = {
            protyle: {},
            element: {
                querySelector: (s2) => (s2 === "img" ? fakeImg : null),
                closest: (s2) => (s2 === "[data-node-id]" ? fakeBlock : null),
            },
            menu: {addItem: () => {}, addSeparator: () => {}},
        };
        listeners.get("open-image-menu")?.({detail});
        listeners.get("open-menu-image")?.({detail});
        return mainMenuItems[mainMenuItems.length - 1];
    };
    openResized("assets/photo.jpg", "block-W", "300px")?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    bumpPng();   // 这里画面确实变了
    draw("rect", {x: 200, y: 200}, {x: 400, y: 380});
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const jpgAsset = "assets/photo-annot.png";
    check("M4 非 PNG 首次保存只换一次链接，指向固定的 -annot.png",
        blockUpdates.length === 1 &&
        blockUpdates[0].data === '![我的图注](assets/photo-annot.png){: style="width: 300px;"}',
        String(blockUpdates[0]?.data));
    check("M4 换链接时把块属性（对齐等）写回去，且不碰 id / updated",
        attrSets.some((call) => call.id === "block-W" && call.attrs?.style === "text-align: center;" &&
            !("id" in call.attrs) && !("updated" in call.attrs)),
        JSON.stringify(attrSets[attrSets.length - 1] || null));
    check("M4 新路径的图片里带完整工程数据", !!packedAt(jpgAsset));
    check("M4 非 PNG 原图字节按原格式内嵌",
        packedAt(jpgAsset)?.base?.dataUrl?.startsWith("data:image/jpeg;base64,"),
        String(packedAt(jpgAsset)?.base?.dataUrl).slice(0, 30));
    blockUpdates.length = 0;
    const writesBefore = putCalls.length;
    // 用真实的 <img> 打开：这一轮要验证「一个字都没改时，正文那张图连属性都不能被碰」
    const realHolder = win.document.createElement("div");
    realHolder.setAttribute("data-node-id", "block-W");
    realHolder.setAttribute("data-type", "NodeParagraph");
    realHolder.innerHTML = `<span><img data-src="${jpgAsset}" src="${jpgAsset}"></span>`;
    win.document.body.append(realHolder);
    const realImg = realHolder.querySelector("img");
    listeners.get("open-menu-image")?.({detail: {
        protyle: {},
        element: {
            querySelector: (sel) => (sel === "img" ? realImg : null),
            closest: (sel) => (sel === "[data-node-id]" ? realHolder : null),
        },
        menu: {addItem: () => {}, addSeparator: () => {}},
    }});
    mainMenuItems[mainMenuItems.length - 1]?.click();
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 内容没变再保存：只给 src 加缓存串刷新，不碰 srcset",
        /^assets\/photo-annot\.png\?v=\d+$/.test(realImg.getAttribute("src") || "") &&
        realImg.getAttribute("srcset") === null,
        String(realImg.getAttribute("src")));
    realHolder.remove();
    check("M4 内容没变时反复保存仍覆盖同一个文件，不重复改笔记",
        blockUpdates.length === 0 &&
        putCalls.filter((path) => path === "data/assets/photo-annot.png").length === 2,
        `${blockUpdates.length} 次更新 / ${putCalls.filter((path) => path === "data/assets/photo-annot.png").length} 次写入`);
    click('[data-action="close"]');
    await settle();

    // 2c) 图片带图注：PNG 路径不变，笔记内容和图注 DOM 都不需要动
    const titledBlock = win.document.createElement("div");
    titledBlock.setAttribute("data-node-id", "block-CAP");
    titledBlock.setAttribute("data-type", "NodeParagraph");
    titledBlock.innerHTML = '<span data-type="img" class="img"><span> </span><span>'
        + '<img data-src="assets/caption.png" src="/assets/caption.png" alt="我的图注" data-title="图注文字" />'
        + '<span class="protyle-action__title"><span>图注文字</span></span>'
        + '</span><span> </span></span>';
    win.document.body.append(titledBlock);
    const capWrap = titledBlock.querySelector('[data-type="img"]');
    listeners.get("open-menu-image")?.({detail: {
        protyle: {},
        element: capWrap,
        menu: {addItem: () => {}, addSeparator: () => {}},
    }});
    mainMenuItems[mainMenuItems.length - 1]?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    bumpPng();   // 这里画面确实变了
    draw("rect", {x: 100, y: 100}, {x: 220, y: 200});
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 带图注的图片照常就地写回，不改笔记内容",
        blockUpdates.length === 0 && !!packedAt("assets/caption.png"),
        `${blockUpdates.length} 次更新`);
    check("M4 图注 DOM 保持原样",
        titledBlock.querySelector('[data-title]')?.getAttribute("data-title") === "图注文字");
    titledBlock.remove();
    click('[data-action="close"]');
    await settle();

    // 3) 重新打开这张成品：从 tEXt 工程数据里拆出底图 + 场景，继续编辑
    openWith(firstAsset, "block-A")?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M4 重新打开还原三个标注", count() === 3, `${count()} 个`);
    check("M4 还原了文字内容",
        Array.from(layer()?.querySelectorAll("text.annot-shape") ?? []).some((e) => e.textContent === "持久化的文字"));
    const baseSrc = q('[data-role="base"]')?.getAttribute("src") || "";
    check("M4 底图取的是包里内嵌的完整原图，不是成品图（否则标注会叠两遍）",
        baseSrc.startsWith("data:image/png;base64,"), baseSrc.slice(0, 40));
    const firstHit = layer()?.querySelector('g[data-object-id] [data-role="hit"]');
    const before = layer()?.querySelector(".annot-shape")?.getAttribute("d") ||
        layer()?.querySelector("rect.annot-shape")?.getAttribute("x");
    ptr("pointerdown", {x: 100, y: 90}, firstHit);
    ptr("pointermove", {x: 140, y: 110});
    ptr("pointerup", {x: 140, y: 110});
    const after = layer()?.querySelector(".annot-shape")?.getAttribute("d") ||
        layer()?.querySelector("rect.annot-shape")?.getAttribute("x");
    check("M4 还原后仍可继续拖拽修改", before !== after, `${before} → ${after}`);

    // 3b) 再改一次再保存：换新名字但删掉上一版，文件总数不变
    const keysAfterFirst = files.size;
    bumpPng();   // 这里画面确实变了
    draw("rect", {x: 500, y: 500}, {x: 600, y: 600});
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const secondAsset = "assets/demo.png";
    check("M4 同一张图反复保存，资源文件数量始终不变",
        files.size === keysAfterFirst, `${keysAfterFirst} → ${files.size}`);
    check("M4 反复保存后工程数据更新为 4 个标注",
        packedAt("assets/demo.png")?.scene?.objects?.length === 4,
        `${packedAt("assets/demo.png")?.scene?.objects?.length} 个`);
    check("M4 反复保存仍没有附档 / 索引",
        ![...files.keys()].some((key) => key.endsWith(".annot.json")) && !files.has(INDEX_PATH));

    // 4) 数据跟着图片文件走：改名后仍能恢复（不再依赖块 ID 索引）
    click('[data-action="close"]');
    await settle();
    files.set("data/assets/renamed.png", files.get("data/" + secondAsset));
    openWith("assets/renamed.png", "block-A")?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M4 图片改名后标注仍存在（数据在图片里）", count() === 4, `${count()} 个`);
    click('[data-action="close"]');
    await settle();

    // 5) v0.21.0：导出入口整体移除 —— 打开旧图只读出来，不会上传新资源、不会插内容
    openWith(secondAsset, "block-A")?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    const uploadsBeforeOpen = uploads.length;
    check("M4 没有导出按钮，打开后也不会偷偷上传或插入内容",
        uploads.length === uploadsBeforeOpen && insertedContents.length === 0 &&
        !q('[data-action="export"]'),
        `${uploads.length} / ${insertedContents.length}`);
    check("M4 导出移除后原图仍然完好", !!packedAt(secondAsset));

    // 6) 旋转后保存：换名 + 改链接，工程数据里的画布变成竖版
    blockUpdates.length = 0;
    bumpPng();   // 这里画面确实变了
    click('[data-canvas-op="rotate-cw"]');
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rotatedAsset = "assets/demo.png";
    check("M4 旋转后保存不改笔记内容", blockUpdates.length === 0, JSON.stringify(blockUpdates));
    const rotatedPack = packedAt(rotatedAsset);
    check("M4 旋转后工程数据的画布变成 800 × 1200 且带旋转矩阵",
        rotatedPack?.scene?.canvas?.width === 800 && rotatedPack?.scene?.canvas?.height === 1200 &&
        rotatedPack?.scene?.canvas?.matrix?.b === 1 && rotatedPack?.scene?.canvas?.matrix?.c === -1,
        rotatedPack ? `${rotatedPack.scene.canvas.width}×${rotatedPack.scene.canvas.height}` : "null");
    check("M4 旋转后标注一个都没丢",
        rotatedPack?.scene?.objects?.length === 4, `${rotatedPack?.scene?.objects?.length}`);

    click('[data-action="close"]');
    await settle();
    openWith(rotatedAsset, "block-A")?.click();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    const transformLayer = win.document.querySelector('[data-role="transform"]');
    check("M4 重新打开还原成竖版画布",
        transformLayer?.style.width === "800px" && transformLayer?.style.height === "1200px",
        `${transformLayer?.style.width}×${transformLayer?.style.height}`);
    check("M4 重新打开时按新画布重新适应窗口",
        /scale\(0\.53\)/.test(transformLayer?.style.transform || ""),
        transformLayer?.style.transform || "");
    check("M4 重新打开时底图沿用工程数据里的旋转矩阵",
        /matrix\(0,\s*1,\s*-1,\s*0,\s*800,\s*0\)/.test(q('[data-role="base"]')?.style.transform || ""),
        q('[data-role="base"]')?.style.transform || "");
    check("M4 旋转后的标注仍可继续编辑", count() === 4, `${count()} 个`);

    // 6b) 内核给资源加过时间戳后缀：名字里不会再叠第二层 -annot
    click('[data-action="close"]');
    await settle();
    files.set("data/assets/demo-20261108180000-abc1234.png", files.get("data/" + rotatedAsset));
    openWith("assets/demo-20261108180000-abc1234.png", "block-A")?.click();
    await settle();
    bumpPng();   // 这里画面确实变了
    click('[data-canvas-op="flip-h"]');
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 带时间戳后缀的资源名继续就地覆盖，不派生新文件",
        putCalls[putCalls.length - 1] === "data/assets/demo-20261108180000-abc1234.png",
        String(putCalls[putCalls.length - 1]));
    click('[data-action="close"]');
    await settle();

    // 7) 图文混排：旧版只能存附档，现在照样就地写回，而且不动笔记内容
    blockUpdates.length = 0;
    openMixed("assets/mixed.png", "block-M").click();
    await settle();
    bumpPng();   // 这里画面确实变了
    click('[data-canvas-op="rotate-cw"]');
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 图文混排段落不会被整段替换", blockUpdates.length === 0, `${blockUpdates.length} 次`);
    check("M4 图文混排也把结果写进图片本身（不再只存附档）",
        packedAt("assets/mixed.png")?.scene?.canvas?.width === 800,
        `${packedAt("assets/mixed.png")?.scene?.canvas?.width}`);
    check("M4 图文混排没有产生附档",
        ![...files.keys()].some((key) => key.endsWith(".annot.json")));
    click('[data-action="close"]');
    await settle();

    // 8) 非段落块（列表项等）同样安全
    blockUpdates.length = 0;
    const openListItem = (assetPath, blockId) => {
        const fakeImg = {getAttribute: (n) => (n === "data-src" ? assetPath : assetPath + "?v=2")};
        const fakeBlock = {getAttribute: (n) => (n === "data-type" ? "NodeListItem" : blockId), textContent: ""};
        const detail = {
            protyle: {},
            element: {
                querySelector: (s) => (s === "img" ? fakeImg : null),
                closest: (s) => (s === "[data-node-id]" ? fakeBlock : null),
            },
            menu: {addItem: () => {}, addSeparator: () => {}},
        };
        listeners.get("open-menu-image")?.({detail});
        return mainMenuItems[mainMenuItems.length - 1];
    };
    openListItem("assets/list.png", "block-L").click();
    await settle();
    click('[data-canvas-op="flip-h"]');
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 列表项里的图片不会被整段替换", blockUpdates.length === 0, `${blockUpdates.length} 次`);
    check("M4 列表项里的图片也写回了成品", !!packedAt("assets/list.png"));
    click('[data-action="close"]');
    await settle();

    // 9) 段落里本来就有只读预览层（里面有文字标注）时也不能被误判
    blockUpdates.length = 0;
    const openWithOverlay = (assetPath, blockId) => {
        const block = win.document.createElement("div");
        block.setAttribute("data-node-id", blockId);
        block.setAttribute("data-type", "NodeParagraph");
        block.innerHTML = `<span data-type="img"><span> </span><span>` +
            `<img data-src="${assetPath}" src="${assetPath}">` +
            `<svg class="annot-doc-overlay"><text x="10" y="30">这里需要重点看</text></svg>` +
            `</span><span> </span></span>`;
        const img = block.querySelector("img");
        const detail = {
            protyle: {},
            element: {
                querySelector: (sel) => (sel === "img" ? img : null),
                closest: (sel) => (sel === "[data-node-id]" ? block : null),
            },
            menu: {addItem: () => {}, addSeparator: () => {}},
        };
        listeners.get("open-menu-image")?.({detail});
        return mainMenuItems[mainMenuItems.length - 1];
    };
    openWithOverlay("assets/with-overlay.png", "block-O").click();
    await settle();
    bumpPng();   // 这里画面确实变了
    click('[data-canvas-op="rotate-cw"]');
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 段落里已有标注预览层也能就地写回图片",
        blockUpdates.length === 0 && !!packedAt("assets/with-overlay.png"),
        `${blockUpdates.length} 次更新`);
    click('[data-action="close"]');
    await settle();

    // 10) 画布底色随工程数据一起保存
    blockUpdates.length = 0;
    openMixed("assets/bg.png", "block-B").click();
    await settle();
    click('[data-canvas-op="extend"]');
    click('[data-bg="white"]');
    const bgMargin = q('[data-role="extend-top"]');
    bgMargin.value = "20";
    bgMargin.dispatchEvent(new win.Event("input", {bubbles: true}));
    click('[data-action="extend-apply"]');
    await settle();
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const bgSaved = packedAt("assets/bg.png")?.scene?.canvas;
    check("M4 画布底色随工程数据一起保存",
        bgSaved?.background === "#FFFFFF" && bgSaved?.width === 1240 && bgSaved?.height === 840,
        bgSaved ? `${bgSaved.width}×${bgSaved.height} bg=${bgSaved.background}` : "missing");
    click('[data-action="close"]');
    await settle();

    // 11) 升级前留下的 -annot.svg：只读兼容，保存一次就自动转成新封装
    const legacyScene = {
        version: 2, objects: [],
        canvas: {width: 10, height: 10, naturalWidth: 10, naturalHeight: 10,
            matrix: {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}, background: null},
        blockId: "block-OLD", assetPath: "assets/legacy-annot.svg",
        imageWidth: 10, imageHeight: 10,
    };
    const legacySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"'
        + ' viewBox="0 0 10 10" data-annot="siyuan-annotate-svg">'
        + `<metadata id="annotate-scene" data-encoding="base64">${Buffer.from(JSON.stringify(legacyScene)).toString("base64")}</metadata>`
        + '<image id="annotate-source" x="0" y="0" width="10" height="10" href="data:image/png;base64,AAAA"/></svg>';
    files.set("data/assets/legacy-annot.svg", legacySvg);
    openWith("assets/legacy-annot.svg", "block-OLD")?.click();
    await settle();
    check("M4 老版 -annot.svg 仍能打开并拆出画布",
        q('[data-role="transform"]')?.style.width === "10px",
        String(q('[data-role="transform"]')?.style.width));
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M4 老图保存一次就升级成新的 PNG 封装",
        !!packedAt("assets/legacy-annot.png"),
        [...files.keys()].filter((key) => key.includes("legacy")).join(","));
    click('[data-action="close"]');
    await settle();
}

// ---------------------------------------------------------------- 里程碑五：体验收尾
if (process.argv[3] === "--m5") {
    Object.defineProperty(globalThis, "localStorage", {value: win.localStorage, configurable: true});
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const key = (k, options = {}) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
        key: k, bubbles: true, cancelable: true, ...options,
    }));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    let svg = null;

    const openM5 = () => {
        const d = makeDetail();
        listeners.get("open-menu-image")?.({detail: d.detail});
        d.getItem()?.click();
    };
    openM5();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    const root = () => win.document.querySelector(".annot-root");
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    const count = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? -1;
    const objectIds = () => Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? [])
        .map((g) => g.getAttribute("data-object-id"));
    const drawRect = (a, b) => {
        click('button[data-tool="rect"]');
        const p1 = toClient(a.x, a.y);
        const p2 = toClient(b.x, b.y);
        const mid = {clientX: (p1.clientX + p2.clientX) / 2, clientY: (p1.clientY + p2.clientY) / 2};
        for (const [type, point] of [["pointerdown", p1], ["pointermove", mid], ["pointerup", p2]]) {
            svg.dispatchEvent(new win.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, clientX: point.clientX, clientY: point.clientY,
            }));
        }
    };

    // 1) 主题三模式 + 跟随思源
    win.document.documentElement.setAttribute("data-theme-mode", "dark");
    await settle();
    check("M5 跟随思源深色主题", root()?.getAttribute("data-annot-theme") === "dark");
    win.document.documentElement.setAttribute("data-theme-mode", "light");
    await settle();
    check("M5 切换思源浅色时界面跟随", root()?.getAttribute("data-annot-theme") === "light");
    const themeSelect = q('[data-role="theme-select"]');
    check("M5 有主题三模式选择器", !!themeSelect && themeSelect.options.length === 3);
    themeSelect.value = "dark";
    themeSelect.dispatchEvent(new win.Event("change", {bubbles: true}));
    check("M5 强制深色生效", root()?.getAttribute("data-annot-theme") === "dark");
    check("M5 主题偏好已持久化", win.localStorage.getItem("siyuan-plugin-annotate:theme") === "dark");
    themeSelect.value = "follow";
    themeSelect.dispatchEvent(new win.Event("change", {bubbles: true}));
    check("M5 切回跟随思源", root()?.getAttribute("data-annot-theme") === "light");

    // 2) 窄窗口工具栏折叠 / 展开
    win.__rootWidth = 700;
    win.dispatchEvent(new win.Event("resize"));
    check("M5 窗口变窄时工具栏折叠为下拉", root()?.classList.contains("is-compact"));
    check("M5 工具下拉菜单初始隐藏", q('[data-role="tool-menu"]')?.hidden === true);
    click('[data-action="tools-menu"]');
    check("M5 点击工具按钮展开下拉", q('[data-role="tool-menu"]')?.hidden === false);
    check("M5 下拉里仍有全部绘图工具（11 个，选择在悬浮条上）",
        q('[data-role="tool-menu"]')?.querySelectorAll("button[data-tool]").length === 12);
    win.__rootWidth = 1000;
    win.dispatchEvent(new win.Event("resize"));
    check("M5 窗口变宽后恢复完整工具栏", !root()?.classList.contains("is-compact"));
    check("M5 恢复时自动收起下拉", q('[data-role="tool-menu"]')?.hidden === true);

    // 3) 快捷键帮助
    key("?");
    check("M5 ? 打开快捷键帮助", q('[data-role="help"]')?.hidden === false);
    check("M5 帮助列出工具与快捷键", (q('[data-role="help"]')?.querySelectorAll(".annot-help__row").length ?? 0) >= 8);
    click('[data-action="close-help"]');
    check("M5 帮助可关闭", q('[data-role="help"]')?.hidden === true);

    // 4) 滚轮缩放 / 按钮缩放 / 适应窗口
    const zoomText = () => q('[data-role="zoom"]')?.textContent;
    const fitZoom = zoomText();
    win.document.querySelector(".annot-stage").dispatchEvent(new win.WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaY: -120, clientX: 300, clientY: 250,
    }));
    check("M5 滚轮可缩放", zoomText() !== fitZoom, `${fitZoom} → ${zoomText()}`);
    click('[data-action="zoom-in"]');
    check("M5 放大按钮可用", zoomText() !== fitZoom);
    click('[data-action="zoom-fit"]');
    check("M5 适应窗口恢复初始缩放", zoomText() === fitZoom, `${zoomText()} vs ${fitZoom}`);

    // 5) 连续 10 次撤销 / 重做结果一致
    // 排成两行网格：同类对象不许互相压着画（会在起手处被防重叠拦成选中）
    for (let i = 0; i < 10; i++) {
        const col = i % 5;
        const row = Math.floor(i / 5);
        drawRect({x: 30 + col * 120, y: 30 + row * 120}, {x: 110 + col * 120, y: 100 + row * 120});
    }
    check("M5 连续画出 10 个标注", count() === 10, `${count()} 个`);
    const idsBefore = objectIds().join(",");
    for (let i = 0; i < 10; i++) key("z", {ctrlKey: true});
    check("M5 连续撤销 10 次回到空白", count() === 0, `${count()} 个`);
    for (let i = 0; i < 10; i++) key("z", {ctrlKey: true, shiftKey: true});
    check("M5 连续重做 10 次恢复 10 个标注", count() === 10, `${count()} 个`);
    check("M5 重做后对象与顺序完全一致", objectIds().join(",") === idsBefore);

    // 6) 侧栏：层级 / 复制（属性栏目已在 v0.21.0 移除）
    click(`[data-role="object-item"][data-id="${objectIds()[0]}"]`);
    check("M5 层级栏目有置顶 / 上移 / 下移 / 置底四个按钮",
        !!q('[data-role="layers"] [data-action="layer-top"]') &&
        !!q('[data-role="layers"] [data-action="layer-bottom"]'));
    check("M5 对象行末有复制按钮；右侧面板只剩对象与层级（属性已移除）",
        !!q('[data-role="object-item"] [data-action="duplicate"]') &&
        !q('[data-role="props"]') && !q('[data-section="props"]') &&
        !!q('[data-section="objects"]') && !!q('[data-section="layers"]'));
    const firstId = objectIds()[0];
    click(`[data-role="layers"] [data-action="layer-top"]`);
    check("M5 置顶改变绘制顺序", objectIds()[objectIds().length - 1] === firstId);
    key("d", {ctrlKey: true});
    check("M5 Ctrl+D 复制选中对象", count() === 11, `${count()} 个`);

    // 6a) 抓手（v0.26.1）：移动 / 角点等比 / 边中点改比例
    {
        drawRect({x: 120, y: 140}, {x: 260, y: 220});
        await settle();
        const names = () => Array.from(win.document.querySelectorAll('[data-role="handles"] [data-handle]'))
            .map((el) => el.getAttribute("data-handle"));
        check("M5 画好的矩形带「移动」抓手，不用先切回选择工具",
            names().includes("move"), names().join(","));

        const box = () => {
            const r = Array.from(layer().querySelectorAll("rect.annot-shape")).pop();
            return {
                x: Number(r.getAttribute("x")), y: Number(r.getAttribute("y")),
                w: Number(r.getAttribute("width")), h: Number(r.getAttribute("height")),
            };
        };
        // 注意：jsdom 里 SVG 元素的 getBoundingClientRect 全是 0，
        // 所以坐标一律用「图片坐标 + toClient 换算」，不能读元素 rect。
        const fire = (type, pt, target) => {
            const c = toClient(pt.x, pt.y);
            (target || svg).dispatchEvent(new win.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
            }));
        };
        const grab = (name, from, to) => {
            const el = win.document.querySelector(`[data-role="handles"] [data-handle="${name}"] circle`);
            fire("pointerdown", from, el);
            fire("pointermove", to);
            fire("pointerup", to);
        };

        const b0 = box();
        const c0 = {x: b0.x + b0.w / 2, y: b0.y + b0.h / 2};
        grab("move", c0, {x: c0.x + 40, y: c0.y + 24});
        const b1 = box();
        check("M5 拖「移动」抓手整体平移：尺寸不变、位置跟着走",
            Math.abs(b1.w - b0.w) < 0.6 && Math.abs(b1.h - b0.h) < 0.6 &&
            b1.x > b0.x + 30 && b1.y > b0.y + 16,
            `${b0.x.toFixed(0)},${b0.y.toFixed(0)} → ${b1.x.toFixed(0)},${b1.y.toFixed(0)}`);

        const ratio = b1.w / b1.h;
        const se = {x: b1.x + b1.w, y: b1.y + b1.h};
        grab("resize:se", se, {x: se.x + 60, y: se.y + 6});
        const b2 = box();
        check("M5 拖四角是等比缩放：宽高比保持不变",
            Math.abs(b2.w / b2.h - ratio) < 0.03 && b2.w > b1.w + 20,
            `${b1.w.toFixed(1)}×${b1.h.toFixed(1)} → ${b2.w.toFixed(1)}×${b2.h.toFixed(1)}`);

        const w2 = b2.w, h2 = b2.h;
        const e2 = {x: b2.x + b2.w, y: b2.y + b2.h / 2};
        grab("resize:e", e2, {x: e2.x + 40, y: e2.y});
        const b3 = box();
        check("M5 拖四边中点只改那一条边：宽变、高不变",
            b3.w > w2 + 20 && Math.abs(b3.h - h2) < 1.2,
            `${w2.toFixed(1)}×${h2.toFixed(1)} → ${b3.w.toFixed(1)}×${b3.h.toFixed(1)}`);

        // 手柄的屏幕尺寸必须恒定：底图一缩放，图片单位半径就要按新比例重算
        const radiusInImage = () => Number(win.document.querySelector(
            '[data-role="handles"] [data-handle="resize:se"] circle')?.getAttribute("r") || 0);
        const r1 = radiusInImage();
        click('[data-action="zoom-in"]');
        await settle();
        await settle();
        const r2 = radiusInImage();
        check("M5 放大画布后手柄按新 zoom 重算（屏幕上不会跟着变大）",
            r1 > 0 && r2 > 0 && r2 < r1 * 0.98, `${r1.toFixed(2)} → ${r2.toFixed(2)}`);
        click('[data-action="zoom-fit"]');
        await settle();
    }

    // 6b) 工具栏点选的样式要记住：关掉再开还是这一套（v0.9.2）
    click('[data-preset="color"][data-value="#8B5CF6"]');
    click('[data-preset="lineWidth"][data-value="8"]');
    click('[data-preset="fontSize"][data-value="42"]');
    // 填充色在「自定义预设 → 点某一档填充」的小窗里选
    click('[data-action="settings"]');
    q('[data-role="group-fills"] [data-index="2"]')?.dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
    q('[data-role="attr-pop"] [data-preset="fillColor"][data-value="#10B981"]')
        ?.dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
    click('[data-action="preset-apply"]');
    const savedCurrent = JSON.parse(win.localStorage.getItem("siyuan-plugin-annotate:current") || "null");
    check("M5 点选颜色/线宽/字号/填充后立刻写进本地存储（填充色跟随描边色）",
        savedCurrent?.color === "#8B5CF6" && savedCurrent?.lineWidth === 8 &&
        savedCurrent?.fontSize === 42 && Math.abs((savedCurrent?.fillOpacity ?? 0) - 0.5) < 0.001 &&
        String(savedCurrent?.fillColor || "").toUpperCase() === "#8B5CF6",
        JSON.stringify(savedCurrent));
    click('[data-action="close"]');
    await settle();
    openM5();
    await settle();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M5 重开时顶栏带回上次的颜色/线宽/字号/填充",
        q('[data-preset="color"][data-value="#8B5CF6"]')?.classList.contains("is-active") &&
        q('[data-preset="lineWidth"][data-value="8"]')?.classList.contains("is-active") &&
        q('[data-preset="fontSize"][data-value="42"]')?.classList.contains("is-active") &&
        q('[data-preset="fillOpacity"][data-value="0.5"]')?.classList.contains("is-active"),
        `color=${q('[data-preset="color"].is-active')?.getAttribute("data-value")} ` +
        `w=${q('[data-preset="lineWidth"].is-active')?.getAttribute("data-value")} ` +
        ` fill=${q('[data-number="fillOpacity"]')?.value}`);
    drawRect({x: 60, y: 60}, {x: 200, y: 160});
    const freshRect = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []).pop();
    check("M5 重开后新画的对象沿用上次的样式",
        freshRect?.getAttribute("stroke")?.toUpperCase() === "#8B5CF6" &&
        freshRect?.getAttribute("stroke-width") === "8" &&
        (freshRect?.getAttribute("fill") || "none") !== "none",
        `${freshRect?.getAttribute("stroke")} / ${freshRect?.getAttribute("stroke-width")} / ${freshRect?.getAttribute("fill")}`);

    // 7) 禁用 / 重新启用 / 卸载清理
    plugin.onunload();
    check("M5 禁用插件后无残留界面", !win.document.querySelector('[data-annot-plugin-root]'));
    check("M5 禁用后注销事件", !listeners.has("open-menu-image"));
    plugin.onload();
    check("M5 重新启用后恢复注册", listeners.has("open-menu-image"));
    plugin.uninstall();
    check("M5 卸载清理本地主题偏好", win.localStorage.getItem("siyuan-plugin-annotate:theme") === null);
    check("M5 卸载后无残留界面", !win.document.querySelector('[data-annot-plugin-root]'));
}

// ---------------------------------------------------------------- 文档内标注预览（保存后在正文图片上直接显示）
if (process.argv[3] === "--doc") {
    const INDEX = "data/storage/petal/siyuan-plugin-annotate/index.json";
    const SIDECAR = "data/assets/demo.png.annot.json";
    const arrow = {
        id: "obj-arrow-1", type: "arrow",
        geometry: {start: {x: 40, y: 40}, end: {x: 300, y: 200}, control: null},
        style: {color: "#EF4444", lineWidth: 4, opacity: 1},
        meta: {label: "箭头", createdAt: 1, updatedAt: 1},
    };
    const rect = {
        id: "obj-rect-1", type: "rect",
        geometry: {x: 100, y: 100, width: 180, height: 120},
        style: {color: "#10B981", lineWidth: 4, opacity: 1, fillMode: "none"},
        meta: {label: "矩形", createdAt: 1, updatedAt: 1},
    };
    const scene = (objects) => ({
        version: 1, blockId: "block-A", assetPath: "assets/demo.png",
        imageWidth: 1200, imageHeight: 800, objects,
        viewport: {zoom: 1, panX: 0, panY: 0}, updatedAt: 1,
    });
    const files = new Map([
        [INDEX, JSON.stringify({"block-A": SIDECAR})],
        [SIDECAR, JSON.stringify(scene([arrow]))],
    ]);
    globalThis.fetch = async (url, options = {}) => {
        if (String(url) === "/api/file/getFile") {
            const {path: filePath} = JSON.parse(options.body);
            const data = files.get(filePath);
            return new Response(data ?? "missing", {status: data === undefined ? 404 : 200});
        }
        return new Response("{}", {status: 200});
    };
    const settleDoc = (ms = 260) => new Promise((resolve) => setTimeout(resolve, ms));

    // 模拟思源正文中的图片块（结构依据 app/src/asset/renderAssets.ts:79）
    const doc = win.document.createElement("div");
    doc.className = "protyle-wysiwyg";
    doc.innerHTML = `<div data-node-id="block-A" data-type="NodeParagraph">
        <span contenteditable="false" data-type="img" class="img"><span> </span>
        <span><img src="assets/demo.png" data-src="assets/demo.png" style="width:600px;height:400px"></span>
        <span> </span></span></div>`;
    win.document.body.append(doc);
    await settleDoc();

    const overlay = () => win.document.querySelector(".annot-doc-overlay");
    const docImg = () => win.document.querySelector('.protyle-wysiwyg img[data-src="assets/demo.png"]');
    check("DOC 正文图片上出现标注预览层", !!overlay());
    check("DOC 预览层含已保存的标注对象", (overlay()?.querySelectorAll("[data-object-id]").length ?? 0) === 1);
    check("DOC 预览层只读、不拦截鼠标", overlay()?.style.pointerEvents === "none");
    check("DOC 原图的 data-src 未被改动", docImg()?.getAttribute("data-src") === "assets/demo.png");
    check("DOC 笔记里没有插入新的图片块", win.document.querySelectorAll(".protyle-wysiwyg img").length === 1);

    // 模拟再次保存（对象变多）→ 预览应自动刷新
    files.set(SIDECAR, JSON.stringify(scene([arrow, rect])));
    win.dispatchEvent(new win.CustomEvent("siyuan-plugin-annotate:saved", {
        detail: {blockId: "block-A", assetPath: "assets/demo.png"},
    }));
    await settleDoc();
    check("DOC 保存后正文预览自动刷新", (overlay()?.querySelectorAll("[data-object-id]").length ?? 0) === 2,
        `${overlay()?.querySelectorAll("[data-object-id]").length ?? 0} 个`);

    // 翻转过的画布：标注位置要镜像回原画面，但文字必须正着显示（不能是反字）
    const mirrored = {
        version: 2, blockId: "block-A", assetPath: "assets/demo.png",
        imageWidth: 1200, imageHeight: 800,
        canvas: {
            width: 1200, height: 800, naturalWidth: 1200, naturalHeight: 800,
            matrix: {a: -1, b: 0, c: 0, d: 1, e: 1200, f: 0},
        },
        objects: [arrow, {
            id: "obj-text-1", type: "text",
            geometry: {x: 100, y: 100, text: "翻转后的文字", fontSize: 28},
            style: {
                color: "#EF4444", lineWidth: 4, opacity: 1, fontSize: 28,
                textStrokeEnabled: true, textStrokeColor: "#FFFFFF", textStrokeWidth: 2,
            },
            meta: {label: "文字", createdAt: 1, updatedAt: 1},
        }],
        viewport: {zoom: 1, panX: 0, panY: 0}, updatedAt: 2,
    };
    files.set(SIDECAR, JSON.stringify(mirrored));
    win.dispatchEvent(new win.CustomEvent("siyuan-plugin-annotate:saved", {
        detail: {blockId: "block-A", assetPath: "assets/demo.png"},
    }));
    await settleDoc();
    const mirrorGroup = overlay()?.querySelector("g[transform]");
    check("DOC 翻转过的画布用镜像矩阵贴回原画面",
        /matrix\(-1/.test(mirrorGroup?.getAttribute("transform") || ""),
        String(mirrorGroup?.getAttribute("transform")));
    const mirrorText = Array.from(overlay()?.querySelectorAll("text") ?? [])
        .find((el) => el.textContent === "翻转后的文字");
    check("DOC 翻转后文字不跟着镜像（不出反字）",
        !!mirrorText && mirrorText.closest("g[transform]") === null);

    check("DOC 宿主元素没有被写入内联样式", !docImg()?.parentElement?.hasAttribute("style"));
    check("DOC 图片没有被写入插件标记", !docImg()?.hasAttribute("data-annot-preview"));
    plugin.onunload();
    check("DOC 禁用插件后预览层被清除", !win.document.querySelector(".annot-doc-overlay"));
}

// ---------------------------------------------------------------- v0.6.0 界面重做与样式预设
if (process.argv[3] === "--ui") {
    Object.defineProperty(globalThis, "localStorage", {value: win.localStorage, configurable: true});
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const settleUI = () => new Promise((resolve) => setTimeout(resolve, 30));
    const fire = (el, type) => el?.dispatchEvent(new win.Event(type, {bubbles: true, cancelable: true}));

    const openUI = () => {
        const d = makeDetail();
        listeners.get("open-menu-image")?.({detail: d.detail});
        d.getItem()?.click();
    };
    openUI();
    await settleUI();
    let svg = win.document.querySelector('[data-role="svg"]');
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    const ptr = (type, pt) => {
        const c = toClient(pt.x, pt.y);
        svg.dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
        }));
    };
    const drawUI = (tool, a, b) => {
        click(`button[data-tool="${tool}"]`);
        ptr("pointerdown", a);
        ptr("pointermove", {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
        ptr("pointerup", b);
    };

    // 1) 名称与两行布局
    check("UI 插件名为「勾画阁·猫抓」", q(".annot-titlebar__name")?.textContent === "勾画阁·猫抓");
    check("UI 撤销重做紧跟名字后",
        !!q(".annot-titlebar__name + .annot-history [data-action='undo']") &&
        !!q(".annot-titlebar__name + .annot-history [data-action='redo']"));
    const rightItems = Array.from(win.document.querySelectorAll(
        ".annot-titlebar > [data-action], .annot-titlebar > [data-role='theme-select']",
    )).map((el) => el.getAttribute("data-action") || "theme");
    check("UI 标题栏右侧顺序为 颜色/取消/保存/全屏（导出按钮已移除）",
        rightItems.join(",") === "theme,close,save,fullscreen", rightItems.join(","));
    check("UI 右侧两个文字按钮改成「取消」在左、「保存」在右",
        (q('[data-action="close"]')?.textContent || "").trim() === "取消" &&
        (q('[data-action="save"]')?.textContent || "").trim() === "保存" &&
        rightItems.indexOf("close") < rightItems.indexOf("save"),
        `${q('[data-action="close"]')?.textContent}/${q('[data-action="save"]')?.textContent}`);
    check("UI 顶栏已经没有「导出为 PNG」按钮",
        !q('[data-action="export"]') &&
        !Array.from(win.document.querySelectorAll(".annot-titlebar .annot-btn"))
            .some((el) => (el.textContent || "").includes("导出")));
    check("UI 工具栏不再重复插件名称", !q(".annot-toolbar .annot-title"));
    check("UI 工具按钮全部为图标",
        q('[data-role="tool-buttons"] button[data-tool] svg') !== null &&
        q('[data-role="tool-buttons"] button[data-tool]')?.textContent.trim() === "");
    check("UI 左侧工具共 12 个（选择已移到悬浮条）",
        q('[data-role="tool-buttons"]')?.querySelectorAll("button[data-tool]").length === 12);
    check("UI 左侧竖栏不再有「选择」按钮",
        !q('[data-role="tool-buttons"] button[data-tool="select"]'));
    {
        const order = Array.from(q('[data-role="tool-buttons"]')?.querySelectorAll("button[data-tool]") ?? [])
            .map((el) => el.getAttribute("data-tool"));
        check("UI 模糊工具紧跟马赛克",
            order.indexOf("blur") === order.indexOf("mosaic") + 1, order.join(","));
        check("UI 画线紧跟画圆（按用户指定的位置）",
            order.indexOf("line") === order.indexOf("ellipse") + 1, order.join(","));
        check("UI 画线图标是用户给的原稿且跟随主题色",
            q('button[data-tool="line"] svg')?.getAttribute("viewBox") === "0 0 1706 1024" &&
            q('button[data-tool="line"] svg path')?.getAttribute("fill") === "currentColor" &&
            q('button[data-tool="line"] svg path')?.getAttribute("d")?.startsWith("M121.941333") === true,
            q('button[data-tool="line"] svg path')?.getAttribute("d")?.slice(0, 18) || "missing");
    }

    // 图标改版回归：全部统一 48 视图 / 4 线宽 / currentColor，避免退回旧的简笔图标
    const iconSvgs = Array.from(win.document.querySelectorAll(
        ".annot-titlebar svg:not(.annot-chevron), .annot-toolbar svg:not(.annot-chevron), .annot-imagebar svg",
    ));
    const outlineIcons = iconSvgs.filter((el) => el.getAttribute("viewBox") === "0 0 48 48");
    const sourceIcons = iconSvgs.filter((el) => el.getAttribute("viewBox") !== "0 0 48 48");
    check("UI 新图标统一 48 视图与 4 单位线宽",
        outlineIcons.length >= 17 && outlineIcons.every((el) =>
            el.getAttribute("viewBox") === "0 0 48 48" &&
            el.getAttribute("stroke-width") === "4" &&
            el.getAttribute("stroke") === "currentColor"),
        `${outlineIcons.length} 个线性 + ${sourceIcons.length} 个原稿实心`);
    const blurSourceIcon = sourceIcons.find((el) => el.getAttribute("viewBox") === "0 0 1111 1024");
    const lineSourceIcon = sourceIcons.find((el) => el.getAttribute("viewBox") === "0 0 1706 1024");
    // 全屏 / 聚光灯 / 扩展画布都是 1024 视图：按路径段数与首段路径区分
    // （全屏 9 段、聚光灯 1 段 M705…、扩展画布 1 段 M320…）
    const is1024 = (el) => el.getAttribute("viewBox") === "0 0 1024 1024";
    const fullscreenSourceIcon = sourceIcons.find((el) => is1024(el) && el.querySelectorAll("path").length === 9);
    const onePath1024 = sourceIcons.filter((el) => is1024(el) && el.querySelectorAll("path").length === 1);
    const spotlightSourceIcon = onePath1024.find((el) =>
        (el.querySelector("path")?.getAttribute("d") || "").startsWith("M705.4336"));
    const extendSourceIcon = onePath1024.find((el) =>
        (el.querySelector("path")?.getAttribute("d") || "").startsWith("M320 864v96"));
    check("UI 模糊 / 画线 / 全屏 / 聚光灯 / 扩展画布图标都用用户给的原稿（实心、不改视图）",
        sourceIcons.length === 6 && !!blurSourceIcon && !!lineSourceIcon &&
        !!fullscreenSourceIcon && !!spotlightSourceIcon && !!extendSourceIcon &&
        [blurSourceIcon, lineSourceIcon, spotlightSourceIcon, extendSourceIcon].every((el) =>
            el.querySelector("path")?.getAttribute("fill") === "currentColor" &&
            el.querySelector("path")?.getAttribute("stroke") === "none") &&
        fullscreenSourceIcon.querySelectorAll("path").length === 9 &&
        Array.from(fullscreenSourceIcon.querySelectorAll("path"))
            .every((el) => el.getAttribute("fill") === "currentColor"),
        sourceIcons.map((el) => el.getAttribute("viewBox")).join(","));
    check("UI 图标没有写死深色", !q(".annot-toolbar")?.innerHTML.includes("#333"));
    check("UI 图标带插件专属类并放大到 20px",
        iconSvgs.every((el) => el.classList.contains("annot-icon")) &&
        iconSvgs.every((el) => el.getAttribute("width") === "20"));
    check("UI 样式表固定了图标规格", css.includes("svg.annot-icon") && css.includes("stroke-width: 4"));
    check("UI 选择与序号改为同粗细的线性描边",
        q('button[data-tool="select"] svg')?.getAttribute("fill") === "none" &&
        q('button[data-tool="number"] svg')?.getAttribute("fill") === "none");
    const marker = q('button[data-tool="highlight"] svg path[transform]');
    check("UI 高亮笔为用户定稿的实心马克笔图形",
        marker?.getAttribute("fill") === "currentColor" &&
        marker?.getAttribute("transform") === "scale(0.046875)");

    // 2) 顶栏五组档位：平铺、独立、每档带 data-index
    const presetCount = (role) => q(`[data-role="${role}"]`)?.querySelectorAll("[data-preset]").length || 0;
    check("UI 颜色一档有 5 个圆点", presetCount("group-colors") === 5);
    check("UI 线宽 / 线型 / 填充 / 字号各四档",
        presetCount("group-widths") === 4 && presetCount("group-lines") === 4 &&
        presetCount("group-fills") === 4 && presetCount("group-fonts") === 4,
        [presetCount("group-widths"), presetCount("group-lines"),
            presetCount("group-fills"), presetCount("group-fonts")].join(","));
    check("UI 每一档都带 data-index（点哪一档就知道改哪个）",
        ["group-colors", "group-widths", "group-lines", "group-fills", "group-fonts"].every((role) =>
            Array.from(q(`[data-role="${role}"]`)?.querySelectorAll("[data-preset]") ?? [])
                .every((el, index) => el.getAttribute("data-index") === String(index))));
    check("UI 常态下没有任何参数小窗（滑块只在编辑模式里出现）",
        !q('[data-range="lineWidth"]') && q('[data-role="attr-pop"]')?.hidden === true);
    check("UI 有自定义颜色圆球与设置入口",
        !!q('[data-role="custom-color"].annot-custom-color') && !!q('[data-action="settings"]'));
    check("UI 自定义颜色圆球自带十字（未取色时是白球）",
        !!q('.annot-custom-color [class="annot-custom-color__cross"]') &&
        /#FFFFFF/i.test(q('.annot-custom-color')?.getAttribute("style") || ""),
        q('.annot-custom-color')?.getAttribute("style") || "");

    // 3) 常态下点档位就是直接生效（不弹窗）
    click('button[data-preset="lineWidth"][data-index="2"]');
    drawUI("rect", {x: 40, y: 40}, {x: 170, y: 130});
    check("UI 点第 3 档线宽（8px）后新矩形就是 8",
        layer()?.querySelector("rect.annot-shape")?.getAttribute("stroke-width") === "8",
        String(layer()?.querySelector("rect.annot-shape")?.getAttribute("stroke-width")));
    check("UI 绘制后保持当前工具", svg.getAttribute("data-active-tool") === "rect");
    check("UI 常态点档位不弹小窗", q('[data-role="attr-pop"]')?.hidden === true);

    click('button[data-preset="color"][data-index="2"]');
    drawUI("ellipse", {x: 220, y: 40}, {x: 380, y: 140});
    check("UI 颜色档位应用到新椭圆",
        layer()?.querySelector("ellipse.annot-shape")?.getAttribute("stroke") === "#10B981");

    // 填充档位 50%
    click('button[data-preset="fillOpacity"][data-index="2"]');
    drawUI("rect", {x: 420, y: 40}, {x: 560, y: 140});
    const rects = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
    check("UI 填充档位 50% 直接画进新矩形",
        /0\.5\)/.test(rects[rects.length - 1]?.getAttribute("fill") || ""),
        rects[rects.length - 1]?.getAttribute("fill") || "");

    // 字号档位 42
    click('button[data-preset="fontSize"][data-index="2"]');
    click('button[data-tool="text"]');
    ptr("pointerdown", {x: 80, y: 260});
    const textAreaUI = q(".annot-text-editor");
    textAreaUI.value = "大字号";
    textAreaUI.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    check("UI 字号档位应用到文字", q('text.annot-shape')?.getAttribute("font-size") === "42",
        String(q('text.annot-shape')?.getAttribute("font-size")));

    // 4) 顶栏档位的调整会同步到后续绘制（属性面板已在 v0.21.0 移除）
    const firstRectId = layer()?.querySelector("g[data-object-id]")?.getAttribute("data-object-id");
    click(`[data-role="object-item"][data-id="${firstRectId}"]`);
    check("UI 右侧面板只剩对象与层级",
        !q('[data-role="props"]') && !!q('[data-role="list"]') && !!q('[data-role="layers"]'));
    click('button[data-preset="lineWidth"][data-index="2"]');
    click('button[data-tool="rect"]');
    drawUI("rect", {x: 80, y: 420}, {x: 220, y: 510});
    const allRects = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
    check("UI 顶栏选的粗细档位（第 3 档 = 8px）会沿用到新对象",
        allRects[allRects.length - 1]?.getAttribute("stroke-width") === "8",
        String(allRects[allRects.length - 1]?.getAttribute("stroke-width")));

    // 5) v0.19.3：编辑模式下「点哪一档，小窗只改那一档」
    const pop = () => q('[data-role="attr-pop"]');
    const slotBtn = (role, index) => q(`[data-role="${role}"] [data-index="${index}"]`);
    const presetsNow = () => {
        try { return JSON.parse(win.localStorage.getItem("siyuan-plugin-annotate:presets") || "{}"); }
        catch { return {}; }
    };
    const headText = () => (pop()?.querySelector(".annot-attr-panel__head")?.textContent || "").trim();

    click('[data-action="settings"]');
    await settleUI();
    check("UI 点自定义预设后，齿轮原地换成 取消 / 应用 / 恢复默认",
        !!q('[data-action="preset-cancel"]') && !!q('[data-action="preset-apply"]') &&
        !!q('[data-action="preset-reset"]') && !q('[data-action="settings"]') &&
        q(".annot-root")?.classList.contains("is-preset-edit"));
    check("UI 编辑模式下五组档位仍然平铺（没有被换成别的按钮）",
        presetCount("group-colors") === 5 && presetCount("group-widths") === 4 &&
        presetCount("group-lines") === 4 && presetCount("group-fills") === 4 &&
        presetCount("group-fonts") === 4);
    check("UI 顶栏去掉了「属性」二字，五组都带小标题",
        !q(".annot-toolbar .annot-toolbar__label") &&
        Array.from(q(".annot-toolbar")?.querySelectorAll(".annot-group__label") ?? [])
            .map((el) => el.textContent.trim()).join(",") === "颜色,粗细,线型,填充,字号");

    // 颜色：点第 1 个圆点，只改第 1 个
    const colorsBefore = Array.from(q('[data-role="group-colors"]')?.querySelectorAll("[data-preset='color']") ?? [])
        .map((el) => el.getAttribute("data-value"));
    slotBtn("group-colors", 0).click();
    await settleUI();
    check("UI 点第 1 个圆点：小窗弹出、写明第 1 个颜色、里面是色轮",
        pop()?.hidden === false && headText().includes("第 1 个颜色") &&
        !!pop()?.querySelector('.annot-cw') &&
        pop()?.querySelectorAll('.annot-cw__readout').length === 3 &&
        !!pop()?.querySelector('[data-cw-mode="rgb"]'),
        `${headText()} | 读数 ${pop()?.querySelectorAll('.annot-cw__readout').length} 格`);
    const colorInput = pop()?.querySelector('.annot-cw__hex-input');
    colorInput.value = "#123456";
    fire(colorInput, "change");
    await settleUI();
    const colorsAfter = Array.from(q('[data-role="group-colors"]')?.querySelectorAll("[data-preset='color']") ?? [])
        .map((el) => el.getAttribute("data-value"));
    check("UI 改第 1 个圆点：只有它变色，其他 4 个没动",
        colorsAfter[0] === "#123456" && colorsAfter.slice(1).join() === colorsBefore.slice(1).join(),
        colorsAfter.join(","));
    check("UI 新颜色写进了预设（下次打开还在）", (presetsNow().colors || [])[0] === "#123456");

    // 线宽：点第 2 档，滑块只改第 2 档
    slotBtn("group-widths", 1).click();
    await settleUI();
    check("UI 点第 2 个线宽：小窗写明第 2 个，且是滑块 + 数字框",
        headText().includes("第 2 个线条粗细") &&
        !!pop()?.querySelector('[data-range="lineWidth"]') &&
        !!pop()?.querySelector('[data-number="lineWidth"]'), headText());
    const wRange = pop()?.querySelector('[data-range="lineWidth"]');
    const wNum = pop()?.querySelector('[data-number="lineWidth"]');
    wRange.value = "12";
    fire(wRange, "input");
    check("UI 拖线宽滑块，数字框跟着变", wNum.value === "12", wNum.value);
    wNum.value = "20";
    fire(wNum, "input");
    fire(wNum, "change");
    await settleUI();
    check("UI 输入 20 后滑块同步", (pop()?.querySelector('[data-range="lineWidth"]')?.value) === "20");
    check("UI 只改第 2 档线宽，其他三档没动",
        (presetsNow().lineWidths || []).join(",") === "2,20,8,14",
        (presetsNow().lineWidths || []).join(","));
    drawUI("rect", {x: 300, y: 40}, {x: 420, y: 130});
    const newest = () => Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []).pop();
    check("UI 改完第 2 档后画出来的矩形就是 20px",
        newest()?.getAttribute("stroke-width") === "20", String(newest()?.getAttribute("stroke-width")));

    // 线型：点「虚线」，只改虚线的间距
    slotBtn("group-lines", 1).click();
    await settleUI();
    check("UI 点虚线：小窗写明虚线的间距", headText().includes("虚线的间距") &&
        !!pop()?.querySelector('[data-number="lineDashGap"]'), headText());
    const gapInput = pop()?.querySelector('[data-number="lineDashGap"]');
    gapInput.value = "14";
    fire(gapInput, "input");
    fire(gapInput, "change");
    await settleUI();
    const gaps = presetsNow().dashGaps || {};
    check("UI 只有虚线间距变成 14，其他线型没动",
        gaps.dashed === 14 && gaps.solid === 6 && gaps.dotted === 6 && gaps.dashdot === 6,
        JSON.stringify(gaps));
    drawUI("rect", {x: 460, y: 40}, {x: 560, y: 130});
    check("UI 虚线间距 14 真的画进新矩形",
        (newest()?.getAttribute("stroke-dasharray") || "").trim().endsWith(" 14"),
        String(newest()?.getAttribute("stroke-dasharray")));
    slotBtn("group-lines", 2).click();
    await settleUI();
    check("UI 点「点线」时滑块显示的是点线自己的间距（6，不是 14）",
        (pop()?.querySelector('[data-number="lineDashGap"]')?.value) === "6",
        String(pop()?.querySelector('[data-number="lineDashGap"]')?.value));

    // 填充：点第 3 档，只改第 3 档
    slotBtn("group-fills", 2).click();
    await settleUI();
    const fillNum = pop()?.querySelector('[data-number="fillOpacity"]');
    fillNum.value = "70";
    fire(fillNum, "input");
    fire(fillNum, "change");
    await settleUI();
    const opacities = presetsNow().fillOpacities || [];
    check("UI 只改第 3 档填充（变 70%），其他三档没动",
        Math.abs(opacities[2] - 0.7) < 1e-6 && opacities[0] === 0 && Math.abs(opacities[1] - 0.15) < 1e-6,
        JSON.stringify(opacities));

    // 填充小窗：只有滑块 + 数字框，没有颜色面板
    slotBtn("group-fills", 1).click();
    await settleUI();
    check("UI 填充小窗只有不透明度（没有颜色面板）",
        !!pop()?.querySelector('[data-range="fillOpacity"]') &&
        !!pop()?.querySelector('[data-number="fillOpacity"]') &&
        (pop()?.querySelectorAll(".annot-swatch2").length || 0) === 0 &&
        !pop()?.querySelector('[data-role="fill-picker"]'),
        headText());

    // 字号：点第 1 档
    slotBtn("group-fonts", 0).click();
    await settleUI();
    const fontNum = pop()?.querySelector('[data-number="fontSize"]');
    fontNum.value = "52";
    fire(fontNum, "input");
    fire(fontNum, "change");
    await settleUI();
    check("UI 只改第 1 档字号（变 52），其他三档没动",
        (presetsNow().fontSizes || []).join(",") === "52,28,42,64",
        (presetsNow().fontSizes || []).join(","));

    // 点外面 / Esc 收起
    ptr("pointerdown", {x: 60, y: 720});
    ptr("pointerup", {x: 60, y: 720});
    await settleUI();
    check("UI 点画布空白处，小窗收起", pop()?.hidden === true);
    slotBtn("group-widths", 0).click();
    await settleUI();
    check("UI 再点一档又能弹出", pop()?.hidden === false);
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
    await settleUI();
    check("UI 按 Esc 收起小窗", pop()?.hidden === true);

    // 应用：退出编辑模式、小窗关闭
    click('[data-action="preset-apply"]');
    await settleUI();
    check("UI 点应用退出编辑模式：小窗关闭、齿轮回来",
        pop()?.hidden === true && !!q('[data-action="settings"]') &&
        !q(".annot-root")?.classList.contains("is-preset-edit"));
    click('button[data-preset="lineWidth"][data-index="0"]');
    await settleUI();
    check("UI 退出后再点档位不弹小窗（只是切换）", pop()?.hidden === true);

    // 取消：档位恢复成进入前的样子
    click('[data-action="settings"]');
    await settleUI();
    slotBtn("group-widths", 0).click();
    await settleUI();
    const cancelNum = pop()?.querySelector('[data-number="lineWidth"]');
    cancelNum.value = "30";
    fire(cancelNum, "input");
    fire(cancelNum, "change");
    await settleUI();
    check("UI 编辑期间档位数值确实变了", (presetsNow().lineWidths || [])[0] === 30,
        (presetsNow().lineWidths || []).join(","));
    click('[data-action="preset-cancel"]');
    await settleUI();
    check("UI 点取消：第 1 档线宽回到 2px，齿轮回来",
        (presetsNow().lineWidths || []).join(",") === "2,20,8,14" && !!q('[data-action="settings"]'),
        (presetsNow().lineWidths || []).join(","));

    // 恢复默认：五组档位回到出厂值
    click('[data-action="settings"]');
    await settleUI();
    click('[data-action="preset-reset"]');
    await settleUI();
    const reset = presetsNow();
    check("UI 点恢复默认：五组档位回到 5 色 / 2·4·8·14 / 0·15·50·85 / 18·28·42·64 / 间距 6",
        (reset.colors || []).length === 5 && (reset.colors || [])[0] === "#EF4444" &&
        (reset.lineWidths || []).join(",") === "2,4,8,14" &&
        (reset.fillOpacities || []).map((v) => Math.round(v * 100)).join(",") === "0,15,50,85" &&
        (reset.fontSizes || []).join(",") === "18,28,42,64" &&
        JSON.stringify(reset.dashGaps) === '{"solid":6,"dashed":6,"dotted":6,"dashdot":6}',
        JSON.stringify(reset));

    // --- v0.13.3：矩形圆角（画布悬浮条下拉，参考 ShareX 的 CornerRadiusPicker）---
    {
        drawUI("rect", {x: 700, y: 300}, {x: 820, y: 400});
        await settleUI();
        const bar = q('[data-role="context-bar"]');
        const picker = () => bar?.querySelector('[data-role="corner-picker"]');
        check("UI 矩形工具时悬浮条出现「圆角」下拉",
            bar?.hidden === false && !!picker() &&
            !!bar.querySelector('[data-role="corner-value"]') &&
            !!bar.querySelector(".annot-corner-picker__icon svg.annot-corner-icon"),
            bar?.hidden ? "bar hidden" : "picker ok");
        const items = Array.from(bar?.querySelectorAll(".annot-corner-picker__item") ?? []);
        check("UI 圆角下拉是 ShareX 的十档 0~30，每档都有图案和数值",
            items.length === 10 &&
            items.map((b) => b.getAttribute("data-value")).join(",") === "0,2,4,6,8,10,15,20,25,30" &&
            items.every((b) => !!b.querySelector("svg.annot-corner-icon") && !!b.textContent.trim()),
            items.map((b) => b.getAttribute("data-value")).join(","));
        const toggle = () => picker()?.querySelector('[data-action="corner-picker-toggle"]');
        check("UI 圆角下拉默认收起，点按钮才展开",
            !picker()?.classList.contains("is-open") && toggle()?.getAttribute("aria-expanded") === "false",
            String(toggle()?.getAttribute("aria-expanded")));
        click('[data-action="corner-picker-toggle"]');
        check("UI 点按钮后下拉展开、aria 同步",
            picker()?.classList.contains("is-open") && toggle()?.getAttribute("aria-expanded") === "true",
            `${picker()?.className} / ${toggle()?.getAttribute("aria-expanded")}`);
        click('.annot-corner-picker__item[data-value="20"]');
        await settleUI();
        const rectsNow = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
        const lastRect = rectsNow[rectsNow.length - 1];
        check("UI 选 20 后刚画的矩形立刻变成圆角 20（rx = ry）",
            lastRect?.getAttribute("rx") === "20" && lastRect?.getAttribute("ry") === "20",
            String(lastRect?.getAttribute("rx")));
        check("UI 选完自动收起，按钮上的数值跟着变",
            !q('[data-role="corner-picker"]')?.classList.contains("is-open") &&
            q('[data-role="corner-value"]')?.textContent.trim() === "20",
            String(q('[data-role="corner-value"]')?.textContent));

        // 只有矩形有圆角
        click('button[data-tool="ellipse"]');
        await settleUI();
        check("UI 椭圆工具不显示圆角（与 ShareX 一致，只有矩形有）",
            !q('[data-role="corner-picker"]'), "无圆角控件");

        // 档位记住，下一个矩形照样带 20
        drawUI("rect", {x: 700, y: 450}, {x: 800, y: 530});
        await settleUI();
        const rects2 = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
        check("UI 新画的矩形继承上一档圆角",
            rects2[rects2.length - 1]?.getAttribute("rx") === "20",
            String(rects2[rects2.length - 1]?.getAttribute("rx")));

        // 0 档回到直角
        click('[data-action="corner-picker-toggle"]');
        click('.annot-corner-picker__item[data-value="0"]');
        await settleUI();
        const rects3 = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
        check("UI 选回 0 档就变回直角",
            (rects3[rects3.length - 1]?.getAttribute("rx") ?? "") === "0",
            String(rects3[rects3.length - 1]?.getAttribute("rx")));

        // 圆角超过半边长时自动截断（不会画出畸形）
        click('[data-action="corner-picker-toggle"]');
        click('.annot-corner-picker__item[data-value="30"]');
        await settleUI();
        const rects4 = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
        const small = rects4[rects4.length - 1];
        const w = Number(small?.getAttribute("width") || 0);
        const h = Number(small?.getAttribute("height") || 0);
        const rx = Number(small?.getAttribute("rx") || 0);
        check("UI 圆角不超过短边的一半（小矩形自动截断）",
            rx > 0 && rx <= Math.min(w, h) / 2 + 0.01,
            `rx=${rx} w=${w.toFixed(1)} h=${h.toFixed(1)}`);

        // 回归网：思源 util/_reset.scss 有一条 svg { fill: currentColor }，
        // 它是 CSS 声明，优先级高于写在 <svg> 上的 fill="none" 属性。
        // 所以圆角档位图案、下拉折角这类线性图标必须每个图形自己写 fill，
        // 不能只靠外层 svg 的属性兜底，否则在真实思源里会被填成实心色块。
        const outlineShapes = [];
        const outlineRoots = Array.from(q(".annot-root")?.querySelectorAll(
            "svg.annot-corner-icon, svg.annot-chevron") ?? []);
        for (const svg of outlineRoots) {
            for (const shape of Array.from(svg.querySelectorAll("path, circle, rect, polygon, polyline"))) {
                if (shape.getAttribute("fill") === null) {
                    outlineShapes.push(`${svg.getAttribute("class")} › ${shape.tagName.toLowerCase()}`);
                }
            }
        }
        check("UI 圆角图案与下拉折角的每个图形都自带 fill，不会被思源填充规则填实",
            outlineRoots.length >= 11 && outlineShapes.length === 0,
            `${outlineRoots.length} 个图标 / 裸图形 ${outlineShapes.slice(0, 4).join(", ")}`);
    }

    // --- v0.14.0：箭头样式顺序 / 点划线 / 画线悬浮条 / 自定义颜色预设 ---
    {
        // 1) 1.3.0 起拆成「类型」与「样式」两个下拉
        drawUI("arrow", {x: 120, y: 600}, {x: 260, y: 660});
        await settleUI();
        const headChips = () => Array.from(q('[data-role="arrow-head-group"]')
            ?.querySelectorAll(".annot-arrow-chip") ?? []);
        const typeItems = () => Array.from(q('[data-role="arrow-type-picker"]')
            ?.querySelectorAll(".annot-arrow-picker__item") ?? []);
        check("UI 端点顺序固定为 无箭头 → 基础 → 燕尾 → 开放 → 菱形 → 圆形",
            headChips().map((el) => el.getAttribute("data-value")).join(",") ===
            "none,basic,classic,open,rhombus,circle",
            headChips().map((el) => el.getAttribute("data-value")).join(","));
        check("UI 单头下「无箭头」置灰，菱形与圆形可用",
            !!q('[data-role="arrow-head-group"] .annot-arrow-chip[data-value="none"]:disabled') &&
            !q('[data-role="arrow-head-group"] .annot-arrow-chip[data-value="rhombus"]:disabled'));
        check("UI 默认端点仍是「燕尾」，高亮没有跑到别的格子上",
            !!q('[data-role="arrow-head-group"] .annot-arrow-chip[data-value="classic"].is-active') &&
            !q('[data-role="arrow-head-group"] .annot-arrow-chip[data-value="basic"].is-active'));
        click('[data-action="arrow-type-toggle"]');
        check("UI 箭头类型是下拉，顺序为 单头 → 双头 → 尖尾 → 两端竖线",
            typeItems().map((el) => el.getAttribute("data-value")).join(",") === "single,double,modern,bar",
            typeItems().map((el) => el.getAttribute("data-value")).join(","));
        check("UI 默认类型是「单头」，下拉里高亮落在第一项",
            !!q('[data-role="arrow-type-picker"] .annot-arrow-picker__item[data-value="single"].is-active'));
        click('[data-action="arrow-type-toggle"]');

        // 2) 顶部属性栏：新增点划线，作用到新画的图形
        check("UI 顶部线型多出一个「中心线」",
            !!q('button[data-preset="lineDash"][data-value="dashdot"]') &&
            (q('button[data-preset="lineDash"][data-value="dashdot"]')?.textContent || "").includes("中心线"));
        check("UI 点划线有「长划—点—长划」的示意图案",
            !!q('.annot-line-demo--dashdot'));
        click('button[data-preset="lineDash"][data-value="dashdot"]');
        drawUI("rect", {x: 320, y: 600}, {x: 460, y: 660});
        await settleUI();
        const dashRects = Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? []);
        const dashPattern = dashRects[dashRects.length - 1]?.getAttribute("stroke-dasharray") || "";
        const dashParts = dashPattern.trim().split(/\s+/).map(Number);
        check("UI 点划线写进新矩形：四段节奏，第三段是「点」（比线宽还短）",
            dashParts.length === 4 && dashParts.every((n) => Number.isFinite(n)) &&
            dashParts[2] <= 1 && dashParts[0] > dashParts[2] * 5,
            dashPattern);
        check("UI 点划线的「点」用圆头画出来，不会消失",
            dashRects[dashRects.length - 1]?.getAttribute("stroke-linecap") === "round",
            String(dashRects[dashRects.length - 1]?.getAttribute("stroke-linecap")));
        click('button[data-preset="lineDash"][data-value="solid"]');

        // 3) 画线悬浮条：圆线开关（选中这条线时当场改）
        click('button[data-tool="line"]');
        ptr("pointerdown", {x: 560, y: 620});
        ptr("pointermove", {x: 640, y: 660});
        ptr("pointerup", {x: 720, y: 700});
        await settleUI();
        const lineBar = () => q('[data-role="context-bar"]');
        const roundToggle = () => lineBar()?.querySelector('[data-action="line-round"]');
        check("UI 画线时出现悬浮条，里面有「圆线」开关",
            lineBar()?.hidden === false && !!roundToggle() &&
            (roundToggle()?.textContent || "").trim() === "圆线",
            lineBar()?.hidden ? "bar hidden" : String(roundToggle()?.textContent));
        check("UI 画线默认是圆头（圆线打开）",
            roundToggle()?.getAttribute("aria-pressed") === "true" &&
            roundToggle()?.classList.contains("is-active"));
        const linePath = () => {
            const groups = Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? []);
            const last = groups[groups.length - 1];
            return last?.querySelector("path.annot-shape");
        };
        check("UI 默认画出来的线是圆头圆角",
            linePath()?.getAttribute("stroke-linecap") === "round" &&
            linePath()?.getAttribute("stroke-linejoin") === "round");
        click('[data-action="line-round"]');
        await settleUI();
        check("UI 关掉圆线后，这条线立刻变成方头（选中状态也生效）",
            linePath()?.getAttribute("stroke-linecap") === "butt" &&
            linePath()?.getAttribute("stroke-linejoin") === "miter",
            String(linePath()?.getAttribute("stroke-linecap")));
        check("UI 悬浮条提示也跟着变成「方头收口」",
            (lineBar()?.textContent || "").includes("方头收口"),
            String(lineBar()?.textContent));
        ptr("pointerdown", {x: 560, y: 700});
        ptr("pointermove", {x: 640, y: 720});
        ptr("pointerup", {x: 720, y: 740});
        await settleUI();
        check("UI 方头设置沿用到下一根线",
            linePath()?.getAttribute("stroke-linecap") === "butt",
            String(linePath()?.getAttribute("stroke-linecap")));
        click('[data-action="line-round"]');
        await settleUI();
        check("UI 再点一次回到圆头",
            linePath()?.getAttribute("stroke-linecap") === "round",
            String(linePath()?.getAttribute("stroke-linecap")));

        // 4) 自定义颜色：白球 + 十字 → 取色后显示颜色、十字保留
        const ball = () => q('[data-role="custom-color"]');
        check("UI 自定义颜色是一颗带十字的圆球（不是原生色块）",
            ball()?.classList.contains("annot-custom-color") &&
            !!ball()?.querySelector(".annot-custom-color__cross"),
            String(ball()?.className));
        click('[data-action="color-pop-toggle"]');
        await settleUI();
        const pop = () => q('[data-role="color-pop"]');
        check("UI 点圆球打开取色弹窗（色轮 + 保存按钮 + 预设区）",
            pop()?.hidden === false && !!q('[data-role="color-wheel"] .annot-cw') &&
            q('[data-role="color-wheel"]')?.querySelectorAll('.annot-cw__readout').length === 3 &&
            !!q('[data-action="color-save"]') && !!q('[data-role="color-presets"]'),
            pop()?.hidden ? "hidden" : "ok");
        const hexField = q('[data-role="color-wheel"] .annot-cw__hex-input');
        hexField.value = "#123456";
        fire(hexField, "change");
        await settleUI();
        check("UI 手输十六进制后球面变成这个颜色",
            (ball()?.style.getPropertyValue("--annot-ball") || "").toUpperCase() === "#123456",
            ball()?.style.getPropertyValue("--annot-ball"));
        check("UI 取色后十字仍然保留（和固定色点区分）",
            !!ball()?.querySelector(".annot-custom-color__cross"),
            String(ball()?.querySelector(".annot-custom-color__cross")?.className));
        check("UI 弹窗仍然开着，色轮的色号同步成这个颜色",
            pop()?.hidden === false &&
            String(q('.annot-cw__hex-input')?.value).toUpperCase() === "123456");

        click('[data-action="color-save"]');
        await settleUI();
        check("UI 保存到预设后出现一个色点",
            q('[data-role="color-presets"]')?.querySelectorAll('[data-role="color-preset"]').length === 1,
            String(q('[data-role="color-presets"]')?.querySelectorAll('[data-role="color-preset"]').length));
        const savedColors = () => JSON.parse(win.localStorage.getItem("siyuan-plugin-annotate:colors") || "{}");
        check("UI 颜色预设写进本地存储",
            String(savedColors().custom) === "#123456" && String(savedColors().saved) === "#123456",
            JSON.stringify(savedColors()));

        const addColor = async (hex) => {
            const field = q('.annot-cw__hex-input');
            field.value = hex;
            fire(field, "change");
            await settleUI();
            click('[data-action="color-save"]');
            await settleUI();
        };
        await addColor("#ABCDEF");
        await addColor("#0F766E");
        const chipCount = () => q('[data-role="color-presets"]')?.querySelectorAll('[data-role="color-preset"]').length ?? 0;
        check("UI 颜色预设可以连续保存多个", chipCount() === 3, String(chipCount()));

        // 点预设 = 应用这个颜色
        click('[data-role="color-preset"][data-value="#ABCDEF"] [data-action="color-preset-apply"]');
        await settleUI();
        check("UI 点预设色点就把当前颜色换成它",
            (ball()?.style.getPropertyValue("--annot-ball") || "").toUpperCase() === "#ABCDEF",
            ball()?.style.getPropertyValue("--annot-ball"));

        // 拖动排序：把第一个拖到第二个位置（jsdom 没有布局，手工给每个色点一个矩形）
        const chipsNow = () => Array.from(q('[data-role="color-presets"]')?.querySelectorAll('[data-role="color-preset"]') ?? []);
        chipsNow().forEach((chip, index) => {
            chip.getBoundingClientRect = () => ({
                left: index * 34, right: index * 34 + 26, top: 0, bottom: 26,
                width: 26, height: 26, x: index * 34, y: 0,
            });
        });
        const dragFrom = chipsNow()[0];
        const pointer = (target, type, x) => target.dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 12,
        }));
        pointer(dragFrom, "pointerdown", 13);
        pointer(q('[data-role="color-presets"]'), "pointermove", 50);
        pointer(q('[data-role="color-presets"]'), "pointerup", 50);
        await settleUI();
        const orderNow = chipsNow().map((chip) => chip.getAttribute("data-value"));
        check("UI 拖动色点可以排序",
            orderNow.join(",") === "#ABCDEF,#123456,#0F766E" ||
            orderNow.join(",") === "#ABCDEF,#0F766E,#123456",
            orderNow.join(","));
        check("UI 拖动后的顺序也写进了本地存储",
            String(savedColors().saved) === orderNow.join(","),
            JSON.stringify(savedColors()));

        // 删除
        const beforeRemove = chipCount();
        click('[data-role="color-preset"] [data-action="color-preset-remove"]');
        await settleUI();
        check("UI 预设色点可以删除", chipCount() === beforeRemove - 1, `${beforeRemove} → ${chipCount()}`);
        check("UI 删除后的列表也写进本地存储",
            savedColors().saved.length === beforeRemove - 1,
            JSON.stringify(savedColors()));

        // 点空白收起弹窗
        click('button[data-tool="select"]');
        await settleUI();
        check("UI 切工具会收起取色弹窗", pop()?.hidden === true);
    }

    // --- v0.15.0：悬浮条基座（选择 / 平移）+ 序号专属参数 ---
    {
        const bar = () => q('[data-role="context-bar"]');
        const baseTools = () => Array.from(bar()?.querySelectorAll(".annot-context__base button[data-tool]") ?? [])
            .map((el) => el.getAttribute("data-tool"));
        check("UI 悬浮条常驻「选择」「平移」两个按钮，且排在最前面",
            bar()?.hidden === false && baseTools().join(",") === "select,pan" &&
            bar()?.firstElementChild?.classList.contains("annot-context__base"),
            `hidden=${bar()?.hidden} base=${baseTools().join(",")}`);
        check("UI 悬浮条即使没选对象、没在画也一直显示", bar()?.hidden === false);
        // 选择工具 + 没选中任何对象时，才是「只有两颗按钮」的状态
        ptr("pointerdown", {x: 30, y: 30});
        ptr("pointerup", {x: 30, y: 30});
        await settleUI();
        check("UI 选择模式下只剩两颗常驻按钮，没有分割线、也没有别的内容",
            bar()?.querySelectorAll(".annot-context__sep").length === 0 &&
            bar()?.children.length === 1 && !(bar()?.textContent || "").trim(),
            `子元素 ${bar()?.children.length} 个`);
        click('button[data-tool="mosaic"]');
        await settleUI();
        check("UI 切到马赛克后分割线出现，右边跟着参数",
            bar()?.querySelectorAll(".annot-context__sep").length === 1 &&
            !!bar()?.querySelector('[data-ctx="blockSize"]'));
        click('[data-tool="select"]');
        await settleUI();
        check("UI 切回选择后分割线又消失", bar()?.querySelectorAll(".annot-context__sep").length === 0);
        const selectIcon = bar()?.querySelector('[data-tool="select"] svg');
        check("UI 选择按钮用给定的指针图形（48 视图、空心、currentColor）",
            selectIcon?.getAttribute("viewBox") === "0 0 48 48" &&
            selectIcon?.querySelector("path")?.getAttribute("d")?.startsWith("M8 6L43 25L24 27L13.9948 44L8 6Z") === true &&
            selectIcon?.querySelector("path")?.getAttribute("fill") === "none",
            String(selectIcon?.getAttribute("viewBox")));
        const panIcon = bar()?.querySelector('[data-tool="pan"] svg');
        check("UI 平移按钮用给定的手型（1024 视图、实心 currentColor）",
            panIcon?.getAttribute("viewBox") === "0 0 1024 1024" &&
            panIcon?.querySelector("path")?.getAttribute("fill") === "currentColor",
            String(panIcon?.getAttribute("viewBox")));

        // 点「平移」→ 按住拖动 → 画面跟着走，且不会画出任何东西
        const countObjects = () => layer()?.querySelectorAll("g[data-object-id]").length ?? 0;
        const objectsBeforePan = countObjects();
        bar()?.querySelector('[data-tool="pan"]')?.dispatchEvent(
            new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        await settleUI();
        check("UI 点「平移」后它成为当前工具，悬浮条只剩两颗按钮（无分割线、无文字）",
            bar()?.querySelector('[data-tool="pan"]')?.classList.contains("is-active") &&
            bar()?.querySelectorAll(".annot-context__sep").length === 0 &&
            bar()?.children.length === 1 && !(bar()?.textContent || "").trim(),
            JSON.stringify({sep: bar()?.querySelectorAll(".annot-context__sep").length, kids: bar()?.children.length}));
        const panBefore = readViewport();
        const fire = (target, type, x, y) => target.dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
        }));
        fire(svg, "pointerdown", 300, 300);
        fire(win.document, "pointermove", 360, 340);
        fire(win.document, "pointerup", 360, 340);
        const panAfter = readViewport();
        check("UI 平移：按住拖动 60/40 像素，画布跟着走同样的距离",
            Math.abs(panAfter.panX - panBefore.panX - 60) < 1.5 &&
            Math.abs(panAfter.panY - panBefore.panY - 40) < 1.5,
            `${panBefore.panX},${panBefore.panY} → ${panAfter.panX},${panAfter.panY}`);
        check("UI 平移不会凭空画出对象", countObjects() === objectsBeforePan, String(countObjects()));
        click('[data-action="zoom-fit"]');
        await settleUI();
        bar()?.querySelector('[data-tool="select"]')?.dispatchEvent(
            new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        await settleUI();

        // 序号专属参数
        click('button[data-tool="number"]');
        await settleUI();
        const formatItems = () => Array.from(bar()?.querySelectorAll('[data-action="number-format-pick"]') ?? []);
        const tipBtns = () => Array.from(bar()?.querySelectorAll('[data-action="number-tip"]') ?? []);
        const formatButtonText = () => (bar()
            ?.querySelector('[data-action="number-format-toggle"] .annot-arrow-picker__label')
            ?.textContent || "").trim();
        const styleItems = () => Array.from(bar()?.querySelectorAll('[data-action="number-style-pick"]') ?? []);
        const pickFormat = async (value) => {
            click('[data-action="number-format-toggle"]');
            await settleUI();
            click(`[data-action="number-format-pick"][data-value="${value}"]`);
            await settleUI();
        };
        check("UI 序号工具有参数，分割线也回来了",
            bar()?.querySelectorAll(".annot-context__sep").length === 1);
        check("UI 选中序号工具后：编号格式下拉 5 项 + 端点样式 5 项 + 末尾的圆线开关",
            formatItems().length === 5 && styleItems().length === 5 &&
            !!bar()?.querySelector('.annot-context__toggle[data-action="number-round-toggle"]'),
            `${formatItems().length} / ${tipBtns().length} / ${styleItems().length}`);
        check("UI 编号格式不再是一排小按钮（旧的 data-action=number-format 已移除）",
            !bar()?.querySelector('[data-action="number-format"]'));
        check("UI 编号格式下拉依次是 阿拉伯/罗马/小写/大写/中文，默认阿拉伯",
            formatItems().map((el) => el.getAttribute("data-value")).join(",") ===
            "arabic,roman,alphaLower,alphaUpper,chinese" &&
            formatItems()[0]?.classList.contains("is-active") &&
            formatButtonText() === "阿拉伯数字",
            `${formatItems().map((el) => el.getAttribute("data-value")).join(",")} · ${formatButtonText()}`);
        check("UI 端点是箭头时，右边给出与箭头工具同一套的端点（五种，带图案），默认燕尾",
            styleItems().map((el) => el.getAttribute("data-value")).join(",") ===
            "basic,classic,open,rhombus,circle" &&
            styleItems().some((el) => el.classList.contains("is-active")) &&
            !!styleItems()[0]?.querySelector("svg"),
            styleItems().map((el) => el.getAttribute("data-value")).join(","));
        check("UI 两个下拉默认都收起",
            !bar()?.querySelector('[data-role="number-format-picker"]')?.classList.contains("is-open") &&
            !bar()?.querySelector('[data-role="number-style-picker"]')?.classList.contains("is-open"));
        click('[data-action="number-format-toggle"]');
        await settleUI();
        check("UI 点编号格式按钮后下拉展开，aria-expanded 同步",
            bar()?.querySelector('[data-role="number-format-picker"]')?.classList.contains("is-open") === true &&
            bar()?.querySelector('[data-action="number-format-toggle"]')?.getAttribute("aria-expanded") === "true");
        click('[data-action="number-style-toggle"]');
        await settleUI();
        check("UI 打开箭头样式下拉时，编号格式下拉自动收起（两个不会同时展开）",
            bar()?.querySelector('[data-role="number-style-picker"]')?.classList.contains("is-open") === true &&
            bar()?.querySelector('[data-role="number-format-picker"]')?.classList.contains("is-open") === false);
        win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
            key: "Escape", bubbles: true, cancelable: true}));
        await settleUI();
        check("UI Esc 收起序号下拉，且不会顺手切走工具",
            !bar()?.querySelector('[data-role="number-style-picker"]')?.classList.contains("is-open") &&
            !!bar()?.querySelector('[data-action="number-format-toggle"]'));
        // 只看序号：序号组里有圆点徽章 + 文字，普通文字对象两者都没有
        const numberTexts = () => Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? [])
            .filter((group) => group.querySelector("circle") && group.querySelector("text.annot-shape"))
            .map((group) => group.querySelector("text.annot-shape")?.textContent ?? "");
        const dropNumber = (x, y) => {
            ptr("pointerdown", {x, y});
            ptr("pointerup", {x, y});
        };
        // 序号是「第几个」决定的，前面几个用例已经放过序号，这里按真实序号算期望值
        const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
        const CHINESE = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
        const base = numberTexts().length;
        await pickFormat("roman");
        check("UI 选完罗马数字后，下拉按钮上的字跟着变",
            formatButtonText() === "罗马数字", formatButtonText());
        dropNumber(160, 180);
        dropNumber(260, 180);
        await settleUI();
        check("UI 选罗马数字后，两个新序号显示为罗马数字（编号仍然连续）",
            numberTexts().slice(base).join(",") === `${ROMAN[base + 1]},${ROMAN[base + 2]}`,
            numberTexts().join(","));
        await pickFormat("chinese");
        dropNumber(360, 180);
        await settleUI();
        check("UI 切成中文数字后，新序号显示中文数字",
            numberTexts().slice(-1)[0] === CHINESE[base + 3], numberTexts().join(","));
        await pickFormat("alphaLower");
        dropNumber(460, 180);
        await settleUI();
        check("UI 切成小写字母后显示对应字母",
            numberTexts().slice(-1)[0] === String.fromCharCode(96 + base + 4), numberTexts().join(","));
        await pickFormat("alphaUpper");
        dropNumber(560, 180);
        await settleUI();
        check("UI 切成大写字母后显示对应字母",
            numberTexts().slice(-1)[0] === String.fromCharCode(64 + base + 5), numberTexts().join(","));

        // 选中已有序号时改格式：只改这一支，前面的不动
        const textsBeforeReflow = numberTexts();
        await pickFormat("roman");
        const textsAfterReflow = numberTexts();
        check("UI 选中序号时改格式，只改这一支（前面的保持原样）",
            textsAfterReflow.slice(-1)[0] === ROMAN[base + 5] &&
            textsAfterReflow.slice(0, -1).join(",") === textsBeforeReflow.slice(0, -1).join(","),
            `${textsBeforeReflow.join(",")} → ${textsAfterReflow.join(",")}`);
        await pickFormat("arabic");

        // 端点：圆点 / 方点
        const lastGroup = () => {
            const groups = Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? []);
            return groups[groups.length - 1];
        };
        const drawLeader = (tool) => {
            click(`button[data-tool="${tool}"]`);
            ptr("pointerdown", {x: 640, y: 300});
            ptr("pointermove", {x: 720, y: 330});
            ptr("pointerup", {x: 800, y: 360});
        };
        // 端点样式：圆形 / 菱形都走同一套 arrowShape，画出来的是箭头头部
        click('[data-action="number-style-toggle"]');
        await settleUI();
        click('[data-action="number-style-pick"][data-value="circle"]');
        await settleUI();
        drawLeader("number");
        await settleUI();
        check("UI 端点选「圆形」：引线末端画出一个箭头头部",
            (lastGroup()?.querySelectorAll("path.annot-head").length ?? 0) === 1);
        click('[data-action="number-style-toggle"]');
        await settleUI();
        click('[data-action="number-style-pick"][data-value="rhombus"]');
        await settleUI();
        drawLeader("number");
        await settleUI();
        check("UI 端点选「菱形」：引线末端同样是一个箭头头部",
            (lastGroup()?.querySelectorAll("path.annot-head").length ?? 0) === 1);

        // 端点回到箭头：引线头部与箭头工具完全同源
        click('[data-action="number-style-toggle"]');
        await settleUI();
        click('[data-action="number-style-pick"][data-value="classic"]');
        click('button[data-tool="arrow"]');
        await settleUI();
        click('[data-action="arrow-picker-toggle"]');
        click('.annot-arrow-picker__item[data-value="classic"]');
        await settleUI();
        ptr("pointerdown", {x: 700, y: 520});
        ptr("pointermove", {x: 760, y: 520});
        ptr("pointerup", {x: 820, y: 520});
        await settleUI();
        const arrowGroup = lastGroup();
        const arrowHeadD = arrowGroup?.querySelector("path.annot-head")?.getAttribute("d") || "";
        const arrowHeadWidth = arrowGroup?.querySelector("path.annot-head")?.getAttribute("stroke-width") || "";
        click('button[data-tool="number"]');
        ptr("pointerdown", {x: 700, y: 520});
        ptr("pointermove", {x: 760, y: 520});
        ptr("pointerup", {x: 820, y: 520});
        await settleUI();
        const numberGroup = lastGroup();
        const numberHeadD = numberGroup?.querySelector("path.annot-head")?.getAttribute("d") || "";
        check("UI 序号引线的箭头与箭头工具完全同一条路径（同起点同终点就一字不差）",
            !!arrowHeadD && arrowHeadD === numberHeadD, `${arrowHeadD.slice(0, 30)} | ${numberHeadD.slice(0, 30)}`);
        check("UI 序号引线头部按线宽描边（尖端不会露出线头），也不再是自拼的三角形",
            numberGroup?.querySelector("path.annot-head")?.getAttribute("stroke-width") === arrowHeadWidth &&
            !numberGroup?.querySelector("polygon"),
            `${arrowHeadWidth} vs ${numberGroup?.querySelector("path.annot-head")?.getAttribute("stroke-width")}`);
        check("UI 序号引线主干线宽与箭头一致",
            numberGroup?.querySelector("path.annot-shape")?.getAttribute("stroke-width") ===
            arrowGroup?.querySelector("path.annot-shape")?.getAttribute("stroke-width"),
            String(numberGroup?.querySelector("path.annot-shape")?.getAttribute("stroke-width")));

        // 引线的端点样式：下拉里选「菱形」应当当场作用在这一支上
        const headCount = () => lastGroup()?.querySelectorAll("path.annot-head").length ?? 0;
        click('[data-action="number-style-toggle"]');
        await settleUI();
        click('[data-action="number-style-pick"][data-value="rhombus"]');
        await settleUI();
        check("UI 序号端点选「菱形」后，这一支引线的箭头当场变菱形",
            (bar()?.querySelector('[data-role="number-style-label"]')?.textContent || "").trim() === "菱形" &&
            headCount() === 1,
            `${headCount()} 个头部 / ${bar()?.querySelector('[data-role="number-style-label"]')?.textContent}`);
        click('[data-action="number-style-toggle"]');
        await settleUI();
        click('[data-action="number-style-pick"][data-value="classic"]');
        await settleUI();
        check("UI 换回「燕尾」后仍是单个箭头", headCount() === 1, String(headCount()));
    }

    // --- v0.18.0：聚光灯 / 放大镜 ---
    {
        const bar = () => q('[data-role="context-bar"]');
        const layerGroups = () => Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? []);
        const lastGroup = () => layerGroups()[layerGroups().length - 1];
        const objectCount = () => layerGroups().length;
        const drawBox = (tool, a, b) => {
            click(`button[data-tool="${tool}"]`);
            ptr("pointerdown", a);
            ptr("pointermove", b);
            ptr("pointerup", b);
        };
        // jsdom 没有 elementFromPoint：要按在对象身上时，直接把 pointerdown 派发给命中元素，
        // 这样 e.target 才会是对象内部节点（真实浏览器里由浏览器负责这一步）
        const ptrOn = (el, type, pt) => {
            if (!el) return;
            const c = toClient(pt.x, pt.y);
            el.dispatchEvent(new win.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
            }));
        };
        // 带 Shift 的指针事件：放大镜的「正方形约束」要按 shiftKey 判断
        const ptrShift = (type, pt) => {
            const c = toClient(pt.x, pt.y);
            svg.dispatchEvent(new win.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, shiftKey: true,
                clientX: c.clientX, clientY: c.clientY,
            }));
        };
        const keyUp = (k) => win.document.body.dispatchEvent(new win.KeyboardEvent("keyup", {
            key: k, bubbles: true, cancelable: true}));
        const keyDown = (k) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
            key: k, bubbles: true, cancelable: true}));
        // 工具入口与图标
        check("UI 左侧工具栏多了聚光灯与放大镜两个按钮",
            !!q('button[data-tool="spotlight"]') && !!q('button[data-tool="magnifier"]'));
        check("UI 聚光灯图标换成实心灯头原稿（1024 视图、单段、fill=currentColor、不描边）",
            q('button[data-tool="spotlight"] svg')?.getAttribute("viewBox") === "0 0 1024 1024" &&
            q('button[data-tool="spotlight"] svg')?.querySelectorAll("path").length === 1 &&
            q('button[data-tool="spotlight"] svg path')?.getAttribute("fill") === "currentColor" &&
            q('button[data-tool="spotlight"] svg path')?.getAttribute("stroke") === "none" &&
            (q('button[data-tool="spotlight"] svg path')?.getAttribute("d") || "").startsWith("M705.4336"),
            q('button[data-tool="spotlight"] svg path')?.getAttribute("fill") || "missing");
        const extendSvg = q('[data-canvas-op="extend"] svg');
        const extendPath = extendSvg?.querySelector("path");
        check("UI 扩展画布图标换成嵌套方框原稿（1024 视图、单段、fill=currentColor）",
            extendSvg?.getAttribute("viewBox") === "0 0 1024 1024" &&
            extendSvg?.querySelectorAll("path").length === 1 &&
            extendPath?.getAttribute("fill") === "currentColor" &&
            extendPath?.getAttribute("stroke") === "none" &&
            (extendPath?.getAttribute("d") || "").startsWith("M320 864v96"),
            (extendPath?.getAttribute("d") || "missing").slice(0, 30));
        check("UI 放大镜图标用给定原稿（48 视图、四段描边）",
            q('button[data-tool="magnifier"] svg')?.getAttribute("viewBox") === "0 0 48 48" &&
            q('button[data-tool="magnifier"] svg')?.querySelectorAll("path").length === 4 &&
            q('button[data-tool="magnifier"] svg')?.getAttribute("stroke") === "currentColor");

        // 聚光灯
        drawBox("spotlight", {x: 120, y: 120}, {x: 420, y: 320});
        await settleUI();
        const spotGroup = lastGroup();
        const spotPath = spotGroup?.querySelector("path.annot-shape");
        check("UI 拖出聚光灯：遮罩盖住画布、中间挖洞（evenodd）、默认矩形",
            spotPath?.getAttribute("fill-rule") === "evenodd" &&
            (spotPath?.getAttribute("d") || "").includes("M-20000") &&
            (spotPath?.getAttribute("d") || "").includes("h300") &&
            (spotPath?.getAttribute("fill") || "").startsWith("rgba(0, 0, 0"),
            (spotPath?.getAttribute("fill") || ""));
        check("UI 聚光灯悬浮条：暗度滑杆 + 矩形/椭圆两颗按钮，默认矩形高亮",
            !!bar()?.querySelector('[data-ctx="spotlightOpacity"]') &&
            Array.from(bar()?.querySelectorAll('[data-action="spotlight-shape"]') ?? [])
                .map((el) => el.getAttribute("data-value")).join(",") === "rect,ellipse" &&
            bar()?.querySelector('[data-action="spotlight-shape"].is-active')?.getAttribute("data-value") === "rect");
        const holeOf = () => lastGroup()?.querySelector("path.annot-shape")?.getAttribute("d") || "";
        const rectHole = holeOf();
        click('[data-action="spotlight-shape"][data-value="ellipse"]');
        await settleUI();
        const ellipseHole = holeOf();
        check("UI 点「椭圆」后遮罩洞口立刻变成椭圆弧，点回「矩形」又变直边",
            ellipseHole.includes("a") && !rectHole.includes("a"),
            `${rectHole.slice(-26)} | ${ellipseHole.slice(-26)}`);
        click('[data-action="spotlight-shape"][data-value="rect"]');
        await settleUI();
        check("UI 切回矩形后洞口恢复直边", !holeOf().includes("a"));

        // 遮罩颜色：黑色（压暗）/ 白色（磨砂高亮）
        const maskFill = () => lastGroup()?.querySelector("path.annot-shape")?.getAttribute("fill") || "";
        const maskChips = () => Array.from(bar()?.querySelectorAll('[data-action="spotlight-color"]') ?? []);
        check("UI 聚光灯悬浮条有「黑色 / 白色」两种遮罩，默认黑色高亮",
            maskChips().map((el) => el.getAttribute("data-value")).join(",") === "black,white" &&
            maskChips().find((el) => el.classList.contains("is-active"))?.getAttribute("data-value") === "black" &&
            maskFill().startsWith("rgba(0, 0, 0"),
            `${maskChips().map((el) => el.getAttribute("data-value")).join(",")} / ${maskFill()}`);
        click('[data-action="spotlight-color"][data-value="white"]');
        await settleUI();
        check("UI 点「白色」后遮罩当场变半透明白，高亮跟过去",
            maskFill().startsWith("rgba(255, 255, 255") &&
            maskChips().find((el) => el.classList.contains("is-active"))?.getAttribute("data-value") === "white",
            maskFill());
        check("UI 白色遮罩的暗度沿用同一个滑杆（读数不变）",
            (q('[data-role="ctx-spotlightOpacity"]')?.textContent || "").trim() === "60%",
            String(q('[data-role="ctx-spotlightOpacity"]')?.textContent));
        click('[data-action="spotlight-color"][data-value="black"]');
        await settleUI();
        check("UI 点回「黑色」后遮罩颜色恢复", maskFill().startsWith("rgba(0, 0, 0"), maskFill());

        // 画完直接拖本体：应该是「挪它」而不是「再画一个」
        const spotBefore = objectCount();
        ptrOn(lastGroup()?.querySelector('rect[data-role="hit"]'), "pointerdown", {x: 270, y: 220});
        ptr("pointermove", {x: 330, y: 260});
        ptr("pointerup", {x: 330, y: 260});
        await settleUI();
        const spotAfterCount = objectCount();
        const movedHole = holeOf();
        check("UI 聚光灯工具下按住本体拖动＝挪位置，不会又叠一个",
            spotAfterCount === spotBefore && movedHole !== rectHole,
            `${spotBefore} → ${spotAfterCount}`);
        check("UI 聚光灯的命中框跟着挪了（亮区确实移动）",
            Number(lastGroup()?.querySelector('rect[data-role="hit"]')?.getAttribute("x")) > 120,
            String(lastGroup()?.querySelector('rect[data-role="hit"]')?.getAttribute("x")));

        // 暗度滑杆
        const slider = q('[data-ctx="spotlightOpacity"]');
        slider.value = "35";
        slider.dispatchEvent(new win.Event("input", {bubbles: true}));
        await settleUI();
        check("UI 拖暗度滑杆，遮罩颜色与读数一起变",
            (holeOf() && (lastGroup()?.querySelector("path.annot-shape")?.getAttribute("fill") || "").includes("0.35")) &&
            (q('[data-role="ctx-spotlightOpacity"]')?.textContent || "").trim() === "35%",
            String(lastGroup()?.querySelector("path.annot-shape")?.getAttribute("fill")));

        // 放大镜
        drawBox("magnifier", {x: 620, y: 160}, {x: 820, y: 360});
        await settleUI();
        const mag = lastGroup();
        const magLens = mag?.querySelector("image") || mag?.querySelector("ellipse.annot-shape");
        check("UI 拖出放大镜：有镜片、镜框、锚点与连线",
            !!mag?.querySelector("clipPath") &&
            mag?.querySelectorAll("circle").length >= 2 &&
            !!mag?.querySelector("line") &&
            !!mag?.querySelector("ellipse.annot-shape"),
            `circles=${mag?.querySelectorAll("circle").length}`);
        check("UI 放大镜悬浮条：4 档倍数 + 圆形/矩形，默认 2x 圆形",
            Array.from(bar()?.querySelectorAll('[data-action="magnifier-zoom"]') ?? [])
                .map((el) => el.getAttribute("data-value")).join(",") === "1.5,2,3,4" &&
            bar()?.querySelector('[data-action="magnifier-zoom"].is-active')?.getAttribute("data-value") === "2" &&
            bar()?.querySelector('[data-action="magnifier-shape"].is-active')?.getAttribute("data-value") === "ellipse");

        const anchorPt = () => {
            const circles = Array.from(lastGroup()?.querySelectorAll("circle") ?? []);
            const dot = circles[circles.length - 1];
            return {x: Number(dot.getAttribute("cx")), y: Number(dot.getAttribute("cy"))};
        };
        const lensRect = () => {
            const el = lastGroup()?.querySelector("image") || lastGroup()?.querySelector("ellipse.annot-shape");
            if (!el) return null;
            if (el.tagName === "ellipse") {
                const cx = Number(el.getAttribute("cx"));
                const cy = Number(el.getAttribute("cy"));
                return {x: cx - Number(el.getAttribute("rx")), y: cy - Number(el.getAttribute("ry"))};
            }
            return {x: Number(el.getAttribute("x")), y: Number(el.getAttribute("y"))};
        };
        const a0 = anchorPt();
        const l0 = lensRect();
        check("UI 新建放大镜时锚点被推到镜框外（连线一眼能看见）",
            a0.x < l0.x || a0.y < l0.y, `${JSON.stringify(a0)} / ${JSON.stringify(l0)}`);

        // 拖锚点：镜框不动
        ptrOn(lastGroup()?.querySelector('[data-role="anchor-hit"]'), "pointerdown", a0);
        ptr("pointermove", {x: a0.x - 120, y: a0.y + 90});
        ptr("pointerup", {x: a0.x - 120, y: a0.y + 90});
        await settleUI();
        const a1 = anchorPt();
        const l1 = lensRect();
        check("UI 拖锚点：锚点跟手走，镜框一动不动",
            Math.abs(a1.x - (a0.x - 120)) < 2 && Math.abs(a1.y - (a0.y + 90)) < 2 &&
            Math.abs(l1.x - l0.x) < 1 && Math.abs(l1.y - l0.y) < 1,
            `anchor ${a1.x},${a1.y} lens ${l1.x},${l1.y}`);

        // 拖镜框：锚点不动、连线跟随
        const lc = {x: l1.x + 100, y: l1.y + 100};
        ptrOn(lastGroup()?.querySelector('rect[data-role="hit"]'), "pointerdown", lc);
        ptr("pointermove", {x: lc.x + 50, y: lc.y + 30});
        ptr("pointerup", {x: lc.x + 50, y: lc.y + 30});
        await settleUI();
        const a2 = anchorPt();
        const l2 = lensRect();
        const line = lastGroup()?.querySelector("line");
        check("UI 拖镜框：框跟着走、锚点没动",
            Math.abs(l2.x - l1.x - 50) < 3 && Math.abs(a2.x - a1.x) < 1,
            `lens ${l1.x},${l1.y} → ${l2.x},${l2.y}；anchor ${a2.x}`);
        check("UI 连线两端始终分别连着锚点与镜框中心",
            Math.abs(Number(line.getAttribute("x1")) - a2.x) < 1 &&
            Math.abs(Number(line.getAttribute("y1")) - a2.y) < 1 &&
            Math.abs(Number(line.getAttribute("x2")) - (l2.x + 100)) < 1 &&
            Math.abs(Number(line.getAttribute("y2")) - (l2.y + 100)) < 1,
            `line ${line.getAttribute("x1")},${line.getAttribute("y1")} → ${line.getAttribute("x2")},${line.getAttribute("y2")}`);

        // 倍数 / 形状
        click('[data-action="magnifier-zoom"][data-value="3"]');
        await settleUI();
        check("UI 倍数切到 3x 后高亮跟着走",
            bar()?.querySelector('[data-action="magnifier-zoom"].is-active')?.getAttribute("data-value") === "3");
        click('[data-action="magnifier-shape"][data-value="rect"]');
        await settleUI();
        check("UI 放大镜切成矩形后，镜框从椭圆变成矩形",
            !!lastGroup()?.querySelector("rect.annot-shape") &&
            !lastGroup()?.querySelector("ellipse.annot-shape"));

        // Shift 正方形：拖 200×140，按住 Shift 应该得到 200×200
        click('button[data-tool="magnifier"]');
        await settleUI();
        // 上一步把形状切成了矩形（会记进默认值），这里先点回圆形，量 rx / ry 才直观
        click('[data-action="magnifier-shape"][data-value="ellipse"]');
        await settleUI();
        ptrShift("pointerdown", {x: 300, y: 640});
        ptrShift("pointermove", {x: 500, y: 780});
        ptrShift("pointerup", {x: 500, y: 780});
        await settleUI();
        const shiftLens = lastGroup()?.querySelector("ellipse.annot-shape");
        const shiftW = Number(shiftLens?.getAttribute("rx")) * 2;
        const shiftH = Number(shiftLens?.getAttribute("ry")) * 2;
        check("UI 放大镜按住 Shift 拖拽 = 正方形镜框（椭圆成正圆）",
            Math.abs(shiftW - 200) < 1 && Math.abs(shiftH - 200) < 1,
            `${shiftW}×${shiftH}`);

        // 拖到一半才按 Shift：鼠标不动也要立刻变正方形；松开立刻回到自由比例
        click('button[data-tool="magnifier"]');
        await settleUI();
        click('[data-action="magnifier-shape"][data-value="ellipse"]');
        await settleUI();
        ptr("pointerdown", {x: 300, y: 500});
        ptr("pointermove", {x: 500, y: 600});
        await settleUI();
        const previewBox = () => {
            const g = layer()?.querySelector("g.is-preview");
            const el = g?.querySelector("ellipse.annot-shape") || g?.querySelector("rect.annot-shape");
            if (!el) return null;
            return el.tagName === "ellipse"
                ? {w: Number(el.getAttribute("rx")) * 2, h: Number(el.getAttribute("ry")) * 2}
                : {w: Number(el.getAttribute("width")), h: Number(el.getAttribute("height"))};
        };
        const freeBox = previewBox();
        keyDown("Shift");
        await settleUI();
        const heldBox = previewBox();
        keyUp("Shift");
        await settleUI();
        const releasedBox = previewBox();
        check("UI 拖拽中途按 Shift：鼠标没动，预览也立刻变正方形",
            Math.abs(freeBox.w - freeBox.h) > 40 &&
            Math.abs(heldBox.w - heldBox.h) < 1 && Math.abs(heldBox.w - 200) < 1,
            `${JSON.stringify(freeBox)} → ${JSON.stringify(heldBox)}`);
        check("UI 松开 Shift：预览立刻回到自由比例（不会被锁死）",
            Math.abs(releasedBox.w - releasedBox.h) > 40,
            JSON.stringify(releasedBox));
        ptr("pointerup", {x: 500, y: 600});
        await settleUI();
        const freeLens = lastGroup()?.querySelector("ellipse.annot-shape");
        check("UI 松手后留下的是松开 Shift 时的自由比例",
            Math.abs(Number(freeLens?.getAttribute("rx")) * 2 -
                Number(freeLens?.getAttribute("ry")) * 2) > 40,
            `${freeLens?.getAttribute("rx")}/${freeLens?.getAttribute("ry")}`);
        click('[data-tool="select"]');
        await settleUI();
    }

    // --- v0.20.2：Shift 约束补齐（箭头 / 矩形 / 椭圆 / 聚光灯）---
    {
        const groups = () => Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? []);
        const lastGroup = () => groups()[groups().length - 1];
        const preview = () => layer()?.querySelector("g.is-preview");
        const withShift = (type, pt, shift) => {
            const c = toClient(pt.x, pt.y);
            svg.dispatchEvent(new win.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0, shiftKey: Boolean(shift),
                clientX: c.clientX, clientY: c.clientY,
            }));
        };
        const keyDown = (k) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
            key: k, bubbles: true, cancelable: true}));
        const keyUp = (k) => win.document.body.dispatchEvent(new win.KeyboardEvent("keyup", {
            key: k, bubbles: true, cancelable: true}));
        const drawWith = async (tool, a, b, shift) => {
            click(`button[data-tool="${tool}"]`);
            await settleUI();
            withShift("pointerdown", a, false);
            withShift("pointermove", b, shift);
            withShift("pointerup", b, shift);
            await settleUI();
        };
        // 箭头主干是 path：把 d 里的数字两两当坐标，取外接框就够判断方向了
        const pathBox = (d) => {
            const nums = (d || "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
            const xs = [];
            const ys = [];
            for (let i = 0; i + 1 < nums.length; i += 2) {
                xs.push(nums[i]);
                ys.push(nums[i + 1]);
            }
            if (!xs.length) return {w: 0, h: 0};
            return {w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
        };
        const arrowBox = () => pathBox(lastGroup()?.querySelector("path.annot-shape")?.getAttribute("d"));
        const shapeBox = (el) => {
            if (!el) return {w: 0, h: 0};
            if (el.tagName === "ellipse") {
                return {w: Number(el.getAttribute("rx")) * 2, h: Number(el.getAttribute("ry")) * 2};
            }
            return {w: Number(el.getAttribute("width")), h: Number(el.getAttribute("height"))};
        };

        // 重新打开一次编辑器，拿到干净画布：本块用例都从空画布起手。
        // 「同类防重叠」生效后，起点落在已有同类对象里会被拦成选中，断言就会读到旧对象。
        click('[data-action="close"]');
        await settleUI();
        openUI();
        await settleUI();
        svg = win.document.querySelector('[data-role="svg"]');
        check("UI Shift 约束用例从空画布起手", groups().length === 0, String(groups().length));

        // 箭头：自由角度（反证）
        await drawWith("arrow", {x: 200, y: 200}, {x: 400, y: 300}, false);
        const freeArrow = arrowBox();
        check("UI 箭头：不按 Shift 是自由角度（斜线不被吸走）",
            freeArrow.w > 150 && freeArrow.h > 60 && freeArrow.h < 140,
            `w=${freeArrow.w.toFixed(1)} h=${freeArrow.h.toFixed(1)}`);
        // 箭头 + Shift：水平（起点要让开上一条箭头，否则会被防重叠拦下）
        await drawWith("arrow", {x: 200, y: 380}, {x: 420, y: 412}, true);
        const flatArrow = arrowBox();
        check("UI 箭头：按住 Shift 吸附成水平（0°/180°）",
            flatArrow.w > 150 && flatArrow.h < 30,
            `w=${flatArrow.w.toFixed(1)} h=${flatArrow.h.toFixed(1)}`);
        // 箭头 + Shift：45°
        await drawWith("arrow", {x: 500, y: 300}, {x: 700, y: 460}, true);
        const diagArrow = arrowBox();
        check("UI 箭头：按住 Shift 吸附成 45°（横竖等长）",
            diagArrow.w > 120 && Math.abs(diagArrow.w - diagArrow.h) < 8,
            `w=${diagArrow.w.toFixed(1)} h=${diagArrow.h.toFixed(1)}`);

        // 矩形 + Shift → 正方形（边长取长边）
        await drawWith("rect", {x: 120, y: 120}, {x: 320, y: 250}, true);
        const square = shapeBox(lastGroup()?.querySelector("rect.annot-shape"));
        check("UI 矩形：按住 Shift 画出正方形（宽=高=200）",
            Math.abs(square.w - 200) < 1 && Math.abs(square.h - 200) < 1,
            JSON.stringify(square));
        // 反方向拖（左上）也要以按下点为角
        await drawWith("rect", {x: 620, y: 420}, {x: 520, y: 350}, true);
        const backSquare = shapeBox(lastGroup()?.querySelector("rect.annot-shape"));
        check("UI 矩形：往左上反方向按 Shift 拖也是正方形（起点仍是角）",
            Math.abs(backSquare.w - 100) < 1 && Math.abs(backSquare.h - 100) < 1,
            JSON.stringify(backSquare));

        // 椭圆 + Shift → 正圆
        await drawWith("ellipse", {x: 700, y: 120}, {x: 900, y: 250}, true);
        const circle = shapeBox(lastGroup()?.querySelector("ellipse.annot-shape"));
        check("UI 椭圆：按住 Shift 画出正圆（rx=ry=100）",
            Math.abs(circle.w - 200) < 1 && Math.abs(circle.h - 200) < 1,
            JSON.stringify(circle));

        // 聚光灯 + Shift → 洞口 1:1（矩形是正方形、椭圆是正圆）
        await drawWith("spotlight", {x: 120, y: 420}, {x: 320, y: 540}, true);
        const spotD = lastGroup()?.querySelector("path.annot-shape")?.getAttribute("d") || "";
        const spotHole = spotD.match(/h(-?[\d.]+)v(-?[\d.]+)/);
        check("UI 聚光灯（矩形）：按住 Shift 洞口变成正方形",
            !!spotHole && Math.abs(Number(spotHole[1])) === Math.abs(Number(spotHole[2])) &&
            Math.abs(Number(spotHole[1]) - 200) < 1,
            spotHole ? `h${spotHole[1]} v${spotHole[2]}` : spotD.slice(-40));
        click('[data-action="spotlight-shape"][data-value="ellipse"]');
        await settleUI();
        await drawWith("spotlight", {x: 480, y: 620}, {x: 640, y: 700}, true);
        const spotArc = (lastGroup()?.querySelector("path.annot-shape")?.getAttribute("d") || "")
            .match(/a([\d.]+) ([\d.]+) 0 1 0/);
        check("UI 聚光灯（椭圆）：按住 Shift 洞口变成正圆（两个半径相等）",
            !!spotArc && Math.abs(Number(spotArc[1]) - Number(spotArc[2])) < 0.01 &&
            Math.abs(Number(spotArc[1]) - 80) < 1,
            spotArc ? `rx=${spotArc[1]} ry=${spotArc[2]}` : "no arc");
        click('[data-action="spotlight-shape"][data-value="rect"]');
        await settleUI();

        // 中途松手：按住 Shift 拖到一半松开，立刻回到自由拉伸
        click('button[data-tool="rect"]');
        await settleUI();
        withShift("pointerdown", {x: 700, y: 560}, false);
        withShift("pointermove", {x: 900, y: 660}, false);
        await settleUI();
        const freeRect = () => shapeBox(preview()?.querySelector("rect.annot-shape"));
        const beforeShift = freeRect();
        keyDown("Shift");
        await settleUI();
        const heldRect = freeRect();
        keyUp("Shift");
        await settleUI();
        const releasedRect = freeRect();
        check("UI 矩形拖拽中途按 Shift：鼠标没动，预览立刻变正方形",
            Math.abs(beforeShift.w - 200) < 2 && Math.abs(beforeShift.h - 100) < 2 &&
            Math.abs(heldRect.w - 200) < 2 && Math.abs(heldRect.h - 200) < 2,
            `${JSON.stringify(beforeShift)} → ${JSON.stringify(heldRect)}`);
        check("UI 矩形松开 Shift：预览立刻回到自由比例",
            Math.abs(releasedRect.w - 200) < 2 && Math.abs(releasedRect.h - 100) < 2,
            JSON.stringify(releasedRect));
        withShift("pointerup", {x: 900, y: 660}, false);
        await settleUI();
        click('[data-tool="select"]');
        await settleUI();
    }

    // --- v0.21.0：多选（对齐模式）+ 对齐 / 分布 ---
    {
        const groups = () => Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []);
        const selectedCount = () => groups().filter((g) => g.classList.contains("is-selected")).length;
        const selectedIds = () => groups().filter((g) => g.classList.contains("is-selected"))
            .map((g) => g.getAttribute("data-object-id"));
        const alignBtns = () => Array.from(
            q('[data-role="context-bar"]')?.querySelectorAll('[data-action="align-op"]') ?? []);
        const rectsNow = () => Array.from(layer()?.querySelectorAll("rect.annot-shape") ?? [])
            .map((el) => ({x: Number(el.getAttribute("x")), w: Number(el.getAttribute("width"))}));
        const withMods = (type, pt, mods, el) => {
            const c = toClient(pt.x, pt.y);
            (el || svg).dispatchEvent(new win.MouseEvent(type, {
                bubbles: true, cancelable: true, button: 0,
                clientX: c.clientX, clientY: c.clientY, ...mods,
            }));
        };
        const hitOf = (id) => layer()?.querySelector(`g[data-object-id="${id}"] [data-role="hit"]`);
        const rowOf = (id) => q(`[data-role="object-item"][data-id="${id}"]`);
        const press = (k, mods = {}) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
            key: k, bubbles: true, cancelable: true, ...mods,
        }));

        // 三个已知位置的矩形
        click('button[data-tool="rect"]');
        drawUI("rect", {x: 100, y: 100}, {x: 200, y: 160});
        drawUI("rect", {x: 400, y: 220}, {x: 500, y: 280});
        drawUI("rect", {x: 900, y: 340}, {x: 1000, y: 400});
        click('button[data-tool="select"]');
        await settleUI();
        const ids = groups().slice(-3).map((g) => g.getAttribute("data-object-id"));
        check("多选：三个测试矩形都画出来了", ids.length === 3 && !!hitOf(ids[0]), ids.join(","));

        // 对齐按钮就在悬浮条常驻组里
        check("多选：悬浮条有【对齐】按钮（图标跟随主题）",
            !!q('[data-role="context-bar"] [data-action="align-mode"]') &&
            q('[data-role="context-bar"] [data-action="align-mode"] svg')?.getAttribute("viewBox") === "0 0 1024 1024");
        click('[data-action="align-mode"]');
        await settleUI();
        check("多选：点【对齐】进入对齐模式（按钮高亮）",
            q('[data-action="align-mode"]')?.classList.contains("is-active") &&
            q('[data-action="align-mode"]')?.getAttribute("aria-pressed") === "true");
        check("多选：只选中一个时还没有对齐面板", alignBtns().length === 0);

        // 画布 Ctrl 点选两个 → 联合包围框 + 8 个对齐按钮
        // 先点空白处清空（画完最后一个矩形它默认是选中的）
        withMods("pointerdown", {x: 40, y: 780}, {});
        withMods("pointerup", {x: 40, y: 780}, {});
        await settleUI();
        withMods("pointerdown", {x: 150, y: 130}, {ctrlKey: true}, hitOf(ids[0]));
        withMods("pointerup", {x: 150, y: 130}, {ctrlKey: true}, hitOf(ids[0]));
        await settleUI();
        withMods("pointerdown", {x: 950, y: 370}, {ctrlKey: true}, hitOf(ids[2]));
        withMods("pointerup", {x: 950, y: 370}, {ctrlKey: true}, hitOf(ids[2]));
        await settleUI();
        check("多选：画布 Ctrl 点选两个不同对象都选中了", selectedCount() === 2, String(selectedCount()));
        check("多选：2 个以上时悬浮条右侧展开 8 个对齐 / 分布按钮",
            alignBtns().length === 8 &&
            alignBtns().map((el) => el.getAttribute("data-value")).join(",") ===
            "left,center-x,right,top,middle,bottom,distribute-x,distribute-y",
            alignBtns().map((el) => el.getAttribute("data-value")).join(","));
        const overlayEl = win.document.querySelector('[data-layer="overlay"]');
        check("多选：画布上出现联合包围框（每个对象一圈 + 整组一个框）",
            !!overlayEl?.querySelector(".annot-selection-union") &&
            overlayEl?.querySelectorAll(".annot-selection-box").length === 2);
        check("多选：多选时不画单对象手柄（避免误拖）",
            overlayEl?.querySelectorAll("[data-handle]").length === 0);

        // 左对齐 → 两个对象左边缘对齐到最左那个
        const before = rectsNow();
        click('[data-action="align-op"][data-value="left"]');
        await settleUI();
        const afterLeft = rectsNow();
        check("对齐：左对齐后两个对象的左边缘都在 100",
            Math.abs(afterLeft[afterLeft.length - 3].x - 100) < 0.01 &&
            Math.abs(afterLeft[afterLeft.length - 1].x - 100) < 0.01,
            `${before.map((r) => r.x).join("/")} → ${afterLeft.slice(-3).map((r) => r.x).join("/")}`);
        press("z", {ctrlKey: true});
        await settleUI();
        check("对齐：Ctrl+Z 撤销后位置复原",
            Math.abs(rectsNow()[rectsNow().length - 1].x - 900) < 0.01,
            String(rectsNow()[rectsNow().length - 1].x));

        // 加上中间那个 → 三个一起横向分布
        withMods("pointerdown", {x: 450, y: 250}, {ctrlKey: true}, hitOf(ids[1]));
        withMods("pointerup", {x: 450, y: 250}, {ctrlKey: true}, hitOf(ids[1]));
        await settleUI();
        check("多选：再 Ctrl 点第三个 → 三个都选中", selectedCount() === 3, String(selectedCount()));
        click('[data-action="align-op"][data-value="distribute-x"]');
        await settleUI();
        const dist = rectsNow().slice(-3);
        const gap1 = dist[1].x - (dist[0].x + dist[0].w);
        const gap2 = dist[2].x - (dist[1].x + dist[1].w);
        check("分布：横向分布后三个矩形的间隙相等（首尾不动）",
            Math.abs(gap1 - gap2) < 0.01 && Math.abs(dist[0].x - 100) < 0.01 &&
            Math.abs(dist[2].x - 900) < 0.01,
            `x=${dist.map((r) => r.x).join("/")} gap=${gap1.toFixed(1)}/${gap2.toFixed(1)}`);
        press("z", {ctrlKey: true});
        await settleUI();
        check("分布：Ctrl+Z 撤销回原来的散落位置",
            Math.abs(rectsNow()[rectsNow().length - 2].x - 400) < 0.01,
            String(rectsNow()[rectsNow().length - 2].x));

        // 右侧列表：点锚点 → Shift 选区间 → Ctrl 加减选
        rowOf(ids[0])?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        await settleUI();
        check("列表多选：先点一行＝单选（并设为锚点）", selectedCount() === 1, String(selectedCount()));
        const order = groups().map((g) => g.getAttribute("data-object-id"));
        const firstRow = order[0];
        const fourthRow = order[3];
        rowOf(firstRow)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        await settleUI();
        rowOf(fourthRow)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true, shiftKey: true}));
        await settleUI();
        check("列表多选：Shift 点第 4 行 → 第 1~4 行全选中",
            selectedCount() === 4 && selectedIds().join(",") === order.slice(0, 4).join(","),
            `${selectedCount()} / ${selectedIds().join(",")}`);
        rowOf(order[1])?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true}));
        await settleUI();
        check("列表多选：Ctrl 点已选中的第 2 行 → 取消它", selectedCount() === 3, String(selectedCount()));
        rowOf(order[1])?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true}));
        await settleUI();
        check("列表多选：再 Ctrl 点第 2 行 → 重新加回来", selectedCount() === 4, String(selectedCount()));

        // 画布上拖拽空白处：不出现虚线框，也不会框选（v0.21.0 明确不做框选）
        withMods("pointerdown", {x: 1180, y: 760}, {});
        withMods("pointerup", {x: 1180, y: 760}, {});
        await settleUI();
        check("点空白处清空选择", selectedCount() === 0, String(selectedCount()));
        withMods("pointerdown", {x: 60, y: 60}, {ctrlKey: true});
        withMods("pointermove", {x: 1050, y: 430}, {ctrlKey: true});
        withMods("pointerup", {x: 1050, y: 430}, {ctrlKey: true});
        await settleUI();
        check("画布拖拽空白处不会框选（没有虚线框，也没有选中任何对象）",
            selectedCount() === 0 &&
            !win.document.querySelector('[data-layer="overlay"] .annot-marquee') &&
            String(q('[data-role="overlay"]')?.innerHTML || "").indexOf("marquee") < 0,
            String(selectedCount()));

        // Esc 退出对齐模式，选择收回单选
        press("Escape");
        await settleUI();
        check("对齐模式按 Esc 退回普通选择，多选收成单选",
            !q('[data-action="align-mode"]')?.classList.contains("is-active") &&
            selectedCount() <= 1, String(selectedCount()));
        click('button[data-tool="select"]');
        await settleUI();
    }

    // --- v0.16.0：顶栏按钮换位 + 全屏 / 还原 ---
    {
        const shell = win.document.querySelector(".b3-dialog");
        const container = shell?.querySelector(".b3-dialog__container");
        const fsBtn = () => q('[data-action="fullscreen"]');
        const titlebarKids = Array.from(q(".annot-titlebar")?.children ?? []);
        check("UI 全屏按钮在「保存」右侧，是标题栏最后一个",
            titlebarKids[titlebarKids.length - 1] === fsBtn(),
            titlebarKids.map((el) => el.getAttribute("data-action") || el.className).join(","));
        check("UI 全屏按钮用给定图标（1024 视图、四角向外、currentColor）",
            fsBtn()?.querySelector("svg")?.getAttribute("viewBox") === "0 0 1024 1024" &&
            fsBtn()?.querySelectorAll("svg path").length === 9 &&
            Array.from(fsBtn()?.querySelectorAll("svg path") ?? [])
                .every((el) => el.getAttribute("fill") === "currentColor") &&
            fsBtn()?.getAttribute("aria-pressed") === "false",
            String(fsBtn()?.querySelectorAll("svg path").length));
        const styleBefore = container?.getAttribute("style") || "";
        fsBtn()?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        await settleUI();
        const expandedStyle = container?.getAttribute("style") || "";
        check("UI 点全屏后外壳被撑满（100vw + 100vh/dvh、去圆角、去阴影）",
            /width: 100vw/.test(expandedStyle) && /height: 100(vh|dvh)/.test(expandedStyle) &&
            /border-radius: 0/.test(expandedStyle) &&
            q(".annot-root")?.classList.contains("is-fullscreen"),
            expandedStyle.slice(0, 80));
        check("UI 全屏后按钮变成「窗口化还原」图标与提示",
            fsBtn()?.getAttribute("aria-pressed") === "true" &&
            (fsBtn()?.getAttribute("title") || "").includes("还原") &&
            fsBtn()?.querySelectorAll("svg path").length === 1,
            String(fsBtn()?.querySelectorAll("svg path").length));
        const {panX, panY, zoom} = readViewport();
        const layerEl = win.document.querySelector('[data-role="transform"]');
        const canvasW = Number.parseFloat(layerEl?.style.width) || 1200;
        const canvasH = Number.parseFloat(layerEl?.style.height) || 800;
        const stageW = win.__stageW || 1000;
        const stageH = win.__stageH || 700;
        check("UI 全屏后画布重新适应并居中（不变形、按比例缩放）",
            Math.abs(panX - (stageW - canvasW * zoom) / 2) < 1.5 &&
            Math.abs(panY - (stageH - canvasH * zoom) / 2) < 1.5,
            `pan=${panX.toFixed(1)},${panY.toFixed(1)} zoom=${zoom.toFixed(3)}`);
        fsBtn()?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
        await settleUI();
        check("UI 再点一次还原：内联样式一字不差写回，不留 important 覆盖",
            (container?.getAttribute("style") || "") === styleBefore &&
            !q(".annot-root")?.classList.contains("is-fullscreen") &&
            fsBtn()?.getAttribute("aria-pressed") === "false",
            container?.getAttribute("style") || "");
        check("UI 还原后图标换回四角向外", fsBtn()?.querySelectorAll("svg path").length === 9);
    }

    click('[data-action="close"]');
    await settleUI();
}

// ---------------------------------------------------------------- v0.7.0 适应窗口 / 底栏 / 图像工具栏 / 文字描边
if (process.argv[3] === "--m6") {
    Object.defineProperty(globalThis, "localStorage", {value: win.localStorage, configurable: true});
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const key = (k, options = {}) => win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
        key: k, bubbles: true, cancelable: true, ...options,
    }));
    const fire = (el, type) => el?.dispatchEvent(new win.Event(type, {bubbles: true, cancelable: true}));
    const settleM6 = () => new Promise((resolve) => setTimeout(resolve, 30));
    let svg = null;

    const open = () => {
        const d = makeDetail();
        listeners.get("open-menu-image")?.({detail: d.detail});
        d.getItem()?.click();
    };
    const viewportOf = () => readViewport();
    const canvasSize = () => {
        const layer = win.document.querySelector('[data-role="transform"]');
        return {
            width: Number.parseFloat(layer?.style.width) || 0,
            height: Number.parseFloat(layer?.style.height) || 0,
        };
    };
    const ptr = (type, pt) => {
        const c = toClient(pt.x, pt.y);
        svg.dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
        }));
    };
    const draw = (tool, a, b) => {
        click(`button[data-tool="${tool}"]`);
        ptr("pointerdown", a);
        ptr("pointermove", {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
        ptr("pointerup", b);
    };
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    const overlay = () => win.document.querySelector('[data-layer="overlay"]');
    const arrowD = () => layer()?.querySelector(".annot-shape")?.getAttribute("d") || "";
    // 路径里前四个数字就是起点与终点的坐标（终点会因为箭头头部略有内缩，所以只比相对关系）
    const numsOf = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).slice(0, 4).map(Number);
    const near = (a, b, t = 0.9) => Math.abs(a - b) <= t;
    const arrowNear = (expected) => {
        const actual = numsOf(arrowD());
        return actual.length === 4 && actual.every((v, i) => near(v, expected[i]));
    };

    open();
    await settleM6();
    svg = win.document.querySelector('[data-role="svg"]');

    // 1) 打开即适应窗口：整张图完整可见且居中
    {
        const {zoom, panX, panY} = viewportOf();
        const {width, height} = canvasSize();
        const expectedZoom = Math.min((1000 - 64) / width, (700 - 64) / height, 1);
        check("M6 打开时自动缩放到整张图完整可见",
            Math.abs(zoom - expectedZoom) < 0.01, `zoom=${zoom} 期望 ≈${expectedZoom.toFixed(2)}`);
        check("M6 图片在可用区域内居中",
            Math.abs(panX - (1000 - width * zoom) / 2) < 1 && Math.abs(panY - (700 - height * zoom) / 2) < 1,
            `pan=${panX.toFixed(1)},${panY.toFixed(1)}`);
        check("M6 未放大到超出可用区域", width * zoom <= 1000 && height * zoom <= 700,
            `${(width * zoom).toFixed(0)}×${(height * zoom).toFixed(0)}`);
    }

    // 1b) 窗口更大时，小图会被放大到接近铺满（以前死卡在 100%，看着就像「没适应」）
    win.__stageW = 1600;
    win.__stageH = 1000;
    win.dispatchEvent(new win.Event("resize"));
    // jsdom 里的 ResizeObserver 是空壳，这里用「适应窗口」按钮走同一套 fitTransform
    click('[data-action="zoom-fit"]');
    {
        const {zoom} = viewportOf();
        const {width, height} = canvasSize();
        check("M6 舞台变大后图片放大到接近铺满", zoom > 1.05, `zoom=${zoom}`);
        check("M6 放大后仍然整张完整可见",
            width * zoom <= 1601 && height * zoom <= 1001,
            `${(width * zoom).toFixed(0)}×${(height * zoom).toFixed(0)}`);
    }
    win.__stageW = 1000;
    win.__stageH = 700;
    win.dispatchEvent(new win.Event("resize"));
    click('[data-action="zoom-fit"]');
    check("M6 舞台变回原尺寸后重新适应",
        Math.abs(viewportOf().zoom - 0.78) < 0.01, String(viewportOf().zoom));

    // 2) 底栏三段式：左分辨率 / 中提示 / 右缩放按钮
    check("M6 底栏左侧显示当前分辨率",
        q('.annot-status [data-role="dimensions"]')?.textContent === "1200 × 800 px",
        String(q('.annot-status [data-role="dimensions"]')?.textContent));
    check("M6 底栏中间显示当前工具提示", /选择/.test(q('.annot-status [data-role="hint"]')?.textContent || ""),
        String(q('.annot-status [data-role="hint"]')?.textContent));
    check("M6 底栏右侧有放大 / 缩小 / 适应窗口",
        !!q('.annot-status__zoom [data-action="zoom-in"]') &&
        !!q('.annot-status__zoom [data-action="zoom-out"]') &&
        !!q('.annot-status__zoom [data-action="zoom-fit"]'));
    check("M6 顶部工具栏不再放缩放按钮", !q('.annot-toolbar [data-action="zoom-in"]'));
    click('button[data-tool="text"]');
    check("M6 切换工具后底栏提示跟着变", /文字/.test(q('.annot-status [data-role="hint"]')?.textContent || ""),
        String(q('.annot-status [data-role="hint"]')?.textContent));
    click('button[data-tool="select"]');

    // 3) 左侧图像工具栏
    const ops = Array.from(win.document.querySelectorAll("[data-canvas-op]"))
        .map((el) => el.getAttribute("data-canvas-op"));
    check("M6 左侧图像工具栏有 6 个按钮",
        ops.join(",") === "crop,extend,rotate-ccw,rotate-cw,flip-h,flip-v", ops.join(","));
    check("M6 图像工具栏在画布左侧",
        q(".annot-main")?.firstElementChild?.classList.contains("annot-imagebar"));
    const barIcons = Array.from(win.document.querySelectorAll(".annot-imagebar [data-canvas-op] svg"));
    // 扩展画布改用用户给的 1024 实心原稿，其余五个仍是 48 视图线性图标
    // 两类都要求带 annot-icon 类、20px、颜色走 currentColor
    check("M6 图像工具栏图标与其它图标同一规格（扩展画布为用户原稿，其余 48 视图线条）",
        barIcons.length === 6 && barIcons.every((el) =>
            el.classList.contains("annot-icon") &&
            el.getAttribute("width") === "20") &&
        barIcons.filter((el) => el.getAttribute("viewBox") === "0 0 48 48").every((el) =>
            el.getAttribute("stroke-width") === "4" &&
            el.getAttribute("stroke") === "currentColor") &&
        q('[data-canvas-op="extend"] svg')?.getAttribute("viewBox") === "0 0 1024 1024" &&
        q('[data-canvas-op="extend"] svg path')?.getAttribute("fill") === "currentColor",
        `${barIcons.length} 个 / ` + barIcons.map((el) => el.getAttribute("viewBox")).join(","));
    check("M6 裁切与扩展画布已从顶部工具栏移走",
        !q('.annot-toolbar [data-canvas-op="crop"]') && !q('.annot-toolbar [data-canvas-op="extend"]'));

    // 4) 旋转：画布宽高对调，标注跟随变换
    draw("arrow", {x: 60, y: 60}, {x: 200, y: 120});
    draw("rect", {x: 300, y: 200}, {x: 420, y: 300});
    const base = numsOf(arrowD());
    click('[data-canvas-op="rotate-cw"]');
    check("M6 向右旋转后画布宽高对调",
        canvasSize().width === 800 && canvasSize().height === 1200,
        `${canvasSize().width}×${canvasSize().height}`);
    check("M6 旋转后画布尺寸同步对调（viewBox 始终等于当前可见区域）", (() => {
        const layer = q('[data-role="transform"]');
        const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
        return layer?.style.width === "800px" && layer?.style.height === "1200px" &&
            vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    })(), String(svg.getAttribute("viewBox")));
    check("M6 旋转后底图矩阵带 90° 旋转",
        /matrix\(0,\s*1,\s*-1,\s*0,\s*800,\s*0\)/.test(q('[data-role="base"]')?.style.transform || ""),
        q('[data-role="base"]')?.style.transform || "");
    check("M6 箭头跟着底图转到新坐标",
        arrowNear([800 - base[1], base[0], 800 - base[3], base[2]]), arrowD());
    check("M6 旋转后重新适应窗口",
        Math.abs(viewportOf().zoom - Math.min(936 / 800, 636 / 1200, 1)) < 0.01, String(viewportOf().zoom));
    // 矩形 (300,200)-(420,300)：中心 (360,250) → (550,360)，新左上角 (490,310)
    const rectAfterRotate = layer()?.querySelector("rect.annot-shape");
    check("M6 矩形也跟到新坐标",
        near(Number(rectAfterRotate?.getAttribute("x")), 490) &&
        near(Number(rectAfterRotate?.getAttribute("y")), 310),
        `${rectAfterRotate?.getAttribute("x")},${rectAfterRotate?.getAttribute("y")}`);

    click('[data-canvas-op="rotate-ccw"]');
    check("M6 反向旋转回到原尺寸", canvasSize().width === 1200 && canvasSize().height === 800);
    check("M6 反向旋转后箭头回到原位", arrowNear(base), arrowD());

    // 5) 旋转可撤销 / 重做（画布状态一起进历史栈）
    click('[data-canvas-op="rotate-cw"]');
    key("z", {ctrlKey: true});
    check("M6 Ctrl+Z 撤销旋转（画布一起回滚）",
        canvasSize().width === 1200 && arrowNear(base),
        `${canvasSize().width}×${canvasSize().height} / ${arrowD()}`);
    key("z", {ctrlKey: true, shiftKey: true});
    check("M6 Ctrl+Shift+Z 重做旋转",
        canvasSize().width === 800 && arrowNear([800 - base[1], base[0], 800 - base[3], base[2]]),
        `${canvasSize().width} / ${arrowD()}`);
    key("z", {ctrlKey: true});

    // 6) 翻转：位置镜像、画布尺寸不变
    click('[data-canvas-op="flip-h"]');
    check("M6 水平翻转后箭头 x 镜像",
        arrowNear([1200 - base[0], base[1], 1200 - base[2], base[3]]), arrowD());
    check("M6 翻转不改变画布尺寸", canvasSize().width === 1200 && canvasSize().height === 800);
    click('[data-canvas-op="flip-h"]');
    check("M6 再次水平翻转恢复原状", arrowNear(base), arrowD());
    click('[data-canvas-op="flip-v"]');
    check("M6 垂直翻转后箭头 y 镜像",
        arrowNear([base[0], 800 - base[1], base[2], 800 - base[3]]), arrowD());
    key("z", {ctrlKey: true});
    check("M6 撤销垂直翻转", arrowNear(base), arrowD());

    // 7) 文字描边：默认白色 2px（v0.21.0 移除属性栏目后不再有开关，只保留默认效果）
    click('button[data-tool="text"]');
    ptr("pointerdown", {x: 120, y: 420});
    let editor = q(".annot-text-editor");
    editor.value = "描边文字";
    editor.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
    const textEl = () => Array.from(layer()?.querySelectorAll("text.annot-shape") ?? [])
        .find((el) => el.textContent === "描边文字");
    check("M6 新文字默认带白色 2px 描边",
        textEl()?.getAttribute("stroke") === "#FFFFFF" &&
        textEl()?.getAttribute("stroke-width") === "2" &&
        textEl()?.getAttribute("paint-order") === "stroke",
        `${textEl()?.getAttribute("stroke")} / ${textEl()?.getAttribute("stroke-width")}`);
    check("M6 描边不影响文字填充色", !!textEl()?.getAttribute("fill"));
    const textId = textEl()?.closest("[data-object-id]")?.getAttribute("data-object-id");
    click(`[data-role="object-item"][data-id="${textId}"]`);
    check("M6 右侧只剩对象 / 层级（文字描边的开关随属性栏目一起移除）",
        !q('[data-role="props"]') && !q('[data-role="props"] input[data-prop="textStrokeEnabled"]') &&
        !!q('[data-section="objects"]') && !!q('[data-section="layers"]'));
    check("M6 描边默认效果不受影响（白色 2px 仍画在文字上）",
        textEl()?.getAttribute("stroke") === "#FFFFFF" && textEl()?.getAttribute("stroke-width") === "2",
        `${textEl()?.getAttribute("stroke")} / ${textEl()?.getAttribute("stroke-width")}`);
    check("M6 文字仍可拖动（描边不影响命中）",
        !!layer()?.querySelector(`g[data-object-id="${textId}"] [data-role="hit"]`));

    // 8) 裁切：拖出区域 → 确认 → 画布变小、标注整体平移
    click('[data-action="close"]');
    await settleM6();
    open();
    await settleM6();
    svg = win.document.querySelector('[data-role="svg"]');
    draw("rect", {x: 200, y: 200}, {x: 300, y: 300});
    // 参考插件：框还在时点框外一律不重画；想重新框选，先按 Delete 把框清掉
    const newCropBox = (from, to) => {
        key("Delete");
        ptr("pointerdown", from);
        ptr("pointerup", to);
    };
    click('[data-canvas-op="crop"]');
    check("M6 点裁切后右侧栏换成裁剪面板",
        q('[data-role="crop-side"]')?.hidden === false && q('[data-role="sidebar"]')?.hidden === true);
    check("M6 进入裁剪默认框铺满整张图（参考插件 getBackgroundCropBounds）",
        /保留 1200 × 800 px/.test(q('[data-role="crop-size"]')?.textContent || ""),
        String(q('[data-role="crop-size"]')?.textContent));
    // 框铺满整图时避开四角手柄，在框内拖一下（平移会被夹住，尺寸不该变）
    ptr("pointerdown", {x: 900, y: 600});
    ptr("pointermove", {x: 1000, y: 650});
    ptr("pointerup", {x: 1000, y: 650});
    check("M6 有框时拖拽不会重画新框（参考插件行为）",
        /保留 1200 × 800 px/.test(q('[data-role="crop-size"]')?.textContent || ""),
        String(q('[data-role="crop-size"]')?.textContent));
    key("Delete");
    check("M6 按 Delete 清掉裁剪框", !q('[data-crop-box]'),
        String(q('[data-role="crop-size"]')?.textContent));
    ptr("pointerdown", {x: 10, y: 10});
    ptr("pointermove", {x: 200, y: 150});
    ptr("pointerup", {x: 410, y: 310});
    check("M6 清框后拖出新框后显示保留尺寸",
        /400 × 300/.test(q('[data-role="crop-size"]')?.textContent || ""),
        String(q('[data-role="crop-size"]')?.textContent));
    check("M6 裁切框有压暗遮罩与虚线边", (overlay()?.querySelectorAll("rect").length ?? 0) >= 5);

    // 8a) 裁剪框可调：8 个手柄、框内拖动、比例预设（v0.9.7）
    const cropSize = () => {
        const text = q('[data-role="crop-size"]')?.textContent || "";
        const m = /保留 (\d+) × (\d+) px(?: · (.+))?/.exec(text);
        return m ? {w: Number(m[1]), h: Number(m[2]), ratio: m[3] || "", raw: text} : null;
    };
    const handleAt = (name) => {
        const el = overlay()?.querySelector(`[data-crop-handle="${name}"]`);
        if (!el) return null;
        return {
            el,
            x: Number(el.getAttribute("x")) + Number(el.getAttribute("width")) / 2,
            y: Number(el.getAttribute("y")) + Number(el.getAttribute("height")) / 2,
        };
    };
    check("M6 裁切框有 8 个手柄（四角 + 四边中点）",
        overlay()?.querySelectorAll("[data-crop-handle]").length === 8,
        String(overlay()?.querySelectorAll("[data-crop-handle]").length));
    check("M6 裁切框内有一块可拖动的命中区", !!q('[data-crop-box]'));

    let handle = handleAt("e");
    ptr("pointerdown", {x: handle.x, y: handle.y}, handle.el);
    ptr("pointermove", {x: handle.x + 50, y: handle.y});
    ptr("pointerup", {x: handle.x + 50, y: handle.y});
    check("M6 拖右边手柄把框拉宽到 450（不用重拖）",
        cropSize()?.w === 450 && cropSize()?.h === 300, JSON.stringify(cropSize()));

    // 框内拖动：只挪位置，尺寸不变
    const boxEl = q('[data-crop-box]');
    const boxCenter = {
        x: Number(boxEl.getAttribute("x")) + Number(boxEl.getAttribute("width")) / 2,
        y: Number(boxEl.getAttribute("y")) + Number(boxEl.getAttribute("height")) / 2,
    };
    ptr("pointerdown", {x: boxCenter.x, y: boxCenter.y}, boxEl);
    ptr("pointermove", {x: boxCenter.x, y: boxCenter.y + 20});
    ptr("pointerup", {x: boxCenter.x, y: boxCenter.y + 20});
    check("M6 框内拖动只挪位置、不改尺寸",
        cropSize()?.w === 450 && cropSize()?.h === 300, JSON.stringify(cropSize()));

    // 比例预设：自由 + 原图 + 9 档固定比例
    check("M6 比例预设共 11 项（自由 / 原图 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3 / 16:9 / 9:16 / 5:4 / 2.35:1）",
        q('[data-role="crop-ratios"]')?.querySelectorAll("button").length === 11,
        String(q('[data-role="crop-ratios"]')?.querySelectorAll("button").length));
    click('[data-action="crop-ratio"][data-ratio="16:9"]');
    const r169 = cropSize();
    check("M6 锁 16:9 后框就地变成 16:9",
        !!r169 && Math.abs(r169.w / r169.h - 16 / 9) < 0.02, JSON.stringify(r169));
    check("M6 尺寸标签带上当前比例", /16:9/.test(r169?.ratio || ""), String(r169?.ratio));
    check("M6 比例按钮高亮为 16:9",
        q('[data-action="crop-ratio"][data-ratio="16:9"]')?.classList.contains("is-active"));

    handle = handleAt("se");
    ptr("pointerdown", {x: handle.x, y: handle.y}, handle.el);
    ptr("pointermove", {x: handle.x + 80, y: handle.y + 80});
    ptr("pointerup", {x: handle.x + 80, y: handle.y + 80});
    const rAfterScale = cropSize();
    check("M6 锁比例时拖角手柄仍保持 16:9",
        !!rAfterScale && Math.abs(rAfterScale.w / rAfterScale.h - 16 / 9) < 0.02, JSON.stringify(rAfterScale));

    click('[data-action="crop-ratio"][data-ratio="source"]');
    const rSource = cropSize();
    check("M6 选「原图」得到 1200:800 的比例",
        !!rSource && Math.abs(rSource.w / rSource.h - 1.5) < 0.02, JSON.stringify(rSource));

    click('[data-action="crop-ratio"][data-ratio="free"]');
    check("M6 切回「自由」后高亮跟着换",
        q('[data-action="crop-ratio"][data-ratio="free"]')?.classList.contains("is-active") &&
        !q('[data-action="crop-ratio"][data-ratio="16:9"]')?.classList.contains("is-active"));

    // 框上的 ✓ / ✕：先点 ✕ 取消，再重进拖框、点 ✓ 应用
    const cropAction = (name) => {
        const el = overlay()?.querySelector(`[data-crop-action="${name}"]`);
        if (!el) return null;
        return {x: Number(el.getAttribute("data-crop-cx")), y: Number(el.getAttribute("data-crop-cy"))};
    };
    check("M6 裁切框上方浮着 ✓ / ✕ 两个按钮",
        overlay()?.querySelectorAll("[data-crop-action]").length === 2,
        String(overlay()?.querySelectorAll("[data-crop-action]").length));
    const cancelPoint = cropAction("cancel");
    ptr("pointerdown", cancelPoint);
    ptr("pointerup", cancelPoint);
    check("M6 点 ✕ 直接取消裁剪，面板收起",
        q('[data-role="crop-side"]')?.hidden === true && q('[data-role="sidebar"]')?.hidden === false);
    svg = win.document.querySelector('[data-role="svg"]');
    click('[data-canvas-op="crop"]');
    newCropBox({x: 10, y: 10}, {x: 410, y: 310});
    check("M6 重进裁切后按 Delete 清框仍能拖出 400 × 300",
        cropSize()?.w === 400 && cropSize()?.h === 300, JSON.stringify(cropSize()));
    const applyPoint = cropAction("apply");
    check("M6 拖框后框上方出现 ✓ / ✕", !!applyPoint && !!cropAction("cancel"));
    ptr("pointerdown", applyPoint);
    ptr("pointerup", applyPoint);
    check("M6 裁切后画布为 400 × 300",
        canvasSize().width === 400 && canvasSize().height === 300,
        `${canvasSize().width}×${canvasSize().height}`);
    const viewEl = q('[data-role="viewport"]');
    check("M6 底图被收进 400 × 300 的可视窗口（框外画面不再露出）",
        !!viewEl && viewEl.contains(q('[data-role="base"]')) &&
        viewEl.style.width === "400px" && viewEl.style.height === "300px",
        `${viewEl?.style.width}×${viewEl?.style.height}`);
    check("M6 可视窗口用 overflow:hidden 真正剪掉框外的底图",
        /\.annot-viewport\s*\{[^}]*overflow:\s*hidden/.test(css),
        String(/\.annot-viewport\s*\{[^}]*\}/.exec(css)?.[0] || "").slice(0, 120));
    const cropped = layer()?.querySelector("rect.annot-shape");
    check("M6 裁切后标注跟着平移到新坐标",
        Math.round(Number(cropped?.getAttribute("x"))) === 190 &&
        Math.round(Number(cropped?.getAttribute("y"))) === 190,
        `${cropped?.getAttribute("x")},${cropped?.getAttribute("y")}`);
    check("M6 裁切后底图矩阵带上偏移",
        /matrix\(1,\s*0,\s*0,\s*1,\s*-10,\s*-10\)/.test(q('[data-role="base"]')?.style.transform || ""),
        q('[data-role="base"]')?.style.transform || "");
    key("z", {ctrlKey: true});
    check("M6 撤销裁切恢复原画布", canvasSize().width === 1200, `${canvasSize().width}`);

    // 9) 扩展画布：四周同步（先裁到 400×300）
    click('[data-canvas-op="crop"]');
    newCropBox({x: 10, y: 10}, {x: 410, y: 310});
    click('[data-action="crop-apply"]');
    check("M6 扩展前先裁到 400 × 300",
        canvasSize().width === 400 && canvasSize().height === 300,
        `${canvasSize().width}×${canvasSize().height}`);
    click('[data-canvas-op="extend"]');
    check("M6 点扩展画布打开浮层", q('[data-role="extend-pop"]')?.hidden === false);
    check("M6 扩展面板有四个方向 + 四周", q('[data-role="extend-pop"]')?.querySelectorAll("[data-dir]").length === 5);
    // 方向盘布局：中心方块（四周）+ 四边箭头，各自带定位类，CSS 用 grid-areas 摆位
    check("M6 方向按钮按方向盘布局（中心方块 + 四边箭头）",
        !!q('[data-dir="all"]')?.classList.contains("annot-dir--all") &&
        ["top", "bottom", "left", "right"].every(
            (d) => q(`[data-dir="${d}"]`)?.classList.contains(`annot-dir--${d}`)),
        String(q('[data-role="extend-dirs"]')?.className));
    // 默认是「四周同步 + 锁链」，第一个框（上）可输入，其余锁死
    const marginInput = q('[data-role="extend-top"]');
    marginInput.value = "50";
    fire(marginInput, "input");
    click('[data-action="extend-apply"]');
    check("M6 四周同步扩展各 50px",
        canvasSize().width === 500 && canvasSize().height === 400,
        `${canvasSize().width}×${canvasSize().height}`);
    const extended = layer()?.querySelector("rect.annot-shape");
    check("M6 扩展后标注跟着内移 50px",
        Math.round(Number(extended?.getAttribute("x"))) === 240 &&
        Math.round(Number(extended?.getAttribute("y"))) === 240,
        `${extended?.getAttribute("x")},${extended?.getAttribute("y")}`);
    check("M6 扩展浮层用后自动关闭", q('[data-role="extend-pop"]')?.hidden === true);
    check("M6 底栏分辨率同步成新画布尺寸",
        q('[data-role="dimensions"]')?.textContent === "500 × 400 px",
        String(q('[data-role="dimensions"]')?.textContent));

    // 9b) 只扩指定方向；没选中的方向输入框锁死，锁链只同步「选中」的那几个
    click('[data-canvas-op="extend"]');
    click('[data-dir="all"]');
    check("M6 点中间方块可以一键取消全部方向",
        Array.from(win.document.querySelectorAll("[data-dir]"))
            .every((el) => !el.classList.contains("is-active")));
    check("M6 四个方向各有一个数值框",
        q('[data-role="extend-pop"]')?.querySelectorAll('input[data-role^="extend-"]').length === 4,
        String(q('[data-role="extend-pop"]')?.querySelectorAll('input[data-role^="extend-"]').length));
    check("M6 一个方向都没选时四个框全部锁死",
        ["top", "bottom", "left", "right"].every((dir) => q(`[data-role="extend-${dir}"]`)?.disabled === true),
        ["top", "bottom", "left", "right"].map((d) => `${d}:${q(`[data-role="extend-${d}"]`)?.disabled}`).join(" "));

    // 只选「上」：只有第一个框能输入，其余三个锁死（用户口径：选几个就激活几个）
    click('[data-dir="top"]');
    check("M6 只选上方时只有上方的框能输入",
        q('[data-role="extend-top"]')?.disabled === false &&
        ["bottom", "left", "right"].every((dir) => q(`[data-role="extend-${dir}"]`)?.disabled === true) &&
        q('[data-role="extend-top"]')?.closest(".annot-amount")?.classList.contains("is-locked") === false,
        ["top", "bottom", "left", "right"].map((d) => `${d}:${q(`[data-role="extend-${d}"]`)?.disabled}`).join(" "));
    check("M6 锁死的框整行都带 is-locked（淡灰）",
        ["bottom", "left", "right"].every(
            (dir) => q(`[data-role="extend-${dir}"]`)?.closest(".annot-amount")?.classList.contains("is-locked") === true));

    // 再选「右」：上和右都能输入，下和左仍然锁死
    click('[data-dir="right"]');
    check("M6 选了两个方向就激活这两个框",
        q('[data-role="extend-top"]')?.disabled === false &&
        q('[data-role="extend-right"]')?.disabled === false &&
        q('[data-role="extend-bottom"]')?.disabled === true &&
        q('[data-role="extend-left"]')?.disabled === true,
        ["top", "bottom", "left", "right"].map((d) => `${d}:${q(`[data-role="extend-${d}"]`)?.disabled}`).join(" "));

    // 锁链：只在「活动的」输入框之间同步，只有第一个活动的能输入
    click('[data-action="toggle-link"]');
    check("M6 点锁链后只有第一个活动的框可输入，其余锁死",
        q('[data-role="extend-top"]')?.disabled === false &&
        ["bottom", "left", "right"].every((dir) => q(`[data-role="extend-${dir}"]`)?.disabled === true) &&
        q('[data-action="toggle-link"]')?.classList.contains("is-active"),
        ["top", "bottom", "left", "right"].map((d) => `${d}:${q(`[data-role="extend-${d}"]`)?.disabled}`).join(" "));
    check("M6 连接后活动的框显示同一个数",
        q('[data-role="extend-right"]')?.value === q('[data-role="extend-top"]')?.value,
        `${q('[data-role="extend-top"]')?.value} / ${q('[data-role="extend-right"]')?.value}`);
    click('[data-action="toggle-link"]');
    check("M6 取消连接后两个选中的框又能分别输入",
        q('[data-role="extend-top"]')?.disabled === false &&
        q('[data-role="extend-right"]')?.disabled === false,
        ["top", "bottom", "left", "right"].map((d) => `${d}:${q(`[data-role="extend-${d}"]`)?.disabled}`).join(" "));

    // 未连接时按方向各填各的
    const topInput = q('[data-role="extend-top"]');
    topInput.value = "30";
    fire(topInput, "input");
    const rightInput = q('[data-role="extend-right"]');
    rightInput.value = "90";
    fire(rightInput, "input");
    click('[data-action="extend-apply"]');
    check("M6 未连接时上、右各用各的数值（高 +30、宽 +90）",
        canvasSize().width === 590 && canvasSize().height === 430,
        `${canvasSize().width}×${canvasSize().height}`);
    const shifted = layer()?.querySelector("rect.annot-shape");
    check("M6 只扩上方时标注整体下移 30px",
        Math.round(Number(shifted?.getAttribute("y"))) === 270 &&
        Math.round(Number(shifted?.getAttribute("x"))) === 240,
        `${shifted?.getAttribute("x")},${shifted?.getAttribute("y")}`);

    // 点「四周同步」= 四个方向全选 + 直接打开锁链
    click('[data-canvas-op="extend"]');
    click('[data-dir="all"]');
    check("M6 点四周同步会直接打开锁链",
        q('[data-action="toggle-link"]')?.classList.contains("is-active") === true &&
        q('[data-role="extend-bottom"]')?.disabled === true);
    click('[data-action="extend-apply"]');

    // 9c) 底色：默认透明，可选白/黑/自定义
    click('[data-canvas-op="extend"]');
    const bgLayer = () => win.document.querySelector('[data-role="canvas-bg"]');
    check("M6 默认底色透明（不铺色层）", bgLayer()?.hidden !== false);
    click('[data-bg="white"]');
    check("M6 选白色后提示会铺白底",
        /FFFFFF/i.test(q('[data-role="extend-tip"]')?.textContent || ""),
        String(q('[data-role="extend-tip"]')?.textContent));
    click('[data-action="extend-apply"]');
    check("M6 画布底色层铺上白色",
        bgLayer()?.hidden === false &&
        /(rgb\(255,\s*255,\s*255\)|#FFFFFF)/i.test(bgLayer()?.style.background || ""),
        String(bgLayer()?.style.background));

    // 9d) 吸管：从图片上取色
    win.HTMLCanvasElement.prototype.getContext = () => ({
        drawImage() {}, getImageData: () => ({data: [18, 52, 86, 255]}),
    });
    click('[data-canvas-op="extend"]');
    click('[data-action="bg-pick"]');
    const rootEl = win.document.querySelector(".annot-root");
    check("M6 点吸管进入取色态", rootEl?.classList.contains("is-picking") === true);
    ptr("pointerdown", {x: 200, y: 150});
    ptr("pointerup", {x: 200, y: 150});
    check("M6 吸管取到颜色后退出取色态", rootEl?.classList.contains("is-picking") !== true);
    check("M6 吸到的颜色写进吸管色块",
        String(q('[data-role="bg-custom2"]')?.dataset.color || "").toUpperCase() === "#123456",
        String(q('[data-role="bg-custom2"]')?.dataset.color));
    check("M6 吸管取色后不产生新的标注对象", layer()?.querySelectorAll("g.annot-object").length === 1,
        String(layer()?.querySelectorAll("g.annot-object").length));
    // 图标断言：面板刷新时若误写 textContent，图标会被冲掉
    check("M6 吸管色块里是吸管图标且刷新后仍在",
        !!q('[data-role="bg-custom2"]')?.querySelector("svg.annot-pick-icon"),
        String(q('[data-role="bg-custom2"]')?.innerHTML || "").slice(0, 60));
    click('[data-action="extend-apply"]');
    check("M6 用吸管色扩展后底色层同步",
        /(rgb\(18,\s*52,\s*86\)|#123456)/i.test(bgLayer()?.style.background || ""),
        String(bgLayer()?.style.background));

    // 10) 裁切态与其它操作互斥：切工具即退出裁切，Ctrl+Z 不会被误触发
    const objectCount = () => layer()?.querySelectorAll("g.annot-object").length ?? -1;
    click('[data-canvas-op="crop"]');
    const copyBefore = objectCount();
    key("z", {ctrlKey: true});
    check("M6 裁切态下 Ctrl+Z 被忽略（不会边裁边撤销）",
        objectCount() === copyBefore && q('[data-role="crop-side"]')?.hidden === false,
        `${copyBefore} → ${objectCount()}`);
    click('button[data-tool="arrow"]');
    check("M6 切工具自动退出裁切态",
        q('[data-role="crop-side"]')?.hidden === true && svg.getAttribute("data-active-tool") === "arrow");
    click('button[data-tool="select"]');

    // 11) 清掉框之后，从图片外的灰色留白起手也能拖框
    // （真实鼠标最容易踩的坑：只在画布内部响应会像"没反应"）
    click('[data-canvas-op="crop"]');
    key("Delete");
    const stageEl = win.document.querySelector(".annot-stage");
    const stagePtr = (type, pt) => stageEl.dispatchEvent(new win.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: pt.x, clientY: pt.y,
    }));
    stagePtr("pointerdown", {x: 5, y: 5});
    stagePtr("pointermove", {x: 200, y: 180});
    stagePtr("pointerup", {x: 400, y: 350});
    const barText = q('[data-role="crop-size"]')?.textContent || "";
    check("M6 Delete 清框后从图片外的留白起手也能拖出裁切框",
        /保留 [1-9]\d* × [1-9]\d* px/.test(barText), barText);
    const [barW, barH] = (barText.match(/\d+/g) || []).map(Number);
    click('[data-action="crop-apply"]');
    check("M6 留白起手的裁切同样生效",
        canvasSize().width === barW && canvasSize().height === barH,
        `${canvasSize().width}×${canvasSize().height} 期望 ${barW}×${barH}`);

    click('[data-action="close"]');
    await settleM6();

    // 12) 再裁剪：能扩回上一次裁掉的范围（保存成 SVG 后重开也是同一套逻辑）
    click('[data-action="close"]');
    await settleM6();
    open();
    await settleM6();
    svg = win.document.querySelector('[data-role="svg"]');
    draw("rect", {x: 200, y: 200}, {x: 400, y: 400});
    click('[data-canvas-op="crop"]');
    newCropBox({x: 10, y: 10}, {x: 410, y: 310});
    click('[data-action="crop-apply"]');
    check("M6 再裁剪准备：先裁到 400 × 300",
        canvasSize().width === 400 && canvasSize().height === 300,
        `${canvasSize().width}×${canvasSize().height}`);

    click('[data-canvas-op="crop"]');
    check("M6 再进裁剪时画布临时扩回完整范围",
        canvasSize().width === 1200 && canvasSize().height === 800,
        `${canvasSize().width}×${canvasSize().height}`);
    check("M6 再进裁剪时可视窗口也铺回完整原图",
        q('[data-role="viewport"]')?.style.width === "1200px" &&
        q('[data-role="viewport"]')?.style.height === "800px",
        `${q('[data-role="viewport"]')?.style.width}×${q('[data-role="viewport"]')?.style.height}`);
    check("M6 默认框正好是上次保留的那块（400 × 300）",
        cropSize()?.w === 400 && cropSize()?.h === 300, JSON.stringify(cropSize()));
    const keepApply = cropAction("apply");
    ptr("pointerdown", keepApply);
    ptr("pointerup", keepApply);
    check("M6 框没动就点 ✓ 等于取消，画布仍是 400 × 300",
        canvasSize().width === 400 && canvasSize().height === 300,
        `${canvasSize().width}×${canvasSize().height}`);

    click('[data-canvas-op="crop"]');
    const cancelKeep = cropAction("cancel");
    ptr("pointerdown", cancelKeep);
    ptr("pointerup", cancelKeep);
    check("M6 在扩张状态下点 ✕ 会还原回 400 × 300（不是停在 1200）",
        canvasSize().width === 400 && canvasSize().height === 300,
        `${canvasSize().width}×${canvasSize().height}`);

    click('[data-canvas-op="crop"]');
    click('[data-action="crop-full"]');
    check("M6 点「整张图」框扩到整幅 1200 × 800",
        cropSize()?.w === 1200 && cropSize()?.h === 800, JSON.stringify(cropSize()));
    const fullApply = cropAction("apply");
    ptr("pointerdown", fullApply);
    ptr("pointerup", fullApply);
    check("M6 应用后画布恢复整幅",
        canvasSize().width === 1200 && canvasSize().height === 800,
        `${canvasSize().width}×${canvasSize().height}`);
    const back = layer()?.querySelector("rect.annot-shape");
    check("M6 被裁掉的标注区域随画布一起回来，标注回到原坐标",
        Math.round(Number(back?.getAttribute("x"))) === 200 &&
        Math.round(Number(back?.getAttribute("y"))) === 200,
        `${back?.getAttribute("x")},${back?.getAttribute("y")}`);

    // 12b) 参考插件在「再裁剪」时不允许框外重画，只能调整已有框把范围拖回来
    click('[data-canvas-op="crop"]');
    newCropBox({x: 10, y: 10}, {x: 410, y: 310});
    click('[data-action="crop-apply"]');
    click('[data-canvas-op="crop"]');
    const beforeOuterDrag = cropSize();
    // 选一个远离四角手柄的空白处，免得误抓到手柄变成缩放
    ptr("pointerdown", {x: 900, y: 600});
    ptr("pointermove", {x: 1000, y: 650});
    ptr("pointerup", {x: 1000, y: 650});
    check("M6 再裁剪时框外拖拽不会重画掉原有框（参考插件行为）",
        cropSize()?.w === beforeOuterDrag?.w && cropSize()?.h === beforeOuterDrag?.h,
        `${JSON.stringify(beforeOuterDrag)} → ${JSON.stringify(cropSize())}`);
    const seHandle = overlay()?.querySelector('[data-crop-handle="se"]');
    const seX = Number(seHandle?.getAttribute("data-crop-cx"));
    const seY = Number(seHandle?.getAttribute("data-crop-cy"));
    ptr("pointerdown", {x: seX, y: seY});
    ptr("pointermove", {x: seX + 200, y: seY + 100});
    ptr("pointerup", {x: seX + 200, y: seY + 100});
    check("M6 拖四角手柄能把框放大回上次裁剪范围之外",
        cropSize()?.w === 600 && cropSize()?.h === 400, JSON.stringify(cropSize()));
    key("Delete");
    check("M6 裁剪态按 Delete 会把框清掉（参考插件行为）",
        !q('[data-crop-box]') &&
        /拖出要保留的区域/.test(q('[data-role="crop-size"]')?.textContent || ""),
        String(q('[data-role="crop-size"]')?.textContent));
    ptr("pointerdown", {x: 100, y: 100});
    ptr("pointerup", {x: 400, y: 300});
    check("M6 清框后还能重新拖出一个新框",
        cropSize()?.w === 300 && cropSize()?.h === 200, JSON.stringify(cropSize()));
    click('[data-action="crop-cancel"]');
    check("M6 取消再裁剪后可视窗口还原成 400 × 300",
        q('[data-role="viewport"]')?.style.width === "400px" &&
        q('[data-role="viewport"]')?.style.height === "300px",
        `${q('[data-role="viewport"]')?.style.width}×${q('[data-role="viewport"]')?.style.height}`);

    // 13) 打开时舞台还没定尺寸（对话框进场动画/布局晚到），之后才变大 → 必须自己纠正
    win.__stageW = 842;
    win.__stageH = 484;
    open();
    await settleM6();
    const zoomSmall = viewportOf().zoom;
    win.__stageW = 1054;
    win.__stageH = 652;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const zoomBig = viewportOf().zoom;
    check("M6 舞台后变大时会自动重新适应窗口",
        zoomBig > zoomSmall + 0.05, `${zoomSmall} → ${zoomBig}`);
    check("M6 纠正后整张图仍然完整可见",
        1200 * zoomBig <= 1054 + 1 && 800 * zoomBig <= 652 + 1,
        `${(1200 * zoomBig).toFixed(0)}×${(800 * zoomBig).toFixed(0)}`);
    win.__stageW = 1000;
    win.__stageH = 700;
    click('[data-action="close"]');
    await settleM6();

    // 14) 真·保存 → 重新右键打开 → 再裁剪。
    // 参考插件的关键能力是「保存之后还能把范围扩到上次裁剪之外」，
    // 所以这里必须真的把写回去的 PNG 读回来，不能只在同一个编辑器里反复进出裁剪。
    const rtFiles = new Map([
        ["data/assets/demo.png", "FAKE-IMAGE-BYTES"],
        ["data/assets/fresh.png", "FAKE-IMAGE-BYTES"],
    ]);
    const rtUploads = [];
    const rtMessages = [];
    const rtPuts = [];
    fakeSiyuan.showMessage = (msg) => rtMessages.push(String(msg));
    const PNG_BYTES = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
    );
    const readPacked = (buf) => {
        if (!buf) return null;
        const bytes = Uint8Array.from(buf);
        let offset = 8;
        while (offset + 12 <= bytes.length) {
            const length = (((bytes[offset] << 24) | (bytes[offset + 1] << 16)
                | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
            const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
            if (type === "tEXt" && length < bytes.length - offset) {
                const text = new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length));
                const split = text.indexOf("\0");
                if (split > 0 && text.slice(0, split) === "siyuan-plugin-annotate") {
                    return JSON.parse(text.slice(split + 1));
                }
            }
            offset += 12 + length;
        }
        return null;
    };
    const packedAt = (path) => readPacked(rtFiles.get("data/" + path));
    globalThis.XMLSerializer = win.XMLSerializer;
    globalThis.Image = class {
        set src(value) { this._src = value; setTimeout(() => this.onload?.(), 0); }
        get src() { return this._src; }
    };
    win.HTMLCanvasElement.prototype.toBlob = function (callback) {
        callback(new Blob([PNG_BYTES], {type: "image/png"}));
    };
    globalThis.fetch = async (url, options = {}) => {
        const endpoint = String(url);
        if (endpoint === "/api/file/getFile") {
            const {path: p} = JSON.parse(options.body);
            const data = rtFiles.get(p);
            return new Response(data ?? "missing", {status: data === undefined ? 404 : 200});
        }
        if (endpoint === "/api/file/putFile") {
            const form = options.body;
            const path = form.get("path");
            rtPuts.push(path);
            rtFiles.set(path, Buffer.from(await form.get("file").arrayBuffer()));
            return new Response("{}", {status: 200});
        }
        if (endpoint === "/upload") {
            const file = options.body.get("file[]");
            rtUploads.push(file);
            const name = file?.name || "upload.bin";
            const assetPath = "assets/" + name;
            rtFiles.set("data/" + assetPath, Buffer.from(await file.arrayBuffer()));
            return new Response(JSON.stringify({
                code: 0, msg: "", data: {succMap: {[name]: assetPath}},
            }), {status: 200});
        }
        if (endpoint === "/api/attr/getBlockAttrs") {
            return new Response(JSON.stringify({
                code: 0, msg: "", data: {id: "202611080000000-abcdefg", updated: "1"},
            }), {status: 200});
        }
        return new Response("{}", {status: 200});
    };
    const openAsset = (assetPath) => {
        const fakeImg = {getAttribute: (n) => (n === "data-src" ? assetPath : assetPath + "?v=2")};
        const fakeBlock = {
            getAttribute: (n) => (n === "data-type" ? "NodeParagraph" : "202611080000000-abcdefg"),
            textContent: "",
        };
        const detail = {
            protyle: {},
            element: {
                querySelector: (s) => (s === "img" ? fakeImg : null),
                closest: (s) => (s === "[data-node-id]" ? fakeBlock : null),
            },
            menu: {addItem() {}, addSeparator() {}},
        };
        listeners.get("open-menu-image")?.({detail});
        mainMenuItems[mainMenuItems.length - 1]?.click();
    };

    openAsset("assets/demo.png");
    await settleM6();
    svg = win.document.querySelector('[data-role="svg"]');
    draw("rect", {x: 200, y: 200}, {x: 300, y: 300});
    click('[data-canvas-op="crop"]');
    newCropBox({x: 10, y: 10}, {x: 410, y: 310});
    click('[data-action="crop-apply"]');
    check("M6 保存前先裁到 400 × 300",
        canvasSize().width === 400 && canvasSize().height === 300,
        `${canvasSize().width}×${canvasSize().height}`);
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("M6 保存时就地覆盖同一个 PNG，没有上传任何新资源",
        rtPuts.includes("data/assets/demo.png") && rtUploads.length === 0,
        `写入=${rtPuts.join(",")} 上传=${rtUploads.length} 消息=${(rtMessages || []).join(" / ")}`);
    const savedPackage = packedAt("assets/demo.png");
    check("M6 PNG 里显式记下了裁剪窗口（保存后扩回的依据）",
        savedPackage?.scene?.crop?.width === 400 && savedPackage?.scene?.crop?.height === 300,
        JSON.stringify(savedPackage?.scene?.crop));
    check("M6 PNG 里同时留着完整原始底图（所以能扩回外围）",
        !!savedPackage?.base?.dataUrl?.startsWith("data:image/") && savedPackage?.base?.width === 1200,
        `${savedPackage?.base?.width}×${savedPackage?.base?.height}`);
    check("M6 保存没有生成附档 / 索引",
        ![...rtFiles.keys()].some((p) => p.endsWith(".annot.json") || p.endsWith("/index.json")));
    if (q(".annot-root")) {
        click('[data-action="close"]');
        await settleM6();
    }
    // 只留这一张 PNG，逼着编辑器只靠图片自带的工程数据还原画布与裁剪窗口
    for (const p of Array.from(rtFiles.keys())) {
        if (p.endsWith(".annot.json") || p.endsWith("/index.json")) rtFiles.delete(p);
    }

    openAsset("assets/demo.png");
    await settleM6();
    svg = win.document.querySelector('[data-role="svg"]');
    check("M6 重新打开的是 400 × 300 的成品图",
        q('[data-role="transform"]')?.style.width === "400px" &&
        q('[data-role="transform"]')?.style.height === "300px",
        String(svg?.getAttribute("viewBox")));
    check("M6 重新打开时插件里也只显示 400 × 300（不再露出完整原图）",
        q('[data-role="viewport"]')?.style.width === "400px" &&
        q('[data-role="viewport"]')?.style.height === "300px" &&
        /matrix\(1,\s*0,\s*0,\s*1,\s*-10,\s*-10\)/.test(q('[data-role="base"]')?.style.transform || ""),
        `${q('[data-role="viewport"]')?.style.width}×${q('[data-role="viewport"]')?.style.height} / ${q('[data-role="base"]')?.style.transform}`);
    click('[data-canvas-op="crop"]');
    check("M6 保存后再次裁剪：画布扩回完整原图范围",
        canvasSize().width === 1200 && canvasSize().height === 800,
        `${canvasSize().width}×${canvasSize().height}`);
    check("M6 保存后再次裁剪：框正好是上次保留的 400 × 300",
        cropSize()?.w === 400 && cropSize()?.h === 300, JSON.stringify(cropSize()));
    click('[data-action="crop-full"]');
    check("M6 保存后仍可一键扩回整张图",
        cropSize()?.w === 1200 && cropSize()?.h === 800, JSON.stringify(cropSize()));
    click('[data-action="crop-apply"]');
    check("M6 保存后扩回整张图并应用成功",
        canvasSize().width === 1200 && canvasSize().height === 800,
        `${canvasSize().width}×${canvasSize().height}`);
    click('[data-action="close"]');
    await settleM6();

    // 15) 参考插件：保存时若有还没确认的裁剪框，会先自动应用，
    // 不会出现「编辑器里看着裁好了，保存出来还是原来的图」
    openAsset("assets/fresh.png");
    await settleM6();
    svg = win.document.querySelector('[data-role="svg"]');
    click('[data-canvas-op="crop"]');
    newCropBox({x: 10, y: 10}, {x: 410, y: 310});
    check("M6 保存前裁剪框还没确认，画布仍是整幅",
        canvasSize().width === 1200 && canvasSize().height === 800,
        `${canvasSize().width}×${canvasSize().height}`);
    const putsBeforeAuto = rtPuts.length;
    click('[data-action="save"]');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const autoPack = packedAt("assets/fresh.png");
    check("M6 保存前自动应用了未确认的裁剪框",
        autoPack?.scene?.canvas?.width === 400 && autoPack?.scene?.canvas?.height === 300 &&
        autoPack?.scene?.crop?.width === 400,
        JSON.stringify(autoPack?.scene?.crop));
    check("M6 自动应用裁剪同样只覆盖同一个文件",
        rtPuts.length === putsBeforeAuto + 1 &&
        rtPuts[rtPuts.length - 1] === "data/assets/fresh.png" && rtUploads.length === 0,
        rtPuts.slice(putsBeforeAuto).join(","));
    if (q(".annot-root")) {
        click('[data-action="close"]');
        await settleM6();
    }
}

// ---------------------------------------------------------------- v0.9.16 文字：透明输入框 / 自动换行
if (process.argv[3] === "--m7") {
    Object.defineProperty(globalThis, "localStorage", {value: win.localStorage, configurable: true});
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const fire = (el, type) => el?.dispatchEvent(new win.Event(type, {bubbles: true, cancelable: true}));
    let svg = null;
    const ptr = (type, pt, target) => {
        const c = toClient(pt.x, pt.y);
        (target || svg).dispatchEvent(new win.MouseEvent(type, {
            bubbles: true, cancelable: true, button: 0, clientX: c.clientX, clientY: c.clientY,
        }));
    };
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    const texts = () => Array.from(layer()?.querySelectorAll("text.annot-shape") ?? []);
    const lineCount = (el) => new Set(
        Array.from(el?.querySelectorAll("tspan") ?? [])
            .map((t) => t.getAttribute("y"))
            .filter((y) => y !== null),
    ).size;
    const typeText = (pt, value) => {
        ptr("pointerdown", pt);
        let area = q(".annot-text-editor");
        if (!area) {
            // 上一段输入还没收尾：这一下只用来结束它，再点一次才新建
            ptr("pointerdown", pt);
            area = q(".annot-text-editor");
        }
        if (!area) return null;
        area.value = value;
        fire(area, "input");
        area.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
        return area;
    };

    const detail = makeDetail();
    listeners.get("open-menu-image")?.({detail: detail.detail});
    detail.getItem()?.click();
    await tick();
    await tick();
    svg = win.document.querySelector('[data-role="svg"]');

    // 1) 输入框：透明、没有占位提示、宽度贴着文字且不超过画布右边
    click('button[data-tool="text"]');
    ptr("pointerdown", {x: 100, y: 120});
    const area = q(".annot-text-editor");
    check("M7 文字输入框没有任何占位提示", !!area && !area.getAttribute("placeholder"));
    // 空文字时输入框宽度＝两个半字高（文字包围盒最小宽度 2 字 + 半字余量）
    const emptyWidth = 2.5 * Number.parseFloat(area?.style.fontSize || "0");
    const wrapLimit = (1200 - 100 - 8) * readViewport().zoom;
    check("M7 输入框宽度贴着文字、且不超过画布右边",
        Math.abs(Number.parseFloat(area?.style.width || "0") - emptyWidth) < 0.6 &&
        Number.parseFloat(area?.style.width || "0") <= wrapLimit + 0.6,
        `${area?.style.width} 期望 ${emptyWidth.toFixed(1)}px，上限 ${wrapLimit.toFixed(1)}px`);
    check("M7 输入框允许自动换行（不再是单行锁定）", area?.wrap === "soft", String(area?.wrap));
    check("M7 打出来的字就是对象颜色 + 白影（过程中不反色）",
        (area?.style.color || "").includes("239") && (area?.style.textShadow || "").length > 0 &&
        !area?.style.mixBlendMode,
        `color=${area?.style.color} shadow=${String(area?.style.textShadow).slice(0, 20)}`);
    check("M7 输入框细框是单独一层（只让边框反色，文字不受影响）",
        !!q(".annot-text-frame") && !area?.style.outline, String(q(".annot-text-frame")?.className));

    // 2) 长文字碰到画布右边自动折行
    typeText({x: 100, y: 420}, "拼".repeat(90));
    const wrapped = texts()[0];
    check("M7 超长文字在画布右边缘折成多行", lineCount(wrapped) >= 3, `行数 ${lineCount(wrapped)}`);
    check("M7 折行后仍从文字左边开始排",
        Math.round(Number(wrapped?.getAttribute("x"))) === 100, String(wrapped?.getAttribute("x")));
    check("M7 提交后的文字用对象自己的颜色（红的还是红，不逐字变黑白）",
        /#EF4444/i.test(wrapped?.getAttribute("fill") || "") &&
        new Set(Array.from(wrapped?.querySelectorAll("tspan") ?? [])
            .map((t) => (t.getAttribute("fill") || "").toUpperCase())).size <= 1,
        `fill=${wrapped?.getAttribute("fill")}`);

    // 3) 把文字往右拖：可用宽度变小，行数变多；拖回左边又恢复
    click('button[data-tool="select"]');
    // 每次重新查询：渲染会重建 DOM，缓存下来的元素已经脱离文档，事件就冒不上去
    const hitOfText = () => texts()[0]?.closest("g")?.querySelector('[data-role="hit"]');
    const before = lineCount(wrapped);
    ptr("pointerdown", {x: 110, y: 430}, hitOfText());
    ptr("pointermove", {x: 500, y: 430});
    ptr("pointerup", {x: 910, y: 430});
    const afterRight = lineCount(texts()[0]);
    check("M7 文字拖到右边后行数变多（被画布边缘挤压）", afterRight > before,
        `${before} → ${afterRight} x=${Math.round(Number(texts()[0]?.getAttribute("x")))}`);
    ptr("pointerdown", {x: 910, y: 430}, hitOfText());
    ptr("pointermove", {x: 500, y: 430});
    ptr("pointerup", {x: 100, y: 430});
    const backLeft = lineCount(texts()[0]);
    check("M7 拖回左边后行数恢复", backLeft === before, `${afterRight} → ${backLeft}`);

    // 4) 文字不会被拖出画布左右边界
    ptr("pointerdown", {x: 110, y: 430}, hitOfText());
    ptr("pointermove", {x: 900, y: 430});
    ptr("pointerup", {x: 2000, y: 430});
    const clampedX = Number(texts()[0]?.getAttribute("x"));
    check("M7 文字被挡在画布右边界内", clampedX <= 1200 - 28, String(clampedX));

    click('[data-action="close"]');
    await tick();
}

// ---------------------------------------------------------------- v0.10.0 移动端：顶部导航 + 上下双栏 + 触摸手势
// ---------------------------------------------------------------- Mac 撤销不吃底图（1.4.0-alpha.62）
if (process.argv[3] === "--macundo") {
    Object.defineProperty(globalThis, "localStorage", {value: win.localStorage, configurable: true});
    const q = (s) => win.document.querySelector(s);
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    const d = makeDetail();
    listeners.get("open-menu-image")?.({detail: d.detail});
    d.getItem()?.click();
    await new Promise((r) => setTimeout(r, 120));
    const baseEl = () => q(".annot-base");
    const srcBefore = baseEl()?.getAttribute("src") || "";
    check("1.4.0-alpha.62 打开编辑器后底图存在", !!baseEl() && !!srcBefore, srcBefore.slice(0, 30));
    check("1.4.0-alpha.67 刚打开时撤销按钮是禁用状态",
        q('[data-action="undo"]')?.disabled === true, String(q('[data-action="undo"]')?.disabled));
    const objects = () => win.document.querySelectorAll("g.annot-object").length;
    click('button[data-tool="rect"]');
    const svgEl = q('[data-role="svg"]');
    const toClient = (x, y) => {
        const layer = q('[data-role="transform"]');
        const r = layer?.getBoundingClientRect?.() ?? {left: 0, top: 0};
        return {clientX: r.left + x, clientY: r.top + y};
    };
    const a = toClient(200, 200); const b = toClient(360, 320);
    svgEl?.dispatchEvent(new win.MouseEvent("pointerdown", {bubbles: true, cancelable: true, button: 0, ...a}));
    svgEl?.dispatchEvent(new win.MouseEvent("pointermove", {bubbles: true, cancelable: true, button: 0,
        clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2}));
    svgEl?.dispatchEvent(new win.MouseEvent("pointerup", {bubbles: true, cancelable: true, button: 0, ...b}));
    const afterDraw = objects();
    const cmdZ = new win.KeyboardEvent("keydown", {key: "z", metaKey: true, bubbles: true, cancelable: true});
    win.document.body.dispatchEvent(cmdZ);
    check("1.4.0-alpha.62 Mac 的 Command+Z 被插件吃掉（defaultPrevented）", cmdZ.defaultPrevented === true);
    check("1.4.0-alpha.67 撤销到底后按钮立刻变灰",
        q('[data-action="undo"]')?.disabled === true, String(q('[data-action="undo"]')?.disabled));
    // 空栈时再按一次：图必须还在
    const emptyZ = new win.KeyboardEvent("keydown", {key: "z", metaKey: true, bubbles: true, cancelable: true});
    win.document.body.dispatchEvent(emptyZ);
    check("1.4.0-alpha.67 空栈再按撤销：事件被吃掉且底图仍在",
        emptyZ.defaultPrevented === true &&
        !!baseEl() && (baseEl()?.getAttribute("src") || "") === srcBefore);
    check("1.4.0-alpha.62 撤销后底图仍在且地址不变",
        !!baseEl() && (baseEl()?.getAttribute("src") || "") === srcBefore,
        `对象 ${afterDraw} -> ${objects()}`);
    click('[data-action="close"]');
    await new Promise((r) => setTimeout(r, 60));
}

if (process.argv[3] === "--m8") {
    Object.defineProperty(globalThis, "localStorage", {value: win.localStorage, configurable: true});
    // 窄屏 + 触摸：让编辑器按移动端布局构建
    Object.defineProperty(win, "innerWidth", {value: 390, configurable: true, writable: true});
    Object.defineProperty(win, "innerHeight", {value: 844, configurable: true, writable: true});
    const q = (s) => win.document.querySelector(s);
    const all = (s) => Array.from(win.document.querySelectorAll(s));
    const click = (s) => q(s)?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    let svg = null;
    // 触摸事件：jsdom 没有 PointerEvent，用 Event 附加所需字段（代码只读这些字段）
    const touch = (type, x, y, id) => {
        const e = new win.Event(type, {bubbles: true, cancelable: true});
        Object.assign(e, {clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0});
        return e;
    };
    const toClient = (x, y) => {
        const r = readViewport();
        return {x: r.panX + x * r.zoom, y: r.panY + y * r.zoom};
    };
    const tapAt = (x, y) => {
        const c = toClient(x, y);
        svg.dispatchEvent(touch("pointerdown", c.x, c.y, 1));
        svg.dispatchEvent(touch("pointerup", c.x, c.y, 1));
    };
    const layer = () => win.document.querySelector('[data-layer="objects"]');
    // 上栏：每次都重新查询，render 会重建它
    const styleHost = () => q('[data-role="mobile-style"]');
    const styleGroups = () => Array.from(styleHost()?.querySelectorAll("[data-group]") ?? [])
        .map((el) => el.getAttribute("data-group"));
    const styleText = () => styleHost()?.textContent || "";

    // 键盘：jsdom 没有 visualViewport，这里造一个可手动改高度的替身，
    // 用来验证「弹键盘 → 收起底部三栏 → 收键盘 → 还原」这条路
    let vvHeight = 844;
    const vvListeners = {resize: [], scroll: []};
    Object.defineProperty(win, "visualViewport", {
        configurable: true,
        value: {
            get height() { return vvHeight; },
            get width() { return 390; },
            addEventListener: (type, fn) => {
                if (!vvListeners[type]) vvListeners[type] = [];
                vvListeners[type].push(fn);
            },
            removeEventListener: () => {},
        },
    });
    const setViewportHeight = (h) => {
        vvHeight = h;
        for (const fn of vvListeners.resize || []) fn();
    };

    const d = makeDetail();
    listeners.get("open-menu-image")?.({detail: d.detail});
    d.getItem()?.click();
    await tick();
    await tick();
    svg = win.document.querySelector('[data-role="svg"]');

    // 空画布时点「对象」也必须能滑出抽屉（v0.25.1：不再要求先选中对象）
    click('.annot-fab-pill[data-action="mobile-props"]');
    await tick();
    check("M8 空画布点了「对象」也能滑出抽屉，里面显示空态",
        q('[data-role="sidebar"]')?.classList.contains("is-open") &&
        !!q(".annot-empty") && (q(".annot-empty")?.textContent || "").includes("还没有"),
        String(q(".annot-empty")?.textContent));
    click('.annot-fab-pill[data-action="mobile-props"]');
    await tick();
    check("M8 再点一次「对象」收起抽屉，胶囊同步复位",
        !q('[data-role="sidebar"]')?.classList.contains("is-open") &&
        !q('[data-action="mobile-props"]')?.classList.contains("is-open"));

    check("M8 窄屏打开时使用移动端布局", !!q(".annot-root--mobile"));
    check("M8 顶部是极简导航（关闭 / 撤销 / 重做 / 完成），不再放品牌名",
        !!q(".annot-mobile-top [data-action=\"close\"]") &&
        all(".annot-mobile-top [data-action=\"undo\"]").length === 1 &&
        all(".annot-mobile-top [data-action=\"redo\"]").length === 1 &&
        !!q(".annot-mobile-top [data-action=\"save\"]") &&
        !q(".annot-mobile-top__title"));
    const railTools = all(".annot-mobile-rail button[data-tool]");
    const railOps = all(".annot-mobile-rail button[data-canvas-op]");
    check("M8 下栏含 12 个绘图工具与 6 个图像操作（选择已独立成圆钮）",
        railTools.length === 12 && railOps.length === 6 &&
        !railTools.some((b) => b.getAttribute("data-tool") === "select"),
        `工具 ${railTools.length} / 图像 ${railOps.length}`);
    check("M8 下栏每个按钮都有文字标签（不靠猜图标）",
        railTools.every((b) => (b.querySelector(".annot-mobile-tool__label")?.textContent || "").length >= 2) &&
        railOps.every((b) => (b.querySelector(".annot-mobile-tool__label")?.textContent || "").length >= 2),
        railTools.map((b) => b.querySelector(".annot-mobile-tool__label")?.textContent).join("/"));
    check("M8 两颗独立圆钮：左「选择」右「对齐」，且没有平移按钮",
        all('[data-role="mobile-fabs"] .annot-fab').length === 2 &&
        !!q('[data-action="mobile-select"]') && !!q('.annot-fab--align[data-action="align-mode"]') &&
        !q('[data-role="mobile-rail"] [data-tool="pan"]') &&
        !q('[data-role="mobile-rail"] [data-tool="select"]') &&
        !q('[data-action="mobile-pan"]'),
        `圆钮 ${all('[data-role="mobile-fabs"] .annot-fab').length} 个`);
    // 线性图标：外层声明 fill=none + stroke=currentColor；实心图标（模糊）内部 path 自己带 fill
    const iconNodes = all(".annot-mobile-tool__icon > svg");
    const badIcons = iconNodes.filter((el) => {
        if (!el.classList.contains("annot-icon")) return true;
        const linear = el.getAttribute("fill") === "none" && el.getAttribute("stroke") === "currentColor";
        const solid = !!el.querySelector('[fill="currentColor"]');
        return !linear && !solid;
    }).map((el) => el.getAttribute("class") || "no-class");
    check("M8 下栏图标带 annot-icon 类且不会被思源全局样式填实（18 个）",
        iconNodes.length === 18 && badIcons.length === 0 &&
        !!q('[data-action="mobile-select"] svg.annot-icon'),
        `${iconNodes.length} 个，异常 ${badIcons.join(" / ")}`);
    check("M8 顶部保存按钮用短文案「完成」",
        (q('.annot-mobile-top [data-action="save"]')?.textContent || "").trim() === "保存",
        String(q('.annot-mobile-top [data-action="save"]')?.textContent));
    const dialogEl = q(".annot-dialog");
    const dialogHeight = dialogEl?.style.height || "";
    check("M8 移动端对话框按整屏尺寸打开、四角强制为直角",
        dialogEl?.style.width === "100vw" && (dialogHeight === "100dvh" || dialogHeight === "100vh") &&
        dialogEl?.style.borderRadius === "0px" &&
        q(".b3-dialog")?.style.padding === "0px" &&
        !!q(".b3-dialog.annot-dialog-fullscreen"),
        `${dialogEl?.style.width} × ${dialogHeight}，圆角 ${dialogEl?.style.borderRadius}，外壳 padding ${q(".b3-dialog")?.style.padding}`);
    check("M8 上下两栏同时存在，上栏有独立滚动区（两栏都能横向滑）",
        !!q(".annot-mobile-style .annot-mobile-style__scroll") &&
        !!q(".annot-mobile-rail .annot-mobile-rail__scroll"),
        String(q(".annot-mobile-style__scroll")?.className));
    check("M8 手机上不再有左侧竖栏与底栏状态条（改由 CSS 隐藏）",
        !!q(".annot-imagebar") && !!q(".annot-status") && !!q(".annot-root--mobile"),
        "结构与 PC 一致，靠 .annot-root--mobile 规则隐藏");

    // 1) 上栏跟着工具变：选择（无选中）＝颜色 + 粗细
    check("M8 打开时上栏显示颜色 / 粗细 / 线型",
        styleGroups().join(",") === "colors,widths,lines", styleGroups().join(","));
    check("M8 选择工具下没有字号 / 填充",
        !styleText().includes("字号") && !styleText().includes("填充"), styleText().slice(0, 40));

    // 切到文字：颜色 + 字号，不再有粗细
    click('.annot-mobile-rail button[data-tool="text"]');
    check("M8 切到文字工具后，第二行只留颜色 + 字号（字体已搬去顶栏）",
        styleGroups().join(",") === "colors,fonts" &&
        styleText().includes("字号") && !styleText().includes("粗细"),
        `${styleGroups().join(",")} / ${styleText().slice(0, 24)}`);
    {
        const t1 = q('[data-role="mobile-topbar"] button[data-action="font-pop"]');
        check("M8 文字工具的字体入口在顶部悬浮栏", !!t1, t1 ? t1.textContent.trim() : "没找到");
        t1?.click();
        await tick();
        const pop = q('[data-role="font-pop"]');
        check("M8 点顶栏字体按钮能真的弹出面板，顶部是上传入口",
            !!pop && pop.firstElementChild?.getAttribute("data-action") === "font-upload" &&
            !!q('[data-role="mobile-font-host"]'),
            pop ? `面板首项=${pop.firstElementChild?.getAttribute("data-action")}` : "面板没出现");
        q('[data-role="mobile-topbar"] button[data-action="font-pop"]')?.click();
        await tick();
        check("M8 再点一下字体按钮收起面板", !q('[data-role="font-pop"]'));
    }

    // 切到矩形：颜色 + 粗细 + 填充 + 圆角（圆角与 ShareX 一样只给矩形）
    click('.annot-mobile-rail button[data-tool="rect"]');
    check("M8 切到矩形工具后，上栏多出线型 / 填充 / 圆角",
        styleGroups().join(",") === "colors,widths,lines,fills,corners" &&
        styleText().includes("线型") && styleText().includes("填充") && styleText().includes("圆角"),
        styleGroups().join(","));
    const cornerChips = () => all('[data-preset="cornerRadius"]');
    check("M8 矩形上栏给了直角 / 4 / 8 / 16 / 24 五档圆角",
        cornerChips().length === 5 && cornerChips()[0].textContent.trim() === "直角",
        cornerChips().map((b) => b.textContent.trim()).join(","));
    cornerChips()[2]?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    await tick();
    check("M8 点圆角档位后该档立刻高亮",
        cornerChips()[2]?.classList.contains("is-active") &&
        !cornerChips()[0]?.classList.contains("is-active"),
        `active=${cornerChips().findIndex((b) => b.classList.contains("is-active"))}`);



    // 切到马赛克：上栏给出「块大小」紧凑滑块（v1.1.0-alpha.3）
    click('.annot-mobile-rail button[data-tool="mosaic"]');
    const mosaicRange = () => q('[data-role="mobile-style"] input[data-ctx="blockSize"]');
    check("M8 切到马赛克后，上栏出现「块大小」滑块",
        styleGroups().join(",") === "blockSize" && !!mosaicRange() &&
        !!q('[data-role="mobile-style"] [data-role="m-blockSize"]'),
        `${styleGroups().join(",")} / ${styleText().slice(0, 24)}`);
    check("M8 手机端马赛克顶栏有「识别」开关",
        !!q('[data-role="mobile-topbar"] [data-action="smart-select"]'),
        String(!!q('[data-role="mobile-topbar"] [data-action="smart-select"]')));
    check("M8 独一根滑块撑满整行，右侧不留空",
        q('[data-role="mobile-style"]')?.classList.contains("annot-mobile-style__scroll--fill"),
        String(q('[data-role="mobile-style"]')?.className));
    if (mosaicRange()) {
        mosaicRange().value = "30";
        mosaicRange().dispatchEvent(new win.Event("input", {bubbles: true, cancelable: true}));
        mosaicRange().dispatchEvent(new win.Event("change", {bubbles: true, cancelable: true}));
        check("M8 手机上拖动块大小，右侧读数同步为 30",
            q('[data-role="m-blockSize"]')?.textContent === "30",
            String(q('[data-role="m-blockSize"]')?.textContent));
    }
    click('.annot-mobile-rail button[data-tool="blur"]');
    check("M8 切到模糊后，上栏出现「模糊程度」滑块",
        styleGroups().join(",") === "blurRadius" &&
        !!q('[data-role="mobile-style"] input[data-ctx="blurRadius"]'),
        styleGroups().join(","));
    click('.annot-mobile-rail button[data-tool="spotlight"]');
    const spotRange = () => q('[data-role="mobile-style"] input[data-ctx="spotlightOpacity"]');
    check("M8 切到聚光灯后，上栏出现「暗度」滑块",
        styleGroups().join(",") === "spotlightOpacity" && !!spotRange() &&
        !!q('[data-role="mobile-style"] [data-role="m-spotlightOpacity"]'),
        `${styleGroups().join(",")} / ${q('[data-role="m-spotlightOpacity"]')?.textContent ?? ""}`);
    if (spotRange()) {
        spotRange().value = "40";
        spotRange().dispatchEvent(new win.Event("input", {bubbles: true, cancelable: true}));
        spotRange().dispatchEvent(new win.Event("change", {bubbles: true, cancelable: true}));
        check("M8 聚光灯暗度调到 40%，右侧读数带百分号",
            q('[data-role="m-spotlightOpacity"]')?.textContent === "40%",
            String(q('[data-role="m-spotlightOpacity"]')?.textContent));
    }

    // 2) 点颜色：真正改到当前样式，并重新高亮
    click('.annot-mobile-rail button[data-tool="arrow"]');
    const swatches = () => all('[data-role="mobile-style"] button[data-preset="color"]');
    check("M8 上栏色点数量来自预设（默认 5 个 + 自定义）",
        swatches().length === 5 && !!q(".annot-mobile-swatch--custom"),
        String(swatches().length));
    swatches()[1]?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    await tick();
    check("M8 点第二个色点后它变成高亮、第一个取消",
        swatches()[1]?.classList.contains("is-active") && !swatches()[0]?.classList.contains("is-active"),
        `active=${swatches().findIndex((b) => b.classList.contains("is-active"))}`);

    // 2b) 对齐圆钮：触屏下点对象即可多选，上栏变成对齐条
    {
        // 先画两个对象（矩形 + 椭圆），保证有多选目标
        click('button[data-tool="rect"]');
        svg.dispatchEvent(touch("pointerdown", toClient(120, 120).x, toClient(120, 120).y, 51));
        svg.dispatchEvent(touch("pointermove", toClient(300, 240).x, toClient(300, 240).y, 51));
        svg.dispatchEvent(touch("pointerup", toClient(300, 240).x, toClient(300, 240).y, 51));
        click('button[data-tool="ellipse"]');
        svg.dispatchEvent(touch("pointerdown", toClient(360, 120).x, toClient(360, 120).y, 52));
        svg.dispatchEvent(touch("pointermove", toClient(560, 260).x, toClient(560, 260).y, 52));
        svg.dispatchEvent(touch("pointerup", toClient(560, 260).x, toClient(560, 260).y, 52));
        await tick();
        click('[data-action="mobile-select"]');
        await tick();
        // 点一下画布空白：把「刚画完默认选中」清掉，后面两次点选才是干净的 0 → 1 → 2
        svg.dispatchEvent(touch("pointerdown", toClient(900, 700).x, toClient(900, 700).y, 55));
        svg.dispatchEvent(touch("pointerup", toClient(900, 700).x, toClient(900, 700).y, 55));
        await tick();
        check("M8 左下圆钮＝选择：点一下就回到单选模式",
            q('[data-action="mobile-select"]')?.classList.contains("is-active") &&
            q('.annot-fab--align')?.classList.contains("is-active") === false);
        click('[data-action="align-mode"]');
        await tick();
        check("M8 点右下圆钮进入多选，圆钮变主色高亮",
            q('.annot-fab--align')?.classList.contains("is-active") &&
            q('.annot-fab--align')?.getAttribute("aria-pressed") === "true");
        const hits = () => Array.from(layer()?.querySelectorAll('g.annot-object [data-role="hit"]') ?? []);
        // 用列表行点选（同样是「点一下切换」，但不会往画布塞合成手指事件）
        const rows = () => Array.from(win.document.querySelectorAll('[data-role="object-item"]'));
        rows()[0]?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true}));
        await tick();
        rows()[1]?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true, ctrlKey: true}));
        await tick();
        const selectedNow = layer()?.querySelectorAll("g.annot-object.is-selected").length ?? 0;
        check("M8 对齐模式下点两个对象都被选中（手机不用 Ctrl）",
            selectedNow === 2, String(selectedNow));
        check("M8 选中两个后上栏换成对齐条：已选 2 个 + 8 颗按钮",
            (q('[data-role="mobile-style"] .annot-mobile-style__count')?.textContent || "").includes("2") &&
            all('[data-role="mobile-style"] [data-action="align-op"]').length === 8 &&
            !!q('[data-role="align-count"]') && q('[data-role="align-count"]')?.hidden === false,
            String(all('[data-role="mobile-style"] [data-action="align-op"]').length));
        click('[data-role="mobile-style"] [data-action="align-op"][data-value="left"]');
        await tick();
        check("M8 点对齐条里的「左对齐」能执行（两个对象左边缘对齐）",
            layer()?.querySelectorAll("g.annot-object.is-selected").length === 2 &&
            (() => {
                const xs = Array.from(layer()?.querySelectorAll("rect.annot-shape, ellipse.annot-shape") ?? [])
                    .map((el) => el.tagName === "rect"
                        ? Number(el.getAttribute("x"))
                        : Number(el.getAttribute("cx")) - Number(el.getAttribute("rx")));
                return Math.abs(xs[0] - xs[1]) < 0.5;
            })(),
            "left aligned");
        click('[data-action="align-mode"]');
        await tick();
        check("M8 再点一次右下圆钮退出多选，上栏恢复参数",
            q('.annot-fab--align')?.classList.contains("is-active") === false &&
            all('[data-role="mobile-style"] [data-action="align-op"]').length === 0);
        click('[data-action="mobile-select"]');
        await tick();
        // 清场：把这两块临时对象删掉，免得影响后面的用例
        for (let i = 0; i < 2; i++) {
            Array.from(win.document.querySelectorAll('[data-role="object-item"]'))[0]
                ?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
            await tick();
            win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", {
                key: "Delete", bubbles: true, cancelable: true}));
            await tick();
        }
        check("M8 临时对象已清理（对齐用例不污染后续）",
            (layer()?.querySelectorAll("g.annot-object").length ?? 0) === 0,
            String(layer()?.querySelectorAll("g.annot-object").length));
        // 把工具交回「箭头」，后面的用例从这里继续
        click('button[data-tool="arrow"]');
        await tick();
    }

    // 3) 单指画箭头
    const start = toClient(200, 200);
    const end = toClient(420, 320);
    svg.dispatchEvent(touch("pointerdown", start.x, start.y, 2));
    svg.dispatchEvent(touch("pointermove", (start.x + end.x) / 2, (start.y + end.y) / 2, 2));
    svg.dispatchEvent(touch("pointerup", end.x, end.y, 2));
    check("M8 单指可以画出箭头", layer()?.querySelectorAll(".annot-shape").length >= 1,
        String(layer()?.querySelectorAll(".annot-shape").length));

    // 3b) 触摸容错：手指抖几像素不该把对象拖走；手柄命中区要放大
    {
        // 先切回选择工具：否则在箭头工具下按到对象会开一条新线，而不是拖动已画的
        click('[data-action="mobile-select"]');
        const arrowPath = () => layer()?.querySelector("g.annot-object .annot-shape")?.getAttribute("d") || "";
        const before = arrowPath();
        const hitOfArrow = () => layer()?.querySelector('g.annot-object [data-role="hit"]');
        const zoom = readViewport().zoom;
        const start = toClient(300, 250);
        // 按下 → 抖 6 屏幕像素 → 松手：应视为「点一下」，对象一动不动
        hitOfArrow()?.dispatchEvent(touch("pointerdown", start.x, start.y, 31));
        hitOfArrow()?.dispatchEvent(touch("pointermove", start.x + 6, start.y + 2, 31));
        hitOfArrow()?.dispatchEvent(touch("pointerup", start.x + 6, start.y + 2, 31));
        check("M8 手指轻抖不会被当成拖动（对象没有位移）",
            arrowPath() === before, `${before.slice(0, 24)} vs ${arrowPath().slice(0, 24)}`);
        // 超过阈值才真的移动
        hitOfArrow()?.dispatchEvent(touch("pointerdown", start.x + 6, start.y + 2, 32));
        hitOfArrow()?.dispatchEvent(touch("pointermove", start.x + 40, start.y + 30, 32));
        hitOfArrow()?.dispatchEvent(touch("pointerup", start.x + 40, start.y + 30, 32));
        check("M8 移动超过阈值后对象才跟随手指",
            arrowPath() !== before && arrowPath().length > 0,
            `before=${before.slice(0, 40)} after=${arrowPath().slice(0, 40)}`);
        // 手柄命中圆：移动端放大到屏幕 30px（可见圆点 8px）
        const endCircles = all('[data-role="handles"] g[data-handle="end"] circle');
        const hitRadius = Number(endCircles[0]?.getAttribute("r") || 0) * zoom;
        const dotRadius = Number(endCircles[1]?.getAttribute("r") || 0) * zoom;
        check("M8 移动端手柄：视觉 4.2px 半径（与文本档一致），命中半径 23px（直径 46，好点）",
            Math.abs(hitRadius - 23) < 0.8 && Math.abs(dotRadius - 4.2) < 0.8,
            `命中 ${hitRadius.toFixed(1)}px / 圆点 ${dotRadius.toFixed(1)}px`);
    }

    // 4) 选中对象：常用参数在上栏，抽屉不自动弹；点「属性」才展开
    click('.annot-mobile-rail button[data-tool="select"]');
    {
        const hit = layer()?.querySelector('g.annot-object [data-role="hit"]');
        const c = toClient(300, 250);
        hit?.dispatchEvent(touch("pointerdown", c.x, c.y, 1));
        hit?.dispatchEvent(touch("pointerup", c.x, c.y, 1));
    }
    check("M8 选中对象后属性抽屉不自动弹出（不挡画布）",
        !q('[data-role="sidebar"]')?.classList.contains("is-open"),
        String(q('[data-role="sidebar"]')?.className));
    check("M8 选中后上栏出现固定的「属性」按钮",
        q('[data-action="mobile-props"]')?.hidden === false);
    click('[data-action="mobile-props"]');
    check("M8 点「对象」后完整属性抽屉展开",
        q('[data-role="sidebar"]')?.classList.contains("is-open") &&
        q('[data-action="mobile-props"]')?.classList.contains("is-open"),
        String(q('[data-role="sidebar"]')?.className));
    check("M8 抽屉顶部有抓手横条（唯一的「往下拖」关闭入口）",
        !!q('[data-role="mobile-grab"]') && !!q('[data-role="mobile-grab"] span'));
    {
        const grabEl = q('[data-role="mobile-grab"]');
        const sheetEl = q('[data-role="sidebar"]');
        grabEl.dispatchEvent(touch("pointerdown", 195, 600, 91));
        grabEl.dispatchEvent(touch("pointermove", 195, 660, 91));
        check("M8 拽抓手时面板跟手（加 is-dragging、写 inline transform）",
            sheetEl.classList.contains("is-dragging") &&
            /translateY\(60px\)/.test(sheetEl.style.transform || ""),
            sheetEl.className + " || " + (sheetEl.style.transform || "(empty)"));
        grabEl.dispatchEvent(touch("pointerup", 195, 660, 91));
        await tick();
        check("M8 拖过阈值松手后抽屉关闭，底部胶囊同步复位",
            !q('[data-role="sidebar"]')?.classList.contains("is-open") &&
            !q('[data-action="mobile-props"]')?.classList.contains("is-open"));
    }
    tapAt(900, 700);
    check("M8 点画布空白后抽屉收起、对象胶囊恢复常态",
        !q('[data-role="sidebar"]')?.classList.contains("is-open") &&
        !q('[data-action="mobile-props"]')?.classList.contains("is-open"));
    // 4.65) 有对象但没选中时，点「对象」同样要能打开（v0.25.1）
    {
        const beforeOpen = q('[data-role="sidebar"]')?.classList.contains("is-open");
        click('.annot-fab-pill[data-action="mobile-props"]');
        await tick();
        check("M8 没选中任何对象时点「对象」也能滑出抽屉",
            !beforeOpen && q('[data-role="sidebar"]')?.classList.contains("is-open"),
            String(beforeOpen));
        tapAt(900, 700);
        await tick();
        check("M8 点画布空白收起抽屉（空选状态下同样有效）",
            !q('[data-role="sidebar"]')?.classList.contains("is-open"));
    }

    // 4.7) 双指手势闸门（v0.25.0）：屏幕上 2 根以上手指时，任何绘制入口都必须失效
    {
        const stageEl = q('.annot-stage');
        const svgEl = q('[data-role="svg"]');
        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        const finger = (type, count) => {
            const e = new win.Event(type, {bubbles: true, cancelable: true});
            Object.assign(e, {
                touches: Array.from({length: count}, (_, i) => ({clientX: 100 + i * 90, clientY: 400})),
                targetTouches: [], changedTouches: [],
            });
            return e;
        };
        const pointer = (type, x, y, id) => {
            // MouseEvent 的 button 是只读 getter，用裸 Event 再挂字段，避免 assign 报错
            const e = new win.Event(type, {bubbles: true, cancelable: true});
            Object.assign(e, {pointerId: id, pointerType: "touch", button: 0, buttons: 1,
                clientX: x, clientY: y});
            return e;
        };
        const countObjects = () => all('[data-layer="objects"] g.annot-object').length;

        const empty = countObjects();
        // 真机上 pointer 先于 touch：两指依次落下
        svgEl.dispatchEvent(pointer("pointerdown", 110, 400, 81));
        stageEl.dispatchEvent(finger("touchstart", 1));
        svgEl.dispatchEvent(pointer("pointerdown", 280, 400, 82));
        stageEl.dispatchEvent(finger("touchstart", 2));
        svgEl.dispatchEvent(pointer("pointerdown", 200, 400, 71));
        svgEl.dispatchEvent(pointer("pointermove", 260, 460, 71));
        svgEl.dispatchEvent(pointer("pointerup", 260, 460, 71));
        check("M8 双指在屏时，pointer 事件也画不出东西",
            countObjects() === empty, `${empty} → ${countObjects()}`);

        // 手指全部抬起 → 应当解锁，并且把漏掉的 pointer 计数一并清空
        svgEl.dispatchEvent(pointer("pointerup", 110, 400, 81));
        svgEl.dispatchEvent(pointer("pointerup", 280, 400, 82));
        stageEl.dispatchEvent(finger("touchend", 0));

        // 解锁后单指必须还能画：闸门不能「锁死不还」
        svgEl.dispatchEvent(pointer("pointerdown", 120, 360, 72));
        svgEl.dispatchEvent(pointer("pointermove", 200, 420, 72));
        svgEl.dispatchEvent(pointer("pointerup", 200, 420, 72));
        check("M8 解锁后单指仍然能正常画",
            countObjects() === empty + 1, `${empty} → ${countObjects()}`);
    }

    check("M8 顶栏两颗胶囊：缩放与对象同样式、同一个 pair 容器、都写中文不写图标",
        (() => {
            const pills = all(".annot-fab-pill");
            if (pills.length !== 2) return false;
            return pills.every((el) => el.closest(".annot-fab__pair") !== null)
                && pills[0].textContent.includes("缩放") && pills[0].textContent.includes("%")
                && pills[1].textContent.includes("对象")
                && pills.every((el) => el.querySelector("svg") === null);
        })(), all(".annot-fab-pill").map((el) => el.textContent.trim()).join(" / "));

    // 4.8) 类 Shift 约束手势（v0.26.0）：一指按住不动 + 另一指滑动
    {
        const stageEl2 = q(".annot-stage");
        const svgEl2 = q('[data-role="svg"]');
        const pe = (type, x, y, id) => {
            const e = new win.Event(type, {bubbles: true, cancelable: true});
            Object.assign(e, {pointerId: id, pointerType: "touch", button: 0, buttons: 1,
                clientX: x, clientY: y});
            return e;
        };
        const countObjects = () => all('[data-layer="objects"] g.annot-object').length;
        const lastRect = () => {
            const shapes = all('[data-layer="objects"] g.annot-object rect');
            return shapes[shapes.length - 1] || null;
        };
        const ratio = () => {
            const el = lastRect();
            if (!el) return null;
            const w = Number(el.getAttribute("width"));
            const h = Number(el.getAttribute("height"));
            return {w, h};
        };

        // (a) 一指按住 + 另一指 drag → 正方形
        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        const baseCount = countObjects();
        svgEl2.dispatchEvent(pe("pointerdown", 110, 400, 91));
        svgEl2.dispatchEvent(pe("pointerdown", 300, 300, 92));
        svgEl2.dispatchEvent(pe("pointermove", 380, 380, 92));   // 这一下判定为「一指按住 + 一指动」
        svgEl2.dispatchEvent(pe("pointermove", 460, 430, 92));   // 真正拖出形状
        svgEl2.dispatchEvent(pe("pointerup", 460, 430, 92));
        svgEl2.dispatchEvent(pe("pointerup", 110, 400, 91));
        const sq = ratio();
        check("M8 一指按住 + 另一指滑动 → 画出的是正方形（宽高相等）",
            countObjects() === baseCount + 1 && !!sq && Math.abs(sq.w - sq.h) < 1.5,
            sq ? `${sq.w} × ${sq.h}` : "没有矩形");

        // (b) 两指都在动 → 只缩放、不落笔
        const beforePinchCount = countObjects();
        const beforeZoom = readViewport().zoom;
        svgEl2.dispatchEvent(pe("pointerdown", 120, 420, 93));
        svgEl2.dispatchEvent(pe("pointerdown", 300, 420, 94));
        for (const [x1, x2] of [[90, 330], [60, 360], [30, 390]]) {
            svgEl2.dispatchEvent(pe("pointermove", x1, 420, 93));
            svgEl2.dispatchEvent(pe("pointermove", x2, 420, 94));
        }
        svgEl2.dispatchEvent(pe("pointerup", 30, 420, 93));
        svgEl2.dispatchEvent(pe("pointerup", 390, 420, 94));
        check("M8 两指都在动 → 只放大画布，不落笔",
            countObjects() === beforePinchCount && readViewport().zoom > beforeZoom * 1.1,
            `对象 ${beforePinchCount}→${countObjects()}，zoom ${beforeZoom.toFixed(2)}→${readViewport().zoom.toFixed(2)}`);

        // (c) 约束中抬起「按住不动」那根 → 解除约束，这一笔继续但不再是 1:1
        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        const beforeRelease = countObjects();
        svgEl2.dispatchEvent(pe("pointerdown", 110, 500, 95));
        svgEl2.dispatchEvent(pe("pointerdown", 300, 400, 96));
        svgEl2.dispatchEvent(pe("pointermove", 360, 460, 96));
        svgEl2.dispatchEvent(pe("pointerup", 110, 500, 95));   // 抬起按住的那根
        svgEl2.dispatchEvent(pe("pointermove", 500, 430, 96)); // 继续自由拖
        svgEl2.dispatchEvent(pe("pointerup", 500, 430, 96));
        const freed = ratio();
        check("M8 抬起「按住」那根后约束解除：这一笔继续，但不强制 1:1",
            countObjects() === beforeRelease + 1 && !!freed && Math.abs(freed.w - freed.h) > 3,
            freed ? `${freed.w} × ${freed.h}` : "没有矩形");
    }

    // 4.9) 移动端手柄：同样带「移动」抓手（v0.26.1）
    check("M8 选中图形时有「移动」抓手，不用先切回选择工具",
        !!q('[data-role="handles"] [data-handle="move"]') ||
        !!all('[data-handle="move"]').length,
        String(all('[data-handle="move"]').length));

    // 5) 双指捏合缩放
    const beforeZoom = readViewport().zoom;
    const stageEl = q(".annot-stage");
    stageEl.dispatchEvent(touch("pointerdown", 120, 400, 11));
    stageEl.dispatchEvent(touch("pointerdown", 280, 400, 12));
    // 两指同时向外张：两指都在动 → 走画布缩放，不会进「类 Shift」约束
    for (const [x1, x2] of [[100, 300], [70, 330], [40, 360], [10, 390]]) {
        stageEl.dispatchEvent(touch("pointermove", x1, 400, 11));
        stageEl.dispatchEvent(touch("pointermove", x2, 400, 12));
    }
    const afterZoom = readViewport().zoom;
    check("M8 双指捏合会放大画布", afterZoom > beforeZoom * 1.2,
        `${beforeZoom.toFixed(2)} → ${afterZoom.toFixed(2)}`);
    stageEl.dispatchEvent(touch("pointerup", 60, 400, 11));
    stageEl.dispatchEvent(touch("pointerup", 340, 400, 12));
    check("M8 画布右下角的缩放胶囊跟着显示百分比",
        /^\d+%$/.test(q('[data-role="mobile-zoom"]')?.textContent || "") &&
        q('[data-role="mobile-zoom"]')?.textContent === `${Math.round(afterZoom * 100)}%`,
        String(q('[data-role="mobile-zoom"]')?.textContent));

    // 6) 双指平移（不改变缩放）
    const beforePan = readViewport();
    stageEl.dispatchEvent(touch("pointerdown", 140, 420, 21));
    stageEl.dispatchEvent(touch("pointerdown", 240, 420, 22));
    for (const [y1, y2] of [[440, 440], [460, 460], [480, 480]]) {
        stageEl.dispatchEvent(touch("pointermove", 140, y1, 21));
        stageEl.dispatchEvent(touch("pointermove", 240, y2, 22));
    }
    const afterPan = readViewport();
    check("M8 双指拖动会平移画布",
        Math.abs(afterPan.panY - beforePan.panY) > 20 && Math.abs(afterPan.zoom - beforePan.zoom) < 0.02,
        `panY ${beforePan.panY.toFixed(0)} → ${afterPan.panY.toFixed(0)}，zoom ${afterPan.zoom.toFixed(2)}`);
    stageEl.dispatchEvent(touch("pointerup", 190, 470, 21));
    stageEl.dispatchEvent(touch("pointerup", 290, 470, 22));

    // 7) 触摸进裁剪：上栏换成比例、裁剪面板以抽屉打开
    click('[data-canvas-op="crop"]');
    check("M8 触摸进入裁剪后，裁剪面板以抽屉打开",
        q('[data-role="crop-side"]')?.classList.contains("is-open"),
        String(q('[data-role="crop-side"]')?.className));
    check("M8 裁剪态上栏换成比例快选",
        styleGroups().includes("ratios") &&
        all('[data-role="mobile-style"] [data-action="crop-ratio"]').length === 11,
        `${styleGroups().join(",")} / ${all('[data-role="mobile-style"] [data-action="crop-ratio"]').length} 档`);
    click('[data-action="crop-cancel"]');
    check("M8 退出裁剪后上栏回到工具参数",
        !styleGroups().includes("ratios"), styleGroups().join(","));

    // 画线（移动端）：只提供拖拽，不提供点击折线；近水平线自动拉直
    check("M8 下栏有画线按钮且图标是原稿",
        !!q('.annot-mobile-rail button[data-tool="line"]') &&
        q('.annot-mobile-rail button[data-tool="line"] svg')?.getAttribute("viewBox") === "0 0 1706 1024");
    click('.annot-mobile-rail button[data-tool="line"]');
    check("M8 选中画线后上栏是颜色 + 粗细",
        styleGroups().includes("colors") && styleGroups().includes("widths"),
        styleGroups().join(","));
    const mobileObjects = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? -1;
    const lastD = () => {
        const groups = Array.from(layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []);
        return groups[groups.length - 1]?.querySelector("path.annot-shape")?.getAttribute("d") || "";
    };
    const swipeLine = (a, b) => {
        const c1 = toClient(a.x, a.y);
        const c2 = toClient(b.x, b.y);
        svg.dispatchEvent(touch("pointerdown", c1.x, c1.y, 1));
        svg.dispatchEvent(touch("pointermove", (c1.x + c2.x) / 2, (c1.y + c2.y) / 2, 1));
        svg.dispatchEvent(touch("pointermove", c2.x, c2.y, 1));
        svg.dispatchEvent(touch("pointerup", c2.x, c2.y, 1));
    };
    const beforeMobileLine = mobileObjects();
    tapAt(120, 300);
    check("M8 手机上轻点一下不会开始折线、也不产生对象",
        mobileObjects() === beforeMobileLine, `count=${mobileObjects()}`);
    swipeLine({x: 120, y: 360}, {x: 260, y: 440});
    check("M8 手指滑动能画出一条线",
        mobileObjects() === beforeMobileLine + 1 && /^M .* L /.test(lastD()),
        `count=${mobileObjects()} d=${lastD()}`);
    swipeLine({x: 320, y: 360}, {x: 460, y: 368});
    const flat = (lastD().match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    check("M8 接近水平的慢线被自动拉成完美水平",
        mobileObjects() === beforeMobileLine + 2 && flat.length >= 4 &&
        Math.abs(flat[3] - flat[1]) < 0.01,
        `d=${lastD()}`);

    check("移动端不显示 PC 的悬浮条 / 面板拉手，层级四按钮在抽屉里仍可用",
        css.includes(".annot-root--mobile .annot-context-bar") &&
        css.includes(".annot-root--mobile .annot-side-handle") &&
        css.includes('.annot-root--mobile .annot-side-section[data-section="layers"]') &&
        !/\.annot-root--mobile \.annot-side-section\[data-section="layers"\][^{]*\{[^}]*display: none/.test(css) &&
        q('[data-role="context-bar"]')?.hidden === true &&
        win.document.querySelectorAll('[data-role="layers"] button').length === 4,
        `悬浮条 hidden=${q('[data-role="context-bar"]')?.hidden}`);
    check("移动端仍保留上下双栏与原有工具栏结构",
        !!q(".annot-mobile-style") && !!q(".annot-mobile-rail") &&
        !!q(".annot-imagebar") && !!q(".annot-status") &&
        q(".annot-root")?.classList.contains("annot-root--mobile") === true);

    // 序号：手机上也能换编号格式与引线端点（不然默认被改成罗马数字就回不去了）
    click('.annot-mobile-rail button[data-tool="number"]');
    await tick();
    check("M8 切到序号后，第二行不再有编号 / 端点（已搬去顶栏）",
        styleGroups().join(",") === "colors,fonts" &&
        !styleText().includes("编号") && !styleText().includes("端点"),
        `${styleGroups().join(",")} / ${styleText().slice(0, 30)}`);
    const topBtns = () => all('[data-role="mobile-topbar"] .annot-mobile-topbar__btn');
    check("M8 序号顶栏第一个按钮就是样式切换",
        topBtns()[0]?.getAttribute("data-pop") === "numberBubble",
        topBtns().map((b) => b.getAttribute("data-action") ?? b.getAttribute("data-pop")).join(","));
    click('[data-role="mobile-topbar"] button[data-pop="numberFormat"]');
    await tick();
    const formatChips = () => all('[data-role="mobile-pop"] [data-action="number-format-pick"]');
    check("M8 顶栏「编号」气泡给 5 种格式", formatChips().length === 5, String(formatChips().length));
    click('[data-role="mobile-pop"] [data-action="number-format-pick"][data-value="roman"]');
    await tick();
    tapAt(300, 300);
    await tick();
    const lastNumberText = () => {
        const groups = Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? [])
            .filter((g) => g.querySelector("circle") && g.querySelector("text.annot-shape"));
        return groups[groups.length - 1]?.querySelector("text.annot-shape")?.textContent || "";
    };
    check("M8 选罗马数字后放的序号是罗马数字", /^[IVX]+$/.test(lastNumberText()), lastNumberText());
    const dragAt = (x1, y1, x2, y2) => {
        const a = toClient(x1, y1);
        const b = toClient(x2, y2);
        svg.dispatchEvent(touch("pointerdown", a.x, a.y, 1));
        svg.dispatchEvent(touch("pointermove", b.x, b.y, 1));
        svg.dispatchEvent(touch("pointerup", b.x, b.y, 1));
    };
    click('[data-role="mobile-topbar"] button[data-pop="numberArrowStyle"]');
    await tick();
    const tipChips = () => all('[data-role="mobile-pop"] [data-action="number-style-pick"]');
    check("M8 序号的端点样式 5 项，与箭头工具同一套",
        tipChips().length === 5 &&
        tipChips().map((b) => b.getAttribute("data-value")).join(",") === "basic,classic,open,rhombus,circle",
        String(tipChips().length));
    const lastNumberGroup = () => {
        const groups = Array.from(layer()?.querySelectorAll("g[data-object-id]") ?? [])
            .filter((g) => g.querySelector("circle") && g.querySelector("text.annot-shape"));
        return groups[groups.length - 1];
    };
    click('[data-role="mobile-pop"] [data-action="number-style-pick"][data-value="rhombus"]');
    await tick();
    dragAt(360, 420, 460, 470);
    await tick();
    check("M8 端点选菱形后，这一支引线画出箭头头部",
        (lastNumberGroup()?.querySelectorAll("path.annot-head").length ?? 0) === 1,
        `${lastNumberGroup()?.querySelectorAll("path.annot-head").length ?? 0} 个头`);

    // 顶栏「样式」：四选一，选完按钮标签与高亮必须立刻跟上
    {
        const styleBtn = () => q('[data-role="mobile-topbar"] button[data-pop="numberBubble"]');
        const styleLabel = () => styleBtn()?.querySelector("span")?.textContent.trim() ?? "";
        const styleCells = () => Array.from(
            q('[data-role="mobile-pop"]')?.querySelectorAll('[data-action="number-bubble"]') ?? []);
        check("M8 序号样式按钮初始为「实心」且带数字 1 缩略图",
            styleLabel() === "实心" && styleBtn()?.querySelector("svg text")?.textContent === "1",
            `${styleLabel()} / ${styleBtn()?.querySelector("svg text")?.textContent}`);

        styleBtn()?.click();
        await tick();
        check("M8 样式面板给四种样式，顺序固定",
            styleCells().map((c) => c.getAttribute("data-value")).join(",") === "solid,hollow,pointer,plain",
            styleCells().map((c) => c.getAttribute("data-value")).join(","));

        styleCells().find((c) => c.getAttribute("data-value") === "hollow")?.click();
        await tick();
        check("M8 选完空心圆：标签变「空心」，顶栏给填充 + 端点，没有透明档",
            styleLabel() === "空心" &&
            !!q('[data-role="mobile-topbar"] [data-action="number-color"][data-value="fillColor"]') &&
            !q('[data-role="mobile-topbar"] [data-action="number-fill-none"]') &&
            !!q('[data-role="mobile-topbar"] button[data-pop="numberArrowStyle"]') &&
            !q('[data-role="mobile-topbar"] button[data-action="number-leader-toggle"]'),
            styleLabel());

        styleBtn()?.click();
        await tick();
        styleCells().find((c) => c.getAttribute("data-value") === "pointer")?.click();
        await tick();
        check("M8 选完定位：标签变「定位」，顶栏换成引线 + 圆头 + 填充",
            styleLabel() === "定位" &&
            !!q('[data-role="mobile-topbar"] button[data-action="number-leader-toggle"]') &&
            !!q('[data-role="mobile-topbar"] button[data-action="number-round-toggle"]') &&
            !!q('[data-role="mobile-topbar"] [data-action="number-color"][data-value="fillColor"]') &&
            !q('[data-role="mobile-topbar"] button[data-pop="numberArrowStyle"]'),
            styleLabel());

        const leader = () => q('[data-role="mobile-topbar"] button[data-action="number-leader-toggle"]');
        const leaderOnBefore = leader()?.classList.contains("is-on");
        leader()?.click();
        await tick();
        check("M8 引线开关点一下状态立刻反过来",
            leader()?.classList.contains("is-on") === !leaderOnBefore,
            `${leaderOnBefore} -> ${leader()?.classList.contains("is-on")}`);

        const roundBtn = () => q('[data-role="mobile-topbar"] button[data-action="number-round-toggle"]');
        const roundBefore = roundBtn()?.classList.contains("is-on");
        roundBtn()?.click();
        await tick();
        check("M8 圆头开关点一下状态立刻反过来",
            roundBtn()?.classList.contains("is-on") === !roundBefore,
            `${roundBefore} -> ${roundBtn()?.classList.contains("is-on")}`);

        styleBtn()?.click();
        await tick();
        styleCells().find((c) => c.getAttribute("data-value") === "plain")?.click();
        await tick();
        check("M8 选完纯数字：标签变「数字」，只剩编号与端点",
            styleLabel() === "数字" &&
            !q('[data-role="mobile-topbar"] button[data-action="number-leader-toggle"]') &&
            !q('[data-role="mobile-topbar"] [data-action="number-color"]') &&
            !!q('[data-role="mobile-topbar"] button[data-pop="numberFormat"]') &&
            !!q('[data-role="mobile-topbar"] button[data-pop="numberArrowStyle"]'),
            styleLabel());

        styleBtn()?.click();
        await tick();
        styleCells().find((c) => c.getAttribute("data-value") === "solid")?.click();
        await tick();
        check("M8 再选回实心圆", styleLabel() === "实心", styleLabel());
    }

    // 9) 触屏「停顿自动矫正」：停住 0.3 秒 → 吸附；继续滑 → 解除
    {
        const previewShape = (sel) => layer()?.querySelector(`g.is-preview ${sel}`);
        const rectBox = () => {
            const el = previewShape("rect.annot-shape");
            return el ? {w: Number(el.getAttribute("width")), h: Number(el.getAttribute("height"))} : null;
        };
        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        const a = toClient(160, 160);
        const b = toClient(360, 250);
        svg.dispatchEvent(touch("pointerdown", a.x, a.y, 71));
        svg.dispatchEvent(touch("pointermove", b.x, b.y, 71));
        const freeBox = rectBox();
        await new Promise((resolve) => setTimeout(resolve, 420));
        const heldBox = rectBox();
        check("M8 矩形停住 0.3 秒后自动锁成正方形（手指不动也会变）",
            !!freeBox && !!heldBox && Math.abs(freeBox.w - freeBox.h) > 30 &&
            Math.abs(heldBox.w - heldBox.h) < 1.5 &&
            Math.abs(heldBox.w - freeBox.w) < 1.5,
            `${JSON.stringify(freeBox)} → ${JSON.stringify(heldBox)}`);
        svg.dispatchEvent(touch("pointermove", b.x + 24, b.y - 46, 71));
        const released = rectBox();
        check("M8 继续滑动立刻解除吸附（宽高重新不等）",
            !!released && Math.abs(released.w - released.h) > 10, JSON.stringify(released));
        svg.dispatchEvent(touch("pointerup", b.x + 24, b.y - 46, 71));
        await tick();

        // 箭头：停住后吸附成 45°
        click('.annot-mobile-rail button[data-tool="arrow"]');
        await tick();
        const c = toClient(220, 380);
        const d2 = toClient(400, 540);
        svg.dispatchEvent(touch("pointerdown", c.x, c.y, 72));
        svg.dispatchEvent(touch("pointermove", d2.x, d2.y, 72));
        await new Promise((resolve) => setTimeout(resolve, 420));
        const arrowD = () => previewShape("path.annot-shape")?.getAttribute("d") || "";
        const nums = (arrowD().match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        const ax = Math.abs((nums[2] || 0) - (nums[0] || 0));
        const ay = Math.abs((nums[3] || 0) - (nums[1] || 0));
        check("M8 箭头停住 0.3 秒后吸附成 45°（横竖分量相等）",
            nums.length >= 4 && ax > 60 && Math.abs(ax - ay) < 1.5,
            `dx=${ax.toFixed(1)} dy=${ay.toFixed(1)} d=${arrowD().slice(0, 40)}`);
        svg.dispatchEvent(touch("pointerup", d2.x + 30, d2.y - 30, 72));
        await tick();
    }

    // 4.5) 顶部悬浮参数栏（v0.23.0）：工具专属参数，每个一枚小按钮，点开向下弹气泡
    tapAt(900, 700);
    click('.annot-mobile-rail button[data-tool="arrow"]');
    const topbar = () => q('[data-role="mobile-topbar"]');
    const topButtons = () => all(".annot-mobile-topbar__btn");
    const popItems = () => all(".annot-mobile-pop__item");
    check("M8 顶部悬浮栏：箭头工具下出「箭头 + 圆线」两枚按钮",
        !!topbar() && topbar().hidden === false && topButtons().length === 2 &&
        topButtons()[0].getAttribute("data-pop") === "arrowStyle" &&
        topButtons()[1].getAttribute("data-action") === "arrow-rounded",
        topButtons().map((el) => el.textContent.trim()).join("/"));
    check("M8 顶部悬浮栏：气泡默认收起", q('[data-role="mobile-pop"]') === null);

    click('.annot-mobile-topbar__btn[data-pop="arrowStyle"]');
    check("M8 箭头气泡：类型 4 格 + 横线 + 端点 6 格",
        q('[data-role="mobile-pop"]') !== null && popItems().length === 10 &&
        !!q(".annot-mobile-pop__hr") &&
        popItems().every((el) => el.textContent.trim() === "") &&
        popItems().every((el) => el.querySelector("svg") !== null),
        String(popItems().length));
    check("M8 分隔线是横线：占满一行、高度 1px",
        css.includes(".annot-mobile-pop__hr") && css.includes("flex: 0 0 100%") &&
        css.includes("height: 1px"));

    click('.annot-mobile-pop__item[data-value="modern"]');
    await tick();
    check("M8 点类型后气泡收起", q('[data-role="mobile-pop"]') === null);
    click('.annot-mobile-topbar__btn[data-pop="arrowStyle"]');
    check("M8 重开气泡时类型高亮落在「尖尾」上",
        q('.annot-mobile-pop__item[data-value="modern"]')?.classList.contains("is-active") === true,
        String(q(".annot-mobile-pop__item.is-active")?.getAttribute("data-value")));
    check("M8 尖尾下开放/菱形/圆形/无箭头置灰但仍在",
        !!q(".annot-mobile-pop__item[data-value='open']:disabled") &&
        !!q(".annot-mobile-pop__item[data-value='rhombus']:disabled") &&
        !!q(".annot-mobile-pop__item[data-value='circle']:disabled") &&
        popItems().length === 10);

    click(".annot-titlebar");
    await tick();
    check("M8 点气泡外面收起", q('[data-role="mobile-pop"]') === null);

    const roundBtn = () => q('.annot-mobile-topbar__btn[data-action="arrow-rounded"]');
    const roundBefore = roundBtn()?.classList.contains("is-on");
    click('.annot-mobile-topbar__btn[data-action="arrow-rounded"]');
    check("M8 「圆线」是纯开关：点一下直接切、不弹气泡",
        roundBtn()?.classList.contains("is-on") !== roundBefore &&
        q('[data-role="mobile-pop"]') === null);

    click('.annot-mobile-rail button[data-tool="rect"]');
    check("M8 顶部悬浮栏跟着工具变：矩形工具只剩「圆角」一枚",
        topButtons().length === 1 && topButtons()[0].getAttribute("data-pop") === "corner",
        topButtons().map((el) => el.textContent.trim()).join("/"));

    tapAt(900, 700);
    click('.annot-fab[data-action="mobile-select"]');
    check("M8 选择工具且没选对象时整条顶部栏隐藏", topbar()?.hidden === true);

    // 高亮：手机顶栏直接平铺「画笔 / 矩形」两颗按钮（v1.1.0-alpha.3）
    click('.annot-mobile-rail button[data-tool="highlight"]');
    const hlButtons = () => Array.from(
        win.document.querySelectorAll('[data-role="mobile-topbar"] .annot-mobile-topbar__btn'));
    check("v1.1.0 手机上选中高亮，顶栏直接并排「画笔 / 矩形」两颗按钮（不用点开气泡）",
        hlButtons().length === 2 &&
        hlButtons()[0].getAttribute("data-action") === "highlight-mode-brush" &&
        hlButtons()[1].getAttribute("data-action") === "highlight-mode-rect" &&
        !win.document.querySelector('[data-role="mobile-pop"]'),
        hlButtons().map((el) => el.textContent.trim()).join("/"));
    check("v1.1.0 当前模式（画笔）那颗按钮是高亮态",
        !!hlButtons()[0]?.classList.contains("is-on") && !hlButtons()[1]?.classList.contains("is-on"));
    hlButtons()[1]?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    await tick();
    check("v1.1.0 点「矩形」后高亮态换到矩形那颗",
        !!hlButtons()[1]?.classList.contains("is-on") && !hlButtons()[0]?.classList.contains("is-on"));
    const beforeMobileHighlight = layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? 0;
    const hlFrom = toClient(120, 520);
    const hlTo = toClient(320, 620);
    svg.dispatchEvent(touch("pointerdown", hlFrom.x, hlFrom.y, 61));
    svg.dispatchEvent(touch("pointermove", (hlFrom.x + hlTo.x) / 2, (hlFrom.y + hlTo.y) / 2, 61));
    svg.dispatchEvent(touch("pointerup", hlTo.x, hlTo.y, 61));
    const mobileHighlight = Array.from(
        layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []).pop();
    const mobileHighlightShape = mobileHighlight?.querySelector("rect.annot-shape");
    check("v1.1.0 手机单指拖出矩形高亮（无描边、半透明）",
        (layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? 0) === beforeMobileHighlight + 1 &&
        !!mobileHighlightShape && mobileHighlightShape.getAttribute("stroke") === "none" &&
        /^rgba\(/.test(mobileHighlightShape.getAttribute("fill") || ""),
        `stroke=${mobileHighlightShape?.getAttribute("stroke")} fill=${mobileHighlightShape?.getAttribute("fill")}`);
    check("v1.1.0 手机端矩形高亮也能选中并出现缩放手柄",
        !!win.document.querySelector('[data-handle="resize:se"]'));

    // 双端一致：手机上拿着矩形工具，按在已有同类矩形里也是「选中它」而不是再叠一个
    {
        const countNow = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? 0;
        const lastObj = () => Array.from(
            layer()?.querySelectorAll("g.annot-object:not(.is-preview)") ?? []).pop();
        const dragTouch = (a, b, id) => {
            const from = toClient(a.x, a.y);
            const to = toClient(b.x, b.y);
            svg.dispatchEvent(touch("pointerdown", from.x, from.y, id));
            svg.dispatchEvent(touch("pointermove", (from.x + to.x) / 2, (from.y + to.y) / 2, id));
            svg.dispatchEvent(touch("pointerup", to.x, to.y, id));
        };
        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        const beforeRect = countNow();
        dragTouch({x: 620, y: 180}, {x: 780, y: 300}, 71);
        const rectId = lastObj()?.getAttribute("data-object-id");
        check("v1.2.0-alpha.19 移动端：先画一个矩形备用",
            countNow() === beforeRect + 1 && !!rectId, `${beforeRect} -> ${countNow()}`);

        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        dragTouch({x: 660, y: 220}, {x: 740, y: 280}, 72);
        check("v1.2.0-alpha.19 移动端：同类对象内按下不再叠一个新矩形",
            countNow() === beforeRect + 1, `${countNow()} 个`);
        check("v1.2.0-alpha.19 移动端：同类对象内按下改为选中原来那个",
            !!layer()?.querySelector(`g.annot-object.is-selected[data-object-id="${rectId}"]`),
            `选中=${layer()?.querySelectorAll("g.annot-object.is-selected").length}`);

        // 不同类型照常画：在同一个矩形上画箭头
        click('.annot-mobile-rail button[data-tool="arrow"]');
        await tick();
        const beforeArrow = countNow();
        dragTouch({x: 660, y: 220}, {x: 740, y: 280}, 73);
        check("v1.2.0-alpha.19 移动端：在矩形上画箭头正常生成",
            countNow() === beforeArrow + 1, `${beforeArrow} -> ${countNow()}`);
    }

    // 键盘弹起：底部三栏必须整块收起（锁定高度 + is-keyboard）
    {
        click('.annot-mobile-rail button[data-tool="text"]');
        await tick();
        tapAt(240, 360);
        await tick();
        check("M8 文字工具点一下出现输入框", !!q(".annot-text-editor"),
            String(!!q(".annot-text-editor")));
        // 进入输入态：只锁高度，工具条留在原位（键盘会盖住它，收起来自然可见）
        check("M8 文字输入态锁住界面高度，工具条不被移除",
            !!q(".annot-root")?.classList.contains("is-keyboard") &&
            !!q(".annot-mobile-rail"),
            String(q(".annot-root")?.className));
        setViewportHeight(500);
        await tick();
        const kbRoot = q(".annot-root");
        check("M8 键盘弹出后锁住高度，画面不跟着挤",
            !!kbRoot?.classList.contains("is-keyboard") &&
            !!kbRoot?.style.getPropertyValue("--annot-lock-h"),
            `lock=${kbRoot?.style.getPropertyValue("--annot-lock-h")}`);
        // 切回别的工具 = 结束输入，三栏立刻回来
        click('.annot-mobile-rail button[data-tool="rect"]');
        await tick();
        setViewportHeight(844);
        await tick();
        check("M8 结束输入后三栏自动回来",
            !q(".annot-root")?.classList.contains("is-keyboard"),
            String(q(".annot-root")?.className));

        // 编辑中点画布：只把这段收尾，不再凭空多一个空文字对象
        const objCount = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? 0;
        click('.annot-mobile-rail button[data-tool="text"]');
        await tick();
        const beforeFirst = objCount();
        tapAt(300, 420);
        await tick();
        const liveEditor = q(".annot-text-editor");
        check("M8 文字工具点一下就能开始写", !!liveEditor,
            `${beforeFirst} -> ${objCount()} / editor=${!!liveEditor}`);
        if (liveEditor) {
            liveEditor.value = "测试";
            liveEditor.dispatchEvent(new win.Event("input", {bubbles: true}));
        }
        await tick();
        const beforeTap = objCount();
        const editorBeforeTap = !!q(".annot-text-editor");
        tapAt(700, 520);
        await tick();
        check("M8 编辑中点别处只收尾，不再新建空文字",
            objCount() === beforeTap && !q(".annot-text-editor"),
            `${beforeTap} -> ${objCount()} / 点前有输入框=${editorBeforeTap} / 点后=${!!q(".annot-text-editor")}`);

        // 输入框被键盘挡住时才上抬，且只补「超出可视区」的那一截
        {
            click('.annot-mobile-rail button[data-tool="text"]');
            await tick();
            tapAt(900, 700);
            await tick();
            const ed = q(".annot-text-editor");
            const stageEl = q(".annot-stage");
            if (ed && stageEl) {
                const rect = (top, height) => ({
                    top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top,
                    toJSON: () => ({}),
                });
                ed.getBoundingClientRect = () => rect(700, 60);
                stageEl.getBoundingClientRect = () => rect(0, 844);
                setViewportHeight(500);
                await tick();
                // 可视底 = 500 - 8 = 492，输入框底边 760，超出 268
                check("M8 键盘挡住输入框时按超出量上抬，不会越抬越偏",
                    (ed.style.transform || "").includes("-268"), ed.style.transform || "(空)");
                setViewportHeight(844);
                await tick();
                check("M8 键盘收起后输入框位置归零", !ed.style.transform, ed.style.transform || "(空)");
            }
        }

        // 文字输入态下双指仍要能缩放（第 2 根手指不能被「结束输入」拦掉）
        {
            click('.annot-mobile-rail button[data-tool="text"]');
            await tick();
            tapAt(300, 240);
            await tick();
            const zoomBefore = readViewport().zoom;
            svg.dispatchEvent(touch("pointerdown", 120, 400, 81));
            svg.dispatchEvent(touch("pointerdown", 280, 400, 82));
            // 两根手指要连续分开几次，第一下只用来判定「这是缩放」而不是「按住当 Shift」
            for (let step = 1; step <= 4; step++) {
                svg.dispatchEvent(touch("pointermove", 120 - step * 15, 400, 81));
                svg.dispatchEvent(touch("pointermove", 280 + step * 15, 400, 82));
            }
            const zoomAfter = readViewport().zoom;
            svg.dispatchEvent(touch("pointerup", 60, 400, 81));
            svg.dispatchEvent(touch("pointerup", 340, 400, 82));
            await tick();
            check("M8 文字输入态下双指仍能缩放画面",
                zoomAfter > zoomBefore * 1.15,
                `${zoomBefore.toFixed(2)} -> ${zoomAfter.toFixed(2)}`);
        }

        // 文字工具下双指：撤掉首指点出来的空文字
        {
            const countAll = () => layer()?.querySelectorAll("g.annot-object:not(.is-preview)").length ?? 0;
            click('.annot-mobile-rail button[data-tool="text"]');
            await tick();
            const before = countAll();
            svg.dispatchEvent(touch("pointerdown", 120, 300, 83));
            svg.dispatchEvent(touch("pointerdown", 280, 300, 84));
            svg.dispatchEvent(touch("pointermove", 60, 300, 83));
            svg.dispatchEvent(touch("pointermove", 340, 300, 84));
            svg.dispatchEvent(touch("pointerup", 60, 300, 83));
            svg.dispatchEvent(touch("pointerup", 340, 300, 84));
            await tick();
            check("M8 文字工具下双指缩放不会留下空文字",
                countAll() === before && !q(".annot-text-editor"),
                `${before} -> ${countAll()} / editor=${!!q(".annot-text-editor")}`);
        }

        // 缩放时不许整幅重建：图形节点保持同一个引用，选中框也不会闪
        {
            click('[data-action="mobile-select"]');
            await tick();
            tapAt(200, 300);
            await tick();
            const nodeBefore = layer()?.querySelector("g.annot-object");
            const zoomBefore = readViewport().zoom;
            svg.dispatchEvent(touch("pointerdown", 120, 400, 91));
            svg.dispatchEvent(touch("pointerdown", 280, 400, 92));
            for (let step = 1; step <= 4; step++) {
                svg.dispatchEvent(touch("pointermove", 120 - step * 15, 400, 91));
                svg.dispatchEvent(touch("pointermove", 280 + step * 15, 400, 92));
            }
            check("M8 双指缩放只改变换、不重建对象节点（画面不闪）",
                layer()?.querySelector("g.annot-object") === nodeBefore &&
                readViewport().zoom > zoomBefore * 1.15,
                `节点相同=${layer()?.querySelector("g.annot-object") === nodeBefore} / zoom ${zoomBefore.toFixed(2)} -> ${readViewport().zoom.toFixed(2)}`);
            svg.dispatchEvent(touch("pointerup", 60, 400, 91));
            svg.dispatchEvent(touch("pointerup", 340, 400, 92));
            await tick();
        }
    }

    // 文本工具：描边/背景换图标、颜色只剩白黑（1.4.0-alpha.44）
    {
        click('.annot-mobile-rail button[data-tool="text"]');
        await tick();
        const modeBtn = Array.from(q('[data-role="mobile-topbar"]')?.querySelectorAll(".annot-mobile-topbar__btn") ?? [])
            .find((b) => (b.getAttribute("data-action") || "") === "text-mode-toggle");
        check("1.4.0-alpha.44 描边/背景按钮用图标（不再是单个汉字）",
            !!modeBtn?.querySelector("svg.annot-icon") && !modeBtn?.querySelector(".annot-mobile-topbar__char"),
            modeBtn?.querySelector("svg") ? "有图标" : "仍是汉字");
        const swatches = Array.from(win.document.querySelectorAll('[data-group="colors"] .annot-mobile-swatch'))
            .filter((el) => el.getAttribute("data-preset") === "color");
        check("1.4.0-alpha.46 底部通用颜色栏保持原样（5 色 + 自定义）",
            swatches.length >= 5, String(swatches.length));
        // 顶部那两颗：粗细（WIDTH_ICON）与字体（FONT_ICON）都必须是图标
        const topBtns = Array.from(q('[data-role="mobile-topbar"]')?.querySelectorAll(".annot-mobile-topbar__btn") ?? []);
        check("1.4.0-alpha.45 顶部粗细与字体按钮都用图标",
            topBtns.length >= 4 && topBtns.every((b) => !!b.querySelector("svg.annot-icon") ||
                !!b.querySelector(".annot-mobile-topbar__dot")),
            `${topBtns.length} 颗 / 非图标 ${topBtns.filter((b) => !b.querySelector("svg.annot-icon") && !b.querySelector(".annot-mobile-topbar__dot")).length}`);
        check("1.4.0-alpha.45 底部通用栏标题仍是文字（粗细 / 字号）",
            styleGroups().indexOf("widths") < 0 || styleText().includes("粗细"));
        click('.annot-mobile-rail button[data-tool="select"]');
        await tick();
    }

    // 顶部文本颜色气泡：白 / 黑 / 自定义（1.4.0-alpha.47）
    {
        click('.annot-mobile-rail button[data-tool="text"]');
        await tick();
        const colorBtn = Array.from(q('[data-role="mobile-topbar"]')?.querySelectorAll(".annot-mobile-topbar__btn") ?? [])
            .find((b) => (b.getAttribute("data-pop") || "") === "textColor");
        check("1.4.0-alpha.47 顶部有文本颜色入口", !!colorBtn);
        if (colorBtn) {
            colorBtn.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
            await tick();
            const pop = q('[data-role="mobile-pop"]');
            const presets = pop?.querySelectorAll('[data-action="text-color"]').length ?? 0;
            const custom = pop?.querySelectorAll('[data-action="mobile-color"]').length ?? 0;
            check("1.4.0-alpha.47 颜色气泡只有白 / 黑 / 自定义",
                presets === 2 && custom === 1, `预设 ${presets} / 自定义 ${custom}`);
        }
        click('.annot-mobile-rail button[data-tool="select"]');
        await tick();
    }

    // 尺寸参数走移动端顶部气泡（1.4.0-alpha.38）
    {
        click('.annot-mobile-rail button[data-tool="measure"]');
        await tick();
        const topbar = q('[data-role="mobile-topbar"]');
        const btns = Array.from(topbar?.querySelectorAll(".annot-mobile-topbar__btn") ?? []);
        check("1.4.0-alpha.48 顶部是长度/角度两颗独立按钮 + 界线 + 箭头 + 单位",
            btns.length === 5, `${btns.length} 个`);
        check("1.4.0-alpha.54 角度图标带收细标记",
            !!q('[data-action="measure-mode-angle"] svg.annot-icon--slim'));
        const lenPath = q('[data-action="measure-mode-length"] svg path');
        const tickPath = q('[data-action="measure-ticks"] svg path');
        // 加粗必须写在 inline style 里：插件 CSS 有
        // `.annot-root svg.annot-icon [fill="currentColor"] { stroke: none }`，会把属性形式的 stroke 干掉
        const lenStyle = lenPath?.getAttribute("style") || "";
        const tickStyle = tickPath?.getAttribute("style") || "";
        check("1.4.0-alpha.53 长度/界线的加粗写在 inline style 里（不被 stroke:none 覆盖）",
            lenStyle.includes("stroke:currentColor") && lenStyle.includes("stroke-width:30") &&
            tickStyle.includes("stroke-width:46"), lenStyle + " | " + tickStyle);
        check("1.4.0-alpha.38 底部参数栏恢复通用项（颜色 / 粗细 / 线型）",
            styleGroups().join(",") === "colors,widths,lines", styleGroups().join(","));
        const headBtn = btns.find((b) => (b.getAttribute("data-pop") || "") === "mHead");
        check("1.4.0-alpha.38 箭头是气泡入口", !!headBtn);
        if (headBtn) {
            headBtn.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
            await tick();
            const pop = q('[data-role="mobile-pop"]');
            check("1.4.0-alpha.38 点开后有 6 个箭头图标", 
                (pop?.querySelectorAll('[data-action="measure-head"]').length ?? 0) === 6,
                String(pop?.querySelectorAll('[data-action="measure-head"]').length ?? 0));
            // 上一步点开箭头气泡后顶部栏已重建，必须重新查一次
            const unitBtn = q('[data-role="mobile-topbar"] [data-pop="mUnit"]');
            check("1.4.0-alpha.48 单位是独立气泡入口", !!unitBtn);
            if (unitBtn) {
                unitBtn.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));
                await tick();
                check("1.4.0-alpha.48 单位气泡里有 9 个长度单位胶囊",
                    (q('[data-role="mobile-pop"]')?.querySelectorAll(".annot-mobile-pop__chip").length ?? 0) === 9,
                    (q('[data-role="mobile-pop"]')?.innerHTML || "(空)").slice(0, 80));
            }
            // 水平居中只由 CSS 负责，JS 不再写 left（否则会双重偏移 / 算偏）
            check("1.4.0-alpha.42 气泡水平居中交给样式（JS 不写 left）",
                (pop?.style.left ?? "") === "", pop?.style.left || "(未设置)");
            // 气泡必须挂在 .annot-root 下，不能塞进宽度=内容的胶囊里
            const livePop = q('[data-role="mobile-pop"]');
            check("1.4.0-alpha.40 气泡挂在根容器下（不受顶部胶囊宽度限制）",
                !!livePop && livePop.parentElement?.classList.contains("annot-root") === true,
                livePop?.parentElement?.className || "(无)");
        }
        click('.annot-mobile-rail button[data-tool="select"]');
        await tick();
    }

    click('[data-action="close"]');
    await tick();
}

// ---------------------------------------------------------------- 图片悬浮快捷入口
if (process.argv[3] === "--quick") {
    const q = (s) => win.document.querySelector(s);
    const click = (el) => el?.dispatchEvent(new win.MouseEvent("click", {bubbles: true, cancelable: true}));

    // 照思源真实结构搭一个图片块（.img > .protyle-action.protyle-icons + img）
    const wysiwyg = win.document.createElement("div");
    wysiwyg.className = "protyle-wysiwyg";
    wysiwyg.innerHTML = '<div data-node-id="202611190000000-quick" data-type="NodeParagraph" class="p">'
        + '<div contenteditable="true"><span contenteditable="false" data-type="img" class="img">'
        + '<span> </span><span>'
        + '<span class="protyle-action protyle-icons">'
        + '<span class="protyle-icon protyle-icon--only"><svg><use href="#iconMore"></use></svg></span>'
        + '</span>'
        + '<img src="assets/demo.png" data-src="assets/demo.png" alt="">'
        + '</span></span></div></div>';
    win.document.body.appendChild(wysiwyg);
    // 指针进入图片时注入（PC 悬停 / 移动端轻点走同一条路）
    const hoverImage = () => q('.img[data-type="img"] img')
        ?.dispatchEvent(new win.MouseEvent("pointerover", {bubbles: true, cancelable: true}));
    hoverImage();

    const icons = q('.img[data-type="img"] .protyle-icons');
    const button = q(".annot-quick-entry");
    check("快捷入口：图片上注入了按钮", !!button, String(!!button));
    hoverImage();
    check("快捷入口：反复进入同一张图不会插出第二个按钮",
        win.document.querySelectorAll(".annot-quick-entry").length === 1,
        String(win.document.querySelectorAll(".annot-quick-entry").length));
    check("快捷入口：按钮排在原生按钮组最左边",
        icons?.firstElementChild === button,
        String(icons?.firstElementChild?.className));
    check("快捷入口：圆角接力（我们 --first，原生从 --only 变 --last）",
        !!button?.classList.contains("protyle-icon--first") &&
        !!icons?.querySelector(".protyle-icon--last") &&
        !icons?.querySelector(".protyle-icon--only"),
        String(icons?.innerHTML || "").slice(0, 70));
    check("快捷入口：图标用 currentColor，没有写死颜色",
        !!button?.querySelector('svg path[fill="currentColor"]') &&
        !/fill="#[0-9a-fA-F]{3,6}"/.test(button?.innerHTML || "") &&
        !/stroke="#[0-9a-fA-F]{3,6}"/.test(button?.innerHTML || ""));

    // 点一下：应当直接打开编辑器，而不是弹原生菜单
    click(button);
    await new Promise((resolve) => setTimeout(resolve, 150));
    check("快捷入口：点击后直接打开标注编辑器", !!q(".annot-root"),
        String(!!q(".annot-root")));
    q('.annot-root [data-action="close"]')?.dispatchEvent(
        new win.MouseEvent("click", {bubbles: true, cancelable: true}));
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 卸载后按钮要摘干净，原生圆角也要还原
    plugin.onunload();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const iconsAfter = q('.img[data-type="img"] .protyle-icons');
    check("快捷入口：卸载后按钮移除、原生按钮恢复 --only",
        !q(".annot-quick-entry") &&
        !!iconsAfter?.querySelector(".protyle-icon--only") &&
        !iconsAfter?.querySelector(".protyle-icon--last"),
        String(iconsAfter?.innerHTML || "").slice(0, 60));
    plugin.onload();
}

plugin.onunload();
check("onunload 后不再注册事件", !listeners.has("open-menu-image"));
check("整个流程控制台无错误", consoleErrors.length === 0, consoleErrors.join(" | "));
console.error = originalConsoleError;

for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
}
console.log(`\nDOM smoke test：${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
