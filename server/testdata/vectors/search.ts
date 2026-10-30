/**
 * Vectors for the Go `platform/search` and `platform/llm` libraries, from the
 * TypeScript that is the spec. Run from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/search.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJiti } from "jiti";

const web = createJiti(__filename, {
  alias: {
    "@/": join(process.cwd(), "apps/web/src") + "/",
    "server-only": join(process.cwd(), "node_modules/server-only/empty.js"),
  },
});

const queries = [
  "", "   ", "girls hostel", "boys hostel in Baneshwor", "co-living space", "mixed hostel", "hostel in Baneshwor",
  "rooms in New Baneshwor", "hostels in Pokhara", "hostel near Ghattekulo", "under 8k", "under 8 thousand", "below 12,000",
  "under 9", "above 10k", "between 6k and 9k", "7000-11000 rent", "cheap hostel", "sasto hostel", "veg food hostel",
  "non veg meals", "non-veg meals", "hostel with wifi", "attached bathroom single room", "2 sharing in Koteshwor",
  "triple sharing", "dorm in Thamel", "Pulchowk campus hostel", "near Xavier", "Tribhuvan University", "hostel near Kathmandu University",
  "girls hostel near Pulchowk under 10k with wifi veg", "a quiet place to study near my college please", "best hostel",
  "find me a nice hostel", "hostel", "the", "Royal Rapti Boys Hostel", "boys hostel near Royal Rapti with parking and laundry",
  "hot water and gym", "ac room", "cctv power backup", "inverter generator", "reading room", "study table bike parking",
  "between 5 and 8", "up to 7k", "at least 5 thousand", "minimum 4k", "within 15000", "5-8k", "5k to 9k", "affordable boys hostel in Kalanki",
  "ladies hostel lalitpur", "gents hostel bhaktapur", "female only", "male", "non veg boys hostel in Gwarko under 9k",
  "hajar", "under 5 hajar", "under 99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
  "hostel near बानेश्वर", "सस्तो hostel", "Baneshwor   boys   under   8k", "NEW BANESHWOR GIRLS", "wi-fi", "wifi internet", "x".repeat(400),
  "hostel in the heart of Thamel with a lot of other words that do not match anything at all", "double room",
  "single 1 sharing", "one sharing", "four sharing", "3sharing", "vegetarian", "Vegetarian non-veg", "non veg", "boys girls",
  "Kupondole 6k-9k", "dillibazar", "Islington college", "Trinity", "KCM Gwarko", "Purwanchal", "amrit science", "kamalpokhari",
  "St. Xavier's College", "model college bagbazar",
];

const parser = await web.import<typeof import("../../../apps/web/src/lib/search/query-parser")>(
  "../../../apps/web/src/lib/search/query-parser",
);
const quota = await web.import<typeof import("../../../apps/web/src/lib/search/search-quota")>(
  "../../../apps/web/src/lib/search/search-quota",
);
const json = await web.import<typeof import("../../../apps/web/src/lib/llm/json")>("../../../apps/web/src/lib/llm/json");

process.env.SEARCH_QUOTA_SECRET = "vector-quota-secret";
const now = 1_790_000_000_000;
const states = [
  { used: 0, windowEndsAt: now + 18_000_000 },
  { used: 9, windowEndsAt: now + 1 },
  { used: 10, windowEndsAt: now + 3_600_000 },
  { used: 12, windowEndsAt: now + 3_600_000 },
  { used: 3, windowEndsAt: now - 5 },
];
const raws = [undefined, "", "junk", "1.2", "1.2.3", "a.b.c", "0.1790000000000.AAAA"];
const quotaOut = {
  states: states.map((s) => ({
    state: s,
    encoded: quota.encodeQuota(s),
    window: quota.currentWindow(quota.encodeQuota(s), now),
    remaining: quota.quotaRemaining(s),
    maxAge: quota.quotaMaxAge(s, now),
  })),
  raws: raws.map((r) => ({ raw: r ?? null, window: quota.currentWindow(r, now) })),
  tampered: (() => {
    const good = quota.encodeQuota({ used: 5, windowEndsAt: now + 1000 });
    const [, end, sig] = good.split(".");
    return { cookie: `0.${end}.${sig}`, window: quota.currentWindow(`0.${end}.${sig}`, now) };
  })(),
};

const modelTexts = [
  "", "   ", '{"area":"Thamel"}', '```json\n{"type":"BOYS","maxPrice":8000}\n```', 'Sure! Here you go: {"q":"Royal"} Hope it helps',
  '[1,2,3]', 'prefix [{"a":1}] suffix', '{"a": "line\nbreak"}', '{“area”: “Thamel”}', '{"a":"tab\there"}', "{bad json", "null", "42",
  '{"a":"bad \\q escape"}', '{"area":"Thamel"} {"area":"Balaju"}', '```\n{"food":"veg"}\n```', '{"a":"x\u0001y"}',
];
const modelOut = modelTexts.map((raw) => ({
  raw,
  extracted: json.extractJsonPayload(raw),
  sanitized: json.sanitizeJsonPayload(json.extractJsonPayload(raw)),
  parsed: (() => {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      return json.parseModelJson(raw, "vector") ?? null;
    } finally {
      console.error = originalError;
    }
  })(),
}));

writeFileSync(
  join(process.cwd(), "server/testdata/vectors/search.json"),
  `${JSON.stringify(
    {
      now,
      quotaSecret: "vector-quota-secret",
      parse: queries.map((query) => ({ query, out: parser.parseSearchQuery(query) })),
      quota: quotaOut,
      model: modelOut,
    },
    undefined,
    1,
  )}\n`,
);
console.log("search.json written");
