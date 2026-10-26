import { describe, expect, it } from "vitest";

import { ROLE_LINKS } from "./role-links";
import { ROLE_PAGES } from "./role-pages";

describe("role pages", () => {
  it("has a page behind every footer link, and a link to every page", () => {
    expect(ROLE_PAGES.map(({ label, slug }) => ({ label, slug }))).toEqual(
      ROLE_LINKS.map(({ label, slug }) => ({ label, slug })),
    );
  });

  it("keeps titles and descriptions inside what search results show", () => {
    for (const page of ROLE_PAGES) {
      expect(page.title.length, page.slug).toBeLessThanOrEqual(75);
      expect(page.description.length, page.slug).toBeLessThanOrEqual(220);
      expect(page.faq.length, page.slug).toBeGreaterThan(0);
    }
  });

  it("never claims a balance sheet — residents get a statement with a running balance", () => {
    expect(JSON.stringify(ROLE_PAGES)).not.toMatch(/balance sheet/i);
  });
});
