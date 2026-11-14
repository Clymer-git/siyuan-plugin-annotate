/**
 * 旧版 `-annot.svg` 的只读兼容解析。
 *
 * 现在的封装是「一张自带工程数据的 PNG」（见 imagePackage.ts），保存时不再生成 SVG。
 * 这里只留解析能力：老笔记里那些以前保存出来的 SVG，右键打开还能读出完整原图与
 * 标注，点一次保存就自动升级成新封装。这个文件不参与任何写操作。
 */

import type {AnnotScene, CanvasState, Matrix} from "../types";
import {IDENTITY} from "./canvas";

/** 根节点标记：没有它就不是我们生成的旧 SVG（普通 SVG 插图照常编辑） */
export const SVG_MARKER = "siyuan-annotate-svg";

const BASE_ID = "annotate-source";
const BG_ID = "annotate-bg";
const SCENE_ID = "annotate-scene";

/** 可以直接内嵌进图片数据的类型（旧 SVG 底图用过的白名单，读原图字节时也复用） */
const EMBED_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    jfif: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
};

export interface SvgBase {
    /** data:image/...;base64,... */
    dataUrl: string;
    /** 原始图片像素尺寸（不是画布尺寸） */
    width: number;
    height: number;
}

export interface ParsedSvg {
    canvas: CanvasState;
    base: SvgBase;
    /** 文件里自带的场景数据；缺失时为 null */
    scene: AnnotScene | null;
}

export function assetExtension(path: string): string {
    const clean = (path || "").split("?")[0].split("#")[0];
    const name = clean.split("/").pop() || "";
    const index = name.lastIndexOf(".");
    return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/** 这个扩展名的图片能直接内嵌吗（否则要先转成 PNG） */
export function embeddableMime(path: string): string | null {
    return EMBED_MIME[assetExtension(path)] ?? null;
}

function bytesToBase64(bytes: Uint8Array): string {
    if (typeof btoa === "function") {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }
    const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = bytes[i + 1];
        const c = bytes[i + 2];
        out += table[a >> 2];
        out += table[((a & 3) << 4) | ((b ?? 0) >> 4)];
        out += b === undefined ? "=" : table[((b & 15) << 2) | ((c ?? 0) >> 6)];
        out += c === undefined ? "=" : table[c & 63];
    }
    return out;
}

/** 把二进制包装成可直接内嵌的 data URL */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function base64ToText(value: string): string {
    const binary = atob(value.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function readMatrix(value: string | null): Matrix {
    const match = /matrix\(\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*\)/
        .exec(value || "");
    if (!match) return {...IDENTITY};
    const [a, b, c, d, e, f] = match.slice(1).map(Number);
    if ([a, b, c, d, e, f].some((n) => !Number.isFinite(n))) return {...IDENTITY};
    return {a, b, c, d, e, f};
}

/**
 * 判断一个 SVG 资源是不是旧版插件写的，并从中取回「底图 + 画布 + 场景」。
 * 不是我们写的（普通 SVG 插图）返回 null，交给正常图片流程处理。
 */
export function parseAnnotatedSvg(text: string): ParsedSvg | null {
    if (!text || text.indexOf(SVG_MARKER) < 0) return null;
    let doc: Document | null = null;
    try {
        doc = new DOMParser().parseFromString(text, "image/svg+xml");
    } catch {
        return null;
    }
    const root = doc?.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") return null;
    if (root.getAttribute("data-annot") !== SVG_MARKER) return null;

    const image = doc?.querySelector(`#${BASE_ID}`);
    if (!image) return null;
    const baseData = image.getAttribute("href") || image.getAttribute("xlink:href") || "";
    if (!baseData.startsWith("data:image/")) return null;

    const viewBox = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const naturalWidth = Number(image.getAttribute("width")) || 0;
    const naturalHeight = Number(image.getAttribute("height")) || 0;
    const width = viewBox.length === 4 && viewBox[2] > 0 ? Math.round(viewBox[2]) : Math.round(Number(root.getAttribute("width")) || naturalWidth);
    const height = viewBox.length === 4 && viewBox[3] > 0 ? Math.round(viewBox[3]) : Math.round(Number(root.getAttribute("height")) || naturalHeight);
    if (!width || !height) return null;

    const bg = doc?.querySelector(`#${BG_ID}`)?.getAttribute("fill") || null;
    const canvas: CanvasState = {
        width,
        height,
        naturalWidth,
        naturalHeight,
        matrix: readMatrix(image.getAttribute("transform")),
        background: bg,
    };

    let scene: AnnotScene | null = null;
    const meta = doc?.querySelector(`#${SCENE_ID}`);
    const encoded = meta?.getAttribute("data-encoding") === "base64" ? (meta.textContent || "") : "";
    if (encoded.trim()) {
        try {
            scene = JSON.parse(base64ToText(encoded)) as AnnotScene;
        } catch {
            scene = null;
        }
    }

    return {
        canvas,
        base: {
            dataUrl: baseData,
            width: naturalWidth || width,
            height: naturalHeight || height,
        },
        scene,
    };
}
