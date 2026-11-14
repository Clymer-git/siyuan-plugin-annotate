/**
 * 模糊：和马赛克同一套思路——从底图上按框选区域采样，处理好之后交给 SVG <image> 呈现。
 *
 * 为什么不用 SVG 的 <filter><feGaussianBlur>：
 * - 保存出来的是一张独立 SVG，滤镜定义得跟着一起搬，思源后端还会清洗 SVG；
 * - 正文预览层、导出 PNG、写回的 SVG 三处都要一致，烤成位图最稳。
 *
 * 采样区域要向外多取一圈（3 倍模糊半径）：
 * 高斯模糊会把边缘的像素往外扩，只取框内的话四边会发虚透出底色。
 * 「画布 → 原图」的逆矩阵由 setInverse() 注入，和马赛克共用同一套画布坐标约定。
 */

import {IDENTITY, mapRect} from "./canvas";
import type {BlurGeometry, Matrix} from "../types";

const CACHE_LIMIT = 48;
/** 模糊半径的上限，防止用户拉爆（画布像素） */
export const MAX_BLUR_RADIUS = 80;

/** 新建模糊区域时的默认强度：能明显看出来，又不至于糊成一片 */
export const DEFAULT_BLUR_RADIUS = 12;

export class BlurRenderer {
    private base: HTMLImageElement | null = null;
    private inverse: Matrix = {...IDENTITY};
    private version = 0;
    private cache = new Map<string, string>();

    setBaseImage(image: HTMLImageElement | null): void {
        this.base = image;
        this.cache.clear();
    }

    /** 画布 → 原图 的逆矩阵；画布旋转/翻转/裁切后必须重新设置 */
    setInverse(matrix: Matrix): void {
        this.inverse = {...matrix};
        this.version++;
        this.cache.clear();
    }

    /** 取模糊位图；底图不可读或环境不支持 Canvas / filter 时返回 null，由调用方降级 */
    getDataUrl(id: string, geometry: BlurGeometry): string | null {
        const width = Math.max(1, Math.round(geometry.width));
        const height = Math.max(1, Math.round(geometry.height));
        const radius = Math.max(1, Math.min(MAX_BLUR_RADIUS, Math.round(geometry.radius || 12)));
        const key = [this.version, id, geometry.x, geometry.y, width, height, radius].join("|");
        const cached = this.cache.get(key);
        if (cached) return cached;

        const url = this.blur(geometry, width, height, radius);
        if (url) {
            this.cache.set(key, url);
            if (this.cache.size > CACHE_LIMIT) {
                const oldest = this.cache.keys().next().value;
                if (oldest) this.cache.delete(oldest);
            }
        }
        return url;
    }

    private blur(geometry: BlurGeometry, width: number, height: number, radius: number): string | null {
        if (!this.base) return null;
        try {
            const source = mapRect(this.inverse, {x: geometry.x, y: geometry.y, width, height});
            const pad = Math.ceil(radius * 3);

            const output = document.createElement("canvas");
            output.width = width;
            output.height = height;
            const ctx = output.getContext("2d");
            if (!ctx) return null;
            // 不支持 filter 的环境（老 WebView）直接返回 null，调用方用半透明雾兜底
            if (typeof (ctx as CanvasRenderingContext2D).filter !== "string") return null;
            ctx.filter = `blur(${radius}px)`;
            // 画布外的部分会被裁掉，但边缘因此有真实像素可用，不会出现透明毛边
            ctx.drawImage(
                this.base,
                source.x - pad, source.y - pad, source.width + pad * 2, source.height + pad * 2,
                -pad, -pad, width + pad * 2, height + pad * 2,
            );
            return output.toDataURL("image/png");
        } catch {
            // 跨域图片会污染 canvas；交给调用方降级
            return null;
        }
    }
}
