/**
 * 一次性构建：Vite 产出 dist/index.js，然后把 public/ 下的静态资源
 * （plugin.json / index.css / i18n / icon.png ...）复制进 dist，
 * 使 dist 本身就是一个可以直接拷进思源插件目录的完整插件包。
 */
import {cp, mkdir, readdir, rm} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const distDir = path.join(root, "dist");

await build({configFile: path.join(root, "vite.config.ts")});
await mkdir(distDir, {recursive: true});
await cp(publicDir, distDir, {recursive: true});

// 清理 Vite 偶尔生成的空样式文件，避免插件包里出现多余内容
for (const name of await readdir(distDir)) {
    if (name.endsWith(".css") && name !== "index.css") {
        await rm(path.join(distDir, name), {force: true});
    }
}

console.log("[annotate] 构建完成 -> " + distDir);
