import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  guideAsMarkdown,
  guideForReader,
  guideProblems,
  guideReaderForRole,
  lockedGroups,
  withPictureUrls,
  type GuideContent,
} from "@hostel/shared/guide/guide";

/** A two-part guide in the stored shape: one public part, one for staff. */
const content: GuideContent = {
  access: [{ area: "Food", cells: { cook: "Edit", guardian: "View", owner: "Edit", resident: "View", warden: "Edit" } }],
  groups: [
    {
      audience: ["owner", "warden", "resident", "guardian", "cook", "visitor"],
      chapters: [
        { id: "sign-in", summary: "How to sign in.", title: "Sign in" },
        { audience: ["owner", "warden"], id: "who-can-do-what", summary: "The table.", title: "Who can do what", widget: "access-table" },
      ],
      intro: "Start.",
      label: "Start here",
      slug: "start",
    },
    {
      audience: ["owner", "warden"],
      chapters: [{ body: ["Petty cash secret."], flow: { caption: "Cash", src: "/guide/cash.webp" }, id: "owner-and-staff", summary: "Staff.", title: "Owner and staff" }],
      intro: "Connects.",
      label: "How it connects",
      slug: "connects",
    },
  ],
  ne: {
    access: { areas: { Food: "खाना" }, cells: { Edit: "फेर्ने", View: "हेर्ने" }, roles: {} },
    chapters: {
      "owner-and-staff": { body: ["…"], flow: "…", summary: "…", title: "…" },
      "sign-in": { summary: "…", title: "…" },
      "who-can-do-what": { summary: "…", title: "…" },
    },
    groups: { connects: { intro: "…", label: "…" }, start: { intro: "…", label: "…" } },
    trouble: [],
  },
  trouble: [],
};

/** The guide is how we run a hostel; only what a reader may read leaves the server. */
describe("guide lock", () => {
  it("hands a visitor the public chapters and names the locked parts only", () => {
    const mine = guideForReader(content, "visitor");
    expect(mine.groups.map((g) => g.slug)).toEqual(["start"]);
    expect(mine.groups[0].chapters.map((c) => c.id)).toEqual(["sign-in"]);
    expect(mine.access).toEqual([]);
    expect(Object.keys(mine.ne.chapters)).toEqual(["sign-in"]);
    expect(JSON.stringify(mine)).not.toContain("Petty cash");
    expect(lockedGroups(content, "visitor")).toEqual([
      { audience: ["owner", "warden"], first: "/guide/connects/owner-and-staff", label: "How it connects", labelNe: "…", slug: "connects" },
    ]);
  });

  it("gives staff their parts and the owner everything", () => {
    expect(guideForReader(content, "warden").access).toHaveLength(1);
    expect(guideForReader(content, "owner")).toEqual(guideForReader(content, "all"));
    expect(guideForReader(content, "resident").groups.map((g) => g.slug)).toEqual(["start"]);
    expect(guideReaderForRole("HOSTEL_ADMIN")).toBe("owner");
    expect(guideReaderForRole("PUBLIC")).toBe("visitor");
    expect(guideReaderForRole(null)).toBe("visitor");
  });

  it("signs pictures by name and keeps private text out of llms-full.txt", () => {
    const signed = withPictureUrls(content, (src) => `https://r2/${src}?sig`);
    expect(signed.groups[1].chapters[0].flow).toEqual({ caption: "Cash", name: "cash.webp", src: "https://r2//guide/cash.webp?sig" });
    const md = guideAsMarkdown(content, { updatedAt: "today", version: "1" });
    expect(md).toContain("Sign in");
    expect(md).not.toMatch(/Petty cash|Who can do what/);
  });

  it("catches Nepali that no longer matches the English", () => {
    expect(guideProblems(content)).toEqual([]);
    const broken = structuredClone(content);
    broken.ne.chapters["owner-and-staff"].body = [];
    expect(guideProblems(broken)).toEqual(["chapter owner-and-staff: body has 0 Nepali lines, 1 English"]);
  });

  it("keeps the guide's words out of this public repository", () => {
    const shared = readFileSync(join(__dirname, "../../../../packages/shared/src/guide/guide.ts"), "utf8");
    expect(shared).not.toMatch(/chapters: \[\s*\{\s*(body|id):/);
  });
});
