import type { NextRequest } from "next/server";

import { afterResponse } from "@/lib/after-response";
import { REALTIME_TOPIC, type RealtimeTopic } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { bumpHostelCache } from "@/lib/redis-cache";

const { BOOKINGS, HOSTELS, PAYMENTS, RESIDENTS, ROOMS } = REALTIME_TOPIC;

/**
 * Which screens a write under each path moves. Longest prefix wins.
 *
 * One table instead of a publish call in every service: residents, bills and
 * rooms are written from dozens of places, and every one that forgot to publish
 * left the other phone (and the web dashboard) showing yesterday until a pull.
 * A path not listed stays quiet — its service publishes for itself, or it is
 * not hostel data.
 */
const WRITE_TOPICS: [string, RealtimeTopic[]][] = [
  ["/api/v1/hostel-admin/residents", [RESIDENTS, PAYMENTS, ROOMS]],
  ["/api/v1/hostel-admin/resident-scan", [RESIDENTS, PAYMENTS, ROOMS]],
  ["/api/v1/hostel-admin/rooms", [ROOMS, RESIDENTS]],
  ["/api/v1/hostel-admin/room-types", [ROOMS]],
  ["/api/v1/hostel-admin/profile", [ROOMS, HOSTELS]],
  ["/api/v1/hostel-admin/kyc", [HOSTELS]],
  ["/api/v1/hostel-admin/settings", [HOSTELS, PAYMENTS]],
  ["/api/v1/hostel-admin/finance", [PAYMENTS]],
  ["/api/v1/hostel-admin/expenses", [PAYMENTS]],
  ["/api/v1/hostel-admin/bookings", [BOOKINGS, ROOMS, RESIDENTS]],
  ["/api/v1/hostel-admin/move-events", [RESIDENTS, PAYMENTS, ROOMS]],
  ["/api/v1/resident/finance", [PAYMENTS]],
  ["/api/v1/resident/room", [ROOMS]],
];

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export function topicsForWrite(method: string, path: string): RealtimeTopic[] {
  if (READS.has(method.toUpperCase())) return [];

  const match = WRITE_TOPICS.filter(([prefix]) => path === prefix || path.startsWith(`${prefix}/`)).sort(
    (left, right) => right[0].length - left[0].length,
  )[0];

  return match?.[1] ?? [];
}

/** After the response, tell every open screen of these hostels to refetch. Never fails the request. */
export function announceWrite(request: NextRequest, hostelIds: string[]) {
  if (hostelIds.length === 0 || !request.method) return;

  if (!READS.has(request.method.toUpperCase())) {
    // Once now and once after the response: a read that lands while the write
    // is still running could otherwise cache the old answer under the new version.
    void bumpHostelCache(hostelIds);
    afterResponse(() => bumpHostelCache(hostelIds));
  }

  const path = request.nextUrl?.pathname ?? (request.url ? new URL(request.url).pathname : "");
  const topics = topicsForWrite(request.method, path);

  if (topics.length === 0) return;

  afterResponse(() => publishResourceChange({ hostelIds, topics }));
}
