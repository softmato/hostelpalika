// The first ~20 s: the owner's question on a dark screen while the hostel's money keeps moving
// (notifications), three pains, then a light burst on the drop reveals the brand.
import { words } from "../../lib/emit.mjs";

const big = (L) => L.W > L.H;

// words of a line appear across the time the voice takes, weighted by length
function speak(e, sel, text, at, len) {
  const ws = text.split(" "), tot = ws.reduce((a, w) => a + w.length + 1, 0);
  let acc = 0;
  ws.forEach((w, i) => {
    e.code(`tl.fromTo("${sel} .w:nth-child(${i + 1})",{yPercent:70,opacity:0,filter:"blur(10px)"},{yPercent:0,opacity:1,filter:"blur(0px)",duration:.5,ease:"expo.out"},${e.r(at + (len * 0.94 * acc) / tot)});`);
    acc += w.length + 1;
  });
  return (word) => at + (len * 0.94 * ws.slice(0, word).reduce((a, w) => a + w.length + 1, 0)) / tot; // time of the nth word
}

const NOTES = [
  ["Rs 12,194 · cash collected", "Nabin Ojha · Aswin rent"],
  ["Rice 25 kg · Rs 2,500", "Expense added · Groceries"],
  ["Stock sent to Branch", "Rice 10 kg · Daal 5 kg"],
  ["Roll call · 20:00", "10 residents to check"],
];

export function cold(e, L, sc, vo) {
  const [v] = vo, b = big(L);
  const q = "होस्टलको मालिक हुनुहुन्छ?", rest = "आफू होस्टलमा नभए पनि, त्यहाँको हरेक कारोबार थाहा पाउन मन छ, हैन?";
  const split = 1.8; // the question, then a breath
  e.clip("coldQ", v.at - 0.1, split + 0.6, `<div class="coldq" id="cq">${words(q)}</div>`, "full center");
  speak(e, "#cq", q, v.at, split);
  e.code(`tl.fromTo("#cq",{scale:1.12},{scale:1,duration:${e.r(split + 0.5)},ease:"power2.out"},${e.r(v.at)});
tl.to("#cq",{y:-40,opacity:0,filter:"blur(12px)",duration:.35,ease:"power2.in"},${e.r(v.at + split + 0.2)});`);
  e.sfx("heart", 0.05, 0.5); e.sfx("hit", v.at + split * 0.8, 0.3);

  const t2 = v.at + split + 0.25;
  e.clip("coldR", t2 - 0.05, sc.dur - t2 + 0.1, `<div class="coldl" id="cr" style="position:absolute;${b ? `left:${L.W * 0.07}px;top:${L.H * 0.3}px;width:${L.W * 0.5}px;text-align:left` : `left:${L.W * 0.07}px;top:${L.H * 0.16}px;width:${L.W * 0.86}px`}">${words(rest, [5, 6])}</div>`, "full");
  const when = speak(e, "#cr", rest, t2, v.at + v.len - t2);
  e.code(`tl.to("#cr",{opacity:0,scale:.94,filter:"blur(10px)",duration:.35,ease:"power2.in"},${e.r(sc.dur - 0.35)});`);

  // notifications drop in while she says "हरेक कारोबार"
  const n0 = when(5) - 0.2, nx = b ? L.W - 520 - 110 : (L.W - 760) / 2, ny = b ? 230 : L.H * 0.56;
  e.clip("coldN", n0 - 0.05, sc.dur - n0 + 0.1, NOTES.map(([t, s], i) => `<div class="notif" id="nt${i}" style="left:${nx}px;top:${ny + i * (b ? 136 : 160)}px">
    <div class="nm"><img src="assets/img/logo-mark.png"></div><div><div class="nt">${t}</div><div class="nb">${s}</div></div><div class="nw">now</div></div>`).join(""), "full");
  NOTES.forEach((_, i) => {
    const s = n0 + i * 0.42;
    e.code(`tl.fromTo("#nt${i}",{y:-40,opacity:0,scale:.9},{y:0,opacity:1,scale:1,duration:.5,ease:"back.out(1.8)"},${e.r(s)});`);
    e.sfx("notif", s, 0.24);
  });
  e.code(`tl.to("#coldN .notif",{opacity:0,y:20,filter:"blur(8px)",duration:.3,stagger:.04},${e.r(sc.dur - 0.4)});`);
}

// three pains slam in, then "अन्दाज मात्र।"
export function pain(e, L, sc, vo) {
  const [v] = vo, b = big(L), t0 = sc.start;
  const parts = [["notepad", "कापीमा हिसाब"], ["chat", "व्हाट्सएपमा रसिद"], ["people", "कसले तिर्‍यो?"]];
  const at = [0.1, 0.3, 0.55].map((f) => v.at + v.len * f), last = v.at + v.len * 0.8;
  const W = b ? 360 : 300, gap = b ? 60 : 30, x0 = (L.W - (W * 3 + gap * 2)) / 2, y = b ? L.H * 0.2 : L.H * 0.3;
  e.clip("painT", t0, sc.dur + 0.1, parts.map(([png, l], i) => `<div class="paintile" id="pt${i}" style="left:${x0 + i * (W + gap)}px;top:${y}px">
    <img src="assets/pngw/${png}.png"><div class="pl">${l}</div><div class="px" id="px${i}"><svg width="50%" viewBox="0 0 24 24"><path d="M6 6 18 18 M18 6 6 18" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg></div></div>`).join(""), "full");
  parts.forEach((_, i) => {
    e.code(`tl.fromTo("#pt${i}",{y:80,opacity:0,scale:.7,rotation:${(i - 1) * 8}},{y:0,opacity:1,scale:1,rotation:${(i - 1) * 3},duration:.55,ease:"back.out(1.9)"},${e.r(at[i])});
tl.fromTo("#px${i}",{scale:0},{scale:1,duration:.35,ease:"back.out(3)"},${e.r(last + i * 0.12)});`);
    e.sfx("pop", at[i], 0.3); e.sfx("cross", last + i * 0.12, 0.25);
  });
  e.sfx("glitch", at[1] + 0.1, 0.18);
  e.clip("painW", last - 0.05, t0 + sc.dur - last + 0.1, `<div class="painw" id="pw" style="margin-top:${b ? 46 : 50}%">${words("सबै अन्दाजमै।")}</div>`, "full center");
  e.code(`tl.fromTo("#pw .w",{yPercent:80,opacity:0},{yPercent:0,opacity:1,duration:.45,ease:"expo.out",stagger:.12},${e.r(last)});
tl.to("#painT .paintile",{x:(i)=>(i-1)*-40,opacity:.25,scale:.92,filter:"blur(3px)",duration:.4},${e.r(last + 0.4)});
tl.to(["#painT","#painW"],{opacity:0,scale:.95,filter:"blur(10px)",duration:.3,ease:"power2.in"},${e.r(t0 + sc.dur - 0.3)});`);
  e.sfx("hit", last, 0.3); e.sfx("riser", t0 + sc.dur - 2.2, 0.22);
}

// "अब होइन।" → light bursts on the drop → mark, wordmark, positioning, section pills
export function logo(e, L, sc, vo) {
  const t0 = sc.start, B = t0 + sc.burst, b = big(L), cy = L.H * (b ? 0.34 : 0.36);
  const [a, br, c] = vo;
  e.clip("capE", a.at - 0.05, B - a.at + 0.3, words("अब होइन।"), "caption onDark big", `top:${L.H * 0.44}px;color:#fff`);
  e.code(`tl.fromTo("#capE .w",{yPercent:70,opacity:0,filter:"blur(8px)"},{yPercent:0,opacity:1,filter:"blur(0px)",duration:.4,ease:"expo.out",stagger:.18},${e.r(a.at)});
tl.to("#capE",{scale:1.3,opacity:0,filter:"blur(14px)",duration:.3,ease:"power2.in"},${e.r(B - 0.25)});`);
  e.add(`<div id="burst" style="position:absolute;left:${L.W / 2 - 50}px;top:${L.H * 0.47 - 50}px;width:100px;height:100px;border-radius:50%;
    background:radial-gradient(circle,#ffffff 0%,#f6f2ff 35%,rgba(222,212,255,.9) 60%,rgba(222,212,255,0) 72%);opacity:0;z-index:2"></div>`);
  e.code(`tl.fromTo("#burst",{scale:0,opacity:1},{scale:${Math.round(Math.max(L.W, L.H) / 30)},opacity:1,duration:.9,ease:"expo.out"},${e.r(B - 0.05)});
tl.to("#burst",{opacity:0,duration:.7,ease:"power1.out"},${e.r(B + 0.6)});
tl.to("#dark",{opacity:0,duration:.25,ease:"none"},${e.r(B + 0.1)});`);
  e.sfx("reveal", B - 0.15, 0.4); e.sfx("hit", B, 0.35); e.sfx("flash", B, 0.25);

  const pills = ["Branches", "Money", "Residents", "Staff", "Reports"];
  e.clip("logoWrap", B, t0 + sc.dur - B + 0.1, `
    <div class="lockup" id="lk" style="top:${cy - 130}px">
      <img id="lmark" src="assets/img/logo-mark.png" style="height:${b ? 160 : 170}px">
      <img id="lword" src="assets/img/wordmark.png" style="height:${b ? 84 : 76}px;margin-top:26px;clip-path:inset(0 100% 0 0)">
      <div id="ltag" class="np" style="margin-top:20px;font:700 ${b ? 48 : 52}px Mukta;color:#2b2838">${words("होस्टल व्यवस्थापन, एउटै एपमा", [2, 3])}</div>
      <div class="chips" style="justify-content:center;margin-top:34px;max-width:${b ? 1150 : 900}px">${pills.map((p) => `<span class="chip lp"><span class="dot"></span>${p}</span>`).join("")}</div>
    </div>`, "full");
  const say = br.at + 0.9; // "HostelPalika" inside "प्रस्तुत छ — HostelPalika"
  e.code(`tl.fromTo("#lmark",{scale:0,rotation:-25},{scale:1,rotation:0,duration:.9,ease:"back.out(1.7)"},${e.r(B + 0.1)});
tl.to("#lword",{clipPath:"inset(0 0% 0 0)",duration:.75,ease:"power3.inOut"},${e.r(say)});
tl.fromTo("#ltag .w",{yPercent:60,opacity:0},{yPercent:0,opacity:1,duration:.55,ease:"expo.out",stagger:.1},${e.r(say + 0.6)});
tl.fromTo("#lk .lp",{y:26,opacity:0,scale:.85},{y:0,opacity:1,scale:1,duration:.55,ease:"back.out(2)",stagger:.2},${e.r(c.at + 0.5)});
tl.to("#lk",{y:-50,opacity:0,scale:.94,filter:"blur(6px)",duration:.45,ease:"power2.in"},${e.r(t0 + sc.dur - 0.5)});`);
  e.sfx("shimmer", say - 0.1, 0.28);
  pills.forEach((_, i) => e.sfx("bubble", c.at + 0.5 + i * 0.2, 0.18));
}
