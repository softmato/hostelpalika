// One phone carries every product scene. Between scenes it whips edge-on, so the footage
// swaps while the screen is a sliver; inside a scene it drifts slowly, like a held camera.
import { words, chars } from "./emit.mjs";
import { componentBox } from "./detect.mjs";
import { CROP_TOP } from "./segments.mjs";

const STATUS = `<span>9:41</span><span class="cam"></span><span class="icons">
<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0zM3.2 6.6a6.8 6.8 0 0 1 9.6 0l-1.3 1.3a5 5 0 0 0-7 0zM.8 4.2a10.2 10.2 0 0 1 14.4 0l-1.3 1.3a8.4 8.4 0 0 0-11.8 0z"/></svg>
<svg width="26" height="12" viewBox="0 0 26 12"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke="currentColor" opacity=".45"/><rect x="2" y="2" width="17" height="8" rx="1.6"/><rect x="23.5" y="4" width="2" height="4" rx="1" opacity=".45"/></svg></span>`;

// opt: { poses: {landscape|portrait: {id: [rotY, rotX]}}, stickers: {id: png}, zoom: [ids that push in],
//        extrasCopy(sc) -> html under the headline, extrasAnim(e, L, sc) -> scene-specific motion }
export function phoneScenes(e, L, fmt, list, opt) {
  const P = L.phone, s = P.screenW / 720;
  const vids = [], touches = [], spots = [];
  list.forEach((sc) => {
    spots.push(spotHtml(e, L, sc));
    vids.push(`<video id="v_${sc.id}" class="clip" src="${sc.file}" muted playsinline data-start="${e.r(sc.start)}" data-duration="${e.r(sc.videoDur)}" data-track-index="1"></video>`);
    sc.touches.forEach((t, i) => {
      const x = t.x1 * s, y = P.bar + (t.y1 - CROP_TOP) * s;
      const life = t.kind === "tap" ? 0.75 : t.dur + 0.5;
      const id = `t_${sc.id}_${i}`;
      touches.push(`<div id="${id}" class="clip touch" data-start="${e.r(sc.start + t.t - 0.08)}" data-duration="${e.r(life)}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px"><i></i><b></b></div>`);
      const T = sc.start + t.t;
      if (t.kind === "tap") {
        e.code(`tl.fromTo("#${id} i",{scale:.5,opacity:0},{scale:1,opacity:1,duration:.08},${e.r(T - 0.06)}).to("#${id} i",{scale:.8,opacity:0,duration:.35,ease:"power2.out"},${e.r(T + 0.18)});
tl.fromTo("#${id} b",{scale:.6,opacity:.9},{scale:2.4,opacity:0,duration:.55,ease:"power2.out"},${e.r(T)});`);
        e.sfx("tap", T, 0.22);
      } else {
        const dx = (t.x2 - t.x1) * s, dy = (t.y2 - t.y1) * s;
        e.code(`tl.fromTo("#${id} i",{x:0,y:0,scale:.6,opacity:0},{scale:1,opacity:.9,duration:.1},${e.r(T - 0.06)}).to("#${id} i",{x:${dx.toFixed(1)},y:${dy.toFixed(1)},duration:${e.r(t.dur)},ease:"power1.inOut"},${e.r(T)}).to("#${id} i",{opacity:0,scale:.7,duration:.25},${e.r(T + t.dur)});`);
        e.sfx("swish", T, 0.12);
      }
    });
  });

  // stills cover the phone before the first take starts and after the last one ends
  const f0 = list[0], fl = list[list.length - 1], flEnd = fl.start + fl.videoDur;
  vids.unshift(`<img class="clip shot" src="assets/img/first_${f0.id}.jpg" data-start="${e.r(Math.max(0, f0.start - 1.5))}" data-duration="${e.r(Math.min(1.5, f0.start) + 0.1)}">`);
  vids.push(`<img class="clip shot" src="assets/img/last_${fl.id}.jpg" data-start="${e.r(flEnd - 0.05)}" data-duration="1.5">`);
  e.code(`tl.set("#cam",{transformOrigin:"0px 0px"},0);`);
  e.add(`<div id="halo"></div><div id="stage"><div id="cam"><div id="rig"><div id="shadow"></div><div class="frame"><div class="screen">
<div class="bar">${STATUS}</div>${vids.join("")}${spots.join("")}${touches.join("")}<div class="glare"></div></div></div></div></div></div>`);

  // camera: entrance, per-scene drift, whip transitions
  const poses = opt.poses[fmt];
  const first = list[0], last = list[list.length - 1];
  const [ry0, rx0] = poses[first.id];
  e.code(`tl.fromTo("#rig",{y:${L.H * 0.75},rotationX:38,rotationY:${ry0 - 20},scale:.9,opacity:0},{y:0,rotationX:${rx0},rotationY:${ry0},scale:1,opacity:1,duration:1.1,ease:"expo.out"},${e.r(first.start - 0.4)});`);
  e.sfx("whoosh", first.start - 0.4, 0.22);
  list.forEach((sc, i) => {
    const [ry, rx] = poses[sc.id];
    const settle = i === 0 ? 0.3 : 0.62;
    const driftDur = Math.max(0.5, sc.dur - settle - 0.5);
    e.code(`tl.to("#rig",{rotationY:${ry + 5},y:-12,duration:${e.r(driftDur)},ease:"sine.inOut"},${e.r(sc.start + settle)});`);
    if ((opt.zoom || []).includes(sc.id)) e.code(`tl.to("#rig",{scale:1.05,duration:${e.r(driftDur)},ease:"sine.inOut"},${e.r(sc.start + settle)}).to("#rig",{scale:1,duration:.5},${e.r(sc.start + sc.dur - 0.5)});`);
    const next = list[i + 1];
    if (!next) return;
    const dir = i % 2 ? -1 : 1, b = next.start, [nry, nrx] = poses[next.id];
    e.code(`tl.to("#rig",{rotationY:${ry + 5 + 78 * dir},x:${-30 * dir},filter:"blur(5px)",duration:.42,ease:"power2.in"},${e.r(b - 0.42)});
tl.fromTo("#rig",{rotationY:${nry - 78 * dir},x:${30 * dir},y:-12,filter:"blur(5px)"},{rotationY:${nry},rotationX:${nrx},x:0,y:0,filter:"blur(0px)",duration:.6,ease:"power3.out",immediateRender:false},${e.r(b)});`);
    e.sfx("whoosh", b - 0.4, 0.16);
  });
  // exit into the end card
  e.code(`tl.to("#rig",{y:${L.H * 0.2},scale:.7,opacity:0,rotationX:20,duration:.7,ease:"power3.in"},${e.r(last.start + last.dur - 0.3)});`);

  // scene copy; a word card opens every scene that has a `word` (public: all, admin: each section)
  const chapters = list.filter((sc) => sc.word);
  list.forEach((sc, i) => {
    const npHtml = sc.np.map((line, i) => `<div class="mask"><div class="npline">${words(line, (sc.accent || [1]).includes(i) ? line.split(" ").map((_, k) => k) : [])}</div></div>`).join("");
    e.clip(`copy_${sc.id}`, sc.start, sc.dur, `<div class="copy" id="cp_${sc.id}">
  <div class="eyebrow">${sc.eyebrow}</div>
  <div class="mask"><div class="label">${chars(sc.label)}</div></div>
  <div class="thread"></div>${npHtml}${opt.extrasCopy ? opt.extrasCopy(sc) : ""}</div>`, "full");
    const S = sc.start;
    e.code(`tl.fromTo("#cp_${sc.id} .eyebrow",{x:-24,opacity:0},{x:0,opacity:1,duration:.6,ease:"expo.out"},${e.r(S + 0.2)});
tl.fromTo("#cp_${sc.id} .ch",{yPercent:115},{yPercent:0,duration:.85,ease:"expo.out",stagger:.022},${e.r(S + 0.25)});
tl.fromTo("#cp_${sc.id} .thread",{scaleX:0},{scaleX:1,duration:.8,ease:"expo.out"},${e.r(S + 0.5)});
tl.fromTo("#cp_${sc.id} .npline .w",{yPercent:80,opacity:0},{yPercent:0,opacity:1,duration:.6,ease:"expo.out",stagger:.07},${e.r(S + 0.65)});
tl.to("#cp_${sc.id}",{y:-26,opacity:0,duration:.32,ease:"power2.in"},${e.r(S + sc.dur - 0.38)});`);
    opt.extrasAnim?.(e, L, sc);
    if (sc.focus) focus(e, L, sc);
    if (sc.word) chapter(e, L, sc, chapters.indexOf(sc), chapters.length);
    if (opt.stickers?.[sc.id]) sticker(e, L, sc, i, opt.stickers[sc.id]);
  });
  // the halo behind the phone breathes with each scene
  e.code(`tl.fromTo("#halo",{opacity:0,scale:.6},{opacity:1,scale:1,duration:1.2,ease:"expo.out"},${e.r(first.start - 0.4)});`);
  list.forEach((sc) => e.code(`tl.fromTo("#halo",{scale:1.25},{scale:1,duration:1.4,ease:"expo.out",immediateRender:false},${e.r(sc.start + 0.2)});`));
  e.code(`tl.to("#halo",{opacity:0,duration:.6},${e.r(last.start + last.dur - 0.3)});`);
}

// Close-ups. The camera flies the phone to the middle of the frame and pushes in on one point of the
// screen (source px, 720×1640) while the rest of the screen frosts over; consecutive close-ups pan
// from one to the next instead of letting go in between.
// sc.focus: [{ at: scene s | tap: n (nth logged tap) | src: [clip, seconds], x, y, k = zoom, hold }]
const plans = new Map();
export function focusPlan(L, sc) {
  const key = `${sc.id}:${L.W}`;
  if (plans.has(key)) return plans.get(key);
  const P = L.phone, s = P.screenW / 720, big = L.W > L.H;
  const left = P.cx - P.w / 2 + P.pad, top = P.cy - P.h / 2 + P.pad;
  const taps = sc.touches.filter((t) => t.kind === "tap");
  const plan = (sc.focus || []).map((f) => {
    const tap = f.tap != null ? taps[f.tap] : null;
    // tap close-ups arrive just before the finger and let go of the ring right after it
    const local = f.at ?? (f.src ? sc.srcAt(...f.src) : tap.t - 0.8);
    const tapAt = tap ? sc.start + tap.t : null;
    const x = f.x ?? tap?.x1 ?? (f.box ? f.box[0] + f.box[2] / 2 : 360), y = f.y ?? tap?.y1 ?? (f.box ? f.box[1] + f.box[3] / 2 : 820);
    const [clip, src] = tap ? [tap.clip, tap.src - 0.25] : f.src ? [f.src[0], f.src[1] + 0.2] : sc.toSrc(local + 0.5);
    const [bx, by, bw, bh] = f.box || componentBox(sc.cfr(clip), src, x, y);
    if (process.env.BOXES) console.error(JSON.stringify({ id: sc.id, clip, src, box: [bx, by, bw, bh], tap: [x, y] }));
    const cx = bx + bw / 2, cy = by + bh / 2; // look at the component's centre, not the fingertip
    const sx = cx * s, sy = P.bar + (cy - 60) * s;
    const k = f.k ?? Math.min(2.8, Math.max(1.95, 560 / Math.max(bw, bh * 1.6))); // small things get closer
    return { at: sc.start + local, tapAt, k, hold: f.hold ?? 1.0, sx, sy, px: left + sx, py: top + sy,
      box: [bx * s, P.bar + (by - 60) * s, bw * s, bh * s],
      tx: f.tx ?? L.W / 2, ty: f.ty ?? (big ? L.H * 0.5 : L.H * 0.47) };
  }).sort((a, b) => a.at - b.at);
  // one ring at a time: each clears before the next one comes in
  plan.forEach((f, i) => { f.re = Math.min(f.tapAt ? f.tapAt + 0.22 : f.at + 0.6 + f.hold, plan[i + 1] ? plan[i + 1].at + 0.2 : Infinity); });
  plans.set(key, plan);
  return plan;
}

// how long the ring shows: until just after the finger lands (tap) or for the hold (look)
const ringEnd = (f) => f.re;
const release = (f) => (f.tapAt ? f.tapAt + 0.25 + f.hold * 0.6 : f.at + 0.6 + f.hold);

// frosted screen with a sharp window over the component: four blurred panels + a ring
export const spotHtml = (e, L, sc) => focusPlan(L, sc).map((f, i) => {
  const P = L.phone, W = P.screenW, H = P.screenH;
  const [x1, y1, w, h] = [Math.max(4, f.box[0]), Math.max(P.bar, f.box[1]), Math.min(W - 8, f.box[2]), f.box[3]], x2 = Math.min(W - 4, x1 + w), y2 = Math.min(H - 4, y1 + h);
  const b = (l, t, ww, hh) => `<i style="left:${l.toFixed(0)}px;top:${t.toFixed(0)}px;width:${Math.max(0, ww).toFixed(0)}px;height:${Math.max(0, hh).toFixed(0)}px"></i>`;
  return `<div id="sp_${sc.id}_${i}" class="clip spot" data-start="${e.r(f.at + 0.25)}" data-duration="${e.r(ringEnd(f) - f.at + 0.1)}">${b(0, 0, W, y1)}${b(0, y2, W, H - y2)}${b(0, y1, x1, y2 - y1)}${b(x2, y1, W - x2, y2 - y1)}<b style="left:${(x1 - 3).toFixed(0)}px;top:${(y1 - 3).toFixed(0)}px;width:${(x2 - x1 + 6).toFixed(0)}px;height:${(y2 - y1 + 6).toFixed(0)}px"></b></div>`;
}).join("");

function focus(e, L, sc) {
  const plan = focusPlan(L, sc);
  plan.forEach((f, i) => {
    const next = plan[i + 1], out = release(f), chain = next && next.at < out + 0.3, re = ringEnd(f);
    e.code(`tl.to("#cam",{scale:${f.k.toFixed(2)},x:${(f.tx - f.px * f.k).toFixed(0)},y:${(f.ty - f.py * f.k).toFixed(0)},duration:.6,ease:"expo.inOut"},${e.r(f.at)});
tl.fromTo("#sp_${sc.id}_${i}",{opacity:0},{opacity:1,duration:.25,ease:"power2.out"},${e.r(f.at + 0.25)});
tl.fromTo("#sp_${sc.id}_${i} b",{scale:1.25,opacity:0},{scale:1,opacity:1,duration:.4,ease:"back.out(2.2)"},${e.r(f.at + 0.3)});${f.tapAt ? `
tl.to("#sp_${sc.id}_${i} b",{scale:.94,duration:.08,yoyo:true,repeat:1},${e.r(f.tapAt - 0.05)});` : ""}
tl.to("#sp_${sc.id}_${i}",{opacity:0,duration:.15},${e.r(re - 0.05)});`);
    if (!chain) e.code(`tl.to("#cam",{scale:1,x:0,y:0,duration:.65,ease:"expo.inOut"},${e.r(out)});`);
    e.sfx("zoom", f.at - 0.05, 0.22); e.sfx("flash", f.at + 0.3, 0.1);
    if (!chain) e.sfx("whoosh", out, 0.1);
  });
  if (plan.length) { // the copy steps aside while the camera is close
    const a = plan[0].at, z = release(plan[plan.length - 1]);
    e.code(`tl.to(["#cp_${sc.id}","#st_${sc.id}"],{opacity:0,duration:.3},${e.r(a)});
tl.to(["#cp_${sc.id}","#st_${sc.id}"],{opacity:1,duration:.4},${e.r(z + 0.3)});`);
  }
}

// A dark-green card wipes across every cut: one big word, then it lifts away to the next scene.
function chapter(e, L, sc, i, n) { // i/n: this card's place among the cards
  const b = sc.start, id = `ch_${sc.id}`, big = L.W > L.H;
  const ox = big ? (i % 2 ? 22 : 78) : 50, oy = big ? 55 : (i % 2 ? 30 : 70);
  e.clip(id, b - 0.55, 1.35, `<div class="chap" id="${id}i"><div class="chapword" style="font-size:${big ? 230 : 170}px"><span class="mask">${chars(sc.word)}</span></div>
    <div class="chapnum">${String(i + 1).padStart(2, "0")} / ${String(n).padStart(2, "0")}</div></div>`, "full top");
  e.code(`tl.fromTo("#${id}i",{clipPath:"circle(0% at ${ox}% ${oy}%)"},{clipPath:"circle(150% at ${ox}% ${oy}%)",duration:.5,ease:"power3.in"},${e.r(b - 0.55)});
tl.fromTo("#${id}i .ch",{yPercent:110},{yPercent:0,duration:.55,ease:"expo.out",stagger:.025},${e.r(b - 0.3)});
tl.fromTo("#${id}i .chapnum",{opacity:0,y:12},{opacity:.7,y:0,duration:.4},${e.r(b - 0.2)});
tl.fromTo("#${id}i .chapword",{scale:1.06},{scale:1,duration:1.0,ease:"power2.out"},${e.r(b - 0.3)});
tl.to("#${id}i",{clipPath:"inset(0% 0% 100% 0%)",duration:.5,ease:"power3.inOut"},${e.r(b + 0.3)});`);
  e.sfx("whoosh", b - 0.6, 0.22); e.sfx("hit", b - 0.08, 0.22);
}

// A small 3D sticker sits on the phone's corner for each scene.
function sticker(e, L, sc, i, png) {
  const P = L.phone, big = L.W > L.H, size = big ? 150 : 170;
  const x = big ? P.cx - P.w / 2 - size * 0.55 : P.cx + P.w / 2 - size * 0.45;
  const y = big ? P.cy - P.h / 2 + 70 : P.cy - P.h / 2 - size * 0.2;
  const id = `st_${sc.id}`, rot = i % 2 ? 10 : -10;
  e.clip(id, sc.start + 0.5, sc.dur - 0.6, `<img class="ic" id="${id}i" src="assets/pngw/${png}.png" style="left:${x}px;top:${y}px;width:${size}px;filter:drop-shadow(0 18px 30px rgba(13,15,14,.22))">`, "full top2");
  e.code(`tl.fromTo("#${id}i",{scale:0,rotation:${rot * 3},opacity:0},{scale:1,rotation:${rot},opacity:1,duration:.65,ease:"back.out(2.2)"},${e.r(sc.start + 0.9)});
tl.to("#${id}i",{y:-12,duration:1.1,yoyo:true,repeat:${Math.max(1, Math.floor((sc.dur - 2.5) / 1.1))},ease:"sine.inOut"},${e.r(sc.start + 1.55)});
tl.to("#${id}i",{scale:0,opacity:0,duration:.3,ease:"back.in(2)"},${e.r(sc.start + sc.dur - 0.45)});`);
  e.sfx("pop", sc.start + 0.9, 0.18);
}
