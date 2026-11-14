/**
 * 图片封装：一张自带工程数据的 PNG（参考 imgReEditor 的做法）。
 *
 * 之前每次保存都会新上传一张 `-annot.svg`，再写一份 `.annot.json` 附档和块 ID 索引，
 * 改十次就多二十个文件，而且这些文件在思源的资源管理里清不掉。现在改成：
 *
 *   - 成品画面直接烘焙成 PNG，**覆盖笔记里正在引用的那个资源文件**，路径不变；
 *     不换链接、不动笔记内容，图片与文字同段也不会被冲掉，更不会多出未引用资源。
 *   - 「完整原始底图 + 矢量标注 + 画布 / 裁剪窗口」打包成 JSON，写进 PNG 的
 *     tEXt 元数据块（参考项目 `insertPNGTextChunk` / `readPNGTextChunk`）。
 *   - 重新右键编辑时从这张 PNG 里把工程数据读回来：底图仍是完整原图，所以
 *     标注可以接着改、裁掉的范围还能扩回来；正文、双击看图、导出、手机端
 *     看到的则是 PNG 里的成品画面，不依赖插件。
 *
 * 一个文件同时是「成品」和「工程文件」，与参考插件完全同一套思路。
 */

import type {AnnotScene} from "../types";

/** tEXt 块的关键字；普通图片没有这个块，就按未编辑过的图片处理 */
export const PACKAGE_KEY = "siyuan-plugin-annotate";
export const PACKAGE_VERSION = 1;

/** 完整原始底图（未经旋转 / 裁剪 / 二次压缩） */
export interface ImageBase {
    /** data:image/...;base64,... */
    dataUrl: string;
    width: number;
    height: number;
}

/** PNG 里装的那份可继续编辑的数据 */
export interface ImagePackage {
    version: number;
    base: ImageBase;
    scene: AnnotScene;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes: Uint8Array): boolean {
    if (bytes.length < 8) return false;
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return (((bytes[offset] << 24) | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
}

function chunkType(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** 列出所有块（含长度与起始位置），块不完整时立即停止 */
function chunksOf(bytes: Uint8Array): Array<{start: number; size: number; type: string}> {
    const chunks: Array<{start: number; size: number; type: string}> = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = readUint32(bytes, offset);
        if (length > bytes.length - offset - 12) break;
        chunks.push({start: offset, size: 12 + length, type: chunkType(bytes, offset)});
        offset += 12 + length;
    }
    return chunks;
}

/** 这个块是不是我们写的那条工程数据 */
function isOurTextChunk(bytes: Uint8Array, chunk: {start: number; size: number}): boolean {
    const start = chunk.start + 8;
    const end = chunk.start + chunk.size - 4;
    const separator = new TextEncoder().encode(PACKAGE_KEY).length;
    if (start + separator >= end) return false;
    if (bytes[start + separator] !== 0) return false;
    return new TextDecoder().decode(bytes.subarray(start, start + separator)) === PACKAGE_KEY;
}

/** 从 PNG 字节里取出工程数据；不是我们生成的图片返回 null */
export function readPackage(bytes: Uint8Array): ImagePackage | null {
    if (!isPng(bytes)) return null;
    const decoder = new TextDecoder();
    for (const chunk of chunksOf(bytes)) {
        if (chunk.type !== "tEXt" || !isOurTextChunk(bytes, chunk)) continue;
        const start = chunk.start + 8 + PACKAGE_KEY.length + 1;
        const end = chunk.start + chunk.size - 4;
        try {
            const data = JSON.parse(decoder.decode(bytes.subarray(start, end))) as ImagePackage;
            if (!data || data.version !== PACKAGE_VERSION) return null;
            if (!data.base?.dataUrl?.startsWith("data:image/")) return null;
            if (!data.scene || !Array.isArray(data.scene.objects)) return null;
            return data;
        } catch {
            return null;
        }
    }
    return null;
}

/** 图片里是否带我们的工程数据（正文预览层用它判断要不要再叠一层标注） */
export function hasPackage(bytes: Uint8Array): boolean {
    if (!isPng(bytes)) return false;
    return chunksOf(bytes).some((chunk) => chunk.type === "tEXt" && isOurTextChunk(bytes, chunk));
}

/**
 * 把工程数据写进 PNG：先删掉旧的同一条 tEXt，再在 IEND 之前插入新块。
 * CRC 按 PNG 规范覆盖「块类型 + 块数据」，写错会导致整张图打不开。
 */
export function writePackage(png: Uint8Array, data: ImagePackage): Uint8Array {
    if (!isPng(png)) throw new Error("不是有效的 PNG，无法写入编辑数据");

    const kept = chunksOf(png)
        .filter((chunk) => !(chunk.type === "tEXt" && isOurTextChunk(png, chunk)))
        .map((chunk) => png.subarray(chunk.start, chunk.start + chunk.size));

    const keyword = new TextEncoder().encode(PACKAGE_KEY);
    const text = new TextEncoder().encode(JSON.stringify(data));
    const payload = concat([keyword, new Uint8Array([0]), text]);
    const type = new Uint8Array([0x74, 0x45, 0x58, 0x74]); // tEXt
    const crcInput = concat([type, payload]);
    const crc = crc32(crcInput);
    const head = new Uint8Array(8);
    head[0] = (payload.length >>> 24) & 0xff;
    head[1] = (payload.length >>> 16) & 0xff;
    head[2] = (payload.length >>> 8) & 0xff;
    head[3] = payload.length & 0xff;
    head.set(type, 4);
    const tail = new Uint8Array(4);
    tail[0] = (crc >>> 24) & 0xff;
    tail[1] = (crc >>> 16) & 0xff;
    tail[2] = (crc >>> 8) & 0xff;
    tail[3] = crc & 0xff;
    const chunk = concat([head, payload, tail]);

    // IEND 必须留在最后；没有 IEND 的 PNG 本身就不合法
    const iendIndex = kept.findIndex((part) => chunkType(part, 0) === "IEND");
    const result = iendIndex >= 0
        ? concat([...kept.slice(0, iendIndex), chunk, ...kept.slice(iendIndex)])
        : concat([...kept, chunk]);
    return concat([PNG_SIGNATURE, result]);
}

/** PNG 成品的字节 → 可写入思源 / 可当 Blob 的 Uint8Array */
export async function pngBytesOf(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer());
}
