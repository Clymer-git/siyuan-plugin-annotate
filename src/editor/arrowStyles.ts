/**
 * 箭头样式的单一来源：ShareX 的 Classic / Modern / Double / Basic / Line，
 * 再加上用户要求保留的「两端竖线」与「两端竖线加双箭头」两种连接线。
 *
 * 旧版本保存过 single / gradient / outline，这里统一映射到最接近的新样式，
 * 以免升级后旧图里的箭头消失。
 */

import type {ArrowStyleKey} from "../types";

export const ARROW_STYLE_KEYS: ArrowStyleKey[] = [
    "classic", "modern", "double", "basic", "line", "bar", "barDouble",
];

const LEGACY_MAP: Record<string, ArrowStyleKey> = {
    single: "classic",
    gradient: "classic",
    outline: "line",
};

export function normalizeArrowStyle(raw: unknown, fallback: ArrowStyleKey = "classic"): ArrowStyleKey {
    const key = String(raw ?? "");
    if (ARROW_STYLE_KEYS.includes(key as ArrowStyleKey)) return key as ArrowStyleKey;
    if (LEGACY_MAP[key]) return LEGACY_MAP[key];
    return fallback;
}
