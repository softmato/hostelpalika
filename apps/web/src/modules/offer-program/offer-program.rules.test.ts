import { describe, expect, it } from "vitest";

import { generateReferenceCode } from "@/modules/finance/reference-code";
import {
  feeOffAmount,
  maskedName,
  newCertificationCode,
  normalizeCertificationCode,
  offerQuarterBounds,
  offerQuarterOf,
  qualifiesForOfferProgram,
  shiftOfferQuarter,
} from "@/modules/offer-program/offer-program.rules";

describe("offer quarters", () => {
  it("cuts the BS year into four", () => {
    // 24 Sep 2026 is Aswin 2083 → Shrawan–Aswin, Q2.
    expect(offerQuarterOf(new Date("2026-09-24T06:00:00.000Z"))).toBe("2083-Q2");
    expect(offerQuarterBounds("2083-Q2").label).toBe("Shrawan – Aswin 2083 BS");
  });

  it("steps across a year boundary", () => {
    expect(shiftOfferQuarter("2083-Q1", -1)).toBe("2082-Q4");
    expect(shiftOfferQuarter("2082-Q4", 1)).toBe("2083-Q1");
  });

  it("covers three whole months with no gap to the next quarter", () => {
    const q2 = offerQuarterBounds("2083-Q2");
    const q3 = offerQuarterBounds("2083-Q3");

    expect(q3.from.getTime() - q2.to.getTime()).toBe(1);
  });
});

describe("qualifiesForOfferProgram", () => {
  const code = generateReferenceCode("RUP", 4821);
  const claim = {
    confirmation: "MANUAL_REVIEW",
    invoiceId: "inv1",
    referenceCode: code,
    source: "RESIDENT_CLAIM",
  };

  it("certifies a warden-approved claim with or without a typed code (D3)", () => {
    expect(qualifiesForOfferProgram({ ...claim, rawPayload: { referenceNote: `rent ${code}` } })).toBe(true);
    expect(qualifiesForOfferProgram({ ...claim, rawPayload: { referenceNote: "rent" } })).toBe(true);
  });

  it("certifies desk cash, gateway and statement matches, never fee-off or adjustments", () => {
    const base = { invoiceId: "inv1", referenceCode: code };

    expect(qualifiesForOfferProgram({ ...base, confirmation: "GATEWAY_VERIFIED", source: "GATEWAY_POLL" })).toBe(true);
    expect(qualifiesForOfferProgram({ ...base, confirmation: "STATEMENT_MATCH", source: "STATEMENT_IMPORT" })).toBe(true);
    expect(qualifiesForOfferProgram({ confirmation: "MANUAL_REVIEW", invoiceId: "inv1", source: "CASH_ENTRY" })).toBe(true);
    expect(qualifiesForOfferProgram({ ...base, confirmation: "MANUAL_REVIEW", source: "OFFER_PROGRAM" })).toBe(false);
    expect(qualifiesForOfferProgram({ ...base, confirmation: "MANUAL_REVIEW", source: "ADJUSTMENT" })).toBe(false);
    expect(qualifiesForOfferProgram({ confirmation: "MANUAL_REVIEW", source: "CASH_ENTRY" })).toBe(false);
  });
});

describe("certification codes", () => {
  it("round-trips through what a person types", () => {
    const issued = newCertificationCode();

    expect(issued).toMatch(/^HP-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normalizeCertificationCode(issued.toLowerCase().replace(/-/g, " "))).toBe(issued);
  });

  it("refuses anything that is not a code", () => {
    expect(normalizeCertificationCode("RCP-RUP-2083-05-00001")).toBeNull();
    expect(normalizeCertificationCode("HP-IIII-OOOO-LLLL")).toBeNull();
  });
});

describe("small rules", () => {
  it("rounds the fee off to whole rupees", () => {
    expect(feeOffAmount(12_345, 50)).toBe(6173);
    expect(feeOffAmount(12_000, 100)).toBe(12_000);
  });

  it("masks a name for a stranger", () => {
    expect(maskedName("Sita Kumari Sharma")).toBe("Sita S.");
    expect(maskedName("Sita")).toBe("Sita");
  });
});
