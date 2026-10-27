import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentModel } from "@hostel/db/models/Resident";

import { LIVE_HOSTEL_FILTER, MIN_PUBLIC_COUNT } from "./platform-highlights.service";

/** What the home page's top chip says. Every field is optional — a quiet day says less. */
export type PlatformPulse = {
  /** Live hostels, or null while the count is too small to say out loud. */
  hostels: number | null;
  residents: number | null;
  /** Hostels that went live on the platform since Nepal's midnight. */
  addedToday: number;
  latest: { city: string; name: string } | null;
};

/** The chip polls this, so one count per minute per server instance is plenty. */
const CACHE_MS = 60 * 1000;
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let cached: { at: number; pulse: PlatformPulse } | null = null;

/** Midnight in Kathmandu (UTC+5:45), as an instant. */
function nepalDayStart(now: number) {
  return new Date(Math.floor((now + NEPAL_OFFSET_MS) / DAY_MS) * DAY_MS - NEPAL_OFFSET_MS);
}

export async function getPlatformPulse(): Promise<PlatformPulse> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.pulse;
  }

  await connectToDatabase();

  const today = { ...LIVE_HOSTEL_FILTER, createdAt: { $gte: nepalDayStart(Date.now()) } };
  const [hostels, residents, addedToday, latest] = await Promise.all([
    HostelModel.countDocuments(LIVE_HOSTEL_FILTER),
    ResidentModel.countDocuments({ isDeleted: false, status: "ACTIVE" }),
    HostelModel.countDocuments(today),
    HostelModel.findOne(today).sort({ createdAt: -1 }).select("name location.city").lean(),
  ]);

  const pulse: PlatformPulse = {
    hostels: hostels >= MIN_PUBLIC_COUNT ? hostels : null,
    residents: residents >= MIN_PUBLIC_COUNT ? residents : null,
    addedToday,
    latest: latest ? { city: latest.location?.city ?? "", name: latest.name } : null,
  };

  cached = { at: Date.now(), pulse };

  return pulse;
}
