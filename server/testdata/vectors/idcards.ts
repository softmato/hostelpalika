/**
 * Golden ID cards from the real painter + @napi-rs/canvas. Run from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/idcards.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJiti } from "jiti";

const web = createJiti(__filename, {
  alias: {
    "@/": join(process.cwd(), "apps/web/src") + "/",
    "server-only": join(process.cwd(), "node_modules/server-only/empty.js"),
  },
});

const out = join(process.cwd(), "server/testdata/golden/idcard");
mkdirSync(out, { recursive: true });

const { renderIdCardPng } = await web.import<typeof import("../../../apps/web/src/lib/platform-id-card.server")>("../../../apps/web/src/lib/platform-id-card.server");
const { createCanvas } = await import("@napi-rs/canvas");
const QRCode = (await import("qrcode")).default;

const portrait = createCanvas(300, 400);
const ctx = portrait.getContext("2d");
ctx.fillStyle = "#336699";
ctx.fillRect(0, 0, 300, 400);
ctx.fillStyle = "#ffcc66";
ctx.fillRect(100, 150, 100, 100);
const photo = await portrait.encode("png");
const qr = await QRCode.toBuffer("https://hostelpalika.com/id/HH-4K7M-9XQ2", { margin: 1, width: 316 });
writeFileSync(join(out, "photo.png"), photo);
writeFileSync(join(out, "qr.png"), qr);

const signature = "M40 150L120 60L200 140L300 50L420 150L560 70M100 180L500 180M300 20";
const cases = [
  { CardType: "RESIDENT", Email: "resident@example.com", Face: "front", FullName: "Asha Bahadur Gurung", Name: "resident-front", Photo: false, QR: true, Signature: "" },
  { CardType: "RESIDENT", Email: "resident@example.com", Face: "back", FullName: "Asha Bahadur Gurung", Name: "resident-back", Photo: false, QR: false, Signature: signature },
  { CardType: "HOSTEL_OWNER", Email: "a-very-long-email-address-that-cannot-possibly-fit-on-the-card@example.com", Face: "front", FullName: "A Very Long Name That Runs Right Off The Card Edge", Name: "owner-front", Photo: true, QR: true, Signature: "" },
  { CardType: "HOSTEL_OWNER", Email: "", Face: "back", FullName: "Owner", Name: "owner-back", Photo: false, QR: false, Signature: "" },
  { CardType: "SERVICE_PROVIDER", Email: "", Face: "front", FullName: "Ram", Name: "provider-front", Photo: false, QR: false, Signature: "" },
  { CardType: "SERVICE_PROVIDER", Email: "", Face: "back", FullName: "Ram", Name: "provider-back", Photo: false, QR: false, Signature: "" },
];

for (const c of cases) {
  const png = await renderIdCardPng({
    bloodGroup: "O+", brandName: "HostelPalika", cardType: c.CardType as never, dateOfBirth: "12 Mar 2001", email: c.Email, fullName: c.FullName, issuedOn: "01 Aug 2026",
    phone: "+977-9800000000", residentId: "HH-4K7M-9XQ2", role: "Resident", signature: c.Signature, siteLabel: "hostelpalika.com",
  }, c.Face as never, { photo: c.Photo ? photo : null, qr: c.QR ? qr : null });
  if (!png) throw new Error(`no card for ${c.Name}`);
  writeFileSync(join(out, `${c.Name}.png`), png);
}
writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 2) + "\n");
console.log(`${cases.length} cards`);
