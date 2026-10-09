// The dark half of the film: cold open, the three pains, and the light burst that reveals the brand.
import { words, PIN_SVG } from "../../lib/emit.mjs";

// deterministic pseudo-random (no Math.random in a render)
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// Words of a line appear across the time the voice takes to say them.
function speak(e, sel, at, len, n) {
  for (let i = 0; i < n; i++)
    e.code(`tl.fromTo("${sel} .w:nth-child(${i + 1})",{yPercent:60,opacity:0,filter:"blur(8px)"},{yPercent:0,opacity:1,filter:"blur(0px)",duration:.55,ease:"expo.out"},${e.r(at + (len * 0.92 * i) / n)});`);
}

// 0–10s: darkness, thousands of dots drifting into a city, one question.
export function cold(e, L, sc, vo) {
  const R = rng(7), cx = L.W / 2, cy = L.H * 0.47, big = L.W > L.H;
  const dots = Array.from({ length: 150 }, (_, i) => {
    const a = R() * Math.PI * 2, d = Math.max(L.W, L.H) * (0.55 + R() * 0.35);
    const tx = cx + (R() - 0.5) * L.W * 0.34, ty = cy + (R() - 0.5) * L.H * 0.3;
    return { i, x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, tx, ty, s: 3 + R() * 5, delay: R() * 2.5, g: R() < 0.25 };
  });
  e.clip("coldDots", 0, sc.dur + 0.4, dots.map((d) =>
    `<i class="sdot${d.g ? " g" : ""}" id="sd${d.i}" style="left:${d.tx.toFixed(0)}px;top:${d.ty.toFixed(0)}px;width:${d.s.toFixed(1)}px;height:${d.s.toFixed(1)}px"></i>`).join(""), "full");
  for (const d of dots)
    e.code(`tl.fromTo("#sd${d.i}",{x:${(d.x - d.tx).toFixed(0)},y:${(d.y - d.ty).toFixed(0)},opacity:0},{x:0,y:0,opacity:${d.g ? 0.95 : 0.5},duration:${(5.5 + d.delay).toFixed(2)},ease:"power2.out"},${(0.2 + d.delay * 0.6).toFixed(2)});`);
  e.code(`tl.to("#coldDots .sdot",{scale:0,opacity:0,duration:.6,ease:"power2.in",stagger:{each:.002,from:"center"}},${sc.dur - 0.8});`);

  const [a, b] = vo;
  const fs = big ? 76 : 70;
  e.clip("coldA", a.at - 0.1, a.len + 0.5, `<div class="cold" style="font-size:${fs}px">${words("हरेक वर्ष, हजारौं विद्यार्थी घर छोडेर नयाँ सहर पुग्छन्।", [2, 3])}</div>`, "full center");
  speak(e, "#coldA", a.at, a.len, 8);
  e.code(`tl.to("#coldA .cold",{opacity:0,y:-30,filter:"blur(10px)",duration:.4,ease:"power2.in"},${e.r(a.at + a.len + 0.05)});`);
  e.clip("coldB", b.at - 0.1, sc.dur - b.at + 0.1, `<div class="cold" style="font-size:${fs}px">${words("अनि सबैको मनमा एउटै प्रश्न हुन्छ —", [])}</div>
    <div class="cold q" id="coldQ" style="font-size:${big ? 190 : 150}px">${words("कहाँ बस्ने?", [0, 1])}</div>`, "full center col");
  speak(e, "#coldB .cold:first-child", b.at, 2.3, 6);
  const q = b.at + 3.0;
  e.code(`tl.fromTo("#coldQ",{scale:1.6,opacity:0,filter:"blur(24px)"},{scale:1,opacity:1,filter:"blur(0px)",duration:.9,ease:"expo.out"},${q});
tl.to("#coldB .cold:first-child",{opacity:.35,duration:.5},${q});
tl.to("#coldQ",{scale:1.08,duration:${e.r(sc.dur - q - 0.4)},ease:"none"},${q + 0.9});
tl.to("#coldB",{opacity:0,scale:.92,filter:"blur(12px)",duration:.45,ease:"power2.in"},${sc.dur - 0.45});`);
  e.sfx("hit", q, 0.45);
  e.sfx("riser", sc.dur - 3.2, 0.22);

  // home → city: a bus leaves the house for a row of hostels
  const y = L.H * (big ? 0.7 : 0.64), u = big ? 150 : 170;
  const hx = L.W * (big ? 0.16 : 0.14), cx1 = L.W * (big ? 0.74 : 0.66), cx2 = L.W * (big ? 0.85 : 0.86);
  const png = (id, name, x, size, extra = "") => `<img class="ic" id="${id}" src="assets/pngw/${name}.png" style="left:${x - size / 2}px;top:${y - size}px;width:${size}px;${extra}">`;
  e.clip("coldTrip", 0.6, a.at + a.len + 0.5 - 0.6, `<div class="full">
    <div class="ic" style="left:${hx}px;top:${y - 2}px;width:${cx2 - hx}px;height:2px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent)"></div>
    ${png("cpHouse", "house", hx, u)}${png("cpHotel", "hotel", cx1, u * 1.15)}${png("cpOffice", "office", cx2, u * 1.3)}
    ${png("cpBus", "bus", hx + u * 0.6, u * 0.7)}${png("cpBag", "backpack", hx - u * 0.75, u * 0.55)}
  </div>`, "full");
  e.code(`tl.fromTo(["#cpHouse","#cpBag"],{y:40,opacity:0,scale:.6},{y:0,opacity:1,scale:1,duration:.8,ease:"back.out(1.8)",stagger:.15},0.7);
tl.fromTo(["#cpHotel","#cpOffice"],{y:50,opacity:0,scale:.6},{y:0,opacity:1,scale:1,duration:.9,ease:"back.out(1.6)",stagger:.18},1.3);
tl.fromTo("#cpBus",{x:0,opacity:0},{x:${(cx1 - hx - u * 1.5).toFixed(0)},opacity:1,duration:3.0,ease:"power1.inOut"},1.6);
tl.fromTo("#cpBus",{y:0},{y:-4,duration:.15,yoyo:true,repeat:19,ease:"sine.inOut"},1.6);
tl.to("#coldTrip",{opacity:0,y:20,filter:"blur(6px)",duration:.4},${e.r(a.at + a.len)});`);
  e.sfx("pop", 0.75, 0.18); e.sfx("pop", 1.35, 0.15); e.sfx("swish", 1.7, 0.18);

  // the question: one student, shrugging, bubbles popping around them
  const qy = L.H * (big ? 0.22 : 0.27), ps = big ? 190 : 230;
  const bub = [["question", -0.95, -0.25, 0.42], ["thought", 0.95, -0.45, 0.55], ["thinking", 1.05, 0.25, 0.42], ["question", -0.8, 0.35, 0.3]];
  e.clip("coldWho", b.at + 0.2, sc.dur - b.at - 0.2, `<div class="full">
    <img class="ic" id="ciP" src="assets/pngw/shrug.png" style="left:${L.W / 2 - ps / 2}px;top:${qy - ps / 2}px;width:${ps}px">
    ${bub.map(([n, dx, dy, k], i) => `<img class="ic" id="ciQ${i}" src="assets/pngw/${n}.png" style="left:${L.W / 2 + dx * ps - ps * k / 2}px;top:${qy + dy * ps - ps * k / 2}px;width:${ps * k}px">`).join("")}
  </div>`, "full");
  e.code(`tl.fromTo("#ciP",{y:30,opacity:0,scale:.7},{y:0,opacity:1,scale:1,duration:.7,ease:"back.out(1.8)"},${e.r(b.at + 0.25)});
tl.to("#ciP",{rotation:-5,transformOrigin:"50% 100%",duration:.5,yoyo:true,repeat:5,ease:"sine.inOut"},${e.r(b.at + 1.0)});
tl.to("#coldWho",{opacity:0,y:-20,duration:.4},${sc.dur - 0.45});`);
  e.sfx("pop", b.at + 0.25, 0.2);
  bub.forEach((_, i) => {
    e.code(`tl.fromTo("#ciQ${i}",{scale:0,opacity:0},{scale:1,opacity:1,duration:.5,ease:"back.out(2.5)"},${e.r(b.at + 0.9 + i * 0.35)});
tl.to("#ciQ${i}",{y:-10,duration:.9,yoyo:true,repeat:3,ease:"sine.inOut"},${e.r(b.at + 1.4 + i * 0.35)});`);
    e.sfx("pop", b.at + 0.9 + i * 0.35, 0.13);
  });
}

const ROOM = `<svg viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
<defs><linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4ece0"/><stop offset="1" stop-color="#eadfcd"/></linearGradient>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe6f3"/><stop offset="1" stop-color="#fbf1dc"/></linearGradient>
<radialGradient id="lamp" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff5d6" stop-opacity=".9"/><stop offset="1" stop-color="#fff5d6" stop-opacity="0"/></radialGradient></defs>
<rect width="600" height="400" fill="url(#wall)"/><rect y="300" width="600" height="100" fill="#d8c8ae"/>
<rect x="340" y="60" width="190" height="150" rx="10" fill="url(#sky)" stroke="#fff" stroke-width="10"/>
<path d="M345 190 Q390 150 430 175 T525 160 V205 H345Z" fill="#8fbf9a"/><path d="M345 205 Q400 175 470 192 T525 185 V205Z" fill="#5e9f74"/>
<line x1="435" y1="60" x2="435" y2="210" stroke="#fff" stroke-width="6"/>
<rect x="60" y="230" width="270" height="80" rx="16" fill="#fff"/><rect x="60" y="250" width="270" height="70" rx="14" fill="#0a8a4b" opacity=".85"/>
<rect x="72" y="214" width="90" height="34" rx="14" fill="#fdfbf7"/><rect x="50" y="200" width="16" height="130" rx="6" fill="#9b7b5b"/>
<circle cx="560" cy="150" r="80" fill="url(#lamp)"/><rect x="552" y="160" width="16" height="140" rx="6" fill="#6e6a62"/><path d="M535 160 h50 l-12 -40 h-26z" fill="#f2d7a1"/>
<rect x="250" y="320" width="120" height="60" rx="8" fill="#a07f5d"/><circle cx="200" cy="120" r="34" fill="#fff" opacity=".7"/>
<path d="M500 300 q-10 -60 18 -90 q8 40 -6 90z" fill="#3f8a5a"/><rect x="494" y="296" width="30" height="34" rx="6" fill="#c9b79c"/></svg>`;

const X_SVG = `<svg viewBox="0 0 40 40" class="x"><path d="M10 10 L30 30 M30 10 L10 30" stroke="#0d0f0e" stroke-width="5" stroke-linecap="round" fill="none" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`;

// The three pains. Authored on its own timeline at "voice starts at 0.5"; placed at `shift`.
export function hook(e, L, sc, shift) {
  const H = L.hook, w = H.w;
  const pins = [[.18,.42],[.34,.28],[.52,.47],[.71,.31],[.86,.55],[.26,.70],[.45,.78],[.63,.66],[.80,.82],[.12,.86]];
  const roads = `<svg viewBox="0 0 600 400" width="100%" height="100%" preserveAspectRatio="none" style="position:absolute;inset:0">
    <rect width="600" height="400" fill="#f1f3ef"/>
    <path d="M0 120 L600 90 M0 260 L600 300 M140 0 L180 400 M380 0 L330 400 M0 360 Q300 330 600 380" stroke="#fff" stroke-width="18" fill="none"/>
    <path d="M60 0 Q120 200 40 400 M520 0 Q470 180 560 400" stroke="#e3e7e1" stroke-width="10" fill="none"/></svg>`;

  e.clip("hookStage", sc.start, sc.dur + 0.2, `<div class="full" style="perspective:1800px">
  <div id="card1" class="card"><div class="tag"><span id="tagA">फोटोमा</span><span id="tagB" style="position:absolute;left:.8em;opacity:0">पुग्दा</span></div>
    <div id="photo" class="slice">${ROOM}</div>
    ${[0,1,2,3].map((i) => `<div class="slice gl" id="gl${i}" style="clip-path:inset(${i * 25}% 0 ${75 - i * 25}% 0);opacity:0">${ROOM}</div>`).join("")}
  </div>
  <div id="card2" class="card"><div class="chat">
    <div class="who"><div class="av">HD</div><div><div class="nm">होस्टल दाइ</div><div class="st" id="chatSt">online</div></div></div>
    <div class="msgs"><div class="bubble" id="bub">दाइ, भाडा कति हो?</div><div class="seen" id="seen">Seen</div>
      <div class="typing" id="typing"><span></span><span></span><span></span></div></div></div></div>
  <div id="card3" class="card">${roads}<div class="count np" id="count">१० ठाउँ</div>
    ${pins.map(([x, y], i) => `<div class="pin" id="hp${i}" style="left:${x * w}px;top:${y * H.h}px">${PIN_SVG("#0d0f0e")}${X_SVG}</div>`).join("")}
  </div></div>`, "full");

  const capLines = [
    ["capA", 0.45, 2.75, "फोटोमा एउटा, पुग्दा अर्कै।", [3], [0.5, 1.1, 1.86, 2.2]],
    ["capB", 2.8, 5.15, "भाडा सोध्यो, रिप्लाई नै आउँदैन।", [4], [2.84, 3.3, 3.93, 4.35, 4.6]],
    ["capC", 5.2, 6.9, "दस ठाउँ धाउँदा पनि,", [], [5.25, 5.6, 5.95, 6.35]],
    ["capD", 6.92, 8.95, "मन परेको होस्टल भेटिएन?", [3], [6.96, 7.3, 7.75, 8.25]],
  ];
  for (const [id, s, end, text, acc] of capLines)
    e.clip(id, shift + s, end - s, words(text, acc), "caption onDark", `top:${L.capY}px`);

  const sx = (n, t, v) => e.sfx(n, shift + t, v);
  const c = [];
  c.push(`h.fromTo("#card1",{z:-700,rotationY:28,opacity:0,y:70},{z:0,rotationY:-5,opacity:1,y:0,duration:1,ease:"expo.out"},0.05);`);
  sx("pop", 0.1, 0.35);
  c.push(`h.fromTo("#photo",{filter:"grayscale(0) brightness(1)"},{filter:"grayscale(1) brightness(.82) contrast(.9)",duration:.35,ease:"power2.out"},1.9);`);
  c.push(`h.to("#tagA",{opacity:0,duration:.15},1.9).to("#tagB",{opacity:1,duration:.15},1.95);`);
  [[-22, 14], [18, -10], [-9, 20], [12, -16]].forEach(([a, b], i) => {
    c.push(`h.set("#gl${i}",{opacity:1,x:${a},filter:"grayscale(1) brightness(.8)"},${1.9 + i * 0.03}).set("#gl${i}",{x:${b}},${2.02 + i * 0.03}).set("#gl${i}",{x:${-a / 2}},${2.14 + i * 0.02}).set("#gl${i}",{opacity:0,x:0},${2.3 + i * 0.02});`);
  });
  c.push(`h.to("#card1",{x:-14,duration:.05,yoyo:true,repeat:5,ease:"none"},1.92);`);
  sx("glitch", 1.88, 0.3);
  c.push(`h.to("#card1",{x:${-w * 0.78},z:-380,rotationY:30,opacity:.35,duration:.8,ease:"power3.inOut"},2.65);`);
  c.push(`h.fromTo("#card2",{x:${w * 0.85},z:-420,rotationY:-32,opacity:0},{x:0,z:0,rotationY:-5,opacity:1,duration:.85,ease:"power3.out"},2.7);`);
  sx("whoosh", 2.6, 0.2);
  c.push(`h.fromTo("#bub",{scale:.6,opacity:0,transformOrigin:"100% 100%"},{scale:1,opacity:1,duration:.45,ease:"back.out(2)"},2.95);`);
  sx("sent", 2.95, 0.3);
  c.push(`h.fromTo("#seen",{opacity:0},{opacity:1,duration:.3},3.6);`);
  c.push(`h.fromTo("#typing",{opacity:0,scale:.8},{opacity:1,scale:1,duration:.3,ease:"back.out(2)"},3.95);`);
  c.push(`h.fromTo("#typing span",{y:0},{y:-7,duration:.18,yoyo:true,repeat:3,stagger:.1,ease:"sine.inOut"},4.0);`);
  sx("typing", 3.95, 0.25);
  c.push(`h.to("#typing",{opacity:0,scale:.8,duration:.3},4.85);`);
  c.push(`h.to("#chatSt",{opacity:.4,duration:.3},4.9);`);
  c.push(`h.to("#card1",{x:${-w * 1.5},z:-700,opacity:0,duration:.8,ease:"power3.in"},5.1);`);
  c.push(`h.to("#card2",{x:${-w * 0.78},z:-380,rotationY:30,opacity:.35,duration:.8,ease:"power3.inOut"},5.1);`);
  c.push(`h.fromTo("#card3",{x:${w * 0.85},z:-420,rotationY:-32,opacity:0},{x:0,z:0,rotationY:-5,opacity:1,duration:.85,ease:"power3.out"},5.15);`);
  sx("whoosh", 5.05, 0.2);
  for (let i = 0; i < 10; i++) {
    c.push(`h.fromTo("#hp${i} svg:first-child",{y:-60,opacity:0},{y:0,opacity:1,duration:.4,ease:"bounce.out"},${5.45 + i * 0.12});`);
    if (i % 2 === 0) sx("plink", 5.45 + i * 0.12, 0.14);
    c.push(`h.to("#hp${i} .x path",{attr:{"stroke-dashoffset":0},duration:.22,ease:"power2.out"},${7.05 + i * 0.08});`);
    c.push(`h.to("#hp${i} svg:first-child",{opacity:.35,duration:.2},${7.1 + i * 0.08});`);
  }
  sx("cross", 7.05, 0.18); sx("cross", 7.4, 0.15); sx("cross", 7.75, 0.12);
  c.push(`h.fromTo("#count",{scale:.4,opacity:0},{scale:1,opacity:1,duration:.5,ease:"back.out(2.4)"},6.0);`);
  sx("pop", 6.0, 0.25);
  c.push(`h.to(["#card2","#card3"],{x:0,z:-900,rotationY:0,scale:.15,opacity:0,duration:.55,ease:"power3.in"},8.85);`);
  sx("whoosh", 8.8, 0.25);
  for (const [id, , end, , , ts] of capLines) {
    ts.forEach((t, i) => c.push(`h.fromTo("#${id} .w:nth-child(${i + 1})",{yPercent:70,opacity:0},{yPercent:0,opacity:1,duration:.45,ease:"expo.out"},${t});`));
    c.push(`h.to("#${id}",{opacity:0,y:-24,duration:.25,ease:"power2.in"},${end - 0.26});`);
  }
  e.code(`{ const h = gsap.timeline();\n${c.join("\n")}\ntl.add(h, ${e.r(shift)}); }`);
}

// "अब यो झन्झट छैन।" in the dark → light bursts on the music's drop → the brand.
export function logo(e, L, sc, vo) {
  const t0 = sc.start, B = t0 + sc.burst, big = L.W > L.H;
  const cy = L.H * 0.36;
  const [a, b, c] = vo;
  e.clip("capE", a.at - 0.05, a.len + 0.3, words("अब यो झन्झट छैन।", [2, 3]), "caption onDark big", `top:${L.H * 0.44}px`);
  e.code(`tl.fromTo("#capE .w",{yPercent:70,opacity:0,filter:"blur(8px)"},{yPercent:0,opacity:1,filter:"blur(0px)",duration:.5,ease:"expo.out",stagger:.28},${e.r(a.at)});
tl.to("#capE",{scale:1.25,opacity:0,filter:"blur(14px)",duration:.35,ease:"power2.in"},${e.r(B - 0.3)});`);
  e.add(`<div id="burst" style="position:absolute;left:${L.W / 2 - 50}px;top:${L.H * 0.47 - 50}px;width:100px;height:100px;border-radius:50%;
    background:radial-gradient(circle,#ffffff 0%,#f2fbf6 35%,rgba(214,240,226,.9) 60%,rgba(214,240,226,0) 72%);opacity:0;z-index:2"></div>`);
  e.code(`tl.fromTo("#burst",{scale:0,opacity:1},{scale:${Math.round(Math.max(L.W, L.H) / 30)},opacity:1,duration:.9,ease:"expo.out"},${e.r(B - 0.05)});
tl.to("#burst",{opacity:0,duration:.7,ease:"power1.out"},${e.r(B + 0.6)});
tl.to("#dark",{opacity:0,duration:.25,ease:"none"},${e.r(B + 0.1)});`);
  e.sfx("reveal", B - 0.15, 0.4); e.sfx("hit", B, 0.35);

  const pills = ["Search", "Map", "Compare", "Book", "Free ID"];
  e.clip("logoWrap", B, t0 + sc.dur - B + 0.1, `
    <div class="lockup" id="lk" style="top:${cy - 130}px">
      <img id="lmark" src="assets/img/logo-mark.png" style="height:${big ? 160 : 170}px">
      <img id="lword" src="assets/img/wordmark.png" style="height:${big ? 84 : 76}px;margin-top:26px;clip-path:inset(0 100% 0 0)">
      <div id="ltag" class="np" style="margin-top:20px;font:600 ${big ? 46 : 50}px Mukta;color:#3b423e">${words("होस्टल खोज्ने नयाँ तरिका", [2, 3])}</div>
      <div class="chips" style="justify-content:center;margin-top:34px;max-width:${big ? 1100 : 900}px">${pills.map((p) => `<span class="chip lp"><span class="dot"></span>${p}</span>`).join("")}</div>
    </div>`, "full");
  const say = b.at + 0.9; // "HostelPalika" inside "प्रस्तुत छ — HostelPalika"
  e.code(`tl.fromTo("#lmark",{scale:0,rotation:-25},{scale:1,rotation:0,duration:.9,ease:"back.out(1.7)"},${e.r(B + 0.1)});
tl.to("#lword",{clipPath:"inset(0 0% 0 0)",duration:.75,ease:"power3.inOut"},${e.r(say)});
tl.fromTo("#ltag .w",{yPercent:60,opacity:0},{yPercent:0,opacity:1,duration:.55,ease:"expo.out",stagger:.1},${e.r(say + 0.7)});
tl.fromTo("#lk .lp",{y:26,opacity:0,scale:.85},{y:0,opacity:1,scale:1,duration:.55,ease:"back.out(2)",stagger:.18},${e.r(c.at + 0.4)});
tl.to("#lk",{y:-50,opacity:0,scale:.94,filter:"blur(6px)",duration:.45,ease:"power2.in"},${e.r(t0 + sc.dur - 0.5)});`);
  e.sfx("shimmer", say - 0.1, 0.28);
  for (let i = 0; i < pills.length; i++) e.sfx("pop", c.at + 0.4 + i * 0.18, 0.14);
}
