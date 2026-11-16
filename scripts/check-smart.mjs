/**
 * 预识别分区算法的单元测试（不依赖浏览器 / Canvas / Worker）。
 *
 * 做法：esbuild 现场把 src/editor/smartSelect.ts 转成 ESM，喂合成图，
 * 断言 detectRegions 能把画面切成「一块块独立的矩形」：
 * 图标、标题、描述、元信息各是一个框，而不是整张卡片一大块。
 *
 * 用法：node scripts/check-smart.mjs
 */
import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {transformSync} from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outPath = path.join(root, "_tools/smartSelect.mjs");
mkdirSync(path.dirname(outPath), {recursive: true});
const compiled = transformSync(readFileSync(path.join(root, "src/editor/smartSelect.ts"), "utf8"), {
    loader: "ts",
    format: "esm",
    target: "es2022",
}).code;
writeFileSync(outPath, compiled);
const {detectRegions} = await import(pathToFileURL(outPath).href);

let failed = 0;
const check = (name, ok, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

function makeImage(w, h, paint) {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const rgb = paint(x, y);
            data[p] = rgb[0];
            data[p + 1] = rgb[1];
            data[p + 2] = rgb[2];
            data[p + 3] = rgb[3] ?? 255;
        }
    }
    return {data, width: w, height: h};
}

const WHITE = [250, 250, 250];
const DARK = [28, 38, 52];
const CARD = [238, 242, 247];
const MUTED = [110, 120, 135];
const ICON = [80, 90, 220];

/** 笔画式「字」：2 横 3 竖，接近真实文字的笔画密度（实心块会让边缘检测失真） */
function drawGlyph(put, x, y, size, color) {
    const t = Math.max(1, Math.round(size / 6));
    const rect = (rx, ry, rw, rh) => {
        for (let j = ry; j < ry + rh; j++) for (let i = rx; i < rx + rw; i++) put(i, j, color);
    };
    rect(x, y, size, t);
    rect(x, y + size - t, size, t);
    rect(x + Math.round(size / 2) - Math.floor(t / 2), y, t, size);
    rect(x + Math.floor(t / 2), y, t, Math.round(size * 0.6));
    rect(x + size - t - Math.floor(t / 2), y + Math.round(size * 0.35), t, Math.round(size * 0.65));
}

function drawTextLine(put, x, y, size, gap, count, color) {
    for (let i = 0; i < count; i++) drawGlyph(put, x + i * (size + gap), y, size, color);
}

// 1) 三张卡片：每张含 图标 + 标题 + 描述 + 元信息，必须切成 4 块而不是一整张
{
    const W = 600;
    const H = 450;
    const img = makeImage(W, H, () => WHITE);
    const put = (x, y, color) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const p = (y * W + x) * 4;
        img.data[p] = color[0];
        img.data[p + 1] = color[1];
        img.data[p + 2] = color[2];
        img.data[p + 3] = 255;
    };
    const fill = (x, y, w, h, color) => {
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) put(i, j, color);
    };
    for (let i = 0; i < 3; i++) {
        const top = 20 + i * 150;
        fill(20, top, 560, 130, CARD);
        fill(40, top + 20, 64, 64, ICON);
        drawTextLine(put, 120, top + 26, 16, 6, 5, DARK);
        drawTextLine(put, 120, top + 62, 12, 4, 12, MUTED);
        drawTextLine(put, 120, top + 100, 10, 4, 6, MUTED);
    }
    const regions = detectRegions(img);
    const perCard = [0, 1, 2].map((i) => regions.filter((r) => {
        const cy = r.y + r.height / 2;
        return cy >= 20 + i * 150 && cy < 20 + (i + 1) * 150;
    }));
    check("每张卡片切成 4 块（图标 / 标题 / 描述 / 元信息）",
        perCard.every((list) => list.length === 4),
        perCard.map((l) => l.length).join("/"));
    check("图标单独一块，尺寸接近 64×64",
        perCard[0].some((r) => Math.abs(r.width - 64) < 10 && Math.abs(r.height - 64) < 10),
        perCard[0].map((r) => `${r.width}x${r.height}`).join(" "));
    check("没有任何一块覆盖整张卡片（宽 > 400 且高 > 100）",
        !regions.some((r) => r.width > 400 && r.height > 100),
        regions.filter((r) => r.width > 400 && r.height > 100).map((r) => `${r.width}x${r.height}`).join(","));
    check("三行文字各成一条（高 8~26）",
        perCard[0].filter((r) => r.height >= 8 && r.height <= 26).length === 3,
        perCard[0].map((r) => r.height).join("/"));
}

// 2) 一个实心方块
{
    const img = makeImage(300, 200, (x, y) =>
        x >= 90 && x < 210 && y >= 60 && y < 140 ? DARK : WHITE);
    const regions = detectRegions(img);
    const r = regions[0];
    check("一个方块切出 1 块", regions.length === 1, `${regions.length} 块`);
    check("框贴合方块（约 90,60 → 210,140）",
        !!r && Math.abs(r.x - 90) < 8 && Math.abs(r.y - 60) < 8 &&
        Math.abs(r.width - 120) < 14 && Math.abs(r.height - 80) < 14,
        r ? `${r.x},${r.y} ${r.width}x${r.height}` : "null");
}

// 3) 三行文字：每行一整条，行与行不粘连
{
    const W = 320;
    const H = 200;
    const img = makeImage(W, H, () => WHITE);
    const put = (x, y, color) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const p = (y * W + x) * 4;
        img.data[p] = color[0];
        img.data[p + 1] = color[1];
        img.data[p + 2] = color[2];
        img.data[p + 3] = 255;
    };
    for (const top of [50, 95, 140]) drawTextLine(put, 20, top, 16, 6, 10, DARK);
    const regions = detectRegions(img);
    check("三行文字切成 3 条", regions.length >= 3 && regions.length <= 5, `${regions.length} 条`);
    check("每条的横向范围覆盖整行（宽 > 160）",
        regions.every((r) => r.width > 160), regions.map((r) => r.width).join("/"));
    check("行与行没有粘在一起（每条高 < 40）",
        regions.every((r) => r.height < 40), regions.map((r) => r.height).join("/"));
}

// 4) 左右两个分开的物体：保持两块
{
    const img = makeImage(300, 120, (x, y) => {
        const left = x >= 20 && x < 80 && y >= 30 && y < 90;
        const right = x >= 200 && x < 260 && y >= 30 && y < 90;
        return left || right ? DARK : WHITE;
    });
    const regions = detectRegions(img);
    check("相距很远的两个物体保持 2 块", regions.length === 2, `${regions.length} 块`);
}

// 5) 纯背景：没有区域
{
    const img = makeImage(200, 200, () => WHITE);
    check("纯背景不产生任何框", detectRegions(img).length === 0);
}

// 6) 孤立噪点被过滤
{
    const img = makeImage(200, 200, (x, y) =>
        x >= 100 && x < 103 && y >= 100 && y < 103 ? DARK : WHITE);
    check("孤立噪点被过滤", detectRegions(img).length === 0);
}

// 7) 深色底 + 浅色主体
{
    const img = makeImage(240, 160, (x, y) =>
        x >= 60 && x < 180 && y >= 40 && y < 120 ? WHITE : [20, 22, 26]);
    const regions = detectRegions(img);
    check("深色底上的浅色主体也能切出来", regions.length === 1, `${regions.length} 块`);
}

// 8) 坐标边界与数量上限
{
    const img = makeImage(400, 300, (x, y) => {
        const col = Math.floor((x - 40) / 50);
        const row = Math.floor((y - 40) / 60);
        const inX = x >= 40 + col * 50 && x < 40 + col * 50 + 30;
        const inY = y >= 40 + row * 60 && y < 40 + row * 60 + 24;
        const inGrid = col >= 0 && col < 6 && row >= 0 && row < 4;
        return inGrid && inX && inY ? DARK : WHITE;
    });
    const regions = detectRegions(img);
    check("密集画面能切出若干块，且不超过 120", regions.length > 0 && regions.length <= 120, `${regions.length} 块`);
    check("所有框都在画面内",
        regions.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.width <= 400 && r.y + r.height <= 300));
}

console.log(`\n预识别分区算法：${failed === 0 ? "全部通过" : failed + " 条失败"}`);
process.exit(failed > 0 ? 1 : 0);
