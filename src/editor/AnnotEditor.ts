/**
 * 标注编辑器（里程碑三：七种标注工具 + 侧边栏 + 属性面板）。
 *
 * 渲染骨架：底图 <img> 与 <svg> 在同一个 CSS transform 容器内，
 * SVG 的 viewBox 恒等于图片原始像素，所有几何数据与缩放解耦。
 * 所有标注都是纯数据对象，绘制/拖拽/属性修改改的都是 geometry 与 style，
 * 因此任何对象都能事后反复调整；历史栈只保存对象数组的快照。
 *
 * 里程碑三仍未做持久化：关闭再打开画面回到空白是预期行为（里程碑四实现）。
 */

import {Dialog, showMessage} from "siyuan";
import {applyTheme, watchTheme, type ThemePreference} from "./theme";
import {EditorHistory, type EditorSnapshot} from "./history";
import {SVG_NS, distance, midpoint, svgEl} from "./geometry";
import {MosaicRenderer} from "./mosaic";
import {BlurRenderer, DEFAULT_BLUR_RADIUS, MAX_BLUR_RADIUS} from "./blur";
import {loadScene, exportFlatPng} from "./persistence";
import {notifySceneSaved} from "./preview";
import {
    bytesToDataUrl, embeddableMime, parseAnnotatedSvg,
} from "./svgfile";
import {
    PACKAGE_VERSION, readPackage, writePackage, pngBytesOf,
    type ImageBase, type ImagePackage,
} from "./imagePackage";
import {Sidebar, type SidebarSelectMods} from "./sidebar";
import {
    loadPresets, savePresets, normalizeHex, loadCurrentStyle, saveCurrentStyle, clonePresets,
    DEFAULT_PRESETS, DEFAULT_CURRENT,
    type StylePresets, type CurrentStyle, type LineDashKey,
} from "./presets";
import {
    ARROW_STYLE_ICONS, CHEVRON_DOWN_ICON, CONTEXT_TOOLS, TOOL_ICONS, UNDO_ICON, REDO_ICON,
    SETTINGS_ICON, HELP_ICON, CANVAS_BUTTONS, CLOSE_ICON, cornerRadiusIcon,
    FULLSCREEN_ICON, RESTORE_ICON, ALIGN_ICON, ALIGN_ACTIONS,
} from "./icons";
import type {AlignOp} from "./icons";
import {CORNER_RADIUS_OPTIONS, MOBILE_CORNER_STEPS, normalizeCornerRadius} from "./cornerRadius";
import {
    MagnifierRenderer, MAGNIFIER_ZOOMS, DEFAULT_MAGNIFIER_ZOOM,
    nudgeAnchorOutside, normalizeMagnifierZoom,
} from "./magnifier";
import {NUMBER_FORMATS, normalizeNumberFormat, type NumberFormatKey} from "./numberFormat";
import {NUMBER_TIPS, normalizeNumberTip, type NumberTipKey} from "./numberTip";
import {
    MAX_SAVED_COLORS, addSavedColor, loadColorPresets, moveSavedColor, normalizeColorHex,
    removeSavedColor, saveColorPresets, setCustomColor, type ColorPresetState,
} from "./colorPresets";
import {pickBadgeTextColor} from "./color";
import {ColorWheel} from "./colorWheel";
import {normalizeArrowStyle} from "./arrowStyles";
import type {ArrowStyleKey} from "../types";
import {fitTransform, computeZoomTransform} from "./viewport";
import {
    applyMatrix, createCanvas, cropWindowOf, extendCanvas, flipCanvas,
    invert, mapRect, remapObjects, rotateCanvas, toMatrixString,
} from "./canvas";
import {detectRegions, SMART_MAX_SIDE, type SmartRegion, type SmartRun} from "./smartSelect";
import SmartWorker from "./smartWorker?worker&inline";
import {
    DEFAULT_EXTEND, EXTEND_DIRS, allDirectionsOn, backgroundForState, firstActiveDir, isDirEditable,
    loadExtendState, marginsForState, hasAnyDirection, saveExtendState, slotColorForState, valueForDir,
    type ExtendDir, type ExtendSlot, type ExtendState,
} from "./extend";
import {
    CROP_HANDLES, CROP_RATIO_PRESETS, dragCropRect, fitCropRatio, moveCropRect,
    resizeCropRect, type CropHandle,
} from "./crop";
import {CropSession} from "./cropSession";
import {
    renderObject, renderDraft, renderHandles, getBounds, boundsCenter,
    translateObject, scaleObjectToBounds, unrotatePoint, setRotation,
    defaultStyle, DEFAULT_TEXT_STROKE_COLOR, DEFAULT_TEXT_STROKE_WIDTH, type Bounds,
} from "./shapes";
import {
    TEXT_LINE_HEIGHT, charWidthRatio, layoutText, measureText, reflowTextObjects, textBlockSize, wrapWidthOf,
} from "./textLayout";
import {ContrastSampler, contrastInk} from "./contrast";
import {
    angleOffsetFromGrid, maxPathDeviation, shouldSnapTouchLine, snapDirection,
} from "./line";
import {
    createEmptyScene, createId, reindexNumbers, TYPE_LABELS,
    type AnnotObject, type AnnotScene, type AnnotType, type ArrowGeometry,
    type CanvasState, type CropWindow, type EllipseGeometry, type Geometry, type HighlightGeometry,
    type BlurGeometry, type LineGeometry, type MagnifierGeometry, type MosaicGeometry,
    type NumberGeometry, type Point, type PropertyPatch, type RectGeometry, type SpotlightGeometry,
    type TextGeometry, type ToolType, type ViewportState,
} from "../types";
import {
    getFileBlob, isMobileRuntime, putFile, replaceBlockImage, refreshImageSrc, type ImageTarget,
} from "../platform";

/** 触屏「停顿自动矫正」：适用的都是支持 Shift 约束的那几个工具 */
const TOUCH_SNAP_TYPES = new Set<string>(["arrow", "line", "rect", "highlightRect", "ellipse", "spotlight", "magnifier"]);
/** 手指停住多久算「停顿」 */
const TOUCH_HOLD_MS = 300;
/** 停顿后手指抖动多少屏幕像素以内仍保持吸附 */
const TOUCH_SNAP_TOLERANCE = 10;

/**
 * 双指「类 Shift」判定：一根手指按下后位移不超过这个值，就算「按住不动」。
 * 只有「一指按住 + 一指滑动」才进约束绘制；两根都动就是画布缩放。
 */
const GESTURE_HOLD_SLOP = 5;
/**
 * 已经进入约束后，「按住不动」那根手指允许的累计抖动。
 * 比进入阈值大一圈（滞回），免得手一抖就被判成「两指都在动」而中断这一笔。
 */
const GESTURE_RELEASE_SLOP = 10;

/** 下一帧执行；jsdom 等没有 requestAnimationFrame 的环境退回 setTimeout */
const nextFrame = (fn: () => void): void => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 0);
};

const STAGE_PADDING = 32;
const MIN_DRAW_SIZE = 6;
const MIN_CROP_SIZE = 24;
const COMPACT_WIDTH = 880;

/** 裁剪框上的 ✓ / ✕：24 视图的描边路径，画在彩色圆底上 */
const CROP_CHECK_PATH = "M6.4 12.6l3.7 3.7 7.5-8.2";
const CROP_CROSS_PATH = "M8 8l8 8M16 8l-8 8";

/** 各手柄对应的鼠标指针（角斜向、边单向） */
function cropCursor(handle: CropHandle): string {
    switch (handle) {
        case "nw":
        case "se":
            return "nwse-resize";
        case "ne":
        case "sw":
            return "nesw-resize";
        case "n":
        case "s":
            return "ns-resize";
        default:
            return "ew-resize";
    }
}
export const THEME_STORAGE_KEY = "siyuan-plugin-annotate:theme";

/**
 * 箭头样式下拉：ShareX 的五种 + 用户要求保留的两种竖线连接线。
 * 顺序即下拉里的顺序，「基础」放第一位（用户要求，最常用的实心三角）。
 * 注意这只影响显示顺序，默认样式仍然是「经典」（背弧更耐看），
 * 因此下拉展开时高亮的是「经典」而不是第一项。
 */
const ARROW_STYLES: {key: ArrowStyleKey; label: string; hint: string}[] = [
    {key: "basic", label: "基础", hint: "线加直底边实心三角（ShareX Basic）"},
    {key: "classic", label: "经典", hint: "线加内凹背弧的实心箭头（ShareX Classic）"},
    {key: "modern", label: "现代", hint: "粗杆与大翼一体成型的箭头（ShareX Modern）"},
    {key: "double", label: "双头", hint: "两端都是经典箭头（ShareX Double）"},
    {key: "line", label: "线条", hint: "线加空心的 V 形箭头（ShareX Line）"},
    {key: "bar", label: "两端竖线", hint: "中间连接线与两端竖线相连"},
    {key: "barDouble", label: "竖线双头", hint: "两端竖线加双向箭头"},
];

/** 高亮的两种画法：笔迹涂抹 / 拖出矩形色块（两个端共用一个入口） */
const HIGHLIGHT_MODES: {key: "brush" | "rect"; label: string; hint: string}[] = [
    {key: "brush", label: "画笔高亮", hint: "按住自由涂抹，留下荧光笔一样的笔迹"},
    {key: "rect", label: "矩形高亮", hint: "拖出一块半透明色块，画完可以选中、拖动、改大小和颜色"},
];

/** 每个工具在底栏中间显示的一句话提示 */
const TOOL_HINTS: Record<ToolType, string> = {
    select: "选择：点对象选中，拖角点缩放，拖顶部菱形旋转",
    pan: "平移：按住拖动整张画布；滚轮缩放、空格 + 拖动也能平移",
    arrow: "箭头：按住拖出，拖两端改起止点，拖中间菱形掰成弧线",
    rect: "矩形：按住拖出方框，可连续画",
    ellipse: "椭圆：按住拖出椭圆，可连续画",
    text: "文字：点一下直接输入，回车或点空白处完成",
    number: "序号：点一下放序号，向外拖可拉出引线",
    mosaic: "马赛克：按住拖出需要遮挡的区域",
    blur: "模糊：按住拖出需要虚化的区域",
    highlight: "高亮：按住自由涂抹；切到「矩形高亮」可以拖出一块半透明色块",
    line: "画线：拖一下直线；点一下定起点，再点连折线，双击或 Esc 结束；按 Shift 锁定水平/垂直/45°",
    spotlight: "聚光灯：按住拖出要照亮的一块，四周自动压暗；拖框挪位置，拖角点改大小",
    magnifier: "放大镜：按住拖出显示框；拖小圆点换「看哪儿」，拖框挪位置，连线始终跟着",
};

/**
 * 扩展画布的方向名，用于底栏提示（「上」而不是 top）。
 */
const DIR_NAMES: Record<ExtendDir, string> = {top: "上", right: "右", bottom: "下", left: "左"};

interface Draft {
    type: AnnotType;
    geometry: Geometry;
}

type DragState =
    | {kind: "draw"; tool: AnnotType; start: Point}
    /** 画折线时的「点一下加一个折点」：不重建草稿，松手也不提交 */
    | {kind: "lineClick"; start: Point}
    | {kind: "move"; start: Point; original: AnnotObject; group?: AnnotObject[]}
    | {
        kind: "handle";
        handle: string;
        /** 按下的位置：用来判断这是「点了一下手柄」还是「真的在拖」 */
        start: Point;
        original: AnnotObject;
        originalBounds: Bounds;
        center: Point;
        rotation: number;
        startAngle: number;
    };

export interface AnnotEditorOptions {
    target: ImageTarget;
    onClosed?: () => void;
    i18n?: Record<string, string>;
}

function cloneObject(object: AnnotObject): AnnotObject {
    return JSON.parse(JSON.stringify(object)) as AnnotObject;
}

function cloneGeometry(geometry: Geometry): Geometry {
    return JSON.parse(JSON.stringify(geometry)) as Geometry;
}

/** 聚光灯的遮挡形状（悬浮条上的两颗小按钮） */
const SPOTLIGHT_SHAPES: {key: "rect" | "ellipse"; label: string; hint: string}[] = [
    {key: "rect", label: "矩形", hint: "遮罩挖出一个矩形亮区"},
    {key: "ellipse", label: "椭圆", hint: "遮罩挖出一个椭圆亮区（圆形聚光）"},
];

/** 聚光灯遮罩的颜色：黑色压暗 / 白色磨砂高亮 */
const SPOTLIGHT_COLORS: {key: "black" | "white"; label: string; hint: string}[] = [
    {key: "black", label: "黑色", hint: "黑色遮罩：四周压暗，常规用法"},
    {key: "white", label: "白色", hint: "白色遮罩：四周磨砂高亮，深色背景图上更醒目"},
];

/** 放大镜显示框的形状 */
/** 顶栏线型的顺序（与旧版一致，索引就是「第几档」） */
const DASH_ITEMS: {key: LineDashKey; label: string}[] = [
    {key: "solid", label: "实线"},
    {key: "dashed", label: "虚线"},
    {key: "dotted", label: "点线"},
    {key: "dashdot", label: "中心线"},
];

/** 「自定义预设」编辑模式下，小窗正在改的是哪一类档位 */
type PresetSlotKind = "color" | "width" | "dash" | "fill" | "font";

/** 色轮弹窗当前作用的目标 */
type ColorPopTarget =
    | {kind: "current"}
    | {kind: "prop"; prop: "color" | "textStrokeColor"}
    | {kind: "extend-bg"}
    | null;

/** data-preset 的名字 → 档位类别（顶栏里每一档都是独立的一个槽） */
const SLOT_KINDS: Record<string, PresetSlotKind | undefined> = {
    color: "color",
    lineWidth: "width",
    lineDash: "dash",
    fillOpacity: "fill",
    fontSize: "font",
};

const MAGNIFIER_SHAPES: {key: "rect" | "ellipse"; label: string; hint: string}[] = [
    {key: "ellipse", label: "圆形", hint: "圆形镜片，最像真的放大镜"},
    {key: "rect", label: "矩形", hint: "方形镜片，适合看表格、代码"},
];

// ---------------------------------------------------------------- 顶部悬浮栏图标
// 全部 24×16 视图、线宽 2、fill="none"，与 PC 顶栏图标同一套规格。
// 每个 svg 都自带 fill="none"：思源有全局 svg{fill:currentColor}，不写会被填成实心块。
const TB_SVG = `<svg class="annot-icon" viewBox="0 0 24 16" fill="none" aria-hidden="true" focusable="false"`;
/** 圆线：两端圆头 */
const TB_ROUND_ON = `${TB_SVG}><path d="M3 8H21" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>`;
/** 方头：两端平收口，跟圆线区分开 */
const TB_ROUND_OFF = `${TB_SVG}><path d="M3 8H21" stroke="currentColor" stroke-width="3.4" stroke-linecap="butt"/></svg>`;
/** 引线端点：箭头 / 圆点 / 方点 */
const TB_TIP_ICONS: Record<string, string> = {
    arrow: `${TB_SVG}><path d="M2 8H14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`
        + `<path d="M13 3.6L22 8L13 12.4Z" fill="currentColor"/></svg>`,
    dot: `${TB_SVG}><path d="M2 8H13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`
        + `<circle cx="17.5" cy="8" r="3.4" fill="currentColor"/></svg>`,
    square: `${TB_SVG}><path d="M2 8H13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>`
        + `<rect x="14.2" y="4.6" width="6.8" height="6.8" rx="1" fill="currentColor"/></svg>`,
};
/** 显示框 / 遮罩形状 */
const TB_SHAPE_RECT = `${TB_SVG}><rect x="3" y="3" width="18" height="10" rx="2" stroke="currentColor" stroke-width="2"/></svg>`;
const TB_SHAPE_ELLIPSE = `${TB_SVG}><ellipse cx="12" cy="8" rx="9" ry="5" stroke="currentColor" stroke-width="2"/></svg>`;
/** 高亮「画笔」模式：两道平行斜杠，接近荧光笔涂抹出来的痕迹 */
const TB_BRUSH = `${TB_SVG}><path d="M3.6 12.6 11.4 4.8M7.2 14.4 15 6.6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
/** 选区识别：虚线框 + 一条贴合内容的横线 */
const TB_SMART = `${TB_SVG}><rect x="3" y="3" width="18" height="10" rx="2" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2"/><path d="M9 8h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
/** 遮罩颜色：左半黑 / 左半白 */
const TB_MASK_BLACK = `${TB_SVG}><circle cx="12" cy="8" r="6" stroke="currentColor" stroke-width="1.8"/>`
    + `<path d="M12 2a6 6 0 0 0 0 12Z" fill="currentColor"/></svg>`;
const TB_MASK_WHITE = `${TB_SVG}><circle cx="12" cy="8" r="6" fill="currentColor"/>`
    + `<path d="M12 2a6 6 0 0 1 0 12Z" fill="var(--annot-panel)"/></svg>`;

/** 顶部悬浮栏的一枚按钮 */
interface MobileTopItem {
    /** 气泡的类型，也是 data-pop 的值 */
    key: string;
    /** 按钮上的两字标签 */
    label: string;
    /** 按钮里的图标（SVG 或一个字符 span） */
    icon: string;
    /** 常驻高亮（如「圆线」开着） */
    on?: boolean;
    /** 只有开 / 关两态：点一下直接切，不弹气泡 */
    toggle?: boolean;
    /** 开关型按钮直接复用的 PC action（有它就不弹气泡） */
    action?: string;
    /** 长按 / 悬停提示 */
    title: string;
}

const TOOL_ITEMS: {tool: ToolType; label: string; key: string}[] = [
    {tool: "select", label: "选择", key: "v"},
    {tool: "arrow", label: "箭头", key: "a"},
    {tool: "rect", label: "矩形", key: "r"},
    {tool: "ellipse", label: "椭圆", key: "e"},
    {tool: "line", label: "画线", key: "k"},
    {tool: "text", label: "文字", key: "t"},
    {tool: "number", label: "序号", key: "n"},
    {tool: "mosaic", label: "马赛克", key: "m"},
    {tool: "blur", label: "模糊", key: "b"},
    {tool: "highlight", label: "高亮", key: "l"},
    {tool: "spotlight", label: "聚光灯", key: "p"},
    {tool: "magnifier", label: "放大镜", key: "g"},
];

/**
 * 锁链图标：两个环扣在一起（用户给的那版实心图标，1024 画布）。
 * 只把填充色换成 currentColor，尺寸交给 CSS，颜色跟着按钮的选中态走。
 */
const LINK_ICON =
    '<svg class="annot-link__icon" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M582.239997 663.142968c-56.713997 0-113.426994-21.589999-156.609992-64.772997-11.728999-11.726999-11.728999-30.792998 0-42.520998 11.728999-11.726999 30.791998-11.726999 42.520998 0 62.910997 62.909997 165.212992 62.909997 228.121989 0L914.94998 337.169984c62.910997-62.909997 62.910997-165.211992 0-228.121989-62.907997-62.909997-165.210992-62.909997-228.119989 0L502.313 293.565986c-11.728999 11.727999-30.792998 11.727999-42.521998 0-11.726999-11.727999-11.726999-30.792998 0-42.520998L644.308994 66.527997c86.364996-86.364996 226.858989-86.364996 313.163985 0 86.304996 86.363996 86.363996 226.857989 0 313.163985L738.794989 598.368971c-43.183998 43.183998-99.898995 64.772997-156.612992 64.772997L582.239997 663.141968zM221.386014 1023.99995c-56.714997 0-113.429994-21.591999-156.611992-64.772997-86.363996-86.364996-86.363996-226.856989 0-313.163985l218.678989-218.678989c86.364996-86.364996 226.858989-86.364996 313.162985 0 11.727999 11.727999 11.727999 30.791998 0 42.520998-11.727999 11.726999-30.792998 11.726999-42.518998 0-62.910997-62.909997-165.213992-62.909997-228.122989 0L107.29402 688.583966c-62.909997 62.907997-62.909997 165.212992 0 228.120989 62.908997 62.907997 165.211992 62.907997 228.121989 0l184.516991-184.517991c11.728999-11.728999 30.793998-11.728999 42.520998 0 11.728999 11.726999 11.728999 30.790998 0 42.520998L377.938007 959.226953C334.755009 1002.407951 278.040011 1023.99995 221.325014 1023.99995L221.386014 1023.99995z"/>' +
    "</svg>";

/**
 * 方向盘上的箭头图标：只写一条「向上」路径，其余方向靠旋转复用，
 * 四支箭头的粗细、长度、箭头张角因此完全一致。
 */
const ARROW_ICON = (angle: number): string =>
    `<svg class="annot-dir__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<g${angle ? ` transform="rotate(${angle} 12 12)"` : ""}>` +
    `<path d="M12 19.5V5M5.6 11.4L12 5l6.4 6.4"/></g></svg>`;

export class AnnotEditor {
    private dialog: Dialog | null = null;
    private root: HTMLElement | null = null;
    private stage: HTMLElement | null = null;
    /** 舞台可用尺寸（fitToStage 量到的），viewBox 用它换算，避免每帧读布局 */
    private stageW = 0;
    private stageH = 0;
    private transformLayer: HTMLElement | null = null;
    private baseImage: HTMLImageElement | null = null;
    /** 选区识别：Worker（懒创建，创建失败就退回主线程，不影响使用） */
    private smartWorker: Worker | null = null;
    private smartWorkerBroken = false;
    private smartJobs = new Map<number, (regions: SmartRegion[] | null) => void>();
    /** 预识别出来的虚线框（画布坐标）；null 表示当前不在识别模式 */
    private smartRegions: SmartRegion[] | null = null;
    private smartScanning = false;
    /** 每次扫描 / 退出都自增，用来作废迟到的 Worker 结果 */
    private smartScanToken = 0;
    /** 识别模式下的待触发单击：延时 180ms，期间第二指落下或位移过大就取消 */
    private smartTap: {
        index: number;
        start: Point;
        clientX: number;
        clientY: number;
        timer: number;
        onMove: (event: PointerEvent) => void;
    } | null = null;
    /** 手势结束后 200ms 内不响应单击识别，防止抬手那一下误触 */
    private smartCooldownUntil = 0;
    /** 降采样后的整幅画面，按「底图 + 画布 + 矩阵」缓存；点击识别时直接取 */
    private smartBuffer: {key: string; data: Uint8ClampedArray; width: number; height: number; scale: number} | null = null;
    private svg: SVGSVGElement | null = null;
    private objectLayer: SVGGElement | null = null;
    private overlayLayer: SVGGElement | null = null;
    private statusDimensions: HTMLElement | null = null;
    private statusMessage: HTMLElement | null = null;
    private statusZoom: HTMLElement | null = null;
    private hint: HTMLElement | null = null;
    private sidebar: Sidebar | null = null;
    private textEditor: HTMLTextAreaElement | null = null;
    /** 输入框那圈细框：单独一层用混合模式反色，任何底色上都看得见 */
    private textFrame: HTMLDivElement | null = null;
    /** 底图明暗取样：只用来给输入光标挑黑/白 */
    private sampler: ContrastSampler | null = null;
    /** 当前输入框的光标挑色函数（输入 / 移动光标时重算） */
    private refreshTextCaret: (() => void) | null = null;
    private editingTextId: string | null = null;
    /** 单击「已选中的文字」时先记住位置，抬起时若没拖动就进编辑态 */
    private pendingTextEdit: {id: string; start: Point} | null = null;
    private readonly mosaic = new MosaicRenderer();
    private readonly blur = new BlurRenderer();
    private readonly magnifier = new MagnifierRenderer();

    private readonly scene: AnnotScene;
    private readonly history: EditorHistory;
    private readonly target: ImageTarget;
    private readonly i18n: Record<string, string>;
    private readonly onClosed?: () => void;
    private readonly abort = new AbortController();
    private resizeObserver: ResizeObserver | null = null;
    private stopThemeWatch: (() => void) | null = null;
    private themePreference: ThemePreference = "follow";

    private viewport: ViewportState = {zoom: 1, panX: 0, panY: 0};
    /** 画布尺寸（= 画布坐标系范围，SVG viewBox 与它一致） */
    private canvasWidth = 0;
    private canvasHeight = 0;
    /** 移动端：单栏布局 + 触摸手势（构造时按「粗指针 / 窄屏」判定，PC 端保持原样） */
    private readonly mobile = isMobileRuntime();
    /** 双指手势：两根手指的位置与起始视口 */
    private touchPoints = new Map<number, Point>();
    private pinch: {zoom: number; panX: number; panY: number; distance: number; midX: number; midY: number} | null = null;
    /**
     * 双指手势锁：屏幕上只要有 2 根以上手指，就绝不允许绘制。
     * 单靠 pointer 事件判定不可靠（第二根手指的 pointerdown 会被 <svg> 再吃一次，
     * 建出一个新草稿，抬手时 commit 成零尺寸对象），所以另外用原生 touch 的
     * touches.length 做一道硬闸。
     */
    private gestureLocked = false;
    /**
     * 双指手势的判定状态机：
     *  - pending   两指刚落下，还不知道用户要「按住一指画」还是「捏合缩放」
     *  - constrain 一指按住不动 + 另一指滑动 → 类 Shift 约束绘制
     *  - pinch     两指都在动 → 画布缩放
     */
    private gestureMode: "none" | "pending" | "constrain" | "pinch" = "none";
    /** 每根手指落下时的起点，用来判断谁在动、谁按住不动 */
    private gestureStart = new Map<number, Point>();
    /** 约束绘制时，最近一次移动的那根手指（抬起它＝这一笔结束） */
    private gestureDriveId: number | null = null;
    /** 约束绘制时「按住不动」的那根手指（它一旦动起来就转成画布缩放） */
    private gestureHoldId: number | null = null;
    /** 约束期间强制按 Shift 计算几何：画线吸附 / 矩形椭圆 1:1 */
    private forceShift = false;
    /** 上栏当前内容签名：只有工具 / 对象类型 / 裁剪态变了才重建，保住横向滚动位置 */
    private mobileStyleKey = "";
    /** 移动端「属性」抽屉是否展开（选中对象不再自动弹，避免挡住画布） */
    private mobileSheetOpen = false;
    /** 移动端键盘检测的基准高度（键盘没弹时视口有多高） */
    private mobileViewportBase = 0;
    /** 键盘弹出前的舞台高度（键盘态要把它锁住，否则隐藏三栏会让画布变高、内容整体缩放） */
    private mobileStageBase = 0;
    /** 键盘状态同步（beginTextEdit / finishTextEdit 会主动调一次） */
    private keyboardSync: (() => void) | null = null;
    /** 上一次画手柄用的 zoom：底图缩放后要按新比例重画，手柄才不会跟着变大变小 */
    private overlayZoom = 1;
    /**
     * 「点空白处取消选中」不在按下那一刻执行，改成抬手时确认没拖动才清。
     * 双指缩放时第一根手指常常落在空白上，按下就清会让手柄瞬间消失。
     */
    private pendingDeselect: {start: Point} | null = null;
    /**
     * 双指开始前选中的是谁。
     * 绘制工具下第一根手指落在空白处会「起笔并清空选中」（这是单指绘制的正常逻辑），
     * 但用户其实是要双指缩放 —— 缩放结束时要把选中还回去，否则一捏合手柄就全没了。
     */
    private selectionBeforeGesture: string[] | null = null;
    /** 移动端顶部悬浮栏当前展开的是哪一枚按钮（null＝全部收起） */
    private mobilePopKey: string | null = null;
    /** 顶部栏上一次渲染用的指纹，没变就不重画，免得把手指下的滚动位置重置 */
    private mobileTopKey = "";
    /** 原始图片像素尺寸（底图按画布矩阵缩放/旋转后贴进画布） */
    private naturalWidth = 0;
    private naturalHeight = 0;
    private userAdjustedViewport = false;
    /**
     * 首次「适应窗口」是否已经成功做过。
     * 图片可能还没解码完、窗口可能还没布好版，用户也可能在这期间滚了滚轮
     * （会把 userAdjustedViewport 置为 true）。在首次适应成功之前，
     * 这条标记让 fitToStage 忽略 userAdjustedViewport，保证「一打开一定整张可见」。
     */
    private initialFitDone = false;
    /** 上一次适应窗口时用的舞台尺寸，用来判断「舞台变了没」 */
    private lastFitStage = {width: 0, height: 0};
    /** 裁切路径 id：让对象层被画布边界裁掉，但手柄不被裁 */
    private readonly clipId = `annot-clip-${Math.random().toString(36).slice(2, 8)}`;

    private activeTool: ToolType = "select";
    private presets: StylePresets = loadPresets();
    private current: CurrentStyle = {...DEFAULT_CURRENT};
    /** 「自定义预设」进入三段式时记下的快照：取消要一字不差地还回去 */
    private presetEdit: {
        style: CurrentStyle;
        presets: StylePresets;
        objectId: string | null;
        objectStyle: AnnotObject["style"] | null;
        objectGeometry: AnnotObject["geometry"] | null;
    } | null = null;
    /** 预设编辑模式下「正在改哪一档」：点第几个圆点 / 第几档粗细，就只改那一个 */
    private slotEdit: {kind: PresetSlotKind; index: number} | null = null;
    /**
     * 当前选中的对象（多选时是多个）。
     * 单选的一切旧逻辑仍然读写 this.selectedId —— 它就是「最后点的那一个」，
     * 多选模式下额外用 this.selectedIds 表示整组。两者永远同步，不会各说各话。
     */
    private selectedIds: string[] = [];
    /** 多选模式的锚点：列表里 Shift 点另一项时，选的就是「锚点 → 当前项」这一段 */
    private selectAnchor: string | null = null;
    /** 「对齐」模式（悬浮条上的对齐按钮）：开启后画布 Ctrl 点多选才生效 */
    private alignMode = false;
    /** 触屏「停顿自动矫正」：停住 300ms 就吸附，继续滑动立刻解除 */
    private touchHoldTimer = 0;
    private touchSnapped = false;
    private touchSnapAnchor: Point | null = null;
    private hoveredId: string | null = null;

    /**
     * 单选语义的入口：读＝主选对象（最后点的那一个），写＝把选择收成这一个。
     * 所有只针对「当前对象」的逻辑（样式、手柄、悬浮条参数）继续走它，不用改。
     */
    private get selectedId(): string | null {
        return this.selectedIds.length ? this.selectedIds[this.selectedIds.length - 1] : null;
    }

    private set selectedId(value: string | null) {
        this.selectedIds = value ? [value] : [];
        this.selectAnchor = value;
    }
    private drag: DragState | null = null;
    private draft: Draft | null = null;
    /** 拖拽绘制中最后一次指针位置：Shift 按下 / 松开时用它就地重算，不必等鼠标再动 */
    private draftPointer: Point | null = null;
    /** 正在连续点折线（仅 PC）：draft 的最后一个点是跟随鼠标的「预览点」 */
    private linePolyline = false;
    /** 触屏画线的轨迹采样：用于判断末端停顿、轨迹笔直度 */
    private lineTouch: {samples: Point[]; lastMoveAt: number} | null = null;
    /** 悬浮工具条的默认参数（没选中对象时也能先调，画出来就带这个值） */
    private contextDefaults = {blockSize: 16, blurRadius: 12, opacity: 100};
    /** 箭头样式下拉是否展开（展开时下拉列表画在按钮正下方） */
    private arrowPickerOpen = false;

    /** 矩形圆角下拉是否展开 */
    private cornerPickerOpen = false;
    /** 序号的「编号格式」下拉是否展开 */
    private numberFormatOpen = false;
    /** 序号的「箭头样式」下拉是否展开（端点=箭头时才存在） */
    private numberStyleOpen = false;
    /** 自定义颜色弹窗是否展开（顶部属性栏的十字圆球 / 属性面板 / 移动端上栏共用） */
    private colorPopOpen = false;
    /** 取色弹窗这次在改谁：当前颜色 / 某个对象的属性 / 扩展画布底色 */
    private colorPopTarget: ColorPopTarget = null;
    /** 取色弹窗的定位锚点（点开它的那颗按钮） */
    private colorPopAnchor: HTMLElement | null = null;
    /** 取色弹窗里的色轮 */
    private colorWheel: ColorWheel | null = null;
    /** 「自定义预设」点色点时，参数小窗里的色轮 */
    private slotWheel: ColorWheel | null = null;
    /** 自定义颜色 + 颜色预设（本地存储） */
    private colorState: ColorPresetState = loadColorPresets();
    /** 颜色预设正在被拖动的下标；null = 没在拖 */
    private colorDragIndex: number | null = null;
    /** 拖动开始时记录指针位置，超过阈值才算「拖」，否则仍是点击应用颜色 */
    private colorDragStart: Point | null = null;
    /** 这一次指针操作是否已经变成拖动（松手时据此决定要不要重排序） */
    private colorDragMoved = false;
    /** 最近一次图像操作，用来决定悬浮条显示哪一组参数 */
    private lastCanvasOp: string | null = null;
    private spaceDown = false;
    private panDrag: {startX: number; startY: number; panX: number; panY: number} | null = null;
    private helpVisible = false;
    private compact = false;
    /** PC 全屏（铺满思源窗口）状态；手机本来就是整屏，不参与 */
    private fullscreen = false;
    /** 全屏前的内联样式快照，还原时原样写回，绝不残留任何 important 覆盖 */
    private fullscreenBackup: {el: HTMLElement; style: string | null}[] = [];
    /** 全屏切换后的延迟重排计时器（布局要等一两帧才稳） */
    private fullscreenTimers: number[] = [];
    /**
     * 窗口是否由我们切进了系统全屏。
     *
     * Windows / Linux 上思源用 Electron 的「窗口控制按钮浮层」（titleBarOverlay）：
     * 右上角那三个按钮是操作系统直接画在窗口上的，根本不在 DOM 里，
     * 所以 z-index 再高也盖不住，点下去是真的点到思源窗口（会关掉思源）。
     * 唯一能让它们彻底消失的做法是让窗口本身进系统全屏，退出时再还原。
     */
    private nativeFullscreen = false;

    // 裁切：先拖出保留区域，确认后才真正裁
    private cropMode = false;
    private cropRect: Bounds | null = null;
    private cropDragStart: Point | null = null;
    /** 正在拖的手柄（nw/ne/... 为缩放，null 表示没在缩放） */
    private cropHandle: CropHandle | null = null;
    /** 正在框内平移：记起点与起始矩形，避免累积误差 */
    private cropMove: {origin: Point; rect: Bounds} | null = null;
    /** 本次拖拽的上一个坐标（缩放按增量算，手感更稳） */
    private cropLastPoint: Point | null = null;
    /** 当前锁定的比例（宽/高），null = 自由 */
    private cropAspect: number | null = null;
    /** 高亮的比例按钮 key（free / source / 16:9 ...） */
    private cropAspectKey = "free";
    /**
     * 裁剪会话：完整视图、累计裁剪窗口、进入裁剪前的现场都由它保管
     * （对齐参考插件的 _originalSrc / _cropOffset / cropData 三件套）。
     * 只有「进入裁剪 → 应用 / 取消」这段时间非空。
     */
    private cropSession: CropSession | null = null;
    /** 临时铺回完整原图时标注被平移过，取消时直接还回这份原始坐标 */
    private cropObjectsBackup: AnnotObject[] | null = null;
    private statusTimer: number | null = null;

    /** 扩展画布面板的状态（方向 / 数值 / 底色），会记住上次的选择 */
    private extendState: ExtendState = {...DEFAULT_EXTEND, dirs: {...DEFAULT_EXTEND.dirs}, sides: {...DEFAULT_EXTEND.sides}};
    /** 吸管取色模式：下一次点击画布就是取色 */
    private pickMode = false;

    /**
     * 完整原始底图（写进 PNG 的工程数据里，裁剪后仍能扩回外围）。
     * 打开普通图片时保存前再读盘；打开本插件生成的图片时直接从文件里带出来。
     */
    private baseSource: ImageBase | null = null;
    /** 需要读盘拿底图字节时的资源路径（assets/xxx.png） */
    private sourceAssetPath = "";
    /** 是不是从「自带工程数据的图片」打开的（画布以文件里的为准） */
    private openedFromPackage = false;
    /** 图片里自带的场景数据；旧版 SVG 也能拆出同一份数据 */
    private packageScene: AnnotScene | null = null;

    private finished = false;

    constructor(options: AnnotEditorOptions) {
        this.target = options.target;
        this.presets = loadPresets();
        // 恢复上次点过的颜色 / 线宽 / 填充 / 字号，而不是每次都回到预设第一项
        this.current = loadCurrentStyle(this.presets);
        this.extendState = loadExtendState();
        this.scene = createEmptyScene(options.target.blockId, options.target.assetPath);
        this.history = new EditorHistory({objects: this.scene.objects, canvas: this.scene.canvas});
        this.i18n = options.i18n ?? {};
        this.onClosed = options.onClosed;
        this.open(options.target);
    }

    /**
     * 把对话框真正铺满手机屏幕。
     *
     * 只用 CSS 类不可靠：不同思源版本里 Dialog 的 element 可能是 `.b3-dialog`，
     * 也可能是 `.b3-dialog__container`，圆角还可能挂在 body 上；一旦选择器对不上，
     * 顶部就会残留两个灰圆角、四周留一圈底色。这里直接找齐这几层写内联样式，
     * 优先级最高，任何主题 / 版本都盖不掉。
     */
    private applyMobileFullscreen(element: HTMLElement): void {
        const shell = element.classList.contains("b3-dialog")
            ? element
            : element.closest<HTMLElement>(".b3-dialog") ?? element;
        shell.classList.add("annot-dialog-fullscreen");
        shell.style.setProperty("padding", "0", "important");
        shell.style.setProperty("margin", "0", "important");
        shell.style.setProperty("border-radius", "0", "important");
        shell.style.setProperty("background", "transparent", "important");

        const container = element.classList.contains("b3-dialog__container")
            ? element
            : element.querySelector<HTMLElement>(".b3-dialog__container") ?? element;
        const body = element.querySelector<HTMLElement>(".b3-dialog__body") ?? container;
        for (const layer of [container, body]) {
            layer.style.setProperty("width", "100vw", "important");
            layer.style.setProperty("height", "100dvh", "important");
            layer.style.setProperty("max-width", "none", "important");
            layer.style.setProperty("max-height", "none", "important");
            layer.style.setProperty("margin", "0", "important");
            layer.style.setProperty("padding", "0", "important");
            layer.style.setProperty("border", "0", "important");
            layer.style.setProperty("border-radius", "0", "important");
            layer.style.setProperty("box-shadow", "none", "important");
            layer.style.setProperty("overflow", "hidden", "important");
        }
        // 100dvh 不认的老 WebView 退回 100vh
        const dvhOk = typeof CSS !== "undefined" && typeof CSS.supports === "function"
            && CSS.supports("height", "100dvh");
        if (!dvhOk) {
            container.style.setProperty("height", "100vh", "important");
            body.style.setProperty("height", "100vh", "important");
        }

        // 思源移动端会在右上角再叠一个自带的关闭按钮，正好压在我们的「完成」上
        for (const extra of Array.from(element.querySelectorAll<HTMLElement>(
            ".b3-dialog__close, .b3-dialog__header"))) {
            extra.style.setProperty("display", "none", "important");
        }
    }

    private t(key: string, fallback: string): string {
        return this.i18n[key] || fallback;
    }

    // ---------------------------------------------------------------- 打开窗口
    private open(target: ImageTarget): void {
        this.dialog = new Dialog({
            // 标题由我们自己的两行工具栏首行承载；思源 Dialog 传空标题会
            // 自动给它的 header 加 fn__none，避免同名标题出现两次
            title: "",
            content: "",
            // 手机上直接铺满整屏：94vw/90vh 会留出一圈背景，看着像没打开
            width: this.mobile ? "100vw" : "94vw",
            height: this.mobile ? "100vh" : "90vh",
            containerClassName: "annot-dialog",
            destroyCallback: () => this.finish(),
        });
        if (this.mobile) this.applyMobileFullscreen(this.dialog.element);
        // 系统全屏被 Esc / 窗口管理器撤掉时，界面要跟着还原
        if (!this.mobile) document.addEventListener("fullscreenchange", this.handleFullscreenChange);
        const body = this.dialog.element.querySelector<HTMLElement>(".b3-dialog__body");
        if (!body) {
            this.dialog.destroy();
            this.finish();
            return;
        }

        // 左侧竖栏只放「画东西」的工具：选择与平移常驻在画布上方的悬浮条最左侧，
        // 这里若再放一份，两处状态会各说各话（而且用户明确要求从这里移走）
        const toolButtons = TOOL_ITEMS.filter((item) => item.tool !== "select").map((item) => `
            <button type="button" class="annot-icon-button" data-tool="${item.tool}"
                title="${item.label}（${item.key.toUpperCase()}）" aria-label="${item.label}">${TOOL_ICONS[item.tool]}</button>`).join("");

        const canvasButtons = CANVAS_BUTTONS.map((item) => `
            <button type="button" class="annot-icon-button" data-canvas-op="${item.op}"
                title="${item.hint}" aria-label="${item.label}">${item.icon}</button>`).join("");

        // 手机上的工具按钮要带文字标签：只有图标时「马赛克 / 模糊 / 高亮」太难分辨
        const mobileToolButton = (item: {tool: ToolType; label: string}): string => `
            <button type="button" class="annot-mobile-tool" data-tool="${item.tool}"
                title="${item.label}" aria-label="${item.label}">
                <span class="annot-mobile-tool__icon">${TOOL_ICONS[item.tool]}</span>
                <span class="annot-mobile-tool__label">${item.label}</span>
            </button>`;
        // 「选择」固定在左侧不参与滚动：画完一笔想改选/挪动时，不用先把工具栏滑回去
        // 「选择」已经变成左下角的圆钮，工具条里只放真正画东西的工具
        const mobileToolButtons = TOOL_ITEMS.filter((item) => item.tool !== "select")
            .map(mobileToolButton).join("");
        const mobileCanvasButtons = CANVAS_BUTTONS.map((item) => `
            <button type="button" class="annot-mobile-tool" data-canvas-op="${item.op}"
                title="${item.hint}" aria-label="${item.label}">
                <span class="annot-mobile-tool__icon">${item.icon}</span>
                <span class="annot-mobile-tool__label">${item.label.replace(" 90°", "")}</span>
            </button>`).join("");

        const helpRows = [
            ["V / A / R / E / K / T / N / M / B / L", "选择 / 箭头 / 矩形 / 椭圆 / 画线 / 文字 / 序号 / 马赛克 / 模糊 / 高亮"],
            ["画线：双击 / Esc", "结束连续折线；按住 Shift 锁定水平 / 垂直 / 45°"],
            ["Ctrl + Z / Ctrl + Shift + Z", "撤销 / 重做（Ctrl + Y 也可重做，含旋转裁切）"],
            ["Ctrl + S", "保存并退出（写回笔记里的这张图）"],
            ["Ctrl + D / Delete", "复制选中对象 / 删除选中对象"],
            ["[ / ]", "选中对象下移一层 / 上移一层"],
            ["滚轮 / 空格 + 拖动 / 中键拖动", "缩放 / 平移画布"],
            ["+ / - / 0", "放大 / 缩小 / 适应窗口"],
            ["Esc / ?", "取消操作或关闭 / 打开本帮助"],
        ].map(([key, text]) => `<div class="annot-help__row"><kbd>${key}</kbd><span>${text}</span></div>`).join("");

        // 顶栏属性分组（沿用旧版结构，一个像素都不改）：
        // 每组是一个带边框的圆角分组框，框里平铺四档预设。
        // 「自定义预设」编辑模式下，点其中某一档才会在它正下方弹出只改这一档的小窗。
        const attrGroup = (role: string): string => `
                <div class="annot-group annot-attr-group">
                    <div class="annot-attr-body" data-role="${role}"></div>
                </div>`;

        const brand = this.t("editorTitle", "勾画阁·猫抓");
        this.root = document.createElement("div");
        this.root.className = this.mobile ? "annot-root annot-root--mobile" : "annot-root";
        this.root.setAttribute("data-annot-plugin-root", "siyuan-plugin-annotate");
        this.root.innerHTML = `
            <div class="annot-titlebar">
                <span class="annot-titlebar__name">${brand}</span>
                <div class="annot-group annot-history">
                    <button type="button" class="annot-icon-button" data-action="undo" title="撤销（Ctrl+Z）" aria-label="撤销">${UNDO_ICON}</button>
                    <button type="button" class="annot-icon-button" data-action="redo" title="重做（Ctrl+Shift+Z）" aria-label="重做">${REDO_ICON}</button>
                </div>
                <span class="annot-titlebar__spacer"></span>
                <select class="annot-theme-select" data-role="theme-select" title="界面颜色" aria-label="界面颜色">
                    <option value="follow">${this.t("themeFollow", "跟随思源")}</option>
                    <option value="light">${this.t("themeLight", "强制浅色")}</option>
                    <option value="dark">${this.t("themeDark", "强制深色")}</option>
                </select>
                <button type="button" class="annot-btn" data-action="close"
                    title="取消：不保存这次的修改，直接关掉">${this.t("close", "取消")}</button>
                <button type="button" class="annot-btn annot-btn--primary" data-action="save"
                    title="保存：写回笔记里的这张图并关掉">${this.t("save", "保存")}</button>
                <button type="button" class="annot-icon-button annot-titlebar__fullscreen" data-action="fullscreen"
                    title="全屏：把编辑器铺满整个思源窗口" aria-label="全屏" aria-pressed="false">${FULLSCREEN_ICON}</button>
            </div>
            ${this.mobile ? `
            <div class="annot-mobile-top">
                <button type="button" class="annot-icon-button annot-mobile-top__close" data-action="close" title="关闭" aria-label="关闭">${CLOSE_ICON}</button>
                <div class="annot-group annot-history">
                    <button type="button" class="annot-icon-button" data-action="undo" title="撤销" aria-label="撤销">${UNDO_ICON}</button>
                    <button type="button" class="annot-icon-button" data-action="redo" title="重做" aria-label="重做">${REDO_ICON}</button>
                </div>
                <span class="annot-mobile-top__spacer"></span>
                <button type="button" class="annot-btn annot-btn--primary annot-mobile-top__done" data-action="save">完成</button>
            </div>
            ` : ""}
            <div class="annot-toolbar" role="toolbar" aria-label="通用属性">
                ${attrGroup("group-colors")}
                ${attrGroup("group-widths")}
                ${attrGroup("group-lines")}
                ${attrGroup("group-fills")}
                ${attrGroup("group-fonts")}
                <button type="button" class="annot-btn annot-tools-toggle" data-action="tools-menu"
                    title="工具菜单" aria-label="工具菜单">工具 ▾</button>
                <div class="annot-group annot-preset-slot" data-role="preset-slot"></div>
            </div>
            <div class="annot-attr-pop" data-role="attr-pop" role="dialog" aria-label="预设参数" hidden></div>
            <div class="annot-tool-menu" data-role="tool-menu" hidden>${toolButtons}</div>
            <div class="annot-help" data-role="help" hidden>
                <div class="annot-help__head">快捷键
                    <button type="button" class="annot-icon-btn" data-action="close-help" aria-label="关闭帮助">✕</button>
                </div>
                ${helpRows}
            </div>
            <div class="annot-color-pop" data-role="color-pop" role="dialog" aria-label="自定义颜色" hidden></div>
            <div class="annot-extend" data-role="extend-pop" hidden>
                <div class="annot-help__head">扩展画布
                    <button type="button" class="annot-icon-btn" data-action="extend-cancel" aria-label="关闭">✕</button>
                </div>

                <div class="annot-extend__block">
                    <span class="annot-extend__label">往哪边扩</span>
                    <div class="annot-extend__top">
                        <div class="annot-dirs" data-role="extend-dirs">
                            <button type="button" class="annot-dir annot-dir--top" data-dir="top"
                                title="向上扩展" aria-label="向上扩展">${ARROW_ICON(0)}</button>
                            <button type="button" class="annot-dir annot-dir--left" data-dir="left"
                                title="向左扩展" aria-label="向左扩展">${ARROW_ICON(-90)}</button>
                            <button type="button" class="annot-dir annot-dir--all" data-dir="all"
                                title="四周同步：四个方向全选并共用第一个数值" aria-label="四周同步">四周<br>同步</button>
                            <button type="button" class="annot-dir annot-dir--right" data-dir="right"
                                title="向右扩展" aria-label="向右扩展">${ARROW_ICON(90)}</button>
                            <button type="button" class="annot-dir annot-dir--bottom" data-dir="bottom"
                                title="向下扩展" aria-label="向下扩展">${ARROW_ICON(180)}</button>
                        </div>
                        <div class="annot-extend__amounts" data-role="extend-amounts">
                            <div class="annot-amount" data-size="top">
                                <span>上</span>
                                <input type="number" data-role="extend-top" min="1" max="2000" step="10" value="60"
                                    aria-label="向上扩展量">
                                <button type="button" class="annot-link" data-action="toggle-link"
                                    aria-label="连接四个方向的数值" title="连接：四个方向共用一个数值">${LINK_ICON}</button>
                            </div>
                            <div class="annot-amount" data-size="bottom">
                                <span>下</span>
                                <input type="number" data-role="extend-bottom" min="1" max="2000" step="10" value="60"
                                    aria-label="向下扩展量">
                                <button type="button" class="annot-link" data-action="toggle-link"
                                    aria-label="连接四个方向的数值" title="连接：四个方向共用一个数值">${LINK_ICON}</button>
                            </div>
                            <div class="annot-amount" data-size="left">
                                <span>左</span>
                                <input type="number" data-role="extend-left" min="1" max="2000" step="10" value="60"
                                    aria-label="向左扩展量">
                                <button type="button" class="annot-link" data-action="toggle-link"
                                    aria-label="连接四个方向的数值" title="连接：四个方向共用一个数值">${LINK_ICON}</button>
                            </div>
                            <div class="annot-amount" data-size="right">
                                <span>右</span>
                                <input type="number" data-role="extend-right" min="1" max="2000" step="10" value="60"
                                    aria-label="向右扩展量">
                                <button type="button" class="annot-link" data-action="toggle-link"
                                    aria-label="连接四个方向的数值" title="连接：四个方向共用一个数值">${LINK_ICON}</button>
                            </div>
                        </div>
                    </div>
                    <p class="annot-extend__hint">先点四个箭头挑选要往哪边扩：<b>只有选中的方向能填数值</b>，没选中的会锁死。点锁链后，选中的方向共用一个数，只在第一个选中的框里输入。</p>
                </div>

                <div class="annot-extend__block">
                    <span class="annot-extend__label">画布底色</span>
                    <div class="annot-bgs" data-role="extend-bgs">
                        <button type="button" class="annot-bg is-active" data-bg="transparent" title="留白保持透明">透明</button>
                        <button type="button" class="annot-bg" data-bg="white" style="background:#FFFFFF" title="白色"></button>
                        <button type="button" class="annot-bg" data-bg="black" style="background:#000000" title="黑色"></button>
                        <button type="button" class="annot-bg annot-bg--custom" data-bg="custom1"
                            data-role="bg-custom1" title="自定义颜色（点开色轮）" aria-label="自定义底色"></button>
                        <button type="button" class="annot-bg annot-bg--custom"
                            data-role="bg-custom2" data-action="bg-pick" aria-label="吸管取色"
                            title="吸管：点一下，然后从图片上取色"><svg class="annot-pick-icon"
                                viewBox="0 0 1024 1024" aria-hidden="true" focusable="false"><path d="M96.376 993.882c-21.082 0-39.152-3.011-54.211-15.058-15.06-15.06-21.083-30.118-21.083-51.2s9.036-39.153 21.083-51.2L102.4 819.2v-6.024c-6.024-45.176 6.024-87.34 39.153-120.47l358.4-358.4L391.529 222.87c-3.011-3.012-6.023-12.047-6.023-18.071 0-6.024 3.012-12.047 6.023-18.07 3.012-3.012 12.047-6.024 18.071-6.024 6.024 0 12.047 3.012 18.07 6.023l75.295 75.295 168.659-168.66c36.14-36.14 81.317-54.211 132.517-54.211 48.188 0 96.377 21.082 132.518 54.212 72.282 72.282 72.282 189.74 0 262.023L768 524.048l75.294 75.293c3.012 3.012 6.024 12.047 6.024 18.07 0 6.024-3.012 12.048-6.024 18.071-6.023 6.024-12.047 6.024-18.07 6.024-6.024 0-12.048-3.012-18.071-6.024L698.729 527.06l-361.411 358.4c-27.106 27.106-60.236 39.153-96.377 39.153-6.023 0-15.059 0-24.094-3.012h-6.023l-60.236 54.212c-12.047 15.059-33.13 18.07-54.212 18.07z m78.306-268.047c-21.082 21.083-30.117 57.224-21.082 87.341 3.012 6.024 3.012 9.036 3.012 12.048v6.023l-3.012 3.012-6.024 6.023-66.258 66.26c-9.036 9.034-9.036 21.082-6.024 30.117 3.012 9.035 15.059 18.07 27.106 18.07 6.024 0 15.059-3.011 21.082-9.035l69.27-69.27 3.013-3.012h9.035c3.012 0 6.024 0 9.035 3.012 9.036 3.011 18.07 3.011 27.106 3.011 24.094 0 45.177-9.035 63.247-27.106l358.4-358.4-126.494-126.494-361.412 358.4zM801.13 90.353c-36.14 0-72.282 15.059-96.376 39.153L536.094 298.165 731.86 493.929l168.659-168.658c54.211-54.212 54.211-141.553 0-195.765-27.106-24.094-63.247-39.153-99.389-39.153z" fill="currentColor"/></svg></button>
                    </div>
                    <p class="annot-extend__tip" data-role="extend-tip">透明＝不铺色；白/黑/自定义＝给扩出来的区域铺底色。吸管可以直接吸图片上的颜色。</p>
                </div>

                <button type="button" class="annot-btn annot-btn--primary" data-action="extend-apply">应用扩展</button>
            </div>
            <div class="annot-main">
                <div class="annot-imagebar" role="toolbar" aria-label="绘图与图像处理" data-role="imagebar">
                    <div class="annot-imagebar__group annot-imagebar__tools" data-role="tool-buttons"
                        aria-label="绘图工具">${toolButtons}</div>
                    <span class="annot-imagebar__sep" aria-hidden="true"></span>
                    <div class="annot-imagebar__group annot-imagebar__canvas" aria-label="图像处理">${canvasButtons}</div>
                </div>
                <div class="annot-stage">
                    <div class="annot-context-bar" data-role="context-bar" hidden></div>
                    <div class="annot-loading" data-role="loading">正在载入图片…</div>
                    <div class="annot-transform" data-role="transform" hidden>
                        <!-- 画布可视窗口：底图只在这里面显示，裁掉的画面不会漏到画布外。
                             标注与手柄仍在上层 SVG 里，贴边也能完整抓到。 -->
                        <div class="annot-viewport" data-role="viewport">
                            <div class="annot-canvas-bg" data-role="canvas-bg" hidden></div>
                            <img class="annot-base" data-role="base" alt="" draggable="false">
                        </div>
                    </div>
                    <!-- 标注层不跟着底图做 CSS 缩放：它自己有 viewBox。
                         放进缩放层的话，浏览器会先按 1200×800 栅格化再拉伸，
                         放大到 350% 时手柄圆点就糊了；独立之后永远是按屏幕像素画的矢量。 -->
                    <svg class="annot-svg" data-role="svg" xmlns="${SVG_NS}"
                        shape-rendering="geometricPrecision"></svg>
                    ${this.mobile ? `
                    <!-- 顶部悬浮参数栏：工具专属参数（箭头样式 / 圆线 / 圆角 / 编号格式…），
                         每个参数一枚小方按钮，点开像气泡一样向下展开。底部两条栏只管通用外观。 -->
                    <div class="annot-mobile-topbar" data-role="mobile-topbar" hidden></div>` : ""}
                </div>
                <aside class="annot-sidebar" data-role="sidebar"></aside>
                <aside class="annot-sidebar annot-crop-side" data-role="crop-side" hidden>
                    <div class="annot-panel-head">
                        <span class="annot-panel-head__title">裁剪</span>
                    </div>
                    <div class="annot-crop-ratios" data-role="crop-ratios">${CROP_RATIO_PRESETS.map((item) =>
                        `<button type="button" class="annot-crop-ratio${item.key === "free" ? " is-active" : ""}"`
                        + ` data-action="crop-ratio" data-ratio="${item.key}"`
                        + ` title="${item.key === "free" ? "不限制比例" : item.key === "source" ? "跟随图片原始比例" : "锁定 ${item.label}"}">`
                        + `${item.label}</button>`).join("")}</div>
                    <button type="button" class="annot-btn annot-crop-full" data-action="crop-full">恢复整张原图</button>
                    <div class="annot-crop-info">
                        <span data-role="crop-size">在图上拖出要保留的区域</span>
                    </div>
                    <p class="annot-crop-tip">框外会压暗；拖四角或四边中点调整，按住框内可整体挪。按 Delete 清掉框重新框选，回车确认、Esc 放弃。保存后再次裁剪会铺回完整原图，把框拖大就能找回之前裁掉的部分。</p>
                    <div class="annot-crop-actions">
                        <button type="button" class="annot-btn annot-btn--primary" data-action="crop-apply">应用裁剪</button>
                        <button type="button" class="annot-btn" data-action="crop-cancel">取消</button>
                    </div>
                </aside>
            </div>
            ${this.mobile ? `
            <!-- 两颗独立圆钮 + 中间两颗等宽胶囊：左「选择」、右「对齐」（触屏不设平移，画布用双指拖动 / 捏合）。
                 缩放与对象都是 80×36，不再随文字长短变宽。 -->
            <div class="annot-mobile-fabs" data-role="mobile-fabs">
                <button type="button" class="annot-fab" data-action="mobile-select"
                    title="选择：点对象选中，拖角点缩放" aria-label="选择">${TOOL_ICONS.select}</button>
                <div class="annot-fab__pair">
                    <button type="button" class="annot-fab-pill" data-action="zoom-fit"
                        title="当前缩放，点一下适应窗口" aria-label="当前缩放，点一下适应窗口"
                        >缩放<b data-role="mobile-zoom">100%</b></button>
                    <button type="button" class="annot-fab-pill" data-action="mobile-props"
                        title="对象列表：选中、调层级、复制、删除" aria-label="对象列表"
                        >对象<b data-role="mobile-count">0</b></button>
                </div>
                <button type="button" class="annot-fab annot-fab--align" data-action="align-mode"
                    title="对齐：打开后点画布对象多选，再点一次退出" aria-label="对齐"
                    aria-pressed="false">${ALIGN_ICON}
                    <b class="annot-fab__count" data-role="align-count" hidden>0</b></button>
            </div>
            <!-- 上栏：跟着当前工具变的通用外观参数（多选时变成对齐条），可横向滑动 -->
            <div class="annot-mobile-style" role="toolbar" aria-label="当前工具的参数">
                <div class="annot-mobile-style__scroll" data-role="mobile-style"></div>
            </div>
            <!-- 下栏：工具与图像操作，可横向滑动、带文字标签 -->
            <div class="annot-mobile-rail" role="toolbar" aria-label="标注与图像工具" data-role="mobile-rail">
                <div class="annot-mobile-rail__scroll">
                    <div class="annot-mobile-rail__group">${mobileToolButtons}</div>
                    <span class="annot-mobile-rail__sep"></span>
                    <div class="annot-mobile-rail__group">${mobileCanvasButtons}</div>
                </div>
            </div>` : ""}
            <div class="annot-status">
                <span class="annot-status__size" data-role="dimensions">—</span>
                <span class="annot-status__center">
                    <span class="annot-hint" data-role="hint"></span>
                    <span class="annot-status__message" data-role="message" hidden></span>
                </span>
                <span class="annot-status__zoom" data-role="zoom-bar">
                    <button type="button" class="annot-icon-btn" data-action="zoom-out" title="缩小（-）" aria-label="缩小">−</button>
                    <span class="annot-status__value" data-role="zoom">100%</span>
                    <button type="button" class="annot-icon-btn" data-action="zoom-in" title="放大（+）" aria-label="放大">＋</button>
                    <button type="button" class="annot-btn annot-btn--tiny" data-action="zoom-fit" title="适应窗口（0）">适应窗口</button>
                </span>
            </div>
        `;
        body.append(this.root);
        this.refreshPresetGroups();

        this.stage = this.root.querySelector<HTMLElement>(".annot-stage");
        this.transformLayer = this.root.querySelector<HTMLElement>('[data-role="transform"]');
        this.baseImage = this.root.querySelector<HTMLImageElement>('[data-role="base"]');
        this.svg = this.root.querySelector<SVGSVGElement>('[data-role="svg"]');
        this.statusDimensions = this.root.querySelector<HTMLElement>('[data-role="dimensions"]');
        this.statusMessage = this.root.querySelector<HTMLElement>('[data-role="message"]');
        this.statusZoom = this.root.querySelector<HTMLElement>('[data-role="zoom"]');
        this.hint = this.root.querySelector<HTMLElement>('[data-role="hint"]');

        const sidebarRoot = this.root.querySelector<HTMLElement>('[data-role="sidebar"]');
        if (sidebarRoot) {
            this.sidebar = new Sidebar(sidebarRoot, {
                onSelect: (id, mods) => this.selectFromList(id, mods),
                onHover: (id) => this.setHovered(id),
                onDelete: (id) => this.deleteObject(id),
                onEditText: (id) => {
                    const object = this.getObject(id);
                    if (object) this.beginTextEdit(object);
                },
                onLayer: (id, action) => this.moveInLayer(id, action),
                onDuplicate: (id) => this.duplicateObject(id),
                onReorder: (fromId, toId) => this.reorderObjects(fromId, toId),
            }, this.abort.signal, {mobile: this.mobile});
        }

        // 主题偏好本地持久化；卸载插件时会清掉
        try {
            const saved = localStorage.getItem(THEME_STORAGE_KEY);
            if (saved === "follow" || saved === "light" || saved === "dark") this.themePreference = saved;
        } catch {
            // 隐私模式下 localStorage 不可用，按跟随思源处理
        }

        this.bindEvents();
        applyTheme(this.root, this.themePreference);
        this.updateCompact();
        this.syncToolColumns();
        // 首帧布局稳定后再量一次，避免对话框刚出现时高度还没定下来
        if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => this.syncToolColumns());
        }
        if (typeof ResizeObserver !== "undefined") {
            const main = this.root.querySelector<HTMLElement>(".annot-main");
            if (main) {
                const columnsObserver = new ResizeObserver(() => this.syncToolColumns());
                columnsObserver.observe(main);
                this.abort.signal.addEventListener("abort", () => columnsObserver.disconnect(), {once: true});
            }
        }
        this.stopThemeWatch = watchTheme(this.root, () => this.themePreference);
        if (this.stage && typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => this.fitToStage());
            this.resizeObserver.observe(this.stage);
        } else {
            window.addEventListener("resize", () => this.fitToStage(), {signal: this.abort.signal});
        }
        this.loadBase(target);
    }

    private bindEvents(): void {
        const signal = this.abort.signal;
        this.bindMobileDrawer();
        this.bindMobileKeyboard();

        this.root?.addEventListener("click", (event) => {
            // 只认真正的按钮。画布 SVG 也曾带 data-tool 属性（用于光标样式），
            // 宽泛选择器会把「点画布」误判成「点工具按钮」，导致文字输入刚打开就被切换工具结束。
            const clicked = event.target as Element | null;
            // 档位点击会重画整排按钮，之后 clicked 已脱离文档，closest 查不到祖先；
            // 这里在事件进来时就按「派发路径」判断命中区域，避免把自己刚打开的小窗关掉。
            const path: EventTarget[] = typeof event.composedPath === "function" ? event.composedPath() : [];
            const pathHas = (selector: string): boolean =>
                path.some((node) => node instanceof Element && node.matches(selector));
            // 点在下拉外面先收起；不影响这次点击原本要做的事
            if (this.arrowPickerOpen && !clicked?.closest?.(".annot-arrow-picker")) {
                this.closeArrowPicker();
            }
            if (this.cornerPickerOpen && !clicked?.closest?.(".annot-corner-picker")) {
                this.closeCornerPicker();
            }
            if (this.numberFormatOpen && !clicked?.closest?.('[data-role="number-format-picker"]')) {
                this.numberFormatOpen = false;
                this.closeNumberPickers();
            }
            if (this.numberStyleOpen && !clicked?.closest?.('[data-role="number-style-picker"]')) {
                this.numberStyleOpen = false;
                this.closeNumberPickers();
            }
            // 顶部栏气泡：点栏外收起；栏内的选项由自己的 action 处理，处理完统一收尾
            if (this.mobilePopKey && !pathHas(".annot-mobile-topbar")) {
                this.mobilePopKey = null;
                this.renderMobileTopbar();
            }
            // 气泡里的选项点一下就收起（action 分发里多处直接 return，
            // 用 setTimeout 排到本轮事件之后，避免漏关）
            if (clicked?.closest?.(".annot-mobile-pop__item")) {
                window.setTimeout(() => {
                    this.mobilePopKey = null;
                    this.renderMobileTopbar();
                }, 0);
            }
            // 预设小窗：点旁边任意空白处收起；点顶栏里别的档位由那一档自己切换。
            // 点档位会重画整排按钮，原来那颗已经从文档里脱离，此时不能当成「点外面」。
            if (this.slotEdit && pathHas(".annot-toolbar") === false &&
                pathHas('[data-role="attr-pop"]') === false) {
                this.closeSlotPop();
            }
            // 取色弹窗：点弹窗和点圆球以外的地方都收起（点圆球由它自己的 data-action 处理）
            if (this.colorPopOpen &&
                !pathHas('[data-role="color-pop"]') &&
                !pathHas('[data-role="custom-color"]') &&
                // 这几个入口本身就在「开新的色轮」，别在冒泡到根节点时又把它关掉
                !pathHas('[data-action="color-open-prop"]') &&
                !pathHas('[data-action="mobile-color"]') &&
                !pathHas('[data-bg="custom1"]')) {
                this.closeColorPop();
            }
            // 拖动排序松手后会重画弹窗，被拖的那颗色点已经不在文档里，
            // 浏览器随之而来的那次 click 找不到委托目标，不需要额外的吞点击处理。

            // 扩展面板里的底色色块：点「自定义」顺手弹色轮，点别的只是切过去
            const bgEl = clicked?.closest?.("[data-bg]") as HTMLElement | null;
            if (bgEl?.getAttribute("data-bg")) {
                const slot = bgEl.getAttribute("data-bg") as ExtendSlot;
                this.selectExtendBg(slot);
                if (slot === "custom1") {
                    this.openColorPop(bgEl, {kind: "extend-bg"}, this.extendState.custom1);
                }
                return;
            }
            const button = clicked?.closest?.(
                "button[data-tool],button[data-action],button[data-preset],button[data-canvas-op],button[data-dir]");
            if (!button) return;
            const dir = button.getAttribute("data-dir");
            if (dir) {
                this.toggleExtendDir(dir);
                return;
            }
            const preset = button.getAttribute("data-preset");
            if (preset) {
                const index = Number(button.getAttribute("data-index"));
                const kind = SLOT_KINDS[preset];
                // 「自定义预设」编辑模式：点某一档只弹这一档的小窗；平时照旧直接生效
                if (this.presetEdit && kind && Number.isFinite(index) && button.closest(".annot-toolbar")) {
                    this.openSlotPop(kind, index);
                    return;
                }
                this.applyPreset(preset, button.getAttribute("data-value") ?? "");
                return;
            }
            const canvasOp = button.getAttribute("data-canvas-op");
            if (canvasOp) {
                this.runCanvasOp(canvasOp);
                return;
            }
            const tool = button.getAttribute("data-tool") as ToolType | null;
            const action = button.getAttribute("data-action");
            if (tool) this.setTool(tool);
            else if (action === "undo") this.undo();
            else if (action === "redo") this.redo();
            else if (action === "save") void this.saveAndClose();
            else if (action === "close") this.close();
            else if (action === "fullscreen") this.toggleFullscreen();
            else if (action === "align-mode") this.toggleAlignMode();
            else if (action === "mobile-select") {
                // 圆钮＝回到单选的「选择」：多选一起收掉
                this.toggleAlignMode(false);
                this.setTool("select");
            }
            else if (action === "align-op") this.alignSelection(button.getAttribute("data-value") as AlignOp);
            else if (action === "help") this.toggleHelp();
            else if (action === "close-help") this.toggleHelp(false);
            else if (action === "settings") this.enterPresetEdit();
            else if (action === "preset-cancel") this.finishPresetEdit("cancel");
            else if (action === "preset-apply") this.finishPresetEdit("apply");
            else if (action === "preset-reset") this.finishPresetEdit("reset");
            else if (action === "slot-color") {
                this.setSlotColor(Number(button.getAttribute("data-index")), button.getAttribute("data-value") || "");
            }
            else if (action === "tools-menu") this.toggleToolMenu();
            else if (action === "zoom-in") this.zoomBy(1.2);
            else if (action === "zoom-out") this.zoomBy(1 / 1.2);
            else if (action === "zoom-fit") this.fitView();
            else if (action === "mobile-pop") {
                // 顶部栏的小按钮：同一枚再点一下收起，点别的直接换
                const key = button.getAttribute("data-pop") ?? "";
                this.mobilePopKey = this.mobilePopKey === key ? null : key;
                this.renderMobileTopbar();
            }
            else if (action === "mobile-props") {
                this.mobileSheetOpen = !this.mobileSheetOpen;
                this.syncMobileSheets();
            }
            else if (action === "crop-apply") this.applyCrop();
            else if (action === "crop-cancel") this.cancelCrop();
            else if (action === "crop-ratio") this.setCropAspect(button.getAttribute("data-ratio") || "free");
            else if (action === "crop-full") this.selectFullCrop();
            else if (action === "extend-apply") this.applyExtend();
            else if (action === "bg-pick") this.startPickColor();
            else if (action === "toggle-link") this.toggleExtendLink();
            else if (action === "extend-cancel") this.toggleExtend(false);
            else if (action === "arrow-rounded") {
                const picked = this.getObject(this.selectedId);
                const on = (picked?.type === "arrow" || picked?.type === "number")
                    ? picked.style.arrowRounded !== false : this.current.arrowRounded;
                this.setArrowRounded(!on);
            }
            else if (action === "number-format") {
                this.setNumberFormat(normalizeNumberFormat(button.getAttribute("data-value")));
            }
            else if (action === "number-tip") {
                this.closeNumberPickers();
                this.setNumberTip(normalizeNumberTip(button.getAttribute("data-value")));
            }
            else if (action === "highlight-mode") {
                this.setHighlightMode(button.getAttribute("data-value") === "rect" ? "rect" : "brush");
            }
            // 手机顶栏是两颗并排按钮，各管一个模式
            else if (action === "highlight-mode-brush") this.setHighlightMode("brush");
            else if (action === "highlight-mode-rect") this.setHighlightMode("rect");
            else if (action === "smart-select") this.toggleSmartSelect();
            else if (action === "spotlight-color") {
                this.setSpotlightColor(button.getAttribute("data-value") === "white" ? "white" : "black");
            }
            else if (action === "spotlight-shape") {
                this.setSpotlightShape(button.getAttribute("data-value") === "ellipse" ? "ellipse" : "rect");
            }
            else if (action === "magnifier-zoom") {
                this.setMagnifierZoom(Number(button.getAttribute("data-value")));
            }
            else if (action === "magnifier-shape") {
                this.setMagnifierShape(button.getAttribute("data-value") === "rect" ? "rect" : "ellipse");
            }
            else if (action === "number-format-toggle") this.toggleNumberFormatPicker();
            else if (action === "number-format-pick") {
                // 先收起再改：setNumberFormat 会重画悬浮条，展开态要一起被重置
                this.numberFormatOpen = false;
                this.setNumberFormat(normalizeNumberFormat(button.getAttribute("data-value")));
            }
            else if (action === "number-style-toggle") this.toggleNumberStylePicker();
            else if (action === "number-style-pick") {
                this.numberStyleOpen = false;
                this.setNumberArrowStyle(normalizeArrowStyle(button.getAttribute("data-value")));
            }
            else if (action === "line-round") {
                const picked = this.getObject(this.selectedId);
                const on = picked?.type === "line"
                    ? picked.style.lineRound !== false : this.current.lineRound;
                this.setLineRound(!on);
            }
            else if (action === "arrow-picker-toggle") this.toggleArrowPicker();
            else if (action === "arrow-style-pick") {
                // 先收起再改样式：setArrowStyle 会重画悬浮条，展开态要一起被重置
                this.arrowPickerOpen = false;
                this.setArrowStyle(normalizeArrowStyle(button.getAttribute("data-value")));
            }
            else if (action === "corner-picker-toggle") this.toggleCornerPicker();
            else if (action === "corner-radius-pick") {
                this.cornerPickerOpen = false;
                this.setCornerRadius(normalizeCornerRadius(button.getAttribute("data-value")));
            }
            else if (action === "color-pop-toggle") this.toggleColorPop();
            else if (action === "mobile-color") {
                const anchor = clicked?.closest?.("button") as HTMLElement | null;
                if (anchor) {
                    this.openColorPop(anchor, {kind: "current"},
                        this.colorState.custom ?? normalizeColorHex(this.current.color) ?? "#FFFFFF");
                }
            }
            else if (action === "color-pop-close") this.toggleColorPop(false);
            else if (action === "color-save") this.saveCurrentColorPreset();
            else if (action === "color-preset-apply") {
                this.applyCustomColor(button.getAttribute("data-value") || "");
            }
            else if (action === "color-preset-remove") {
                this.removeColorPreset(button.getAttribute("data-value") || "");
            }
            else if (action === "extend-quick") {
                const input = this.root?.querySelector<HTMLInputElement>('[data-role="extend-margin"]');
                if (input) input.value = button.getAttribute("data-value") || "60";
            }
        }, {signal});

        this.root?.addEventListener("change", (event) => {
            const target = event.target as Element | null;
            const select = target?.closest?.("[data-role='theme-select']") as HTMLSelectElement | null;
            if (select) {
                this.setThemePreference(select.value as ThemePreference);
                return;
            }
        }, {signal});

        // 颜色预设的拖动排序：按下记下标，移动超过阈值才算拖，
        // 拖动过程中直接挪 DOM 做实时预览，松手才写回数据（数据与画面不会半步不一致）
        this.root?.addEventListener("pointerdown", (event) => {
            const target = event.target as Element | null;
            if (target?.closest?.('[data-action="color-preset-remove"]')) return;
            const chip = target?.closest?.('[data-role="color-preset"]') as HTMLElement | null;
            if (!chip) return;
            const index = Number(chip.dataset.index);
            if (!Number.isInteger(index)) return;
            this.colorDragIndex = index;
            this.colorDragStart = {x: event.clientX, y: event.clientY};
            this.colorDragMoved = false;
            // 抓住指针：拖到弹窗外面也不会丢掉 move / up
            try {
                chip.setPointerCapture(event.pointerId);
            } catch {
                // 老环境不支持指针捕获就退回普通冒泡，弹窗内拖动仍然可用
            }
        }, {signal});

        this.root?.addEventListener("pointermove", (event) => {
            if (this.colorDragIndex === null || !this.colorDragStart) return;
            const dx = event.clientX - this.colorDragStart.x;
            const dy = event.clientY - this.colorDragStart.y;
            if (!this.colorDragMoved && Math.abs(dx) + Math.abs(dy) < 4) return;
            this.colorDragMoved = true;
            const host = this.root?.querySelector<HTMLElement>('[data-role="color-presets"]');
            if (!host) return;
            const chips = Array.from(host.querySelectorAll<HTMLElement>('[data-role="color-preset"]'));
            chips.forEach((chip, index) => chip.classList.toggle("is-dragging", index === this.colorDragIndex));
            const target = this.colorPresetIndexAt(event.clientX, event.clientY);
            if (target === null || target === this.colorDragIndex) return;
            const moving = chips[this.colorDragIndex];
            const anchor = chips[target];
            if (!moving || !anchor || anchor.parentElement !== host) return;
            host.insertBefore(moving, target > this.colorDragIndex ? anchor.nextSibling : anchor);
            Array.from(host.querySelectorAll<HTMLElement>('[data-role="color-preset"]'))
                .forEach((chip, index) => { chip.dataset.index = String(index); });
            this.colorDragIndex = target;
        }, {signal});

        const endColorDrag = (): void => {
            if (this.colorDragIndex === null) return;
            const dragged = this.colorDragMoved;
            const host = this.root?.querySelector<HTMLElement>('[data-role="color-presets"]');
            const order = host
                ? Array.from(host.querySelectorAll<HTMLElement>('[data-role="color-preset"]'))
                    .map((chip) => chip.dataset.value || "")
                : [];
            this.colorDragIndex = null;
            this.colorDragStart = null;
            this.colorDragMoved = false;
            if (!dragged) return;
            if (order.length === this.colorState.saved.length && order.every(Boolean)) {
                this.colorState = {custom: this.colorState.custom, saved: order};
                saveColorPresets(this.colorState);
            }
            this.renderColorPresets();
        };
        this.root?.addEventListener("pointerup", endColorDrag, {signal});
        this.root?.addEventListener("pointercancel", endColorDrag, {signal});

        // 扩展面板：数值、同步开关、自定义底色
        const readExtendInput = (target: EventTarget | null): void => {
            const el = target as HTMLInputElement | null;
            const role = el?.getAttribute?.("data-role") || "";
            if (!role) return;
            const clampSize = (value: string, fallback: number): number => {
                const n = Number(value);
                return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(2000, Math.round(n))) : fallback;
            };
            if (role.startsWith("extend-") && role !== "extend-link") {
                const dir = role.slice("extend-".length) as ExtendDir;
                if (!EXTEND_DIRS.includes(dir)) return;
                // 锁死的框不接受输入（disabled 本来就点不进去，这里再兜一层）
                if (!isDirEditable(this.extendState, dir)) return;
                const fallback = valueForDir(this.extendState, dir);
                const value = clampSize(el?.value ?? "", fallback);
                if (this.extendState.link) this.extendState.margin = value;
                else this.extendState.sides[dir] = value;
            } else {
                return;
            }
            saveExtendState(this.extendState);
            this.syncExtendPanel();
        };
        this.root?.addEventListener("input", (event) => {
            // 参数悬浮窗里的取色器：拖动的过程中就实时预览，松手时再记历史
            const liveColor = (event.target as Element | null)
                ?.closest?.('[data-role="pop-color-picker"]') as HTMLInputElement | null;
            if (liveColor) {
                if (this.slotEdit?.kind === "color") this.setSlotColor(this.slotEdit.index, liveColor.value, false);
                else this.applyPreset("color", liveColor.value, false);
                return;
            }
            const ctx = (event.target as HTMLElement | null)?.getAttribute?.("data-ctx");
            if (ctx) this.applyContextValue(ctx, Number((event.target as HTMLInputElement).value), false);
            readExtendInput(event.target);
            this.onPresetInput(event.target, false);
        }, {signal});
        this.root?.addEventListener("change", (event) => {
            const ctx = (event.target as HTMLElement | null)?.getAttribute?.("data-ctx");
            if (ctx) this.applyContextValue(ctx, Number((event.target as HTMLInputElement).value), true);
            readExtendInput(event.target);
            this.onPresetInput(event.target, true);
        }, {signal});

        // 扩展画布输入框里按回车直接应用
        this.root?.addEventListener("keydown", (event) => {
            const el = event.target as HTMLElement | null;
            const role = el?.getAttribute?.("data-role") || "";
            if (role.startsWith("extend-") && event.key === "Enter") {
                event.preventDefault();
                this.applyExtend();
            }
        }, {signal});

        // 滚轮以鼠标位置为焦点缩放；按住空格或中键拖动平移画布
        // ---------------------------------------------------------------- 触摸手势（移动端）
        // 双指：捏合缩放 + 拖动平移；两根手指一落下就取消正在进行的绘制，避免误画。
        const stageEl = this.stage;
        if (stageEl) {
            const spread = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
            const middle = (a: Point, b: Point): Point => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
            stageEl.addEventListener("pointerdown", (event) => {
                if (event.pointerType === "mouse") return;
                this.touchPoints.set(event.pointerId, {x: event.clientX, y: event.clientY});
                this.gestureStart.set(event.pointerId, {x: event.clientX, y: event.clientY});
                if (this.touchPoints.size === 1) {
                    // 单指：交给 <svg> 正常绘制，这里完全不干预
                    // 但记一份选中，双指缩放结束后要还回去
                    this.selectionBeforeGesture = [...this.selectedIds];
                    this.gestureMode = "none";
                    this.gestureDriveId = null;
                    this.forceShift = false;
                    return;
                }
                // 第二根手指落下：先拦下这一次，别让 <svg> 再建一个草稿。
                // 到底是「一指按住当 Shift」还是「两指缩放」，等手指真的动起来再判（见 resolveTwoFinger）。
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                if (this.touchPoints.size === 2) {
                    // 双指缩放优先级最高：这一下还没落地的单击识别直接作废
                    this.cancelSmartTap();
                    this.gestureMode = "pending";
                    this.gestureLocked = true;
                } else {
                    this.enterPinch();
                }
            }, {capture: true, signal});
            stageEl.addEventListener("pointermove", (event) => {
                if (!this.touchPoints.has(event.pointerId)) return;
                this.touchPoints.set(event.pointerId, {x: event.clientX, y: event.clientY});
                if (this.gestureMode === "pending") {
                    event.preventDefault();
                    event.stopPropagation();
                    this.resolveTwoFinger();
                    return;
                }
                if (this.gestureMode === "constrain") {
                    event.preventDefault();
                    event.stopPropagation();
                    // 另一根手指也动了 → 用户其实是想缩放，立刻放弃这一笔转成捏合
                    if (this.holdFingerMoved()) {
                        this.enterPinch();
                        return;
                    }
                    this.gestureDriveId = event.pointerId;
                    this.gestureDrawTo(event.pointerId, event.clientX, event.clientY);
                    return;
                }
                const pinch = this.pinch;
                if (!pinch || this.touchPoints.size < 2) return;
                event.preventDefault();
                event.stopPropagation();
                const [a, b] = Array.from(this.touchPoints.values());
                const ratio = spread(a, b) / pinch.distance;
                const zoom = Math.min(8, Math.max(0.05, pinch.zoom * ratio));
                const center = middle(a, b);
                const k = zoom / pinch.zoom;
                // 以两指中点为锚点：中点下面的画面不会跑掉，双指平移也自然成立
                this.viewport = {
                    ...this.viewport,
                    zoom,
                    panX: center.x - (pinch.midX - pinch.panX) * k,
                    panY: center.y - (pinch.midY - pinch.panY) * k,
                };
                this.userAdjustedViewport = true;
                this.applyViewport();
            }, {capture: true, signal});
            // 手指可能在画布外抬起：挂到 window 才收得到，否则 touchPoints 残留，
            // 下一次单指落下会被误判成「第二根手指」，导致再也画不出来。
            const endTouch = (event: PointerEvent): void => {
                const id = event.pointerId;
                const mode = this.gestureMode;
                this.touchPoints.delete(id);
                this.gestureStart.delete(id);
                if (mode === "constrain") {
                    const wasDrive = id === this.gestureDriveId;
                    if (this.touchPoints.size === 0) {
                        // 最后一根抬起：这一笔照常落下
                        if (this.drag) this.onPointerUp(this.fakePointer(id, event.clientX, event.clientY));
                        this.finishGesture();
                        return;
                    }
                    if (wasDrive) {
                        // 正在画的那根抬起 → 这一笔结束，剩下那根回到自由单指
                        if (this.drag) this.onPointerUp(this.fakePointer(id, event.clientX, event.clientY));
                    } else {
                        // 抬起的是「按住不动」那根：这一笔不结束，别让 <svg> 也收到这次 pointerup
                        event.stopPropagation();
                    }
                    // 抬起的是「按住不动」那根：只解除约束，这一笔继续跟手（可以接着自由画）
                    this.gestureMode = "none";
                    this.gestureDriveId = null;
                    this.gestureHoldId = null;
                    this.forceShift = false;
                    this.gestureLocked = false;
                    return;
                }
                if (this.touchPoints.size < 2) this.pinch = null;
                if (this.touchPoints.size === 0) this.finishGesture();
            };
            window.addEventListener("pointerup", endTouch, {capture: true, signal});
            window.addEventListener("pointercancel", endTouch, {capture: true, signal});
            this.bindMobileGestureGuard();
        }

        this.stage?.addEventListener("wheel", (event) => {
            event.preventDefault();
            const rect = this.stage?.getBoundingClientRect();
            if (!rect) return;
            const focal = {x: event.clientX - rect.left, y: event.clientY - rect.top};
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            this.viewport = computeZoomTransform(this.viewport, focal, this.viewport.zoom * factor);
            this.userAdjustedViewport = true;
            this.applyViewport();
            this.renderCanvas();
        }, {passive: false, signal});
        this.stage?.addEventListener("pointerdown", (event) => {
            // 裁切态下整个舞台都能起手拉框（包括图片外的灰色留白），
            // 只在画布内部响应的话，从留白开始拖会毫无反应，看起来就像「裁切不生效」
            if (this.cropMode && event.button === 0) {
                event.preventDefault();
                // 三种拖拽：手柄缩放 / 框内平移 / 重新拉一个框。
                // 用坐标判定而不是 DOM 命中：SVG 元素的命中测试在缩放手柄、
                // 触摸与不同内核下都有差异，按坐标算距离最稳。
                const point = this.toImagePoint(event);
                const cropAction = this.cropActionAt(point);
                if (cropAction === "apply") {
                    // 关键：这里是 capture 阶段，不拦住的话事件还会继续传给画布，
                    // 画布会把这次点击当成"点空白"再走一遍选择流程（会多压一层撤销栈）
                    event.stopPropagation();
                    this.applyCrop();
                    return;
                }
                if (cropAction === "cancel") {
                    event.stopPropagation();
                    this.cancelCrop();
                    return;
                }
                const handle = this.cropHandleAt(point);
                if (handle) {
                    event.stopPropagation();
                    this.beginCropResize(handle, event);
                    return;
                }
                if (this.cropRect && this.pointInCropBox(point)) {
                    event.stopPropagation();
                    this.beginCropMove(event);
                    return;
                }
                // 参考插件：只要框还在，点框外一律不重画。用户在外围按下通常只是
                // 想把框拖大，一旦重画成小框，之前裁掉的范围就再也找不回来了。
                // 要重新框选，先按 Delete 把框清掉，再在图上拖新的。
                if (this.cropRect) {
                    event.stopPropagation();
                    this.setStatus("拖四角 / 四边把框放大就能找回裁掉的部分；点「恢复整张原图」一次全要，或按 Delete 清掉框重新框选");
                    return;
                }
                event.stopPropagation();
                this.beginCropDrag(event);
                return;
            }
            // 平移的三种入口：中键、按住空格 + 左键、或者在悬浮条上选了「平移」工具
            const panTool = this.activeTool === "pan";
            if (!(event.button === 1 || ((this.spaceDown || panTool) && event.button === 0))) return;
            event.preventDefault();
            event.stopPropagation();
            this.panDrag = {
                startX: event.clientX, startY: event.clientY,
                panX: this.viewport.panX, panY: this.viewport.panY,
            };
            this.stage?.classList.add("is-panning");
            this.svg?.classList.add("is-panning");
        }, {capture: true, signal});
        document.addEventListener("pointermove", (event) => {
            if (this.cropHandle) {
                this.updateCropResize(event);
                return;
            }
            if (this.cropMove) {
                this.updateCropMove(event);
                return;
            }
            if (this.cropDragStart) {
                this.updateCropDrag(event);
                return;
            }
            if (!this.panDrag) return;
            this.viewport = {
                ...this.viewport,
                panX: this.panDrag.panX + event.clientX - this.panDrag.startX,
                panY: this.panDrag.panY + event.clientY - this.panDrag.startY,
            };
            this.userAdjustedViewport = true;
            this.applyViewport();
        }, {signal});
        document.addEventListener("pointerup", (event) => {
            if (this.cropHandle) {
                // 松手时再用最终坐标算一次，快速拖拽可能没有对应的 pointermove
                this.updateCropResize(event);
                this.cropHandle = null;
                this.cropLastPoint = null;
                this.updateCropBar();
                this.renderOverlay();
                return;
            }
            if (this.cropMove) {
                this.updateCropMove(event);
                this.cropMove = null;
                this.updateCropBar();
                this.renderOverlay();
                return;
            }
            if (this.cropDragStart) {
                this.updateCropDrag(event);
                this.finishCropDrag();
                return;
            }
            if (!this.panDrag) return;
            this.panDrag = null;
            this.stage?.classList.remove("is-panning");
            this.svg?.classList.remove("is-panning");
            this.stage?.classList.remove("is-panning");
        }, {signal});
        document.addEventListener("keyup", (event) => {
            if (event.key === " ") this.spaceDown = false;
        }, {signal});
        // 拖拽绘制时按 / 松 Shift：即使鼠标不动，也要立刻在「锁定比例 / 45°」与「自由」之间切换
        // （画线、箭头、矩形、椭圆、聚光灯、放大镜共用同一处）
        const syncDraftShift = (event: KeyboardEvent): void => {
            if (event.key !== "Shift") return;
            if (!this.draft || !this.draftPointer || !this.drag) return;
            if (this.drag.kind !== "draw" && this.drag.kind !== "lineClick") return;
            this.updateDraft(this.draft, this.drag.start, this.draftPointer, event.type === "keydown");
            this.renderCanvas();
        };
        document.addEventListener("keydown", syncDraftShift, {signal});
        document.addEventListener("keyup", syncDraftShift, {signal});
        window.addEventListener("resize", () => {
            this.updateCompact();
            this.syncToolColumns();
        }, {signal});

        const svg = this.svg;
        if (svg) {
            svg.addEventListener("pointerdown", (e) => this.onPointerDown(e), {signal});
            svg.addEventListener("pointermove", (e) => this.onPointerMove(e), {signal});
            svg.addEventListener("pointerup", (e) => this.onPointerUp(e), {signal});
            svg.addEventListener("pointercancel", (e) => this.onPointerUp(e), {signal});
            svg.addEventListener("contextmenu", (e) => e.preventDefault(), {signal});
            svg.addEventListener("dblclick", (e) => {
                if (this.linePolyline) {
                    e.preventDefault();
                    this.finishLine();
                    return;
                }
                const el = (e.target as Element | null)?.closest?.("[data-object-id]");
                const object = this.getObject(el?.getAttribute("data-object-id") ?? null);
                if (object?.type === "text") {
                    e.preventDefault();
                    if (this.editingTextId === object.id) return;
                    this.selectedId = object.id;
                    this.beginTextEdit(object);
                }
            }, {signal});
        }
        // 文字编辑态只在「明确点到输入框以外」时才结束。
        // 不能用 textarea 的 blur 判定：pointerdown 之后浏览器会把焦点交还给画布，
        // 紧接着触发 blur，输入框会在用户还没来得及打字时就被销毁（闪一下就消失）。
        document.addEventListener("pointerdown", (event) => {
            if (!this.editingTextId || !this.textEditor) return;
            if (this.textEditor.contains(event.target as Node)) return;
            this.finishTextEdit();
        }, {capture: true, signal});
        document.addEventListener("keydown", (e) => this.onKeyDown(e), {capture: true, signal});
    }

    // ---------------------------------------------------------------- 底图与视口
    /**
     * 打开图片。
     *
     * 参考插件的做法：直接读图片文件的字节，看里面有没有内嵌的工程数据。
     * 有（本插件保存过的 PNG）就拆出「完整原始底图 + 场景」继续编辑，
     * 没有就当普通图片打开。旧版生成的 -annot.svg 也还能拆开读一次，
     * 但保存时会转成新的 PNG 封装。
     */
    private async loadBase(target: ImageTarget): Promise<void> {
        const path = target.assetPath;
        if (path) {
            try {
                const blob = await getFileBlob(`data/${path}`);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (this.finished) return;
                const pack = readPackage(bytes);
                if (pack) {
                    this.openedFromPackage = true;
                    this.baseSource = pack.base;
                    this.packageScene = pack.scene;
                    this.loadBaseImage(pack.base.dataUrl, this.canvasFromScene(pack.scene));
                    return;
                }
                // 老版本留下来的 -annot.svg：只读兼容，保存后自动升级成 PNG 封装
                if (/\.svg$/i.test(path)) {
                    const legacy = parseAnnotatedSvg(new TextDecoder().decode(bytes));
                    if (legacy) {
                        this.openedFromPackage = true;
                        this.baseSource = legacy.base;
                        this.packageScene = legacy.scene;
                        this.loadBaseImage(legacy.base.dataUrl,
                            this.canvasFromScene(legacy.scene) ?? legacy.canvas);
                        return;
                    }
                }
            } catch {
                // 读不到资源 / 不是我们生成的图片：按普通图片处理
            }
        }
        this.sourceAssetPath = path;
        this.loadBaseImage(target.url);
    }

    /** 工程数据里的画布：底图尺寸以包里带的完整原图为准 */
    private canvasFromScene(scene: AnnotScene | null): CanvasState | undefined {
        if (!scene?.canvas) return undefined;
        return {
            ...scene.canvas,
            naturalWidth: this.baseSource?.width || scene.canvas.naturalWidth,
            naturalHeight: this.baseSource?.height || scene.canvas.naturalHeight,
            matrix: {...scene.canvas.matrix},
        };
    }

    private loadBaseImage(url: string, canvas?: CanvasState): void {
        const img = this.baseImage;
        if (!img) return;
        const signal = this.abort.signal;
        img.addEventListener("load", () => {
            this.naturalWidth = img.naturalWidth || img.width;
            this.naturalHeight = img.naturalHeight || img.height;
            if (!this.naturalWidth || !this.naturalHeight) {
                this.showError(this.t("imageLoadFailed", "图片加载失败，请确认资源文件仍然存在"));
                return;
            }
            this.scene.imageWidth = this.naturalWidth;
            this.scene.imageHeight = this.naturalHeight;
            // 无变换时初始画布 = 原图；从已有 SVG 打开时沿用文件里的画布（尺寸 + 矩阵）
            this.scene.canvas = canvas
                ? {...canvas, matrix: {...canvas.matrix}}
                : createCanvas(this.naturalWidth, this.naturalHeight);
            this.mosaic.setBaseImage(img);
            this.blur.setBaseImage(img);
            this.magnifier.setBaseImage(img);
            // 只抓一次缩略图，之后只换矩阵：给光标挑色用，拖拽时不重复读像素
            this.sampler = new ContrastSampler(img, this.naturalWidth, this.naturalHeight, this.scene.canvas.matrix);
            this.buildSvgLayers();
            this.root?.querySelector<HTMLElement>('[data-role="loading"]')?.remove();
            if (this.transformLayer) this.transformLayer.hidden = false;
            this.applyCanvas();
            // 需求：打开时自动缩放到「整张图完整居中显示」，且这一次必须成功
            this.userAdjustedViewport = false;
            this.initialFitDone = false;
            this.fitAfterLayout();
            this.render();
            void this.restoreScene();
        }, {once: true, signal});
        img.addEventListener("error", () => {
            this.showError(this.t("imageLoadFailed", "图片加载失败，请确认资源文件仍然存在"));
        }, {once: true, signal});
        img.src = url;
    }

    private buildSvgLayers(): void {
        const svg = this.svg;
        if (!svg) return;
        const defs = document.createElementNS(SVG_NS, "defs");
        const clip = document.createElementNS(SVG_NS, "clipPath");
        clip.setAttribute("id", this.clipId);
        const clipRect = document.createElementNS(SVG_NS, "rect");
        clipRect.setAttribute("data-role", "clip-rect");
        clipRect.setAttribute("x", "0");
        clipRect.setAttribute("y", "0");
        clipRect.setAttribute("width", String(this.canvasWidth || 1));
        clipRect.setAttribute("height", String(this.canvasHeight || 1));
        clip.append(clipRect);
        defs.append(clip);

        const catcher = document.createElementNS(SVG_NS, "rect");
        catcher.setAttribute("data-layer", "catcher");
        catcher.setAttribute("x", "0");
        catcher.setAttribute("y", "0");
        catcher.setAttribute("width", String(this.canvasWidth || 1));
        catcher.setAttribute("height", String(this.canvasHeight || 1));
        catcher.setAttribute("fill", "transparent");
        catcher.setAttribute("pointer-events", "all");
        this.objectLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
        this.objectLayer.setAttribute("data-layer", "objects");
        // 对象层按画布边界裁切：裁切画面后，落在画布外的标注不会再飘到画布外面；
        // 手柄在 overlay 层，不受影响，仍然可以正常抓取。
        this.objectLayer.setAttribute("clip-path", `url(#${this.clipId})`);
        this.overlayLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
        this.overlayLayer.setAttribute("data-layer", "overlay");
        svg.replaceChildren(defs, catcher, this.objectLayer, this.overlayLayer);
    }

    /**
     * 把画布状态同步到 DOM：尺寸、底图矩阵、SVG viewBox、裁切框。
     * 旋转 / 裁切 / 扩画布之后必须调用一次，否则底图与坐标系会脱节。
     */
    private applyCanvas(): void {
        const canvas = this.scene.canvas;
        this.canvasWidth = canvas.width;
        this.canvasHeight = canvas.height;
        this.sampler?.setMatrix(canvas.matrix);

        if (this.transformLayer) {
            this.transformLayer.style.width = `${canvas.width}px`;
            this.transformLayer.style.height = `${canvas.height}px`;
        }
        // 可视窗口跟着画布走：裁小之后，窗口外的底图被 overflow:hidden 真正剪掉，
        // 再裁剪临时扩回完整原图时又会自动放大回去。
        const viewport = this.root?.querySelector<HTMLElement>('[data-role="viewport"]');
        if (viewport) {
            viewport.style.width = `${canvas.width}px`;
            viewport.style.height = `${canvas.height}px`;
        }

        const img = this.baseImage;
        if (img) {
            img.style.width = `${canvas.naturalWidth}px`;
            img.style.height = `${canvas.naturalHeight}px`;
            img.style.transform = `matrix(${toMatrixString(canvas.matrix)})`;
        }

        // 画布底色层：铺在底图下面，扩出来的留白就能看到颜色
        const bgLayer = this.root?.querySelector<HTMLElement>('[data-role="canvas-bg"]');
        if (bgLayer) {
            bgLayer.hidden = !canvas.background;
            bgLayer.style.width = `${canvas.width}px`;
            bgLayer.style.height = `${canvas.height}px`;
            bgLayer.style.background = canvas.background ?? "transparent";
        }

        if (this.svg) {
            // 尺寸交给 CSS（100% 铺满舞台），可见范围交给 applyViewport 的 viewBox
            this.applySvgViewBox();
            const catcher = this.svg.querySelector('[data-layer="catcher"]');
            catcher?.setAttribute("width", String(canvas.width));
            catcher?.setAttribute("height", String(canvas.height));
            const clipRect = this.svg.querySelector('[data-role="clip-rect"]');
            clipRect?.setAttribute("width", String(canvas.width));
            clipRect?.setAttribute("height", String(canvas.height));
        }

        // 马赛克采样要用「画布 → 原图」的逆矩阵，换了画布就得跟着换
        this.mosaic.setInverse(invert(canvas.matrix));
        this.blur.setInverse(invert(canvas.matrix));
        this.magnifier.setInverse(invert(canvas.matrix));
        this.magnifier.setCanvasSize(canvas.width, canvas.height);

        if (this.statusDimensions) {
            this.statusDimensions.textContent = `${canvas.width} × ${canvas.height} px`;
        }
        // 裁剪窗口和画布矩阵是同一件事的两种写法。旋转 / 翻转 / 扩画布都会改矩阵，
        // 这里同步一次，避免场景里留下过期的窗口数据，导致下次裁剪扩错范围。
        this.scene.crop = cropWindowOf(canvas);
    }

    private fitToStage(force = false): void {
        if (!this.stage || !this.transformLayer || !this.canvasWidth || !this.canvasHeight) return;
        // 手机上正在输入文字：键盘一弹 window.innerHeight 就变，绝不能借机重新适应窗口，
        // 否则画布被重算一次，所有标注都会瞬移到别的位置。
        if (this.mobile && this.editingTextId) return;
        // 首次适应还没做成时，即使中间被滚轮改过视口也要强行适应一次
        if (!force && this.userAdjustedViewport && this.initialFitDone) return;
        const stage = this.stage;
        const rect = stage.getBoundingClientRect();
        // 优先用 offset 尺寸：它是「布局尺寸」，不受对话框进场动画（transform: scale）影响。
        // 用 getBoundingClientRect 时，如果恰好测在动画中间，会按缩小后的尺寸算适应，
        // 而 transform 动画又不会触发 ResizeObserver —— 结果就是图片一直偏小、再也不修正。
        const width = stage.offsetWidth || rect.width;
        const height = stage.offsetHeight || rect.height;
        if (width < 2 || height < 2) return;
        this.stageW = width;
        this.stageH = height;
        // 手机上上下两条栏占掉了空间，留白收窄一点，图片才不至于小得看不清
        const padding = this.mobile ? 10 : STAGE_PADDING;
        this.viewport = fitTransform(width, height, this.canvasWidth, this.canvasHeight, padding);
        this.initialFitDone = true;
        this.lastFitStage = {width, height};
        this.applyViewport();
    }

    /**
     * 打开后的这一小段时间里持续校正视口。
     * 对话框可能有进场动画、侧边栏/字体也可能晚一步定尺寸，
     * 这些都靠不住一次测量，也不能指望 ResizeObserver（transform 变化它不报）。
     * 只要用户还没自己缩放/平移过，就跟着当前实际尺寸重新适应。
     */
    private fitAfterLayout(): void {
        this.fitToStage(true);
        const raf = typeof requestAnimationFrame === "function"
            ? requestAnimationFrame
            : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16) as unknown as number;
        let frames = 0;
        const step = (): void => {
            if (this.finished) return;
            this.correctFitIfNeeded();
            if (!this.finished && ++frames < 90) raf(step);
        };
        raf(step);
        // rAF 在某些情况下会被节流，再补三次定时兜底
        for (const delay of [320, 900, 1800]) {
            window.setTimeout(() => {
                if (!this.finished) this.correctFitIfNeeded();
            }, delay);
        }
    }

    /** 舞台尺寸和上次适应时不一致（或还没适应过）就重新适应；用户手动调整过则不动 */
    private correctFitIfNeeded(): void {
        if (this.finished) return;
        if (this.userAdjustedViewport && this.initialFitDone) return;
        const stage = this.stage;
        if (!stage) return;
        const rect = stage.getBoundingClientRect();
        const width = stage.offsetWidth || rect.width;
        const height = stage.offsetHeight || rect.height;
        if (width < 2 || height < 2) return;
        const moved = Math.abs(width - this.lastFitStage.width) > 0.5 ||
            Math.abs(height - this.lastFitStage.height) > 0.5;
        if (!this.initialFitDone || moved) this.fitToStage(true);
    }

    private applyViewport(): void {
        if (!this.transformLayer) return;
        const {zoom, panX, panY} = this.viewport;
        this.transformLayer.style.width = `${this.canvasWidth}px`;
        this.transformLayer.style.height = `${this.canvasHeight}px`;
        this.transformLayer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        // 标注层不走 CSS 缩放，改用 viewBox 表达「现在看的是图片的哪一块」：
        // 屏幕 1px 对应 1/zoom 个图片单位，手柄按屏幕像素画出来就永远锐利。
        this.applySvgViewBox();
        if (this.statusZoom) this.statusZoom.textContent = `${Math.round(zoom * 100)}%`;
        // 手机上底栏被隐藏，百分比显示在画布底部正中的胶囊里
        this.syncMobileZoom();
        this.scene.viewport = {...this.viewport};
        this.syncHandleScale(zoom);
    }

    /**
     * 手柄尺寸「相对界面固定」。
     *
     * 手柄画在图片坐标系里（半径 = 基础值 / zoom），底图一缩放，这层会被 CSS transform
     * 一起放大，屏幕尺寸就跟着变。所以 zoom 一变就按新比例重建一次 overlay，
     * 保证「缩放画面时按钮大小恒定、图标始终是矢量清晰度」。
     *
     * 同步重建而不是排 rAF：晚一帧就能看到圆点先胀一下再缩回去。
     * 只在真选中单个对象时才做，重建成本是十几个 SVG 节点，滚轮缩放的帧率扛得住。
     */
    private syncHandleScale(zoom: number): void {
        if (!this.overlayLayer || this.selectedIds.length !== 1) return;
        const previous = this.overlayZoom || 1;
        // 千分之一以下的差别肉眼看不出来，不必重建
        if (Math.abs(zoom - previous) <= 0.0008 * Math.max(1, zoom)) return;
        this.overlayZoom = zoom;
        this.renderOverlay();
    }

    /** 把「当前视口看到的那一块图片」写进 viewBox（标注层唯一的缩放来源） */
    private applySvgViewBox(): void {
        if (!this.svg) return;
        const zoom = this.viewport.zoom || 1;
        const vw = this.stageW || this.canvasWidth || 1;
        const vh = this.stageH || this.canvasHeight || 1;
        this.svg.setAttribute("viewBox",
            `${-this.viewport.panX / zoom} ${-this.viewport.panY / zoom} ${vw / zoom} ${vh / zoom}`);
    }

    /** 读回 viewBox（不用 svg.viewBox.baseVal：jsdom 里没有这个对象） */
    private svgViewBox(): {x: number; y: number; width: number; height: number} {
        const raw = this.svg?.getAttribute("viewBox") || "";
        const parts = raw.trim().split(/[\s,]+/).map(Number);
        const ok = parts.length === 4 && parts.every((n) => Number.isFinite(n));
        if (ok) return {x: parts[0], y: parts[1], width: parts[2], height: parts[3]};
        return {x: 0, y: 0, width: this.canvasWidth || 1, height: this.canvasHeight || 1};
    }

    private toImagePoint(e: {clientX: number; clientY: number}): Point {
        const rect = this.svg?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return {x: 0, y: 0};
        const vb = this.svgViewBox();
        return {
            x: vb.x + (e.clientX - rect.left) * (vb.width / rect.width),
            y: vb.y + (e.clientY - rect.top) * (vb.height / rect.height),
        };
    }

    /** 图片像素坐标 → 相对 stage 的屏幕坐标，用于文字输入框定位 */
    private imageToScreen(p: Point): Point {
        return {
            x: this.viewport.panX + p.x * this.viewport.zoom,
            y: this.viewport.panY + p.y * this.viewport.zoom,
        };
    }

    // ---------------------------------------------------------------- 对象读写
    private getObject(id: string | null): AnnotObject | null {
        if (!id) return null;
        return this.scene.objects.find((o) => o.id === id) ?? null;
    }

    private createObject(type: AnnotType, geometry: Geometry): AnnotObject {
        const now = Date.now();
        const copy = cloneGeometry(geometry);
        // 字号预设同时决定序号圆点大小
        if (type === "number") {
            (copy as NumberGeometry).radius = Math.max(12, this.current.fontSize * 0.65);
            (copy as NumberGeometry).format = this.current.numberFormat;
        }
        if (type === "magnifier") {
            const m = copy as MagnifierGeometry;
            m.zoom = normalizeMagnifierZoom(m.zoom);
            nudgeAnchorOutside(m);
        }
        return {
            id: createId(),
            type,
            geometry: copy,
            style: defaultStyle(type, this.current),
            meta: {label: TYPE_LABELS[type], createdAt: now, updatedAt: now},
        };
    }

    private setTool(tool: ToolType): void {
        if (this.linePolyline) this.finishLine();
        this.finishTextEdit();
        // 切工具时把裁切 / 扩展画布这些临时状态收掉，避免「还以为在画图，结果在拉裁切框」
        this.cancelCrop();
        this.toggleExtend(false);
        this.arrowPickerOpen = false;
        this.cornerPickerOpen = false;
        this.numberFormatOpen = false;
        this.numberStyleOpen = false;
        this.toggleColorPop(false);
        this.activeTool = tool;
        // 对齐模式依附在「选择」工具上：换成画图工具就一起收掉
        if (tool !== "select") this.alignMode = false;
        // 平移只是挪画面，不改变选择；其余绘制工具会清掉选择
        if (tool !== "select" && tool !== "pan") this.selectedId = null;
        // 换到别的工具就退出识别模式，免得虚线框一直挂在那
        if (this.current.smartSelect && tool !== "mosaic" && tool !== "blur") {
            this.current.smartSelect = false;
            saveCurrentStyle(this.current);
            this.smartRegions = null;
            this.smartScanning = false;
            this.smartScanToken++;
        }
        this.drag = null;
        this.draft = null;
        this.resetTouchHold();
        this.render();
    }

    private commit(): void {
        reindexNumbers(this.scene.objects);
        this.scene.updatedAt = Date.now();
        this.history.commit(this.snapshot());
    }

    /** 撤销栈里的一帧 = 对象 + 画布，两者必须同时回滚，否则标注会错位 */
    private snapshot(): EditorSnapshot {
        return {objects: this.scene.objects, canvas: this.scene.canvas};
    }

    private restore(snapshot: EditorSnapshot | null): boolean {
        if (!snapshot) return false;
        this.scene.objects = snapshot.objects;
        this.scene.canvas = snapshot.canvas;
        reindexNumbers(this.scene.objects);
        if (!this.getObject(this.selectedId)) this.selectedId = null;
        this.applyCanvas();
        this.render();
        return true;
    }

    private undo(): void {
        if (this.restore(this.history.undo())) this.updateHint();
    }

    private redo(): void {
        if (this.restore(this.history.redo())) this.updateHint();
    }

    private deleteObject(id: string | null): void {
        if (!id) return;
        this.finishTextEdit();
        this.scene.objects = this.scene.objects.filter((o) => o.id !== id);
        if (this.selectedId === id) this.selectedId = null;
        this.commit();
        this.render();
    }

    private deleteSelected(): void {
        this.deleteObject(this.selectedId);
    }

    /** 属性面板：实时改对象，change 结束时才提交一次历史 */
    private applyProperty(patch: PropertyPatch, commit: boolean): void {
        const object = this.getObject(this.selectedId);
        if (!object) return;
        // 属性面板里的调整同样写回当前预设，之后继续画就沿用这份外观
        let styleTouched = false;
        if (patch.color) {
            object.style.color = patch.color;
            this.current.color = patch.color;
            styleTouched = true;
        }
        if (patch.lineWidth !== undefined) {
            object.style.lineWidth = patch.lineWidth;
            this.current.lineWidth = patch.lineWidth;
            styleTouched = true;
        }
        if (patch.opacity !== undefined) object.style.opacity = patch.opacity;
        if (patch.fillMode) object.style.fillMode = patch.fillMode;
        if (patch.fillOpacity !== undefined) {
            object.style.fillOpacity = patch.fillOpacity;
            object.style.fillMode = patch.fillOpacity > 0 ? "translucent" : "none";
            this.current.fillOpacity = patch.fillOpacity;
            styleTouched = true;
        }
        if (patch.fontSize !== undefined) {
            this.applyFontSize(object, patch.fontSize);
            this.current.fontSize = patch.fontSize;
            styleTouched = true;
        }
        if (patch.lineDash) {
            object.style.lineDash = patch.lineDash;
            this.current.lineDash = patch.lineDash;
            styleTouched = true;
        }
        if (patch.arrowStyle) {
            object.style.arrowStyle = normalizeArrowStyle(patch.arrowStyle);
            this.current.arrowStyle = object.style.arrowStyle;
            styleTouched = true;
        }
        if (patch.arrowRounded !== undefined) {
            object.style.arrowRounded = patch.arrowRounded;
            this.current.arrowRounded = patch.arrowRounded;
            styleTouched = true;
        }
        if (patch.lineRound !== undefined) {
            object.style.lineRound = patch.lineRound;
            this.current.lineRound = patch.lineRound;
            styleTouched = true;
        }
        // 文字描边：开关 / 颜色 / 宽度，改完同样记进当前预设，下一段文字沿用
        if (patch.textStrokeEnabled !== undefined) {
            object.style.textStrokeEnabled = patch.textStrokeEnabled;
            this.current.textStrokeEnabled = patch.textStrokeEnabled;
            styleTouched = true;
        }
        if (patch.textStrokeColor) {
            object.style.textStrokeColor = patch.textStrokeColor;
            this.current.textStrokeColor = patch.textStrokeColor;
            styleTouched = true;
        }
        if (patch.textStrokeWidth !== undefined) {
            object.style.textStrokeWidth = patch.textStrokeWidth;
            this.current.textStrokeWidth = patch.textStrokeWidth;
            styleTouched = true;
        }
        if (styleTouched) saveCurrentStyle(this.current);
        if (patch.text !== undefined && object.type === "text") {
            (object.geometry as TextGeometry).text = patch.text;
        }
        if (patch.blockSize !== undefined && object.type === "mosaic") {
            (object.geometry as MosaicGeometry).blockSize = patch.blockSize;
        }
        if (patch.blurRadius !== undefined && object.type === "blur") {
            (object.geometry as BlurGeometry).radius = Math.max(1, Math.min(MAX_BLUR_RADIUS, patch.blurRadius));
        }
        if (patch.rotation !== undefined) setRotation(object, patch.rotation);
        object.meta.updatedAt = Date.now();
        if (commit) {
            this.commit();
            this.render();
        } else {
            this.renderCanvas();
        }
    }

    private setHovered(id: string | null): void {
        if (this.hoveredId === id) return;
        this.hoveredId = id;
        this.objectLayer?.querySelectorAll<SVGElement>(".annot-object").forEach((el) => {
            el.classList.toggle("is-hovered", el.getAttribute("data-object-id") === id);
        });
        this.root?.querySelectorAll<HTMLElement>("[data-role='object-item']").forEach((el) => {
            el.classList.toggle("is-hovered", el.dataset.id === id);
        });
    }

    // ---------------------------------------------------------------- 文字编辑
    private beginTextEdit(object: AnnotObject, caretPoint?: Point): void {
        if (object.type !== "text" || !this.stage) return;
        this.finishTextEdit();
        this.editingTextId = object.id;
        const geometry = object.geometry as TextGeometry;
        const editor = document.createElement("textarea");
        editor.className = "annot-text-editor";
        editor.value = geometry.text;
        editor.spellcheck = false;
        // 允许自动换行：画布右边到哪就折到哪，和保存出来的排版一致
        editor.wrap = "soft";
        const zoom = this.viewport.zoom || 1;
        const fontSize = geometry.fontSize * zoom;
        const position = this.imageToScreen({x: geometry.x, y: geometry.y});
        // 折行宽度 = 画布右边到文字左边这段距离；拖动文字后这个值会变，行数也就跟着变
        const wrapWidth = wrapWidthOf(geometry, this.canvasWidth || geometry.x + geometry.fontSize * 10);
        // 输入框宽度贴着已有文字（不铺满整张画布），但最多到画布右边
        const measureWidth = (value: string): number => {
            const block = textBlockSize(value, geometry.fontSize, wrapWidth);
            return Math.min(wrapWidth, Math.max(geometry.fontSize * 2, block.width + geometry.fontSize * 0.5));
        };
        editor.style.left = `${position.x}px`;
        // 行高的半行距会把字形往下压 0.075 个字高，补回来才和提交后的位置对齐
        editor.style.top = `${position.y + geometry.fontSize * 0.075 * zoom}px`;
        editor.style.fontSize = `${fontSize}px`;
        editor.style.lineHeight = String(TEXT_LINE_HEIGHT);
        editor.style.width = `${measureWidth(geometry.text) * zoom}px`;
        const initialLines = layoutText(geometry.text, geometry.fontSize, wrapWidth).length;
        editor.style.height = `${Math.max(1, initialLines) * geometry.fontSize * TEXT_LINE_HEIGHT * zoom}px`;
        // 手机上输入框可能落在屏幕底部被键盘挡住：整个框往上抬，保证完整可见
        const keepVisible = (): void => {
            if (!this.mobile || !this.stage) return;
            const stageHeight = this.stage.clientHeight || 0;
            const boxHeight = Number.parseFloat(editor.style.height) || 0;
            const top = Number.parseFloat(editor.style.top) || 0;
            if (stageHeight > 0 && top + boxHeight > stageHeight - 8) {
                editor.style.top = `${Math.max(6, stageHeight - boxHeight - 8)}px`;
                if (this.textFrame) this.textFrame.style.top = editor.style.top;
            }
        };
        keepVisible();
        // 打出来的字就是成品颜色（红的还是红）＋外沿白影，过程中不做任何反色
        editor.style.color = object.style.color;
        const strokeEnabled = object.style.textStrokeEnabled !== false;
        const strokeColor = object.style.textStrokeColor ?? DEFAULT_TEXT_STROKE_COLOR;
        const strokeWidth = Math.max(0, object.style.textStrokeWidth ?? DEFAULT_TEXT_STROKE_WIDTH);
        if (strokeEnabled && strokeWidth > 0) {
            const r = Math.max(1, Math.round(strokeWidth * zoom));
            const offsets = [[-r, -r], [0, -r], [r, -r], [-r, 0], [r, 0], [-r, r], [0, r], [r, r]];
            editor.style.textShadow = offsets
                .map(([x, y]) => `${x}px ${y}px 0 ${strokeColor}`).join(", ");
        }
        // 只给「细框」和「光标」做自动黑白：细框单独一层用混合模式反色，
        // 光标按它所在位置的底图明暗取黑或白 —— 文字本身不参与。
        const frame = document.createElement("div");
        frame.className = "annot-text-frame";
        frame.style.left = editor.style.left;
        frame.style.top = editor.style.top;
        frame.style.width = editor.style.width;
        frame.style.height = editor.style.height;
        this.stage.append(frame);
        this.textFrame = frame;
        this.stage.append(editor);
        this.textEditor = editor;

        const syncFrame = (): void => {
            if (!this.textFrame) return;
            this.textFrame.style.width = editor.style.width;
            this.textFrame.style.height = editor.style.height;
        };
        const caretCanvas = (): Point => {
            const block = textBlockSize(editor.value, geometry.fontSize, wrapWidth);
            const index = Math.max(0, Math.min(editor.value.length, editor.selectionStart ?? editor.value.length));
            let lineIndex = 0;
            for (let i = 0; i < block.lines.length; i += 1) {
                const line = block.lines[i];
                lineIndex = i;
                if (index <= line.start + line.text.length) break;
            }
            const line = block.lines[lineIndex];
            const offset = Math.max(0, Math.min(line.text.length, index - line.start));
            return {
                x: geometry.x + measureText(line.text.slice(0, offset), geometry.fontSize),
                y: geometry.y + lineIndex * geometry.fontSize * TEXT_LINE_HEIGHT,
            };
        };
        const refreshCaret = (): void => {
            const point = caretCanvas();
            const luminance = this.sampler?.luminanceAt(
                point.x, point.y, Math.max(2, geometry.fontSize * 0.35), geometry.fontSize,
            ) ?? null;
            if (luminance === null) {
                editor.style.caretColor = "";
                return;
            }
            editor.style.caretColor = contrastInk(luminance);
        };
        this.refreshTextCaret = refreshCaret;
        refreshCaret();

        // 光标落在点击处（从属性面板进来时落在文字末尾），而不是全选——
        // 全选会让用户以为「没有光标」，也没法直接按退格改字。
        const caret = caretPoint ? this.caretIndexAt(object, caretPoint) : geometry.text.length;
        const focusEditor = (): boolean => {
            if (this.finished || this.editingTextId !== object.id || !editor.isConnected) return false;
            editor.focus({preventScroll: true});
            try {
                editor.setSelectionRange(caret, caret);
            } catch {
                // 少数环境不支持选区 API，退化为只聚焦
            }
            return this.root?.ownerDocument?.activeElement === editor;
        };
        // 延后到本次鼠标事件序列结束再聚焦，否则随后的 mousedown 会立刻抢走焦点
        window.setTimeout(() => {
            if (focusEditor()) return;
            // 偶尔第一次聚焦会被对话框/画布抢走，补一次
            window.setTimeout(focusEditor, 60);
        }, 0);

        const signal = this.abort.signal;
        editor.addEventListener("keydown", (event) => {
            // 输入框内不把按键交给画布快捷键处理
            event.stopPropagation();
            if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                this.finishTextEdit();
            }
        }, {signal});
        // 文字变长 → 输入框跟着变宽，到画布右边就停住开始换行
        editor.addEventListener("input", () => {
            editor.style.width = `${measureWidth(editor.value) * zoom}px`;
            editor.style.height = "auto";
            const grown = Math.max(editor.scrollHeight, geometry.fontSize * TEXT_LINE_HEIGHT * zoom);
            editor.style.height = `${grown}px`;
            syncFrame();
            keepVisible();
            refreshCaret();
        }, {signal});
        // 光标移动也要重新挑色：在同一行里从黑底滑到白底时，光标要跟着翻色
        for (const type of ["keyup", "click", "select", "focus"] as const) {
            editor.addEventListener(type, refreshCaret, {signal});
        }
        editor.addEventListener("blur", refreshCaret, {signal});
        this.render();
    }

    /**
     * 算出点击位置最接近的字符插入点。
     * 有 canvas 就按同样的字体逐字量宽（准确）；没有 canvas 的环境
     * （比如某些受限 WebView）退回「中日韩 ≈ 1 个字宽、其它 ≈ 0.55」的估算。
     */
    private caretIndexAt(object: AnnotObject, point: Point): number {
        const geometry = object.geometry as TextGeometry;
        const text = geometry.text || "";
        if (!text) return 0;
        const block = textBlockSize(text, geometry.fontSize, geometry.width ?? Infinity);
        const lineHeight = Math.max(1, geometry.fontSize * TEXT_LINE_HEIGHT);
        const lineIndex = Math.max(0, Math.min(block.lines.length - 1, Math.floor((point.y - geometry.y) / lineHeight)));
        const line = block.lines[lineIndex];
        const target = point.x - geometry.x;
        if (target <= 0) return line.start;

        let ctx: CanvasRenderingContext2D | null = null;
        try {
            ctx = document.createElement("canvas").getContext("2d");
        } catch {
            ctx = null;
        }
        const el = this.svg?.querySelector(`[data-object-id="${object.id}"] text.annot-shape`) as SVGTextElement | null;
        if (ctx && typeof ctx.measureText === "function" && el) {
            const style = getComputedStyle(el);
            ctx.font = `${style.fontWeight || "600"} ${geometry.fontSize}px ${style.fontFamily || "sans-serif"}`;
        }

        const measure = (char: string): number => {
            if (ctx && typeof ctx.measureText === "function") {
                const metrics = ctx.measureText(char);
                if (metrics && Number.isFinite(metrics.width) && metrics.width > 0) return metrics.width;
            }
            // 没有 canvas 时按包围盒同一套宽度规则估，保证点哪算哪
            return charWidthRatio(char) * geometry.fontSize;
        };

        let width = 0;
        const chars = Array.from(line.text);
        for (let index = 0; index < chars.length; index += 1) {
            const next = width + measure(chars[index]);
            if (target < (width + next) / 2) return line.start + index;
            width = next;
        }
        return line.start + chars.length;
    }

    private finishTextEdit(): void {
        const id = this.editingTextId;
        if (!id) return;
        this.editingTextId = null;
        // 退出输入：把「键盘态」一起摘掉，三栏与输入框位移全部还原
        this.keyboardSync?.();
        const value = this.textEditor?.value ?? "";
        this.textEditor?.remove();
        this.textEditor = null;
        this.textFrame?.remove();
        this.textFrame = null;
        this.refreshTextCaret = null;
        const object = this.getObject(id);
        if (!object || object.type !== "text") return;
        const geometry = object.geometry as TextGeometry;
        if (!value.trim()) {
            // 确实没输入内容才丢弃这次新建
            this.scene.objects = this.scene.objects.filter((o) => o.id !== id);
            if (this.selectedId === id) this.selectedId = null;
            this.commit();
            this.render();
            return;
        }
        if (geometry.text !== value) {
            geometry.text = value;
            object.meta.updatedAt = Date.now();
            this.commit();
            this.render();
        } else {
            // 只是退出输入态，不必重建属性面板，避免吞掉用户紧接着的那次点击
            this.renderCanvas();
        }
    }

    // ---------------------------------------------------------------- 绘制草稿
    private makeDraft(tool: AnnotType, start: Point): Draft | null {
        switch (tool) {
            case "arrow":
                return {type: tool, geometry: {start: {...start}, end: {...start}, control: null}};
            case "line":
                // 两点：起点 + 跟随指针的末端；折线时末端始终是「预览点」
                return {type: tool, geometry: {points: [{...start}, {...start}]}};
            case "rect":
                return {type: tool, geometry: {x: start.x, y: start.y, width: 0, height: 0}};
            case "mosaic":
                return {type: tool, geometry: {x: start.x, y: start.y, width: 0, height: 0,
                    blockSize: this.contextDefaults.blockSize}};
            case "blur":
                return {type: tool, geometry: {x: start.x, y: start.y, width: 0, height: 0,
                    radius: this.contextDefaults.blurRadius}};
            case "spotlight":
                return {
                    type: tool,
                    geometry: {
                        x: start.x, y: start.y, width: 0, height: 0,
                        shape: this.current.spotlightShape,
                    },
                };
            case "magnifier":
                return {
                    type: tool,
                    geometry: {
                        x: start.x, y: start.y, width: 0, height: 0,
                        anchor: {...start}, zoom: this.current.magnifierZoom,
                        shape: this.current.magnifierShape,
                    },
                };
            case "ellipse":
                return {type: tool, geometry: {cx: start.x, cy: start.y, rx: 0, ry: 0}};
            case "number":
                return {
                    type: tool,
                    geometry: {
                        center: {...start}, tip: null, control: null, number: 0,
                        radius: Math.max(12, this.current.fontSize * 0.65),
                    },
                };
            case "highlight":
                // 矩形模式拖出来的是「独立对象」而不是笔迹：松手后能选中、拖动、改大小
                if (this.current.highlightMode === "rect") {
                    return {
                        type: "highlightRect",
                        geometry: {x: start.x, y: start.y, width: 0, height: 0},
                    };
                }
                return {type: tool, geometry: {points: [{...start}]}};
            default:
                return null;
        }
    }

    private updateDraft(draft: Draft, start: Point, current: Point, shift = false): void {
        const g = draft.geometry;
        switch (draft.type) {
            case "arrow": {
                // Shift 与【画线】完全一致：方向吸附到水平 / 垂直 / 45°，长度保持鼠标距离
                const a = g as ArrowGeometry;
                a.end = shift ? snapDirection(a.start, current) : {...current};
                break;
            }
            case "line": {
                const l = g as LineGeometry;
                // Shift 把这一段锁定在水平 / 垂直 / 45°；折线时锚点是上一个折点
                const from = l.points.length >= 2 ? l.points[l.points.length - 2] : start;
                const target = shift ? snapDirection(from, current) : {...current};
                l.points[l.points.length - 1] = target;
                if (this.lineTouch) {
                    this.lineTouch.samples.push({...target});
                    this.lineTouch.lastMoveAt = Date.now();
                }
                break;
            }
            case "rect":
            case "highlightRect":
            case "spotlight": {
                // 矩形 / 矩形高亮 / 聚光灯：Shift 锁 1:1 —— 矩形是正方形，聚光灯是正圆（椭圆形状时）
                const r = g as RectGeometry;
                if (shift) {
                    const side = Math.max(Math.abs(current.x - start.x), Math.abs(current.y - start.y));
                    r.x = current.x < start.x ? start.x - side : start.x;
                    r.y = current.y < start.y ? start.y - side : start.y;
                    r.width = side;
                    r.height = side;
                    break;
                }
                r.x = Math.min(start.x, current.x);
                r.y = Math.min(start.y, current.y);
                r.width = Math.abs(current.x - start.x);
                r.height = Math.abs(current.y - start.y);
                break;
            }
            case "mosaic":
            case "blur": {
                const r = g as RectGeometry;
                r.x = Math.min(start.x, current.x);
                r.y = Math.min(start.y, current.y);
                r.width = Math.abs(current.x - start.x);
                r.height = Math.abs(current.y - start.y);
                break;
            }
            case "magnifier": {
                const m = g as MagnifierGeometry;
                let dx = current.x - start.x;
                let dy = current.y - start.y;
                if (shift) {
                    // Shift：X / Y 位移取同一个绝对值 → 正方形镜框（圆形镜片就是正圆）
                    const side = Math.max(Math.abs(dx), Math.abs(dy));
                    dx = dx < 0 ? -side : side;
                    dy = dy < 0 ? -side : side;
                }
                m.x = Math.min(start.x, start.x + dx);
                m.y = Math.min(start.y, start.y + dy);
                m.width = Math.abs(dx);
                m.height = Math.abs(dy);
                // 起点一直在框角上：锚点跟着推到框外，边拖边能看到「点 → 框」的连线
                m.anchor = {...start};
                nudgeAnchorOutside(m);
                break;
            }
            case "ellipse": {
                const e = g as EllipseGeometry;
                let dx = current.x - start.x;
                let dy = current.y - start.y;
                if (shift) {
                    // Shift：X / Y 位移取同一个绝对值 → 正圆（以按下点为一个角，往外长）
                    const side = Math.max(Math.abs(dx), Math.abs(dy));
                    dx = dx < 0 ? -side : side;
                    dy = dy < 0 ? -side : side;
                }
                e.cx = start.x + dx / 2;
                e.cy = start.y + dy / 2;
                e.rx = Math.abs(dx) / 2;
                e.ry = Math.abs(dy) / 2;
                break;
            }
            case "number": {
                const n = g as NumberGeometry;
                n.tip = distance(start, current) > n.radius + 8 / this.viewport.zoom ? {...current} : null;
                break;
            }
            case "highlight": {
                const h = g as HighlightGeometry;
                const last = h.points[h.points.length - 1];
                if (!last || distance(last, current) > 2 / this.viewport.zoom) h.points.push({...current});
                break;
            }
        }
    }

    private isDraftValid(draft: Draft): boolean {
        const min = MIN_DRAW_SIZE / this.viewport.zoom;
        switch (draft.type) {
            case "arrow":
                return distance((draft.geometry as ArrowGeometry).start, (draft.geometry as ArrowGeometry).end) >= 8 / this.viewport.zoom;
            case "line": {
                const l = draft.geometry as LineGeometry;
                if (l.points.length < 2) return false;
                let total = 0;
                for (let i = 1; i < l.points.length; i++) total += distance(l.points[i - 1], l.points[i]);
                return total >= 8 / this.viewport.zoom;
            }
            case "rect":
            case "highlightRect":
            case "spotlight":
            case "magnifier":
            case "mosaic":
            case "blur": {
                const r = draft.geometry as RectGeometry;
                return r.width >= min && r.height >= min;
            }
            case "ellipse": {
                const e = draft.geometry as EllipseGeometry;
                return e.rx >= min / 2 && e.ry >= min / 2;
            }
            case "number":
                return true;
            case "highlight":
                return (draft.geometry as HighlightGeometry).points.length >= 2;
            default:
                return false;
        }
    }

    /**
     * 结束一条连续折线：双击 / Esc / 切工具 / 保存时调用。
     * 末尾那个「跟随鼠标的预览点」不算数，去掉后只要有两点以上就保留已画的部分。
     */
    private finishLine(): void {
        if (!this.linePolyline) return;
        const draft = this.draft;
        this.linePolyline = false;
        this.linePolylineCleanup();
        if (!draft || draft.type !== "line") return;
        const l = draft.geometry as LineGeometry;
        while (l.points.length > 2 &&
            distance(l.points[l.points.length - 1], l.points[l.points.length - 2]) < 2 / this.viewport.zoom) {
            l.points.pop();
        }
        if (this.isDraftValid(draft)) {
            const object = this.createObject("line", draft.geometry);
            this.scene.objects.push(object);
            this.selectedId = object.id;
            this.commit();
        }
        this.render();
    }

    /** 折线相关临时状态的统一清理 */
    private linePolylineCleanup(): void {
        this.draft = null;
        this.drag = null;
        this.lineTouch = null;
    }

    // ---------------------------------------------------------------- 指针交互
    private onPointerDown(e: PointerEvent): void {
        if (e.button !== 0 || !this.svg) return;
        // 双指手势期间绝不绘制：touches>=2 时 stage 的捕获阶段已把事件拦下，
        // 这里再兜一层，防止某些内核里 pointerdown 绕过 stopPropagation 漏进来
        if (this.mobile && this.gestureMode !== "constrain" &&
            (this.gestureLocked || this.touchPoints.size >= 2)) return;
        // 点画布＝收起底部对象抽屉（抽屉盖住了底部两条栏，这是它主要的关闭手势之一）
        if (this.mobileSheetOpen) this.closeMobileSheet();
        // 点画布＝不想再调了：把小窗收起来（不影响这一下继续画）
        if (this.slotEdit) this.closeSlotPop();
        // 平移工具由舞台统一接管（可能从图片外的留白起手），画布这里什么都不做
        if (this.activeTool === "pan") return;
        // 吸管模式：这一下点击就是取色，不画任何东西
        if (this.pickMode) {
            e.preventDefault();
            this.finishPickColor(e);
            return;
        }
        // 裁切拖拽由舞台统一接管（可能从图片外的留白起手），画布这里不再插手
        if (this.cropMode) return;
        const p = this.toImagePoint(e);

        const target = e.target as Element | null;
        // 识别模式下的虚线框：点哪个就把哪个打码，不进入画图流程
        const regionEl = target?.closest?.("[data-smart-region]") ?? null;
        if (regionEl && this.smartRegions) {
            e.preventDefault();
            this.beginSmartTap(Number(regionEl.getAttribute("data-smart-region")), p, {
                x: e.clientX, y: e.clientY,
            });
            return;
        }
        const handleEl = target?.closest?.("[data-handle]") ?? null;
        const objectEl = target?.closest?.("[data-object-id]") ?? null;
        // 聚光灯 / 放大镜是「效果类」对象，画完常常要马上挪一挪。
        // 这两个工具下按在同类对象身上时，当作「调它」而不是「再画一个」，
        // 否则刚画完想拖动，结果又叠了一个新的。
        const under = objectEl ? this.getObject(objectEl.getAttribute("data-object-id")) : null;
        const adjustExisting = !!under && (
            this.activeTool === "select" ||
            (this.activeTool === "spotlight" && under.type === "spotlight") ||
            (this.activeTool === "magnifier" && under.type === "magnifier"));

        this.pendingTextEdit = null;
        this.pendingDeselect = null;

        // 对齐模式：点对象＝加入 / 移出选择（点空白不做任何事，本插件不提供框选）
        // 电脑上要按住 Ctrl；手机上没有 Ctrl 键，进了对齐模式点一下就算多选
        if (this.alignMode && this.activeTool === "select" && (this.mobile || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (under) {
                this.toggleSelected(under.id);
                this.render();
            }
            return;
        }

        // 手柄优先：即使当前仍停留在绘制工具，也能继续调整刚画好的对象
        if (handleEl && this.getObject(this.selectedId)) {
            const object = this.getObject(this.selectedId)!;
            const handleName = handleEl.getAttribute("data-handle") || "";
            // 「再次编辑」角标：直接进输入态，不走拖拽
            if (handleName === "edit") {
                e.preventDefault();
                this.beginTextEdit(object);
                this.render();
                return;
            }
            // 「移动」抓手：和按住对象本身拖动同一条路径（多选时整组一起挪）
            if (handleName === "move") {
                const inGroup = this.selectedIds.length > 1 && this.selectedIds.includes(object.id);
                this.drag = {
                    kind: "move",
                    start: p,
                    original: cloneObject(object),
                    group: inGroup
                        ? this.selectedIds
                            .map((id) => this.getObject(id))
                            .filter((item): item is AnnotObject => Boolean(item))
                            .map((item) => cloneObject(item))
                        : undefined,
                };
                this.pendingTextEdit = null;
                try {
                    this.svg?.setPointerCapture?.(e.pointerId);
                } catch {
                    // 部分环境不支持指针捕获
                }
                e.preventDefault();
                this.render();
                return;
            }
            const bounds = getBounds(object);
            const center = boundsCenter(bounds);
            const rotation = (object.geometry as {rotation?: number}).rotation ?? 0;
            this.drag = {
                kind: "handle",
                handle: handleEl.getAttribute("data-handle") || "",
                start: p,
                original: cloneObject(object),
                originalBounds: bounds,
                center,
                rotation,
                startAngle: Math.atan2(p.y - center.y, p.x - center.x) * 180 / Math.PI,
            };
        } else if (this.activeTool === "text") {
            // 文字工具：点一下就创建对象并立刻进入输入态。
            // 先阻止默认行为，避免后续 mousedown 把焦点从输入框抢走。
            e.preventDefault();
            const geometry: TextGeometry = {x: p.x, y: p.y, text: "", fontSize: this.current.fontSize};
            const object = this.createObject("text", geometry);
            this.scene.objects.push(object);
            this.selectedId = object.id;
            this.beginTextEdit(object);
            return;
        } else if (this.activeTool === "line" && this.linePolyline && this.draft) {
            // 折线进行中：这一下只是「加一个折点」，不重开草稿
            this.drag = {kind: "lineClick", start: p};
        } else if (adjustExisting && under && objectEl) {
            const wasSelected = this.selectedId === under.id;
            // 多选状态下按住其中一个成员拖动：整组一起挪，选择也不能被收成单选
            const inGroup = this.selectedIds.length > 1 && this.selectedIds.includes(under.id);
            if (!inGroup) this.selectedId = under.id;
            if (under.type === "magnifier" && this.hitsMagnifierAnchor(under, p)) {
                const bounds = getBounds(under);
                this.drag = {
                    kind: "handle",
                    handle: "anchor",
                    start: p,
                    original: cloneObject(under),
                    originalBounds: bounds,
                    center: boundsCenter(bounds),
                    rotation: (under.geometry as {rotation?: number}).rotation ?? 0,
                    startAngle: 0,
                };
            } else {
                const group = inGroup
                    ? this.selectedIds
                        .map((id) => this.getObject(id))
                        .filter((object): object is AnnotObject => Boolean(object))
                        .map((object) => cloneObject(object))
                    : undefined;
                this.drag = {kind: "move", start: p, original: cloneObject(under), group};
                // 已经选中的文字：这次只点不拖，就在抬起时进入编辑（拖仍然能移动它）
                this.pendingTextEdit = under.type === "text" && wasSelected && !inGroup
                    ? {id: under.id, start: p}
                    : null;
            }
        } else if (this.activeTool !== "select") {
            const draft = this.makeDraft(this.activeTool as AnnotType, p);
            if (draft) {
                this.drag = {kind: "draw", tool: this.activeTool as AnnotType, start: p};
                this.draft = draft;
                this.draftPointer = {...p};
                this.resetTouchHold();
                this.selectedId = null;
                // 触屏画线要记轨迹，用来判断末端停顿 / 是否该自动拉直
                this.lineTouch = this.mobile && this.activeTool === "line"
                    ? {samples: [{...p}], lastMoveAt: Date.now()}
                    : null;
            }
        } else if (objectEl) {
            const id = objectEl.getAttribute("data-object-id");
            const wasSelected = Boolean(id) && this.selectedId === id;
            this.selectedId = id;
            const object = this.getObject(id);
            if (object && object.type === "magnifier" && this.hitsMagnifierAnchor(object, p)) {
                // 按在锚点上：只挪锚点，镜框不动（这就是放大镜的「解耦」）
                const bounds = getBounds(object);
                this.drag = {
                    kind: "handle",
                    handle: "anchor",
                    start: p,
                    original: cloneObject(object),
                    originalBounds: bounds,
                    center: boundsCenter(bounds),
                    rotation: (object.geometry as {rotation?: number}).rotation ?? 0,
                    startAngle: 0,
                };
            } else if (object) {
                this.drag = {kind: "move", start: p, original: cloneObject(object)};
                // 已经选中的文字：这次只点不拖，就在抬起时进入编辑（拖仍然能移动它）
                this.pendingTextEdit = object.type === "text" && wasSelected
                    ? {id: object.id, start: p}
                    : null;
            }
        } else {
            this.pendingTextEdit = null;
            // 先记下来，抬手时确认没拖动再清（双指缩放的第一根手指也走这里）
            this.pendingDeselect = {start: p};
        }

        try {
            this.svg.setPointerCapture?.(e.pointerId);
        } catch {
            // 部分环境不支持指针捕获
        }
        e.preventDefault();
        this.render();
    }

    /** 抬起时确认「刚才那一下是点空白」：没拖动才真的取消选中 */
    private flushPendingDeselect(e: PointerEvent): void {
        const pending = this.pendingDeselect;
        if (!pending) return;
        this.pendingDeselect = null;
        const moved = distance(this.toImagePoint(e), pending.start) * this.viewport.zoom;
        if (moved > this.dragSlop) return;
        if (!this.selectedId && this.selectedIds.length === 0) return;
        this.selectedId = null;
        this.render();
    }

    /**
     * 按下后移动多少屏幕像素才算「真的在拖」。
     * 鼠标 3px 够用；手指按下时天然会抖 5-10px，用同样的阈值会把「点一下」
     * 判成拖拽，对象就被挪走了，所以移动端放宽到 10px。
     */
    private get dragSlop(): number {
        return this.mobile ? 10 : 3;
    }

    /** 指针是否落在放大镜的锚点上（按屏幕像素判断，缩放后手感一致） */
    private hitsMagnifierAnchor(object: AnnotObject, p: Point): boolean {
        const g = object.geometry as MagnifierGeometry;
        const bounds = getBounds(object);
        const local = unrotatePoint(
            p, boundsCenter(bounds), (object.geometry as {rotation?: number}).rotation ?? 0);
        const dot = Math.max(3, object.style.lineWidth * 1.3);
        const radius = Math.max(14 / (this.viewport.zoom || 1), dot * 2) + 3;
        return distance(local, g.anchor) <= radius;
    }

    private onPointerMove(e: PointerEvent): void {
        const p = this.toImagePoint(e);
        if (this.cropMode) return;
        const drag = this.drag;
        if (!drag) {
            // 折线还没结束：最后一个点跟着鼠标走，用户能看到下一段会连到哪
            if (this.linePolyline && this.draft?.type === "line") {
                const l = this.draft.geometry as LineGeometry;
                const from = l.points.length >= 2 ? l.points[l.points.length - 2] : p;
                l.points[l.points.length - 1] = (e.shiftKey || this.forceShift) ? snapDirection(from, p) : {...p};
                this.renderCanvas();
                return;
            }
            // 悬停联动：画布对象 ↔ 侧边栏条目
            const objectEl = (e.target as Element | null)?.closest?.("[data-object-id]");
            this.setHovered(objectEl?.getAttribute("data-object-id") ?? null);
            return;
        }

        if (drag.kind === "draw" || drag.kind === "lineClick") {
            this.draftPointer = {...p};
            if (this.draft) {
                const zoom = this.viewport.zoom || 1;
                if (this.mobile && this.touchSnapped && this.touchSnapAnchor) {
                    if (distance(p, this.touchSnapAnchor) * zoom <= TOUCH_SNAP_TOLERANCE) {
                        // 还在停顿容差内：保持吸附，别被手指的小抖动带跑
                        this.updateDraft(this.draft, drag.start, this.draftPointer, true);
                    } else {
                        // 真的继续滑了 → 立刻解除吸附，回到自由拖动
                        this.touchSnapped = false;
                        this.touchSnapAnchor = null;
                        this.updateDraft(this.draft, drag.start, p, e.shiftKey || this.forceShift);
                        this.scheduleTouchHold(drag.start);
                    }
                } else {
                    this.updateDraft(this.draft, drag.start, p, e.shiftKey || this.forceShift);
                    this.scheduleTouchHold(drag.start);
                }
            }
        } else if (drag.kind === "move" && drag.group && drag.group.length > 1) {
            if (distance(p, drag.start) * this.viewport.zoom < this.dragSlop) return;
            const dx = p.x - drag.start.x;
            const dy = p.y - drag.start.y;
            for (const original of drag.group) {
                const object = this.getObject(original.id);
                if (!object) continue;
                object.geometry = cloneGeometry(original.geometry);
                translateObject(object, dx, dy);
                object.meta.updatedAt = Date.now();
            }
        } else if (drag.kind === "move") {
            const object = this.getObject(this.selectedId);
            if (!object) return;
            // 阈值以内当手抖：否则「点一下」会把对象挪动一两个像素
            if (distance(p, drag.start) * this.viewport.zoom < this.dragSlop) return;
            object.geometry = cloneGeometry(drag.original.geometry);
            translateObject(object, p.x - drag.start.x, p.y - drag.start.y);
            // 文字不许被拖出画布左右边界；贴着右边缘时可用宽度变小，行数自动变多
            if (object.type === "text") {
                const text = object.geometry as TextGeometry;
                text.x = Math.max(0, Math.min(Math.max(0, this.canvasWidth - text.fontSize), text.x));
            }
            object.meta.updatedAt = Date.now();
        } else {
            const object = this.getObject(this.selectedId);
            if (!object) return;
            // 拖手柄同样要过阈值：只是点了一下手柄，不该把对象缩放 / 旋转一点点
            if (distance(p, drag.start) * this.viewport.zoom < this.dragSlop) return;
            // 每次从拖拽开始时的副本重算，避免累积误差
            object.geometry = cloneGeometry(drag.original.geometry);
            object.style = {...drag.original.style};
            const name = drag.handle;
            if (name === "start" || name === "end" || name === "curve") {
                const a = object.geometry as ArrowGeometry;
                if (name === "start") a.start = {...p};
                else if (name === "end") a.end = {...p};
                else {
                    const original = drag.original.geometry as ArrowGeometry;
                    const center = midpoint(original.start, original.end);
                    a.control = distance(p, center) < 5 / this.viewport.zoom ? null : {...p};
                }
            } else if (name.startsWith("point:")) {
                // 画线 / 折线：拖任意一个顶点改这一段的终点方向；按住 Shift 也能锁 45°
                const index = Number(name.slice(6));
                const l = object.geometry as LineGeometry;
                if (Number.isFinite(index) && index >= 0 && index < l.points.length) {
                    const anchor = index > 0 ? l.points[index - 1] : null;
                    l.points[index] = (e.shiftKey || this.forceShift) && anchor ? snapDirection(anchor, p) : {...p};
                }
            } else if (name === "tip") {
                const n = object.geometry as NumberGeometry;
                n.tip = distance(p, n.center) < n.radius + 6 / this.viewport.zoom ? null : {...p};
            } else if (name === "anchor") {
                // 放大镜锚点：换「看哪儿」，镜框原地不动，内容随即重采
                const m = object.geometry as MagnifierGeometry;
                m.anchor = unrotatePoint(p, drag.center, drag.rotation);
            } else if (name.startsWith("resize:")) {
                const anchor = name.slice(7);
                const local = unrotatePoint(p, drag.center, drag.rotation);
                const b = drag.originalBounds;
                const right = b.x + b.width;
                const bottom = b.y + b.height;
                const minSide = 8 / this.viewport.zoom;
                let {x, y, width, height} = b;
                if (anchor.length === 2) {
                    // 四角：等比缩放。对角点作为固定点，按较大的那个方向取比例，
                    // 图形不会被拉扁；想改宽高比请拖四边中点。
                    const fixedX = anchor.includes("w") ? right : b.x;
                    const fixedY = anchor.includes("n") ? bottom : b.y;
                    const w0 = Math.max(1, b.width);
                    const h0 = Math.max(1, b.height);
                    const kMin = Math.max(minSide / w0, minSide / h0);
                    const k = Math.max(kMin,
                        Math.abs(local.x - fixedX) / w0,
                        Math.abs(local.y - fixedY) / h0);
                    width = w0 * k;
                    height = h0 * k;
                    x = anchor.includes("w") ? fixedX - width : fixedX;
                    y = anchor.includes("n") ? fixedY - height : fixedY;
                } else {
                    // 四边中点：只动那一条边，宽高各自变化
                    if (anchor === "w") {
                        x = Math.min(local.x, right - minSide);
                        width = right - x;
                    } else if (anchor === "e") {
                        width = Math.max(minSide, local.x - b.x);
                    } else if (anchor === "n") {
                        y = Math.min(local.y, bottom - minSide);
                        height = bottom - y;
                    } else {
                        height = Math.max(minSide, local.y - b.y);
                    }
                }
                scaleObjectToBounds(object, b, {x, y, width, height});
            } else if (name === "rotate") {
                const angle = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) * 180 / Math.PI;
                let next = (drag.original.geometry as {rotation?: number}).rotation ?? 0;
                next += angle - drag.startAngle;
                if (e.shiftKey || this.forceShift) next = Math.round(next / 15) * 15;
                setRotation(object, next);
            }
            object.meta.updatedAt = Date.now();
        }
        this.renderCanvas();
    }

    private onPointerUp(e: PointerEvent): void {
        if (this.cropMode) return;
        // 双指结束时的这次抬起，绝不能把半截草稿提交成对象
        if (this.mobile && this.gestureMode !== "constrain" &&
            (this.gestureLocked || this.touchPoints.size >= 2)) {
            // 双指缩放时第一根手指常常落在空白上：这次抬起不算「点空白」，
            // 否则一捏合就丢选中、手柄全没了。
            this.pendingDeselect = null;
            this.abortCurrentGesture();
            return;
        }
        this.flushPendingDeselect(e);
        // 识别模式的单击：抬指时才落地；位移过大说明是在平移画布，不打码
        if (this.smartTap) {
            const tap = this.smartTap;
            this.cancelSmartTap();
            if (distance(this.toImagePoint(e), tap.start) * this.viewport.zoom < 8) {
                this.applySmartRegion(tap.index);
            }
            this.smartCooldownUntil = performance.now() + 200;
            return;
        }
        const drag = this.drag;
        if (!drag) return;
        // 先记下手指在末端停了多久：下面 onPointerMove 会把 lastMoveAt 刷新成现在，
        // 事后再算就永远是 0，触屏「停顿即矫正」会失效
        const touchDwellMs = this.lineTouch ? Date.now() - this.lineTouch.lastMoveAt : 0;
        // 快速松手时未必有对应的 pointermove，用 pointerup 的最终坐标再算一次
        this.onPointerMove(e);
        this.drag = null;
        this.resetTouchHold();
        try {
            this.svg?.releasePointerCapture?.(e.pointerId);
        } catch {
            // 忽略
        }

        if (drag.kind === "move" && this.pendingTextEdit) {
            // 单击（没有真正拖动）已选中的文字 → 直接进入编辑，光标落在点击处
            const pending = this.pendingTextEdit;
            this.pendingTextEdit = null;
            const moved = distance(this.toImagePoint(e), pending.start) * this.viewport.zoom;
            if (moved < this.dragSlop) {
                const object = this.getObject(pending.id);
                if (object) {
                    this.beginTextEdit(object, pending.start);
                    this.render();
                    return;
                }
            }
        }
        this.pendingTextEdit = null;

        if (drag.kind === "lineClick") {
            // 折线：把光标点固化成一个新折点，末尾再补一个预览点
            const draft = this.draft;
            if (draft?.type === "line") {
                const l = draft.geometry as LineGeometry;
                const p = this.toImagePoint(e);
                const anchor = l.points.length >= 2 ? l.points[l.points.length - 2] : drag.start;
                const next = (e.shiftKey || this.forceShift) ? snapDirection(anchor, p) : {...p};
                if (distance(anchor, next) >= 8 / this.viewport.zoom) {
                    l.points[l.points.length - 1] = next;
                    l.points.push({...next});
                }
            }
            this.render();
            return;
        }

        if (drag.kind === "draw") {
            const draft = this.draft;
            if (draft?.type === "line") {
                const l = draft.geometry as LineGeometry;
                const moved = distance(this.toImagePoint(e), drag.start) * this.viewport.zoom;
                // 触屏智能矫正：末端停顿 / 滑得极短 / 又直又贴近 45° 网格时拉直
                if (this.mobile && this.lineTouch) {
                    const from = l.points[0];
                    const to = l.points[l.points.length - 1];
                    const samples = this.lineTouch.samples;
                    if (shouldSnapTouchLine({
                        dwellMs: touchDwellMs,
                        distancePx: distance(from, to) * this.viewport.zoom,
                        deviationPx: maxPathDeviation(samples, from, to) * this.viewport.zoom,
                        angleOffsetDeg: angleOffsetFromGrid(from, to),
                    })) {
                        l.points[l.points.length - 1] = snapDirection(from, to);
                    }
                    this.lineTouch = null;
                }
                if (moved < this.dragSlop) {
                    if (!this.mobile) {
                        // PC：单击＝折线起点，等下一次点击继续连
                        l.points = [{...drag.start}, {...drag.start}];
                        this.linePolyline = true;
                        this.render();
                        return;
                    }
                    // 手机上不提供点击折线；轻点一下不画东西
                    this.draft = null;
                    this.lineTouch = null;
                    this.render();
                    return;
                }
            }
            this.draft = null;
            this.draftPointer = null;
            this.lineTouch = null;
            if (draft && this.isDraftValid(draft)) {
                const object = this.createObject(draft.type, draft.geometry);
                this.scene.objects.push(object);
                this.selectedId = object.id;
                // 保持当前工具，方便连续绘制同类型标注；
                // 需要选择时由用户自己点「选择」，刚画好的对象仍会自动选中以便继续调整。
                this.commit();
            }
        } else {
            this.commit();
        }
        this.render();
    }

    // ---------------------------------------------------------------- 快捷键
    private onKeyDown(e: KeyboardEvent): void {
        // 输入框 / 滑块 / 下拉框内的按键交给控件自己处理。
        // 尤其文字编辑态的 Esc 要由 textarea 监听提交，不能被全局捕获抢走。
        if (this.isTyping(e.target)) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = (e.key || "").toLowerCase();
        // 取色弹窗展开时：Esc 只收弹窗，不切工具、不关窗口
        // 对齐模式开着时，Esc 先退回普通选择，不直接关窗口
        if (this.alignMode && key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            this.toggleAlignMode(false);
            return;
        }
        if (this.colorPopOpen && key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeColorPop();
            return;
        }
        // 箭头下拉展开时：Esc 只收下拉，不切工具、不关窗口
        if (this.arrowPickerOpen && key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeArrowPicker();
            return;
        }
        if (this.cornerPickerOpen && key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeCornerPicker();
            return;
        }
        if (this.slotEdit && key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeSlotPop();
            return;
        }
        if ((this.numberFormatOpen || this.numberStyleOpen) && key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            this.closeNumberPickers();
            return;
        }
        // 折线画到一半：Esc 是「收尾」，保留已连好的线段，不切工具也不关窗口
        if (key === "escape" && this.linePolyline) {
            e.preventDefault();
            e.stopPropagation();
            this.finishLine();
            return;
        }
        // 取色模式：Esc 退出
        if (this.pickMode) {
            if (key === "escape") {
                e.preventDefault();
                e.stopPropagation();
                this.stopPickColor();
                this.setStatus("已取消取色");
            }
            return;
        }
        // 裁切态：回车确认、Esc 放弃；其余按键一律吞掉，
        // 否则可能在拉裁切框的同时触发撤销、切工具等操作，状态就乱了
        if (this.cropMode) {
            if (key === "enter") {
                e.preventDefault();
                e.stopPropagation();
                this.applyCrop();
            } else if (key === "escape") {
                e.preventDefault();
                e.stopPropagation();
                this.cancelCrop();
                this.setStatus("已取消裁切");
            } else if (key === "delete" || key === "backspace") {
                // 参考插件按 Delete 直接把裁剪框删掉；之后在图上拖一下就是新框
                e.preventDefault();
                e.stopPropagation();
                this.cropRect = null;
                this.cropDragStart = null;
                this.cropHandle = null;
                this.cropMove = null;
                this.cropAspect = null;
                this.cropAspectKey = "free";
                this.syncCropRatios();
                this.updateCropBar();
                this.renderOverlay();
                this.setStatus("裁剪框已清除：在图上拖出新框；按 Esc 放弃裁剪");
            } else {
                e.preventDefault();
            }
            return;
        }
        if (mod && key === "z") {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) this.redo();
            else this.undo();
            return;
        }
        if (mod && key === "y") {
            e.preventDefault();
            e.stopPropagation();
            this.redo();
            return;
        }
        const shortcut = (run: () => void): void => {
            e.preventDefault();
            e.stopPropagation();
            run();
        };
        if (mod && key === "s") { shortcut(() => void this.saveAndClose()); return; }
        if (mod && key === "d") {
            if (!this.selectedId) return;
            shortcut(() => this.duplicateObject(this.selectedId!));
            return;
        }
        if (!mod) {
            if (key === " ") {
                this.spaceDown = true;
                e.preventDefault();
                return;
            }
            if (key === "0") { shortcut(() => this.fitView()); return; }
            if (key === "?" || key === "f1") { shortcut(() => this.toggleHelp()); return; }
            if (key === "+" || key === "=") { shortcut(() => this.zoomBy(1.2)); return; }
            if (key === "-") { shortcut(() => this.zoomBy(1 / 1.2)); return; }
            if ((key === "[" || key === "]") && this.selectedId) {
                shortcut(() => this.moveInLayer(this.selectedId!, key === "]" ? "up" : "down"));
                return;
            }
        }
        if (key === "delete" || key === "backspace") {
            if (this.isTyping(e.target) || !this.selectedId) return;
            e.preventDefault();
            e.stopPropagation();
            this.deleteSelected();
            return;
        }
        if (key === "escape") {
            e.preventDefault();
            e.stopPropagation();
            if (this.selectedId || this.activeTool !== "select" || this.drag) {
                this.selectedId = null;
                this.activeTool = "select";
                this.drag = null;
                this.draft = null;
                this.render();
            } else {
                this.close();
            }
            return;
        }
        // 单键工具快捷键；文字输入框内由 textarea 自己 stopPropagation
        if (!mod && !e.altKey && !this.isTyping(e.target)) {
            // H = 手型平移（与常见图像编辑器一致）
            if (key === "h") {
                e.preventDefault();
                e.stopPropagation();
                this.setTool("pan");
                return;
            }
            const item = TOOL_ITEMS.find((i) => i.key === key);
            if (item) {
                e.preventDefault();
                e.stopPropagation();
                this.setTool(item.tool);
            }
        }
    }

    private isTyping(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        if (!el) return false;
        const tag = el.tagName?.toLowerCase();
        return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
    }

    // ---------------------------------------------------------------- 渲染
    private renderCanvas(): void {
        // 每帧按「文字右边还剩多少地方」重算折行：拖动文字时行数会实时变
        reflowTextObjects(this.scene.objects, this.canvasWidth);
        this.renderObjects();
        this.renderOverlay();
        this.renderToolbar();
        this.renderPresetState();
        if (!this.drag) this.setHovered(this.hoveredId);
    }

    private render(): void {
        this.renderCanvas();
        this.sidebar?.render(this.scene.objects, this.selectedIds, this.hoveredId);
        this.renderContextBar();
        this.renderMobileStyle();
        this.renderMobileTopbar();
        this.syncMobileSheets();
        this.syncMobileZoom();
        this.syncMobileFabs();
    }

    // ---------------------------------------------------------------- 移动端上下双栏
    /**
     * 上栏该显示哪些参数。
     * 跟当前工具（或选中对象的类型）走：箭头只有颜色 / 粗细，矩形椭圆多一个填充，
     * 文字和序号换成字号，马赛克 / 模糊没有可调样式，就给一句提示。
     */
    private mobileStyleGroups(): string[] {
        if (this.cropMode) return ["ratios"];
        const object = this.getObject(this.selectedId);
        const type = object ? object.type : (this.activeTool === "select" ? "" : this.activeTool);
        switch (type) {
            // 线型只对「有线」的对象有意义，跟 PC 顶栏保持一致：箭头 / 画线 / 矩形 / 椭圆都有
            case "arrow":
            case "line": return ["colors", "widths", "lines"];
            case "rect": return ["colors", "widths", "lines", "fills", "corners"];
            case "ellipse": return ["colors", "widths", "lines", "fills"];
            case "text": return ["colors", "fonts"];
            // 序号多两组：编号格式、引线端点（手机上也能改，不然默认为罗马数字就再也回不去）
            case "number": return ["colors", "numbers", "fonts"];
            case "highlight":
            // 矩形高亮只认「颜色 + 填充浓度」两样，粗细 / 线型对它没有意义
            case "highlightRect": return ["colors", "fills"];
            // 马赛克 / 模糊：手机上也要能调参数，给一个紧凑滑块（v1.1.0-alpha.3）
            case "mosaic": return ["blockSize"];
            case "blur": return ["blurRadius"];
            // 放大镜：镜框颜色 / 线宽有用；聚光灯没有现成的分组可复用，上栏给提示
            case "magnifier": return ["colors", "widths"];
            case "spotlight": return [];
            default: return ["colors", "widths", "lines"];
        }
    }

    /** 上栏按钮全部复用 PC 的预设机制（data-preset / data-action），不另做一套状态 */
    private buildMobileStyleGroups(groups: string[]): string {
        const parts: string[] = [];
        if (groups.includes("colors")) {
            const swatches = this.presets.colors.map((hex) => `
                <button type="button" class="annot-mobile-swatch" data-preset="color" data-value="${hex}"
                    title="${hex}" aria-label="颜色 ${hex}" style="--annot-swatch-color:${hex}"></button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="colors">
                <span class="annot-mobile-style__label">颜色</span>${swatches}
                <button type="button" class="annot-mobile-swatch annot-mobile-swatch--custom"
                    data-action="mobile-color" title="自定义颜色" aria-label="自定义颜色"></button>
            </div>`);
        }
        if (groups.includes("widths")) {
            const items = this.presets.lineWidths.map((width) => `
                <button type="button" class="annot-mobile-chip" data-preset="lineWidth" data-value="${width}"
                    title="粗细 ${width} px" aria-label="粗细 ${width} 像素">
                    <span class="annot-mobile-chip__line" style="height:${Math.min(6, Math.max(1.5, width))}px"></span>
                    <span class="annot-mobile-chip__num">${width}</span>
                </button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="widths">
                <span class="annot-mobile-style__label">粗细</span>${items}</div>`);
        }
        if (groups.includes("lines")) {
            // 线型在手机上原本没有，和 PC 顶栏一样补上四档（图案沿用 .annot-line-demo）
            const items = DASH_ITEMS.map((item) => `
                <button type="button" class="annot-mobile-chip" data-preset="lineDash" data-value="${item.key}"
                    title="${item.label}" aria-label="${item.label}">
                    <span class="annot-line-demo annot-line-demo--${item.key}"></span></button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="lines">
                <span class="annot-mobile-style__label">线型</span>${items}</div>`);
        }
        if (groups.includes("fills")) {
            const items = this.presets.fillOpacities.map((value) => `
                <button type="button" class="annot-mobile-chip" data-preset="fillOpacity" data-value="${value}"
                    title="填充 ${Math.round(value * 100)}%" aria-label="填充 ${Math.round(value * 100)} 百分比">${Math.round(value * 100)}%</button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="fills">
                <span class="annot-mobile-style__label">填充</span>${items}</div>`);
        }
        if (groups.includes("numbers")) {
            const picked = this.getObject(this.selectedId);
            const numberObject = picked?.type === "number" ? picked : null;
            const format = normalizeNumberFormat(numberObject
                ? (numberObject.geometry as NumberGeometry).format : this.current.numberFormat);
            const tip = normalizeNumberTip(numberObject ? numberObject.style.numberTip : this.current.numberTip);
            const formatItems = NUMBER_FORMATS.map((item) => `
                <button type="button" class="annot-mobile-chip${item.key === format ? " is-active" : ""}"
                    data-action="number-format-pick" data-value="${item.key}"
                    title="${item.label}" aria-label="${item.label}">${item.chip}</button>`).join("");
            const tipItems = NUMBER_TIPS.map((item) => `
                <button type="button" class="annot-mobile-chip${item.key === tip ? " is-active" : ""}"
                    data-action="number-tip" data-value="${item.key}"
                    title="${item.hint}" aria-label="${item.label}">${item.label}</button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="numbers">
                <span class="annot-mobile-style__label">编号</span>${formatItems}
                <span class="annot-mobile-style__label">端点</span>${tipItems}</div>`);
        }
        if (groups.includes("corners")) {
            // 手机屏窄，只给五档最常用的（直角 / 4 / 8 / 16 / 24）
            const items = MOBILE_CORNER_STEPS.map((value) => `
                <button type="button" class="annot-mobile-chip" data-preset="cornerRadius" data-value="${value}"
                    title="圆角 ${value} px" aria-label="圆角 ${value} 像素">${value === 0 ? "直角" : value}</button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="corners">
                <span class="annot-mobile-style__label">圆角</span>${items}</div>`);
        }
        if (groups.includes("fonts")) {
            const items = this.presets.fontSizes.map((size) => `
                <button type="button" class="annot-mobile-chip" data-preset="fontSize" data-value="${size}"
                    title="字号 ${size} px" aria-label="字号 ${size} 像素">${size}</button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="fonts">
                <span class="annot-mobile-style__label">字号</span>${items}</div>`);
        }
        // 马赛克块大小 / 模糊程度：手机屏窄，滑块压到 96px，数值跟在右边
        if (groups.includes("blockSize") || groups.includes("blurRadius")) {
            const isBlur = groups.includes("blurRadius");
            const key = isBlur ? "blurRadius" : "blockSize";
            const object = this.getObject(this.selectedId);
            let value = isBlur ? this.contextDefaults.blurRadius : this.contextDefaults.blockSize;
            if (isBlur && object?.type === "blur") {
                value = (object.geometry as BlurGeometry).radius ?? value;
            } else if (!isBlur && object?.type === "mosaic") {
                value = (object.geometry as MosaicGeometry).blockSize ?? value;
            }
            value = Math.round(value);
            const label = isBlur ? "模糊程度" : "块大小";
            parts.push(`<div class="annot-mobile-style__group annot-mobile-style__group--slider" data-group="${key}">
                <span class="annot-mobile-style__label">${label}</span>
                <input type="range" class="annot-mobile-range" data-ctx="${key}"
                    min="${isBlur ? 2 : 4}" max="${isBlur ? MAX_BLUR_RADIUS : 48}" value="${value}"
                    aria-label="${label}">
                <b class="annot-mobile-range__value" data-role="m-${key}">${value}</b>
            </div>`);
        }
        if (groups.includes("ratios")) {
            const items = CROP_RATIO_PRESETS.map((item) => `
                <button type="button" class="annot-mobile-chip${item.key === this.cropAspectKey ? " is-active" : ""}"
                    data-action="crop-ratio" data-ratio="${item.key}"
                    title="${item.key === "free" ? "不限制比例" : `锁定 ${item.label}`}">${item.label}</button>`).join("");
            parts.push(`<div class="annot-mobile-style__group" data-group="ratios">
                <span class="annot-mobile-style__label">比例</span>${items}</div>`);
        }
        if (!parts.length) {
            const hint = this.activeTool === "mosaic" || this.activeTool === "blur"
                ? "这个工具没有可调参数：直接在图上拖出要处理的范围"
                : "上栏会跟着当前工具显示颜色、粗细、填充和字号";
            parts.push(`<div class="annot-mobile-style__group annot-mobile-style__group--hint" data-group="hint">
                <span class="annot-mobile-style__hint">${hint}</span></div>`);
        }
        return parts.join("");
    }

    /**
     * 移动端对象抽屉：拽顶部小横条往下滑＝关闭。
     * 面板从屏幕最底边长出来、会盖住底部两条栏，所以「对象」胶囊被自己挡住，
     * 抓手是唯一的显式关闭入口（另外点画布空白也能关）。
     * 拖动时去掉过渡让面板严格跟手，松手按「抽屉高度的 1/4」判断：过了就关，没过弹回。
     */
    /**
     * 移动端键盘：一弹出来就把底部三栏收掉。
     *
     * 键盘占掉屏幕下方 30~40%，而属性栏 + 工具条 + 两颗圆钮又压在最下面，
     * 用户正在写的那行字几乎全被盖住。此刻他要的是"看见自己写的字"，
     * 不是改颜色或换工具 —— 所以三栏直接隐藏，画布同时缩到键盘上沿；
     * 键盘一收起，三栏原样回来（类名一摘，CSS 全部还原，不动任何内联样式）。
     */
    private bindMobileKeyboard(): void {
        if (!this.mobile || !this.root) return;
        const viewport = window.visualViewport;
        if (!viewport) return;
        // 基准高度必须在「键盘还没弹」时就记下来，否则第一次事件里算出来的差值是 0，
        // 键盘弹起根本检测不到（之前就是栽在这）。
        this.mobileViewportBase = Math.max(window.innerHeight, viewport.height);
        // 舞台高度也要记：隐藏底部三栏后 stage 会「长高」，SVG 跟着变尺寸，画布就又跑位了
        this.mobileStageBase = this.stage?.clientHeight || 0;
        const sync = (): void => {
            if (!this.root || this.finished) return;
            if (!this.mobileViewportBase) {
                this.mobileViewportBase = Math.max(window.innerHeight, viewport.height);
            }
            const hidden = this.mobileViewportBase - viewport.height;
            const editing = !!this.editingTextId;
            const open = hidden > 120 || (editing && hidden > 40);
            if (open && !this.root.classList.contains("is-keyboard")) {
                // 锁的是「键盘弹之前」的高度（mobileViewportBase）。
                // 不能用实时测量：resize 事件到达时布局已经缩过了，量出来就是缩小后的值。
                const h = Math.round(this.mobileViewportBase);
                if (h > 0) this.root.style.setProperty("--annot-lock-h", `${h}px`);
                // 舞台同理：锁成「键盘弹之前」的高度，隐藏三栏腾出来的空间不用它去填
                if (this.mobileStageBase > 0) {
                    this.root.style.setProperty("--annot-lock-stage", `${Math.round(this.mobileStageBase)}px`);
                }
            }
            this.root.classList.toggle("is-keyboard", open);
            if (!open) {
                this.root.style.removeProperty("--annot-lock-h");
                this.root.style.removeProperty("--annot-lock-stage");
            }
            // 画布本身一格不动，只把正在输入的文本框抬到键盘上方
            this.liftTextEditor(open ? Math.max(0, hidden) : 0);
        };
        this.keyboardSync = sync;
        viewport.addEventListener("resize", sync, {signal: this.abort.signal});
        viewport.addEventListener("scroll", sync, {signal: this.abort.signal});
        // 有些设备只发 window.resize（不发 visualViewport），两个都听
        window.addEventListener("resize", sync, {signal: this.abort.signal});
        this.abort.signal.addEventListener("abort", () => {
            this.root?.classList.remove("is-keyboard");
            this.root?.style.removeProperty("--annot-lock-h");
            this.root?.style.removeProperty("--annot-lock-stage");
            this.liftTextEditor(0);
        }, {once: true});
    }

    /**
     * 键盘挡住输入框时，只把文本框（和它的细边框）往上抬到键盘上沿，
     * 画布的缩放、平移、尺寸一个都不碰 —— 这就是「编辑期间标注不跑位」的关键。
     */
    private liftTextEditor(lift: number): void {
        const editor = this.textEditor;
        if (!editor) return;
        const clear = (): void => {
            editor.style.transform = "";
            if (this.textFrame) this.textFrame.style.transform = "";
        };
        if (lift <= 0) { clear(); return; }
        const stageRect = this.stage?.getBoundingClientRect();
        if (!stageRect) { clear(); return; }
        const box = editor.getBoundingClientRect();
        // 最多抬到「输入框顶边贴着舞台上沿」，再抬就看不见了
        const delta = Math.max(0, Math.min(lift, box.top - stageRect.top - 8));
        if (delta <= 0) { clear(); return; }
        editor.style.transform = `translateY(${-delta}px)`;
        if (this.textFrame) this.textFrame.style.transform = `translateY(${-delta}px)`;
    }

    private bindMobileDrawer(): void {
        if (!this.mobile || !this.root) return;
        const signal = this.abort.signal;
        const root = this.root;
        root.addEventListener("pointerdown", (event) => {
            const grab = (event.target as Element | null)?.closest?.('[data-role="mobile-grab"]');
            if (!grab || !this.mobileSheetOpen) return;
            const sheet = root.querySelector<HTMLElement>('[data-role="sidebar"]');
            if (!sheet) return;
            event.preventDefault();
            event.stopPropagation();
            const pointer = event as PointerEvent;
            const startY = pointer.clientY;
            const height = sheet.getBoundingClientRect().height || 1;
            const threshold = Math.min(96, height * 0.25);
            let dy = 0;
            sheet.classList.add("is-dragging");
            try {
                grab.setPointerCapture?.(pointer.pointerId);
            } catch {
                // 某些内核在触摸序列里不允许捕获，忽略即可（window 上的监听照样能收到）
            }
            const onMove = (move: PointerEvent): void => {
                dy = Math.max(0, move.clientY - startY);
                sheet.style.transform = `translateY(${dy}px)`;
            };
            const finish = (): void => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                sheet.classList.remove("is-dragging");
                sheet.style.transform = "";
                if (dy > threshold) {
                    this.mobileSheetOpen = false;
                    this.syncMobileSheets();
                    this.renderMobileTopbar();
                }
            };
            window.addEventListener("pointermove", onMove, {signal});
            window.addEventListener("pointerup", finish, {signal});
            window.addEventListener("pointercancel", finish, {signal});
        }, {signal});
    }

    /**
     * 双指手势的硬闸：直接用原生 touch 的 touches.length 判定，不依赖 pointer 事件。
     * 只要屏幕上有 2 根以上手指，就立刻中断并清掉正在画的东西，并把 gestureLocked 置位，
     * 之后所有绘制入口都直接返回；手指全部抬起才解锁。
     */
    private bindMobileGestureGuard(): void {
        if (!this.mobile) return;
        const stage = this.stage;
        if (!stage) return;
        const signal = this.abort.signal;
        const unlock = (event: TouchEvent): void => {
            if (event.touches.length > 0) return;
            // 手指全部抬起：把双指状态、锁、pointer 计数一起清空。
            // 有些 pointerup 会丢在画布外收不到，不清就会让下一次单指被误判成「第二根手指」，
            // 表现就是「双指之后再也画不出东西」。
            this.touchPoints.clear();
            this.finishGesture();
        };
        window.addEventListener("touchend", unlock, {capture: true, passive: true, signal});
        window.addEventListener("touchcancel", unlock, {capture: true, passive: true, signal});
    }

    /** 双指介入时把「正在画 / 正在拖 / 正在编辑」的东西全部丢掉（草稿不提交，等于撤销） */
    private abortCurrentGesture(): void {
        this.clearTouchHold();
        this.resetTouchHold();
        this.drag = null;
        this.draft = null;
        this.linePolyline = false;
        this.lineTouch = null;
        this.pendingTextEdit = null;
        this.pendingDeselect = null;
        this.cropHandle = null;
        this.cropMove = null;
        this.cropDragStart = null;
        this.cropLastPoint = null;
        this.panDrag = null;
        this.finishTextEdit();
        this.render();
    }

    /** 收起底部对象抽屉（拖动抓手 / 点画布两条路径共用） */
    private closeMobileSheet(): void {
        if (!this.mobileSheetOpen) return;
        this.mobileSheetOpen = false;
        this.syncMobileSheets();
    }

    /** 两指落下后判定：一指按住不动 → 约束绘制；两指都在动 → 画布缩放 */
    private resolveTwoFinger(): void {
        const entries = Array.from(this.touchPoints.entries());
        if (entries.length < 2) return;
        const moving = entries
            .map(([id, p]) => {
                const start = this.gestureStart.get(id) ?? p;
                return {id, dist: Math.hypot(p.x - start.x, p.y - start.y)};
            })
            .filter((item) => item.dist > GESTURE_HOLD_SLOP);
        if (moving.length === 0) return;          // 都还没动：继续待定
        if (moving.length >= 2) { this.enterPinch(); return; }
        this.enterConstrain();
    }

    /**
     * 「按住不动」的那根手指是不是也动起来了（滞回阈值更大，避开正常抖动）。
     * 只盯进入约束时被判定为静止的那一根——负责画的那根本来就会越走越远，不能算进来。
     */
    private holdFingerMoved(): boolean {
        if (this.gestureHoldId === null) return false;
        const start = this.gestureStart.get(this.gestureHoldId);
        const p = this.touchPoints.get(this.gestureHoldId);
        if (!start || !p) return false;
        return Math.hypot(p.x - start.x, p.y - start.y) > GESTURE_RELEASE_SLOP;
    }

    /** 两指都在动 → 画布缩放；待定期间可能画出来的草稿一并丢掉 */
    private enterPinch(): void {
        if (this.gestureMode === "pinch") return;
        this.gestureMode = "pinch";
        this.gestureLocked = true;
        this.forceShift = false;
        this.gestureDriveId = null;
        this.abortCurrentGesture();
        // 第一根手指起笔时把选中清了，这里还回去：缩放画面不该改变选中的是谁
        if (this.selectedIds.length === 0 && this.selectionBeforeGesture?.length) {
            this.selectedIds = [...this.selectionBeforeGesture];
            this.render();
        }
        const [a, b] = Array.from(this.touchPoints.values());
        if (!a || !b) return;
        const center = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
        this.pinch = {
            zoom: this.viewport.zoom, panX: this.viewport.panX, panY: this.viewport.panY,
            distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midX: center.x, midY: center.y,
        };
    }

    /**
     * 一指按住不动 + 另一指滑动 → 类 Shift 约束绘制。
     * 用「移动的那根手指」当绘图指针，并且把 Shift 强制打开，
     * 几何计算仍然走原来那套（画线吸附 / 矩形椭圆 1:1），不另写一份。
     */
    private enterConstrain(): void {
        if (this.gestureMode === "constrain") return;
        this.gestureMode = "constrain";
        this.forceShift = true;
        this.gestureLocked = false;
        // 记下「按住不动」的那一根：后面只盯它，负责画的那根本来就会一直跑
        for (const [id, p] of this.touchPoints) {
            const start = this.gestureStart.get(id);
            if (start && Math.hypot(p.x - start.x, p.y - start.y) <= GESTURE_HOLD_SLOP) {
                this.gestureHoldId = id;
                break;
            }
        }
        // 以「移动的那根手指」作为绘图指针：第一根手指之前可能已经落下并起了个草稿，
        // 这里先丢掉，从移动指的位置重新起笔，起点才和用户正在拖的那根手一致。
        if (this.drag) {
            this.drag = null;
            this.draft = null;
        }
        const entry = Array.from(this.touchPoints.entries()).find(([id]) => {
            const start = this.gestureStart.get(id);
            const p = this.touchPoints.get(id);
            return !!start && !!p && Math.hypot(p.x - start.x, p.y - start.y) > GESTURE_HOLD_SLOP;
        });
        if (!entry) return;
        const [id, p] = entry;
        this.gestureDriveId = id;
        this.onPointerDown(this.fakePointer(id, p.x, p.y));
    }

    /** 约束绘制期间，把手指位置喂给正常的绘制流程（Shift 已强制打开） */
    private gestureDrawTo(id: number, x: number, y: number): void {
        if (!this.drag) return;
        this.onPointerMove(this.fakePointer(id, x, y));
    }

    /** 合成一个「只带坐标和 Shift」的指针事件，避免给约束模式另写一套几何 */
    private fakePointer(id: number, x: number, y: number): PointerEvent {
        return {
            pointerId: id, pointerType: "touch", button: 0, buttons: 1,
            clientX: x, clientY: y,
            shiftKey: this.forceShift, altKey: false, ctrlKey: false, metaKey: false,
            target: this.svg,
            preventDefault: () => undefined, stopPropagation: () => undefined,
            composedPath: () => [],
        } as unknown as PointerEvent;
    }

    /** 双指手势收尾：状态、锁、强制 Shift 一起复位 */
    private finishGesture(): void {
        // 手指全离开后短暂冷却：抬手的余波不再被当成「点击识别」
        this.smartCooldownUntil = performance.now() + 200;
        this.selectionBeforeGesture = null;
        this.gestureMode = "none";
        this.gestureLocked = false;
        this.forceShift = false;
        this.gestureDriveId = null;
        this.gestureHoldId = null;
        this.pinch = null;
        this.gestureStart.clear();
    }

    private renderMobileStyle(): void {
        if (!this.mobile || !this.root) return;
        const host = this.root.querySelector<HTMLElement>('[data-role="mobile-style"]');
        if (!host) return;
        // 选中两个以上：这一条让位给「对齐条」——已选 N 个 + 8 颗按钮（可左右滑）
        if (this.selectedIds.length >= 2 && !this.cropMode) {
            const alignKey = `align|${this.selectedIds.length}`;
            if (alignKey !== this.mobileStyleKey) {
                this.mobileStyleKey = alignKey;
                host.innerHTML = this.buildMobileAlignRow();
                host.scrollLeft = 0;
            }
            return;
        }
        const groups = this.mobileStyleGroups();
        const object = this.getObject(this.selectedId);
        const numberState = groups.includes("numbers")
            ? `${normalizeNumberFormat(object?.type === "number"
                ? (object.geometry as NumberGeometry).format : this.current.numberFormat)}/` +
              `${normalizeNumberTip(object?.type === "number" ? object.style.numberTip : this.current.numberTip)}`
            : "";
        // 带上对象 id：同类对象互相切换时也要重建，否则滑块会停在上一块的数值上
        const key = `${this.cropMode ? "crop" : this.activeTool}|` +
            `${object?.type ?? (this.activeTool === "select" ? "" : this.activeTool)}|` +
            `${object?.id ?? ""}|${groups.join(",")}|${numberState}`;
        if (key !== this.mobileStyleKey) {
            this.mobileStyleKey = key;
            host.innerHTML = this.buildMobileStyleGroups(groups);
            host.scrollLeft = 0;
        }
        // 点完色点 / 粗细后重新标高亮（与 PC 共用同一套 data-preset 判定）
        this.renderPresetState();
        this.syncCropRatios();
    }

    // ---------------------------------------------------------------- 顶部悬浮参数栏
    /**
     * 顶部栏该出哪几枚按钮：跟当前工具 / 选中对象走，一栏对应 PC 悬浮条上的一类参数。
     * 手机上一屏只留最常用的枚举型参数；马赛克块大小、模糊程度、聚光灯暗度这些滑块
     * 仍只在 PC 上调（手机上塞进气泡要额外占一行滑块，收益不大）。
     */
    private mobileTopItems(): MobileTopItem[] {
        // 抽屉打开时顶栏照常保留：改对象属性仍然要用它（抽屉只盖住底部）
        if (this.cropMode) return [];
        const picked = this.getObject(this.selectedId);
        const type: string = this.activeTool === "pan"
            ? ""
            : (picked?.type ?? (this.activeTool === "select" ? "" : this.activeTool));
        const style = picked?.style;
        const arrowKey = normalizeArrowStyle(style?.arrowStyle ?? this.current.arrowStyle);
        const arrowRound = picked ? style?.arrowRounded !== false : this.current.arrowRounded;
        const lineRound = picked ? style?.lineRound !== false : this.current.lineRound;
        const items: MobileTopItem[] = [];
        // 高亮只有两种画法，折叠进气泡反而多一次点击：直接并排平铺两个按钮，
        // 选中哪一个就把哪一个点亮（v1.1.0-alpha.3）
        if (type === "highlight" || type === "highlightRect") {
            const mode = this.current.highlightMode === "rect" ? "rect" : "brush";
            items.push({
                key: "hlBrush",
                label: "画笔",
                icon: TB_BRUSH,
                on: mode === "brush",
                action: "highlight-mode-brush",
                title: "画笔高亮：按住自由涂抹",
            });
            items.push({
                key: "hlRect",
                label: "矩形",
                icon: TB_SHAPE_RECT,
                on: mode === "rect",
                action: "highlight-mode-rect",
                title: "矩形高亮：拖出一块半透明色块",
            });
        }
        // 马赛克 / 模糊：一颗「识别」开关，开着时框选完按像素自动贴合主体
        if (type === "mosaic" || type === "blur") {
            items.push({
                key: "smart",
                label: "识别",
                icon: TB_SMART,
                on: this.current.smartSelect,
                action: "smart-select",
                title: this.current.smartSelect
                    ? "选区识别已开启：点一下画面上的文字或物体即可"
                    : "选区识别：点一下画面上的文字或物体，自动贴合轮廓",
            });
        }
        // 「圆线」是纯开关：点一下直接切，不弹气泡（少一次点击）
        const pushRound = (on: boolean, what: "arrow" | "line"): void => {
            items.push({
                key: "round",
                label: "圆线",
                toggle: true,
                action: what === "line" ? "line-round" : "arrow-rounded",
                on,
                icon: on ? TB_ROUND_ON : TB_ROUND_OFF,
                title: what === "line"
                    ? "线端是否圆润：开了是圆头，关掉是方头"
                    : "线端与折角是否圆润：开了是圆线，关掉是方头尖角",
            });
        };
        switch (type) {
            case "arrow":
                items.push({key: "arrowStyle", label: "箭头", icon: ARROW_STYLE_ICONS[arrowKey], title: "箭头样式"});
                pushRound(arrowRound, "arrow");
                break;
            case "line":
                pushRound(lineRound, "line");
                break;
            case "rect":
                items.push({
                    key: "corner",
                    label: "圆角",
                    icon: cornerRadiusIcon(normalizeCornerRadius(
                        picked?.type === "rect" ? picked.style.cornerRadius : this.current.cornerRadius)),
                    title: "矩形圆角半径",
                });
                break;
            case "number": {
                const format = normalizeNumberFormat(picked?.type === "number"
                    ? (picked.geometry as NumberGeometry).format : this.current.numberFormat);
                const tip = normalizeNumberTip(picked?.type === "number"
                    ? picked.style.numberTip : this.current.numberTip);
                const item = NUMBER_FORMATS.find((one) => one.key === format) ?? NUMBER_FORMATS[0];
                items.push({
                    key: "numberFormat",
                    label: "编号",
                    icon: `<span class="annot-mobile-topbar__char">${item.chip}</span>`,
                    title: `编号格式：${item.short}`,
                });
                items.push({
                    key: "numberTip", label: "端点",
                    icon: TB_TIP_ICONS[tip] ?? TB_TIP_ICONS.arrow,
                    title: "引线端点",
                });
                if (tip === "arrow") {
                    items.push({
                        key: "arrowStyle", label: "样式",
                        icon: ARROW_STYLE_ICONS[arrowKey], title: "引线箭头样式",
                    });
                }
                pushRound(arrowRound, "arrow");
                break;
            }
            case "magnifier": {
                const zoom = normalizeMagnifierZoom(picked?.type === "magnifier"
                    ? (picked.geometry as MagnifierGeometry).zoom : this.current.magnifierZoom);
                const shape = picked?.type === "magnifier"
                    ? (picked.geometry as MagnifierGeometry).shape ?? "ellipse" : this.current.magnifierShape;
                items.push({
                    key: "magnifierZoom", label: "倍数",
                    icon: `<span class="annot-mobile-topbar__char">${zoom}x</span>`, title: "放大倍数",
                });
                items.push({
                    key: "shape", label: "形状",
                    icon: shape === "rect" ? TB_SHAPE_RECT : TB_SHAPE_ELLIPSE, title: "镜片形状",
                });
                break;
            }
            case "spotlight": {
                const mask = picked?.type === "spotlight"
                    ? picked.style.spotlightColor ?? "black" : this.current.spotlightColor;
                const shape = picked?.type === "spotlight"
                    ? (picked.geometry as SpotlightGeometry).shape ?? "rect" : this.current.spotlightShape;
                items.push({
                    key: "mask", label: "遮罩",
                    icon: mask === "white" ? TB_MASK_WHITE : TB_MASK_BLACK, title: "遮罩颜色",
                });
                items.push({
                    key: "shape", label: "形状",
                    icon: shape === "rect" ? TB_SHAPE_RECT : TB_SHAPE_ELLIPSE, title: "遮挡形状",
                });
                break;
            }
            default:
                break;
        }
        return items;
    }

    /** 气泡里的选项：只留图案，不带文字（图案本身就能说明差异） */
    private mobilePopBody(key: string): string {
        const picked = this.getObject(this.selectedId);
        const cell = (action: string, value: string, icon: string, on: boolean, title: string): string =>
            `<button type="button" class="annot-mobile-pop__item${on ? " is-active" : ""}"
                data-action="${action}" data-value="${value}" aria-pressed="${on}"
                title="${title}" aria-label="${title}">${icon}</button>`;
        if (key === "arrowStyle") {
            const active = normalizeArrowStyle(picked?.style.arrowStyle ?? this.current.arrowStyle);
            return ARROW_STYLES.map((item) => cell("arrow-style-pick", item.key,
                ARROW_STYLE_ICONS[item.key], item.key === active, item.label)).join("");
        }
        if (key === "highlightMode") {
            const mode = this.current.highlightMode === "rect" ? "rect" : "brush";
            return HIGHLIGHT_MODES.map((item) => cell("highlight-mode", item.key,
                item.key === "rect" ? TB_SHAPE_RECT : TB_BRUSH,
                item.key === mode, item.label)).join("");
        }
        if (key === "corner") {
            const radius = normalizeCornerRadius(
                picked?.type === "rect" ? picked.style.cornerRadius : this.current.cornerRadius);
            return MOBILE_CORNER_STEPS.map((value) => cell("corner-radius-pick", String(value),
                `<span class="annot-mobile-topbar__char">${value}</span>`,
                value === radius, `圆角 ${value} 像素`)).join("");
        }
        if (key === "numberFormat") {
            const active = normalizeNumberFormat(picked?.type === "number"
                ? (picked.geometry as NumberGeometry).format : this.current.numberFormat);
            return NUMBER_FORMATS.map((item) => cell("number-format-pick", item.key,
                `<span class="annot-mobile-topbar__char">${item.chip}</span>`,
                item.key === active, item.label)).join("");
        }
        if (key === "numberTip") {
            const active = normalizeNumberTip(picked?.type === "number"
                ? picked.style.numberTip : this.current.numberTip);
            return NUMBER_TIPS.map((item) => cell("number-tip", item.key,
                TB_TIP_ICONS[item.key] ?? TB_TIP_ICONS.arrow,
                item.key === active, item.label)).join("");
        }
        if (key === "magnifierZoom") {
            const active = normalizeMagnifierZoom(picked?.type === "magnifier"
                ? (picked.geometry as MagnifierGeometry).zoom : this.current.magnifierZoom);
            return MAGNIFIER_ZOOMS.map((value) => cell("magnifier-zoom", String(value),
                `<span class="annot-mobile-topbar__char">${value}x</span>`,
                Math.abs(value - active) < 0.01, `放大 ${value} 倍`)).join("");
        }
        if (key === "shape") {
            // 放大镜与聚光灯共用「形状」这枚按钮，按当前对象分流
            const lens = picked?.type === "magnifier";
            const shape = lens
                ? (picked?.type === "magnifier"
                    ? (picked.geometry as MagnifierGeometry).shape ?? "ellipse" : this.current.magnifierShape)
                : (picked?.type === "spotlight"
                    ? (picked.geometry as SpotlightGeometry).shape ?? "rect" : this.current.spotlightShape);
            return (lens ? MAGNIFIER_SHAPES : SPOTLIGHT_SHAPES).map((item) => cell(
                lens ? "magnifier-shape" : "spotlight-shape", item.key,
                item.key === "rect" ? TB_SHAPE_RECT : TB_SHAPE_ELLIPSE,
                item.key === shape, item.hint)).join("");
        }
        if (key === "mask") {
            const active = picked?.type === "spotlight"
                ? picked.style.spotlightColor ?? "black" : this.current.spotlightColor;
            return SPOTLIGHT_COLORS.map((item) => cell("spotlight-color", item.key,
                `<span class="annot-mobile-pop__dot" style="background:${item.key === "white" ? "#FFFFFF" : "#111827"}"></span>`,
                item.key === active, item.hint)).join("");
        }
        return "";
    }

    private renderMobileTopbar(): void {
        if (!this.mobile || !this.root) return;
        const bar = this.root.querySelector<HTMLElement>('[data-role="mobile-topbar"]');
        if (!bar) return;
        const items = this.mobileTopItems();
        if (!items.length) {
            bar.hidden = true;
            if (this.mobileTopKey) {
                bar.innerHTML = "";
                this.mobileTopKey = "";
            }
            this.mobilePopKey = null;
            return;
        }
        // 换工具后原来展开的那枚已经不存在：直接收起，别留个孤儿气泡
        if (this.mobilePopKey && !items.some((item) => item.key === this.mobilePopKey)) {
            this.mobilePopKey = null;
        }
        bar.hidden = false;
        const fingerprint = items.map((item) => `${item.key}:${item.on ? 1 : 0}:${item.label}`).join("|")
            + `#${this.mobilePopKey ?? ""}`;
        if (fingerprint === this.mobileTopKey) return;
        this.mobileTopKey = fingerprint;
        bar.innerHTML = items.map((item) => `
            <button type="button" class="annot-mobile-topbar__btn${
                item.key === this.mobilePopKey ? " is-open" : ""}${item.on ? " is-on" : ""}"
                data-action="${item.action ?? "mobile-pop"}"${
                item.action ? "" : ` data-pop="${item.key}"`}
                aria-expanded="${item.key === this.mobilePopKey}" title="${item.title}">
                ${item.icon}<span>${item.label}</span></button>`).join("")
            + (this.mobilePopKey ? `<div class="annot-mobile-pop" data-role="mobile-pop">${
                this.mobilePopBody(this.mobilePopKey)}</div>` : "");
        this.positionMobilePop();
    }

    /** 气泡水平居中于整条栏，尖角单独指回被点的那枚按钮 */
    private positionMobilePop(): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="mobile-pop"]');
        const btn = this.root?.querySelector<HTMLElement>(".annot-mobile-topbar__btn.is-open");
        if (!pop || !btn) return;
        const popBox = pop.getBoundingClientRect();
        const btnBox = btn.getBoundingClientRect();
        if (!popBox.width) return;
        pop.style.setProperty("--tip-x",
            `${Math.round(btnBox.left + btnBox.width / 2 - popBox.left)}px`);
    }

    /** 多选时的上栏：已选数量 + 8 颗对齐 / 分布按钮（图标与 PC 同一套原稿） */
    private buildMobileAlignRow(): string {
        return `<div class="annot-mobile-style__group annot-mobile-style__group--align">` +
            `<span class="annot-mobile-style__count">已选 ${this.selectedIds.length} 个</span>` +
            ALIGN_ACTIONS.map((item) => `
                <button type="button" class="annot-mobile-align" data-action="align-op"
                    data-value="${item.op}" title="${item.hint}" aria-label="${item.label}">${item.icon}</button>`).join("") +
            `</div>`;
    }

    /** 两颗圆钮的状态：普通选择时左钮高亮；对齐模式时右钮高亮并显示已选数量 */
    private syncMobileFabs(): void {
        if (!this.mobile || !this.root) return;
        const select = this.root.querySelector<HTMLElement>('[data-action="mobile-select"]');
        const align = this.root.querySelector<HTMLElement>('.annot-fab--align');
        const count = this.root.querySelector<HTMLElement>('[data-role="align-count"]');
        const selecting = this.activeTool === "select" && !this.alignMode;
        select?.classList.toggle("is-active", selecting);
        select?.setAttribute("aria-pressed", String(selecting));
        align?.classList.toggle("is-active", this.alignMode);
        align?.setAttribute("aria-pressed", String(this.alignMode));
        if (count) {
            const total = this.selectedIds.length;
            count.hidden = !this.alignMode || total < 2;
            count.textContent = String(total);
        }
    }

    // ---------------------------------------------------------------- 触屏停顿矫正
    private clearTouchHold(): void {
        if (this.touchHoldTimer) {
            window.clearTimeout(this.touchHoldTimer);
            this.touchHoldTimer = 0;
        }
    }

    private resetTouchHold(): void {
        this.clearTouchHold();
        this.touchSnapped = false;
        this.touchSnapAnchor = null;
    }

    /**
     * 手指在画布上停住 300ms 不动 → 把当前草稿按「按住了 Shift」重算一次：
     * 画线 / 箭头吸到水平、垂直或 45°；矩形 / 椭圆 / 聚光灯 / 放大镜锁成 1:1。
     * 继续滑动（超过 10px）立刻解除，回到自由拖动并重新计时。
     */
    private scheduleTouchHold(start: Point): void {
        if (!this.mobile || !this.draft || !TOUCH_SNAP_TYPES.has(this.draft.type)) return;
        this.clearTouchHold();
        this.touchHoldTimer = window.setTimeout(() => {
            this.touchHoldTimer = 0;
            const draft = this.draft;
            const p = this.draftPointer;
            if (!draft || !p || this.finished) return;
            if (!this.isDraftValid(draft)) return;
            this.updateDraft(draft, start, p, true);
            this.touchSnapped = true;
            this.touchSnapAnchor = {...p};
            this.renderCanvas();
        }, TOUCH_HOLD_MS);
    }

    /**
     * 移动端：对象列表（含层级 / 复制 / 删除）做成底部抽屉。
     * 常用参数已经常驻上栏，所以选中对象时不再自动弹出（会挡住半张画布）；
     * 需要调层级或删除时点右上「对象」展开，点空白或换对象自动收起。
     */
    private syncMobileSheets(): void {
        if (!this.mobile || !this.root) return;
        // 抽屉开不开只看「用户想不想看」，跟有没有选中对象完全无关：
        // 没选中、甚至一个对象都没有，也要能滑出来（里面显示空态）。
        if (this.cropMode) this.mobileSheetOpen = false;
        const sheet = this.root.querySelector<HTMLElement>('[data-role="sidebar"]');
        sheet?.classList.toggle("is-open", this.mobileSheetOpen);
        const cropSheet = this.root.querySelector<HTMLElement>('[data-role="crop-side"]');
        cropSheet?.classList.toggle("is-open", this.cropMode);
        const more = this.root.querySelector<HTMLElement>('.annot-fab-pill[data-action="mobile-props"]');
        if (more) more.classList.toggle("is-open", this.mobileSheetOpen);
    }

    /** 顶部「缩放 / 对象」两颗胶囊：缩放显示百分比，对象显示画布上的对象总数 */
    private syncMobileZoom(): void {
        if (!this.mobile) return;
        const label = this.root?.querySelector<HTMLElement>('[data-role="mobile-zoom"]');
        if (label) label.textContent = `${Math.round((this.viewport.zoom || 1) * 100)}%`;
        const count = this.root?.querySelector<HTMLElement>('[data-role="mobile-count"]');
        if (count) count.textContent = String(this.scene.objects.length);
    }

    private fakeObject(draft: Draft): AnnotObject {
        const now = Date.now();
        const geometry = cloneGeometry(draft.geometry);
        if (draft.type === "number") {
            (geometry as NumberGeometry).number =
                this.scene.objects.filter((o) => o.type === "number").length + 1;
        }
        return {
            id: "__draft__",
            type: draft.type,
            geometry,
            style: defaultStyle(draft.type, this.current),
            meta: {label: TYPE_LABELS[draft.type], createdAt: now, updatedAt: now},
        };
    }

    /** 马赛克 / 模糊都要「按框选区域从底图现采一张位图」，统一从这里取 */
    private bitmapFor(object: AnnotObject): string | null {
        if (object.type === "mosaic") {
            return this.mosaic.getDataUrl(object.id, object.geometry as MosaicGeometry);
        }
        if (object.type === "blur") {
            return this.blur.getDataUrl(object.id, object.geometry as BlurGeometry);
        }
        if (object.type === "magnifier") {
            return this.magnifier.getDataUrl(object.id, object.geometry as MagnifierGeometry);
        }
        return null;
    }

    private renderObjects(): void {
        const layer = this.objectLayer;
        if (!layer) return;
        layer.replaceChildren();
        const zoom = this.viewport.zoom || 1;
        for (const object of this.scene.objects) {
            const bitmapUrl = this.bitmapFor(object);
            const group = renderObject(object, {zoom, bitmapUrl});
            if (this.selectedIds.includes(object.id)) group.classList.add("is-selected");
            if (object.id === this.hoveredId) group.classList.add("is-hovered");
            if (object.id === this.editingTextId) group.classList.add("is-editing");
            layer.append(group);
        }
        if (this.draft) {
            const fake = this.fakeObject(this.draft);
            layer.append(renderDraft(fake, {zoom, bitmapUrl: this.bitmapFor(fake)}));
        }
    }

    private renderOverlay(): void {
        const layer = this.overlayLayer;
        if (!layer) return;
        this.overlayZoom = this.viewport.zoom || 1;
        layer.replaceChildren();
        if (this.cropMode) {
            this.renderCropOverlay(layer);
            return;
        }
        // 预识别的虚线框画在最底下，手柄盖在上面
        this.renderSmartRegions(layer);
        // 保持当前工具时，刚画好的对象也要显示手柄，方便接着调整
        if (this.editingTextId) return;
        const boxes = this.selectedIds
            .map((id) => this.getObject(id))
            .filter((object): object is AnnotObject => Boolean(object))
            .map((object) => getBounds(object));
        // 多选：每个对象一圈细虚线 + 整组一个联合包围框，不画单对象手柄（避免误拖）
        if (boxes.length > 1) {
            for (const box of boxes) {
                layer.append(svgEl("rect", {
                    x: box.x, y: box.y, width: box.width, height: box.height,
                    class: "annot-selection-box",
                }));
            }
            const union = boxes.reduce<Bounds>((acc, b) => {
                const right = Math.max(acc.x + acc.width, b.x + b.width);
                const bottom = Math.max(acc.y + acc.height, b.y + b.height);
                const x = Math.min(acc.x, b.x);
                const y = Math.min(acc.y, b.y);
                return {x, y, width: right - x, height: bottom - y};
            }, {...boxes[0]});
            layer.append(svgEl("rect", {
                x: union.x, y: union.y, width: union.width, height: union.height,
                class: "annot-selection-union",
            }));
            return;
        }
        const object = this.getObject(this.selectedId);
        if (!object) return;
        // 手指比鼠标粗：手柄的可见圆点与透明命中圆都放大，稍微点偏也能抓住
        // 触屏的视觉尺寸比电脑小一档（半径 8 ≈ 电脑 9 的 89%，加上角点/按钮各自的系数后
        // 屏幕上分别约 10.7px / 19.5px，比电脑的 12 / 22 更收敛），
        // 但命中半径反而要给足：46px 直径，手指照样一按就中。
        const handleSizes = this.mobile ? {radius: 8, hitRadius: 23} : undefined;
        for (const element of renderHandles(object, this.viewport.zoom || 1, handleSizes)) layer.append(element);
    }

    /**
     * 裁剪画面（对齐参考插件的观感）：
     * 框外压暗、框内保持原亮度；四角是白色圆点、四边中点是白色胶囊，
     * 框上方浮一对 ✓ / ✕ 直接确认或取消。不再画虚线边框与三分线，
     * 因为它们会和遮罩边缘抢视觉，看起来"杂"。
     */
    private renderCropOverlay(layer: SVGGElement): void {
        const rect = this.cropRect;
        if (!rect) return;
        const zoom = this.viewport.zoom || 1;
        const {width: cw, height: ch} = this.scene.canvas;
        const box = this.normalizeCrop(rect);
        const right = box.x + box.width;
        const bottom = box.y + box.height;
        // 参考插件 CropRect.render 里把框外统一压暗 45%，这里保持一致
        const shade = (x: number, y: number, w: number, h: number): void => {
            if (w <= 0 || h <= 0) return;
            layer.append(svgEl("rect", {
                x, y, width: w, height: h, fill: "rgba(0, 0, 0, 0.45)", "pointer-events": "none",
            }));
        };
        shade(0, 0, cw, box.y);
        shade(0, bottom, cw, ch - bottom);
        shade(0, box.y, box.x, box.height);
        shade(right, box.y, cw - right, box.height);

        // 框线上一条极淡的白边：遮罩对比之外再给个轮廓，手柄旁边不至于"虚"
        layer.append(svgEl("rect", {
            x: box.x, y: box.y, width: box.width, height: box.height,
            fill: "none", stroke: "rgba(255, 255, 255, .55)", "stroke-width": 1 / zoom,
            "pointer-events": "none",
        }));

        // 框内透明命中区：按住可以整体挪动（在手柄下面，手柄优先命中）
        layer.append(svgEl("rect", {
            x: box.x, y: box.y, width: box.width, height: box.height,
            fill: "transparent", "pointer-events": "all", "data-crop-box": "1",
            class: "annot-crop-box",
        }));

        const dot = 6 / zoom;
        const bar = 4 / zoom;
        const barLength = 18 / zoom;
        const centers: Record<CropHandle, Point> = {
            nw: {x: box.x, y: box.y},
            n: {x: box.x + box.width / 2, y: box.y},
            ne: {x: right, y: box.y},
            w: {x: box.x, y: box.y + box.height / 2},
            e: {x: right, y: box.y + box.height / 2},
            sw: {x: box.x, y: bottom},
            s: {x: box.x + box.width / 2, y: bottom},
            se: {x: right, y: bottom},
        };
        for (const handle of CROP_HANDLES) {
            const center = centers[handle];
            const common: Record<string, string | number> = {
                fill: "#ffffff",
                stroke: "rgba(0, 0, 0, .26)",
                "stroke-width": 1 / zoom,
                "pointer-events": "all",
                "data-crop-handle": handle,
                "data-crop-cx": center.x,
                "data-crop-cy": center.y,
                style: `filter:drop-shadow(0 1px 2px rgba(32,45,62,.35));cursor:${cropCursor(handle)}`,
            };
            if (handle.length === 2) {
                // 四角：小圆点
                layer.append(svgEl("circle", {...common, cx: center.x, cy: center.y, r: dot}));
            } else {
                // 四边中点：胶囊（竖边是竖条，上下边是横条）
                const vertical = handle === "e" || handle === "w";
                layer.append(svgEl("rect", {
                    ...common,
                    x: center.x - (vertical ? bar / 2 : barLength / 2),
                    y: center.y - (vertical ? barLength / 2 : bar / 2),
                    width: vertical ? bar : barLength,
                    height: vertical ? barLength : bar,
                    rx: bar / 2,
                }));
            }
        }

        // 框上方的确认 / 取消
        const buttons = this.cropButtonPoints(box);
        this.appendCropButton(layer, buttons.apply, buttons.radius, "apply", "#22C55E", CROP_CHECK_PATH, zoom);
        this.appendCropButton(layer, buttons.cancel, buttons.radius, "cancel", "#EF4444", CROP_CROSS_PATH, zoom);
    }

    /** ✓ / ✕ 的圆心：优先放框外上方，顶到画布边就改放框内顶部 */
    private cropButtonPoints(box: Bounds): {apply: Point; cancel: Point; radius: number} {
        const zoom = this.viewport.zoom || 1;
        const radius = 13 / zoom;
        const gap = 34 / zoom;
        const outside = box.y - 32 / zoom;
        const y = outside >= 0 ? outside : box.y + 32 / zoom;
        const centerX = box.x + box.width / 2;
        return {
            apply: {x: centerX - gap / 2, y},
            cancel: {x: centerX + gap / 2, y},
            radius,
        };
    }

    private appendCropButton(
        layer: SVGGElement, center: Point, radius: number,
        action: "apply" | "cancel", color: string, icon: string, zoom: number,
    ): void {
        const group = svgEl("g", {
            "data-crop-action": action, "pointer-events": "all", style: "cursor:pointer",
            "data-crop-cx": center.x, "data-crop-cy": center.y, "data-crop-r": radius,
        });
        group.append(svgEl("circle", {
            cx: center.x, cy: center.y, r: radius, fill: color,
            stroke: "rgba(255, 255, 255, .92)", "stroke-width": 1.6 / zoom,
            style: "filter:drop-shadow(0 2px 5px rgba(15,23,42,.35))",
        }));
        const scale = (radius * 2) / 24;
        group.append(svgEl("path", {
            d: icon,
            fill: "none",
            stroke: "#ffffff",
            "stroke-width": 2.6,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "pointer-events": "none",
            transform: `translate(${center.x - 12 * scale} ${center.y - 12 * scale}) scale(${scale})`,
        }));
        layer.append(group);
    }

    /** 点是否落在 ✓ / ✕ 上 */
    private cropActionAt(p: Point): "apply" | "cancel" | null {
        if (!this.cropRect || !this.cropMode) return null;
        const buttons = this.cropButtonPoints(this.normalizeCrop(this.cropRect));
        const tol = buttons.radius * 1.2;
        if (Math.hypot(p.x - buttons.apply.x, p.y - buttons.apply.y) <= tol) return "apply";
        if (Math.hypot(p.x - buttons.cancel.x, p.y - buttons.cancel.y) <= tol) return "cancel";
        return null;
    }

    private renderToolbar(): void {
        if (!this.root) return;
        for (const button of Array.from(this.root.querySelectorAll<HTMLElement>("button[data-tool]"))) {
            const active = button.getAttribute("data-tool") === this.activeTool;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        }
        for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-action="undo"]'))) {
            button.disabled = !this.history.canUndo;
        }
        for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-action="redo"]'))) {
            button.disabled = !this.history.canRedo;
        }
        const themeSelect = this.root.querySelector<HTMLSelectElement>('[data-role="theme-select"]');
        if (themeSelect) themeSelect.value = this.themePreference;
        // 属性名与工具栏的 data-tool 区分开，避免任何选择器把画布当成工具按钮
        this.svg?.setAttribute("data-active-tool", this.activeTool);
        this.root.classList.toggle("is-cropping", this.cropMode);

        this.updateHint();
    }

    /** 底栏中间的提示语：跟随当前工具；裁切态显示裁切的临时提示 */
    private updateHint(): void {
        if (!this.hint) return;
        if (this.cropMode) {
            this.hint.textContent = this.cropRect
                ? `裁剪：保留 ${Math.max(0, Math.round(this.cropRect.width))} × ${Math.max(0, Math.round(this.cropRect.height))} px · 回车应用 · Delete 清框 · Esc 取消`
                : "裁剪：在图上拖出要保留的区域 · Esc 放弃";
            return;
        }
        const base = TOOL_HINTS[this.activeTool] ?? "";
        if (this.activeTool === "select" && this.selectedId) {
            const count = this.selectedIds.length;
            this.hint.textContent = count > 1
                ? `${base} · 已选中 ${count} 个对象 · Ctrl+Z 可撤销对齐`
                : `${base} · 已选中 1 个对象`;
            return;
        }
        this.hint.textContent = base;
    }

    // ---------------------------------------------------------------- 样式预设
    /**
     * 按当前预设值重建顶栏五组档位。
     * 每一档都带 data-index —— 「自定义预设」模式下点它就知道要改第几个，互不干扰。
     */
    private refreshPresetGroups(): void {
        if (!this.root) return;
        const {colors, lineWidths, fillOpacities, fontSizes, dashGaps} = this.presets;
        const set = (role: string, html: string): void => {
            const host = this.root?.querySelector<HTMLElement>(`[data-role="${role}"]`);
            if (host) host.innerHTML = html;
        };

        // 颜色：小标题「颜色」+ 五颗圆点 + 一颗带十字的自定义圆球
        set("group-colors", `<span class="annot-group__label">颜色</span>` + colors.map((hex, index) => `
                <button type="button" class="annot-swatch2" data-preset="color" data-index="${index}"
                    data-value="${hex}" title="${hex}" aria-label="第 ${index + 1} 个颜色 ${hex}"
                    style="background:${hex}"></button>`).join("") + this.customColorButton());

        // 线宽：小标题「粗细」+ 一条粗细不同的横线 + 数值
        set("group-widths", `<span class="annot-group__label">粗细</span>` + lineWidths.map((width, index) => `
                <button type="button" class="annot-preset-button" data-preset="lineWidth" data-index="${index}"
                    data-value="${width}" title="第 ${index + 1} 档线宽 ${width}px"><span class="annot-line-sample"
                    style="height:${Math.min(6, Math.max(1, width / 2))}px"></span><span>${width}px</span></button>`).join(""));

        // 线型：实线 / 虚线 / 点线 / 中心线（每档各自记间距）
        set("group-lines", `<span class="annot-group__label">线型</span>` + DASH_ITEMS.map((item, index) => `
                <button type="button" class="annot-preset-button" data-preset="lineDash" data-index="${index}"
                    data-value="${item.key}" title="${item.label}（间距 ${dashGaps[item.key]}px）">
                    <span class="annot-line-demo annot-line-demo--${item.key}"></span><span>${item.label}</span></button>`).join(""));

        // 填充：四档不透明度
        set("group-fills", `<span class="annot-group__label">填充</span>` + fillOpacities.map((value, index) => `
                <button type="button" class="annot-preset-button" data-preset="fillOpacity" data-index="${index}"
                    data-value="${value}" title="第 ${index + 1} 档填充 ${Math.round(value * 100)}%">${Math.round(value * 100)}%</button>`).join(""));

        // 字号：四档数值
        set("group-fonts", `<span class="annot-group__label">字号</span>` + fontSizes.map((size, index) => `
                <button type="button" class="annot-preset-button" data-preset="fontSize" data-index="${index}"
                    data-value="${size}" title="第 ${index + 1} 档字号 ${size}px">${size}</button>`).join(""));

        this.renderPresetSlot();
        this.renderPresetState();
        // 小窗开着时档位被重画了：重新贴到新的那颗按钮下面
        if (this.slotEdit) {
            this.positionSlotPop();
            this.markEditingSlot();
        }
    }

    /** 顶栏右侧那一格：平时是齿轮 + 问号，编辑模式下原地换成 取消 / 应用 / 恢复默认 */
    private renderPresetSlot(): void {
        const host = this.root?.querySelector<HTMLElement>('[data-role="preset-slot"]');
        if (!host) return;
        this.root?.classList.toggle("is-preset-edit", Boolean(this.presetEdit));
        const help = `<button type="button" class="annot-icon-button" data-action="help"
            title="快捷键帮助" aria-label="快捷键帮助">${HELP_ICON}</button>`;
        if (this.presetEdit) {
            host.innerHTML =
                `<button type="button" class="annot-btn annot-btn--mini" data-action="preset-cancel"
                    title="取消：把刚才的修改全部还原">取消</button>` +
                `<button type="button" class="annot-btn annot-btn--mini annot-btn--primary" data-action="preset-apply"
                    title="应用：保留当前这套样式并记住">应用</button>` +
                `<button type="button" class="annot-btn annot-btn--mini" data-action="preset-reset"
                    title="恢复默认样式">恢复默认</button>` + help;
            host.classList.add("is-editing");
        } else {
            host.innerHTML = `<button type="button" class="annot-icon-button" data-action="settings"
                title="自定义预设" aria-label="自定义预设">${SETTINGS_ICON}</button>` + help;
            host.classList.remove("is-editing");
        }
    }

    /** 高亮当前生效的预设；属性面板里的自定义值如果没有对应预设，则一个都不高亮 */
    private renderPresetState(): void {
        if (!this.root) return;
        for (const element of Array.from(this.root.querySelectorAll<HTMLElement>("[data-preset]"))) {
            const name = element.dataset.preset;
            const value = element.dataset.value ?? "";
            let active = false;
            if (name === "color") active = value.toUpperCase() === this.current.color.toUpperCase();
            else if (name === "lineWidth") active = Number(value) === this.current.lineWidth;
            else if (name === "fillOpacity") active = Math.abs(Number(value) - this.current.fillOpacity) < 0.001;
            else if (name === "fontSize") active = Number(value) === this.current.fontSize;
            else if (name === "lineDash") active = value === this.current.lineDash;
            else if (name === "cornerRadius") active = Number(value) === normalizeCornerRadius(this.current.cornerRadius);
            else if (name === "fillColor") {
                // 「无填充」是 fillOpacity 为 0 的那个状态；有填充时比较填充色
                active = this.current.fillOpacity <= 0
                    ? value === ""
                    : value !== "" && value.toUpperCase() === this.current.fillColor.toUpperCase();
            }
            element.classList.toggle("is-active", active);
        }
        const custom = this.root.querySelector<HTMLElement>('[data-role="custom-color"]');
        if (custom) {
            if (custom.tagName === "INPUT") {
                (custom as HTMLInputElement).value = this.current.color;
            } else {
                const hex = this.colorState.custom;
                custom.style.setProperty("--annot-ball", hex ?? "#FFFFFF");
                custom.style.setProperty("--annot-ball-ink", hex ? pickBadgeTextColor(hex) : "#1F2937");
                custom.classList.toggle("is-active",
                    Boolean(hex) && hex!.toUpperCase() === this.current.color.toUpperCase());
                custom.setAttribute("aria-expanded", String(this.colorPopOpen));
            }
        }
        this.syncAttrInputs();
    }

    /** 小窗里的滑块 / 数字框：跟着这一档的值走；正在输入的那个不回写 */
    private syncAttrInputs(): void {
        if (!this.root) return;
        const values: Record<string, number> = {
            lineWidth: this.current.lineWidth,
            lineDashGap: this.current.lineDashGap,
            fillOpacity: Math.round(this.current.fillOpacity * 100),
            fontSize: this.current.fontSize,
        };
        for (const [key, value] of Object.entries(values)) {
            const range = this.root.querySelector<HTMLInputElement>(`[data-range="${key}"]`);
            const num = this.root.querySelector<HTMLInputElement>(`[data-number="${key}"]`);
            for (const el of [range, num]) {
                if (!el || el === document.activeElement) continue;
                el.value = String(value);
            }
            if (range) this.paintRangeTrack(range, value);
        }
        // 实线没有「间距」可言：置灰并禁用，避免用户以为调了没反应
        const gapRow = this.root.querySelector<HTMLElement>('[data-range="lineDashGap"]')?.closest(".annot-num-row");
        const solid = this.current.lineDash === "solid";
        if (gapRow && this.slotEdit?.kind === "dash") {
            gapRow.classList.toggle("is-disabled", solid);
            for (const el of Array.from(gapRow.querySelectorAll<HTMLInputElement>("input"))) el.disabled = solid;
        }
        const colorPicker = this.root.querySelector<HTMLInputElement>('[data-role="pop-color-picker"]');
        if (colorPicker && colorPicker !== document.activeElement) colorPicker.value = this.current.color;
        const colorHex = this.root.querySelector<HTMLElement>('[data-role="pop-color-hex"]');
        if (colorHex) colorHex.textContent = this.current.color;
    }

    /** 滑块走一条彩色轨道，位置一眼看得出 */
    private paintRangeTrack(range: HTMLInputElement, value: number): void {
        const min = Number(range.min || 0);
        const max = Number(range.max || 100);
        const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
        range.style.setProperty("--annot-range-ratio", `${(ratio * 100).toFixed(1)}%`);
    }

    // ---------------------------------------------------------------- 预设编辑：点哪一档改哪一档
    /** 「自定义预设」模式下点某一档：在它正下方弹出只改这一档的小窗 */
    private openSlotPop(kind: PresetSlotKind, index: number): void {
        if (!this.presetEdit) return;
        this.slotEdit = {kind, index};
        // 先让这一档成为当前样式：画布上立刻能看出改的是它
        this.selectSlot(kind, index);
        this.renderSlotPop();
        const pop = this.root?.querySelector<HTMLElement>('[data-role="attr-pop"]');
        if (!pop) return;
        pop.hidden = false;
        this.positionSlotPop();
        this.markEditingSlot();
        this.syncAttrInputs();
    }

    /** 把某一档的值套到当前样式（顺带画到选中的对象上） */
    private selectSlot(kind: PresetSlotKind, index: number): void {
        const presets = this.presets;
        if (kind === "color") {
            const hex = presets.colors[index];
            if (hex) this.applyPreset("color", hex, false);
        } else if (kind === "width") {
            const width = presets.lineWidths[index];
            if (Number.isFinite(width)) this.applyPreset("lineWidth", String(width), false);
        } else if (kind === "dash") {
            const item = DASH_ITEMS[index];
            if (item) {
                this.applyPreset("lineDash", item.key, false);
                this.applyPreset("lineDashGap", String(presets.dashGaps[item.key]), false);
            }
        } else if (kind === "fill") {
            const value = presets.fillOpacities[index];
            if (Number.isFinite(value)) this.applyPreset("fillOpacity", String(value), false);
        } else {
            const size = presets.fontSizes[index];
            if (Number.isFinite(size)) this.applyPreset("fontSize", String(size), false);
        }
    }

    /** 小窗内容：只针对「这一档」，所以标题里写明是第几个 */
    private renderSlotPop(): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="attr-pop"]');
        const slot = this.slotEdit;
        if (!pop || !slot) return;
        const {kind, index} = slot;
        const panel = (title: string, body: string): string => `
            <div class="annot-attr-panel" data-panel="${kind}">
                <div class="annot-attr-panel__head">${title}</div>${body}
            </div>`;
        const numRow = (label: string, key: string, min: number, max: number, unit: string, hint: string): string => `
            <div class="annot-num-row">
                ${label ? `<span class="annot-num-row__label">${label}</span>` : ""}
                <input type="range" data-range="${key}" min="${min}" max="${max}" step="1" aria-label="${hint}">
                <input type="number" class="annot-num-row__input" data-number="${key}"
                    min="${min}" max="${max}" step="1" aria-label="${hint}数值">
                <span class="annot-num-row__unit">${unit}</span>
            </div>`;

        if (kind === "color") {
            const hex = this.presets.colors[index] ?? this.current.color;
            pop.innerHTML = panel(`第 ${index + 1} 个颜色`, `<div data-role="slot-wheel"></div>`);
            this.mountSlotWheel(hex, index);
        } else if (kind === "width") {
            pop.innerHTML = panel(`第 ${index + 1} 个线条粗细`,
                numRow("", "lineWidth", 1, 40, "px", "线条粗细"));
        } else if (kind === "dash") {
            const item = DASH_ITEMS[index] ?? DASH_ITEMS[0];
            pop.innerHTML = panel(`${item.label}的间距`,
                numRow("间距", "lineDashGap", 1, 20, "px", `${item.label}间距`));
        } else if (kind === "fill") {
            // 只改这一档的不透明度；填充颜色不在这里动
            pop.innerHTML = panel(`第 ${index + 1} 档填充`,
                numRow("不透明度", "fillOpacity", 0, 100, "%", "填充不透明度"));
        } else {
            pop.innerHTML = panel(`第 ${index + 1} 档字号`,
                numRow("", "fontSize", 8, 120, "px", "字号"));
        }
    }

    /** 颜色档位的小窗里放一颗色轮：拖动时只改这一档，松手才落盘 */
    private mountSlotWheel(hex: string, index: number): void {
        const host = this.root?.querySelector<HTMLElement>('[data-role="slot-wheel"]');
        if (!host) return;
        this.slotWheel?.destroy();
        this.slotWheel = new ColorWheel({
            size: 216,
            onPreview: (value) => this.setSlotColor(index, value, false, false),
            onCommit: (value) => this.setSlotColor(index, value, true),
        });
        host.append(this.slotWheel.el);
        this.slotWheel.setColor(hex);
        nextFrame(() => this.slotWheel?.relayout());
    }

    /** 小窗里的色板：点哪个都只是把「这一档」换成那个颜色 */
    private presetColorButtons(): string {
        return this.presets.colors.map((hex, index) => `
            <button type="button" class="annot-swatch2" data-action="slot-color" data-index="${index}"
                data-value="${hex}" title="${hex}" aria-label="用 ${hex}"
                style="background:${hex}"></button>`).join("");
    }

    /** 把这一档换成新颜色（只动它，别的圆点不变） */
    private setSlotColor(index: number, raw: string, relabel = true, persist = true): void {
        const hex = normalizeHex(raw);
        if (!hex || index < 0 || index >= this.presets.colors.length) return;
        this.presets.colors[index] = hex;
        if (persist) savePresets(this.presets);
        this.applyPreset("color", hex, false);
        if (relabel) this.refreshPresetGroups();
        this.syncAttrInputs();
    }

    /** 滑块 / 数字框改的是「正在编辑的这一档」，不是全局样式 */
    private applySlotValue(key: string, raw: number, commit: boolean): void {
        const slot = this.slotEdit;
        if (!slot || !Number.isFinite(raw)) return;
        const clampValue = (min: number, max: number): number => Math.max(min, Math.min(max, Math.round(raw)));
        if (slot.kind === "width" && key === "lineWidth") {
            const value = clampValue(1, 40);
            this.presets.lineWidths[slot.index] = value;
            this.applyPreset("lineWidth", String(value), commit);
        } else if (slot.kind === "fill" && key === "fillOpacity") {
            const percent = clampValue(0, 100);
            this.presets.fillOpacities[slot.index] = percent / 100;
            this.applyPreset("fillOpacity", String(percent / 100), commit);
        } else if (slot.kind === "font" && key === "fontSize") {
            const value = clampValue(8, 120);
            this.presets.fontSizes[slot.index] = value;
            this.applyPreset("fontSize", String(value), commit);
        } else if (slot.kind === "dash" && key === "lineDashGap") {
            const item = DASH_ITEMS[slot.index] ?? DASH_ITEMS[0];
            const value = clampValue(1, 20);
            this.presets.dashGaps[item.key] = value;
            this.applyPreset("lineDashGap", String(value), commit);
        } else {
            return;
        }
        savePresets(this.presets);
        // 松手才重画档位（拖动中重画会把锚点按钮换掉，反而闪）
        if (commit) this.refreshPresetGroups();
    }

    /**
     * 小窗贴在「那一档按钮」正下方，并**始终完整落在插件容器内**。
     * 定位是相对插件根节点（`.annot-root{position:relative}`）的 absolute，
     * 所以插件是窗口里的一个悬浮窗时，小窗也只会在这个窗口里挪，不会跑到思源界面上去。
     */
    private positionSlotPop(): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="attr-pop"]');
        const slot = this.slotEdit;
        if (!pop || !slot || !this.root) return;
        const button = this.slotAnchor(slot.kind, slot.index);
        if (!button) return;
        const rootBox = this.root.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        pop.style.visibility = "hidden";
        pop.hidden = false;
        const width = pop.offsetWidth;
        const height = pop.offsetHeight;
        const margin = 8;
        const maxLeft = Math.max(margin, this.root.clientWidth - width - margin);
        const maxTop = Math.max(margin, this.root.clientHeight - height - margin);

        // 水平：以按钮中心对齐，再夹进容器
        const anchorCenter = rect.left - rootBox.left + rect.width / 2;
        const left = Math.max(margin, Math.min(anchorCenter - width / 2, maxLeft));
        // 垂直：优先在按钮下方，下方放不下就翻到上方，两边都不够就贴住容器
        let top = rect.bottom - rootBox.top + 6;
        if (top > maxTop) {
            const above = rect.top - rootBox.top - height - 6;
            top = above >= margin ? above : maxTop;
        }
        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(Math.max(margin, Math.min(top, maxTop)))}px`;
        pop.style.visibility = "";
    }

    /** 某一档对应的按钮（小窗的定位锚点与高亮都靠它） */
    private slotAnchor(kind: PresetSlotKind, index: number): HTMLElement | null {
        const roles: Record<PresetSlotKind, string> = {
            color: "group-colors",
            width: "group-widths",
            dash: "group-lines",
            fill: "group-fills",
            font: "group-fonts",
        };
        const host = this.root?.querySelector<HTMLElement>(`[data-role="${roles[kind]}"]`);
        return host?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null;
    }

    /** 正在编辑的那一档加个圈，一眼看出小窗改的是它 */
    private markEditingSlot(): void {
        if (!this.root) return;
        for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".is-editing-slot"))) {
            el.classList.remove("is-editing-slot");
            el.removeAttribute("aria-expanded");
        }
        const slot = this.slotEdit;
        if (!slot) return;
        const anchor = this.slotAnchor(slot.kind, slot.index);
        anchor?.classList.add("is-editing-slot");
        anchor?.setAttribute("aria-expanded", "true");
    }

    private closeSlotPop(): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="attr-pop"]');
        if (pop) {
            pop.hidden = true;
            pop.innerHTML = "";
        }
        this.slotWheel?.destroy();
        this.slotWheel = null;
        this.slotEdit = null;
        this.markEditingSlot();
    }

    /** 滑块 / 数字框改值：两个控件互相同步，画布实时跟着变 */
    private applyAttrValue(key: string, raw: number, commit: boolean): void {
        if (!Number.isFinite(raw)) return;
        if (key === "fillOpacity") {
            this.applyPreset("fillOpacity", String(Math.max(0, Math.min(100, Math.round(raw))) / 100), commit);
            return;
        }
        const limits: Record<string, [number, number]> = {
            lineWidth: [1, 40],
            lineDashGap: [1, 20],
            fontSize: [8, 120],
        };
        const [min, max] = limits[key] ?? [0, 100];
        this.applyPreset(key, String(Math.max(min, Math.min(max, Math.round(raw)))), commit);
    }

    // ---------------------------------------------------------------- 自定义颜色（PC）
    /**
     * 顶部属性栏里的自定义颜色按钮：一颗圆球，球心固定一个十字。
     * 与左边那排固定色点的区别就是「永远有十字」，所以取过色也认得出这是自定义。
     */
    private customColorButton(): string {
        const hex = this.colorState.custom;
        const ink = hex ? pickBadgeTextColor(hex) : "#1F2937";
        return `<button type="button" class="annot-custom-color" data-role="custom-color"
            data-action="color-pop-toggle" aria-haspopup="dialog" aria-expanded="${this.colorPopOpen}"
            style="--annot-ball:${hex ?? "#FFFFFF"};--annot-ball-ink:${ink}"
            title="自定义颜色：点开取色，或把常用色存成预设" aria-label="自定义颜色">
            <span class="annot-custom-color__cross" aria-hidden="true"></span></button>`;
    }

    /** 展开 / 收起取色弹窗（顶部那颗十字圆球） */
    private toggleColorPop(force?: boolean): void {
        const open = force ?? !this.colorPopOpen;
        if (!open) {
            this.closeColorPop();
            return;
        }
        const ball = this.root?.querySelector<HTMLElement>('[data-role="custom-color"]');
        if (!ball) return;
        const hex = this.colorState.custom ?? normalizeColorHex(this.current.color) ?? "#FFFFFF";
        this.openColorPop(ball, {kind: "current"}, hex);
    }

    private closeColorPop(): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="color-pop"]');
        this.colorPopOpen = false;
        this.colorPopTarget = null;
        this.colorPopAnchor = null;
        this.colorDragIndex = null;
        this.colorDragStart = null;
        this.colorDragMoved = false;
        if (pop) {
            pop.hidden = true;
            pop.innerHTML = "";
        }
        this.colorWheel?.destroy();
        this.colorWheel = null;
        this.root?.querySelector<HTMLElement>('[data-role="custom-color"]')
            ?.setAttribute("aria-expanded", "false");
    }

    /**
     * 打开色轮弹窗。
     * anchor 是点开它的那颗按钮（弹窗贴着它展开），target 决定颜色最终落到哪里。
     */
    private openColorPop(anchor: HTMLElement, target: Exclude<ColorPopTarget, null>, initial: string): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="color-pop"]');
        if (!pop) return;
        this.colorPopTarget = target;
        this.colorPopAnchor = anchor;
        this.colorPopOpen = true;
        this.colorDragIndex = null;
        this.colorDragStart = null;
        this.colorDragMoved = false;

        pop.innerHTML = this.colorPopMarkup(target);
        pop.hidden = false;

        this.colorWheel?.destroy();
        this.colorWheel = new ColorWheel({
            size: 236,
            onPreview: (hex) => this.applyWheelColor(hex, false),
            onCommit: (hex) => this.applyWheelColor(hex, true),
        });
        pop.querySelector<HTMLElement>('[data-role="color-wheel"]')?.append(this.colorWheel.el);
        this.colorWheel.setColor(initial);
        this.renderColorPresets();
        this.positionColorPop();
        nextFrame(() => this.colorWheel?.relayout());
        anchor.setAttribute("aria-expanded", "true");
    }

    /** 弹窗骨架：色轮 + （改当前颜色时）保存按钮与颜色预设 */
    private colorPopMarkup(target: Exclude<ColorPopTarget, null>): string {
        const title = target.kind === "prop"
            ? (target.prop === "textStrokeColor" ? "文字描边颜色" : "对象颜色")
            : target.kind === "extend-bg" ? "画布底色" : "自定义颜色";
        const withSaved = target.kind === "current";
        return `
            <div class="annot-color-pop__head"><span>${title}</span>
                <button type="button" class="annot-icon-btn" data-action="color-pop-close"
                    aria-label="关闭取色弹窗">✕</button>
            </div>
            <div class="annot-color-pop__wheel" data-role="color-wheel"></div>
            ${withSaved ? `
            <div class="annot-color-pop__foot">
                <button type="button" class="annot-btn annot-color-pop__save" data-action="color-save"
                    title="把这个颜色存进下面的预设">保存到预设</button>
                <span class="annot-color-pop__hint" data-role="color-pop-hint"></span>
            </div>
            <div class="annot-color-pop__sub">颜色预设</div>
            <div class="annot-color-pop__presets" data-role="color-presets"></div>` : ""}`;
    }

    /** 色轮改了颜色：按当前目标写回去；commit=true 时记一次撤销 */
    private applyWheelColor(hex: string, commit: boolean): void {
        const target = this.colorPopTarget;
        if (!target) return;
        if (target.kind === "current") {
            this.applyPreset("color", hex, commit);
            this.colorState = setCustomColor(this.colorState, hex);
            if (commit) saveColorPresets(this.colorState);
            this.paintCustomBall(hex);
            this.syncColorPresetActive();
        } else if (target.kind === "prop") {
            this.applyProperty({[target.prop]: hex} as PropertyPatch, commit);
        } else {
            this.extendState.custom1 = hex;
            this.extendState.slot = "custom1";
            if (commit) saveExtendState(this.extendState);
            this.syncExtendPanel();
        }
    }

    /** 点「颜色预设」里的一颗：应用它并记成当前自定义色 */
    private applyCustomColor(value: string): void {
        const hex = normalizeColorHex(value);
        if (!hex) return;
        this.colorState = setCustomColor(this.colorState, hex);
        saveColorPresets(this.colorState);
        this.applyPreset("color", hex);
        this.paintCustomBall(hex);
        this.colorWheel?.setColor(hex);
        this.syncColorPresetActive();
    }

    /** 圆球表面跟着当前颜色走（不重画整排预设，拖动时更稳） */
    private paintCustomBall(hex: string | null): void {
        const ball = this.root?.querySelector<HTMLElement>('[data-role="custom-color"]');
        if (!ball) return;
        ball.style.setProperty("--annot-ball", hex ?? "#FFFFFF");
        ball.style.setProperty("--annot-ball-ink", hex ? pickBadgeTextColor(hex) : "#1F2937");
    }

    /** 只重画「颜色预设」这一块，色轮本身不动 */
    private renderColorPresets(): void {
        const host = this.root?.querySelector<HTMLElement>('[data-role="color-presets"]');
        if (!host) return;
        const hex = this.colorState.custom ?? normalizeColorHex(this.current.color) ?? "#FFFFFF";
        const full = this.colorState.saved.length >= MAX_SAVED_COLORS;
        host.innerHTML = this.colorState.saved.length
            ? this.colorState.saved.map((item, index) => `
                <div class="annot-color-preset${item === hex ? " is-active" : ""}" data-role="color-preset"
                    data-index="${index}" data-value="${item}" title="${item}">
                    <button type="button" class="annot-color-preset__swatch" data-action="color-preset-apply"
                        data-value="${item}" style="background:${item}" aria-label="使用颜色 ${item}"></button>
                    <button type="button" class="annot-color-preset__remove" data-action="color-preset-remove"
                        data-value="${item}" title="删除这个预设" aria-label="删除预设 ${item}">✕</button>
                </div>`).join("")
            : `<span class="annot-color-pop__empty">还没有预设：调好颜色后点「保存到预设」</span>`;
        const save = this.root?.querySelector<HTMLButtonElement>('[data-role="color-pop"] [data-action="color-save"]');
        if (save) {
            save.disabled = full;
            save.textContent = full ? "预设已满" : "保存到预设";
        }
        const hint = this.root?.querySelector<HTMLElement>('[data-role="color-pop-hint"]');
        if (hint) {
            hint.textContent = full ? `最多 ${MAX_SAVED_COLORS} 个` : "拖动可排序，点 ✕ 删除";
        }
    }

    /** 预设里当前颜色那一颗高亮 */
    private syncColorPresetActive(): void {
        const hex = (this.colorState.custom ?? normalizeColorHex(this.current.color) ?? "").toUpperCase();
        for (const chip of Array.from(this.root?.querySelectorAll<HTMLElement>('[data-role="color-preset"]') ?? [])) {
            chip.classList.toggle("is-active", (chip.dataset.value || "").toUpperCase() === hex);
        }
    }

    /** 弹窗贴着锚点按钮展开，并保证整个落在插件矩形内 */
    private positionColorPop(): void {
        const pop = this.root?.querySelector<HTMLElement>('[data-role="color-pop"]');
        const anchor = this.colorPopAnchor;
        if (!pop || !anchor || !this.root) return;
        const rootBox = this.root.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        pop.style.visibility = "hidden";
        pop.hidden = false;
        const width = pop.offsetWidth;
        const height = pop.offsetHeight;
        const margin = 8;
        const maxLeft = Math.max(margin, this.root.clientWidth - width - margin);
        const maxTop = Math.max(margin, this.root.clientHeight - height - margin);
        const center = rect.left - rootBox.left + rect.width / 2;
        const left = Math.max(margin, Math.min(center - width / 2, maxLeft));
        let top = rect.bottom - rootBox.top + 8;
        if (top > maxTop) {
            const above = rect.top - rootBox.top - height - 8;
            top = above >= margin ? above : maxTop;
        }
        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(Math.max(margin, Math.min(top, maxTop)))}px`;
        pop.style.visibility = "";
    }

    /** 把当前自定义色存进预设 */
    private saveCurrentColorPreset(): void {
        const hex = this.colorState.custom ?? normalizeColorHex(this.current.color);
        if (!hex) return;
        const before = this.colorState.saved.length;
        this.colorState = addSavedColor(this.colorState, hex);
        saveColorPresets(this.colorState);
        this.renderColorPresets();
        this.setStatus(this.colorState.saved.length > before
            ? `已保存颜色 ${hex} 到预设`
            : `颜色 ${hex} 已经在预设里了`);
    }

    private removeColorPreset(value: string): void {
        this.colorState = removeSavedColor(this.colorState, value);
        saveColorPresets(this.colorState);
        this.renderColorPresets();
    }

    /** 拖动时指针落在第几个色点上（落在空白处按最近的中心算） */
    private colorPresetIndexAt(x: number, y: number): number | null {
        const host = this.root?.querySelector<HTMLElement>('[data-role="color-presets"]');
        if (!host) return null;
        const chips = Array.from(host.querySelectorAll<HTMLElement>('[data-role="color-preset"]'));
        for (let index = 0; index < chips.length; index += 1) {
            const rect = chips[index].getBoundingClientRect();
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return index;
        }
        let best: number | null = null;
        let bestDistance = Infinity;
        chips.forEach((chip, index) => {
            const rect = chip.getBoundingClientRect();
            const distance = Math.abs(x - (rect.left + rect.right) / 2);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        });
        return best;
    }

    /** 点预设：既改变后续绘制的默认值，也应用到当前选中的对象 */
    private applyPreset(name: string, raw: string, commit = true): void {
        const number = Number(raw);
        switch (name) {
            case "color": this.current.color = raw; break;
            case "lineWidth": this.current.lineWidth = number; break;
            case "fillOpacity":
                this.current.fillOpacity = number;
                // 填充色不再单独设置：默认跟描边色一致，避免「蓝边红底」这种违和组合
                this.current.fillColor = this.current.color;
                break;
            case "fillColor": {
                const hex = raw.trim();
                if (!hex) {
                    // 「无填充」：只把不透明度归零，填充色留着，下次再点色块能接着用
                    this.current.fillOpacity = 0;
                    break;
                }
                const normalized = normalizeHex(hex);
                if (!normalized) return;
                this.current.fillColor = normalized;
                // 选了颜色却还是 0% 的话，圈选出来的形状会"什么都没发生"
                if (this.current.fillOpacity <= 0) this.current.fillOpacity = 0.5;
                break;
            }
            case "fontSize": this.current.fontSize = number; break;
            case "cornerRadius": this.current.cornerRadius = normalizeCornerRadius(number); break;
            case "lineDashGap": this.current.lineDashGap = Math.max(1, Math.min(20, Math.round(number))); break;
            case "lineDash":
                if (raw !== "solid" && raw !== "dashed" && raw !== "dotted" && raw !== "dashdot") return;
                this.current.lineDash = raw;
                // 每种线型各自记间距：切过去就换成它自己那一份
                this.current.lineDashGap = this.presets.dashGaps[raw] ?? this.current.lineDashGap;
                break;
            default: return;
        }
        const object = this.getObject(this.selectedId);
        if (object) {
            switch (name) {
                case "color": object.style.color = this.current.color; break;
                case "lineWidth": object.style.lineWidth = this.current.lineWidth; break;
                case "fillOpacity":
                    object.style.fillOpacity = this.current.fillOpacity;
                    object.style.fillColor = this.current.fillColor;
                    object.style.fillMode = this.current.fillOpacity > 0 ? "translucent" : "none";
                    break;
                case "fillColor":
                    object.style.fillColor = this.current.fillColor;
                    object.style.fillOpacity = this.current.fillOpacity;
                    object.style.fillMode = this.current.fillOpacity > 0 ? "translucent" : "none";
                    break;
                case "fontSize": this.applyFontSize(object, this.current.fontSize); break;
                case "cornerRadius":
                    if (object.type === "rect") object.style.cornerRadius = this.current.cornerRadius;
                    break;
                case "lineDash":
                    object.style.lineDash = this.current.lineDash;
                    object.style.lineDashGap = this.current.lineDashGap;
                    break;
                case "lineDashGap": object.style.lineDashGap = this.current.lineDashGap; break;
            }
            object.meta.updatedAt = Date.now();
            // 拖滑块时每一帧都记一次历史会把撤销栈撑爆：拖动中先不提交，松手再记一次
            if (commit) this.commit();
        }
        saveCurrentStyle(this.current);
        this.render();
    }

    /** 字号同时作用于文字与序号圆点 */
    private applyFontSize(object: AnnotObject, size: number): void {
        object.style.fontSize = size;
        if (object.type === "text") (object.geometry as TextGeometry).fontSize = size;
        if (object.type === "number") {
            (object.geometry as NumberGeometry).radius = Math.max(12, size * 0.65);
        }
    }

    // ---------------------------------------------------------------- 属性输入联动
    /** 悬浮条里的滑块 / 数字框：data-range / data-number 的值就是 CurrentStyle 的字段名 */
    private onPresetInput(target: EventTarget | null, final: boolean): void {
        const element = target as HTMLInputElement | null;
        if (!element || typeof element.getAttribute !== "function") return;
        const named = element.getAttribute("data-range") || element.getAttribute("data-number");
        if (!named || !["lineWidth", "lineDashGap", "fillOpacity", "fontSize"].includes(named)) return;
        this.syncAttrPair(named, element);
        // 小窗开着：改的是「正在编辑的那一档」，不是全局默认值
        if (this.slotEdit) this.applySlotValue(named, Number(element.value), final);
        else this.applyAttrValue(named, Number(element.value), final);
    }

    /** 滑块 ↔ 数字框：只回写另一个控件，正在编辑的那个保持原样 */
    private syncAttrPair(key: string, source: HTMLInputElement): void {
        const range = this.root?.querySelector<HTMLInputElement>(`[data-range="${key}"]`);
        const num = this.root?.querySelector<HTMLInputElement>(`[data-number="${key}"]`);
        const other = source === range ? num : range;
        const raw = Number(source.value);
        if (!other || !Number.isFinite(raw)) return;
        other.value = String(raw);
        if (range) this.paintRangeTrack(range, Number(range.value));
    }

    // ---------------------------------------------------------------- 自定义预设（三段式）
    /**
     * 点齿轮进入「调样式」状态：原地换成 取消 / 应用 / 恢复默认。
     * 进来先拍一张快照（当前样式 + 选中对象的样式与几何），取消时原样还回去。
     */
    private enterPresetEdit(): void {
        if (this.presetEdit) return;
        const object = this.getObject(this.selectedId);
        this.presetEdit = {
            style: {...this.current},
            presets: clonePresets(this.presets),
            objectId: object?.id ?? null,
            objectStyle: object ? {...object.style} : null,
            objectGeometry: object ? cloneGeometry(object.geometry) : null,
        };
        this.closeSlotPop();
        this.renderPresetSlot();
        this.setStatus("自定义预设：调整后点「应用」保留，点「取消」全部还原");
    }

    /** 三个按钮任意一个都会结束这个状态 */
    private finishPresetEdit(mode: "apply" | "cancel" | "reset"): void {
        const snapshot = this.presetEdit;
        if (!snapshot) return;
        const object = snapshot.objectId ? this.getObject(snapshot.objectId) : undefined;
        if (mode === "cancel") {
            // 档位本身也要还回去：这一轮改过第几个圆点 / 第几档粗细都按快照复原
            this.presets = clonePresets(snapshot.presets);
            savePresets(this.presets);
            this.current = {...snapshot.style};
            if (object && snapshot.objectStyle) {
                object.style = {...snapshot.objectStyle};
                if (snapshot.objectGeometry) {
                    object.geometry = cloneGeometry(snapshot.objectGeometry);
                }
                object.meta.updatedAt = Date.now();
                this.commit();
            }
            saveCurrentStyle(this.current);
        } else if (mode === "reset") {
            // 五组档位回到出厂值（色点 / 四档粗细 / 四档填充 / 四档字号 / 线型间距）
            this.presets = clonePresets(DEFAULT_PRESETS);
            savePresets(this.presets);
            // 顶栏这七项也恢复默认；箭头 / 圆角 / 聚光灯那些各自记住的设置不动
            const keys = ["color", "lineWidth", "fillOpacity", "fillColor",
                "fontSize", "lineDash", "lineDashGap"] as const;
            for (const key of keys) {
                this.applyPreset(key, String(DEFAULT_CURRENT[key]), false);
            }
            if (object) this.commit();
            saveCurrentStyle(this.current);
        } else {
            saveCurrentStyle(this.current);
        }
        this.presetEdit = null;
        // 退出编辑模式时把小窗一起收掉，顶栏回到原来的样子
        this.closeSlotPop();
        this.renderPresetSlot();
        this.refreshPresetGroups();
        this.render();
        this.setStatus(mode === "cancel" ? "已取消，刚才的修改都还原了"
            : mode === "reset" ? "已恢复默认样式" : "已应用并记住这套样式");
    }

    // ---------------------------------------------------------------- 全屏（PC）
    /**
     * 全屏：把 Dialog 的几层外壳按 100vw / 100dvh 撑开，
     * 编辑器内部（画布 + 顶部属性栏 + 工具条 + 侧边栏）本来就是 flex 铺满，
     * 所以外壳一放大，整套界面就跟着铺满思源窗口。再点一次把内联样式原样还回去。
     */
    private toggleFullscreen(force?: boolean): void {
        // 手机端本来就是整屏，不参与这个开关
        if (this.mobile) return;
        const on = force ?? !this.fullscreen;
        if (on === this.fullscreen) return;
        const element = this.dialog?.element;
        if (!element) return;
        this.fullscreen = on;
        if (on) {
            this.applyFullscreenStyles(element);
            this.enterNativeFullscreen();
        } else {
            this.restoreFullscreenStyles();
            this.leaveNativeFullscreen();
        }
        // 全屏期间给 <html> 打个标记：顺手把思源自己的窗口按钮 / 滚动条彻底压掉，
        // 退出全屏时一行 classList.remove 就全部还原，不留任何后遗症
        document.documentElement.classList.toggle("annot-fs", on);
        this.root?.classList.toggle("is-fullscreen", on);
        const button = this.root?.querySelector<HTMLElement>('[data-action="fullscreen"]');
        if (button) {
            button.innerHTML = on ? RESTORE_ICON : FULLSCREEN_ICON;
            button.setAttribute("title", on
                ? "窗口化还原：回到原来的弹窗大小"
                : "全屏：把编辑器铺满整个屏幕");
            button.setAttribute("aria-label", on ? "窗口化还原" : "全屏");
            button.setAttribute("aria-pressed", String(on));
            button.classList.toggle("is-active", on);
        }
        this.scheduleFullscreenRefit();
    }

    /**
     * 让思源窗口本身进入系统全屏 —— 这是彻底解决「右上角三个原生按钮压着插件」的唯一办法。
     *
     * 原理：思源桌面端（Windows / Linux）创建窗口时用了
     * frame:false + titleBarStyle:'hidden' + titleBarOverlay，
     * 最小化 / 最大化 / 关闭 是 Chromium 画的浮层按钮，不在 DOM 里，
     * 位置固定贴在窗口右上角，点击由浏览器进程直接接收。
     * 窗口一旦进入系统全屏，Chromium 会把整块浮层撤掉（思源自己也用
     * body--fullscreen 这个类做的同一个判断），于是那三个按钮连影子都不剩。
     *
     * 如果用户本来就按过 F11（body--fullscreen），原生按钮已经没了，就不动窗口状态。
     */
    private enterNativeFullscreen(): void {
        if (typeof document === "undefined") return;
        if (document.body?.classList.contains("body--fullscreen")) return;
        const doc = document.documentElement as HTMLElement & {
            requestFullscreen?: (options?: {navigationUI?: string}) => Promise<void>;
        };
        if (typeof doc.requestFullscreen !== "function") return;
        this.nativeFullscreen = true;
        try {
            const result = doc.requestFullscreen({navigationUI: "hide"});
            if (result && typeof result.then === "function") {
                result.then(() => {
                    // 反手点击：请求刚落定、用户已经点了还原 —— 立刻退出去，别把思源留在全屏
                    if (!this.fullscreen) this.leaveNativeFullscreen(true);
                }).catch(() => {
                    // 没有用户手势 / 宿主禁止全屏时安静退回「纯 CSS 铺满」，不打断画图
                    this.nativeFullscreen = false;
                });
            }
        } catch {
            this.nativeFullscreen = false;
        }
    }

    /** 退出系统全屏：只还原我们自己切进去的那一次，用户原本的全屏状态不碰 */
    private leaveNativeFullscreen(force = false): void {
        const requested = this.nativeFullscreen;
        this.nativeFullscreen = false;
        if (!requested && !force) return;
        if (typeof document === "undefined") return;
        try {
            if (!document.fullscreenElement) return;
            if (typeof document.exitFullscreen !== "function") return;
            const result = document.exitFullscreen();
            if (result && typeof result.catch === "function") result.catch(() => {});
        } catch {
            // 已经退出或宿主不支持：忽略即可，界面本身照常还原
        }
    }

    /** 用户按 Esc / 系统强制退出全屏时，把插件界面同步还原，避免残留一层 100vw 遮罩 */
    private readonly handleFullscreenChange = (): void => {
        if (!this.fullscreen) return;
        if (document.fullscreenElement) return;
        this.toggleFullscreen(false);
    };

    /** 逐层写内联 important：不同思源版本里外壳可能是 .b3-dialog 也可能是 .b3-dialog__container */
    private applyFullscreenStyles(element: HTMLElement): void {
        const shell = element.classList.contains("b3-dialog")
            ? element
            : element.closest<HTMLElement>(".b3-dialog") ?? element;
        const container = element.classList.contains("b3-dialog__container")
            ? element
            : element.querySelector<HTMLElement>(".b3-dialog__container") ?? element;
        const body = element.querySelector<HTMLElement>(".b3-dialog__body") ?? container;
        this.fullscreenBackup = [shell, container, body].map((el) => ({
            el, style: el.getAttribute("style"),
        }));
        const dvhOk = typeof CSS !== "undefined" && typeof CSS.supports === "function"
            && CSS.supports("height", "100dvh");
        // 层级：直接用 CSS 里 z-index 能表达的最大值（int32 上限），
        // 思源自己的标题栏 / 状态栏 / 菜单位于这个层级之下时，全屏这一层就是绝对阻挡。
        // 注意：Windows 上右上角那三个原生按钮不在 DOM 里，光靠 z-index 盖不住，
        // 必须配合 enterNativeFullscreen() 让窗口进系统全屏（两者一起才是完整修复）。
        const TOP_Z = "2147483647";
        shell.style.setProperty("position", "fixed", "important");
        shell.style.setProperty("top", "0", "important");
        shell.style.setProperty("left", "0", "important");
        shell.style.setProperty("right", "0", "important");
        shell.style.setProperty("bottom", "0", "important");
        shell.style.setProperty("z-index", TOP_Z, "important");
        shell.style.setProperty("isolation", "isolate", "important");
        shell.style.setProperty("pointer-events", "auto", "important");
        shell.style.setProperty("background", "transparent", "important");
        container.style.setProperty("z-index", TOP_Z, "important");
        body.style.setProperty("z-index", "1", "important");
        const layers = [shell, container, body];
        for (const el of layers) {
            el.style.setProperty("width", "100vw", "important");
            el.style.setProperty("height", dvhOk ? "100dvh" : "100vh", "important");
            el.style.setProperty("min-width", "0", "important");
            el.style.setProperty("min-height", "0", "important");
            el.style.setProperty("max-width", "none", "important");
            el.style.setProperty("max-height", "none", "important");
            el.style.setProperty("inset", "0", "important");
            el.style.setProperty("margin", "0", "important");
            el.style.setProperty("padding", "0", "important");
            el.style.setProperty("border", "0", "important");
            el.style.setProperty("border-radius", "0", "important");
            el.style.setProperty("box-shadow", "none", "important");
            el.style.setProperty("overflow", "hidden", "important");
            el.style.setProperty("transform", "none", "important");
        }
        container.style.setProperty("position", "relative", "important");
        body.style.setProperty("position", "relative", "important");
    }

    /** 还原：把切换前的 style 属性一字不差地写回去，不残留任何 important 覆盖 */
    private restoreFullscreenStyles(): void {
        for (const {el, style} of this.fullscreenBackup) {
            if (style === null) el.removeAttribute("style");
            else el.setAttribute("style", style);
        }
        this.fullscreenBackup = [];
    }

    /**
     * 尺寸变了之后重新适应窗口。
     * 对话框的宽高是我们用内联 important 改的，ResizeObserver 不一定马上报，
     * 所以自己补几次（fitView 是幂等的，多算几次没有副作用）。
     */
    private scheduleFullscreenRefit(): void {
        for (const id of this.fullscreenTimers) window.clearTimeout(id);
        this.fullscreenTimers = [];
        const refit = (): void => {
            if (this.finished) return;
            this.fitView();
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(refit);
        else window.setTimeout(refit, 16);
        this.fullscreenTimers.push(window.setTimeout(refit, 120));
        this.fullscreenTimers.push(window.setTimeout(refit, 420));
    }

    // ---------------------------------------------------------------- 体验收尾
    private setThemePreference(preference: ThemePreference): void {
        if (!this.root) return;
        this.themePreference = preference;
        applyTheme(this.root, preference);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, preference);
        } catch {
            // 隐私模式下忽略
        }
        const select = this.root.querySelector<HTMLSelectElement>('[data-role="theme-select"]');
        if (select) select.value = preference;
    }

    private toggleHelp(force?: boolean): void {
        this.helpVisible = force ?? !this.helpVisible;
        const help = this.root?.querySelector<HTMLElement>('[data-role="help"]');
        if (help) help.hidden = !this.helpVisible;
    }

    private toggleToolMenu(): void {
        const menu = this.root?.querySelector<HTMLElement>('[data-role="tool-menu"]');
        if (menu) menu.hidden = !menu.hidden;
    }

    private zoomBy(factor: number): void {
        const rect = this.stage?.getBoundingClientRect();
        const focal = {x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2};
        this.viewport = computeZoomTransform(this.viewport, focal, this.viewport.zoom * factor);
        this.userAdjustedViewport = true;
        this.applyViewport();
        this.renderCanvas();
    }

    private fitView(): void {
        // 用户显式点「适应窗口」：无论之前怎么缩放过，都强行重新适应一次
        this.userAdjustedViewport = false;
        this.fitToStage();
        this.renderCanvas();
    }

    /** 窗口变窄时把工具按钮收进下拉，避免横向挤成一团 */
    /**
     * 左侧工具栏默认单列；按钮总高度超过窗口可用高度时自动切成双列，
     * 保证每个按钮都完整可见，不会挤在一起或被裁掉。
     */
    private syncToolColumns(): void {
        if (this.mobile) return;
        const bar = this.root?.querySelector<HTMLElement>(".annot-imagebar");
        if (!bar) return;
        bar.classList.remove("is-two-col");
        const available = bar.clientHeight;
        if (available <= 0) return;
        if (bar.scrollHeight > available + 2) bar.classList.add("is-two-col");
    }

    private updateCompact(): void {
        const width = this.root?.getBoundingClientRect().width ?? 0;
        const compact = width > 0 && width < COMPACT_WIDTH;
        if (compact === this.compact) return;
        this.compact = compact;
        this.root?.classList.toggle("is-compact", compact);
        if (!compact) {
            const menu = this.root?.querySelector<HTMLElement>('[data-role="tool-menu"]');
            if (menu) menu.hidden = true;
        }
    }

    /** 层级面板拖拽：把 fromId 挪到 toId 所在的位置 */
    private reorderObjects(fromId: string, toId: string): void {
        const from = this.scene.objects.findIndex((o) => o.id === fromId);
        const to = this.scene.objects.findIndex((o) => o.id === toId);
        if (from < 0 || to < 0 || from === to) return;
        const [object] = this.scene.objects.splice(from, 1);
        this.scene.objects.splice(Math.min(this.scene.objects.length, to), 0, object);
        this.commit();
        this.render();
    }

    /** 画布悬浮工具条：按当前工具 / 选中的对象，动态显示对应参数 */
    // ---------------------------------------------------------------- 多选 / 对齐
    /** 按场景顺序整理选择，避免顺序抖动导致结果不可复现 */
    private normalizeSelection(ids: Iterable<string>): string[] {
        const wanted = new Set(ids);
        return this.scene.objects.map((object) => object.id).filter((id) => wanted.has(id));
    }

    /** 列表里点一行：普通点＝单选＋锚点，Shift＝锚点到这一行，Ctrl＝加 / 减选 */
    private selectFromList(id: string, mods: SidebarSelectMods): void {
        if (!this.getObject(id)) return;
        if (mods.ctrl) {
            const next = new Set(this.selectedIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            this.selectedIds = this.normalizeSelection(next);
            this.selectAnchor = id;
        } else if (mods.shift && this.selectAnchor && this.selectAnchor !== id) {
            const order = this.scene.objects.map((object) => object.id);
            const from = order.indexOf(this.selectAnchor);
            const to = order.indexOf(id);
            this.selectedIds = from >= 0 && to >= 0
                ? order.slice(Math.min(from, to), Math.max(from, to) + 1)
                : [id];
        } else {
            this.selectedIds = [id];
            this.selectAnchor = id;
        }
        this.render();
    }

    /** 画布 Ctrl 点对象：在选中集合里加上 / 去掉 */
    private toggleSelected(id: string): void {
        const next = new Set(this.selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        this.selectedIds = this.normalizeSelection(next);
        this.selectAnchor = id;
    }

    /** 对齐模式开关：开启后才允许画布 Ctrl 多选 / 框选 */
    private toggleAlignMode(force?: boolean): void {
        const on = force ?? !this.alignMode;
        if (on === this.alignMode) return;
        this.alignMode = on;
        // 关掉时把多选收回成单选，避免留下一层看不见的整组选中
        if (!on && this.selectedIds.length > 1) {
            const primary = this.selectedId;
            this.selectedIds = primary ? [primary] : [];
        }
        if (on && this.activeTool !== "select" && this.activeTool !== "pan") this.setTool("select");
        this.render();
    }

    /**
     * 对齐 / 分布：全部基于「对象的绝对包围盒」算，改完统一 commit 记一次历史。
     * 分布要求三个以上对象，首尾不动、中间的间隙平均分配。
     */
    private alignSelection(op: AlignOp): void {
        const objects = this.selectedIds
            .map((id) => this.getObject(id))
            .filter((object): object is AnnotObject => Boolean(object));
        if (objects.length < 2) return;
        const items = objects.map((object) => ({object, box: getBounds(object)}));
        const union = items.reduce<Bounds>((acc, item) => {
            const b = item.box;
            const right = Math.max(acc.x + acc.width, b.x + b.width);
            const bottom = Math.max(acc.y + acc.height, b.y + b.height);
            const x = Math.min(acc.x, b.x);
            const y = Math.min(acc.y, b.y);
            return {x, y, width: right - x, height: bottom - y};
        }, {...items[0].box});
        const shiftTo = (item: {object: AnnotObject; box: Bounds}, x?: number, y?: number): void => {
            const dx = x === undefined ? 0 : x - item.box.x;
            const dy = y === undefined ? 0 : y - item.box.y;
            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) translateObject(item.object, dx, dy);
        };
        switch (op) {
            case "left":
                items.forEach((item) => shiftTo(item, union.x));
                break;
            case "right":
                items.forEach((item) => shiftTo(item, union.x + union.width - item.box.width));
                break;
            case "center-x":
                items.forEach((item) => shiftTo(item, union.x + (union.width - item.box.width) / 2));
                break;
            case "top":
                items.forEach((item) => shiftTo(item, undefined, union.y));
                break;
            case "bottom":
                items.forEach((item) => shiftTo(item, undefined, union.y + union.height - item.box.height));
                break;
            case "middle":
                items.forEach((item) => shiftTo(item, undefined, union.y + (union.height - item.box.height) / 2));
                break;
            case "distribute-x":
            case "distribute-y": {
                if (items.length < 3) {
                    this.setStatus("分布需要先选中 3 个以上对象", "error");
                    return;
                }
                const alongX = op === "distribute-x";
                const sorted = [...items].sort((a, b) => alongX ? a.box.x - b.box.x : a.box.y - b.box.y);
                const first = sorted[0];
                const last = sorted[sorted.length - 1];
                // 首尾之间要铺满的总长度＝「最后一个的右边 / 下边」减「第一个的左边 / 上边」
                const span = alongX
                    ? (last.box.x + last.box.width) - first.box.x
                    : (last.box.y + last.box.height) - first.box.y;
                const used = sorted.reduce((sum, item) => sum + (alongX ? item.box.width : item.box.height), 0);
                const gap = (span - used) / (sorted.length - 1);
                let cursor = alongX ? first.box.x : first.box.y;
                for (const item of sorted) {
                    if (item !== first && item !== last) {
                        shiftTo(item, alongX ? cursor : undefined, alongX ? undefined : cursor);
                    }
                    cursor += (alongX ? item.box.width : item.box.height) + gap;
                }
                break;
            }
        }
        const now = Date.now();
        for (const item of items) item.object.meta.updatedAt = now;
        this.commit();
        this.render();
        const label = ALIGN_ACTIONS.find((item) => item.op === op)?.label ?? "对齐";
        this.setStatus(`${label}：已整理 ${items.length} 个对象`);
    }

    private renderContextBar(): void {
        const bar = this.root?.querySelector<HTMLElement>('[data-role="context-bar"]');
        if (!bar) return;
        // 手机端只用上下双栏，不显示 PC 的悬浮条
        if (this.mobile) { bar.hidden = true; return; }
        const selected = this.getObject(this.selectedId);
        // 平移工具不显示任何对象参数，只提示怎么用
        const type: string = this.activeTool === "pan"
            ? ""
            : (selected?.type ?? (this.activeTool === "select" ? "" : this.activeTool));
        // 最左侧两个常驻按钮：选择 / 平移。其它参数一律排在它们右边。
        const base = `<div class="annot-context__base" role="group" aria-label="基础工具">` +
            CONTEXT_TOOLS.map((item) => `
                <button type="button" class="annot-context__tool${this.activeTool === item.tool ? " is-active" : ""}"
                    data-tool="${item.tool}" title="${item.title}" aria-label="${item.label}"
                    aria-pressed="${this.activeTool === item.tool}">${item.icon}</button>`).join("") +
            `<button type="button" class="annot-context__tool annot-context__tool--align${this.alignMode ? " is-active" : ""}"
                data-action="align-mode" title="对齐：打开后可按住 Ctrl 点选 / 框选多个对象（Esc 退出）"
                aria-label="对齐" aria-pressed="${this.alignMode}">${ALIGN_ICON}</button>` +
            `</div>`;
        // 选中两个以上时，对齐按钮右边就地展开 8 个对齐 / 分布按钮
        const alignPanel = this.selectedIds.length >= 2
            ? `<div class="annot-context__align" role="group" aria-label="对齐与分布">` +
            `<span class="annot-context__title">已选 ${this.selectedIds.length} 个</span>` +
            ALIGN_ACTIONS.map((item) => `
                <button type="button" class="annot-context__align-btn" data-action="align-op"
                    data-value="${item.op}" title="${item.hint}" aria-label="${item.label}">${item.icon}</button>`).join("") +
            `</div>`
            : "";
        const range = (key: string, label: string, min: number, max: number, value: number, unit = "") => `
            <label class="annot-context__item"><span>${label}</span>
                <input type="range" data-ctx="${key}" min="${min}" max="${max}" value="${value}">
                <b data-role="ctx-${key}">${value}${unit}</b></label>`;
        // 马赛克 / 模糊共用：开着的时候点一下画面，就能自动贴合文字或物体的轮廓
        const smartChip = `<button type="button" class="annot-context__chip${this.current.smartSelect ? " is-active" : ""}"
            data-action="smart-select" aria-pressed="${this.current.smartSelect}"
            title="选区识别：开启后点一下画面上的文字或物体，自动贴合它的轮廓">选区识别</button>`;
        let html = "";
        if (this.activeTool === "pan") {
            // 平移只是挪视线，没有任何参数可调：保持和「选择」一样，只留两颗常驻按钮
            html = "";
        } else if (type === "highlight" || type === "highlightRect") {
            // 高亮的两种画法：点一下直接换，不用先选工具再进设置
            const mode = this.current.highlightMode === "rect" ? "rect" : "brush";
            html = `<span class="annot-context__title">高亮</span>` +
                `<div class="annot-context__chips" role="group" aria-label="高亮模式">` +
                HIGHLIGHT_MODES.map((item) => `
                    <button type="button" class="annot-context__chip${item.key === mode ? " is-active" : ""}"
                        data-action="highlight-mode" data-value="${item.key}" title="${item.hint}"
                        aria-pressed="${item.key === mode}">${item.label}</button>`).join("") +
                `</div>`;
        } else if (type === "mosaic") {
            const size = selected ? (selected.geometry as MosaicGeometry).blockSize : this.contextDefaults.blockSize;
            // 透明度对马赛克意义不大（它本来就是盖住内容），PC 悬浮条只留块大小
            html = `<span class="annot-context__title">马赛克</span>` +
                range("blockSize", "块大小", 4, 48, size) + smartChip;
        } else if (type === "spotlight") {
            // 暗度 / 遮挡形状：选中谁改谁，没选中就改下一个聚光灯的默认值
            const picked = this.getObject(this.selectedId);
            const spot = picked?.type === "spotlight" ? picked : null;
            const darkness = Math.round((spot
                ? spot.style.spotlightOpacity ?? 0.6 : this.current.spotlightOpacity) * 100);
            const shape = spot
                ? (spot.geometry as SpotlightGeometry).shape ?? "rect" : this.current.spotlightShape;
            const maskColor = spot
                ? spot.style.spotlightColor ?? "black" : this.current.spotlightColor;
            html = `<span class="annot-context__title">聚光灯</span>` +
                `<div class="annot-context__chips" role="group" aria-label="遮罩颜色">` +
                SPOTLIGHT_COLORS.map((item) => `
                    <button type="button" class="annot-context__chip annot-context__chip--mask${item.key === maskColor ? " is-active" : ""}"
                        data-action="spotlight-color" data-value="${item.key}" title="${item.hint}"
                        aria-pressed="${item.key === maskColor}">${item.label}</button>`).join("") +
                `</div>` +
                range("spotlightOpacity", "暗度", 10, 95, darkness, "%") +
                `<span class="annot-context__title">形状</span>` +
                `<div class="annot-context__chips" role="group" aria-label="遮挡形状">` +
                SPOTLIGHT_SHAPES.map((item) => `
                    <button type="button" class="annot-context__chip${item.key === shape ? " is-active" : ""}"
                        data-action="spotlight-shape" data-value="${item.key}" title="${item.hint}"
                        aria-pressed="${item.key === shape}">${item.label}</button>`).join("") +
                `</div>`;
        } else if (type === "magnifier") {
            const picked = this.getObject(this.selectedId);
            const lens = picked?.type === "magnifier" ? picked : null;
            const zoom = normalizeMagnifierZoom(lens
                ? (lens.geometry as MagnifierGeometry).zoom : this.current.magnifierZoom);
            const shape = lens
                ? (lens.geometry as MagnifierGeometry).shape ?? "ellipse" : this.current.magnifierShape;
            html = `<span class="annot-context__title">放大镜</span>` +
                `<div class="annot-context__chips" role="group" aria-label="放大倍数">` +
                MAGNIFIER_ZOOMS.map((value) => `
                    <button type="button" class="annot-context__chip${Math.abs(value - zoom) < 0.01 ? " is-active" : ""}"
                        data-action="magnifier-zoom" data-value="${value}" title="放大 ${value} 倍"
                        aria-pressed="${Math.abs(value - zoom) < 0.01}">${value}x</button>`).join("") +
                `</div>` +
                `<span class="annot-context__title">形状</span>` +
                `<div class="annot-context__chips" role="group" aria-label="显示框形状">` +
                MAGNIFIER_SHAPES.map((item) => `
                    <button type="button" class="annot-context__chip${item.key === shape ? " is-active" : ""}"
                        data-action="magnifier-shape" data-value="${item.key}" title="${item.hint}"
                        aria-pressed="${item.key === shape}">${item.label}</button>`).join("") +
                `</div>`;
        } else if (type === "blur") {
            const radius = selected ? Math.round((selected.geometry as BlurGeometry).radius ?? 12)
                : this.contextDefaults.blurRadius;
            html = `<span class="annot-context__title">模糊</span>` +
                range("blurRadius", "模糊程度", 2, 40, radius) + smartChip;
        } else if (type === "number") {
            // 编号格式 / 引线端点 / 圆线：都按「选中谁改谁，没选中改默认值」取当前值
            const pickedNumber = this.getObject(this.selectedId);
            const numberObject = pickedNumber?.type === "number" ? pickedNumber : null;
            const format = normalizeNumberFormat(
                numberObject ? (numberObject.geometry as NumberGeometry).format : this.current.numberFormat);
            const tip = normalizeNumberTip(numberObject ? numberObject.style.numberTip : this.current.numberTip);
            const rounded = numberObject
                ? numberObject.style.arrowRounded !== false : this.current.arrowRounded;
            const formatItem = NUMBER_FORMATS.find((item) => item.key === format) ?? NUMBER_FORMATS[0];
            const style = normalizeArrowStyle(
                numberObject ? numberObject.style.numberArrowStyle : this.current.numberArrowStyle);
            const styleLabel = ARROW_STYLES.find((item) => item.key === style)?.label ?? "经典";
            html = `<span class="annot-context__title">序号</span>` +
                // 编号格式：下拉框（按钮上写「名称 + 一个样子」）
                `<div class="annot-arrow-picker annot-picker--text${this.numberFormatOpen ? " is-open" : ""}"
                    data-role="number-format-picker">` +
                `<button type="button" class="annot-arrow-picker__button" data-action="number-format-toggle" ` +
                `aria-haspopup="listbox" aria-expanded="${this.numberFormatOpen}" title="编号的显示格式">` +
                `<span class="annot-arrow-picker__label">${formatItem.short}</span>` +
                `<span class="annot-arrow-picker__icon annot-arrow-picker__icon--chip"
                    data-role="number-format-chip" aria-hidden="true">${formatItem.chip}</span>` +
                CHEVRON_DOWN_ICON +
                `</button>` +
                `<div class="annot-arrow-picker__menu" role="listbox" aria-label="编号格式">` +
                NUMBER_FORMATS.map((item) => `
                    <button type="button" class="annot-arrow-picker__item${item.key === format ? " is-active" : ""}"
                        role="option" aria-selected="${item.key === format}"
                        data-action="number-format-pick" data-value="${item.key}" title="${item.label}">
                        <span class="annot-arrow-picker__item-label">${item.short}</span>
                        <span class="annot-arrow-picker__icon annot-arrow-picker__icon--chip"
                            aria-hidden="true">${item.chip}</span>
                    </button>`).join("") +
                `</div></div>` +
                `<span class="annot-context__title">端点</span>` +
                `<div class="annot-context__chips" role="group" aria-label="引线端点">` +
                NUMBER_TIPS.map((item) => `
                    <button type="button" class="annot-context__chip${item.key === tip ? " is-active" : ""}"
                        data-action="number-tip" data-value="${item.key}" title="${item.hint}"
                        aria-pressed="${item.key === tip}">${item.label}</button>`).join("") +
                `</div>` +
                // 端点是箭头时，右边再给一个样式下拉（与箭头工具同一套七种，带图案）
                (tip === "arrow"
                    ? `<div class="annot-arrow-picker${this.numberStyleOpen ? " is-open" : ""}"
                        data-role="number-style-picker">` +
                        `<button type="button" class="annot-arrow-picker__button" data-action="number-style-toggle" ` +
                        `aria-haspopup="listbox" aria-expanded="${this.numberStyleOpen}" title="引线箭头的样式">` +
                        `<span class="annot-arrow-picker__label" data-role="number-style-label">${styleLabel}</span>` +
                        `<span class="annot-arrow-picker__icon" aria-hidden="true">${ARROW_STYLE_ICONS[style]}</span>` +
                        CHEVRON_DOWN_ICON +
                        `</button>` +
                        `<div class="annot-arrow-picker__menu" role="listbox" aria-label="箭头样式">` +
                        ARROW_STYLES.map((item) => `
                            <button type="button" class="annot-arrow-picker__item${item.key === style ? " is-active" : ""}"
                                role="option" aria-selected="${item.key === style}"
                                data-action="number-style-pick" data-value="${item.key}" title="${item.hint}">
                                <span class="annot-arrow-picker__item-label">${item.label}</span>
                                <span class="annot-arrow-picker__icon" aria-hidden="true">${ARROW_STYLE_ICONS[item.key]}</span>
                            </button>`).join("") +
                        `</div></div>` +
                        `<button type="button" class="annot-context__toggle${rounded ? " is-active" : ""}"
                            data-action="arrow-rounded" aria-pressed="${rounded}"
                            title="线端与折角是否圆润：开了是圆线，关掉是方头尖角">圆线</button>`
                    : "");
        } else if (type === "arrow") {
            // 显示值必须和「改动目标」一致：选中的那支优先，没选中才显示默认样式
            const picked = this.getObject(this.selectedId);
            const pickedStyle = picked?.type === "arrow" ? picked.style : null;
            const active = normalizeArrowStyle(pickedStyle?.arrowStyle ?? this.current.arrowStyle);
            const rounded = pickedStyle ? pickedStyle.arrowRounded !== false : this.current.arrowRounded;
            const activeLabel = ARROW_STYLES.find((item) => item.key === active)?.label ?? "经典";
            // 参考 ShareX 的 ArrowStylePickerDropdown：按钮里「文字 + 图案 + 折角箭头」，
            // 展开后每一项同样是「文字在左、图案在右」
            html = `<span class="annot-context__title">箭头样式</span>` +
                `<div class="annot-arrow-picker${this.arrowPickerOpen ? " is-open" : ""}" data-role="arrow-picker">` +
                `<button type="button" class="annot-arrow-picker__button" data-action="arrow-picker-toggle" ` +
                `aria-haspopup="listbox" aria-expanded="${this.arrowPickerOpen}" title="选择箭头样式">` +
                `<span class="annot-arrow-picker__label">${activeLabel}</span>` +
                `<span class="annot-arrow-picker__icon" aria-hidden="true">${ARROW_STYLE_ICONS[active]}</span>` +
                CHEVRON_DOWN_ICON +
                `</button>` +
                `<div class="annot-arrow-picker__menu" role="listbox" aria-label="箭头样式">` +
                ARROW_STYLES.map((item) => `
                    <button type="button" class="annot-arrow-picker__item${item.key === active ? " is-active" : ""}"
                        role="option" aria-selected="${item.key === active}"
                        data-action="arrow-style-pick" data-value="${item.key}" title="${item.hint}">
                        <span class="annot-arrow-picker__item-label">${item.label}</span>
                        <span class="annot-arrow-picker__icon" aria-hidden="true">${ARROW_STYLE_ICONS[item.key]}</span>
                    </button>`).join("") +
                `</div></div>` +
                `<button type="button" class="annot-context__toggle${rounded ? " is-active" : ""}"
                    data-action="arrow-rounded" aria-pressed="${rounded}"
                    title="线端与折角是否圆润：开了是圆线，关掉是方头尖角">圆线</button>`;
        } else if (type === "rect") {
            // 与 ShareX 一致：只有矩形有圆角。
            // 和箭头一样——画完仍选中时就该改这一支，所以直接用当前选中对象。
            const picked = this.getObject(this.selectedId);
            const radius = normalizeCornerRadius(
                picked?.type === "rect" ? picked.style.cornerRadius : this.current.cornerRadius);
            html = `<span class="annot-context__title">圆角</span>` +
                `<div class="annot-corner-picker${this.cornerPickerOpen ? " is-open" : ""}" data-role="corner-picker">` +
                `<button type="button" class="annot-corner-picker__button" data-action="corner-picker-toggle" ` +
                `aria-haspopup="listbox" aria-expanded="${this.cornerPickerOpen}" title="设置矩形四个角的圆角半径">` +
                `<span class="annot-corner-picker__value" data-role="corner-value">${radius}</span>` +
                `<span class="annot-corner-picker__icon" aria-hidden="true">${cornerRadiusIcon(radius)}</span>` +
                CHEVRON_DOWN_ICON +
                `</button>` +
                `<div class="annot-corner-picker__menu" role="listbox" aria-label="圆角半径">` +
                CORNER_RADIUS_OPTIONS.map((value) => `
                    <button type="button" class="annot-corner-picker__item${value === radius ? " is-active" : ""}"
                        role="option" aria-selected="${value === radius}"
                        data-action="corner-radius-pick" data-value="${value}" title="圆角 ${value} px">
                        <span class="annot-corner-picker__icon" aria-hidden="true">${cornerRadiusIcon(value)}</span>
                        <span class="annot-corner-picker__item-label">${value}</span>
                    </button>`).join("") +
                `</div></div>`;
        } else if (type === "line") {
            // 画线的悬浮条只放一个「圆线」开关：线端圆头 / 方头。
            // 取值规则与箭头样式、矩形圆角一致——选中谁改谁，没选中改默认值。
            const pickedLine = this.getObject(this.selectedId);
            const round = pickedLine?.type === "line"
                ? pickedLine.style.lineRound !== false : this.current.lineRound;
            html = `<span class="annot-context__title">画线</span>` +
                `<span class="annot-context__hint">${round ? "圆头收口" : "方头收口"}</span>` +
                `<button type="button" class="annot-context__toggle${round ? " is-active" : ""}"
                    data-action="line-round" aria-pressed="${round}"
                    title="线端是否圆润：开了是圆头，关掉是方头（机械制图那种平齐收口）">圆线</button>`;
        } else if (this.cropMode) {
            html = `<span class="annot-context__title">裁剪</span>` +
                `<span class="annot-context__hint">在图上拖出保留区域，回车确认</span>`;
        } else if (this.lastCanvasOp && /^(rotate|flip)/.test(this.lastCanvasOp)) {
            html = `<span class="annot-context__title">图像调整</span>` +
                `<span class="annot-context__hint">旋转角度 90°</span>` +
                `<button type="button" class="annot-context__arrow" data-canvas-op="rotate-ccw">向左 90°</button>` +
                `<button type="button" class="annot-context__arrow" data-canvas-op="rotate-cw">向右 90°</button>`;
        }
        // 多选时这一段参数没有任何意义（只会改到最后点的那一个），整个让位给对齐面板，
        // 顺便避免悬浮条被撑得比窗口还宽。分割线也只在真有参数时才出现。
        const rest = html && this.selectedIds.length < 2
            ? `<span class="annot-context__sep" aria-hidden="true"></span>` + html
            : "";
        bar.innerHTML = base + alignPanel + rest;
        // 基座常驻：即使没选中任何东西、也没在画，这两个按钮也一直在
        bar.hidden = false;
    }

    /** 箭头样式下拉的展开 / 收起：只改状态与属性，不重画整块悬浮条 */
    private toggleArrowPicker(force?: boolean): void {
        this.arrowPickerOpen = force ?? !this.arrowPickerOpen;
        const picker = this.root?.querySelector<HTMLElement>('[data-role="arrow-picker"]');
        const button = picker?.querySelector<HTMLElement>('[data-action="arrow-picker-toggle"]');
        picker?.classList.toggle("is-open", this.arrowPickerOpen);
        button?.setAttribute("aria-expanded", String(this.arrowPickerOpen));
    }

    private closeArrowPicker(): void {
        if (this.arrowPickerOpen) this.toggleArrowPicker(false);
    }

    /** 序号的「编号格式」下拉：展开 / 收起 */
    private toggleNumberFormatPicker(force?: boolean): void {
        this.numberFormatOpen = force ?? !this.numberFormatOpen;
        if (this.numberFormatOpen) this.numberStyleOpen = false;
        this.syncNumberPickers();
    }

    /** 序号的「箭头样式」下拉：展开 / 收起 */
    private toggleNumberStylePicker(force?: boolean): void {
        this.numberStyleOpen = force ?? !this.numberStyleOpen;
        if (this.numberStyleOpen) this.numberFormatOpen = false;
        this.syncNumberPickers();
    }

    private closeNumberPickers(): void {
        this.numberFormatOpen = false;
        this.numberStyleOpen = false;
        this.syncNumberPickers();
    }

    /** 两个下拉是互斥的，同步时两个一起处理，避免同时展开 */
    private syncNumberPickers(): void {
        const apply = (role: string, open: boolean): void => {
            const picker = this.root?.querySelector<HTMLElement>(`[data-role="${role}"]`);
            if (!picker) return;
            picker.classList.toggle("is-open", open);
            picker.querySelector<HTMLElement>("button[data-action$=\"-toggle\"]")
                ?.setAttribute("aria-expanded", String(open));
        };
        apply("number-format-picker", this.numberFormatOpen);
        apply("number-style-picker", this.numberStyleOpen);
    }

    /** 圆角下拉的展开 / 收起：只改状态与属性，不重画整块悬浮条 */
    private toggleCornerPicker(force?: boolean): void {
        this.cornerPickerOpen = force ?? !this.cornerPickerOpen;
        const picker = this.root?.querySelector<HTMLElement>('[data-role="corner-picker"]');
        const button = picker?.querySelector<HTMLElement>('[data-action="corner-picker-toggle"]');
        picker?.classList.toggle("is-open", this.cornerPickerOpen);
        button?.setAttribute("aria-expanded", String(this.cornerPickerOpen));
    }

    private closeCornerPicker(): void {
        if (this.cornerPickerOpen) this.toggleCornerPicker(false);
    }

    /**
     * 设置矩形圆角：选中矩形就改它（包括刚画完、还带着选中态的那一支），
     * 没选中就改后续绘制的默认值。圆角是数值属性，改了就是要当前这个形状变，
     * 所以不像箭头样式那样跳过新画的对象。
     */
    private setCornerRadius(value: number): void {
        const radius = normalizeCornerRadius(value);
        this.current.cornerRadius = radius;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "rect") {
            object.style.cornerRadius = radius;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /**
     * 切换箭头样式：与矩形圆角同一套逻辑——选中箭头就当场改它
     * （包括刚画完、还带着选中态的那一支），没选中就只改后续绘制的默认样式。
     */
    private setArrowStyle(style: ArrowStyleKey): void {
        const key = normalizeArrowStyle(style);
        if (!ARROW_STYLES.some((item) => item.key === key)) return;
        this.current.arrowStyle = key;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "arrow") {
            object.style.arrowStyle = key;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /**
     * 圆线开关：选中箭头就改它，没选中就改后续绘制的默认值。
     * 序号引线的箭头用的是同一套几何与同一个开关，所以一并覆盖。
     */
    private setArrowRounded(enabled: boolean): void {
        this.current.arrowRounded = enabled;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "arrow" || object?.type === "number") {
            object.style.arrowRounded = enabled;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 聚光灯遮罩颜色：黑 / 白。选中就当场换，没选中就改下一个聚光灯的默认值 */
    private setSpotlightColor(color: "black" | "white"): void {
        this.current.spotlightColor = color;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "spotlight") {
            object.style.spotlightColor = color;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 聚光灯遮挡形状：选中就当场换，没选中就改下一个聚光灯的默认值 */
    /**
     * 在「画笔高亮」与「矩形高亮」之间切换。
     * 只影响接下来怎么画，不动已经画好的对象 —— 用户不会因为试一下模式就丢掉刚画的东西。
     */
    private setHighlightMode(mode: "brush" | "rect"): void {
        const changed = this.current.highlightMode !== mode;
        this.current.highlightMode = mode;
        // 切到矩形高亮时，如果「填充」当前是 0%（顶栏显示无填充），给一个能看见的默认浓度，
        // 否则第一次拖出来的会是一块全透明，看起来像没画上
        if (mode === "rect" && this.current.fillOpacity <= 0) this.current.fillOpacity = 0.5;
        saveCurrentStyle(this.current);
        if (changed || mode === "rect") this.render();
    }

    /**
     * 选区识别：点一下按钮，先把整张画面切成一个个独立区块（虚线框）；
     * 用户点哪个框，哪个框就被打码。再点一次按钮退出，清掉所有还没点的框。
     */
    private toggleSmartSelect(): void {
        if (this.current.smartSelect) {
            this.exitSmartMode();
            return;
        }
        this.current.smartSelect = true;
        saveCurrentStyle(this.current);
        this.scanSmartRegions();
    }

    /** 退出识别模式：清空未点的虚线框（已经打出来的马赛克 / 模糊不受影响） */
    private exitSmartMode(): void {
        this.current.smartSelect = false;
        saveCurrentStyle(this.current);
        this.smartScanToken++;
        this.smartRegions = null;
        this.smartScanning = false;
        this.render();
    }

    /** Worker 懒创建；创建失败（CSP / 老内核）就把 broken 置位，之后一律主线程兜底 */
    private ensureSmartWorker(): Worker | null {
        if (this.smartWorkerBroken) return null;
        if (this.smartWorker) return this.smartWorker;
        try {
            const worker = new SmartWorker();
            worker.onmessage = (event: MessageEvent<{id: number; regions: SmartRegion[] | null}>) => {
                const callback = this.smartJobs.get(event.data.id);
                this.smartJobs.delete(event.data.id);
                callback?.(event.data.regions ?? null);
            };
            worker.onerror = () => {
                this.smartWorkerBroken = true;
            };
            this.smartWorker = worker;
            return worker;
        } catch {
            this.smartWorkerBroken = true;
            return null;
        }
    }

    /**
     * 把「当前看到的画面」按矩阵画到一张降采样画布上，供识别使用。
     *
     * 画的是**变换后的画面**（旋转 / 翻转 / 裁剪都已经体现在矩阵里），
     * 所以结果的像素坐标乘一个比例就能当画布坐标用，不需要来回换算。
     */
    private smartImageData(): {data: Uint8ClampedArray; width: number; height: number; scale: number} | null {
        const img = this.baseImage;
        const canvas = this.scene.canvas;
        if (!img || !img.naturalWidth || canvas.width < 16 || canvas.height < 16) return null;
        const key = `${img.currentSrc || img.src}|${canvas.width}x${canvas.height}|${toMatrixString(canvas.matrix)}`;
        if (this.smartBuffer?.key === key) return this.smartBuffer;
        const scale = Math.min(1, SMART_MAX_SIDE / Math.max(canvas.width, canvas.height));
        const width = Math.max(8, Math.round(canvas.width * scale));
        const height = Math.max(8, Math.round(canvas.height * scale));
        try {
            const off = document.createElement("canvas");
            off.width = width;
            off.height = height;
            const ctx = off.getContext("2d", {willReadFrequently: true});
            if (!ctx) return null;
            const m = canvas.matrix;
            ctx.setTransform(scale * m.a, scale * m.b, scale * m.c, scale * m.d, scale * m.e, scale * m.f);
            ctx.drawImage(img, 0, 0);
            const pixels = ctx.getImageData(0, 0, width, height);
            this.smartBuffer = {key, data: pixels.data, width, height, scale};
            return this.smartBuffer;
        } catch {
            // 跨域底图会污染 canvas：识别不可用，退回手动拖框
            return null;
        }
    }

    /** 扫描整幅画面，拿到所有独立区块（Worker 里算，主线程只等结果） */
    private scanSmartRegions(): void {
        const source = this.smartImageData();
        if (!source) {
            this.exitSmartMode();
            return;
        }
        const token = ++this.smartScanToken;
        this.smartScanning = true;
        this.smartRegions = null;
        this.render();
        const finish = (regions: SmartRegion[] | null): void => {
            // 已经退出模式、或者又点了一次按钮：这批结果作废
            if (token !== this.smartScanToken) return;
            this.smartScanning = false;
            const k = this.scene.canvas.width / Math.max(1, source.width);
            this.smartRegions = (regions ?? []).map((r) => ({
                x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k,
            }));
            // 一个块都没扫出来：自动退出，别让按钮一直亮着却什么都没有
            if (!this.smartRegions.length) {
                this.exitSmartMode();
                return;
            }
            this.render();
        };
        const worker = this.ensureSmartWorker();
        if (worker) {
            this.smartJobs.set(token, finish);
            try {
                worker.postMessage({id: token, data: source.data, width: source.width, height: source.height});
                return;
            } catch {
                this.smartJobs.delete(token);
                this.smartWorkerBroken = true;
            }
        }
        // 兜底：Worker 不可用就在主线程算（画面已经降采样，通常一两百毫秒）
        try {
            finish(detectRegions({data: source.data, width: source.width, height: source.height}));
        } catch {
            finish(null);
        }
    }

    /**
     * 识别模式下的「点一下打码」不是按下就执行，而是挂一个 180ms 的延时：
     * 期间只要出现第二根手指、或手指标明显移动，就立刻取消 —— 保证双指缩放永远优先。
     */
    private beginSmartTap(index: number, point: Point, client: {x: number; y: number}): void {
        this.cancelSmartTap();
        if (performance.now() < this.smartCooldownUntil) return;
        const onMove = (event: PointerEvent): void => {
            if (Math.hypot(event.clientX - client.x, event.clientY - client.y) > 8) {
                this.cancelSmartTap();
            }
        };
        const timer = window.setTimeout(() => {
            const tap = this.smartTap;
            this.smartTap = null;
            if (!tap) return;
            window.removeEventListener("pointermove", tap.onMove, {capture: true} as EventListenerOptions);
            this.applySmartRegion(tap.index);
        }, 180);
        this.smartTap = {index, start: {...point}, clientX: client.x, clientY: client.y, timer, onMove};
        window.addEventListener("pointermove", onMove, {capture: true, passive: true});
    }

    private cancelSmartTap(): void {
        if (!this.smartTap) return;
        window.clearTimeout(this.smartTap.timer);
        window.removeEventListener("pointermove", this.smartTap.onMove, {capture: true} as EventListenerOptions);
        this.smartTap = null;
    }

    /** 点中虚线框：把这一块变成马赛克 / 模糊对象，框随即消失 */
    private applySmartRegion(index: number): void {
        const region = this.smartRegions?.[index];
        const tool = this.activeTool;
        if (!region || (tool !== "mosaic" && tool !== "blur")) return;
        const object = tool === "mosaic"
            ? this.createObject("mosaic", {
                x: region.x, y: region.y, width: region.width, height: region.height,
                blockSize: this.contextDefaults.blockSize,
            })
            : this.createObject("blur", {
                x: region.x, y: region.y, width: region.width, height: region.height,
                radius: this.contextDefaults.blurRadius,
            });
        this.scene.objects.push(object);
        this.smartRegions?.splice(index, 1);
        this.selectedId = object.id;
        this.commit();
        // 点完最后一个框就自动退出识别模式：下次要用重新点按钮，
        // 不会出现「按钮还亮着、但画面里已经没有框可点」的尴尬状态
        if (!this.smartRegions?.length) {
            this.exitSmartMode();
            return;
        }
        this.render();
    }

    /** overlay 上的虚线框：点一下就是打码；扫描期间显示一行「正在识别…」 */
    private renderSmartRegions(layer: SVGGElement): void {
        if (!this.smartRegions && !this.smartScanning) return;
        const group = svgEl("g", {"data-role": "smart-regions"});
        for (const [index, region] of (this.smartRegions ?? []).entries()) {
            group.append(svgEl("rect", {
                "data-smart-region": String(index),
                x: region.x, y: region.y,
                width: Math.max(2, region.width), height: Math.max(2, region.height),
                rx: Math.min(6, Math.max(2, Math.min(region.width, region.height) * 0.12)),
                class: "annot-smart-region",
            }));
        }
        if (this.smartScanning) {
            const vb = this.svg?.viewBox?.baseVal;
            if (vb && vb.width > 0) {
                const text = svgEl("text", {
                    x: vb.x + vb.width / 2, y: vb.y + vb.height / 2,
                    "text-anchor": "middle", "dominant-baseline": "middle",
                    "font-size": 15 / (this.viewport.zoom || 1),
                    class: "annot-smart-scanning", "pointer-events": "none",
                });
                text.textContent = "正在识别…";
                group.append(text);
            }
        }
        layer.append(group);
    }

    private setSpotlightShape(shape: "rect" | "ellipse"): void {
        this.current.spotlightShape = shape;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "spotlight") {
            (object.geometry as SpotlightGeometry).shape = shape;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 放大镜倍数 */
    private setMagnifierZoom(value: number): void {
        const zoom = normalizeMagnifierZoom(value);
        this.current.magnifierZoom = zoom;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "magnifier") {
            (object.geometry as MagnifierGeometry).zoom = zoom;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 放大镜显示框形状：圆形 / 矩形 */
    private setMagnifierShape(shape: "rect" | "ellipse"): void {
        this.current.magnifierShape = shape;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "magnifier") {
            (object.geometry as MagnifierGeometry).shape = shape;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 编号格式：选中序号就当场改这一支，没选中就改下一个序号的默认值 */
    private setNumberFormat(format: NumberFormatKey): void {
        this.current.numberFormat = format;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "number") {
            (object.geometry as NumberGeometry).format = format;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 序号引线用哪种箭头样式（单头 / 双头 / 线条……），与箭头工具同一套 */
    private setNumberArrowStyle(style: ArrowStyleKey): void {
        const key = normalizeArrowStyle(style);
        this.current.numberArrowStyle = key;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "number") {
            object.style.numberArrowStyle = key;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 引线末端：箭头 / 圆点 / 方点 */
    private setNumberTip(tip: NumberTipKey): void {
        this.current.numberTip = tip;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "number") {
            object.style.numberTip = tip;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 画线的「圆线」开关：选中线就改它，没选中就改后续绘制的默认值 */
    private setLineRound(enabled: boolean): void {
        this.current.lineRound = enabled;
        saveCurrentStyle(this.current);
        const object = this.getObject(this.selectedId);
        if (object?.type === "line") {
            object.style.lineRound = enabled;
            object.meta.updatedAt = Date.now();
            this.commit();
        }
        this.render();
    }

    /** 悬浮条滑块：没选中对象时记成默认值，画出来就带上；选中了就立刻改对象 */
    private applyContextValue(key: string, value: number, commit: boolean): void {
        if (!Number.isFinite(value)) return;
        if (key === "blockSize") this.contextDefaults.blockSize = value;
        else if (key === "blurRadius") this.contextDefaults.blurRadius = value;
        else if (key === "opacity") this.contextDefaults.opacity = value;
        if (key === "spotlightOpacity") {
            // 暗度是聚光灯自己的属性，直接写对象样式，不必绕 applyProperty
            const ratio = Math.min(0.95, Math.max(0, value / 100));
            this.current.spotlightOpacity = ratio;
            const badge = this.root?.querySelector<HTMLElement>('[data-role="ctx-spotlightOpacity"]');
            if (badge) badge.textContent = `${Math.round(ratio * 100)}%`;
            const spot = this.getObject(this.selectedId);
            if (spot?.type === "spotlight") {
                spot.style.spotlightOpacity = ratio;
                spot.meta.updatedAt = Date.now();
            }
            if (commit) {
                saveCurrentStyle(this.current);
                this.commit();
            } else {
                this.renderCanvas();
            }
            return;
        }
        const badge = this.root?.querySelector<HTMLElement>(`[data-role="ctx-${key}"]`);
        if (badge) badge.textContent = `${value}${key === "opacity" ? "%" : ""}`;
        // 手机属性栏的读数（块大小 / 模糊程度）跟 PC 共用同一套 data-ctx，读数单独一份
        const mobileBadge = this.root?.querySelector<HTMLElement>(`[data-role="m-${key}"]`);
        if (mobileBadge) mobileBadge.textContent = String(Math.round(value));
        const object = this.getObject(this.selectedId);
        if (!object) return;
        const patch: PropertyPatch = {};
        if (key === "blockSize" && object.type === "mosaic") patch.blockSize = value;
        if (key === "blurRadius" && object.type === "blur") patch.blurRadius = value;
        if (key === "opacity") patch.opacity = value / 100;
        if (Object.keys(patch).length) this.applyProperty(patch, commit);
    }

    /** 调整对象层级；绘制顺序即 z-order */
    private moveInLayer(id: string, action: "top" | "up" | "down" | "bottom"): void {
        const index = this.scene.objects.findIndex((o) => o.id === id);
        if (index < 0 || this.scene.objects.length < 2) return;
        const [object] = this.scene.objects.splice(index, 1);
        let target = index;
        if (action === "top") target = this.scene.objects.length;
        else if (action === "bottom") target = 0;
        else if (action === "up") target = Math.min(this.scene.objects.length, index + 1);
        else target = Math.max(0, index - 1);
        this.scene.objects.splice(target, 0, object);
        this.commit();
        this.render();
    }

    /** 复制选中的对象，稍微偏移一点便于分辨 */
    private duplicateObject(id: string): void {
        const object = this.getObject(id);
        if (!object) return;
        const copy = cloneObject(object);
        copy.id = createId();
        copy.meta.createdAt = Date.now();
        copy.meta.updatedAt = copy.meta.createdAt;
        translateObject(copy, 24 / this.viewport.zoom, 24 / this.viewport.zoom);
        this.scene.objects.push(copy);
        this.selectedId = copy.id;
        this.commit();
        this.render();
    }

    // ---------------------------------------------------------------- 画布操作
    private runCanvasOp(op: string): void {
        this.lastCanvasOp = op;
        switch (op) {
            case "crop": this.startCrop(); break;
            case "extend": this.toggleExtend(); break;
            case "rotate-cw": this.rotateView(1); break;
            case "rotate-ccw": this.rotateView(-1); break;
            case "flip-h": this.flipView("x"); break;
            case "flip-v": this.flipView("y"); break;
            default: break;
        }
    }

    /**
     * 旋转画布 90°。
     * 标注用的是画布坐标，所以必须和底图做同一套映射：
     * 顺时针 (x, y) → (H - y, x)，逆时针 (x, y) → (y, W - x)，
     * 对象自身角度也加/减 90°，文字才会跟着画面一起转，而不是原地立着。
     */
    private rotateView(direction: 1 | -1): void {
        if (!this.canvasWidth) return;
        this.finishTextEdit();
        this.cancelCrop();
        const {width, height} = this.scene.canvas;
        remapObjects(
            this.scene.objects,
            direction > 0 ? (p) => ({x: height - p.y, y: p.x}) : (p) => ({x: p.y, y: width - p.x}),
            {angleDelta: direction > 0 ? 90 : -90},
        );
        this.scene.canvas = rotateCanvas(this.scene.canvas, direction);
        this.applyCanvas();
        this.commit();
        // 旋转后画布宽高对调，重新适应窗口，保证整张图仍然完整可见
        this.fitView();
        this.setStatus(direction > 0
            ? "已向右旋转 90°，标注跟着一起转；保存时会写回笔记里的图片"
            : "已向左旋转 90°，标注跟着一起转；保存时会写回笔记里的图片");
    }

    /** 翻转画面；文字保持正向可读（不镜像字形），位置照常跟随 */
    private flipView(axis: "x" | "y"): void {
        if (!this.canvasWidth) return;
        this.finishTextEdit();
        this.cancelCrop();
        const {width, height} = this.scene.canvas;
        remapObjects(
            this.scene.objects,
            axis === "x" ? (p) => ({x: width - p.x, y: p.y}) : (p) => ({x: p.x, y: height - p.y}),
            {negateRotation: true},
        );
        this.scene.canvas = flipCanvas(this.scene.canvas, axis);
        this.applyCanvas();
        this.commit();
        this.fitView();
        this.setStatus(axis === "x"
            ? "已水平翻转画面；保存时会写回笔记里的图片"
            : "已垂直翻转画面；保存时会写回笔记里的图片");
    }

    /**
     * 进入裁剪：参考插件 enterCropMode(restoreCrop) 的等价实现。
     *
     * 参考插件把 _originalSrc（完整原图）重新铺满，标注 +cropOffset 移回原位，
     * 裁剪框正好框住上次保留的那块；没裁过时框直接铺满整张图。
     * 这里由 CropSession 算好「完整视图 / 累计窗口 / 最大可恢复范围」，
     * 编辑器只负责把画布铺开、把标注搬过去、把框画出来。
     * 取消时用会话里的现场原样还原，不会停在临时放大的画面上。
     */
    private startCrop(): void {
        this.finishTextEdit();
        this.toggleExtend(false);
        if (this.cropMode) return;

        const session = new CropSession(this.scene.canvas, this.scene.crop);
        const entered = session.enter();
        this.cropSession = session;
        this.cropMode = true;

        if (entered.expanded) {
            // 临时铺回完整原图：标注跟着回到原图坐标，框＝上次保留的那块
            this.cropObjectsBackup = JSON.parse(JSON.stringify(this.scene.objects)) as AnnotObject[];
            remapObjects(this.scene.objects, (p) => ({
                x: p.x + entered.shift.x, y: p.y + entered.shift.y,
            }));
            this.scene.canvas = entered.canvas;
            this.applyCanvas();
            this.userAdjustedViewport = false;
            this.initialFitDone = false;
            this.fitView();
        } else {
            this.cropObjectsBackup = null;
        }

        this.cropRect = {...entered.rect};
        // 框是「整张图」或「上次保留的那块」，比例一律标成自由，免得按钮与实际不符
        this.cropAspect = null;
        this.cropAspectKey = "free";
        this.cropDragStart = null;
        this.cropHandle = null;
        this.cropMove = null;
        this.cropLastPoint = null;
        this.selectedId = null;
        this.syncCropRatios();
        this.updateCropBar();
        this.render();
        this.setStatus(entered.expanded
            ? "再裁剪：完整原图已铺回，灰色是上次裁掉的部分；拖四角 / 四边把框放大就能找回，点「恢复整张原图」可一次全要"
            : "裁剪：框已铺满整张图，拖四角 / 四边收小到要保留的范围；按 Delete 可清掉框重新框选，回车确认");
    }

    /** 「恢复整张原图」：把框放到最大可恢复范围 */
    private selectFullCrop(): void {
        if (!this.cropMode) return;
        this.cropRect = this.cropSession
            ? {...this.cropSession.fullRect()}
            : {x: 0, y: 0, width: this.canvasWidth, height: this.canvasHeight};
        this.cropAspect = null;
        this.cropAspectKey = "free";
        this.syncCropRatios();
        this.updateCropBar();
        this.renderOverlay();
        this.setStatus("已扩到整张原图的范围：点 ✓ / 回车确认");
    }

    /** 取消 / 退出裁剪：把进入前的画布、标注坐标、裁剪窗口原样还回去 */
    private restoreCropState(): void {
        const session = this.cropSession;
        if (!session) return;
        this.cropSession = null;
        const backup = session.restore();
        this.scene.canvas = backup.canvas;
        this.scene.crop = backup.crop;
        if (this.cropObjectsBackup) this.scene.objects = this.cropObjectsBackup;
        this.cropObjectsBackup = null;
        // 临时扩张期间没有往历史里压过东西，快照本来就停在扩张前，不用清空撤销记录
        this.applyCanvas();
        this.fitView();
    }

    /** 把坐标夹在画布内：从图片外的留白起手时也能得到合理的起点 */
    private clampToCanvas(p: Point): Point {
        return {
            x: Math.min(Math.max(p.x, 0), this.canvasWidth || 0),
            y: Math.min(Math.max(p.y, 0), this.canvasHeight || 0),
        };
    }

    private beginCropDrag(e: {clientX: number; clientY: number}): void {
        const p = this.clampToCanvas(this.toImagePoint(e));
        this.cropDragStart = p;
        this.cropRect = {x: p.x, y: p.y, width: 0, height: 0};
        this.updateCropBar();
        this.renderOverlay();
    }

    private updateCropDrag(e: {clientX: number; clientY: number}): void {
        if (!this.cropDragStart) return;
        const p = this.clampToCanvas(this.toImagePoint(e));
        // 锁比例时，拖出来的框一开始就是那个比例
        this.cropRect = dragCropRect(
            this.cropDragStart, p,
            this.canvasWidth, this.canvasHeight,
            this.cropAspect, MIN_CROP_SIZE,
        );
        this.updateCropBar();
        this.renderOverlay();
    }

    /** 点在哪一个手柄的命中范围内（容差跟缩放走，缩放越小越好点） */
    private cropHandleAt(p: Point): CropHandle | null {
        const rect = this.cropRect;
        if (!rect || !this.cropMode) return null;
        const box = this.normalizeCrop(rect);
        const right = box.x + box.width;
        const bottom = box.y + box.height;
        // 手指比鼠标粗：移动端把热区放大到 22px，稍微点偏一点也能拖到
        const tol = (this.mobile ? 22 : 12) / (this.viewport.zoom || 1);
        const spots: Array<[CropHandle, number, number]> = [
            ["nw", box.x, box.y], ["ne", right, box.y],
            ["sw", box.x, bottom], ["se", right, bottom],
            ["n", box.x + box.width / 2, box.y], ["s", box.x + box.width / 2, bottom],
            ["w", box.x, box.y + box.height / 2], ["e", right, box.y + box.height / 2],
        ];
        let best: CropHandle | null = null;
        let bestDistance = Infinity;
        for (const [handle, hx, hy] of spots) {
            const distance = Math.hypot(p.x - hx, p.y - hy);
            if (distance <= tol && distance < bestDistance) {
                best = handle;
                bestDistance = distance;
            }
        }
        return best;
    }

    /** 点是否落在裁切框内部（用于「按住框内挪位置」） */
    private pointInCropBox(p: Point): boolean {
        if (!this.cropRect) return false;
        const box = this.normalizeCrop(this.cropRect);
        return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
    }

    /** 开始拖手柄缩放：记下手柄与起点，位移按增量算 */
    private beginCropResize(handle: CropHandle, e: {clientX: number; clientY: number}): void {
        if (!this.cropRect) return;
        this.cropHandle = handle;
        this.cropLastPoint = this.toImagePoint(e);
        this.cropRect = this.normalizeCrop(this.cropRect);
        this.updateCropBar();
        this.renderOverlay();
    }

    private updateCropResize(e: {clientX: number; clientY: number}): void {
        if (!this.cropHandle || !this.cropRect) return;
        const p = this.toImagePoint(e);
        const last = this.cropLastPoint ?? p;
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (dx === 0 && dy === 0) return;
        this.cropRect = resizeCropRect(
            this.cropRect, this.cropHandle, dx, dy,
            this.canvasWidth, this.canvasHeight,
            this.cropAspect, MIN_CROP_SIZE,
        );
        this.cropLastPoint = p;
        this.updateCropBar();
        this.renderOverlay();
    }

    /** 框内按住拖动：整体挪动裁切框（比拖手柄更容易对上位置） */
    private beginCropMove(e: {clientX: number; clientY: number}): void {
        if (!this.cropRect) return;
        this.cropMove = {origin: this.toImagePoint(e), rect: this.normalizeCrop(this.cropRect)};
        this.renderOverlay();
    }

    private updateCropMove(e: {clientX: number; clientY: number}): void {
        if (!this.cropMove) return;
        const p = this.toImagePoint(e);
        this.cropRect = moveCropRect(
            this.cropMove.rect,
            p.x - this.cropMove.origin.x, p.y - this.cropMove.origin.y,
            this.canvasWidth, this.canvasHeight,
        );
        this.updateCropBar();
        this.renderOverlay();
    }

    private finishCropDrag(): void {
        if (!this.cropDragStart) return;
        this.cropDragStart = null;
        this.cropRect = this.cropRect ? this.normalizeCrop(this.cropRect) : null;
        this.updateCropBar();
        this.renderOverlay();
    }

    /** 退出裁剪（参考插件 exitCropMode）：拿掉框，并把临时铺开的画面还原 */
    private cancelCrop(): void {
        if (!this.cropMode && !this.cropRect) return;
        this.cropMode = false;
        this.cropRect = null;
        this.cropDragStart = null;
        this.cropHandle = null;
        this.cropMove = null;
        this.cropLastPoint = null;
        this.updateCropBar();
        this.restoreCropState();
        this.render();
    }

    /**
     * 应用裁剪（参考插件 applyCrop）：把当前显示窗口换成框里那一块。
     * 参考插件会烤一张位图；我们改画布窗口 + 由可视窗口剪掉框外内容，
     * 效果一样但保留完整原图，保存后重新编辑依旧能扩回外围。
     */
    private applyCrop(): void {
        const raw = this.cropRect;
        const session = this.cropSession;
        if (!this.cropMode || !raw || !session) return;
        const rect = this.normalizeCrop(raw);
        if (rect.width < MIN_CROP_SIZE || rect.height < MIN_CROP_SIZE) {
            this.setStatus("裁剪范围太小了，请拖一个更大的区域");
            return;
        }
        // 框还停在进来时的位置：等于什么都没改，原样退出
        if (session.unchanged(rect)) {
            this.cancelCrop();
            this.setStatus("范围没变，已保持原样");
            return;
        }
        const baked = session.bake(rect);
        // 累计裁剪窗口随场景写进 SVG 的 metadata 与 sidecar，下次才扩得回来
        this.scene.crop = baked.crop;
        // 标注整体平移到新画布原点，画面与标注的相对位置保持不变
        remapObjects(this.scene.objects, (p) => ({x: p.x + baked.shift.x, y: p.y + baked.shift.y}));
        this.scene.canvas = baked.canvas;
        this.cropSession = null;
        this.cropObjectsBackup = null;
        this.cropMode = false;
        this.cropRect = null;
        this.cropDragStart = null;
        this.cropHandle = null;
        this.cropMove = null;
        this.cropLastPoint = null;
        this.updateCropBar();
        this.applyCanvas();
        this.commit();
        this.fitView();
        this.setStatus(`已裁剪为 ${this.scene.canvas.width} × ${this.scene.canvas.height} px；框外的画面已收起，保存后正文里也是这个范围`);
    }

    /** 把拖拽得到的两点整理成「左上角 + 正宽高」，并限制在画布内、对齐到整像素 */
    private normalizeCrop(rect: Bounds): Bounds {
        const left = Math.min(rect.x, rect.x + rect.width);
        const top = Math.min(rect.y, rect.y + rect.height);
        const right = Math.max(rect.x, rect.x + rect.width);
        const bottom = Math.max(rect.y, rect.y + rect.height);
        const x = Math.max(0, Math.round(left));
        const y = Math.max(0, Math.round(top));
        return {
            x,
            y,
            width: Math.min(this.canvasWidth, Math.round(right)) - x,
            height: Math.min(this.canvasHeight, Math.round(bottom)) - y,
        };
    }

    private updateCropBar(): void {
        // 裁剪时右侧栏换成裁剪面板（比例 / 尺寸 / 应用），平时显示对象列表
        const panel = this.root?.querySelector<HTMLElement>('[data-role="crop-side"]');
        const sidebar = this.root?.querySelector<HTMLElement>('[data-role="sidebar"]');
        if (panel) panel.hidden = !this.cropMode;
        if (sidebar) sidebar.hidden = this.cropMode;
        const bar = panel;
        if (!bar) return;
        // 拖拽方向可能是反的，显示与可用性判断都要用规范化后的正宽高
        const box = this.cropRect ? this.normalizeCrop(this.cropRect) : null;
        const preset = CROP_RATIO_PRESETS.find((item) => item.key === this.cropAspectKey);
        const suffix = preset && preset.key !== "free" ? ` · ${preset.label}` : "";
        const size = bar.querySelector<HTMLElement>('[data-role="crop-size"]');
        if (size) {
            size.textContent = box
                ? `保留 ${Math.max(0, box.width)} × ${Math.max(0, box.height)} px${suffix}`
                : "拖出要保留的区域";
        }
        const apply = bar.querySelector<HTMLButtonElement>('[data-action="crop-apply"]');
        if (apply) apply.disabled = !box || box.width < MIN_CROP_SIZE || box.height < MIN_CROP_SIZE;
    }

    /** 高亮当前锁定的比例按钮 */
    private syncCropRatios(): void {
        // PC 的比例按钮在右侧面板里，手机上在上栏：两处都要同步高亮
        const buttons = this.root?.querySelectorAll<HTMLElement>('[data-action="crop-ratio"]') ?? [];
        Array.from(buttons).forEach((button) => {
            const active = button.getAttribute("data-ratio") === this.cropAspectKey;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", active ? "true" : "false");
        });
    }

    /**
     * 切换比例锁定。
     * 已经有框就地调成该比例（保持中心，尽量大）；还没框就只记下来，
     * 之后拖出来的框自然就是这个比例。
     */
    private setCropAspect(key: string): void {
        const preset = CROP_RATIO_PRESETS.find((item) => item.key === key);
        if (!preset) return;
        this.cropAspectKey = preset.key;
        if (preset.key === "free") {
            this.cropAspect = null;
        } else if (preset.ratio === "source") {
            this.cropAspect = this.naturalHeight ? this.naturalWidth / this.naturalHeight : null;
        } else {
            this.cropAspect = preset.ratio;
        }
        if (this.cropRect && this.cropAspect) {
            this.cropRect = fitCropRatio(
                this.normalizeCrop(this.cropRect), this.cropAspect,
                this.canvasWidth, this.canvasHeight, MIN_CROP_SIZE,
            );
        }
        this.syncCropRatios();
        this.updateCropBar();
        this.renderOverlay();
        if (this.cropAspect) {
            this.setStatus(`已锁定 ${preset.label}${preset.key === "source" ? "（图片原始比例）" : ""}：拖手柄时会自动保持`);
        } else {
            this.setStatus("比例已放开：可以任意拖着裁");
        }
    }

    private toggleExtend(force?: boolean): void {
        const panel = this.root?.querySelector<HTMLElement>('[data-role="extend-pop"]');
        if (!panel) return;
        const next = force ?? panel.hidden;
        panel.hidden = !next;
        if (!next) {
            this.stopPickColor();
            return;
        }
        this.finishTextEdit();
        this.cancelCrop();
        this.syncExtendPanel();
        const input = panel.querySelector<HTMLInputElement>('[data-role="extend-margin"]');
        if (input) window.setTimeout(() => input.select(), 0);
    }

    /** 把 extendState 反映到面板上（方向高亮、联动显隐、数值、底色选中态） */
    private syncExtendPanel(): void {
        const panel = this.root?.querySelector<HTMLElement>('[data-role="extend-pop"]');
        if (!panel) return;
        const state = this.extendState;

        for (const button of panel.querySelectorAll<HTMLElement>("[data-dir]")) {
            const dir = button.getAttribute("data-dir");
            // 中间方块只有在「四个方向全选 + 已连接」时才算激活
            const active = dir === "all"
                ? allDirectionsOn(state) && state.link
                : state.dirs[dir as ExtendDir];
            button.classList.toggle("is-active", Boolean(active));
            button.setAttribute("aria-pressed", active ? "true" : "false");
        }

        // 四个方向各一个框：只有「选中的方向」能输入；连接时只有第一个选中的能输入
        for (const dir of EXTEND_DIRS) {
            const input = panel.querySelector<HTMLInputElement>(`[data-role="extend-${dir}"]`);
            if (!input) continue;
            input.value = String(valueForDir(state, dir));
            const editable = isDirEditable(state, dir);
            input.disabled = !editable;
            input.title = editable
                ? "填这个方向的扩展量"
                : state.dirs[dir]
                    ? "已连接：改第一个选中的框即可同步"
                    : "没选这个方向，先点上面的箭头";
            input.closest<HTMLElement>(".annot-amount")?.classList.toggle("is-locked", !editable);
        }
        for (const button of panel.querySelectorAll<HTMLElement>('[data-action="toggle-link"]')) {
            button.classList.toggle("is-active", state.link);
            button.setAttribute("aria-pressed", state.link ? "true" : "false");
            button.title = state.link
                ? "已连接：选中的方向共用一个数值（点它取消连接）"
                : "连接选中的方向：共用一个数值";
        }

        for (const button of panel.querySelectorAll<HTMLElement>("[data-bg]")) {
            const slot = button.getAttribute("data-bg") as ExtendSlot | null;
            if (slot) button.classList.toggle("is-active", state.slot === slot);
        }
        const custom1Label = panel.querySelector<HTMLElement>('[data-bg="custom1"]');
        if (custom1Label) {
            custom1Label.style.background = state.custom1;
            // 十字用反差色：浅底给深十字、深底给浅十字，避免十字和底色糊在一起
            custom1Label.style.setProperty("--annot-cross-color", this.readableTextOn(state.custom1));
            custom1Label.classList.toggle("is-active", state.slot === "custom1");
        }
        const custom2 = panel.querySelector<HTMLElement>('[data-role="bg-custom2"]');
        if (custom2) {
            const color = slotColorForState(state, "custom2");
            custom2.style.background = color ?? "";
            // 按钮里是吸管图标，千万别再写 textContent，否则会把图标冲掉
            custom2.dataset.color = color ?? "";
            // 图标用 currentColor：深底给白图标、浅底给深图标
            custom2.style.color = color ? this.readableTextOn(color) : "";
            custom2.setAttribute("aria-label", color ? `吸管取色（当前 ${color}）` : "吸管取色");
            custom2.classList.toggle("is-active", state.slot === "custom2");
        }
        const tip = panel.querySelector<HTMLElement>('[data-role="extend-tip"]');
        if (tip) {
            const bg = backgroundForState(state);
            tip.textContent = bg
                ? `扩出来的区域会铺上 ${bg} 底色。`
                : "透明＝不铺色；白/黑/自定义＝给扩出来的区域铺底色。吸管可以直接吸图片上的颜色。";
        }
    }

    /** 深色底上用白字、浅色底上用深字（只给面板上的小色块用） */
    private readableTextOn(hex: string): string {
        const value = hex.replace("#", "");
        const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#222222" : "#FFFFFF";
    }

    private setExtendDir(dir: ExtendDir, value: boolean): void {
        this.extendState.dirs[dir] = value;
        // 连接状态下，取消选中一个方向可能换掉「第一个选中的」，数值要跟着搬过去，
        // 否则用户会觉得数字莫名归零
        if (this.extendState.link) {
            const first = firstActiveDir(this.extendState);
            if (first) this.extendState.margin = this.extendState.sides[first];
        }
        saveExtendState(this.extendState);
        this.syncExtendPanel();
        if (!hasAnyDirection(this.extendState)) {
            this.setStatus("至少要选一个方向，四个框才可以用");
        }
    }

    /**
     * 锁链：把「选中的那几个方向」连接起来共用一个数值。
     * 打开时取第一个选中方向的数值当统一值；取消时把统一值分回各个选中方向，
     * 数字不会突然跳变。
     */
    private toggleExtendLink(): void {
        const active = EXTEND_DIRS.filter((dir) => this.extendState.dirs[dir]);
        if (!active.length) {
            // 一个方向都没选时无从连接，先让用户挑方向
            this.setStatus("先点箭头选一个扩展方向，再决定要不要连接");
            return;
        }
        const next = !this.extendState.link;
        this.extendState.link = next;
        if (next) {
            this.extendState.margin = this.extendState.sides[active[0]];
        } else {
            for (const dir of active) this.extendState.sides[dir] = this.extendState.margin;
        }
        saveExtendState(this.extendState);
        this.syncExtendPanel();
        const names = active.map((dir) => DIR_NAMES[dir]).join("、");
        this.setStatus(next
            ? `${names} 已连接：改 ${DIR_NAMES[active[0]]} 那个框即可同步`
            : "已取消连接：选中的方向可以分别设置");
    }

    /** 选底色槽位（透明 / 白 / 黑 / 自定义色 / 吸管取到的色） */
    private selectExtendBg(slot: ExtendSlot): void {
        this.extendState.slot = slot;
        saveExtendState(this.extendState);
        this.syncExtendPanel();
    }

    private toggleExtendDir(dir: string): void {
        if (dir === "all") {
            // 点它＝「四个方向全选 + 打开锁链」；已经是这个状态时再点才取消
            const next = !(allDirectionsOn(this.extendState) && this.extendState.link);
            for (const item of EXTEND_DIRS) this.extendState.dirs[item] = next;
            // 点「四周同步」＝直接打开锁链：四个方向共用第一个框（上）的数值
            this.extendState.link = next;
            if (next) this.extendState.margin = this.extendState.sides.top;
            saveExtendState(this.extendState);
            this.syncExtendPanel();
            this.setStatus(next ? "四周同步：四个方向共用第一个框的数值" : "已取消四周同步：先选方向，再分别填数值");
            return;
        }
        if (!EXTEND_DIRS.includes(dir as ExtendDir)) return;
        this.setExtendDir(dir as ExtendDir, !this.extendState.dirs[dir as ExtendDir]);
    }

    private applyExtend(): void {
        const state = this.extendState;
        if (!hasAnyDirection(state)) {
            this.setStatus("先选一个扩展方向（↑ ↓ ← → 或「四周」）");
            return;
        }
        const margins = marginsForState(state);
        if (!margins.top && !margins.right && !margins.bottom && !margins.left) {
            this.setStatus("扩展数值要大于 0");
            return;
        }
        // 标注整体跟着底图平移：只扩左边时，所有标注往右挪，相对位置不变
        remapObjects(this.scene.objects, (p) => ({x: p.x + margins.left, y: p.y + margins.top}));
        const canvas = extendCanvas(this.scene.canvas, margins);
        canvas.background = backgroundForState(state);
        this.scene.canvas = canvas;
        saveExtendState(state);
        this.toggleExtend(false);
        this.applyCanvas();
        this.commit();
        this.fitView();
        const parts: string[] = [];
        if (margins.top) parts.push(`上 ${margins.top}`);
        if (margins.bottom) parts.push(`下 ${margins.bottom}`);
        if (margins.left) parts.push(`左 ${margins.left}`);
        if (margins.right) parts.push(`右 ${margins.right}`);
        const bg = canvas.background ? `，底色 ${canvas.background}` : "，保持透明";
        this.setStatus(`已扩展（${parts.join(" / ")} px）${bg}；保存时会写回笔记里的图片`);
    }

    // ---------------------------------------------------------------- 吸管取色
    private startPickColor(): void {
        this.pickMode = true;
        this.root?.classList.add("is-picking");
        this.setStatus("吸管：在图片上点一下取色，Esc 取消");
    }

    private stopPickColor(): void {
        if (!this.pickMode) return;
        this.pickMode = false;
        this.root?.classList.remove("is-picking");
    }

    /** 从底图上取一个像素的颜色（画布坐标 → 原图坐标） */
    private pickColorAt(e: {clientX: number; clientY: number}): string | null {
        const img = this.baseImage;
        if (!img || !this.naturalWidth || !this.naturalHeight) return null;
        const point = applyMatrix(invert(this.scene.canvas.matrix), this.toImagePoint(e));
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        if (x < 0 || y < 0 || x >= this.naturalWidth || y >= this.naturalHeight) return null;
        try {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d", {willReadFrequently: true});
            if (!ctx || typeof ctx.getImageData !== "function") return null;
            ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
        } catch {
            // 跨域底图会污染 canvas，取不到色就放弃
            return null;
        }
    }

    private finishPickColor(e: {clientX: number; clientY: number}): void {
        const color = this.pickColorAt(e);
        this.stopPickColor();
        if (!color) {
            this.setStatus("没能取到颜色（位置在图外，或底图不允许读取像素）", "error");
            return;
        }
        this.extendState.custom2 = color;
        this.extendState.slot = "custom2";
        saveExtendState(this.extendState);
        this.syncExtendPanel();
        this.setStatus(`吸到颜色 ${color}，扩展时会铺这个底色`);
    }

    // ---------------------------------------------------------------- 持久化
    /**
     * 打开时恢复场景。
     * 图片文件里内嵌的工程数据最权威；只有老版本留下、还没转成新封装的图，
     * 才去读一次旧的附档（只读，从此不再写附档）。
     */
    private async restoreScene(): Promise<void> {
        if (this.finished) return;
        try {
            const embedded = this.packageScene;
            const legacy = embedded ? null : await loadScene(this.target.blockId, this.target.assetPath);
            const saved = embedded ?? legacy;
            if (!saved || this.finished) return;
            this.scene.objects = saved.objects;
            this.scene.imageWidth = this.naturalWidth;
            this.scene.imageHeight = this.naturalHeight;
            this.scene.canvas = saved.canvas
                ? {...saved.canvas, matrix: {...saved.canvas.matrix}}
                : createCanvas(this.naturalWidth, this.naturalHeight);
            if (!this.scene.canvas.naturalWidth) {
                this.scene.canvas.naturalWidth = this.naturalWidth;
                this.scene.canvas.naturalHeight = this.naturalHeight;
            }
            // 裁剪窗口显式存在场景里；老场景没这个字段就从矩阵反推，结果一致
            this.scene.crop = saved.crop ?? cropWindowOf(this.scene.canvas);
            this.scene.blockId = this.target.blockId || saved.blockId;
            this.scene.assetPath = this.target.assetPath || saved.assetPath;
            this.history.reset(this.snapshot());
            this.selectedId = null;
            this.applyCanvas();
            // 每次打开都重新适应窗口（不再沿用上次的缩放，避免一进来就被裁掉）。
            // 还原画布尺寸可能和原图不同（以前旋转/裁切过），所以这里再强制适应一次。
            this.userAdjustedViewport = false;
            this.initialFitDone = false;
            this.fitAfterLayout();
            this.render();
            this.setStatus(this.openedFromPackage
                ? `已从图片里恢复 ${this.scene.objects.length} 个标注，可以继续编辑`
                : `已还原 ${this.scene.objects.length} 个标注`);
        } catch {
            // 读取失败不阻止继续编辑，按空白画布处理
        }
    }

    /**
     * 取完整原始底图，写进 PNG 的工程数据里。
     * 能直接内嵌的格式（png / jpg / gif / webp）原样保留，绝不做二次压缩；
     * 其余格式（svg / bmp / avif / heic…）先画成 PNG 再内嵌。
     */
    private async resolveBaseSource(): Promise<ImageBase> {
        if (this.baseSource) return this.baseSource;
        const path = this.sourceAssetPath;
        if (!path) throw new Error("找不到原始图片");
        const blob = await getFileBlob(`data/${path}`);
        const mime = embeddableMime(path);
        if (mime) {
            this.baseSource = {
                dataUrl: bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), mime),
                width: this.naturalWidth || 1,
                height: this.naturalHeight || 1,
            };
            return this.baseSource;
        }
        const img = this.baseImage;
        if (!img) throw new Error("底图还没载入完成");
        const offscreen = document.createElement("canvas");
        offscreen.width = Math.max(1, this.naturalWidth);
        offscreen.height = Math.max(1, this.naturalHeight);
        offscreen.getContext("2d")?.drawImage(img, 0, 0, offscreen.width, offscreen.height);
        this.baseSource = {
            dataUrl: offscreen.toDataURL("image/png"),
            width: offscreen.width,
            height: offscreen.height,
        };
        return this.baseSource;
    }

    /**
     * 把「成品画面 + 可继续编辑的工程数据」写成一张 PNG，覆盖笔记里正在引用的资源。
     *
     * 这是参考插件 imgReEditor 的做法：文件就一个、路径不变、不写附档。
     * 因此改一百次也只会有这一张图，思源的资源管理能正常识别与清理；
     * 正文、双击看图、导出、手机端看到的是 PNG 里的成品，右键进插件时
     * 再从 tEXt 元数据里拆出完整原图与矢量标注继续改。
     *
     * 注意：v0.10.6~v0.10.10 曾改成「每次生成带内容指纹的新文件名」来绕开浏览器缓存，
     * 虽然解决了「保存后正文不刷新」，但会在资源里留下多余 PNG、并且在「没改任何东西
     * 直接保存」时把正文那张图弄成破图。用户确认后 v0.10.11 回到这里的单文件方案：
     * 覆盖同一个资源 + 给 img.src 加缓存串刷新（代价是双击看图可能定位不到，已知）。
     */
    private async writePackagedImage(): Promise<string> {
        const base = await this.resolveBaseSource();
        const layer = this.objectLayer;
        const image = this.baseImage;
        if (!layer || !image) throw new Error("编辑器还没准备好，无法保存图片");

        // 1) 所见即所得的成品位图
        const png = await exportFlatPng(image, layer, this.scene.canvas);
        // 2) 工程数据：完整原始底图 + 矢量标注 + 画布 / 裁剪窗口
        const scene: AnnotScene = {
            ...this.scene,
            canvas: {...this.scene.canvas, matrix: {...this.scene.canvas.matrix}},
            objects: this.scene.objects,
            assetPath: "",
        };
        const flat = await pngBytesOf(png);
        const packed = writePackage(flat, {
            version: PACKAGE_VERSION, base, scene,
        });

        // 3) 目标路径：PNG 直接覆盖原文件；其它格式首次换成一个固定的 -annot.png
        const current = this.target.assetPath || this.sourceAssetPath;
        if (!current) throw new Error("找不到图片资源路径");
        let assetPath = current;
        if (!/\.png$/i.test(current)) {
            const name = current.split("/").pop() || "image";
            const dir = current.slice(0, current.lastIndexOf("/") + 1);
            const stem = name.replace(/\.[^.]+$/, "").replace(/-annot$/, "");
            // 图文混排时绝不改笔记内容，直接覆盖原文件（PNG 字节浏览器按内容解码）
            assetPath = this.target.pureImage ? `${dir}${stem}-annot.png` : current;
        }
        const blob = new Blob([new Uint8Array(packed)], {type: "image/png"});
        await putFile(`data/${assetPath}`, blob, assetPath.split("/").pop() || "image.png");

        // 4) 路径没变就只刷新 img.src；宽度 / 图注 / 块属性 / 同段文字一概不动
        if (assetPath === current) {
            refreshImageSrc(current);
        } else {
            const blockId = this.scene.blockId || this.target.blockId;
            if (!blockId) throw new Error("找不到块 ID");
            await replaceBlockImage(blockId, assetPath, {
                width: this.target.displayWidth,
                alt: this.target.alt,
                title: this.target.title,
            });
        }
        return assetPath;
    }

    /**
     * 保存：把成品 + 工程数据写回同一张图片，不产生任何附档或新资源。
     *
     * 因为路径通常不变，连笔记内容都不用改，图文混排也安全；失败时保持编辑器
     * 打开，让用户能重试，绝不把没保存成功的标注悄悄丢掉。
     */
    private async saveAndClose(): Promise<void> {
        if (this.finished) return;
        if (this.linePolyline) this.finishLine();
        this.finishTextEdit();
        // 参考插件在保存前会先处理没确认的裁剪框（applyPendingCrop）：
        // 有框就应用；框被 Delete 清掉了就还原现场，别把临时铺开的完整原图存出去。
        if (this.cropMode) {
            if (this.cropRect) this.applyCrop();
            else this.cancelCrop();
        }
        this.scene.blockId = this.target.blockId;
        this.scene.viewport = {...this.viewport};
        reindexNumbers(this.scene.objects);
        this.scene.updatedAt = Date.now();
        this.scene.imageWidth = this.naturalWidth;
        this.scene.imageHeight = this.naturalHeight;

        const count = this.scene.objects.length;
        try {
            this.scene.assetPath = await this.writePackagedImage();
            // 通知文档预览层清掉旧缓存：新封装的图片天生带标注，不需要再叠一层
            notifySceneSaved(this.scene.blockId, this.scene.assetPath);
            // 全删光也照样保存（把空白成品写回去），提示别说成「0 个标注」
            const summary = count > 0 ? `${count} 个标注已保存。` : "标注已清空。";
            showMessage(`${summary}编辑信息单独记录，支持再次编辑。`, 4000, "info");
            this.close();
        } catch (error) {
            showMessage(`保存失败，编辑器保持打开以免丢失标注：${String(error)}`, 6000, "error");
        }
    }

    /** 导出 PNG：按画布尺寸合成底图 + 对象层，上传成新资源并插入当前笔记 */
    private setStatus(message: string, tone: "info" | "error" = "info"): void {
        if (!this.statusMessage || !this.hint) return;
        this.statusMessage.textContent = message;
        this.statusMessage.classList.toggle("annot-status__error", tone === "error");
        this.statusMessage.hidden = false;
        this.hint.hidden = true;
        if (this.statusTimer) {
            window.clearTimeout(this.statusTimer);
            this.statusTimer = null;
        }
        if (tone === "error") return;
        // 提示语只是临时占位，过一会儿把底栏中间还给当前工具提示
        this.statusTimer = window.setTimeout(() => {
            this.statusTimer = null;
            if (this.statusMessage) {
                this.statusMessage.textContent = "";
                this.statusMessage.hidden = true;
                this.statusMessage.classList.remove("annot-status__error");
            }
            if (this.hint) this.hint.hidden = false;
            this.updateHint();
        }, 2800);
    }

    private showError(message: string): void {
        this.root?.querySelector<HTMLElement>('[data-role="loading"]')?.remove();
        this.setStatus(message, "error");
    }

    // ---------------------------------------------------------------- 关闭清理
    public close(): void {
        if (this.finished) return;
        // 关闭前把当前样式记下来（用户可能只是拖了滑块就直接关窗，没触发过 change）
        saveCurrentStyle(this.current);
        const dialog = this.dialog;
        this.dialog = null;
        try {
            dialog?.destroy();
        } catch {
            // 对话框可能已被思源自身销毁
        }
        this.finish();
    }

    private finish(): void {
        if (this.finished) return;
        this.clearTouchHold();
        this.finished = true;
        // 关窗时必须先把窗口从系统全屏放出来，否则思源会一直停在全屏状态
        this.leaveNativeFullscreen();
        try {
            document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
            document.documentElement.classList.remove("annot-fs");
        } catch {
            // 宿主已销毁文档：忽略
        }
        this.fullscreen = false;
        // 不管从哪条路关窗（保存 / 取消 / 思源自己销毁对话框），都把当前样式记下来
        saveCurrentStyle(this.current);
        this.abort.abort();
        // 关窗时把识别 Worker 收掉：反复开关编辑器不该堆一串后台线程
        if (this.smartWorker) {
            try {
                this.smartWorker.terminate();
            } catch {
                // 已经终止过了
            }
            this.smartWorker = null;
        }
        this.cancelSmartTap();
        this.smartJobs.clear();
        this.smartBuffer = null;
        this.smartRegions = null;
        this.smartScanning = false;
        this.smartScanToken++;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.stopThemeWatch?.();
        this.stopThemeWatch = null;
        if (this.statusTimer) {
            window.clearTimeout(this.statusTimer);
            this.statusTimer = null;
        }
        this.textEditor?.remove();
        this.textEditor = null;
        this.textFrame?.remove();
        this.textFrame = null;
        this.refreshTextCaret = null;
        this.editingTextId = null;
        this.drag = null;
        this.draft = null;
        this.linePolyline = false;
        this.lineTouch = null;
        this.cropMode = false;
        this.cropRect = null;
        this.cropDragStart = null;
        this.cropSession = null;
        this.cropObjectsBackup = null;
        this.pickMode = false;
        this.selectedId = null;
        this.dialog = null;
        this.root?.remove();
        this.root = null;
        this.onClosed?.();
    }

    public getScene(): AnnotScene {
        return this.scene;
    }
}
