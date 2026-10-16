import type { GlyphName } from "@hostel/constants/glyphs";

import type { ContentPage, SiteIdentity } from "@/lib/site-config-api";

/**
 * Reading the page copy the superadmin authors, on the phone.
 *
 * This is the counterpart of `apps/web/src/lib/site-content.ts` — the same two
 * operations. Both now land on the same glyph set (`glyphs.ts`). Both files exist because the
 * app does not link the web workspace (it has its own `node_modules` and its own
 * Metro resolver), so what is shared between the two clients is the *payload*,
 * not the module. The payload is the thing that has to agree; a second twenty-line
 * mapping table is not a second privacy policy.
 */

/**
 * Stored copy cannot interpolate, so it carries `{siteName}` and
 * `{supportEmail}` and they are replaced here.
 *
 * A blank support email falls back to a phrase rather than to nothing, so a
 * sentence never renders as "Contact our Data Protection team at ." — same rule
 * as the web, and it has to be the same rule, or the two clients print different
 * sentences from one stored string.
 */
export function fillPlaceholders(text: string, identity: SiteIdentity) {
  return text
    .replaceAll("{siteName}", identity.siteName)
    .replaceAll("{supportEmail}", identity.supportEmail || "our support team");
}

export type ResolvedContentPage = {
  highlights: { label: string; value: string }[];
  intro: string[];
  noteBody: string;
  noteTitle: string;
  sections: { body: string[]; icon: string; title: string }[];
  subtitle: string;
};

/** The same substitution across a whole page, so screens read plain text. */
export function resolveContentPage(
  page: ContentPage,
  identity: SiteIdentity,
): ResolvedContentPage {
  const fill = (text: string) => fillPlaceholders(text, identity);

  return {
    highlights: page.highlights,
    intro: page.intro.map(fill),
    noteBody: fill(page.noteBody),
    noteTitle: fill(page.noteTitle),
    sections: page.sections.map((section) => ({
      body: section.body.map(fill),
      icon: section.icon,
      title: fill(section.title),
    })),
    subtitle: fill(page.subtitle),
  };
}

/**
 * Slug → glyph. The slugs are the website's, so this table has to cover the
 * same set; an unknown one is an ordinary typo in a text field on the admin
 * page and degrades to the schema's own default rather than throwing.
 *
 * The outline variants are deliberate — every icon elsewhere in the app is an
 * outline glyph, and a filled mark in a document would read as an alert.
 */
const CONTENT_ICONS: Record<string, GlyphName> = {
  "alert-triangle": "warning",
  "badge-check": "checkmark-circle",
  ban: "ban",
  bed: "bed",
  bell: "notifications",
  building: "business",
  "credit-card": "card",
  database: "server",
  eye: "eye",
  "file-text": "document-text",
  gift: "gift",
  globe: "globe",
  heart: "heart",
  home: "home",
  "layout-dashboard": "grid",
  lock: "lock-closed",
  mail: "mail",
  "map-pin": "location",
  "qr-code": "qr-code",
  receipt: "receipt",
  scale: "scale",
  shield: "shield",
  "shield-check": "shield-checkmark",
  sparkles: "sparkles",
  target: "locate",
  "user-check": "person-circle",
  "user-plus": "person-add",
  "user-round": "person",
  users: "people",
  utensils: "restaurant",
  wallet: "wallet",
  wrench: "construct",
};

export function contentIcon(slug: string): GlyphName {
  return CONTENT_ICONS[slug] ?? "sparkles";
}
