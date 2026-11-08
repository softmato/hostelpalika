import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { readAccessTokenCookie } from "@/lib/auth-cookies";
import { verifyAccessToken } from "@/lib/auth";
import { Role } from "@/lib/roles";
import { serverApi, ServerApiError } from "@/lib/server-api";

type WorkspaceHostel = {
  /** Branches this hostel's plan includes — 0 on every plan but Max. */
  branchCap: number;
  /** First exterior photo — the hostel's face in the switcher. */
  coverUrl: string | null;
  id: string;
  /** A branch of a Max hostel — labelled so in the switcher. */
  isBranch: boolean;
  name: string;
  slug: string;
};

/**
 * `GET /api/v1/account/workspaces` with this request's session, once per
 * request and slug. No session, or a dead one, reads as no hostels — callers
 * 404 rather than leak whether a slug exists. A browser that still owes the
 * app-lock PIN goes to `/unlock` first.
 */
const readWorkspaces = cache(async (slug?: string): Promise<{ held: boolean; hostels: WorkspaceHostel[] }> => {
  if (!readAccessTokenCookie(await cookies())) return { held: false, hostels: [] };

  try {
    return await serverApi(`/api/v1/account/workspaces${slug ? `?slug=${encodeURIComponent(slug)}` : ""}`, {
      session: true,
    });
  } catch (error) {
    if (error instanceof ServerApiError && error.code === "LOCK_PIN_REQUIRED") redirect("/unlock");
    if (error instanceof ServerApiError && error.status < 500) return { held: false, hostels: [] };
    throw error;
  }
});

/** The hostels the signed-in staff member may open a workspace for, main hostels first. */
export const listWorkspaceHostels = cache(async (): Promise<WorkspaceHostel[]> => (await readWorkspaces()).hostels);

/** Whether `slug` is this account's own held (left-the-platform) hostel. */
export async function isHeldWorkspace(slug: string): Promise<boolean> {
  return (await readWorkspaces(slug)).held;
}

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

const sessionRole = cache(async (): Promise<string | null> => {
  const token = readAccessTokenCookie(await cookies());

  if (!token) return null;

  try {
    return (await verifyAccessToken(token)).role ?? null;
  } catch {
    return null;
  }
});

/**
 * The Overall workspace (`OVERALL_SLUG`): the owner of more than one hostel.
 * A warden who works in two branches is a member of each, not their owner, so
 * never gets it — the all-branches figures are the owner's alone.
 */
export const canOpenOverall = cache(
  async (): Promise<boolean> =>
    (await sessionRole()) === Role.HOSTEL_ADMIN && (await listWorkspaceHostels()).length > 1,
);

/**
 * Why Branches is closed in this workspace, or null when it is open. Branches
 * come with Max and only the owner runs them — the nav hides the screen, the
 * switcher's "Manage branches" toasts this, and the screen says it.
 */
export const branchesLock = cache(async (slug: string): Promise<string | null> => {
  const hostel = (await listWorkspaceHostels()).find((entry) => entry.slug === slug);

  if (!hostel) return null;
  if (hostel.branchCap === 0) return "You need the Max plan to use branches.";

  return (await sessionRole()) === Role.HOSTEL_ADMIN ? null : "Only the hostel owner can manage branches.";
});
