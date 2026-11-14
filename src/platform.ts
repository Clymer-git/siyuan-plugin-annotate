/**
 * 思源平台适配层。
 * 依据 siyuan-master 的 Windows 端源码：
 * - app/src/menus/protyle.ts:1601  open-menu-image 只给 protyle / element
 * - app/src/asset/renderAssets.ts:79  图片是 <span data-type="img"> 内的 <img src="assets/...">
 * - app/src/protyle/util/hasClosest.ts:107  块 ID 来自最近的 [data-node-id]
 * - kernel/server/serve.go:1117   assets/xxx.png 通过 /assets/xxx.png 访问
 * - kernel/apicontract/file.go      /api/file/getFile、/api/file/putFile
 */

/** 桌面端（含浏览器桌面版）：用鼠标 + 多栏布局 */
export function isDesktopFrontend(frontend: string): boolean {
    return frontend === "desktop" || frontend === "desktop-window" || frontend === "browser-desktop";
}

/** 移动端（Android / iOS / 手机浏览器）：用触摸 + 单栏布局 */
export function isMobileFrontend(frontend: string): boolean {
    return frontend === "mobile" || frontend === "browser-mobile";
}

/** 桌面端与移动端都支持；其它前端（如 iPad 分屏的特殊值）不注册事件 */
export function supportsFrontend(frontend: string): boolean {
    return isDesktopFrontend(frontend) || isMobileFrontend(frontend);
}

/**
 * 运行环境是不是触摸为主的窄屏。
 *
 * 不只看 getFrontend()：思源移动端 WebView 里 getFrontend() 也可能返回 mobile，
 * 但更稳的判断是「粗指针 + 窄屏」——这样平板、手机浏览器、桌面窗口缩窄都能各自合适。
 */
export function isMobileRuntime(): boolean {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    const coarse = typeof window.matchMedia === "function"
        && window.matchMedia("(pointer: coarse)").matches;
    // 有些宿主（含测试环境）拿不到 innerWidth，此时按桌面处理，避免误判成手机
    const width = window.innerWidth || document.documentElement?.clientWidth || 0;
    const narrow = width >= 320 && width < 720;
    return coarse || narrow;
}

/** 把 img 上的 src 归一化成思源资源路径 assets/xxx.png；非资源图返回空串 */
export function normalizeAssetPath(raw: string): string {
    if (!raw) return "";
    let value = raw.trim();
    // 去掉查询串，但保留扩展名
    const qIndex = value.indexOf("?");
    if (qIndex >= 0) value = value.slice(0, qIndex);
    value = value.replace(/\\/g, "/");
    value = value.replace(/^\/+/, "");
    if (value.startsWith("data/")) value = value.slice(5);
    const pos = value.indexOf("assets/");
    if (pos >= 0) value = value.slice(pos);
    if (!value.startsWith("assets/")) return "";
    return value;
}

/** 把笔记里的图片地址转成浏览器可直接用于 <img src> 的地址 */
export function resolveImageUrl(raw: string): string {
    const value = (raw || "").trim();
    if (!value) return "";
    if (/^(data:|blob:|https?:\/\/|file:\/\/)/i.test(value)) return value;
    let path = value.replace(/\\/g, "/").replace(/^\/+/, "");
    if (path.startsWith("data/")) path = path.slice(5);
    const pos = path.indexOf("assets/");
    if (pos >= 0) path = path.slice(pos);
    return "/" + path;
}

export interface ImageTarget {
    /** 笔记里的原始地址，如 assets/xxx.png */
    assetPath: string;
    /** 浏览器可加载地址 */
    url: string;
    /** 图片所在块 ID（sidecar 的主关联键） */
    blockId: string;
    /** 当前编辑器实例，后续插入导出图片时要用 */
    protyle: unknown;
    /**
     * 图片在笔记里的自定义显示宽度（用户在正文里拖过图片右下角）。
     * 思源把它存成图片的行内 IAL：`![](assets/x.png){: style="width: 300px;"}`。
     * 换图时必须把它带过去，否则「缩放过」的图片会弹回原始宽度（v0.9.1 修的）。
     */
    displayWidth: string;
    /** 图片的替代文字（非文件名时才带过去） */
    alt: string;
    /** 图片图注（思源的 <img data-title>），换图时随 markdown 一起带过去 */
    title: string;
    /**
     * 图片是不是「独占一个段落」（段落里除了这张图没有别的文字）。
     * 只有这种情况下才敢用 updateBlock 把段落内容换成新图片，
     * 否则会把同段落的文字一起冲掉，宁可只保存标注。
     */
    pureImage: boolean;
}

/**
 * 文档内只读预览层的类名。
 * 它被塞在图片所在段落内部，里面会有文字标注 —— 统计「段落里还有没有别的文字」
 * 时必须把它排除掉，否则「图上已经有标注文字」会被误判成图文混排，
 * 导致旋转/裁切不再写回笔记图片（v0.7.1 实测踩到）。
 */
export const DOC_OVERLAY_CLASS = "annot-doc-overlay";

/**
 * 统计块内的「正文文字」，用来判断图片是不是独占一段。
 *
 * 必须排除两类东西：
 * 1. 插件自己的文档预览层（里面有标注文字）；
 * 2. 图片自身的 DOM —— 思源会把图注渲染成 `.protyle-action__title`（里面有文本），
 *    还有拖拽点 / 更多按钮。不排除的话，「图片 + 图注」会被当成图文混排，
 *    裁切 / 旋转就不会写回笔记里的图片（v0.9.8 用户实测踩到）。
 *
 * 做法是克隆一份、把这两类整棵删掉再读文本，比逐个节点递归更不容易漏。
 * 测试替身可能没有 cloneNode，退回 textContent。
 */
function blockTextExcludingOverlay(block: HTMLElement | null): string {
    if (!block) return "";
    const clone = (block as unknown as {cloneNode?: (deep: boolean) => HTMLElement}).cloneNode;
    if (typeof clone !== "function") return block.textContent || "";
    try {
        const copy = clone.call(block, true);
        copy.querySelectorAll(`[data-type="img"], .${DOC_OVERLAY_CLASS}`).forEach((el) => el.remove());
        return copy.textContent || "";
    } catch {
        return block.textContent || "";
    }
}

/**
 * 读出图片的自定义显示宽度。
 *
 * 思源现在的做法（app/src/protyle/wysiwyg/index.ts:2094）：把宽度写在包着 <img> 的那个
 * span 的 style 上；旧的 3.1.15 以前可能写在 <img> 或 .img 容器上。三个位置都看一下，
 * 因为用户升级过来的老笔记什么写法都有可能。
 */
function imageDisplayWidth(img: Element): string {
    const pick = (el: HTMLElement | null): string => (el?.style?.width || "").trim();
    const inner = img.parentElement as HTMLElement | null;
    const box = (typeof img.closest === "function" ? img.closest('span[data-type="img"]') : null) as HTMLElement | null;
    const width = pick(inner) || pick(img as HTMLElement) || pick(box);
    if (width) return width;
    // 更老的写法是 width="300" 属性
    const attr = (img.getAttribute("width") || "").trim();
    return /^\d+(\.\d+)?$/.test(attr) ? `${attr}px` : "";
}

/** 图注 / 替代文字：只有真的写过内容（不是自动带的文件名）才值得带过去 */
function imageAltText(img: Element, assetPath: string): string {
    const alt = (img.getAttribute("alt") || "").trim();
    if (!alt) return "";
    // 有些场景会往 alt 里塞地址，那种不可能是图注，别当真
    if (/[/\\?]/.test(alt)) return "";
    const stem = (assetPath.split("/").pop() || "").replace(/\.[^.]+$/, "");
    return alt === stem ? "" : alt;
}

/**
 * 图注：思源存在 <img data-title>（app/src/protyle/render/imageTitle.ts），
 * markdown 里是 `![alt](src "图注")`。换图时要原样带过去，否则用户的图注会消失。
 */
function imageTitleText(img: Element): string {
    const title = (img.getAttribute("data-title") || img.getAttribute("title") || "").trim();
    if (!title) return "";
    // 塞进地址/链接的标题不算图注，别跟着换
    if (/^[/\\]*(assets|data|https?:)/i.test(title)) return "";
    return title;
}

/**
 * 从 open-menu-image 的 detail.element 解析图片信息。
 * 注意：detail 里没有 src 字段，也没有 blockId，必须自行向上找 [data-node-id]。
 */
export function readImageTarget(detail: any): ImageTarget | null {
    const element = detail?.element as HTMLElement | undefined | null;
    if (!element || typeof element.querySelector !== "function") return null;
    const img = element.querySelector("img");
    if (!img) return null;

    // 思源用 data-src 保存规范资源路径，src 可能带 ?v= 缓存串
    const raw = img.getAttribute("data-src") || img.getAttribute("src") || "";
    const assetPath = normalizeAssetPath(raw);
    const url = resolveImageUrl(raw);
    if (!url) return null;

    const block = element.closest("[data-node-id]") as HTMLElement | null;
    const blockId = block?.getAttribute("data-node-id") || "";
    // 图片本身没有文字，段落里还剩文字就说明是「图文混排」；
    // 另外只有段落能整段换成图片，列表项/表格单元格之类换了会破坏结构。
    const blockText = blockTextExcludingOverlay(block).replace(/[\s\u200b]+/g, "");
    const blockType = block?.getAttribute("data-type") || "";
    const pureImage = blockText.length === 0 && (blockType === "" || blockType === "NodeParagraph");

    return {
        assetPath, url, blockId,
        protyle: detail?.protyle ?? null,
        displayWidth: imageDisplayWidth(img),
        alt: imageAltText(img, assetPath),
        title: imageTitleText(img),
        pureImage,
    };
}

/** 用公开 API 读取资源文件二进制；马赛克采样、PNG 导出、sidecar 读取都会用到 */
export async function getFileBlob(path: string): Promise<Blob> {
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({path}),
    });
    if (!response.ok) {
        throw new Error(`读取文件失败：${path}（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
        throw new Error(`文件为空：${path}`);
    }
    return blob;
}

/** 用公开 API 写入文件（FormData 字段名以 kernel/apicontract/file.go 为准） */
export async function putFile(path: string, file: Blob, fileName: string): Promise<void> {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", "false");
    form.append("modTime", String(Date.now()));
    form.append("file", file, fileName);
    const response = await fetch("/api/file/putFile", {method: "POST", body: form});
    if (!response.ok) {
        throw new Error(`写入文件失败：${path}（HTTP ${response.status}）`);
    }
}

/** 用 /upload 上传资源，返回 assets/xxx 路径（内核与 /api/asset/upload 等价） */export async function uploadAsset(file: Blob, fileName: string, docId?: string): Promise<string> {
    const form = new FormData();
    form.append("file[]", file, fileName);
    if (docId) form.append("id", docId);
    const response = await fetch("/upload", {method: "POST", body: form});
    const result = await response.json();
    const succMap = result?.data?.succMap as Record<string, string> | undefined;
    const found = succMap?.[fileName] ?? Object.values(succMap ?? {})[0];
    if (!found) throw new Error("上传图片失败：内核未返回资源路径");
    return found;
}

/** 块属性（IAL）：`/api/attr/getBlockAttrs` 返回的扁平结构 */
export type BlockAttrs = Record<string, string>;

export async function getBlockAttrs(blockId: string): Promise<BlockAttrs> {
    try {
        const response = await fetch("/api/attr/getBlockAttrs", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({id: blockId}),
        });
        if (!response.ok) return {};
        const result = await response.json();
        const data = result?.data;
        return data && typeof data === "object" ? data as BlockAttrs : {};
    } catch {
        return {};
    }
}

async function setBlockAttrs(blockId: string, attrs: BlockAttrs): Promise<void> {
    const response = await fetch("/api/attr/setBlockAttrs", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: blockId, attrs}),
    });
    if (!response.ok) throw new Error(`写回块属性失败（HTTP ${response.status}）`);
    const result = await response.json();
    if (result && typeof result.code === "number" && result.code !== 0) {
        throw new Error(result.msg || "写回块属性失败");
    }
}

/** 换图时要原样带回的块属性（id / updated 由内核自己维护，不要碰） */
function restorableAttrs(attrs: BlockAttrs): BlockAttrs {
    const out: BlockAttrs = {};
    for (const [key, value] of Object.entries(attrs || {})) {
        if (key === "id" || key === "updated") continue;
        if (typeof value !== "string" || !value) continue;
        out[key] = value;
    }
    return out;
}

/**
 * 把某个块的内容换成一张图片（块 ID 保持不变）。
 *
 * 依据 kernel/api/block_op.go:636 与 kernel/model/block_update.go：/api/block/updateBlock
 * 接受 {id, data, dataType}，dataType 支持 markdown / dom；用 markdown 传 `![](...)`
 * 就是笔记里图片块本来的写法，内核会原地更新同一个块（IAL、块 ID 都保留）。
 *
 * 两个必须手动带过去的东西（v0.9.1）：
 * - **图片的显示宽度**：思源存成图片的行内 IAL `![](x.png){: style="width: 300px;"}`，
 *   而 updateBlock 是整段重新解析，不写就会丢 —— 用户会觉得「我缩过的图又变回默认大小了」；
 * - **块自身的属性**（居中、自定义属性等）：doUpdate 只补 id，其余 IAL 会一起丢，
 *   所以更新前后各取一次属性，把非 id/updated 的原样写回。
 */
export async function replaceBlockImage(
    blockId: string,
    assetPath: string,
    options: {width?: string; alt?: string; title?: string} = {},
): Promise<void> {
    const before = await getBlockAttrs(blockId);
    const alt = (options.alt || "").replace(/[[\]\\]/g, "");
    // 图注用双引号包在地址后面；图注里本身有双引号时换成单引号，避免把 markdown 拆坏
    const title = (options.title || "").replace(/"/g, "'").trim();
    const width = (options.width || "").trim();
    // 行内 IAL：紧跟在图片后面，作用在这张图上
    const ial = width ? `{: style="width: ${width};"}` : "";
    const data = `![${alt}](${assetPath}${title ? ` "${title}"` : ""})${ial}`;

    const response = await fetch("/api/block/updateBlock", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: blockId, dataType: "markdown", data}),
    });
    if (!response.ok) {
        throw new Error(`更新笔记图片失败（HTTP ${response.status}）`);
    }
    const result = await response.json();
    if (result && typeof result.code === "number" && result.code !== 0) {
        throw new Error(result.msg || "更新笔记图片失败");
    }

    // 块属性丢了就补回去；补失败不影响图片本身，只是少了个对齐方式
    const restore = restorableAttrs(before);
    if (Object.keys(restore).length) {
        try {
            await setBlockAttrs(blockId, restore);
        } catch {
            // 忽略：图片已经换好，属性尽力而为
        }
    }
}

/**
 * 覆盖同名资源之后，让正文里的图片立刻重新加载（v0.10.5 的做法，v0.10.11 恢复）。
 *
 * 只给 img.src 加一个缓存串：data-src、笔记内容、图片宽度、图注、块属性全都不动，
 * 所以图片和文字在同一段里也绝对安全。
 *
 * 已知代价：src 带上 `?v=` 之后，思源双击看图时用 `src.endsWith(资源路径)` 定位会失败
 * （app/src/protyle/preview/image.ts:29），查看器可能显示空白。这一点已与用户确认，
 * 现阶段优先保证「保存后正文立刻刷新、且不产生新资源」。
 */
export function refreshImageSrc(assetPath: string): void {
    if (typeof document === "undefined" || !assetPath) return;
    const stamp = `?v=${Date.now()}`;
    document.querySelectorAll<HTMLImageElement>("img[data-src]").forEach((img) => {
        const current = normalizeAssetPath(img.getAttribute("data-src") || "");
        if (current !== assetPath) return;
        const raw = img.getAttribute("src") || img.getAttribute("data-src") || assetPath;
        img.setAttribute("src", `${raw.split("?")[0]}${stamp}`);
    });
}
