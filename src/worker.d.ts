/**
 * Vite 的 Worker 导入类型声明。
 *
 * 用 `?worker&inline` 而不是 `?worker`：内联会把 Worker 代码打成 base64 塞进
 * index.js，插件包仍然是「一个 index.js」的结构，不会多出一个必须一起分发的
 * worker.js（思源集市只发 index.js + index.css，多文件会漏）。
 */
declare module "*?worker&inline" {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}
