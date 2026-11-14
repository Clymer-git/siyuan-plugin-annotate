/**
 * 序号（编号）的显示格式。
 *
 * 数据里存的永远是「第几个」（AnnotObject.geometry.number，由 reindexNumbers 统一重排），
 * 显示时才按格式翻译成 1 / I / a / A / 一。这样换格式只是换显示，
 * 增删对象后编号仍然连续，不会出现「罗马数字跳号」这类问题。
 */

export type NumberFormatKey = "arabic" | "roman" | "alphaLower" | "alphaUpper" | "chinese";

export interface NumberFormatOption {
    key: NumberFormatKey;
    /** 下拉按钮与菜单里那个「样子」小标 */
    chip: string;
    /** 短名：下拉按钮上显示这一项（太长会把悬浮条撑宽） */
    short: string;
    label: string;
}

/** 顺序即悬浮条上的显示顺序 */
export const NUMBER_FORMATS: NumberFormatOption[] = [
    {key: "arabic", chip: "1", short: "阿拉伯数字", label: "阿拉伯数字（1, 2, 3）"},
    {key: "roman", chip: "I", short: "罗马数字", label: "罗马数字（I, II, III）"},
    {key: "alphaLower", chip: "a", short: "小写字母", label: "小写字母（a, b, c）"},
    {key: "alphaUpper", chip: "A", short: "大写字母", label: "大写字母（A, B, C）"},
    {key: "chinese", chip: "一", short: "中文数字", label: "中文数字（一, 二, 三）"},
];

export const DEFAULT_NUMBER_FORMAT: NumberFormatKey = "arabic";

export function normalizeNumberFormat(raw: unknown, fallback: NumberFormatKey = DEFAULT_NUMBER_FORMAT): NumberFormatKey {
    const key = String(raw ?? "");
    return NUMBER_FORMATS.some((item) => item.key === key) ? key as NumberFormatKey : fallback;
}

const ROMAN_TABLE: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

const CN_DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function toRoman(value: number): string {
    if (value < 1 || value > 3999) return String(value);
    let rest = value;
    let out = "";
    for (const [num, symbol] of ROMAN_TABLE) {
        while (rest >= num) {
            out += symbol;
            rest -= num;
        }
    }
    return out;
}

/** 1→a、26→z、27→aa（与表格软件一致，超过 26 个也不至于跳回数字） */
function toAlpha(value: number, upper: boolean): string {
    if (value < 1) return String(value);
    let rest = value;
    let out = "";
    while (rest > 0) {
        const index = (rest - 1) % 26;
        out = String.fromCharCode((upper ? 65 : 97) + index) + out;
        rest = Math.floor((rest - 1) / 26);
    }
    return out;
}

/** 1~99 的中文数字；超过 99 直接退回阿拉伯数字，避免「一百零三」写得一塌糊涂 */
function toChinese(value: number): string {
    if (value < 0 || value > 99) return String(value);
    if (value < 10) return CN_DIGITS[value];
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    const head = tens === 1 ? "十" : `${CN_DIGITS[tens]}十`;
    return ones === 0 ? head : `${head}${CN_DIGITS[ones]}`;
}

export function formatNumber(value: number, format: NumberFormatKey = DEFAULT_NUMBER_FORMAT): string {
    const n = Math.max(1, Math.round(Number(value) || 1));
    switch (format) {
        case "roman": return toRoman(n);
        case "alphaLower": return toAlpha(n, false);
        case "alphaUpper": return toAlpha(n, true);
        case "chinese": return toChinese(n);
        default: return String(n);
    }
}

/**
 * 圆点里放多字符（XII、aa、二十一）时把字号收一点，避免溢出圆的边界。
 * 单字符保持原字号；越长的越收，但有下限。
 */
export function numberTextScale(text: string): number {
    const length = Math.max(1, Array.from(text).length);
    if (length <= 1) return 1;
    return Math.max(0.42, 1.55 / length);
}
