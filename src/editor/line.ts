/**
 * 画线工具的几何纯函数（不碰 DOM，方便单测）。
 *
 * 三个用途：
 * 1. Shift 约束：把终点吸附到水平 / 垂直 / 45° 这八个方向，保持线段长度；
 * 2. 触屏智能矫正：判断这次滑动该不该自动拉直；
 * 3. 轨迹笔直度：量一下采样点偏离「起点→终点」直线有多远。
 */

import type {Point} from "../types";

const STEP = Math.PI / 4;

/** 把 to 吸附到以 from 为起点的八个方向（水平 / 垂直 / 45°），长度不变 */
export function snapDirection(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return {...from};
    const angle = Math.round(Math.atan2(dy, dx) / STEP) * STEP;
    return {x: from.x + length * Math.cos(angle), y: from.y + length * Math.sin(angle)};
}

/** 当前方向与最近的 45° 网格差多少度（0~22.5） */
export function angleOffsetFromGrid(from: Point, to: Point): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.hypot(dx, dy) < 1e-6) return 0;
    const raw = Math.atan2(dy, dx) / STEP;
    return Math.abs(raw - Math.round(raw)) * 45;
}

/** 采样点偏离「起点→终点」直线的最大距离（画布像素） */
export function maxPathDeviation(samples: Point[], from: Point, to: Point): number {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return 0;
    let worst = 0;
    for (const p of samples) {
        // 点到直线的垂直距离（二维叉积除以底边长）
        const offset = Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx) / length;
        if (offset > worst) worst = offset;
    }
    return worst;
}

/** 触屏矫正的判定输入，全部换算成「屏幕像素」，与画布缩放无关 */
export interface TouchLineInfo {
    /** 手指在末端停了多久（毫秒） */
    dwellMs: number;
    /** 起点到终点的屏幕距离 */
    distancePx: number;
    /** 轨迹偏离直线的最大屏幕距离 */
    deviationPx: number;
    /** 与最近的 45° 方向差多少度 */
    angleOffsetDeg: number;
}

/**
 * 是否把这条手指画的线自动拉直成水平 / 垂直 / 45°。
 *
 * 三种情况才矫正，避免把用户认真画的一条普通斜线强行掰弯：
 * - 末端短暂停留后松手（用户明确停顿，多半是想画直的）；
 * - 滑动距离极短（几乎是个点，无所谓方向）；
 * - 轨迹本来就很直，而且方向已经接近 45° 网格（顺手帮它对齐）。
 */
export function shouldSnapTouchLine(info: TouchLineInfo): boolean {
    if (info.dwellMs >= 180) return true;
    if (info.distancePx <= 12) return true;
    return info.deviationPx <= 10 && info.angleOffsetDeg <= 12;
}
