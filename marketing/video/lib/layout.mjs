// Geometry for each output format. Phone screen keeps the recording's aspect (720 × 1580 + status bar).
import { CROP_TOP } from "./segments.mjs";

function phone(screenW, cx, cy, pad, r) {
  const s = screenW / 720, bar = Math.round(CROP_TOP * s), videoH = Math.round((1640 - CROP_TOP) * s);
  const screenH = bar + videoH;
  return { s, bar, cx, cy, pad, r, w: screenW + pad * 2, h: screenH + pad * 2, screenW, screenH };
}

export const layouts = {
  landscape: {
    W: 1920, H: 1080,
    phone: phone(422, 1330, 540, 12, 62),
    copy: { x: 170, y: 318, w: 830, align: "left", eyebrow: 22, label: 100, np: 50, chip: 24, thread: 120 },
    bug: { x: 64, y: 50, h: 44 },
    cap: 68, capY: 850,
    sub: { x: 170, y: 905, w: 880, align: "left", size: 34 },
    hook: { cx: 960, cy: 410, w: 720, h: 480 },
    touch: 22, receipt: { w: 380, x: 820, y: 230 }, tick: 120, pinFont: 20,
    mini: { w: 300, h: 300 * (1640 / 720) * 0.93, r: 40, pad: 8 },
    end: { url: 34, lockY: 190, minisY: 690 },
    pins: [[1590, 300], [1600, 560], [1585, 830], [260, 780], [600, 900], [880, 760]],
    route: { from: [1150, 600], to: [560, 860], c1: [980, 980], c2: [760, 640] },
  },
  portrait: {
    W: 1080, H: 1920,
    phone: phone(520, 540, 1262, 13, 70),
    copy: { x: 60, y: 168, w: 960, align: "center", eyebrow: 26, label: 92, np: 48, chip: 22, thread: 120 },
    bug: { x: 60, y: 70, h: 46 },
    cap: 74, capY: 1300,
    sub: { x: 70, y: 1690, w: 940, align: "center", size: 38 },
    hook: { cx: 540, cy: 800, w: 820, h: 560 },
    touch: 26, receipt: { w: 470, x: 305, y: 690 }, tick: 140, pinFont: 22,
    mini: { w: 330, h: 330 * (1640 / 720) * 0.93, r: 44, pad: 9 },
    end: { url: 40, lockY: 380, minisY: 1180 },
    pins: [],
    route: null,
  },
};
