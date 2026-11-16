/**
 * 画布变换：旋转 / 翻转 / 裁切 / 扩展画布。
 *
 * 关键设计：底图与标注共用一套「画布坐标系」。
 * - 画布尺寸由 CanvasState.width/height 决定，SVG 的 viewBox 恒等于 0 0 宽 高。
 * - 原始图片通过一个仿射矩阵贴进画布，因此旋转 90° 时画布宽高对调、
 *   原图跟着转，而原始图片文件从头到尾不被修改。
 * - 画布一改变，所有标注的坐标也要跟着做同一套变换，否则标注会「漂」到别处。
 *   这一步由 remapObjects() 完成：把每个几何点喂进同一个映射函数即可。
 */

import {getBounds, boundsCenter} from "./shapes";
import type {
    AnnotObject, CanvasState, CropWindow, Matrix, Point,
    ArrowGeometry, EllipseGeometry, HighlightGeometry, LineGeometry, NumberGeometry,
    RectGeometry, TextGeometry,
} from "../types";

export const IDENTITY: Matrix = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};

export function isIdentity(m: Matrix): boolean {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

export function createCanvas(naturalWidth: number, naturalHeight: number): CanvasState {
    return {
        width: naturalWidth,
        height: naturalHeight,
        naturalWidth,
        naturalHeight,
        matrix: {...IDENTITY},
        background: null,
    };
}

/** 先应用 inner，再应用 outer（矩阵乘法 outer ∘ inner） */
export function multiply(outer: Matrix, inner: Matrix): Matrix {
    return {
        a: outer.a * inner.a + outer.c * inner.b,
        b: outer.b * inner.a + outer.d * inner.b,
        c: outer.a * inner.c + outer.c * inner.d,
        d: outer.b * inner.c + outer.d * inner.d,
        e: outer.a * inner.e + outer.c * inner.f + outer.e,
        f: outer.b * inner.e + outer.d * inner.f + outer.f,
    };
}

export function applyMatrix(m: Matrix, p: Point): Point {
    return {x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f};
}

/** 只对轴对齐矩阵求逆（我们始终只产生这类矩阵），det 不会为 0 */
export function invert(m: Matrix): Matrix {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return {...IDENTITY};
    return {
        a: m.d / det,
        b: -m.b / det,
        c: -m.c / det,
        d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det,
        f: (m.b * m.e - m.a * m.f) / det,
    };
}

export function toMatrixString(m: Matrix): string {
    return `${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f}`;
}

/** 矩阵作用在矩形上得到的包围盒（轴对齐矩阵下就是精确矩形） */
export function mapRect(m: Matrix, rect: {x: number; y: number; width: number; height: number}) {
    const corners = [
        {x: rect.x, y: rect.y},
        {x: rect.x + rect.width, y: rect.y},
        {x: rect.x, y: rect.y + rect.height},
        {x: rect.x + rect.width, y: rect.y + rect.height},
    ].map((p) => applyMatrix(m, p));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
    };
}

// ---------------------------------------------------------------- 画布本身
/** 顺时针 90°：(x, y) → (H - y, x)，画布宽高对调 */
export function rotateCanvas(canvas: CanvasState, direction: 1 | -1): CanvasState {
    const {width, height} = canvas;
    const rotation: Matrix = direction > 0
        ? {a: 0, b: 1, c: -1, d: 0, e: height, f: 0}
        : {a: 0, b: -1, c: 1, d: 0, e: 0, f: width};
    return {
        ...canvas,
        width: height,
        height: width,
        matrix: multiply(rotation, canvas.matrix),
    };
}

export function flipCanvas(canvas: CanvasState, axis: "x" | "y"): CanvasState {
    const flip: Matrix = axis === "x"
        ? {a: -1, b: 0, c: 0, d: 1, e: canvas.width, f: 0}
        : {a: 1, b: 0, c: 0, d: -1, e: 0, f: canvas.height};
    return {...canvas, matrix: multiply(flip, canvas.matrix)};
}

/**
 * 「完整视图」＝把完整底图按矩阵里的线性部分（旋转 / 翻转）贴好，
 * 再把外接矩形的左上角平移到 (0,0)。
 *
 * 为什么需要它：参考插件保存时会额外留一份完整原图，再打开裁剪时把整幅图
 * 重新铺出来，用户才能把范围扩回上次裁掉的外面。我们的底图本来就是完整原图，
 * 所以只要算出这个完整视图，就能做到一模一样，而且不用把图片烤一遍、不失真。
 */
export function fullViewOf(canvas: CanvasState): {width: number; height: number; matrix: Matrix} {
    const {a, b, c, d} = canvas.matrix;
    const w = Math.max(1, canvas.naturalWidth || canvas.width || 1);
    const h = Math.max(1, canvas.naturalHeight || canvas.height || 1);
    const xs = [0, a * w, c * h, a * w + c * h];
    const ys = [0, b * w, d * h, b * w + d * h];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
        width: Math.max(1, Math.round(Math.max(...xs) - minX)),
        height: Math.max(1, Math.round(Math.max(...ys) - minY)),
        matrix: {...canvas.matrix, e: -minX, f: -minY},
    };
}

/**
 * 从画布矩阵反推裁剪窗口（老场景里没有显式 crop 字段时兜底）。
 * 恒等式：画布矩阵＝完整视图矩阵再平移 (−窗口.x, −窗口.y)。
 */
export function cropWindowOf(canvas: CanvasState): CropWindow {
    const full = fullViewOf(canvas);
    return {
        x: Math.round(full.matrix.e - canvas.matrix.e),
        y: Math.round(full.matrix.f - canvas.matrix.f),
        width: Math.max(1, Math.round(canvas.width)),
        height: Math.max(1, Math.round(canvas.height)),
    };
}

/** 这个窗口是否已经不是完整原图（裁过、或扩过画布留白） */
export function isCroppedWindow(crop: CropWindow, canvas: CanvasState): boolean {
    const full = fullViewOf(canvas);
    return Math.round(crop.x) !== 0 || Math.round(crop.y) !== 0
        || Math.round(crop.width) !== full.width || Math.round(crop.height) !== full.height;
}

/** 裁切：画布原点移到裁切框左上角，底图同步平移 */
export function cropCanvas(
    canvas: CanvasState,
    rect: {x: number; y: number; width: number; height: number},
): CanvasState {
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    return {
        ...canvas,
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        matrix: {...canvas.matrix, e: canvas.matrix.e - x, f: canvas.matrix.f - y},
    };
}

/** 四个方向各自的扩展量（像素，>=0） */
export interface ExtendMargins {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/**
 * 扩展画布：按方向分别加留白。
 * 只加某一边时，底图位置只在该方向平移，其它方向不变形。
 */
export function extendCanvas(canvas: CanvasState, margins: ExtendMargins): CanvasState {
    const clamp = (v: number) => Math.max(0, Math.min(4000, Math.round(Number.isFinite(v) ? v : 0)));
    const top = clamp(margins.top);
    const right = clamp(margins.right);
    const bottom = clamp(margins.bottom);
    const left = clamp(margins.left);
    return {
        ...canvas,
        width: Math.max(1, canvas.width + left + right),
        height: Math.max(1, canvas.height + top + bottom),
        matrix: {...canvas.matrix, e: canvas.matrix.e + left, f: canvas.matrix.f + top},
    };
}

// ---------------------------------------------------------------- 标注跟随变换
export interface RemapOptions {
    /** 旋转角度增量（90° 旋转时用） */
    angleDelta?: number;
    /** 翻转时把对象自身角度取反（镜像后角度方向相反） */
    negateRotation?: boolean;
}

function normalizeAngle(degrees: number): number {
    let value = degrees % 360;
    if (value > 180) value -= 360;
    if (value <= -180) value += 360;
    return value;
}

/** 包围盒中心一起走，宽高不变（矩形/椭圆/文字/马赛克用） */
function moveCenter(object: AnnotObject, mapPoint: (p: Point) => Point): void {
    const bounds = getBounds(object);
    const center = boundsCenter(bounds);
    const next = mapPoint(center);
    const dx = next.x - center.x;
    const dy = next.y - center.y;
    switch (object.type) {
        case "rect":
        case "highlightRect":
        case "mosaic":
        case "blur": {
            const r = object.geometry as RectGeometry;
            r.x += dx;
            r.y += dy;
            break;
        }
        case "ellipse": {
            const e = object.geometry as EllipseGeometry;
            e.cx += dx;
            e.cy += dy;
            break;
        }
        case "text": {
            const t = object.geometry as TextGeometry;
            t.x += dx;
            t.y += dy;
            break;
        }
        case "magnifier": {
            // 镜框整体平移时，锚点也跟着走（它是同一个对象的一部分）
            const m = object.geometry as {x: number; y: number; anchor: {x: number; y: number}};
            m.x += dx;
            m.y += dy;
            m.anchor = {x: m.anchor.x + dx, y: m.anchor.y + dy};
            break;
        }
        default:
            break;
    }
}

/**
 * 把所有标注按同一个坐标映射搬到新画布坐标系。
 * 提示：这里改的是几何数据本身（而不是给渲染层加个外层变换），
 * 好处是旋转之后手柄、命中检测、属性面板里的数值全部自然正确。
 */
export function remapObjects(
    objects: AnnotObject[],
    mapPoint: (p: Point) => Point,
    options: RemapOptions = {},
): void {
    const {angleDelta = 0, negateRotation = false} = options;
    for (const object of objects) {
        switch (object.type) {
            case "arrow": {
                const a = object.geometry as ArrowGeometry;
                object.geometry = {
                    start: mapPoint(a.start),
                    end: mapPoint(a.end),
                    control: a.control ? mapPoint(a.control) : null,
                } as ArrowGeometry;
                break;
            }
            case "highlight": {
                const h = object.geometry as HighlightGeometry;
                h.points = h.points.map(mapPoint);
                break;
            }
            case "line": {
                const l = object.geometry as LineGeometry;
                l.points = l.points.map(mapPoint);
                break;
            }
            case "number": {
                const n = object.geometry as NumberGeometry;
                n.center = mapPoint(n.center);
                if (n.tip) n.tip = mapPoint(n.tip);
                if (n.control) n.control = mapPoint(n.control);
                break;
            }
            default:
                moveCenter(object, mapPoint);
                break;
        }
        // 对象自身的旋转角：平移不受影响，旋转/翻转要跟着改
        const geometry = object.geometry as {rotation?: number};
        if (object.type !== "arrow" && object.type !== "number" &&
            object.type !== "highlight" && object.type !== "highlightRect" &&
            object.type !== "line") {
            const current = geometry.rotation ?? 0;
            if (negateRotation) geometry.rotation = normalizeAngle(-current);
            else if (angleDelta) geometry.rotation = normalizeAngle(current + angleDelta);
            if (geometry.rotation === 0) delete geometry.rotation;
        }
        object.meta.updatedAt = Date.now();
    }
}
