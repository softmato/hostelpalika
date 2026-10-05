import { api } from "@/lib/api";
import { type ApiEnvelope, readApiError, unwrap } from "@/lib/api-contract";
import type {
  AdminBranchRow,
  AdminComplaint,
  AdminInvoiceMatrix,
  AdminInquiry,
  AdminLedger,
  AdminMaintenance,
  AdminNightStatus,
  AdminNotice,
  AdminPeriodSummary,
  AdminResident,
} from "@/lib/admin-api";
import { getBranchesSummary } from "@/lib/admin-api";
import type {
  AttendanceAnalytics,
  CookAccount,
  FoodAnalytics,
  HostelAttendance,
  ManagedHostel,
  ManagedWarden,
  PerformanceReport,
  PlanBilling,
} from "@/lib/admin-manage-api";
import type { ExpenseHome } from "@/lib/expenses";
import type { HostelBookings } from "@/lib/admin-bookings-api";

export type OverallSection = "overview" | "people" | "money" | "operations" | "reports";
export type OverallField =
  | "profile" | "residents" | "wardens" | "cooks"
  | "invoices" | "periods" | "ledger" | "expenses" | "billing"
  | "complaints" | "maintenance" | "inquiries" | "night" | "attendanceToday" | "bookings" | "notices"
  | "performance" | "food" | "attendance";

export type Page<T> = {
  pagination?: { hasMore: boolean; total: number; totalPages: number };
} & T;

export type OverallValues = {
  profile: { hostel: ManagedHostel };
  residents: Page<{ residents: AdminResident[] }>;
  wardens: Page<{ wardens: ManagedWarden[] }>;
  cooks: { cooks: CookAccount[]; expensesEnabled?: boolean; portalEnabled: boolean };
  invoices: AdminInvoiceMatrix;
  periods: AdminPeriodSummary;
  ledger: AdminLedger;
  expenses: ExpenseHome;
  billing: { history: PlanBilling };
  complaints: Page<{ complaints: AdminComplaint[] }>;
  maintenance: AdminMaintenance;
  inquiries: Page<{ inquiries: AdminInquiry[] }>;
  night: AdminNightStatus;
  attendanceToday: HostelAttendance;
  bookings: HostelBookings;
  notices: Page<{ notices: AdminNotice[] }>;
  performance: { report: PerformanceReport };
  food: FoodAnalytics;
  attendance: AttendanceAnalytics;
};

export type FieldState<T> = { data: T; error: null } | { data: null; error: string };
export type BranchOverall = {
  branch: AdminBranchRow;
  fields: Partial<{ [K in OverallField]: FieldState<OverallValues[K]> }>;
};
export type OverallData = { branches: BranchOverall[]; period: string };

/** Explicit header wins over the ordinary active-branch interceptor. Each read is still
 * narrowed and authorised by the server. No aggregate request can write data. */
async function scopedGet<K extends OverallField>(
  branchId: string,
  path: string,
  params?: Record<string, string | number>,
): Promise<FieldState<OverallValues[K]>> {
  try {
    const response = await api.get<ApiEnvelope<OverallValues[K]>>(path, {
      headers: { "x-hostel-id": branchId },
      params,
    });
    return { data: unwrap(response), error: null };
  } catch (error) {
    return { data: null, error: readApiError(error, "Could not load this section.") };
  }
}

const ROOT = "/hostel-admin";

async function loadBranch(branch: AdminBranchRow, section: OverallSection, period: string): Promise<BranchOverall> {
  if (section === "overview") {
    const profile = await scopedGet<"profile">(branch.id, `${ROOT}/profile`);
    return { branch, fields: { profile } };
  }
  if (section === "people") {
    const [residents, wardens, cooks] = await Promise.all([
      scopedGet<"residents">(branch.id, `${ROOT}/residents`, { pageSize: 100 }),
      scopedGet<"wardens">(branch.id, `${ROOT}/wardens`, { pageSize: 100 }),
      scopedGet<"cooks">(branch.id, `${ROOT}/cooks`),
    ]);
    return { branch, fields: { residents, wardens, cooks } };
  }
  if (section === "money") {
    const [invoices, periods, ledger, expenses, billing] = await Promise.all([
      scopedGet<"invoices">(branch.id, `${ROOT}/finance/invoices`, { period }),
      scopedGet<"periods">(branch.id, `${ROOT}/finance/invoices/periods`),
      scopedGet<"ledger">(branch.id, `${ROOT}/finance/invoices/ledger`),
      scopedGet<"expenses">(branch.id, `${ROOT}/expenses`, { period }),
      scopedGet<"billing">(branch.id, `${ROOT}/billing`),
    ]);
    return { branch, fields: { invoices, periods, ledger, expenses, billing } };
  }
  if (section === "operations") {
    const [complaints, maintenance, inquiries, night, attendanceToday, bookings, notices] = await Promise.all([
      scopedGet<"complaints">(branch.id, `${ROOT}/complaints`, { pageSize: 100 }),
      scopedGet<"maintenance">(branch.id, `${ROOT}/maintenance/requests`),
      scopedGet<"inquiries">(branch.id, `${ROOT}/inquiries`, { pageSize: 100 }),
      scopedGet<"night">(branch.id, `${ROOT}/night-status`, { pageSize: 100 }),
      scopedGet<"attendanceToday">(branch.id, `${ROOT}/attendance`),
      scopedGet<"bookings">(branch.id, `${ROOT}/bookings`, { tab: "requests" }),
      scopedGet<"notices">(branch.id, `${ROOT}/notices`, { pageSize: 100 }),
    ]);
    return { branch, fields: { complaints, maintenance, inquiries, night, attendanceToday, bookings, notices } };
  }
  const [performance, food, attendance] = await Promise.all([
    scopedGet<"performance">(branch.id, `${ROOT}/reports/performance`, { month: period }),
    scopedGet<"food">(branch.id, `${ROOT}/reports/food`),
    scopedGet<"attendance">(branch.id, `${ROOT}/reports/attendance`),
  ]);
  return { branch, fields: { performance, food, attendance } };
}

/** Fetch only the visible category. A failed branch keeps its own error instead of
 * turning another branch's empty state into a misleading organisation total. */
export async function getOverallData(section: OverallSection, period: string): Promise<OverallData> {
  const summary = await getBranchesSummary();
  const branches: BranchOverall[] = [];
  for (let start = 0; start < summary.hostels.length; start += 3) {
    branches.push(...await Promise.all(
      summary.hostels.slice(start, start + 3).map((branch) => loadBranch(branch, section, period)),
    ));
  }
  return { branches, period: summary.period };
}
