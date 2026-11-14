/**
 * PC 工具栏「自定义颜色」圆球 + 颜色预设。
 *
 * 思路与移动端那颗自定义色点一致：取过色之后球面显示这个颜色，
 * 球心永远画一个十字，于是它和左边那一排固定色点一眼就能分开。
 * 还没取过色时球是白的，同样带十字，用来提示「这里可以取色」。
 *
 * 弹窗里的颜色预设可以保存 / 复用 / 删除 / 拖动排序，全部落在本地存储，
 * 下次打开编辑器还在（与其它预设一样存 localStorage，隐私模式下静默失败）。
 */

export interface ColorPresetState {
    /** 最近一次取到的自定义颜色；null = 还没取过色（球是白的） */
    custom: string | null;
    /** 用户保存的颜色预设，数组顺序就是显示顺序 */
    saved: string[];
}

/** 最多存 12 个：再多弹窗一屏放不下，也失去了「常用色」的意义 */
export const MAX_SAVED_COLORS = 12;

const STORAGE_KEY = "siyuan-plugin-annotate:colors";

export const EMPTY_COLOR_STATE: ColorPresetState = {custom: null, saved: []};

/** 只认 #RRGGBB（三位简写补全后同样接受），其余一律当作没设置 */
export function normalizeColorHex(value: unknown): string | null {
    const raw = String(value ?? "").trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(raw)) {
        return `#${raw.split("").map((c) => c + c).join("").toUpperCase()}`;
    }
    if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toUpperCase()}`;
    return null;
}

function sanitize(input: unknown): ColorPresetState {
    const parsed = (input ?? {}) as Partial<ColorPresetState>;
    const custom = normalizeColorHex(parsed.custom);
    const saved: string[] = [];
    if (Array.isArray(parsed.saved)) {
        for (const item of parsed.saved) {
            const hex = normalizeColorHex(item);
            // 去重时保留第一次出现的位置：用户拖出来的顺序不能因为读盘被打乱
            if (hex && !saved.includes(hex)) saved.push(hex);
            if (saved.length >= MAX_SAVED_COLORS) break;
        }
    }
    return {custom, saved};
}

export function loadColorPresets(): ColorPresetState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {custom: null, saved: []};
        return sanitize(JSON.parse(raw));
    } catch {
        return {custom: null, saved: []};
    }
}

export function saveColorPresets(state: ColorPresetState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(state)));
    } catch {
        // 隐私模式下忽略，本次会话内仍然生效
    }
}

/** 记下取到的颜色（同时就是按钮上的球面色） */
export function setCustomColor(state: ColorPresetState, value: string): ColorPresetState {
    const hex = normalizeColorHex(value);
    if (!hex) return state;
    return {custom: hex, saved: [...state.saved]};
}

/** 保存一个颜色预设：已经在列表里就保持原位置（不重复、不挪动） */
export function addSavedColor(state: ColorPresetState, value: string): ColorPresetState {
    const hex = normalizeColorHex(value);
    const saved = [...state.saved];
    if (!hex || saved.includes(hex) || saved.length >= MAX_SAVED_COLORS) {
        return {custom: state.custom, saved};
    }
    saved.push(hex);
    return {custom: state.custom, saved};
}

export function removeSavedColor(state: ColorPresetState, value: string): ColorPresetState {
    return {
        custom: state.custom,
        saved: state.saved.filter((item) => item !== normalizeColorHex(value)),
    };
}

/** 拖动排序：把 from 挪到 to 的位置（两者都会先夹到合法范围内） */
export function moveSavedColor(state: ColorPresetState, from: number, to: number): ColorPresetState {
    const saved = [...state.saved];
    if (!Number.isInteger(from) || !Number.isInteger(to)) return {custom: state.custom, saved};
    if (from < 0 || from >= saved.length) return {custom: state.custom, saved};
    const clamped = Math.max(0, Math.min(saved.length - 1, to));
    if (clamped === from) return {custom: state.custom, saved};
    const [hex] = saved.splice(from, 1);
    saved.splice(clamped, 0, hex);
    return {custom: state.custom, saved};
}
