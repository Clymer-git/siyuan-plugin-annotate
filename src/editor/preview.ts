/**
 * 文档内标注预览（**仅用于升级前留下的旧数据**）。
 *
 * 现在保存会把成品和工程数据一起写进原图片文件（见 imagePackage.ts），
 * 正文里的图天生带标注。这一层只为「以前只存了附档、还没转成新封装」的老图服务：
 * 它不写任何文件、不改笔记内容，只是临时叠一层只读 SVG。
 * 图片文件里带新封装数据时直接跳过，避免标注叠两遍。
 *
 * 做法是给文档中的 <img> 叠一层只读 SVG：
 *   - 不修改原始图片文件；
 *   - 不修改笔记内容（不换 src、不插入新块）；
 *   - 不生成任何新资源文件；
 *   - 覆盖层 pointer-events:none，不影响右键菜单、拖拽、缩放等原生操作。
 *
 * 思源图片块 DOM（app/src/asset/renderAssets.ts:79）：
 *   <span data-type="img" class="img"><span> </span><span>
 *       ...<img src="assets/x.png" data-src="assets/x.png">...
 *   </span><span> </span></span>
 * 覆盖层插在直接包住 img 的那个 span 里，按 img 的实际显示尺寸定位。
 */

import {SVG_NS} from "./geometry";
import {loadScene} from "./persistence";
import {hasPackage} from "./imagePackage";
import {MosaicRenderer} from "./mosaic";
import {BlurRenderer} from "./blur";
import {MagnifierRenderer} from "./magnifier";
import {renderObject} from "./shapes";
import {reflowTextObjects} from "./textLayout";
import {applyMatrix, createCanvas, invert, isIdentity, remapObjects, toMatrixString} from "./canvas";
import {DOC_OVERLAY_CLASS, getFileBlob} from "../platform";
import type {AnnotObject, AnnotScene, BlurGeometry, MagnifierGeometry, MosaicGeometry} from "../types";

const OVERLAY_CLASS = DOC_OVERLAY_CLASS;
const SAVED_EVENT = "siyuan-plugin-annotate:saved";

/** 编辑器保存成功后通知文档预览刷新对应块 */
export function notifySceneSaved(blockId: string, assetPath: string): void {
    if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
    window.dispatchEvent(new CustomEvent(SAVED_EVENT, {detail: {blockId, assetPath}}));
}

function syncRect(image: HTMLImageElement, overlay: SVGSVGElement): void {
    if (!image.isConnected || !overlay.isConnected) return;
    overlay.style.left = `${image.offsetLeft}px`;
    overlay.style.top = `${image.offsetTop}px`;
    overlay.style.width = `${image.clientWidth}px`;
    overlay.style.height = `${image.clientHeight}px`;
}

export class DocumentPreview {
    private observer: MutationObserver | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    private readonly mosaic = new MosaicRenderer();
    private readonly blur = new BlurRenderer();
    private readonly magnifier = new MagnifierRenderer();
    private readonly scenes = new Map<string, AnnotScene | null>();
    private readonly overlays = new Map<Element, SVGSVGElement>();
    // 用 WeakSet 记录已处理的图片，不在 img / 父元素上写任何属性，
    // 避免思源把插件的临时标记或内联样式序列化回笔记内容
    private readonly seen = new WeakSet<HTMLImageElement>();
    private readonly resizeObserver: ResizeObserver | null = null;

    constructor() {
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const overlay = this.overlays.get(entry.target);
                    if (overlay) syncRect(entry.target as HTMLImageElement, overlay);
                }
            });
        }
    }

    start(): void {
        // 纯 Node 的生命周期 smoke 没有 DOM，直接跳过
        if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
        if (typeof window !== "undefined" && window.addEventListener) {
            window.addEventListener(SAVED_EVENT, this.onSaved);
        }
        this.observer = new MutationObserver(() => this.schedule());
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.schedule();
    }

    destroy(): void {
        this.destroyed = true;
        if (typeof window !== "undefined" && window.removeEventListener) {
            window.removeEventListener(SAVED_EVENT, this.onSaved);
        }
        this.observer?.disconnect();
        this.observer = null;
        this.resizeObserver?.disconnect();
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.scenes.clear();
        this.overlays.clear();
        if (typeof document !== "undefined") {
            document.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
        }
    }

    private readonly onSaved = (event: Event): void => {
        const detail = (event as CustomEvent).detail as {blockId?: string} | undefined;
        if (detail?.blockId) this.scenes.delete(detail.blockId);
        // 让对应图片重新读取 sidecar；其他图片保持现状不动
        document.querySelectorAll<HTMLImageElement>('span[data-type="img"] img[data-src^="assets/"]')
            .forEach((img) => {
                const id = img.closest("[data-node-id]")?.getAttribute("data-node-id");
                if (detail?.blockId && id !== detail.blockId) return;
                this.seen.delete(img);
                img.parentElement?.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
                const overlay = this.overlays.get(img);
                if (overlay) {
                    this.resizeObserver?.unobserve(img);
                    this.overlays.delete(img);
                }
            });
        this.schedule();
    };

    /** 合并高频 DOM 变化，避免 protyle 重绘时反复扫描 */
    private schedule(): void {
        if (this.destroyed || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.scan();
        }, 120);
    }

    private scan(): void {
        if (this.destroyed) return;
        const images = document.querySelectorAll<HTMLImageElement>(
            'span[data-type="img"] img[data-src^="assets/"]',
        );
        for (const image of images) {
            if (this.seen.has(image)) continue;
            const blockId = image.closest("[data-node-id]")?.getAttribute("data-node-id") || "";
            const assetPath = image.getAttribute("data-src") || "";
            if (!blockId || !assetPath) continue;
            this.seen.add(image);
            void this.attach(image, blockId, assetPath);
        }
    }

    private async attach(image: HTMLImageElement, blockId: string, assetPath: string): Promise<void> {
        // 新封装的图片自己就带着成品画面，再叠一层会重复显示标注。
        // 只有读不到工程数据的老图才需要这层预览。
        try {
            const blob = await getFileBlob(`data/${assetPath}`);
            if (hasPackage(new Uint8Array(await blob.arrayBuffer()))) return;
        } catch {
            // 读不到资源就按老数据处理，不影响编辑
        }
        let scene = this.scenes.get(blockId);
        if (scene === undefined) {
            scene = await loadScene(blockId, assetPath);
            this.scenes.set(blockId, scene);
        }
        if (this.destroyed || !image.isConnected) return;

        const host = image.parentElement;
        if (!host) return;
        host.querySelectorAll(`.${OVERLAY_CLASS}`).forEach((el) => el.remove());
        if (!scene || scene.objects.length === 0) return;
        // 保存成 SVG 之后，标注已经在图片文件里了，再叠一层就会重复显示。
        // 场景的 assetPath 指向 .svg 就说明这张图是「已经烤好的」。
        if (/\.svg$/i.test(scene.assetPath || "")) return;

        // 编辑器里的标注用的是「画布坐标」，而正文显示的是原始图片。
        // 旋转 / 翻转 / 裁切过画布之后，两者差一个矩阵，这里用逆矩阵把标注
        // 贴回原图的坐标系，标注才会落在原来的画面位置上。
        const canvas = scene.canvas ?? createCanvas(scene.imageWidth, scene.imageHeight);
        const naturalWidth = canvas.naturalWidth || scene.imageWidth || 1;
        const naturalHeight = canvas.naturalHeight || scene.imageHeight || 1;
        const inverse = invert(canvas.matrix);
        // 老数据里没有折行宽度，先按画布宽度补一遍，行数才和编辑器里一致
        reflowTextObjects(scene.objects, canvas.width);

        const overlay = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
        overlay.setAttribute("class", OVERLAY_CLASS);
        overlay.setAttribute("viewBox", `0 0 ${naturalWidth} ${naturalHeight}`);
        overlay.setAttribute("preserveAspectRatio", "none");
        overlay.style.position = "absolute";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "1";
        overlay.style.overflow = "visible";
        // 定位参照由插件 CSS 的 :has() 规则提供，绝不改父元素的 style/class，
        // 防止思源把临时样式序列化进笔记内容。
        this.mosaic.setBaseImage(image);
        this.mosaic.setInverse(inverse);
        this.blur.setBaseImage(image);
        this.blur.setInverse(inverse);
        this.magnifier.setBaseImage(image);
        this.magnifier.setInverse(inverse);
        this.magnifier.setCanvasSize(canvas.width, canvas.height);

        const holder = isIdentity(inverse)
            ? overlay
            : document.createElementNS(SVG_NS, "g") as SVGGElement;
        if (holder !== overlay) holder.setAttribute("transform", `matrix(${toMatrixString(inverse)})`);

        // 画布被翻转时，逆矩阵里带镜像。标注位置要镜像回去（才能贴住原画面），
        // 但文字不能跟着变成反字 —— 这里把文字单独搬到原图坐标系里正着画。
        const det = canvas.matrix.a * canvas.matrix.d - canvas.matrix.b * canvas.matrix.c;
        const mirrored = det < 0;
        const upright: AnnotObject[] = [];
        const inGroup: AnnotObject[] = [];
        for (const object of scene.objects) {
            if (mirrored && object.type === "text") {
                upright.push(JSON.parse(JSON.stringify(object)) as AnnotObject);
            } else {
                inGroup.push(object);
            }
        }
        if (upright.length) {
            remapObjects(upright, (p) => applyMatrix(inverse, p), {negateRotation: true});
        }

        const draw = (target: SVGElement, object: AnnotObject): void => {
            let bitmapUrl: string | null = null;
            if (object.type === "mosaic") {
                bitmapUrl = this.mosaic.getDataUrl(object.id, object.geometry as MosaicGeometry);
            } else if (object.type === "blur") {
                bitmapUrl = this.blur.getDataUrl(object.id, object.geometry as BlurGeometry);
            } else if (object.type === "magnifier") {
                bitmapUrl = this.magnifier.getDataUrl(object.id, object.geometry as MagnifierGeometry);
            }
            target.append(renderObject(object, {zoom: 1, bitmapUrl}));
        };
        for (const object of inGroup) draw(holder, object);
        if (holder !== overlay) overlay.append(holder);
        for (const object of upright) draw(overlay, object);
        host.append(overlay);
        this.overlays.set(image, overlay);
        this.resizeObserver?.observe(image);
        syncRect(image, overlay);
    }
}
