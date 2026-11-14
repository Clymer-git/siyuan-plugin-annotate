/**
 * 矩形圆角半径：与 ShareX 的 CornerRadius 同义。
 *
 * 参考源码（参考工程 ShareX-develop）：
 *   Core/Annotations/Shapes/RectangleAnnotation.cs —— `CornerRadius`（int，四角同值）
 *   Presentation/Rendering/AnnotationVisuals/RectangleAnnotation.Visual.cs —— RadiusX = RadiusY
 *   Presentation/Controls/CornerRadiusPickerDropdown.axaml.cs —— 档位 0/2/4/6/8/10/15/20/25/30
 *
 * 这里只放常量与数值换算，不碰 DOM：下拉里的图案、画布上的形状、静态测试都读同一份。
 */

import type {AnnotObject, RectGeometry} from "../types";

/** 悬浮条下拉里的档位，与 ShareX 的顺序一致 */
export const CORNER_RADIUS_OPTIONS = [0, 2, 4, 6, 8, 10, 15, 20, 25, 30];

/** 手机端上栏只放五档：屏幕窄，够用比齐全重要 */
export const MOBILE_CORNER_STEPS = [0, 4, 8, 16, 24];

/** 上限：再大就没有意义了（矩形总共也没多宽），也防止手填出离谱的值 */
export const CORNER_RADIUS_MAX = 80;

/** 把任意输入收敛成合法半径：非法值 / 负数按 0，超出上限按上限 */
export function normalizeCornerRadius(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(CORNER_RADIUS_MAX, Math.round(n * 10) / 10);
}

/**
 * 矩形实际生效的圆角：四个角同半径，矩形窄到放不下时按半边长截断
 * （与 ShareX 把 RadiusX 直接写进形状、由渲染器自行收敛的效果一致）。
 */
export function rectCornerRadius(styleRadius: unknown, geometry: RectGeometry): number {
    const radius = normalizeCornerRadius(styleRadius);
    if (radius <= 0) return 0;
    return Math.min(radius, Math.abs(geometry.width) / 2, Math.abs(geometry.height) / 2);
}

/**
 * 下拉图案里那个「圆角拐角」该画多大。
 * 档位是 0~30，图案边长 20（内边距 3），按比例映射到 0~14 才会每档可辨。
 */
export function cornerPreviewRadius(radius: number): number {
    const value = normalizeCornerRadius(radius);
    return Math.round(14 * Math.min(1, value / 30) * 100) / 100;
}

/** 判断对象是否矩形的守卫，避免调用处到处写 type === "rect" */
export function isRectObject(object: AnnotObject | null | undefined): boolean {
    return object?.type === "rect";
}
