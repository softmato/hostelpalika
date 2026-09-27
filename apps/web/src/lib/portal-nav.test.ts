import { describe, expect, it } from "vitest";

import {
  PLATFORM_MODERATOR_NAV,
  PLATFORM_MODERATOR_SEARCH_ENTRIES,
  PLATFORM_NAV,
  searchEntriesFromNav,
} from "@/lib/portal-nav";

function hrefs(groups: typeof PLATFORM_NAV) {
  return groups.flatMap((group) =>
    group.items.flatMap((item) =>
      item.children ? item.children.map((child) => child.href) : [item.href],
    ),
  );
}

describe("platform moderator navigation", () => {
  it("drops every destination the route rules would redirect away from", () => {
    const moderatorHrefs = hrefs(PLATFORM_MODERATOR_NAV);

    expect(moderatorHrefs.some((href) => href.startsWith("/platform/config"))).toBe(
      false,
    );
    expect(moderatorHrefs).not.toContain("/platform/settings");
  });

  it("keeps the moderation and approval work", () => {
    const moderatorHrefs = hrefs(PLATFORM_MODERATOR_NAV);

    expect(moderatorHrefs).toContain("/platform/hostels");
    expect(moderatorHrefs).toContain("/platform/service-providers");
    expect(moderatorHrefs).toContain("/platform/reviews");
    expect(moderatorHrefs).toContain("/platform/reports");
  });

  it("removes a group left empty rather than rendering a bare heading", () => {
    const websiteConfig = PLATFORM_MODERATOR_NAV.find(
      (group) => group.label === "Website Config",
    );

    expect(websiteConfig).toBeUndefined();
  });

  // The palette is derived from the same tree, so a hidden tab must not remain
  // searchable — that is the whole point of one nav source of truth.
  it("keeps the command palette in step with the sidebar", () => {
    // Field entries ride on these pages; platform-field-index.test.ts covers them.
    expect(PLATFORM_MODERATOR_SEARCH_ENTRIES.filter((entry) => !entry.field)).toEqual(
      searchEntriesFromNav(PLATFORM_MODERATOR_NAV),
    );
    expect(
      PLATFORM_MODERATOR_SEARCH_ENTRIES.some((entry) =>
        entry.href.startsWith("/platform/config"),
      ),
    ).toBe(false);
  });
});
