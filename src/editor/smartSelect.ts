/**
 * 选区识别：先把整张画面切成一个个「独立区块」，用户再点哪个框、哪个框就被打码。
 *
 * 算法骨架来自 snow-shot 的 visual-region-detector（纯 Rust，无 AI 模型）。
 * 它之所以分得细，关键不在于边缘检测，而在于**局部背景**：
 * 每块区域先估出自己的底色（卡片底、面板底），只有相对这块底色有反差的像素
 * 才算「内容」。这样就不会把一张浅色卡片的底色当成一大块内容。
 *
 * 这里搬过来的四步：
 *   1. 局部底色 = 大半径均值模糊；前景 = 与原像素差超过阈值。
 *   2. 另算一遍「全局前景」（与页面底色比），其中高度超过 2 个字高的连通域
 *      就是图标 / 照片 / 色块这类「大块」，从文字前景里扣掉，图标和标题才不会被粘在一起。
 *   3. 剩下的文字前景做小核横向闭运算（只为连上字内缝隙），再按「高度相近」合并成行。
 *   4. 过滤过小过大的块，按面积取前 N，按阅读顺序排。
 *
 * 全部是 TypedArray 整数运算；主线程会把画面降到 800px 以内再丢进 Web Worker。
 */

export interface SmartImage {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

export interface SmartRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 归一化条带（老版本「框选识别」留下的形状字段仍在用，保留类型） */
export type SmartRun = [number, number, number, number];

export interface SmartResult {
    runs: SmartRun[];
    coverage: number;
}

/** 识别前把画面压到这个边长以内再算 */
export const SMART_MAX_SIDE = 800;

/** 最多给多少个框 */
const MAX_REGIONS = 120;

/** 小于整幅这个面积的块丢掉 */
const MIN_AREA_RATIO = 0.00012;

/** 大于整幅这个面积的块丢掉（整片背景） */
const MAX_AREA_RATIO = 0.9;

/** 与 3×3 邻域的亮度差多少才算「内容边缘」 */
const EDGE_THRESHOLD = 11;

/** 与「页面底色」差多少才算内容 */
const GLOBAL_THRESHOLD = 26;

interface Component {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    area: number;
    label: number;
}

export function detectRegions(input: SmartImage): SmartRegion[] {
    const {data, width: w, height: h} = input;
    if (w < 16 || h < 16) return [];

    const globalBg = estimateBackground(data, w, h);

    // ① 局部对比：只认「与紧邻像素明显不同」的地方。
    //    卡片底、面板底是均匀色，不会被算成内容；文字笔画、图标边缘、边框会被算成内容。
    //    这比「大半径模糊当背景」稳得多——模糊会把文字糊进背景，行与行之间出现光晕，
    //    结果整段文字黏成一块。
    const luma = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    const localFg = new Uint8Array(w * h);
    let localCount = 0;
    for (let y = 1; y < h - 1; y++) {
        const row = y * w;
        for (let x = 1; x < w - 1; x++) {
            const i = row + x;
            if (data[i * 4 + 3] < 16) continue;
            const sum = luma[i - w - 1] + luma[i - w] + luma[i - w + 1] +
                luma[i - 1] + luma[i] + luma[i + 1] +
                luma[i + w - 1] + luma[i + w] + luma[i + w + 1];
            if (Math.abs(luma[i] - sum / 9) > EDGE_THRESHOLD) {
                localFg[i] = 1;
                localCount++;
            }
        }
    }
    if (localCount < w * h * 0.002) return [];

    // ①-b 扣掉「长横线 / 长竖线」：卡片边框、分割线在局部前景里非常显眼，
    // 留着会把整张卡片连成一个框（snow-shot 的 text_lines 也是先做开运算去线）
    const lineX = openLine(localFg, w, h, Math.max(8, Math.round(w / 15)), false);
    const lineY = openLine(localFg, w, h, Math.max(8, Math.round(h / 15)), true);
    for (let i = 0; i < localFg.length; i++) {
        if (lineX[i] || lineY[i]) localFg[i] = 0;
    }

    // 字高：用局部前景的连通域高度取 70 分位（snow-shot 的 text.rs 也是这么估的）
    const localComps = labelComponents(localFg, w, h).comps;
    const heights: number[] = [];
    for (const c of localComps) {
        const cw = c.x1 - c.x0 + 1;
        const ch = c.y1 - c.y0 + 1;
        if (ch >= 6 && ch <= h * 0.06 && cw >= 2 && cw <= w * 0.5) heights.push(ch);
    }
    const charHeight = heights.length
        ? percentile(heights, 0.7)
        : Math.max(12, Math.round(h * 0.018));

    // ② 大块（图标 / 照片 / 色块）：全局前景里高度超过 2 倍字高的连通域
    const globalFg = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        if (data[p + 3] < 16) continue;
        const dr = data[p] - globalBg[0];
        const dg = data[p + 1] - globalBg[1];
        const db = data[p + 2] - globalBg[2];
        if (Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db) > GLOBAL_THRESHOLD) {
            globalFg[i] = 1;
        }
    }
    const globalLabeled = labelComponents(globalFg, w, h);
    const bigMask = new Uint8Array(w * h);
    const bigRegions: SmartRegion[] = [];
    for (const c of globalLabeled.comps) {
        const cw = c.x1 - c.x0 + 1;
        const ch = c.y1 - c.y0 + 1;
        if (ch < charHeight * 2) continue;              // 文字行不会有这么高
        if (ch > h * 0.85 || cw > w * 0.97) continue;   // 整片背景
        if (c.area < w * h * 0.0006) continue;
        bigRegions.push({x: c.x0, y: c.y0, width: cw, height: ch});
        for (let i = 0; i < bigMask.length; i++) {
            if (globalLabeled.labels[i] === c.label) bigMask[i] = 1;
        }
    }
    // 大块向外扩 2px：把抗锯齿边一并划给它，免得文字检测蹭到图标的边
    const bigGrown = dilateRect(bigMask, w, h, 2, 2);
    for (let i = 0; i < localFg.length; i++) {
        if (bigGrown[i]) localFg[i] = 0;
    }

    // ③ 文字：小核横向闭运算只连字内缝隙（字距交给下一步「合并」判断）
    const kernelX = Math.max(3, Math.min(12, Math.round(charHeight * 0.45)));
    const closed = closeRect(localFg, w, h, kernelX, 1);
    const textComps = labelComponents(closed, w, h).comps;

    let regions: SmartRegion[] = [];
    for (const c of textComps) {
        const cw = c.x1 - c.x0 + 1;
        const ch = c.y1 - c.y0 + 1;
        // 太碎的不是内容：边框残段、标点、噪点
        if (cw < 8 || ch < 5 || c.area < 24) continue;
        // 填充率太低 = 细线或空心环（边框残留），不是内容
        if (c.area / (cw * ch) < 0.12) continue;
        regions.push({x: c.x0, y: c.y0, width: cw, height: ch});
    }
    regions = mergeTextLines(regions, charHeight);
    regions = [...bigRegions, ...regions];

    const total = w * h;
    regions = regions.filter((r) => {
        const area = r.width * r.height;
        return area >= total * MIN_AREA_RATIO && area <= total * MAX_AREA_RATIO;
    });
    regions = dropOverlaps(regions);

    regions.sort((a, b) => b.width * b.height - a.width * a.height);
    regions = regions.slice(0, MAX_REGIONS);
    regions.sort((a, b) => a.y - b.y || a.x - b.x);
    return regions;
}

/** 边缘一圈投票取页面底色 */
function estimateBackground(data: Uint8ClampedArray, w: number, h: number): [number, number, number] {
    const counts = new Map<number, {n: number; r: number; g: number; b: number}>();
    const add = (x: number, y: number): void => {
        const p = (y * w + x) * 4;
        if (data[p + 3] < 16) return;
        const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
        const hit = counts.get(key);
        if (hit) {
            hit.n++;
            hit.r += data[p];
            hit.g += data[p + 1];
            hit.b += data[p + 2];
        } else {
            counts.set(key, {n: 1, r: data[p], g: data[p + 1], b: data[p + 2]});
        }
    };
    const band = Math.max(1, Math.min(3, Math.round(Math.min(w, h) / 60)));
    for (let y = 0; y < h; y++) {
        for (let d = 0; d < band; d++) {
            add(d, y);
            add(w - 1 - d, y);
        }
    }
    for (let x = 0; x < w; x++) {
        for (let d = 0; d < band; d++) {
            add(x, d);
            add(x, h - 1 - d);
        }
    }
    let best: {n: number; r: number; g: number; b: number} | null = null;
    for (const item of counts.values()) {
        if (!best || item.n > best.n) best = item;
    }
    if (!best) return [255, 255, 255];
    return [best.r / best.n, best.g / best.n, best.b / best.n];
}

function percentile(values: number[], ratio: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const pos = (sorted.length - 1) * ratio;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

/** 4 邻接连通域，同时返回每块的信息和一张 label 图（label 从 1 开始，0 是背景） */
function labelComponents(mask: Uint8Array, w: number, h: number): {comps: Component[]; labels: Int32Array} {
    const labels = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    const comps: Component[] = [];
    let next = 1;
    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || labels[start]) continue;
        const label = next++;
        let head = 0;
        let tail = 0;
        let x0 = w;
        let x1 = -1;
        let y0 = h;
        let y1 = -1;
        let area = 0;
        queue[tail++] = start;
        labels[start] = label;
        while (head < tail) {
            const i = queue[head++];
            const x = i % w;
            const y = (i / w) | 0;
            area++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (x > 0 && mask[i - 1] && !labels[i - 1]) {
                labels[i - 1] = label;
                queue[tail++] = i - 1;
            }
            if (x + 1 < w && mask[i + 1] && !labels[i + 1]) {
                labels[i + 1] = label;
                queue[tail++] = i + 1;
            }
            if (y > 0 && mask[i - w] && !labels[i - w]) {
                labels[i - w] = label;
                queue[tail++] = i - w;
            }
            if (y + 1 < h && mask[i + w] && !labels[i + w]) {
                labels[i + w] = label;
                queue[tail++] = i + w;
            }
        }
        comps.push({x0, y0, x1, y1, area, label});
    }
    return {comps, labels};
}

/** 一维膨胀：半径内有前景就点亮 */
function dilateLine(src: Uint8Array, w: number, h: number, r: number, vertical: boolean): Uint8Array {
    const out = new Uint8Array(w * h);
    const length = vertical ? h : w;
    const outer = vertical ? w : h;
    // 横向：base = y*w，逐像素 +1；纵向：base = x，逐像素 +w
    const stride = vertical ? 1 : w;
    const step = vertical ? w : 1;
    for (let o = 0; o < outer; o++) {
        const base = o * stride;
        const left = new Int32Array(length);
        let last = -1e9;
        for (let i = 0; i < length; i++) {
            if (src[base + i * step]) last = i;
            left[i] = i - last;
        }
        let next = 1e9;
        for (let i = length - 1; i >= 0; i--) {
            if (src[base + i * step]) next = i;
            const d = Math.min(left[i], next - i);
            out[base + i * step] = d <= r ? 1 : 0;
        }
    }
    return out;
}

/** 一维腐蚀：半径内有背景就熄灭 */
function erodeLine(src: Uint8Array, w: number, h: number, r: number, vertical: boolean): Uint8Array {
    const out = new Uint8Array(w * h);
    const length = vertical ? h : w;
    const outer = vertical ? w : h;
    const stride = vertical ? 1 : w;
    const step = vertical ? w : 1;
    for (let o = 0; o < outer; o++) {
        const base = o * stride;
        const left = new Int32Array(length);
        let last = -1e9;
        for (let i = 0; i < length; i++) {
            if (!src[base + i * step]) last = i;
            left[i] = i - last;
        }
        let next = 1e9;
        for (let i = length - 1; i >= 0; i--) {
            if (!src[base + i * step]) next = i;
            const d = Math.min(left[i], next - i);
            out[base + i * step] = d > r ? 1 : 0;
        }
    }
    return out;
}

/** 一维开运算：先腐蚀后膨胀，只有长度超过 2r 的连续段能留下来（用来认长线） */
function openLine(src: Uint8Array, w: number, h: number, r: number, vertical: boolean): Uint8Array {
    return dilateLine(erodeLine(src, w, h, r, vertical), w, h, r, vertical);
}

function dilateRect(src: Uint8Array, w: number, h: number, kx: number, ky: number): Uint8Array {
    let work = kx > 0 ? dilateLine(src, w, h, kx, false) : src;
    if (ky > 0) work = dilateLine(work, w, h, ky, true);
    return work;
}

/** 矩形核闭运算（先膨胀后腐蚀） */
function closeRect(src: Uint8Array, w: number, h: number, kx: number, ky: number): Uint8Array {
    let work = dilateLine(src, w, h, kx, false);
    if (ky > 1) work = dilateLine(work, w, h, ky, true);
    work = erodeLine(work, w, h, kx, false);
    if (ky > 1) work = erodeLine(work, w, h, ky, true);
    return work;
}

/**
 * 同行合并：只把「高度相近」的文字块连起来。
 * 高度差太多说明其中一个是图标 / 图片，硬合并就会出现「图标 + 标题」粘成一大条。
 */
function mergeTextLines(regions: SmartRegion[], charHeight: number): SmartRegion[] {
    let items = regions.slice();
    const gapLimit = Math.max(4, Math.round(charHeight * 1.2));
    for (let round = 0; round < 3; round++) {
        const used = new Array(items.length).fill(false);
        const out: SmartRegion[] = [];
        let changed = false;
        for (let i = 0; i < items.length; i++) {
            if (used[i]) continue;
            used[i] = true;
            let current = {...items[i]};
            for (let j = i + 1; j < items.length; j++) {
                if (used[j]) continue;
                const other = items[j];
                const ratio = current.height / other.height;
                if (ratio < 0.55 || ratio > 1.8) continue;
                const overlapY = Math.min(current.y + current.height, other.y + other.height) -
                    Math.max(current.y, other.y);
                if (overlapY < Math.min(current.height, other.height) * 0.6) continue;
                const gapX = Math.max(other.x - (current.x + current.width), current.x - (other.x + other.width));
                if (gapX > gapLimit) continue;
                const x0 = Math.min(current.x, other.x);
                const y0 = Math.min(current.y, other.y);
                const x1 = Math.max(current.x + current.width, other.x + other.width);
                const y1 = Math.max(current.y + current.height, other.y + other.height);
                current = {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
                used[j] = true;
                changed = true;
            }
            out.push(current);
        }
        items = out;
        if (!changed) break;
    }
    return items;
}

/** 去掉几乎重复的框（IoU 很高时只留大的） */
function dropOverlaps(regions: SmartRegion[]): SmartRegion[] {
    const sorted = [...regions].sort((a, b) => b.width * b.height - a.width * a.height);
    const keep: SmartRegion[] = [];
    for (const r of sorted) {
        const area = r.width * r.height;
        const duplicate = keep.some((k) => {
            const x0 = Math.max(r.x, k.x);
            const y0 = Math.max(r.y, k.y);
            const x1 = Math.min(r.x + r.width, k.x + k.width);
            const y1 = Math.min(r.y + r.height, k.y + k.height);
            const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
            return inter / area > 0.88;
        });
        if (!duplicate) keep.push(r);
    }
    return keep;
}
