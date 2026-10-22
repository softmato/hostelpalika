// The owner film, v4: hook (fire → app glimpse → promise) → eight numbered sections, each opening on
// the problem in one sentence and then showing + saying the fix → the owner at ease → how to start
// today, step by step → close. Source times are seconds into assets/cfr/<clip>.mp4. Phone scenes last
// voice + TAIL unless `dur`; most footage is lifted from the admin film's tuned takes.
import { execFileSync } from "node:child_process";
import { scenes as A } from "../../admin-film/build/config.mjs";

export const TOUCH_LAG = 0.4;
export const TAIL = 0.3;

const take = (id) => A.find((s) => s.id === id);
const len = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
  decodeURIComponent(new URL(`../assets/audio/${f}.mp3`, import.meta.url).pathname).replace(/^\/([A-Z]:)/, "$1")]));
// a footage range played to last exactly `dur` seconds (speeds then sum to the scene, so nothing is rescaled)
const fit = (clip, from, to, dur, extra = {}) => ({ clip, from, to, speed: (to - from) / dur, ...extra });

const REVIEW = [0, 860, 720, 300]; // the Play review row carries the user's own name
const AVATAR = [585, 85, 135, 100]; // the Play account avatar
const RES = [513, 678, 843, 1008, 1172, 1337, 1502];
const resBlur = [...RES.map((y) => [290, y - 18, 220, 36]), [0, 660, 520, 36]];
const AREA = [20, 725, 680, 260]; // KYC details: autofill typed the user's name into Area / Address
const MAPNAME = [0, 1060, 720, 90]; // KYC map: the same name under the pin

// ── how to start: one voice line per step, each step's footage fills exactly its line ──
// step 2 carries two lines: install from Play, or from the website on an iPhone
const HOW = ["v4_15a_search", "v4_15b_install", "v4_15b2_iphone", "v4_15c_register", "v4_15d_portal", "v4_15e_kyc", "v4_15f_verified"];
let t = 0.3;
const how = HOW.map((file) => { const at = t, l = len(file); t += l + 0.15; return { file, at, len: l }; });
const howEnd = how[6].at + how[6].len + 0.5;
const step = [0, 1, 3, 4, 5, 6].map((i) => how[i].at); // when each of the six steps begins
const win = (i) => (step[i + 1] ?? howEnd) - (i ? step[i] : 0);
const kycSegs = [ // [clip, from, to, share of the KYC window, rail label]
  ["k01_details", 0.8, 3.8, 2.3, "Details", { blur: [AREA] }],
  ["k02_kyc", 50, 54, 1.1, "Photos"],
  ["k02_kyc", 57.4, 61, 1.0, "Room types"],
  ["k02_kyc", 78.5, 82, 1.0, "Documents"],
  ["k03_kyc", 50.4, 54, 1.0, "Map", { blur: [MAPNAME] }],
  ["k03_kyc", 130.4, 136, 1.6, "Agreement"],
  ["k04_submit", 3, 5, 0.55, "Send"],
  ["k04_submit", 12.5, 14.5, 0.6, null],
];
const kycK = win(4) / kycSegs.reduce((a, s) => a + s[3], 0);
let kt = step[4];
const kycRail = kycSegs.map(([, , , d, label]) => { const at = kt; kt += d * kycK; return label && [label, at]; }).filter(Boolean);

export const scenes = [
  { id: "hook", kind: "hook", dur: 8.4, burst: 3.75,
    vo: [{ file: "v4_00_hook", at: 0.15 }, { file: "v4_01_reveal", at: 4.1 }] },

  // ── 01 · Residents ──
  {
    id: "qr", kind: "phone", word: "Residents.", chapNo: 0, label: "Admission by QR", eyebrow: "01 · Residents",
    np: ["विद्यार्थीले क्यूआर स्क्यान गरेर", "फारम आफैं भर्छन्।"], sticker: "qr",
    pain: { text: "नयाँ फारम भर्न झन्झट लाग्छ।", at: 0.4, end: 2.95 },
    vo: [{ file: "v4_02_qr", at: 0.3, sub: true }],
    dur: 12.3,
    // the hostel's Form QR → the owner finds the filled form on the Residents tab and checks it
    segs: [fit("u01_unlock", 17.8, 24.9, 8.1), fit("q01_form", 3.3, 5.9, 1.3), fit("q01_form", 7.2, 11.0, 2.9)],
    focus: [{ at: 3.0, hold: 1.9, k: 1.9, box: [150, 380, 420, 420] }, { src: ["q01_form", 4.9], hold: 0.4, k: 1.8, box: [20, 440, 680, 95] },
      { src: ["q01_form", 8.6], hold: 0.8, k: 1.7, box: [20, 1495, 680, 62] }],
    student: { at: 5.4, sent: 8.15 },
    steps: [{ at: 5.6, n: 1, text: "विद्यार्थीले क्यूआर स्क्यान गर्छन्।" }, { at: 6.9, n: 2, text: "उनीहरू फारम आफैं भर्छन्।" },
      { at: 8.35, n: 3, text: "तपाईं जाँचेर थप्नुहुन्छ।" }],
  },
  {
    id: "byhand", kind: "phone", label: "Rooms & Beds", eyebrow: "01 · Residents",
    np: ["फारम आफैं पनि भर्न सकिन्छ।", "कति बेड खाली छ, एकै नजरमा देखिन्छ।"], sticker: "bed",
    vo: [{ file: "v4_03_byhand", at: 0.3, sub: true }],
    segs: [
      { clip: "u01_unlock", from: 14.2, to: 17.0, speed: 1.1 },
      { clip: "a11_residents", from: 6.4, to: 9.3, speed: 1.0, blur: resBlur },
      { clip: "a12_rooms", from: 2.1, to: 8.6, speed: 2.4 },
    ],
    focus: [{ at: 0.9, hold: 1.1, k: 2.0, box: [30, 1440, 660, 56] }],
    cards: [{ at: 4.2, png: "bed", title: "Rooms", value: "47", sub: "of 175 beds free" }],
  },

  // ── 02 · Money ──
  {
    ...take("payments"), id: "rent", word: "Money.", chapNo: 1, label: "Who Paid?", eyebrow: "02 · Money",
    np: ["सबैको बाँकी", "एउटै लिस्टमा देखिन्छ।"],
    pain: { text: "भाडा कसले तिर्‍यो, सम्झन गाह्रो हुन्छ।", at: 0.4, end: 3.45 },
    vo: [{ file: "v4_05_rent", at: 0.3, sub: true }],
    segs: [...take("payments").segs, ...take("collect").segs.slice(1)],
    focus: [{ src: ["a07b_collect", 17.2], hold: 1.2, k: 1.6, box: [100, 1000, 520, 420] }],
    cards: [{ at: 3.9, png: "people", title: "Aswin 2083", value: "7", sub: "people still owe" }],
  },
  {
    ...take("esewa"), id: "receipt", label: "Share a Receipt", eyebrow: "02 · Money", dur: 7.2,
    np: ["रसिद सेयर गर्दा", "खर्च आफैं चढ्छ।"], vo: [{ file: "v4_06_receipt", at: 0.3, sub: true }],
    focus: [take("esewa").focus[1], take("esewa").focus[5]],
    steps: [{ tap: 1, n: 1, text: "रसिद सेयर गर्नुहोस्।" }, { src: ["e01_esewa", 8.4], n: 2, text: "एपले रसिद आफैं पढ्छ।" },
      { tap: 4, n: 3, text: "सेभ थिच्नुहोस्।" }],
  },
  {
    id: "money", kind: "phone", label: "Every Rupee", eyebrow: "02 · Money",
    np: ["खर्च, स्टक र उधारो", "छुट्टाछुट्टै राखिन्छ।"], sticker: "moneybag",
    vo: [{ file: "v4_07_money", at: 0.3, sub: true }],
    segs: [take("expense").segs[0], take("stock").segs[0], take("khata").segs[0]],
    focus: [{ src: ["a08_khata", 3.0], hold: 1.0, box: [55, 1010, 560, 105] }],
    cards: [{ at: 1.2, png: "barchart", title: "Spent on", bars: [["Other", 42], ["Groceries", 28], ["Salary", 26], ["Veg & meat", 4]] }],
  },

  // ── 03 · Reports ──
  {
    id: "statement", kind: "phone", word: "Reports.", chapNo: 2, label: "Statement & Reports", eyebrow: "03 · Reports",
    np: ["स्टेटमेन्ट र रिपोर्ट", "एक ट्यापमा पीडीएफ बन्छ।"], sticker: "page", dur: 8.0,
    vo: [{ file: "v4_08_statement", at: 0.3, sub: true }],
    pdf: { at: 2.7, file: "statement" },
    segs: [
      { clip: "a18_reports", from: 2.0, to: 11.2, speed: 3.2 },
      { clip: "a09_statement", from: 2.4, to: 7.4, speed: 2.0 },
      { clip: "a09_statement", from: 10.4, to: 15.5, speed: 1.6 },
    ],
  },

  // ── 04 · Staff ──
  {
    id: "staff", kind: "phone", word: "Staff.", chapNo: 3, label: "Staff Apps", eyebrow: "04 · Staff",
    np: ["वार्डन र कुकको", "आफ्नै एप हुन्छ।"], sticker: "guard",
    pain: { text: "स्टाफलाई दिनभर फोन गर्नुपर्छ।", at: 0.4, end: 2.2 },
    vo: [{ file: "v4_10_staff", at: 0.3, sub: true }],
    segs: [
      { clip: "a14_warden", from: 4.1, to: 9.6, speed: 1.6 },
      { clip: "w01_warden", from: 1.8, to: 7.6, speed: 1.6 },
      { clip: "c01_cook", from: 1.5, to: 9.5, speed: 2.0 },
    ],
    perms: { at: 4.4, on: ["Residents", "Rooms", "Record cash", "Food", "Notices"], off: ["Edit the hostel", "Reverse payments"] },
    cards: [{ ...take("cookapp").cards[0], at: 2.9 }],
  },

  // ── 05 · Branches ──
  {
    ...take("branch"), id: "branch", word: "Branches.", chapNo: 4, label: "Every Branch", eyebrow: "05 · Branches",
    np: ["एक ट्यापमा", "ब्रान्च बदलिन्छ।"], vo: [{ file: "v4_11_branch", at: 0.3, sub: true }],
  },

  // ── 06 · Secure ──
  {
    id: "lock", kind: "phone", word: "Secure.", chapNo: 5, label: "App Lock", eyebrow: "06 · Secure",
    np: ["एप पिन वा फिङ्गरप्रिन्टले", "मात्र खुल्छ।"], sticker: "lock",
    vo: [{ file: "v4_12_lock", at: 0.3, sub: true }], dur: 5.2,
    segs: [
      { clip: "p06_lock", from: 1.6, to: 4.2, speed: 1.2 },
      { clip: "p06_lock", from: 11.6, to: 21.4, speed: 4.0 },
      { clip: "p07_pinopen", from: 1.0, to: 6.0, speed: 2.4 },
    ],
    cards: [{ at: 2.0, png: "shield", title: "App lock", value: "ON", sub: "PIN · fingerprint · same PIN on the web", tick: true }],
  },

  // ── 07 · Web portal ──
  { id: "web", kind: "web", chapNo: 6, dur: 6.9, vo: [{ file: "v4_13_web", at: 0.4, sub: true }] },

  // the payoff: the owner at ease
  { id: "calm", kind: "calm", dur: 5.1, vo: [{ file: "v4_14_calm", at: 0.3 }] },

  // ── 08 · Start today ──
  {
    id: "howto", kind: "phone", word: "Start.", chapNo: 7, chapIn: "fade", label: "Start Today", eyebrow: "08 · Start Today",
    np: [], sticker: "sparkles", dur: Math.round(howEnd * 30) / 30,
    vo: how.map(({ file, at }) => ({ file, at })), // the step panel already carries each line
    segs: [
      fit("s01_search", 2.0, 4.6, win(0) * 0.3, { blur: [AVATAR] }),
      fit("s01_search", 9.8, 15.8, win(0) * 0.42, { blur: [AVATAR] }),
      fit("s01_search", 17.0, 18.6, win(0) * 0.28, { blur: [AVATAR] }),
      fit("p01_playstore", 0.3, 6.3, win(1), { blur: [REVIEW] }), // the listing holds still until 9.6 s
      fit("p03_register", 1.2, 3.6, win(2) * 0.26),
      fit("p03_register", 13.0, 15.6, win(2) * 0.2),
      fit("p03_register", 21.5, 24.0, win(2) * 0.2),
      fit("p03_register", 33.0, 36.5, win(2) * 0.2),
      fit("p03_register", 40.5, 42.5, win(2) * 0.14),
      fit("p03_register", 42.5, 44.5, win(3) * 0.4),
      fit("u01_unlock", 12.0, 13.4, win(3) * 0.6),
      ...kycSegs.map(([clip, from, to, d, , extra]) => fit(clip, from, to, d * kycK, extra)),
      fit("u01_unlock", 5.6, 8.6, win(5) * 0.55),
      fit("a02_home", 1.6, 4.8, win(5) * 0.45),
    ],
    // close-ups zoom in place on the right so the step panel stays readable
    focus: [
      { at: step[1] - 0.75, hold: 0.5, k: 1.7, tx: 1330, box: [10, 940, 700, 110] },
      { at: step[1] + 0.1, hold: 1.0, k: 1.6, tx: 1330, box: [20, 190, 680, 290] },
      { at: step[5] + 0.3, hold: 1.2, k: 1.8, tx: 1330, box: [20, 330, 680, 170] },
    ],
    howto: [
      ["Search HostelPalika", "प्ले स्टोरमा होस्टलपालिका खोज्नुहोस्।"],
      ["Install", "इन्स्टल गरेर एप खोल्नुहोस्।"],
      ["Register hostel", "नाम, फोन र होस्टलको नाम भर्नुहोस्।"],
      ["Your portal opens", "पोर्टल तुरुन्तै खुल्छ।"],
      ["Fill the KYC", "विवरण भरेर पठाउनुहोस्।"],
      ["Start managing", "भेरिफाइ भएपछि सुरु गर्नुहोस्।"],
    ].map(([title, np], i) => ({ title, np, at: step[i], short: ["Search", "Install", "Register", "Portal", "KYC", "Start"][i] })),
    kycRail, ios: { at: how[2].at, end: step[2] - 0.35 },
  },
  { id: "end", kind: "end", dur: 6.6, vo: [{ file: "v4_16_end", at: 0.5 }] },
];
