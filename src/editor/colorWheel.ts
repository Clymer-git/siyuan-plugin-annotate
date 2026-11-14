/**
 * 色轮取色器（PC / 移动端共用）。
 *
 * 结构与 Colorink 的色轮一致：外圈是空心色相环，中间内接一个饱和度/明度方块，
 * 环上那颗白圈定色相、方块里的小圈定浓淡；下面一行是预览块 + 色号（HEX / RGB 可切），
 * 再下面是三格读数（色相 / 浓度 / 明度）。
 *
 * 组件只负责「画 + 拖动 + 输入」，颜色落到哪里由调用方的回调决定：
 * - onPreview：拖动 / 输入过程中实时触发（用于画布实时预览）
 * - onCommit：松手 / 输入完成时触发（用于记一次撤销）
 */

import {normalizeColorHex} from "./colorPresets";

export interface ColorWheelOptions {
    /** 色轮直径，默认 236px */
    size?: number;
    /** 拖动中实时回调（不记历史） */
    onPreview?: (hex: string) => void;
    /** 松手 / 输入完成时回调（记历史） */
    onCommit?: (hex: string) => void;
}

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const hh = (((h % 360) + 360) % 360) / 60;
    const ss = s / 100;
    const vv = v / 100;
    const c = vv * ss;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = vv - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hh < 1) [r, g, b] = [c, x, 0];
    else if (hh < 2) [r, g, b] = [x, c, 0];
    else if (hh < 3) [r, g, b] = [0, c, x];
    else if (hh < 4) [r, g, b] = [0, x, c];
    else if (hh < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [r, g, b].map((n) => Math.round((n + m) * 255)) as [number, number, number];
}

export function rgbToHsv(r: number, g: number, b: number): {h: number; s: number; v: number} {
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    const max = Math.max(rr, gg, bb);
    const min = Math.min(rr, gg, bb);
    const d = max - min;
    let h = 0;
    if (d) {
        if (max === rr) h = ((gg - bb) / d) % 6;
        else if (max === gg) h = (bb - rr) / d + 2;
        else h = (rr - gg) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return {h, s: max ? (d / max) * 100 : 0, v: max * 100};
}

function hexToRgb(hex: string): [number, number, number] {
    const value = hex.replace("#", "");
    return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
    ];
}

function rgbToHex(r: number, g: number, b: number): string {
    const part = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
    return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

const TEMPLATE = `
    <div class="annot-cw__wheel">
        <div class="annot-cw__ring"></div>
        <div class="annot-cw__slice"></div>
        <div class="annot-cw__dot annot-cw__dot--hue"></div>
        <div class="annot-cw__dot annot-cw__dot--sv"></div>
    </div>
    <div class="annot-cw__row">
        <span class="annot-cw__chip"></span>
        <div class="annot-cw__fields">
            <label class="annot-cw__hex">
                <span class="annot-cw__hash">#</span>
                <input class="annot-cw__hex-input" maxlength="7" spellcheck="false" aria-label="十六进制颜色">
            </label>
            <div class="annot-cw__rgb" hidden>
                <label class="annot-cw__cell"><span>R</span><input data-ch="r" maxlength="3" inputmode="numeric" aria-label="红色"></label>
                <label class="annot-cw__cell"><span>G</span><input data-ch="g" maxlength="3" inputmode="numeric" aria-label="绿色"></label>
                <label class="annot-cw__cell"><span>B</span><input data-ch="b" maxlength="3" inputmode="numeric" aria-label="蓝色"></label>
            </div>
        </div>
        <div class="annot-cw__seg" role="group" aria-label="色号输入格式">
            <button type="button" data-cw-mode="hex" class="is-active">HEX</button>
            <button type="button" data-cw-mode="rgb">RGB</button>
        </div>
    </div>
    <div class="annot-cw__readouts">
        <span class="annot-cw__readout"><i>色相（H）</i><b data-cw-value="h">0°</b></span>
        <span class="annot-cw__readout"><i>浓度（S）</i><b data-cw-value="s">0%</b></span>
        <span class="annot-cw__readout"><i>明度（V）</i><b data-cw-value="v">0%</b></span>
    </div>`;

export class ColorWheel {
    readonly el: HTMLDivElement;

    private readonly opts: ColorWheelOptions;
    private readonly wheel: HTMLElement;
    private readonly slice: HTMLElement;
    private readonly hueDot: HTMLElement;
    private readonly svDot: HTMLElement;
    private readonly chip: HTMLElement;
    private readonly hexWrap: HTMLElement;
    private readonly hexInput: HTMLInputElement;
    private readonly rgbWrap: HTMLElement;
    private readonly rgbInputs: Record<"r" | "g" | "b", HTMLInputElement>;
    private readonly segButtons: HTMLButtonElement[];
    private readonly readouts: Record<"h" | "s" | "v", HTMLElement>;
    private readonly observer: ResizeObserver | null;

    private hsv = {h: 0, s: 0, v: 0};
    private mode: "hex" | "rgb" = "hex";
    private drag: "hue" | "sv" | null = null;

    constructor(options: ColorWheelOptions = {}) {
        this.opts = options;
        const size = options.size ?? 236;
        const ring = Math.round(size * 0.09);

        this.el = document.createElement("div");
        this.el.className = "annot-cw";
        this.el.style.setProperty("--annot-cw-size", `${size}px`);
        this.el.style.setProperty("--annot-cw-ring", `${ring}px`);
        this.el.innerHTML = TEMPLATE;

        const q = <T extends HTMLElement>(selector: string): T => this.el.querySelector(selector) as T;
        this.wheel = q(".annot-cw__wheel");
        this.slice = q(".annot-cw__slice");
        this.hueDot = q(".annot-cw__dot--hue");
        this.svDot = q(".annot-cw__dot--sv");
        this.chip = q(".annot-cw__chip");
        this.hexWrap = q(".annot-cw__hex");
        this.hexInput = q<HTMLInputElement>(".annot-cw__hex-input");
        this.rgbWrap = q(".annot-cw__rgb");
        this.rgbInputs = {
            r: q<HTMLInputElement>('[data-ch="r"]'),
            g: q<HTMLInputElement>('[data-ch="g"]'),
            b: q<HTMLInputElement>('[data-ch="b"]'),
        };
        this.segButtons = Array.from(this.el.querySelectorAll<HTMLButtonElement>("[data-cw-mode]"));
        this.readouts = {
            h: q('[data-cw-value="h"]'),
            s: q('[data-cw-value="s"]'),
            v: q('[data-cw-value="v"]'),
        };

        this.bind();
        this.render();
        this.observer = typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(() => this.layoutDots());
        this.observer?.observe(this.wheel);
    }

    /** 设置当前颜色（不触发回调） */
    setColor(hexLike: string): void {
        const hex = normalizeColorHex(hexLike);
        if (!hex) return;
        this.hsv = rgbToHsv(...hexToRgb(hex));
        this.render();
    }

    /** 弹层从 display:none 变可见后，指示点需要重新量一次位置 */
    relayout(): void {
        this.render();
    }

    destroy(): void {
        this.observer?.disconnect();
        this.el.remove();
    }

    private get hex(): string {
        return rgbToHex(...hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v));
    }

    private emit(commit: boolean): void {
        const hex = this.hex;
        if (commit) this.opts.onCommit?.(hex);
        else this.opts.onPreview?.(hex);
    }

    private bind(): void {
        const onDown = (event: PointerEvent): void => {
            const box = this.wheel.getBoundingClientRect();
            if (!box.width) return;
            const cx = box.left + box.width / 2;
            const cy = box.top + box.height / 2;
            const ring = this.ringWidth();
            const outer = box.width / 2;
            const inner = outer - ring;
            const distance = Math.hypot(event.clientX - cx, event.clientY - cy);
            const sliceBox = this.slice.getBoundingClientRect();
            const insideSlice = event.clientX >= sliceBox.left && event.clientX <= sliceBox.right &&
                event.clientY >= sliceBox.top && event.clientY <= sliceBox.bottom;
            if (distance <= outer + 6 && distance >= inner - 4) this.drag = "hue";
            else if (insideSlice) this.drag = "sv";
            else return;
            try {
                this.wheel.setPointerCapture(event.pointerId);
            } catch {
                /* jsdom / 老版本浏览器没有指针捕获，忽略即可 */
            }
            this.applyPoint(event.clientX, event.clientY, false);
            event.preventDefault();
            event.stopPropagation();
        };

        this.wheel.addEventListener("pointerdown", onDown);
        this.wheel.addEventListener("pointermove", (event) => {
            if (!this.drag) return;
            this.applyPoint(event.clientX, event.clientY, false);
            event.preventDefault();
        });
        const end = (event: PointerEvent): void => {
            if (!this.drag) return;
            this.applyPoint(event.clientX, event.clientY, true);
            this.drag = null;
            try {
                this.wheel.releasePointerCapture(event.pointerId);
            } catch {
                /* 同上 */
            }
        };
        this.wheel.addEventListener("pointerup", end);
        this.wheel.addEventListener("pointercancel", end);

        for (const button of this.segButtons) {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                this.setMode(button.dataset.cwMode === "rgb" ? "rgb" : "hex");
            });
        }

        this.hexInput.addEventListener("change", () => {
            const hex = normalizeColorHex(this.hexInput.value);
            if (!hex) {
                this.render();
                return;
            }
            this.hsv = rgbToHsv(...hexToRgb(hex));
            this.render();
            this.emit(true);
        });
        this.hexInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") this.hexInput.blur();
        });

        for (const key of ["r", "g", "b"] as const) {
            const input = this.rgbInputs[key];
            input.addEventListener("input", () => {
                const value = clamp(Math.round(Number(input.value) || 0), 0, 255);
                const rgb = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
                rgb[["r", "g", "b"].indexOf(key)] = value;
                this.hsv = rgbToHsv(...rgb);
                this.render(false);
                this.emit(false);
            });
            input.addEventListener("change", () => {
                this.render();
                this.emit(true);
            });
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") input.blur();
            });
        }
    }

    /** 用点击位置更新色相或 S/V；commit=true 表示这一次拖动结束 */
    private applyPoint(x: number, y: number, commit: boolean): void {
        if (this.drag === "hue") {
            const box = this.wheel.getBoundingClientRect();
            const cx = box.left + box.width / 2;
            const cy = box.top + box.height / 2;
            let deg = (Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI;
            if (deg < 0) deg += 360;
            this.hsv.h = deg;
        } else if (this.drag === "sv") {
            const box = this.slice.getBoundingClientRect();
            this.hsv.s = clamp((x - box.left) / box.width, 0, 1) * 100;
            this.hsv.v = (1 - clamp((y - box.top) / box.height, 0, 1)) * 100;
        } else {
            return;
        }
        this.render();
        this.emit(commit);
    }

    private setMode(mode: "hex" | "rgb"): void {
        this.mode = mode;
        this.hexWrap.hidden = mode !== "hex";
        this.rgbWrap.hidden = mode !== "rgb";
        this.el.classList.toggle("is-rgb", mode === "rgb");
        for (const button of this.segButtons) {
            button.classList.toggle("is-active", button.dataset.cwMode === mode);
        }
        this.syncInputs();
    }

    private ringWidth(): number {
        const raw = getComputedStyle(this.el).getPropertyValue("--annot-cw-ring");
        const value = parseFloat(raw);
        return Number.isFinite(value) ? value : 21;
    }

    /** 指示点贴到当前色相 / S/V 上（尺寸为 0 时说明还没显示，直接跳过） */
    private layoutDots(): void {
        const wheelBox = this.wheel.getBoundingClientRect();
        if (!wheelBox.width) return;
        const radius = wheelBox.width / 2 - this.ringWidth() / 2;
        const rad = (this.hsv.h * Math.PI) / 180;
        this.hueDot.style.transform =
            `translate(${wheelBox.width / 2 + radius * Math.sin(rad)}px, ` +
            `${wheelBox.height / 2 - radius * Math.cos(rad)}px)`;

        const sliceBox = this.slice.getBoundingClientRect();
        const offsetX = sliceBox.left - wheelBox.left;
        const offsetY = sliceBox.top - wheelBox.top;
        this.svDot.style.transform =
            `translate(${offsetX + (this.hsv.s / 100) * sliceBox.width}px, ` +
            `${offsetY + (1 - this.hsv.v / 100) * sliceBox.height}px)`;
    }

    private syncInputs(): void {
        const [r, g, b] = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
        if (this.mode === "hex") {
            if (this.hexInput !== document.activeElement) this.hexInput.value = this.hex.slice(1);
            return;
        }
        for (const [key, value] of [["r", r], ["g", g], ["b", b]] as const) {
            const input = this.rgbInputs[key];
            if (input !== document.activeElement) input.value = String(value);
        }
    }

    private render(sync = true): void {
        const {h, s, v} = this.hsv;
        const [r, g, b] = hsvToRgb(h, s, v);

        this.slice.style.background =
            `linear-gradient(to top, #000, rgba(0,0,0,0)),` +
            `linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
        this.chip.style.background = `rgb(${r}, ${g}, ${b})`;
        this.readouts.h.textContent = `${Math.round(h)}°`;
        this.readouts.s.textContent = `${Math.round(s)}%`;
        this.readouts.v.textContent = `${Math.round(v)}%`;
        if (sync) this.syncInputs();
        this.layoutDots();
    }
}
