import { Types } from "mongoose";
import { HostelModel } from "@hostel/db/models/Hostel";
import type { PublicBranch } from "@hostel/shared/types/public-branch";
import { resolveHostelPhotoUrls, type HostelPhoto } from "@/lib/hostel-photos";

/** Family membership is explicit, not inferred from shared PAN, names or bank accounts. */
export async function listPublicSiblingBranches(hostel: {
  _id: Types.ObjectId;
  ownerId?: Types.ObjectId;
  parentHostelId?: Types.ObjectId | null;
}): Promise<PublicBranch[]> {
  if (!hostel.ownerId) return [];
  const root = hostel.parentHostelId ?? hostel._id;
  const branches = await HostelModel.find({
    _id: { $ne: hostel._id },
    ownerId: hostel.ownerId,
    $or: [{ _id: root }, { parentHostelId: root }],
    isDeleted: false,
    status: "PUBLISHED",
    verificationStatus: "VERIFIED",
  })
    .select("name slug location.area location.city photos")
    .sort({ name: 1, _id: 1 })
    .limit(60)
    .lean<
      Array<{
        _id: Types.ObjectId;
        name: string;
        slug: string;
        location?: { area?: string; city?: string };
        photos?: HostelPhoto[];
      }>
    >();

  return branches
    .filter((branch) => Boolean(branch.slug))
    .map((branch) => ({
      id: String(branch._id),
      name: branch.name,
      slug: branch.slug,
      area: branch.location?.area ?? "",
      city: branch.location?.city ?? "",
      photoUrl: resolveHostelPhotoUrls(branch.photos, "EXTERIOR")[0] ?? null,
    }));
}
