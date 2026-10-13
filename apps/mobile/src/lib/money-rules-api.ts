import { REALTIME_TOPIC } from "@/constants/topics";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { defineQuery, type Query } from "@/lib/query-cache";

/**
 * The hostel's money rules (docs/FIELD_FIXES_2026_10.md): opening balance,
 * how a leaving month is charged, and what days away take off.
 */
export type LeaveRule = { enabled: boolean; foodPerDay: number; minDays: number; mode: "FOOD" | "FULL_DAY" };

export type MoneyRules = {
  leave: LeaveRule;
  moveOutCharge: "FULL_MONTH" | "TILL_DAY";
  openingBalance: { amount: number; asOf: string } | null;
};

export async function getMoneyRules() {
  return unwrap(await api.get<ApiEnvelope<{ rules: MoneyRules }>>("/hostel-admin/finance/money-rules")).rules;
}

export async function saveMoneyRules(
  input: Partial<Omit<MoneyRules, "openingBalance">> & { openingBalance?: MoneyRules["openingBalance"] },
) {
  return unwrap(await api.put<ApiEnvelope<{ rules: MoneyRules }>>("/hostel-admin/finance/money-rules", input)).rules;
}

export const moneyRulesQuery = (): Query<MoneyRules> =>
  defineQuery("admin:money-rules", [REALTIME_TOPIC.PAYMENTS], getMoneyRules);

/** One stay away and what came off for it (docs/FIELD_FIXES_2026_10.md §9). */
export type LeaveEntry = {
  amount: number;
  days: number;
  from: string;
  id: string;
  /** "Kartik 3–12". */
  label: string;
  mode: "FOOD" | "FULL_DAY";
  note: string | null;
  periodLabel: string;
  to: string;
};

export type ResidentLeaves = { leaves: LeaveEntry[]; rule: LeaveRule };

export async function getResidentLeaves(residentId: string) {
  return unwrap(await api.get<ApiEnvelope<ResidentLeaves>>(`/hostel-admin/residents/${residentId}/leave`));
}

export async function addResidentLeave(residentId: string, input: { from: string; note?: string; to: string }) {
  return unwrap(await api.post<ApiEnvelope<ResidentLeaves>>(`/hostel-admin/residents/${residentId}/leave`, input));
}

export async function removeResidentLeave(residentId: string, leaveId: string) {
  return unwrap(await api.delete<ApiEnvelope<ResidentLeaves>>(`/hostel-admin/residents/${residentId}/leave/${leaveId}`));
}
