import { useCallback, useMemo } from "react";

import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { hostelCoordinates } from "@/lib/geo";
import type { PublicHostel } from "@/lib/public-api";
import { fetchTravelTimes, type RouteMode } from "@/lib/routing";

/**
 * Minutes from the reader's "My college / office" to each hostel.
 *
 * One router `table` request for the whole list (`fetchTravelTimes`), redone
 * only when the place, the profile or the set of hostels changes. The place is
 * `ui.commutePlace`, kept on this phone only; without one, every answer is null.
 */
export function useCommuteTimes(hostels: PublicHostel[], mode: RouteMode) {
  const place = useAppSelector((state) => state.ui.commutePlace ?? null);

  const placed = useMemo(
    () =>
      hostels.flatMap((hostel) => {
        const point = hostelCoordinates(hostel);

        return point ? [{ id: hostel.id, point }] : [];
      }),
    [hostels],
  );

  const travel = useResource<Record<string, number>>(
    useCallback(async () => {
      if (!place || placed.length === 0) {
        return {};
      }

      const seconds = await fetchTravelTimes(
        place,
        placed.map((entry) => entry.point),
        mode,
      );

      return Object.fromEntries(
        placed.flatMap((entry, index) => (seconds[index] == null ? [] : [[entry.id, seconds[index]]])),
      );
    }, [mode, place, placed]),
    { refetchOnFocus: false },
  );

  const minutesTo = useCallback(
    (id: string) => {
      const seconds = travel.data?.[id];

      return seconds == null ? null : Math.max(1, Math.round(seconds / 60));
    },
    [travel.data],
  );

  return { minutesTo, place };
}
