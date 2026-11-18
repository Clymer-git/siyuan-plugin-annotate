import type {NumberBubble} from "../types";
import {fontStackOf} from "./fonts";

/**
 * 工具栏「序号样式」按钮上的缩略图。
 *
 * 这里跟画布渲染（editor/shapes.ts）**完全解耦**：只用最朴素的 SVG 图元自己画一张
 * 黑白灰小图，不调用 renderObject。这样以后调图标（配色、比例、尖头形状）都不会
 * 牵动画布上的真实标注 —— 之前正是因为改图标顺手改了画布渲染，把定位气泡改坏了。
 *
 * 配色约定（重要）：
 * - 一切颜色都走「变量对」，并且写在**内联 style** 里：
 *     球：style="fill:var(--annot-badge-disc, currentColor)"
 *     字：style="fill:var(--annot-badge-digit, var(--annot-panel, #fff))"
 *   按钮的选中态只需改这两个变量（见 index.css 的 .is-active 块），
 *   球和字永远同时被改写，不会再出现「球和数字一个颜色、数字看不见」。
 * - 不用 fill="..." 呈现属性：属性优先级最低，思源主题里任何一条
 *   `svg {...}` / `.protyle svg text {...}` 都能把它按掉，内联 style 才压得住。
 * - 尺寸只跟「样式」有关，跟画布上的字号 / 线宽 / 颜色无关，缓存一次就够。
 */

/** 图标里圆的半径（纯数字会大一号，否则一个小字看不出内容） */
const BASE_RADIUS = 9;
/** 图标线宽：跟工具栏其它 SVG 图标同一量级 */
const STROKE = 1.9;
/** 定位气泡的尖头长度（相对半径） */
const TIP_RATIO = 1.9;
/** 取景框留白 */
const PAD = 1.4;

/** 属性里的字体名可能带引号，拼进 HTML 前要转义 */
function esc(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * 尖头：从圆引两条切线到顶点，再沿圆周收回去。
 * 只覆盖圆外那一段，所以图标里的圆始终是完整的（不会有三角底边穿出来）。
 */
function tipPath(radius: number): string {
    const d = radius * TIP_RATIO;
    const theta = Math.acos(Math.min(1, radius / d));
    const cx = -radius * Math.sin(theta);
    const cy = radius * Math.cos(theta);
    const t1 = `${cx.toFixed(2)} ${cy.toFixed(2)}`;
    const t2 = `${(-cx).toFixed(2)} ${cy.toFixed(2)}`;
    return `M${t1}L0 ${d.toFixed(2)}L${t2}A${radius} ${radius} 0 0 1 ${t1}Z`;
}

/** 球 / 描边 / 尖头的颜色：默认跟按钮文字色，选中态由容器变量整体换掉 */
const DISC = "var(--annot-badge-disc, currentColor)";
/** 实心圆里数字的颜色：默认面板底色，选中态由容器变量整体换掉 */
const DIGIT_ON_DISC = "var(--annot-badge-digit, var(--annot-panel, #fff))";

function digit(radius: number, fill: string): string {
    // 颜色一律写进 style：呈现属性（fill="..."）优先级最低，
    // 思源主题里任何一条 svg 相关规则都能把它按掉，内联样式不会。
    return `<text class="annot-badge-digit" x="0" y="${(radius * 0.36).toFixed(2)}"`
        + ` font-size="${(radius * 1.05).toFixed(2)}" font-weight="700" text-anchor="middle"`
        + ` font-family="${esc(fontStackOf(undefined))}" style="fill:${fill}">1</text>`;
}

/** 生成一枚样式缩略图（返回完整 <svg> 字符串） */
export function numberStyleIconSvg(bubble: NumberBubble): string {
    const radius = bubble === "plain" ? BASE_RADIUS * 1.34 : BASE_RADIUS;
    const d = radius * TIP_RATIO;
    const parts: string[] = [];

    if (bubble === "solid") {
        parts.push(`<circle cx="0" cy="0" r="${radius}" style="fill:${DISC}"/>`);
        // 实心圆是唯一「有底色」的样式，数字必须与球取不同来源，否则同色就看不见
        parts.push(digit(radius, DIGIT_ON_DISC));
    } else if (bubble === "hollow") {
        parts.push(`<circle cx="0" cy="0" r="${radius}"`
            + ` style="fill:none;stroke:${DISC};stroke-width:${STROKE}"/>`);
        parts.push(digit(radius, "currentColor"));
    } else if (bubble === "pointer") {
        parts.push(`<path d="${tipPath(radius)}" style="fill:${DISC}"/>`);
        parts.push(`<circle cx="0" cy="0" r="${radius}"`
            + ` style="fill:none;stroke:${DISC};stroke-width:${STROKE}"/>`);
        parts.push(digit(radius, "currentColor"));
    } else {
        parts.push(digit(radius, "currentColor"));
    }

    // 取景框：圆（＋尖头）刚好铺满，纯数字按文字本身取景
    const viewBox = bubble === "plain"
        ? `${(-radius * 0.62).toFixed(2)} ${(-radius * 0.85).toFixed(2)} `
            + `${(radius * 1.24).toFixed(2)} ${(radius * 1.72).toFixed(2)}`
        : `${(-radius - PAD).toFixed(2)} ${(-radius - PAD).toFixed(2)} `
            + `${((radius + PAD) * 2).toFixed(2)} `
            + `${(radius + (bubble === "pointer" ? d : radius) + PAD * 2).toFixed(2)}`;

    return `<svg class="annot-badge-icon annot-badge-icon--${bubble}" aria-hidden="true"`
        + ` focusable="false" viewBox="${viewBox}">${parts.join("")}</svg>`;
}
