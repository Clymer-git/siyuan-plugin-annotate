/** 箭头样式：ShareX 五种 + 用户要求保留的两种竖线连接线 */
export type ArrowStyleKey =
    "classic" | "modern" | "double" | "basic" | "line" | "bar" | "barDouble";

/** 选区识别得到的贴合形状：0..1 归一化水平条带（见 editor/smartSelect.ts） */
import type {SmartRun} from "./editor/smartSelect";

/**
 * 标注数据模型（五个里程碑共用）。
 *
 * 设计原则：
 * - 所有坐标都用「图片原始像素」表示，与屏幕缩放无关（参照 Anot8 的固定 viewBox 做法）。
 * - 每个标注对象是独立数据，保存的是"怎么画"，不是"画完的像素"，
 *   因此重新打开后仍可拖拽端点、掰弯曲线、改文字、调颜色线宽。
 * - 场景 JSON 只存纯数据，不存 DOM、不存位图（马赛克除外，见里程碑三）。
 */

/**
 * 场景文件版本。
 * v2 起场景多了一个「画布」概念：旋转 / 翻转 / 裁切 / 扩展画布都会改变画布尺寸，
 * 底图不再等于画布（原图可能只占画布的一部分，甚至被转 90 度）。
 * v1 场景在读取时自动迁移，老标注不会丢。
 */
export const SCENE_VERSION = 2;

export type ToolType =
    | "select"
    /** 手型平移：只在画布上方的悬浮条里，按住拖动整张画布（不产生任何标注） */
    | "pan"
    | "arrow"
    | "rect"
    | "ellipse"
    | "text"
    | "number"
    | "mosaic"
    | "blur"
    | "highlight"
    | "line"
    | "spotlight"
    | "magnifier";

/**
 * 画布上真实存在的对象类型。
 * 「矩形高亮」不是独立工具：它是【高亮】工具的矩形模式产出的对象，
 * 所以只出现在对象类型里，不出现在工具栏里。
 */
export type AnnotType = Exclude<ToolType, "select" | "pan"> | "highlightRect";

export interface Point {
    x: number;
    y: number;
}

export interface RectGeometry {
    x: number;
    y: number;
    width: number;
    height: number;
    /** 弧度制，绕矩形中心旋转（里程碑三） */
    rotation?: number;
}

export interface EllipseGeometry {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    rotation?: number;
}

/** 箭头：control 为 null 表示直线，否则为二次贝塞尔控制点（capcap 的做法） */
export interface ArrowGeometry {
    start: Point;
    end: Point;
    control: Point | null;
}

export interface TextGeometry {
    x: number;
    y: number;
    text: string;
    fontSize: number;
    /** 折行宽度（画布像素）：不是用户设置的，而是「右边还剩多少地方」，每次渲染前重算 */
    width?: number;
    rotation?: number;
}

/** 序号：tip 为 null 表示只有圆点，否则为引线端点 */
export interface NumberGeometry {
    center: Point;
    tip: Point | null;
    control: Point | null;
    /** 由场景统一重排，保证 1..N 连续无间隙 */
    number: number;
    radius: number;
    /** 编号显示格式：1 / I / a / A / 一；缺省按阿拉伯数字 */
    format?: "arabic" | "roman" | "alphaLower" | "alphaUpper" | "chinese";
    rotation?: number;
}

/** 马赛克：矩形区域 + 块大小，像素内容在渲染时从底图实时采样 */
export interface MosaicGeometry extends RectGeometry {
    blockSize: number;
    /** 选区识别得到的贴合形状；没有这个字段就是整块矩形 */
    mask?: SmartRun[];
}

/**
 * 模糊：矩形区域 + 模糊强度（像素）。
 * 和马赛克一样，是从底图实时采一块再处理，因此框选区域变、底图变都要重新算；
 * 强度单位是画布像素，缩放画布不影响观感。
 */
export interface BlurGeometry extends RectGeometry {
    radius: number;
    /** 选区识别得到的贴合形状；没有这个字段就是整块矩形 */
    mask?: SmartRun[];
}

/**
 * 聚光灯：区域外压一层暗色遮罩、区域内保持原样。
 * shape 决定遮罩挖出的孔是矩形还是椭圆（工具栏上可随时切换）。
 */
export interface SpotlightGeometry extends RectGeometry {
    shape?: "rect" | "ellipse";
}

/**
 * 放大镜：显示框（本接口的 x/y/width/height）+ 锚点 + 倍数。
 *
 * 两者刻意解耦：拖动显示框只改 x/y，锚点不动；拖动锚点只改 anchor，
 * 显示框不动，只是框里的画面换成新锚点周围的放大内容。
 */
export interface MagnifierGeometry extends RectGeometry {
    /** 被放大的目标点（画布坐标） */
    anchor: Point;
    /** 放大倍数 */
    zoom: number;
    /** 显示框形状：圆形 / 矩形 */
    shape?: "rect" | "ellipse";
}

/** 高亮笔：自由笔迹，points 为图片像素坐标序列 */
export interface HighlightGeometry {
    points: Point[];
    rotation?: number;
}

/** 画线：两点为直线，多点为连续折线；points 为图片像素坐标序列 */
export interface LineGeometry {
    points: Point[];
}

export type Geometry =
    | RectGeometry
    | EllipseGeometry
    | ArrowGeometry
    | TextGeometry
    | NumberGeometry
    | MosaicGeometry
    | BlurGeometry
    | HighlightGeometry
    | LineGeometry
    | SpotlightGeometry
    | MagnifierGeometry;

/** 统一的视觉属性，所有对象类型都能事后修改 */
export interface AnnotStyle {
    color: string;
    /** 描边宽度，图片像素单位 */
    lineWidth: number;
    /** 0~1，用于填充/半透明笔迹 */
    opacity: number;
    /** 文字/序号的字号 */
    fontSize?: number;
    /** 形状内部填充不透明度 0~1；0 表示不填充 */
    fillOpacity?: number;
    /** 填充色；缺省跟描边色一致（老图保持原样） */
    fillColor?: string;
    /** 兼容早期场景数据，渲染以 fillOpacity 为准 */
    fillMode?: "none" | "solid" | "translucent";
    /**
     * 文字描边（沿字形外沿的一圈描边，用来让文字在复杂底图上依然清楚）。
     * 只对 text 生效；缺省视为开启，老场景读进来时也会补上默认值。
     */
    /** 线条样式：实线 / 虚线 / 点线 / 点划线（顶部属性栏） */
    lineDash?: "solid" | "dashed" | "dotted" | "dashdot";
    /** 虚线的留空间距（画布像素，1~20）；缺省 6 */
    lineDashGap?: number;
    /** 箭头样式（画布悬浮条里的下拉选择） */
    arrowStyle?: ArrowStyleKey;
    /** 箭头端点与折角是否圆润；缺省视为开启 */
    arrowRounded?: boolean;
    /** 画线的线端是否圆润；缺省视为开启（圆头），关掉是方头 */
    lineRound?: boolean;
    /** 序号引线末端的样式：箭头 / 圆点 / 方点；缺省箭头 */
    numberTip?: "arrow" | "dot" | "square";
    /** 序号引线末端为箭头时用哪种箭头样式（与箭头工具同一套七种）；缺省经典 */
    numberArrowStyle?: ArrowStyleKey;
    /**
     * 矩形的圆角半径，画布像素单位；缺省 0 表示直角。
     * 与 ShareX 的 CornerRadius 同义：四个角用同一个半径，缩放矩形时半径不跟着变，
     * 只在矩形窄到放不下时按半边长截断。
     */
    cornerRadius?: number;
    textStrokeEnabled?: boolean;
    textStrokeColor?: string;
    /** 描边宽度，画布像素单位 */
    textStrokeWidth?: number;
    /** 聚光灯遮罩的暗度 0~1；缺省 0.6 */
    spotlightOpacity?: number;
    /** 聚光灯遮罩的颜色：黑色（默认，压暗）或白色（磨砂高亮，适合深色图） */
    spotlightColor?: "black" | "white";
}

export interface AnnotMeta {
    /** 用于侧边栏显示名 */
    label: string;
    createdAt: number;
    updatedAt: number;
    /** 供后续扩展（如导出备注），不参与渲染 */
    note?: string;
}

export interface AnnotObject {
    id: string;
    type: AnnotType;
    geometry: Geometry;
    style: AnnotStyle;
    meta: AnnotMeta;
}

/** 视口状态随场景一起保存，二次打开时还原缩放与平移 */
export interface ViewportState {
    zoom: number;
    panX: number;
    panY: number;
}

/**
 * 2×3 仿射矩阵，SVG / CSS 的 matrix(a b c d e f) 顺序。
 * 这里只用来描述「原始图片 → 画布」这一层映射：
 *   x' = a·x + c·y + e
 *   y' = b·x + d·y + f
 * 旋转 90°、翻转、裁切、扩画布都只是往它左边乘一个矩阵，
 * 因此不需要把旋转角、翻转标记拆开存，也不会出现组合后对不上的情况。
 */
export interface Matrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

/**
 * 画布状态。
 * - width/height：画布尺寸（画布坐标系，也是标注坐标系的单位）
 * - naturalWidth/naturalHeight：原始图片像素尺寸，只用于绘制底图
 * - matrix：把原始图片贴进画布所用的变换
 */
export interface CanvasState {
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    matrix: Matrix;
    /**
     * 画布底色（扩展画布时铺在新留白上的颜色）。
     * null / 缺省 = 透明。只在画布坐标里铺一层纯色，底图本身不被改写。
     */
    background?: string | null;
}

/**
 * 当前画布窗口在「完整视图」里的矩形，和参考插件的 cropData 是同一件事。
 *
 * 完整视图＝原始底图按当前旋转 / 翻转贴好、左上角归到 (0,0) 之后的范围；
 * 裁剪只是把这个视图开了一个窗口，所以把它显式记下来，保存后重新打开时
 * 就能准确把窗口扩回去，不用靠图片属性去猜。x/y 允许为负（扩展画布加过留白）。
 */
export interface CropWindow {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AnnotScene {
    version: number;
    /** 主关联键：图片所在块的 data-node-id */
    blockId: string;
    /** 辅助关联键 / 兜底：assets/xxx.png */
    assetPath: string;
    /** 图片原始尺寸，用于坐标校验 */
    imageWidth: number;
    imageHeight: number;
    /** 画布状态（v2 起；读取 v1 场景时自动补齐） */
    canvas: CanvasState;
    /** 裁剪窗口（显式持久化，保存后再次裁剪靠它扩回完整图） */
    crop?: CropWindow | null;
    objects: AnnotObject[];
    viewport: ViewportState;
    updatedAt: number;
}

export function createEmptyScene(blockId: string, assetPath: string): AnnotScene {
    return {
        version: SCENE_VERSION,
        blockId,
        assetPath,
        imageWidth: 0,
        imageHeight: 0,
        canvas: {
            width: 0,
            height: 0,
            naturalWidth: 0,
            naturalHeight: 0,
            matrix: {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0},
            background: null,
        },
        objects: [],
        viewport: {zoom: 1, panX: 0, panY: 0},
        updatedAt: Date.now(),
    };
}

/** 侧边栏显示用的中文名 */
export const TYPE_LABELS: Record<AnnotType, string> = {
    arrow: "箭头",
    rect: "矩形",
    ellipse: "椭圆",
    text: "文字",
    number: "序号",
    mosaic: "马赛克",
    blur: "模糊",
    highlight: "高亮",
    highlightRect: "矩形高亮",
    line: "画线",
    spotlight: "聚光灯",
    magnifier: "放大镜",
};

/**
 * 序号重排：按对象数组顺序，把所有序号标注改成 1..N 连续编号。
 * 新增、删除、重排后都要调用；这样删掉中间的 2，后面的会自动变成 2，
 * 不会出现索引间隙（capcap 原版没有做，这里按需求补齐）。
 * 返回是否真的发生了改动，便于决定是否提交历史。
 */
export function reindexNumbers(objects: AnnotObject[]): boolean {
    let next = 1;
    let changed = false;
    for (const object of objects) {
        if (object.type !== "number") continue;
        const geometry = object.geometry as NumberGeometry;
        if (geometry.number !== next) {
            geometry.number = next;
            object.meta.updatedAt = Date.now();
            changed = true;
        }
        next++;
    }
    return changed;
}

/** 唯一 id：优先 crypto.randomUUID，老环境退化为时间戳 + 随机数 */
export function createId(): string {
    const cryptoObj = globalThis.crypto as Crypto | undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
        return cryptoObj.randomUUID();
    }
    return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 对象样式的增量修改（悬浮条 / 色轮 / 预设都走它，改完再 commit 记历史） */
export interface PropertyPatch {
    color?: string;
    lineWidth?: number;
    opacity?: number;
    fillMode?: "none" | "solid" | "translucent";
    fillOpacity?: number;
    fontSize?: number;
    text?: string;
    blockSize?: number;
    /** 模糊强度（画布像素） */
    blurRadius?: number;
    rotation?: number;
    lineDash?: "solid" | "dashed" | "dotted" | "dashdot";
    arrowStyle?: ArrowStyleKey;
    arrowRounded?: boolean;
    lineRound?: boolean;
    textStrokeEnabled?: boolean;
    textStrokeColor?: string;
    textStrokeWidth?: number;
}
