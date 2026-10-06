import { cookies } from "next/headers";
import { cache } from "react";

import { readAccessTokenCookie } from "@/lib/auth-cookies";
import { isAuthBypassEnabled } from "@/lib/auth-bypass";
import { verifyAccessToken } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { type HostelPhoto, resolveHostelPhotos } from "@/lib/hostel-photos";
import { Role } from "@/lib/roles";
import { planBranchCap } from "@/modules/billing/billing-hostel";
import { HostelModel } from "@hostel/db/models/Hostel";

type WorkspaceHostel = {
  /** First exterior photo — the hostel's face in the switcher. */
  coverUrl: string | null;
  id: string;
  /** A branch of a Max hostel — labelled so in the switcher. */
  isBranch: boolean;
  name: string;
  slug: string;
};

const isAuthBypassed = isAuthBypassEnabled;

/** Dev-only stand-in for "the hostels this session belongs to". */
async function previewHostels(): Promise<WorkspaceHostel[]> {
  await connectToDatabase();

  const hostels = await HostelModel.find({ isDeleted: { $ne: true } })
    .select("name photos.kind photos.url slug")
    .limit(10)
    .lean<Array<{ _id: { toString(): string }; name: string; photos?: HostelPhoto[]; slug: string }>>();

  return hostels.map((hostel) => ({
    coverUrl: resolveHostelPhotos(hostel.photos, "EXTERIOR")[0]?.url ?? null,
    id: hostel._id.toString(),
    isBranch: false,
    name: hostel.name,
    slug: hostel.slug,
  }));
}

/**
 * The hostels the signed-in staff member may open a workspace for. Returns an
 * empty list when there is no valid session — callers redirect to login rather
 * than leaking whether a slug exists.
 *
 * Wrapped in React's `cache` because the admin layout asks twice per render —
 * once through `canAccessWorkspace`, once through `workspaceHostelName` — and
 * each ask was its own identical `Hostel.find`. Per-request only, so a session
 * change on the next request is still seen.
 */
export const listWorkspaceHostels = cache(async (): Promise<WorkspaceHostel[]> => {
  const store = await cookies();
  const token = readAccessTokenCookie(store);

  let hostelIds: string[] = [];

  if (token) {
    try {
      const payload = await verifyAccessToken(token);
      hostelIds = payload.hostelIds ?? [];
    } catch {
      hostelIds = [];
    }
  }

  // proxy.ts skips auth in development / UI-preview mode, so the portal has to
  // stay browsable there without a session. Never in production.
  if (hostelIds.length === 0) {
    return isAuthBypassed() ? previewHostels() : [];
  }

  await connectToDatabase();

  const hostels = await HostelModel.find({
    _id: { $in: hostelIds },
    isDeleted: { $ne: true },
  })
    .select("name parentHostelId photos.kind photos.url slug")
    .lean<
      Array<{
        _id: { toString(): string };
        name: string;
        parentHostelId?: unknown;
        photos?: HostelPhoto[];
        slug: string;
      }>
    >();

  // The token's order: the hostel granted first — the main one — leads.
  const order = new Map(hostelIds.map((id, index) => [id, index]));

  return hostels
    .map((hostel) => ({
      coverUrl: resolveHostelPhotos(hostel.photos, "EXTERIOR")[0]?.url ?? null,
      id: hostel._id.toString(),
      isBranch: Boolean(hostel.parentHostelId),
      name: hostel.name,
      slug: hostel.slug,
    }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
});

/** The slug the portal should open by default for this staff member. */
export async function defaultWorkspaceSlug(): Promise<string | null> {
  const hostels = await listWorkspaceHostels();

  return hostels[0]?.slug ?? null;
}

/**
 * Confirms `slug` belongs to a hostel this staff member is a member of. Used by
 * the tenant-scoped routes so one admin cannot open another hostel's workspace
 * by editing the URL.
 */
export async function canAccessWorkspace(slug: string): Promise<boolean> {
  const hostels = await listWorkspaceHostels();

  return hostels.some((hostel) => hostel.slug === slug);
}

/** Display name for the workspace switcher; null when out of scope. */
export async function workspaceHostelName(slug: string): Promise<string | null> {
  const hostels = await listWorkspaceHostels();

  return hostels.find((hostel) => hostel.slug === slug)?.name ?? null;
}

/**
 * The Overall workspace (`OVERALL_SLUG`): the owner of more than one hostel.
 * A warden who works in two branches is a member of each, not their owner, so
 * never gets it — the all-branches figures are the owner's alone.
 */
export const canOpenOverall = cache(async (): Promise<boolean> => {
  const token = readAccessTokenCookie(await cookies());

  if (!token) return isAuthBypassed() && (await listWorkspaceHostels()).length > 1;

  try {
    const payload = await verifyAccessToken(token);

    return payload.role === Role.HOSTEL_ADMIN && (await listWorkspaceHostels()).length > 1;
  } catch {
    return false;
  }
});

/**
 * Why Branches is closed in this workspace, or null when it is open. Branches
 * come with Max and only the owner runs them — the nav hides the screen, the
 * switcher's "Manage branches" toasts this, and the screen says it.
 */
export const branchesLock = cache(async (slug: string): Promise<string | null> => {
  const hostel = (await listWorkspaceHostels()).find((entry) => entry.slug === slug);

  if (!hostel) return null;
  if ((await planBranchCap(hostel.id)) === 0) return "You need the Max plan to use branches.";

  const token = readAccessTokenCookie(await cookies());

  if (!token) return null; // dev preview, no session

  try {
    const payload = await verifyAccessToken(token);

    return payload.role === Role.HOSTEL_ADMIN ? null : "Only the hostel owner can manage branches.";
  } catch {
    return "Only the hostel owner can manage branches.";
  }
});
