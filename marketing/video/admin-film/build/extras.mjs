// Admin film: the motion that belongs to scenes — glass cards with rolling numbers, settings pills,
// branch merge, stock transfer, warden permission toggles, the eSewa receipt scan and PDF close-ups.
import { words } from "../../lib/emit.mjs";

const TICK = `<svg width="56%" viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const big = (L) => L.W > L.H;

// where floating pieces sit: beside the phone (landscape) or over its upper right (portrait)
function side(L) {
  const P = L.phone, cw = big(L) ? 400 : 470;
  return big(L) ? { x: P.cx + P.w / 2 - 70, y: L.H * 0.5 } : { x: L.W - cw - 36, y: P.cy - P.h / 2 + 70 };
}
// the empty half of the frame: left of the phone (landscape) / lower band (portrait)
function stage(L) {
  return big(L) ? { x: 150, y: 150, w: 880 } : { x: 60, y: 1360, w: 960 };
}

// digits roll like an odometer; everything else stays put
const odo = (v) => [...v].map((c) => /\d/.test(c)
  ? `<span class="od"><span class="odc" data-d="${c}">${[...Array(10).keys()].map((n) => `<span>${n}</span>`).join("")}</span></span>`
  : `<span>${c === " " ? "&nbsp;" : c}</span>`).join("");

function rollIn(e, sel, t) {
  e.code(`document.querySelectorAll("${sel} .odc").forEach((el, i, all) => tl.fromTo(el,{yPercent:0},{yPercent:-10 * Number(el.dataset.d),duration:.9 + (all.length - i) * .06,ease:"expo.out"},${e.r(t)}));`);
}

// the outer copy clip, so it never fights the close-up dimming on the inner block
export const hideCopy = (e, sc, t0) =>
  e.code(`tl.to("#copy_${sc.id}",{opacity:0,x:-30,duration:.3,ease:"power2.in"},${e.r(t0)});`);

function cards(e, L, sc) {
  const { x, y } = side(L), list = sc.cards;
  list.forEach((c, i) => {
    const t = sc.start + c.at, end = list[i + 1] ? sc.start + list[i + 1].at - 0.1 : sc.start + sc.dur - 0.35;
    const id = `gc_${sc.id}_${i}`;
    const body = c.bars
      ? c.bars.map(([l, p]) => `<div class="gbar"><div class="bl"><span>${l}</span><b>${p}%</b></div><div class="bt"><div class="bf" style="width:${(p / c.bars[0][1]) * 100}%"></div></div></div>`).join("")
      : `${c.value ? `<div class="gv">${odo(c.value)}</div>` : ""}${c.sub ? `<div class="gs">${c.sub}</div>` : ""}${(c.rows || []).map(([a, b]) => `<div class="grow"><span>${a}</span><b>${b}</b></div>`).join("")}`;
    e.clip(id, t - 0.05, end - t + 0.4, `<div class="gcard" id="${id}i" style="left:${x}px;top:${y - (c.bars ? 120 : 70)}px">
      <img class="gi" src="assets/pngw/${c.png}.png"><div class="gb"><div class="gt">${c.title}</div>${body}</div>${c.tick ? `<div class="gtick">${TICK}</div>` : ""}</div>`, "full top2");
    e.code(`tl.fromTo("#${id}i",{x:80,y:20,opacity:0,scale:.86,rotationY:-28,filter:"blur(8px)"},{x:0,y:0,opacity:1,scale:1,rotationY:0,filter:"blur(0px)",duration:.75,ease:"expo.out"},${e.r(t)});
tl.fromTo("#${id}i .gi",{scale:0,rotation:-25},{scale:1,rotation:0,duration:.6,ease:"back.out(2.4)"},${e.r(t + 0.15)});
tl.to("#${id}i",{y:-8,duration:1.2,yoyo:true,repeat:1,ease:"sine.inOut"},${e.r(t + 0.8)});
tl.to("#${id}i",{x:-40,opacity:0,scale:.94,filter:"blur(6px)",duration:.35,ease:"power2.in"},${e.r(end)});`);
    e.sfx("glass", t - 0.05, 0.3);
    if (c.value && /\d/.test(c.value)) { rollIn(e, `#${id}i`, t + 0.2); e.sfx("count", t + 0.2, 0.18); }
    if (c.bars) {
      e.code(`tl.fromTo("#${id}i .bf",{scaleX:0},{scaleX:1,duration:.8,ease:"expo.out",stagger:.12},${e.r(t + 0.3)});`);
      c.bars.forEach((_, k) => e.sfx("bubble", t + 0.3 + k * 0.12, 0.12));
    }
    if (c.tick) {
      e.code(`tl.fromTo("#${id}i .gtick",{scale:0,rotation:-40},{scale:1,rotation:0,duration:.5,ease:"back.out(3)"},${e.r(t + 0.75)});`);
      e.sfx(/Rs/.test(c.value || "") ? "coin" : "success", t + 0.75, 0.26);
    }
  });
}

function pills(e, L, sc) {
  const P = L.phone;
  sc.pills.forEach((p, i) => {
    const t = sc.start + p.at, id = `pl_${sc.id}_${i}`;
    const x = big(L) ? P.cx + P.w / 2 - 80 : 50, y = big(L) ? 330 + i * 110 : P.cy - P.h / 2 + 120 + i * 100;
    e.clip(id, t - 0.05, sc.start + sc.dur - t - 0.2, `<div class="pill2" id="${id}i" style="left:${x}px;top:${y}px"><span class="dt"></span>${p.text}</div>`, "full top2");
    e.code(`tl.fromTo("#${id}i",{x:${big(L) ? 60 : -60},opacity:0,scale:.8},{x:0,opacity:1,scale:1,duration:.6,ease:"back.out(2)"},${e.r(t)});
tl.to("#${id}i",{opacity:0,y:-16,duration:.3},${e.r(sc.start + sc.dur - 0.45)});`);
    e.sfx("bubble", t, 0.22);
  });
}

// Two hostels slide together and click into one: Overall.
function branchMerge(e, L, sc) {
  const tap = sc.touches.filter((t) => t.kind === "tap")[3];
  const m = sc.start + (tap ? tap.t + 0.2 : 4.5), a = sc.start + 1.4, S = stage(L);
  const y = big(L) ? 740 : S.y, x1 = S.x + 20, x2 = S.x + (big(L) ? 470 : 520), xm = S.x + (big(L) ? 230 : 250);
  e.clip("bm", a - 0.05, sc.start + sc.dur - a - 0.2, `
    <div class="bnode" id="bmA" style="left:${x1}px;top:${y}px"><img src="assets/pngw/house.png"><div><div class="bn">Main</div><div class="bs">Ghattekulo</div></div></div>
    <div class="bnode" id="bmB" style="left:${x2}px;top:${y}px"><img src="assets/pngw/hotel.png"><div><div class="bn">Branch</div><div class="bs">Kathmandu-01</div></div></div>
    <div class="bnode all" id="bmC" style="left:${xm}px;top:${y}px"><img src="assets/pngw/link.png"><div><div class="bn">Overall</div><div class="bs">2 branches together</div></div></div>`, "full top2");
  e.code(`tl.fromTo("#bmA",{x:-90,opacity:0,scale:.85},{x:0,opacity:1,scale:1,duration:.7,ease:"expo.out"},${e.r(a)});
tl.fromTo("#bmB",{x:90,opacity:0,scale:.85},{x:0,opacity:1,scale:1,duration:.7,ease:"expo.out"},${e.r(a + 0.15)});
tl.to("#bmA",{x:${xm - x1},duration:.45,ease:"power3.in"},${e.r(m - 0.45)});
tl.to("#bmB",{x:${xm - x2},duration:.45,ease:"power3.in"},${e.r(m - 0.45)});
tl.to(["#bmA","#bmB"],{opacity:0,scale:.9,duration:.15},${e.r(m)});
tl.fromTo("#bmC",{opacity:0,scale:1.25},{opacity:1,scale:1,duration:.55,ease:"back.out(2.2)"},${e.r(m)});
tl.to("#bmC",{opacity:0,y:-20,duration:.3},${e.r(sc.start + sc.dur - 0.5)});`);
  e.sfx("bubble", a, 0.2); e.sfx("bubble", a + 0.15, 0.18); e.sfx("snap", m - 0.02, 0.45); e.sfx("flash", m, 0.22);
}

// Stock walks from the main hostel to the branch.
function transfer(e, L, sc) {
  const T = sc.transfer, t = sc.start + T.at, S = stage(L);
  const y = big(L) ? 680 : S.y, x1 = S.x + 20, x2 = S.x + (big(L) ? 560 : 600);
  e.clip("tr", t - 0.05, sc.start + sc.dur - t - 0.1, `
    <svg width="${L.W}" height="${L.H}" style="position:absolute;inset:0"><path id="trp" d="M${x1 + 250} ${y + 52} L${x2 - 20} ${y + 52}" stroke="#0a8a4b" stroke-width="5" stroke-dasharray="2 14" stroke-linecap="round" fill="none"/></svg>
    <div class="bnode" id="trA" style="left:${x1}px;top:${y}px"><img src="assets/pngw/house.png"><div><div class="bn">Main</div><div class="bs">Rice 35 kg left</div></div></div>
    <div class="bnode" id="trB" style="left:${x2}px;top:${y}px"><img src="assets/pngw/hotel.png"><div><div class="bn">Branch</div><div class="bs">taps Got it</div></div></div>
    ${T.items.map((it, i) => `<div class="tchip" id="trc${i}" style="left:${x1 + 250}px;top:${y + 30 + i * 0}px">${it}</div>`).join("")}`, "full top2");
  e.code(`tl.fromTo(["#trA","#trB"],{y:30,opacity:0,scale:.85},{y:0,opacity:1,scale:1,duration:.6,ease:"back.out(2)",stagger:.15},${e.r(t)});
tl.fromTo("#trp",{opacity:0},{opacity:1,duration:.4},${e.r(t + 0.3)});`);
  T.items.forEach((_, i) => {
    const s = t + 0.6 + i * 0.55;
    e.code(`tl.fromTo("#trc${i}",{x:0,opacity:0,scale:.6},{x:${x2 - x1 - 330},opacity:1,scale:1,duration:1.0,ease:"power2.inOut"},${e.r(s)}).to("#trc${i}",{opacity:0,scale:.5,duration:.2},${e.r(s + 1.0)});`);
    e.sfx("swish", s, 0.2); e.sfx("plink", s + 1.0, 0.24);
  });
  e.code(`tl.to("#tr",{opacity:0,duration:.3},${e.r(sc.start + sc.dur - 0.45)});`);
  if (big(L)) hideCopy(e, sc, t - 0.1);
}

// The warden's permissions switch on one by one; the ones you keep stay locked.
function perms(e, L, sc) {
  const p = sc.perms, t = sc.start + p.at;
  const x = big(L) ? 160 : (L.W - 520) / 2, y = big(L) ? 210 : 1180;
  const rows = [...p.on.map((n) => [n, 1]), ...p.off.map((n) => [n, 0])];
  e.clip("perm", t - 0.05, sc.start + sc.dur - t - 0.1, `<div class="perm" id="pmi" style="left:${x}px;top:${y}px">
    <div class="ph"><img src="assets/pngw/key.png">What Ram may do</div>
    ${rows.map(([n, on], i) => `<div class="pr2${on ? "" : " off"}" id="pm${i}"><span>${n}</span><span class="sw" id="sw${i}"><i></i></span></div>`).join("")}</div>`, "full top2");
  e.code(`tl.fromTo("#pmi",{x:${big(L) ? -60 : 0},y:${big(L) ? 0 : 60},opacity:0,scale:.9},{x:0,y:0,opacity:1,scale:1,duration:.6,ease:"expo.out"},${e.r(t)});
tl.fromTo("#pmi .pr2",{opacity:0,x:-20},{opacity:1,x:0,duration:.35,stagger:.06},${e.r(t + 0.2)});`);
  rows.forEach(([, on], i) => {
    if (!on) return;
    const s = t + 0.7 + i * 0.32;
    e.code(`tl.to("#sw${i}",{backgroundColor:"#0a8a4b",duration:.18},${e.r(s)}).to("#sw${i} i",{x:24,duration:.22,ease:"back.out(2)"},${e.r(s)});`);
    e.sfx("toggle", s, 0.3);
  });
  e.code(`tl.to("#pmi",{opacity:0,x:-30,duration:.35},${e.r(sc.start + sc.dur - 0.5)});`);
  hideCopy(e, sc, t - 0.1);
}

// The eSewa receipt lifts off the phone; a light reads it; the fields drop out as facts.
function scan(e, L, sc) {
  const t = sc.start + (sc.scan.at ?? sc.srcAt(...sc.scan.src)), P = L.phone;
  const w = big(L) ? 470 : 440, h = w * (800 / 720);
  const x = big(L) ? 170 : 70, y = big(L) ? (L.H - h) / 2 - 20 : 700;
  const fx = x + w + 30, fields = [["Amount", "Rs 50"], ["To", "Ritik Kumar Mandal"], ["Paid by", "eSewa"], ["Code", "1SKTPB2"]];
  e.clip("scan", t - 0.05, 1.15 + 4 * 0.36 + 0.3 + 1.75, `
    <div class="pdfsheet" id="scS" style="left:${x}px;top:${y}px;width:${w}px;border-radius:22px"><img src="assets/img/esewa_card.jpg">
      <div id="scB" style="position:absolute;left:0;right:0;top:0;height:18%;background:linear-gradient(180deg,rgba(18,169,93,0),rgba(18,169,93,.35) 80%,#5fffb0);box-shadow:0 6px 30px #12a95d"></div></div>
    ${fields.map(([k, v], i) => `<div class="pill2" id="scF${i}" style="left:${big(L) ? fx : x + 40}px;top:${big(L) ? y + 40 + i * 104 : y + h + 30 + i * 0}px"><span class="dt"></span><span style="color:#6d6885;font-weight:600">${k}</span>&nbsp;${v}</div>`).join("")}
    <div class="pill2" id="scOk" style="left:${big(L) ? fx : x + 40}px;top:${big(L) ? y + 40 + 4 * 104 + 20 : y + h + 30}px;background:#0d0f0e;color:#fff"><span class="dt"></span>Expense saved · Rs 50</div>`, "full top2");
  const px = P.cx - x - w / 2, py = P.cy - y - h / 2;
  e.code(`tl.fromTo("#scS",{x:${px},y:${py},scale:.35,rotation:6,opacity:0},{x:0,y:0,scale:1,rotation:-3,opacity:1,duration:.9,ease:"expo.out"},${e.r(t)});
tl.fromTo("#scB",{yPercent:-100,opacity:1},{yPercent:556,duration:1.5,ease:"power1.inOut"},${e.r(t + 0.9)});
tl.to("#scB",{opacity:0,duration:.2},${e.r(t + 2.4)});`);
  e.sfx("paper", t, 0.35); e.sfx("scan", t + 0.9, 0.35);
  fields.forEach((_, i) => {
    const s = t + 1.15 + i * 0.36;
    if (big(L)) e.code(`tl.fromTo("#scF${i}",{x:-50,opacity:0,scale:.7},{x:0,opacity:1,scale:1,duration:.5,ease:"back.out(2.2)"},${e.r(s)});`);
    else e.code(`tl.fromTo("#scF${i}",{y:30,opacity:0,scale:.7},{y:0,opacity:1,scale:1,duration:.45,ease:"back.out(2.2)"},${e.r(s)}).to("#scF${i}",{opacity:0,y:-20,duration:.2},${e.r(s + 0.33)});`);
    e.sfx("bubble", s, 0.22);
  });
  const ok = t + 1.15 + 4 * 0.36 + 0.3;
  e.code(`tl.fromTo("#scOk",{scale:.6,opacity:0},{scale:1,opacity:1,duration:.55,ease:"back.out(2.4)"},${e.r(ok)});
tl.to("#scS",{rotation:0,scale:.96,duration:.5},${e.r(ok)});
tl.to("#scan",{opacity:0,x:-40,filter:"blur(8px)",duration:.35},${e.r(ok + 1.3)});`);
  e.sfx("success", ok, 0.3);
  hideCopy(e, sc, t - 0.1);
}

// A PDF slides out of the phone; the camera leans in on the numbers that matter.
const STATEMENT = { // statement page at 600px wide: Debit / Credit / Balance columns, row centres
  col: { debit: [346, 404], credit: [420, 476], balance: [488, 552] },
  row: (k) => 0.4267 * (370 + 41.1 * k),
};
function pdf(e, L, sc) {
  const t = sc.start + sc.pdf.at, P = L.phone;
  const w = big(L) ? 600 : 620, h = w * (1988 / 1406), x = big(L) ? 160 : (L.W - w) / 2, y = big(L) ? 110 : 640;
  const id = `pdf_${sc.id}`, k = w / 600;
  const S = STATEMENT, isSt = sc.pdf.file === "statement";
  const box = (c, r, cls = "") => `<div class="hl ${cls}" style="left:${(S.col[c][0] - 6) * k}px;top:${(S.row(r) - 14) * k}px;width:${(S.col[c][1] - S.col[c][0] + 12) * k}px;height:${28 * k}px"></div>`;
  const marks = isSt ? [box("credit", 1), box("debit", 6, "red"), `<div class="hl" style="left:${330 * k}px;top:${(0.4267 * 1659 - 16) * k}px;width:${230 * k}px;height:${32 * k}px"></div>`] : [];
  e.clip(id, t - 0.05, sc.start + sc.dur - t - 0.1, `<div class="pdfsheet" id="${id}s" style="left:${x}px;top:${y}px;width:${w}px">
    <img src="assets/img/pdf_${sc.pdf.file}.png">${marks.map((m, i) => m.replace('class="hl', `id="${id}h${i}" class="hl`)).join("")}</div>
    ${isSt ? `<div class="ptag" id="${id}t0" style="left:${x + w * 0.5}px;top:${y + 40}px;background:#0a8a4b">Credit · money in</div>
    <div class="ptag" id="${id}t1" style="left:${x + w * 0.5}px;top:${y + 40}px;background:#c2412d">Debit · money out</div>` : ""}`, "full top2");
  const px = P.cx - x - w / 2, py = P.cy - y - h / 2;
  e.code(`tl.fromTo("#${id}s",{x:${px},y:${py},scale:.3,rotation:8,opacity:0},{x:0,y:0,scale:1,rotation:-2,opacity:1,duration:.9,ease:"expo.out"},${e.r(t)});`);
  e.sfx("paper", t, 0.4); e.sfx("page", t + 0.7, 0.25);
  if (isSt) {
    // lean in on rows 1–8, mark a credit then a debit, slide down to the totals
    const ox = 470 * k, oy = S.row(4) * k;
    e.code(`tl.to("#${id}s",{scale:2.1,rotation:0,transformOrigin:"${ox.toFixed(0)}px ${oy.toFixed(0)}px",duration:.8,ease:"power3.inOut"},${e.r(t + 1.0)});
tl.fromTo("#${id}h0",{opacity:0,scale:1.3},{opacity:1,scale:1,duration:.35,ease:"back.out(2)"},${e.r(t + 1.7)});
tl.fromTo("#${id}t0",{opacity:0,y:20,scale:.8},{opacity:1,y:0,scale:1,duration:.4,ease:"back.out(2)"},${e.r(t + 1.75)});
tl.to("#${id}t0",{opacity:0,duration:.2},${e.r(t + 2.55)});
tl.fromTo("#${id}h1",{opacity:0,scale:1.3},{opacity:1,scale:1,duration:.35,ease:"back.out(2)"},${e.r(t + 2.6)});
tl.fromTo("#${id}t1",{opacity:0,y:20,scale:.8},{opacity:1,y:0,scale:1,duration:.4,ease:"back.out(2)"},${e.r(t + 2.65)});
tl.to("#${id}t1",{opacity:0,duration:.2},${e.r(t + 3.5)});
tl.to("#${id}s",{y:${(-(0.4267 * 1659 - S.row(4)) * k * 1.6).toFixed(0)},scale:1.6,duration:.8,ease:"power3.inOut"},${e.r(t + 3.5)});
tl.fromTo("#${id}h2",{opacity:0,scale:1.3},{opacity:1,scale:1,duration:.35,ease:"back.out(2)"},${e.r(t + 4.2)});`);
    e.sfx("zoom", t + 1.0, 0.25); e.sfx("bubble", t + 1.7, 0.25); e.sfx("click", t + 2.6, 0.3); e.sfx("swish", t + 3.5, 0.2); e.sfx("stamp", t + 4.2, 0.3);
  } else {
    e.code(`tl.to("#${id}s",{scale:1.55,rotation:0,transformOrigin:"50% 18%",duration:2.6,ease:"power2.inOut"},${e.r(t + 1.0)});`);
    e.sfx("zoom", t + 1.0, 0.2);
  }
  e.code(`tl.to("#${id}s",{opacity:0,y:"-=60",duration:.4,ease:"power2.in"},${e.r(sc.start + sc.dur - 0.55)});`);
  hideCopy(e, sc, t - 0.1);
}

// numbered process captions over the top of the frame, one replacing the next
function steps(e, L, sc) {
  const taps = sc.touches.filter((t) => t.kind === "tap");
  const when = (s) => sc.start + (s.at ?? (s.src ? sc.srcAt(...s.src) : taps[s.tap].t - 0.3));
  const list = sc.steps.map((s) => ({ ...s, t: when(s) })), y = big(L) ? 70 : 150;
  list.forEach((s, i) => {
    const end = list[i + 1] ? list[i + 1].t : sc.start + sc.dur - 0.4, id = `stp_${sc.id}_${i}`;
    e.clip(id, s.t - 0.05, end - s.t + 0.35, `<div class="center" style="position:absolute;left:0;right:0;top:${y}px">
      <div class="step" id="${id}i"><span class="sn">${s.n}</span><span class="np">${s.text}</span></div></div>`, "full top");
    e.code(`tl.fromTo("#${id}i",{y:-30,opacity:0,scale:.85,filter:"blur(10px)"},{y:0,opacity:1,scale:1,filter:"blur(0px)",duration:.45,ease:"back.out(2)"},${e.r(s.t)});
tl.fromTo("#${id}i .sn",{scale:0,rotation:-90},{scale:1,rotation:0,duration:.45,ease:"back.out(3)"},${e.r(s.t + 0.1)});
tl.to("#${id}i",{y:24,opacity:0,filter:"blur(8px)",duration:.25,ease:"power2.in"},${e.r(end)});`);
    e.sfx("bubble", s.t, 0.26);
  });
}

// a pill on the phone saying whose phone this is (resident / warden / cook portals)
function badge(e, L, sc) {
  const P = L.phone, t = sc.start + 0.6;
  const x = big(L) ? P.cx - P.w / 2 - 250 : P.cx - 170, y = big(L) ? P.cy + 220 : P.cy - P.h / 2 - 90;
  e.clip(`bd_${sc.id}`, t - 0.05, sc.dur - 0.9, `<div class="pill2" id="bd_${sc.id}i" style="left:${x}px;top:${y}px;background:#0d0f0e;color:#fff"><span class="dt"></span>${sc.badge}</div>`, "full top2");
  e.code(`tl.fromTo("#bd_${sc.id}i",{scale:.5,opacity:0},{scale:1,opacity:1,duration:.5,ease:"back.out(2.4)"},${e.r(t)});
tl.to("#bd_${sc.id}i",{opacity:0,duration:.25},${e.r(sc.start + sc.dur - 0.4)});`);
  e.sfx("flash", t - 0.1, 0.2);
}

export function extrasAnim(e, L, sc) {
  if (sc.cards) cards(e, L, sc);
  if (sc.pills) pills(e, L, sc);
  if (sc.id === "branch") branchMerge(e, L, sc);
  if (sc.transfer) transfer(e, L, sc);
  if (sc.perms) perms(e, L, sc);
  if (sc.scan) scan(e, L, sc);
  if (sc.pdf) pdf(e, L, sc);
  if (sc.badge) badge(e, L, sc);
  if (sc.steps) steps(e, L, sc);
}

export { words };
