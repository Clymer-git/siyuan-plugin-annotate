/**
 * 撤销 / 重做：基于「整份编辑器状态快照」，不存画布像素。
 *
 * v0.7.0 起快照里除了对象数组，还带上了画布状态（尺寸 + 底图矩阵）：
 * 旋转 90°、翻转、裁切、扩展画布都会改变画布，如果只存对象，
 * 撤销之后对象会搬回旧坐标、画布却还是新的，标注立刻错位。
 * 因此这里把「对象 + 画布」当作一个不可分割的状态一起入栈。
 *
 * 一次连续拖拽只在 pointerup 时提交一次，选择态不入栈。
 */

import type {AnnotObject, CanvasState} from "../types";

const MAX_STEPS = 100;

export interface EditorSnapshot {
    objects: AnnotObject[];
    canvas: CanvasState;
}

function clone(snapshot: EditorSnapshot): EditorSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as EditorSnapshot;
}

function same(a: EditorSnapshot, b: EditorSnapshot): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export class EditorHistory {
    private stack: EditorSnapshot[];
    private cursor = 0;

    constructor(initial: EditorSnapshot) {
        this.stack = [clone(initial)];
    }

    /** 从 sidecar 还原场景后重置历史：撤销的起点是「刚打开时」，而不是空白画布 */
    reset(snapshot: EditorSnapshot): void {
        this.stack = [clone(snapshot)];
        this.cursor = 0;
    }

    /** 提交一次新状态；与当前状态相同则忽略，避免点一下手柄没动也产生一步历史 */
    commit(snapshot: EditorSnapshot): void {
        const next = clone(snapshot);
        if (same(next, this.stack[this.cursor])) return;
        // 在历史中途产生新操作时，丢弃原来的重做分支
        this.stack.length = this.cursor + 1;
        this.stack.push(next);
        if (this.stack.length > MAX_STEPS) this.stack.shift();
        this.cursor = this.stack.length - 1;
    }

    undo(): EditorSnapshot | null {
        if (this.cursor <= 0) return null;
        this.cursor--;
        return clone(this.stack[this.cursor]);
    }

    redo(): EditorSnapshot | null {
        if (this.cursor >= this.stack.length - 1) return null;
        this.cursor++;
        return clone(this.stack[this.cursor]);
    }

    get canUndo(): boolean {
        return this.cursor > 0;
    }

    get canRedo(): boolean {
        return this.cursor < this.stack.length - 1;
    }
}
