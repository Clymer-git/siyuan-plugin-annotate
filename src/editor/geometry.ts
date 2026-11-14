/**
 * 几何与 SVG 构建工具。
 *
 * 坐标体系：所有点都用「图片原始像素」表示（SVG viewBox 恒等于 0 0 W H），
 * 视口的缩放/平移由外层 CSS transform 负责，因此这里的函数不需要知道 zoom。
 * 只有「手柄大小」「命中容差」这类需要保持屏幕尺寸的元素，才由调用方除以 zoom。
 *
 * 箭头行为参照 capcap 的 ArrowAnnotation（Annotations.swift:1383-2016）：
 * control 为 null 是直线，否则是二次贝塞尔；曲线时头部方向取 end - control。
 */

import type {ArrowGeometry, Point} from "../types";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** 创建 SVG 元素并批量设置属性 */
export function svgEl<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, String(value));
    }
    return el;
}

export function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
    return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
}

/** 点到线段的最短距离 */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return distance(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return distance(p, {x: a.x + t * dx, y: a.y + t * dy});
}

/** 二次贝塞尔在 t 处的点 */
export function quadAt(t: number, s: Point, c: Point, e: Point): Point {
    const u = 1 - t;
    return {
        x: u * u * s.x + 2 * u * t * c.x + t * t * e.x,
        y: u * u * s.y + 2 * u * t * c.y + t * t * e.y,
    };
}

/** 点到二次贝塞尔的近似最短距离（折线采样，24 段足够命中检测用） */
export function distanceToQuad(p: Point, s: Point, c: Point, e: Point, samples = 24): number {
    let best = Infinity;
    let prev = s;
    for (let i = 1; i <= samples; i++) {
        const cur = quadAt(i / samples, s, c, e);
        best = Math.min(best, pointSegmentDistance(p, prev, cur));
        prev = cur;
    }
    return best;
}

/** 箭头末端的单位方向：曲线用 end - control，直线用 end - start */
export function arrowUnit(g: ArrowGeometry): Point {
    const ref = g.control ?? g.start;
    const dx = g.end.x - ref.x;
    const dy = g.end.y - ref.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.0001) return {x: 0, y: -1};
    return {x: dx / len, y: dy / len};
}

export function headLength(lineWidth: number): number {
    return Math.max(14, lineWidth * 4.2);
}

/** 箭头脊柱路径；shrink 让线段终点内缩，避免从箭头头部里穿出来 */
export function arrowPath(g: ArrowGeometry, shrink = 0, shrinkStart = 0): string {
    const unit = arrowUnit(g);
    const end = {x: g.end.x - unit.x * shrink, y: g.end.y - unit.y * shrink};
    const start = {x: g.start.x + unit.x * shrinkStart, y: g.start.y + unit.y * shrinkStart};
    const s = `${start.x} ${start.y}`;
    const e = `${end.x} ${end.y}`;
    return g.control
        ? `M ${s} Q ${g.control.x} ${g.control.y} ${e}`
        : `M ${s} L ${e}`;
}

/** 箭头头部三角形顶点 */
export function arrowHeadPoints(g: ArrowGeometry, lineWidth: number, atStart = false): string {
    const unit = arrowUnit(g);
    const sign = atStart ? -1 : 1;
    const dir = {x: unit.x * sign, y: unit.y * sign};
    const perp = {x: -dir.y, y: dir.x};
    const tip = atStart ? g.start : g.end;
    const len = headLength(lineWidth);
    const width = Math.max(11, lineWidth * 3);
    const base = {x: tip.x - dir.x * len, y: tip.y - dir.y * len};
    const a = `${tip.x},${tip.y}`;
    const b = `${base.x + perp.x * width / 2},${base.y + perp.y * width / 2}`;
    const c = `${base.x - perp.x * width / 2},${base.y - perp.y * width / 2}`;
    return `${a} ${b} ${c}`;
}

/** 两端垂直短线 / 线框箭头用到的法向量 */
export function arrowPerp(g: ArrowGeometry): Point {
    const unit = arrowUnit(g);
    return {x: -unit.y, y: unit.x};
}

/** 命中检测：曲线走折线采样，直线走点到线段 */
export function hitArrow(g: ArrowGeometry, p: Point, tolerance: number): boolean {
    if (g.control) return distanceToQuad(p, g.start, g.control, g.end) <= tolerance;
    return pointSegmentDistance(p, g.start, g.end) <= tolerance;
}

/** 整体平移箭头（控制点一起走） */
export function translateArrow(g: ArrowGeometry, dx: number, dy: number): ArrowGeometry {
    const move = (p: Point): Point => ({x: p.x + dx, y: p.y + dy});
    return {
        start: move(g.start),
        end: move(g.end),
        control: g.control ? move(g.control) : null,
    };
}

/** 复制几何，避免拖拽过程中改动被历史快照意外共享 */
export function cloneArrow(g: ArrowGeometry): ArrowGeometry {
    return {
        start: {...g.start},
        end: {...g.end},
        control: g.control ? {...g.control} : null,
    };
}

/** 箭头包围盒（含控制点），用于选中虚线框 */
export function arrowBounds(g: ArrowGeometry, padding: number): {x: number; y: number; width: number; height: number} {
    const pts: Point[] = [g.start, g.end];
    if (g.control) pts.push(g.control);
    else {
        // 直线时曲线手柄在几何中点
        pts.push(midpoint(g.start, g.end));
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    return {
        x: minX,
        y: minY,
        width: Math.max(...xs) + padding - minX,
        height: Math.max(...ys) + padding - minY,
    };
}
