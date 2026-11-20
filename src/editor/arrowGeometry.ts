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

import type {ArrowGeometry, ArrowHead, ArrowKind, ArrowStyleKey, Point} from "../types";
import {resolveArrowKind} from "./arrowStyles";

/** 端点图形的半宽（倍数 × 线宽） */
const HEAD_MULTIPLIER: Record<ArrowHead, number> = {
    basic: 1.75,
    classic: 2,
    open: 1.75,
    rhombus: 2.2,
    circle: 2.2,
    none: 0,
};

/** 旧的扁平样式键（序号引线还在用）→ 半宽倍数 */
const LEGACY_MULTIPLIER: Record<ArrowStyleKey, number> = {
    classic: 2,
    modern: 3,
    double: 2,
    basic: 1.75,
    line: 1.75,
    bar: 0,
    barDouble: 1.75,
};

/** 尖尾类型的头部按 3 倍线宽起算：楔形杆和头部才撑得起来 */
export const MODERN_HEAD_SIZE = 3;

/**
 * 头长 = 3.2 × 半宽。
 * 用户给的经验值：箭头长度最好不小于线宽的 6 倍，粗线才不会把箭头「压扁」；
 * 3.2 让「基础」这种最窄的头也有 5.6 倍线宽，接近下限。
 */
const HEAD_LENGTH_RATIO = 3.2;

/** 线宽超过这个值之后，箭头尺寸不再等比放大（视觉重量要跟面积走，不跟线宽走） */
const HEAD_WIDTH_SOFT_LIMIT = 2.5;
const HEAD_WIDTH_TAIL_SLOPE = 0.55;
/** 箭头最宽处至少是线宽的 3 倍，否则粗线会把箭头吃掉 */
const HEAD_MIN_WIDTH_RATIO = 1.5;
const BACK_CURVE_CONTROL_RATIO = 2;
const MODERN_HEIGHT_RATIO = 2.5;
const MODERN_BASE_RATIO = 1.5;
const MODERN_SHAFT_RATIO = 0.25;
/** ShareX 的翼角：Math.PI / 5.14（约 35°） */
const MODERN_ANGLE = Math.PI / 5.14;
/** 两端竖线的默认半长：至少 10px，粗线按 2.5 倍 */
const DEFAULT_BAR_HALF = 10;
/** 现代样式曲线杆的分段数：足够平滑，又不至于让 path 字符串太长 */
const MODERN_CURVE_SEGMENTS = 32;
/**
 * 尖尾的杆要插进箭头内部多远（倍数 × 头部尺寸）。
 *
 * 不能只画到「箭头根部」——燕尾的背边是向内凹的弧，根部中线处是空的，
 * 杆画到那儿会在杆和燕尾之间留下一道月牙缺口。
 * 缩到 2 倍时，杆末端整圈都落在头部三角的内部，任何头型都能盖住。
 */
const TAPERED_SHAFT_DEPTH = 2;

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
    /** 主干是不是闭合多边形（现代曲线）：是则要填色，否则只描边 */
    shaftFilled?: boolean;
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

/**
 * 算尺寸用的「视觉线宽」。
 *
 * 线是细长条，视觉重量随线宽线性增长；实心箭头是块面，重量随面积增长。
 * 所以线宽翻倍时，箭头只该放大 √2 左右，而不是翻倍，否则粗线配一个巨大的头。
 * 这里在 6px 以内保持线性（细线的观感不变），超过之后斜率降到 0.55。
 */
function visualWidth(lineWidth: number): number {
    const w = Math.max(0.5, lineWidth);
    return w <= HEAD_WIDTH_SOFT_LIMIT
        ? w
        : HEAD_WIDTH_SOFT_LIMIT + (w - HEAD_WIDTH_SOFT_LIMIT) * HEAD_WIDTH_TAIL_SLOPE;
}

/** 头部半宽；既接受新的端点键，也接受旧的扁平样式键 */
export function arrowHeadSize(head: ArrowHead | ArrowStyleKey, lineWidth: number): number {
    const key = String(head);
    const mult = key in HEAD_MULTIPLIER
        ? HEAD_MULTIPLIER[key as ArrowHead]
        : LEGACY_MULTIPLIER[key as ArrowStyleKey] ?? 2;
    if (mult <= 0) return 0;
    const w = Math.max(0.5, lineWidth);
    // 下限兜住：粗线时宁可牺牲「面积匹配」，也不能让箭头缩得看不见
    return Math.max(mult * visualWidth(w), w * HEAD_MIN_WIDTH_RATIO);
}

export function arrowBarHalf(lineWidth: number): number {
    return Math.max(DEFAULT_BAR_HALF, visualWidth(lineWidth) * 2.5);
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
export function arrowTipMiterInset(style: ArrowStyleKey | ArrowHead, lineWidth: number): number {
    const halfStroke = Math.max(0.5, lineWidth) / 2;
    const sinHalf = String(style) === "modern"
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

/** 二次贝塞尔上的一点 */
function quadAt(g: ArrowGeometry, t: number): Point {
    const c = g.control as Point;
    const mt = 1 - t;
    return {
        x: mt * mt * g.start.x + 2 * mt * t * c.x + t * t * g.end.x,
        y: mt * mt * g.start.y + 2 * mt * t * c.y + t * t * g.end.y,
    };
}

/** 二次贝塞尔切线方向（单位向量） */
function quadDir(g: ArrowGeometry, t: number): Point {
    const c = g.control as Point;
    const d = {
        x: 2 * (1 - t) * (c.x - g.start.x) + 2 * t * (g.end.x - c.x),
        y: 2 * (1 - t) * (c.y - g.start.y) + 2 * t * (g.end.y - c.y),
    };
    const len = Math.hypot(d.x, d.y) || 1;
    return {x: d.x / len, y: d.y / len};
}

/**
 * 现代样式的曲线杆：一条**宽度渐变**的闭合多边形。
 *
 * 直线的杆是楔形——起点是一个点（宽度 0），到箭头根部涨到 2.25×线宽，
 * 再加 1×线宽描边，于是尾细头粗。曲线必须长一个样，不能退化成统一粗细的描边。
 * 做法是沿曲线采样，每点的法向上按 t 线性张开，左右边缘各取一串点连成闭合路径；
 * 末端停在箭头根部（沿曲线往回缩），由三角头盖住接缝，线头不会戳出尖端。
 */
export function modernCurvedShaft(
    g: ArrowGeometry,
    headSize: number,
    segments = MODERN_CURVE_SEGMENTS,
): {d: string; tailWidth: number; headWidth: number; endT: number; lastPoint: Point} {
    const {shaftHalf} = modernMetrics(headSize);
    // 杆末端要落在箭头内部：从终点往回扫，找到第一个离终点足够远的采样点。
    // （不能取「离箭头根部最近的点」——曲线弯得厉害时，最近点会落到头部外面，杆就戳出尖端了）
    const depth = headSize * TAPERED_SHAFT_DEPTH;
    const distToEnd = (t: number): number => {
        const p = quadAt(g, t);
        return Math.hypot(p.x - g.end.x, p.y - g.end.y);
    };
    // 从终点往回扫，找到「离终点刚好 depth」的那一点：先粗扫定位，再二分逼近，
    // 否则采样步长在弯得厉害的曲线上会跳过头，杆要么戳出尖端、要么离箭头太远。
    let endT = 1;
    const steps = segments * 4;
    let prev = 1;
    for (let i = steps; i >= 0; i--) {
        const t = i / steps;
        if (distToEnd(t) >= depth) {
            let lo = t;
            let hi = prev;
            for (let k = 0; k < 14; k++) {
                const mid = (lo + hi) / 2;
                if (distToEnd(mid) < depth) hi = mid;
                else lo = mid;
            }
            endT = (lo + hi) / 2;
            break;
        }
        prev = t;
        endT = t;
    }
    // 箭头本身很短时也别把杆压没
    endT = Math.max(endT, 0.3);

    const left: Point[] = [];
    const right: Point[] = [];
    for (let i = 0; i <= segments; i++) {
        const k = i / segments;
        const t = endT * k;
        const p = quadAt(g, t);
        const n = perpOf(quadDir(g, t));
        // 尾 0 → 头 shaftHalf，和直线杆的楔形一致
        const w = shaftHalf * k;
        left.push({x: p.x + n.x * w, y: p.y + n.y * w});
        right.push({x: p.x - n.x * w, y: p.y - n.y * w});
    }

    const parts = [`M ${fmt(left[0])}`];
    for (let i = 1; i < left.length; i++) parts.push(`L ${fmt(left[i])}`);
    for (let i = right.length - 1; i >= 1; i--) parts.push(`L ${fmt(right[i])}`);
    parts.push("Z");

    return {
        d: parts.join(" "),
        tailWidth: Math.hypot(left[0].x - right[0].x, left[0].y - right[0].y),
        headWidth: Math.hypot(
            left[left.length - 1].x - right[right.length - 1].x,
            left[left.length - 1].y - right[right.length - 1].y,
        ),
        endT,
        lastPoint: quadAt(g, endT),
    };
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

/**
 * 两端竖线（仅 bar / barDouble）。
 * 每一端都用自己的切线：曲线时起点切线来自 start→control，
 * 借用末端那条会让起点竖线歪掉（直线时两者只差一个方向，反正是同一根线，看不出差别）。
 */
export function arrowBars(g: ArrowGeometry, lineWidth: number, barHalf = arrowBarHalf(lineWidth)): ArrowBar[] {
    const at = (tip: Point, u: Point): ArrowBar => {
        const p = perpOf(u);
        return {
            x1: tip.x - p.x * barHalf, y1: tip.y - p.y * barHalf,
            x2: tip.x + p.x * barHalf, y2: tip.y + p.y * barHalf,
        };
    };
    return [at(g.start, arrowTipDir(g, true)), at(g.end, arrowTipDir(g, false))];
}

/**
 * 菱形头：正方形旋转 45°。
 * 四个顶点到中心的距离完全相同（都是 half），所以纵横等长，不会拉成梭子。
 */
export function rhombusHead(g: ArrowGeometry, half: number, atStart = false, inset = 0): ArrowHeadPath {
    const u = arrowTipDir(g, atStart);
    const tip = sub(atStart ? g.start : g.end, mul(u, inset));
    const p = perpOf(u);
    // 中心退一个 half，四个顶点就是 ±half 的四个方向
    const center = sub(tip, mul(u, half));
    return {
        d: `M ${fmt(tip)} ` +
            `L ${fmt(add(center, mul(p, half)))} ` +
            `L ${fmt(sub(center, mul(u, half)))} ` +
            `L ${fmt(sub(center, mul(p, half)))} Z`,
        fill: true,
    };
}

/** 圆形头：实心圆，圆心缩进一个半径，圆的最外点正好压在端点上 */
export function circleHead(g: ArrowGeometry, half: number, atStart = false, inset = 0): ArrowHeadPath {
    const u = arrowTipDir(g, atStart);
    const tip = sub(atStart ? g.start : g.end, mul(u, inset));
    const cx = tip.x - u.x * half;
    const cy = tip.y - u.y * half;
    return {
        d: `M ${cx - half} ${cy} a ${half} ${half} 0 1 0 ${half * 2} 0 ` +
            `a ${half} ${half} 0 1 0 ${-half * 2} 0 Z`,
        fill: true,
    };
}

/** 按端点键生成一个头；「无」返回空图形（渲染时按空处理） */
function makeHead(
    g: ArrowGeometry,
    head: ArrowHead,
    half: number,
    atStart: boolean,
    inset: number,
): ArrowHeadPath {
    switch (head) {
        case "classic": return classicHead(g, half, atStart, inset);
        case "open": return basicHead(g, half, atStart, true, inset);
        case "rhombus": return rhombusHead(g, half, atStart, inset);
        case "circle": return circleHead(g, half, atStart, inset);
        case "basic":
        default: return basicHead(g, half, atStart, false, inset);
    }
}

/**
 * 尖尾的直杆：起点是一个点，到箭头根部张开成楔形（尾细头粗）。
 * 宽度与曲线版保持同一套比例，弯与不弯看起来才是一支箭。
 */
function modernStraightShaft(g: ArrowGeometry, size: number): string {
    const u = arrowTipDir(g, false);
    const p = perpOf(u);
    const base = sub(g.end, mul(u, size * TAPERED_SHAFT_DEPTH));
    const shaftHalf = size * MODERN_BASE_RATIO * MODERN_SHAFT_RATIO;
    return `M ${fmt(g.start)} L ${fmt(add(base, mul(p, shaftHalf)))} ` +
        `L ${fmt(sub(base, mul(p, shaftHalf)))} Z`;
}

/**
 * 生成一个箭头的全部图形。
 *
 * @param kind 类型 + 端点样式；也接受旧的扁平样式键（序号引线还在用）
 * @param lineWidth 线宽
 * @param barHalf 竖线半长，预览图里用小值
 * @param tipInset 头部沿箭头方向的内缩量（关闭圆角时用来抵消 miter 溢出）
 */
export function arrowShape(
    g: ArrowGeometry,
    kind: ArrowKind | ArrowStyleKey,
    lineWidth: number,
    barHalf?: number,
    tipInset = 0,
): ArrowShape {
    const resolved = typeof kind === "string" ? resolveArrowKind({arrowStyle: kind}) : kind;
    const {type, head} = resolved;
    const isBar = type === "bar";
    // 双头与两端竖线都是两端对称
    const twoEnds = type === "double" || isBar;
    const tapered = type === "modern";

    // 尖尾的头按 3 倍线宽起算，楔形杆才撑得住；其余按端点自己的倍数
    // 尖尾的头原本是 3 倍线宽（比燕尾的 2 倍大一号），同样受「面积规则」和下限约束
    const size = tapered
        ? Math.max(arrowHeadSize("classic", lineWidth) * 1.5, Math.max(0.5, lineWidth) * HEAD_MIN_WIDTH_RATIO)
        : arrowHeadSize(head, lineWidth);

    const heads: ArrowHeadPath[] = [];
    if (head !== "none") {
        if (twoEnds) heads.push(makeHead(g, head, size, true, tipInset));
        heads.push(makeHead(g, head, size, false, tipInset));
    }

    let shaft: string | null;
    let shaftFilled = false;
    if (tapered) {
        // 尖尾：杆是宽度渐变的楔形，必须填色
        shaft = g.control ? modernCurvedShaft(g, size).d : modernStraightShaft(g, size);
        shaftFilled = true;
    } else {
        shaft = arrowShaftPath(g);
    }

    return {
        shaft,
        heads,
        bars: isBar ? arrowBars(g, lineWidth, barHalf) : [],
        shaftFilled,
    };
}

// ---------------------------------------------------------------- 预览图

/**
 * 图标里的小预览：与真实绘制走同一套几何，尺寸固定，不受当前线宽影响。
 * tail 是起点缩进 —— 图标只画「箭头端的一小段」，别把整条长线缩进去，
 * 否则头被压成一个小点，看不出是什么形状。
 */
export const ARROW_PREVIEW = {
    width: 48, height: 20, padding: 3, lineWidth: 1.6, barHalf: 7, tail: 3,
};

export interface ArrowPreview {
    width: number;
    height: number;
    shaft: string | null;
    shaftFilled?: boolean;
    heads: ArrowHeadPath[];
    bars: ArrowBar[];
}

export function arrowPreview(kind: ArrowKind | ArrowStyleKey): ArrowPreview {
    const {width, height, padding, barHalf, tail} = ARROW_PREVIEW;
    const resolved = typeof kind === "string" ? resolveArrowKind({arrowStyle: kind}) : kind;
    // 尖尾的头按 3 倍线宽起算，图标这么小会顶满整格、把楔形藏起来，单独收细一点
    const lineWidth = ARROW_PREVIEW.lineWidth;
    const g: ArrowGeometry = {
        start: {x: tail, y: height / 2},
        end: {x: width - padding, y: height / 2},
        control: null,
    };
    const shape = arrowShape(g, resolved, lineWidth, barHalf);
    return {width, height, ...shape};
}
