/**
 * 本文件按 siyuan-master/app/src/plugin/API.ts 与 plugin/index.ts 的实际导出，
 * 为插件侧用到的少量 API 提供本地类型声明。
 * 之所以不直接依赖 npm 的 `siyuan` 包：那份声明版本与本工作区所读的
 * Windows 端源码可能不一致，这里以源码为准，避免"凭记忆"写错字段。
 */

declare module "siyuan" {
    /** app/src/menus/Menu.ts 的 subMenu：emitOpenMenu 注入到 event.detail.menu */
    export interface IPluginSubMenu {
        menus: IMenuItem[];
        addItem(menu: IMenuItem): void;
        addSeparator(index?: number, id?: string): void;
    }

    /** app/src/types/index.d.ts:1008-1029 的 IMenu */
    export interface IMenuItem {
        id?: string;
        label?: string;
        icon?: string;
        iconHTML?: string;
        iconClass?: string;
        accelerator?: string;
        click?: (element: HTMLElement, event: MouseEvent) => boolean | void | Promise<boolean | void>;
        disabled?: boolean;
        index?: number;
        type?: "separator" | "submenu" | "readonly" | "empty";
        submenu?: IMenuItem[];
        checked?: boolean;
        current?: boolean;
        warning?: boolean;
        bind?: (element: HTMLElement) => void;
    }

    export interface IEventBus {
        on(type: string, listener: (event: CustomEvent) => void): void;
        off(type: string, listener: (event: CustomEvent) => void): void;
        once(type: string, listener: (event: CustomEvent) => void): void;
    }

    export class Plugin {
        readonly name: string;
        displayName: string;
        i18n: Record<string, string>;
        eventBus: IEventBus;
        data: Record<string, unknown>;
        app: unknown;
        constructor(options: {
            app: unknown;
            name: string;
            displayName: string;
            i18n: Record<string, string>;
        });
        onload(): void | Promise<void>;
        onunload(): void | Promise<void>;
        onLayoutReady(): void | Promise<void>;
        uninstall(): void | Promise<void>;
        loadData(name: string): Promise<unknown>;
        saveData(name: string, data: unknown): Promise<unknown>;
        removeData(name: string): Promise<unknown>;
        addIcons(svg: string): void;
    }

    /** app/src/dialog/index.ts:61-76 的构造参数 */
    export interface IDialogOptions {
        title?: string;
        content: string;
        width?: string;
        height?: string;
        transparent?: boolean;
        positionId?: string;
        hideCloseIcon?: boolean;
        disableClose?: boolean;
        disableAnimation?: boolean;
        containerClassName?: string;
        beforeClose?: () => boolean;
        destroyCallback?: (options?: Record<string, unknown>) => void;
    }

    export class Dialog {
        element: HTMLElement;
        constructor(options: IDialogOptions);
        destroy(options?: Record<string, unknown>): void;
        resize(): void;
        bindInput(input: HTMLInputElement | HTMLTextAreaElement, enterEvent?: () => void, bindEnter?: boolean): void;
    }

    /** app/src/util/functions.ts:22-44 */
    export function getFrontend(): string;
    export function getBackend(): string;

    export function fetchPost(
        url: string,
        data?: unknown,
        callback?: (response: any) => void,
        headers?: Record<string, string>,
        failCallback?: (response: any) => void,
    ): Promise<void>;

    export function fetchSyncPost(url: string, data?: unknown): Promise<any>;
    export function fetchGet(url: string, callback?: (response: any) => void): Promise<void>;

    export function showMessage(text: string, timeout?: number, type?: "info" | "error", id?: string): void;
    export function insertContent(options: {
        data: string;
        dataType?: "markdown" | "html";
        editor?: unknown;
        range?: Range;
    }): void | Promise<any>;
    export function confirm(title: string, text: string, confirmCallback?: () => void, cancelCallback?: () => void): void;
    export function openWindow(options: Record<string, unknown>): void;
}

interface Window {
    siyuan: {
        config?: {
            appearance?: { mode?: number; modeOS?: boolean; lang?: string };
            readonly?: boolean;
            [key: string]: unknown;
        };
        menus?: {
            menu?: {
                element: HTMLElement;
                addItem(option: any): HTMLElement;
                append(element: HTMLElement, index?: number): void;
                remove(): void;
            };
        };
        languages?: Record<string, string>;
        isPublish?: boolean;
        zIndex?: number;
        [key: string]: unknown;
    };
}
