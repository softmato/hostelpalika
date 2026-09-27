import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLATFORM_MODERATOR_SEARCH_ENTRIES, PLATFORM_SEARCH_ENTRIES } from "./portal-nav";

/**
 * The generator for `platform-field-index.generated.ts`, the superadmin
 * palette's list of every field on the config screens.
 *
 * Most settings are hand-written `<label>Text<input>` rather than one shared
 * field component, so the labels are read out of the source: `label="…"`
 * props, `label: "…"` inside UPPER_CASE constant arrays (`NUMBER_FIELDS`), and
 * the first text inside a `<label>`. The section is the nearest component
 * `title="…"` or `<h2>`/`<h3>` above the field in the same declaration.
 *
 * A renamed or added field fails this test until the index is regenerated:
 *   npx vitest run src/lib/platform-field-index.test.ts -u
 */

type Source = {
  file: string;
  href: string;
  /**
   * Declaration → tab key ("" for no tab, null to leave it out of search).
   * When present, every declaration with a field must be listed, so a new
   * helper component on a tabbed page cannot land on the wrong tab.
   */
  decls?: Record<string, string | null>;
};

// `platform-settings-page.tsx` is left out on purpose: it is the admin roster
// and the superadmin's own account, not configuration.
const SOURCES: Source[] = [
  { file: "platform-config-site-page.tsx", href: "/platform/config/site" },
  { file: "platform-config-locations-page.tsx", href: "/platform/config/locations" },
  { file: "platform-config-facilities-page.tsx", href: "/platform/config/facilities" },
  {
    decls: {
      BadgeEditor: "offer",
      EventDiscount: "offer",
      LinksTab: "links",
      OfferTab: "offer",
      PlanPricingRow: "pricing",
    },
    file: "platform-config-plans-page.tsx",
    href: "/platform/config/plans",
  },
  { file: "platform-config-announcements-page.tsx", href: "/platform/config/announcements" },
  { file: "platform-config-content-page.tsx", href: "/platform/config/content" },
  { file: "platform-config-seo-page.tsx", href: "/platform/config/seo" },
  { file: "platform-config-legal-page.tsx", href: "/platform/config/legal" },
  { file: "platform-config-features-page.tsx", href: "/platform/config/features" },
  {
    decls: { PayDialog: null, TeamCommissionPanel: "" },
    file: "platform-team-commission.tsx",
    href: "/platform/team",
  },
  {
    decls: {
      AccountsTab: null,
      BookingsTab: null,
      MarkSent: null,
      NUMBER_FIELDS: "settings",
      PaymentsTab: null,
      SettingsForm: "settings",
    },
    file: "platform-bookings-page.tsx",
    href: "/platform/bookings",
  },
];

type Field = { href: string; label: string; section: string; tab: string };

/** Drops `{…}` expressions, however deep, leaving the literal text around them. */
function withoutExpressions(text: string) {
  let out = "";
  let depth = 0;

  for (const char of text) {
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }

  return out;
}

function extract(source: Source, code: string): Field[] {
  const decls = [...code.matchAll(/^(?:export )?(?:async )?(?:function|const) (\w+)/gm)].map(
    (match) => ({ at: match.index, name: match[1] }),
  );
  const declAt = (at: number) => decls.filter((decl) => decl.at <= at).at(-1);

  const labels: { at: number; label: string }[] = [];
  for (const match of code.matchAll(/(?<![-\w])label="([^"]+)"/g)) {
    labels.push({ at: match.index, label: match[1] });
  }
  for (const match of code.matchAll(/^const [A-Z][A-Z0-9_]*\b[^=]*= \[([\s\S]*?)^\];/gm)) {
    for (const item of match[1].matchAll(/label: "([^"]+)"/g)) {
      labels.push({ at: match.index + item.index, label: item[1] });
    }
  }
  for (const match of code.matchAll(/<label\b([\s\S]*?)<\/label>/g)) {
    // `=>` would end a tag early; the attributes before the first `>` are not text.
    const body = match[1].replace(/=>/g, "").replace(/^[^>]*>/, "");
    const text = body
      .split(/<[^>]*>/)
      .map((piece) => withoutExpressions(piece).replace(/\s+/g, " ").trim())
      .find((piece) => /[A-Za-z]{2}/.test(piece));
    if (text) labels.push({ at: match.index, label: text });
  }

  const sections = [
    ...[...code.matchAll(/<[A-Z]\w*\b(?:=>|[^>])*?\stitle="([^"]+)"/g)].map((m) => ({
      at: m.index,
      title: m[1],
    })),
    ...[...code.matchAll(/<h[23]\b[^>]*>([^<{]+)<\/h[23]>/g)].map((m) => ({
      at: m.index,
      title: m[1].trim(),
    })),
  ];

  /** The nearest section title above `at`, inside the same declaration. */
  const sectionAt = (at: number) => {
    const start = declAt(at)?.at ?? 0;
    return (
      sections
        .filter((item) => item.at < at && item.at >= start)
        .sort((left, right) => left.at - right.at)
        .at(-1)?.title ?? ""
    );
  };

  const fields: Field[] = [];
  const seen = new Set<string>();

  for (const { at, label } of labels.sort((left, right) => left.at - right.at)) {
    const decl = declAt(at);
    let tab = "";

    if (source.decls) {
      if (!decl || !(decl.name in source.decls)) {
        throw new Error(`${source.file}: map \`${decl?.name}\` (field "${label}") in SOURCES.decls`);
      }
      const mapped = source.decls[decl.name];
      if (mapped === null) continue;
      tab = mapped;
    }

    // A shared editor (`<PageEditor>` under six cards) takes each card's title.
    const own = sectionAt(at);
    const used =
      own || !decl
        ? []
        : [...code.matchAll(new RegExp(`<${decl.name}\\b`, "g"))]
            .map((match) => sectionAt(match.index))
            .filter(Boolean);

    for (const section of own ? [own] : used.length > 0 ? used : [""]) {
      const key = `${tab}|${section}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push({ href: source.href, label, section, tab });
    }
  }

  return fields;
}

function render(fields: Field[]) {
  const q = JSON.stringify;
  const rows = fields.map(
    (field) =>
      `  { href: ${q(field.href)}, label: ${q(field.label)}, section: ${q(field.section)}, tab: ${q(field.tab)} },`,
  );

  return [
    "// Generated by platform-field-index.test.ts from the platform config screens. Do not edit.",
    "// Regenerate: npx vitest run src/lib/platform-field-index.test.ts -u",
    "export const PLATFORM_FIELDS: ReadonlyArray<{",
    "  href: string;",
    "  label: string;",
    "  section: string;",
    "  tab: string;",
    "}> = [",
    ...rows,
    "];",
    "",
  ].join("\n");
}

describe("platform field index", () => {
  const dir = path.resolve(__dirname, "../app/_components");
  const fields = SOURCES.flatMap((source) =>
    extract(source, fs.readFileSync(path.join(dir, source.file), "utf8")),
  );

  it("finds the fields the palette is asked for by name", () => {
    expect(fields).toContainEqual({
      href: "/platform/team",
      label: "Setup fee (Rs)",
      section: "Commission",
      tab: "",
    });
    expect(fields).toContainEqual(
      expect.objectContaining({ label: "Free months", tab: "pricing" }),
    );
    expect(fields).toContainEqual(
      expect.objectContaining({ href: "/platform/bookings", label: "Booking fee", tab: "settings" }),
    );
  });

  it("is up to date with the config screens", async () => {
    await expect(render(fields)).toMatchFileSnapshot("./platform-field-index.generated.ts");
  });

  it("deep-links each field, and a moderator gets no field of a page they cannot open", () => {
    expect(PLATFORM_SEARCH_ENTRIES).toContainEqual(
      expect.objectContaining({
        description: "Commission",
        field: true,
        href: "/platform/team?field=setup-fee-rs&in=commission",
        label: "Setup fee (Rs)",
      }),
    );
    expect(PLATFORM_SEARCH_ENTRIES).toContainEqual(
      expect.objectContaining({ href: "/platform/config/plans?tab=pricing&field=free-months&in=prices-discounts" }),
    );
    expect(new Set(PLATFORM_SEARCH_ENTRIES.map((entry) => entry.id)).size).toBe(
      PLATFORM_SEARCH_ENTRIES.length,
    );
    expect(
      PLATFORM_MODERATOR_SEARCH_ENTRIES.filter(
        (entry) => entry.href.startsWith("/platform/config") || entry.href.startsWith("/platform/bookings"),
      ),
    ).toEqual([]);
  });
});
