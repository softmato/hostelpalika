// Tiny accumulator the scene modules write into: markup, timeline code, and sound cues.
export function emitter() {
  const html = [], js = [], cues = [];
  const r = (n) => Math.round(n * 1000) / 1000;
  return {
    html, js, cues, r,
    add: (s) => html.push(s),
    code: (s) => js.push(s),
    // a timed element: visible only inside [start, start+dur)
    clip: (id, start, dur, inner, cls = "", style = "") =>
      html.push(`<div id="${id}" class="clip ${cls}" data-start="${r(start)}" data-duration="${r(dur)}" style="${style}">${inner}</div>`),
    sfx: (name, t, vol = 0.3) => cues.push({ name, t: r(t), vol }),
  };
}

// words as spans so they can rise one by one; Devanagari is never split below the word
export const words = (text, acc = []) =>
  text.split(" ").map((w, i) => `<span class="w${acc.includes(i) ? " acc" : ""}">${w}</span>`).join(" ");

export const chars = (text) =>
  [...text].map((c) => (c === " " ? `<span class="ch">&nbsp;</span>` : `<span class="ch">${c}</span>`)).join("");

export const PIN_SVG = (fill = "#0a8a4b") =>
  `<svg viewBox="0 0 34 44"><path d="M17 43C17 43 3 27.5 3 16.5a14 14 0 0 1 28 0C31 27.5 17 43 17 43Z" fill="${fill}"/><circle cx="17" cy="16" r="5.5" fill="#fff"/></svg>`;

// Minimal line icons (64×64, stroke = currentColor). pathLength=1 so they can draw themselves on.
const P = (d) => `<path d="${d}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="0"/>`;
export const ICON = {
  house: P("M10 30 L32 12 L54 30") + P("M16 26 V54 H48 V26") + P("M27 54 V40 H37 V54"),
  hostel: P("M14 56 V12 H40 V56") + P("M40 56 V28 H52 V56") + P("M8 56 H58") + P("M20 20 H24 M30 20 H34 M20 28 H24 M30 28 H34 M20 36 H24 M30 36 H34 M45 36 H47 M45 44 H47") + P("M24 56 V47 H30 V56"),
  person: P("M25 18 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0") + P("M18 56 v-8 a14 14 0 0 1 28 0 v8"),
  ask: P("M12 12 H52 a6 6 0 0 1 6 6 V36 a6 6 0 0 1 -6 6 H28 L18 52 V42 H12 a6 6 0 0 1 -6 -6 V18 a6 6 0 0 1 6 -6 Z") + P("M27 22 a5 5 0 1 1 7 4.6 c-1.5 .8 -2 1.8 -2 3.4 M32 35 v.6"),
};
export const icon = (name, size, extra = "") =>
  `<svg class="ico" viewBox="0 0 64 64" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICON[name]}</svg>`;
