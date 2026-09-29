import { assertPlanRoom } from "@/modules/billing/plan-limits";
import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { afterResponse } from "@/lib/after-response";
import { logger } from "@/lib/logger";
import { bsPeriodBounds, hostelPeriodOf } from "@/lib/hostel-day";
import { runBillingCycle } from "@/modules/finance/billing.service";
import { normalizeBedType } from "@/modules/finance/bed-type";
import { allocateReferenceCode } from "@/modules/finance/reference-sequence.service";
import {
  claimBedForRoomType,
  releaseBedForRoomType,
} from "@/modules/hostels/hostel-capacity.service";
import {
  type CheckContext,
  type CheckResult,
  checkExistingResidents,
  type ListRow,
  monthLabel,
  moveInDateFor,
  type RoomTypeContext,
  sameRoomType,
  splitFullName,
  unpaidMonths,
} from "@/modules/residents/existing-residents-check";
import { defaultJoinedDate } from "@/modules/residents/existing-residents-cells";
import {
  buildExistingResidentsTemplate,
  readExistingResidentsFile,
} from "@/modules/residents/existing-residents-file";
import { notifyExistingResidentsAdded } from "@/modules/residents/existing-resident-notify";
import type { ExistingResidentRowInput } from "@/modules/residents/existing-residents.validation";
import { getIntakeQuote } from "@/modules/residents/resident-intake.service";
import {
  auditResidentAction,
  findAccountForIntake,
  linkResidentAccount,
  type ResidentRecord,
} from "@/modules/residents/resident.service";
import { findLiveResidency, liveResidencyMessage } from "@/modules/residents/live-residency";
import { ExistingResidentListModel } from "@hostel/db/models/ExistingResidentList";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { ResidentModel } from "@hostel/db/models/Resident";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

/**
 * Residents who were already living in a hostel when it joined
 * (docs/EXISTING_RESIDENTS.md, item 5).
 *
 * ## Why this is not `createResident` in a loop
 *
 * `createResident` is for somebody moving in today. After it saves the row it
 * raises the admission fee and deposit, bills the move-in month, applies a
 * referral and sends a welcome bill — all four wrong for somebody who moved in
 * last year and paid for all of it at the counter. This path shares the parts
 * that are about *the person* (the same duplicate rules, the same bed count, the
 * same account link) and none of the parts that are about *joining*.
 *
 * ## Who is told
 *
 * Every resident added hears once, by email and in the app when they have it:
 * paid till which month, or each month due and the old dues with their codes
 * (`existing-resident-notify.ts`). The staff get one summary.
 *
 * ## What gets billed
 *
 * Only what is still owed today: every month after "Rent paid till" up to this
 * month, through the normal billing run so the amounts and reference codes are
 * the same as any other month's, and one "Old dues" bill for anything else. The
 * months on or before "Rent paid till" are skipped by the billing run itself
 * (`Resident.paidTill`), so the monthly cron can never bill them later either.
 *
 * ## Safe to press twice, safe to retry
 *
 * A lock on the list stops two presses from adding the same people. Each row
 * records the resident it became the moment it is created, so a run that dies
 * half-way is finished by pressing again: added rows are skipped, the billing run
 * is idempotent by its own unique index, and an Old dues bill is looked for
 * before one is raised.
 */

export class ExistingResidentsError extends Error {
  constructor(
    message: string,
    public errorCode = "EXISTING_RESIDENTS_ERROR",
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * A run older than this is taken to have died with its function. Longer than the
 * add route's `maxDuration` (300 s), so a slow run is never mistaken for a dead one.
 */
const LOCK_STALE_MS = 6 * 60 * 1000;

export const OLD_DUES_LINE = `Old dues (before ${PLATFORM_NAME})`;

type StoredRow = {
  _id: Types.ObjectId;
  depositPaid?: number;
  email?: string;
  fullName?: string;
  joinedDate?: Date | null;
  monthlyRent?: number | null;
  oldDues?: number;
  paidTill?: string | null;
  phone?: string;
  residentId?: Types.ObjectId | null;
  roomType?: string;
};

type StoredList = {
  _id: Types.ObjectId;
  addedAt?: Date | null;
  addingSince?: Date | null;
  result?: {
    added?: number;
    billsRaised?: number;
    problems?: { message: string; name: string }[];
  };
  rows: StoredRow[];
  status: "ADDED" | "OPEN";
  updatedAt?: Date;
};

export type AddResult = {
  added: number;
  billsRaised: number;
  problems: { message: string; name: string }[];
};

export type ExistingResidentsView = {
  check: CheckResult | null;
  currentMonth: { label: string; period: string };
  hostel: { id: string; name: string };
  /** What the last "Add all" did, for the screen to say so. */
  lastAdded: (AddResult & { addedAt: string }) | null;
  list: { id: string; rows: ListRow[]; updatedAt: string | null } | null;
  roomTypes: { freeBeds: number; monthlyRent: number | null; roomType: string }[];
};

function toListRow(row: StoredRow): ListRow {
  return {
    depositPaid: row.depositPaid ?? 0,
    email: row.email ?? "",
    fullName: row.fullName ?? "",
    id: row._id.toString(),
    joinedDate: row.joinedDate ? new Date(row.joinedDate).toISOString() : null,
    monthlyRent: row.monthlyRent ?? null,
    oldDues: row.oldDues ?? 0,
    paidTill: row.paidTill ?? null,
    phone: row.phone ?? "",
    residentId: row.residentId ? row.residentId.toString() : null,
    roomType: row.roomType ?? "",
  };
}

async function loadHostel(hostelId: Types.ObjectId) {
  const hostel = await HostelModel.findOne({ _id: hostelId, isDeleted: { $ne: true } })
    .select("name slug roomConfigurations")
    .lean<{
      _id: Types.ObjectId;
      name?: string;
      roomConfigurations?: { roomType: string; vacantBeds?: number }[];
      slug?: string;
    } | null>();

  if (!hostel) {
    throw new ExistingResidentsError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  return hostel;
}

async function roomTypesFor(
  hostelId: Types.ObjectId,
  configurations: { roomType: string; vacantBeds?: number }[],
): Promise<RoomTypeContext[]> {
  // The intake's own quote, so "the normal rent" here is exactly what the
  // billing run will charge: the rate card first, the room list's rent after.
  return Promise.all(
    configurations
      .filter((config) => config.roomType?.trim())
      .map(async (config) => {
        const quote = await getIntakeQuote(hostelId, { roomType: config.roomType });

        return {
          monthlyRent: quote.monthlyRent,
          roomType: config.roomType,
          vacantBeds: config.vacantBeds ?? 0,
        };
      }),
  );
}

async function contextFor(
  hostelId: Types.ObjectId,
  rows: ListRow[],
  roomTypes: RoomTypeContext[],
): Promise<CheckContext> {
  const pending = rows.filter((row) => !row.residentId);
  const phones = [...new Set(pending.map((row) => row.phone).filter(Boolean))];
  const emails = [
    ...new Set(pending.map((row) => row.email.trim().toLowerCase()).filter(Boolean)),
  ];

  const [own, elsewhere] = await Promise.all([
    phones.length || emails.length
      ? ResidentModel.find({
          hostelId,
          isDeleted: { $ne: true },
          $or: [
            ...(phones.length ? [{ phone: { $in: phones } }] : []),
            ...(emails.length ? [{ email: { $in: emails } }] : []),
          ],
        })
          .select("email firstName lastName phone")
          .lean<{ email?: string; firstName?: string; lastName?: string; phone?: string }[]>()
      : Promise.resolve([]),
    emails.length
      ? ResidentModel.find({
          email: { $in: emails },
          hostelId: { $ne: hostelId },
          isDeleted: { $ne: true },
          status: { $in: ["ACTIVE", "PENDING", "SUSPENDED"] },
        })
          .select("email hostelId")
          .lean<{ email?: string; hostelId: Types.ObjectId }[]>()
      : Promise.resolve([]),
  ]);

  const takenPhones = new Map<string, string>();
  const takenEmails = new Map<string, string>();

  for (const resident of own) {
    const name = `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim() || "A resident";

    if (resident.phone) takenPhones.set(resident.phone, name);
    if (resident.email) takenEmails.set(resident.email.toLowerCase(), name);
  }

  const hostelNames = new Map<string, string>();

  if (elsewhere.length) {
    const hostels = await HostelModel.find({
      _id: { $in: [...new Set(elsewhere.map((row) => row.hostelId.toString()))] },
    })
      .select("name")
      .lean<{ _id: Types.ObjectId; name?: string }[]>();

    for (const hostel of hostels) {
      hostelNames.set(hostel._id.toString(), hostel.name?.trim() || "another hostel");
    }
  }

  return {
    currentPeriod: hostelPeriodOf(new Date()),
    livingElsewhere: new Map(
      elsewhere
        .filter((row) => row.email)
        .map((row) => [
          row.email!.toLowerCase(),
          hostelNames.get(row.hostelId.toString()) ?? "another hostel",
        ]),
    ),
    roomTypes,
    takenEmails,
    takenPhones,
  };
}

async function findOpenList(hostelId: Types.ObjectId) {
  return ExistingResidentListModel.findOne({ hostelId, status: "OPEN" }).lean<StoredList | null>();
}

export async function getExistingResidents(
  hostelId: Types.ObjectId,
): Promise<ExistingResidentsView> {
  await connectToDatabase();

  const hostel = await loadHostel(hostelId);
  const [list, latest, roomTypes] = await Promise.all([
    findOpenList(hostelId),
    ExistingResidentListModel.findOne({ addedAt: { $ne: null }, hostelId })
      .sort({ addedAt: -1 })
      .select("addedAt result")
      .lean<StoredList | null>(),
    roomTypesFor(hostelId, hostel.roomConfigurations ?? []),
  ]);

  const rows = (list?.rows ?? []).map(toListRow);
  const period = hostelPeriodOf(new Date());

  return {
    check: list ? checkExistingResidents(rows, await contextFor(hostelId, rows, roomTypes)) : null,
    currentMonth: { label: monthLabel(period), period },
    hostel: { id: hostelId.toString(), name: hostel.name ?? "" },
    lastAdded: latest?.addedAt
      ? {
          addedAt: new Date(latest.addedAt).toISOString(),
          added: latest.result?.added ?? 0,
          billsRaised: latest.result?.billsRaised ?? 0,
          problems: latest.result?.problems ?? [],
        }
      : null,
    list: list
      ? {
          id: list._id.toString(),
          rows,
          updatedAt: list.updatedAt ? new Date(list.updatedAt).toISOString() : null,
        }
      : null,
    roomTypes: roomTypes.map((room) => ({
      freeBeds: room.vacantBeds,
      monthlyRent: room.monthlyRent,
      roomType: room.roomType,
    })),
  };
}

function storedFromInput(row: ExistingResidentRowInput) {
  return {
    ...(row.id ? { _id: new Types.ObjectId(row.id) } : {}),
    depositPaid: row.depositPaid,
    email: row.email.toLowerCase(),
    fullName: row.fullName.replace(/\s+/g, " "),
    joinedDate:
      row.joinedDate ?? (row.paidTill ? defaultJoinedDate(row.paidTill, hostelPeriodOf(new Date())) : null),
    // Rent is the rate card's, read when the list is checked — never stored per line.
    monthlyRent: null,
    oldDues: row.oldDues,
    paidTill: row.paidTill,
    phone: row.phone,
    residentId: null,
    roomType: row.roomType,
  };
}

function assertNotAdding(list: StoredList | null) {
  if (list?.addingSince && Date.now() - new Date(list.addingSince).getTime() < LOCK_STALE_MS) {
    throw new ExistingResidentsError(
      "This list is being added right now. Wait a moment and open it again.",
      "EXISTING_RESIDENTS_BUSY",
      409,
    );
  }
}

async function writeRows(
  hostelId: Types.ObjectId,
  principal: ApiPrincipal,
  build: (current: StoredRow[]) => object[],
) {
  await connectToDatabase();
  await loadHostel(hostelId);

  const list = await findOpenList(hostelId);

  assertNotAdding(list);

  const next = build(list?.rows ?? []);

  if (next.length > 500) {
    throw new ExistingResidentsError(
      "A list can hold 500 residents. Add these first, then start a new list.",
      "EXISTING_RESIDENTS_TOO_MANY",
      422,
    );
  }

  if (list) {
    await ExistingResidentListModel.updateOne(
      { _id: list._id, status: "OPEN" },
      { $set: { rows: next, updatedBy: principal.userId } },
      { runValidators: true },
    );
  } else {
    try {
      await ExistingResidentListModel.create({
        createdBy: principal.userId,
        hostelId,
        rows: next,
        status: "OPEN",
        updatedBy: principal.userId,
      });
    } catch (error) {
      // Two devices starting a list at the same moment: the second one's rows
      // go onto the list the first one made.
      if ((error as { code?: number }).code !== 11000) throw error;

      await ExistingResidentListModel.updateOne(
        { hostelId, status: "OPEN" },
        { $push: { rows: { $each: next } }, $set: { updatedBy: principal.userId } },
      );
    }
  }
}

/**
 * Replaces the list with what the screen holds.
 *
 * Rows that are already residents are not the screen's to change: they are kept
 * exactly as stored, whatever was sent for them, and cannot be removed here.
 */
export async function saveExistingResidentRows(
  hostelId: Types.ObjectId,
  rows: ExistingResidentRowInput[],
  principal: ApiPrincipal,
) {
  await writeRows(hostelId, principal, (current) => {
    const added = new Map(
      current.filter((row) => row.residentId).map((row) => [row._id.toString(), row]),
    );
    const sent = rows.map((row) => (row.id && added.has(row.id) ? added.get(row.id)! : storedFromInput(row)));
    const sentIds = new Set(rows.map((row) => row.id).filter(Boolean));

    return [...sent, ...[...added.values()].filter((row) => !sentIds.has(row._id.toString()))];
  });

  return getExistingResidents(hostelId);
}

export async function addExistingResidentsFile(
  hostelId: Types.ObjectId,
  contentBase64: string,
  principal: ApiPrincipal,
) {
  const { notes, rows } = readExistingResidentsFile(
    Buffer.from(contentBase64, "base64"),
    hostelPeriodOf(new Date()),
  );

  await writeRows(hostelId, principal, (current) => [
    ...current,
    ...rows.map((row) => storedFromInput({ ...row, id: undefined })),
  ]);

  return { notes, read: rows.length, view: await getExistingResidents(hostelId) };
}

/** Removes the rows not yet added. Rows already added stay as the list's record. */
export async function clearExistingResidents(hostelId: Types.ObjectId) {
  await connectToDatabase();

  const list = await findOpenList(hostelId);

  assertNotAdding(list);

  if (list) {
    const added = list.rows.filter((row) => row.residentId);

    if (added.length === 0) {
      await ExistingResidentListModel.deleteOne({ _id: list._id, status: "OPEN" });
    } else {
      await ExistingResidentListModel.updateOne(
        { _id: list._id, status: "OPEN" },
        { $set: { rows: added, status: "ADDED" } },
      );
    }
  }

  return getExistingResidents(hostelId);
}

export async function existingResidentsTemplate(hostelId: Types.ObjectId) {
  await connectToDatabase();

  const hostel = await loadHostel(hostelId);
  const roomTypes = await roomTypesFor(hostelId, hostel.roomConfigurations ?? []);

  return {
    body: buildExistingResidentsTemplate({
      currentMonth: monthLabel(hostelPeriodOf(new Date())),
      hostelName: hostel.name ?? "your hostel",
      roomTypes,
    }),
    fileName: `${hostel.slug || "hostel"}-existing-residents.xlsx`,
  };
}

async function nonFatal(label: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    logger.error(`Existing residents: ${label} failed; the resident is added.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isDuplicateKey(error: unknown) {
  return (error as { code?: number })?.code === 11000;
}

export async function addExistingResidents(
  hostelId: Types.ObjectId,
  principal: ApiPrincipal,
  /** Add just this row (the scan desk's one person); the rest of the list is left alone. */
  onlyRowId?: string,
): Promise<{ result: AddResult; view: ExistingResidentsView }> {
  await connectToDatabase();

  const hostel = await loadHostel(hostelId);
  const now = new Date();

  const list = await ExistingResidentListModel.findOneAndUpdate(
    {
      hostelId,
      status: "OPEN",
      $or: [
        { addingSince: null },
        { addingSince: { $lt: new Date(now.getTime() - LOCK_STALE_MS) } },
      ],
    },
    { $set: { addingSince: now } },
    { new: true },
  ).lean<StoredList | null>();

  if (!list) {
    assertNotAdding(await findOpenList(hostelId));

    throw new ExistingResidentsError(
      "There is no list to add. Upload a file or add residents one by one first.",
      "EXISTING_RESIDENTS_EMPTY",
      404,
    );
  }

  const result: AddResult = { added: 0, billsRaised: 0, problems: [] };

  try {
    const rows = list.rows.map(toListRow).filter((row) => !onlyRowId || row.id === onlyRowId);
    const roomTypes = await roomTypesFor(hostelId, hostel.roomConfigurations ?? []);
    const check = checkExistingResidents(rows, await contextFor(hostelId, rows, roomTypes));

    if (check.toAdd > 0 && !check.ready) {
      throw new ExistingResidentsError(
        "Fix the problems in the list first.",
        "EXISTING_RESIDENTS_NOT_READY",
        422,
        { check },
      );
    }

    if (check.toAdd > 0) await assertPlanRoom(hostelId, "residents", check.toAdd);

    const residentIds = new Map<string, Types.ObjectId>();
    const addedNow: { rent: number | null; residentId: Types.ObjectId }[] = [];

    for (const row of rows) {
      if (row.residentId) {
        residentIds.set(row.id, new Types.ObjectId(row.residentId));
        continue;
      }

      const checked = check.rows.find((candidate) => candidate.id === row.id)!;
      const room = roomTypes.find((candidate) => sameRoomType(candidate.roomType, row.roomType))!;
      const name = splitFullName(row.fullName)!;

      try {
        await claimBedForRoomType(hostelId, room.roomType);
      } catch (error) {
        result.problems.push({
          message: error instanceof Error ? error.message : "No free bed.",
          name: row.fullName,
        });
        continue;
      }

      let resident: { _id: Types.ObjectId };

      try {
        resident = (await ResidentModel.create({
          admissionFee: null,
          bedType: normalizeBedType(room.roomType),
          createdBy: principal.userId,
          depositAmount: row.depositPaid,
          email: row.email.trim().toLowerCase() || undefined,
          existingListId: list._id,
          firstName: name.firstName,
          hostelId,
          isDeleted: false,
          lastName: name.lastName,
          monthlyFee: null,
          moveInDate: moveInDateFor(row),
          paidTill: row.paidTill,
          phone: row.phone,
          roomType: room.roomType,
          status: "ACTIVE",
          updatedBy: principal.userId,
        })) as unknown as { _id: Types.ObjectId };
      } catch (error) {
        await releaseBedForRoomType(hostelId, room.roomType);

        result.problems.push({
          message: isDuplicateKey(error)
            ? "Phone or email is already used in this hostel."
            : error instanceof Error
              ? error.message
              : "Could not be added.",
          name: row.fullName,
        });
        continue;
      }

      // Recorded before anything else, so a retry never adds this person twice.
      await ExistingResidentListModel.updateOne(
        { _id: list._id, "rows._id": new Types.ObjectId(row.id) },
        { $set: { "rows.$.residentId": resident._id } },
      );

      residentIds.set(row.id, resident._id);
      addedNow.push({ rent: checked.rent, residentId: resident._id });
      result.added += 1;

      await nonFatal("audit", () =>
        auditResidentAction(principal, hostelId, resident._id, "RESIDENT_CREATED", {
          existingListId: list._id.toString(),
          roomType: room.roomType,
          source: "EXISTING_RESIDENTS",
        }),
      );

      /*
       * No account is linked here, even when one exists with this email. The
       * email came from a spreadsheet; the person confirms it is them the next
       * time they sign in (`residency-invite.service.ts`).
       */
    }

    const currentPeriod = hostelPeriodOf(new Date());
    const { lastDay: dueDate } = bsPeriodBounds(currentPeriod);
    const addedRows = rows.filter((row) => residentIds.has(row.id));

    /*
     * Unpaid months, oldest first, each through the normal billing run so the
     * bill is exactly what any other month's would be. All due at the end of this
     * month rather than at the end of their own: a bill for Shrawan raised in
     * Aswin and already "overdue" the moment it exists would start the reminder
     * ladder at its angriest step.
     */
    const periods = [
      ...new Set(
        addedRows.flatMap((row) => (row.paidTill ? unpaidMonths(row.paidTill, currentPeriod) : [])),
      ),
    ].sort();

    for (const period of periods) {
      const ids = addedRows
        .filter((row) => row.paidTill && row.paidTill < period)
        .map((row) => residentIds.get(row.id)!);

      try {
        const run = await runBillingCycle({ dueDate, hostelId, period, residentIds: ids }, principal);

        result.billsRaised += run.billed.length;

        for (const failure of run.failures) {
          const row = addedRows.find(
            (candidate) => residentIds.get(candidate.id)?.toString() === failure.residentId,
          );

          result.problems.push({
            message: `${monthLabel(period)} rent was not billed: ${failure.message}`,
            name: row?.fullName ?? "A resident",
          });
        }
      } catch (error) {
        result.problems.push({
          message: `${monthLabel(period)} rent was not billed: ${
            error instanceof Error ? error.message : "billing failed"
          }`,
          name: `${ids.length} ${ids.length === 1 ? "resident" : "residents"}`,
        });
      }
    }

    const prefix = (
      await HostelModel.findById(hostelId)
        .select("referencePrefix")
        .lean<{ referencePrefix?: string } | null>()
    )?.referencePrefix;

    for (const row of addedRows.filter((candidate) => candidate.oldDues > 0)) {
      const residentId = residentIds.get(row.id)!;

      try {
        const existing = await InvoiceModel.exists({
          hostelId,
          kind: "ADJUSTMENT",
          "lines.description": OLD_DUES_LINE,
          residentId,
          status: { $ne: "VOID" },
        });

        if (existing) continue;

        await InvoiceModel.create({
          createdBy: principal.userId,
          dueDate,
          hostelId,
          kind: "ADJUSTMENT",
          lines: [{ amount: row.oldDues, basis: "MANUAL", description: OLD_DUES_LINE }],
          // Belongs to no month — see `one-off invoices have no period`.
          period: null,
          referenceCode: await allocateReferenceCode(hostelId, prefix),
          residentId,
          status: "OPEN",
          totalAmount: row.oldDues,
        });

        result.billsRaised += 1;
      } catch (error) {
        result.problems.push({
          message: `Old dues were not billed: ${error instanceof Error ? error.message : "failed"}`,
          name: row.fullName,
        });
      }
    }

    // The whole list, not `rows`: a one-row add must not close a list still holding others.
    const remaining = list.rows.filter(
      (row) => !row.residentId && !residentIds.has(row._id.toString()),
    ).length;

    await ExistingResidentListModel.updateOne(
      { _id: list._id },
      {
        $set: {
          addedAt: new Date(),
          addedBy: principal.userId,
          addingSince: null,
          result,
          status: remaining === 0 ? "ADDED" : "OPEN",
        },
      },
    );

    /*
     * Last, and after the response: each resident added in this press hears once
     * — paid till when, or what is due and by when — and the staff get one
     * summary. Residents added by an earlier press were told then.
     */
    afterResponse(() =>
      notifyExistingResidentsAdded({
        added: addedNow,
        billsRaised: result.billsRaised,
        hostelId,
        principal,
      }),
    );
  } catch (error) {
    await ExistingResidentListModel.updateOne({ _id: list._id }, { $set: { addingSince: null } });

    throw error;
  }

  return { result, view: await getExistingResidents(hostelId) };
}

/**
 * One person scanned at the desk who already lived here before the hostel
 * joined — the "Add as existing resident" switch on the intake's bed step.
 *
 * The same path as "Add all", run on a single row: the row goes onto the open
 * list, only that row is added, and a row that could not be added is taken back
 * off so the warden's own list is never left holding it. Unlike a spreadsheet
 * row, the card resolved an exact account, so it is linked on the spot.
 */
export async function addScannedExistingResident(
  hostelId: Types.ObjectId,
  row: ExistingResidentRowInput,
  userResidentId: string | undefined,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const account = await findAccountForIntake(row.email || undefined, userResidentId);
  const residency = await findLiveResidency(
    { emails: [row.email, account.email], userIds: [account.userId] },
    hostelId,
  );

  if (residency) {
    throw new ExistingResidentsError(
      liveResidencyMessage(row.fullName, residency),
      residency.sameHostel ? "RESIDENT_ALREADY_HERE" : "RESIDENT_LIVES_ELSEWHERE",
      409,
    );
  }

  const rowId = new Types.ObjectId();

  await writeRows(hostelId, principal, (current) => [
    ...current,
    { ...storedFromInput({ ...row, id: undefined }), _id: rowId },
  ]);

  const takeBack = () =>
    ExistingResidentListModel.updateOne(
      { hostelId, status: "OPEN" },
      { $pull: { rows: { _id: rowId, residentId: null } } },
    );

  let result: AddResult;

  try {
    ({ result } = await addExistingResidents(hostelId, principal, rowId.toString()));
  } catch (error) {
    await takeBack();

    const check = (error as ExistingResidentsError).details as { check?: CheckResult } | undefined;
    const reason = [
      ...(check?.check?.listProblems ?? []),
      ...(check?.check?.rows[0]?.problems.map((problem) => problem.message) ?? []),
    ][0];

    if (reason) throw new ExistingResidentsError(reason, "EXISTING_RESIDENT_NOT_READY", 422);

    throw error;
  }

  if (result.added === 0) {
    await takeBack();

    throw new ExistingResidentsError(
      result.problems[0]?.message ?? "They could not be added.",
      "EXISTING_RESIDENT_NOT_ADDED",
      409,
    );
  }

  const residentId = (
    await ExistingResidentListModel.findOne({ hostelId, "rows._id": rowId })
      .select({ "rows.$": 1 })
      .lean<{ rows: StoredRow[] } | null>()
  )?.rows[0]?.residentId;

  const resident = residentId
    ? await ResidentModel.findById(residentId).lean<ResidentRecord | null>()
    : null;

  if (resident) {
    // The "added" notice already tells them; no second welcome mail.
    await nonFatal("account link", () =>
      linkResidentAccount(resident, hostelId, principal, userResidentId, false, account),
    );
  }

  return { residentId: residentId?.toString() ?? null, result };
}
