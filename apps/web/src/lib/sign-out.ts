"use client";

import { clearPersistedQueryCache } from "@/components/query-provider";
import { clearHeaderSnapshot } from "@/stores/session-store";

/**
 * Ends the browser session.
 *
 * One function rather than a `fetch` at each sign-out button, because the
 * session cookie is no longer the only thing a sign-out has to drop: the
 * TanStack cache is parked in `sessionStorage` and survives the reload that
 * follows, so a missed call here leaves the previous account's rows sitting in
 * the tab for the next person to sign in.
 *
 * Clearing runs in `finally` — a logout request that fails still means the user
 * asked to leave, and the caller redirects either way.
 */
export async function signOutRequest() {
  try {
    await fetch("/api/v1/auth/logout", { credentials: "include", method: "POST" });
  } finally {
    clearPersistedQueryCache();
    clearHeaderSnapshot();
  }
}
