import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { UserModel } from "@hostel/db/models/User";

const valid = (ids: string[]) => ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));

async function read(userId: string) {
  const user = await UserModel.findById(userId)
    .select("savedHostelIds")
    .lean<{ savedHostelIds?: Types.ObjectId[] } | null>();

  return (user?.savedHostelIds ?? []).map(String);
}

export async function getSavedHostelIds(userId: string) {
  await connectToDatabase();

  return read(userId);
}

/** Merge `add` in and take `remove` out; returns the account's full saved list. */
export async function updateSavedHostelIds(userId: string, input: { add?: string[]; remove?: string[] }) {
  await connectToDatabase();

  const add = valid(input.add ?? []);
  const remove = valid(input.remove ?? []);

  if (add.length) {
    await UserModel.updateOne({ _id: userId }, { $addToSet: { savedHostelIds: { $each: add } } });
  }

  if (remove.length) {
    await UserModel.updateOne({ _id: userId }, { $pull: { savedHostelIds: { $in: remove } } });
  }

  return read(userId);
}
