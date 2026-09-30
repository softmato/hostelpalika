"use client";

import { useQueries, useQuery } from "@tanstack/react-query";

import type { PublicHostel } from "@/app/_components/public-hostel-data";
import { browserApi } from "@/lib/browser-api";

export type PublicHostelReview = {
  cleanlinessRating?: number;
  comment: string;
  createdAt?: string;
  foodRating?: number;
  id: string;
  isVerifiedResident: boolean;
  locationRating?: number;
  managementRating?: number;
  overallRating: number;
  reviewerName: string;
  roomRating?: number;
  safetyRating?: number;
};

export type PublicHostelReviewData = {
  reviews: PublicHostelReview[];
  summary: {
    averageRating: number;
    categories: Record<string, number | null>;
    distribution: Array<{ count: number; stars: number }>;
    total: number;
  };
};

function hostelReviewsQuery(slug: string) {
  return {
    queryFn: () =>
      browserApi<PublicHostelReviewData>(
        `/api/v1/public/hostels/${encodeURIComponent(slug)}/reviews`,
      ),
    queryKey: ["public-hostel-reviews", slug] as const,
  };
}

export type PublicHostelQueryParams = {
  area?: string;
  facility?: string;
  /** Dietary preference filter — matches publicHostelListQuerySchema. */
  food?: "veg" | "non-veg";
  maxPrice?: string;
  minPrice?: string;
  q?: string;
  roomType?: string;
  stay?: "short";
  type?: string;
};

function toSearchString(params: PublicHostelQueryParams) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }
  return search.toString();
}

/**
 * Tells the server these hostels were shown in a result list.
 *
 * Fire-and-forget, and swallowing its own failure: a hostel owner's statistic
 * is never worth a broken listing page. In the `queryFn` rather than an effect,
 * so it fires once per actual network fetch — a repaint from the TanStack cache
 * is not a new appearance.
 */
function reportListingImpressions(hostels: PublicHostel[]) {
  const hostelIds = hostels.map((hostel) => hostel.id).filter(Boolean);

  if (hostelIds.length === 0) {
    return;
  }

  void browserApi("/api/v1/public/hostels/impressions", {
    body: JSON.stringify({ hostelIds: hostelIds.slice(0, 60) }),
    method: "POST",
  }).catch(() => {
    // Analytics must never break the page.
  });
}

/** Public hostel listing (server state via TanStack Query). */
export function useHostels(params: PublicHostelQueryParams = {}) {
  const qs = toSearchString(params);

  return useQuery({
    queryFn: async () => {
      const result = await browserApi<{ hostels: PublicHostel[] }>(
        `/api/v1/public/hostels${qs ? `?${qs}` : ""}`,
      );

      reportListingImpressions(result.hostels);

      return result;
    },
    queryKey: ["public-hostels", qs],
  });
}

/** Side-by-side comparison payload for 2–3 hostels. */
export function useCompareHostels(ids: string[]) {
  const key = ids.join(",");

  return useQuery({
    enabled: ids.length >= 2,
    queryFn: () =>
      browserApi<{ hostels: PublicHostel[] }>(
        `/api/v1/public/hostels/compare?ids=${encodeURIComponent(key)}`,
      ),
    queryKey: ["public-hostels-compare", key],
  });
}

/**
 * One review summary per slug, same shape and endpoint the hostel detail page
 * uses — so the compare page's rating breakdown and review snippets match
 * what a visitor sees after clicking through to a listing.
 */
export function useHostelsReviews(slugs: string[]) {
  return useQueries({ queries: slugs.map(hostelReviewsQuery) });
}
