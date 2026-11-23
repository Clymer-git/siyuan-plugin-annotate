/**
 * 统一的配置存储层。
 *
 * 以前各模块直接写 localStorage —— 数据落在浏览器的 WebStorage 里，
 * 工作空间的 `data/storage/petal/siyuan-plugin-annotate/data.json` 里什么都看不到，
 * 换设备 / 清缓存就丢。
 *
 * 现在统一走思源插件官方的 saveData / loadData：
 * - 启动时由插件把读到的对象灌进来（hydrate）
 * - 各模块读写仍然用同步接口（readItem / writeItem），内部是内存缓存 + 防抖落盘
 * - 落盘一次写整个对象，写进 petal 目录下的 data.json
 */

type Flush = (payload: Record<string, string>) => void | Promise<void>;

let flush: Flush | null = null;
let cache: Record<string, string> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY = 300;

/** 插件启动时接入官方 API；payload 里带着上次存下的所有键值 */
export function attachStorage(persisted: unknown, save: Flush): void {
    flush = save;
    cache = {};
    if (!persisted || typeof persisted !== "object") return;
    for (const [key, value] of Object.entries(persisted as Record<string, unknown>)) {
        if (typeof value === "string") {
            cache[key] = value;
        } else if (value !== undefined && value !== null) {
            // 允许直接存对象，读的时候统一成字符串
            cache[key] = JSON.stringify(value);
        }
    }
}

/** 读：先看内存缓存，没有就退回老版本留在 localStorage 里的数据（平滑迁移） */
export function readItem(key: string): string | null {
    if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** 写：内存立刻生效，磁盘防抖落盘；不依赖调用方 await */
export function writeItem(key: string, value: string): void {
    cache[key] = value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        safeFlush();
    }, FLUSH_DELAY);
}

/** 老 localStorage 里的键（迁移用）；没有就返回空对象 */
function legacySnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(PREFIX)) continue;
            const value = localStorage.getItem(key);
            if (value !== null && cache[key] === undefined) out[key] = value;
        }
    } catch {
        // 隐私模式没有 localStorage，忽略
    }
    return out;
}

export const PREFIX = "siyuan-plugin-annotate";

/** 立刻落盘（关闭编辑器等时机调用，避免最后一次改动丢在防抖窗口里） */
export function flushStorage(): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    safeFlush();
}

/** 落盘并吞掉异常：测试环境或宿主没提供 saveData 时不能把界面带崩 */
function safeFlush(): void {
    try {
        const result = flush?.({...cache, ...legacySnapshot()});
        if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch(() => {});
        }
    } catch {
        // 忽略
    }
}
