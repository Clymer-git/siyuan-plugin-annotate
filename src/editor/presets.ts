import type {ArrowStyleKey} from "../types";
import {normalizeArrowStyle} from "./arrowStyles";
import {DEFAULT_NUMBER_FORMAT, normalizeNumberFormat, type NumberFormatKey} from "./numberFormat";
import {DEFAULT_NUMBER_TIP, normalizeNumberTip, type NumberTipKey} from "./numberTip";

/**
 * 工具栏样式预设。
 *
 * 用户痛点：在属性面板里把箭头/矩形调粗后，再画一个新对象又回到默认最细。
 * 现在工具栏提供四组预设（颜色 / 线宽 / 填充透明度 / 字号），新绘制的对象
 * 一律套用当前预设；在属性面板里改选中对象时也会同步更新预设，
 * 因此「调过一次之后继续画」保持同样外观。
 * 预设之外的数值仍在右侧属性面板里调节；四组预设数值可在设置浮层里自定义。
 */

export interface StylePresets {
    colors: string[];
    lineWidths: number[];
    /** 填充不透明度，0~1；0 表示不填充 */
    fillOpacities: number[];
    fontSizes: number[];
    /** 每种线型各自的留空间距（像素）：改虚线不会影响点线 */
    dashGaps: Record<LineDashKey, number>;
}

/**
 * 顶部属性栏的线型。
 * `dashdot` 是机械制图里中心线那种「长划—点—长划」，不是普通的差分虚线。
 */
export type LineDashKey = "solid" | "dashed" | "dotted" | "dashdot";

/** 当前选中的样式值（可能来自预设，也可能来自属性面板的自定义值） */
export interface CurrentStyle {
    color: string;
    lineWidth: number;
    fillOpacity: number;
    /** 填充色（与描边色分开） */
    fillColor: string;
    fontSize: number;
    /** 顶部属性栏的线条样式 */
    lineDash: LineDashKey;
    /** 虚线 / 点线 / 点划线的留空间距（像素） */
    lineDashGap: number;
    /** 箭头工具当前选中的样式（悬浮工具条下拉框） */
    arrowStyle: ArrowStyleKey;
    /** 箭头端点与折角是否圆润（界面文案「圆线」） */
    arrowRounded: boolean;
    /** 画线工具的线端是否圆润（界面文案「圆线」）：关掉是方头 */
    lineRound: boolean;
    /** 序号的编号格式（1 / I / a / A / 一） */
    numberFormat: NumberFormatKey;
    /** 序号引线末端（箭头 / 圆点 / 方点） */
    numberTip: NumberTipKey;
    /** 序号引线用哪种箭头样式（只在端点=箭头时可见） */
    numberArrowStyle: ArrowStyleKey;
    /** 聚光灯周围遮罩的暗度 0~1（界面显示成百分比） */
    spotlightOpacity: number;
    /** 聚光灯遮挡形状：矩形 / 椭圆 */
    spotlightShape: "rect" | "ellipse";
    /** 聚光灯遮罩颜色：黑色 / 白色 */
    spotlightColor: "black" | "white";
    /** 放大镜倍数 */
    magnifierZoom: number;
    /** 放大镜显示框形状：圆形 / 矩形 */
    magnifierShape: "rect" | "ellipse";
    /** 矩形圆角半径（画布像素），与 ShareX 的 CornerRadius 同义 */
    cornerRadius: number;
    /** 高亮工具的模式：自由涂抹 / 拖出矩形色块（会记进预设，下次打开还是上次选的） */
    highlightMode: "brush" | "rect";
    /** 马赛克 / 模糊的「选区识别」开关：开着时框选完自动贴合主体轮廓 */
    smartSelect: boolean;
    /** 文字描边（只对文字生效，不在四组预设里，跟随属性面板最后一次调整） */
    textStrokeEnabled: boolean;
    textStrokeColor: string;
    textStrokeWidth: number;
}

export const DEFAULT_PRESETS: StylePresets = {
    colors: ["#EF4444", "#F59E0B", "#10B981", "#06B6D4", "#8B5CF6"],
    // 线宽 / 填充 / 字号各四档，最后一档是「更粗 / 更实 / 更大」的那一档
    lineWidths: [2, 4, 8, 14],
    fillOpacities: [0, 0.15, 0.5, 0.85],
    fontSizes: [18, 28, 42, 64],
    dashGaps: {solid: 6, dashed: 6, dotted: 6, dashdot: 6},
};

/**
 * v0.13.x 的三档默认值。
 *
 * 本地存过预设的用户，读到的是自己那份三档数组，新加的第四档永远看不到。
 * 只有在「存下来的数组与旧默认值一字不差」时（也就是用户从没改过），
 * 才升级成新的四档；用户真改过的数组一律原样保留。
 */
const LEGACY_DEFAULT_PRESETS: StylePresets = {
    colors: ["#EF4444", "#F59E0B", "#10B981", "#06B6D4", "#8B5CF6"],
    lineWidths: [2, 4, 8],
    fillOpacities: [0, 0.15, 0.5],
    fontSizes: [18, 28, 42],
    dashGaps: {solid: 6, dashed: 6, dotted: 6, dashdot: 6},
};

function sameNumbers(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < 1e-6);
}

export const DEFAULT_CURRENT: CurrentStyle = {
    color: DEFAULT_PRESETS.colors[0],
    lineWidth: 4,
    fillOpacity: 0,
    fillColor: DEFAULT_PRESETS.colors[0],
    fontSize: 28,
    lineDash: "solid",
    lineDashGap: 6,
    arrowStyle: "classic",
    arrowRounded: true,
    lineRound: true,
    numberFormat: DEFAULT_NUMBER_FORMAT,
    numberTip: DEFAULT_NUMBER_TIP,
    numberArrowStyle: "classic",
    spotlightOpacity: 0.6,
    spotlightShape: "rect",
    spotlightColor: "black",
    magnifierZoom: 2,
    magnifierShape: "ellipse",
    cornerRadius: 0,
    highlightMode: "brush",
    smartSelect: false,
    textStrokeEnabled: true,
    textStrokeColor: "#FFFFFF",
    textStrokeWidth: 2,
};

const STORAGE_KEY = "siyuan-plugin-annotate:presets";
const CURRENT_KEY = "siyuan-plugin-annotate:current";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function numbers(input: unknown, fallback: number[], min: number, max: number, scale = 1): number[] {
    if (!Array.isArray(input)) return [...fallback];
    const result = input
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
        .map((v) => clamp(v * scale, min, max));
    return result.length >= 2 && result.length <= 6 ? result : [...fallback];
}

function dashGaps(input: unknown): Record<LineDashKey, number> {
    const base = {...DEFAULT_PRESETS.dashGaps};
    if (!input || typeof input !== "object") return base;
    for (const key of ["solid", "dashed", "dotted", "dashdot"] as LineDashKey[]) {
        const value = Number((input as Record<string, unknown>)[key]);
        if (Number.isFinite(value)) base[key] = clamp(Math.round(value), 1, 20);
    }
    return base;
}

function colors(input: unknown, fallback: string[]): string[] {
    if (!Array.isArray(input)) return [...fallback];
    const result = input
        .map((v) => String(v).trim())
        .filter((v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v));
    return result.length >= 2 && result.length <= 8 ? result : [...fallback];
}

export function loadPresets(): StylePresets {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return structuredCloneSafe(DEFAULT_PRESETS);
        const parsed = JSON.parse(raw) as Partial<StylePresets>;
        const loaded: StylePresets = {
            colors: colors(parsed.colors, DEFAULT_PRESETS.colors),
            lineWidths: numbers(parsed.lineWidths, DEFAULT_PRESETS.lineWidths, 1, 40),
            // 设置界面用 0~100 的百分比填写，落盘统一存 0~1
            fillOpacities: numbers(parsed.fillOpacities, DEFAULT_PRESETS.fillOpacities, 0, 1),
            fontSizes: numbers(parsed.fontSizes, DEFAULT_PRESETS.fontSizes, 8, 120),
            dashGaps: dashGaps(parsed.dashGaps),
        };
        // 从没改过预设的老用户：升级成新的四档，否则永远看不到新加的那一档
        if (sameNumbers(loaded.lineWidths, LEGACY_DEFAULT_PRESETS.lineWidths)) {
            loaded.lineWidths = [...DEFAULT_PRESETS.lineWidths];
        }
        if (sameNumbers(loaded.fillOpacities, LEGACY_DEFAULT_PRESETS.fillOpacities)) {
            loaded.fillOpacities = [...DEFAULT_PRESETS.fillOpacities];
        }
        if (sameNumbers(loaded.fontSizes, LEGACY_DEFAULT_PRESETS.fontSizes)) {
            loaded.fontSizes = [...DEFAULT_PRESETS.fontSizes];
        }
        return loaded;
    } catch {
        return structuredCloneSafe(DEFAULT_PRESETS);
    }
}

export function savePresets(presets: StylePresets): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
    } catch {
        // 隐私模式下忽略，本次会话内仍生效
    }
}

/**
 * 打开编辑器时该用哪套「当前样式」。
 *
 * 以前每次打开都写死成预设的第一项（第一个颜色、第二档线宽……），用户在工具栏上
 * 点过的颜色 / 线宽 / 填充 / 字号下一次就没了。现在把最后一次的点选记下来，
 * 下次打开接着用；只有没记录过时才回到预设默认。
 */
export function loadCurrentStyle(presets: StylePresets): CurrentStyle {
    const base: CurrentStyle = {
        ...DEFAULT_CURRENT,
        color: presets.colors[0] ?? DEFAULT_CURRENT.color,
        lineWidth: presets.lineWidths[1] ?? presets.lineWidths[0] ?? DEFAULT_CURRENT.lineWidth,
        fillOpacity: presets.fillOpacities[0] ?? DEFAULT_CURRENT.fillOpacity,
        fontSize: presets.fontSizes[1] ?? presets.fontSizes[0] ?? DEFAULT_CURRENT.fontSize,
    };
    try {
        const raw = localStorage.getItem(CURRENT_KEY);
        if (!raw) return base;
        const parsed = JSON.parse(raw) as Partial<CurrentStyle>;
        const color = typeof parsed.color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(parsed.color.trim())
            ? parsed.color.trim().toUpperCase()
            : base.color;
        const number = (value: unknown, fallback: number, min: number, max: number): number => {
            const n = Number(value);
            return Number.isFinite(n) ? clamp(n, min, max) : fallback;
        };
        const strokeColor = typeof parsed.textStrokeColor === "string" &&
            /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(parsed.textStrokeColor.trim())
            ? parsed.textStrokeColor.trim().toUpperCase()
            : base.textStrokeColor;
        const dash = parsed.lineDash;
        return {
            color,
            lineWidth: number(parsed.lineWidth, base.lineWidth, 1, 40),
            fillOpacity: number(parsed.fillOpacity, base.fillOpacity, 0, 1),
            fillColor: typeof parsed.fillColor === "string" &&
                /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(parsed.fillColor.trim())
                ? parsed.fillColor.trim().toUpperCase()
                : base.fillColor,
            fontSize: number(parsed.fontSize, base.fontSize, 8, 120),
            lineDash: dash === "dashed" || dash === "dotted" || dash === "dashdot"
                ? dash : base.lineDash,
            lineDashGap: number(parsed.lineDashGap, base.lineDashGap, 1, 20),
            arrowStyle: normalizeArrowStyle(parsed.arrowStyle, base.arrowStyle),
            arrowRounded: parsed.arrowRounded !== false,
            lineRound: parsed.lineRound !== false,
            numberFormat: normalizeNumberFormat(parsed.numberFormat, base.numberFormat),
            numberTip: normalizeNumberTip(parsed.numberTip, base.numberTip),
            numberArrowStyle: normalizeArrowStyle(parsed.numberArrowStyle, base.numberArrowStyle),
            spotlightOpacity: number(parsed.spotlightOpacity, base.spotlightOpacity, 0, 0.95),
            spotlightShape: parsed.spotlightShape === "ellipse" || parsed.spotlightShape === "rect"
                ? parsed.spotlightShape : base.spotlightShape,
            spotlightColor: parsed.spotlightColor === "white" || parsed.spotlightColor === "black"
                ? parsed.spotlightColor : base.spotlightColor,
            magnifierZoom: number(parsed.magnifierZoom, base.magnifierZoom, 1.2, 6),
            magnifierShape: parsed.magnifierShape === "rect" || parsed.magnifierShape === "ellipse"
                ? parsed.magnifierShape : base.magnifierShape,
            cornerRadius: number(parsed.cornerRadius, base.cornerRadius, 0, 80),
            highlightMode: parsed.highlightMode === "rect" ? "rect" : base.highlightMode,
            // 选区识别是「一次性动作」：每次打开编辑器都从关闭开始，
            // 免得出现「按钮亮着、但画面里没有框」的困惑
            smartSelect: false,
            textStrokeEnabled: parsed.textStrokeEnabled !== false,
            textStrokeColor: strokeColor,
            textStrokeWidth: number(parsed.textStrokeWidth, base.textStrokeWidth, 0, 10),
        };
    } catch {
        return base;
    }
}

/** 记住这次点选的颜色 / 线宽 / 填充 / 字号，下次打开继续用 */
export function saveCurrentStyle(style: CurrentStyle): void {
    try {
        localStorage.setItem(CURRENT_KEY, JSON.stringify({
            color: style.color,
            lineWidth: style.lineWidth,
            fillOpacity: style.fillOpacity,
            fillColor: style.fillColor,
            fontSize: style.fontSize,
            lineDash: style.lineDash,
            lineDashGap: style.lineDashGap,
            arrowStyle: style.arrowStyle,
            arrowRounded: style.arrowRounded,
            lineRound: style.lineRound,
            numberFormat: style.numberFormat,
            numberTip: style.numberTip,
            numberArrowStyle: style.numberArrowStyle,
            spotlightOpacity: style.spotlightOpacity,
            spotlightShape: style.spotlightShape,
            spotlightColor: style.spotlightColor,
            magnifierZoom: style.magnifierZoom,
            magnifierShape: style.magnifierShape,
            cornerRadius: style.cornerRadius,
            highlightMode: style.highlightMode,
            smartSelect: style.smartSelect,
            textStrokeEnabled: style.textStrokeEnabled,
            textStrokeColor: style.textStrokeColor,
            textStrokeWidth: style.textStrokeWidth,
        }));
    } catch {
        // 隐私模式下忽略
    }
}

/** 规范化颜色写法：接受 RRGGBB / #RRGGBB / #RGB，非法返回 null（选色器只认 6 位） */
export function normalizeHex(value: string): string | null {
    const raw = String(value || "").trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(raw)) {
        return `#${raw.split("").map((c) => c + c).join("").toUpperCase()}`;
    }
    if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toUpperCase()}`;
    return null;
}

function structuredCloneSafe(presets: StylePresets): StylePresets {
    return {
        colors: [...presets.colors],
        lineWidths: [...presets.lineWidths],
        fillOpacities: [...presets.fillOpacities],
        fontSizes: [...presets.fontSizes],
        dashGaps: {...presets.dashGaps},
    };
}

/** 深拷贝一份预设：进入「自定义预设」时拍快照，取消要一字不差地还回去 */
export function clonePresets(presets: StylePresets): StylePresets {
    return structuredCloneSafe(presets);
}
