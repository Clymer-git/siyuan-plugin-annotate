/**
 * 带「选区识别形状」的马赛克 / 模糊怎么渲染 —— 纯 DOM 验证，不需要真浏览器。
 *
 * 做法：用 esbuild 把 src/editor/shapes.ts 连同依赖打成单文件，塞进 jsdom 里渲染，
 * 断言：① 生成 clipPath；② 位图/兜底块挂上了 clip-path；③ 条带数量与几何对得上。
 *
 * 用法：node scripts/check-mask-render.mjs
 */
import {buildSync} from "esbuild";
import {createRequire} from "node:module";
import path from "node:path";
import {pathToFileURL} from "node:url";

// 和 smoke-dom.mjs 一样，jsdom 复用隔壁 BlockBar 项目里那份，避免本项目多装一套依赖
const require = createRequire(import.meta.url);
const {JSDOM} = require("D:/WorkBuddy/siyuan-plugin/siyuan-plugin-BlockBar/node_modules/jsdom");

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.join(root, "_tools/shapes-bundle.mjs");

buildSync({
    entryPoints: [path.join(root, "src/editor/shapes.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile,
    logLevel: "silent",
});

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

const {renderObject} = await import(pathToFileURL(outfile).href);

let failed = 0;
const check = (name, ok, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

const baseStyle = {
    color: "#EF4444", lineWidth: 4, opacity: 1, fontSize: 28,
    fillOpacity: 0, fontSize: 28, lineDash: "solid", lineDashGap: 6,
};

const makeMosaic = (mask) => ({
    id: "obj-test-1",
    type: "mosaic",
    geometry: {x: 100, y: 50, width: 200, height: 120, blockSize: 8, ...(mask ? {mask} : {})},
    style: {...baseStyle},
    meta: {label: "马赛克", createdAt: 0, updatedAt: 0},
});

// 1) 没有 mask：不应出现 clipPath（老对象行为不变）
{
    const g = renderObject(makeMosaic(null), {zoom: 1, bitmapUrl: "data:image/png;base64,AAAA"});
    check("普通矩形马赛克不生成 clipPath", !g.querySelector("clipPath"));
    const image = g.querySelector("image");
    check("普通矩形马赛克仍是整块位图", !!image && !image.getAttribute("clip-path"));
}

// 2) 两条带：应生成 clipPath，位图按它裁剪
{
    const mask = [[0, 0.5, 0, 0.25], [0.2, 1, 0.6, 1]];
    const g = renderObject(makeMosaic(mask), {zoom: 1, bitmapUrl: "data:image/png;base64,AAAA"});
    const clip = g.querySelector("clipPath");
    check("带 mask 的马赛克生成 clipPath", !!clip && clip.getAttribute("id") === "annot-mask-obj-test-1",
        clip ? clip.getAttribute("id") : "无");
    const d = clip?.querySelector("path")?.getAttribute("d") ?? "";
    check("clipPath 里是两段子路径（一字一条带）", (d.match(/M/g) || []).length === 2, `${(d.match(/M/g) || []).length} 段`);
    // bbox = x 100..300, y 50..170；第一段 0..0.5 / 0..0.25 → 100..200, 50..80
    check("条带坐标按 bbox 换算正确（第一段 100,50 宽 100 高 30）",
        d.includes("M100.00 50.00") && d.includes("H200.00") && d.includes("V80.00"), d);
    const image = g.querySelector("image");
    check("位图挂上了 clip-path", image?.getAttribute("clip-path") === "url(#annot-mask-obj-test-1)",
        String(image?.getAttribute("clip-path")));
}

// 3) 模糊 + 无位图（跨域兜底）：雾块也要被裁剪
{
    const g = renderObject({
        id: "obj-test-2",
        type: "blur",
        geometry: {x: 0, y: 0, width: 100, height: 100, radius: 12, mask: [[0, 1, 0, 0.3]]},
        style: {...baseStyle},
        meta: {label: "模糊", createdAt: 0, updatedAt: 0},
    }, {zoom: 1, bitmapUrl: null});
    const fog = g.querySelector("rect.annot-shape");
    check("跨域兜底的雾块同样按 mask 裁剪",
        fog?.getAttribute("clip-path") === "url(#annot-mask-obj-test-2)",
        String(fog?.getAttribute("clip-path")));
}

console.log(`\n带形状的马赛克渲染：${failed === 0 ? "全部通过" : failed + " 条失败"}`);
process.exit(failed > 0 ? 1 : 0);
