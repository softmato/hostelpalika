// The public-side film (v2): cold open → pain hook → reveal → eight product scenes → close.
// Source times are seconds into assets/cfr/<clip>.mp4 (30fps copies of the phone recordings).
// Phone scenes last as long as their voice line plus TAIL; the footage is retimed to fit.
// `decimate` drops frames where the screen did not change (map zoom waits are dead air).

export const TOUCH_LAG = 0.4; // adb `input` lands ~0.4s after the logged command time
export const TAIL = 1.0;      // breath after each scene's line before the next scene

export const scenes = [
  { id: "cold", kind: "cold", dur: 10.0, vo: [{ file: "00a_bishnu", at: 0.8 }, { file: "00b_bishnu", at: 5.4 }] },
  { id: "hook", kind: "hook", dur: 8.8, vo: [{ file: "01_sunita", at: 0.3 }] },
  // the music's drop lands on the light burst at start + burst
  { id: "logo", kind: "logo", dur: 11.2, burst: 2.0,
    vo: [{ file: "02a_bishnu", at: 0.2 }, { file: "02b_bishnu", at: 2.3 }, { file: "02c_sunita", at: 4.7, sub: true }] },
  {
    id: "search", kind: "phone", word: "Search.", label: "Search & Filter", eyebrow: "01 · Discover",
    np: ["बजेट, रुम, खाना —", "आफ्नै हिसाबले"],
    vo: [{ file: "03_sunita", at: 0.5, sub: true }],
    segs: [
      { clip: "c01_home", from: 3.6, to: 8.0, speed: 1.6 },
      { clip: "c02_search", from: 5.9, to: 14.4, speed: 1.7 },
      { clip: "c02_search", from: 16.9, to: 20.0, speed: 1.4 },
    ],
  },
  {
    id: "map", kind: "phone", word: "Map.", label: "Hostel Map", eyebrow: "02 · Nepal-wide",
    np: ["नेपालभरका होस्टल,", "एकै नजरमा"],
    vo: [{ file: "04_sunita", at: 0.5, sub: true }],
    segs: [{ clip: "c03_map", from: 11.4, to: 104, speed: 1.25, decimate: true }],
  },
  {
    id: "directions", kind: "phone", word: "Navigate.", label: "Directions", eyebrow: "03 · Navigate",
    np: ["होस्टलको ढोकासम्म,", "बाटो एपले देखाउँछ"],
    vo: [{ file: "05_bishnu", at: 0.5, sub: true }],
    segs: [
      { clip: "c04_directions", from: 17.6, to: 21.0, speed: 1.3 },
      { clip: "c04_directions", from: 23.6, to: 30.5, speed: 1.5 },
      { clip: "c04_directions", from: 32.4, to: 35.6, speed: 1.2 },
    ],
  },
  {
    id: "detail", kind: "phone", word: "Verified.", label: "Verified Hostels", eyebrow: "04 · Trust",
    np: ["असली फोटो, क्लियर भाडा,", "खाली बेड — सबै थाहा"],
    vo: [{ file: "06_sunita", at: 0.5, sub: true }],
    chips: ["Wi-Fi", "CCTV", "Hot Water", "Study Room", "Laundry", "Meals"],
    segs: [
      { clip: "c05_detail", from: 3.0, to: 12.6, speed: 1.8 },
      { clip: "c05_detail", from: 14.6, to: 20.5, speed: 2.0 },
    ],
  },
  {
    id: "compare", kind: "phone", word: "Compare.", label: "Compare", eyebrow: "05 · Decide",
    np: ["दुई होस्टल,", "साइड-बाइ-साइड"],
    vo: [{ file: "07_sunita", at: 0.5, sub: true }],
    segs: [
      { clip: "c06_compare", from: 38.6, to: 41.0, speed: 1.2 },
      { clip: "c06_compare", from: 46.3, to: 53.0, speed: 1.6 },
    ],
  },
  {
    id: "book", kind: "phone", word: "Book.", label: "Book Online", eyebrow: "06 · Book",
    np: ["घरैबाट बेड बुक,", "रसिद तुरुन्तै"],
    vo: [{ file: "08_sunita", at: 0.5, sub: true }],
    receiptAt: 4.9, // scene-local second the receipt flies out ("रसिद तपाईंको फोनमा")
    segs: [
      { clip: "c07_booking", from: 2.6, to: 16.6, speed: 2.0 },
      { clip: "c07_booking", from: 17.3, to: 27.5, speed: 4.0 },
    ],
  },
  {
    id: "refund", kind: "phone", word: "Clear.", label: "Clear Refund Policy", eyebrow: "07 · Peace of mind",
    np: ["बुकिङ फी, रिफन्ड —", "कुनै लुकेको शुल्क छैन"],
    vo: [{ file: "08b_sunita", at: 0.5, sub: true }],
    segs: [{ clip: "c07_booking", from: 28.3, to: 37.0, speed: 1.7 }],
  },
  {
    id: "idcard", kind: "phone", word: "Free ID.", label: "Free Digital ID", eyebrow: "08 · Belong",
    np: ["एपबाटै फ्रीमा बनाउनुहोस्,", "QR स्क्यान — विवरण आफैं पुग्छ"],
    vo: [{ file: "09_sunita", at: 0.5, sub: true }],
    segs: [{ clip: "c09_idcard", from: 2.6, to: 13.4, speed: 1.0 }],
  },
  { id: "end", kind: "end", dur: 12.5,
    vo: [{ file: "10a_sunita", at: 0.8 }, { file: "10b_bishnu", at: 4.6 }, { file: "10c_sunita", at: 8.4 }] },
];
