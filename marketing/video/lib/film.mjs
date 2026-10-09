// Shared film pipeline: time the scenes, run each film's sections, lay subtitles, the brand bug,
// the audio mix (voice, ducked music bed, sound cues on free lanes) and write index.html.
//
// makeFilm({
//   fmt, scenes, tail, lag,              // config
//   dir, config, outDir, voDirs, title,  // URLs: film project, its config file, where index.html goes
//   layout?: (L) => L,                   // per-film geometry tweaks
//   sections(e, L, S, timed),            // the film's own scenes (cold/hook/phones/end…)
//   ambient?: (e, L, S, total) => "js",  // extra lines for the ambient block
//   css?: (L) => "css", dark?: bool, bgHtml?: "html", music?: "music_film",
// })
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildScene } from "./segments.mjs";
import { layouts } from "./layout.mjs";
import { css as baseCss } from "./styles.mjs";
import { emitter, words } from "./emit.mjs";

const path = (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Z]:)/, "$1");
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

export function makeFilm(o) {
  const { fmt } = o;
  const L = o.layout ? o.layout(structuredClone(layouts[fmt]), fmt) : layouts[fmt];
  const asset = (rel) => path(new URL(`assets/${rel}`, o.dir));
  const voLen = (f) => probe(asset(`audio/${f}.mp3`));
  const voText = (f) => {
    for (const d of o.voDirs) {
      const hit = [`${f}.txt`, `${f.replace(/_(sunita|bishnu)$/, "")}_sunita.txt`].map((n) => path(new URL(n, d))).find(existsSync);
      if (hit) return readFileSync(hit, "utf8").replace(/\[[^\]]*\]\s*/g, "").trim(); // emotion tags are for the voice only
    }
    return "";
  };

  // 1. timeline — phone scenes last as long as their line
  let t = 0;
  const timed = o.scenes.map((sc) => {
    const vo = (sc.vo || []).map((v) => ({ ...v, len: voLen(v.file) }));
    const d = sc.dur ?? Math.round((Math.max(...vo.map((v) => v.at + v.len)) + o.tail) * 30) / 30;
    const extra = sc.segs ? buildScene(sc, d, { dir: o.dir, config: o.config, lag: o.lag }) : {};
    const out = { ...sc, ...extra, start: t, dur: d, vo: vo.map((v) => ({ ...v, at: t + v.at })) };
    t += d;
    return out;
  });
  const total = Math.round(t * 100) / 100;
  const S = Object.fromEntries(timed.map((s) => [s.id, s]));

  // 2. scenes
  const e = emitter();
  o.sections(e, L, S, timed);
  const phones = timed.filter((s) => s.kind === "phone");

  // subtitles for every narrated line marked `sub`
  timed.flatMap((sc) => sc.vo.filter((v) => v.sub).map((v) => ({ ...v, kind: sc.kind }))).forEach((v, i) => {
    const text = v.text ?? voText(v.file), n = text.split(" ").length;
    const pos = v.kind === "phone" ? "" : `left:${L.W * 0.08}px;width:${L.W * 0.84}px;text-align:center;top:${L.H * 0.86}px`;
    e.clip(`sub${i}`, v.at - 0.05, v.len + 0.45, `<div class="sub" style="${pos}"><span class="box">${words(text)}</span></div>`, "full");
    e.code(`tl.fromTo("#sub${i} .box",{y:16,opacity:0},{y:0,opacity:1,duration:.35,ease:"power3.out"},${e.r(v.at - 0.05)});`);
    for (let k = 0; k < n; k++)
      e.code(`tl.fromTo("#sub${i} .w:nth-child(${k + 1})",{opacity:.25},{opacity:1,duration:.2},${e.r(v.at + (v.len * 0.95 * k) / n)});`);
    e.code(`tl.to("#sub${i} .box",{opacity:0,y:-10,duration:.25},${e.r(v.at + v.len + 0.15)});`);
  });

  // brand bug in the corner while the product is on screen
  const bugFrom = phones[0].start - 0.3, bugTo = S.end.start;
  e.clip("bug", bugFrom, bugTo - bugFrom, `<div class="bug"><img class="m" src="assets/img/logo-mark.png"><img class="w" src="assets/img/wordmark.png"></div>`, "full");
  e.code(`tl.fromTo("#bug .bug",{opacity:0,x:-16},{opacity:1,x:0,duration:.6,ease:"expo.out"},${e.r(bugFrom + 0.6)});
tl.to("#bug .bug",{opacity:0,duration:.3},${e.r(bugTo - 0.4)});`);

  // 3. audio: voice, a music bed that dips under it, sound cues
  const vo = timed.flatMap((sc) => sc.vo);
  const audio = vo.map((v, i) => `<audio id="vo${i}" src="assets/audio/${v.file}.mp3" data-start="${e.r(v.at)}" data-duration="${e.r(v.len)}" data-track-index="10" data-volume="1.15"></audio>`);
  const BED = o.bed ?? 0.9, DUCK = o.duck ?? 0.5;
  const pts = [{ t: 0, v: BED }];
  for (const v of vo) pts.push({ t: v.at - 0.2, v: BED }, { t: v.at + 0.05, v: DUCK }, { t: v.at + v.len, v: DUCK }, { t: v.at + v.len + 0.35, v: BED });
  pts.push({ t: total - 1.6, v: BED }, { t: total, v: 0 });
  const clean = pts.sort((a, b) => a.t - b.t).filter((p, i, a) => !a[i + 1] || a[i + 1].t - p.t > 0.05).map((p) => ({ t: e.r(Math.max(0, p.t)), v: p.v }));
  audio.push(`<audio id="music" src="assets/audio/${o.music ?? "music_film"}.mp3" data-start="0" data-duration="${total}" data-track-index="11" data-volume="1" data-automation='${JSON.stringify({ version: 1, lanes: [{ target: "volume", points: clean }] })}'></audio>`);
  const sfxDur = (n) => probe(asset(`sfx/${n}.mp3`));
  const lanes = []; // each cue takes the first lane free when it starts
  e.cues.sort((a, b) => a.t - b.t).forEach((c, i) => {
    const t0 = Math.max(0, c.t), d = e.r(sfxDur(c.name)), lane = lanes.findIndex((x) => x <= t0 + 0.001);
    const k = lane < 0 ? lanes.push(0) - 1 : lane;
    lanes[k] = t0 + d;
    audio.push(`<audio id="fx${i}" src="assets/sfx/${c.name}.mp3" data-start="${t0}" data-duration="${d}" data-track-index="${20 + k}" data-volume="${c.vol}"></audio>`);
  });

  // 4. ambient light
  e.code(`tl.fromTo("#beam1",{x:${-L.W * 0.25}},{x:${L.W * 0.25},duration:${total},ease:"none"},0);
tl.fromTo("#beam2",{x:${L.W * 0.2}},{x:${-L.W * 0.2},duration:${total},ease:"none"},0);
tl.fromTo("#glow1",{x:${L.W * 0.55},y:${-L.H * 0.2}},{x:${L.W * 0.15},y:${L.H * 0.45},duration:${total},ease:"sine.inOut"},0);${o.ambient ? "\n" + o.ambient(e, L, S, total) : ""}`);

  const html = `<!doctype html>
<html lang="ne"><head><meta charset="UTF-8"><meta name="viewport" content="width=${L.W}, height=${L.H}">
<title>${o.title}</title><script src="assets/js/gsap.min.js"></script><style>${baseCss(L)}${o.css ? o.css(L) : ""}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-width="${L.W}" data-height="${L.H}" data-duration="${total}">
<div id="bg"><div class="beam" id="beam1"></div><div class="beam" id="beam2"></div><div class="glow" id="glow1"></div>${o.bgHtml ?? ""}</div>
${o.dark ? `<div id="dark"></div>\n` : ""}${e.html.join("\n")}
<div id="grain"></div>
${audio.join("\n")}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${e.js.join("\n")}
window.__timelines["main"] = tl;
</script></body></html>`;

  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(new URL("index.html", o.outDir), html);
  console.log(`${fmt}: ${total}s, ${phones.length} phone scenes, ${e.cues.length} sound cues, ${vo.length} voice lines`);
  for (const s of timed) console.log(`  ${s.id.padEnd(11)} ${s.start.toFixed(2).padStart(6)} → ${(s.start + s.dur).toFixed(2)}`);
  return { L, S, timed, total };
}
