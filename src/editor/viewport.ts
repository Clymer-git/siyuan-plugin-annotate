/**
 * 视口缩放 / 平移的坐标换算。
 * 参照 Anot8 的 src/math/coordinates.ts：viewBox 恒定，缩放平移只改 CSS transform；
 * 以鼠标位置为焦点缩放时，保证焦点下的像素在屏幕上不动。
 */

import type {Point, ViewportState} from "../types";

/**
 * 缩放下限放到 0.02：长截图（例如 1000×8000）要完整放进窗口，需要的比例可能低于 0.1，
 * 以前卡在 0.1 就会「怎么点适应窗口都放不下」。
 */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;
/** 「适应窗口」允许把太小的图放大一点，但不无限放大（会糊） */
export const MAX_FIT_ZOOM = 2;

export function clampZoom(value: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

export function screenToImage(point: Point, viewport: ViewportState): Point {
    return {
        x: (point.x - viewport.panX) / viewport.zoom,
        y: (point.y - viewport.panY) / viewport.zoom,
    };
}

export function imageToScreen(point: Point, viewport: ViewportState): Point {
    return {
        x: point.x * viewport.zoom + viewport.panX,
        y: point.y * viewport.zoom + viewport.panY,
    };
}

/** 以 focalPointScreen 为锚点缩放到 targetZoom */
export function computeZoomTransform(
    viewport: ViewportState,
    focalPointScreen: Point,
    targetZoom: number,
): ViewportState {
    const zoom = clampZoom(targetZoom);
    const ratio = zoom / viewport.zoom;
    return {
        zoom,
        panX: focalPointScreen.x - ratio * (focalPointScreen.x - viewport.panX),
        panY: focalPointScreen.y - ratio * (focalPointScreen.y - viewport.panY),
    };
}

/**
 * 让整张图完整居中地放进舞台（保持宽高比）。
 * 小图会适当放大到接近铺满，但不超过 MAX_FIT_ZOOM，避免像素糊。
 */
export function fitTransform(
    stageWidth: number,
    stageHeight: number,
    imageWidth: number,
    imageHeight: number,
    padding = 32,
): ViewportState {
    const availableW = Math.max(1, stageWidth - padding * 2);
    const availableH = Math.max(1, stageHeight - padding * 2);
    const scale = Math.min(availableW / imageWidth, availableH / imageHeight, MAX_FIT_ZOOM);
    const zoom = clampZoom(scale);
    return {
        zoom,
        panX: (stageWidth - imageWidth * zoom) / 2,
        panY: (stageHeight - imageHeight * zoom) / 2,
    };
}
