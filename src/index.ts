/**
 * 勾画阁·猫抓（siyuan-plugin-annotate）插件入口。
 *
 * 依据 siyuan-master 的 Windows 端源码：
 * - app/src/menus/protyle.ts:1599-1612   open-menu-image 触发时主菜单已构建好，popup() 在事件之后
 * - app/src/plugin/EventBus.ts:14-31     detail.menu 是插件专属 subMenu；只有往里加了项，
 *   才会 append 名为「插件」的二级菜单
 * - app/src/menus/Menu.ts:646-660       addItem 的 index 指分隔符下标，index:1 表示靠前插入
 * - app/src/menus/Menu.ts:866-872       菜单项的 id 落在 DOM 的 data-id 上，可用于防重复
 * - app/src/types/index.d.ts:1008-1029  IMenu 字段（addItem 的参数结构）
 * - app/src/plugin/API.ts:411-460       Plugin / Dialog / getFrontend 等导出
 *
 * 注意：detail 里没有 src、没有 blockId，两者都要从 detail.element 自行解析。
 */

import {Plugin, getFrontend, showMessage} from "siyuan";
import {readImageTarget, supportsFrontend, type ImageTarget} from "./platform";
import {AnnotEditor, THEME_STORAGE_KEY} from "./editor/AnnotEditor";
import {DocumentPreview} from "./editor/preview";
import {QuickEntry, ICON_PATH, ICON_VIEWBOX} from "./quickEntry";

const ROOT_SELECTOR = '[data-annot-plugin-root="siyuan-plugin-annotate"]';

const EVENT_OPEN_MENU_IMAGE = "open-menu-image";
const MENU_ITEM_ID = "siyuan-plugin-annotate__open";

export default class AnnotatePlugin extends Plugin {
    private editor: AnnotEditor | null = null;
    private preview: DocumentPreview | null = null;
    private quickEntry: QuickEntry | null = null;

    onload(): void {
        // 桌面端与移动端都注册：移动端长按图片同样会走 open-menu-image。
        let frontend = "";
        try {
            frontend = getFrontend();
        } catch {
            return;
        }
        if (!supportsFrontend(frontend)) return;

        this.eventBus.on(EVENT_OPEN_MENU_IMAGE, this.handleOpenMenuImage);
        // 图片上的快捷入口：PC 悬停 / 移动端轻点图片时，跟着原生按钮组一起出现
        if (!this.quickEntry) {
            this.quickEntry = new QuickEntry(
                (target) => this.openEditor(target),
                () => this.i18n?.openEditor || "勾画阁·猫抓 编辑",
            );
            this.quickEntry.start();
        }
        // 文档内只读预览：只为升级前、还没转成新 PNG 封装的老图服务
        if (!this.preview) {
            this.preview = new DocumentPreview();
            this.preview.start();
        }
    }

    onunload(): void {
        this.eventBus.off(EVENT_OPEN_MENU_IMAGE, this.handleOpenMenuImage);
        this.quickEntry?.stop();
        this.quickEntry = null;
        this.preview?.destroy();
        this.preview = null;
        this.closeEditor();
        // 兜底：即使编辑器曾被异常中断，也把挂在页面上的浮层清干净。
        // 这里不假设一定有 DOM（某些宿主会在卸载阶段提前销毁文档）。
        if (typeof document !== "undefined") {
            document.querySelectorAll(ROOT_SELECTOR).forEach((element) => element.remove());
        }
    }

    uninstall(): void {
        this.onunload();
        try {
            localStorage.removeItem(THEME_STORAGE_KEY);
        } catch {
            // 隐私模式下 localStorage 不可用
        }
    }

    private readonly handleOpenMenuImage = (event: CustomEvent): void => {
        const detail = event?.detail as any;
        if (!detail) return;

        const target = readImageTarget(detail);
        if (!target) return;

        // 菜单项带上「编辑」，让人一眼知道点它是打开编辑器
        const label = this.i18n?.openEditor || "勾画阁·猫抓 编辑";
        const menuItem = {
            id: MENU_ITEM_ID,
            // 菜单项只认思源内置图标名：用「编辑」那支笔，和悬浮按钮的画板笔是一套语义
            icon: "iconEdit",
            label,
            // 放到靠前的分组，右键后一眼就能看见，不必往下翻
            index: 1,
            click: () => {
                // detail / element 只在菜单打开期间有效，这里重新解析一次更安全
                const fresh = readImageTarget(detail) ?? target;
                this.openEditor(fresh);
            },
        };

        // 主菜单：菜单项直接出现在右键菜单第一层。
        // 不往 detail.menu（插件 subMenu）里写任何东西，思源就不会生成「插件」二级菜单。
        const globalMenu = typeof window !== "undefined" ? window.siyuan?.menus?.menu : undefined;
        if (globalMenu && typeof globalMenu.addItem === "function") {
            const host = globalMenu.element as HTMLElement | undefined;
            // 同一个菜单被重复派发事件时不插入第二遍
            if (host?.querySelector?.(`[data-id="${MENU_ITEM_ID}"]`)) return;
            globalMenu.addItem(menuItem);
            this.patchMenuIcon(host);
            return;
        }

        // 兜底：极老版本没有全局菜单实例时，退回插件 subMenu（此时会回到二级菜单）
        const subMenu = detail.menu;
        if (subMenu && typeof subMenu.addItem === "function") {
            subMenu.addItem(menuItem);
        }
    };

    /**
     * 把菜单项前面的图标换成和悬浮按钮同一个。
     *
     * 思源菜单项的 icon 只认内置图标名（塞不进自定义 SVG），所以先用内置的「编辑笔」
     * 占住那个 svg 元素，等菜单 DOM 生成后再把里面的 <use> 换掉 —— 两头才是同一张图。
     */
    private patchMenuIcon(host?: HTMLElement): void {
        const apply = (): boolean => {
            const svg = host?.querySelector<SVGSVGElement>(`[data-id="${MENU_ITEM_ID}"] svg`);
            if (!svg) return false;
            svg.setAttribute("viewBox", ICON_VIEWBOX);
            svg.removeAttribute("width");
            svg.removeAttribute("height");
            svg.innerHTML = ICON_PATH;
            return true;
        };
        // 菜单往往在 popup() 里才挂上 DOM，补一拍再试
        if (!apply() && typeof setTimeout === "function") setTimeout(apply, 40);
    }

    private openEditor(target: ImageTarget): void {
        // 同一次只允许一个编辑器；重复打开时先干净地关掉旧的
        this.closeEditor();
        try {
            this.editor = new AnnotEditor({
                target,
                i18n: this.i18n ?? {},
                onClosed: () => {
                    this.editor = null;
                },
            });
        } catch (error) {
            this.editor = null;
            showMessage("勾画阁·猫抓：编辑器打开失败，请查看控制台", 5000, "error");
            // 只在真正异常时输出，正常反复开合不会污染控制台
            console.error("[siyuan-plugin-annotate] openEditor failed", error);
        }
    }

    private closeEditor(): void {
        if (!this.editor) return;
        const editor = this.editor;
        this.editor = null;
        editor.close();
    }
}
