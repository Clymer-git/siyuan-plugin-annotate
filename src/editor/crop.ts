/**
 * 裁切框的几何运算（纯函数，全部用画布坐标）。
 *
 * 为什么单独拆出来：裁切框的「拖手柄 / 拖框内 / 拖出新框 / 锁比例」是四种
 * 不同的拖拽，但都要处理同一堆边界夹取与最小尺寸问题。混在编辑器里会很难测，
 * 这里做成纯函数，单元测试（DOM smoke）直接喂坐标断言结果。
 *
 * 约定：所有返回值的 x/y 是左上角，width/height 恒为正；
 * ratio = 宽 / 高（null 表示自由比例）。
 */
import type {Bounds} from "./shapes";
import type {Matrix, Point} from "../types";
import {applyMatrix} from "./canvas";

export type CropHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

export const CROP_HANDLES: CropHandle[] = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];

/** 比例预设：key 用于按钮标记，ratio 为 宽/高，source 表示跟随原图，null 表示自由 */
export interface CropRatioPreset {
    key: string;
    label: string;
    ratio: number | "source" | null;
}

/**
 * 比例预设。用户要求「常用的都加上」：方形、照片、屏幕、竖屏、打印、宽幅。
 * 2.35:1 是宽银幕，5:4 是打印/相框常用。
 */
export const CROP_RATIO_PRESETS: CropRatioPreset[] = [
    {key: "free", label: "自由", ratio: null},
    {key: "source", label: "原图", ratio: "source"},
    {key: "1:1", label: "1:1", ratio: 1},
    {key: "4:3", label: "4:3", ratio: 4 / 3},
    {key: "3:4", label: "3:4", ratio: 3 / 4},
    {key: "3:2", label: "3:2", ratio: 3 / 2},
    {key: "2:3", label: "2:3", ratio: 2 / 3},
    {key: "16:9", label: "16:9", ratio: 16 / 9},
    {key: "9:16", label: "9:16", ratio: 9 / 16},
    {key: "5:4", label: "5:4", ratio: 5 / 4},
    {key: "2.35:1", label: "2.35:1", ratio: 2.35},
];

const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(Math.max(value, lo), Math.max(lo, hi));

/** 按比例把宽高整理成整数：宽度取整，高度跟着比例算，保证比例不走样 */
function withRatio(width: number, ratio: number, min: number): {w: number; h: number} {
    const w = Math.max(1, Math.round(width));
    return {w, h: Math.max(min, Math.round(w / ratio))};
}

/** 拖出新框：起点 + 当前点；ratio 为 null 时自由拖 */
export function dragCropRect(
    start: Point,
    current: Point,
    canvasWidth: number,
    canvasHeight: number,
    ratio: number | null,
    min: number,
): Bounds {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const toRight = dx >= 0;
    const toBottom = dy >= 0;
    // 移动方向上还有多少空间
    const availW = toRight ? canvasWidth - start.x : start.x;
    const availH = toBottom ? canvasHeight - start.y : start.y;

    let w = Math.abs(dx);
    let h = Math.abs(dy);

    if (ratio) {
        // 以「变化更大的一边」为准，另一边跟着走，手感更贴手
        if (w / ratio >= h) h = w / ratio;
        else w = h * ratio;
        // 画布边界可能不给足：能放下的最大宽度
        const maxW = Math.max(min, Math.min(availW, availH * ratio));
        if (w > maxW) {
            w = maxW;
            h = w / ratio;
        }
        const fixed = withRatio(w, ratio, min);
        w = fixed.w;
        h = fixed.h;
    } else {
        w = Math.min(Math.abs(dx), availW);
        h = Math.min(Math.abs(dy), availH);
    }

    const x = toRight ? start.x : start.x - w;
    const y = toBottom ? start.y : start.y - h;
    return {
        x: Math.round(clamp(x, 0, Math.max(0, canvasWidth - w))),
        y: Math.round(clamp(y, 0, Math.max(0, canvasHeight - h))),
        width: Math.max(1, Math.round(w)),
        height: Math.max(1, Math.round(h)),
    };
}

/**
 * 拖手柄缩放：dx/dy 是本次鼠标位移（画布坐标）。
 * 锚点是对角/对边，锁比例时按宽度（角、左右手柄）或按高度（上下手柄）推算另一边。
 */
export function resizeCropRect(
    rect: Bounds,
    handle: CropHandle,
    dx: number,
    dy: number,
    canvasWidth: number,
    canvasHeight: number,
    ratio: number | null,
    min: number,
): Bounds {
    const left = rect.x;
    const top = rect.y;
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const west = handle.includes("w");
    const east = handle.includes("e");
    const north = handle.includes("n");
    const south = handle.includes("s");

    // 原始目标尺寸（未夹取）
    const rawW = east ? right + dx - left : west ? right - (left + dx) : rect.width;
    const rawH = south ? bottom + dy - top : north ? bottom - (top + dy) : rect.height;

    let w: number;
    let h: number;
    if (ratio) {
        if (east || west) {
            const availW = west ? right : canvasWidth - left;
            const availH = north ? bottom : canvasHeight - top;
            const maxW = Math.max(min, Math.min(availW, availH * ratio));
            w = clamp(rawW, min, maxW);
            const fixed = withRatio(w, ratio, min);
            w = Math.min(fixed.w, Math.floor(maxW));
            h = Math.max(min, Math.round(w / ratio));
        } else {
            const availW = canvasWidth - left;
            const availH = north ? bottom : canvasHeight - top;
            const maxH = Math.max(min, Math.min(availH, availW / ratio));
            h = clamp(rawH, min, maxH);
            const fixed = withRatio(h * ratio, ratio, min);
            h = Math.max(min, Math.round(fixed.w / ratio));
            w = Math.max(1, Math.round(h * ratio));
        }
    } else {
        const maxW = east ? canvasWidth - left : west ? right : rect.width;
        const maxH = south ? canvasHeight - top : north ? bottom : rect.height;
        w = clamp(rawW, min, maxW);
        h = clamp(rawH, min, maxH);
    }

    const x = west ? right - w : left;
    const y = north ? bottom - h : top;
    return {
        x: Math.round(clamp(x, 0, Math.max(0, canvasWidth - w))),
        y: Math.round(clamp(y, 0, Math.max(0, canvasHeight - h))),
        width: Math.max(1, Math.round(w)),
        height: Math.max(1, Math.round(h)),
    };
}

/** 框内按住拖动：整体平移，不越出画布 */
export function moveCropRect(
    rect: Bounds,
    dx: number,
    dy: number,
    canvasWidth: number,
    canvasHeight: number,
): Bounds {
    return {
        x: Math.round(clamp(rect.x + dx, 0, Math.max(0, canvasWidth - rect.width))),
        y: Math.round(clamp(rect.y + dy, 0, Math.max(0, canvasHeight - rect.height))),
        width: rect.width,
        height: rect.height,
    };
}

/**
 * 切换比例时把现有框「原地调到该比例」：保持中心，尽量大但不超出画布。
 * 没框时返回 null（用户还没拉框，比例只记下来，等拖的时候生效）。
 */
export function fitCropRatio(
    rect: Bounds | null,
    ratio: number,
    canvasWidth: number,
    canvasHeight: number,
    min: number,
): Bounds | null {
    if (!rect) return null;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const maxW = Math.max(min, Math.min(canvasWidth, canvasHeight * ratio));
    let width = Math.min(Math.max(rect.width, min), maxW);
    let fixed = withRatio(width, ratio, min);
    if (fixed.w > maxW) {
        fixed = withRatio(maxW, ratio, min);
    }
    const {w, h} = fixed;
    return {
        x: Math.round(clamp(centerX - w / 2, 0, Math.max(0, canvasWidth - w))),
        y: Math.round(clamp(centerY - h / 2, 0, Math.max(0, canvasHeight - h))),
        width: w,
        height: h,
    };
}

/** 整张画布（第二步「整图」按钮用） */
export function fullCropRect(canvasWidth: number, canvasHeight: number): Bounds {
    return {x: 0, y: 0, width: Math.max(1, Math.round(canvasWidth)), height: Math.max(1, Math.round(canvasHeight))};
}

/**
 * 底图在「当前画布坐标」里占的范围（四个角变换后的外接矩形）。
 *
 * 为什么需要它：裁剪只是把画布窗口改小，底图本身还完整躺在文件里。
 * 再进裁剪时用这个范围算出「最多能扩回哪里」，用户就能把范围拖回上一次裁掉的部分。
 * 矩阵只有 0/90/180/270 的旋转与翻转，所以四角外接矩形就是精确边界。
 */
export function imageBounds(naturalWidth: number, naturalHeight: number, matrix: Matrix): Bounds {
    const w = Math.max(1, naturalWidth);
    const h = Math.max(1, naturalHeight);
    const corners = [
        applyMatrix(matrix, {x: 0, y: 0}),
        applyMatrix(matrix, {x: w, y: 0}),
        applyMatrix(matrix, {x: 0, y: h}),
        applyMatrix(matrix, {x: w, y: h}),
    ];
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.max(1, Math.round(Math.max(...xs) - left)),
        height: Math.max(1, Math.round(Math.max(...ys) - top)),
    };
}

/** 两个矩形的并集（用来算「当前窗口 + 完整底图」的最大可裁范围） */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.max(1, Math.round(right - left)),
        height: Math.max(1, Math.round(bottom - top)),
    };
}

/** 当前框是否符合某个比例（容差 1px，用于尺寸标签与按钮状态） */
export function ratioOfRect(rect: Bounds): number | null {
    if (!rect.width || !rect.height) return null;
    return rect.width / rect.height;
}
