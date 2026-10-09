// Cut each phone scene's footage out of the 30fps recordings into one mp4, and map the
// logged touches into scene time so the composition can draw a finger where it happened.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const CFR = new URL("../assets/cfr/", import.meta.url);
const RAW = new URL("../assets/raw/clips/", import.meta.url);
export const CROP_TOP = 60; // Android status bar; the phone frame draws its own
const p = (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Z]:)/, "$1");

const probe = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

function touches(clip, lag) {
  const f = p(new URL(`${clip}.touches`, RAW));
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const [t, kind, ...n] = l.trim().split(/\s+/);
    const [x1, y1, x2, y2, ms] = n.map(Number);
    return kind === "tap" ? { t: +t + lag, kind, x1, y1 } : { t: +t + lag, kind, x1, y1, x2, y2, dur: ms / 1000 };
  });
}

// Retime the ranges so the scene's footage lasts `target` seconds; short footage holds its last frame.
// `film.dir` is the film project's URL (cuts land in its assets/video), `film.config` the file whose
// edits invalidate them, `film.lag` the adb touch lag.
export function buildScene(scene, target, film) {
  const out = p(new URL(`assets/video/${scene.id}.mp4`, film.dir));
  const raw = scene.segs.reduce((a, s) => a + (s.decimate ? 0 : (s.to - s.from) / s.speed), 0);
  if (raw > 0) {
    const k = raw / target;
    scene = { ...scene, segs: scene.segs.map((s) => ({ ...s, speed: Math.min(4, Math.max(0.75, s.speed * k)) })) };
  }
  const inputs = [], filters = [];
  scene.segs.forEach((s, i) => {
    inputs.push("-ss", String(s.from), "-to", String(s.to), "-i", p(new URL(`${s.clip}.mp4`, CFR)));
    const dec = s.decimate ? "mpdecimate=hi=64*12:lo=64*5:frac=0.33," : "";
    // blur boxes [x, y, w, h, fromSrc?, toSrc?] in recording px / source seconds (phone numbers on lists)
    let src = `[${i}:v]`;
    (s.blur || []).forEach(([x, y, w, h, a = s.from, b = s.to], j) => {
      const en = `between(t,${(a - s.from).toFixed(2)},${(b - s.from).toFixed(2)})`;
      filters.push(`${src}split[b${i}_${j}a][b${i}_${j}b];[b${i}_${j}b]crop=${w}:${h}:${x}:${y},boxblur=8:3:4:3[b${i}_${j}c];[b${i}_${j}a][b${i}_${j}c]overlay=${x}:${y}:enable='${en}'[b${i}_${j}]`);
      src = `[b${i}_${j}]`;
    });
    filters.push(`${src}${dec}setpts=(N/30/TB)/${s.speed},crop=720:1640-${CROP_TOP}:0:${CROP_TOP},fps=30[v${i}]`);
  });
  const fresh = existsSync(out) && statSync(out).mtimeMs > statSync(film.config).mtimeMs
    && Math.abs(probe(out) - target) < 0.05;
  if (!fresh) {
    const concat = scene.segs.map((_, i) => `[v${i}]`).join("") + `concat=n=${scene.segs.length}:v=1:a=0,tpad=stop_mode=clone:stop_duration=${target}[out]`;
    execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", [...filters, concat].join(";"),
      "-map", "[out]", "-t", String(target), "-c:v", "libx264", "-crf", "15", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
  }
  const videoDur = probe(out);

  // touches: only for plain (non-decimated) ranges, where source time maps linearly
  const marks = [];
  let offset = 0;
  for (const s of scene.segs) {
    const len = s.decimate ? null : (s.to - s.from) / s.speed;
    if (!s.decimate) for (const t of touches(s.clip, film.lag)) {
      if (t.t < s.from || t.t > s.to) continue;
      marks.push({ ...t, t: offset + (t.t - s.from) / s.speed, dur: t.dur ? t.dur / s.speed : undefined, clip: s.clip, src: t.t });
    }
    offset += len ?? videoDur - offset; // a decimated range is always a scene's only range
  }
  // scene time of a moment in a source clip (first plain range that holds it)
  const ranges = [];
  let off = 0;
  for (const s of scene.segs) { if (!s.decimate) ranges.push({ ...s, off }); off += s.decimate ? 0 : (s.to - s.from) / s.speed; }
  const srcAt = (clip, t) => { const r = ranges.find((r) => r.clip === clip && t >= r.from && t <= r.to); return r ? r.off + (t - r.from) / r.speed : 0; };
  const toSrc = (local) => { const r = ranges.find((r) => local >= r.off && local < r.off + (r.to - r.from) / r.speed) || ranges[ranges.length - 1];
    return [r.clip, Math.min(r.to, r.from + (local - r.off) * r.speed)]; };
  const cfr = (clip) => p(new URL(`${clip}.mp4`, CFR));
  return { file: `assets/video/${scene.id}.mp4`, videoDur, touches: marks, srcAt, toSrc, cfr };
}
