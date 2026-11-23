/**
 * 尺寸标注的单位换算与数值格式化。
 *
 * 存的是画布像素（与图片同坐标），所以画面放大缩小时标注的「物理尺寸」不会变 ——
 * 变的只是它在屏幕上的大小。单位按 96 DPI 折算（图片本身没有物理尺寸元数据，
 * 这是屏幕显示的通用约定，也是截图类工具的一致做法）。
 */
import type {Point} from "../types";

export type MeasureUnit = "px" | "mm" | "cm" | "m" | "km" | "um" | "pt" | "in" | "ft";
/** 长度单位下拉的固定顺序（与 snow-shot 一致） */
export const LENGTH_UNITS: Array<[MeasureUnit, string]> = [
    ["mm", "mm"], ["cm", "cm"], ["m", "m"], ["km", "km"], ["um", "μm"],
    ["px", "px"], ["pt", "pt"], ["in", "in"], ["ft", "ft"],
];
/** 角度单位：度 / 弧度 */
export type AngleUnit = "deg" | "rad";

const DPI = 96;

/** 画布像素 → 目标单位 */
export function toUnit(px: number, unit: string): number {
    switch (unit) {
        case "mm": return px * 25.4 / DPI;
        case "cm": return px * 2.54 / DPI;
        case "in": return px / DPI;
        case "m": return px * 0.0254 / DPI;
        case "km": return px * 0.0000254 / DPI;
        case "um": return px * 25400 / DPI;
        case "ft": return px / DPI / 12;
        case "pt": return px * 72 / DPI;
        default: return px;
    }
}

/** 只给数值部分（不含单位），编辑时用它填输入框 */
export function measureNumberText(px: number, unit: string): string {
    const value = toUnit(px, unit);
    if (unit === "px" || unit === "um") return String(Math.round(value));
    return value.toFixed(1);
}

/** 单位后缀（编辑时固定显示在输入框右侧，不可被删掉） */
export function measureSuffix(unit: string): string {
    if (unit === "deg") return "°";
    if (unit === "um") return " μm";
    return ` ${unit}`;
}

/** 已知单位后缀：从用户自定义文字里剥掉旧单位时用 */
const UNIT_TOKENS = ["mm", "cm", "km", "μm", "um", "px", "pt", "in", "ft", "m", "°", "deg", "rad"];

/**
 * 最终显示文本：用户改过数值时，只保留「数字 + 自定义尾巴」，单位永远按当前设置拼。
 * 这样切单位不会因为自定义文字被写死而不生效。
 */
export function measureTextWithUnit(custom: string | undefined, auto: string, unit: string): string {
    if (!custom) return auto;
    const match = custom.match(/^(-?\d+(?:\.\d+)?)([\s\S]*)$/);
    if (!match) return custom;
    let tail = match[2] ?? "";
    const trimmed = tail.trim();
    for (const token of UNIT_TOKENS) {
        if (trimmed.endsWith(token)) {
            tail = trimmed.slice(0, -token.length);
            break;
        }
    }
    return `${match[1]}${tail}${measureSuffix(unit)}`;
}

/** 数值文案：像素取整，物理单位留一位小数 */
export function formatMeasure(px: number, unit: string): string {
    const value = toUnit(px, unit);
    if (unit === "px") return `${Math.round(value)} px`;
    if (unit === "um") return `${Math.round(value)} μm`;
    return `${value.toFixed(1)} ${unit}`;
}

/** 角度文案：按选择的单位输出 */
export function formatAngle(deg: number, unit: string): string {
    if (unit === "rad") return `${(deg * Math.PI / 180).toFixed(2)} rad`;
    return `${deg.toFixed(1)}°`;
}

/** 数值标签的中心点（画布坐标）：长度取中点，角度取角平分线外侧 */
export function measureLabelPoint(g: {mode: string; start: Point; end: Point; vertex?: Point},
                                  fontSize: number): Point {
    if (g.mode === "angle" && g.vertex) {
        const v = g.vertex;
        const a1 = Math.atan2(g.start.y - v.y, g.start.x - v.x);
        const a2 = Math.atan2(g.end.y - v.y, g.end.x - v.x);
        let sweep = a2 - a1;
        while (sweep <= -Math.PI) sweep += Math.PI * 2;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        const radius = Math.min(fontSize * 3.4,
            Math.hypot(g.start.x - v.x, g.start.y - v.y) * 0.8,
            Math.hypot(g.end.x - v.x, g.end.y - v.y) * 0.8);
        const mid = a1 + sweep / 2;
        return {x: v.x + Math.cos(mid) * (radius + fontSize * 1.5),
            y: v.y + Math.sin(mid) * (radius + fontSize * 1.5)};
    }
    return {x: (g.start.x + g.end.x) / 2, y: (g.start.y + g.end.y) / 2};
}

/** 三点夹角（顶点在 vertex），返回 0~180 度 */
export function angleAt(vertex: Point, a: Point, b: Point): number {
    const v1 = {x: a.x - vertex.x, y: a.y - vertex.y};
    const v2 = {x: b.x - vertex.x, y: b.y - vertex.y};
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 0.001 || l2 < 0.001) return 0;
    const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
    return Math.acos(cos) * 180 / Math.PI;
}
