import { DEFAULT_HOSTEL_IMAGE, mapPublicHostelToSummary, type PublicHostel } from "@/app/_components/public-hostel-data";
import { serverApi } from "@/lib/server-api";

export type GuideHostel = { area: string; image: string; name: string; slug: string };

/**
 * A few live hostels for the guide's right rail — each with its first exterior photo.
 * Demo listings and hostels without a real photo are skipped. Same cached request
 * the sitemap and llms.txt make, so it costs nothing extra; never throws.
 */
export async function loadGuideHostels(limit = 6): Promise<GuideHostel[]> {
  try {
    const { hostels } = await serverApi<{ hostels: PublicHostel[] }>("/api/v1/public/hostels", { revalidate: 3600 });
    return hostels
      .filter((h) => !h.isDemoData)
      .map(mapPublicHostelToSummary)
      .filter((h) => h.image && h.image !== DEFAULT_HOSTEL_IMAGE)
      .slice(0, limit)
      .map((h) => ({ area: [h.area, h.city].filter(Boolean).join(", "), image: h.image, name: h.name, slug: h.slug }));
  } catch {
    return [];
  }
}
