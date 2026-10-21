import type { Types } from "mongoose";
import * as XLSX from "xlsx";

import { toCsv } from "@/lib/csv";
import { zipStream } from "@/lib/zip-stream";

import { hostelCalendarDay, toBs } from "@hostel/shared/calendar/bs";
import { AttendanceLogModel } from "@hostel/db/models/AttendanceLog";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { DepositRecordModel } from "@hostel/db/models/DepositRecord";
import { ExpenseModel } from "@hostel/db/models/Expense";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { FoodRoutineModel } from "@hostel/db/models/FoodRoutine";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelRoomModel } from "@hostel/db/models/HostelRoom";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { KhataEntryModel } from "@hostel/db/models/KhataEntry";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { NoticeModel } from "@hostel/db/models/Notice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ResidentModel } from "@hostel/db/models/Resident";
import { StockEntryModel } from "@hostel/db/models/StockEntry";
import { UserModel } from "@hostel/db/models/User";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import {
  HOSTEL_LEAVE_SECTIONS,
  type HostelLeaveSection,
} from "@hostel/shared/constants/hostel-leave";
import type { EmailAttachment } from "@hostel/shared/email/sender";

/**
 * A leaving hostel's data, handed back to its owner (docs/HOSTEL_LEAVE_PLATFORM.md).
 *
 * Two files of the same data, built to be used somewhere else:
 *
 * - **A workbook** for people: an About sheet that says what the hostel is, what
 *   period it covers, what each sheet holds and how they link; then one sheet
 *   per section with a filter on the header row.
 * - **JSON** for software: the same rows under the same section keys, with
 *   snake_case field names, so another system can import it without anyone
 *   retyping a column.
 *
 * Kept clean on purpose — every value is plain: dates `YYYY-MM-DD` in Nepal's
 * own day (with a BS twin beside each sheet's main date), months as BS periods
 * (`2083-05`), money as whole rupees with no symbol, statuses in words, and an
 * id on every person, bill and payment so the sheets join to each other.
 *
 * Row dumps, unlike `report-export.service.ts`: it is the owner's own record of
 * their own hostel, from its first day to today, and the last copy they get.
 */

// ponytail: per-sheet row ceiling keeps the email under Resend's 40 MB; split a
// sheet across files if a hostel ever outgrows it.
export const LEAVE_EXPORT_ROW_CAP = 100_000;

type Cell = string | number | null;
type Row = Record<string, Cell>;
type Column = { header: string; key: string };
type Lookup = {
  hostel: (id: unknown) => string;
  resident: (id: unknown) => string;
};

type AnyLean = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NEPAL_OFFSET_MS = 345 * 60_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** `2026-10-21` — the Nepal day an instant falls on. **Pure.** */
export function adDate(value: unknown): Cell {
  const date = toDate(value);

  return date ? hostelCalendarDay(date).toISOString().slice(0, 10) : null;
}

/** `2083-07-05` — the same day in Bikram Sambat. **Pure.** */
export function bsDate(value: unknown): Cell {
  const date = toDate(value);

  if (!date) return null;

  const bs = toBs(date);

  return `${bs.year}-${pad(bs.month)}-${pad(bs.day)}`;
}

/** `2026-10-21 18:42` in Nepal time. **Pure.** */
export function adDateTime(value: unknown): Cell {
  const date = toDate(value);

  return date ? new Date(date.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") : null;
}

/** `MOVED_OUT` → `Moved out`. **Pure.** */
export function words(value: unknown): Cell {
  if (typeof value !== "string" || !value) return null;

  const spaced = value.replaceAll("_", " ").toLowerCase();

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function toDate(value: unknown) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date;
}

const money = (value: unknown): Cell => (typeof value === "number" ? value : null);
const text = (value: unknown): Cell => (value === undefined || value === null || value === "" ? null : String(value));
const id = (value: unknown): Cell => (value ? String(value) : null);
const name = (row: AnyLean) => `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();

/** A sheet: its columns, and how to read its rows. Oldest first, like a ledger. */
type SectionSpec = { columns: Column[]; rows: (ids: Types.ObjectId[], lookup: Lookup) => Promise<Row[]> };

const col = (key: string, header: string): Column => ({ header, key });
const HOSTEL = col("hostel", "Hostel");

const SECTIONS: Record<HostelLeaveSection, SectionSpec> = {
  residents: {
    columns: [
      col("resident_id", "Resident ID"),
      HOSTEL,
      col("name", "Name"),
      col("phone", "Phone"),
      col("email", "Email"),
      col("resident_type", "Type"),
      col("room", "Room"),
      col("floor", "Floor"),
      col("status", "Status"),
      col("moved_in", "Moved in"),
      col("moved_in_bs", "Moved in (BS)"),
      col("moved_out", "Moved out"),
      col("monthly_fee", "Monthly fee (Rs)"),
      col("deposit", "Deposit (Rs)"),
      col("admission_fee", "Admission fee (Rs)"),
      col("paid_till", "Paid till"),
    ],
    rows: async (ids, lookup) =>
      (await ResidentModel.find({ hostelId: { $in: ids } })
        .sort({ moveInDate: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .select("hostelId firstName lastName phone email residentType roomNumber floor status moveInDate moveOutDate monthlyFee depositAmount admissionFee paidTill isDeleted")
        .lean<AnyLean[]>()).map((row) => ({
        admission_fee: money(row.admissionFee),
        deposit: money(row.depositAmount),
        email: text(row.email),
        floor: text(row.floor),
        hostel: lookup.hostel(row.hostelId),
        monthly_fee: money(row.monthlyFee),
        moved_in: adDate(row.moveInDate),
        moved_in_bs: bsDate(row.moveInDate),
        moved_out: adDate(row.moveOutDate),
        name: name(row),
        paid_till: text(row.paidTill),
        phone: text(row.phone),
        resident_id: id(row._id),
        resident_type: words(row.residentType),
        room: text(row.roomNumber),
        status: row.isDeleted ? "Removed" : words(row.status),
      })),
  },
  rooms: {
    columns: [HOSTEL, col("floor", "Floor"), col("room", "Room"), col("room_type", "Room type"), col("beds", "Beds")],
    rows: async (ids, lookup) =>
      (await HostelRoomModel.find({ hostelId: { $in: ids }, isDeleted: { $ne: true } })
        .sort({ floor: 1, number: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        beds: typeof row.beds === "number" ? row.beds : null,
        floor: typeof row.floor === "number" ? row.floor : null,
        hostel: lookup.hostel(row.hostelId),
        room: text(row.number),
        room_type: words(row.roomType),
      })),
  },
  bills: {
    columns: [
      col("bill_id", "Bill ID"),
      HOSTEL,
      col("reference", "Reference"),
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("month", "Month (BS)"),
      col("kind", "Kind"),
      col("issued", "Issued"),
      col("issued_bs", "Issued (BS)"),
      col("due", "Due"),
      col("amount", "Amount (Rs)"),
      col("paid", "Paid (Rs)"),
      col("balance", "Balance (Rs)"),
      col("status", "Status"),
    ],
    rows: async (ids, lookup) => {
      const [invoices, paid] = await Promise.all([
        InvoiceModel.find({ hostelId: { $in: ids } })
          .sort({ issuedAt: 1 })
          .limit(LEAVE_EXPORT_ROW_CAP)
          .select("hostelId issuedAt referenceCode residentId period kind totalAmount dueDate status")
          .lean<AnyLean[]>(),
        PaymentEventModel.aggregate<{ _id: Types.ObjectId; total: number }>([
          { $match: { direction: "CREDIT", hostelId: { $in: ids }, invoiceId: { $ne: null }, status: "SETTLED" } },
          { $group: { _id: "$invoiceId", total: { $sum: "$amount" } } },
        ]),
      ]);
      const paidBy = new Map(paid.map((row) => [row._id.toString(), row.total]));

      return invoices.map((row) => {
        const amount = typeof row.totalAmount === "number" ? row.totalAmount : 0;
        const settled = paidBy.get(row._id.toString()) ?? 0;

        return {
          amount,
          balance: Math.max(0, amount - settled),
          bill_id: id(row._id),
          due: adDate(row.dueDate),
          hostel: lookup.hostel(row.hostelId),
          issued: adDate(row.issuedAt),
          issued_bs: bsDate(row.issuedAt),
          kind: words(row.kind),
          month: text(row.period),
          paid: settled,
          reference: text(row.referenceCode),
          resident: lookup.resident(row.residentId),
          resident_id: id(row.residentId),
          status: words(row.status),
        };
      });
    },
  },
  payments: {
    columns: [
      col("payment_id", "Payment ID"),
      HOSTEL,
      col("date", "Date"),
      col("date_bs", "Date (BS)"),
      col("direction", "In / out"),
      col("amount", "Amount (Rs)"),
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("bill_id", "Bill ID"),
      col("paid_by", "Paid by"),
      col("transaction_id", "Transaction ID"),
      col("reference", "Reference"),
      col("status", "Status"),
    ],
    rows: async (ids, lookup) =>
      (await PaymentEventModel.find({ hostelId: { $in: ids } })
        .sort({ occurredAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .select("hostelId occurredAt residentId invoiceId direction amount provider providerTxnId referenceCode status")
        .lean<AnyLean[]>()).map((row) => ({
        amount: money(row.amount),
        bill_id: id(row.invoiceId),
        date: adDate(row.occurredAt),
        date_bs: bsDate(row.occurredAt),
        direction: row.direction === "DEBIT" ? "Out" : "In",
        hostel: lookup.hostel(row.hostelId),
        paid_by: words(row.provider),
        payment_id: id(row._id),
        reference: text(row.referenceCode),
        resident: lookup.resident(row.residentId),
        resident_id: id(row.residentId),
        status: words(row.status),
        transaction_id: text(row.providerTxnId),
      })),
  },
  receipts: {
    columns: [
      col("receipt_number", "Receipt no"),
      HOSTEL,
      col("issued", "Issued"),
      col("issued_bs", "Issued (BS)"),
      col("month", "Month (BS)"),
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("bill_id", "Bill ID"),
      col("payment_id", "Payment ID"),
      col("amount", "Amount (Rs)"),
      col("certification_code", "Certification code"),
      col("voided", "Voided"),
    ],
    rows: async (ids, lookup) =>
      (await ReceiptModel.find({ hostelId: { $in: ids } })
        .sort({ issuedAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        amount: money(row.amount),
        bill_id: id(row.invoiceId),
        certification_code: text(row.certificationCode),
        hostel: lookup.hostel(row.hostelId),
        issued: adDate(row.issuedAt),
        issued_bs: bsDate(row.issuedAt),
        month: text(row.month),
        payment_id: id(row.eventId ?? row.paymentId),
        receipt_number: text(row.receiptNumber),
        resident: lookup.resident(row.residentId),
        resident_id: id(row.residentId),
        voided: adDate(row.voidedAt),
      })),
  },
  deposits: {
    columns: [
      HOSTEL,
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("amount", "Amount (Rs)"),
      col("paid", "Paid on"),
      col("status", "Status"),
      col("refunded", "Refunded on"),
      col("refunded_amount", "Refunded (Rs)"),
      col("remarks", "Remarks"),
    ],
    rows: async (ids, lookup) =>
      (await DepositRecordModel.find({ hostelId: { $in: ids } })
        .sort({ paidDate: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        amount: money(row.amount),
        hostel: lookup.hostel(row.hostelId),
        paid: adDate(row.paidDate),
        refunded: adDate(row.refundedDate),
        refunded_amount: money(row.refundedAmount),
        remarks: text(row.remarks),
        resident: lookup.resident(row.residentId),
        resident_id: id(row.residentId),
        status: words(row.status),
      })),
  },
  khata: {
    columns: [
      HOSTEL,
      col("date", "Date"),
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("item", "Item"),
      col("quantity", "Quantity"),
      col("unit_price", "Price (Rs)"),
      col("amount", "Amount (Rs)"),
      col("bill_id", "Billed on (Bill ID)"),
      col("status", "Status"),
      col("note", "Note"),
    ],
    rows: async (ids, lookup) =>
      (await KhataEntryModel.find({ hostelId: { $in: ids } })
        .sort({ createdAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        amount: money(row.amount),
        bill_id: id(row.invoiceId),
        date: adDate(row.createdAt),
        hostel: lookup.hostel(row.hostelId),
        item: text(row.name),
        note: text(row.note),
        quantity: typeof row.quantity === "number" ? row.quantity : null,
        resident: lookup.resident(row.residentId),
        resident_id: id(row.residentId),
        status: words(row.status),
        unit_price: money(row.unitPrice),
      })),
  },
  expenses: {
    columns: [
      HOSTEL,
      col("date", "Date"),
      col("date_bs", "Date (BS)"),
      col("category", "Category"),
      col("what", "What"),
      col("amount", "Amount (Rs)"),
      col("paid_by", "Paid by"),
      col("recorded_by", "Recorded by"),
      col("status", "Status"),
    ],
    rows: async (ids, lookup) =>
      (await ExpenseModel.find({ hostelId: { $in: ids } })
        .sort({ spentOn: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .select("hostelId spentOn category what amount paidBy recordedByName status")
        .lean<AnyLean[]>()).map((row) => ({
        amount: money(row.amount),
        category: words(row.category),
        date: adDate(row.spentOn),
        date_bs: bsDate(row.spentOn),
        hostel: lookup.hostel(row.hostelId),
        paid_by: words(row.paidBy),
        recorded_by: text(row.recordedByName),
        status: words(row.status),
        what: text(row.what),
      })),
  },
  stock: {
    columns: [
      HOSTEL,
      col("date", "Date"),
      col("date_bs", "Date (BS)"),
      col("kind", "Kind"),
      col("item", "Item"),
      col("quantity", "Quantity"),
      col("unit", "Unit"),
      col("rate", "Rate (Rs)"),
      col("supplier", "Supplier"),
      col("bill_no", "Bill no"),
      col("status", "Status"),
    ],
    rows: async (ids, lookup) => {
      const entries = await StockEntryModel.find({
        $or: [{ groupHostelId: { $in: ids } }, { hostelId: { $in: ids } }],
      })
        .sort({ on: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>();

      // One row per item on an entry: a bill of five things is five lines.
      return entries.flatMap((entry) =>
        (entry.lines ?? []).map((line: AnyLean) => ({
          bill_no: text(entry.billNo),
          date: adDate(entry.on ?? entry.createdAt),
          date_bs: bsDate(entry.on ?? entry.createdAt),
          hostel: lookup.hostel(entry.hostelId),
          item: text(line.name),
          kind: words(entry.kind),
          quantity: typeof line.qty === "number" ? line.qty : null,
          rate: money(line.rate),
          status: words(entry.status),
          supplier: text(entry.supplier),
          unit: text(line.unit),
        })),
      );
    },
  },
  food: {
    columns: [HOSTEL, col("day", "Day"), col("meal", "Meal"), col("time", "Time"), col("items", "Items"), col("note", "Note")],
    rows: async (ids, lookup) => {
      const routines = await FoodRoutineModel.find({ hostelId: { $in: ids } }).lean<AnyLean[]>();

      return routines.flatMap((routine) => [
        ...(routine.meals ?? []).map((meal: AnyLean) => ({
          day: words(meal.dayOfWeek),
          hostel: lookup.hostel(routine.hostelId),
          items: (meal.items ?? []).join(", ") || null,
          meal: words(meal.mealType),
          note: text(meal.note),
          time: text(routine.timings?.[meal.mealType]),
        })),
        ...(routine.monthEndSpecial?.items?.length
          ? [
              {
                day: "Last day of the month",
                hostel: lookup.hostel(routine.hostelId),
                items: routine.monthEndSpecial.items.join(", "),
                meal: "Special",
                note: text(routine.monthEndSpecial.note),
                time: null,
              },
            ]
          : []),
      ]);
    },
  },
  complaints: {
    columns: [
      HOSTEL,
      col("date", "Date"),
      col("date_bs", "Date (BS)"),
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("category", "Category"),
      col("title", "Title"),
      col("details", "Details"),
      col("status", "Status"),
      col("reply", "Your reply"),
      col("resolved", "Resolved"),
    ],
    rows: async (ids, lookup) =>
      (await ComplaintModel.find({ hostelId: { $in: ids } })
        .sort({ createdAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        category: words(row.category),
        date: adDate(row.createdAt),
        date_bs: bsDate(row.createdAt),
        details: text(row.description),
        hostel: lookup.hostel(row.hostelId),
        reply: text(row.adminResponse),
        resident: row.isAnonymous ? "Anonymous" : lookup.resident(row.residentId),
        resident_id: row.isAnonymous ? null : id(row.residentId),
        resolved: adDate(row.resolvedAt),
        status: words(row.status),
        title: text(row.title),
      })),
  },
  repairs: {
    columns: [
      HOSTEL,
      col("date", "Date"),
      col("date_bs", "Date (BS)"),
      col("trade", "Trade"),
      col("title", "Title"),
      col("where", "Where"),
      col("priority", "Priority"),
      col("status", "Status"),
      col("completed", "Completed"),
      col("cost_note", "Cost note"),
    ],
    rows: async (ids, lookup) =>
      (await MaintenanceRequestModel.find({ hostelId: { $in: ids }, isDeleted: { $ne: true } })
        .sort({ createdAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        completed: adDate(row.completedAt),
        cost_note: text(row.costNote),
        date: adDate(row.createdAt),
        date_bs: bsDate(row.createdAt),
        hostel: lookup.hostel(row.hostelId),
        priority: words(row.priority),
        status: words(row.status),
        title: text(row.title),
        trade: words(row.category),
        where: text(row.location),
      })),
  },
  attendance: {
    columns: [
      HOSTEL,
      col("day", "Day"),
      col("recorded", "Recorded (Nepal time)"),
      col("resident_id", "Resident ID"),
      col("resident", "Resident"),
      col("zone", "Zone"),
      col("source", "How"),
    ],
    rows: async (ids, lookup) =>
      (await AttendanceLogModel.find({ hostelId: { $in: ids } })
        .sort({ recordedAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .select("hostelId day recordedAt residentId zone source")
        .lean<AnyLean[]>()).map((row) => ({
        day: adDate(row.day ?? row.recordedAt),
        hostel: lookup.hostel(row.hostelId),
        recorded: adDateTime(row.recordedAt),
        resident: lookup.resident(row.residentId),
        resident_id: id(row.residentId),
        source: words(row.source),
        zone: words(row.zone),
      })),
  },
  notices: {
    columns: [HOSTEL, col("published", "Published"), col("published_bs", "Published (BS)"), col("title", "Title"), col("category", "Category"), col("notice", "Notice")],
    rows: async (ids, lookup) =>
      (await NoticeModel.find({ hostelId: { $in: ids } })
        .sort({ createdAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .lean<AnyLean[]>()).map((row) => ({
        category: words(row.category),
        hostel: lookup.hostel(row.hostelId),
        notice: text(row.content),
        published: adDate(row.publishedAt ?? row.createdAt),
        published_bs: bsDate(row.publishedAt ?? row.createdAt),
        title: text(row.title),
      })),
  },
  files: {
    columns: [HOSTEL, col("uploaded", "Uploaded"), col("kind", "Kind"), col("file_name", "File name"), col("type", "Type"), col("size_kb", "Size (KB)")],
    rows: async (ids, lookup) =>
      (await FileAssetModel.find({ hostelId: { $in: ids }, isDeleted: { $ne: true } })
        .sort({ createdAt: 1 })
        .limit(LEAVE_EXPORT_ROW_CAP)
        .select("hostelId createdAt kind fileName mimeType sizeBytes")
        .lean<AnyLean[]>()).map((row) => ({
        file_name: text(row.fileName),
        hostel: lookup.hostel(row.hostelId),
        kind: words(row.kind),
        size_kb: typeof row.sizeBytes === "number" ? Math.ceil(row.sizeBytes / 1024) : null,
        type: text(row.mimeType),
        uploaded: adDate(row.createdAt),
      })),
  },
};

/** Base name of both files: `sunrise-hostel-data-2026-10-21`. */
export function leaveExportBaseName(slug: string, at = new Date()) {
  return `${slug || "hostel"}-data-${adDate(at)}`;
}

/** Column widths from the longest value, so nothing opens squashed. */
function columnWidths(columns: Column[], rows: Row[]) {
  return columns.map((column) => ({
    wch: Math.min(
      60,
      Math.max(column.header.length, ...rows.slice(0, 500).map((row) => String(row[column.key] ?? "").length)) + 2,
    ),
  }));
}

/**
 * The workbook and the JSON for the ticked sections, in the order the form
 * lists them. A section with no rows is still a sheet, header only: "you had
 * none" is an answer, a missing sheet is a question.
 */
export async function buildLeaveExport(
  hostelIds: Types.ObjectId[],
  sections: readonly HostelLeaveSection[],
  slug: string,
) {
  const [hostels, residents] = await Promise.all([
    HostelModel.find({ _id: { $in: hostelIds } })
      .select("name location contact panNumber createdAt ownerId")
      .lean<AnyLean[]>(),
    ResidentModel.find({ hostelId: { $in: hostelIds } })
      .select("firstName lastName")
      .lean<AnyLean[]>(),
  ]);
  const main = hostels.find((row) => String(row._id) === String(hostelIds[0])) ?? hostels[0];
  const owner = main?.ownerId
    ? await UserModel.findById(main.ownerId).select("name email phone").lean<AnyLean | null>()
    : null;
  const hostelNames = new Map(hostels.map((row) => [String(row._id), row.name ?? ""]));
  const residentNames = new Map(residents.map((row) => [String(row._id), name(row)]));
  const lookup: Lookup = {
    hostel: (value) => (value ? hostelNames.get(String(value)) ?? "" : ""),
    resident: (value) => (value ? residentNames.get(String(value)) ?? "" : ""),
  };
  // One building: the Hostel column would say the same thing on every row.
  const several = hostelIds.length > 1;
  const now = new Date();

  const sheets: Array<{ columns: Column[]; key: HostelLeaveSection; label: string; rows: Row[]; truncated: boolean }> = [];

  for (const section of HOSTEL_LEAVE_SECTIONS.filter((entry) => sections.includes(entry.key))) {
    const spec = SECTIONS[section.key];
    const rows = await spec.rows(hostelIds, lookup);

    sheets.push({
      columns: spec.columns.filter((column) => several || column.key !== "hostel"),
      key: section.key,
      label: section.label,
      rows,
      truncated: rows.length >= LEAVE_EXPORT_ROW_CAP,
    });
  }

  const about = {
    address: [main?.location?.address, main?.location?.area, main?.location?.city].filter(Boolean).join(", ") || null,
    buildings: hostels.map((row) => row.name ?? ""),
    covers_from: adDate(main?.createdAt),
    covers_to: adDate(now),
    exported_at: adDateTime(now),
    hostel: main?.name ?? "",
    owner: owner?.name ?? null,
    owner_email: owner?.email ?? null,
    phone: main?.contact?.phone ?? owner?.phone ?? null,
    pan: main?.panNumber ?? null,
  };

  const book = XLSX.utils.book_new();
  const aboutRows: Cell[][] = [
    [`${about.hostel} — data from ${PLATFORM_NAME}`],
    [],
    ["Hostel", about.hostel],
    ...(several ? [["Buildings", about.buildings.join(", ")] as Cell[]] : []),
    ["Address", about.address],
    ["Phone", about.phone],
    ["PAN / VAT", about.pan],
    ["Owner", [about.owner, about.owner_email].filter(Boolean).join(" · ") || null],
    ["Covers", `${about.covers_from ?? "first day"} to ${about.covers_to}`],
    ["Exported", `${about.exported_at} (Nepal time)`],
    [],
    ["Sheet", "What it holds", "Rows"],
    ...sheets.map((sheet): Cell[] => [
      sheet.label,
      HOSTEL_LEAVE_SECTIONS.find((entry) => entry.key === sheet.key)?.description ?? "",
      sheet.truncated ? `${sheet.rows.length} (first ${LEAVE_EXPORT_ROW_CAP} only)` : sheet.rows.length,
    ]),
    [],
    ["How to read it"],
    ["Dates", "YYYY-MM-DD, the day in Nepal. Columns marked (BS) give the same day in Bikram Sambat."],
    ["Months", "Bikram Sambat, YYYY-MM (2083-05 is Bhadra 2083)."],
    ["Money", "Nepali rupees, whole numbers."],
    ["Linking", "Resident ID joins Residents to Bills, Payments, Receipts, Deposits, Khata, Complaints and Attendance. Bill ID and Payment ID join Bills, Payments and Receipts."],
    ["Other software", `The ${leaveExportBaseName(slug, now)}.json file attached with this one holds the same data for import.`],
  ];
  const aboutSheet = XLSX.utils.aoa_to_sheet(aboutRows);

  aboutSheet["!cols"] = [{ wch: 18 }, { wch: 90 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(book, aboutSheet, "About");

  for (const sheet of sheets) {
    const grid: Cell[][] = [
      sheet.columns.map((column) => column.header),
      ...sheet.rows.map((row) => sheet.columns.map((column) => row[column.key] ?? null)),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(grid);

    worksheet["!cols"] = columnWidths(sheet.columns, sheet.rows);
    worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ c: 0, r: 0 }, { c: sheet.columns.length - 1, r: Math.max(0, sheet.rows.length) }) };
    // Sheet names cap at 31 characters and refuse a few symbols; ours are short and plain.
    XLSX.utils.book_append_sheet(book, worksheet, sheet.label);
  }

  const json = {
    about,
    format: { dates: "YYYY-MM-DD (Nepal day)", money: "NPR whole rupees", months: "Bikram Sambat YYYY-MM" },
    sections: Object.fromEntries(
      sheets.map((sheet) => [
        sheet.key,
        sheet.rows.map((row) => Object.fromEntries(sheet.columns.map((column) => [column.key, row[column.key] ?? null]))),
      ]),
    ),
  };

  const base = leaveExportBaseName(slug, now);
  const csv = await csvPack(base, sheets);
  const attachments: EmailAttachment[] = [
    { content: new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }) as Buffer), filename: `${base}.xlsx` },
    { content: new TextEncoder().encode(JSON.stringify(json, null, 2)), filename: `${base}.json` },
  ];

  return {
    attachments,
    // Kept with the files rather than emailed: the workbook already has every sheet.
    csvFiles: csv.files,
    csvZip: csv.zip,
    sheets: sheets.map((sheet) => ({ key: sheet.key, label: sheet.label, rows: sheet.rows.length, truncated: sheet.truncated })),
  };
}

/**
 * One CSV per section — each its own download — and all of them in one ZIP.
 * The format almost any other software imports; a UTF-8 byte-order mark on each
 * file, so Excel opens Nepali names correctly.
 */
async function csvPack(base: string, sheets: Array<{ columns: Column[]; key: string; rows: Row[] }>) {
  const now = new Date();
  const files: EmailAttachment[] = sheets.map((sheet) => ({
    content: new TextEncoder().encode(
      `\uFEFF${toCsv(sheet.columns.map((column) => ({ key: column.key, label: column.header })), sheet.rows)}`,
    ),
    filename: `${base}-${sheet.key}.csv`,
  }));
  const chunks: Uint8Array[] = [];
  const entries = files.map((file) => ({
    data: (async function* () {
      yield file.content;
    })(),
    date: now,
    name: file.filename,
  }));

  for await (const chunk of zipStream(entries)) chunks.push(chunk);

  return {
    files,
    zip: { content: new Uint8Array(Buffer.concat(chunks)), filename: `${base}-csv.zip` } satisfies EmailAttachment,
  };
}
