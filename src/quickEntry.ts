/**
 * 图片上的快捷入口。
 *
 * 思源给图片块渲染的原生结构是：
 *   <span data-type="img" class="img">
 *     <span class="protyle-action protyle-icons">
 *       <span class="protyle-icon protyle-icon--only"><svg><use href="#iconMore"/></svg></span>
 *     </span>
 *     <img src="...">
 *   </span>
 *
 * - 桌面端：鼠标悬停在图片上时整组按钮淡入（.protyle-icon 靠 hover 提亮）
 * - 移动端：轻点图片时思源会给这组加 .protyle-icons--show，同样会显示
 *
 * 所以只要把自己的按钮插进这个容器的最前面，两端就都能跟着原生一起出现，
 * 位置、圆角、配色也天然和原生按钮一致，不需要另画一套样式。
 *
 * 注入时机选在「指针进入图片」这一刻，而不是常驻 MutationObserver：
 * 编辑器一次弹窗会插入几百个节点，盯着整棵文档树做查询会拖慢首帧；
 * 而悬停 / 轻点本身就是「马上要用这个按钮」的时刻，顺手注入就够，
 * 同一个事件里同步完成，原生按钮组显示出来时我们的按钮已经排在最左边。
 */

import {readImageTarget, type ImageTarget} from "./platform";

/** 图片块容器 */
const CONTAINER_SELECTOR = '.img[data-type="img"]';
/** 注入标记：同一个容器只插一次 */
const MARK_ATTR = "data-annot-quick";
const BUTTON_CLASS = "annot-quick-entry";

/** 图标路径：悬浮按钮和右键菜单共用同一份，保证两处长得一样 */
export const ICON_PATH = '<path d="M883.09248 1018.88h-742.912C65.58208 1018.88 5.09952 958.4128 5.09952 883.79904v-742.912c0-74.5984 60.48256-135.08608 135.08096-135.08608h489.64096a16.896 16.896 0 0 1 16.896 16.87552v33.77152a16.896 16.896 0 0 1-16.896 16.896H173.952c-55.95648 0-101.31456 45.35296-101.31456 101.30944v675.37408c0 55.95136 45.35808 101.30944 101.31456 101.30944h675.37408c55.95136 0 101.30432-45.35808 101.30432-101.30944V394.15808c0-9.32352 7.57248-16.896 16.896-16.896h33.77664a16.89088 16.89088 0 0 1 16.8704 16.896v489.64096C1018.16832 958.4128 957.69088 1018.88 883.09248 1018.88z m59.52512-803.85024l-140.34944-132.49024 42.61888-42.78784c32.95232-33.06496 87.13216-33.94048 121.05728-1.92l17.54624 16.54784c33.89952 32.02048 34.67776 84.80256 1.73056 117.888l-42.60352 42.76224zM273.90976 613.10464l140.33408 132.49536-206.52544 70.656 66.19136-203.15136z m634.61376-363.8272L448.31232 711.3728l-140.33408-132.49536 460.20608-462.09024 140.3392 132.49024z" fill="currentColor"></path>';

/** 工具条图标（细线，currentColor，跟随思源按钮配色） */
/**
 * 视图要比图形本身大一圈：思源原生图标（24 视图，内容 3..21）只占格子 75%，
 * 而这张图的路径从 5 画到 1018、几乎占满 1024。直接塞进同一个 16px 盒子会大出三成。
 * 把视图扩到 -171..1195（1024/1366 = 75%），图形在盒子里就正好是原生那个比例，
 * 悬浮按钮（16px 盒）和右键菜单（14px 盒）都不必再单独调尺寸。
 */
export const ICON_VIEWBOX = "-171 -171 1366 1366";

const ICON = `<svg viewBox="${ICON_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${ICON_PATH}</svg>`;

interface Installed {
    /** 被插进按钮的那个原生组，卸载时按它还原圆角 */
    icons: HTMLElement;
    button: HTMLElement;
    /** 原来那个按钮是不是 --only（唯一时四角都是圆角） */
    restored: boolean;
}

export class QuickEntry {
    private installed = new Set<Installed>();
    private abort: AbortController | null = null;

    constructor(
        private readonly onOpen: (target: ImageTarget) => void,
        private readonly label: () => string,
    ) {}

    start(): void {
        if (typeof document === "undefined" || this.abort) return;
        this.abort = new AbortController();
        const signal = this.abort.signal;
        document.addEventListener("pointerover", this.handleEnter, {capture: true, signal});
        document.addEventListener("pointerdown", this.handleEnter, {capture: true, signal});
        document.addEventListener("touchstart", this.handleEnter, {capture: true, passive: true, signal});
    }

    stop(): void {
        this.abort?.abort();
        this.abort = null;
        for (const item of this.installed) {
            item.button.remove();
            // 还原：只剩原生按钮时它又该是 --only
            if (item.restored) {
                const only = item.icons.querySelector(".protyle-icon--last");
                if (only) {
                    only.classList.remove("protyle-icon--last");
                    only.classList.add("protyle-icon--only");
                }
            }
        }
        this.installed.clear();
        // 某些宿主在卸载阶段已经把文档销毁了
        if (typeof document !== "undefined") {
            document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => el.removeAttribute(MARK_ATTR));
        }
    }

    private readonly handleEnter = (event: Event): void => {
        const target = event.target as Element | null;
        const container = target?.closest?.(CONTAINER_SELECTOR) as HTMLElement | null;
        if (container) this.inject(container);
    };

    private inject(container: HTMLElement): void {
        if (container.hasAttribute(MARK_ATTR)) return;
        const icons = container.querySelector<HTMLElement>(".protyle-icons");
        // 按钮组还没渲染出来（图片仍在加载）：不标记，下次进入再试
        if (!icons) return;
        if (icons.querySelector(`.${BUTTON_CLASS}`)) {
            container.setAttribute(MARK_ATTR, "1");
            return;
        }

        const button = document.createElement("span");
        button.className = `protyle-icon protyle-icon--first ${BUTTON_CLASS}`;
        button.setAttribute("data-type", "annot-quick-entry");
        button.setAttribute("aria-label", this.label());
        button.setAttribute("title", this.label());
        button.innerHTML = ICON;

        // 原来这组只有一个按钮，它带 --only（四个角都是圆角）。
        // 现在变成两个：左边的我们负责左圆角，右边那个改成 --last 负责右圆角。
        const first = icons.firstElementChild as HTMLElement | null;
        const restored = !!first?.classList.contains("protyle-icon--only");
        if (first && restored) {
            first.classList.remove("protyle-icon--only");
            first.classList.add("protyle-icon--last");
        }

        icons.insertBefore(button, icons.firstElementChild);
        container.setAttribute(MARK_ATTR, "1");
        this.installed.add({icons, button, restored});

        button.addEventListener("click", (event) => {
            // 别让这一次点击被思源当成「选中图片 / 打开原生菜单」
            event.preventDefault();
            event.stopPropagation();
            const target = readImageTarget({element: container});
            if (target) this.onOpen(target);
        });
    }
}
