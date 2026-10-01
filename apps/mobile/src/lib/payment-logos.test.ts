import { describe, expect, it } from "vitest";

import {
  BANK_NAMES,
  normalisePaymentName,
  PAYMENT_LOGO_KEYS,
  resolvePaymentLogoKey,
} from "@/lib/payment-logos";

/**
 * The screen this feeds tells somebody where to send money. A wrong bank logo
 * there is worse than no logo, so the collisions get their own cases.
 */
describe("normalisePaymentName", () => {
  it("drops the noise every owner types differently", () => {
    expect(normalisePaymentName("Everest Bank Limited")).toEqual(["everest", "bank"]);
    expect(normalisePaymentName("Everest Bank Ltd.")).toEqual(["everest", "bank"]);
    expect(normalisePaymentName("  everest   bank  ")).toEqual(["everest", "bank"]);
  });

  it("keeps `bank` and `nepal`, which carry identity here", () => {
    // "Bank of Kathmandu" is the phrase; "Nepal Bank", "Nepal SBI" and
    // "Nepal Rastra" are three institutions told apart by what follows.
    expect(normalisePaymentName("Bank of Kathmandu")).toEqual(["bank", "of", "kathmandu"]);
    expect(normalisePaymentName("Nepal Bank Ltd")).toEqual(["nepal", "bank"]);
  });

  it("flattens punctuation and non-Latin script", () => {
    expect(normalisePaymentName("Shangri-La")).toEqual(["shangri", "la"]);
    expect(normalisePaymentName("Siddhartha Women's")).toEqual(["siddhartha", "womens"]);
    expect(normalisePaymentName("Rastra Bank (नेपाल राष्ट्र बैंक)")).toEqual([
      "rastra",
      "bank",
    ]);
  });
});

describe("resolvePaymentLogoKey", () => {
  it("resolves the wallet enums the server sends", () => {
    expect(resolvePaymentLogoKey("ESEWA")).toBe("esewa");
    expect(resolvePaymentLogoKey("KHALTI")).toBe("khalti");
    expect(resolvePaymentLogoKey("FONEPAY")).toBe("fonepay");
  });

  it("resolves the same bank however the owner spelled it", () => {
    for (const spelling of [
      "Everest Bank",
      "Everest Bank Ltd.",
      "EVEREST BANK LIMITED",
      "everest bank ltd",
      "EBL",
    ]) {
      expect(resolvePaymentLogoKey(spelling)).toBe("everest");
    }
  });

  /*
   * The four prefix collisions. Each of these is a real institution that the
   * naive `String.includes` version showed a competitor's mark for.
   */
  it("prefers the longer name where one bank's name contains another's", () => {
    expect(resolvePaymentLogoKey("Prabhu Bank Ltd.")).toBe("prabhu");
    expect(resolvePaymentLogoKey("Prabhu Mahalaxmi Bank Ltd.")).toBe("prabhu-mahalaxmi");

    expect(resolvePaymentLogoKey("Siddhartha Bank Ltd.")).toBe("siddhartha");
    expect(resolvePaymentLogoKey("Siddhartha Women's Bikas Bank Ltd.")).toBe("swbbl");

    expect(resolvePaymentLogoKey("Nabil Bank Ltd.")).toBe("nabil");
    expect(resolvePaymentLogoKey("Nabil Bank (Formerly NCB) Ltd.")).toBe("nabil-ncb");

    expect(resolvePaymentLogoKey("Suryodaya Womi Laghubitta Bittiya Sanstha Ltd.")).toBe(
      "suryodaya-womi",
    );
    expect(resolvePaymentLogoKey("Womi Microfinance Laghubitta Bittiya Sanstha Ltd.")).toBe(
      "womi",
    );
  });

  it("keeps the three Nepal-prefixed banks apart", () => {
    expect(resolvePaymentLogoKey("Nepal Bank Ltd.")).toBe("nepal-bank");
    expect(resolvePaymentLogoKey("Nepal SBI Bank Ltd.")).toBe("nepal-sbi");
    expect(resolvePaymentLogoKey("Nepal Rastra Bank")).toBe("nepal-rastra");
    expect(resolvePaymentLogoKey("Nepal Investment Mega Bank Ltd.")).toBe(
      "nepal-investment-mega",
    );
  });

  /*
   * The reason matching is word-wise. As a substring, `nic` is inside
   * "technical", `sbi` inside "sbico", `ebl` inside "pebble". A resolver that
   * used `includes` would put NIC Asia's mark on any of them.
   */
  it("matches whole words, so a short code cannot fire inside a longer one", () => {
    expect(resolvePaymentLogoKey("Technical Finance")).toBeNull();
    expect(resolvePaymentLogoKey("Pebble Savings")).toBeNull();
    expect(resolvePaymentLogoKey("NIC Asia Bank Ltd.")).toBe("nic-asia");
  });

  it("returns null for a category rather than an institution", () => {
    // The caller draws a glyph for these — they are not anybody's brand.
    expect(resolvePaymentLogoKey("BANK_TRANSFER")).toBeNull();
    expect(resolvePaymentLogoKey("CASH")).toBeNull();
    expect(resolvePaymentLogoKey("OTHER")).toBeNull();
  });

  it("returns null rather than guessing at a bank it has no mark for", () => {
    expect(resolvePaymentLogoKey("Some Cooperative Ltd.")).toBeNull();
    expect(resolvePaymentLogoKey("")).toBeNull();
    expect(resolvePaymentLogoKey(null)).toBeNull();
    expect(resolvePaymentLogoKey(undefined)).toBeNull();
  });

  it("every key is reachable from at least one name", () => {
    // A key with no pattern is an asset that ships and never renders.
    const reached = new Set(
      PAYMENT_LOGO_KEYS.map((key) => resolvePaymentLogoKey(key.replace(/-/g, " "))),
    );

    // `swbbl` and `nabil-ncb` are slugs that are not their own name, so they are
    // checked by the collision case above instead.
    const bySlug = PAYMENT_LOGO_KEYS.filter(
      (key) => key !== "swbbl" && key !== "nabil-ncb" && key !== "womi",
    );

    for (const key of bySlug) {
      expect(reached.has(key)).toBe(true);
    }
  });
});

describe("BANK_NAMES", () => {
  it("draws a logo for every bank the picker offers, bar the one we hold no mark for", () => {
    const unmarked = BANK_NAMES.filter((name) => resolvePaymentLogoKey(name) === null);

    expect(unmarked).toEqual(["Rastriya Banijya Bank"]);
  });
});
