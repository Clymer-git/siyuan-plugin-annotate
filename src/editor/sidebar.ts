/**
 * 右侧栏：「对象」「层级」两个可折叠区块，外加一个整体收起的拉手。
 * 「对象」负责列表、多选、拖拽排序、复制与删除；「层级」只放置顶 / 上移 / 下移 / 置底。
 * 选中状态由编辑器主控统一持有（这里是多选，所以是一组 id）。
 */

import {pickBadgeTextColor} from "./color";
import {DUPLICATE_ICON, DELETE_ICON} from "./icons";
import {type AnnotObject, type NumberGeometry} from "../types";
import {objectLabel} from "./shapes";

/** 列表点击时的修饰键：Shift 选一段、Ctrl 逐个加减 */
export interface SidebarSelectMods {
    shift: boolean;
    ctrl: boolean;
}

export interface SidebarCallbacks {
    onSelect(id: string, mods: SidebarSelectMods): void;
    onHover(id: string | null): void;
    onDelete(id: string): void;
    onEditText(id: string): void;
    onLayer(id: string, action: "top" | "up" | "down" | "bottom"): void;
    onDuplicate(id: string): void;
    /** 在「对象」栏目里拖一行调整堆叠顺序 */
    onReorder(fromId: string, toId: string): void;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch] || ch);
}

const sectionHead = (key: string, title: string, plain: string): string => `
    <div class="annot-panel-head">
        <span class="annot-panel-head__title">${title}</span>
        <button type="button" class="annot-section-toggle" data-action="toggle-section"
            data-section="${key}" title="折叠 / 展开「${plain}」"
            aria-label="折叠 / 展开">▾</button>
    </div>`;

export class Sidebar {
    private readonly root: HTMLElement;
    private readonly callbacks: SidebarCallbacks;
    private readonly abort: AbortController;
    private collapsed = false;
    private dragId: string | null = null;

    constructor(
        container: HTMLElement, callbacks: SidebarCallbacks, signal: AbortSignal,
        options: {mobile?: boolean} = {},
    ) {
        this.root = container;
        this.callbacks = callbacks;
        this.abort = new AbortController();
        signal.addEventListener("abort", () => this.abort.abort(), {once: true});

        this.root.innerHTML = `
            ${options.mobile ? `
            <div class="annot-mobile-grab" data-role="mobile-grab" title="往下拖动可以收起"
                aria-label="往下拖动可以收起"><span></span></div>` : ""}
            <button type="button" class="annot-side-handle" data-action="toggle-sidebar"
                title="收起 / 展开右侧面板" aria-label="收起 / 展开右侧面板">›</button>
            <div class="annot-side-panels">
                <section class="annot-side-section" data-section="objects">
                    ${sectionHead("objects", '对象 <span class="annot-count" data-role="count">0</span>', "对象")}
                    <div class="annot-section-body annot-objects-body">
                        <div class="annot-object-list" data-role="list"></div>
                    </div>
                </section>
                <section class="annot-side-section" data-section="layers">
                    ${sectionHead("layers", "层级", "层级")}
                    <div class="annot-section-body annot-layer-controls" data-role="layers">
                        <button type="button" data-action="layer-top" title="移到最上层">置顶</button>
                        <button type="button" data-action="layer-up" title="上移一层">上移</button>
                        <button type="button" data-action="layer-down" title="下移一层">下移</button>
                        <button type="button" data-action="layer-bottom" title="移到最下层">置底</button>
                    </div>
                </section>
            </div>
        `;
        this.bindEvents();
    }

    private bindEvents(): void {
        const signal = this.abort.signal;
        const findItem = (target: EventTarget | null): HTMLElement | null =>
            (target as Element | null)?.closest?.("[data-role='object-item']") ?? null;
        const dataAction = (target: EventTarget | null): string | null =>
            ((target as Element | null)?.closest?.("[data-action]") as HTMLElement | null)
                ?.getAttribute("data-action") ?? null;

        this.root.addEventListener("click", (event) => {
            const target = event.target as Element;
            const action = dataAction(target);
            if (action === "toggle-sidebar") {
                this.setCollapsed(!this.collapsed);
                return;
            }
            if (action === "toggle-section") {
                const key = (target.closest("[data-action]") as HTMLElement)?.dataset.section;
                const section = key ? this.root.querySelector<HTMLElement>(
                    `.annot-side-section[data-section="${key}"]`) : null;
                if (section) {
                    const folded = section.classList.toggle("is-folded");
                    const button = section.querySelector<HTMLElement>(".annot-section-toggle");
                    if (button) button.textContent = folded ? "▸" : "▾";
                }
                return;
            }
            if (action === "delete-object") {
                const id = (target.closest("[data-action]") as HTMLElement)?.dataset.id;
                if (id) this.callbacks.onDelete(id);
                return;
            }
            if (action === "edit-text") {
                const id = (target.closest("[data-action]") as HTMLElement)?.dataset.id;
                if (id) this.callbacks.onEditText(id);
                return;
            }
            if (action === "duplicate" || action?.startsWith("layer-")) {
                const id = (target.closest("[data-action]") as HTMLElement)?.dataset.id;
                if (!id) return;
                if (action === "duplicate") this.callbacks.onDuplicate(id);
                else this.callbacks.onLayer(id, action.slice(6) as "top" | "up" | "down" | "bottom");
                return;
            }
            const item = findItem(target);
            if (item?.dataset.id) {
                // 列表里点一行：普通点是单选并设为锚点，Shift 选区间，Ctrl 逐个加减
                this.callbacks.onSelect(item.dataset.id, {
                    shift: event.shiftKey,
                    ctrl: event.ctrlKey || event.metaKey,
                });
            }
        }, {signal});

        // 对象列表拖拽：把一个对象拖到另一个对象上，就排到它的位置
        this.root.addEventListener("dragstart", (event) => {
            if ((event.target as Element | null)?.closest?.("button")) return;
            const item = (event.target as Element | null)?.closest?.("[data-role='object-item']") as HTMLElement | null;
            if (!item) return;
            this.dragId = item.dataset.id || null;
            item.classList.add("is-dragging");
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        }, {signal});
        this.root.addEventListener("dragover", (event) => {
            const item = (event.target as Element | null)?.closest?.("[data-role='object-item']") as HTMLElement | null;
            if (!item || !this.dragId) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            this.root.querySelectorAll(".annot-object-item.is-over").forEach((el) => el.classList.remove("is-over"));
            item.classList.add("is-over");
        }, {signal});
        this.root.addEventListener("drop", (event) => {
            const item = (event.target as Element | null)?.closest?.("[data-role='object-item']") as HTMLElement | null;
            const toId = item?.dataset.id || null;
            if (this.dragId && toId && this.dragId !== toId) {
                event.preventDefault();
                this.callbacks.onReorder(this.dragId, toId);
            }
            this.clearDrag();
        }, {signal});
        this.root.addEventListener("dragend", () => this.clearDrag(), {signal});

        this.root.addEventListener("mouseover", (event) => {
            const item = findItem(event.target);
            if (item?.dataset.id) this.callbacks.onHover(item.dataset.id);
        }, {signal});
        this.root.addEventListener("mouseout", (event) => {
            const item = findItem(event.target);
            const next = (event as MouseEvent).relatedTarget as Element | null;
            if (item && !item.contains(next)) this.callbacks.onHover(null);
        }, {signal});

    }

    private clearDrag(): void {
        this.dragId = null;
        this.root.querySelectorAll(".annot-object-item.is-dragging, .annot-object-item.is-over")
            .forEach((el) => el.classList.remove("is-dragging", "is-over"));
    }

    private setCollapsed(value: boolean): void {
        this.collapsed = value;
        this.root.classList.toggle("is-collapsed", value);
        const button = this.root.querySelector<HTMLElement>('[data-action="toggle-sidebar"]');
        if (button) button.textContent = value ? "‹" : "›";
    }

    render(objects: AnnotObject[], selectedIds: string[], hoveredId: string | null): void {
        const count = this.root.querySelector<HTMLElement>('[data-role="count"]');
        const list = this.root.querySelector<HTMLElement>('[data-role="list"]');
        const layers = this.root.querySelector<HTMLElement>('[data-role="layers"]');
        if (!list || !layers) return;
        const picked = new Set(selectedIds);
        if (count) count.textContent = String(objects.length);

        list.replaceChildren();
        if (objects.length === 0) {
            const empty = document.createElement("div");
            empty.className = "annot-empty";
            empty.textContent = "还没有标注对象";
            list.append(empty);
        }
        objects.forEach((object, index) => {
            const item = document.createElement("div");
            item.className = "annot-object-item";
            item.dataset.role = "object-item";
            item.dataset.id = object.id;
            item.draggable = true;
            item.setAttribute("title", "拖动这一行调整上下覆盖关系");
            if (picked.has(object.id)) item.classList.add("is-selected");
            if (object.id === hoveredId) item.classList.add("is-hovered");
            const isNumber = object.type === "number";
            const badge = document.createElement("span");
            badge.className = "annot-object-item__badge";
            if (isNumber) {
                const number = (object.geometry as NumberGeometry).number;
                badge.textContent = String(number);
                badge.style.background = object.style.color;
                badge.style.color = pickBadgeTextColor(object.style.color);
            } else {
                badge.textContent = String(index + 1);
            }
            const name = document.createElement("span");
            name.className = "annot-object-item__name";
            name.textContent = objectLabel(object);
            // 每行末尾直接放复制 / 删除：类型名称前面已经有了，不再重复写一遍
            const actions = document.createElement("span");
            actions.className = "annot-object-item__actions";
            const duplicate = document.createElement("button");
            duplicate.type = "button";
            duplicate.className = "annot-prop-icon-btn annot-object-item__btn";
            duplicate.dataset.action = "duplicate";
            duplicate.dataset.id = object.id;
            duplicate.title = "复制这个对象（Ctrl+D）";
            duplicate.setAttribute("aria-label", "复制");
            duplicate.innerHTML = DUPLICATE_ICON;
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "annot-prop-icon-btn annot-prop-icon-btn--danger annot-object-item__btn";
            remove.dataset.action = "delete-object";
            remove.dataset.id = object.id;
            remove.title = "删除这个对象（Delete）";
            remove.setAttribute("aria-label", "删除");
            remove.innerHTML = DELETE_ICON;
            actions.append(duplicate, remove);
            item.append(badge, name, actions);
            list.append(item);
        });

        // 层级栏目：四个按钮控制选中对象（多选时作用于最后点的那一个）；没有选中对象时禁用
        const primaryId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
        const layerButtons = this.root.querySelectorAll<HTMLButtonElement>('[data-role="layers"] button');
        layerButtons.forEach((button) => {
            button.dataset.id = primaryId ?? "";
            button.disabled = !primaryId;
        });
    }
}
