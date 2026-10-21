import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { renderAgreementDocument } from "@/modules/hostels/hostel-agreement-document";
import { agreementTerms, type AgreementParties } from "@/modules/hostels/hostel-agreement-terms";

const parties: AgreementParties = {
  company: {
    address: "Mid-Baneshwor, Kathmandu",
    email: "work@softmato.com",
    legalName: "Softmato Technology Private Limited",
    pan: "623692242",
    phone: "9819748466",
    supportPhone: "+977 981-9748466",
  },
  hostel: { address: "Baneshwor, Kathmandu", name: "Everest Boys Hostel" },
  // A Devanagari name must degrade, not throw: the standard font cannot draw it.
  owner: { email: "owner@example.com", name: "राम Sharma", phone: "9811111111" },
};

const issuer = {
  address: parties.company.address,
  email: parties.company.email,
  legalName: parties.company.legalName,
  pan: parties.company.pan,
  phone: parties.company.phone,
  productName: "HostelPalika",
  vatRegistered: false,
};
// The real seals are private (never in git): point this at a local copy to see them printed.
const sealsDir = process.env.AGREEMENT_SEALS_DIR;
const seals = sealsDir
  ? {
      signatures: [
        { image: readFileSync(path.join(sealsDir, "signature-jiwan.png")), name: "Jiwan Mijhar", title: "Founder" },
        { image: readFileSync(path.join(sealsDir, "signature-siddhant.png")), name: "Siddhant Yadav", title: "Founder" },
      ],
      stamp: readFileSync(path.join(sealsDir, "stamp.png")),
    }
  : null;
const signed = {
  approvedByName: "Jiwan Mijhar",
  ip: "103.10.10.10",
  issuedAt: new Date("2026-10-21T06:00:00Z"),
  issuer,
  parties,
  refCode: "SMT/HP/2026/012",
  seals,
  signature: "M40 150L120 60L200 140L280 50L360 150L440 70L520 130M60 180L540 180",
  signedAt: new Date("2026-10-20T09:30:00Z"),
  signerName: "राम Sharma",
  terms: agreementTerms(parties),
  textHash: "a".repeat(64),
  userAgent: "Mozilla/5.0 (Linux; Android 14; Redmi Note 13)",
};

describe("renderAgreementDocument", () => {
  it("marks an agreement that is not issued yet as a preview", async () => {
    const pdf = await PDFDocument.load(await renderAgreementDocument({ ...signed, issuedAt: null, refCode: null }));

    expect(pdf.getTitle()).toContain("PREVIEW");
  });

  it("prints every term across pages with the signature", async () => {
    const bytes = await renderAgreementDocument(signed);
    const pdf = await PDFDocument.load(bytes);

    if (process.env.AGREEMENT_PDF_OUT) writeFileSync(process.env.AGREEMENT_PDF_OUT, bytes);

    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toContain("SMT/HP/2026/012");
  });
});
