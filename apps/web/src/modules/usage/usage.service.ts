import { type PipelineStage, Types } from "mongoose";

import { HostelModel } from "@hostel/db/models/Hostel";
import { UsageDailyModel } from "@hostel/db/models/UsageDaily";
import { UsageEventModel } from "@hostel/db/models/UsageEvent";
import { UserModel } from "@hostel/db/models/User";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { hostelCalendarDay } from "@/lib/hostel-day";

import type { UsageEventInput } from "./usage.validation";

/** How far back a buffered event may claim to be from (a phone offline for a week). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** And how far ahead of our clock a phone's may run. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * A path as a screen or feature name: query and hash gone, every id-shaped
 * segment (object id, number, uuid, long token) turned into `:id`, and the
 * tenant slug in `/{slug}/admin` turned into `:hostel` so every hostel's
 * Residents page is one screen. The app sends route templates already; this is
 * what keeps a web path, or an API url, from carrying anybody's id.
 */
export function usagePath(path: string) {
  return (
    path
      .split(/[?#]/)[0]
      .replace(/^\/[^/]+\/admin(?=\/|$)/, "/:hostel/admin")
      .replace(/\/(?:[a-f\d]{24}|\d+|[a-f\d]{8}-[a-f\d-]{27}|[\w-]{25,})(?=\/|$)/gi, "/:id")
      .replace(/\/+$/, "")
      .slice(0, 120) || "/"
  );
}

/** `POST /api/v1/hostel-admin/expenses/66ab…` → `POST /hostel-admin/expenses/:id`. */
export function usageFeature(feature: string) {
  const [method, ...rest] = feature.trim().split(/\s+/);
  const path = rest.join("") || method;
  const verb = rest.length > 0 ? `${method.toUpperCase()} ` : "";

  return `${verb}${usagePath(path.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1(?=\/)/, ""))}`;
}

export type UsageRollUpRow = {
  day: string;
  durationMs: number;
  feature: string;
  opens: number;
  screen: string;
  uses: number;
  views: number;
};

/**
 * One batch as cleaned events plus the `UsageDaily` increments it makes.
 * Pure, so the maths has a test: events outside the clock window are dropped,
 * names are normalised, and each (day, screen, feature) gets one row.
 */
export function rollUpUsage(events: UsageEventInput[], now = Date.now()) {
  const kept: (UsageEventInput & { durationMs: number; feature: string; screen: string })[] = [];
  const rows = new Map<string, UsageRollUpRow>();

  for (const event of events) {
    const at = event.at.getTime();

    if (!Number.isFinite(at) || at < now - MAX_AGE_MS || at > now + MAX_SKEW_MS) continue;

    const screen = event.kind === "screen" && event.screen ? usagePath(event.screen) : "";
    const feature = event.kind === "feature" && event.feature ? usageFeature(event.feature) : "";

    // A screen or feature event without its name says nothing.
    if ((event.kind === "screen" && !screen) || (event.kind === "feature" && !feature)) continue;

    const durationMs = event.kind === "screen" ? (event.durationMs ?? 0) : 0;
    const day = hostelCalendarDay(event.at).toISOString().slice(0, 10);
    const key = `${day}|${screen}|${feature}`;
    const row = rows.get(key) ?? { day, durationMs: 0, feature, opens: 0, screen, uses: 0, views: 0 };

    if (event.kind === "open") row.opens += 1;
    if (event.kind === "screen") {
      row.views += 1;
      row.durationMs += durationMs;
    }
    if (event.kind === "feature") row.uses += 1;

    rows.set(key, row);
    kept.push({ ...event, durationMs, feature, screen });
  }

  return { events: kept, rows: [...rows.values()] };
}

export async function recordUsage(
  principal: ApiPrincipal,
  client: "app" | "web",
  events: UsageEventInput[],
) {
  const { events: kept, rows } = rollUpUsage(events);

  if (kept.length === 0) return { recorded: 0 };

  await connectToDatabase();

  const userId = new Types.ObjectId(principal.userId);
  const hostel = principal.hostelIds[0];
  const hostelId = hostel && Types.ObjectId.isValid(hostel) ? new Types.ObjectId(hostel) : null;

  await Promise.all([
    UsageEventModel.insertMany(
      kept.map((event) => ({
        at: event.at,
        client,
        durationMs: event.durationMs,
        feature: event.feature,
        hostelId,
        kind: event.kind,
        role: principal.role,
        screen: event.screen,
        userId,
      })),
      { ordered: false },
    ),
    UsageDailyModel.bulkWrite(
      rows.map((row) => ({
        updateOne: {
          filter: { day: row.day, feature: row.feature, hostelId, screen: row.screen, userId },
          update: {
            $inc: { durationMs: row.durationMs, opens: row.opens, uses: row.uses, views: row.views },
            $set: { role: principal.role },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    ),
  ]);

  return { recorded: kept.length };
}

type Grouped = { _id: unknown; durationMs: number; opens: number; users: number; uses: number; views: number };

const SUMS = {
  durationMs: { $sum: "$durationMs" },
  opens: { $sum: "$opens" },
  userSet: { $addToSet: "$userId" },
  uses: { $sum: "$uses" },
  views: { $sum: "$views" },
};

const COUNT_USERS = { $set: { users: { $size: "$userSet" } } };

function groupBy(field: string, match: Record<string, unknown>, sort: string, limit: number): PipelineStage[] {
  return [
    { $match: match },
    { $group: { _id: `$${field}`, ...SUMS } },
    COUNT_USERS,
    { $project: { userSet: 0 } },
    { $sort: { [sort]: -1 as const } },
    { $limit: limit },
  ];
}

async function namesOf(model: typeof UserModel | typeof HostelModel, ids: unknown[]) {
  const rows = await model
    .find({ _id: { $in: ids.filter(Boolean) } })
    .select("name email")
    .lean<{ _id: Types.ObjectId; email?: string; name: string }[]>();

  return new Map(rows.map((row) => [String(row._id), row]));
}

/**
 * The superadmin Analytics tab: who opens the app, which screens hold people,
 * which features get used, by role and hostel — or all of it for one person.
 */
export async function getUsageAnalytics({ days, userId }: { days: number; userId?: string }) {
  await connectToDatabase();

  const from = hostelCalendarDay(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000))
    .toISOString()
    .slice(0, 10);
  const base: Record<string, unknown> = { day: { $gte: from } };

  if (userId) base.userId = new Types.ObjectId(userId);

  const [totals, users, screens, features, byRole, byHostel, daily] = await Promise.all([
    UsageDailyModel.aggregate<Grouped>([{ $match: base }, { $group: { _id: null, ...SUMS } }, COUNT_USERS]),
    UsageDailyModel.aggregate<Grouped & { hostelId: unknown; lastDay: string; role: string }>([
      { $match: base },
      { $sort: { day: 1 } },
      {
        $group: {
          _id: "$userId",
          ...SUMS,
          hostelId: { $last: "$hostelId" },
          lastDay: { $last: "$day" },
          role: { $last: "$role" },
        },
      },
      COUNT_USERS,
      { $project: { userSet: 0 } },
      { $sort: { opens: -1, durationMs: -1 } },
      { $limit: 100 },
    ]),
    UsageDailyModel.aggregate<Grouped>(groupBy("screen", { ...base, screen: { $ne: "" } }, "durationMs", 40)),
    UsageDailyModel.aggregate<Grouped>(groupBy("feature", { ...base, feature: { $ne: "" } }, "uses", 40)),
    UsageDailyModel.aggregate<Grouped>(groupBy("role", base, "opens", 20)),
    UsageDailyModel.aggregate<Grouped>(groupBy("hostelId", { ...base, hostelId: { $ne: null } }, "opens", 40)),
    UsageDailyModel.aggregate<Grouped>([
      { $match: base },
      { $group: { _id: "$day", ...SUMS } },
      COUNT_USERS,
      { $project: { userSet: 0 } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const [people, hostels] = await Promise.all([
    namesOf(UserModel, [...users.map((row) => row._id), ...(userId ? [new Types.ObjectId(userId)] : [])]),
    namesOf(HostelModel, [...users.map((row) => row.hostelId), ...byHostel.map((row) => row._id)]),
  ]);

  const total = totals[0];
  const recent = userId
    ? await UsageEventModel.find({ userId: new Types.ObjectId(userId) })
        .sort({ at: -1 })
        .limit(60)
        .select("-_id at client kind screen feature durationMs")
        .lean<{ at: Date; client: string; durationMs: number; feature: string; kind: string; screen: string }[]>()
    : [];

  return {
    byHostel: byHostel.map(({ _id, ...row }) => ({
      ...row,
      hostelId: String(_id),
      hostelName: hostels.get(String(_id))?.name ?? "Removed hostel",
    })),
    byRole: byRole.map(({ _id, ...row }) => ({ ...row, role: String(_id) })),
    daily: daily.map(({ _id, ...row }) => ({ ...row, day: String(_id) })),
    days,
    features: features.map(({ _id, ...row }) => ({ ...row, feature: String(_id) })),
    from,
    recent: recent.map((event) => ({ ...event, at: event.at.toISOString() })),
    screens: screens.map(({ _id, ...row }) => ({ ...row, screen: String(_id) })),
    totals: {
      durationMs: total?.durationMs ?? 0,
      opens: total?.opens ?? 0,
      users: total?.users ?? 0,
      uses: total?.uses ?? 0,
      views: total?.views ?? 0,
    },
    user: userId
      ? {
          email: people.get(userId)?.email ?? null,
          name: people.get(userId)?.name ?? "Removed account",
          userId,
        }
      : null,
    users: users.map(({ _id, hostelId, ...row }) => ({
      ...row,
      email: people.get(String(_id))?.email ?? null,
      hostelName: hostelId ? (hostels.get(String(hostelId))?.name ?? null) : null,
      name: people.get(String(_id))?.name ?? "Removed account",
      userId: String(_id),
    })),
  };
}

export type UsageAnalytics = Awaited<ReturnType<typeof getUsageAnalytics>>;
