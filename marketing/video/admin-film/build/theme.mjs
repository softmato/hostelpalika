// Admin film look: a soft moving mesh (lavender, mint, cream on white) instead of the public film's
// plain paper; black type, the app's green as the only accent, white glass cards.
export const bgHtml = `<div class="blob" id="blob1"></div><div class="blob" id="blob2"></div><div class="blob" id="blob3"></div><div class="blob" id="blob4"></div>`;

// blobs wander for the whole film (deterministic, seek-safe)
export function ambient(e, L, S, total) {
  const W = L.W, H = L.H, d = e.r(total);
  return [
    `tl.fromTo("#blob1",{x:${-W * 0.12},y:${-H * 0.15}},{x:${W * 0.18},y:${H * 0.12},duration:${d},ease:"sine.inOut"},0);`,
    `tl.fromTo("#blob2",{x:${W * 0.1},y:${H * 0.1}},{x:${-W * 0.2},y:${-H * 0.08},duration:${d},ease:"sine.inOut"},0);`,
    `tl.fromTo("#blob3",{x:0,y:0,scale:1},{x:${-W * 0.25},y:${H * 0.2},scale:1.25,duration:${d},ease:"sine.inOut"},0);`,
    `tl.fromTo("#blob4",{x:0,y:0,scale:1.1},{x:${W * 0.22},y:${-H * 0.18},scale:.9,duration:${d},ease:"sine.inOut"},0);`,
    `tl.fromTo("#dark",{scale:1.08},{scale:1,duration:${e.r(S.logo.start + S.logo.burst)},ease:"none"},0);`,
  ].join("\n");
}

export function css(L) {
  const big = L.W > L.H, P = L.phone;
  const cw = big ? 400 : 470;
  return `
/* mesh background */
#bg { background: #fbfaff; }
#bg::after { opacity: .28; }
.beam { opacity: .55; }
.glow { display: none; }
.blob { position: absolute; border-radius: 50%; filter: blur(${big ? 120 : 110}px); width: ${Math.max(L.W, L.H) * 0.62}px; height: ${Math.max(L.W, L.H) * 0.62}px; }
#blob1 { left: -12%; top: -22%; background: radial-gradient(circle, rgba(178,156,255,.62), rgba(178,156,255,0) 70%); }
#blob2 { right: -18%; bottom: -30%; background: radial-gradient(circle, rgba(130,222,186,.50), rgba(130,222,186,0) 70%); }
#blob3 { right: -10%; top: -26%; background: radial-gradient(circle, rgba(226,192,255,.55), rgba(226,192,255,0) 70%); }
#blob4 { left: -16%; bottom: -34%; background: radial-gradient(circle, rgba(255,230,196,.55), rgba(255,230,196,0) 70%); }
#halo { background: radial-gradient(circle, rgba(255,255,255,.9) 0%, rgba(196,182,255,.28) 38%, transparent 66%); }
#dark { background: radial-gradient(85% 75% at 50% 45%, #1d1a2b 0%, #0f0d17 55%, #070609 100%); }
.chap { background: radial-gradient(90% 80% at 50% 50%, #ffffff 0%, #f6f3ff 55%, #ebe5ff 100%); }
.chap::after { opacity: .6; }
.touch b { border-color: rgba(10,138,75,.8); }

/* glass cards */
.gcard { position: absolute; width: ${cw}px; padding: 22px 26px 22px 22px; border-radius: 30px; display: flex; gap: 18px; align-items: center;
  background: linear-gradient(150deg, rgba(255,255,255,.92), rgba(255,255,255,.66)); backdrop-filter: blur(22px) saturate(1.3);
  box-shadow: 0 34px 80px rgba(72,52,150,.20), 0 8px 22px rgba(13,15,14,.08), inset 0 0 0 1.5px rgba(255,255,255,.95); }
.gcard .gi { width: ${big ? 86 : 96}px; height: ${big ? 86 : 96}px; flex: none; filter: drop-shadow(0 12px 18px rgba(72,52,150,.22)); }
.gcard .gb { flex: 1; min-width: 0; }
.gt { font: 600 ${big ? 21 : 24}px "Inter Tight"; color: #6d6885; letter-spacing: .02em; }
.gv { font: 800 ${big ? 54 : 60}px/1.08 "Inter Tight"; color: #0d0f0e; letter-spacing: -.03em; display: flex; white-space: pre; }
.gs { font: 600 ${big ? 19 : 22}px "Inter Tight"; color: #0a8a4b; margin-top: 4px; }
.od { display: inline-block; height: 1.08em; overflow: hidden; }
.odc { display: flex; flex-direction: column; } .odc span { height: 1.08em; display: block; }
.grow { display: flex; justify-content: space-between; font: 600 ${big ? 19 : 22}px "Inter Tight"; color: #3b423e; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(13,15,14,.08); }
.grow b { color: #0d0f0e; }
.gtick { position: absolute; right: -14px; top: -14px; width: 54px; height: 54px; border-radius: 50%; background: #0a8a4b; display: grid; place-items: center;
  box-shadow: 0 12px 26px rgba(10,138,75,.35); }
.gbar { margin-top: 12px; } .gbar .bl { display: flex; justify-content: space-between; font: 600 ${big ? 18 : 21}px "Inter Tight"; color: #3b423e; }
.gbar .bt { height: 10px; border-radius: 6px; background: rgba(13,15,14,.07); margin-top: 6px; overflow: hidden; }
.gbar .bf { height: 100%; border-radius: 6px; background: linear-gradient(90deg, #0a8a4b, #19b866); transform-origin: 0 50%; }

/* process steps */
.step { display: inline-flex; align-items: center; gap: 18px; padding: 14px 34px 14px 14px; border-radius: 999px; background: #0d0f0e; color: #fff;
  font: 700 ${big ? 40 : 44}px Mukta; box-shadow: 0 24px 60px rgba(13,15,14,.28); white-space: nowrap; }
.step .sn { width: ${big ? 58 : 64}px; height: ${big ? 58 : 64}px; border-radius: 50%; background: #0a8a4b; display: grid; place-items: center; font: 800 ${big ? 30 : 34}px "Inter Tight"; }

/* settings pills */
.pill2 { position: absolute; display: inline-flex; align-items: center; gap: .6em; font: 700 ${big ? 26 : 28}px "Inter Tight"; color: #0d0f0e; padding: .6em 1.1em .6em .8em;
  border-radius: 999px; background: rgba(255,255,255,.88); backdrop-filter: blur(16px); white-space: nowrap;
  box-shadow: 0 20px 50px rgba(72,52,150,.16), inset 0 0 0 1.5px rgba(255,255,255,.95); }
.pill2 .dt { width: .9em; height: .9em; border-radius: 50%; background: #0a8a4b; box-shadow: 0 0 0 5px rgba(10,138,75,.14); }

/* warden permissions panel */
.perm { position: absolute; width: ${big ? 440 : 520}px; padding: 20px 26px; border-radius: 30px;
  background: linear-gradient(150deg, rgba(255,255,255,.94), rgba(255,255,255,.72)); backdrop-filter: blur(22px);
  box-shadow: 0 34px 80px rgba(72,52,150,.2), inset 0 0 0 1.5px rgba(255,255,255,.95); }
.perm .ph { font: 700 ${big ? 22 : 26}px "Inter Tight"; color: #6d6885; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
.perm .ph img { width: 44px; }
.pr2 { display: flex; align-items: center; justify-content: space-between; font: 600 ${big ? 24 : 28}px "Inter Tight"; color: #0d0f0e; padding: 10px 0; border-top: 1px solid rgba(13,15,14,.06); }
.pr2.off { color: #9a96aa; }
.sw { width: 56px; height: 32px; border-radius: 17px; background: #dcd8e6; position: relative; flex: none; }
.sw i { position: absolute; left: 3px; top: 3px; width: 26px; height: 26px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,.22); }

/* branch merge + stock transfer */
.bnode { position: absolute; display: flex; align-items: center; gap: 16px; padding: 16px 24px 16px 16px; border-radius: 26px; white-space: nowrap;
  background: rgba(255,255,255,.9); backdrop-filter: blur(18px); box-shadow: 0 26px 60px rgba(72,52,150,.18), inset 0 0 0 1.5px rgba(255,255,255,.95); }
.bnode img { width: ${big ? 70 : 80}px; } .bnode .bn { font: 800 ${big ? 26 : 30}px "Inter Tight"; color: #0d0f0e; } .bnode .bs { font: 600 ${big ? 18 : 21}px "Inter Tight"; color: #6d6885; }
.bnode.all { background: #0d0f0e; } .bnode.all .bn { color: #fff; } .bnode.all .bs { color: #8fe3bf; }
.tchip { position: absolute; font: 700 ${big ? 22 : 25}px "Inter Tight"; color: #fff; background: #0a8a4b; padding: .4em .9em; border-radius: 999px; white-space: nowrap;
  box-shadow: 0 12px 28px rgba(10,138,75,.3); }

/* PDF close-up */
.pdfsheet { position: absolute; border-radius: 16px; overflow: hidden; background: #fff;
  box-shadow: 0 60px 120px rgba(40,28,90,.28), 0 12px 30px rgba(13,15,14,.12); }
.pdfsheet img { display: block; width: 100%; }
.hl { position: absolute; border-radius: 10px; border: 3px solid #0a8a4b; background: rgba(10,138,75,.10); box-shadow: 0 0 0 6px rgba(10,138,75,.10); }
.hl.red { border-color: #c2412d; background: rgba(194,65,45,.08); box-shadow: 0 0 0 6px rgba(194,65,45,.08); }
.ptag { position: absolute; font: 800 ${big ? 30 : 34}px "Inter Tight"; padding: .3em .8em; border-radius: 999px; color: #fff; white-space: nowrap; }

/* cold open */
.coldq { font: 800 ${big ? 118 : 104}px/1.12 Mukta; color: #fff; letter-spacing: -.01em; text-align: center; }
.coldq .w, .coldl .w, .painw .w { display: inline-block; margin: 0 .12em; }
.coldl { font: 700 ${big ? 66 : 62}px/1.25 Mukta; color: #eceaf5; text-align: center; max-width: 86%; }
.coldl .acc { color: #9ff0c9; }
.notif { position: absolute; width: ${big ? 520 : 760}px; display: flex; gap: 18px; align-items: center; padding: 18px 22px; border-radius: 26px;
  background: rgba(255,255,255,.12); backdrop-filter: blur(18px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.18), 0 20px 50px rgba(0,0,0,.35); }
.notif .nm { width: 54px; height: 54px; border-radius: 14px; background: #fff; display: grid; place-items: center; flex: none; }
.notif .nm img { width: 38px; }
.notif .nt { font: 700 ${big ? 24 : 30}px "Inter Tight"; color: #fff; } .notif .nb { font: 500 ${big ? 21 : 26}px "Inter Tight"; color: rgba(255,255,255,.72); }
.notif .nw { margin-left: auto; align-self: flex-start; font: 500 18px "Inter Tight"; color: rgba(255,255,255,.5); }
.paintile { position: absolute; width: ${big ? 360 : 300}px; padding: 26px 22px 24px; border-radius: 34px; text-align: center;
  background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14), 0 30px 70px rgba(0,0,0,.4); }
.paintile img { width: ${big ? 150 : 130}px; display: block; margin: 0 auto 10px; }
.paintile .pl { font: 700 ${big ? 38 : 34}px/1.2 Mukta; color: #fff; }
.paintile .px { position: absolute; right: 18px; top: 16px; width: 52px; height: 52px; border-radius: 50%; background: #c2412d; display: grid; place-items: center; }
.painw { font: 800 ${big ? 120 : 110}px/1.1 Mukta; color: #fff; text-align: center; }
`;
}
