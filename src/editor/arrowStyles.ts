/**
 * 箭头属性的单一来源。
 *
 * 1.3.0 起拆成两个维度，用户各选各的：
 *   - 类型（ArrowType）：单头 / 双头 / 尖尾 / 两端竖线 —— 决定整体的分布与形态
 *   - 端点（ArrowHead）：基础 / 燕尾 / 开放 / 菱形 / 圆形 / 无 —— 决定两端画成什么样
 *
 * 样式列表跟着类型走，这是用户明确定死的：
 *   - 单头 / 双头：基础、燕尾、开放、菱形、圆形
 *   - 尖尾：基础、燕尾（楔形杆本身已经很重，再叠开放/菱形/圆形会糊）
 *   - 两端竖线：无箭头（固定第一）、基础、燕尾
 *
 * 旧数据只有 arrowStyle 一个字段（7 种扁平样式），这里保留映射，
 * 保证升级后老图里的箭头不变形。
 */

import type {ArrowHead, ArrowKind, ArrowStyleKey, ArrowType} from "../types";

export interface ArrowOption<T> {
    key: T;
    label: string;
    hint: string;
}

/** 类型下拉（顺序即用户要求的顺序） */
export const ARROW_TYPES: ArrowOption<ArrowType>[] = [
    {key: "single", label: "单头", hint: "直线，终点一个箭头"},
    {key: "double", label: "双头", hint: "直线，两端各一个箭头"},
    {key: "modern", label: "尖尾", hint: "杆从尾部尖楔张开到头部，尾细头粗"},
    {key: "bar", label: "两端竖线", hint: "两端各一道竖线，可再加箭头"},
];

const HEAD_BASIC: ArrowOption<ArrowHead> = {key: "basic", label: "基础", hint: "实心三角"};
const HEAD_CLASSIC: ArrowOption<ArrowHead> = {key: "classic", label: "燕尾", hint: "尾部带燕尾弧的三角"};
const HEAD_OPEN: ArrowOption<ArrowHead> = {key: "open", label: "开放", hint: "开口的 V 形，不填充"};
const HEAD_RHOMBUS: ArrowOption<ArrowHead> = {key: "rhombus", label: "菱形", hint: "实心菱形"};
const HEAD_CIRCLE: ArrowOption<ArrowHead> = {key: "circle", label: "圆形", hint: "实心圆形"};
const HEAD_NONE: ArrowOption<ArrowHead> = {key: "none", label: "无箭头", hint: "只剩一条连接线"};

/**
 * 端点样式的固定顺序（横向平铺，不随类型增减）。
 * 不合法的那几个不隐藏，只置灰 —— 用户要能看见「有这些样式，但此刻用不了」。
 */
export const ARROW_HEADS: ArrowOption<ArrowHead>[] = [
    HEAD_NONE, HEAD_BASIC, HEAD_CLASSIC, HEAD_OPEN, HEAD_RHOMBUS, HEAD_CIRCLE,
];

/** 某个类型下这个端点能不能用 */
export function headEnabled(type: ArrowType, head: ArrowHead): boolean {
    // 两端竖线也能配开放箭头（尺寸线常用这种「竖线 + V 头」的工程画法）
    if (type === "bar") return head === "none" || head === "basic" || head === "classic" || head === "open";
    if (type === "modern") return head === "basic" || head === "classic";
    return head !== "none";
}

/** 当前类型下可用的端点（过滤掉置灰的） */
export function headsForType(type: ArrowType): ArrowOption<ArrowHead>[] {
    return ARROW_HEADS.filter((item) => headEnabled(type, item.key));
}

export function normalizeArrowType(raw: unknown, fallback: ArrowType = "single"): ArrowType {
    const key = String(raw ?? "");
    return ARROW_TYPES.some((item) => item.key === key) ? key as ArrowType : fallback;
}

export function normalizeArrowHead(raw: unknown, fallback: ArrowHead = "classic"): ArrowHead {
    const key = String(raw ?? "");
    return ARROW_HEADS.some((item) => item.key === key) ? key as ArrowHead : fallback;
}

/** 旧箭头键（含更早版本的别名）→ 新模型 */
const LEGACY_KINDS: Record<string, ArrowKind> = {
    classic: {type: "single", head: "classic"},
    modern: {type: "modern", head: "basic"},
    double: {type: "double", head: "classic"},
    basic: {type: "single", head: "basic"},
    line: {type: "single", head: "open"},
    bar: {type: "bar", head: "none"},
    barDouble: {type: "bar", head: "basic"},
    // 1.0 之前存过的别名
    single: {type: "single", head: "classic"},
    gradient: {type: "modern", head: "basic"},
    outline: {type: "single", head: "open"},
};

export const ARROW_STYLE_KEYS: ArrowStyleKey[] = [
    "classic", "modern", "double", "basic", "line", "bar", "barDouble",
];

/** 旧的扁平样式键（序号引线等地方还在用），保留原语义 */
export function normalizeArrowStyle(raw: unknown, fallback: ArrowStyleKey = "classic"): ArrowStyleKey {
    const key = String(raw ?? "");
    if (ARROW_STYLE_KEYS.includes(key as ArrowStyleKey)) return key as ArrowStyleKey;
    return LEGACY_KINDS[key] ? legacyOf(LEGACY_KINDS[key]) : fallback;
}

/**
 * 从对象样式解出「类型 + 端点」。
 * 新字段优先；只有旧字段时按映射表还原；都没有就给默认（单头 + 燕尾）。
 */
export function resolveArrowKind(style?: {
    arrowType?: ArrowType;
    arrowHead?: ArrowHead;
    arrowStyle?: ArrowStyleKey;
} | null): ArrowKind {
    if (style?.arrowType) {
        const type = normalizeArrowType(style.arrowType);
        const requested = style.arrowHead as ArrowHead;
        const head = headEnabled(type, requested)
            ? requested
            // 类型换了之后原样式不可用（比如尖尾下不能有开放）：退到最接近的一个
            : (type === "bar" ? "none" : "classic");
        return {type, head};
    }
    const legacy = String(style?.arrowStyle ?? "");
    return LEGACY_KINDS[legacy] ? {...LEGACY_KINDS[legacy]} : {type: "single", head: "classic"};
}

/** 新模型 → 最接近的旧样式键（写回 arrowStyle，便于降级到旧版插件） */
export function legacyOf(kind: ArrowKind): ArrowStyleKey {
    if (kind.type === "bar") return kind.head === "none" ? "bar" : "barDouble";
    if (kind.type === "double") return "double";
    if (kind.type === "modern") return "modern";
    switch (kind.head) {
        case "basic": return "basic";
        case "open": return "line";
        default: return "classic";
    }
}

/** 类型切走之后，原来的端点还合不合法；不合法就给这个类型的默认值 */
export function headAfterTypeChange(type: ArrowType, current: ArrowHead): ArrowHead {
    if (headEnabled(type, current)) return current;
    return type === "bar" ? "none" : "classic";
}

/**
 * 序号引线只能是一根单头箭头，所以只需要端点。
 * 老数据存的是扁平键（classic / modern / line / bar…），这里还原成端点；
 * 「无」「竖线」对引线没有意义，一律退回燕尾。
 */
export function numberHeadOf(style: {
    numberArrowHead?: ArrowHead;
    numberArrowStyle?: ArrowStyleKey;
    numberTip?: string;
} | null | undefined): ArrowHead {
    if (style?.numberArrowHead) return normalizeArrowHead(style.numberArrowHead);
    // 旧版还有「端点」三选一：圆点 / 方点直接就是圆形 / 菱形端点
    const tip = String(style?.numberTip ?? "");
    if (tip === "dot") return "circle";
    if (tip === "square") return "rhombus";
    const legacy = String(style?.numberArrowStyle ?? "");
    const kind = LEGACY_KINDS[legacy];
    if (!kind || kind.head === "none") return "classic";
    return kind.head;
}

/** 端点 → 旧扁平键（写回 numberArrowStyle，降级用） */
export function legacyOfNumberHead(head: ArrowHead): ArrowStyleKey {
    switch (head) {
        case "basic": return "basic";
        case "open": return "line";
        default: return "classic";
    }
}
