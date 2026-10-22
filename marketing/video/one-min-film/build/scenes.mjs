// The owner film's own scenes (v4): the moving white/lavender/mint background, the fire → app-glimpse
// hook, the problem chip, the student's phone filling the Form QR, the step-by-step start panel, the
// web portal, the owner at ease and the close. Veo clips live in assets/veo/.
import { existsSync } from "node:fs";
import { words, chars } from "../../lib/emit.mjs";
import { chapter } from "../../lib/phone.mjs";
import { extrasAnim as adminExtras, hideCopy } from "../../admin-film/build/extras.mjs";

const veo = (name) => existsSync(new URL(`../assets/veo/${name}.mp4`, import.meta.url));
// a top-level Veo video (the renderer can't time media nested inside another timed element)
const vid = (e, id, src, t, dur, from = 0, cls = "", style = "", track = 2) =>
  e.add(`<video id="${id}" class="clip fullv ${cls}" src="assets/veo/${src}.mp4" muted playsinline data-start="${e.r(t)}" data-duration="${e.r(dur)}" data-media-start="${from}" data-track-index="${track}" style="${style}"></video>`);
const TICK = `<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// smoke_wipe is a plume from the left on black; turned upright it rises from the bottom of the frame.
// Screen-blended it shows over dark footage and fills to white at `peak`; the white beneath takes the cut.
function smokeRise(e, id, peak, until, veil = true) {
  if (!veo("smoke_wipe")) return;
  const s = peak - 1.25; // starts on a plume already rolling, so it fills fast and keeps its texture
  vid(e, id, "smoke_wipe", s, until - s, 2.3, "screen-blend", "z-index:7;pointer-events:none", 4);
  e.code(`tl.fromTo("#${id}",{rotation:-90,scale:1.95,yPercent:24,opacity:.85},{yPercent:-12,scale:2.3,opacity:1,duration:${e.r(until - s)},ease:"power1.out"},${e.r(s)});`);
  if (veil) {
    e.clip(`${id}w`, peak - 0.55, 1.5, `<div style="position:absolute;inset:0;background:radial-gradient(120% 100% at 50% 60%,#fff 45%,#f3efff 100%)"></div>`, "full", "z-index:8");
    e.code(`tl.fromTo("#${id}w",{opacity:0},{opacity:1,duration:.55,ease:"power2.in"},${e.r(peak - 0.55)});
tl.to("#${id}w",{opacity:0,duration:.8,ease:"power2.out"},${e.r(peak + 0.12)});`);
  }
  e.sfx("whoosh", s + 0.25, 0.32); e.sfx("rise", peak - 1.15, 0.24);
}
const shake = (e, sel, t, a = 12) =>
  e.code(`tl.fromTo("${sel}",{x:0,y:0},{keyframes:[{x:${-a},y:${a * 0.5}},{x:${a * 0.8},y:${-a * 0.6}},{x:${-a * 0.5},y:${a * 0.3}},{x:${a * 0.25},y:0},{x:0,y:0}],duration:.36,ease:"none",immediateRender:false},${e.r(t)});`);

// ── background: white-led mesh, soft lavender + a little mint, always drifting ──
const BLOBS = [ // colour, size (× long side), start [x, y] (× W/H), drift [dx, dy], period s
  ["rgba(186,165,255,.50)", 0.62, [-0.12, -0.22], [0.22, 0.16], 11],
  ["rgba(130,222,186,.30)", 0.46, [0.62, 0.55], [-0.2, -0.14], 13],
  ["rgba(232,198,255,.50)", 0.58, [0.55, -0.3], [-0.18, 0.2], 9.5],
  ["rgba(205,192,255,.40)", 0.52, [-0.16, 0.52], [0.24, -0.16], 12],
  ["rgba(170,236,208,.24)", 0.36, [0.28, 0.2], [0.16, 0.18], 8],
];
export const bgHtml = BLOBS.map((_, i) => `<div class="blob" id="vb${i}"></div>`).join("") + `<div id="aur"></div>`
  + Array.from({ length: 14 }, (_, i) => `<i class="mote" id="mo${i}"></i>`).join("");
export function ambient(e, L, S, total) {
  const W = L.W, H = L.H, out = [];
  BLOBS.forEach(([, , , [dx, dy], p], i) => out.push(`tl.fromTo("#vb${i}",{x:0,y:0,scale:1},{x:${dx * W},y:${dy * H},scale:${i % 2 ? 1.2 : 0.85},duration:${p},ease:"sine.inOut",yoyo:true,repeat:${Math.ceil(total / p)}},0);`));
  out.push(`tl.fromTo("#aur",{rotation:0},{rotation:${Math.round(total * 3)},duration:${e.r(total)},ease:"none"},0);`);
  for (let i = 0; i < 14; i++) {
    const p = 14 + ((i * 7) % 9), x = ((i * 137) % 100) / 100 * W;
    out.push(`tl.fromTo("#mo${i}",{x:${x.toFixed(0)},y:${H + 30},opacity:0},{keyframes:[{opacity:.9,duration:${p * 0.2}},{opacity:.9,duration:${p * 0.6}},{opacity:0,duration:${p * 0.2}}],y:-40,x:${(x + ((i % 3) - 1) * 120).toFixed(0)},duration:${p},ease:"none",repeat:${Math.ceil(total / p)},delay:${(i * 1.7) % p}},0);`);
  }
  return out.join("\n");
}

// Type: the lib faces are re-pointed (a later @font-face with the same descriptors wins) — Plus Jakarta
// Sans for Latin, Poppins for Nepali, Bebas Neue for the punch words.
const NP = ["Medium", 500, "SemiBold", 600, "Bold", 700, "ExtraBold", 800];
export const css = (L) => `
@font-face { font-family: "Inter Tight"; src: url("assets/type/Jakarta.ttf") format("truetype"); font-weight: 100 900; }
${[0, 2, 4, 6].map((i) => `@font-face { font-family: "Mukta"; src: url("assets/type/Poppins-${NP[i]}.ttf") format("truetype"); font-weight: ${NP[i + 1]}; }`).join("\n")}
@font-face { font-family: "Bebas Neue"; src: url("assets/type/Bebas.ttf") format("truetype"); font-weight: 400; }
.chapword { font-family: "Bebas Neue", "Mukta" !important; font-weight: 400 !important; letter-spacing: .01em !important; }
.label { letter-spacing: -.045em; font-weight: 800; }
.npline { line-height: 1.45 !important; letter-spacing: -.01em; }
.sub span.box { line-height: 1.5 !important; font-weight: 600 !important; }
#bg { background: #fdfcff; }
${BLOBS.map(([c, s, [x, y]], i) => `#vb${i} { left:${x * 100}%; top:${y * 100}%; width:${Math.max(L.W, L.H) * s}px; height:${Math.max(L.W, L.H) * s}px; background:radial-gradient(circle, ${c}, transparent 70%); }`).join("\n")}
#aur { position:absolute; left:50%; top:50%; width:${L.W * 1.6}px; height:${L.W * 1.6}px; margin:${-L.W * 0.8}px 0 0 ${-L.W * 0.8}px; opacity:.32;
  background:conic-gradient(from 0deg, transparent 0deg, rgba(196,180,255,.55) 40deg, transparent 95deg, rgba(150,228,196,.35) 170deg, transparent 230deg, rgba(232,204,255,.5) 300deg, transparent 360deg); filter:blur(90px); }
.mote { position:absolute; left:0; top:0; width:7px; height:7px; border-radius:50%; background:#fff; box-shadow:0 0 14px 4px rgba(190,170,255,.55); }
.fullv { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.screen-blend { mix-blend-mode: screen; }
.hk { position:absolute; left:0; right:0; text-align:center; font:400 200px/1 "Bebas Neue", Mukta, sans-serif; letter-spacing:.02em; color:#fff; text-shadow:0 10px 50px rgba(0,0,0,.7); }
.hk .s { position:relative; display:inline-block; margin:0 .22em; }
.hk .s i { position:absolute; left:-6%; right:-6%; top:50%; height:.09em; background:#e5484d; border-radius:9px; transform-origin:left center; transform:scaleX(0); }
.burst { position:absolute; left:50%; top:50%; width:600px; height:600px; margin:-300px 0 0 -300px; border-radius:50%;
  background:radial-gradient(circle, #fff 0%, rgba(255,255,255,.9) 30%, rgba(214,200,255,.5) 55%, transparent 72%); }
.gl { position:absolute; width:250px; height:549px; border-radius:34px; overflow:hidden; background:#fff; border:7px solid #0d0f0e;
  box-shadow:0 40px 90px rgba(40,30,90,.32); }
.gl img { width:100%; height:100%; object-fit:cover; display:block; }
.hk2 { position:absolute; left:0; right:0; text-align:center; font:800 70px/1.3 Mukta, sans-serif; color:#14121c; }
.hk2 .acc { color:#0a8a4b; }
.pain { position:absolute; display:inline-flex; align-items:center; gap:14px; padding:12px 26px 12px 14px; border-radius:99px; background:rgba(255,255,255,.88);
  box-shadow:0 18px 40px rgba(40,30,80,.14), inset 0 0 0 1.5px rgba(255,255,255,.9); font:600 30px Mukta, sans-serif; color:#3b3848; white-space:nowrap; }
.pain .ic { position:relative; width:42px; height:42px; border-radius:50%; background:#e5484d; display:grid; place-items:center; color:#fff; font:800 24px "Inter Tight"; }
.pain .ic svg { position:absolute; width:62%; opacity:0; }
.pain .tx { position:relative; } .pain .tx i { position:absolute; left:-3%; right:-3%; top:54%; height:3px; background:#e5484d; border-radius:3px; transform-origin:left; transform:scaleX(0); }
.pain .ok { font:700 26px "Inter Tight"; color:#0a8a4b; opacity:0; }
.url { position:absolute; display:inline-flex; align-items:center; gap:12px; padding:12px 26px; border-radius:99px; background:#14121c; color:#fff; font:700 28px "Inter Tight", sans-serif; }
.url b { width:14px; height:14px; border-radius:50%; background:#12a95d; box-shadow:0 0 0 6px rgba(18,169,93,.25); }
.wtag { position:absolute; padding:22px 30px; border-radius:26px; background:rgba(255,255,255,.88); box-shadow:0 30px 70px rgba(20,15,40,.25); }
.wtag .eyebrow { font:700 20px "Inter Tight"; letter-spacing:.16em; color:#0a8a4b; text-transform:uppercase; }
.wtag .wl { font:800 56px/1.05 "Inter Tight"; letter-spacing:-.04em; color:#14121c; margin-top:6px; }
.wtag .wn { font:600 32px/1.4 Mukta; color:#2b2838; margin-top:4px; }
.wwin { position:absolute; overflow:hidden; border-radius:22px; background:#fff; box-shadow:0 50px 120px rgba(20,15,40,.35); }
.wwin .tb { height:44px; background:#f1f0f5; display:flex; align-items:center; gap:9px; padding:0 18px; }
.wwin .tb i { width:13px; height:13px; border-radius:50%; background:#d6d4de; }
.wwin .tb span { margin-left:16px; padding:5px 18px; border-radius:99px; background:#fff; font:600 17px "Inter Tight"; color:#6b6880; }
.play { display:inline-flex; align-items:center; gap:18px; padding:16px 34px 16px 24px; border-radius:20px; background:#14121c; color:#fff; }
.play small { display:block; font:600 18px "Inter Tight"; letter-spacing:.06em; opacity:.8; } .play span { font:800 38px "Inter Tight"; }
/* the student's phone */
.sp { position:absolute; width:330px; height:690px; border-radius:48px; background:#0d0f0e; padding:11px; box-shadow:0 50px 110px rgba(40,30,90,.35); }
.sp .ss { position:relative; width:100%; height:100%; border-radius:38px; overflow:hidden; background:#fff; }
.sp .cam { position:absolute; inset:0; background:#101114; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:26px; }
.sp .cam p { font:600 19px "Inter Tight"; color:#fff; opacity:.8; margin:0; }
.sp .vf { position:relative; width:230px; height:230px; }
.sp .vf img { position:absolute; inset:18px; width:194px; height:194px; border-radius:8px; }
.sp .vf b { position:absolute; width:46px; height:46px; border:5px solid #fff; }
.sp .vf .ln { position:absolute; left:10px; right:10px; height:3px; background:#3ddc84; box-shadow:0 0 18px #3ddc84; top:20px; }
.sp .ban { background:#0a8a4b; color:#fff; padding:44px 20px 22px; border-radius:0 0 26px 26px; }
.sp .ban small { font:700 12px "Inter Tight"; letter-spacing:.08em; opacity:.75; } .sp .ban div { font:800 24px "Inter Tight"; margin-top:2px; } .sp .ban span { font:500 15px "Inter Tight"; opacity:.85; }
.sp .fl { margin:12px 16px 0; } .sp .fl small { display:block; font:600 13px "Inter Tight"; color:#6d6885; margin-bottom:4px; }
.sp .fl div { height:42px; border-radius:12px; background:#f3f2f7; display:flex; align-items:center; padding:0 14px; font:600 18px "Inter Tight"; color:#14121c; }
.sp .fl div span { clip-path:inset(0 100% 0 0); }
.sp .chips { display:flex; gap:8px; margin:14px 16px 0; } .sp .chip { flex:1; display:flex; align-items:center; justify-content:center; gap:6px; height:40px; border-radius:12px;
  background:#e8f5ee; color:#0a8a4b; font:700 15px "Inter Tight"; opacity:0; } .sp .chip img { width:26px; }
.sp .btn { position:absolute; left:16px; right:16px; bottom:18px; height:54px; border-radius:16px; background:#0a8a4b; color:#fff; display:grid; place-items:center; font:700 17px "Inter Tight"; }
.sp .okv { position:absolute; inset:0; background:#fff; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:30px; text-align:center; opacity:0; }
.sp .okv .ck { width:96px; height:96px; border-radius:50%; background:#0a8a4b; display:grid; place-items:center; } .sp .okv .ck svg { width:56%; }
.sp .okv div { font:800 24px/1.25 "Inter Tight"; color:#14121c; } .sp .okv span { font:500 16px "Inter Tight"; color:#6d6885; }
.formchip { position:absolute; display:flex; align-items:center; gap:10px; padding:12px 20px 12px 12px; border-radius:18px; background:#fff; font:700 20px "Inter Tight"; color:#14121c;
  box-shadow:0 20px 50px rgba(40,30,90,.25); white-space:nowrap; } .formchip img { width:44px; }
/* how to start */
.hw { position:absolute; left:150px; top:120px; width:860px; }
.rail { position:relative; display:flex; justify-content:space-between; }
.rail .rl { position:absolute; left:23px; right:23px; top:22px; height:5px; border-radius:3px; background:rgba(20,18,28,.08); }
.rail .rl i { position:absolute; inset:0; border-radius:3px; background:linear-gradient(90deg,#0a8a4b,#19b866); transform-origin:0 50%; transform:scaleX(0); }
.rail .nd { position:relative; display:flex; flex-direction:column; align-items:center; gap:8px; width:46px; }
.rail .nd b { position:relative; width:46px; height:46px; border-radius:50%; background:#fff; display:grid; place-items:center; font:800 19px "Inter Tight"; color:#6d6885;
  box-shadow:0 8px 20px rgba(40,30,80,.12); } .rail .nd b svg { position:absolute; width:56%; opacity:0; }
.rail .nd span { font:700 15px "Inter Tight"; color:#6d6885; white-space:nowrap; }
.hwc { position:absolute; left:0; top:150px; width:860px; }
.hwn { font:400 210px/0.9 "Bebas Neue"; color:#0a8a4b; letter-spacing:.01em; }
.hwt { font:800 82px/1.05 "Inter Tight"; letter-spacing:-.045em; color:#14121c; margin-top:6px; }
.hwnp { font:700 44px/1.45 Mukta; color:#2b2838; margin-top:14px; }
.ios { position:absolute; left:0; top:640px; display:flex; align-items:center; gap:20px; padding:20px 30px 20px 20px; border-radius:28px; background:rgba(255,255,255,.9);
  box-shadow:0 24px 60px rgba(40,30,80,.16); opacity:0; } .ios img { width:84px; } .ios b { display:block; font:800 34px "Inter Tight"; color:#14121c; }
.ios span { font:700 34px/1.4 Mukta; color:#2b2838; } .ios .acc { color:#0a8a4b; font-family:"Inter Tight"; font-weight:800; }
.kyc { position:absolute; left:0; top:640px; width:860px; display:flex; flex-wrap:wrap; gap:12px; }
.kc { display:inline-flex; align-items:center; gap:10px; padding:10px 20px 10px 10px; border-radius:99px; background:rgba(255,255,255,.88); font:700 22px "Inter Tight"; color:#6d6885;
  box-shadow:0 12px 30px rgba(40,30,80,.12); } .kc b { position:relative; width:32px; height:32px; border-radius:50%; background:#ece9f4; display:grid; place-items:center; } .kc b svg { width:60%; opacity:0; }
/* the owner at ease */
.calm { position:absolute; left:0; right:0; text-align:center; color:#fff; text-shadow:0 8px 40px rgba(0,0,0,.55); }
.calm .c1 { font:800 92px/1.25 Mukta; } .calm .c2 { font:600 46px/1.4 Mukta; margin-top:6px; opacity:.95; }
`;

// ── hook: the register burns, three old tools slam in and get struck, a light burst, five real screens fly
// out of the depth and fold into the mark, the promise lands ──
const GLIMPSE = ["g_qr", "g_res", "g_home", "g_pay", "g_esewa"];
export function hook(e, L, sc) {
  const t0 = sc.start, B = t0 + sc.burst, W = L.W, H = L.H, end = t0 + sc.dur;
  if (veo("fireA")) {
    vid(e, "hookv", "fireA", t0, sc.burst + 0.5, 2.2);
    e.code(`tl.fromTo("#hookv",{scale:1.18},{scale:1,duration:${sc.burst},ease:"power1.out"},${t0});
tl.to("#hookv",{scale:1.35,filter:"brightness(1.6) blur(4px)",duration:.45,ease:"power2.in"},${e.r(B - 0.45)});`);
  }
  if (veo("particles_loop")) vid(e, "hookp", "particles_loop", t0, sc.burst + 0.5, 0, "screen-blend", "opacity:.75", 5);
  e.sfx("fire", t0, 0.4); e.sfx("riser", t0 + 0.9, 0.22);
  const pains = ["कापी", "Excel", "WhatsApp"], at = [0.2, 0.78, 1.32];
  e.clip("hookw", t0, sc.burst + 0.1, `<div class="hk" id="hkw" style="top:${H * 0.36}px">${pains.map((p, i) => `<span class="s" id="hs${i}">${p}<i></i></span>`).join("")}</div>`, "full");
  pains.forEach((_, i) => {
    const t = t0 + at[i];
    e.code(`tl.fromTo("#hs${i}",{scale:2.6,opacity:0,filter:"blur(16px)"},{scale:1,opacity:1,filter:"blur(0px)",duration:.26,ease:"expo.out"},${e.r(t)});
tl.to("#hs${i} i",{scaleX:1,duration:.16,ease:"power3.out"},${e.r(t0 + 2.3 + i * 0.12)});`);
    e.sfx("boom", t + 0.05, 0.3); shake(e, "#hkw", t + 0.08, 14);
    e.sfx("cross", t0 + 2.3 + i * 0.12, 0.26);
  });
  e.code(`tl.to("#hs0,#hs1,#hs2",{opacity:.35,duration:.3},${e.r(t0 + 2.75)});
tl.to("#hkw",{scale:.82,opacity:0,filter:"blur(14px)",duration:.3,ease:"power2.in"},${e.r(B - 0.3)});`);
  e.sfx("glitch", t0 + 2.6, 0.18);
  smokeRise(e, "smk0", B, B + 0.25); // the burning register's smoke rises and whites out the frame

  // light burst; the dark gives way to the white mesh
  e.clip("burst", B - 0.1, 1.2, `<div class="burst" id="bst"></div>`, "full top");
  e.code(`tl.fromTo("#bst",{scale:0,opacity:1},{scale:${W / 220},opacity:0,duration:1.05,ease:"expo.out"},${e.r(B - 0.05)});
tl.to("#dark",{opacity:0,duration:.35},${e.r(B)});`);
  e.sfx("boom", B, 0.42); e.sfx("reveal", B - 0.05, 0.32);

  // five real screens fly out of the depth into a fan, then fold into the mark
  const fan = [-560, -280, 0, 280, 560], rot = [-14, -7, 0, 7, 14], cy = H * 0.5 - 275;
  e.clip("glim", B, 2.4, GLIMPSE.map((g, i) => `<div class="gl" id="gl${i}" style="left:${W / 2 - 125}px;top:${cy}px"><img src="assets/img/${g}.jpg"></div>`).join(""), "full");
  GLIMPSE.forEach((_, i) => {
    const t = B + 0.08 + Math.abs(i - 2) * 0.1;
    e.code(`tl.fromTo("#gl${i}",{x:${fan[i] * 0.2},y:${180 + Math.abs(i - 2) * 40},scale:.15,rotation:${rot[i] * 3},rotationY:${(i - 2) * 25},opacity:0,filter:"blur(18px)"},{x:${fan[i]},y:${Math.abs(i - 2) * 26},scale:${i === 2 ? 1.08 : 0.92},rotation:${rot[i]},rotationY:0,opacity:1,filter:"blur(0px)",duration:.62,ease:"expo.out"},${e.r(t)});
tl.to("#gl${i}",{y:"-=14",duration:.9,ease:"sine.inOut"},${e.r(t + 0.62)});
tl.to("#gl${i}",{x:0,y:0,scale:.12,rotation:0,opacity:0,filter:"blur(6px)",duration:.42,ease:"power3.in"},${e.r(B + 1.85 + Math.abs(i - 2) * 0.04)});`);
    e.sfx(i % 2 ? "whip" : "swish", t, 0.2);
  });
  const M = B + 2.25; // the mark lands where the screens folded
  e.clip("hlock", M - 0.1, end - M + 0.15, `<div style="position:absolute;left:0;right:0;top:${H * 0.24}px;display:flex;flex-direction:column;align-items:center">
    <img id="hmark" src="assets/img/logo-mark.png" style="height:170px"><img id="hword" src="assets/img/wordmark.png" style="height:84px;margin-top:26px;clip-path:inset(0 100% 0 0)"></div>
    <div class="hk2" id="hline" style="top:${H * 0.66}px">${words("अब पूरै होस्टल एउटै एपमा चल्छ।", [3, 4])}</div>`, "full");
  e.code(`tl.fromTo("#hmark",{scale:0,rotation:-30,opacity:0},{scale:1,rotation:0,opacity:1,duration:.75,ease:"back.out(1.8)"},${e.r(M)});
tl.to("#hword",{clipPath:"inset(0 0% 0 0)",duration:.6,ease:"power3.inOut"},${e.r(M + 0.3)});
tl.fromTo("#hline .w",{yPercent:70,opacity:0},{yPercent:0,opacity:1,duration:.5,ease:"expo.out",stagger:.08},${e.r(M + 0.7)});
tl.to("#hlock > *",{y:-60,opacity:0,filter:"blur(10px)",duration:.4,ease:"power2.in",stagger:.05},${e.r(end - 0.45)});`);
  e.sfx("boom", M, 0.32); e.sfx("shimmer", M + 0.25, 0.3); e.sfx("bubble", M + 0.7, 0.18);
  shake(e, "#hlock", M + 0.05, 8);
}

// ── the problem, said in one sentence: chip → struck → "Solved" ──
function pain(e, L, sc) {
  const p = sc.pain, t = sc.start + p.at, x = sc.start + p.end, C = L.copy, id = `pn_${sc.id}`;
  e.clip(id, t - 0.05, x - t + 1.4, `<div class="pain" id="${id}i" style="left:${C.x}px;top:${C.y - 100}px"><span class="ic"><span class="x">!</span>${TICK}</span><span class="tx">${p.text}<i></i></span><span class="ok">Solved</span></div>`, "full top2");
  e.code(`tl.fromTo("#${id}i",{y:18,opacity:0,scale:.85},{y:0,opacity:1,scale:1,duration:.45,ease:"back.out(2.2)"},${e.r(t)});
tl.to("#${id}i .tx i",{scaleX:1,duration:.25,ease:"power3.out"},${e.r(x - 0.3)});
tl.to("#${id}i .tx",{opacity:.45,duration:.25},${e.r(x - 0.25)});
tl.to("#${id}i .ic",{backgroundColor:"#0a8a4b",duration:.2},${e.r(x - 0.15)});
tl.to("#${id}i .ic .x",{opacity:0,duration:.1},${e.r(x - 0.15)});
tl.fromTo("#${id}i .ic svg",{scale:0},{scale:1,opacity:1,duration:.35,ease:"back.out(3)"},${e.r(x - 0.13)});
tl.fromTo("#${id}i .ok",{x:-10,opacity:0},{x:0,opacity:1,duration:.3},${e.r(x - 0.05)});
tl.to("#${id}i",{opacity:0,y:-14,duration:.3},${e.r(x + 1.0)});`);
  e.sfx("pop", t, 0.24); e.sfx("cross", x - 0.3, 0.24); e.sfx("success", x - 0.13, 0.24);
  shake(e, `#${id}i`, t + 0.1, 5);
}

// ── the student's phone: scan the hostel's QR → the form fills → sent; the form flies to the owner ──
function student(e, L, sc) {
  const a = sc.start + sc.student.at, s = sc.start + sc.student.sent, P = L.phone;
  const x = 640, y = 150, out = s + 0.75;
  const fields = [["First name", "Aarav"], ["Last name", "Karki"], ["Phone", "9800000001"], ["College", "Tri-Chandra College"]];
  e.clip("stu", a - 0.05, out - a + 0.5, `
    <div class="pill2" id="stub" style="left:${x - 290}px;top:${y + 300}px;background:#0d0f0e;color:#fff"><span class="dt"></span>Student's phone</div>
    <div class="sp" id="stp" style="left:${x}px;top:${y}px"><div class="ss">
      <div class="ban"><small>FILLING FORM FOR</small><div>Himalaya Boys Hostel</div><span>Kathmandu</span></div>
      ${fields.map(([k, v], i) => `<div class="fl" id="sf${i}"><small>${k}</small><div><span>${v}</span></div></div>`).join("")}
      <div class="chips"><div class="chip" id="sc0"><img src="assets/pngw/student.png">Photo ✓</div><div class="chip" id="sc1">ID ✓</div><div class="chip" id="sc2">Signed ✓</div></div>
      <div class="btn" id="sbtn">Send to Himalaya Boys Hostel</div>
      <div class="cam" id="scam"><p>Scan the hostel's QR</p><div class="vf"><img src="assets/img/qr_crop.png">
        <b style="left:0;top:0;border-right:0;border-bottom:0;border-radius:14px 0 0 0"></b><b style="right:0;top:0;border-left:0;border-bottom:0;border-radius:0 14px 0 0"></b>
        <b style="left:0;bottom:0;border-right:0;border-top:0;border-radius:0 0 0 14px"></b><b style="right:0;bottom:0;border-left:0;border-top:0;border-radius:0 0 14px 0"></b>
        <i class="ln" id="sln"></i></div></div>
      <div class="okv" id="sok"><span class="ck">${TICK}</span><div>Sent to Himalaya Boys Hostel</div><span>They have your form.</span></div>
    </div></div>
    <div class="formchip" id="sfc" style="left:${x + 40}px;top:${y + 300}px"><img src="assets/pngw/page.png">Aarav's form</div>`, "full top2");
  e.code(`tl.fromTo("#stp",{y:${L.H * 0.7},rotation:-8,opacity:0},{y:0,rotation:-3,opacity:1,duration:.7,ease:"expo.out"},${e.r(a)});
tl.fromTo("#stub",{scale:.5,opacity:0},{scale:1,opacity:1,duration:.45,ease:"back.out(2.4)"},${e.r(a + 0.3)});
tl.fromTo("#sln",{y:0},{y:186,duration:.5,ease:"sine.inOut",yoyo:true,repeat:1},${e.r(a + 0.35)});
tl.to("#scam .vf b",{borderColor:"#3ddc84",duration:.1},${e.r(a + 1.15)});
tl.to("#scam",{opacity:0,scale:1.15,duration:.3,ease:"power2.in"},${e.r(a + 1.35)});`);
  e.sfx("whoosh", a, 0.24); e.sfx("scan", a + 0.35, 0.28); e.sfx("beep", a + 1.15, 0.4);
  fields.forEach((_, i) => {
    const t = a + 1.6 + i * 0.3;
    e.code(`tl.to("#sf${i} span",{clipPath:"inset(0 0% 0 0)",duration:.26,ease:"steps(8)"},${e.r(t)});`);
    e.sfx("keys", t, 0.16);
  });
  [0, 1, 2].forEach((i) => {
    e.code(`tl.fromTo("#sc${i}",{scale:.6,opacity:0},{scale:1,opacity:1,duration:.3,ease:"back.out(2.6)"},${e.r(a + 2.85 + i * 0.12)});`);
    e.sfx("bubble", a + 2.85 + i * 0.12, 0.16);
  });
  e.code(`tl.to("#sbtn",{scale:.94,duration:.08,yoyo:true,repeat:1},${e.r(s - 0.2)});
tl.fromTo("#sok",{opacity:0},{opacity:1,duration:.25},${e.r(s)});
tl.fromTo("#sok .ck",{scale:0,rotation:-40},{scale:1,rotation:0,duration:.45,ease:"back.out(2.6)"},${e.r(s + 0.05)});
tl.fromTo("#sfc",{x:0,y:0,scale:.6,opacity:0},{keyframes:[{x:150,y:-130,scale:1,opacity:1,duration:.3},{x:${P.cx - x - 160},y:-20,scale:.8,opacity:1,duration:.4}],ease:"power2.inOut"},${e.r(s + 0.15)});
tl.to("#sfc",{opacity:0,scale:.4,duration:.15},${e.r(s + 0.85)});
tl.to(["#stp","#stub"],{x:-80,opacity:0,filter:"blur(8px)",duration:.4,ease:"power2.in"},${e.r(out)});`);
  e.sfx("tap", s - 0.2, 0.3); e.sfx("sent", s + 0.05, 0.3); e.sfx("success", s + 0.1, 0.24); e.sfx("plink", s + 0.85, 0.3);
  hideCopy(e, sc, a - 0.25);
}

// ── how to start: a six-node rail, a big step number, the step in English + one Nepali sentence;
// the KYC step lists its sections and ticks them as the footage reaches each one ──
function howto(e, L, sc) {
  const steps = sc.howto, end = sc.start + sc.dur - 0.35, n = steps.length;
  e.clip(`hw_${sc.id}`, sc.start + 0.5, sc.dur - 0.5, `<div class="hw" id="hw">
    <div class="rail"><div class="rl"><i id="hwfill"></i></div>${steps.map((s, i) => `<div class="nd" id="hn${i}"><b><em style="font-style:normal">${i + 1}</em>${TICK}</b><span>${s.short}</span></div>`).join("")}</div>
    ${steps.map((s, i) => `<div class="hwc" id="hc${i}"><div class="hwn">${String(i + 1).padStart(2, "0")}</div><div class="hwt">${chars(s.title)}</div><div class="hwnp">${words(s.np)}</div></div>`).join("")}
    <div class="ios" id="hios"><img src="assets/pngw/mobile.png"><div><b>iPhone?</b><span>${words("hostelpalika.com मा गएर एप इन्स्टल गर्नुहोस्।", [0])}</span></div></div>
    <div class="kyc" id="hkyc">${sc.kycRail.map(([l], k) => `<span class="kc" id="hk${k}"><b>${TICK}</b>${l}</span>`).join("")}</div></div>`, "full top2");
  e.code(`tl.fromTo("#hw .nd",{y:20,opacity:0},{y:0,opacity:1,duration:.45,ease:"back.out(2)",stagger:.05},${e.r(sc.start + 0.55)});
tl.fromTo("#hw .rl",{opacity:0},{opacity:1,duration:.4},${e.r(sc.start + 0.55)});
tl.set("#hw .hwc",{opacity:0},${e.r(sc.start + 0.5)});
tl.to("#hw",{opacity:0,y:-20,duration:.3},${e.r(end)});`);
  e.sfx("glass", sc.start + 0.55, 0.24);
  steps.forEach((s, i) => {
    const t = sc.start + Math.max(s.at, 0.75), next = steps[i + 1] ? sc.start + steps[i + 1].at : end;
    e.code(`tl.fromTo("#hc${i}",{opacity:0},{opacity:1,duration:.01},${e.r(t)});
tl.fromTo("#hc${i} .hwn",{rotationX:-90,opacity:0},{rotationX:0,opacity:1,duration:.5,ease:"back.out(2)"},${e.r(t)});
tl.fromTo("#hc${i} .ch",{yPercent:110,opacity:0},{yPercent:0,opacity:1,duration:.55,ease:"expo.out",stagger:.02},${e.r(t + 0.1)});
tl.fromTo("#hc${i} .w",{yPercent:70,opacity:0},{yPercent:0,opacity:1,duration:.45,ease:"expo.out",stagger:.06},${e.r(t + 0.3)});
tl.to("#hwfill",{scaleX:${(i / (n - 1)).toFixed(3)},duration:.5,ease:"power3.out"},${e.r(t)});
tl.to("#hn${i} b",{backgroundColor:"#0a8a4b",color:"#fff",scale:1.18,duration:.3,ease:"back.out(2.5)"},${e.r(t)});
tl.to("#hn${i} span",{color:"#0a8a4b",duration:.2},${e.r(t)});${steps[i + 1] ? `
tl.to("#hc${i}",{y:-30,opacity:0,filter:"blur(6px)",duration:.28,ease:"power2.in"},${e.r(next - 0.3)});
tl.to("#hn${i} b",{scale:1,duration:.2},${e.r(next - 0.15)});
tl.to("#hn${i} em",{opacity:0,duration:.1},${e.r(next - 0.15)});
tl.fromTo("#hn${i} b svg",{scale:0},{scale:1,opacity:1,duration:.3,ease:"back.out(3)"},${e.r(next - 0.15)});` : ""}`);
    e.code(`tl.fromTo("#rig .frame",{scale:1},{keyframes:[{scale:1.045,duration:.16},{scale:1,duration:.4}],ease:"power2.out",immediateRender:false},${e.r(t)});`);
    e.sfx("whip", t - 0.05, 0.24); e.sfx("click", t + 0.05, 0.26); e.sfx("bubble", t + 0.3, 0.14);
    if (steps[i + 1]) e.sfx("plink", next - 0.15, 0.22);
  });
  const io = sc.start + sc.ios.at, ie = sc.start + sc.ios.end;
  e.code(`tl.fromTo("#hios",{x:-40,opacity:0,scale:.9},{x:0,opacity:1,scale:1,duration:.55,ease:"back.out(2)"},${e.r(io)});
tl.fromTo("#hios img",{rotation:-30,scale:0},{rotation:0,scale:1,duration:.5,ease:"back.out(2.6)"},${e.r(io + 0.1)});
tl.fromTo("#hios .w",{yPercent:60,opacity:0},{yPercent:0,opacity:1,duration:.4,ease:"expo.out",stagger:.06},${e.r(io + 0.25)});
tl.to("#hios",{x:-30,opacity:0,duration:.3,ease:"power2.in"},${e.r(ie)});
tl.to("#rig",{opacity:.3,duration:.4},${e.r(io)});
tl.to("#rig",{opacity:1,duration:.4},${e.r(ie)});`);
  e.sfx("glass", io, 0.28); e.sfx("pop", io + 0.1, 0.2);
  const k0 = sc.start + sc.kycRail[0][1];
  e.code(`tl.fromTo("#hkyc .kc",{y:16,opacity:0,scale:.9},{y:0,opacity:1,scale:1,duration:.4,ease:"back.out(2)",stagger:.05},${e.r(k0 + 0.2)});
tl.to("#hkyc",{opacity:0,y:-16,duration:.3},${e.r(sc.start + steps[n - 1].at - 0.3)});`);
  sc.kycRail.forEach(([, at], k) => {
    const t = sc.start + at + 0.25;
    e.code(`tl.to("#hk${k}",{color:"#0a8a4b",scale:1.06,duration:.2},${e.r(t)});
tl.to("#hk${k} b",{backgroundColor:"#0a8a4b",duration:.2},${e.r(t)});
tl.fromTo("#hk${k} b svg",{scale:0},{scale:1,opacity:1,duration:.3,ease:"back.out(3)"},${e.r(t + 0.05)});
tl.to("#hk${k}",{scale:1,duration:.2},${e.r(t + 0.3)});`);
    e.sfx("toggle", t, 0.22);
  });
  hideCopy(e, sc, sc.start + 0.45);
}

export function extrasAnim(e, L, sc) {
  adminExtras(e, L, sc);
  if (sc.pain) pain(e, L, sc);
  if (sc.student) student(e, L, sc);
  if (sc.howto) howto(e, L, sc);
  // more sound: the riser into every section card, a thump on its word, the copy arriving
  if (sc.word) { e.sfx("rise", sc.start - 1.25, 0.2); e.sfx("boom", sc.start - 0.1, 0.22); }
  e.sfx("swish", sc.start + 0.25, 0.12); e.sfx("twinkle", sc.start + 0.7, 0.12);
}

// ── web portal: section card, the Veo laptop pushes into its screen, then the portal itself fills a
// browser window for close-ups. web.mp4 = five 1.33 s shots; the laptop composite runs the same footage ──
const SHOTS = [[0.32, 0.3, 1.45], [0.5, 0.45, 1.6], [0.42, 0.28, 1.5], [0.5, 0.4, 1.5], [0.72, 0.42, 1.5]], SHOT = 4 / 3;
const SCREEN = { x: 0.38, y: 0.565 }; // centre of the laptop screen in laptop_web.mp4 (fractions)
export function web(e, L, sc) {
  const t0 = sc.start, lap = veo("laptop_web"), push = lap ? 3.0 : 0;
  chapter(e, L, { ...sc, word: "Web." }, sc.chapNo, 8);
  e.sfx("rise", t0 - 1.25, 0.2); e.sfx("boom", t0 - 0.1, 0.22);
  if (lap) {
    vid(e, "lapv", "laptop_web", t0 - 0.2, push + 0.6, 0, "", `object-position:${SCREEN.x * 100}% 50%`);
    e.clip("webLap", t0 + 0.3, push, `<div class="wtag" id="wtag" style="right:90px;top:${L.H * 0.14}px"><div class="eyebrow">07 · Web Portal</div><div class="wl">Laptop. Web. Anywhere.</div><div class="wn">${words("उही पोर्टल जहाँबाट पनि चल्छ।")}</div></div>`, "full");
    e.code(`tl.fromTo("#lapv",{scale:1.04,transformOrigin:"${SCREEN.x * 100}% ${SCREEN.y * 100}%"},{scale:2.5,duration:${push + 0.5},ease:"power3.in"},${e.r(t0 - 0.2)});
tl.fromTo("#wtag",{x:40,opacity:0},{x:0,opacity:1,duration:.55,ease:"expo.out"},${e.r(t0 + 0.4)});
tl.fromTo("#wtag .w",{yPercent:70,opacity:0},{yPercent:0,opacity:1,duration:.45,ease:"expo.out",stagger:.06},${e.r(t0 + 0.6)});
tl.to("#wtag",{opacity:0,y:-16,duration:.3},${e.r(t0 + push - 0.5)});`);
    e.sfx("glass", t0 + 0.4, 0.24); e.sfx("zoom", t0 + push - 1.0, 0.26); e.sfx("whoosh", t0 + push - 0.4, 0.2);
  }
  const ww = 1620, wh = (ww * 9) / 16 + 44, wx = (L.W - ww) / 2, wy = 70, ws = t0 + push;
  e.clip("webWin", ws - 0.1, t0 + sc.dur - ws + 0.1, `<div class="wwin" id="wwin" style="left:${wx}px;top:${wy}px;width:${ww}px;height:${wh}px">
    <div class="tb"><i></i><i></i><i></i><span>hostelpalika.com</span></div>
    <div style="position:absolute;left:0;right:0;top:44px;bottom:0;overflow:hidden"><div id="wz" style="position:absolute;inset:0">
      <video id="webv" class="fullv" src="assets/web/web.mp4" muted playsinline data-start="${e.r(t0 + 0.4)}" data-duration="6.667" data-track-index="3"></video></div></div></div>`, "full");
  e.code(`tl.fromTo("#wwin",{scale:${lap ? 1.6 : 0.85},opacity:0,borderRadius:0},{scale:1,opacity:1,borderRadius:22,duration:.55,ease:"expo.out"},${e.r(ws - 0.1)});
tl.to("#wwin",{scale:.9,opacity:0,filter:"blur(10px)",duration:.4,ease:"power2.in"},${e.r(t0 + sc.dur - 0.4)});`);
  SHOTS.forEach(([x, y, k], i) => {
    const s = t0 + 0.4 + i * SHOT;
    if (s + SHOT < ws + 0.2) return; // still on the laptop
    e.code(`tl.fromTo("#wz",{scale:1,transformOrigin:"${x * 100}% ${y * 100}%"},{scale:${k},duration:${e.r(s + SHOT - Math.max(s, ws) - 0.1)},ease:"power2.inOut",immediateRender:false},${e.r(Math.max(s, ws) + 0.05)});`);
    e.sfx(i % 2 ? "zoom" : "swish", Math.max(s, ws) + 0.05, 0.18);
  });
}

// ── the payoff: the owner on a rooftop with tea, the line in big white type ──
export function calm(e, L, sc) {
  const t0 = sc.start, vo = sc.vo[0].at;
  if (veo("owner_relaxed")) {
    vid(e, "calmv", "owner_relaxed", t0, sc.dur + 0.3, 1.2, "", "object-position:30% 50%");
    e.code(`tl.fromTo("#calmv",{scale:1.14},{scale:1,duration:${sc.dur},ease:"none"},${t0});`);
  }
  e.clip("calmt", t0 + 0.2, sc.dur, `<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,8,20,0) 40%,rgba(10,8,20,.55) 100%)"></div>
    <div class="calm" style="top:${L.H * 0.58}px"><div class="c1" id="cl1">${words("अब हिसाबको टेन्सन छैन।", [2, 3])}</div><div class="c2" id="cl2">${words("होस्टल चल्दै छ, तपाईं ढुक्क हुनुहुन्छ।")}</div></div>`, "full");
  e.code(`tl.fromTo("#cl1 .w",{yPercent:80,opacity:0,filter:"blur(8px)"},{yPercent:0,opacity:1,filter:"blur(0px)",duration:.55,ease:"expo.out",stagger:.1},${e.r(vo)});
tl.fromTo("#cl2 .w",{yPercent:60,opacity:0},{yPercent:0,opacity:1,duration:.5,ease:"expo.out",stagger:.07},${e.r(vo + 1.85)});
tl.to("#calmt",{opacity:0,duration:.35},${e.r(t0 + sc.dur - 0.45)});`);
  e.sfx("shimmer", t0, 0.24); e.sfx("twinkle", vo + 0.1, 0.18); e.sfx("bubble", vo + 1.85, 0.14);
  // steam off the tea rises into white, and "Start." fades in out of it
  smokeRise(e, "smk1", t0 + sc.dur - 0.35, t0 + sc.dur + 0.25, false);
}

// ── close: mark, wordmark, tagline, Play button, URL ──
export function end(e, L, sc) {
  const t0 = sc.start, lt = t0 + 0.25;
  e.clip("endlk", lt - 0.1, sc.dur - 0.15, `<div style="position:absolute;left:0;right:0;top:${L.H * 0.2}px;display:flex;flex-direction:column;align-items:center">
    <img id="emark" src="assets/img/logo-mark.png" style="height:160px">
    <img id="eword" src="assets/img/wordmark.png" style="height:84px;margin-top:24px;clip-path:inset(0 100% 0 0)">
    <div id="etag" style="margin-top:22px;font:700 48px/1.4 Mukta;color:#2b2838">${words("होस्टल चलाउने नयाँ तरिका यही हो।", [2, 3])}</div>
    <div id="ecta" style="margin-top:40px;display:flex;gap:26px;align-items:center">
      <div class="play"><svg width="40" height="44" viewBox="0 0 20 22"><path d="M2 1.5 18 11 2 20.5Z" fill="#12a95d"/></svg><div><small>GET IT ON</small><span>Google Play</span></div></div>
      <div class="url" style="position:relative"><b></b>iPhone · hostelpalika.com</div></div></div>`, "full");
  e.code(`tl.fromTo("#emark",{scale:0,rotation:-25,opacity:0},{scale:1,rotation:0,opacity:1,duration:.8,ease:"back.out(1.7)"},${e.r(lt)});
tl.to("#eword",{clipPath:"inset(0 0% 0 0)",duration:.7,ease:"power3.inOut"},${e.r(lt + 0.35)});
tl.fromTo("#etag .w",{yPercent:60,opacity:0},{yPercent:0,opacity:1,duration:.5,ease:"expo.out",stagger:.08},${e.r(lt + 0.8)});
tl.fromTo("#ecta > *",{y:30,opacity:0,scale:.9},{y:0,opacity:1,scale:1,duration:.5,ease:"back.out(2)",stagger:.15},${e.r(lt + 1.3)});
tl.to("#emark",{scale:1.06,duration:.9,yoyo:true,repeat:${Math.max(1, Math.floor((sc.dur - 2.5) / 0.9))},ease:"sine.inOut"},${e.r(lt + 0.9)});
tl.fromTo("#endlk > div:first-child",{scale:1},{scale:1.05,duration:${e.r(sc.dur)},ease:"none"},${e.r(lt)});
tl.fromTo("#emark",{rotationY:0},{rotationY:360,duration:1.1,ease:"power3.inOut",immediateRender:false},${e.r(lt + 2.6)});
tl.to("#ecta .play",{scale:1.05,duration:.6,yoyo:true,repeat:5,ease:"sine.inOut"},${e.r(lt + 2.0)});`);
  e.sfx("swish", lt + 2.6, 0.2); e.sfx("twinkle", lt + 3.5, 0.22);
  e.sfx("boom", lt, 0.3); e.sfx("reveal", lt - 0.15, 0.3); e.sfx("shimmer", lt + 0.3, 0.26);
  e.sfx("bubble", lt + 0.8, 0.14); e.sfx("success", lt + 1.3, 0.24); e.sfx("pop", lt + 1.45, 0.18);
}
