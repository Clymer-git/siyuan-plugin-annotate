/**
 * 静态回归 + 免浏览器 smoke test。
 * 用法：node scripts/verify.mjs [插件包目录]   默认 dist/
 *
 * 静态回归：清单字段、产物形态、主题变量映射、i18n 合法性、图标签名。
 * smoke test：用与思源加载器（app/src/plugin/loader.ts:44-60）完全相同的
 *   (require, module, exports) 包装执行打包后的 index.js，验证：
 *   1) 能拿到 extends Plugin 的默认导出；
 *   2) onload 会注册 open-menu-image；
 *   3) 模拟一次右键图片事件，能解析出 assets 路径与块 ID，并注入菜单项；
 *   4) onunload 会注销监听。
 * 同时输出每个文件的 SHA256，便于比对交付包是否被改动。
 */
import {readFile, readdir, stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(root, process.argv[2] || "dist");
const results = [];
let failed = 0;

function check(name, condition, detail = "") {
    results.push({name, ok: Boolean(condition), detail});
    if (!condition) failed++;
}

const read = async (p) => await readFile(path.join(target, p));
const exists = async (p) => {
    try {
        await stat(path.join(target, p));
        return true;
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------- 静态回归
const manifest = JSON.parse((await read("plugin.json")).toString("utf8"));
check("plugin.json name 为 siyuan-plugin-annotate", manifest.name === "siyuan-plugin-annotate", manifest.name);
const isDeliverable = path.basename(target) !== "dist";
check("插件目录名与 name 一致",
    !isDeliverable || path.basename(target) === manifest.name, path.basename(target));
const displayNames = Object.values(manifest.displayName ?? {});
check("displayName 全部为「勾画阁·猫抓」", displayNames.length > 0 && displayNames.every((v) => v === "勾画阁·猫抓"), JSON.stringify(displayNames));
check("frontends 同时声明桌面端与移动端",
    Array.isArray(manifest.frontends) &&
    manifest.frontends.includes("desktop") &&
    manifest.frontends.includes("mobile"),
    JSON.stringify(manifest.frontends));
check("声明了 minAppVersion", typeof manifest.minAppVersion === "string", String(manifest.minAppVersion));

// 集市展示：本地已安装包靠包内文件渲染「介绍」与「预览图」
// （kernel/bazaar/installed.go:96-101 读 preview.png 与 plugin.json 的 readme 文件）
check("plugin.json 声明了 preview 预览图", typeof manifest.preview === "string" && manifest.preview !== "",
    String(manifest.preview || ""));
check("预览图文件真的在包里", await exists(manifest.preview || "preview.png"), String(manifest.preview || ""));
check("预览图用的是集市要求的尺寸比例（4:3，1024×768 或更大）", await (async () => {
    const file = manifest.preview || "preview.png";
    if (!(await exists(file))) return false;
    const head = await read(file);
    // PNG 头里的 IHDR：宽高各 4 字节
    if (head.length < 24 || head[0] !== 0x89 || head.slice(1, 4).toString("latin1") !== "PNG") return false;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    return width >= 1024 && height >= 768 && Math.abs(width / height - 4 / 3) < 0.02;
})(), String(manifest.preview || ""));
check("plugin.json 声明了 README（插件介绍）",
    !!manifest.readme && typeof manifest.readme === "object" &&
    Object.values(manifest.readme).some((v) => typeof v === "string" && v.trim() !== ""),
    JSON.stringify(manifest.readme || null));
check("README.md 在包里且写了功能介绍",
    await (async () => {
        const name = Object.values(manifest.readme ?? {}).find((v) => typeof v === "string" && v.trim()) || "README.md";
        if (!(await exists(name))) return false;
        const md = (await read(name)).toString("utf8");
        // 标题允许「## 标注工具 / 功能 / 能做什么」，只要讲了功能与用法即可
        return md.includes("勾画阁·猫抓") && /## (标注工具|功能|能做什么)/.test(md) &&
            /## (两种打开方式|怎么用|使用|操作)/.test(md) && md.length > 600;
    })(), "README 需含名称、功能、用法");
check("README 里引用了预览图", await (async () => {
    const name = Object.values(manifest.readme ?? {}).find((v) => typeof v === "string" && v.trim()) || "README.md";
    if (!(await exists(name))) return false;
    return (await read(name)).toString("utf8").includes("preview.png");
})(), "");


const js = (await read("index.js")).toString("utf8");
check("index.js 存在且非空", js.length > 500, `${js.length} bytes`);
check("index.js 外置 require('siyuan')", /require\(["']siyuan["']\)/.test(js));
check("index.js 导出 default 类", /exports\.default\s*=/.test(js) || /module\.exports\s*=/.test(js));
check("index.js 无残留 ESM import", !/^\s*import\s+[^;]+from\s+["']/m.test(js));
check("index.js 注册 open-menu-image", js.includes("open-menu-image"));
check("index.js 使用 detail.element 解析图片", js.includes("data-src"));
check("菜单项注入主菜单并带幂等保护",
    js.includes('[data-id="') && js.includes("globalMenu.addItem(menuItem)") && js.includes("detail.menu"),
    "主菜单 addItem + data-id 去重 + subMenu 兜底");

const css = (await read("index.css")).toString("utf8");
check("index.css 映射思源主题变量", css.includes("--b3-theme-background") && css.includes("--b3-theme-on-background"));
check("index.css 含语义令牌", css.includes("--annot-bg") && css.includes("--annot-accent"));
check("index.css 含强制浅/深色覆盖", css.includes('data-annot-theme="light"') && css.includes('data-annot-theme="dark"'));
check("index.css 自定义色块中心有十字标记",
    css.includes('.annot-bg[data-bg="custom1"]::before') && css.includes('.annot-bg[data-bg="custom1"]::after'));
check("吸管色块里是吸管图标（不再是文字）",
    js.includes("annot-pick-icon") && css.includes("svg.annot-pick-icon"));
check("扩展面板的方向选择器是「中心方块 + 四边箭头」的方向盘布局",
    css.includes("grid-template-areas") && css.includes("annot-dir--all") && css.includes("annot-dir__icon"));

check("色块轮廓用外描边（不再用 inset，避免浅色圆看起来小一圈）",
    /\.annot-bg\s*\{[^}]*box-shadow:\s*0 0 0 1px/.test(css) && !/\.annot-bg\s*\{[^}]*inset/.test(css));
check("index.css 有左侧图像工具栏与底栏三段式",
    css.includes(".annot-imagebar") && css.includes(".annot-status__zoom") && css.includes(".annot-status__center"));
check("index.css 有裁剪侧栏与扩展画布浮层",
    css.includes(".annot-crop-side") && css.includes(".annot-extend") &&
    css.includes(".annot-sidebar[hidden]"));
check("index.css 用矩阵定位底图",
    /\.annot-base\s*\{[^}]*transform-origin/s.test(css) && css.includes("position: absolute"));

// v0.7.0：适应窗口 / 底栏 / 左侧图像工具栏 / 文字描边
check("index.js 含左侧图像工具栏的六种图像操作",
    js.includes("data-canvas-op") && js.includes("rotate-cw") && js.includes("flip-v") && js.includes("crop"));
check("index.js 画布操作会重排标注坐标", js.includes("remapObjects"));
check("index.js 文字描边走 paint-order", js.includes("paint-order") && js.includes("textStrokeEnabled"));
check("index.js 保存时写入画布状态", js.includes("naturalWidth") && js.includes("matrix"));
check("index.js 会通过 updateBlock 把画布改动写回笔记图片",
    js.includes("/api/block/updateBlock") && js.includes("dataType"));
check("index.js 含方向盘、四向数值 + 锁链、画布底色/吸管",
    js.includes("data-dir") && js.includes("bg-pick") && js.includes("canvas-bg") &&
    js.includes("extend-top") && js.includes("extend-right") && js.includes("toggle-link"));
check("方向按钮是「贴边矩形」（相邻边＝中心方块边长 46）",
    css.includes("grid-template-columns: 26px 46px 26px") &&
    css.includes("grid-template-rows: 26px 46px 26px") &&
    css.includes("place-items: stretch"));

check("顶栏属性是五组预设按钮（分组框）+ 参数悬浮条，旧的可视化设置面板已移除",
    js.includes("annot-attr-group") && js.includes("annot-preset-button") &&
    js.includes("data-range") &&
    !js.includes("annot-preset-group") && !js.includes("data-setting"));
check("index.css 含圆头滑轨（线宽随数值变粗）与色块样式",
    css.includes(".annot-range-track") && css.includes(".annot-range-track--fill") &&
    css.includes("border-radius: 999px") && css.includes(".annot-swatch"));

// v0.9.13：参考 imgReEditor，改成「覆盖同名 PNG + tEXt 内嵌工程数据」
check("保存时把成品与工程数据写进同一张 PNG（tEXt 块）",
    js.includes("siyuan-plugin-annotate") && js.includes("tEXt") &&
    js.includes("writePackage") && js.includes("readPackage"));
check("保存覆盖笔记正在引用的资源路径，不再生成 SVG 与附档",
    js.includes("writePackagedImage") && js.includes("putFile") &&
    js.includes("refreshImageSrc") && !js.includes("buildAnnotatedSvg") &&
    !js.includes("svgAssetName") && !js.includes("saveScene("));
check("PNG 里留着完整原始底图，裁剪后仍能扩回外围",
    js.includes("resolveBaseSource") && js.includes("PACKAGE_VERSION") &&
    js.includes("image/png"));
check("旧版 -annot.svg 仍可只读打开（升级兼容）", js.includes("parseAnnotatedSvg"));

// v0.10.11：按用户要求回到 v0.10.5 的保存方式 —— 覆盖同一个资源 + 给 img.src 加缓存串。
// 代价是双击看图可能定位不到初始索引（已知，写在 refreshImageSrc 的注释里）。
check("保存时覆盖笔记正在引用的同一个资源（不产生新文件、不改笔记内容）",
    js.includes("data/${assetPath}") && !js.includes("-annot-${hash}.png") &&
    !js.includes("cleanupOldProducts") && !js.includes("contentHash"));
check("保存后只给 img.src 加缓存串刷新，不碰 srcset",
    js.includes("?v=${Date.now()}") && js.includes('img.setAttribute("src"') &&
    !js.includes('setAttribute("srcset"'));
check("非 PNG 且独占一段时首次换成固定 -annot.png，之后一直覆盖它",
    js.includes("}-annot.png`") && js.includes("replaceBlockImage"));
check("图文混排不改笔记内容，直接覆盖原路径",
    js.includes("pureImage ? `${dir}${stem}-annot.png` : current"));

check("保存提示是「N 个标注已保存。编辑信息单独记录，支持再次编辑。」（全删光时说「标注已清空」）",
    js.includes("编辑信息单独记录，支持再次编辑") && js.includes("标注已清空") &&
    !js.includes("上一版成品图已清理"));

// ---- 画线工具：静态存在性 + 几何纯函数行为 ----
check("新增第 10 个工具「画线」，图标用用户给的原稿且颜色跟随主题",
    js.includes('line: "画线"') && js.includes("0 0 1706 1024") &&
    js.includes("M121.941333") && js.includes('fill="currentColor"'));
check("画线支持 Shift 锁定方向、折线双击/Esc 结束、触屏智能矫正",
    js.includes("snapDirection") && js.includes("shouldSnapTouchLine") &&
    js.includes("linePolyline") && js.includes("dblclick") && js.includes('kind: "lineClick"'));
check("画线与其它对象一样有包围盒 / 平移 / 缩放 / 逐点手柄",
    (js.match(/case "line":/g) || []).length >= 8 &&
    js.includes("point:") && js.includes('startsWith("point:")'));

/** 从打包产物里抠出指定顶层函数，用来跑纯函数断言 */
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

let lineHelpers = null;
try {
    const code = ["snapDirection", "angleOffsetFromGrid", "maxPathDeviation", "shouldSnapTouchLine"]
        .map((name) => extractFunction(js, name)).join("\n");
    // line.ts 里的 STEP 是模块级常量，抽取函数时要一起补上
    lineHelpers = new Function(`const STEP = Math.PI / 4;\n${code}; return {snapDirection, angleOffsetFromGrid, maxPathDeviation, shouldSnapTouchLine};`)();
} catch (e) {
    lineHelpers = null;
}
const near = (a, b, tol = 0.001) => Math.abs(a - b) < tol;
check("Shift 约束：接近水平的斜线被拉成水平，长度不变",
    !!lineHelpers && near(lineHelpers.snapDirection({x: 0, y: 0}, {x: 100, y: 20}).y, 0) &&
    near(lineHelpers.snapDirection({x: 0, y: 0}, {x: 100, y: 20}).x, Math.hypot(100, 20)),
    JSON.stringify(lineHelpers?.snapDirection({x: 0, y: 0}, {x: 100, y: 20})));
check("Shift 约束：接近 45° 的斜线两个分量被拉成相等",
    !!lineHelpers &&
    near(Math.abs(lineHelpers.snapDirection({x: 0, y: 0}, {x: 100, y: 80}).x),
        Math.abs(lineHelpers.snapDirection({x: 0, y: 0}, {x: 100, y: 80}).y)),
    JSON.stringify(lineHelpers?.snapDirection({x: 0, y: 0}, {x: 100, y: 80})));
check("触屏矫正：末端停顿会拉直；快速画的普通斜线不打断用户",
    !!lineHelpers &&
    lineHelpers.shouldSnapTouchLine({dwellMs: 250, distancePx: 160, deviationPx: 3, angleOffsetDeg: 18}) === true &&
    lineHelpers.shouldSnapTouchLine({dwellMs: 20, distancePx: 160, deviationPx: 20, angleOffsetDeg: 18}) === false &&
    lineHelpers.shouldSnapTouchLine({dwellMs: 20, distancePx: 160, deviationPx: 2, angleOffsetDeg: 5}) === true,
    lineHelpers ? "三条判定都符合" : "取不到函数");
check("触屏矫正：轨迹笔直度能量出偏离",
    !!lineHelpers &&
    near(lineHelpers.maxPathDeviation([{x: 50, y: 0}, {x: 100, y: 0}], {x: 0, y: 0}, {x: 100, y: 0}), 0) &&
    lineHelpers.maxPathDeviation([{x: 50, y: 30}], {x: 0, y: 0}, {x: 100, y: 0}) === 30,
    String(lineHelpers?.maxPathDeviation([{x: 50, y: 30}], {x: 0, y: 0}, {x: 100, y: 0})));

// 反证：把思源 preview/image.ts:29 的 endsWith 判断搬过来跑一遍
const viewerIndexOf = (src, list) => {
    let index = -1;
    list.forEach((item, i) => { if (src.endsWith(encodeURI(item)) || src.endsWith(item)) index = i; });
    return index;
};
check("查看器定位：干净 src 命中、带 ?v= 的旧写法匹配不到（即白屏根因）",
    viewerIndexOf("assets/x.png", ["assets/x.png"]) === 0 &&
    viewerIndexOf("assets/x.png?v=1731", ["assets/x.png"]) === -1);
check("扩展面板没选中的方向输入框锁死",
    js.includes("is-locked") && css.includes(".annot-amount.is-locked") &&
    /is-locked["']?,?\s*!?.{0,20}disabled|disabled\s*=/.test(js));
check("锁链图标是实心两环（1024 画布 + currentColor）",
    js.includes("annot-link__icon") && /viewBox="0 0 1024 1024"/.test(js) &&
    /\.annot-link__icon\s*\{[^}]*fill:\s*currentColor/.test(css));
check("自定义色块的十字是细线（1.2px，和吸管图标一个量级）",
    /\.annot-bg\[data-bg="custom1"\]::before\s*\{[^}]*height:\s*1\.2px/.test(css) &&
    /\.annot-bg\[data-bg="custom1"\]::after\s*\{[^}]*width:\s*1\.2px/.test(css),
    "十字线条粗细");

// v0.9.1：换图时保住「图片的显示宽度 / 图注 / 块属性」，否则缩过的图会弹回默认大小
check("换图时把图片的显示宽度写成行内 IAL 带过去",
    js.includes('style="width: ') && /width:\s*\$\{/.test(js.replace(/\s/g, " ")));
check("换图前读块属性、换完写回去（保住居中 / 自定义属性）",
    js.includes("/api/attr/getBlockAttrs") && js.includes("/api/attr/setBlockAttrs"));

// v0.9.2：导出按钮改名 + 记住工具栏点选 + 马赛克无描边
check("v0.21.0：顶栏不再有「导出为 PNG」按钮，导出逻辑整体移除",
    !js.includes('data-action="export"') && !js.includes("导出为 PNG") &&
    !js.includes("exportPng") && !js.includes("已导出 PNG 并插入笔记"));
check("工具栏点选的颜色/线宽/填充/字号会被记住",
    js.includes("siyuan-plugin-annotate:current") && js.includes("saveCurrentStyle"));

// v0.9.7：裁剪框升级（8 手柄 / 框内拖动 / 比例预设）
check("index.js 含裁剪手柄与比例预设",
    js.includes("data-crop-handle") && js.includes('"crop-ratio"') && js.includes("16:9") && js.includes("2.35:1"),
    "手柄 + 比例按钮");
check("裁剪比例与最小尺寸一起夹取（几何工具独立成模块）",
    js.includes("resizeCropRect") && js.includes("fitCropRatio") && js.includes("dragCropRect"));
check("index.css 有比例网格、尺寸块与裁剪按钮组",
    css.includes(".annot-crop-ratio") && css.includes(".annot-crop-ratios") &&
    css.includes("grid-template-columns: repeat(3") &&
    css.includes(".annot-crop-info") && css.includes(".annot-crop-actions"));

// v0.9.12：裁剪整块按参考插件 imgReEditor 重做，并补上真正裁掉画面的可视窗口
check("裁剪会话独立成模块（完整视图 / 累计窗口 / 最大可恢复范围）",
    js.includes("CropSession") && js.includes("fullRect") &&
    js.includes("session.bake(rect)") && js.includes("session.unchanged(rect)"));
check("底图被收进可视窗口，裁剪后框外画面不再露出",
    css.includes(".annot-viewport") && /\.annot-viewport\s*\{[^}]*overflow:\s*hidden/.test(css) &&
    js.includes('data-role="viewport"'));
check("进入裁剪时框默认铺满整张图（参考插件 getBackgroundCropBounds）",
    js.includes("框已铺满整张图"));
check("参考插件行为：有框时框外不重画、Delete 清框",
    js.includes("裁剪框已清除") && js.includes("拖四角 / 四边把框放大"));
check("框外遮罩统一 45%（参考插件 CropRect.render）",
    js.includes("rgba(0, 0, 0, 0.45)") && !js.includes("shadeAlpha"));

// v0.9.3：马赛克后面新增「模糊」，框选区域现采一片再高斯模糊
check("index.js 含模糊工具与「模糊强度」参数（模糊程度上限 40）",
    js.includes('blur: "模糊"') && js.includes("blurRadius") && js.includes("模糊程度"));
check("马赛克与模糊共用「现采位图」渲染（保存时一起烘焙进 PNG）",
    js.includes("bitmapUrl") && js.includes("BlurRenderer"));

for (const file of ["zh-CN.json", "en.json"]) {
    const text = (await read(path.join("i18n", file))).toString("utf8");
    try {
        JSON.parse(text);
        check(`i18n/${file} 是合法 JSON`, true);
    } catch (e) {
        check(`i18n/${file} 是合法 JSON`, false, String(e));
    }
}

if (await exists("icon.png")) {
    const buf = await read("icon.png");
    check("icon.png 是 PNG", buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
} else {
    check("icon.png 存在", false);
}

// ---------------------------------------------------------------- smoke test
const listeners = new Map();
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
const fakeSiyuan = {
    Plugin: FakePlugin,
    getFrontend: () => "desktop",
    showMessage: () => {},
    Dialog: class Dialog {},
};

// 模拟思源主菜单（window.siyuan.menus.menu）与插件 subMenu（detail.menu）
const mainMenuItems = [];
const subMenuItems = [];
const fakeMainMenuElement = {querySelector: () => null};
const fakeMainMenu = {
    element: fakeMainMenuElement,
    addItem: (item) => { mainMenuItems.push(item); return {}; },
    append: () => {},
};
globalThis.window = {siyuan: {menus: {menu: fakeMainMenu}}};

let pluginClass;
try {
    const moduleObj = {exports: {}};
    const exportsObj = moduleObj.exports;
    // 与思源 loader.ts 的 window.eval 包装等价
    const run = new Function("require", "module", "exports", js);
    run((key) => (key === "siyuan" ? fakeSiyuan : {}), moduleObj, exportsObj);
    pluginClass = (moduleObj.exports || exportsObj).default || moduleObj.exports;
    check("打包产物可在 CJS 包装下执行", typeof pluginClass === "function");
    check("默认导出 extends Plugin", typeof pluginClass === "function" && pluginClass.prototype instanceof FakePlugin);
} catch (e) {
    check("打包产物可在 CJS 包装下执行", false, String(e));
}

if (typeof pluginClass === "function") {
    try {
        const plugin = new pluginClass({app: {}, name: manifest.name, displayName: "勾画阁·猫抓", i18n: {}});
        plugin.onload();
        check("onload 注册 open-menu-image", listeners.has("open-menu-image"));

        const fakeImg = {getAttribute: (n) => (n === "data-src" ? "assets/demo.png" : "assets/demo.png?v=1")};
        const fakeBlock = {getAttribute: () => "202611080000000-abcdefg"};
        const fakeElement = {
            querySelector: (s) => (s === "img" ? fakeImg : null),
            closest: (s) => (s === "[data-node-id]" ? fakeBlock : null),
        };
        const detail = {
            protyle: {},
            element: fakeElement,
            menu: {addItem: (item) => subMenuItems.push(item), addSeparator: () => {}},
        };
        listeners.get("open-menu-image")?.({detail});
        const addedItem = mainMenuItems[0];
        check("右键事件注入菜单项", !!addedItem && addedItem.id === "siyuan-plugin-annotate__open", JSON.stringify(addedItem));
        check("菜单项文案为「勾画阁·猫抓 编辑」", addedItem?.label === "勾画阁·猫抓 编辑", String(addedItem?.label));
        check("菜单项位于右键菜单第一层（主菜单）", mainMenuItems.length === 1 && subMenuItems.length === 0,
            `主菜单 ${mainMenuItems.length} 项 / 插件子菜单 ${subMenuItems.length} 项`);
        check("菜单项靠前插入（index: 1）", addedItem?.index === 1, String(addedItem?.index));

        // 同一菜单重复派发事件时不应插入第二遍
        fakeMainMenuElement.querySelector = () => ({});
        listeners.get("open-menu-image")?.({detail});
        check("重复派发不产生重复菜单项", mainMenuItems.length === 1, `${mainMenuItems.length} 项`);
        fakeMainMenuElement.querySelector = () => null;

        plugin.onunload();
        check("onunload 注销监听", !listeners.has("open-menu-image"));
    } catch (e) {
        check("生命周期 smoke test 无异常", false, String(e));
    }
}

// v0.9.15：文字输入所见即所得，编辑框不再冒出白底 / 蓝框 / 阴影
check("画布内文字输入框完全透明（没有白底 / 边框 / 阴影 / 内边距）",
    /\.annot-root textarea\.annot-text-editor\s*\{[^}]*background:\s*transparent\s*!important/.test(css) &&
    /\.annot-root textarea\.annot-text-editor\s*\{[^}]*border:\s*0\s*!important/.test(css) &&
    /\.annot-root textarea\.annot-text-editor\s*\{[^}]*box-shadow:\s*none\s*!important/.test(css) &&
    /\.annot-root textarea\.annot-text-editor\s*\{[^}]*padding:\s*0\s*!important/.test(css));
check("编辑中的原文字先隐藏，避免与输入框叠成双影",
    /\.annot-object\.is-editing\s*\{\s*visibility:\s*hidden/.test(css));
check("输入文字不做反色，只让细框反色、光标按位置挑黑白",
    /\.annot-root \.annot-text-frame\s*\{[^}]*mix-blend-mode:[ ]*difference/.test(css) &&
    !/\.annot-root textarea\.annot-text-editor\s*\{[^}]*mix-blend-mode/.test(css) &&
    js.includes("contrastInk") && js.includes("caretColor"));
check("输入框没有任何占位提示（只有光标）",
    /::placeholder\s*\{[^}]*color:[ ]*transparent/.test(css) && !js.includes("placeholder"));
check("输入框允许按画布宽度自动换行（不再锁成单行）",
    js.includes('wrap = "soft"') && /white-space:[ ]*pre-wrap/.test(css));
check("文字自动换行独立成模块（排版与会话解耦）",
    js.includes("reflowTextObjects") && js.includes("layoutText") && js.includes("TEXT_LINE_HEIGHT"));

check("移动端布局与触摸手势都实现了",
    js.includes("annot-root--mobile") && js.includes("annot-mobile-rail") &&
    js.includes("touchPoints") && js.includes("pointerType"));
check("移动端只在窄屏 / 触摸环境生效，PC 仍是原来的三栏",
    js.includes("mobile-rail") && css.includes(".annot-root--mobile .annot-titlebar") &&
    js.includes("isMobileRuntime"));
check("移动端是上下双栏：上栏参数随工具变、下栏工具带文字标签",
    js.includes("mobileStyleGroups") && js.includes("annot-mobile-style__scroll") &&
    js.includes("annot-mobile-tool__label") && js.includes("renderMobileStyle"));
check("两栏都能横向滑动，工具热区够手指点（54×56）",
    /\.annot-mobile-style__scroll\s*\{[^}]*overflow-x:[ ]*auto/.test(css) &&
    /\.annot-mobile-rail__scroll\s*\{[^}]*overflow-x:[ ]*auto/.test(css) &&
    /\.annot-mobile-tool\s*\{[^}]*width:[ ]*54px/.test(css) &&
    /\.annot-mobile-tool\s*\{[^}]*min-height:[ ]*56px/.test(css));
check("移动端窗口整屏打开，顶部保存与 PC 用同一个文案「保存」",
    js.includes("annot-dialog-fullscreen") && js.includes("100vw") && js.includes("100vh") &&
    /\.b3-dialog\.annot-dialog-fullscreen\s*\{[^}]*padding:[ ]*0/.test(css) &&
    js.includes("annot-mobile-top__done") && !js.includes(">完成<"));
check("移动端把「选择」做成左下圆钮、「对齐」做成右下圆钮（不再固定在下栏里）",
    js.includes("annot-mobile-fabs") && js.includes('data-action="mobile-select"') &&
    js.includes('class="annot-fab annot-fab--align"') &&
    !js.includes("mobilePinnedTool") && !css.includes("annot-mobile-rail__pinned") &&
    /\.annot-fab\s*\{[^}]*border-radius:[ ]*50%/.test(css) &&
    /\.annot-fab\.is-active\s*\{[^}]*background:[ ]*var\(--annot-accent\)/.test(css));
check("移动端图标单独声明笔触，避免被思源全局样式填实",
    /\.annot-root \.annot-mobile-tool__icon > svg\.annot-icon\s*\{[^}]*fill:[ ]*none/.test(css) &&
    /\.annot-root \.annot-mobile-tool__icon > svg\.annot-icon\s*\{[^}]*stroke:[ ]*currentColor/.test(css));
check("移动端工具选中态＝主色浅底 + 主色文字（不再抹成透明，照片上也看得清）",
    /\.annot-mobile-tool\.is-active\s*\{[^}]*background:[ ]*var\(--annot-accent-soft\)/.test(css) &&
    /\.annot-mobile-tool\.is-active\s*\{[^}]*color:[ ]*var\(--annot-accent\)/.test(css));
check("移动端用内联样式强制全屏：外壳内边距 / 容器圆角 / 自带关闭按钮",
    js.includes("applyMobileFullscreen") &&
    js.includes('setProperty("border-radius", "0", "important")') &&
    js.includes('setProperty("width", "100vw", "important")') &&
    js.includes(".b3-dialog__close") &&
    /\.b3-dialog\.annot-dialog-fullscreen[\s\S]{0,400}border-radius:[ ]*0 !important/.test(css));
check("移动端把属性面板做成底部抽屉、缩放比例显示在顶栏胶囊里",
    /\.annot-root--mobile \.annot-sidebar\s*\{[^}]*transform:[ ]*translateY/.test(css) &&
    js.includes("mobile-zoom") && js.includes("mobile-count") &&
    // 常用参数已在上栏，选中对象不再自动弹抽屉
    js.includes("mobileSheetOpen"));

// ---------------------------------------------------------------- SHA256
async function listFiles(dir, prefix = "") {
    const out = [];
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) out.push(...await listFiles(path.join(dir, entry.name), rel));
        else out.push(rel);
    }
    return out.sort();
}
const hashLines = [];
for (const rel of await listFiles(target)) {
    const buf = await readFile(path.join(target, rel));
    hashLines.push(`${createHash("sha256").update(buf).digest("hex")}  ${rel.replace(/\\/g, "/")}`);
}

// ---- v0.12.0 PC 界面重构 ----
check("PC 绘图工具移到左侧竖栏，顶部只放通用属性（含线条样式）；「属性」二字已去掉",
    js.includes("annot-imagebar__tools") && js.includes('"group-lines"') &&
    !js.includes("annot-toolbar__label") && css.includes(".annot-imagebar__sep"));
check("顶栏五个分组都带小标题（颜色 / 粗细 / 线型 / 填充 / 字号）",
    ["颜色", "粗细", "线型", "填充", "字号"].every((label) =>
        js.includes(`<span class="annot-group__label">${label}</span>`)));
check("画布悬浮条按工具显示参数，箭头有类型下拉 + 端点图标 + 圆线开关",
    js.includes("renderContextBar") && js.includes("arrow-type-toggle") && js.includes("arrow-picker-toggle") &&
    ["rhombus", "classic", "basic", "open", "circle"].every((k) => js.includes(k)) &&
    js.includes("annot-arrow-style-icon") && js.includes("ARROW_HEAD_ICONS") &&
    js.includes("arrow-rounded") && js.includes("setArrowRounded") &&
    css.includes(".annot-arrow-picker__button") && css.includes(".annot-context__toggle"));
check("右侧面板分对象 / 层级 / 属性三区块，折叠与职责各归其位",
    js.includes('data-section="layers"') && js.includes("onReorder") &&
    js.includes("toggle-section") && css.includes(".annot-side-handle") &&
    css.includes(".annot-side-section.is-folded") &&
    js.includes("annot-layer-controls") && js.includes("layer-bottom") &&
    !js.includes('data-role="layer-item"') && js.includes("annot-object-item__actions") &&
    !js.includes("annot-object-actions"));
check("复制 / 删除改用用户给定的纯线条镂空 SVG（fill=none + currentColor）",
    js.includes("M13 12.4316") && js.includes("M29.6567 18.3432") &&
    js.includes("annot-prop-icon-btn") && js.includes('fill="none"') &&
    css.includes("fill: none !important"));
check("移动端仍隐藏 PC 的悬浮条 / 拉手，层级四按钮在抽屉里可用",
    css.includes(".annot-root--mobile .annot-context-bar") &&
    css.includes(".annot-root--mobile .annot-side-handle") &&
    css.includes('.annot-root--mobile .annot-side-section[data-section="layers"]') &&
    !/\.annot-root--mobile \.annot-side-section\[data-section="layers"\][^{]*\{[^}]*display: none/.test(css));

// ---- v0.12.1：本轮五处修复 ----
check("左侧工具栏默认单列，高度不够自动切成双列",
    js.includes("syncToolColumns") && js.includes("is-two-col") &&
    js.includes("ResizeObserver") && css.includes(".annot-imagebar.is-two-col") &&
    css.includes("grid-template-columns: repeat(2, 34px)") &&
    /\.annot-imagebar__group \{[^}]*flex-direction: column/.test(css));
check("折叠拉手相对插件容器用 absolute，不再用 fixed",
    /\.annot-sidebar\.is-collapsed \.annot-side-handle \{[^}]*position: absolute/.test(css) &&
    !/\.annot-sidebar\.is-collapsed \.annot-side-handle \{[^}]*position: fixed/.test(css));
check("层级栏目只留四个按钮，对象栏目承担拖拽与复制删除",
    js.includes('data-action="layer-top"') && js.includes('data-action="layer-bottom"') &&
    js.includes("annot-object-item__actions") && js.includes("item.draggable = true") &&
    !js.includes("annot-layer-item") && !js.includes("annot-prop-actions") &&
    !js.includes("annot-layer-row"));
check("保留「两端竖线」与「竖线双头」，且中间连接线与竖线不再有空隙",
    js.includes("barDouble") && js.includes("annot-bar") &&
    js.includes("function arrowShaftPath") && js.includes("function arrowBars") &&
    !js.includes("shrinkStart"));
const arrowIconSrc = await readFile(path.join(root, "src/editor/icons.ts"), "utf8");
const editorSrcEarly = await readFile(path.join(root, "src/editor/AnnotEditor.ts"), "utf8");
const shapesSrc = await readFile(path.join(root, "src/editor/shapes.ts"), "utf8");
const shapesSrcEarly = shapesSrc;
check("方点已并入菱形端点，不再单独画旋转方块",
    !shapesSrcEarly.includes("const tipAngle") &&
    shapesSrcEarly.includes("numberHeadOf"));

check("类型下拉用整条长箭头（与画布同源），样式格用手绘短图标",
    arrowIconSrc.includes("ARROW_TYPE_ICONS") &&
    arrowIconSrc.includes('arrowStyleIcon({type: "single", head: "classic"})') &&
    arrowIconSrc.includes('arrowStyleIcon({type: "modern", head: "basic"})') &&
    // 样式格是另一套手绘短图，别和类型共用
    arrowIconSrc.includes("const arrowGlyph") && arrowIconSrc.includes('viewBox="0 0 40 24"') &&
    // 样式格的杆伸进头部内部（燕尾那条穿到 26）
    arrowIconSrc.includes("M6 12H26") && arrowIconSrc.includes("M6 12H24") &&
    !arrowIconSrc.includes("ARROW_TYPE_ICONS: Record<ArrowType, string> = {\n    single: arrowGlyph"));
check("箭头工具每个格子都是纯图案 + 提示文字，复制删除图标每个 path 都镂空",
    js.includes("ARROW_HEAD_ICONS[item.key]") && js.includes("ARROW_TYPE_ICONS[item.key]") &&
    js.includes("annot-arrow-chip") &&
    js.includes('<path fill="none" d="M13 12.4316') && js.includes('<path fill="none" d="M29.6567'));

// ---- v0.12.2：对象行末按钮 + 去掉「选中对象」行 + 层级栏目紧凑 ----
check("复制 / 删除直接放在每个对象行末，各带自己的对象编号",
    js.includes("annot-object-item__actions") && js.includes('duplicate.dataset.id = object.id') &&
    js.includes('remove.dataset.id = object.id'));
check("对象行不再重复显示类型名称，也不再有底部「选中对象」操作行",
    !js.includes("annot-object-item__type") && !js.includes("annot-object-actions") &&
    !js.includes("annot-object-actions__label") && !css.includes(".annot-object-actions"));
check("层级栏目只占一行，属性栏目吃掉剩余空间（不再三等分留半屏空白）",
    /\.annot-side-section\[data-section="layers"\] \{[^}]*flex: 0 0 auto/.test(css) &&
    /\.annot-side-section\[data-section="props"\] \{[^}]*flex: 1 1 auto/.test(css) &&
    /\.annot-side-section\[data-section="objects"\] \{[^}]*flex: 0 1 auto/.test(css));
check("从对象行按钮上按下不会误触发拖拽排序",
    /addEventListener\("dragstart"[\s\S]{0,400}?"button"[\s\S]{0,80}?return/.test(js));

// ---- v0.13.x：ShareX 箭头样式 + 自定义下拉 + 圆角开关 + 竖线无缝 ----
check("箭头类型四种、端点五种齐全，旧扁平键仍能解析",
    ["single", "double", "modern", "bar"].every((k) => js.includes(`"${k}"`)) &&
    ["basic", "classic", "open", "rhombus", "circle"].every((k) => js.includes(`"${k}"`)) &&
    js.includes("ARROW_STYLE_KEYS") && js.includes("normalizeArrowStyle") &&
    js.includes("LEGACY_KINDS"));
check("旧图里的 single / gradient / outline 会映射到新的类型+端点，不会画出空箭头",
    js.includes("LEGACY_KINDS") &&
    js.includes("gradient") && js.includes("outline") && js.includes("barDouble") &&
    // 映射表里给的都是「类型 + 端点」的组合，而不是空对象
    js.includes('head: "classic"') && js.includes('head: "open"'));
check("燕尾用内凹背弧，尖尾用从尾部张开的楔形杆",
    js.includes("Q ${fmt(ctrl)}") && js.includes("Math.PI / 5.14") &&
    js.includes("classicHead") && js.includes("modernCurvedShaft") &&
    js.includes("modernStraightShaft") && js.includes("MODERN_BASE_RATIO"));
check("箭头头部轮廓按线宽描边，尖端不会露出一截线头（ShareX 同款 Path）",
    /class: "annot-head"/.test(js) && js.includes('"stroke-width": lineWidth') &&
    // 画布上的描边不能乘一个小于 1 的系数（热区那种放大是另一回事）
    !/"stroke-width": lineWidth \* 0\./.test(js));
check("关闭圆角时燕尾尖角不被截平：miter limit 取 ShareX 的 10（SVG 默认 4 会削成平头）",
    js.includes('"stroke-miterlimit": 10') && js.includes("stroke-linejoin"));
check("两端竖线加箭头时按 miter 溢出量内缩，尖头不会戳出竖线",
    js.includes("function arrowTipMiterInset") &&
    /kind\.type === "bar" && kind\.head !== "none"/.test(js) &&
    js.includes("arrowTipMiterInset(kind.head, lineWidth)"));
check("悬浮条是两个自定义下拉（类型 + 样式），不再是原生 select",
    !js.includes('data-action="arrow-style-select"') && !js.includes("annot-context__select") &&
    js.includes('"arrow-type-toggle"') && js.includes('"arrow-picker-toggle"') &&
    js.includes('"arrow-type-pick"') && js.includes('"arrow-style-pick"') &&
    js.includes("arrow-type-picker") && js.includes("annot-arrow-picker__item-label"))
;
check("下拉里的图案与画布上的箭头同源（同一套 arrowShape 几何）",
    js.includes("function arrowPreview") && js.includes("function arrowStyleIcon") &&
    !js.includes("const HEAD_R ="));
check("圆角开关同时作用于线端与折角，并写进对象 / 当前样式",
    js.includes("arrowRounded") && js.includes("linecap = rounded") &&
    js.includes("linejoin = rounded") && js.includes("stroke-linejoin"));
check("箭头样式与矩形圆角同一套逻辑：选中就改这一支，没选中才改默认值",
    !js.includes("lastDrawnId") && !js.includes("styleTarget") &&
    /setArrowStyle\([\s\S]{0,420}?this\.getObject\(this\.selectedId\)/.test(js) &&
    /setArrowRounded\([\s\S]{0,420}?this\.getObject\(this\.selectedId\)/.test(js));

// ---- v0.13.3：矩形圆角（参考 ShareX 的 CornerRadius） ----
check("矩形按 ShareX 的 CornerRadius 渲染：rx = ry，四个角同半径",
    js.includes("function rectCornerRadius") && /rx: radius,\s*ry: radius/.test(js));
check("圆角超过半边长时自动截断（矩形再小也不会画出畸形）",
    js.includes("Math.min(radius, Math.abs(geometry.width) / 2"));
check("圆角档位与 ShareX 一致：0/2/4/6/8/10/15/20/25/30",
    js.includes("CORNER_RADIUS_OPTIONS = [0, 2, 4, 6, 8, 10, 15, 20, 25, 30]"));
check("圆角只对矩形生效，椭圆 / 其它工具不显示这个控件",
    js.includes('type === "rect"') && js.includes('cornerRadius: type === "rect" ? current.cornerRadius : 0'));
check("悬浮条上的圆角控件是「数值 + 图案 + 折角箭头」的下拉，展开为图案网格",
    js.includes('data-role="corner-picker"') && js.includes('data-action="corner-picker-toggle"') &&
    js.includes('data-action="corner-radius-pick"') && js.includes("annot-corner-picker__item-label") &&
    js.includes("cornerRadiusIcon"));
check("圆角图案与档位同源（同一套 cornerPreviewRadius 映射，0 档是直角）",
    js.includes("function cornerRadiusIcon") && js.includes("function cornerPreviewRadius") &&
    js.includes("M3 17 L3 3 L17 3"));
check("圆角写进对象样式并随「当前样式」持久化",
    js.includes("object.style.cornerRadius = radius") && js.includes("cornerRadius: style.cornerRadius"));
check("圆角样式齐全：按钮 / 下拉网格 / 选中态",
    css.includes(".annot-corner-picker__button") && css.includes(".annot-corner-picker__menu") &&
    css.includes("grid-template-columns: repeat(5, 36px)") &&
    css.includes(".annot-corner-picker__item.is-active"));
// 思源 util/_reset.scss 里的 svg { fill: currentColor } 会把只有描边的图标填成实心块。
// 圆角档位图案与下拉折角都踩过这个坑，这里同时守住「元素自带 fill」和「作用域兜底规则」两层。
check("圆角档位图案是纯线条：path 自己声明 fill=\"none\"",
    js.includes('<path fill="none" d="${d}"/>'));
check("下拉折角箭头自己声明 fill=\"none\"（不会被填成实心三角）",
    js.includes('<path fill="none" d="M12 19 L24 31 L36 19"/>'));
check("线性图标在插件作用域内统一兜底：默认 fill:none，只有标了 currentColor 的才填色",
    /\.annot-root svg\.annot-icon,\s*\.annot-root svg\.annot-corner-icon,\s*\.annot-root svg\.annot-chevron,\s*\.annot-root svg\.annot-arrow-style-icon\s*\{[^}]*fill: none/.test(css) &&
    /\.annot-root svg\.annot-icon \[fill="currentColor"\][^{]*\{[^}]*fill: currentColor/.test(css));

// ---- v0.14.0：箭头样式排序 / 属性栏加档 / 点划线 / 画线圆线端 / 颜色预设 ----
const arrowStylesSrc = await readFile(path.join(root, "src/editor/arrowStyles.ts"), "utf8");
check("端点的显示顺序是 无 → 基础 → 燕尾 → 开放 → 菱形 → 圆形",
    (() => {
        const i = arrowStylesSrc.indexOf("export const ARROW_HEADS");
        const block = arrowStylesSrc.slice(i, i + 300);
        return ["HEAD_NONE", "HEAD_BASIC", "HEAD_CLASSIC", "HEAD_OPEN", "HEAD_RHOMBUS", "HEAD_CIRCLE"]
            .every((name, idx, arr) => idx === 0 || block.indexOf(arr[idx - 1]) < block.indexOf(name));
    })(), "顺序不对");
check("默认箭头仍是「经典」（排序只影响显示，不改默认外观）",
    js.includes('arrowStyle: "classic"'));
check("箭头悬浮条的圆润开关改叫「圆线」，与画线用同一个词",
    js.includes('title="线端与折角是否圆润：开了是圆线，关掉是方头尖角">圆线</button>') &&
    !js.includes("箭头端点与折角是否圆润"));
check("线宽 / 填充 / 字号各多一档，最后一档更粗 / 更实 / 更大",
    js.includes("lineWidths: [2, 4, 8, 14]") &&
    js.includes("fillOpacities: [0, 0.15, 0.5, 0.85]") &&
    js.includes("fontSizes: [18, 28, 42, 64]"));
check("老用户的三档默认值会升级成四档（只有从没改过预设时才升级）",
    js.includes("LEGACY_DEFAULT_PRESETS") && js.includes("sameNumbers"));
check("线型里的「中心线」按「长划—点—长划」四段节奏渲染，且留空可调",
    js.includes('key: "dashdot", label: "中心线"') &&
    js.includes('dash === "dashdot"') &&
    /Math\.max\(0\.01, lineWidth \* 0\.01\)/.test(js) &&
    /style\.lineDashGap\)\s*!=\s*null\s*\?\s*\w+\s*:\s*6/.test(js));
check("点划线的「点」用圆头画出来（方头会让点消失）",
    js.includes('dash === "dotted" || dash === "dashdot" ? "round" : "butt"') ||
    /dash === "dotted" \|\| dash === "dashdot"[\s\S]{0,60}?"round"/.test(js));
check("画线新增悬浮条与「圆线」开关（选中就改这一支，没选中改默认值）",
    js.includes('data-action="line-round"') && js.includes("function setLineRound") === false &&
    /setLineRound\([\s\S]{0,420}?this\.getObject\(this\.selectedId\)/.test(js));
check("关掉圆线时线端是方头（cap: butt + join: miter），缺省仍是圆头",
    js.includes('"stroke-linecap": roundEnd ? "round" : "butt"') &&
    js.includes('"stroke-linejoin": roundEnd ? "round" : "miter"') &&
    /lineRound:\s*type === "line" \? current\.lineRound/.test(js));
check("lineRound 随「当前样式」持久化，旧记录缺省视为开启",
    js.includes("lineRound: style.lineRound") && js.includes("lineRound: parsed.lineRound !== false"));
check("PC 自定义颜色是带十字的圆球（不再是原生 input）",
    js.includes("annot-custom-color__cross") && js.includes("data-action=\"color-pop-toggle\"") &&
    js.includes("--annot-ball"));
check("圆球十字按球面色自动取黑 / 白，取色后仍然看得出是自定义色",
    js.includes("--annot-ball-ink") && js.includes("pickBadgeTextColor(hex)"));
check("取色弹窗改成色轮：色轮宿主 + 保存到预设 + 预设区",
    js.includes('data-role="color-wheel"') && js.includes('data-action="color-save"') &&
    js.includes('data-role="color-presets"') &&
    js.includes("new ColorWheel(") &&
    !js.includes('data-role="color-pop-input"') && !js.includes('data-role="color-pop-hex"'));
check("色轮接进全部取色入口：顶栏圆球 / 预设色点 / 属性面板 / 移动端 / 底色",
    js.includes('data-action="color-pop-toggle"') &&
    js.includes('data-role="slot-wheel"') &&
    js.includes('data-action="color-open-prop"') &&
    js.includes('data-action="mobile-color"') &&
    js.includes('kind: "extend-bg"') &&
    js.includes("new ColorWheel("));
check("色轮组件带 HEX / RGB 切换与中文读数，色环用 closest-side 遮罩挖空",
    js.includes("annot-cw__seg") && js.includes("annot-cw__cell") &&
    js.includes("色相（H）") && js.includes("浓度（S）") && js.includes("明度（V）") &&
    css.includes("conic-gradient") && css.includes("closest-side"));
check("颜色预设支持保存 / 应用 / 删除 / 拖动排序，并落在独立存储键",
    js.includes("siyuan-plugin-annotate:colors") && js.includes("addSavedColor") &&
    js.includes("removeSavedColor") && js.includes("colorPresetIndexAt") &&
    js.includes("splice(from"));
check("颜色预设最多 12 个，重复颜色不会重复入列",
    js.includes("MAX_SAVED_COLORS = 12"));
check("颜色圆球与弹窗样式齐全（十字 / 选中圈 / 拖动态 / 删除按钮）",
    css.includes(".annot-custom-color__cross") && css.includes(".annot-color-pop__presets") &&
    css.includes(".annot-color-preset.is-dragging") && css.includes(".annot-color-preset__remove") &&
    css.includes(".annot-color-pop__well"));

// ---- v0.15.0：悬浮条基座（选择 / 平移）+ 序号专属参数 ----
check("悬浮条最左侧常驻「选择」「平移」两个按钮（同一份 CONTEXT_TOOLS）",
    js.includes("CONTEXT_TOOLS") && js.includes('tool: "select"') && js.includes('tool: "pan"') &&
    js.includes("annot-context__base"));
check("左侧竖栏不再放「选择」，只留绘图工具",
    /TOOL_ITEMS\.filter\(\s*\(item\)\s*=>\s*item\.tool !== "select"\)/.test(js));
check("平移成为正式工具（ToolType 含 pan），有说明文案与快捷键 H",
    js.includes('pan: "平移：按住拖动整张画布') && js.includes('key === "h"') &&
    js.includes('this.setTool("pan")'));
check("平移复用既有的空格 / 中键拖动逻辑，并拦在绘制之前",
    js.includes('const panTool = this.activeTool === "pan"') &&
    /if \(this\.activeTool === "pan"\) return;/.test(js));
check("平移时画布是抓手光标，按住变握拳",
    css.includes('.annot-svg[data-active-tool="pan"]') && css.includes("cursor: grab") &&
    css.includes('.annot-svg[data-active-tool="pan"].is-panning') && css.includes("cursor: grabbing"));
check("悬浮条样式齐全：基座 / 分隔线 / 小方块按钮 / 高亮",
    css.includes(".annot-context__base") && css.includes(".annot-context__sep") &&
    css.includes(".annot-context__tool.is-active") && css.includes(".annot-context__chip.is-active") &&
    /annot-context-bar \{[^}]*flex-wrap: wrap/.test(css));
check("序号编号格式 5 种：阿拉伯 / 罗马 / 小写 / 大写 / 中文",
    js.includes("NUMBER_FORMATS") && js.includes('key: "arabic"') && js.includes('key: "roman"') &&
    js.includes('key: "alphaLower"') && js.includes('key: "alphaUpper"') && js.includes('key: "chinese"'));
check("罗马数字与中文数字都是数值换算出来的，不是写死的表",
    js.includes("function formatNumber") && js.includes("ROMAN_TABLE") && js.includes("CN_DIGITS"));
const tipKeys = ((js.match(/NUMBER_TIPS = \[([\s\S]*?)\];/) || [])[1] || "")
    .match(/key: "([a-zA-Z]+)"/g) || [];
check("序号引线末端只有箭头 / 圆点 / 方点三种（没有双头与竖线）",
    tipKeys.join(",") === 'key: "arrow",key: "dot",key: "square"', tipKeys.join(","));
check("序号引线箭头直接复用 arrowShape（与箭头工具同一套几何，不再自拼三角形）",
    /arrowShape\(\{\.\.\.lead\}, \{type: "single", head: arrowHead\}, lineWidth\)/.test(shapesSrcEarly) &&
    !js.includes("function numberLeader(n: NumberGeometry, color: string, lineWidth: number)"));
check("序号引线头部按线宽描边 + miterlimit 10（尖端不会露出线头）",
    /numberLeader[\s\S]{0,1600}?"stroke-miterlimit": 10/.test(js));
check("序号引线的圆点 / 方点已并入端点样式，不再单独画标记",
    !js.includes("const size = Math.max(4, lineWidth * 2)") &&
    js.includes("numberHeadOf") && js.includes("rotation"));
check("编号格式与端点都落在对象上（格式存 geometry，端点存 style），可持久化",
    js.includes("format = this.current.numberFormat") &&
    /numberTip: *type === "number" \? current\.numberTip/.test(js) &&
    js.includes("numberFormat: style.numberFormat") && js.includes("numberTip: style.numberTip"));
check("序号悬浮条：编号格式下拉 + 端点下拉常显 + 末尾的圆线开关，端点三选一已取消",
    js.includes('data-action="number-format-toggle"') &&
    js.includes('data-action="number-format-pick"') &&
    js.includes('data-action="number-style-toggle"') &&
    js.includes('data-action="number-style-pick"') &&
    !js.includes('data-action="number-tip"') &&
    js.includes('data-action="number-round-toggle"'));
check("序号文字按格式显示，多字符时字号自动收小（不撑出圆点）",
    /formatNumber\(n\.number,/.test(js) && js.includes("numberTextScale(badgeText)"));
check("序号也参与「圆线」开关与属性面板标签",
    /setArrowRounded\(enabled\)[\s\S]{0,260}?=== "number"/.test(js) &&
    js.includes("序号 ${formatNumber("));
check("v1.2.0-alpha.7：手机端编号 / 样式 / 端点都在顶部悬浮栏（不再挤在第二行）",
    js.includes('"numberFormat"') && js.includes('"numberTip"') && js.includes('"numberBubble"') &&
    js.includes('number-leader-toggle') && js.includes('number-round-toggle') &&
    !js.includes('data-group="numbers"'));

// ---- v0.16.0：顶栏按钮换位 / 文案 / 全屏 ----
check("顶栏顺序：取消在左、保存在右，全屏按钮排最右",
    /data-action="close"[\s\S]{0,320}?data-action="save"[\s\S]{0,320}?data-action="fullscreen"/.test(js) &&
    !/data-action="save"[\s\S]{0,200}?data-action="close"/.test(js));
const zhI18n = JSON.parse((await read("i18n/zh-CN.json")).toString("utf8"));
check("按钮文案：关闭→取消、保存并关闭→保存（i18n 与代码兜底一起改）",
    zhI18n.close === "取消" && zhI18n.save === "保存" &&
    js.includes('this.t("save", "保存")') && js.includes('this.t("close", "取消")') &&
    !js.includes("保存并关闭"));
check("全屏按钮用用户给的图标（四角向外 9 段 / 四角向内 1 段，均为 currentColor）",
    js.includes("FULLSCREEN_ICON") && js.includes("RESTORE_ICON") &&
    ((js.match(/FULLSCREEN_PATHS = '([\s\S]*?)';/) || [])[1] || "").includes("M41.909959 682.266194"));
check("全屏把对话框外壳逐层撑满（100vw / 100dvh、去圆角与阴影）",
    js.includes("applyFullscreenStyles(element)") &&
    js.includes('el.style.setProperty("width", "100vw", "important")') &&
    js.includes('el.style.setProperty("height", dvhOk ? "100dvh" : "100vh", "important")') &&
    js.includes('el.style.setProperty("border-radius", "0", "important")'));
check("全屏与还原可反复切换：切换前快照内联样式，还原时原样写回",
    js.includes("fullscreenBackup") &&
    /fullscreenBackup = \[shell, container, body\]/.test(js) &&
    /restoreFullscreenStyles[\s\S]{0,320}?removeAttribute\("style"\)/.test(js));
check("全屏后主动重新适应窗口（fitView），画布不会被拉伸或跑偏",
    /scheduleFullscreenRefit[\s\S]{0,520}?this\.fitView\(\)/.test(js) &&
    js.includes("toggleFullscreen") && js.includes("scheduleFullscreenRefit()"));
check("全屏按钮在切换后换图标 / 提示 / aria-pressed，并给根节点打标记",
    /button\.innerHTML = on \? RESTORE_ICON : FULLSCREEN_ICON/.test(js) &&
    js.includes('classList.toggle("is-fullscreen", on)') &&
    js.includes('setAttribute("aria-pressed", String(on))'));
check("手机端不参与全屏开关（本来就是整屏）",
    /toggleFullscreen\(force\)[\s\S]{0,200}?if \(this\.mobile\) return;/.test(js));
check("全屏按钮样式：贴住「保存」右侧，全屏时高亮",
    css.includes(".annot-titlebar__fullscreen") &&
    css.includes(".annot-root.is-fullscreen .annot-titlebar__fullscreen.is-active"));

// ---- v0.17.0：分割线按需 / 序号下拉 / 全屏遮挡 ----
check("悬浮条分割线只在右边真有参数时才拼上去（选择 / 平移时只剩两颗按钮）",
    (js.match(/annot-context__sep/g) || []).length === 1 &&
    /const rest = html && this\.selectedIds\.length < 2 \? `[^`]*annot-context__sep[^`]*` \+ html : "";/.test(js) &&
    /bar\.innerHTML = base \+ alignPanel \+ rest;/.test(js));
check("平移工具不再显示提示文字，与「选择」一样只留两颗常驻按钮",
    /if \(this\.activeTool === "pan"\) \{[\s\S]{0,200}?html = "";/.test(js) &&
    !js.includes("按住鼠标拖动＝平移整张画布"));
check("编号格式改成下拉框：按钮 + 5 个选项（data-action 成对存在）",
    js.includes('data-action="number-format-toggle"') &&
    js.includes('data-action="number-format-pick"') &&
    /NUMBER_FORMATS = \[[\s\S]{0,700}?short: "阿拉伯数字"[\s\S]{0,700}?short: "中文数字"/.test(js));
check("编号格式的五个选项各自带一个「样子」小标（1 / I / a / A / 一）",
    js.includes('chip: "1"') && js.includes('chip: "I"') && js.includes('chip: "a"') &&
    js.includes('chip: "A"') && js.includes('chip: "一"'));
check("端点下拉一直显示（不再依赖「端点=箭头」），五项与箭头工具同源",
    js.includes('data-role="number-style-picker"') &&
    /const tipBlock = `<span class="annot-context__title">端点<\/span>` \+\s*`<div class="annot-arrow-picker/.test(editorSrcEarly) &&
    /ARROW_HEAD_ICONS\[item\.key\]/.test(js));
check("两个序号下拉互斥：打开一个会自动收起另一个",
    /toggleNumberFormatPicker\(force\)[\s\S]{0,220}?this\.numberStyleOpen = false/.test(js) &&
    /toggleNumberStylePicker\(force\)[\s\S]{0,220}?this\.numberFormatOpen = false/.test(js));
check("序号引线的端点跟着对象走（numberArrowHead，同时写一份旧字段）",
    js.includes("numberArrowHead") &&
    /setNumberArrowHead\(head\)[\s\S]{0,700}?object\.style\.numberArrowHead = key/.test(js) &&
    /object\.style\.numberArrowStyle = legacy/.test(js));
check("全屏层级压过思源原生 UI：极值 z-index（2147483647）+ fixed + 四边贴 0",
    js.includes('const TOP_Z = "2147483647"') &&
    js.includes('setProperty("z-index", TOP_Z, "important")') &&
    js.includes('shell.style.setProperty("position", "fixed", "important")') &&
    js.includes('shell.style.setProperty("top", "0", "important")') &&
    js.includes('shell.style.setProperty("bottom", "0", "important")') &&
    js.includes('shell.style.setProperty("isolation", "isolate", "important")'));
// v0.20.1：Windows 上那三个原生按钮是 Electron 的窗口控制浮层，不在 DOM 里，
// 光靠 z-index 永远盖不住，必须让窗口本身进系统全屏才会被 Chromium 撤掉
check("全屏时让思源窗口进系统全屏（原生最小化/最大化/关闭 被整块撤掉）",
    js.includes("enterNativeFullscreen") &&
    js.includes('doc.requestFullscreen({ navigationUI: "hide" })') &&
    /enterNativeFullscreen[\s\S]{0,420}?classList\.contains\("body--fullscreen"\)/.test(js) &&
    js.includes("this.nativeFullscreen = true"));
check("还原 / 关窗时一定退出系统全屏，不留思源卡在全屏",
    js.includes("leaveNativeFullscreen") &&
    js.includes("document.exitFullscreen()") &&
    /finish\(\)[\s\S]{0,320}?this\.leaveNativeFullscreen\(\)/.test(js));
check("用户按 Esc 撤掉系统全屏时界面跟着还原（监听 fullscreenchange）",
    js.includes('document.addEventListener("fullscreenchange", this.handleFullscreenChange)') &&
    js.includes('document.removeEventListener("fullscreenchange", this.handleFullscreenChange)') &&
    /handleFullscreenChange = \(\) => \{[\s\S]{0,220}?this\.toggleFullscreen\(false\)/.test(js));
check("全屏期间给 <html> 打 annot-fs 标记，退出时整块移除（零残留）",
    js.includes('document.documentElement.classList.toggle("annot-fs", on)') &&
    js.includes('document.documentElement.classList.remove("annot-fs")') &&
    /html\.annot-fs #minWindow[\s\S]{0,220}?display: none !important/.test(css));
check("全屏时顶栏不再单独内收（那三个原生按钮全屏本来就不存在，不必让位）",
    !/\.annot-root\.is-fullscreen \.annot-titlebar[\s,{]/.test(css) &&
    !/\.annot-root\.is-fullscreen \.annot-titlebar__fullscreen \{/.test(css) &&
    // 系统全屏这条路还在：它负责让 Chromium 把原生按钮浮层整个撤掉
    js.includes("requestFullscreen") &&
    js.includes("annot-fs"));
check("顶栏右侧不再为原生窗口按钮预留宽度（那三个按钮全屏时本来就不该出现）",
    !js.includes("avoidNativeControls") &&
    !js.includes("--annot-fs-safe-right") &&
    !css.includes("--annot-fs-safe-right"));
check("全屏时容器与内容区也真正铺满（100vw / 100dvh、inset 0、min 尺寸归零）",
    js.includes('el.style.setProperty("inset", "0", "important")') &&
    js.includes('el.style.setProperty("min-width", "0", "important")') &&
    js.includes('el.style.setProperty("min-height", "0", "important")'));
check("序号下拉的样式齐全（文字列宽度 + 样子小标）",
    css.includes(".annot-picker--text .annot-arrow-picker__button") &&
    css.includes(".annot-arrow-picker__icon--chip"));

// ---- v0.18.0：聚光灯 / 放大镜 ----
const srcTypes = await readFile(path.join(root, "src/types.ts"), "utf8");
const srcMagnifierFile = await readFile(path.join(root, "src/editor/magnifier.ts"), "utf8");
const srcPreviewFile = await readFile(path.join(root, "src/editor/preview.ts"), "utf8");
check("两种新类型进了数据模型与中文名",
    /\| "spotlight"\s*\| "magnifier"/.test(srcTypes) &&
    srcTypes.includes('spotlight: "聚光灯"') && srcTypes.includes('magnifier: "放大镜"') &&
    srcTypes.includes("interface SpotlightGeometry") && srcTypes.includes("interface MagnifierGeometry"));
check("放大镜的锚点/倍数存在几何里，和显示框解耦",
    /interface MagnifierGeometry[\s\S]{0,420}?anchor: Point;[\s\S]{0,200}?zoom: number;/.test(srcTypes));
check("工具栏注册了聚光灯与放大镜（含快捷键 P / G）",
    js.includes('tool: "spotlight", label: "聚光灯", key: "p"') &&
    js.includes('tool: "magnifier", label: "放大镜", key: "g"') &&
    js.includes("spotlight: \"聚光灯：按住拖出要照亮的一块") &&
    js.includes("magnifier: \"放大镜：按住拖出显示框"));
check("聚光灯图标换成用户给的 1024 实心灯头原稿（currentColor，不再是描边取景框）",
    js.includes("SPOTLIGHT_1024") && js.includes("M705.4336 316.2112") &&
    /sourceIcon\(SPOTLIGHT_1024, "0 0 1024 1024"\)/.test(js) &&
    !js.includes("M345.6 1024H136.533333") && !js.includes("M512 512m-187.733333") &&
    /const sourceIcon = [\s\S]{0,200}?fill="currentColor"/.test(js));
check("扩展画布图标换成用户给的 1024 嵌套方框原稿（currentColor）",
    js.includes("EXTEND_1024") && js.includes("M320 864v96H64v-256h96V320H64V64h256v96h384V64h256v256h-96v384h96v256h-256v-96H320z") &&
    /extend: sourceIcon\(EXTEND_1024, "0 0 1024 1024"\)/.test(js));
check("放大镜图标是用户给的 48 视图十字镜（四段描边、currentColor）",
    js.includes("M33.2216 33.2217L41.7069 41.707") &&
    js.includes("M15.0156 21.0156L27 21") &&
    /magnifier: wrap\([\s\S]{0,900}?stroke="currentColor"/.test(js));
check("聚光灯：一块远大于画布的遮罩 + evenodd 挖洞，暗度取 style.spotlightOpacity",
    js.includes('const outer = "M-20000 -20000H20000V20000H-20000Z"') &&
    js.includes('"fill-rule": "evenodd"') &&
    /style\.spotlightOpacity\)[\s\S]{0,40}?: 0\.6/.test(js) &&
    js.includes("rgba(${ink}, ${darkness})"));
check("聚光灯遮罩支持黑 / 白两种颜色（白色＝磨砂高亮）",
    srcTypes.includes('spotlightColor?: "black" | "white"') &&
    /spotlightColor === "white" \? "255, 255, 255" : "0, 0, 0"/.test(js) &&
    /spotlightColor: type === "spotlight" \? current\.spotlightColor : (undefined|void 0)/.test(js));
check("聚光灯悬浮条有「黑色 / 白色」两颗按钮，动作 spotlight-color 可当场切换",
    js.includes("SPOTLIGHT_COLORS") &&
    js.includes('data-action="spotlight-color"') &&
    /setSpotlightColor\(color\)[\s\S]{0,520}?object\.style\.spotlightColor = color/.test(js));
check("放大镜拖拽支持 Shift：X / Y 位移取同一绝对值（正方形 / 正圆）",
    /const side = Math\.max\(Math\.abs\(dx\), Math\.abs\(dy\)\)/.test(js) &&
    /m\.width = Math\.abs\(dx\);[\s\S]{0,80}?m\.height = Math\.abs\(dy\)/.test(js));
check("Shift 在拖拽中途按下 / 松开也能实时切换（监听 keydown + keyup 就地重算）",
    /const syncDraftShift = \(event\)[\s\S]{0,620}?this\.updateDraft\(this\.draft, this\.drag\.start, this\.draftPointer, event\.type === "keydown"\)/.test(js) &&
    js.includes('document.addEventListener("keydown", syncDraftShift') &&
    js.includes('document.addEventListener("keyup", syncDraftShift'));
// v0.20.2：Shift 约束补齐（箭头 / 矩形 / 椭圆 / 聚光灯）；画线与放大镜的算法一个字都没动
check("箭头拖拽支持 Shift：与画线同一套 snapDirection（水平 / 垂直 / 45°）",
    /a\.end = shift \? snapDirection\(a\.start, current\) : \{ \.\.\.current \}/.test(js));
check("矩形 / 聚光灯拖拽支持 Shift：宽高取同一值（正方形 / 正圆洞口）",
    /case "rect":[\s\S]{0,60}?case "spotlight": \{\s*const r = g;\s*if \(shift\) \{\s*const side = Math\.max\(Math\.abs\(current\.x - start\.x\), Math\.abs\(current\.y - start\.y\)\)/.test(js) &&
    /r\.x = current\.x < start\.x \? start\.x - side : start\.x;[\s\S]{0,200}?r\.width = side;[\s\S]{0,40}?r\.height = side;/.test(js));
check("椭圆拖拽支持 Shift：rx = ry（以按下点为一个角的正圆）",
    /e\.cx = start\.x \+ dx \/ 2;[\s\S]{0,80}?e\.rx = Math\.abs\(dx\) \/ 2;[\s\S]{0,60}?e\.ry = Math\.abs\(dy\) \/ 2;/.test(js) &&
    /case "ellipse": \{[\s\S]{0,420}?if \(shift\) \{/.test(js));
check("马赛克 / 模糊没有被顺手改掉（仍走原来的自由矩形分支）",
    /case "mosaic":\s*case "blur": \{\s*const r = g;\s*r\.x = Math\.min\(start\.x, current\.x\)/.test(js));
check("Shift 实时同步不再只认放大镜，所有拖拽绘制的形状都跟着走",
    /const syncDraftShift = \(event\)[\s\S]{0,260}?this\.drag\.kind !== "draw" && this\.drag\.kind !== "lineClick"/.test(js) &&
    !/if \(!this\.draft \|\| this\.draft\.type !== "magnifier"\) return;/.test(js));
check("聚光灯洞口支持矩形与椭圆两种形状",
    /if \(sp\.shape === "ellipse"\)[\s\S]{0,420}?a\$\{rx\} \$\{ry\}/.test(js));
check("放大镜：镜片用 clipPath 裁剪，镜框 + 连线 + 锚点齐全",
    js.includes("annot-lens-") && js.includes("clip-path") &&
    js.includes('"data-role": "anchor-hit"') &&
    /case "magnifier"[\s\S]{0,1400}?svgEl\("line"/.test(js));
check("放大镜采样：按倍数从画布空间底图上裁一块再放大",
    /const srcW = lensW \/ zoom/.test(srcMagnifierFile) &&
    /spaceCanvas\(\)/.test(srcMagnifierFile) && js.includes("setCanvasSize"));
check("新建放大镜时锚点被推到镜框外（点与连线一画出来就看得见）",
    srcMagnifierFile.includes("export function nudgeAnchorOutside") &&
    /createObject\(type, geometry\)[\s\S]{0,900}?nudgeAnchorOutside\(m\)/.test(js));
check("拖锚点只改 anchor；拖显示框只改 x/y（translateObject 单独分支）",
    /case "magnifier": \{[\s\S]{0,260}?m\.x \+= dx;/.test(js) &&
    /name === "anchor"[\s\S]{0,220}?m\.anchor = unrotatePoint/.test(js) &&
    js.includes("hitsMagnifierAnchor"));
check("聚光灯/放大镜工具下按住同类对象＝调整它，而不是再画一个",
    // 现在由通用的「同类命中」统一接管：聚光灯对聚光灯、放大镜对放大镜（含它的锚点）
    js.includes("adjustExisting") &&
    js.includes("isSameKindTool") &&
    js.includes("hitsMagnifierAnchor"));
check("悬浮条：聚光灯有暗度滑杆 + 两种形状，放大镜有 4 档倍数 + 两种形状",
    js.includes('data-action="spotlight-shape"') &&
    js.includes('data-action="magnifier-zoom"') &&
    js.includes('data-action="magnifier-shape"') &&
    js.includes("MAGNIFIER_ZOOMS") && js.includes("SPOTLIGHT_SHAPES") &&
    js.includes("MAGNIFIER_SHAPES"));
check("两个效果对象都排除在线型虚线之外（不会被设成虚线框）",
    /object\.type !== "spotlight" && object\.type !== "magnifier"/.test(js));
check("手机端：放大镜给颜色/线宽，聚光灯给暗度滑块",
    /case "magnifier":\s*return \["colors", "widths"\]/.test(js) &&
    /case "spotlight":\s*return \["spotlightOpacity"\]/.test(js));
check("正文预览也接了放大镜采样（笔记里看到的和编辑器一致）",
    /magnifier = new MagnifierRenderer\(\)/.test(srcPreviewFile) &&
    srcPreviewFile.includes("this.magnifier.getDataUrl"));

// ---- v0.19.0：顶栏属性悬浮条 / 三段式自定义预设 / 填充色 / 虚线间距 ----
check("顶栏是五组平铺的属性档位（颜色 / 粗细 / 线型 / 填充 / 字号），没有合并成一个图标",
    ["group-colors", "group-widths", "group-lines", "group-fills", "group-fonts"]
        .every((role) => js.includes(`attrGroup("${role}")`)) &&
    !js.includes("attr-open") && !js.includes("attr-head") &&
    js.includes("data-role=\"attr-pop\""));
check("顶栏档位是「分组框 + 带文字的小胶囊」，与旧版一致（不是纯图案）",
    css.includes(".annot-attr-group") && css.includes(".annot-preset-button") &&
    css.includes(".annot-line-sample") && css.includes(".annot-group__label") &&
    /annot-preset-button.is-active[\s\S]{0,160}?var\(--annot-accent-soft\)/.test(css) &&
    js.includes("annot-line-sample") && js.includes("annot-group__label"));
check("小窗只在「自定义预设」编辑模式下、且点的是某一档时才弹",
    /if \(this\.presetEdit && kind && Number\.isFinite\(index\)/.test(js) &&
    /openSlotPop[\s\S]{0,120}?if \(!this\.presetEdit\)/.test(js) &&
    js.includes("is-preset-edit"));
check("参数小窗与色轮弹窗都相对插件容器绝对定位，点旁边空白处会收起",
    css.includes(".annot-attr-pop {") && css.includes("position: absolute") &&
    css.includes("z-index: 80") &&
    /\.annot-color-pop \{[^}]*position: absolute/.test(css) &&
    /slotEdit[\s\S]{0,220}?closeSlotPop\(\)/.test(js) &&
    /colorPopOpen[\s\S]{0,260}?closeColorPop\(\)/.test(js));
check("线宽 / 字号 / 间距都是「滑块 + 数值框」，两者双向同步",
    js.includes('data-range="${key}"') && js.includes('data-number="${key}"') &&
    ["lineWidth", "fontSize", "lineDashGap", "fillOpacity"].every((key) => js.includes(`"${key}": [`) || js.includes(`numRow("`, ) && js.includes(`"${key}"`)) &&
    /syncAttrPair[\s\S]{0,420}?other\.value = String\(raw\)/.test(js));
check("滑块拖动时只渲染不写历史，松手（change）才提交一次",
    js.includes("applyPreset(name, raw, commit = true)") &&
    /if \(commit\) this\.commit\(\)/.test(js) &&
    js.includes("this.applyAttrValue(named, Number(element.value), final)"));
check("填充小窗只有不透明度（没有颜色面板），填充色跟随描边色",
    !js.includes('data-role="fill-picker"') && !js.includes('data-preset="fillColor"') &&
    !js.includes('data-role="pop-fills"') &&
    /case "fillOpacity":[\s\S]{0,220}?this\.current\.fillColor = this\.current\.color/.test(js) &&
    /object\.style\.fillColor = this\.current\.fillColor/.test(js));
check("顶栏分组统一高度，且与「自定义预设」那一格等高",
    /\.annot-toolbar \.annot-group \{[^}]*height: 36px/.test(css) &&
    /\.annot-preset-slot|data-role="preset-slot"/.test(js) &&
    /\.annot-toolbar \{\s*gap: 12px/.test(css));
check("参数小窗是容器内 absolute 定位，并按容器边界夹住",
    css.includes(".annot-attr-pop {") && /position: absolute/.test(css) &&
    js.includes("this.root.getBoundingClientRect()") &&
    /maxLeft = Math\.max\(margin, this\.root\.clientWidth - width - margin\)/.test(js) &&
    /maxTop = Math\.max\(margin, this\.root\.clientHeight - height - margin\)/.test(js));
check("选中填充色会自动抬到 50% 不透明度（否则看着像没生效）",
    /if \(this\.current\.fillOpacity <= 0\) this\.current\.fillOpacity = 0\.5/.test(js));
check("虚线间距写进样式并参与 stroke-dasharray（1~20px）",
    srcTypes.includes("lineDashGap?: number") &&
    js.includes("lineDashGap: current.lineDashGap") &&
    /case "lineDashGap":\s*this\.current\.lineDashGap/.test(js) &&
    /`\$\{dot\} \$\{gap\}`/.test(js));
check("自定义预设改成三段式：取消 / 应用 / 恢复默认，原地替换齿轮",
    js.includes("preset-cancel") && js.includes("preset-apply") && js.includes("preset-reset") &&
    /renderPresetSlot\(\)[\s\S]{0,900}?data-action="preset-cancel"/.test(js));
check("「取消」会按进入时的快照还原样式与选中对象",
    js.includes("enterPresetEdit()") && js.includes("presetEdit") &&
    /mode === "cancel"[\s\S]{0,420}?this\.current = \{\s*\.\.\.snapshot\.style\s*\}/.test(js) &&
    /snapshot\.objectStyle[\s\S]{0,300}?object\.style = \{\s*\.\.\.snapshot\.objectStyle\s*\}/.test(js));
check("「恢复默认」只复位顶栏这七项，不动箭头 / 圆角等各自记住的设置",
    /mode === "reset"[\s\S]{0,700}?"lineDashGap"\s*\]/.test(js));
check("旧的预设调整面板已移除（不再有 settings-body / 保存并应用）",
    !js.includes('data-role="settings-body"') && !js.includes("annot-settings__body") &&
    !js.includes("save-settings"));

// ---------------------------------------------------------------- v0.21.0：UI 精简 + 多选对齐
const srcEditor = await readFile(path.join(root, "src/editor/AnnotEditor.ts"), "utf8");
const srcSidebar = await readFile(path.join(root, "src/editor/sidebar.ts"), "utf8");
const srcIcons = await readFile(path.join(root, "src/editor/icons.ts"), "utf8");

check("侧栏不再渲染属性面板（无 data-role=props / renderProperties）",
    !srcSidebar.includes('data-role="props"') && !srcSidebar.includes("renderProperties") &&
    !srcSidebar.includes("annot-properties") && !js.includes('data-role="props"'));
check("侧栏渲染改为「一组选中 id」，列表点击带回 Shift / Ctrl 修饰键",
    /render\(objects: AnnotObject\[\], selectedIds: string\[\]/.test(srcSidebar) &&
    /onSelect\(id: string, mods: SidebarSelectMods\)/.test(srcSidebar) &&
    srcSidebar.includes("event.shiftKey") && srcSidebar.includes("event.ctrlKey"));
check("悬浮条有【对齐】按钮，图标用用户原稿（1024 视图、currentColor）",
    js.includes('data-action="align-mode"') && js.includes("ALIGN_ICON") &&
    srcIcons.includes("M855.4496 825.7536"));
check("8 个对齐 / 分布按钮全部存在（左中右 / 上中下 / 横向 / 纵向）",
    /op: "left"/.test(srcIcons) && /op: "center-x"/.test(srcIcons) &&
    /op: "right"/.test(srcIcons) && /op: "top"/.test(srcIcons) &&
    /op: "middle"/.test(srcIcons) && /op: "bottom"/.test(srcIcons) &&
    /op: "distribute-x"/.test(srcIcons) && /op: "distribute-y"/.test(srcIcons) &&
    js.includes('data-action="align-op"'));
check("对齐图标各自带原稿 viewBox（1170 / 1243 的那几个没被硬套成 1024）",
    srcIcons.includes('"0 0 1170 1024"') && srcIcons.includes('"0 0 1243 1024"') &&
    srcIcons.includes('"0 0 1024 1024"') &&
    srcIcons.includes("fill=\"currentColor\" stroke=\"none\""));
check("选中 2 个以上才展开对齐面板",
    /this\.selectedIds\.length >= 2[\s\S]{0,160}?annot-context__align/.test(js));
check("对齐算法：整体包围盒 + 逐个平移 + 记一次历史",
    js.includes("alignSelection(op)") && js.includes("translateObject(item.object, dx, dy)") &&
    /this\.commit\(\);[\s\S]{0,160}?this\.render\(\);/.test(js));
check("分布算法：首尾不动、间隙平均（span = 末右 - 首左）",
    /const span = alongX \? last\.box\.x \+ last\.box\.width - first\.box\.x/.test(js) &&
    /const gap = \(span - used\) \/ \(sorted\.length - 1\)/.test(js));
check("多选入口：画布 Ctrl 点选、列表 Shift 区间 / Ctrl 加减（按需求不做框选）",
    js.includes("toggleSelected") && js.includes("selectFromList") &&
    !js.includes("marquee") && !css.includes("annot-marquee"));
check("多选视觉：每个对象一圈虚线 + 整组联合包围框，且不画单对象手柄",
    css.includes(".annot-selection-box") && css.includes(".annot-selection-union") &&
    /if \(boxes\.length > 1\)/.test(js));
check("单选语义仍然统一走 selectedId（最后格），不会两套状态打架",
    /private get selectedId\(\): string \| null \{/.test(srcEditor) &&
    /private set selectedId\(value: string \| null\)/.test(srcEditor) &&
    srcEditor.includes("private selectedIds: string[] = []"));
check("多选状态下拖其中一个成员，整组一起挪（选择也不会被收成单选）",
    js.includes("group?: AnnotObject[]") === false &&
    /drag\.group && drag\.group\.length > 1/.test(js) &&
    js.includes("const inGroup = this.selectedIds.length > 1"));

// ---------------------------------------------------------------- v0.22.0：移动端圆钮 + 停顿矫正
const srcEditor2 = await readFile(path.join(root, "src/editor/AnnotEditor.ts"), "utf8");
const srcShapes2 = await readFile(path.join(root, "src/editor/shapes.ts"), "utf8");
const srcSmart = await readFile(path.join(root, "src/editor/smartSelect.ts"), "utf8");
const srcPresetsFile = await readFile(path.join(root, "src/editor/presets.ts"), "utf8");
const srcFontsFile = await readFile(path.join(root, "src/editor/fonts.ts"), "utf8");
const srcNumberIcon = await readFile(path.join(root, "src/editor/numberIcon.ts"), "utf8");
const srcColorFile = await readFile(path.join(root, "src/editor/color.ts"), "utf8");
const srcPersistence = await readFile(path.join(root, "src/editor/persistence.ts"), "utf8");
const srcQuickEntry = await readFile(path.join(root, "src/quickEntry.ts"), "utf8");
const srcIndexFile = await readFile(path.join(root, "src/index.ts"), "utf8");
const srcSmartWorker = await readFile(path.join(root, "src/editor/smartWorker.ts"), "utf8");
check("移动端两颗独立圆钮：左选择、右对齐，圆形、48px，无平移",
    js.includes("annot-mobile-fabs") && js.includes('"mobile-select"') &&
    js.includes("annot-fab annot-fab--align") &&
    !js.includes("mobilePinnedTool") && !css.includes("annot-mobile-rail__pinned") &&
    css.includes(".annot-fab {") && css.includes("border-radius: 50%;") &&
    /TOOL_ITEMS\.filter\(\(item\) => item\.tool !== "select"\)/.test(srcEditor2));
check("圆钮状态：普通选择时左钮高亮，对齐模式时右钮高亮并显示数量",
    js.includes("syncMobileFabs") &&
    /classList\.toggle\("is-active", selecting\)/.test(js) &&
    js.includes('data-role="align-count"'));
check("触屏进入对齐模式后点对象即可多选（手机不需要 Ctrl）",
    /this\.alignMode && this\.activeTool === "select" && \(this\.mobile \|\| e\.ctrlKey \|\| e\.metaKey\)/.test(srcEditor2));
check("移动端多选时上栏换成对齐条：已选 N 个 + 8 颗按钮",
    js.includes("buildMobileAlignRow") && js.includes("annot-mobile-style__count") &&
    /ALIGN_ACTIONS\.map\(\(item\) => `[\s\S]{0,220}?annot-mobile-align/.test(srcEditor2));
check("触屏「停顿自动矫正」：停 300ms 按 Shift 逻辑重算，继续滑立刻解除",
    srcEditor2.includes("TOUCH_HOLD_MS = 300") &&
    srcEditor2.includes("scheduleTouchHold") &&
    /this\.updateDraft\(draft, start, p, true\)/.test(srcEditor2) &&
    /this\.touchSnapped = false;[\s\S]{0,260}?this\.updateDraft\(this\.draft, drag\.start, p, e\.shiftKey \|\| this\.forceShift\)/.test(srcEditor2));
check("停顿矫正只在移动端、且只对支持约束的工具生效",
    srcEditor2.includes("TOUCH_SNAP_TYPES") &&
    /\["arrow", "line", "rect", "highlightRect", "ellipse", "spotlight", "magnifier"\]/.test(srcEditor2) &&
    /if \(!this\.mobile \|\| !this\.draft \|\| !TOUCH_SNAP_TYPES\.has/.test(srcEditor2));
check("v0.22.2：两条栏取消底板，变成透明悬浮层（无背景、无边框、无投影）",
    /\.annot-mobile-style \{[^}]*margin: 0 8px 4px/.test(css) &&
    /\.annot-mobile-style \{[^}]*background: transparent/.test(css) &&
    /\.annot-mobile-style \{[^}]*border: 0/.test(css) &&
    /\.annot-mobile-style \{[^}]*box-shadow: none/.test(css) &&
    /\.annot-mobile-rail \{[^}]*background: transparent/.test(css) &&
    /\.annot-mobile-rail \{[^}]*border: 0/.test(css) &&
    /\.annot-mobile-rail \{[^}]*box-shadow: none/.test(css) &&
    /\.annot-mobile-rail \{[^}]*overflow: visible/.test(css));
check("v0.23.0：底部合成一整条 dock（rail::before 铺底），工具按钮自身透明",
    /\.annot-mobile-rail::before \{[^}]*position: absolute/.test(css) &&
    /\.annot-mobile-rail::before \{[^}]*border-radius: 22px/.test(css) &&
    /\.annot-mobile-rail::before \{[^}]*color-mix/.test(css) &&
    /\.annot-mobile-rail::before \{[^}]*backdrop-filter: blur\(18px\)/.test(css) &&
    /\.annot-mobile-tool \{[^}]*background: transparent/.test(css) &&
    /\.annot-mobile-tool \{[^}]*box-shadow: none/.test(css));

check("v0.23.0：属性栏每组是一个圆角矩形框，框内按钮去掉自带底色",
    /\.annot-mobile-style__group \{[^}]*border: 1px solid/.test(css) &&
    /\.annot-mobile-style__group \{[^}]*border-radius: 12px/.test(css) &&
    /\.annot-mobile-style__group \{[^}]*backdrop-filter: blur\(14px\)/.test(css) &&
    /\.annot-mobile-style__group \.annot-mobile-chip \{[^}]*background: transparent/.test(css) &&
    /\.annot-mobile-style__group \.annot-mobile-chip\.is-active \{[^}]*var\(--annot-accent-soft\)/.test(css));

check("v0.23.0：缩放 / 对象是两颗 80×36 等宽胶囊，进顶栏不再压在画布上",
    /\.annot-fab-pill \{[^}]*width: 80px/.test(css) &&
    /\.annot-fab-pill \{[^}]*height: 36px/.test(css) &&
    /\.annot-fab__pair \{[^}]*display: flex/.test(css) &&
    !css.includes(".annot-mobile-zoom") &&
    !css.includes(".annot-mobile-style__more"));
check("v0.22.1：两颗圆钮压到属性卡片上沿（不再为缩放胶囊抬高 66px）",
    /\.annot-mobile-fabs \{[^}]*bottom: calc\(var\(--annot-rail-h\) \+ var\(--annot-style-h\) \+ 26px/.test(css) &&
    !css.includes("+ 66px + env(safe-area-inset-bottom"));

check("v0.23.0：顶部悬浮栏按当前工具出按钮（箭头 / 画线 / 矩形 / 序号 / 放大镜 / 聚光灯）",
    srcEditor2.includes("private mobileTopItems") &&
    /case "arrow":[\s\S]{0,460}?pushRound\(arrowRound, "arrow"\)/.test(srcEditor2) &&
    /case "line":[\s\S]{0,160}?pushRound\(lineRound, "line"\)/.test(srcEditor2) &&
    /case "rect":[\s\S]{0,340}?key: "corner"/.test(srcEditor2) &&
    /case "magnifier":[\s\S]{0,700}?key: "magnifierZoom"/.test(srcEditor2) &&
    /case "spotlight":[\s\S]{0,700}?key: "mask"/.test(srcEditor2));

check("v0.23.0：「圆线」是纯开关，直接复用 PC 的 arrow-rounded / line-round，不弹气泡",
    /action: what === "line" \? "line-round" : "arrow-rounded"/.test(srcEditor2) &&
    srcEditor2.includes('item.action ?? "mobile-pop"'));

check("v0.23.0：气泡格子只有图案、不带文字（信息只靠 SVG 或一个字符）",
    /const cell = \(action: string, value: string, icon: string, on: boolean, title: string,/.test(srcEditor2) &&
    /aria-label="\$\{title\}"[\s\S]{0,80}?>\$\{icon\}<\/button>/.test(srcEditor2));

check("v0.23.0：气泡居中显示，尖角单独指回被点的那颗按钮",
    srcEditor2.includes("positionMobilePop") &&
    /pop\.style\.setProperty\("--tip-x"/.test(srcEditor2) &&
    /\.annot-mobile-pop \{[\s\S]{0,240}?left: 50%/.test(css) &&
    /\.annot-mobile-pop::before \{[\s\S]{0,240}?left: var\(--tip-x/.test(css) &&
    /\.annot-mobile-pop \{[\s\S]{0,240}?transform: translateX\(-50%\)/.test(css));

check("v0.23.0：点选项收起、点栏外收起、换工具不留孤儿气泡",
    /clicked\?\.closest\?\.\("\.annot-mobile-pop__item"\)/.test(srcEditor2) &&
    /if \(this\.mobilePopKey && !pathHas\("\.annot-mobile-topbar"\)\)/.test(srcEditor2) &&
    /!items\.some\(\(item\) => item\.key === this\.mobilePopKey\)/.test(srcEditor2));

check("v0.24.0：对象抽屉从屏幕底边长出，盖住底部两条栏",
    /\.annot-root--mobile \.annot-sidebar \{[\s\S]{0,520}?bottom: 0;/.test(css) &&
    /\.annot-root--mobile \.annot-sidebar \{[\s\S]{0,520}?z-index: 60;/.test(css) &&
    /\.annot-root--mobile \.annot-sidebar \{[\s\S]{0,520}?border-radius: 20px 20px 0 0;/.test(css) &&
    /\.annot-root--mobile \.annot-sidebar \{[\s\S]{0,520}?max-height: min\(46vh, 420px\)/.test(css) &&
    /\.annot-root--mobile \.annot-sidebar \{[\s\S]{0,520}?translateY\(101%\)/.test(css));

check("v0.24.0：抽屉顶部有抓手横条，拖动时去掉过渡让面板跟手",
    /\.annot-mobile-grab \{[\s\S]{0,320}?height: 20px/.test(css) &&
    /\.annot-mobile-grab > span \{[\s\S]{0,200}?width: 40px/.test(css) &&
    /\.annot-root--mobile \.annot-sidebar\.is-dragging \{[\s\S]{0,180}?transition: none/.test(css) &&
    js.includes("annot-mobile-grab") && js.includes("is-dragging"));

check("v0.24.0：抓手只在移动端渲染，拖过「抽屉高 1/4」就收起",
    srcEditor2.includes("bindMobileDrawer") &&
    /this\.reorderObjects\(fromId, toId\),[\s\S]{0,80}?\{mobile: this\.mobile\}/.test(srcEditor2) &&
    /const threshold = Math\.min\(96, height \* 0\.25\)/.test(srcEditor2) &&
    /if \(dy > threshold\) \{[\s\S]{0,160}?this\.mobileSheetOpen = false;/.test(srcEditor2));

check("v0.26.0：双指落下先进「待定」，再按手指位移分流成缩放或约束",
    srcEditor2.includes('private gestureMode: "none" | "pending" | "constrain" | "pinch" = "none";') &&
    /this\.gestureMode = "pending";[\s\S]{0,140}?this\.gestureLocked = true;/.test(srcEditor2) &&
    srcEditor2.includes("resolveTwoFinger") &&
    /moving\.length >= 2\) \{ this\.enterPinch\(\); return; \}/.test(srcEditor2) &&
    /this\.enterConstrain\(\);/.test(srcEditor2));

check("v0.26.0：一指按住不动 + 另一指滑动 → 类 Shift 约束（以移动指为指针）",
    srcEditor2.includes("GESTURE_HOLD_SLOP = 5") &&
    srcEditor2.includes("GESTURE_RELEASE_SLOP = 10") &&
    /this\.forceShift = true;/.test(srcEditor2) &&
    srcEditor2.includes("private gestureDrawTo(") &&
    srcEditor2.includes("private fakePointer(") &&
    /private holdFingerMoved\(\): boolean/.test(srcEditor2) &&
    /if \(this\.holdFingerMoved\(\)\) \{/.test(srcEditor2));

check("v0.26.0：约束期间所有 Shift 判定都认 forceShift（画线吸附 / 矩形椭圆 1:1）",
    (srcEditor2.match(/e\.shiftKey \|\| this\.forceShift/g) || []).length >= 5 &&
    /\(e\.shiftKey \|\| this\.forceShift\) && anchor \? snapDirection/.test(srcEditor2) &&
    /const next = \(e\.shiftKey \|\| this\.forceShift\) \? snapDirection/.test(srcEditor2));

check("v0.26.0：第二根手指的 pointerdown 仍被拦下，绘制入口只给约束模式放行",
    /event\.stopPropagation\(\);[\s\S]{0,320}?this\.gestureMode = "pending";/.test(srcEditor2) &&
    /if \(this\.mobile && this\.gestureMode !== "constrain" &&/.test(srcEditor2) &&
    /this\.touchPoints\.clear\(\);\s*\n\s*this\.finishGesture\(\);/.test(srcEditor2));

check("v0.25.1：对象抽屉的打开不再依赖「是否选中对象」",
    /sheet\?\.classList\.toggle\("is-open", this\.mobileSheetOpen\);/.test(srcEditor2) &&
    !/is-open", this\.mobileSheetOpen && !!this\.selectedId/.test(srcEditor2) &&
    !srcEditor2.includes("mobileSheetOwner"));

check("v0.25.1：空画布也能滑出抽屉（列表给空态），点画布与拖抓手都能收",
    js.includes("还没有标注对象") &&
    srcEditor2.includes("private closeMobileSheet(") &&
    /if \(this\.mobileSheetOpen\) this\.closeMobileSheet\(\);/.test(srcEditor2) &&
    /this\.mobileSheetOpen = false;\s*\n\s*this\.syncMobileSheets\(\);/.test(srcEditor2));

check("v0.26.7：移动/旋转/编辑换成 1024 图标 + 白圆底（currentColor 跟随主题）",
    srcShapes2.includes("const HANDLE_ICONS") &&
    (srcShapes2.match(/M512 992a480 480/g) || []).length >= 1 &&
    srcShapes2.includes("translate(-512 -512)") &&
    srcShapes2.includes('style: "color: var(--annot-accent)"') &&
    srcShapes2.includes('fill: "currentColor"') &&
    srcShapes2.includes('makeHandle("rotate", top, zoom, "rotate", buttonSizes)') &&
    srcShapes2.includes('makeHandle("move", moveAt, zoom, "move", buttonSizes)') &&
    srcShapes2.includes('}, zoom, "edit", buttonSizes)'));

check("v0.26.7：四角/四边收小一圈，命中半径不减（热区单独更大）",
    /const dotSizes: HandleSizes = \{[\s\S]{0,160}?radius: sizes\.radius \* \(object\.type === "text" \? 0\.52 : 0\.67\)/.test(srcShapes2) &&
    /const buttonSizes: HandleSizes = \{[\s\S]{0,160}?radius: sizes\.radius \* 1\.22,[\s\S]{0,80}?hitRadius: sizes\.hitRadius \+ 4/.test(srcShapes2) &&
    // 命中圆永远画在可见图形之前，且半径更大
    srcShapes2.includes('class: "annot-handle"') &&
    srcShapes2.includes('fill: "transparent", "pointer-events": "all"'));

check("v0.26.1：四角等比缩放（宽高比不变），四边中点才改比例",
    /if \(anchor\.length === 2\) \{/.test(srcEditor2) &&
    /const k = Math\.max\(kMin,/.test(srcEditor2) &&
    /width = w0 \* k;/.test(srcEditor2) &&
    /height = h0 \* k;/.test(srcEditor2) &&
    /\} else \{\s*\n\s*\/\/ 四边中点/.test(srcEditor2));

check("v0.26.11：键盘弹起时界面与舞台都锁高度，画布尺寸一格不动（否则标注必错位）",
    css.includes(".annot-root--mobile.is-keyboard") &&
    // v1.2.0-alpha.22 起不再隐藏三栏：锁住高度后它们自然落到键盘下面，
    // 收键盘就能看见，不会卡在「没有工具条可用」
    !css.includes(".annot-root--mobile.is-keyboard .annot-mobile-rail") &&
    // 关键是「锁住」而不是「跟随」：界面与舞台都锁成键盘弹之前的像素高度，
    // 键盘再矮也不会重排，画布内容因此一格不动
    /\.annot-root--mobile\.is-keyboard \{[^}]*height: var\(--annot-lock-h/.test(css) &&
    /\.annot-root--mobile\.is-keyboard \.annot-stage \{[^}]*height: var\(--annot-lock-stage/.test(css) &&
    /width: 100%;[\s\S]{0,80}?height: var\(--annot-lock-h/.test(css) &&
    !js.includes("--annot-vv-h"));

check("v0.26.11：编辑文字期间冻结视口，键盘只抬输入框",
    /if \(this\.mobile && this\.editingTextId\) return;/.test(srcEditor2) &&
    srcEditor2.includes("private liftTextEditor(") &&
    /editor\.style\.transform = `translateY\(\$\{-delta\}px\)`/.test(srcEditor2) &&
    /this\.keyboardSync\?\.\(\)/.test(srcEditor2));

check("v0.26.2：全屏不再给顶栏留「避让原生按钮」的预留宽度（按钮位置不再跳）",
    !srcEditor2.includes("--annot-fs-safe-right") &&
    !srcEditor2.includes("avoidNativeControls") &&
    !srcEditor2.includes("windowControlsOverlay") &&
    !css.includes("--annot-fs-safe-right") &&
    // 系统全屏本身仍然保留（这是让原生按钮彻底消失的手段）
    srcEditor2.includes("requestFullscreen"));

check("v0.26.2：全屏时顶栏的内边距 / 间距与窗口化完全一致（按钮不会跳位）",
    !/\.annot-root\.is-fullscreen \.annot-titlebar\s*\{/.test(css) &&
    /\.annot-titlebar\s*\{[^}]*padding: 6px 12px;/.test(css));

check("v0.26.3：文字的移动抓手在正下方，与旋转抓手上下对称并各带一条虚线",
    /moveAt = \{x: center\.x, y: bounds\.y \+ bounds\.height \+ 30 \/ zoom\}/.test(srcShapes2) &&
    /x1: center\.x, y1: bounds\.y \+ bounds\.height/.test(srcShapes2) &&
    /x2: moveAt\.x, y2: moveAt\.y/.test(srcShapes2));

check("v0.26.5：手柄尺寸相对界面固定——zoom 一变就同步按新比例重建 overlay",
    srcEditor2.includes("private overlayZoom = 1;") &&
    srcEditor2.includes("private syncHandleScale(") &&
    /this\.syncHandleScale\(zoom\);/.test(srcEditor2) &&
    /this\.overlayZoom = this\.viewport\.zoom \|\| 1;/.test(srcEditor2) &&
    // 必须同步重建：排到下一帧会先看到圆点胀一下
    !srcEditor2.includes("overlayRaf") &&
    srcEditor2.includes('shape-rendering="geometricPrecision"') &&
    // 尺寸基准：PC 18px / 手机 25px 直径
    srcShapes2.includes("radius: 9, hitRadius: 17") &&
    srcEditor2.includes("{radius: 8, hitRadius: 23}"));

// ---------------------------------------------------------------- v1.1.0 高亮模式
check("v1.1.0：高亮工具统一改名「高亮」（左栏与手机工具栏共用同一份文案）",
    js.includes('tool: "highlight", label: "高亮"') &&
    !js.includes('label: "高亮笔"') &&
    srcTypes.includes('highlight: "高亮"') &&
    srcTypes.includes('highlightRect: "矩形高亮"'));

check("v1.1.0：高亮两种模式，PC 悬浮条与手机顶栏都能切",
    /const HIGHLIGHT_MODES: \{key: "brush" \| "rect"/.test(srcEditor2) &&
    srcEditor2.includes('data-action="highlight-mode"') &&
    // 手机端不再是折叠气泡，而是两颗并排按钮（v1.1.0-alpha.3）
    srcEditor2.includes('action: "highlight-mode-brush"') &&
    srcEditor2.includes('action: "highlight-mode-rect"') &&
    srcEditor2.includes("private setHighlightMode("));

check("v1.1.0：矩形高亮画出来是一块半透明色块，不画描边",
    /case "highlightRect": \{[\s\S]{0,700}?stroke: "none"/.test(srcShapes2) &&
    /withAlpha\(object\.style\.color, alpha\)/.test(srcShapes2) &&
    /const alpha = object\.style\.fillOpacity \?\? 0\.5;/.test(srcShapes2));

check("v1.1.0：矩形高亮是独立对象——包围盒 / 平移 / 缩放都按矩形处理，且不参与旋转",
    (srcShapes2.match(/case "highlightRect":/g) || []).length >= 4 &&
    /export function supportsRotation[\s\S]{0,260}?object\.type !== "highlightRect"/.test(srcShapes2) &&
    js.includes("highlightRect"));

check("v1.1.0：矩形高亮默认浓度兜底 50%，切换模式时也补一次（避免画出全透明）",
    /current\.fillOpacity > 0 \? current\.fillOpacity : 0\.5/.test(srcShapes2) &&
    /mode === "rect" && this\.current\.fillOpacity <= 0/.test(srcEditor2));

check("v1.1.0：手机端上栏对矩形高亮只给「颜色 + 填充浓度」两组",
    /case "highlightRect": return \["colors", "fills"\]/.test(srcEditor2) &&
    /case "highlight":\s*\/\/ 矩形高亮只认/.test(srcEditor2));

check("v1.1.0-alpha.3：手机高亮直接平铺「画笔 / 矩形」两枚按钮，不用再点开气泡",
    /label: "画笔"/.test(srcEditor2) &&
    /label: "矩形",\s*icon: TB_SHAPE_RECT,\s*on: mode === "rect"/.test(srcEditor2) &&
    !srcEditor2.includes('key: "highlightMode"'));

check("v1.1.0-alpha.3：PC 马赛克悬浮条只剩「块大小」，透明度滑块已移除",
    /type === "mosaic"\) \{[\s\S]{0,320}?range\("blockSize", "块大小", 4, 48, size\)/.test(srcEditor2) &&
    !/range\("blockSize"[\s\S]{0,200}?range\("opacity"/.test(srcEditor2));

check("v1.1.0-alpha.3：手机马赛克 / 模糊给出紧凑滑块（块大小、模糊程度）",
    /case "mosaic": return \["blockSize"\]/.test(srcEditor2) &&
    /case "blur": return \["blurRadius"\]/.test(srcEditor2) &&
    srcEditor2.includes('class="annot-mobile-range"') &&
    /\.annot-mobile-range \{[^}]*width: 96px/.test(css));

check("v1.1.0-alpha.4：选区识别的开关同时出现在 PC 与手机的悬浮栏",
    srcEditor2.includes('data-action="smart-select"') &&
    srcEditor2.includes('label: "识别"') &&
    srcEditor2.includes("private toggleSmartSelect("));

check("v1.1.0-alpha.7：点【选区识别】先扫整幅画面，切出一个个独立矩形",
    srcSmart.includes("export function detectRegions") &&
    srcSmart.includes("MAX_REGIONS = 120") &&
    srcEditor2.includes("private scanSmartRegions(") &&
    srcEditor2.includes("this.smartRegions = (regions ?? [])"));

check("v1.1.0-alpha.7：分区够细靠三件事——局部对比、去长线、图标单独成块",
    srcSmart.includes("EDGE_THRESHOLD") &&
    srcSmart.includes("function openLine(") &&
    srcSmart.includes("ch < charHeight * 2") &&
    srcSmart.includes("ratio < 0.55 || ratio > 1.8"));

check("v1.1.0-alpha.6：识别跑在 Web Worker 里，画面先降到 800px，主线程只等坐标",
    srcEditor2.includes('from "./smartWorker?worker&inline"') &&
    /worker\.postMessage\(\{id: token, data: source\.data, width: source\.width, height: source\.height\}\)/.test(srcEditor2) &&
    /SMART_MAX_SIDE \/ Math\.max\(canvas\.width, canvas\.height\)/.test(srcEditor2) &&
    srcSmart.includes("SMART_MAX_SIDE = 800") &&
    srcSmartWorker.includes("detectRegions"));

check("v1.1.0-alpha.6：虚线框画在 overlay 上，点哪个框就把哪个打码、框随即消失",
    srcEditor2.includes('"data-smart-region": String(index)') &&
    srcEditor2.includes('class: "annot-smart-region"') &&
    /closest\?\.\("\[data-smart-region\]"\)/.test(srcEditor2) &&
    srcEditor2.includes("this.smartRegions?.splice(index, 1)") &&
    css.includes(".annot-smart-region") &&
    /\.annot-smart-region \{[^}]*stroke-dasharray/.test(css));

check("v1.1.0-alpha.6：再点一次按钮退出识别模式，清掉所有没点的框",
    /if \(this\.current\.smartSelect\) \{\s*this\.exitSmartMode\(\);/.test(srcEditor2) &&
    /private exitSmartMode\(\): void \{[\s\S]{0,220}?this\.smartRegions = null/.test(srcEditor2) &&
    /this\.current\.smartSelect && tool !== "mosaic" && tool !== "blur"/.test(srcEditor2));

check("v1.1.0-alpha.6：Worker 建不出来时退回主线程算（CSP 严格的内核也能用）",
    /worker\.postMessage\(\{id: token[\s\S]{0,400}?finish\(detectRegions\(/.test(srcEditor2) &&
    srcEditor2.includes("smartWorkerBroken"));

check("v1.1.0-alpha.6：旧版本带 mask 的马赛克仍按形状裁剪（向后兼容）",
    srcTypes.includes("mask?: SmartRun[]") &&
    srcShapes2.includes("const runs = m.mask;") &&
    /annot-mask-[\s\S]{0,600}?clip-path/.test(srcShapes2));

check("v1.1.0-alpha.8：选区识别用完自动关闭（点完最后一个框 / 一个块都没扫出）",
    /this\.smartRegions\?\.splice\(index, 1\);[\s\S]{0,300}?if \(!this\.smartRegions\?\.length\) \{[\s\S]{0,90}?this\.exitSmartMode\(\);/.test(srcEditor2) &&
    /if \(!this\.smartRegions\.length\) \{[\s\S]{0,90}?this\.exitSmartMode\(\);/.test(srcEditor2));

check("v1.1.0-alpha.8：识别开关不跨会话保持，重开编辑器一律从关闭开始",
    srcPresetsFile.includes("smartSelect: false"));

check("v1.1.0-alpha.9：识别单击先延时 180ms，第二根手指落下立刻作废",
    srcEditor2.includes("private beginSmartTap(") &&
    /}, 180\);/.test(srcEditor2) &&
    /this\.touchPoints\.size === 2\) \{[\s\S]{0,120}?this\.cancelSmartTap\(\);/.test(srcEditor2));

check("v1.1.0-alpha.9：位移超过 8px 不算点击，手势结束后 200ms 内不响应",
    /Math\.hypot\(event\.clientX - client\.x, event\.clientY - client\.y\) > 8/.test(srcEditor2) &&
    /this\.smartCooldownUntil = performance\.now\(\) \+ 200;/.test(srcEditor2) &&
    /if \(performance\.now\(\) < this\.smartCooldownUntil\) return;/.test(srcEditor2) &&
    /distance\(this\.toImagePoint\(e\), tap\.start\) \* this\.viewport\.zoom < 8/.test(srcEditor2));

check("v1.2.0-alpha.7：文字工具的字体入口双端都在悬浮栏上（手机端在顶栏）",
    srcEditor2.includes('data-action="font-pop"') &&
    srcEditor2.includes('case "text": return ["colors", "fonts"]') &&
    srcEditor2.includes('case "text": {') &&
    srcFontsFile.includes("var(--b3-font-family,") &&
    srcFontsFile.includes("var(--b3-font-family-code,"));

check("v1.2.0-alpha.1：导出成品图时只解析字体变量，用户选的字体不会被冲成 sans-serif",
    srcFontsFile.includes("export function inlineFontVars") &&
    srcFontsFile.includes("var(--b3-font-family-code") &&
    !srcPersistence.includes('replace(/font-family="[^"]*"/g, \'font-family="sans-serif"\')') &&
    srcPersistence.includes("inlineFontVars(new XMLSerializer().serializeToString(objectLayer))"));

check("v1.1.0-alpha.10：字体存档位键、渲染时才翻译成字体栈（换主题旧文字也跟着走）",
    srcTypes.includes("fontFamily?: string") &&
    /"font-family": fontStackOf\(object\.style\.fontFamily\)/.test(srcShapes2) &&
    srcEditor2.includes("editor.style.fontFamily = fontStackOf(object.style.fontFamily)") &&
    srcEditor2.includes("saveCurrentStyle(this.current)"));

check("v1.2.0-alpha.2：字体面板顶部是上传按钮，自定义字体在前、系统字体在后",
    srcEditor2.includes('class="annot-font-upload" data-action="font-upload"') &&
    /annot-font-upload[\s\S]{0,600}?annot-font-list--default/.test(srcEditor2) &&
    /annot-font-list--default[\s\S]{0,200}?annot-font-sep">系统字体/.test(srcEditor2) &&
    !/>\s*自定义字体\s*</.test(srcEditor2) &&
    srcFontsFile.includes("export function detectSystemFonts") &&
    srcFontsFile.includes("export async function queryLocalFonts") &&
    srcFontsFile.includes("export async function loadUploadedFonts"));

check("v1.2.0-alpha.1：支持上传字体，存进数据目录、导出时内嵌（插件包不含字体）",
    srcFontsFile.includes("export async function uploadFontFile") &&
    srcFontsFile.includes("buildFontFaceCss") &&
    srcFontsFile.includes("new FontFace(family, data)") &&
    srcEditor2.includes("private async pickFontFile") &&
    srcEditor2.includes('accept = ".ttf,.otf,.woff,.woff2"') &&
    srcPersistence.includes("fontCss") &&
    srcPersistence.includes("<defs><style") &&
    srcEditor2.includes("await buildFontFaceCss(usedFonts)"));

check("v1.2.0-alpha.3：系统字体显示中文名，渲染仍用英文族名",
    srcFontsFile.includes("FONT_CN_NAMES") &&
    srcFontsFile.includes("function pickLabel") &&
    srcFontsFile.includes("fullName") &&
    srcEditor2.includes("this.systemFonts.map((font) => item(font.family, font.label))") &&
    srcFontsFile.includes('return `"${key}", system-ui, sans-serif`;'));

check("v1.2.0-alpha.4：上传字体只收 ttf/otf/woff/woff2，失败有具体原因",
    srcFontsFile.includes("const FONT_EXT = /\\.(ttf|otf|woff2?)$/i") &&
    !srcFontsFile.includes("|ttc") &&
    srcFontsFile.includes("MAX_FONT_BYTES") &&
    srcFontsFile.includes("export class FontUploadError") &&
    srcFontsFile.includes("只支持 ttf、otf、woff、woff2 格式的字体") &&
    srcEditor2.includes("error instanceof FontUploadError"));

check("v1.2.0-alpha.6：定位气泡＝完整圆 + 单独尖头，尖头颜色跟主色",
    srcShapes2.includes("function pointerBubble") &&
    srcShapes2.includes("const bubble = normalizeNumberBubble(n.bubble)") &&
    srcShapes2.includes('const isPointer = bubble === "pointer"') &&
    srcShapes2.includes("Math.acos") &&
    // 尖头是独立三角（annot-head），填充＝描边色；圆是完整 circle，内部填充走 fillColor
    srcShapes2.includes('class: "annot-head"') &&
    srcShapes2.includes('fill: object.style.fillColor ?? "#FFFFFF"') &&
    srcShapes2.includes("fill: ink,") &&
    // 反色只发生在实心圆分支里，其它样式一律用主色
    /if \(!isPlain\) \{[\s\S]{0,600}?ink = pickBadgeTextColor\(color\);/.test(srcShapes2) &&
    /if \(hollow\) \{[\s\S]{0,700}?ink = readableInk\(color,/.test(srcShapes2) &&
    !srcShapes2.includes("inkOnLight") &&
    srcShapes2.includes("dist > d + 2") &&
    srcTypes.includes('export type NumberBubble = "solid" | "hollow" | "pointer" | "plain"'));

check("v1.2.0-alpha.10：定位气泡有引线 / 圆线开关 / 填充，边框与文字跟随主色",
    srcEditor2.includes('data-action="number-leader"') &&
    srcEditor2.includes('data-action="number-round-toggle"') &&
    srcEditor2.includes('swatch("fillColor"') &&
    srcEditor2.includes('value: "fillColor"') &&
    !srcEditor2.includes('data-value="numberTextColor"') &&
    /bubble === "pointer" \? leaderChips \+ fillChips/.test(srcEditor2));

check("v1.2.0-alpha.6：拖动预览就按当前样式画（不再是光秃秃的圆）",
    /bubble: this\.current\.numberBubble,[\s\S]{0,80}?leader: this\.current\.numberLeader,/.test(srcEditor2));

check("v1.2.0-alpha.6：序号工具栏的样式切换与专属参数互斥显示",
    srcEditor2.includes('data-action="number-bubble"') &&
    srcEditor2.includes('data-action="number-leader"') &&
    /bubble === "pointer" \? leaderChips/.test(srcEditor2) &&
    srcEditor2.includes("private setNumberBubble") &&
    srcEditor2.includes("private setNumberLeader"));

check("v1.2.0-alpha.7：重建工具栏后保持横向滚动位置（不再弹回最左）",
    /const keepScroll = host\.scrollLeft;[\s\S]{0,600}?host\.scrollLeft = keepScroll;/.test(srcEditor2) &&
    /const keepScroll = bar\.scrollLeft;[\s\S]{0,900}?bar\.scrollLeft = keepScroll;/.test(srcEditor2));

check("v1.2.0-alpha.7：手机字体面板挂在 root 下，不被横向滚动的上栏裁掉",
    srcEditor2.includes("private renderMobileFontPop") &&
    srcEditor2.includes('data-role="mobile-font-host"') &&
    srcEditor2.includes("this.renderMobileFontPop();") &&
    css.includes(".annot-font-host") &&
    !/\.annot-font-pop--mobile \{[^}]*position: fixed/.test(css));

check("v1.2.0-alpha.10：序号顶栏第一位是样式，点开四选一且状态即时同步",
    /key: "numberBubble"[\s\S]{0,260}?icon: this\.numberStyleIcon\(bubble\)/.test(srcEditor2) &&
    /if \(key === "numberBubble"\)[\s\S]{0,320}?cell\("number-bubble"/.test(srcEditor2) &&
    srcEditor2.includes('action === "number-round-toggle"') &&
    srcEditor2.includes('action === "number-leader-toggle"') &&
    srcEditor2.includes('item.value === undefined ? "" : ` data-value="${item.value}"`'));

check("v1.2.0-alpha.7：手机第二行不再重复放序号 / 字体设置",
    srcEditor2.includes('case "number": return ["colors", "fonts"]') &&
    srcEditor2.includes('case "text": return ["colors", "fonts"]'));

check("v1.2.0-alpha.12：样式图标独立成模块，不再复用画布渲染",
    srcEditor2.includes("numberStyleIconSvg") &&
    srcNumberIcon.includes("export function numberStyleIconSvg") &&
    !/renderObject\s*\(/.test(srcNumberIcon) &&
    !/defaultStyle\s*\(/.test(srcNumberIcon) &&
    !srcShapes2.includes("monochrome") &&
    srcNumberIcon.includes("currentColor"));

check("v1.2.0-alpha.12：实心圆图标里的数字取按钮底色，选中时换成主题色",
    // 颜色改为「变量对 + 内联 style」：球与字成对改写，杜绝两者同色
    srcNumberIcon.includes("const DISC = \"var(--annot-badge-disc, currentColor)\"") &&
    srcNumberIcon.includes("const DIGIT_ON_DISC = \"var(--annot-badge-digit, var(--annot-panel, #fff))\"") &&
    srcNumberIcon.includes('class="annot-badge-digit"') &&
    srcNumberIcon.includes('style="fill:${fill}"') &&
    css.includes("--annot-badge-disc: var(--annot-accent-text);") &&
    css.includes("--annot-badge-digit: var(--annot-accent);") &&
    !css.includes("svg.annot-badge-icon .annot-badge-digit"));

check("v1.2.0-alpha.12：画布上的定位气泡恢复「完整圆 + 三角尖头被圆盖住」",
    srcShapes2.includes('d: `M${t1.x} ${t1.y}L${apex.x} ${apex.y}L${t2.x} ${t2.y}Z`') &&
    /"stroke-width": lineWidth,\s*"stroke-linejoin": round \? "round" : "miter"/.test(srcShapes2) &&
    !srcShapes2.includes("A${radius} ${radius} 0 0 1"));

check("v1.2.0-alpha.12：图标里的尖头走圆弧收回，圆保持完整",
    srcNumberIcon.includes("A${radius} ${radius} 0 0 1 ${t1}Z") &&
    srcNumberIcon.includes("Math.acos"));

check("v1.2.0-alpha.13：空心圆与纯数字也能拉引线，起点让到圆外",
    srcShapes2.includes("const leaderInset = hollow ? n.radius : (isPlain ? n.radius * 0.8 : 0)") &&
    srcShapes2.includes("lineWidth, leaderInset)") &&
    srcEditor2.includes("const tipBlock =") &&
    /bubble === "hollow" \? fillChips \+ tipBlock/.test(srcEditor2) &&
    /: tipBlock\)\s*\+\s*roundToggle;/.test(srcEditor2));

check("v1.2.0-alpha.13：空心圆内部固定实色，颜色只由取色器控制",
    /if \(hollow\) \{[\s\S]{0,400}?"fill-opacity": 1,/.test(srcShapes2) &&
    srcShapes2.includes('fill: object.style.fillColor ?? "#FFFFFF"') &&
    !srcEditor2.includes("number-fill-none") &&
    !srcEditor2.includes("setNumberFillNone") &&
    srcEditor2.includes('swatch("fillColor"'));

check("v1.2.0-alpha.14：切成定位气泡时自动补默认尖头，切回圆形时清掉",
    srcShapes2.includes("export function defaultPointerTip") &&
    srcEditor2.includes("const wasPointer = prev === \"pointer\"") &&
    srcEditor2.includes("n.tip = defaultPointerTip(n)") &&
    /bubble !== "pointer" && wasPointer[\s\S]{0,80}?n\.tip = null;/.test(srcEditor2) &&
    srcEditor2.includes("n.leader = false;"));

check("v1.2.0-alpha.14：缺尖头数据时安全降级，不会算出 NaN",
    srcShapes2.includes("Number.isFinite(n.tip.x) && Number.isFinite(n.tip.y)") &&
    srcPersistence.includes("defaultPointerTip(n)") &&
    srcPersistence.includes("normalizeNumberBubble"));

check("v1.2.0-alpha.15：浅底序号的文字不会撞色，实心圆反色只在自己分支里",
    srcColorFile.includes("export function readableInk") &&
    srcColorFile.includes("export function contrastRatio") &&
    /ink = readableInk\(color, object\.style\.fillColor \?\? "#FFFFFF"\)/.test(srcShapes2) &&
    !srcShapes2.includes("inkOnLight"));

check("v1.2.0-alpha.15：切样式不拿主色顶替填充色，圆心原地不动",
    // 实心圆 / 纯数字的底色是主色，那不是填充色；带过去会让定位气泡整颗变红
    !/object\.style\.fillColor = object\.style\.color;/.test(srcEditor2) &&
    srcEditor2.includes("object.style.fillColor === object.style.color") &&
    /n\.tip = defaultPointerTip\(n\)/.test(srcEditor2) &&
    !/n\.center = /.test(srcEditor2));

check("v1.3.0-alpha.2：图片快捷入口插在原生按钮组最左侧，双端共用",
    srcIndexFile.includes('from "./quickEntry"') &&
    srcIndexFile.includes("this.patchMenuIcon(host)") &&
    // 菜单项和悬浮按钮共用同一份路径，不是各画一张
    srcIndexFile.includes("svg.innerHTML = ICON_PATH") &&
    srcQuickEntry.includes("export const ICON_PATH") &&
    srcQuickEntry.includes("${ICON_PATH}") &&
    srcIndexFile.includes("this.quickEntry?.stop()") &&
    // 插进原生的 .protyle-icons（PC 悬停、移动端轻点都由思源显示这一组）
    srcQuickEntry.includes('".protyle-icons"') &&
    srcQuickEntry.includes("insertBefore(button, icons.firstElementChild)") &&
    // 圆角接力：我们 --first，原来唯一的那个 --only 改成 --last
    srcQuickEntry.includes("protyle-icon--first") &&
    srcQuickEntry.includes("protyle-icon--last") &&
    srcQuickEntry.includes("protyle-icon--only") &&
    // 图标只用 currentColor，颜色不写死（1024 视图的两段实心路径）
    !/fill="#[0-9a-fA-F]/.test(srcQuickEntry) &&
    !/stroke="#[0-9a-fA-F]/.test(srcQuickEntry) &&
    // 视图放大到图形的 75%（-171..1195），和思源 24 视图图标（内容 3..21）同比例
    srcQuickEntry.includes('"-171 -171 1366 1366"') &&
    srcIndexFile.includes("svg.setAttribute(\"viewBox\", ICON_VIEWBOX)") &&
    (srcQuickEntry.match(/fill="currentColor"/g) || []).length >= 1 &&
    // 盒子和原生一致 16px，视觉比例由 viewBox 内边距负责
    /\.annot-quick-entry > svg \{[^}]*width: 16px[^}]*height: 16px/.test(css) &&
    // 触屏热区 ≥44px（视觉仍是 24px，只扩伪元素）
    css.includes(".annot-quick-entry::after") &&
    /@media \(pointer: coarse\)[\s\S]{0,200}?\.annot-quick-entry::after/.test(css) &&
    css.includes("inset: -10px"));

check("v1.3.0-alpha.2：快捷入口点击直接开编辑器，不触发原生菜单",
    srcQuickEntry.includes("event.stopPropagation()") &&
    srcQuickEntry.includes("readImageTarget({element: container})") &&
    srcIndexFile.includes("(target) => this.openEditor(target)"));

check("v1.2.0-alpha.16：序号文字色的取色器真正生效",
    srcShapes2.includes("if (object.style.numberTextColor) ink = object.style.numberTextColor;") &&
    srcShapes2.indexOf("numberTextColor) ink = object.style.numberTextColor")
        > srcShapes2.indexOf("ink = pickBadgeTextColor(color)"));

check("v1.2.0-alpha.19：同类对象内起手改为选中，不再叠一个",
    // 几何命中（不依赖 DOM 事件目标，上层盖着别的类型也能找对同类那一个）
    srcEditor2.includes("private findSameKindAt(tool: string, p: Point)") &&
    srcEditor2.includes("for (let i = this.scene.objects.length - 1; i >= 0; i--)") &&
    srcEditor2.includes("private isSameKindTool(tool: string, type: AnnotType)") &&
    // 高亮的笔迹与色块算同一类
    srcEditor2.includes('return tool === "highlight" && (type === "highlight" || type === "highlightRect")') &&
    // 起点在同类对象上 → 走「选中 + 拖动」而不是「画新的」
    srcEditor2.includes("this.findSameKindAt(this.activeTool, p) ?? under") &&
    /adjustExisting && hitObject/.test(srcEditor2) &&
    // 文字工具也要让路，否则会直接新建一个文字对象
    srcEditor2.includes('this.activeTool === "text" && !adjustExisting'));

check("v1.2.0-alpha.22：键盘态只锁高度，不再隐藏底部三栏",
    // 锁高度：避免 dvh 随键盘缩、工具条被顶到键盘上方
    css.includes("height: var(--annot-lock-h, 100dvh)") &&
    // 三栏一条都不能在键盘态里被 display:none
    !css.includes(".annot-root--mobile.is-keyboard .annot-mobile-rail") &&
    !css.includes(".annot-root--mobile.is-keyboard .annot-mobile-fabs") &&
    !css.includes(".annot-root--mobile.is-keyboard .annot-mobile-style") &&
    !css.includes(".annot-root--mobile.is-keyboard .annot-mobile-topbar") &&
    // 点画布结束输入时，这一下不许再落到画布上新建：
    // 触屏走 swallowPointer（放行事件让舞台判断双指），鼠标直接拦在捕获阶段
    srcEditor2.includes("this.swallowPointer = (event as PointerEvent).pointerId") &&
    srcEditor2.includes("e.pointerId === this.swallowPointer"));

// ---------------------------------------------------------------- 报告
console.log(`\n=== 校验目标：${target} ===\n`);
for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
}
console.log(`\n静态回归 / smoke test：${results.length - failed}/${results.length} 通过\n`);
console.log("=== SHA256 ===");
console.log(hashLines.join("\n"));
console.log("");
process.exit(failed > 0 ? 1 : 0);
