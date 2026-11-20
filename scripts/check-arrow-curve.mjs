/**
 * 箭头几何的独立检查（不经 DOM，直接对 arrowGeometry.ts 求值）。
 *
 * 覆盖两件容易回归的事：
 * 1. 现代样式掰弯后，杆的视觉粗细必须和直线时一样（不能细成一根头发丝）；
 * 2. 两端竖线各自垂直于所在端点的切线（曲线时起点切线来自 start→control）。
 */
import {build} from "esbuild";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "annot-arrow-"));
const bundle = path.join(dir, "arrow.mjs");
await build({
    entryPoints: [path.join(root, "src/editor/arrowGeometry.ts")],
    bundle: true,
    format: "esm",
    outfile: bundle,
    logLevel: "silent",
});
const {arrowShape, arrowBars, arrowTipDir, arrowHeadSize, modernCurvedShaft} = await import(pathToFileURL(bundle).href);

let failed = 0;
const results = [];
const check = (name, ok, detail = "") => {
    results.push({name, ok, detail});
    if (!ok) failed++;
};

/** path 里所有坐标数字的外接框 */
function pathBox(d) {
    const nums = (d || "").match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const xs = [];
    const ys = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        xs.push(nums[i]);
        ys.push(nums[i + 1]);
    }
    if (!xs.length) return {w: 0, h: 0};
    return {w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)};
}

const lw = 4;
const straight = {start: {x: 100, y: 300}, end: {x: 500, y: 300}, control: null};
const curved = {start: {x: 100, y: 300}, end: {x: 500, y: 300}, control: {x: 300, y: 150}};

// ---------------------------------------------------------------- 1. 现代样式：掰弯后仍是「尾细头粗」
{
    const headSize = arrowHeadSize("modern", lw);
    const st = arrowShape(straight, "modern", lw);
    const cv = arrowShape(curved, "modern", lw);
    check("尖尾直线也是填色楔形杆（尾细头粗）", !!st.shaft && st.shaftFilled === true,
        `shaft=${!!st.shaft} filled=${st.shaftFilled}`);
    check("现代样式弯曲后杆是填色多边形，不是一根统一粗细的描边",
        !!cv.shaft && cv.shaftFilled === true, `shaftFilled=${cv.shaftFilled}`);

    const poly = modernCurvedShaft(curved, headSize);
    // 直线的杆：起点一个点 → 箭头根部张开到 2 × shaftHalf
    const shaftHalf = headSize * 1.5 * 0.25;
    check("曲线杆尾部收成一点（尾细）",
        poly.tailWidth < 0.01, `tail=${poly.tailWidth.toFixed(3)}`);
    check("曲线杆在箭头根部张到与直线相同的几何宽度（头粗）",
        Math.abs(poly.headWidth - shaftHalf * 2) < 0.5,
        `head=${poly.headWidth.toFixed(2)} / 期望 ${(shaftHalf * 2).toFixed(2)}`);
    check("曲线杆确实是渐变的（头比尾宽）",
        poly.headWidth > poly.tailWidth + 1,
        `${poly.tailWidth.toFixed(2)} → ${poly.headWidth.toFixed(2)}`);

    // 视觉粗细（几何 + 描边）必须和直线一致
    const straightVisual = shaftHalf * 2 + lw;
    const curveVisual = poly.headWidth + lw;
    check("弯曲后箭头根部的视觉粗细与直线一致",
        Math.abs(curveVisual - straightVisual) < 0.6,
        `${curveVisual.toFixed(2)} / 直线 ${straightVisual.toFixed(2)}`);

    // 穿模：杆要停在箭头内部（2 × 头尺寸处），既不出尖端、也不和燕尾之间留缺口
    const depth = headSize * 2;
    const toEnd = Math.hypot(poly.lastPoint.x - curved.end.x, poly.lastPoint.y - curved.end.y);
    check("曲线杆末端插在箭头内部，不露尖端、也不留缺口",
        toEnd >= depth * 0.85 && toEnd <= depth * 1.15,
        `回缩 ${toEnd.toFixed(2)} / 期望 ${depth.toFixed(2)}`);
    // 杆末端的半宽必须小于头部三角在该处的半宽，否则会从燕尾的凹口两侧露出来
    const headHalfAtDepth = depth / 3;
    check("杆末端窄于箭头在该处的开口（燕尾的凹背不会撕出缺口）",
        poly.headWidth / 2 < headHalfAtDepth,
        `杆半宽 ${(poly.headWidth / 2).toFixed(2)} < 头部半宽 ${headHalfAtDepth.toFixed(2)}`);
}

// ---------------------------------------------------------------- 2. 头部不随弯曲变形
{
    for (const style of ["classic", "basic", "line", "double", "barDouble"]) {
        const a = pathBox(arrowShape(straight, style, lw).heads[0]?.d);
        const b = pathBox(arrowShape(curved, style, lw).heads[0]?.d);
        // 曲线会绕着头部的切线方向转，外接框比例可能有别，这里只比"最大跨度"
        const spanA = Math.max(a.w, a.h);
        const spanB = Math.max(b.w, b.h);
        // 起点端（双头）用 atStart 单独比
        check(`${style}：弯曲后头部跨度不变（±12%）`,
            spanB > 0 && Math.abs(spanB - spanA) / spanA < 0.12,
            `直线 ${spanA.toFixed(2)} / 曲线 ${spanB.toFixed(2)}`);
    }
}

// ---------------------------------------------------------------- 3. 两端竖线各贴各的切线
{
    const bars = arrowBars(curved, lw);
    const dirStart = arrowTipDir(curved, true);
    const dirEnd = arrowTipDir(curved, false);
    const barDir = (bar) => {
        const dx = bar.x2 - bar.x1;
        const dy = bar.y2 - bar.y1;
        const len = Math.hypot(dx, dy) || 1;
        return {x: dx / len, y: dy / len};
    };
    const dot = (a, b) => a.x * b.x + a.y * b.y;
    check("曲线：左端竖线垂直于起点切线",
        Math.abs(dot(barDir(bars[0]), dirStart)) < 1e-6,
        `dot=${dot(barDir(bars[0]), dirStart).toFixed(4)}`);
    check("曲线：右端竖线垂直于末端切线",
        Math.abs(dot(barDir(bars[1]), dirEnd)) < 1e-6,
        `dot=${dot(barDir(bars[1]), dirEnd).toFixed(4)}`);
    // 左端竖线不该和右端平行（曲线两端切线不同）
    const cross = barDir(bars[0]).x * barDir(bars[1]).y - barDir(bars[0]).y * barDir(bars[1]).x;
    check("曲线：左右竖线方向不同（不再共用末端切线）", Math.abs(cross) > 0.05,
        `cross=${cross.toFixed(3)}`);

    const lineBars = arrowBars(straight, lw);
    check("直线：两端竖线仍然竖直",
        Math.abs(lineBars[0].x1 - lineBars[0].x2) < 1e-6 &&
        Math.abs(lineBars[1].x1 - lineBars[1].x2) < 1e-6);
}

// ---------------------------------------------------------------- 3.5 菱形头是正方形旋转 45°
{
    const g = {start: {x: 100, y: 300}, end: {x: 400, y: 300}, control: null};
    const shape = arrowShape(g, {type: "single", head: "rhombus"}, 4);
    const box = pathBox(shape.heads[0]?.d);
    check("菱形头纵横等长（正方形旋转 45°，不是梭形）",
        box.w > 0 && Math.abs(box.w - box.h) / Math.max(box.w, box.h) < 0.02,
        `${box.w.toFixed(2)} × ${box.h.toFixed(2)}`);
}

// ---------------------------------------------------------------- 3.6 视觉重量：粗线不暴涨
{
    const half = (w) => arrowHeadSize("basic", w);
    const r = half(4) / half(2);
    check("线宽 2→4 时箭头只放大 1.4~1.85 倍（不跟着翻倍）", r > 1.4 && r < 1.85, `${r.toFixed(2)}×`);
    check("线宽 12 时箭头最宽处仍不小于线宽的 3 倍",
        (half(12) * 2) / 12 >= 3 - 1e-6, `${((half(12) * 2) / 12).toFixed(2)}×`);
    check("2px 基准：头长约为线宽的 5 倍以上",
        (half(2) * 6.4) / 2 >= 5, `${((half(2) * 6.4) / 2).toFixed(2)}×`);
    // 粗线区间受「宽 ≥ 3 倍线宽」的下限约束，只能贴着下限走，不再额外放大
    const r12 = half(12) / half(6);
    check("6→12 时贴着下限走，不超过 2 倍", r12 <= 2.02, `${r12.toFixed(2)}×`);
}

// ---------------------------------------------------------------- 4. 双头箭头方向
{
    const shape = arrowShape(curved, "double", lw);
    check("双头样式弯曲后仍是两个头", shape.heads.length === 2);
    const startDir = arrowTipDir(curved, true);
    const endDir = arrowTipDir(curved, false);
    check("双头两端方向相反（一头朝起点、一头朝终点）",
        startDir.x * endDir.x + startDir.y * endDir.y < 0.9,
        `${startDir.x.toFixed(2)},${startDir.y.toFixed(2)} / ${endDir.x.toFixed(2)},${endDir.y.toFixed(2)}`);
}

await rm(dir, {recursive: true, force: true});

for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
}
console.log(`\n箭头几何检查：${results.length - failed}/${results.length} 通过`);
process.exit(failed > 0 ? 1 : 0);
