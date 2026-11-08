import { connectToDatabase } from "@/lib/db";
import type { ApiPrincipal } from "@/lib/api-auth";
import { type HostelPhoto, resolveHostelPhotos } from "@/lib/hostel-photos";
import { planBranchCap } from "@/modules/billing/billing-hostel";
import { heldHostelForSlug } from "@/modules/hostels/hostel-leave.service";
import { HostelModel } from "@hostel/db/models/Hostel";

export type WorkspaceHostel = {
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
 * `GET /account/workspaces` — the hostels this session may open a web portal
 * workspace for, main hostels first, then the token's order (a claim-back
 * re-grants branches before their main). Suspended ones are listed too: their
 * portal says so rather than 404ing. With `slug`, `held` says whether that
 * address is this account's own held (left-the-platform) hostel, which the
 * portal answers with the claim-back home instead of a 404.
 */
export async function listWorkspaces(principal: ApiPrincipal, slug: string | null) {
  await connectToDatabase();

  const hostelIds = [
    ...new Set([...(principal.allHostelIds ?? principal.hostelIds), ...(principal.suspendedHostelIds ?? [])]),
  ];
  const rows = hostelIds.length
    ? await HostelModel.find({ _id: { $in: hostelIds }, isDeleted: { $ne: true } })
        .select("name parentHostelId photos.kind photos.url slug")
        .lean<
          Array<{ _id: { toString(): string }; name: string; parentHostelId?: unknown; photos?: HostelPhoto[]; slug: string }>
        >()
    : [];
  const order = new Map(hostelIds.map((id, index) => [id, index]));
  const hostels: WorkspaceHostel[] = await Promise.all(
    rows
      .map((hostel) => ({
        coverUrl: resolveHostelPhotos(hostel.photos, "EXTERIOR")[0]?.url ?? null,
        id: hostel._id.toString(),
        isBranch: Boolean(hostel.parentHostelId),
        name: hostel.name,
        slug: hostel.slug,
      }))
      .sort((a, b) => Number(a.isBranch) - Number(b.isBranch) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map(async (hostel) => ({ branchCap: await planBranchCap(hostel.id), ...hostel })),
  );
  const held = slug && !hostels.some((hostel) => hostel.slug === slug)
    ? Boolean(await heldHostelForSlug(principal.userId, slug))
    : false;

  return { held, hostels };
}
