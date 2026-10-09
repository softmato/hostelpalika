// Close: three promises tick in, then three phones rise and fan out under the lockup.
import { words } from "./emit.mjs";

// opt: { promises: [3 Nepali phrases], ticks: [offsets into the trust line], shots: [3 stills], tagline, accent: [word idx] }
export function end(e, L, sc, vo, opt) {
  const t0 = sc.start, dur = sc.dur, big = L.W > L.H, r = e.r;
  const [trust, brand, cta] = vo;
  // 1. the promise — three ticks, one per sentence of the trust line
  const promises = opt.promises;
  const tks = opt.ticks.map((x) => trust.at + x);
  e.clip("promise", t0, brand.at - t0 + 0.2, `<div class="promise" style="${big ? "" : "flex-direction:column;"}">${promises.map((p, i) =>
    `<div class="pr" id="pr${i}"><img class="tkp" src="assets/png/check.png"><span class="np">${p}</span></div>`).join("")}</div>`, "full center");
  tks.forEach((t, i) => {
    e.code(`tl.fromTo("#pr${i}",{y:40,opacity:0,scale:.9},{y:0,opacity:1,scale:1,duration:.6,ease:"back.out(2)"},${r(t)}).fromTo("#pr${i} .tkp",{scale:0,rotation:-30},{scale:1,rotation:0,duration:.5,ease:"back.out(3)"},${r(t + 0.15)});`);
    e.sfx("success", t + 0.15, 0.22);
  });
  e.code(`tl.to("#promise .pr",{y:-30,opacity:0,filter:"blur(6px)",duration:.4,ease:"power2.in",stagger:.06},${r(brand.at - 0.45)});`);

  // 2. the brand, on the brand line
  const M = L.mini, sw = M.w - M.pad * 2, h = sw * (1640 / 720) + M.pad * 2;
  const shots = opt.shots;
  const gap = big ? M.w * 1.05 : M.w * 0.92;
  const minis = shots.map((s, i) => {
    const x = L.W / 2 + (i - 1) * gap - M.w / 2;
    return `<div class="mini" id="mini${i}" style="left:${x}px;top:${L.end.minisY}px;height:${h}px"><div class="frame"><div class="screen"><img src="assets/img/${s}.jpg"></div></div></div>`;
  }).join("");
  const B = brand.at - 0.15;
  e.clip("endWrap", B, t0 + dur - B, `<div class="full" style="perspective:1600px">${minis}</div>
  <div class="lockup" style="top:${L.end.lockY}px">
    <img id="emark" src="assets/img/logo-mark.png" style="height:${big ? 120 : 140}px">
    <img id="eword" src="assets/img/wordmark.png" style="height:${big ? 70 : 72}px;margin-top:22px;clip-path:inset(0 100% 0 0)">
    <div id="etag" class="np" style="margin-top:22px;font:700 ${big ? 50 : 56}px Mukta;color:#0d0f0e">${words(opt.tagline, opt.accent)}</div>
    <div style="margin-top:30px"><span class="url" id="eurl">hostelpalika.com</span></div>
  </div>`, "full");
  const rot = [-14, 0, 14], lift = [40, 0, 40];
  shots.forEach((_, i) => e.code(`tl.fromTo("#mini${i}",{y:${L.H * 0.5},rotation:0,opacity:0},{y:${lift[i]},rotation:${rot[i]},opacity:1,duration:1.1,ease:"expo.out"},${r(B + 0.2 + i * 0.12)});`));
  e.sfx("whoosh", B + 0.1, 0.2);
  e.code(`tl.fromTo("#emark",{scale:0,rotation:-20},{scale:1,rotation:0,duration:.7,ease:"back.out(1.8)"},${r(B)});
tl.to("#eword",{clipPath:"inset(0 0% 0 0)",duration:.6,ease:"power3.inOut"},${r(brand.at + 0.1)});
tl.fromTo("#etag .w",{yPercent:60,opacity:0},{yPercent:0,opacity:1,duration:.55,ease:"expo.out",stagger:.12},${r(brand.at + 1.1)});
tl.fromTo("#eurl",{y:20,opacity:0,scale:.9},{y:0,opacity:1,scale:1,duration:.55,ease:"back.out(2)"},${r(cta.at + 1.2)});
tl.to("#eurl",{scale:1.06,duration:.35,yoyo:true,repeat:1,ease:"sine.inOut"},${r(cta.at + 2.2)});`);
  e.sfx("shimmer", B, 0.28); e.sfx("pop", cta.at + 1.2, 0.22);
}
