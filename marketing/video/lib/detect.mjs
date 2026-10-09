// Where is the thing under a finger? Read one frame of the recording and flood-fill from the tap
// point over pixels of the component's own background colour; the filled region's box is the
// button / tile / field. Falls back to a plain box when the fill leaks into the page.
import { execFileSync } from "node:child_process";

const W = 720, H = 1640, cache = new Map();

function frame(file, t) {
  const k = `${file}@${t.toFixed(2)}`;
  if (!cache.has(k)) cache.set(k, execFileSync("ffmpeg", ["-v", "error", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1",
    "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: W * H * 4 }));
  return cache.get(k);
}

// returns [x, y, w, h] in recording px
export function componentBox(file, t, x, y, fallback = [200, 90]) {
  const px = frame(file, t), at = (i, j) => (j * W + i) * 3;
  x = Math.round(Math.min(W - 1, Math.max(0, x))); y = Math.round(Math.min(H - 1, Math.max(0, y)));
  // seed colour: the most common colour around the point (the background, not a glyph stroke)
  const bins = new Map();
  for (let j = -6; j <= 6; j++) for (let i = -6; i <= 6; i++) {
    const a = at(Math.min(W - 1, Math.max(0, x + i)), Math.min(H - 1, Math.max(0, y + j)));
    const key = ((px[a] >> 3) << 10) | ((px[a + 1] >> 3) << 5) | (px[a + 2] >> 3);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  const key = [...bins].sort((a, b) => b[1] - a[1])[0][0];
  const seed = [((key >> 10) & 31) << 3, ((key >> 5) & 31) << 3, (key & 31) << 3];
  const near = (a) => Math.abs(px[a] - seed[0]) + Math.abs(px[a + 1] - seed[1]) + Math.abs(px[a + 2] - seed[2]) < 40;
  // flood fill, but never further than a generous component from the point
  const lim = { x0: x - 330, x1: x + 330, y0: y - 220, y1: y + 220 };
  const seen = new Uint8Array(W * H), stack = [];
  let x0 = x, x1 = x, y0 = y, y1 = y, n = 0, leaked = false;
  // start from the nearest seed-coloured pixel to the point
  outer: for (let r = 0; r < 14; r++) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const a = at(x + i, y + j);
    if (x + i >= 0 && x + i < W && y + j >= 0 && y + j < H && near(a)) { stack.push([x + i, y + j]); break outer; }
  }
  while (stack.length) {
    const [i, j] = stack.pop(), id = j * W + i;
    if (seen[id]) continue;
    seen[id] = 1;
    if (!near(id * 3)) continue;
    if (i <= lim.x0 || i >= lim.x1 || j <= lim.y0 || j >= lim.y1) { leaked = true; continue; }
    n++; if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j;
    if (i > 0) stack.push([i - 1, j]); if (i < W - 1) stack.push([i + 1, j]);
    if (j > 0) stack.push([i, j - 1]); if (j < H - 1) stack.push([i, j + 1]);
  }
  const w = x1 - x0, h = y1 - y0;
  // leaked into the page, or a speck: use a plain box round the point
  if (leaked || w < 34 || h < 26 || n < 600) return [x - fallback[0] / 2, y - fallback[1] / 2, fallback[0], fallback[1]];
  return [x0 - 10, y0 - 10, w + 20, h + 20];
}
