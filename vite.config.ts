import {defineConfig} from "vite";
import {fileURLToPath} from "node:url";

/**
 * 思源插件的加载器（app/src/plugin/loader.ts）用 window.eval 包一层 CommonJS：
 *   (function anonymous(require, module, exports){ <index.js> })
 * 所以产物必须是 CJS，且 `siyuan` 必须外置成 require("siyuan")。
 * CSS 不在这里打包：public/index.css 会被原样复制到 dist/index.css，
 * 由内核 loadCode() 读取并注入 <style id="pluginsStyle{name}">。
 */
export default defineConfig({
    build: {
        target: "es2018",
        outDir: "dist",
        emptyOutDir: true,
        minify: false,
        cssCodeSplit: false,
        lib: {
            entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["siyuan"],
            output: {
                exports: "named",
                // 避免 Rollup 生成 ESM 专属的 import.meta 或动态 import
                generatedCode: "es5",
            },
        },
    },
});
