// Public film only: copy and motion that belong to one scene (chips, map pins, route, receipt, tick).
import { PIN_SVG } from "../../lib/emit.mjs";

export const POSES = {
  landscape: { search: [-16, 4], map: [-7, 3], directions: [-12, 6], detail: [-18, 4], compare: [-10, 3], book: [-14, 5], refund: [-9, 3], idcard: [-5, 2] },
  portrait: { search: [-7, 3], map: [-3, 2], directions: [-6, 4], detail: [-8, 3], compare: [-5, 2], book: [-7, 3], refund: [-4, 2], idcard: [-2, 1] },
};
export const STICKERS = { search: "backpack", map: "map", directions: "bus", detail: "hotel", compare: "thinking", book: "key", refund: "shield", idcard: "student" };

export function extrasCopy(sc) {
  if (sc.id === "search") return `<div class="chips">${["Boys", "Girls", "Single", "Double", "Veg", "Wi-Fi"].map((c, i) => `<span class="chip" id="sc${i}"><span class="dot"></span>${c}</span>`).join("")}</div>`;
  if (sc.id === "detail") return `<div class="chips">${sc.chips.map((c) => `<span class="chip fx"><span class="dot"></span>${c}</span>`).join("")}</div>`;
  if (sc.id === "compare") return `<div class="chips"><span class="chip fx">Education Light Hostel</span><span class="vs fx">vs</span><span class="chip fx">Leeway Residence</span></div>`;
  if (sc.id === "idcard") return `<div class="chips"><span class="chip on fx"><span class="dot"></span>FREE</span><span class="chip fx">QR Scan</span><span class="chip fx">Save &amp; Share</span></div>`;
  return "";
}

export function extrasAnim(e, L, sc) {
  const S = sc.start, r = e.r;
  if (sc.id === "search") {
    e.code(`tl.fromTo("#cp_search .chip",{y:20,opacity:0},{y:0,opacity:1,duration:.5,ease:"back.out(2)",stagger:.06},${r(S + 1.0)});`);
    e.sfx("pop", S + 1.0, 0.16);
    // "Boys" and "Double" switch on when the finger taps them in the footage
    const taps = sc.touches.filter((t) => t.kind === "tap");
    const boys = taps.find((t) => Math.abs(t.x1 - 195) < 30 && Math.abs(t.y1 - 284) < 30);
    const dbl = taps.filter((t) => Math.abs(t.x1 - 340) < 30 && Math.abs(t.y1 - 839) < 30).pop();
    for (const [t, i] of [[boys, 0], [dbl, 3]]) if (t) {
      e.code(`tl.to("#sc${i}",{backgroundColor:"#0a8a4b",color:"#fff",duration:.2},${r(S + t.t)}).to("#sc${i} .dot",{backgroundColor:"#fff",duration:.2},${r(S + t.t)}).fromTo("#sc${i}",{scale:1},{scale:1.12,duration:.12,yoyo:true,repeat:1},${r(S + t.t)});`);
      e.sfx("pop", S + t.t + 0.02, 0.2);
    }
  }
  if (["detail", "compare", "idcard"].includes(sc.id)) {
    e.code(`tl.fromTo("#cp_${sc.id} .fx",{y:24,opacity:0,scale:.9},{y:0,opacity:1,scale:1,duration:.55,ease:"back.out(2)",stagger:.09},${r(S + 1.3)});`);
    e.sfx("pop", S + 1.3, 0.2); e.sfx("pop", S + 1.48, 0.15);
  }
  if (sc.id === "map" && L.pins.length) {
    const names = ["Education Light Hostel", "Alsus Boys Hostel", "Leeway Residence", "Sarthak Boys Hostel", "Dream Home Boys Hostel", "Aadarsh Boys Hostel"];
    const html = L.pins.map(([x, y], i) => `<div class="mpin" id="mp${i}" style="left:${x}px;top:${y - 46}px">${PIN_SVG()}<span>${names[i]}</span></div>`).join("");
    e.clip("mapPins", S, sc.dur, html, "full");
    L.pins.forEach((_, i) => {
      const t = S + 3.4 + i * 0.32;
      e.code(`tl.fromTo("#mp${i}",{y:-50,scale:.4,opacity:0},{y:0,scale:1,opacity:1,duration:.6,ease:"back.out(2.2)"},${r(t)});`);
      e.sfx("plink", t, 0.18);
    });
    e.code(`tl.to("#mapPins .mpin",{opacity:0,y:-20,duration:.3,stagger:.04},${r(S + sc.dur - 0.5)});`);
  }
  if (sc.id === "directions" && L.route) {
    const { from: [x1, y1], to: [x2, y2], c1, c2 } = L.route;
    const d = `M${x1} ${y1} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${x2} ${y2}`;
    e.clip("route", S, sc.dur, `<svg width="${L.W}" height="${L.H}" style="position:absolute;inset:0">
<defs><mask id="rmask"><path id="rpath" d="${d}" stroke="#fff" stroke-width="24" fill="none" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></mask></defs>
<path d="${d}" stroke="#0a8a4b" stroke-width="7" stroke-linecap="round" stroke-dasharray="0.1 16" fill="none" mask="url(#rmask)"/></svg>
<div class="mpin" id="dest" style="left:${x2 - 18}px;top:${y2 - 46}px">${PIN_SVG()}<span>Education Light · 5.7 km</span></div>`, "full");
    e.code(`tl.to("#rpath",{attr:{"stroke-dashoffset":0},duration:2.2,ease:"power2.inOut"},${r(S + 2.2)});
tl.fromTo("#dest",{y:-40,scale:.4,opacity:0},{y:0,scale:1,opacity:1,duration:.6,ease:"back.out(2)"},${r(S + 4.2)});
tl.to("#route",{opacity:0,duration:.35},${r(S + sc.dur - 0.45)});`);
    e.sfx("plink", S + 4.2, 0.22);
  }
  if (sc.id === "book") {
    const R = L.receipt, t = S + sc.receiptAt;
    e.clip("receipt", t - 0.1, sc.dur - sc.receiptAt + 0.1, `<div class="receipt" id="rc" style="left:${R.x}px;top:${R.y}px">
<img src="assets/img/HH-BKR-2083-84-00000003.png"><div class="stamp" id="stamp">RECEIVED</div></div>`, "full");
    const px = L.phone.cx - R.x - R.w / 2, py = L.phone.cy - R.y - R.w * 0.7;
    e.code(`tl.fromTo("#rc",{x:${px},y:${py},scale:.25,rotation:8,opacity:0},{x:0,y:0,scale:1,rotation:-5,opacity:1,duration:.9,ease:"expo.out"},${r(t)});
tl.fromTo("#stamp",{scale:2.4,rotation:-12,opacity:0},{scale:1,rotation:-12,opacity:1,duration:.35,ease:"back.out(1.6)"},${r(t + 0.9)});
tl.to("#rc",{x:${-L.W * 0.1},y:${-40},rotation:-10,opacity:0,duration:.45,ease:"power2.in"},${r(S + sc.dur - 0.5)});`);
    e.sfx("paper", t, 0.4); e.sfx("pop", t + 0.9, 0.25);
  }
  if (sc.id === "refund") {
    const tap = sc.touches.filter((t) => t.kind === "tap").pop();
    if (tap) {
      const t = S + tap.t + 0.15, x = L.W > L.H ? L.phone.cx - L.phone.w / 2 - L.tick * 1.35 : L.phone.cx - L.tick / 2, y = L.W > L.H ? L.phone.cy + 60 : L.phone.cy - L.phone.h / 2 - L.tick * 0.4;
      e.clip("tick", t - 0.05, S + sc.dur - t + 0.05, `<div class="tick" id="tk" style="left:${x}px;top:${y}px"><svg width="56%" viewBox="0 0 24 24"><path id="tkp" d="M5 12.5 10 17.5 19 7" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg></div>`, "full");
      e.code(`tl.fromTo("#tk",{scale:0},{scale:1,duration:.5,ease:"back.out(2.2)"},${r(t)}).to("#tkp",{attr:{"stroke-dashoffset":0},duration:.35,ease:"power2.out"},${r(t + 0.2)});`);
      e.sfx("success", t + 0.1, 0.3);
    }
  }
}

