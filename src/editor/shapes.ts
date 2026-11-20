/**
 * 所有标注类型的统一渲染、包围盒与手柄。
 *
 * 设计要点：
 * - 每种对象都实现「取包围盒 / 平移 / 按包围盒缩放 / 旋转」四件事，
 *   于是 8 点缩放手柄和旋转手柄可以一套代码服务矩形、椭圆、文字、
 *   序号、马赛克、高亮笔；箭头沿用里程碑二的三手柄。
 * - 视觉元素与命中区域分离：透明 hit 元素专门接收指针，
 *   可见形状统一 pointer-events:none，避免细线难点中。
 * - 旋转通过 group 的 transform 施加，命中检测由浏览器自动跟随变换。
 */

import type {ArrowHead} from "../types";
import {
    svgEl, arrowBounds, midpoint, cloneArrow,
} from "./geometry";
import {arrowShape, arrowTipMiterInset, arrowShaftPath} from "./arrowGeometry";
import {numberHeadOf, resolveArrowKind} from "./arrowStyles";
import {formatNumber, numberTextScale} from "./numberFormat";
import {normalizeNumberTip, type NumberTipKey} from "./numberTip";
import {pickBadgeTextColor, readableInk, withAlpha} from "./color";
import {fontStackOf} from "./fonts";
import {charWidthRatio, measureText, textBlockSize, TEXT_LINE_HEIGHT} from "./textLayout";
import {normalizeArrowStyle} from "./arrowStyles";
import {rectCornerRadius} from "./cornerRadius";
import {normalizeNumberBubble, type CurrentStyle} from "./presets";
import {
    TYPE_LABELS,
    type AnnotStyle, type AnnotObject, type AnnotType, type ArrowGeometry, type ArrowStyleKey, type EllipseGeometry,
    type Geometry, type HighlightGeometry, type LineGeometry, type MosaicGeometry,
    type MagnifierGeometry, type NumberGeometry, type Point, type RectGeometry,
    type SpotlightGeometry, type TextGeometry,
} from "../types";

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface RenderOptions {
    zoom: number;
    /**
     * 马赛克 / 模糊这类「按框选区域从底图现采样」的对象，渲染时由调用方算好位图传进来。
     * 位图是 data URL，因此导出的 SVG 自带全部像素，不依赖任何外部资源。
     */
    bitmapUrl?: string | null;
}

const NO_ROTATION: AnnotType[] = ["arrow", "line"];

/** 文字描边默认值：白色、2px。用户可在属性面板里改，也会被记进当前预设。 */
export const DEFAULT_TEXT_STROKE_COLOR = "#FFFFFF";
export const DEFAULT_TEXT_STROKE_WIDTH = 2;

export function supportsRotation(object: AnnotObject): boolean {
    // 矩形高亮是一块纯色区域，转它没有意义（还会让包围盒手柄对不上），一并排除
    return !NO_ROTATION.includes(object.type) && object.type !== "number" &&
        object.type !== "highlight" && object.type !== "highlightRect";
}

export function getRotation(object: AnnotObject): number {
    return (object.geometry as {rotation?: number}).rotation ?? 0;
}

export function setRotation(object: AnnotObject, degrees: number): void {
    if (!supportsRotation(object)) return;
    (object.geometry as {rotation?: number}).rotation = degrees;
}

export {charWidthRatio};

/** 兼容旧调用：整段文字按不换行算的宽度 */
export function textWidth(text: string, fontSize: number): number {
    return Math.max(fontSize * 2, measureText(text, fontSize));
}

export function getBounds(object: AnnotObject): Bounds {
    const g = object.geometry;
    switch (object.type) {
        case "rect":
        case "highlightRect":
        case "mosaic":
        case "blur":
        case "spotlight":
        case "magnifier": {
            const r = g as RectGeometry;
            return {x: r.x, y: r.y, width: Math.abs(r.width), height: Math.abs(r.height)};
        }
        case "ellipse": {
            const e = g as EllipseGeometry;
            return {x: e.cx - e.rx, y: e.cy - e.ry, width: e.rx * 2, height: e.ry * 2};
        }
        case "arrow":
            return arrowBounds(g as ArrowGeometry, 0);
        case "text": {
            const t = g as TextGeometry;
            const block = textBlockSize(t.text, t.fontSize, t.width ?? Infinity);
            return {x: t.x, y: t.y, width: block.width, height: block.height};
        }
        case "number": {
            const n = g as NumberGeometry;
            const points: Point[] = [
                {x: n.center.x - n.radius, y: n.center.y - n.radius},
                {x: n.center.x + n.radius, y: n.center.y + n.radius},
            ];
            if (n.tip) points.push(n.tip);
            const xs = points.map((p) => p.x);
            const ys = points.map((p) => p.y);
            return {
                x: Math.min(...xs), y: Math.min(...ys),
                width: Math.max(...xs) - Math.min(...xs),
                height: Math.max(...ys) - Math.min(...ys),
            };
        }
        case "highlight": {
            const h = g as HighlightGeometry;
            const xs = h.points.map((p) => p.x);
            const ys = h.points.map((p) => p.y);
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            const pad = object.style.lineWidth * 3;
            return {
                x: minX - pad, y: minY - pad,
                width: Math.max(1, Math.max(...xs) - minX) + pad * 2,
                height: Math.max(1, Math.max(...ys) - minY) + pad * 2,
            };
        }
        case "line": {
            const l = g as LineGeometry;
            const xs = l.points.map((p) => p.x);
            const ys = l.points.map((p) => p.y);
            const minX = Math.min(...xs);
            const minY = Math.min(...ys);
            const pad = Math.max(4, object.style.lineWidth / 2);
            return {
                x: minX - pad, y: minY - pad,
                width: Math.max(1, Math.max(...xs) - minX) + pad * 2,
                height: Math.max(1, Math.max(...ys) - minY) + pad * 2,
            };
        }
    }
}

/** 平移对象；所有几何点一起走，旋转角度不变 */
export function translateObject(object: AnnotObject, dx: number, dy: number): void {
    const move = (p: Point): Point => ({x: p.x + dx, y: p.y + dy});
    const g = object.geometry;
    switch (object.type) {
        case "rect":
        case "highlightRect":
        case "mosaic":
        case "blur":
        case "spotlight": {
            const r = g as RectGeometry;
            r.x += dx;
            r.y += dy;
            break;
        }
        case "magnifier": {
            // 拖动显示框只挪框，锚点留在原地（这就是「解耦」的核心）
            const m = g as MagnifierGeometry;
            m.x += dx;
            m.y += dy;
            break;
        }
        case "ellipse": {
            const e = g as EllipseGeometry;
            e.cx += dx;
            e.cy += dy;
            break;
        }
        case "arrow": {
            const a = g as ArrowGeometry;
            const next: ArrowGeometry = {
                start: move(a.start), end: move(a.end),
                control: a.control ? move(a.control) : null,
            };
            object.geometry = next;
            break;
        }
        case "text": {
            const t = g as TextGeometry;
            t.x += dx;
            t.y += dy;
            break;
        }
        case "number": {
            const n = g as NumberGeometry;
            n.center = move(n.center);
            if (n.tip) n.tip = move(n.tip);
            if (n.control) n.control = move(n.control);
            break;
        }
        case "highlight": {
            const h = g as HighlightGeometry;
            h.points = h.points.map(move);
            break;
        }
        case "line": {
            const l = g as LineGeometry;
            l.points = l.points.map(move);
            break;
        }
    }
}

/** 按包围盒缩放对象；文字同步缩放字号 */
export function scaleObjectToBounds(object: AnnotObject, from: Bounds, to: Bounds): void {
    const sx = to.width / Math.max(1, from.width);
    const sy = to.height / Math.max(1, from.height);
    const mx = (x: number): number => to.x + (x - from.x) * sx;
    const my = (y: number): number => to.y + (y - from.y) * sy;
    const g = object.geometry;
    switch (object.type) {
        case "rect":
        case "highlightRect":
        case "mosaic":
        case "blur":
        case "spotlight":
        case "magnifier": {
            // 放大镜只缩放显示框，锚点保持不动（框变大了，看的还是同一处）
            const r = g as RectGeometry;
            r.x = to.x;
            r.y = to.y;
            r.width = to.width;
            r.height = to.height;
            break;
        }
        case "ellipse": {
            const e = g as EllipseGeometry;
            e.cx = to.x + to.width / 2;
            e.cy = to.y + to.height / 2;
            e.rx = to.width / 2;
            e.ry = to.height / 2;
            break;
        }
        case "arrow": {
            const a = g as ArrowGeometry;
            object.geometry = {
                start: {x: mx(a.start.x), y: my(a.start.y)},
                end: {x: mx(a.end.x), y: my(a.end.y)},
                control: a.control ? {x: mx(a.control.x), y: my(a.control.y)} : null,
            };
            break;
        }
        case "text": {
            const t = g as TextGeometry;
            t.x = to.x;
            t.y = to.y;
            t.fontSize = Math.max(8, t.fontSize * sy);
            object.style.fontSize = t.fontSize;
            break;
        }
        case "number": {
            const n = g as NumberGeometry;
            n.center = {x: mx(n.center.x), y: my(n.center.y)};
            if (n.tip) n.tip = {x: mx(n.tip.x), y: my(n.tip.y)};
            if (n.control) n.control = {x: mx(n.control.x), y: my(n.control.y)};
            n.radius = Math.max(8, n.radius * Math.min(sx, sy));
            break;
        }
        case "highlight": {
            const h = g as HighlightGeometry;
            h.points = h.points.map((p) => ({x: mx(p.x), y: my(p.y)}));
            break;
        }
        case "line": {
            const l = g as LineGeometry;
            l.points = l.points.map((p) => ({x: mx(p.x), y: my(p.y)}));
            break;
        }
    }
}

export function unrotatePoint(p: Point, center: Point, degrees: number): Point {
    if (!degrees) return p;
    const rad = -degrees * Math.PI / 180;
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return {
        x: center.x + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: center.y + dx * Math.sin(rad) + dy * Math.cos(rad),
    };
}

export function boundsCenter(b: Bounds): Point {
    return {x: b.x + b.width / 2, y: b.y + b.height / 2};
}

function hitRect(b: Bounds, zoom: number): SVGRectElement {
    const pad = 6 / zoom;
    return svgEl("rect", {
        "data-role": "hit",
        x: b.x - pad, y: b.y - pad,
        width: b.width + pad * 2, height: b.height + pad * 2,
        fill: "transparent", "pointer-events": "all",
    });
}

function fillFor(object: AnnotObject): string {
    const fill = object.style.fillOpacity ?? 0;
    if (fill <= 0) return "none";
    // 填充色可与描边色不同；老对象没存 fillColor 时仍然跟描边色，外观不变
    return withAlpha(object.style.fillColor ?? object.style.color, fill);
}

/**
 * 选区识别的条带 → SVG 路径。
 * 条带是 0..1 归一化的，乘当前 bbox 就回到画布坐标；多段子路径一起交给 clipPath，
 * 因此「文字有多行、主体分成几块」都能如实裁出来，缩放 / 拖动时也自动跟着走。
 */
function maskPath(runs: [number, number, number, number][], m: MosaicGeometry): string {
    const w = Math.abs(m.width);
    const h = Math.abs(m.height);
    return runs.map(([x0, x1, y0, y1]) => {
        const x = m.x + x0 * w;
        const y = m.y + y0 * h;
        const rw = Math.max(0.5, (x1 - x0) * w);
        const rh = Math.max(0.5, (y1 - y0) * h);
        return `M${x.toFixed(2)} ${y.toFixed(2)}H${(x + rw).toFixed(2)}` +
            `V${(y + rh).toFixed(2)}H${x.toFixed(2)}Z`;
    }).join("");
}

function highlightPath(points: Point[]): string {
    if (points.length === 0) return "";
    if (points.length === 1) {
        const p = points[0];
        return `M ${p.x - 0.01} ${p.y} L ${p.x + 0.01} ${p.y}`;
    }
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
}

/**
 * 序号的引线。
 *
 * 箭头端点必须和「箭头」工具画出来的一模一样：这里直接把引线当成一支经典箭头
 * 交给 arrowGeometry（同一条主干、同一个头部路径、同一套线宽与圆线规则），
 * 而不是自己再拼一个三角形——自己拼的和箭头工具永远对不齐，尖端还会露出线头。
 * 圆点 / 方点则只画主干，在末端盖一个实心标记。
 */
function numberLeader(
    n: NumberGeometry,
    rounded: boolean,
    arrowHead: ArrowHead,
    color: string,
    lineWidth: number,
    /** 起点从圆心往外让出的距离：实心圆由圆盖住，空心圆 / 纯数字要让到圆外 */
    inset = 0,
): SVGElement[] {
    if (!n.tip) return [];
    const linecap = rounded ? "round" : "butt";
    const linejoin = rounded ? "round" : "miter";
    // 起点沿引线方向外移，空心圆不会有一条线横穿内部
    const gap = Math.hypot(n.tip.x - n.center.x, n.tip.y - n.center.y) || 1;
    const start = {
        x: n.center.x + (n.tip.x - n.center.x) / gap * inset,
        y: n.center.y + (n.tip.y - n.center.y) / gap * inset,
    };
    const lead: ArrowGeometry = {
        start,
        end: {x: n.tip.x, y: n.tip.y},
        control: n.control ? {x: n.control.x, y: n.control.y} : null,
    };
    const out: SVGElement[] = [];
    // 引线固定单头，端点就是序号自己选的那个（菱形 / 圆形已取代旧的方点 / 圆点）
    const shape = arrowShape({...lead}, {type: "single", head: arrowHead}, lineWidth);
    if (shape.shaft) {
        out.push(svgEl("path", {
            d: shape.shaft, fill: shape.shaftFilled ? color : "none", stroke: color,
            "stroke-width": lineWidth,
            "stroke-linecap": linecap, "stroke-linejoin": linejoin,
            "pointer-events": "none", class: "annot-shape",
        }));
    }
    for (const head of shape.heads) {
        out.push(svgEl("path", {
            d: head.d, fill: head.fill ? color : "none", stroke: color,
            "stroke-width": lineWidth, "stroke-miterlimit": 10,
            "stroke-linecap": linecap, "stroke-linejoin": linejoin,
            "pointer-events": "none", class: "annot-head",
        }));
    }
    return out;
}

/**
 * 定位气泡：一个整体的「水滴 / 图钉」形路径。
 *
 * 尖头不是贴在圆旁边，而是从圆心外一点向圆引两条**切线**：
 * 切点由 d 与 R 决定（θ = acos(R/d)），路径 = 大弧（绕背面）+ 切线到尖端 + 闭合。
 * 这样尖头两边与圆自然相切，描边也是一整条，不会在接缝处断掉。
 *
 * 尖头长度：没有引线时跟着拖动距离走；有引线时封顶在 1.9R，多出来的部分交给细引线。
 */
function pointerBubble(n: NumberGeometry, style: AnnotStyle, color: string, lineWidth: number): SVGElement[] {
    const target = n.tip;
    const radius = n.radius;
    if (!target) return [];
    const dx = target.x - n.center.x;
    const dy = target.y - n.center.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return [];
    const ux = dx / dist;
    const uy = dy / dist;
    const headMax = radius * 1.9;
    // 无引线：尖头直接指到落点；有引线：尖头封顶，剩余距离画引线
    const d = Math.max(radius * 1.04, n.leader ? Math.min(dist, headMax) : dist);
    const apex = {x: n.center.x + ux * d, y: n.center.y + uy * d};
    // 从尖端向圆引切线：切点与圆心连线的夹角
    const theta = Math.acos(Math.min(1, radius / d));
    const phi = Math.atan2(uy, ux);
    const t1 = {x: n.center.x + radius * Math.cos(phi + theta), y: n.center.y + radius * Math.sin(phi + theta)};
    const t2 = {x: n.center.x + radius * Math.cos(phi - theta), y: n.center.y + radius * Math.sin(phi - theta)};
    const out: SVGElement[] = [];
    // 圆头开关：开＝圆端帽 / 圆折角，关＝平口与尖角
    const round = style.bubbleRound !== false;
    if (n.leader && dist > d + 2) {
        out.push(svgEl("line", {
            x1: apex.x, y1: apex.y, x2: target.x, y2: target.y,
            stroke: color, "stroke-width": Math.max(1.4, lineWidth * 0.6),
            "stroke-linecap": round ? "round" : "butt", "pointer-events": "none", class: "annot-shape",
        }));
    }
    // 画布上的尖头：一个三角，两个底角落在切点上，根部由后画的圆盖住。
    // 露在外面的只剩「从圆边平滑长出去」的那一段，圆保持完整、描边不断开。
    // 注意：工具栏的小图标是另一套独立绘制（editor/numberIcon.ts），改图标不要动这里。
    out.push(svgEl("path", {
        d: `M${t1.x} ${t1.y}L${apex.x} ${apex.y}L${t2.x} ${t2.y}Z`,
        // 尖头的颜色＝圆的描边色，两者是同一种颜色，交叠处不会出现深浅接缝
        fill: color,
        stroke: color,
        "stroke-width": lineWidth,
        "stroke-linejoin": round ? "round" : "miter",
        "stroke-linecap": round ? "round" : "butt",
        "pointer-events": "none",
        class: "annot-head",
    }));
    return out;
}

/**
 * 定位气泡的默认尖头：朝右下 45°，长度 1.5 倍半径。
 *
 * 只在「从其它样式切换过来」或读到缺数据的老场景时用来补全：
 * 圆形对象本来只有圆心和半径，没有尖头数据，直接按定位气泡渲染会算出 NaN。
 */
export function defaultPointerTip(n: NumberGeometry): Point {
    const center = n.center ?? {x: 0, y: 0};
    const radius = Number.isFinite(n.radius) && n.radius > 0 ? n.radius : 12;
    const len = radius * 1.5 * Math.SQRT1_2;
    return {x: center.x + len, y: center.y + len};
}

/** 把一个标注对象渲染成 SVG 组：命中层与可见层分开 */
export function renderObject(object: AnnotObject, options: RenderOptions): SVGGElement {
    const {zoom} = options;
    const group = svgEl("g", {"data-object-id": object.id, class: "annot-object"});
    group.setAttribute("opacity", String(object.style.opacity));
    const bounds = getBounds(object);
    const rotation = getRotation(object);
    if (rotation) {
        const c = boundsCenter(bounds);
        group.setAttribute("transform", `rotate(${rotation} ${c.x} ${c.y})`);
    }
    const {color, lineWidth} = object.style;
    const visuals: SVGElement[] = [];

    switch (object.type) {
        case "arrow": {
            const a = object.geometry as ArrowGeometry;
            // 新数据只有类型 + 端点，老数据只有旧的扁平键，统一在这里还原
            const kind = resolveArrowKind(object.style);
            const rounded = object.style.arrowRounded !== false;
            const linecap = rounded ? "round" : "butt";
            const linejoin = rounded ? "round" : "miter";
            // 关闭圆角时 miter 会在尖角外伸，两端竖线的尖头会戳出竖线，按溢出量内缩
            const tipInset = rounded ? 0
                : (kind.type === "bar" && kind.head !== "none" ? arrowTipMiterInset(kind.head, lineWidth) : 0);
            // 几何全部来自 arrowGeometry.ts（ShareX 的常量与路径），这里只负责上色
            const shape = arrowShape(a, kind, lineWidth, undefined, tipInset);
            group.append(svgEl("path", {
                "data-role": "hit", d: shape.shaft ?? shape.heads[0]?.d ?? "", fill: "none",
                stroke: "transparent", "stroke-width": Math.max(18, lineWidth + 12) / zoom,
                "stroke-linecap": linecap, "pointer-events": "stroke",
            }));
            // 主干画到端点，由头部轮廓外扩半个线宽盖住线头（ShareX 同款 Path）
            if (shape.shaft) {
                visuals.push(svgEl("path", {
                    d: shape.shaft, fill: shape.shaftFilled ? color : "none", stroke: color,
                    // 现代样式弯曲后是多边形，要填色；其余样式仍是单根描边
                    "stroke-width": lineWidth,
                    "stroke-linecap": linecap, "stroke-linejoin": linejoin,
                    "pointer-events": "none", class: "annot-shape",
                }));
            }
            for (const head of shape.heads) {
                visuals.push(svgEl("path", {
                    d: head.d, fill: head.fill ? color : "none", stroke: color,
                    "stroke-width": lineWidth,
                    // ShareX（GDI+ / WPF）的 miter limit 是 10；SVG 默认只有 4，
                    // 燕尾尾部尖角的 miter 比值约 4.35 会被截成平头，尖角就"消失"了
                    "stroke-miterlimit": 10,
                    "stroke-linecap": linecap, "stroke-linejoin": linejoin,
                    "pointer-events": "none", class: "annot-head",
                }));
            }
            for (const bar of shape.bars) {
                visuals.push(svgEl("line", {
                    x1: bar.x1, y1: bar.y1, x2: bar.x2, y2: bar.y2,
                    stroke: color, "stroke-width": lineWidth,
                    "stroke-linecap": linecap, "pointer-events": "none", class: "annot-bar",
                }));
            }
            break;
        }
        case "rect": {
            const r = object.geometry as RectGeometry;
            group.append(hitRect(bounds, zoom));
            // 圆角与 ShareX 的 CornerRadius 同义：四个角同半径，矩形窄到放不下时按半边长截断
            const radius = rectCornerRadius(object.style.cornerRadius, r);
            visuals.push(svgEl("rect", {
                x: r.x, y: r.y, width: Math.abs(r.width), height: Math.abs(r.height),
                rx: radius, ry: radius,
                fill: fillFor(object), stroke: color, "stroke-width": lineWidth,
                "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
        case "highlightRect": {
            // 矩形高亮：只有一块半透明色，不画描边（用户要求「不需要描边线条」）。
            // 颜色直接取顶栏「颜色」组，浓度取「填充」组 —— 两个控件不会互相打架。
            const r = object.geometry as RectGeometry;
            group.append(hitRect(bounds, zoom));
            const alpha = object.style.fillOpacity ?? 0.5;
            visuals.push(svgEl("rect", {
                x: r.x, y: r.y, width: Math.abs(r.width), height: Math.abs(r.height),
                fill: alpha > 0 ? withAlpha(object.style.color, alpha) : "none",
                stroke: "none",
                "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
        case "ellipse": {
            const e = object.geometry as EllipseGeometry;
            group.append(hitRect(bounds, zoom));
            visuals.push(svgEl("ellipse", {
                cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry,
                fill: fillFor(object), stroke: color, "stroke-width": lineWidth,
                "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
        case "text": {
            const t = object.geometry as TextGeometry;
            group.append(hitRect(bounds, zoom));
            // 文字后面的极淡底板，扩大双击命中范围（几乎不可见，不干扰画面）
            visuals.push(svgEl("rect", {
                x: bounds.x - 4, y: bounds.y - 2, width: bounds.width + 8, height: bounds.height + 4,
                fill: withAlpha("#FFFFFF", 0.001), "pointer-events": "none",
            }));
            // 文字描边：默认开启、白色、2px。paint-order="stroke" 让描边先画、
            // 填充后画，于是白边只出现在字形外沿，字芯仍是原本的颜色，不会糊。
            const strokeEnabled = object.style.textStrokeEnabled !== false;
            const strokeColor = object.style.textStrokeColor ?? DEFAULT_TEXT_STROKE_COLOR;
            const strokeWidth = Math.max(0, object.style.textStrokeWidth ?? DEFAULT_TEXT_STROKE_WIDTH);
            // 文字换行：一行一个 tspan，每行都从文字左边重新起排
            const block = textBlockSize(t.text, t.fontSize, t.width ?? Infinity);
            const textAttrs: Record<string, string | number> = {
                x: t.x, y: t.y + t.fontSize, fill: color,
                "font-size": t.fontSize, "font-family": fontStackOf(object.style.fontFamily),
                "font-weight": "600", "pointer-events": "none", class: "annot-shape",
            };
            if (strokeEnabled && strokeWidth > 0) {
                textAttrs.stroke = strokeColor;
                textAttrs["stroke-width"] = strokeWidth;
                textAttrs["stroke-linejoin"] = "round";
                textAttrs["stroke-linecap"] = "round";
                textAttrs["paint-order"] = "stroke";
                textAttrs["data-text-stroke"] = "1";
            }
            const textNode = svgEl("text", textAttrs);
            if (block.lines.length <= 1) {
                textNode.textContent = t.text || " ";
            } else {
                block.lines.forEach((line, index) => {
                    const tspan = svgEl("tspan", {
                        x: t.x,
                        y: t.y + t.fontSize + index * t.fontSize * TEXT_LINE_HEIGHT,
                    });
                    tspan.textContent = line.text || " ";
                    textNode.append(tspan);
                });
            }
            visuals.push(textNode);
            break;
        }
        case "number": {
            const n = object.geometry as NumberGeometry;
            group.append(hitRect(bounds, zoom));
            // 四种外观：实心圆 / 空心圆 / 定位气泡 / 纯数字（不画外框）
            const bubble = normalizeNumberBubble(n.bubble);
            // 尖头数据缺失或坐标坏掉时按「没有尖头」处理，绝不拿 NaN 去算路径
            const tipOk = !!n.tip && Number.isFinite(n.tip.x) && Number.isFinite(n.tip.y);
            const isPointer = bubble === "pointer" && tipOk;
            const hollow = bubble === "hollow";
            const isPlain = bubble === "plain";
            // 文字颜色按样式各自决定：只有实心圆需要「自动反差色」，
            // 其余三种一律用主色。各分支自己算，互不影响。
            let ink = color;
            if (isPointer) {
                // 先尖头（下层），再完整圆（上层盖住尖头根部），交叠处完美融合
                visuals.push(...pointerBubble(n, object.style, color, lineWidth));
                visuals.push(svgEl("circle", {
                    cx: n.center.x, cy: n.center.y, r: n.radius,
                    fill: object.style.fillColor ?? "#FFFFFF",
                    "fill-opacity": object.style.fillOpacity === undefined ? 1 : object.style.fillOpacity,
                    stroke: color, "stroke-width": lineWidth,
                    "pointer-events": "none", class: "annot-shape",
                }));
                ink = readableInk(color, object.style.fillColor ?? "#FFFFFF");
            } else {
                // 实心圆 / 空心圆 / 纯数字都支持引线：起点让出圆边，线不会横穿内部
                const leaderInset = hollow ? n.radius : (isPlain ? n.radius * 0.8 : 0);
                visuals.push(...numberLeader(
                    n, object.style.arrowRounded !== false,
                    numberHeadOf(object.style), color, lineWidth, leaderInset));
                if (hollow) {
                    // 空心圆：描边 + 实色填充（默认白，颜色只由取色器决定，没有透明档）
                    visuals.push(svgEl("circle", {
                        cx: n.center.x, cy: n.center.y, r: n.radius,
                        fill: object.style.fillColor ?? "#FFFFFF",
                        "fill-opacity": 1,
                        stroke: color, "stroke-width": lineWidth,
                        "pointer-events": "none", class: "annot-shape",
                    }));
                    ink = readableInk(color, object.style.fillColor ?? "#FFFFFF");
                } else if (!isPlain) {
                    // 实心圆：整颗填满主色，所以文字必须取反差色 —— 反色逻辑只在这里
                    visuals.push(svgEl("circle", {
                        cx: n.center.x, cy: n.center.y, r: n.radius,
                        fill: color, "pointer-events": "none",
                    }));
                    ink = pickBadgeTextColor(color);
                } else {
                    // 纯数字：没有底色，直接跟主色
                    ink = color;
                }
            }
            // 编号按格式翻译（1 / I / a / A / 一）；多字符时把字号收一点，别撑出圆点
            // 手动指定过文字色（定位气泡的三色取色器）就以它为准，其余走上面按样式算出来的 ink
            if (object.style.numberTextColor) ink = object.style.numberTextColor;
            const badgeText = formatNumber(n.number, n.format ?? "arabic");
            const label = svgEl("text", {
                x: n.center.x, y: n.center.y + n.radius * 0.36,
                fill: ink,
                "font-size": n.radius * 1.05 * numberTextScale(badgeText),
                "font-weight": "700", "text-anchor": "middle",
                "font-family": fontStackOf(undefined),
                "pointer-events": "none", class: "annot-shape",
            });
            label.textContent = badgeText;
            visuals.push(label);
            break;
        }
        case "mosaic":
        case "blur": {
            const m = object.geometry as MosaicGeometry;
            group.append(hitRect(bounds, zoom));
            // 选区识别过的对象带 mask：把整块矩形位图裁成贴合主体的形状。
            // 位图本身仍是整框（采样逻辑不变），所以性能与以前一样，只是多一层裁剪。
            const runs = m.mask;
            let clipId = "";
            if (runs?.length) {
                clipId = `annot-mask-${object.id}`;
                const clip = svgEl("clipPath", {id: clipId});
                clip.append(svgEl("path", {d: maskPath(runs, m)}));
                group.append(clip);
            }
            if (options.bitmapUrl) {
                const image = svgEl("image", {
                    href: options.bitmapUrl, x: m.x, y: m.y,
                    width: Math.abs(m.width), height: Math.abs(m.height),
                    preserveAspectRatio: "none", "pointer-events": "none", class: "annot-shape",
                });
                if (clipId) image.setAttribute("clip-path", `url(#${clipId})`);
                visuals.push(image);
            } else {
                // Canvas / filter 不可用（例如跨域底图）时的兜底：半透明雾块
                const fog = svgEl("rect", {
                    x: m.x, y: m.y, width: Math.abs(m.width), height: Math.abs(m.height),
                    fill: object.type === "blur" ? "rgba(255, 255, 255, .45)" : "rgba(127, 127, 127, .62)",
                    "pointer-events": "none", class: "annot-shape",
                });
                if (clipId) fog.setAttribute("clip-path", `url(#${clipId})`);
                visuals.push(fog);
            }
            // 不画描边：马赛克 / 模糊就是把这块打糊，外面套一圈彩色边框看着像贴了个框，
            // 用户明确要求去掉；选中时的虚线框在 overlay 层，仍然能看出范围
            break;
        }
        case "spotlight": {
            const sp = object.geometry as SpotlightGeometry;
            group.append(hitRect(bounds, zoom));
            const darkness = Math.min(0.95, Math.max(0, object.style.spotlightOpacity ?? 0.6));
            // 黑遮罩＝压暗（常规），白遮罩＝磨砂高亮（深色图上用）
            const ink = object.style.spotlightColor === "white" ? "255, 255, 255" : "0, 0, 0";
            // 遮罩要盖住整张画布：用一块远大于画布的矩形 + evenodd 挖洞，
            // 这样不管画布多大、被旋转/裁切过、还是对象自己带了旋转角，四周都不会漏光
            const outer = "M-20000 -20000H20000V20000H-20000Z";
            let hole: string;
            if (sp.shape === "ellipse") {
                const rx = Math.abs(sp.width) / 2;
                const ry = Math.abs(sp.height) / 2;
                const cx = sp.x + sp.width / 2;
                const cy = sp.y + sp.height / 2;
                hole = `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;
            } else {
                hole = `M${sp.x} ${sp.y}h${sp.width}v${sp.height}h${-sp.width}Z`;
            }
            visuals.push(svgEl("path", {
                d: `${outer}${hole}`, "fill-rule": "evenodd",
                fill: `rgba(${ink}, ${darkness})`,
                "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
        case "magnifier": {
            const m = object.geometry as MagnifierGeometry;
            const rounded = m.shape !== "rect";
            const cx = bounds.x + bounds.width / 2;
            const cy = bounds.y + bounds.height / 2;
            const clipId = `annot-lens-${object.id}`;
            group.append(hitRect(bounds, zoom));
            // 锚点：实心小圆点 + 一圈白边，压在任何底图上都看得见
            const dotR = Math.max(3, lineWidth * 1.3);
            group.append(svgEl("circle", {
                cx: m.anchor.x, cy: m.anchor.y, r: Math.max(14 / zoom, dotR * 2),
                fill: "transparent", "pointer-events": "all", "data-role": "anchor-hit",
            }));
            // 连线先画：它会被镜片盖住里面那一段，看上去正好接在镜框上
            visuals.push(svgEl("line", {
                x1: m.anchor.x, y1: m.anchor.y, x2: cx, y2: cy,
                stroke: color, "stroke-width": Math.max(1.5, lineWidth * 0.6),
                "stroke-linecap": "round", "pointer-events": "none", class: "annot-shape",
            }));
            // 镜片内容：从底图现采的放大图，用 clipPath 裁成圆形 / 矩形
            const clip = svgEl("clipPath", {id: clipId});
            clip.append(rounded
                ? svgEl("ellipse", {cx, cy, rx: bounds.width / 2, ry: bounds.height / 2})
                : svgEl("rect", {
                    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                }));
            group.append(clip);
            if (options.bitmapUrl) {
                visuals.push(svgEl("image", {
                    href: options.bitmapUrl, x: bounds.x, y: bounds.y,
                    width: bounds.width, height: bounds.height,
                    preserveAspectRatio: "none", "clip-path": `url(#${clipId})`,
                    "pointer-events": "none", class: "annot-shape",
                }));
            } else {
                // Canvas 不可用（跨域底图）时的兜底：半透明镜片，看起来仍是块放大区
                visuals.push(rounded
                    ? svgEl("ellipse", {
                        cx, cy, rx: bounds.width / 2, ry: bounds.height / 2,
                        fill: "rgba(255, 255, 255, .42)", "pointer-events": "none", class: "annot-shape",
                    })
                    : svgEl("rect", {
                        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                        fill: "rgba(255, 255, 255, .42)", "pointer-events": "none", class: "annot-shape",
                    }));
            }
            // 镜框：明显的描边，让「这是个放大镜」一眼看得出来
            visuals.push(rounded
                ? svgEl("ellipse", {
                    cx, cy, rx: bounds.width / 2, ry: bounds.height / 2,
                    fill: "none", stroke: color, "stroke-width": lineWidth,
                    "pointer-events": "none", class: "annot-shape",
                })
                : svgEl("rect", {
                    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
                    fill: "none", stroke: color, "stroke-width": lineWidth,
                    "pointer-events": "none", class: "annot-shape",
                }));
            // 锚点最后画，永远露在最上层
            visuals.push(svgEl("circle", {
                cx: m.anchor.x, cy: m.anchor.y, r: dotR + Math.max(1, lineWidth * 0.35),
                fill: "#FFFFFF", "pointer-events": "none", class: "annot-shape",
            }));
            visuals.push(svgEl("circle", {
                cx: m.anchor.x, cy: m.anchor.y, r: dotR,
                fill: color, "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
        case "line": {
            const l = object.geometry as LineGeometry;
            const d = highlightPath(l.points);
            // 圆线端：圆头 + 圆折角；关掉是机械制图那种平齐的方头 + 尖角
            const roundEnd = object.style.lineRound !== false;
            group.append(svgEl("path", {
                "data-role": "hit", d, fill: "none", stroke: "transparent",
                "stroke-width": Math.max(18, lineWidth + 12) / zoom,
                "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "stroke",
            }));
            visuals.push(svgEl("path", {
                d, fill: "none", stroke: color, "stroke-width": lineWidth,
                "stroke-linecap": roundEnd ? "round" : "butt",
                "stroke-linejoin": roundEnd ? "round" : "miter",
                "stroke-miterlimit": "10",
                "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
        case "highlight": {
            const h = object.geometry as HighlightGeometry;
            const d = highlightPath(h.points);
            group.append(svgEl("path", {
                "data-role": "hit", d, fill: "none", stroke: "transparent",
                "stroke-width": lineWidth * 6 + 12 / zoom,
                "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "stroke",
            }));
            // 单条 path 一次性绘制，自交叠不会像多次 stroke 那样加深；
            // 透明度由 group 统一施加
            visuals.push(svgEl("path", {
                d, fill: "none", stroke: color,
                "stroke-width": lineWidth * 6, "stroke-linecap": "round", "stroke-linejoin": "round",
                "pointer-events": "none", class: "annot-shape",
            }));
            break;
        }
    }

    const dash = object.style.lineDash;
    if (dash && dash !== "solid" &&
        object.type !== "text" && object.type !== "number" &&
        object.type !== "mosaic" && object.type !== "blur" &&
        object.type !== "spotlight" && object.type !== "magnifier") {
        // 留空距离由悬浮条上的「间距」控制（1~20px），改它就能调疏密
        const gap = Math.min(20, Math.max(1, object.style.lineDashGap ?? 6));
        const dot = Math.max(0.01, lineWidth * 0.01);
        const pattern = dash === "dotted"
            ? `${dot} ${gap}`
            // 点划线：长划 + 空隙 + 极短划（配合圆头画成一个点）+ 空隙，
            // 就是机械制图里中心线那种「长—点—长—点」
            : dash === "dashdot"
                ? `${Math.max(10, lineWidth * 5)} ${gap} ${dot} ${gap}`
                : `${Math.max(6, lineWidth * 3)} ${gap}`;
        for (const visual of visuals) {
            if ((visual.getAttribute("class") || "").includes("annot-head")) continue;
            const stroke = visual.getAttribute("stroke");
            if (stroke && stroke !== "none" && stroke !== "transparent") {
                visual.setAttribute("stroke-dasharray", pattern);
                // 点线 / 点划线的「点」靠圆头画出来，方头会变成一个看不见的碎片
                visual.setAttribute("stroke-linecap",
                    dash === "dotted" || dash === "dashdot" ? "round" : "butt");
            }
        }
    }

    for (const visual of visuals) group.append(visual);
    return group;
}

/** 绘制中的草稿：复用正式渲染，再去掉命中层并降低不透明度 */
export function renderDraft(object: AnnotObject, options: RenderOptions): SVGGElement {
    const group = renderObject(object, options);
    group.classList.add("is-preview");
    group.querySelectorAll('[data-role="hit"]').forEach((el) => el.remove());
    return group;
}

// ---------------------------------------------------------------- 手柄
const RESIZE_ANCHORS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

function resizeHandlePositions(b: Bounds): Record<string, Point> {
    return {
        nw: {x: b.x, y: b.y},
        n: {x: b.x + b.width / 2, y: b.y},
        ne: {x: b.x + b.width, y: b.y},
        e: {x: b.x + b.width, y: b.y + b.height / 2},
        se: {x: b.x + b.width, y: b.y + b.height},
        s: {x: b.x + b.width / 2, y: b.y + b.height},
        sw: {x: b.x, y: b.y + b.height},
        w: {x: b.x, y: b.y + b.height / 2},
    };
}

/** 手柄尺寸（屏幕像素，不随画布缩放变）：radius 是看得见的圆点，hitRadius 是透明命中圆 */
export interface HandleSizes {
    radius: number;
    hitRadius: number;
}

const DESKTOP_HANDLES: HandleSizes = {radius: 9, hitRadius: 17};

/**
 * 移动 / 旋转 / 编辑三枚按钮的图标：统一 1024 视图（用户提供的图形），
 * 画在圆底里，颜色走 currentColor，跟随主题。
 */
const HANDLE_ICONS: Record<string, string> = {
    move: "M78.1312 490.24h412.1088V78.1312L378.9056 189.4656a21.76 21.76 0 1 1-30.7712-30.7712l148.48-148.48a21.76 21.76 0 0 1 30.7712 0l148.48 148.48a21.76 21.76 0 0 1-30.7712 30.7712L533.76 78.1312v412.1088h412.1088l-111.3344-111.3344a21.76 21.76 0 0 1 30.7712-30.7712l148.48 148.48a21.76 21.76 0 0 1 0 30.7712l-148.48 148.48a21.76 21.76 0 0 1-30.7712-30.7712l111.3344-111.3344h-412.1088v412.1088l111.3344-111.3344a21.76 21.76 0 0 1 30.7712 30.7712l-148.48 148.48a21.76 21.76 0 0 1-30.7712 0l-148.48-148.48a21.76 21.76 0 0 1 30.7712-30.7712L490.24 945.8688v-412.1088H78.1312l111.3344 111.3344a21.76 21.76 0 0 1-30.7712 30.7712l-148.48-148.48a21.76 21.76 0 0 1 0-30.7712l148.48-148.48a21.76 21.76 0 1 1 30.7712 30.7712L78.1312 490.24z",
    rotate: "M512 992a480 480 0 1 1 390.4-759.04V128a32 32 0 0 1 64 0v192a32 32 0 0 1-32 32h-192a32 32 0 0 1 0-64h120.32a416 416 0 1 0 64 224 32 32 0 0 1 64 0A480 480 0 0 1 512 992z",
    edit: "M982.016 301.568L696.832 20.992c-7.168-6.656-16.384-10.24-26.112-10.752-9.728 0-19.456 4.096-26.112 11.264L113.152 567.296c-5.12 5.12-8.704 11.776-9.728 18.944l-71.68 383.488c-2.048 12.288 1.536 25.088 10.752 33.28 7.168 6.656 16.384 10.24 25.6 10.24 2.56 0 5.632-0.512 8.192-1.024l337.92-75.264c7.168-1.536 13.312-5.12 18.432-10.24L983.04 353.792c13.824-14.848 13.824-37.888-1.024-52.224zM419.84 833.024l-141.824-140.8c-14.336-14.336-37.888-14.336-52.224 0-14.336 14.336-14.336 37.888 0 52.736l130.048 129.024-241.664 54.272 59.392-317.44 497.664-510.976 232.96 228.864L419.84 833.024z",
};

function makeHandle(
    name: string, p: Point, zoom: number, marker = "circle", sizes: HandleSizes = DESKTOP_HANDLES,
): SVGGElement {
    const radius = sizes.radius / zoom;
    const hitRadius = sizes.hitRadius / zoom;
    const strokeWidth = 1.9 / zoom;
    const group = svgEl("g", {"data-handle": name, class: "annot-handle"});
    group.append(svgEl("circle", {
        cx: p.x, cy: p.y, r: hitRadius, fill: "transparent", "pointer-events": "all",
    }));
    if (marker === "diamond") {
        const r = radius * 1.32;
        group.append(svgEl("polygon", {
            points: `${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}`,
            fill: "var(--annot-panel)", stroke: "var(--annot-accent)",
            "stroke-width": strokeWidth, "pointer-events": "none",
        }));
    } else {
        group.append(svgEl("circle", {
            cx: p.x, cy: p.y, r: radius,
            fill: "var(--annot-panel)", stroke: "var(--annot-accent)",
            "stroke-width": strokeWidth, "pointer-events": "none",
        }));
    }
    if (HANDLE_ICONS[marker]) {
        // 白色圆底 + 细边框：任何底图上都能看清；图标用 currentColor 跟随主题
        group.append(svgEl("circle", {
            cx: p.x, cy: p.y, r: radius,
            fill: "var(--annot-panel)",
            stroke: "var(--annot-accent)",
            "stroke-width": strokeWidth * 0.72,
            "pointer-events": "none",
        }));
        const k = (radius * 1.26) / 1024;
        const icon = svgEl("g", {
            transform: `translate(${p.x} ${p.y}) scale(${k}) translate(-512 -512)`,
            style: "color: var(--annot-accent)",
            "pointer-events": "none",
        });
        icon.append(svgEl("path", {d: HANDLE_ICONS[marker], fill: "currentColor"}));
        group.append(icon);
    } else if (marker === "diamond") {
        const r = radius * 1.02;
        group.append(svgEl("polygon", {
            points: `${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}`,
            fill: "var(--annot-panel)", stroke: "var(--annot-accent)",
            "stroke-width": strokeWidth, "pointer-events": "none",
        }));
    } else {
        group.append(svgEl("circle", {
            cx: p.x, cy: p.y, r: radius,
            fill: "var(--annot-panel)", stroke: "var(--annot-accent)",
            "stroke-width": strokeWidth, "pointer-events": "none",
        }));
    }
    if (name === "curve" || name === "tip") {
        group.append(svgEl("circle", {
            cx: p.x, cy: p.y, r: radius * 0.40,
            fill: "var(--annot-accent)", "pointer-events": "none",
        }));
    }
    return group;
}

/**
 * 渲染选中对象的手柄。返回的元素直接 append 到 overlay 层。
 * 选中虚线框、旋转连线与手柄全部放进同一个旋转 group：
 * 对象被转 90° 之后，虚线框如果还横着画，就会和实际画面完全对不上。
 */
export function renderHandles(
    object: AnnotObject, zoom: number, sizes: HandleSizes = DESKTOP_HANDLES,
): SVGElement[] {
    const bounds = getBounds(object);
    const center = boundsCenter(bounds);
    const rotation = getRotation(object);
    const dash = `${6 / zoom} ${4 / zoom}`;
    const result: SVGElement[] = [];
    // 四角 / 四边：视觉上收小一圈（画布放大后不再笨重），命中半径一点不减；
    // 文字块只有一行高，再小一档，四个角才不会上下叠在一起。
    const dotSizes: HandleSizes = {
        ...sizes,
        radius: sizes.radius * (object.type === "text" ? 0.52 : 0.67),
    };
    // 移动 / 旋转 / 编辑：圆底里要放 1024 图标，所以比角点大一圈
    const buttonSizes: HandleSizes = {
        ...sizes,
        radius: sizes.radius * 1.22,
        hitRadius: sizes.hitRadius + 4,
    };

    const handlesGroup = svgEl("g", {"data-role": "handles"});
    if (rotation) handlesGroup.setAttribute("transform", `rotate(${rotation} ${center.x} ${center.y})`);

    handlesGroup.append(svgEl("rect", {
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        fill: "none", stroke: "var(--annot-accent)", "stroke-width": 2 / zoom,
        "stroke-dasharray": dash, opacity: 0.7, "pointer-events": "none",
        class: "annot-selection-box",
    }));

    if (object.type === "arrow") {
        const a = object.geometry as ArrowGeometry;
        const control = a.control ?? midpoint(a.start, a.end);
        if (a.control) {
            handlesGroup.append(svgEl("line", {
                x1: midpoint(a.start, a.end).x, y1: midpoint(a.start, a.end).y,
                x2: control.x, y2: control.y,
                stroke: "var(--annot-accent)", "stroke-width": 2 / zoom,
                "stroke-dasharray": dash, opacity: 0.65, "pointer-events": "none",
            }));
        }
        handlesGroup.append(makeHandle("start", a.start, zoom, "circle", sizes));
        handlesGroup.append(makeHandle("end", a.end, zoom, "circle", sizes));
        handlesGroup.append(makeHandle("curve", control, zoom, "diamond", sizes));
    } else if (object.type === "line") {
        const l = object.geometry as LineGeometry;
        l.points.forEach((p, i) => {
            handlesGroup.append(makeHandle(`point:${i}`, p, zoom, "circle", sizes));
        });
    } else {
        const positions = resizeHandlePositions(bounds);
        // 文字只用四角手柄：边中点手柄会压在文字中线上，
        // 用户想「点一下文字就编辑」时容易误触成缩放
        const anchors = object.type === "text"
            ? (["nw", "ne", "se", "sw"] as const)
            : RESIZE_ANCHORS;
        for (const anchor of anchors) {
            handlesGroup.append(makeHandle(`resize:${anchor}`, positions[anchor], zoom, "circle", dotSizes));
        }
        if (supportsRotation(object)) {
            const top = {x: center.x, y: bounds.y - 26 / zoom};
            handlesGroup.append(svgEl("line", {
                x1: center.x, y1: bounds.y, x2: top.x, y2: top.y,
                stroke: "var(--annot-accent)", "stroke-width": 1.5 / zoom,
                "stroke-dasharray": dash, opacity: 0.6, "pointer-events": "none",
            }));
            handlesGroup.append(makeHandle("rotate", top, zoom, "rotate", buttonSizes));
        }
        if (object.type === "number") {
            const n = object.geometry as NumberGeometry;
            const tip = n.tip ?? {x: n.center.x, y: n.center.y - n.radius - 20 / zoom};
            handlesGroup.append(makeHandle("tip", tip, zoom, "diamond", sizes));
        }
        if (object.type === "magnifier") {
            // 锚点单独一个手柄：拖动它只换「看哪儿」，镜框不动。
            // 这里不再补一条虚线引导线——对象自己已经画了实心连线，
            // 再来一条会横穿镜片、把放大后的画面割开。
            const m = object.geometry as MagnifierGeometry;
            handlesGroup.append(makeHandle("anchor", m.anchor, zoom, "circle", sizes));
        }
    }
    // 移动抓手：刚画好的图形常常要挪一下，有这个就不用先切回选择工具。
    // 两点箭头的曲线手柄正好在包围盒中心，错开 26px 免得把它盖住。
    let moveAt = {x: center.x, y: center.y};
    if (object.type === "text") {
        // 文字的中心就是字本身，抓手压上去会看不清；挪到正下方，
        // 和上方那枚旋转抓手上下对称，各带一条虚线指回文字。
        moveAt = {x: center.x, y: bounds.y + bounds.height + 30 / zoom};
        handlesGroup.append(svgEl("line", {
            x1: center.x, y1: bounds.y + bounds.height,
            x2: moveAt.x, y2: moveAt.y,
            stroke: "var(--annot-accent)", "stroke-width": 1.5 / zoom,
            "stroke-dasharray": dash, opacity: 0.6, "pointer-events": "none",
        }));
    } else if (object.type === "arrow") {
        const a = object.geometry as ArrowGeometry;
        const control = a.control ?? midpoint(a.start, a.end);
        if (Math.abs(control.x - center.x) < 1 && Math.abs(control.y - center.y) < 1) {
            moveAt = {x: center.x, y: center.y + 26 / zoom};
        }
    }
    handlesGroup.append(makeHandle("move", moveAt, zoom, "move", buttonSizes));
    if (object.type === "text") {
        // 文字：右上角一颗「再次编辑」，触屏上不用反复点文字去唤醒键盘
        handlesGroup.append(makeHandle("edit", {
            x: bounds.x + bounds.width + 26 / zoom,
            y: bounds.y - 26 / zoom,
        }, zoom, "edit", buttonSizes));
    }

    result.push(handlesGroup);
    return result;
}

/**
 * 新建对象的默认样式：一律套用工具栏当前预设，
 * 这样「调过一次线宽之后继续画」不会又回到默认最细。
 */
export function defaultStyle(type: AnnotType, current: CurrentStyle) {
    const highlightRect = type === "highlightRect";
    const shape = type === "rect" || type === "ellipse" || highlightRect;
    // 矩形高亮的「浓度」直接复用填充不透明度；当前填充是 0% 时兜底 50%，
    // 否则刚画出来会是一块全透明，看着像「什么都没发生」
    // 定位气泡走「白底 + 彩边」，所以它的填充默认是实心白，不带描边预设里的浓度
    const bubble = type === "number" ? normalizeNumberBubble(current.numberBubble) : "solid";
    const pointerNumber = bubble === "pointer";
    const hollowNumber = bubble === "hollow";
    const fill = highlightRect
        ? (current.fillOpacity > 0 ? current.fillOpacity : 0.5)
        : (shape ? current.fillOpacity : ((pointerNumber || hollowNumber) ? 1 : 0));
    const style = {
        color: current.color,
        lineWidth: current.lineWidth,
        opacity: type === "highlight" ? 0.35 : 1,
        fontSize: current.fontSize,
        // 只有文字用得上；存的是档位键，渲染时才翻译成字体栈
        fontFamily: type === "text" ? current.fontFamily : undefined,
        fillOpacity: fill,
        // 定位气泡与空心圆都给一个可填的底色：定位默认白，空心默认全透明
        fillColor: (pointerNumber || hollowNumber) ? "#FFFFFF" : (shape ? current.fillColor : undefined),
        fillMode: (shape && fill > 0 ? "translucent" : "none") as "none" | "solid" | "translucent",
        lineDash: current.lineDash,
        lineDashGap: current.lineDashGap,
        arrowStyle: current.arrowStyle,
        // 类型 + 端点：渲染只看这两个，arrowStyle 只是给旧版插件留的备份
        arrowType: current.arrowType,
        arrowHead: current.arrowHead,
        arrowRounded: current.arrowRounded,
        // 线端圆润只对画线有意义（箭头的圆润由 arrowRounded 管）
        lineRound: type === "line" ? current.lineRound : undefined,
        // 序号引线末端：箭头 / 圆点 / 方点
        numberTip: type === "number" ? current.numberTip : undefined,
        // 序号引线箭头用哪种样式：默认跟随箭头工具当前选的
        numberArrowHead: type === "number" ? current.numberArrowHead : undefined,
        numberArrowStyle: type === "number" ? current.numberArrowStyle : undefined,
        // 聚光灯的暗度 / 遮罩颜色跟着悬浮条最后一次调整
        spotlightOpacity: type === "spotlight" ? current.spotlightOpacity : undefined,
        spotlightColor: type === "spotlight" ? current.spotlightColor : undefined,
        // 圆角只对矩形有意义，画椭圆时不必带上
        cornerRadius: type === "rect" ? current.cornerRadius : 0,
    };
    // 文字默认带描边：复杂底图上不加白边几乎看不清
    if (type === "text") {
        Object.assign(style, {
            textStrokeEnabled: current.textStrokeEnabled,
            textStrokeColor: current.textStrokeColor,
            textStrokeWidth: current.textStrokeWidth,
        });
    }
    return style;
}

export function objectLabel(object: AnnotObject): string {
    if (object.type === "text") {
        const text = (object.geometry as TextGeometry).text;
        return text ? `文字：${text.slice(0, 8)}` : "文字";
    }
    if (object.type === "number") {
        const n = object.geometry as NumberGeometry;
        return `序号 ${formatNumber(n.number, n.format ?? "arabic")}`;
    }
    if (object.type === "magnifier") {
        const zoom = (object.geometry as MagnifierGeometry).zoom ?? 2;
        return `放大镜 ${zoom}x`;
    }
    if (object.type === "spotlight") {
        const shape = (object.geometry as SpotlightGeometry).shape === "ellipse" ? "椭圆" : "矩形";
        return `聚光灯（${shape}）`;
    }
    return TYPE_LABELS[object.type];
}
