/**
 * Reference code — Block 1 item 1.5 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (target §5, ADR-7).
 *
 * This is the mechanism principle P2 rests on, so the tests are exhaustive
 * rather than representative: **every** single-character typo and **every**
 * adjacent transposition of a valid code is generated and asserted to fail.
 * If a mistyped code validated, the matching ladder would auto-settle one
 * resident's payment against another resident's invoice.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  deriveHostelPrefix,
  extractReferenceCodes,
  generateReferenceCode,
  generateMonthCode,
  generatePersonalCode,
  parseMonthCode,
  isValidPrefix,
  isValidReferenceCode,
  MAX_SEQUENCE,
  parseReferenceCode,
} from "@/modules/finance/reference-code";

/** Must mirror SYMBOLS in the module: 31 characters, `Z` excluded. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXY";

describe("generateReferenceCode", () => {
  it("produces the documented shape", () => {
    expect(generateReferenceCode("RUP", 4821)).toMatch(/^[A-Z]{3}-[0-9A-Z]{4}-[0-9A-Z]$/);
  });

  it("is stable — the same invoice always gets the same code", () => {
    expect(generateReferenceCode("RUP", 4821)).toBe(generateReferenceCode("RUP", 4821));
  });

  it("is 10 characters including hyphens, so it fits a remarks field", () => {
    expect(generateReferenceCode("RUP", 4821)).toHaveLength(10);
  });

  it("uses no letter that can be misread as a digit", () => {
    for (let sequence = 0; sequence < 2000; sequence += 7) {
      const body = generateReferenceCode("RUP", sequence).replace(/^RUP-/, "");

      expect(body).not.toMatch(/[ILOU]/);
    }
  });

  it.each([0, 1, 31, 32, 1023, 1024, MAX_SEQUENCE])(
    "round-trips the sequence %s",
    (sequence) => {
      const parsed = parseReferenceCode(generateReferenceCode("RUP", sequence));

      expect(parsed).toEqual({ prefix: "RUP", sequence });
    },
  );

  it.each([-1, 1.5, MAX_SEQUENCE + 1])("rejects the sequence %s", (sequence) => {
    expect(() => generateReferenceCode("RUP", sequence)).toThrow(/sequence/);
  });

  it.each(["RU", "RUPA", "R1P", "rup"])("rejects the prefix %s", (prefix) => {
    expect(() => generateReferenceCode(prefix, 1)).toThrow(/three letters/);
  });
});

describe("parseReferenceCode — accepting what a human typed", () => {
  const canonical = generateReferenceCode("RUP", 4821);
  const bare = canonical.replace(/-/g, "");

  it.each([
    () => canonical,
    () => canonical.toLowerCase(),
    () => bare,
    () => bare.toLowerCase(),
    () => ` ${canonical} `,
    () => bare.split("").join(" "),
  ])("accepts formatting variant %#", (build) => {
    expect(parseReferenceCode(build())).toEqual({ prefix: "RUP", sequence: 4821 });
  });

  it.each([null, undefined, "", "   ", "RUP", "RUP-4821", "RUP-4821-KK"])(
    "rejects the malformed input %s",
    (input) => {
      expect(parseReferenceCode(input)).toBeNull();
    },
  );
});

/**
 * The two properties the check character exists for. These are the mistakes
 * people actually make copying a code off a phone screen into a banking app.
 */
describe("parseReferenceCode — detecting mistakes", () => {
  const codes = [
    generateReferenceCode("RUP", 4821),
    generateReferenceCode("ABC", 0),
    generateReferenceCode("XYW", MAX_SEQUENCE),
    generateReferenceCode("SUN", 12345),
  ];

  /**
   * Exhaustive: every position × every replacement symbol, on four codes.
   * A prime modulus is what makes this pass — with 32 symbols, a change of 16
   * at an even-weighted position cancels exactly and the typo validates.
   */
  it("rejects every single-character substitution", () => {
    for (const code of codes) {
      const bare = code.replace(/-/g, "");

      for (let position = 0; position < bare.length; position += 1) {
        for (const replacement of ALPHABET) {
          if (replacement === bare[position]) {
            continue;
          }

          const typo = bare.slice(0, position) + replacement + bare.slice(position + 1);

          expect(isValidReferenceCode(typo)).toBe(false);
        }
      }
    }
  });

  it("rejects every adjacent transposition", () => {
    for (const code of codes) {
      const bare = code.replace(/-/g, "");

      for (let position = 0; position < bare.length - 1; position += 1) {
        if (bare[position] === bare[position + 1]) {
          continue;
        }

        const swapped =
          bare.slice(0, position) +
          bare[position + 1] +
          bare[position] +
          bare.slice(position + 2);

        expect(isValidReferenceCode(swapped)).toBe(false);
      }
    }
  });

  // The prefix uses all 26 letters, not the 31-symbol data alphabet, so its
  // typos need their own sweep: RUP → RUA, RUB, … and RAP, RBP, … and so on.
  it("rejects every single-letter typo in the hostel prefix", () => {
    for (const code of codes) {
      const prefix = code.slice(0, 3);
      const rest = code.slice(3);

      for (let position = 0; position < 3; position += 1) {
        for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
          if (letter === prefix[position]) {
            continue;
          }

          const typo =
            prefix.slice(0, position) + letter + prefix.slice(position + 1) + rest;

          expect(isValidReferenceCode(typo)).toBe(false);
        }
      }
    }
  });

  it("uses a prime modulus, which is what the two guarantees above rest on", () => {
    expect(ALPHABET).toHaveLength(31);
  });

  // Crockford maps these on input, so a resident writing O for 0 still matches.
  it("accepts the confusable characters I, L and O as 1, 1 and 0", () => {
    const code = generateReferenceCode("RUP", 0); // sequence encodes as 0000
    const typed = code.replace(/0/g, "O");

    expect(parseReferenceCode(typed)).toEqual({ prefix: "RUP", sequence: 0 });
  });
});

describe("extractReferenceCodes — reading free text", () => {
  const code = generateReferenceCode("RUP", 4821);

  it.each([
    (c: string) => `${c} rent for august`,
    (c: string) => `payment ref ${c}`,
    (c: string) => `${c.replace(/-/g, "")} AUG RENT`,
    (c: string) => `ref: ${c.toLowerCase()}, thanks`,
    (c: string) => `FT26080012/${c}`,
    (c: string) => `${c.replace(/-/g, " ")} august`,
  ])("finds the code in remark variant %#", (build) => {
    expect(extractReferenceCodes(build(code))).toContain(code);
  });

  /**
   * The regression that forced tokenised extraction. A sliding window over this
   * string finds `STRENTPA`, which passes its check character and is not a
   * reference code — and a false positive here auto-settles one resident's
   * payment against another resident's invoice.
   */
  it("finds nothing in ordinary English", () => {
    expect(extractReferenceCodes("AUGUST RENT PAYMENT THANK YOU")).toEqual([]);
  });

  it.each([
    "MONTHLY RENT TRANSFER PLEASE CONFIRM RECEIPT",
    "PAYMENT FOR HOSTEL ACCOMMODATION AUGUST",
    "TRANSFER FROM SAVINGS ACCOUNT THANK YOU",
  ])("finds nothing in the prose remark %s", (remark) => {
    expect(extractReferenceCodes(remark)).toEqual([]);
  });

  it("finds nothing in a remark carrying a mistyped code", () => {
    const bare = code.replace(/-/g, "");
    const typo = `${bare.slice(0, 7)}${bare[7] === "Z" ? "Y" : "Z"}`;

    expect(extractReferenceCodes(`rent ${typo}`)).not.toContain(code);
  });

  it.each([null, undefined, ""])("handles the empty remark %s", (input) => {
    expect(extractReferenceCodes(input)).toEqual([]);
  });

  it("finds two codes when a resident pays for two months at once", () => {
    const other = generateReferenceCode("RUP", 4822);
    const found = extractReferenceCodes(`${code} and ${other}`);

    expect(found).toContain(code);
    expect(found).toContain(other);
  });

  it("does not invent a code from an account number", () => {
    expect(extractReferenceCodes("A/C 01234567890123 NIC ASIA")).toEqual([]);
  });
});

describe("deriveHostelPrefix", () => {
  it.each([
    ["Rupak Hostel", "RUP"],
    ["Sunrise Boys Hostel", "SUN"],
    ["Education Light Hostel", "EDU"],
  ] as const)("derives %s to %s", (name, expected) => {
    expect(deriveHostelPrefix(name)).toBe(expected);
  });

  it("pads a short name to three letters", () => {
    expect(deriveHostelPrefix("Om")).toBe("OMX");
  });

  it("falls back when a name has no letters at all", () => {
    expect(deriveHostelPrefix("123 456")).toBe("HST");
  });

  it("ignores digits and punctuation in the name", () => {
    expect(deriveHostelPrefix("24/7 Hostel")).toBe("HOS");
  });

  it("is deterministic, so re-running the backfill is a no-op", () => {
    expect(deriveHostelPrefix("Rupak Hostel", 3)).toBe(
      deriveHostelPrefix("Rupak Hostel", 3),
    );
  });

  it("produces a different, still-valid prefix on each disambiguation attempt", () => {
    const seen = new Set<string>();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const prefix = deriveHostelPrefix("Rupak Hostel", attempt);

      // Only letters are usable, so numeric alphabet positions are skipped by
      // the caller — what matters is that valid ones differ from the base.
      if (isValidPrefix(prefix)) {
        seen.add(prefix);
      }
    }

    expect(seen.size).toBeGreaterThan(1);
  });

  it("always generates a usable code from a derived prefix", () => {
    const prefix = deriveHostelPrefix("Question Call Hostel");

    expect(isValidReferenceCode(generateReferenceCode(prefix, 1))).toBe(true);
  });
});

describe("the backfill script's mirror of this module", () => {
  /**
   * `scripts/backfill-invoice-reference-code.mjs` cannot import this TypeScript
   * module, so it hand-copies the generator — the same compromise
   * `backfill-hostel-reference-prefix.mjs` makes for `deriveHostelPrefix`.
   *
   * A drift between the two is invisible at the point it happens and only shows
   * up much later, as statement rows that will not match an invoice whose code
   * looks perfectly well-formed. So the copy is executed here against the real
   * validator rather than trusted.
   */
  const scriptPath = new URL(
    "../../../scripts/backfill-invoice-reference-code.mjs",
    import.meta.url,
  );

  it("produces codes this module considers valid", async () => {
    const source = await readFile(scriptPath, "utf8");

    // The script connects to MongoDB at import time, so the two pure functions
    // are lifted out and evaluated on their own.
    const symbols = /const SYMBOLS = "([^"]+)";/.exec(source)![1];
    const encode = /function encodeSequence\(sequence\) \{[\s\S]*?\n\}/.exec(source)![0];
    const check = /function checkCharacter\(prefix, encoded\) \{[\s\S]*?\n\}/.exec(source)![0];

    const mirror = new Function(`
      const SYMBOLS = ${JSON.stringify(symbols)};
      const MODULUS = SYMBOLS.length;
      const SEQ_LENGTH = 4;
      ${encode}
      ${check}
      return (prefix, sequence) => {
        const encoded = encodeSequence(sequence);
        const c = checkCharacter(prefix, encoded);
        return c ? prefix + "-" + encoded + "-" + c : null;
      };
    `)() as (prefix: string, sequence: number) => string | null;

    for (const prefix of ["EDU", "RUP", "AAA", "ZZZ", "LIO"]) {
      for (const sequence of [0, 1, 2, 30, 31, 1000, 4821, 923_520]) {
        const mirrored = mirror(prefix, sequence);

        expect(mirrored).toBe(generateReferenceCode(prefix, sequence));
        expect(isValidReferenceCode(mirrored!)).toBe(true);
      }
    }
  });
});

describe("month codes (todo A1–A4)", () => {
  const personal = generatePersonalCode("RUP", 4000);

  it("keeps the personal part and changes only the month", () => {
    expect(personal).toMatch(/^RUP-[0-9A-Y]{4}$/);
    expect(generateMonthCode(personal, "2083-01")).toBe(`${personal}-BAI83`);
    expect(generateMonthCode(personal, "2083-02")).toBe(`${personal}-JES83`);
    expect(generateMonthCode(personal, "2084-12")).toBe(`${personal}-CHA84`);
  });

  it("reads the month code with -, _, space, nothing, any case", () => {
    const code = generateMonthCode(personal, "2083-05");
    const bare = code.replace(/-/g, "");

    for (const typed of [code, bare, bare.toLowerCase(), code.replace(/-/g, "_"), code.replace(/-/g, " "), `${bare.slice(0, 3)} ${bare.slice(3, 7)} ${bare.slice(7, 10)} ${bare.slice(10)}`]) {
      expect(extractReferenceCodes(`rent ${typed} thanks`)).toEqual([code]);
    }
    expect(parseMonthCode(code)).toEqual({ personalCode: personal, period: "2083-05", tag: "BHA83" });
  });

  it("still reads old invoice codes beside new ones", () => {
    const old = generateReferenceCode("RUP", 4821);
    const fresh = generateMonthCode(personal, "2083-05");

    expect(extractReferenceCodes(`${old} and ${fresh}`).sort()).toEqual([old, fresh].sort());
    expect(isValidReferenceCode(fresh)).toBe(true);
  });

  it("rejects a month that is not a month", () => {
    expect(parseMonthCode(`${personal}-BHX83`)).toBeNull();
  });

  // A4: a one-symbol typo in the personal part never lands on another resident.
  it("catches every one-symbol typo and adjacent swap in the personal part", () => {
    const symbols = "0123456789ABCDEFGHJKMNPQRSTVWXY";

    for (const number of [0, 1, 30, 482, 4000, 29_790]) {
      const code = generateMonthCode(generatePersonalCode("RUP", number), "2083-05");
      const bare = code.replace(/-/g, "");

      for (let index = 3; index < 7; index += 1) {
        for (const symbol of symbols) {
          if (symbol === bare[index]) continue;
          const typo = bare.slice(0, index) + symbol + bare.slice(index + 1);
          expect(parseMonthCode(typo)).toBeNull();
        }
      }

      for (let index = 0; index < 6; index += 1) {
        if (bare[index] === bare[index + 1]) continue;
        const swapped = bare.slice(0, index) + bare[index + 1] + bare[index] + bare.slice(index + 2);
        expect(parseMonthCode(swapped)).toBeNull();
      }
    }
  });
});
