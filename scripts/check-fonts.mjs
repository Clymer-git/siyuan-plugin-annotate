/**
 * 字体模块的单元测试（纯 Node）。
 *
 * 覆盖：默认档渲染成具体字体栈（导出才不会丢）、字体名包装、老档位键兼容、
 * 系统字体度量探测、导出时字体变量解析、上传目录不可用时不崩。
 *
 * 用法：node scripts/check-fonts.mjs
 */
import {writeFileSync, mkdirSync} from "node:fs";
import {pathToFileURL} from "node:url";
import path from "node:path";
import {build} from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outPath = path.join(root, "_tools/fonts.mjs");
const stubPath = path.join(root, "_tools/platform-stub.mjs");
mkdirSync(path.dirname(outPath), {recursive: true});

// 字体模块要 import 思源的文件接口，这里换成 stub，测纯逻辑不受影响
writeFileSync(stubPath, `export async function getFileBlob() { throw new Error("no fs"); }
export async function putFile() {}
export async function readDir() { return []; }
export async function removeFile() {}
`);

await build({
    entryPoints: [path.join(root, "src/editor/fonts.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: outPath,
    logLevel: "silent",
    plugins: [{
        name: "stub-platform",
        setup(build) {
            build.onResolve({filter: /\/platform$/}, () => ({path: stubPath}));
        },
    }],
});

const {fontStackOf, detectSystemFonts, inlineFontVars, defaultFontLabel,
    buildFontFaceCss, loadUploadedFonts, isUploadedFont, queryLocalFonts,
    uploadFontFile} = await import(pathToFileURL(outPath).href);

let failed = 0;
const check = (name, ok, detail = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

// 1) 默认档：必须是具体字体栈（留着 var() 导出就会丢字体）
{
    const stack = fontStackOf("");
    check("默认档渲染成具体字体栈（不含 var）", !stack.includes("var("), stack);
    check("默认档有可用兜底", /sans-serif|system-ui/.test(stack), stack);
    check("缺省值与空串一致", fontStackOf(undefined) === stack);
    check("默认档标签以「默认」开头", /^默认/.test(defaultFontLabel()), defaultFontLabel());
}

// 2) 具体字体名：包引号 + 兜底
{
    check("字体名包成带兜底的栈", fontStackOf("KaiTi") === '"KaiTi", system-ui, sans-serif', fontStackOf("KaiTi"));
    check("上传字体（Annot- 前缀）同样处理",
        fontStackOf("Annot-1a2b3c4d") === '"Annot-1a2b3c4d", system-ui, sans-serif');
    check("完整字体栈原样透传",
        fontStackOf('"Noto Sans SC", sans-serif') === '"Noto Sans SC", sans-serif');
}

// 3) 老数据兼容：以前的档位键还能给对的字体
{
    check("老 key code 仍走等宽", /monospace/.test(fontStackOf("code")), fontStackOf("code"));
    check("老 key kai 仍是楷体", /Kai/.test(fontStackOf("kai")), fontStackOf("kai"));
    check("老 key sans / serif 仍可用",
        /sans-serif/.test(fontStackOf("sans")) && /serif/.test(fontStackOf("serif")));
}

// 4) 系统字体探测：伪装 canvas，只有 KaiTi 改变宽度
{
    const fakeCtx = {
        font: "",
        measureText() {
            return {width: /KaiTi/.test(this.font) ? 107.5 : 100};
        },
    };
    globalThis.document = {createElement: () => ({getContext: () => fakeCtx})};
    const fresh = await import(pathToFileURL(outPath).href + "?probe=" + Date.now());
    const list = fresh.detectSystemFonts();
    const families = list.map((item) => item.family);
    check("度量法只认装了的字体", families.includes("KaiTi"), families.join(",") || "空");
    check("没装的不误报", !families.includes("Arial"));
    check("系统字体用中文名显示（楷体）",
        list.find((item) => item.family === "KaiTi")?.label === "楷体",
        list.find((item) => item.family === "KaiTi")?.label ?? "无");
    delete globalThis.document;
}

// 4b) 本地字体接口：本地化全名优先（中文），英文族名只做兜底
{
    globalThis.window = {
        queryLocalFonts: async () => [
            {family: "Microsoft YaHei", fullName: "微软雅黑"},
            {family: "Arial", fullName: "Arial"},
            {family: "Source Han Sans SC", fullName: ""},
        ],
    };
    const fresh = await import(pathToFileURL(outPath).href + "?local=" + Date.now());
    const list = await fresh.queryLocalFonts();
    check("本地字体接口返回带中文名的条目",
        list.find((item) => item.family === "Microsoft YaHei")?.label === "微软雅黑",
        JSON.stringify(list.map((i) => [i.family, i.label])));
    check("英文名原样显示", list.find((item) => item.family === "Arial")?.label === "Arial");
    check("没有本地化名时用映射表补中文",
        list.find((item) => item.family === "Source Han Sans SC")?.label === "思源黑体",
        list.find((item) => item.family === "Source Han Sans SC")?.label ?? "无");
    check("渲染用的仍是英文族名",
        fresh.fontStackOf("Microsoft YaHei") === '"Microsoft YaHei", system-ui, sans-serif',
        fresh.fontStackOf("Microsoft YaHei"));
    delete globalThis.window;
}

// 5) 导出：字体变量解析，具体字体名保留
{
    const markup =
        '<text font-family="var(--b3-font-family, system-ui, sans-serif)">正文</text>' +
        '<text font-family="&quot;Kaiti SC&quot;, KaiTi, serif">楷体</text>';
    const out = inlineFontVars(markup);
    check("导出后不再残留 var(--b3-font-family)", !out.includes("var(--b3-font-family"), out.slice(0, 50));
    check("导出后具体字体名原样保留", out.includes("Kaiti SC"));
    check("导出结果没有裸引号破坏属性", (out.match(/font-family="[^"]*"/g) || []).length === 2);
}

// 6) 上传目录不可用时不能崩
{
    let ok = true;
    let list = null;
    try {
        list = await loadUploadedFonts();
    } catch {
        ok = false;
    }
    check("上传目录读不到时返回空列表而不是报错", ok && Array.isArray(list) && list.length === 0);
    check("没有上传字体时导出的字体 CSS 为空", (await buildFontFaceCss(["Arial"])) === "");
    check("系统字体不会被当成上传字体", !isUploadedFont("Arial"));
}

// 7) 上传格式校验：明确告诉用户哪里不对
{
    const attempt = async (name, bytes) => {
        try {
            await uploadFontFile(new File([new Uint8Array(bytes)], name));
            return "";
        } catch (error) {
            return error?.message ?? "";
        }
    };
    check("ttc 被拒绝并说明支持哪些格式",
        /ttf、otf、woff、woff2/.test(await attempt("font.ttc", [1, 2, 3])));
    check("非字体扩展名被拒绝", /只支持/.test(await attempt("photo.png", [1, 2, 3])));
    check("空文件被拒绝", /空的/.test(await attempt("font.ttf", [])));
    check("读不出来的字体被拒绝", /读不出/.test(await attempt("broken.ttf", [1, 2, 3, 4])));
}

console.log(`\n字体模块：${failed === 0 ? "全部通过" : failed + " 条失败"}`);
process.exit(failed > 0 ? 1 : 0);
