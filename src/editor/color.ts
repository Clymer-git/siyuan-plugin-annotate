/**
 * 色彩策略。
 * 色值与对比度算法参照 Anot8 的 src/constants/colors.ts（实读）：
 * 5 个高对比预设 + 任意十六进制取色 + 按 WCAG 相对亮度自动选黑/白徽章文字。
 * Anot8 的取色器只存在于 spec/Agent 输入层，本插件按要求补上可视化控件。
 */

export interface ColorPreset {
    key: string;
    name: string;
    hex: string;
}

export const COLOR_PRESETS: ColorPreset[] = [
    {key: "red", name: "红", hex: "#EF4444"},
    {key: "amber", name: "琥珀", hex: "#F59E0B"},
    {key: "green", name: "绿", hex: "#10B981"},
    {key: "cyan", name: "青", hex: "#06B6D4"},
    {key: "purple", name: "紫", hex: "#8B5CF6"},
];

export const DEFAULT_COLOR = COLOR_PRESETS[0].hex;
const DARK_TEXT = "#1E293B";
const LIGHT_TEXT = "#FFFFFF";

function expandHex(hex: string): string {
    const clean = hex.replace(/^#/, "");
    const full = clean.length === 3
        ? clean.split("").map((c) => c + c).join("")
        : clean;
    return `#${full.toUpperCase()}`;
}

function relativeLuminance(hex: string): number {
    const channel = (offset: number) => {
        const value = parseInt(hex.substring(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** 选择与背景对比度更高的文字颜色，保证序号徽章数字清晰可读 */
export function pickBadgeTextColor(hex: string): string {
    try {
        const bg = relativeLuminance(expandHex(hex));
        const dark = relativeLuminance(DARK_TEXT);
        const contrastWithWhite = 1.05 / (bg + 0.05);
        const contrastWithDark = (bg + 0.05) / (dark + 0.05);
        return contrastWithDark > contrastWithWhite ? DARK_TEXT : LIGHT_TEXT;
    } catch {
        return LIGHT_TEXT;
    }
}

/** 两个颜色的对比度（WCAG 比值）；算不出来时当作足够清楚 */
export function contrastRatio(a: string, b: string): number {
    try {
        const la = relativeLuminance(expandHex(a));
        const lb = relativeLuminance(expandHex(b));
        const hi = Math.max(la, lb);
        const lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    } catch {
        return 21;
    }
}

/**
 * 浅底序号（定位气泡 / 空心圆）的文字色：
 * 首选仍是主色（和以前一样），只有当主色与内部填充太接近时，才退回自动反差色。
 * 这样默认外观不变，切样式把底色带过来时也不会出现"红字红底"。
 */
export function readableInk(preferred: string, background: string | undefined): string {
    if (!background) return preferred;
    return contrastRatio(preferred, background) >= 3 ? preferred : pickBadgeTextColor(background);
}

/** 把颜色转成带透明度的 rgba，用于形状填充与半透明笔迹 */
export function withAlpha(hex: string, alpha: number): string {
    try {
        const value = expandHex(hex).slice(1);
        const r = parseInt(value.slice(0, 2), 16);
        const g = parseInt(value.slice(2, 4), 16);
        const b = parseInt(value.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
    } catch {
        return hex;
    }
}

export function normalizeHex(input: string): string | null {
    const value = input.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return expandHex(value);
    if (/^([0-9a-f]{6})$/i.test(value)) return `#${value.toUpperCase()}`;
    return null;
}
