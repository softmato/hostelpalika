/**
 * Vectors for the Go `platform/maps` library's pure parts. Run from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/maps.ts
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

const links = await web.import<typeof import("../../../apps/web/src/lib/maps/map-links")>("../../../apps/web/src/lib/maps/map-links");
const geo = await web.import<typeof import("../../../apps/web/src/lib/maps/geocoding")>("../../../apps/web/src/lib/maps/geocoding");

const urls = [
  "", "  ", "27.7172, 85.3240", "@27.7172,85.3240", "27.7172 85.3240", "27.7172,85.3240", "0,0", "91,10", "-27.5, -85.5", "12345",
  "plain text query", "Baneshwor, Kathmandu",
  "https://www.google.com/maps/place/New+Baneshwor/@27.6935,85.3419,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d27.6930!4d85.3420",
  "https://www.google.com/maps/@27.6935,85.3419,17z", "https://www.google.com/maps/place/Royal+Rapti+Hostel/@27.69,85.34,15z",
  "https://www.google.com/maps/place/Royal%20Rapti%20Hostel", "https://www.google.com/maps/search/hostel+near+me/", "https://www.google.com/maps/dir/Thamel/Baneshwor",
  "https://www.google.com/maps?q=27.7,85.3", "https://www.google.com/maps?q=Thamel+Kathmandu", "https://maps.google.com/?ll=27.7,85.3",
  "https://maps.google.com/?daddr=27.71,85.32", "https://maps.google.com/?center=27.71,85.32&q=Foo", "https://www.openstreetmap.org/?mlat=27.7&mlon=85.3",
  "https://www.openstreetmap.org/#map=17/27.6935/85.3419", "https://www.openstreetmap.org/#map=17.5/27.6935/85.3419", "https://osm.org/go/abc", "https://goo.gl/maps/abc123",
  "https://maps.app.goo.gl/xyz", "https://share.google/g7znZy6lJWDsMM2rq", "http://bit.ly/3abc", "https://g.co/kgs/abc", "https://a.goo.gl/x?y=1#z",
  "https://goo.gl", "www.google.com/maps/@27.7,85.3,15z", "maps.google.com/?q=27.7,85.3", "https://example.com/", "https://example.com/place/%3Cb%3E",
  "https://www.google.com/maps/place/123,456/@27.7,85.3,15z", "https://www.google.com/maps/place/data=!4m2/@27.7,85.3,15z",
  "https://www.google.com/maps/place/Kathmandu+Durbar+Square", "https://www.google.com/maps?query=Bhaktapur", "https://www.google.com/maps?q=12,34",
  "https://www.google.com/maps?q=%20%20", "https://www.google.com/maps/@0,0,10z", "https://www.google.com/maps/@91.5,85,10z",
  "https://apple.com/maps?ll=27.7,85.3&q=Home", "http://", "https://", "ftp://x/y", "HTTPS://WWW.GOOGLE.COM/maps/@27.7,85.3,15z",
  "https://www.google.com/maps/place/%C3%9Cber+Caf%C3%A9/@27.7,85.3,15z",
];

const places = ["Kathmandu Metropolitan City", "Bagamati Province", "Lalitpur Sub-Metropolitan City", "Bhaktapur Municipality", "Province", " Kathmandu District ", "Pokhara", "", undefined,
  "Gokarneshwor Municipality", "Chandragiri Rural Municipality", "Metropolitan City", "X  Province", "Kaski district"];
const queries = ["Narephat, Narephat, Kathmandu, Nepal", "A, B, C", "  a ,A, b ", "single", "", ",,", "Royal Rapti Boys Hostel, New Baneshwor, Kathmandu"];
const parts = [
  { address: "Ring Road", area: "Baneshwor", city: "Kathmandu", province: "Bagmati", country: "Nepal" },
  { area: " Baneshwor ", city: "Kathmandu" }, {}, { country: "" }, { country: "India", city: "Delhi" }, { address: "  ", city: "X" },
];

writeFileSync(
  join(process.cwd(), "server/testdata/vectors/maps.json"),
  `${JSON.stringify(
    {
      links: urls.map((url) => ({ url, out: links.parseMapLink(url) })),
      tidy: places.map((value) => ({ value: value ?? null, out: geo.tidyPlaceName(value) ?? null })),
      variants: queries.map((query) => ({ query, out: geo.queryVariants(query) })),
      address: parts.map((p) => ({ parts: p, out: geo.buildAddressQuery(p) })),
    },
    undefined,
    1,
  )}\n`,
);
console.log("maps.json written");
