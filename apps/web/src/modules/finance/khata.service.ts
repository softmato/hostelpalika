import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { formatBsPeriod } from "@/lib/hostel-day";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { findCurrentResident } from "@/modules/residents/resident-access";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { KhataEntryModel } from "@hostel/db/models/KhataEntry";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * Khata — what a resident takes from the hostel on account.
 *
 * The hostel keeps a short price list (egg, extra meal, laundry). A resident asks
 * staff to open their khata; once it is open they ask for an item, the cook (or
 * staff) hands it over, and from then it is owed. Everything handed over before a
 * month starts goes onto that month's rent bill as one `Khata` line — see
 * `runBillingCycle` — so there is no second bill and no second payment.
 */

export type KhataStatus = "NONE" | "REQUESTED" | "ACTIVE" | "DECLINED" | "CLOSED";

/** Waiting asks a resident may have at once — a list, not a flood. */
const MAX_WAITING = 10;

export const khataItemsSchema = z.object({
  hostelId: z.string().optional(),
  items: z
    .array(
      z.object({
        active: z.boolean().default(true),
        id: z.string().optional(),
        /** A PUBLIC upload — the item photo residents pick from. */
        imageAssetId: z.string().regex(/^[a-f\d]{24}$/i).nullish(),
        name: z.string().trim().min(1).max(40),
        price: z.number().int().min(1).max(100000),
      }),
    )
    .max(60),
});

export const khataAccountDecisionSchema = z.object({
  action: z.enum(["APPROVE", "DECLINE", "CLOSE"]),
  hostelId: z.string().optional(),
});

export const khataOrderDecisionSchema = z.object({
  action: z.enum(["GIVE", "DECLINE"]),
  hostelId: z.string().optional(),
});

export const residentKhataActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("OPEN") }),
  z.object({
    action: z.literal("ASK"),
    itemId: z.string(),
    note: z.string().trim().max(120).optional(),
    quantity: z.number().int().min(1).max(20),
  }),
  z.object({ action: z.literal("CANCEL"), entryId: z.string() }),
]);

type ItemRecord = {
  _id: Types.ObjectId;
  active?: boolean;
  imageAssetId?: Types.ObjectId | null;
  name: string;
  price: number;
};

type EntryRecord = {
  _id: Types.ObjectId;
  amount: number;
  createdAt: Date;
  decidedAt?: Date;
  invoiceId?: Types.ObjectId | null;
  name: string;
  note?: string;
  quantity: number;
  residentId: Types.ObjectId;
  status: string;
  unitPrice: number;
};

type ResidentLite = {
  _id: Types.ObjectId;
  firstName?: string;
  khata?: { requestedAt?: Date; status?: KhataStatus };
  lastName?: string;
  roomNumber?: string;
  userId?: Types.ObjectId;
};

function fullName(resident?: ResidentLite | null) {
  return `${resident?.firstName ?? ""} ${resident?.lastName ?? ""}`.trim() || "Resident";
}

function toItem(item: ItemRecord) {
  return {
    active: item.active !== false,
    id: item._id.toString(),
    imageAssetId: item.imageAssetId?.toString() ?? null,
    name: item.name,
    price: item.price,
  };
}

function toEntry(entry: EntryRecord, resident?: ResidentLite) {
  return {
    amount: entry.amount,
    billed: Boolean(entry.invoiceId),
    createdAt: entry.createdAt.toISOString(),
    decidedAt: entry.decidedAt?.toISOString() ?? null,
    id: entry._id.toString(),
    name: entry.name,
    note: entry.note ?? null,
    quantity: entry.quantity,
    resident: resident
      ? {
          id: resident._id.toString(),
          name: fullName(resident),
          roomNumber: resident.roomNumber ?? null,
        }
      : null,
    status: entry.status,
    unitPrice: entry.unitPrice,
  };
}

async function readItems(hostelId: Types.ObjectId | string): Promise<ItemRecord[]> {
  const row = await HostelSettingsModel.findOne({ hostelId })
    .select("khataItems")
    .lean<{ khataItems?: ItemRecord[] } | null>();

  return row?.khataItems ?? [];
}

async function residentsById(ids: Types.ObjectId[]) {
  const residents = await ResidentModel.find({ _id: { $in: ids } })
    .select("firstName lastName roomNumber userId khata")
    .lean<ResidentLite[]>();

  return new Map(residents.map((resident) => [resident._id.toString(), resident]));
}

function changed(hostelId: Types.ObjectId | string) {
  return publishResourceChange({
    hostelIds: [String(hostelId)],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });
}

async function notify(userIds: string[], title: string, body: string, hostelId: string) {
  await Promise.all(
    userIds.map((userId) =>
      createInAppNotification({ body, category: "PAYMENT", hostelId, title, userId }).catch(
        () => undefined,
      ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Staff                                                                       */
/* -------------------------------------------------------------------------- */

/** Everything the warden's Khata screen draws, in one read. */
export async function getKhataOverview(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const [items, residents, unbilled, waiting] = await Promise.all([
    readItems(hostelId),
    ResidentModel.find({
      hostelId,
      isDeleted: { $ne: true },
      "khata.status": { $in: ["REQUESTED", "ACTIVE"] },
    })
      .select("firstName lastName roomNumber khata")
      .lean<ResidentLite[]>(),
    KhataEntryModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
      {
        $match: {
          hostelId: new Types.ObjectId(String(hostelId)),
          invoiceId: null,
          status: "GIVEN",
        },
      },
      { $group: { _id: "$residentId", amount: { $sum: "$amount" } } },
    ]),
    listKhataOrders(hostelId),
  ]);

  const unbilledBy = new Map(unbilled.map((row) => [row._id.toString(), row.amount]));
  const row = (resident: ResidentLite) => ({
    id: resident._id.toString(),
    name: fullName(resident),
    requestedAt: resident.khata?.requestedAt?.toISOString() ?? null,
    roomNumber: resident.roomNumber ?? null,
    unbilled: unbilledBy.get(resident._id.toString()) ?? 0,
  });

  return {
    accounts: residents
      .filter((resident) => resident.khata?.status === "ACTIVE")
      .map(row)
      .sort((left, right) => right.unbilled - left.unbilled || left.name.localeCompare(right.name)),
    items: items.map(toItem),
    requests: residents
      .filter((resident) => resident.khata?.status === "REQUESTED")
      .map(row),
    ...waiting,
  };
}

export async function saveKhataItems(
  hostelId: Types.ObjectId | string,
  items: z.infer<typeof khataItemsSchema>["items"],
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const next = items.map((item) => ({
    _id: item.id && Types.ObjectId.isValid(item.id) ? new Types.ObjectId(item.id) : new Types.ObjectId(),
    active: item.active,
    imageAssetId: item.imageAssetId ? new Types.ObjectId(item.imageAssetId) : null,
    name: item.name,
    price: item.price,
  }));

  await HostelSettingsModel.updateOne(
    { hostelId },
    {
      $set: { khataItems: next, updatedBy: principal.userId },
      $setOnInsert: { createdBy: principal.userId },
    },
    { upsert: true },
  );
  await changed(hostelId);

  return next.map(toItem);
}

export async function decideKhataAccount(
  hostelId: Types.ObjectId | string,
  residentId: string,
  action: z.infer<typeof khataAccountDecisionSchema>["action"],
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(residentId)) {
    throw new FinanceServiceError("Resident was not found.", "KHATA_ENTRY_NOT_FOUND");
  }

  const status = action === "APPROVE" ? "ACTIVE" : action === "DECLINE" ? "DECLINED" : "CLOSED";
  const resident = await ResidentModel.findOneAndUpdate(
    { _id: residentId, hostelId, isDeleted: { $ne: true } },
    {
      $set: {
        "khata.decidedAt": new Date(),
        "khata.decidedBy": principal.userId,
        "khata.status": status,
      },
    },
    { new: true },
  )
    .select("firstName lastName userId")
    .lean<ResidentLite | null>();

  if (!resident) {
    throw new FinanceServiceError("Resident was not found.", "KHATA_ENTRY_NOT_FOUND");
  }

  if (resident.userId) {
    await notify(
      [resident.userId.toString()],
      status === "ACTIVE" ? "Your khata is open" : "Khata",
      status === "ACTIVE"
        ? "Ask for items from the Khata screen. What you take is added to next month's bill."
        : status === "DECLINED"
          ? "The hostel did not open a khata for you."
          : "Your khata is closed. Anything already taken stays on your next bill.",
      String(hostelId),
    );
  }

  await changed(hostelId);

  return { residentId, status };
}

/* -------------------------------------------------------------------------- */
/* Cook and staff — the asks                                                   */
/* -------------------------------------------------------------------------- */

/** Asks still waiting, and what was handed over or refused in the last day. */
export async function listKhataOrders(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [waiting, recent] = await Promise.all([
    KhataEntryModel.find({ hostelId, status: "REQUESTED" })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean<EntryRecord[]>(),
    KhataEntryModel.find({
      decidedAt: { $gte: since },
      hostelId,
      status: { $in: ["GIVEN", "DECLINED"] },
    })
      .sort({ decidedAt: -1 })
      .limit(50)
      .lean<EntryRecord[]>(),
  ]);

  const people = await residentsById([...waiting, ...recent].map((entry) => entry.residentId));

  return {
    recent: recent.map((entry) => toEntry(entry, people.get(entry.residentId.toString()))),
    waiting: waiting.map((entry) => toEntry(entry, people.get(entry.residentId.toString()))),
  };
}

export async function decideKhataOrder(
  hostelId: Types.ObjectId | string,
  entryId: string,
  action: z.infer<typeof khataOrderDecisionSchema>["action"],
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(entryId)) {
    throw new FinanceServiceError("That ask was not found.", "KHATA_ENTRY_NOT_FOUND");
  }

  const entry = await KhataEntryModel.findOneAndUpdate(
    { _id: entryId, hostelId, status: "REQUESTED" },
    {
      $set: {
        decidedAt: new Date(),
        decidedBy: principal.userId,
        status: action === "GIVE" ? "GIVEN" : "DECLINED",
      },
    },
    { new: true },
  ).lean<EntryRecord | null>();

  if (!entry) {
    const exists = await KhataEntryModel.exists({ _id: entryId, hostelId });

    throw exists
      ? new FinanceServiceError("Someone already answered this ask.", "KHATA_ENTRY_DECIDED")
      : new FinanceServiceError("That ask was not found.", "KHATA_ENTRY_NOT_FOUND");
  }

  const resident = await ResidentModel.findById(entry.residentId)
    .select("userId")
    .lean<{ userId?: Types.ObjectId } | null>();

  if (resident?.userId) {
    await notify(
      [resident.userId.toString()],
      action === "GIVE" ? `${entry.name} ×${entry.quantity} given` : `${entry.name} not available`,
      action === "GIVE"
        ? `Rs ${entry.amount.toLocaleString("en-US")} added to your khata — it goes on next month's bill.`
        : "Nothing was added to your khata.",
      String(hostelId),
    );
  }

  await changed(hostelId);

  return toEntry(entry);
}

/* -------------------------------------------------------------------------- */
/* Resident                                                                    */
/* -------------------------------------------------------------------------- */

export async function getResidentKhata(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as unknown as ResidentLite & {
    hostelId: Types.ObjectId;
  };
  const [items, entries, billed] = await Promise.all([
    readItems(resident.hostelId),
    KhataEntryModel.find({ residentId: resident._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<EntryRecord[]>(),
    KhataEntryModel.aggregate<{ _id: Types.ObjectId; amount: number; items: number }>([
      { $match: { invoiceId: { $ne: null }, residentId: resident._id, status: "GIVEN" } },
      { $group: { _id: "$invoiceId", amount: { $sum: "$amount" }, items: { $sum: "$quantity" } } },
    ]),
  ]);

  const invoices = billed.length
    ? await InvoiceModel.find({ _id: { $in: billed.map((row) => row._id) }, status: { $ne: "VOID" } })
        .select("period status issuedAt")
        .lean<{ _id: Types.ObjectId; issuedAt?: Date; period?: string | null; status: string }[]>()
    : [];
  const byInvoice = new Map(billed.map((row) => [row._id.toString(), row]));

  return {
    /** Every rent bill that carried khata, newest first — what was billed, and whether it is paid. */
    bills: invoices
      .sort((left, right) => (right.period ?? "").localeCompare(left.period ?? ""))
      .map((invoice) => ({
        amount: byInvoice.get(invoice._id.toString())?.amount ?? 0,
        invoiceId: invoice._id.toString(),
        items: byInvoice.get(invoice._id.toString())?.items ?? 0,
        label: invoice.period ? formatBsPeriod(invoice.period) || invoice.period : "Bill",
        paid: invoice.status === "PAID",
      })),
    entries: entries.map((entry) => toEntry(entry)),
    items: items.filter((item) => item.active !== false).map(toItem),
    status: (resident.khata?.status ?? "NONE") as KhataStatus,
    /** Handed over and not yet on a bill — what next month's bill will add. */
    unbilled: entries
      .filter((entry) => entry.status === "GIVEN" && !entry.invoiceId)
      .reduce((sum, entry) => sum + entry.amount, 0),
  };
}

export async function residentKhataAction(
  principal: ApiPrincipal,
  input: z.infer<typeof residentKhataActionSchema>,
) {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as unknown as ResidentLite & {
    hostelId: Types.ObjectId;
  };
  const hostelId = resident.hostelId.toString();
  const status = resident.khata?.status ?? "NONE";

  if (input.action === "OPEN") {
    if (status !== "ACTIVE" && status !== "REQUESTED") {
      await ResidentModel.updateOne(
        { _id: resident._id },
        { $set: { khata: { requestedAt: new Date(), status: "REQUESTED" } } },
      );
      await notify(
        await resolveHostelStaffUserIds(hostelId),
        "Khata request",
        `${fullName(resident)}${resident.roomNumber ? ` (room ${resident.roomNumber})` : ""} asked to open a khata.`,
        hostelId,
      );
      await changed(hostelId);
    }

    return getResidentKhata(principal);
  }

  if (input.action === "CANCEL") {
    const result = await KhataEntryModel.updateOne(
      { _id: Types.ObjectId.isValid(input.entryId) ? input.entryId : null, residentId: resident._id, status: "REQUESTED" },
      { $set: { decidedAt: new Date(), status: "CANCELLED" } },
    );

    if (result.modifiedCount === 0) {
      throw new FinanceServiceError("It was already answered.", "KHATA_ENTRY_DECIDED");
    }

    await changed(hostelId);

    return getResidentKhata(principal);
  }

  if (status !== "ACTIVE") {
    throw new FinanceServiceError("Your khata is not open yet.", "KHATA_NOT_ACTIVE");
  }

  const item = (await readItems(hostelId)).find(
    (row) => row._id.toString() === input.itemId && row.active !== false,
  );

  if (!item) {
    throw new FinanceServiceError("That item is not on the list any more.", "KHATA_ITEM_NOT_FOUND");
  }

  const waiting = await KhataEntryModel.countDocuments({
    residentId: resident._id,
    status: "REQUESTED",
  });

  if (waiting >= MAX_WAITING) {
    throw new FinanceServiceError(
      `You have ${waiting} asks waiting. Wait for the cook to answer them first.`,
      "KHATA_ENTRY_DECIDED",
    );
  }

  await KhataEntryModel.create({
    amount: item.price * input.quantity,
    hostelId,
    itemId: item._id,
    name: item.name,
    note: input.note || undefined,
    quantity: input.quantity,
    residentId: resident._id,
    unitPrice: item.price,
  });

  const cooks = await CookAccountModel.find({
    hostelId,
    status: "ACTIVE",
    userId: { $ne: null },
  })
    .select("userId")
    .lean<{ userId: Types.ObjectId }[]>();

  await notify(
    cooks.length > 0
      ? cooks.map((cook) => cook.userId.toString())
      : await resolveHostelStaffUserIds(hostelId),
    `${item.name} ×${input.quantity}`,
    `${fullName(resident)}${resident.roomNumber ? `, room ${resident.roomNumber}` : ""} asked on khata.${input.note ? ` “${input.note}”` : ""}`,
    hostelId,
  );
  await changed(hostelId);

  return getResidentKhata(principal);
}

/* -------------------------------------------------------------------------- */
/* Billing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Handed-over khata not yet on any bill, per resident — everything given before
 * `before` (the month's first day), so this month's khata waits for next month.
 */
export async function unbilledKhata(
  residentIds: Types.ObjectId[],
  before: Date,
): Promise<Map<string, { amount: number; description: string; entryIds: Types.ObjectId[] }>> {
  const entries = await KhataEntryModel.find({
    decidedAt: { $lt: before },
    invoiceId: null,
    residentId: { $in: residentIds },
    status: "GIVEN",
  })
    .select("amount name quantity residentId")
    .lean<EntryRecord[]>();

  const byResident = new Map<string, EntryRecord[]>();

  for (const entry of entries) {
    const key = entry.residentId.toString();
    byResident.set(key, [...(byResident.get(key) ?? []), entry]);
  }

  return new Map(
    [...byResident].map(([residentId, rows]) => {
      const counts = new Map<string, number>();

      for (const row of rows) {
        counts.set(row.name, (counts.get(row.name) ?? 0) + row.quantity);
      }

      const summary = [...counts].map(([name, quantity]) => `${name} ×${quantity}`).join(", ");

      return [
        residentId,
        {
          amount: rows.reduce((sum, row) => sum + row.amount, 0),
          description: `Khata — ${summary.length > 90 ? `${summary.slice(0, 87)}…` : summary}`,
          entryIds: rows.map((row) => row._id),
        },
      ];
    }),
  );
}

export async function markKhataBilled(entryIds: Types.ObjectId[], invoiceId: Types.ObjectId) {
  if (entryIds.length > 0) {
    await KhataEntryModel.updateMany(
      { _id: { $in: entryIds }, invoiceId: null },
      { $set: { invoiceId } },
    );
  }
}

/** A voided bill gives its khata back, so the next bill picks it up. */
export async function releaseKhata(invoiceId: Types.ObjectId) {
  await KhataEntryModel.updateMany({ invoiceId }, { $set: { invoiceId: null } });
}
