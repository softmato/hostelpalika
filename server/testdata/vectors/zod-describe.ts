/**
 * Turns a zod v4 schema into the JSON descriptor `internal/platform/zschema`
 * interprets, so Go re-parses stored config exactly as `safeParse` does.
 *
 * Functions (refines, transforms, function defaults are evaluated) cannot be
 * serialised, so each one is matched by its source against NAMED and sent as
 * an id the Go side implements. An unknown one throws: add it here and in Go.
 */

type Desc = Record<string, unknown>;

const NAMED: Array<[string, string]> = [
  ['value === "" || value.startsWith("https://")', "httpsOrBlank"],
  ['value.startsWith("https://")', "https"],
  ["deal.endsOn >= deal.startsOn", "lifetimeDates"],
  ["new Set(deal.offers.map", "lifetimeUniqueOffers"],
  ["config.leaveHoldMinDays <= config.leaveHoldMaxDays", "leaveHold"],
  ["PLATFORM_NAME", "platformName"],
  ["lines.filter((line) => line.phone)", "filterPhone"],
  ["filter(Boolean)", "filterBoolean"],
  ["input.trim()", "trim"],
  ["input.toLowerCase()", "lower"],
];

function named(fn: unknown): string {
  const src = String(fn);
  const hit = NAMED.find(([needle]) => src.includes(needle));
  if (!hit) throw new Error(`zod-describe: name this function in NAMED and zschema: ${src}`);
  return hit[1];
}

function check(c: { _zod: { def: Record<string, unknown> } }): Desc {
  const d = c._zod.def;
  switch (d.check) {
    case "overwrite":
      return { k: named(d.tx) };
    case "min_length":
      return { k: "min", v: d.minimum };
    case "max_length":
      return { k: "max", v: d.maximum };
    case "length_equals":
      return { k: "len", v: d.length };
    case "greater_than":
      return { k: d.inclusive ? "gte" : "gt", v: d.value };
    case "less_than":
      return { k: d.inclusive ? "lte" : "lt", v: d.value };
    case "number_format":
      return { k: d.format };
    case "string_format": {
      const out: Desc = { k: d.format };
      if (d.format === "regex" || d.pattern) {
        const p = d.pattern as RegExp;
        out.src = p.source;
        out.flags = p.flags;
      }
      if (d.format === "starts_with") out.v = d.prefix;
      if (d.format === "ends_with") out.v = d.suffix;
      if (d.format === "includes") out.v = d.includes;
      return out;
    }
    case "multiple_of":
      return { k: "multipleOf", v: d.value };
    case "custom":
      // A superRefine keeps its function in a closure; the caller names it
      // with nameSuperRefine.
      if (d.fn === undefined) return { k: "custom", fn: SUPER_REFINE };
      return { k: "custom", fn: named(d.fn) };
    default:
      throw new Error(`zod-describe: unhandled check ${String(d.check)}`);
  }
}

const SUPER_REFINE = "superRefine?";

/** Names the one superRefine in a described schema (it has to have exactly one). */
export function nameSuperRefine(desc: Desc, id: string): Desc {
  const text = JSON.stringify(desc);
  if (text.split(SUPER_REFINE).length !== 2) throw new Error(`zod-describe: expected one superRefine for ${id}`);
  return JSON.parse(text.replace(SUPER_REFINE, id));
}

export function describe(schema: unknown): Desc {
  const d = (schema as { _zod: { def: Record<string, any> } })._zod.def;
  const out: Desc = { t: d.type };
  if (d.checks?.length) out.checks = d.checks.map(check);
  switch (d.type) {
    case "object":
      out.shape = Object.entries(d.shape).map(([k, v]) => [k, describe(v)]);
      if (d.catchall && d.catchall._zod.def.type !== "never") out.catchall = describe(d.catchall);
      break;
    case "array":
      out.el = describe(d.element);
      break;
    case "union":
      out.options = d.options.map(describe);
      break;
    case "optional":
    case "nullable":
    case "readonly":
    case "nonoptional":
      out.inner = describe(d.innerType);
      break;
    case "default":
    case "prefault":
      out.inner = describe(d.innerType);
      out.value = d.defaultValue;
      break;
    case "catch":
      out.inner = describe(d.innerType);
      out.value = d.catchValue({ error: null, input: undefined, value: undefined });
      break;
    case "pipe":
      out.in = describe(d.in);
      out.out = describe(d.out);
      break;
    case "transform":
      out.fn = named(d.transform);
      break;
    case "literal":
      out.values = d.values;
      break;
    case "enum":
      out.values = Object.values(d.entries);
      break;
    case "record":
      out.key = describe(d.keyType);
      out.val = describe(d.valueType);
      break;
    case "string":
    case "number":
    case "boolean":
    case "any":
    case "unknown":
    case "null":
      break;
    default:
      throw new Error(`zod-describe: unhandled type ${d.type}`);
  }
  return out;
}
