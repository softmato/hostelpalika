/**
 * Site config + operations config: the zod descriptors and shipped defaults the
 * Go `platformconfig` module embeds, and safeParse vectors over mutated stored
 * values. Called from generate.ts; `HP_ONLY=config` runs just this part.
 */

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

import { describe, nameSuperRefine } from "./zod-describe";

type Web = { import<T>(id: string): Promise<T> };

/** One-step mutations of a valid value: what an old build or a hand edit leaves behind. */
function mutations(value: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (node: unknown, set: (v: unknown) => unknown) => {
    if (typeof node === "string") {
      out.push(set(`  ${node}  `), set(node + "x".repeat(1300)), set(42));
    } else if (typeof node === "number") {
      out.push(set(String(node)), set(node + 0.5), set(-1), set(null));
    } else if (typeof node === "boolean") {
      out.push(set("true"));
    } else if (Array.isArray(node)) {
      out.push(set([]), set({}));
      node.slice(0, 2).forEach((child, i) =>
        visit(child, (v) => set(node.map((c, j) => (j === i ? v : c)))),
      );
    } else if (node && typeof node === "object") {
      const entries = Object.entries(node);
      out.push(set({ ...node, zzUnknown: 1 }), set(null));
      entries.slice(0, 8).forEach(([key, child]) => {
        const { [key]: _gone, ...rest } = node as Record<string, unknown>;
        out.push(set(rest));
        visit(child, (v) => set({ ...node, [key]: v }));
      });
    }
  };
  visit(value, (v) => v);
  // At most 40, spread across the whole value: enough to reach every kind of
  // node without the plans section's hundreds of strings bloating the file.
  const step = Math.max(1, Math.ceil(out.length / 40));
  return out.filter((_, i) => i % step === 0);
}

export async function configVectors(web: Web, here: string) {
  const validation = await web.import<typeof import("../../../apps/web/src/modules/platform-config/site-config.validation")>(
    "../../../apps/web/src/modules/platform-config/site-config.validation",
  );
  const { DEFAULT_SITE_CONFIG } = await web.import<typeof import("../../../apps/web/src/modules/platform-config/site-config.defaults")>(
    "../../../apps/web/src/modules/platform-config/site-config.defaults",
  );
  const ops = await web.import<typeof import("../../../apps/web/src/modules/platform-config/operations-config")>(
    "../../../apps/web/src/modules/platform-config/operations-config",
  );

  const bookings = await web.import<typeof import("../../../apps/web/src/modules/bookings/booking-config")>(
    "../../../apps/web/src/modules/bookings/booking-config",
  );
  // Every platformsettings row Go re-parses: the site sections, operations, bookings.
  const schemas = {
    ...validation.siteConfigSectionSchemas,
    operations: ops.operationsConfigSchema,
    bookings: bookings.bookingConfigSchema,
  };
  writeFileSync(
    join(here, "internal/modules/platformconfig/schemas.json"),
    `${JSON.stringify({
      sections: Object.fromEntries(
        Object.entries(schemas).map(([k, s]) => [k, k === "bookings" ? nameSuperRefine(describe(s), "bookingRules") : describe(s)]),
      ),
      defaults: { ...DEFAULT_SITE_CONFIG, operations: ops.DEFAULT_OPERATIONS_CONFIG, bookings: bookings.DEFAULT_BOOKING_CONFIG },
    })}\n`,
  );

  const defaults: Record<string, unknown> = {
    ...DEFAULT_SITE_CONFIG,
    operations: ops.DEFAULT_OPERATIONS_CONFIG,
    bookings: bookings.DEFAULT_BOOKING_CONFIG,
  };
  const cases = Object.entries(schemas).flatMap(([section, schema]) =>
    [defaults[section], undefined, "nope", ...mutations(defaults[section])].map((input) => {
      const parsed = schema.safeParse(input);
      return { section, input, ok: parsed.success, data: parsed.success ? parsed.data : null };
    }),
  );
  // Gzipped: every case carries a whole section, and the plans one is large.
  writeFileSync(join(here, "testdata/vectors/siteconfig.json.gz"), gzipSync(JSON.stringify(cases)));
  console.log(`siteconfig.json.gz written (${cases.length} cases)`);
}
