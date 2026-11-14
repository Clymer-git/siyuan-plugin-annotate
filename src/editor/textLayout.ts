/**
 * 文字排版：自动换行 + 逐字位置。
 *
 * 为什么要自己算而不是交给 SVG：文字的换行位置决定了「一行有多宽、一共几行」，
 * 包围盒、手柄、点击命中、逐字配色、导出到 PNG 全都依赖这几个数字。
 * 交给浏览器就没有确定的数字可用；自己按字宽累加，才能保证
 * 「编辑时看到的行数」和「保存出来的行数」完全一致。
 *
 * 宽度规则和以前保持同一套（见 charWidthRatio）：全角 / CJK 算 1 个字宽，
 * 其余算 0.6 —— 这套估算已经和思源里的实际渲染对齐过。
 */

import type {AnnotObject, TextGeometry} from "../types";

/** 行高（相对字号）：排版、输入框、SVG 三处必须一致 */
export const TEXT_LINE_HEIGHT = 1.25;

/** 文字右边留一点余量，避免估算误差把最后一个字挤出画布 */
export const TEXT_RIGHT_PADDING = 8;

/**
 * 单个字符的相对宽度：全角/CJK 算 1 个字宽，其余 0.6。
 * 以前只把 \u3400-\u9fff 当全角，导致「【】、，！？」这类全角标点被算窄，
 * 文字包围盒比实际渲染窄一截 —— 点文字右端会落到框外，单击编辑也就失灵了。
 */
export function charWidthRatio(char: string): number {
    return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char)
        ? 1
        : 0.6;
}

/** 按同一套字宽规则量一段文字的宽度 */
export function measureText(text: string, fontSize: number): number {
    let width = 0;
    for (const char of Array.from(text || "")) {
        width += charWidthRatio(char) * fontSize;
    }
    return width;
}

export interface TextLine {
    /** 这一行的文字（不含换行符） */
    text: string;
    /** 这一行的宽度 */
    width: number;
    /** 这一行第一个字在整段文字里的下标（用来算光标落点） */
    start: number;
}

/**
 * 把一段文字按可用宽度折成若干行。
 *
 * - 显式换行符先断行；
 * - 中文可以逐字断；
 * - 西文尽量在空格处断，避免把一个单词劈成两半；
 * - 宽度按 fontSize 算，maxWidth 传 Infinity 就是「不换行」。
 */
export function layoutText(text: string, fontSize: number, maxWidth: number): TextLine[] {
    const raw = String(text ?? "");
    const size = Math.max(1, fontSize || 1);
    const limit = Number.isFinite(maxWidth) && maxWidth > size * 0.6 ? maxWidth : Infinity;
    const lines: TextLine[] = [];

    let current = "";
    let width = 0;
    let start = 0;
    const flush = (): void => {
        lines.push({text: current, width, start});
    };

    for (let i = 0; i < raw.length; i += 1) {
        const char = raw[i];
        if (char === "\n") {
            flush();
            start = i + 1;
            current = "";
            width = 0;
            continue;
        }
        const charWidth = charWidthRatio(char) * size;
        if (current && width + charWidth > limit) {
            // 行尾刚好是空格：去掉空格再断，免得下一行以空格开头
            if (current.endsWith(" ")) {
                const kept = current.replace(/ +$/, "");
                current = kept;
                width = measureText(kept, size);
            }
            flush();
            start = i;
            current = char;
            width = charWidth;
            continue;
        }
        current += char;
        width += charWidth;
    }
    flush();

    // 空字符串也要有一行，否则包围盒高度是 0，点都点不中
    if (!lines.length) lines.push({text: "", width: 0, start: 0});
    return lines;
}

export interface TextBlock {
    lines: TextLine[];
    width: number;
    height: number;
}

/** 一段文字在给定可用宽度下占多大 */
export function textBlockSize(text: string, fontSize: number, maxWidth: number): TextBlock {
    const size = Math.max(1, fontSize || 1);
    const lines = layoutText(text, size, maxWidth);
    let width = 0;
    for (const line of lines) width = Math.max(width, line.width);
    return {
        lines,
        width: Math.max(size * 2, width),
        height: lines.length * size * TEXT_LINE_HEIGHT,
    };
}

/** 某个文字对象当前可用的折行宽度（右边贴着画布边缘） */
export function wrapWidthOf(geometry: TextGeometry, canvasWidth: number): number {
    const edge = canvasWidth > 0 ? canvasWidth : geometry.x + (geometry.width ?? 0);
    return Math.max(geometry.fontSize * 2, edge - geometry.x - TEXT_RIGHT_PADDING);
}

/**
 * 重算每个文字对象的折行宽度。
 *
 * 文字对象的宽度不是"设置"出来的，而是"剩下多少地方"——所以每次位置、
 * 字号或画布尺寸变化后都要重算一遍。渲染前统一跑一次，拖动过程中
 * 就能看到行数随位置实时变化。
 */
export function reflowTextObjects(objects: AnnotObject[], canvasWidth: number): void {
    if (!(canvasWidth > 0)) return;
    for (const object of objects) {
        if (object.type !== "text") continue;
        const geometry = object.geometry as TextGeometry;
        // 左边越界时先拉回来：文字不能跑到画布外面去
        if (geometry.x < 0) geometry.x = 0;
        if (geometry.x > canvasWidth - geometry.fontSize) {
            geometry.x = Math.max(0, canvasWidth - geometry.fontSize);
        }
        geometry.width = wrapWidthOf(geometry, canvasWidth);
    }
}
