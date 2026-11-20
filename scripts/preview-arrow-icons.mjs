/** 把箭头类型/端点图标渲染成一张 HTML，方便肉眼核对（打包前自查用） */
import {build} from "esbuild";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "annot-icons-"));
const bundle = path.join(dir, "icons.mjs");
await build({
    entryPoints: [path.join(root, "src/editor/icons.ts")],
    bundle: true, format: "esm", outfile: bundle, logLevel: "silent",
});
const {ARROW_TYPE_ICONS, ARROW_HEAD_ICONS} = await import(pathToFileURL(bundle).href);

const cell = (label, svg, chip) => chip
    ? `<div class="cell"><div class="chip">${svg}</div><span>${label}</span></div>`
    : `<div class="btnrow"><span>${label}</span><div class="btn">${svg}</div></div>`;

const types = [["单头", "single"], ["双头", "double"], ["尖尾", "modern"], ["两端竖线", "bar"]];
const heads = [["无箭头", "none"], ["基础", "basic"], ["开放", "open"], ["燕尾", "classic"], ["菱形", "rhombus"], ["圆形", "circle"]];

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:18px;background:#1f2225;color:#e6e6e6;font:13px/1.4 system-ui,sans-serif}
h3{margin:12px 0 8px;font-size:12px;font-weight:600;color:#9aa0a6;letter-spacing:.08em}
.row{display:flex;gap:10px;align-items:flex-end}
.col{display:flex;flex-direction:column;gap:3px}
.btnrow{display:flex;align-items:center;gap:12px;background:#24282c;border-radius:6px;padding:2px 6px;width:200px;justify-content:space-between}
.btn{width:200px;height:26px;display:flex;align-items:center;gap:14px;padding:0 8px}
.chip{width:34px;height:26px;display:grid;place-items:center;border:1px solid #3a3f44;border-radius:6px;background:#24282c}
.cell{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:46px}
span{font-size:11px;color:#9aa0a6}
svg{width:30px;height:13px;display:block}
.big svg{width:120px;height:72px}
.zoom .cell{width:130px}
.btn svg{width:46px;height:20px}
</style>
<h3>箭头类型（下拉里 / 4 项，整条长箭头）</h3><div class="col">
${types.map(([l, k]) => cell(l, ARROW_TYPE_ICONS[k], false)).join("")}
</div>
<h3>端点样式（横排 / 6 格，只画箭头端一小段）</h3><div class="row">
${heads.map(([l, k]) => cell(l, ARROW_HEAD_ICONS[k], true)).join("")}
</div>
<h3>放大 4 倍（只放样式格）</h3><div class="row zoom">
${heads.map(([l, k]) => `<div class="cell"><div class="big">${ARROW_HEAD_ICONS[k]}</div><span>${l}</span></div>`).join("")}
</div>`;

await writeFile(path.join(root, "_tools/arrow-icons.html"), html);
await rm(dir, {recursive: true, force: true});
console.log("已生成 _tools/arrow-icons.html");
