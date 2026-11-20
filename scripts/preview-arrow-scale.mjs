/** 不同线宽下箭头尺寸的对照图（按 2px 为基准），用来核对视觉重量 */
import {build} from "esbuild";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(path.join(tmpdir(), "annot-scale-"));
const bundle = path.join(dir, "geo.mjs");
await build({
    entryPoints: [path.join(root, "src/editor/arrowGeometry.ts")],
    bundle: true, format: "esm", outfile: bundle, logLevel: "silent",
});
const {arrowShape} = await import(pathToFileURL(bundle).href);

const WIDTHS = [2, 4, 6, 8, 12];
const HEADS = [["基础", "basic"], ["燕尾", "classic"], ["开放", "open"], ["菱形", "rhombus"], ["圆形", "circle"]];

const render = (head, w) => {
    const start = {x: 6, y: 40};
    const end = {x: 170, y: 40};
    const shape = arrowShape({start, end, control: null}, {type: "single", head}, w);
    const parts = [];
    if (shape.shaft) {
        parts.push(`<path d="${shape.shaft}" fill="${shape.shaftFilled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`);
    }
    for (const h of shape.heads) {
        parts.push(`<path d="${h.d}" fill="${h.fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="${w}" stroke-miterlimit="10" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    const box = 200;
    return `<svg viewBox="0 0 ${box} 80" width="${box}" height="80">${parts.join("")}</svg>`;
};

const rows = HEADS.map(([label, head]) =>
    `<div class="row"><span class="lbl">${label}</span>` +
    WIDTHS.map((w) => `<div class="cell"><div class="art">${render(head, w)}</div><span>${w}px</span></div>`).join("") +
    `</div>`).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:14px;background:#1f2225;color:#e6e6e6;font:12px system-ui,sans-serif}
.row{display:flex;align-items:flex-end;gap:8px;margin-bottom:6px}
.lbl{width:44px;color:#9aa0a6}
.cell{display:flex;flex-direction:column;align-items:center;gap:2px}
.art{background:#24282c;border-radius:4px}
span{color:#9aa0a6;font-size:11px}
</style>${rows}`;

await writeFile(path.join(root, "_tools/arrow-scale.html"), html);
await rm(dir, {recursive: true, force: true});
console.log("已生成 _tools/arrow-scale.html");
