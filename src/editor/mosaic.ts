/**
 * 马赛克：离屏 Canvas 对底图对应区域采样，生成 PNG dataURL 交给 SVG <image> 呈现。
 *
 * 依据 capcap 的 MosaicTool.swift / EditCanvasView.translatedMosaic：
 * 马赛克是「底图上被重新采样的一块区域」，不是贴在图上可拉伸的贴图。
 * 因此这里只缓存渲染结果（按几何 + 块大小做 key），几何一变就从底图重新采样；
 * 原始图片文件从头到尾不被修改，马赛克对象也随时可删、可缩放、可调块大小。
 *
 * v0.7.0：底图可能被旋转 / 翻转 / 裁切过，马赛克区域用的是画布坐标，
 * 采样时必须先用「画布 → 原图」的逆矩阵换算成原图坐标，否则会采到别处。
 * 逆矩阵由 setInverse() 注入，画布一变就换一份并清空缓存。
 */

import {IDENTITY, mapRect} from "./canvas";
import type {MosaicGeometry, Matrix} from "../types";

const CACHE_LIMIT = 48;

export class MosaicRenderer {
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

    /** 取马赛克位图；底图不可读或环境不支持 Canvas 时返回 null，由调用方降级 */
    getDataUrl(id: string, geometry: MosaicGeometry): string | null {
        const width = Math.max(1, Math.round(geometry.width));
        const height = Math.max(1, Math.round(geometry.height));
        const blockSize = Math.max(2, Math.round(geometry.blockSize));
        const key = [this.version, id, geometry.x, geometry.y, width, height, blockSize].join("|");
        const cached = this.cache.get(key);
        if (cached) return cached;

        const url = this.sample(geometry, width, height, blockSize);
        if (url) {
            this.cache.set(key, url);
            if (this.cache.size > CACHE_LIMIT) {
                const oldest = this.cache.keys().next().value;
                if (oldest) this.cache.delete(oldest);
            }
        }
        return url;
    }

    private sample(geometry: MosaicGeometry, width: number, height: number, blockSize: number): string | null {
        if (!this.base) return null;
        try {
            // 画布坐标 → 原图坐标（旋转/裁切后仍然采到正确的像素）
            const source = mapRect(this.inverse, {
                x: geometry.x, y: geometry.y, width, height,
            });

            // 先缩到「一格一个像素」，再无插值放大回原尺寸，得到方块化效果
            const smallW = Math.max(1, Math.ceil(width / blockSize));
            const smallH = Math.max(1, Math.ceil(height / blockSize));

            const small = document.createElement("canvas");
            small.width = smallW;
            small.height = smallH;
            const smallCtx = small.getContext("2d");
            if (!smallCtx) return null;
            smallCtx.imageSmoothingEnabled = false;
            smallCtx.drawImage(this.base, source.x, source.y, source.width, source.height, 0, 0, smallW, smallH);

            const output = document.createElement("canvas");
            output.width = width;
            output.height = height;
            const ctx = output.getContext("2d");
            if (!ctx) return null;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, width, height);
            return output.toDataURL("image/png");
        } catch {
            // 跨域图片会污染 canvas；此时降级为纯色遮罩，不影响其它功能
            return null;
        }
    }
}
