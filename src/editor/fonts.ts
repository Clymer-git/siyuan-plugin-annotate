/**
 * 文字工具的字体来源（重构版：参考 imgReEditor 的「一个字体列表」思路）。
 *
 * 不做「档位」这套抽象，就是一个列表：
 *   · 「默认」＝不指定字体，跟随思源正文（导出时解析成实际字体栈）；
 *   · 系统里装了什么就列什么；
 *   · 用户自己上传的字体单独一组，存在思源数据目录里，多端同步可用。
 *
 * 插件**不打包任何字体文件**，所以包体积不增加，也不存在再分发授权问题。
 */

import {getFileBlob, putFile, readDir, removeFile} from "../platform";

export interface FontEntry {
    /** CSS 家族名（上传字体用 Annot-xxxx，避免和系统字体重名） */
    family: string;
    /** 下拉里显示的名字 */
    label: string;
    source: "system" | "upload";
    /** 上传字体的存储路径（导出内嵌时要用） */
    path?: string;
}

/** 什么都不选＝默认：跟随思源正文 */
export const DEFAULT_FONT_KEY = "";

/** 上传字体放这里：跟着思源数据目录同步，换设备也在 */
const FONT_DIR = "data/storage/petal/siyuan-plugin-annotate/fonts";
const INDEX_PATH = `${FONT_DIR}/index.json`;
/** 只放行这四种：ttc 是「字体集合」，网页标准引用不了，放进来只会让用户白折腾 */
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
/** 单个字体文件上限：字体要跟着思源同步，太大既慢又占空间 */
const MAX_FONT_BYTES = 20 * 1024 * 1024;

/** 上传字体时的可读错误：调用方直接拿 message 提示用户 */
export class FontUploadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FontUploadError";
    }
}

/** family -> 信息；导出内嵌字体时按它找文件 */
const uploaded = new Map<string, {path: string; label: string}>();

/** 探针表达式：变量存在就用思源的，不存在退回通用族 */
const BODY_PROBE = 'var(--b3-font-family, system-ui, sans-serif)';
const CODE_PROBE = 'var(--b3-font-family-code, ui-monospace, SFMono-Regular, monospace)';

let bodyCache: string | null = null;
let codeCache: string | null = null;
/**
 * 英文族名 → 中文名。
 *
 * Windows 的字体接口会返回本地化全名（微软雅黑），Mac 上部分字体只有英文族名，
 * 这个表是兜底：只补常见的系统自带 / 开源中文字体，不打包任何字体文件。
 */
const FONT_CN_NAMES: Record<string, string> = {
    "Microsoft YaHei": "微软雅黑",
    "Microsoft YaHei UI": "微软雅黑 UI",
    "Microsoft JhengHei": "微软正黑体",
    "SimSun": "宋体",
    "NSimSun": "新宋体",
    "SimHei": "黑体",
    "KaiTi": "楷体",
    "FangSong": "仿宋",
    "DengXian": "等线",
    "PingFang SC": "苹方-简",
    "PingFang TC": "苹方-繁",
    "Hiragino Sans GB": "冬青黑体简体中文",
    "Heiti SC": "黑体-简",
    "STHeiti": "华文黑体",
    "Songti SC": "宋体-简",
    "STSong": "华文宋体",
    "Kaiti SC": "楷体-简",
    "STKaiti": "华文楷体",
    "Yuanti SC": "圆体-简",
    "Lantinghei SC": "兰亭黑-简",
    "Source Han Sans SC": "思源黑体",
    "Source Han Serif SC": "思源宋体",
    "Noto Sans SC": "思源黑体",
    "Noto Serif SC": "思源宋体",
    "Noto Sans CJK SC": "思源黑体",
    "HarmonyOS Sans SC": "鸿蒙黑体",
    "MiSans": "小米兰亭 Pro",
    "Alibaba PuHuiTi": "阿里巴巴普惠体",
    "Smiley Sans": "得意黑",
    "LXGW WenKai": "霞鹜文楷",
    "WenQuanYi Micro Hei": "文泉驿微米黑",
};

/** 是否含中日韩文字 */
const CJK = /[\u3400-\u9fbf]/;

/**
 * 下拉里显示什么名字：优先带中文的那个（本地化全名或映射表），
 * 都没有才退回英文族名。**存进对象、传给 CSS 的始终是 family**。
 */
function pickLabel(family: string, fullName?: string): string {
    const local = (fullName ?? "").trim();
    const mapped = FONT_CN_NAMES[family];
    if (local && CJK.test(local)) return local;
    if (mapped) return mapped;
    return local || family;
}

let systemFontsCache: FontEntry[] | null = null;

/**
 * 候选字体池：本地字体接口不可用时，用 Canvas 度量法逐个试探。
 * 只列名字探测系统装没装，不分发任何字体文件。
 */
const SYSTEM_CANDIDATES = [
    "Microsoft YaHei", "Microsoft YaHei UI", "Microsoft JhengHei", "SimSun", "NSimSun",
    "SimHei", "KaiTi", "FangSong", "DengXian",
    "PingFang SC", "PingFang TC", "Hiragino Sans GB", "Heiti SC", "STHeiti",
    "Songti SC", "STSong", "Kaiti SC", "STKaiti", "Yuanti SC", "Lantinghei SC",
    "Source Han Sans SC", "Source Han Serif SC", "Noto Sans SC", "Noto Serif SC",
    "Noto Sans CJK SC", "HarmonyOS Sans SC", "MiSans", "Alibaba PuHuiTi",
    "Smiley Sans", "LXGW WenKai", "WenQuanYi Micro Hei",
    "Arial", "Arial Black", "Helvetica", "Helvetica Neue", "Verdana", "Tahoma",
    "Trebuchet MS", "Segoe UI", "Calibri", "Candara", "Corbel", "Optima",
    "Avenir", "Avenir Next", "Futura", "Century Gothic", "Gill Sans",
    "Times New Roman", "Georgia", "Cambria", "Constantia", "Palatino", "Palatino Linotype",
    "Garamond", "Baskerville", "Book Antiqua",
    "Consolas", "Courier New", "Menlo", "Monaco", "JetBrains Mono", "Fira Code",
    "Cascadia Code", "Source Code Pro", "Roboto Mono", "Comic Sans MS", "Impact",
];

/** 默认档的真实字体栈（跟随思源正文） */
export function bodyFontStack(): string {
    if (bodyCache === null) {
        let resolved = readFontFamily(BODY_PROBE);
        // 探针拿到浏览器默认衬线体，说明思源变量没生效，退回 body 自己的字体
        if (!resolved || /times new roman/i.test(resolved)) {
            resolved = readFontFamily("inherit") || resolved;
        }
        bodyCache = resolved || "system-ui, sans-serif";
    }
    return bodyCache;
}

/** 等宽档（老数据里存了 "code" 的仍能用） */
export function codeFontStack(): string {
    if (codeCache === null) codeCache = readFontFamily(CODE_PROBE) || "ui-monospace, monospace";
    return codeCache;
}

/** 默认档显示成什么名字 */
export function defaultFontLabel(): string {
    const name = firstFamily(bodyFontStack());
    return name ? `默认 · ${name}` : "默认";
}

/** 用探针元素让浏览器把 var() 解析成真实字体栈 */
function readFontFamily(value: string): string {
    if (typeof document === "undefined") return "";
    try {
        const probe = document.createElement("span");
        probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;font-family:${value}`;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).fontFamily;
        probe.remove();
        return resolved && resolved !== "inherit" ? resolved : "";
    } catch {
        return "";
    }
}

function firstFamily(stack: string): string {
    if (!stack) return "";
    const generic = new Set([
        "system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy",
        "ui-monospace", "ui-sans-serif", "ui-serif", "inherit", "initial",
        "-apple-system", "blinkmacsystemfont",
    ]);
    for (const part of stack.split(",")) {
        const name = part.trim().replace(/^["']|["']$/g, "");
        if (!name) continue;
        if (generic.has(name.toLowerCase())) continue;
        return name;
    }
    return "";
}

/**
 * 键 → CSS font-family。
 * **必须返回具体字体栈**，不能留 var()：导出成品图时 SVG 是当图片渲染的，
 * 读不到页面变量，字体就会掉回默认。
 */
export function fontStackOf(key: string | undefined): string {
    if (!key) return bodyFontStack();
    if (key === "code") return codeFontStack();
    // 老的档位键（老图里可能存着），继续给对的字体
    const legacy: Record<string, string> = {
        sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        serif: 'Georgia, "Songti SC", serif',
        kai: '"Kaiti SC", KaiTi, STKaiti, serif',
        round: '"Yuanti SC", YouYuan, sans-serif',
    };
    if (legacy[key]) return legacy[key];
    // 老数据里存了完整字体栈
    if (/[",]/.test(key)) return key;
    // 系统字体名 / 上传字体名
    return `"${key}", system-ui, sans-serif`;
}

/** 下拉里显示的名字 */
export function fontLabelOf(family: string | undefined): string {
    if (!family) return defaultFontLabel();
    if (family === "code") return "思源等宽";
    return uploaded.get(family)?.label ?? family;
}

/** 探测系统里装了哪些字体（Canvas 度量法，几十个候选一次几毫秒） */
export function detectSystemFonts(): FontEntry[] {
    if (systemFontsCache) return systemFontsCache;
    const found: FontEntry[] = [];
    try {
        if (typeof document === "undefined") {
            systemFontsCache = [];
            return systemFontsCache;
        }
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx || typeof ctx.measureText !== "function") {
            systemFontsCache = [];
            return systemFontsCache;
        }
        const sample = "mmmmmmmmmmlli永和九年岁在癸丑";
        const bases = ["monospace", "serif", "sans-serif"];
        const widths: number[] = [];
        for (const base of bases) {
            ctx.font = `32px ${base}`;
            widths.push(ctx.measureText(sample).width);
        }
        for (const family of SYSTEM_CANDIDATES) {
            for (let i = 0; i < bases.length; i++) {
                ctx.font = `32px "${family}", ${bases[i]}`;
                if (Math.abs(ctx.measureText(sample).width - widths[i]) > 0.5) {
                    found.push({family, label: pickLabel(family), source: "system"});
                    break;
                }
            }
        }
    } catch {
        // 度量不可用就只留「默认」+ 上传字体，不影响使用
    }
    systemFontsCache = found;
    return found;
}

/**
 * Chromium 的本地字体接口：一次拿到系统全部字体，**并且带本地化全名**。
 * `fullName` 在中文系统上就是「微软雅黑」，所以 UI 能显示中文，
 * 而实际用于 CSS 的仍是 `family`（Microsoft YaHei）。
 */
export async function queryLocalFonts(): Promise<FontEntry[]> {
    const api = (window as unknown as {
        queryLocalFonts?: () => Promise<Array<{family?: string; fullName?: string}>>;
    }).queryLocalFonts;
    if (typeof api !== "function") return [];
    try {
        const list = await api.call(window);
        const seen = new Set<string>();
        const entries: FontEntry[] = [];
        for (const item of list ?? []) {
            const family = (item?.family ?? "").trim();
            if (!family || seen.has(family)) continue;
            seen.add(family);
            entries.push({family, label: pickLabel(family, item?.fullName), source: "system"});
        }
        return entries.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
    } catch {
        return [];
    }
}

/** 注册一个字体文件（上传字体靠它进入 CSS 字体集） */
async function registerFace(family: string, data: ArrayBuffer): Promise<boolean> {
    if (typeof document === "undefined" || !("fonts" in document)) return false;
    try {
        const face = new FontFace(family, data);
        await face.load();
        document.fonts.add(face);
        return true;
    } catch {
        return false;
    }
}

async function readIndex(): Promise<Record<string, {label: string; file: string}>> {
    try {
        const blob = await getFileBlob(INDEX_PATH);
        const data = JSON.parse(await blob.text());
        return data && typeof data === "object" ? data : {};
    } catch {
        return {};
    }
}

async function writeIndex(index: Record<string, {label: string; file: string}>): Promise<void> {
    try {
        await putFile(INDEX_PATH, new Blob([JSON.stringify(index)], {type: "application/json"}), "index.json");
    } catch {
        // 索引写不进去不影响字体本身可用
    }
}

/** 列出用户上传的字体（顺便注册到文档字体集） */
export async function loadUploadedFonts(): Promise<FontEntry[]> {
    if (typeof document === "undefined") return [];
    const files = await readDir(FONT_DIR);
    if (!files.length) return [];
    const index = await readIndex();
    const entries: FontEntry[] = [];
    for (const item of files) {
        if (item.isDir || !FONT_EXT.test(item.name)) continue;
        const family = item.name.replace(/\.[^.]+$/, "");
        const path = `${FONT_DIR}/${item.name}`;
        const label = index[family]?.label ?? family;
        if (!uploaded.has(family)) {
            try {
                const blob = await getFileBlob(path);
                const usable = await registerFace(family, await blob.arrayBuffer());
                if (!usable) continue;   // 文件坏了或格式不支持：不列出来，免得选了没反应
            } catch {
                continue;
            }
            uploaded.set(family, {path, label});
        }
        entries.push({family, label, source: "upload", path});
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
}

/**
 * 上传字体：存进 petal 目录（跟着思源同步），并立刻注册到当前文档。
 * 插件包里不含任何字体文件，包体积不受影响。
 */
export async function uploadFontFile(file: File): Promise<FontEntry> {
    if (!FONT_EXT.test(file.name)) {
        throw new FontUploadError("只支持 ttf、otf、woff、woff2 格式的字体");
    }
    if (file.size > MAX_FONT_BYTES) {
        const mb = (file.size / 1024 / 1024).toFixed(1);
        throw new FontUploadError(`字体文件太大（${mb} MB），请换一个 20 MB 以内的`);
    }
    const buffer = await file.arrayBuffer();
    if (!buffer.byteLength) {
        throw new FontUploadError("这个文件是空的，换一个字体文件试试");
    }
    const ext = (file.name.split(".").pop() || "ttf").toLowerCase();
    const family = `Annot-${hash32(buffer)}`;
    const fileName = `${family}.${ext}`;
    const path = `${FONT_DIR}/${fileName}`;
    // 先让浏览器试着加载：读不出来就说明文件损坏或格式不受支持，别白占同步空间
    const usable = await registerFace(family, buffer);
    if (!usable) {
        throw new FontUploadError("浏览器读不出这个字体，可能文件已损坏或格式不受支持");
    }
    await putFile(path, new Blob([buffer], {type: "application/octet-stream"}), fileName);
    const label = file.name.replace(/\.[^.]+$/, "");
    uploaded.set(family, {path, label});
    const index = await readIndex();
    index[family] = {label, file: fileName};
    await writeIndex(index);
    return {family, label, source: "upload", path};
}

/** 删除一个上传字体 */
export async function removeUploadedFont(family: string): Promise<void> {
    const info = uploaded.get(family);
    if (!info) return;
    try {
        await removeFile(info.path);
    } catch {
        // 文件已经不在了也继续清索引
    }
    uploaded.delete(family);
    const index = await readIndex();
    delete index[family];
    await writeIndex(index);
}

/** 这个字体是不是用户上传的（导出时要内嵌，系统字体不用） */
export function isUploadedFont(family: string | undefined): boolean {
    return !!family && uploaded.has(family);
}

/** 把一批字体打成 @font-face CSS（导出内嵌用；只处理上传字体） */
export async function buildFontFaceCss(families: string[]): Promise<string> {
    const seen = new Set<string>();
    const rules: string[] = [];
    for (const family of families) {
        if (!family || seen.has(family)) continue;
        const info = uploaded.get(family);
        if (!info) continue;
        seen.add(family);
        try {
            const blob = await getFileBlob(info.path);
            const base64 = toBase64(await blob.arrayBuffer());
            const ext = info.path.split(".").pop()?.toLowerCase();
            const format = ext === "woff2" ? "woff2" : ext === "woff" ? "woff"
                : ext === "otf" ? "opentype" : "truetype";
            rules.push(`@font-face{font-family:'${family}';src:url(data:font/${format};base64,${base64}) format('${format}');}`);
        } catch {
            // 文件读不到就别内嵌，导出会回退到系统字体
        }
    }
    return rules.join("");
}

function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** 文件内容哈希，给上传字体起一个稳定且不重名的家族名 */
function hash32(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hash = 0x811c9dc5;
    const step = Math.max(1, Math.floor(bytes.length / 4096));
    for (let i = 0; i < bytes.length; i += step) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

/** 主题 / 字体设置变化后清缓存 */
export function invalidateFontCache(): void {
    bodyCache = null;
    codeCache = null;
}

/** 导出兜底：万一 SVG 里还有 var() 字体，就地解析 */
export function inlineFontVars(markup: string): string {
    const attr = (stack: string): string =>
        stack.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const body = attr(bodyFontStack());
    const code = attr(codeFontStack());
    return markup
        .replace(/font-family="var\(--b3-font-family-code[^"]*"/g, `font-family="${code}"`)
        .replace(/font-family="var\(--b3-font-family[^"]*"/g, `font-family="${body}"`);
}
