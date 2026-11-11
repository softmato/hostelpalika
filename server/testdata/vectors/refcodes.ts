/**
 * Reference / month code vectors (todo A6): Go makes and reads exactly what
 * reference-code.ts does. Written by generate.ts; standalone from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/refcodes.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import * as ref from "../../../apps/web/src/modules/finance/reference-code";

export function refcodeVectors() {
  const personal: { prefix: string; number: number; code: string }[] = [];
  const month: { personal: string; period: string; code: string }[] = [];

  for (const prefix of ["RUP", "EDU", "LIO", "ZZZ"]) {
    for (const number of [0, 1, 30, 31, 482, 4000, 29_790]) {
      const code = ref.generatePersonalCode(prefix, number);
      personal.push({ code, number, prefix });
      for (const period of ["2083-01", "2083-05", "2084-12", "2090-07"]) {
        month.push({ code: ref.generateMonthCode(code, period), period, personal: code });
      }
    }
  }

  const sample = ref.generateMonthCode(ref.generatePersonalCode("RUP", 482), "2083-05");
  const bare = sample.replace(/-/g, "");
  const old = ref.generateReferenceCode("RUP", 4821);
  const texts = [
    sample,
    bare,
    bare.toLowerCase(),
    sample.replace(/-/g, "_"),
    sample.replace(/-/g, " "),
    `${bare.slice(0, 3)} ${bare.slice(3, 7)} ${bare.slice(7, 10)} ${bare.slice(10)}`,
    `rent ${old} and ${sample} thanks`,
    `${bare.slice(0, 7)}BHX83`,
    `${bare.slice(0, 4)}${bare[5]}${bare[4]}${bare.slice(6)}`,
    "AUGUST RENT PAYMENT THANK YOU",
    `${bare.slice(0, 10)}O3`,
  ];

  return {
    extract: texts.map((text) => ({ codes: ref.extractReferenceCodes(text), text })),
    month,
    personal,
  };
}

if (process.argv[1]?.endsWith("refcodes.ts")) {
  writeFileSync(
    join(process.cwd(), "server/testdata/vectors/refcodes.json"),
    `${JSON.stringify(refcodeVectors(), null, 1)}\n`,
  );
}
