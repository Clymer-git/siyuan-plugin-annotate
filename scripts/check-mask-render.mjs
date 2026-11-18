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

const {renderObject, defaultPointerTip} = await import(pathToFileURL(outfile).href);

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

// ---------------------------------------------------------------- 定位气泡
{
    const base = {color: "#EF4444", lineWidth: 4, opacity: 1, fontSize: 28};
    const make = (bubble, leader, tipDist) => ({
        id: "num-" + bubble + tipDist,
        type: "number",
        geometry: {
            center: {x: 100, y: 100},
            tip: tipDist ? {x: 100 + tipDist, y: 100} : null,
            control: null,
            number: 1,
            radius: 20,
            format: "arabic",
            bubble,
            leader,
        },
        style: {...base, numberTip: "arrow"},
        meta: {label: "序号", createdAt: 0, updatedAt: 0},
    });

    const far = renderObject(make("pointer", true, 90), {zoom: 1});
    {
        const apex = far.querySelector("path.annot-head");
        const circle = far.querySelector("circle.annot-shape");
        const d = apex?.getAttribute("d") ?? "";
        check("定位气泡：尖头是单独的三角路径",
            /^M/.test(d) && /L/.test(d) && d.trim().endsWith("Z"), d.slice(0, 50));
        check("定位气泡：圆是完整的独立圆（半径不变）",
            !!circle && Number(circle.getAttribute("r")) === 20);
        check("定位气泡：尖头颜色与圆描边完全一致",
            apex?.getAttribute("fill") === circle?.getAttribute("stroke"),
            `${apex?.getAttribute("fill")} / ${circle?.getAttribute("stroke")}`);
        check("定位气泡：圆内部默认白色、描边红色",
            circle?.getAttribute("fill") === "#FFFFFF" && circle?.getAttribute("stroke") === "#EF4444");
        const tipText = far.querySelector("text");
        check("定位气泡：文字用主色（红）",
            tipText?.getAttribute("fill") === "#EF4444", tipText?.getAttribute("fill") ?? "");
        // 尖端方向应朝着 tip（+x）：取路径里最靠右的那个顶点
        const points = [...d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)]
            .map((m) => ({x: Number(m[1]), y: Number(m[2])}));
        const apexPoint = points.reduce((a, b) => (b.x > a.x ? b : a), {x: 0, y: 0});
        check("定位气泡：尖头指向拖动方向", apexPoint.x > 100 + 20, `x=${apexPoint.x}`);
        // 填充色只影响圆内部，尖头颜色不受影响
        const tinted = renderObject({...make("pointer", false, 90), style: {...base, color: "#EF4444", fillColor: "#FDE68A"}}, {zoom: 1});
        check("定位气泡：改填充只影响圆内部",
            tinted.querySelector("circle.annot-shape")?.getAttribute("fill") === "#FDE68A" &&
            tinted.querySelector("path.annot-head")?.getAttribute("fill") === "#EF4444");
        // 改主色，边框与尖头一起变
        const recolored = renderObject({...make("pointer", false, 90), style: {...base, color: "#2563EB"}}, {zoom: 1});
        check("定位气泡：改主色时边框和尖头一起变",
            recolored.querySelector("circle.annot-shape")?.getAttribute("stroke") === "#2563EB" &&
            recolored.querySelector("path.annot-head")?.getAttribute("fill") === "#2563EB");

        // 空心圆：白底 + 描边，没有尖头
        const hollow = renderObject(make("hollow", false, 0), {zoom: 1});
        const hollowCircle = hollow.querySelector("circle.annot-shape");
        const tintedHollow = renderObject({...make("hollow", false, 0), style: {...base, fillColor: "#22C55E"}}, {zoom: 1});
        check("空心圆：换填充色就变实色填充，没有透明档",
            tintedHollow.querySelector("circle.annot-shape")?.getAttribute("fill") === "#22C55E" &&
            tintedHollow.querySelector("circle.annot-shape")?.getAttribute("fill-opacity") === "1");
        check("空心圆：白底红边，没有尖头",
            hollowCircle?.getAttribute("stroke") === "#EF4444" &&
            hollowCircle?.getAttribute("fill") === "#FFFFFF" &&
            Number(hollowCircle?.getAttribute("fill-opacity")) === 1 &&
            !hollow.querySelector("path.annot-head"),
            `${hollowCircle?.getAttribute("stroke")} / ${hollowCircle?.getAttribute("fill")} / ${hollowCircle?.getAttribute("fill-opacity")}`);

        // 空心圆也能拉引线：线从圆边起画，不横穿内部
        const startX = (el) => {
            const m = (el?.getAttribute("d") ?? "").match(/^M\s*(-?[\d.]+)\s+(-?[\d.]+)/);
            return m ? Number(m[1]) : NaN;
        };
        const hollowLeader = renderObject(make("hollow", false, 90), {zoom: 1});
        check("空心圆能拉出引线，起点让到圆边（不横穿圆内）",
            startX(hollowLeader.querySelector("path.annot-shape")) > 100 + 15 &&
            !!hollowLeader.querySelector("path.annot-head"),
            String(startX(hollowLeader.querySelector("path.annot-shape"))));

        // 纯数字：没有外框，只剩文字；同样能拉引线
        const plain = renderObject(make("plain", false, 0), {zoom: 1});
        check("纯数字：没有任何外框，只剩数字",
            !plain.querySelector("circle") && !plain.querySelector("path.annot-head") &&
            plain.querySelector("text")?.textContent === "1",
            plain.querySelector("text")?.textContent ?? "无文字");
        const plainLeader = renderObject(make("plain", false, 90), {zoom: 1});
        check("纯数字也能拉出引线，起点在数字外侧",
            startX(plainLeader.querySelector("path.annot-shape")) > 100 + 10 &&
            !!plainLeader.querySelector("path.annot-head"),
            String(startX(plainLeader.querySelector("path.annot-shape"))));

        // 圆头开关：尖头折角与引线端帽
        const sharp = renderObject({...make("pointer", true, 90), style: {...base, bubbleRound: false}}, {zoom: 1});
        const roundOne = renderObject({...make("pointer", true, 90), style: {...base, bubbleRound: true}}, {zoom: 1});
        check("圆头关：尖头是尖角、引线是平口",
            sharp.querySelector("path.annot-head")?.getAttribute("stroke-linejoin") === "miter" &&
            sharp.querySelector("line.annot-shape")?.getAttribute("stroke-linecap") === "butt",
            `${sharp.querySelector("path.annot-head")?.getAttribute("stroke-linejoin")} / ${sharp.querySelector("line.annot-shape")?.getAttribute("stroke-linecap")}`);
        check("圆头开：尖头与引线末端变圆",
            roundOne.querySelector("path.annot-head")?.getAttribute("stroke-linejoin") === "round" &&
            roundOne.querySelector("line.annot-shape")?.getAttribute("stroke-linecap") === "round");

        // 缺尖头数据的定位气泡（从圆形切过来 / 老场景）：绝不能画出 NaN 路径
        const blank = {...make("pointer", false, 0), geometry: {center: {x: 100, y: 100}, tip: null, control: null, number: 1, radius: 20, bubble: "pointer", leader: false}};
        const blankEl = renderObject(blank, {zoom: 1});
        const blankMarkup = blankEl.outerHTML;
        check("缺尖头时安全降级成一个完整的圆，不产生 NaN",
            !blankMarkup.includes("NaN") &&
            !!blankEl.querySelector("circle") &&
            !blankEl.querySelector("path.annot-head"),
            blankMarkup.includes("NaN") ? "出现 NaN" : "无 NaN");

        // 补全用的默认尖头：右下 45°、1.5 倍半径
        const def = defaultPointerTip({center: {x: 50, y: 50}, radius: 20});
        const dist = Math.hypot(def.x - 50, def.y - 50);
        check("默认尖头在右下 45°、长度 1.5R",
            Math.abs(dist - 30) < 0.01 && Math.abs((def.x - 50) - (def.y - 50)) < 0.01,
            `距离 ${dist.toFixed(2)}`);
    }
    check("定位气泡：拖得够远时有细引线", far.querySelectorAll("line.annot-shape").length === 1);

    const short = renderObject(make("pointer", true, 24), {zoom: 1});
    check("定位气泡：距离不到尖头长度时不画引线（防误触）",
        short.querySelectorAll("line.annot-shape").length === 0);
    check("定位气泡：这种情况下尖头仍在", !!short.querySelector("path.annot-head"));

    const noLeader = renderObject(make("pointer", false, 90), {zoom: 1});
    check("定位气泡：关掉引线开关后没有引线",
        noLeader.querySelectorAll("line.annot-shape").length === 0);

    const circle = renderObject(make("circle", true, 90), {zoom: 1});
    check("圆形气泡仍是原来的引线端点样式，不是尖头三角形",
        circle.querySelectorAll("line.annot-shape").length === 0 &&
        !!circle.querySelector("path.annot-shape"),
        "");

    // 文字必须水平：不能有任何 rotate 变换
    const label = far.querySelector("text");
    check("定位气泡：文字没有旋转（始终水平）",
        !!label && !label.getAttribute("transform") && label.getAttribute("text-anchor") === "middle");
}

console.log(`\n带形状的马赛克渲染：${failed === 0 ? "全部通过" : failed + " 条失败"}`);
process.exit(failed > 0 ? 1 : 0);
