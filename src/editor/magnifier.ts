/**
 * 放大镜：从底图上按「锚点 + 倍数」现采一块像素，放大后贴进显示框。
 *
 * 为什么不用 SVG 的 <image> 直接引用底图再缩放：
 * - 导出 / 正文预览都要把对象层单独栅格化，引用外部资源会失败，
 *   和马赛克一样烤成小位图最稳（框一般只有一两百像素，代价很低）；
 * - 画布可能被旋转 / 翻转 / 裁切过，直接引用对不准，先烘一层「画布空间底图」再裁最准。
 *
 * 画布空间底图只建一次（底图或画布矩阵变了才重建），
 * 之后每次拖拽锚点只是从这张缓存画布上裁一小块并放大，逐帧更新也不卡。
 */

import {IDENTITY} from "./canvas";
import type {MagnifierGeometry, Matrix} from "../types";

const CACHE_LIMIT = 64;

/** 新建放大镜的默认倍数 */
export const DEFAULT_MAGNIFIER_ZOOM = 2;

/** 悬浮条上可选的倍数 */
export const MAGNIFIER_ZOOMS = [1.5, 2, 3, 4] as const;

export function normalizeMagnifierZoom(raw: unknown, fallback = DEFAULT_MAGNIFIER_ZOOM): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(6, Math.max(1.2, Math.round(value * 10) / 10));
}

/**
 * 新建放大镜时，锚点若落在显示框里（拖拽起点就是框的一个角），
 * 沿「框中心 → 锚点」的方向把它推到框外一点点。
 * 这样刚画完就能同时看到小圆点、镜框和两者之间的连线，
 * 而不是圆点被压在块里、连线长度为 0。
 */
export function nudgeAnchorOutside(g: MagnifierGeometry): void {
    const box = {
        x: Math.min(g.x, g.x + g.width),
        y: Math.min(g.y, g.y + g.height),
        w: Math.abs(g.width),
        h: Math.abs(g.height),
    };
    if (box.w < 4 || box.h < 4) return;
    const pad = 14;
    const ax = g.anchor.x;
    const ay = g.anchor.y;
    const inside = ax > box.x - pad && ax < box.x + box.w + pad &&
        ay > box.y - pad && ay < box.y + box.h + pad;
    if (!inside) return;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let dx = ax - cx;
    let dy = ay - cy;
    if (Math.hypot(dx, dy) < 0.5) {
        // 正好在中心：往左上角推
        dx = -1;
        dy = -1;
    }
    const kx = (box.w / 2 + pad) / Math.max(1e-3, Math.abs(dx));
    const ky = (box.h / 2 + pad) / Math.max(1e-3, Math.abs(dy));
    const k = Math.min(kx, ky);
    g.anchor = {x: cx + dx * k, y: cy + dy * k};
}

export class MagnifierRenderer {
    private base: HTMLImageElement | null = null;
    private inverse: Matrix = {...IDENTITY};
    private canvasWidth = 0;
    private canvasHeight = 0;
    private version = 0;
    private cache = new Map<string, string>();
    /** 画布空间的底图缓存（底图已按画布矩阵贴好） */
    private space: HTMLCanvasElement | null = null;

    setBaseImage(image: HTMLImageElement | null): void {
        this.base = image;
        this.space = null;
        this.cache.clear();
    }

    /** 画布 → 原图 的逆矩阵；画布旋转 / 翻转 / 裁切后必须重新设置 */
    setInverse(matrix: Matrix): void {
        this.inverse = {...matrix};
        this.space = null;
        this.version++;
        this.cache.clear();
    }

    /** 画布尺寸；扩画布 / 旋转后要更新，否则缓存层还是旧的 */
    setCanvasSize(width: number, height: number): void {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        if (w === this.canvasWidth && h === this.canvasHeight) return;
        this.canvasWidth = w;
        this.canvasHeight = h;
        this.space = null;
        this.version++;
        this.cache.clear();
    }

    /** 取显示框里的放大图；底图不可读或环境不支持 Canvas 时返回 null，由调用方降级 */
    getDataUrl(id: string, geometry: MagnifierGeometry): string | null {
        const lensW = Math.max(8, Math.round(Math.abs(geometry.width)));
        const lensH = Math.max(8, Math.round(Math.abs(geometry.height)));
        const zoom = normalizeMagnifierZoom(geometry.zoom);
        // 锚点按 0.5px 取整做 key：拖拽时每帧都会变，但停下来就能命中缓存
        const ax = Math.round(geometry.anchor.x * 2) / 2;
        const ay = Math.round(geometry.anchor.y * 2) / 2;
        const key = [this.version, id, ax, ay, lensW, lensH, zoom].join("|");
        const cached = this.cache.get(key);
        if (cached) return cached;
        const url = this.sample(geometry, lensW, lensH, zoom);
        if (url) {
            this.cache.set(key, url);
            if (this.cache.size > CACHE_LIMIT) {
                const oldest = this.cache.keys().next().value;
                if (oldest) this.cache.delete(oldest);
            }
        }
        return url;
    }

    private sample(geometry: MagnifierGeometry, lensW: number, lensH: number, zoom: number): string | null {
        const space = this.spaceCanvas();
        if (!space) return null;
        try {
            // 「显示框里看到的那一块」在原图里只有 1/zoom 那么大
            const srcW = lensW / zoom;
            const srcH = lensH / zoom;
            const sx = geometry.anchor.x - srcW / 2;
            const sy = geometry.anchor.y - srcH / 2;
            // 超出画布的部分不要拉变形：按交集裁剪，再把目标区域等比例缩回去
            const ix = Math.max(0, sx);
            const iy = Math.max(0, sy);
            const ix2 = Math.min(space.width, sx + srcW);
            const iy2 = Math.min(space.height, sy + srcH);
            if (ix2 <= ix || iy2 <= iy) return null;

            const output = document.createElement("canvas");
            output.width = lensW;
            output.height = lensH;
            const ctx = output.getContext("2d");
            if (!ctx) return null;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            const scaleX = lensW / srcW;
            const scaleY = lensH / srcH;
            ctx.drawImage(
                space, ix, iy, ix2 - ix, iy2 - iy,
                (ix - sx) * scaleX, (iy - sy) * scaleY,
                (ix2 - ix) * scaleX, (iy2 - iy) * scaleY,
            );
            return output.toDataURL("image/png");
        } catch {
            // 跨域图片会污染 canvas；此时降级成半透明镜片
            return null;
        }
    }

    /** 画布空间的底图：底图按矩阵贴好、尺寸等于画布，之后所有采样都从它上面裁 */
    private spaceCanvas(): HTMLCanvasElement | null {
        if (this.space) return this.space;
        const base = this.base;
        if (!base) return null;
        const naturalW = base.naturalWidth || this.canvasWidth;
        const naturalH = base.naturalHeight || this.canvasHeight;
        const w = this.canvasWidth || naturalW;
        const h = this.canvasHeight || naturalH;
        if (!w || !h) return null;
        try {
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(w));
            canvas.height = Math.max(1, Math.round(h));
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            const m = invertMatrix(this.inverse);
            if (typeof ctx.setTransform === "function") ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
            ctx.drawImage(base, 0, 0, naturalW, naturalH);
            if (typeof ctx.setTransform === "function") ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.space = canvas;
            return canvas;
        } catch {
            return null;
        }
    }
}

/** 轴对齐矩阵求逆（与 canvas.ts 的 invert 等价，这里只处理我们自己的矩阵） */
function invertMatrix(m: Matrix): Matrix {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return {...IDENTITY};
    return {
        a: m.d / det,
        b: -m.b / det,
        c: -m.c / det,
        d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det,
        f: (m.b * m.e - m.a * m.f) / det,
    };
}
