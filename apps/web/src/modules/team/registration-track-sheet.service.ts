import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { TRACK_SHEET_EVENT } from "@/lib/realtime/channels";
import { publishTrackSheet } from "@/lib/realtime/server";
import { HostelAgreementModel } from "@hostel/db/models/HostelAgreement";
import { PlatformDocumentSequenceModel } from "@hostel/db/models/PlatformDocumentSequence";
import { UserModel } from "@hostel/db/models/User";

import {
  agreementRef,
  type AgreementRow,
  type AgreementStatus,
  type TrackSheetSave,
  type TrackSheetView,
} from "@/lib/team/registration-track-sheet";

/** The agreement codes' one run — never reset by year (`PlatformDocumentSequence`). */
const RUN = { fiscalYear: "LIFETIME", kind: "HOSTEL_AGREEMENT" } as const;

type AgreementDoc = Omit<AgreementRow, "id" | "signedBy" | "signedOn"> & {
  _id: Types.ObjectId;
  createdBy?: Types.ObjectId | null;
  signedOn: Date;
};

type Viewer = Pick<ApiPrincipal, "role" | "userId">;

function toRow(doc: AgreementDoc, names: Map<string, string>, viewer: Viewer): AgreementRow {
  return {
    canEdit: viewer.role === Role.SUPERADMIN || String(doc.createdBy) === viewer.userId,
    hostelName: doc.hostelName,
    id: String(doc._id),
    location: doc.location ?? "",
    notes: doc.notes ?? "",
    ownerName: doc.ownerName ?? "",
    phone: doc.phone ?? "",
    refCode: doc.refCode,
    signedBy: (doc.createdBy && names.get(String(doc.createdBy))) ?? "",
    signedOn: doc.signedOn.toISOString(),
    status: doc.status as AgreementStatus,
  };
}

export async function getTrackSheet(viewer: Viewer): Promise<TrackSheetView> {
  const { userId } = viewer;

  await connectToDatabase();

  const [rows, run] = await Promise.all([
    HostelAgreementModel.find({ deletedAt: null }).sort({ sequence: 1 }).lean<AgreementDoc[]>(),
    PlatformDocumentSequenceModel.findOne(RUN).lean<{ sequence: number } | null>(),
  ]);

  const users = await UserModel.find({ _id: { $in: [userId, ...rows.map((row) => row.createdBy).filter(Boolean)] } })
    .select("name")
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const names = new Map(users.map((user) => [String(user._id), user.name]));

  return {
    nextSequence: (run?.sequence ?? 0) + 1,
    rows: rows.map((row) => toRow(row, names, viewer)),
    you: names.get(userId) ?? "",
  };
}

/**
 * Writes the changed lines and hands every new one its code.
 *
 * A saved line is changed or deleted only by a superadmin or the team member
 * who signed it; the whole save is refused if it touches anyone else's. Two
 * people adding lines at once can never share a code — each save takes its
 * whole block from one atomic `$inc`.
 */
export async function saveTrackSheet(input: TrackSheetSave, viewer: Viewer) {
  await connectToDatabase();

  const by = new Types.ObjectId(viewer.userId);
  // Everyone but a superadmin reaches only their own lines.
  const own = viewer.role === Role.SUPERADMIN ? {} : { createdBy: by };
  const touched = [...input.rows.flatMap((row) => (row.id ? [row.id] : [])), ...input.removed];

  if (
    viewer.role !== Role.SUPERADMIN &&
    touched.length &&
    (await HostelAgreementModel.countDocuments({
      _id: { $in: touched.map((id) => new Types.ObjectId(id)) },
      createdBy: { $ne: by },
    }))
  ) {
    throw Object.assign(new Error("Only a superadmin or the team member who signed a line can change it."), {
      errorCode: "AGREEMENT_NOT_YOURS",
      status: 403,
    });
  }

  const fields = (row: TrackSheetSave["rows"][number]) => ({
    hostelName: row.hostelName,
    location: row.location,
    notes: row.notes,
    ownerName: row.ownerName,
    phone: row.phone,
    signedOn: row.signedOn,
    status: row.status,
  });
  const updates = input.rows.filter((row) => row.id);
  const creates = input.rows.filter((row) => !row.id);

  if (updates.length) {
    await HostelAgreementModel.bulkWrite(
      updates.map((row) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(row.id), deletedAt: null, ...own },
          update: { $set: { ...fields(row), updatedBy: by } },
        },
      })),
    );
  }

  if (input.removed.length) {
    await HostelAgreementModel.updateMany(
      { _id: { $in: input.removed.map((id) => new Types.ObjectId(id)) }, deletedAt: null, ...own },
      { $set: { deletedAt: new Date(), updatedBy: by } },
    );
  }

  if (creates.length) {
    const run = await PlatformDocumentSequenceModel.findOneAndUpdate(
      RUN,
      { $inc: { sequence: creates.length } },
      { new: true, setDefaultsOnInsert: true, upsert: true },
    ).lean<{ sequence: number } | null>();
    // A failed insert below burns the block — a gap, never a code given twice.
    const first = (run?.sequence ?? creates.length) - creates.length + 1;
    const now = new Date();

    await HostelAgreementModel.insertMany(
      creates.map((row, index) => ({
        ...fields(row),
        createdBy: by,
        refCode: agreementRef(first + index, now),
        sequence: first + index,
        updatedBy: by,
      })),
    );
  }

  await publishTrackSheet(TRACK_SHEET_EVENT.SAVED, { userId: viewer.userId });

  return getTrackSheet(viewer);
}
