/**
 * 主题映射。
 * 依据 siyuan-master/app/src/util/assets.ts:150-160 与 :476-483：
 * 思源把明暗写到 <html data-theme-mode="light|dark">，没有 body 明暗 class。
 * 这里只负责把"跟随思源"的结果写到编辑器根节点的 data-annot-theme，
 * 具体颜色全部由 public/index.css 里的 --annot-* → --b3-theme-* 映射完成。
 */

export type ThemeMode = "light" | "dark";
export type ThemePreference = "follow" | "light" | "dark";

export function detectSiYuanTheme(): ThemeMode {
    const html = document.documentElement;
    const attr = html.getAttribute("data-theme-mode");
    if (attr === "dark" || attr === "light") return attr;

    // 兜底：老版本/设置窗口里可能还没写入属性
    const appearance = window.siyuan?.config?.appearance;
    if (appearance) {
        if (appearance.modeOS) {
            return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
        return appearance.mode === 1 ? "dark" : "light";
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ThemeMode {
    if (preference === "follow") return detectSiYuanTheme();
    return preference;
}

/** 把主题写到根节点；CSS 里 [data-annot-theme=...] 会覆盖成对应配色 */
export function applyTheme(root: HTMLElement, preference: ThemePreference): void {
    root.setAttribute("data-annot-theme", resolveTheme(preference));
}

/**
 * 监听思源主题切换。切换外观时思源会重写 <html> 的属性，
 * 同时监听系统偏好，保证 modeOS=true 时也能实时跟随。
 * 返回的函数用于在关闭编辑器时彻底清理监听。
 */
export function watchTheme(root: HTMLElement, preference: () => ThemePreference): () => void {
    const refresh = () => applyTheme(root, preference());
    refresh();

    const observer = new MutationObserver((records) => {
        if (records.some((r) => r.attributeName === "data-theme-mode")) refresh();
    });
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme-mode"]});

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => refresh();
    if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onMediaChange);
    } else if (typeof (media as any).addListener === "function") {
        (media as any).addListener(onMediaChange);
    }

    return () => {
        observer.disconnect();
        if (typeof media.removeEventListener === "function") {
            media.removeEventListener("change", onMediaChange);
        } else if (typeof (media as any).removeListener === "function") {
            (media as any).removeListener(onMediaChange);
        }
    };
}
