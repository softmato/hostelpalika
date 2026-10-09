// node build/build.mjs [landscape|portrait] — cut footage, lay out the timeline, write index.html.
import { scenes, TAIL, TOUCH_LAG } from "./config.mjs";
import { makeFilm } from "../../lib/film.mjs";
import { phoneScenes } from "../../lib/phone.mjs";
import { end } from "../../lib/end.mjs";
import { cold, pain, logo } from "./hook.mjs";
import { extrasAnim } from "./extras.mjs";
import { css, bgHtml, ambient } from "./theme.mjs";

const fmt = process.argv[2] || "landscape";
const phones = scenes.filter((s) => s.kind === "phone");
// each scene leans a little differently; portrait stays nearly square-on
const POSES = { landscape: {}, portrait: {} };
phones.forEach((s, i) => {
  POSES.landscape[s.id] = [[-14, -8, -16, -10, -12, -6][i % 6], [4, 3, 5][i % 3]];
  POSES.portrait[s.id] = [[-6, -3, -7, -4, -5, -2][i % 6], [3, 2, 3][i % 3]];
});

makeFilm({
  fmt, scenes, tail: TAIL, lag: TOUCH_LAG,
  dir: new URL("../", import.meta.url),
  config: new URL("config.mjs", import.meta.url),
  outDir: new URL(fmt === "landscape" ? "../" : "../../admin-film-vertical/", import.meta.url),
  voDirs: [new URL("../../audio/admin/", import.meta.url)],
  title: "HostelPalika — Hostel Admin",
  dark: true, css, bgHtml, ambient,
  sections(e, L, S, timed) {
    cold(e, L, S.cold, S.cold.vo);
    pain(e, L, S.pain, S.pain.vo);
    logo(e, L, S.logo, S.logo.vo);
    phoneScenes(e, L, fmt, timed.filter((s) => s.kind === "phone"), {
      poses: POSES, stickers: Object.fromEntries(phones.map((s) => [s.id, s.sticker])), extrasAnim,
    });
    end(e, L, S.end, S.end.vo, {
      promises: ["हरेक रुपैयाँको हिसाब", "हरेक रेसिडेन्टको रेकर्ड", "जहाँ भए पनि"], ticks: [0.1, 1.8, 3.5],
      shots: ["still_home", "still_perm", "still_spend"], tagline: "होस्टल चलाउने स्मार्ट तरिका", accent: [2, 3],
    });
  },
});
