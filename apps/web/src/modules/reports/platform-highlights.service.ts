import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { ResidentModel } from "@hostel/db/models/Resident";

export type PlatformStat = { label: string; value: number };

/** Statuses a hostel is running on the platform in — not a draft or a refusal. */
export const LIVE_HOSTEL_FILTER ={ isDeleted: false, status: { $in: ["APPROVED", "PUBLISHED"] } };

/**
 * A pitch page that says "1 hostel on the platform" argues against itself, so a
 * count below this is left out until it is worth saying out loud.
 */
export const MIN_PUBLIC_COUNT = 10;

/**
 * Read by the root layout on every request, so counts this coarse are held for
 * a few minutes per server instance rather than re-counted per page view.
 */
const CACHE_MS = 5 * 60 * 1000;

let cached: { at: number; stats: PlatformStat[] } | null = null;

/**
 * The live half of the Register your hostel stat strip.
 *
 * Only figures that are good to say in public: how many hostels, residents and
 * enquiries the platform carries. Money and occupancy stay off it — they are
 * each hostel's own business, and a small number reads as a warning. The
 * growth claims beside these are admin-written copy (`registerHostel.highlights`),
 * not counts.
 */
export async function getPublicPlatformStats(): Promise<PlatformStat[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.stats;
  }

  await connectToDatabase();

  const [hostels, residents, enquiries] = await Promise.all([
    HostelModel.countDocuments(LIVE_HOSTEL_FILTER),
    ResidentModel.countDocuments({ isDeleted: false, status: "ACTIVE" }),
    InquiryModel.countDocuments({ isDeleted: false }),
  ]);

  const stats = [
    { label: "Hostels on the platform", value: hostels },
    { label: "Residents living in them", value: residents },
    { label: "Enquiries sent to hostels", value: enquiries },
  ].filter((stat) => stat.value >= MIN_PUBLIC_COUNT);

  cached = { at: Date.now(), stats };

  return stats;
}
