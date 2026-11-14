import {writeFile} from "node:fs/promises";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, {resolve, reject}); ws.send(JSON.stringify({id: i, method, params})); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + JSON.stringify(r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
};
const OUT = "D:/WorkBuddy/siyuan-plugin/siyuan-plugin-annotate/deliverables/color-wheel-prototype";
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {width: 1240, height: 1000, deviceScaleFactor: 2, mobile: false});
await send("Page.navigate", {url: "file:///D:/WorkBuddy/siyuan-plugin/siyuan-plugin-annotate/deliverables/color-wheel-prototype/index.html"});
for (let i = 0; i < 40; i++) { if (await evaluate("document.querySelector('#pickerPhone .wheel')?.getBoundingClientRect().width")) break; await sleep(100); }
await sleep(400);
const info = await evaluate(`(() => {
  const rect = (sel, pad = 12) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return [Math.round(b.left - pad), Math.round(b.top - pad), Math.round(b.right + pad), Math.round(b.bottom + pad)];
  };
  return {
    pageH: document.documentElement.scrollHeight,
    light: rect('#pickerLight'),
    dark: rect('#pickerDark'),
    phone: rect('.phone', 10),
    mock: rect('.mock'),
    counts: {
      pickers: document.querySelectorAll('.picker').length,
      alphaEls: document.querySelectorAll('.alpha, .alpha-num').length,
      readoutBoxes: document.querySelectorAll('#pickerLight .readout').length,
      segButtons: document.querySelectorAll('.seg > button').length,
      rgbInputs: document.querySelectorAll('.rgb-cell > input').length,
    },
  };
})()`);
console.log(JSON.stringify(info.counts), "pageH", info.pageH);
const shot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: true,
  clip: {x: 0, y: 0, width: 1240, height: Math.min(2200, info.pageH), scale: 2}});
await writeFile(`${OUT}/原型-总览.png`, Buffer.from(shot.data, "base64"));
const crops = [["原型-浅色.png", info.light], ["原型-深色.png", info.dark], ["原型-移动端.png", info.phone]];
const {execFileSync} = await import("node:child_process");
for (const [name, box] of crops) {
  execFileSync("python", ["-c", `
from PIL import Image
im = Image.open(r"${OUT}/原型-总览.png")
k = im.size[0] / 1240.0
im.crop(tuple(int(v * k) for v in ${JSON.stringify(box)})).save(r"${OUT}/${name}")
`]);
  console.log("crop", name, box);
}
ws.close();
