/**
 * 扩展画布面板的状态与持久化。
 *
 * 需求要点（用户口径）：
 * - 扩展方向可选：单方向、两个方向、三个方向，或点中间的「四周同步」一键全选；
 * - **只有选中的方向对应的输入框能输入**，没选中的一律锁死（淡灰、不能点）；
 * - 未连接时选中的方向各填各的数值；点锁链后，「活动」的那些输入框共用一个数值，
 *   且只有第一个选中的方向可以输入，其余锁死；
 * - 扩出来的区域可以保持透明，也可以铺底色（白 / 黑 / 两个自定义色，其中一个用吸管从图上吸）。
 *
 * 这里只管状态与派生值，界面与画面改动留在编辑器里做。
 */

import type {ExtendMargins} from "./canvas";

export type ExtendDir = "top" | "right" | "bottom" | "left";
export type ExtendSlot = "transparent" | "white" | "black" | "custom1" | "custom2";

export const EXTEND_DIRS: ExtendDir[] = ["top", "right", "bottom", "left"];

export interface ExtendState {
    dirs: Record<ExtendDir, boolean>;
    /** 锁链：打开后四个方向共用一个数值，只有第一个框能输入 */
    link: boolean;
    /** 连接时使用的统一数值（由上方的输入框写入） */
    margin: number;
    /** 未连接时每个方向各自的数值 */
    sides: Record<ExtendDir, number>;
    /** 当前选中的底色槽位 */
    slot: ExtendSlot;
    /** 自定义色（取色器） */
    custom1: string;
    /** 自定义色（吸管） */
    custom2: string;
}

export const DEFAULT_EXTEND: ExtendState = {
    dirs: {top: true, right: true, bottom: true, left: true},
    link: true,
    margin: 60,
    sides: {top: 60, right: 60, bottom: 60, left: 60},
    slot: "transparent",
    custom1: "#F5F5F5",
    custom2: "#9CA3AF",
};

const STORAGE_KEY = "siyuan-plugin-annotate:extend";
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function clampSize(value: unknown, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.min(2000, Math.round(n)));
}

function clampColor(value: unknown, fallback: string): string {
    return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toUpperCase() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

export function loadExtendState(): ExtendState {
    const base: ExtendState = {
        ...DEFAULT_EXTEND,
        dirs: {...DEFAULT_EXTEND.dirs},
        sides: {...DEFAULT_EXTEND.sides},
    };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return base;
        const parsed = JSON.parse(raw) as Partial<ExtendState>;
        const dirs = (parsed.dirs ?? {}) as Partial<Record<ExtendDir, boolean>>;
        const sides = (parsed.sides ?? {}) as Partial<Record<ExtendDir, number>>;
        return {
            dirs: {
                top: bool(dirs.top, base.dirs.top),
                right: bool(dirs.right, base.dirs.right),
                bottom: bool(dirs.bottom, base.dirs.bottom),
                left: bool(dirs.left, base.dirs.left),
            },
            link: bool(parsed.link, base.link),
            margin: clampSize(parsed.margin, base.margin),
            sides: {
                top: clampSize(sides.top, base.sides.top),
                right: clampSize(sides.right, base.sides.right),
                bottom: clampSize(sides.bottom, base.sides.bottom),
                left: clampSize(sides.left, base.sides.left),
            },
            slot: (["transparent", "white", "black", "custom1", "custom2"] as ExtendSlot[])
                .includes(parsed.slot as ExtendSlot) ? parsed.slot as ExtendSlot : base.slot,
            custom1: clampColor(parsed.custom1, base.custom1),
            custom2: clampColor(parsed.custom2, base.custom2),
        };
    } catch {
        return base;
    }
}

export function saveExtendState(state: ExtendState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // 隐私模式下忽略，本次会话内仍生效
    }
}

/** 当前槽位对应的底色；null 表示透明 */
export function backgroundForState(state: ExtendState): string | null {
    switch (state.slot) {
        case "white": return "#FFFFFF";
        case "black": return "#000000";
        case "custom1": return state.custom1;
        case "custom2": return state.custom2;
        default: return null;
    }
}

/** 当前槽位对应的展示色（透明用 null，界面自己画斜纹） */
export function slotColorForState(state: ExtendState, slot: ExtendSlot): string | null {
    if (slot === "white") return "#FFFFFF";
    if (slot === "black") return "#000000";
    if (slot === "custom1") return state.custom1;
    if (slot === "custom2") return state.custom2;
    return null;
}

/** 按方向算出真正的扩展量（未选中的方向为 0；连接时用统一数值，否则各用各的） */
export function marginsForState(state: ExtendState): ExtendMargins {
    const value = (dir: ExtendDir): number => {
        if (!state.dirs[dir]) return 0;
        return state.link ? state.margin : state.sides[dir];
    };
    return {top: value("top"), right: value("right"), bottom: value("bottom"), left: value("left")};
}

export function hasAnyDirection(state: ExtendState): boolean {
    return EXTEND_DIRS.some((dir) => state.dirs[dir]);
}

/** 各方向是否全都勾上（用于「四周」按钮的高亮） */
export function allDirectionsOn(state: ExtendState): boolean {
    return EXTEND_DIRS.every((dir) => state.dirs[dir]);
}

/** 当前选中的第一个方向（连接状态下只有它能输入，数值也从它这里来） */
export function firstActiveDir(state: ExtendState): ExtendDir | null {
    return EXTEND_DIRS.find((dir) => state.dirs[dir]) ?? null;
}

/**
 * 某个方向的输入框能不能输入。
 * - 没选这个方向 → 不能输入（用户口径：只选了上，其余框就锁死）；
 * - 连接状态下 → 只有第一个选中的方向能输入，其余锁死并共用它的数值。
 */
export function isDirEditable(state: ExtendState, dir: ExtendDir): boolean {
    if (!state.dirs[dir]) return false;
    return state.link ? firstActiveDir(state) === dir : true;
}

/** 连接状态下显示的数值（未连接时用各方向自己的数值） */
export function valueForDir(state: ExtendState, dir: ExtendDir): number {
    return state.link && state.dirs[dir] ? state.margin : state.sides[dir];
}
