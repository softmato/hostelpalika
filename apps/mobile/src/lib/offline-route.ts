import { OfflineManager } from "@maplibre/maplibre-react-native";

import type { Coordinates } from "@/lib/geo";
import { corridorBoxes } from "@/lib/navigation";

/**
 * Pressing Start saves the map along the route, so guidance keeps drawing
 * streets when the data drops in a lane.
 *
 * MapLibre offline packs of OpenFreeMap's vector tiles — allowed, and small:
 * a corridor of boxes (`corridorBoxes`) at zoom 13–17, a few hundred kilobytes
 * for a city route. Only the newest `TRIPS_KEPT` trips are kept on the phone.
 * The PWA has no offline packs; `web/offline-route.ts` answers false.
 */

const TRIPS_KEPT = 3;
/** A pack that has not finished by then is reported as not saved. */
const PACK_TIMEOUT_MS = 60_000;

async function pruneOldTrips() {
  const packs = await OfflineManager.getPacks();
  const trips = [...new Set(packs.map((pack) => String(pack.metadata.trip ?? "")))]
    .filter(Boolean)
    .sort()
    .reverse();
  const keep = new Set(trips.slice(0, TRIPS_KEPT - 1));

  await Promise.all(
    packs
      .filter((pack) => !keep.has(String(pack.metadata.trip ?? "")))
      .map((pack) => OfflineManager.deletePack(pack.id).catch(() => undefined)),
  );
}

function savePack(bounds: [number, number, number, number], mapStyle: string, trip: string) {
  return new Promise<boolean>((resolve) => {
    let id: string | null = null;
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      if (id) OfflineManager.removeListener(id);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PACK_TIMEOUT_MS);

    OfflineManager.createPack(
      { bounds, mapStyle, maxZoom: 17, metadata: { trip }, minZoom: 13 },
      (pack, status) => {
        id = pack.id;
        if (status.state === "complete") finish(true);
      },
      () => finish(false),
    )
      .then((pack) => {
        id = pack.id;
      })
      .catch(() => finish(false));
  });
}

/** True once every box of the route is on the phone. Never throws. */
export async function saveRouteOffline(points: Coordinates[], mapStyle: string): Promise<boolean> {
  try {
    await pruneOldTrips();
    const trip = String(Date.now());
    const saved = await Promise.all(
      corridorBoxes(points).map((bounds) => savePack(bounds, mapStyle, trip)),
    );

    return saved.every(Boolean);
  } catch {
    return false;
  }
}
