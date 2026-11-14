/**
 * 序号引线的末端样式。
 *
 * 只做三种：箭头 / 圆点 / 方点——用户明确不要双头箭头与两端竖线，
 * 索引号是「指向某处」的标记，两端都有东西反而看不清指哪儿。
 */

export type NumberTipKey = "arrow" | "dot" | "square";

export interface NumberTipOption {
    key: NumberTipKey;
    label: string;
    hint: string;
}

export const NUMBER_TIPS: NumberTipOption[] = [
    {key: "arrow", label: "箭头", hint: "与普通箭头工具同一种箭头，可开关圆线"},
    {key: "dot", label: "圆点", hint: "引线末端一个圆点"},
    {key: "square", label: "方点", hint: "引线末端一个方点"},
];

export const DEFAULT_NUMBER_TIP: NumberTipKey = "arrow";

export function normalizeNumberTip(raw: unknown, fallback: NumberTipKey = DEFAULT_NUMBER_TIP): NumberTipKey {
    const key = String(raw ?? "");
    return NUMBER_TIPS.some((item) => item.key === key) ? key as NumberTipKey : fallback;
}
