import { revalidatePath, revalidateTag } from "next/cache";

import { HOSTELS_TAG } from "@/lib/server-api";

/**
 * A change an owner would look for on their listing — profile, rates, free
 * beds — clears the pages that read listing data (`HOSTELS_TAG`) now instead of
 * after their day-long window. Only those: this runs on every bed change, and
 * clearing the whole site here re-rendered all ~700 pages (the 1 MB guide
 * included) each time — 103K ISR writes in ten days, 2026-11-18. Pages rebuild
 * lazily on their next visit, serving the old copy meanwhile.
 *
 * Outside a Next request (scripts, tests) there is no cache to clear and the
 * call throws; that is swallowed — a stale listing is never worth failing a save.
 */
export function revalidatePublicPages() {
  try {
    revalidateTag(HOSTELS_TAG, "max");
  } catch {
    // Not in a Next request.
  }
}

/** The website config changed: every page renders it, so all of them go. */
export function revalidateWholeSite() {
  try {
    revalidatePath("/", "layout");
  } catch {
    // Not in a Next request.
  }
}
