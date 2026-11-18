import type { Metadata } from "next";

import {
  mapPublicHostelToSummary,
  type PublicHostel,
} from "@/app/_components/public-hostel-data";
import { PublicHomePage } from "@/app/_components/public-home-page";
import type { HostelSummary } from "@/app/_components/public-hostel-types";
import { staticPageMetadata } from "@/lib/seo-config";
import { HOSTELS_TAG, serverApi } from "@/lib/server-api";
import { loadSiteConfig } from "@/lib/site-config-server";

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("home");
}

/**
 * The home page is the listing's shop window, so its cards are read on the
 * server: a crawler — and anyone on a slow connection — gets real hostels in the
 * first response rather than an empty grid that fills in later.
 *
 * A failed read must not take the marketing page down with it; the sections then
 * show the same empty state a platform with no hostels yet would show.
 */
async function loadHostels(): Promise<HostelSummary[]> {
  try {
    const { hostels } = await serverApi<{ hostels: PublicHostel[] }>("/api/v1/public/hostels", { tags: [HOSTELS_TAG] });
    return (hostels as PublicHostel[]).map(mapPublicHostelToSummary);
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const [hostels, { platformStats }] = await Promise.all([loadHostels(), loadSiteConfig()]);
  return <PublicHomePage hostels={hostels} platformStats={platformStats} />;
}
