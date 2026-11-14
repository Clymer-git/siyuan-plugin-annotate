/**
 * 旧附档的只读兼容 + 扁平 PNG 合成。
 *
 * 现在保存走「覆盖原 PNG + 内嵌工程数据」（见 imagePackage.ts），**不再写任何
 * .annot.json 附档，也不再维护块 ID 索引**。这里保留 loadScene() 只是为了把
 * 升级前那些只有附档的老图读出来，用户打开保存一次就自动升级。
 *
 * 扁平 PNG 的合成：按画布尺寸建一张离屏 Canvas，先用画布矩阵把底图画上去
 * （旋转 / 裁切 / 留白都在这一步体现），再把对象层叠上去，得到所见即所得的成品。
 */

import {getFileBlob, uploadAsset} from "../platform";
import {createCanvas} from "./canvas";
import {
    SCENE_VERSION,
    type AnnotScene, type AnnotObject, type CanvasState,
} from "../types";

const INDEX_PATH = "data/storage/petal/siyuan-plugin-annotate/index.json";
const FALLBACK_DIR = "data/storage/petal/siyuan-plugin-annotate";

type SidecarIndex = Record<string, string>;

// 文档内预览会扫描很多图片，索引只读一次并缓存，避免每张图都发一次请求
let indexCache: SidecarIndex | null = null;

export function invalidateIndexCache(): void {
    indexCache = null;
}

async function getIndex(): Promise<SidecarIndex> {
    if (indexCache) return indexCache;
    indexCache = (await readJson<SidecarIndex>(INDEX_PATH)) ?? {};
    return indexCache;
}

function sidecarPathFor(assetPath: string): string {
    return `data/${assetPath}.annot.json`;
}

async function readJson<T>(path: string): Promise<T | null> {
    try {
        const blob = await getFileBlob(path);
        return JSON.parse(await blob.text()) as T;
    } catch {
        // 文件不存在或内容损坏都按「没有场景」处理，不打断编辑器打开
        return null;
    }
}

/**
 * 老场景升级到当前版本。
 * v1 没有 canvas 字段，当时「画布 = 原图」，按这个假设补齐即可，
 * 之前画的标注一个都不会丢。文字描边也是 v2 才有的，老文字补上默认值。
 */
export function normalizeScene(raw: AnnotScene | null): AnnotScene | null {
    if (!raw || !Array.isArray(raw.objects)) return null;
    if (typeof raw.version === "number" && raw.version > SCENE_VERSION) return null;
    const scene = raw as AnnotScene;
    const naturalWidth = scene.imageWidth || 0;
    const naturalHeight = scene.imageHeight || 0;
    if (!scene.canvas || !scene.canvas.width) {
        scene.canvas = createCanvas(naturalWidth, naturalHeight);
    }
    if (scene.canvas.background === undefined) scene.canvas.background = null;
    for (const object of scene.objects as AnnotObject[]) {
        if (object.type !== "text") continue;
        if (object.style.textStrokeEnabled === undefined) {
            object.style.textStrokeEnabled = true;
            object.style.textStrokeColor = "#FFFFFF";
            object.style.textStrokeWidth = 2;
        }
    }
    scene.version = SCENE_VERSION;
    return scene;
}

/** 读取场景：先按块 ID 查索引（主），再按当前图片路径兜底 */
export async function loadScene(blockId: string, assetPath: string): Promise<AnnotScene | null> {
    const index = await getIndex();
    const candidates: string[] = [];
    if (blockId && index[blockId]) candidates.push(index[blockId]);
    if (assetPath) candidates.push(sidecarPathFor(assetPath));
    if (blockId) candidates.push(`${FALLBACK_DIR}/${blockId}.annot.json`);

    for (const path of candidates) {
        const scene = normalizeScene(await readJson<AnnotScene>(path));
        if (!scene) continue;
        // 兼容早期没有 blockId 的场景文件
        if (blockId && scene.blockId && scene.blockId !== blockId) continue;
        return scene;
    }
    return null;
}

/**
 * 把「底图（含旋转/裁切）+ 当前对象层」合成为一张扁平 PNG。
 * 复用编辑器已经渲染好的 SVG 对象层，保证导出与屏幕所见一致；
 * 手柄 / 选中框在 overlay 层，不参与导出。
 */
export async function exportFlatPng(
    baseImage: HTMLImageElement,
    objectLayer: SVGGElement,
    canvas: CanvasState,
): Promise<Blob> {
    const width = Math.max(1, Math.round(canvas.width));
    const height = Math.max(1, Math.round(canvas.height));

    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持 Canvas，无法导出图片");

    // 0) 画布底色（扩展出来的留白用；透明时跳过）
    if (canvas.background) {
        ctx.fillStyle = canvas.background;
        ctx.fillRect(0, 0, width, height);
    }

    // 1) 底图：直接按画布矩阵绘制，旋转 90° / 裁切 / 四周留白都在这里生效
    const m = canvas.matrix;
    if (typeof ctx.setTransform === "function") ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(baseImage, 0, 0, canvas.naturalWidth || width, canvas.naturalHeight || height);
    if (typeof ctx.setTransform === "function") ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 2) 对象层：单独栅格化成透明 SVG 再叠上去
    const objectsMarkup = new XMLSerializer().serializeToString(objectLayer)
        // 独立 SVG 里没有思源的 CSS 变量，统一换成系统字体
        .replace(/font-family="[^"]*"/g, 'font-family="sans-serif"');
    const svgMarkup =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        objectsMarkup +
        `</svg>`;
    const svgUrl = URL.createObjectURL(new Blob([svgMarkup], {type: "image/svg+xml;charset=utf-8"}));
    try {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("标注合成失败"));
            image.src = svgUrl;
        });
        ctx.drawImage(image, 0, 0, width, height);
    } finally {
        URL.revokeObjectURL(svgUrl);
    }

    return await new Promise<Blob>((resolve, reject) => {
        output.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG 生成失败")), "image/png");
    });
}

/**
 * 只把「底图 + 画布变换」烘焙成一张 PNG（不含任何标注）。
 *
 * 现在保存走「覆盖原 PNG + 内嵌工程数据」（见 imagePackage.ts），这条路径平时
 * 不再调用；保留是因为它验证过「矩阵烘焙」这套算法，以后要导出纯底图直接能用。
 */
export async function flattenBaseImage(
    baseImage: HTMLImageElement,
    canvas: CanvasState,
): Promise<Blob> {
    const width = Math.max(1, Math.round(canvas.width));
    const height = Math.max(1, Math.round(canvas.height));
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持 Canvas，无法应用旋转/裁切");
    if (canvas.background) {
        ctx.fillStyle = canvas.background;
        ctx.fillRect(0, 0, width, height);
    }
    const m = canvas.matrix;
    if (typeof ctx.setTransform === "function") ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.drawImage(baseImage, 0, 0, canvas.naturalWidth || width, canvas.naturalHeight || height);
    if (typeof ctx.setTransform === "function") ctx.setTransform(1, 0, 0, 1, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
        output.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG 生成失败")), "image/png");
    });
}

/** 上传导出的 PNG 并插入当前笔记，返回插入的资源路径 */
export async function uploadFlattenedPng(png: Blob): Promise<string> {
    const name = `annotate-${Date.now()}.png`;
    return await uploadAsset(png, name);
}
