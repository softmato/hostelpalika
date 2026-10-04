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
