// The hostel-admin film: cold question → pain → reveal → five sections (Branches, Money,
// Residents, Staff, Daily) → promises → logo. Source times are seconds into assets/cfr/<clip>.mp4.
// Phone scenes last voice + TAIL; footage is retimed to fit (relative speeds kept, clamp 0.75–4×).
// focus: close-ups ({tap: n} = nth logged tap in this scene, or {at, x, y}); cards: glass callouts.
// blur: [x, y, w, h, fromSrc, toSrc] boxes over phone numbers on lists (recording px).

export const TOUCH_LAG = 0.4;
export const TAIL = 0.6;

// phone-number boxes, measured on the recordings
const ROWS_RES = [513, 678, 843, 1008, 1172, 1337, 1502];
const ROWS_PAY = [800, 958, 1116, 1274, 1432, 1590];
const resBlur = (a, b, skip = -1) => ROWS_RES.filter((_, i) => i !== skip).map((y) => [250, y - 16, 142, 32, a, b]);
const ESEWA_BLUR = [[60, 895, 170, 40, 0, 15.0], [350, 1137, 190, 40, 0, 15.0], [60, 895, 170, 40, 18.9, 21.2], [350, 1137, 190, 40, 18.9, 21.2]];
const payBlur = (a, b) => ROWS_PAY.map((y) => [268, y - 16, 120, 32, a, b]);

export const scenes = [
  { id: "cold", kind: "cold", dur: 8.2, vo: [{ file: "00_hook_sunita", at: 0.3 }] },
  { id: "pain", kind: "pain", dur: 7.9, vo: [{ file: "01_pain_sunita", at: 0.2 }] },
  // the music's drop lands on the light burst at start + burst
  { id: "logo", kind: "logo", dur: 10.3, burst: 1.45,
    vo: [{ file: "02a_bishnu", at: 0.1 }, { file: "02b_bishnu", at: 1.8 }, { file: "02c_sunita", at: 4.2, sub: true }] },

  // ── Branches ──
  {
    id: "branch", kind: "phone", word: "Branches.", label: "Every Branch", eyebrow: "01 · Branches",
    np: ["मेन होस्टल, ब्रान्च, ओभरअल —", "एक ट्यापमा"], sticker: "link",
    vo: [{ file: "03_branch_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a01_branch", from: 1.8, to: 4.9, speed: 1.2 },
      { clip: "a01_branch", from: 4.9, to: 8.0, speed: 2.6 },
      { clip: "a01_branch", from: 11.3, to: 15.6, speed: 1.2 },
      { clip: "a01_branch", from: 16.6, to: 18.8, speed: 2.2 },
    ],
    focus: [{ tap: 1, hold: 0.6, box: [20, 1185, 680, 115] }, { tap: 3, hold: 0.8, box: [20, 1345, 680, 100] }],
  },
  {
    id: "home", kind: "phone", label: "Today at a Glance", eyebrow: "01 · Branches",
    np: ["कति उठ्यो, कति बाँकी —", "होममै"], sticker: "eye",
    vo: [{ file: "04_home_sunita", at: 0.35, sub: true }],
    segs: [
      { clip: "a02_home", from: 1.6, to: 4.8, speed: 1.0 },
      { clip: "a02_home", from: 4.8, to: 9.0, speed: 2.4 },
    ],
    focus: [{ tap: 0, hold: 1.3, box: [30, 365, 360, 85] }],
    cards: [{ at: 1.9, png: "moneybag", title: "This month", value: "Rs 84,512", rows: [["In Aswin", "Rs 65,226"], ["Still due", "Rs 52,581"]] }],
  },

  // ── Money ──
  {
    id: "expense", kind: "phone", word: "Money.", label: "Add Expense", eyebrow: "02 · Money",
    np: ["रकम, क्याटेगोरी, सेभ —", "दुई सेकेन्डमा"], sticker: "cart",
    vo: [{ file: "05_expense_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a03_expense", from: 2.0, to: 9.0, speed: 1.7 },
      { clip: "a03_expense", from: 17.6, to: 20.4, speed: 3.0 },
      { clip: "a03_expense", from: 21.7, to: 24.6, speed: 1.4 },
    ],
    focus: [{ tap: 1, hold: 0.9, box: [20, 230, 680, 190] }, { tap: 3, hold: 0.5 }],
    cards: [{ at: 4.6, png: "rice", title: "Groceries", value: "Rs 2,500", sub: "Rice 25 kg · saved", tick: true }],
  },
  {
    id: "esewa", kind: "phone", label: "Share a Receipt", eyebrow: "02 · Money",
    np: ["इसेवाको रसिद सेयर —", "एपले आफैं पढ्छ"], sticker: "receipt",
    vo: [{ file: "06_esewa_sunita", at: 0.4, sub: true }, { file: "06b_esewa_sunita", at: 9.4, sub: true }],
    scan: { src: ["e01_esewa", 8.4] },
    segs: [
      { clip: "e01_esewa", from: 0.0, to: 1.4, speed: 1.2, blur: ESEWA_BLUR },
      { clip: "e01_esewa", from: 1.4, to: 4.4, speed: 1.6, blur: ESEWA_BLUR },
      { clip: "e01_esewa", from: 6.3, to: 8.0, speed: 1.1, blur: ESEWA_BLUR },
      { clip: "e01_esewa", from: 8.0, to: 15.0, speed: 2.0, blur: ESEWA_BLUR },
      { clip: "e01_esewa", from: 15.0, to: 17.4, speed: 0.9 },
      { clip: "e01_esewa", from: 17.4, to: 19.0, speed: 1.0 },
      { clip: "e01_esewa", from: 21.4, to: 23.6, speed: 1.0 },
    ],
    focus: [
      { tap: 0, hold: 0.3, box: [615, 95, 95, 85] }, { tap: 1, hold: 0.3, box: [20, 1395, 680, 75] }, { tap: 2, hold: 0.3, box: [30, 1478, 660, 95] }, { tap: 3, hold: 0.5 },
      { src: ["e01_esewa", 15.8], hold: 0.8, box: [25, 860, 670, 345] },
      { tap: 4, hold: 0.5, box: [370, 1462, 260, 100] }, { src: ["e01_esewa", 21.8], hold: 1.0, box: [15, 725, 560, 160] },
    ],
    steps: [
      { tap: 0, n: 1, text: "इसेवामा रसिद खोल्नुहोस्" }, { tap: 1, n: 2, text: "सेयर" }, { tap: 3, n: 3, text: "HostelPalika छान्नुहोस्" },
      { src: ["e01_esewa", 8.4], n: 4, text: "एपले आफैं पढ्छ" }, { src: ["e01_esewa", 16.0], n: 5, text: "रकम, पेमेन्ट — आफैं भरियो" }, { tap: 4, n: 6, text: "सेभ ✓" },
    ],
  },
  {
    id: "spend", kind: "phone", label: "Money In & Out", eyebrow: "02 · Money",
    np: ["तलब, ग्रोसरी, बिजुली —", "सबै छुट्टाछुट्टै"], sticker: "barchart",
    vo: [{ file: "07_spend_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a05_spend", from: 1.9, to: 10.5, speed: 1.8 },
      { clip: "a05b_cash", from: 3.9, to: 8.6, speed: 1.6 },
      { clip: "a05b_cash", from: 13.3, to: 17.9, speed: 1.6 },
    ],
    focus: [{ src: ["a05_spend", 3.0], hold: 1.0, box: [20, 170, 670, 235] }, { tap: 3, hold: 0.7 }],
    cards: [{ at: 2.2, png: "barchart", title: "Spent on", bars: [["Other", 42], ["Groceries", 28], ["Salary", 26], ["Veg & meat", 4]] },
      { at: 6.6, png: "cash", title: "Cash to Demo Warden", value: "Rs 3,000", sub: "Staff cash", tick: true }],
  },
  {
    id: "stock", kind: "phone", label: "Stock", eyebrow: "02 · Money",
    np: ["थप्नुहोस्, ब्रान्चमा पठाउनुहोस् —", "सबै गनिन्छ"], sticker: "package",
    vo: [{ file: "08_stock_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a06_stock", from: 2.4, to: 7.6, speed: 1.6 },
      { clip: "a06_stock", from: 14.9, to: 16.5, speed: 1.2 },
      { clip: "a06b_send", from: 2.4, to: 7.4, speed: 1.8 },
      { clip: "a06b_send", from: 12.6, to: 14.7, speed: 1.2 },
    ],
    focus: [{ tap: 2, hold: 0.7, box: [45, 390, 630, 95] }, { tap: 7, hold: 0.8 }],
    transfer: { at: 5.0, items: ["Rice 10 kg", "Daal 5 kg"] },
  },
  {
    id: "payments", kind: "phone", label: "Who Paid?", eyebrow: "02 · Money",
    np: ["कसको कति बाँकी —", "एउटै लिस्टमा"], sticker: "bank",
    vo: [{ file: "09_payments_sunita", at: 0.45, sub: true }],
    segs: [{ clip: "a07_payments", from: 1.6, to: 10.9, speed: 1.6, blur: [...payBlur(1.6, 2.7), ...payBlur(5.6, 10.9)] }],
    cards: [{ at: 3.6, png: "people", title: "Aswin 2083", value: "7", sub: "people still owe" }],
  },
  {
    id: "collect", kind: "phone", label: "Collect Cash", eyebrow: "02 · Money",
    np: ["नगद आयो?", "एक ट्यापमा हिसाब मिल्छ"], sticker: "coin",
    vo: [{ file: "09b_collect_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a07b_collect", from: 7.9, to: 12.4, speed: 1.0, blur: [...payBlur(7.9, 9.15), [85, 888, 122, 38, 9.15, 12.4]] },
      { clip: "a07b_collect", from: 15.6, to: 18.0, speed: 0.8, blur: [[85, 888, 122, 38]] },
    ],
    focus: [
      { tap: 0, hold: 0.2, box: [15, 715, 690, 130] },
      { src: ["a07b_collect", 9.9], hold: 1.5, k: 1.3, box: [10, 540, 700, 1030] },
      { tap: 1, hold: 0.3, box: [20, 1450, 680, 100] },
      { src: ["a07b_collect", 17.2], hold: 1.3, k: 1.6, box: [100, 1000, 520, 420] },
    ],
  },
  {
    id: "khata", kind: "phone", label: "Khata", eyebrow: "02 · Money",
    np: ["उधारो आफैं", "अर्को बिलमा जोडिन्छ"], sticker: "ledger",
    vo: [{ file: "10_khata_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a08_khata", from: 2.0, to: 5.6, speed: 1.1 },
      { clip: "a08_khata", from: 7.0, to: 10.5, speed: 2.5 },
      { clip: "a08_khata", from: 14.6, to: 20.5, speed: 2.2 },
    ],
    focus: [{ src: ["a08_khata", 3.0], hold: 1.1, box: [55, 1010, 560, 105] }],
    cards: [{ at: 1.4, png: "ledger", title: "Demo Resident", value: "Rs 70", sub: "→ goes on the next bill" }],
  },
  {
    id: "statement", kind: "phone", label: "Statement", eyebrow: "02 · Money",
    np: ["डेबिट, क्रेडिट, ब्यालेन्स —", "एक ट्यापमा PDF"], sticker: "page",
    vo: [{ file: "11_statement_sunita", at: 0.45, sub: true }],
    dur: 9.2, pdf: { at: 3.4, file: "statement" },
    segs: [
      { clip: "a09_statement", from: 2.4, to: 7.4, speed: 2.0 },
      { clip: "a09_statement", from: 10.4, to: 15.5, speed: 1.6 },
    ],
  },
  {
    id: "settings", kind: "phone", label: "Fees & Rules", eyebrow: "02 · Money",
    np: ["भाडा, डिस्काउन्ट, लेट फाइन —", "एकपटक सेट"], sticker: "gear",
    vo: [{ file: "12_settings_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a10_settings", from: 2.2, to: 4.6, speed: 1.2 },
      { clip: "a10_settings", from: 6.9, to: 10.0, speed: 1.3 },
      { clip: "a10_settings", from: 16.8, to: 20.0, speed: 1.3 },
    ],
    pills: [{ at: 2.4, text: "Dashain · 50% off" }, { at: 3.0, text: "Room rates · 4 types" }, { at: 4.9, text: "Late fine · Rs 60/day after 5 days" }],
  },

  // ── Residents ──
  {
    id: "residents", kind: "phone", word: "Residents.", label: "Residents", eyebrow: "03 · Residents",
    np: ["रुम, फोन, भुक्तानी —", "एकै लिस्टमा"], sticker: "people",
    vo: [{ file: "13_residents_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a11_residents", from: 1.6, to: 4.4, speed: 1.8, blur: resBlur(1.6, 2.5) },
      { clip: "a11_residents", from: 6.4, to: 9.3, speed: 1.0, blur: [...resBlur(6.4, 9.3, 1), [250, 662, 142, 32, 6.4, 7.0], [80, 662, 142, 32, 7.3, 9.3]] },
      { clip: "a11b_profile", from: 1.9, to: 4.0, speed: 1.5, blur: [[110, 384, 118, 38]] },
      { clip: "a11b_profile", from: 12.8, to: 15.8, speed: 1.2 },
    ],
    focus: [{ src: ["a11_residents", 7.3], x: 560, y: 672, hold: 1.0 }, { src: ["a11b_profile", 14.4], hold: 0.9, box: [30, 215, 660, 160] }],
  },
  {
    id: "resident", kind: "phone", label: "Resident App", eyebrow: "03 · Residents", badge: "Resident's phone",
    np: ["डिजिटल ID, बाँकी रकम,", "एक ट्यापमा पेमेन्ट"], sticker: "card",
    vo: [{ file: "13b_resident_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "r01_resident", from: 1.8, to: 4.6, speed: 1.3 },
      { clip: "r01_resident", from: 4.9, to: 8.6, speed: 1.4, blur: [[280, 878, 150, 36]] },
      { clip: "r01_resident", from: 12.9, to: 16.4, speed: 1.3 },
    ],
    focus: [{ tap: 0, hold: 0.9, box: [45, 455, 310, 115] }],
    cards: [{ at: 4.4, png: "card", title: "Digital ID", value: "HH-4E8N", sub: "scan to share details" }],
  },
  {
    id: "rooms", kind: "phone", label: "Rooms & Beds", eyebrow: "03 · Residents",
    np: ["कुन रुममा कति बेड खाली —", "एकै नजरमा"], sticker: "bed",
    vo: [{ file: "14_rooms_sunita", at: 0.45, sub: true }],
    segs: [{ clip: "a12_rooms", from: 2.1, to: 11.6, speed: 2.2 }],
    cards: [{ at: 1.3, png: "bed", title: "Education Light", value: "47", sub: "of 175 beds free" }],
  },
  {
    id: "night", kind: "phone", label: "Night Status", eyebrow: "03 · Residents",
    np: ["को भित्र, को बाहिर —", "हरेक राति"], sticker: "moon",
    vo: [{ file: "15_night_sunita", at: 0.45, sub: true }],
    segs: [{ clip: "a12_rooms", from: 15.6, to: 22.1, speed: 1.2 }],
    focus: [{ src: ["a12_rooms", 16.8], hold: 1.1, box: [20, 200, 680, 200] }],
    cards: [{ at: 2.0, png: "moon", title: "Roll call", value: "20:00", sub: "asked again every 30 min" }],
  },

  // ── Staff ──
  {
    id: "warden", kind: "phone", word: "Staff.", label: "Wardens", eyebrow: "04 · Staff",
    np: ["के हेर्न दिने, के नदिने —", "तपाईंकै हातमा"], sticker: "key",
    vo: [{ file: "16_warden_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a14_warden", from: 1.9, to: 3.0, speed: 2.0 },
      { clip: "a14_warden", from: 4.1, to: 9.6, speed: 1.4 },
      { clip: "a14b_invite", from: 14.3, to: 19.0, speed: 1.4 },
    ],
    focus: [{ tap: 2, hold: 0.8 }, { tap: 4, hold: 1.2, box: [10, 1335, 700, 205] }],
    perms: { at: 2.4, on: ["Residents", "Rooms", "Record cash", "Food", "Notices"], off: ["Edit the hostel", "Reverse payments"] },
  },
  {
    id: "wardenapp", kind: "phone", label: "Warden's App", eyebrow: "04 · Staff", badge: "Warden's phone",
    np: ["क्यास पुष्टि, पेमेन्ट एप्रुभ —", "एक ट्यापमा"], sticker: "guard",
    vo: [{ file: "16b_wardenapp_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "w01_warden", from: 1.8, to: 7.6, speed: 1.4 },
      { clip: "w01_warden", from: 9.6, to: 11.8, speed: 1.6, blur: payBlur(9.6, 11.8) },
      { clip: "w01_warden", from: 12.7, to: 15.6, speed: 1.2 },
      { clip: "w01_warden", from: 18.6, to: 21.6, speed: 1.0, blur: payBlur(18.6, 21.6) },
    ],
    focus: [{ tap: 1, hold: 0.6 }, { tap: 4, hold: 0.9 }],
    cards: [{ at: 1.9, png: "cash", title: "Cash from the owner", value: "Rs 3,000", sub: "Got it · added to my cash", tick: true },
      { at: 5.6, png: "check", title: "Claim verified", value: "Rs 2,000", sub: "Demo Resident · eSewa", tick: true }],
  },
  {
    id: "cook", kind: "phone", label: "Cooks", eyebrow: "04 · Staff",
    np: ["खर्च अनुमति, फिंगरप्रिन्ट —", "किचन पनि सफा"], sticker: "cook",
    vo: [{ file: "17_cook_sunita", at: 0.45, sub: true }],
    segs: [{ clip: "a15_cook", from: 2.0, to: 13.4, speed: 1.6 }],
    focus: [{ tap: 1, hold: 0.8 }, { tap: 2, hold: 0.7 }],
  },
  {
    id: "cookapp", kind: "phone", label: "Cook's App", eyebrow: "04 · Staff", badge: "Cook's phone",
    np: ["खाना तयार —", "एक ट्यापमा सबैलाई थाहा"], sticker: "rice",
    vo: [{ file: "17b_cookapp_sunita", at: 0.45, sub: true }],
    segs: [{ clip: "c01_cook", from: 1.5, to: 9.5, speed: 1.0 }],
    focus: [{ tap: 0, hold: 1.4 }],
    cards: [{ at: 4.2, png: "bell", title: "Lunch announced", value: "8", sub: "residents notified · office too", tick: true }],
  },

  // ── Daily ──
  {
    id: "food", kind: "phone", word: "Daily.", label: "Food Menu", eyebrow: "05 · Daily",
    np: ["हप्ताभरिको मेनु —", "सबैले देख्छन्"], sticker: "plate",
    vo: [{ file: "18_food_sunita", at: 0.45, sub: true }],
    segs: [{ clip: "a16_more", from: 2.0, to: 12.5, speed: 2.0 }],
  },
  {
    id: "notices", kind: "phone", label: "Notices & Repairs", eyebrow: "05 · Daily",
    np: ["सूचना, मर्मत, गुनासो —", "फोनैफोन बिना"], sticker: "megaphone",
    vo: [{ file: "19_notices_sunita", at: 0.45, sub: true }],
    segs: [
      { clip: "a16_more", from: 15.4, to: 24.5, speed: 2.4 },
      { clip: "a16_more", from: 36.4, to: 38.4, speed: 1.0 },
      { clip: "a16_more", from: 43.5, to: 49.0, speed: 2.0 },
    ],
  },
  {
    id: "reports", kind: "phone", label: "Monthly Report", eyebrow: "05 · Daily",
    np: ["बिल, कलेक्सन, अकुपेन्सी —", "एक ट्यापमा PDF"], sticker: "chartup",
    vo: [{ file: "20_reports_sunita", at: 0.45, sub: true }],
    dur: 9.0, pdf: { at: 4.0, file: "performance" },
    segs: [
      { clip: "a18_reports", from: 2.0, to: 11.2, speed: 2.6 },
      { clip: "a18_reports", from: 15.9, to: 18.6, speed: 1.2 },
      { clip: "a18b_pdf", from: 1.9, to: 5.9, speed: 1.0 },
    ],
  },
  { id: "end", kind: "end", dur: 12.8,
    vo: [{ file: "21a_sunita", at: 0.6 }, { file: "21b_bishnu", at: 5.9 }, { file: "22_cta_sunita", at: 9.2 }] },
];
