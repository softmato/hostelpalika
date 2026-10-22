// node build/build.mjs [landscape|portrait] — cut footage, lay out the timeline, write index.html.
// v4 is built and checked in landscape only; portrait comes once landscape is approved.
import { scenes, TAIL, TOUCH_LAG } from "./config.mjs";
import { makeFilm } from "../../lib/film.mjs";
import { phoneScenes } from "../../lib/phone.mjs";
import { css as adminCss } from "../../admin-film/build/theme.mjs";
import { css, bgHtml, ambient, hook, web, calm, end, extrasAnim } from "./scenes.mjs";

const fmt = process.argv[2] || "landscape";
const phones = scenes.filter((s) => s.kind === "phone");
const POSES = { landscape: {}, portrait: {} };
phones.forEach((s, i) => {
  POSES.landscape[s.id] = [[-14, -8, -16, -10, -12, -6][i % 6], [4, 3, 5][i % 3]];
  POSES.portrait[s.id] = [[-6, -3, -7, -4, -5, -2][i % 6], [3, 2, 3][i % 3]];
});

makeFilm({
  fmt, scenes, tail: TAIL, lag: TOUCH_LAG,
  dir: new URL("../", import.meta.url),
  config: new URL("config.mjs", import.meta.url),
  outDir: new URL(fmt === "landscape" ? "../" : "../../one-min-film-vertical/", import.meta.url),
  voDirs: [new URL("../../audio/v4/", import.meta.url)],
  title: "HostelPalika — Run Your Hostel From One App",
  dark: true, bgHtml, ambient, subSplit: true, music: "music_v4", bed: 0.8, duck: 0.38,
  css: (L) => adminCss(L) + css(L),
  sections(e, L, S, timed) {
    hook(e, L, S.hook);
    phoneScenes(e, L, fmt, timed.filter((s) => s.kind === "phone"), {
      poses: POSES, stickers: Object.fromEntries(phones.map((s) => [s.id, s.sticker])), extrasAnim, chapters: 8,
    });
    // the phone steps out for the web portal and the owner, and comes back for "start today"
    e.code(`tl.to("#stage",{opacity:0,duration:.3},${e.r(S.web.start - 0.25)});
tl.to("#stage",{opacity:1,duration:.3},${e.r(S.howto.start - 0.5)});`);
    web(e, L, S.web);
    calm(e, L, S.calm);
    end(e, L, S.end);
  },
});
