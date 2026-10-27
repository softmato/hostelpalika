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
  /** A resident's leaving day must be at least this many days ahead (E5). */
  moveOutNoticeDays?: number;
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

/** Still here on or after the day they said they would leave (E5) — Home's "Leaving today". */
export type LeavingResident = { id: string; leavingOn: string; name: string; roomNumber: string | null };

export const leavingTodayQuery = (): Query<LeavingResident[]> =>
  defineQuery("admin:leaving-today", [REALTIME_TOPIC.PAYMENTS], async () =>
    unwrap(await api.get<ApiEnvelope<{ residents: LeavingResident[] }>>("/hostel-admin/residents/leaving-today"))
      .residents,
  );

/** A resident's own move-out notice (E5). Dates are `YYYY-MM-DD`. */
export type LeavingNotice = {
  earliest: string;
  leavingOn: string | null;
  leavingOnLabel: string | null;
  noticeDays: number;
  reason: string | null;
};

export async function getLeavingNotice() {
  return unwrap(await api.get<ApiEnvelope<LeavingNotice>>("/resident/leaving"));
}

export async function saveLeavingNotice(input: { date: string; reason?: string }) {
  return unwrap(await api.put<ApiEnvelope<LeavingNotice>>("/resident/leaving", input));
}

export async function cancelLeavingNotice() {
  return unwrap(await api.delete<ApiEnvelope<LeavingNotice>>("/resident/leaving"));
}
