// Look of the film. Black, white and the app's green (#0a8a4b) — nothing else carries colour.
export function css(L) {
  return `
@font-face { font-family: "Inter Tight"; src: url("assets/fonts/InterTight[wght].ttf") format("truetype"); font-weight: 100 900; }
@font-face { font-family: "Mukta"; src: url("assets/fonts/Mukta-Medium.ttf") format("truetype"); font-weight: 500; }
@font-face { font-family: "Mukta"; src: url("assets/fonts/Mukta-SemiBold.ttf") format("truetype"); font-weight: 600; }
@font-face { font-family: "Mukta"; src: url("assets/fonts/Mukta-Bold.ttf") format("truetype"); font-weight: 700; }
:root { --ink: #0d0f0e; --ink2: #3b423e; --mute: #7d857f; --paper: #f5f4ef; --green: #0a8a4b; --green2: #12a95d; --deep: #06301d; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--paper);
  font-family: "Inter Tight", "Mukta", sans-serif; color: var(--ink); }
.np { font-family: "Mukta", sans-serif; }
.full { position: absolute; inset: 0; }

/* light: two soft beams drifting across warm paper, Legora-style */
#bg { position: absolute; inset: 0; overflow: hidden;
  background: radial-gradient(120% 95% at 25% 0%, #ffffff 0%, #fafbfa 55%, #eef0ef 100%); }
#bg::after { content: ""; position: absolute; inset: 0; opacity: .5;
  background-image: radial-gradient(rgba(13,15,14,.10) 1.2px, transparent 1.6px); background-size: 28px 28px;
  -webkit-mask-image: radial-gradient(70% 70% at 70% 50%, #000, transparent); mask-image: radial-gradient(70% 70% at 70% 50%, #000, transparent); }
.beam { position: absolute; width: 140%; height: 38%; left: -20%; filter: blur(70px); opacity: .9;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.95), transparent); rotate: -24deg; }
#beam1 { top: 6%; } #beam2 { top: 58%; opacity: .6; }
.glow { position: absolute; width: ${L.W * 0.55}px; height: ${L.W * 0.55}px; border-radius: 50%; filter: blur(110px);
  background: radial-gradient(circle, rgba(10,138,75,.07), transparent 65%); }
#halo { position: absolute; left: ${L.phone.cx - L.phone.h * 0.55}px; top: ${L.phone.cy - L.phone.h * 0.55}px; width: ${L.phone.h * 1.1}px; height: ${L.phone.h * 1.1}px;
  border-radius: 50%; background: radial-gradient(circle, rgba(18,169,93,.13) 0%, rgba(10,138,75,.05) 40%, transparent 66%); opacity: 0; }
#dark { position: absolute; inset: 0; z-index: 1; background: radial-gradient(85% 75% at 50% 45%, #1c201e 0%, #0d0f0e 50%, #050606 100%); }
#dark::after { content: ""; position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.09) 1.2px, transparent 1.6px); background-size: 26px 26px;
  -webkit-mask-image: radial-gradient(60% 60% at 50% 50%, transparent 30%, #000); mask-image: radial-gradient(60% 60% at 50% 50%, transparent 30%, #000); }
.clip { z-index: 3; } .top2 { z-index: 6 !important; } .top { z-index: 8 !important; }
.pr .tkp { width: 70px; height: 70px; }
.center { display: flex; align-items: center; justify-content: center; text-align: center; } .col { flex-direction: column; gap: 10px; }
.ic { position: absolute; } .ic svg { display: block; overflow: visible; }
.sdot { position: absolute; border-radius: 50%; background: #d9dedb; } .sdot.g { background: #2fd27f; box-shadow: 0 0 12px #2fd27f; }
.cold { font-family: "Mukta"; font-weight: 700; color: #f2f7f4; line-height: 1.2; max-width: 88%; }
.cold .w { display: inline-block; margin: 0 .12em; } .cold .acc { color: #3ee08c; }
.cold.q { color: #fff; text-shadow: 0 0 50px rgba(255,255,255,.25); letter-spacing: -.01em; }
.caption.onDark { color: #f2f7f4; } .caption.onDark .acc { color: #3ee08c; } .caption.big { font-size: ${L.cap * 1.5}px; }
.chap { position: absolute; inset: 0; background: radial-gradient(90% 80% at 50% 50%, #ffffff 0%, #f7f8f7 60%, #eceeed 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; }
.chap::after { content: ""; position: absolute; inset: 0; background-image: radial-gradient(rgba(13,15,14,.08) 1.2px, transparent 1.6px); background-size: 26px 26px; }
.chapword { font-family: "Inter Tight"; font-weight: 800; letter-spacing: -.05em; line-height: 1; position: relative; z-index: 1; }
.chapword .mask { display: block; overflow: hidden; padding: 0 .04em .1em; }
.chapword .ch { display: inline-block; color: #0d0f0e; } .chapword .ch:last-child { color: #0a8a4b; }
.chapnum { position: relative; z-index: 1; margin-top: 18px; font: 600 22px "Inter Tight"; letter-spacing: .3em; color: #7d857f; }
.sub { position: absolute; left: ${L.sub.x}px; top: ${L.sub.y}px; width: ${L.sub.w}px; text-align: ${L.sub.align}; }
.sub span.box { display: inline-block; font: 600 ${L.sub.size}px/1.35 "Mukta"; color: #fff; background: rgba(13,15,14,.86); padding: .3em .75em; border-radius: 18px;
  box-shadow: 0 14px 34px rgba(13,15,14,.2); }
.sub .w { display: inline-block; margin-right: .22em; }
.promise { display: flex; gap: 28px; align-items: center; justify-content: center; }
.pr { display: flex; align-items: center; gap: 18px; background: #fff; border-radius: 999px; padding: 18px 34px 18px 18px; font: 700 ${L.W > L.H ? 46 : 54}px Mukta; color: var(--ink);
  box-shadow: 0 24px 60px rgba(13,15,14,.10), inset 0 0 0 1.5px rgba(13,15,14,.08); }
.pr .tk { width: 64px; height: 64px; border-radius: 50%; background: var(--green); display: grid; place-items: center; } .pr .tk svg { width: 60%; }
#grain { position: absolute; inset: 0; opacity: .07; mix-blend-mode: multiply; pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }

/* phone */
#stage { position: absolute; inset: 0; perspective: 2200px; perspective-origin: ${L.phone.cx}px ${L.phone.cy}px; }
#cam { position: absolute; inset: 0; transform-style: preserve-3d; }
.screen .spot { position: absolute; inset: 0; z-index: 4; opacity: 0; }
.screen .spot i { position: absolute; backdrop-filter: blur(6px) saturate(.8); -webkit-backdrop-filter: blur(6px) saturate(.8); background: rgba(244,241,255,.38); }
.screen .spot b { position: absolute; border-radius: 14px; border: 3px solid #0a8a4b; box-shadow: 0 0 0 6px rgba(10,138,75,.16), 0 10px 30px rgba(13,15,14,.18); }
#rig { position: absolute; left: ${L.phone.cx - L.phone.w / 2}px; top: ${L.phone.cy - L.phone.h / 2}px;
  width: ${L.phone.w}px; height: ${L.phone.h}px; transform-style: preserve-3d; }
#shadow { position: absolute; left: 6%; right: 6%; bottom: -5%; height: 9%; border-radius: 50%;
  background: radial-gradient(closest-side, rgba(13,15,14,.32), transparent); filter: blur(18px); }
.frame { position: absolute; inset: 0; border-radius: ${L.phone.r}px; padding: ${L.phone.pad}px;
  background: linear-gradient(145deg, #2a2e2c, #0b0d0c 40%, #1b1e1d);
  box-shadow: 0 50px 110px rgba(13,15,14,.22), 0 12px 30px rgba(13,15,14,.18), inset 0 0 0 1.5px rgba(255,255,255,.12); }
.screen { position: relative; width: 100%; height: 100%; border-radius: ${L.phone.r - L.phone.pad}px; overflow: hidden; background: #fff; }
.screen video, .screen img.shot { position: absolute; left: 0; width: 100%; top: ${L.phone.bar}px; height: calc(100% - ${L.phone.bar}px); object-fit: cover; }
.bar { position: absolute; left: 0; right: 0; top: 0; height: ${L.phone.bar}px; background: #fff; display: flex; align-items: center;
  justify-content: space-between; padding: 0 ${L.phone.bar * 0.62}px; font: 600 ${L.phone.bar * 0.42}px "Inter Tight"; color: var(--ink); z-index: 3; }
.bar .icons { display: flex; gap: ${L.phone.bar * 0.16}px; align-items: center; }
.bar .cam { position: absolute; left: 50%; top: 50%; width: ${L.phone.bar * 0.36}px; height: ${L.phone.bar * 0.36}px; margin: -${L.phone.bar * 0.18}px; border-radius: 50%; background: #0b0d0c; }
.glare { position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 4;
  background: linear-gradient(115deg, rgba(255,255,255,.22) 0%, rgba(255,255,255,0) 32%, rgba(255,255,255,0) 70%, rgba(255,255,255,.08) 100%); }
.touch { position: absolute; width: 0; height: 0; z-index: 5; }
.touch i { position: absolute; left: -${L.touch}px; top: -${L.touch}px; width: ${L.touch * 2}px; height: ${L.touch * 2}px; border-radius: 50%;
  background: rgba(13,15,14,.22); border: 2px solid rgba(255,255,255,.85); box-shadow: 0 4px 14px rgba(0,0,0,.18); opacity: 0; }
.touch b { position: absolute; left: -${L.touch}px; top: -${L.touch}px; width: ${L.touch * 2}px; height: ${L.touch * 2}px; border-radius: 50%;
  border: 2px solid rgba(10,138,75,.75); opacity: 0; }

/* scene copy */
.copy { position: absolute; left: ${L.copy.x}px; top: ${L.copy.y}px; width: ${L.copy.w}px; text-align: ${L.copy.align}; }
.eyebrow { font: 600 ${L.copy.eyebrow}px "Inter Tight"; letter-spacing: .22em; text-transform: uppercase; color: var(--green); }
.label { margin-top: ${L.copy.eyebrow * 0.8}px; font: 700 ${L.copy.label}px/1.0 "Inter Tight"; letter-spacing: -.035em; color: var(--ink); }
.label .ch { display: inline-block; }
.mask { overflow: hidden; display: block; padding-bottom: .08em; }
.thread { height: 4px; width: ${L.copy.thread}px; margin-top: ${L.copy.label * 0.32}px; border-radius: 2px; background: var(--green); transform-origin: ${L.copy.align === "center" ? "50%" : "0"} 50%;
  ${L.copy.align === "center" ? "margin-left: auto; margin-right: auto;" : ""} }
.npline { font: 600 ${L.copy.np}px/1.32 "Mukta"; color: var(--ink2); }
.npline .w { display: inline-block; margin-right: .26em; }
.npline .acc { color: var(--green); }
.chips { display: flex; flex-wrap: wrap; gap: 14px; margin-top: ${L.copy.np * 0.7}px; ${L.copy.align === "center" ? "justify-content: center;" : ""} }
.chip { font: 600 ${L.copy.chip}px "Inter Tight"; padding: .55em 1.05em; border-radius: 999px; background: #fff; color: var(--ink);
  box-shadow: 0 8px 24px rgba(13,15,14,.08), inset 0 0 0 1.5px rgba(13,15,14,.08); display: inline-flex; align-items: center; gap: .5em; }
.chip .dot { width: .55em; height: .55em; border-radius: 50%; background: var(--green); }
.chip.on { background: var(--green); color: #fff; } .chip.on .dot { background: #fff; }

/* brand */
.lockup { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; }
.bug { position: absolute; left: ${L.bug.x}px; top: ${L.bug.y}px; display: flex; align-items: center; gap: 12px; }
.bug img.m { height: ${L.bug.h}px; } .bug img.w { height: ${L.bug.h * 0.62}px; }
.caption { position: absolute; left: 0; right: 0; text-align: center; z-index: 4; font: 700 ${L.cap}px/1.2 "Mukta"; color: var(--ink); }
.caption .w { display: inline-block; margin: 0 .14em; }
.caption .acc { color: var(--green); }

/* hook cards */
.card { position: absolute; left: ${L.hook.cx - L.hook.w / 2}px; top: ${L.hook.cy - L.hook.h / 2}px; width: ${L.hook.w}px; height: ${L.hook.h}px;
  border-radius: 34px; background: #fff; overflow: hidden;
  box-shadow: 0 40px 90px rgba(13,15,14,.16), 0 8px 22px rgba(13,15,14,.08), inset 0 0 0 1px rgba(13,15,14,.06); }
.tag { position: absolute; left: 22px; top: 20px; z-index: 3; font: 700 22px "Mukta"; padding: .2em .8em; border-radius: 999px; background: rgba(255,255,255,.92); color: var(--ink); }
.slice { position: absolute; inset: 0; }
.chat { padding: 26px 30px; display: flex; flex-direction: column; height: 100%; font-family: "Mukta"; }
.chat .who { display: flex; align-items: center; gap: 14px; padding-bottom: 18px; border-bottom: 1px solid #eceae4; }
.chat .av { width: 54px; height: 54px; border-radius: 50%; background: #dfe5e1; display: grid; place-items: center; font: 700 22px "Inter Tight"; color: var(--ink2); }
.chat .nm { font: 700 26px "Mukta"; } .chat .st { font: 500 19px "Inter Tight"; color: var(--mute); }
.chat .msgs { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; }
.bubble { align-self: flex-end; max-width: 80%; background: var(--green); color: #fff; font: 600 30px "Mukta"; padding: 12px 22px; border-radius: 24px 24px 6px 24px; }
.seen { align-self: flex-end; font: 600 18px "Inter Tight"; color: var(--mute); }
.typing { align-self: flex-start; background: #eef0ee; border-radius: 22px; padding: 16px 20px; display: flex; gap: 8px; }
.typing span { width: 12px; height: 12px; border-radius: 50%; background: #9aa39d; }
.count { position: absolute; right: 26px; top: 18px; z-index: 3; font: 700 30px "Mukta"; color: var(--ink); background: #fff; border-radius: 999px; padding: .1em .7em;
  box-shadow: 0 6px 16px rgba(0,0,0,.08); }
.pin { position: absolute; width: 0; height: 0; }
.pin svg { position: absolute; left: -17px; top: -44px; width: 34px; height: 44px; }
.pin .x { position: absolute; left: -20px; top: -46px; width: 40px; height: 40px; }

/* floating extras */
.mpin { position: absolute; display: flex; align-items: center; gap: 10px; transform-origin: 18px 100%; }
.mpin svg { width: 36px; height: 46px; flex: none; }
.mpin span { font: 600 ${L.pinFont}px "Inter Tight"; background: #fff; padding: .35em .8em; border-radius: 12px; box-shadow: 0 8px 22px rgba(13,15,14,.1); white-space: nowrap; }
.receipt { position: absolute; width: ${L.receipt.w}px; border-radius: 10px; overflow: hidden; background: #fff;
  box-shadow: 0 50px 100px rgba(13,15,14,.22), 0 10px 26px rgba(13,15,14,.12); }
.receipt img { display: block; width: 100%; }
.stamp { position: absolute; right: 8%; top: 42%; font: 800 ${L.receipt.w * 0.07}px "Inter Tight"; letter-spacing: .08em; color: var(--green);
  border: 4px solid var(--green); border-radius: 12px; padding: .15em .5em; background: rgba(255,255,255,.85); }
.tick { position: absolute; width: ${L.tick}px; height: ${L.tick}px; border-radius: 50%; background: var(--green); display: grid; place-items: center;
  box-shadow: 0 20px 50px rgba(10,138,75,.35); }
.vs { font: 800 ${L.copy.chip * 1.1}px "Inter Tight"; color: var(--mute); align-self: center; }
.mini { position: absolute; width: ${L.mini.w}px; height: ${L.mini.h}px; }
.mini .frame { border-radius: ${L.mini.r}px; padding: ${L.mini.pad}px; }
.mini .screen { border-radius: ${L.mini.r - L.mini.pad}px; }
.mini .screen img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.url { display: inline-block; font: 700 ${L.end.url}px "Inter Tight"; letter-spacing: -.01em; color: #fff; background: var(--ink); padding: .5em 1.1em; border-radius: 999px; }
`;
}
