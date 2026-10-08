// node ui.mjs find "<text>" [index]  -> prints "x y" centre of the nth node whose text/desc contains <text>
// node ui.mjs list                     -> prints every labelled node with its centre
import { execFileSync } from "node:child_process";

const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
execFileSync("adb", ["shell", "uiautomator", "dump", "/sdcard/ui.xml"], { env, stdio: "ignore" });
const xml = execFileSync("adb", ["exec-out", "cat", "/sdcard/ui.xml"], { env }).toString("utf8");

const nodes = [...xml.matchAll(/<node [^>]*>/g)].map(([n]) => {
  const a = (k) => (n.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || "";
  const [x1, y1, x2, y2] = a("bounds").match(/\d+/g).map(Number);
  return { label: a("text") || a("content-desc"), x: (x1 + x2) >> 1, y: (y1 + y2) >> 1 };
}).filter((n) => n.label);

const [cmd, text, idx = "0"] = process.argv.slice(2);
if (cmd === "centroid") { // centroid of on-screen nodes matching any of a|b|c
  const re = new RegExp(text, "i"), hits = nodes.filter((n) => re.test(n.label) && n.label.length < 45 && n.x > 0 && n.y > 0);
  if (!hits.length) { console.error("no hits"); process.exit(1); }
  console.log(Math.round(hits.reduce((a, n) => a + n.x, 0) / hits.length), Math.round(hits.reduce((a, n) => a + n.y, 0) / hits.length));
} else if (cmd === "empty") { // nearest point to (x,y)=text "x,y" at least 75px from every node label
  const [cx, cy] = text.split(",").map(Number), pts = nodes.filter((n) => n.label.length < 45 && n.x > 0 && n.y > 300 && n.y < 1450);
  for (let r = 0; r < 400; r += 15) for (let a = 0; a < 360; a += 30) {
    const x = Math.round(cx + r * Math.cos(a * Math.PI / 180)), y = Math.round(cy + r * Math.sin(a * Math.PI / 180));
    if (pts.every((n) => Math.hypot(n.x - x, n.y - y) > 75)) { console.log(x, y); process.exit(0); }
  }
  console.log(cx, cy);
} else if (cmd === "spread") { // vertical spread (px) of on-screen nodes matching a|b|c
  const re = new RegExp(text, "i"), ys = nodes.filter((n) => re.test(n.label) && n.label.length < 45 && n.y > 0).map((n) => n.y);
  console.log(ys.length ? Math.max(...ys) - Math.min(...ys) : 0);
} else if (cmd === "list") for (const n of nodes) console.log(n.x, n.y, JSON.stringify(n.label));
else {
  const hits = nodes.filter((n) => n.label.toLowerCase().includes(text.toLowerCase()));
  const hit = hits[Number(idx)];
  if (!hit) { console.error(`not found: ${text}`); process.exit(1); }
  console.log(hit.x, hit.y);
}
