import { Types } from "mongoose";
import type { z } from "zod";

import { addBsMonths, bsPeriodBounds, currentBsPeriod } from "@hostel/shared/calendar/bs";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { assertHostelAccess } from "@/lib/tenant";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { HostelModel } from "@hostel/db/models/Hostel";
import { periodTotals } from "@/modules/finance/ledger-read.service";
import { ResidentModel } from "@hostel/db/models/Resident";
import type {
  hostelAdminReportExportSchema,
  platformReportExportSchema,
} from "@/modules/reports/report.validation";

type PlatformReportExportInput = z.infer<typeof platformReportExportSchema>;
type HostelAdminReportExportInput = z.infer<typeof hostelAdminReportExportSchema>;

export type ReportExport = {
  columns: Array<{ key: string; label: string }>;
  filenamePrefix: string;
  /** What the rows cover — "Last 6 months". Absent on a snapshot. */
  period?: string;
  rows: Array<Record<string, unknown>>;
};

/**
 * The window an export covers: `months` BS months counting this one, or
 * everything at 0. `fromPeriod` filters period-keyed rows, `from` instants.
 */
function exportWindow(months: number) {
  if (!months) return { from: null, fromPeriod: null, label: "Everything" };

  const fromPeriod = addBsMonths(currentBsPeriod(), -(months - 1));

  return {
    from: bsPeriodBounds(fromPeriod).start,
    fromPeriod,
    label: months === 1 ? "This month" : months === 12 ? "Last 1 year" : `Last ${months} months`,
  };
}

export class ReportExportError extends Error {
  constructor(
    message: string,
    public errorCode = "REPORT_EXPORT_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * Exports are aggregates, never row dumps: a CSV of every resident would put
 * names and phone numbers in a downloaded file for no reporting benefit. Each
 * report below groups first and exports the grouped counts.
 */
const EXPORT_ROW_CAP = 5000;

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new ReportExportError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

async function hostelNamesByIdFor(ids: Array<Types.ObjectId | string>) {
  const hostels = await HostelModel.find({ _id: { $in: ids } })
    .select("name")
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();

  return new Map(hostels.map((hostel) => [hostel._id.toString(), hostel.name]));
}

async function hostelsByStatus(): Promise<ReportExport> {
  const rows = await HostelModel.aggregate<{ _id: string; count: number }>([
    { $match: { isDeleted: false } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  return {
    columns: [
      { key: "status", label: "Status" },
      { key: "count", label: "Hostels" },
    ],
    filenamePrefix: "hostels-by-status",
    rows: rows.map((row) => ({ count: row.count, status: row._id ?? "UNKNOWN" })),
  };
}

async function residentsByStatus(): Promise<ReportExport> {
  const rows = await ResidentModel.aggregate<{
    _id: { hostelId: Types.ObjectId; status: string };
    count: number;
  }>([
    { $match: { isDeleted: false } },
    { $group: { _id: { hostelId: "$hostelId", status: "$status" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: EXPORT_ROW_CAP },
  ]);
  const names = await hostelNamesByIdFor(rows.map((row) => row._id.hostelId));

  return {
    columns: [
      { key: "hostel", label: "Hostel" },
      { key: "status", label: "Status" },
      { key: "count", label: "Residents" },
    ],
    filenamePrefix: "residents-by-status",
    rows: rows.map((row) => ({
      count: row.count,
      hostel: names.get(row._id.hostelId.toString()) ?? "Unknown hostel",
      status: row._id.status ?? "UNKNOWN",
    })),
  };
}

/** Payment volume: what was billed vs what residents actually settled. */
async function paymentVolume(months: number): Promise<ReportExport> {
  const window = exportWindow(months);
  const rows = (await periodTotals({}, { groupByHostel: true, limit: EXPORT_ROW_CAP })).filter(
    (row) => !window.fromPeriod || row.period >= window.fromPeriod,
  );
  const names = await hostelNamesByIdFor(
    rows.map((row) => row.hostelId).filter((id): id is string => Boolean(id)),
  );

  return {
    columns: [
      { key: "month", label: "Month" },
      { key: "hostel", label: "Hostel" },
      { key: "payments", label: "Payment records" },
      { key: "dueAmount", label: "Billed (NPR)" },
      { key: "paidAmount", label: "Collected (NPR)" },
      { key: "collectionRatePercent", label: "Collection rate (%)" },
    ],
    filenamePrefix: "payment-volume",
    period: window.label,
    rows: rows.map((row) => ({
      collectionRatePercent:
        row.dueAmount > 0 ? ((row.paidAmount / row.dueAmount) * 100).toFixed(1) : "0.0",
      dueAmount: row.dueAmount,
      hostel: names.get(row.hostelId ?? "") ?? "Unknown hostel",
      month: row.period,
      paidAmount: row.paidAmount,
      payments: row.invoiceCount,
    })),
  };
}

async function complaintVolume(months: number): Promise<ReportExport> {
  const window = exportWindow(months);
  const rows = await ComplaintModel.aggregate<{
    _id: { hostelId: Types.ObjectId; status: string };
    count: number;
  }>([
    ...(window.from ? [{ $match: { createdAt: { $gte: window.from } } }] : []),
    { $group: { _id: { hostelId: "$hostelId", status: "$status" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: EXPORT_ROW_CAP },
  ]);
  const names = await hostelNamesByIdFor(rows.map((row) => row._id.hostelId));

  return {
    columns: [
      { key: "hostel", label: "Hostel" },
      { key: "status", label: "Status" },
      { key: "count", label: "Complaints" },
    ],
    filenamePrefix: "complaint-volume",
    period: window.label,
    rows: rows.map((row) => ({
      count: row.count,
      hostel: names.get(row._id.hostelId.toString()) ?? "Unknown hostel",
      status: row._id.status ?? "UNKNOWN",
    })),
  };
}

export async function buildPlatformReportExport(
  input: PlatformReportExportInput,
): Promise<ReportExport> {
  await connectToDatabase();

  switch (input.report) {
    case "hostels":
      return hostelsByStatus();
    case "residents":
      return residentsByStatus();
    case "payments":
      return paymentVolume(input.months);
    case "complaints":
      return complaintVolume(input.months);
  }
}

/* -------------------------------------------------------------------------- */
/* Hostel admin                                                               */
/* -------------------------------------------------------------------------- */

function scopedHostelIds(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return [normalizeObjectId(requestedHostelId, "hostel id")];
  }

  return principal.hostelIds.map((id) => normalizeObjectId(id, "hostel id"));
}

export async function buildHostelAdminReportExport(
  input: HostelAdminReportExportInput,
  principal: ApiPrincipal,
): Promise<ReportExport> {
  await connectToDatabase();

  const hostelIds = scopedHostelIds(principal, input.hostelId);

  if (hostelIds.length === 0) {
    throw new ReportExportError(
      "This account is not linked to a hostel.",
      "HOSTEL_SCOPE_REQUIRED",
      422,
    );
  }

  const scope = { hostelId: { $in: hostelIds } };
  const window = exportWindow(input.months);

  if (input.report === "residents") {
    // Resident count over time — grouped by move-in month, never per person.
    const rows = await ResidentModel.aggregate<{ _id: string; count: number }>([
      {
        $match: {
          ...scope,
          isDeleted: false,
          ...(window.from ? { moveInDate: { $gte: window.from } } : {}),
        },
      },
      {
        $group: {
          _id: { $dateToString: { date: "$moveInDate", format: "%Y-%m" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: EXPORT_ROW_CAP },
    ]);

    return {
      columns: [
        { key: "month", label: "Move-in month" },
        { key: "count", label: "Residents" },
      ],
      filenamePrefix: "residents-over-time",
      period: window.label,
      rows: rows.map((row) => ({ count: row.count, month: row._id ?? "Unknown" })),
    };
  }

  if (input.report === "payments") {
    const rows = (await periodTotals({ hostelIds }, { limit: EXPORT_ROW_CAP })).filter(
      (row) => !window.fromPeriod || row.period >= window.fromPeriod,
    );

    return {
      columns: [
        { key: "month", label: "Month" },
        { key: "payments", label: "Payment records" },
        { key: "dueAmount", label: "Billed (NPR)" },
        { key: "paidAmount", label: "Collected (NPR)" },
        { key: "collectionRatePercent", label: "Collection rate (%)" },
      ],
      filenamePrefix: "payment-collection",
      period: window.label,
      rows: rows.map((row) => ({
        collectionRatePercent:
          row.dueAmount > 0 ? ((row.paidAmount / row.dueAmount) * 100).toFixed(1) : "0.0",
        dueAmount: row.dueAmount,
        month: row.period,
        paidAmount: row.paidAmount,
        payments: row.invoiceCount,
      })),
    };
  }

  if (input.report === "complaints") {
    // Resolution time in days, so slow categories stand out at a glance.
    const rows = await ComplaintModel.aggregate<{
      _id: { category: string; status: string };
      avgResolutionMs: number | null;
      count: number;
    }>([
      { $match: { ...scope, ...(window.from ? { createdAt: { $gte: window.from } } : {}) } },
      {
        $group: {
          _id: { category: "$category", status: "$status" },
          avgResolutionMs: {
            // Unresolved complaints contribute null, which $avg ignores —
            // otherwise an open ticket would read as "resolved in 0 days".
            $avg: {
              $cond: [
                { $ne: ["$resolvedAt", null] },
                { $subtract: ["$resolvedAt", "$createdAt"] },
                null,
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: EXPORT_ROW_CAP },
    ]);

    return {
      columns: [
        { key: "category", label: "Category" },
        { key: "status", label: "Status" },
        { key: "count", label: "Complaints" },
        { key: "avgResolutionDays", label: "Avg resolution (days)" },
      ],
      filenamePrefix: "complaint-resolution",
      period: window.label,
      rows: rows.map((row) => ({
        avgResolutionDays: row.avgResolutionMs
          ? (row.avgResolutionMs / 86_400_000).toFixed(1)
          : "—",
        category: row._id.category ?? "UNKNOWN",
        count: row.count,
        status: row._id.status ?? "UNKNOWN",
      })),
    };
  }

  // Occupancy: vacancy is a running count on each hostel's room configurations.
  const hostels = await HostelModel.find({ _id: { $in: hostelIds }, isDeleted: false })
    .select("name roomConfigurations")
    .lean<
      Array<{
        _id: Types.ObjectId;
        name: string;
        roomConfigurations?: Array<{
          bedsPerRoom?: number;
          rooms?: number;
          roomType?: string;
          vacantBeds?: number;
        }>;
      }>
    >();

  return {
    columns: [
      { key: "hostel", label: "Hostel" },
      { key: "roomType", label: "Room type" },
      { key: "totalBeds", label: "Total beds" },
      { key: "occupiedBeds", label: "Occupied beds" },
      { key: "occupancyRatePercent", label: "Occupancy rate (%)" },
    ],
    filenamePrefix: "room-occupancy",
    rows: hostels.flatMap((hostel) =>
      (hostel.roomConfigurations ?? []).map((config) => {
        // Beds are not documents; each room type carries rooms × bedsPerRoom
        // with a running vacancy counter, same as the occupancy report.
        const totalBeds = (config.bedsPerRoom ?? 0) * (config.rooms ?? 0);
        const occupiedBeds = Math.max(totalBeds - (config.vacantBeds ?? 0), 0);

        return {
          hostel: hostel.name,
          occupancyRatePercent:
            totalBeds > 0 ? ((occupiedBeds / totalBeds) * 100).toFixed(1) : "0.0",
          occupiedBeds,
          roomType: config.roomType ?? "Unknown",
          totalBeds,
        };
      }),
    ),
  };
}
