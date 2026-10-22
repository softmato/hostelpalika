import { Redis } from "@upstash/redis";

/**
 * Server-side read cache on Upstash Redis (Mumbai, beside the Vercel `bom1`
 * functions and the Atlas cluster).
 *
 * The clients already hold what they fetched (TanStack Query, the app's
 * `query-cache`) and revalidate with ETags (`etag.ts`). A 304 still runs the
 * query, though, and a cold function, a second device or a refresh after the
 * client cache expired all rebuild the same answer. This keeps the built answer
 * for `TTL_SECONDS`, so those reads skip MongoDB.
 *
 * ## Invalidation is a version, not a delete
 *
 * Every key carries its hostel's version number. `bumpHostelCache` raises it on
 * every signed-in write to that hostel (`announceWrite`), so every cached read
 * of that hostel is skipped at once, without listing keys. Writes that reach a
 * hostel without its staff signing in bump it where they announce themselves:
 * `publishResourceChange` (crons, platform actions, night-status answers) and
 * `settleEvent` (every settled payment, gateway webhooks included). Anything
 * else shows up when the TTL runs out, no later than the clients' own stale
 * window.
 *
 * Keys are per user: what a staff member is shown depends on their role and
 * capabilities, and a shared key would hand one person's view to another.
 *
 * No `UPSTASH_REDIS_REST_URL`/`_TOKEN` (local dev, CI) means no cache, never an
 * error. A Redis failure falls through to the database the same way.
 */

const TTL_SECONDS = 60;

/**
 * Longest Redis may take before the request goes to the database instead. From
 * `bom1` an Upstash call is a few milliseconds; this only trips when Redis is
 * down or slow, and then it must cost the user almost nothing.
 */
const TIMEOUT_MS = 150;

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        // The client retries five times with backoff by default — seconds of
        // waiting on a dead Redis. One try, then the database.
        retry: false,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
        url: process.env.UPSTASH_REDIS_REST_URL,
      })
    : null;

const versionKey = (hostelId: string) => `v:hostel:${hostelId}`;

/** Rejects past `TIMEOUT_MS`; every caller treats a rejection as "no cache". */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("redis timeout")), TIMEOUT_MS)),
  ]);
}

/** `principal` is the narrowed `ApiPrincipal`; a request spanning several hostels is not cached. */
export async function cachedRead<T>(
  principal: { hostelIds: string[]; userId: string },
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const hostelId = principal.hostelIds.length === 1 ? principal.hostelIds[0] : null;

  if (!redis || !hostelId) return load();

  let cacheKey: string | null = null;

  try {
    const version = (await withTimeout(redis.get<number>(versionKey(hostelId)))) ?? 0;
    cacheKey = `c:${hostelId}:${version}:${principal.userId}:${key}`;
    const hit = await withTimeout(redis.get<{ value: T }>(cacheKey));

    if (hit) return hit.value;
  } catch {
    return load();
  }

  const value = await load();

  // Wrapped so a cached `null` reads as a hit, not a miss.
  await withTimeout(redis.set(cacheKey, { value }, { ex: TTL_SECONDS })).catch(() => undefined);

  return value;
}

/** Skips every cached read of these hostels. Never fails the request. */
export async function bumpHostelCache(hostelIds: (string | undefined | null)[]) {
  const ids = [...new Set(hostelIds.filter((id): id is string => Boolean(id)))];

  if (!redis || ids.length === 0) return;

  await withTimeout(Promise.all(ids.map((id) => redis.incr(versionKey(id))))).catch(() => undefined);
}
