import { describe, expect, it } from "vitest";

import { CONTENT_ICON_SLUGS, contentIcon, resolveContentPage } from "@/lib/site-content";
import { DEFAULT_SITE_CONFIG } from "@/modules/platform-config/site-config.defaults";
import { contentSchema } from "@/modules/platform-config/site-config.validation";

/**
 * The page copy is now configuration, served to the website *and* to the mobile
 * app from one place. These cases guard the two halves of that promise: that the
 * shipped copy is valid and complete, and that what reaches a reader has no
 * unsubstituted placeholders left in it.
 */

const IDENTITY = {
  address: "Kathmandu, Nepal",
  siteName: "TestHostels",
  supportEmail: "help@example.com",
  supportPhone: "+977-1-0000000",
  tagline: "",
};

describe("shipped page content", () => {
  it("passes its own schema", () => {
    // The defaults are what a fresh database serves and what the admin editor
    // opens pre-filled with. A default that fails validation would be silently
    // swapped for itself by `coerceSection` and hide the mistake.
    expect(contentSchema.safeParse(DEFAULT_SITE_CONFIG.content).success).toBe(true);
  });

  it("gives every document page sections to render", () => {
    // A page with no sections renders as a masthead over white space — which is
    // exactly what the app shows when the server is too old to send this
    // section, and must never be what a current server sends.
    for (const page of [
      "about",
      "offerProgram",
      "privacy",
      "registerHostel",
      "serviceProviders",
      "terms",
    ] as const) {
      expect(DEFAULT_SITE_CONFIG.content[page].sections.length).toBeGreaterThan(0);
    }

    expect(DEFAULT_SITE_CONFIG.content.faq.length).toBeGreaterThan(0);
  });

  it("names an icon both clients can draw", () => {
    // Slugs are shared vocabulary: `apps/mobile/src/lib/site-content.ts` maps the
    // same names onto the same glyph set. A shipped default outside the set would fall
    // back to a generic mark on every surface.
    for (const page of Object.values(DEFAULT_SITE_CONFIG.content)) {
      if (Array.isArray(page)) continue;

      for (const section of page.sections) {
        expect(CONTENT_ICON_SLUGS).toContain(section.icon);
      }
    }
  });

  it("leaves no HTML entities in the copy", () => {
    /*
     * The old hardcoded arrays were JS strings holding `&ldquo;` and `&apos;`,
     * which React escapes rather than decodes — the live Terms page printed
     * `provided &ldquo;as is&rdquo;` to real readers. Stored copy has the same
     * hazard and no JSX around it to blame, so it is checked.
     */
    const everything = JSON.stringify(DEFAULT_SITE_CONFIG.content);

    expect(everything).not.toMatch(/&[a-z]+;/i);
  });
});

describe("resolveContentPage", () => {
  it("substitutes the platform's own name and support address", () => {
    const page = resolveContentPage(DEFAULT_SITE_CONFIG.content.terms, IDENTITY);
    const rendered = JSON.stringify(page);

    expect(rendered).toContain("TestHostels");
    expect(rendered).toContain("help@example.com");
    expect(rendered).not.toContain("{siteName}");
    expect(rendered).not.toContain("{supportEmail}");
  });

  it("does not print a bare full stop when no support email is configured", () => {
    // `supportEmail` is optional. "Contact our Data Protection team at ." is a
    // worse sentence than one that names no address, so the blank resolves to a
    // phrase — and the app has to do the same, or one stored string renders two
    // different sentences.
    const page = resolveContentPage(DEFAULT_SITE_CONFIG.content.privacy, {
      ...IDENTITY,
      supportEmail: "",
    });

    expect(page.noteBody).toBe("Contact our Data Protection team at our support team.");
  });
});

describe("contentIcon", () => {
  it("falls back rather than throwing on a slug an editor mistyped", () => {
    // The admin panel's icon field is free text; a typo must degrade to a
    // generic mark, not take the page down.
    expect(contentIcon("not-an-icon")).toBe(contentIcon("sparkles"));
  });
});
