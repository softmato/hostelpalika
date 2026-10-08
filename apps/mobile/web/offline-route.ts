import type { Coordinates } from "@/lib/geo";

/** The PWA has no offline map packs; the browser's own cache is all there is. */
export async function saveRouteOffline(_points: Coordinates[], _mapStyle: string): Promise<boolean> {
  return false;
}
