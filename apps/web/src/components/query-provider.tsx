"use client";

import {
  QueryClient,
  QueryClientProvider,
  defaultShouldDehydrateQuery,
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryKey,
} from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Where the cache is parked between page loads.
 *
 * **`sessionStorage`, not `localStorage`, and that is a security decision.**
 * This holds whatever the portal last read — rosters, invoices, complaints.
 * `sessionStorage` dies with the tab, so a shared hostel-office PC cannot hand
 * one account's data to whoever sits down next. `signOutRequest` clears it on
 * the way out for the case where the same tab is reused.
 */
const PERSIST_KEY = "hostelpalika:query-cache";

const isPublicKey = (key: QueryKey) => String(key[0]).startsWith("public-");

/** Drops the parked cache. Called on sign-out; see `lib/sign-out.ts`. */
export function clearPersistedQueryCache() {
  try {
    window.sessionStorage.removeItem(PERSIST_KEY);
  } catch {
    // Private mode and blocked site data both throw here. Nothing to clear.
  }
}

/**
 * App-wide TanStack Query provider (ARCHITECTURE.md — server state layer).
 * One client per browser session; sensible defaults for a mostly-read UI.
 *
 * The client itself is in-memory, so before this a refresh threw the whole
 * cache away and every portal page went back to a spinner — `staleTime` only
 * ever saved a tab switch. Restoring it on mount means F5 repaints from what
 * the tab already had and revalidates behind the paint.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 30_000,
          },
        },
      }),
  );

  // In an effect rather than during render: the server HTML has no cached data,
  // so filling the cache before the first paint would be a hydration mismatch.
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(PERSIST_KEY);

      if (saved) {
        const state = JSON.parse(saved) as DehydratedState;

        // Also filters caches parked before public reads were excluded (see `save`).
        hydrate(client, { ...state, queries: state.queries.filter((query) => !isPublicKey(query.queryKey)) });
      }
    } catch {
      // Unreadable or from an older shape — start cold rather than guess.
      clearPersistedQueryCache();
    }

    // `pagehide` rather than `beforeunload`: it is the one that fires on mobile
    // and on bfcache entry, which is most of how a tab actually leaves.
    // Public reads (`public-*`) are not parked: their pages render on the server
    // inside streamed Suspense boundaries that hydrate *after* this effect, so a
    // restored hostel list is a hydration mismatch. They are CDN-cached anyway.
    const save = () => {
      try {
        const snapshot = dehydrate(client, {
          shouldDehydrateQuery: (query) =>
            defaultShouldDehydrateQuery(query) && !isPublicKey(query.queryKey),
        });

        window.sessionStorage.setItem(PERSIST_KEY, JSON.stringify(snapshot));
      } catch {
        // Over quota, or storage blocked. The cache is an optimisation.
      }
    };

    window.addEventListener("pagehide", save);

    return () => window.removeEventListener("pagehide", save);
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
