/**
 * Pages the Overall switcher scope renders. Lives here, not in the client
 * page, because the server route reads it — a "use client" module only hands
 * a server component a reference, never the array.
 */
export const OVERALL_SCREENS = [
  "dashboard",
  "residents",
  "staff",
  "payments",
  "statement",
  "expenses",
  "daily",
  "reports",
] as const;

export type OverallScreen = (typeof OVERALL_SCREENS)[number];

/** Branch keys and cache lifetime are shared by reads and prefetches. */
export const BRANCH_STALE_MS = 2 * 60_000;
export const BRANCH_GC_MS = 15 * 60_000;

export function branchSlug(pathname: string) {
  return /^\/([^/]+)\/admin(?:\/|$)/.exec(pathname)?.[1] ?? "";
}

export function portalResourceKey(url: string, slug: string) {
  return ["portal-resource", url, slug] as const;
}

export function branchRequestOptions(slug: string) {
  return { headers: { "x-hostel-id": slug ? decodeURIComponent(slug) : "" } };
}

/**
 * The workspace that answers for every branch at once: `/overall/admin/...`,
 * picked in the switcher like a branch. Reserved — no hostel is ever given this
 * slug — and owner-only (`canOpenOverall`). Its pages read each branch with an
 * explicit `x-hostel-id`; the header the portal would send for it names no
 * hostel, so the server falls back to the main one and never mixes branches.
 */
export const OVERALL_SLUG = "overall";
