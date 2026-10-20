import { revalidatePath } from "next/cache";

/**
 * Public pages are cached for hours (`revalidate` on the layouts) because each
 * re-render costs real CPU. A change an owner would look for on their listing —
 * profile, rates, free beds — clears that cache now instead of waiting it out.
 * Pages rebuild lazily on their next visit, so this costs nothing until then.
 *
 * Outside a Next request (scripts, tests) there is no cache to clear and
 * `revalidatePath` throws; that is swallowed — a stale listing is never worth
 * failing a save.
 */
export function revalidatePublicPages() {
  try {
    revalidatePath("/", "layout");
  } catch {
    // Not in a Next request.
  }
}
