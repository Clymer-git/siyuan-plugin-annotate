/**
 * 底图明暗取样：只给「输入光标」挑颜色用。
 *
 * 光标是一根很细的竖线，颜色只能整体一个值，所以要按它**当前所在位置**的底图明暗
 * 决定用白还是黑 —— 采样点必须在光标脚下，不能用整张图的平均值。
 *
 * 注意：提交后的文字**不用**这里的颜色，它们保持用户自己选的颜色（见 shapes.ts）。
 */

import {invert} from "./canvas";
import type {Matrix} from "../types";

export type InkColor = "#000000" | "#FFFFFF";

const THRESHOLD = 0.5;
const MAX_SIDE = 320;

export function contrastInk(luminance: number): InkColor {
    return luminance < THRESHOLD ? "#FFFFFF" : "#000000";
}

const sRGB = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

export class ContrastSampler {
    private data: Uint8ClampedArray | null = null;
    private thumbWidth = 0;
    private thumbHeight = 0;
    private naturalWidth = 1;
    private naturalHeight = 1;
    private inverse: Matrix = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};

    constructor(source: CanvasImageSource, naturalWidth: number, naturalHeight: number, matrix?: Matrix) {
        this.naturalWidth = Math.max(1, Math.round(naturalWidth || 1));
        this.naturalHeight = Math.max(1, Math.round(naturalHeight || 1));
        const scale = Math.min(1, MAX_SIDE / Math.max(this.naturalWidth, this.naturalHeight));
        this.thumbWidth = Math.max(1, Math.round(this.naturalWidth * scale));
        this.thumbHeight = Math.max(1, Math.round(this.naturalHeight * scale));
        try {
            const canvas = document.createElement("canvas");
            canvas.width = this.thumbWidth;
            canvas.height = this.thumbHeight;
            const ctx = canvas.getContext("2d", {willReadFrequently: true});
            if (ctx) {
                ctx.drawImage(source, 0, 0, this.thumbWidth, this.thumbHeight);
                this.data = ctx.getImageData(0, 0, this.thumbWidth, this.thumbHeight).data;
            }
        } catch {
            // 跨域 / 受限环境取不到像素：光标退回主题强调色，不影响其它功能
            this.data = null;
        }
        if (matrix) this.setMatrix(matrix);
    }

    setMatrix(matrix: Matrix): void {
        this.inverse = invert({...matrix});
    }

    /** 画布坐标里的一块区域，底图有多亮（0 黑 ~ 1 白）；取不到返回 null */
    luminanceAt(x: number, y: number, width: number, height: number): number | null {
        const data = this.data;
        if (!data) return null;
        const m = this.inverse;
        const toImage = (px: number, py: number): {x: number, y: number} => ({
            x: m.a * px + m.c * py + m.e,
            y: m.b * px + m.d * py + m.f,
        });
        const corners = [
            toImage(x, y),
            toImage(x + width, y),
            toImage(x, y + height),
            toImage(x + width, y + height),
        ];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const corner of corners) {
            minX = Math.min(minX, corner.x);
            maxX = Math.max(maxX, corner.x);
            minY = Math.min(minY, corner.y);
            maxY = Math.max(maxY, corner.y);
        }
        const sx = this.thumbWidth / this.naturalWidth;
        const sy = this.thumbHeight / this.naturalHeight;
        let x0 = Math.max(0, Math.min(this.thumbWidth - 1, Math.floor(minX * sx)));
        let x1 = Math.max(x0 + 1, Math.min(this.thumbWidth, Math.ceil(maxX * sx)));
        let y0 = Math.max(0, Math.min(this.thumbHeight - 1, Math.floor(minY * sy)));
        let y1 = Math.max(y0 + 1, Math.min(this.thumbHeight, Math.ceil(maxY * sy)));

        const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
        const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
        let sum = 0;
        let count = 0;
        for (let py = y0; py < y1; py += stepY) {
            for (let px = x0; px < x1; px += stepX) {
                const index = (py * this.thumbWidth + px) * 4;
                sum += 0.2126 * sRGB(data[index]) + 0.7152 * sRGB(data[index + 1]) + 0.0722 * sRGB(data[index + 2]);
                count += 1;
            }
        }
        return count ? sum / count : null;
    }
}
