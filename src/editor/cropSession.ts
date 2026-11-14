/**
 * 裁剪会话：完整照搬参考插件 imgReEditor 的裁剪数据流。
 *
 * 参考插件（src/components/editor/CanvasEditor.svelte）的做法是：
 *   1. 背景图始终留两份：_originalSrc（完整原图）和「当前显示的裁后位图」；
 *   2. _cropOffset 记着当前显示窗口左上角在完整原图里的位置；
 *   3. enterCropMode(restoreCrop)：把 _originalSrc 重新铺满，标注全部 +offset 移回
 *      原位，裁剪框正好框住上次保留的那块；
 *   4. applyCrop：把框里的画面烤成一张新的显示位图，_cropOffset += 框左上角，
 *      标注全部 −框左上角，然后 fitImageToViewport()；
 *   5. exitCropMode：只把框拿掉。
 *
 * 我们不把画面烤成位图（会掉画质，也没法再扩回外围），而是用
 * 「完整视图 + 显式裁剪窗口」做等价表达：
 *   - full   = fullViewOf(canvas)：完整原图按旋转 / 翻转贴好、左上角归零；
 *   - crop   = 当前显示窗口在完整视图里的矩形，等价于 _cropOffset + 尺寸；
 *   - bounds = 「当前窗口 ∪ 完整原图」：最大能扩回的范围；
 *   - 显示画布 = full 的矩阵再平移 (−crop.x, −crop.y)，宽高＝窗口宽高。
 * 编辑器里由 .annot-viewport 把窗口外的内容裁掉，保存出去的 SVG 由 viewBox
 * 天然裁掉。两者看到的都是「裁后的画面」，但完整原图一直留在文件里，
 * 所以保存后重新右键编辑仍能扩回上次裁掉的外围。
 *
 * 这个类只算数，不碰 DOM、不碰标注对象本身，方便单独回归测试。
 */

import {cropCanvas, cropWindowOf, fullViewOf} from "./canvas";
import {unionBounds} from "./crop";
import type {Bounds} from "./shapes";
import type {CanvasState, CropWindow, Matrix, Point} from "../types";

/** 完整视图：拿到原始图片之后、动过旋转 / 翻转、但还没裁过的那幅画面 */
export interface OriginalView {
    width: number;
    height: number;
    matrix: Matrix;
}

/** 进入裁剪时记下的现场，取消就原样还原（参考插件退出时不会还原，我们不跟这个漏洞） */
export interface CropBackup {
    canvas: CanvasState;
    crop: CropWindow;
    /** 扩回完整范围时标注被加上的位移，取消时减回去 */
    shift: Point;
}

export interface EnterResult {
    /** 裁剪期间临时铺开的画布（可能是最大范围，也可能就是当前画布） */
    canvas: CanvasState;
    /** 标注要跟着移动的位移 */
    shift: Point;
    /** 裁剪框的初始值：上次保留的那块，或整张图 */
    rect: CropWindow;
    /** 是否把之前裁掉的外围重新铺了出来 */
    expanded: boolean;
}

export interface BakeResult {
    canvas: CanvasState;
    crop: CropWindow;
    /** 标注要跟着移动的位移 */
    shift: Point;
}

const roundRect = (rect: Bounds): CropWindow => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
});

const sameRect = (a: Bounds, b: Bounds): boolean => {
    const x = roundRect(a);
    const y = roundRect(b);
    return x.x === y.x && x.y === y.y && x.width === y.width && x.height === y.height;
};

export class CropSession {
    /** 完整原图铺出来的那幅画面，全程不变 */
    readonly full: OriginalView;
    /** 进入裁剪前正在显示的窗口（完整视图坐标） */
    readonly previous: CropWindow;
    /** 最大可恢复范围（完整视图坐标）：当前窗口 ∪ 完整原图 */
    readonly bounds: Bounds;
    /** 是否要临时铺回更大的范围 */
    readonly expanded: boolean;
    /** 进入裁剪前的现场 */
    readonly backup: CropBackup;
    /** 裁剪期间实际使用的画布 */
    private workingCanvas: CanvasState;
    /** enter 的结果缓存：判断「框没动」时要复用同一份初始框 */
    private entered: EnterResult | null = null;

    constructor(canvas: CanvasState, crop?: CropWindow | null) {
        this.full = fullViewOf(canvas);
        this.previous = roundRect(crop ?? cropWindowOf(canvas));
        this.bounds = unionBounds(this.previous, {
            x: 0, y: 0, width: this.full.width, height: this.full.height,
        });
        this.expanded = !sameRect(this.previous, this.bounds);
        this.backup = {
            canvas: {...canvas, matrix: {...canvas.matrix}},
            crop: {...this.previous},
            shift: {x: 0, y: 0},
        };
        this.workingCanvas = {...canvas, matrix: {...canvas.matrix}};
    }

    /**
     * 进入裁剪（参考插件 enterCropMode(restoreCrop)）。
     * 之前裁过就把完整原图重新铺出来，标注跟着回到原图坐标，
     * 框正好框住上次保留的那块；没裁过就维持当前画面，框铺满整张图。
     */
    enter(): EnterResult {
        if (this.entered) return this.entered;
        const shift: Point = {
            x: this.previous.x - this.bounds.x,
            y: this.previous.y - this.bounds.y,
        };
        if (this.expanded) {
            this.workingCanvas = {
                ...this.backup.canvas,
                width: this.bounds.width,
                height: this.bounds.height,
                matrix: {
                    ...this.full.matrix,
                    e: this.full.matrix.e - this.bounds.x,
                    f: this.full.matrix.f - this.bounds.y,
                },
            };
            this.backup.shift = shift;
        }
        const rect: CropWindow = this.expanded
            ? {x: shift.x, y: shift.y, width: this.previous.width, height: this.previous.height}
            : {x: 0, y: 0, width: this.workingCanvas.width, height: this.workingCanvas.height};
        this.entered = {
            canvas: this.workingCanvas,
            shift: this.expanded ? shift : {x: 0, y: 0},
            rect,
            expanded: this.expanded,
        };
        return this.entered;
    }

    /** 框没动就点确认：等于什么都没做（参考插件不处理，但用户会以为裁丢了） */
    unchanged(rect: Bounds): boolean {
        return this.expanded && sameRect(rect, this.enterRect());
    }

    /** 进入裁剪时框的位置，供「框没动」判断与整图按钮复用 */
    enterRect(): CropWindow {
        return roundRect(this.enter().rect);
    }

    /**
     * 应用裁剪（参考插件 applyCrop）。
     * 传入的框是「裁剪期间画布坐标」；新窗口要换算回完整视图坐标，
     * 才能和 _cropOffset 一样在下次打开时继续累加。
     */
    bake(rect: Bounds): BakeResult {
        const box = roundRect(rect);
        const crop: CropWindow = {
            x: this.bounds.x + box.x,
            y: this.bounds.y + box.y,
            width: box.width,
            height: box.height,
        };
        return {
            canvas: cropCanvas(this.workingCanvas, box),
            crop,
            shift: {x: -box.x, y: -box.y},
        };
    }

    /** 取消 / 退出：把进入裁剪前的画布与裁剪窗口原样还回去 */
    restore(): CropBackup {
        return {
            canvas: {...this.backup.canvas, matrix: {...this.backup.canvas.matrix}},
            crop: {...this.backup.crop},
            shift: {x: -this.backup.shift.x, y: -this.backup.shift.y},
        };
    }

    /** 「整张原图」按钮：框铺满最大可恢复范围 */
    fullRect(): CropWindow {
        const canvas = this.expanded ? this.workingCanvas : this.backup.canvas;
        return {x: 0, y: 0, width: canvas.width, height: canvas.height};
    }
}
