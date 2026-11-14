/**
 * 箭头几何：唯一来源，严格按 ShareX.ImageEditor 的 ArrowAnnotation 实现。
 *
 * 参考源码（参考工程 ShareX-develop）：
 *   Core/Annotations/Shapes/ArrowAnnotation.cs
 *   常量：Classic/Double 头半宽 2×线宽，Modern 头尺寸 3×线宽，
 *         Basic/Line 头半宽 1.75×线宽；头长统一 3×头半宽；
 *         Classic 背弧控制点在尖端后方 2×头半宽处。
 *   渲染：主干与头部是同一个 Path 的多个 figure，fill 与 stroke 同为画笔色，
 *         stroke 宽度就是线宽。所以头部轮廓会向外扩半个线宽，
 *         正好把主干圆头（同样外扩半个线宽）盖住，尖端不会露出一截线头。
 *
 * 本文件只做数学与 path 字符串，不碰 DOM，方便静态测试逐点核对。
 */

import type {ArrowGeometry, ArrowStyleKey, Point} from "../types";

/** ShareX：头尺寸 / 线宽 */
const HEAD_MULTIPLIER: Record<ArrowStyleKey, number> = {
    classic: 2,
    modern: 3,
    double: 2,
    basic: 1.75,
    line: 1.75,
    bar: 0,
    barDouble: 1.75,
};

const HEAD_LENGTH_RATIO = 3;
const BACK_CURVE_CONTROL_RATIO = 2;
const MODERN_HEIGHT_RATIO = 2.5;
const MODERN_BASE_RATIO = 1.5;
const MODERN_SHAFT_RATIO = 0.25;
/** ShareX 的翼角：Math.PI / 5.14（约 35°） */
const MODERN_ANGLE = Math.PI / 5.14;
/** 两端竖线的默认半长：至少 10px，粗线按 2.5 倍 */
const DEFAULT_BAR_HALF = 10;

export interface ArrowBar {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface ArrowHeadPath {
    d: string;
    /** ShareX 里头部 figure 与主干共用画笔：闭合的填充，开放的只描边 */
    fill: boolean;
}

export interface ArrowShape {
    /** 主干；Modern 直线把杆并进闭合路径，此时为 null */
    shaft: string | null;
    heads: ArrowHeadPath[];
    bars: ArrowBar[];
}

const fmt = (p: Point): string => `${p.x} ${p.y}`;

const add = (a: Point, b: Point): Point => ({x: a.x + b.x, y: a.y + b.y});
const sub = (a: Point, b: Point): Point => ({x: a.x - b.x, y: a.y - b.y});
const mul = (a: Point, k: number): Point => ({x: a.x * k, y: a.y * k});
const perpOf = (u: Point): Point => ({x: -u.y, y: u.x});

/** 端点方向：直线指向另一端，曲线取末端切线（ShareX 的 GetQuadraticTangentAtEnd） */
export function arrowTipDir(g: ArrowGeometry, atStart = false): Point {
    const tip = atStart ? g.start : g.end;
    const ref = g.control ?? (atStart ? g.end : g.start);
    const d = sub(tip, ref);
    const len = Math.hypot(d.x, d.y);
    if (len < 0.0001) return {x: 1, y: 0};
    return {x: d.x / len, y: d.y / len};
}

export function arrowHeadSize(style: ArrowStyleKey, lineWidth: number): number {
    return Math.max(0.5, lineWidth) * HEAD_MULTIPLIER[style];
}

export function arrowBarHalf(lineWidth: number): number {
    return Math.max(DEFAULT_BAR_HALF, lineWidth * 2.5);
}

/** 主干路径：一律画到两个端点（两端竖线才不会留空隙），由头部轮廓负责盖住线头 */
export function arrowShaftPath(g: ArrowGeometry): string {
    return g.control
        ? `M ${fmt(g.start)} Q ${fmt(g.control)} ${fmt(g.end)}`
        : `M ${fmt(g.start)} L ${fmt(g.end)}`;
}

/**
 * 尖端 miter 溢出量：关闭圆角时，描边在尖角处会沿箭头方向伸出 (线宽/2)/sin(半角)，
 * 视觉尖端因此越过端点（竖线双头最明显——尖头戳出竖线）。把头部整体内缩这个距离，
 * 描边后的视觉尖端才正好落在端点上。
 *
 * 半角由几何本身决定：经典 / 基础 / 竖线双头为 atan(1/3)（sin = 1/√10），
 * 现代为大翼尖角（tan = 0.6·tan(π/5.14)）。
 */
export function arrowTipMiterInset(style: ArrowStyleKey, lineWidth: number): number {
    const halfStroke = Math.max(0.5, lineWidth) / 2;
    const sinHalf = style === "modern"
        ? Math.sin(Math.atan(MODERN_BASE_RATIO * 0.4 * Math.tan(MODERN_ANGLE)))
        : 1 / Math.sqrt(10);
    return halfStroke / sinHalf;
}

/** Classic / Double：尖端 + 两侧底角 + 向尖端鼓出的二次曲线背弧（燕尾） */
export function classicHead(g: ArrowGeometry, half: number, atStart = false, inset = 0): ArrowHeadPath {
    const u = arrowTipDir(g, atStart);
    const tip = sub(atStart ? g.start : g.end, mul(u, inset));
    const p = perpOf(u);
    const base = sub(tip, mul(u, half * HEAD_LENGTH_RATIO));
    const left = add(base, mul(p, half));
    const right = sub(base, mul(p, half));
    const ctrl = sub(tip, mul(u, half * BACK_CURVE_CONTROL_RATIO));
    return {
        d: `M ${fmt(tip)} L ${fmt(left)} Q ${fmt(ctrl)} ${fmt(right)} Z`,
        fill: true,
    };
}

/**
 * Basic / Line：同一组底角，背边是直线。
 * Basic 闭合填充成实心三角；Line 只描两条斜边、不填充，保留「线条箭头」的开口 V 形，
 * 与实心三角一眼能分开（ShareX 里两者几何相同，这里只差填充方式）。
 */
export function basicHead(g: ArrowGeometry, half: number, atStart = false, open = false, inset = 0): ArrowHeadPath {
    const u = arrowTipDir(g, atStart);
    const tip = sub(atStart ? g.start : g.end, mul(u, inset));
    const p = perpOf(u);
    const base = sub(tip, mul(u, half * HEAD_LENGTH_RATIO));
    const left = add(base, mul(p, half));
    const right = sub(base, mul(p, half));
    return open
        ? {d: `M ${fmt(left)} L ${fmt(tip)} L ${fmt(right)}`, fill: false}
        : {d: `M ${fmt(tip)} L ${fmt(left)} L ${fmt(right)} Z`, fill: true};
}

interface ModernMetrics {
    height: number;
    wing: number;
    shaftHalf: number;
}

function modernMetrics(headSize: number): ModernMetrics {
    const baseWidth = headSize * MODERN_BASE_RATIO;
    return {
        height: headSize * MODERN_HEIGHT_RATIO,
        wing: baseWidth * Math.tan(MODERN_ANGLE),
        shaftHalf: baseWidth * MODERN_SHAFT_RATIO,
    };
}

/**
 * Modern 直线：一根从起点直通箭头的大闭合图形，
 * 杆在箭头根部收窄到 0.25×底宽，翼展按 35° 张开。
 */
function modernSolid(g: ArrowGeometry, headSize: number): string {
    const u = arrowTipDir(g, false);
    const p = perpOf(u);
    const {height, wing, shaftHalf} = modernMetrics(headSize);
    const base = sub(g.end, mul(u, height));
    const shaftLeft = add(base, mul(p, shaftHalf));
    const wingLeft = add(base, mul(p, wing));
    const wingRight = sub(base, mul(p, wing));
    const shaftRight = sub(base, mul(p, shaftHalf));
    return `M ${fmt(g.start)} L ${fmt(shaftLeft)} L ${fmt(wingLeft)} ` +
        `L ${fmt(g.end)} L ${fmt(wingRight)} L ${fmt(shaftRight)} Z`;
}

/** Modern 曲线：曲线主干 + 一个只按翼宽张开的三角头（ShareX 的 CurvedModern） */
function modernCurvedHead(g: ArrowGeometry, headSize: number): ArrowHeadPath {
    const u = arrowTipDir(g, false);
    const p = perpOf(u);
    const {height, wing} = modernMetrics(headSize);
    const base = sub(g.end, mul(u, height));
    return {
        d: `M ${fmt(g.end)} L ${fmt(add(base, mul(p, wing)))} L ${fmt(sub(base, mul(p, wing)))} Z`,
        fill: true,
    };
}

/** 两端竖线（仅 bar / barDouble） */
export function arrowBars(g: ArrowGeometry, lineWidth: number, barHalf = arrowBarHalf(lineWidth)): ArrowBar[] {
    const u = arrowTipDir(g, false);
    const p = perpOf(u);
    const at = (tip: Point): ArrowBar => ({
        x1: tip.x - p.x * barHalf, y1: tip.y - p.y * barHalf,
        x2: tip.x + p.x * barHalf, y2: tip.y + p.y * barHalf,
    });
    return [at(g.start), at(g.end)];
}

/**
 * 生成一个箭头的全部图形。
 * @param lineWidth 线宽（与 ShareX 的 StrokeWidth 同义）
 * @param barHalf 竖线半长，预览图里用小值
 * @param tipInset 头部沿箭头方向的内缩量（关闭圆角时用来抵消 miter 溢出）
 */
export function arrowShape(
    g: ArrowGeometry,
    style: ArrowStyleKey,
    lineWidth: number,
    barHalf?: number,
    tipInset = 0,
): ArrowShape {
    const shaft = arrowShaftPath(g);
    const size = arrowHeadSize(style, lineWidth);
    const base: ArrowShape = {shaft, heads: [], bars: []};

    switch (style) {
        case "modern":
            if (g.control) {
                return {shaft, heads: [modernCurvedHead(g, size)], bars: []};
            }
            return {shaft: null, heads: [{d: modernSolid(g, size), fill: true}], bars: []};
        case "double":
            base.heads = [classicHead(g, size, true), classicHead(g, size, false)];
            return base;
        case "basic":
            base.heads = [basicHead(g, size, false)];
            return base;
        case "line":
            base.heads = [basicHead(g, size, false, true)];
            return base;
        case "bar":
            base.bars = arrowBars(g, lineWidth, barHalf);
            return base;
        case "barDouble":
            base.bars = arrowBars(g, lineWidth, barHalf);
            base.heads = [
                basicHead(g, size, true, false, tipInset),
                basicHead(g, size, false, false, tipInset),
            ];
            return base;
        case "classic":
        default:
            base.heads = [classicHead(g, size, false)];
            return base;
    }
}

// ---------------------------------------------------------------- 预览图

/** 下拉里的小预览：与真实绘制走同一套几何，尺寸固定，不受当前线宽影响 */
export const ARROW_PREVIEW = {width: 48, height: 20, padding: 3, lineWidth: 1.6, barHalf: 7};

export interface ArrowPreview {
    width: number;
    height: number;
    shaft: string | null;
    heads: ArrowHeadPath[];
    bars: ArrowBar[];
}

export function arrowPreview(style: ArrowStyleKey): ArrowPreview {
    const {width, height, padding, lineWidth, barHalf} = ARROW_PREVIEW;
    const g: ArrowGeometry = {
        start: {x: padding, y: height / 2},
        end: {x: width - padding, y: height / 2},
        control: null,
    };
    const shape = arrowShape(g, style, lineWidth, barHalf);
    return {width, height, ...shape};
}
