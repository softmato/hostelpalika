// node build/build.mjs [landscape|portrait] — cut footage, lay out the timeline, write index.html.
import { scenes, TAIL, TOUCH_LAG } from "./config.mjs";
import { makeFilm } from "../../lib/film.mjs";
import { phoneScenes } from "../../lib/phone.mjs";
import { end } from "../../lib/end.mjs";
import { cold, hook, logo } from "./hook.mjs";
import { POSES, STICKERS, extrasCopy, extrasAnim } from "./extras.mjs";

const fmt = process.argv[2] || "landscape";
makeFilm({
  fmt, scenes, tail: TAIL, lag: TOUCH_LAG,
  dir: new URL("../", import.meta.url),
  config: new URL("config.mjs", import.meta.url),
  outDir: new URL(fmt === "landscape" ? "../" : "../../public-film-vertical/", import.meta.url),
  voDirs: ["v2", "public"].map((d) => new URL(`../../audio/${d}/`, import.meta.url)),
  title: "HostelPalika — Public",
  dark: true,
  sections(e, L, S, timed) {
    cold(e, L, S.cold, S.cold.vo);
    hook(e, L, S.hook, S.hook.vo[0].at - 0.5);
    logo(e, L, S.logo, S.logo.vo);
    phoneScenes(e, L, fmt, timed.filter((s) => s.kind === "phone"), { poses: POSES, stickers: STICKERS, zoom: ["map"], extrasCopy, extrasAnim });
    end(e, L, S.end, S.end.vo, {
      promises: ["भेरिफाइड होस्टल", "क्लियर भाडा", "भरपर्दो बुकिङ"], ticks: [0, 1.3, 2.25],
      shots: ["still_map", "still_detail", "still_idcard"], tagline: "होस्टल खोज्ने नयाँ तरिका", accent: [2, 3],
    });
  },
  ambient: (e, L, S) => `tl.fromTo("#dark",{scale:1.08},{scale:1,duration:${e.r(S.logo.start + S.logo.burst)},ease:"none"},0);`,
});
