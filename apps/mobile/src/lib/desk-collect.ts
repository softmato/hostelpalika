import type { PaymentProfile, ResidentLedger } from "@/lib/admin-manage-api";

/** Pure rules behind the desk collect sheet (`components/collect-payment.tsx`). */
export type DeskMethod = "CASH" | "QR" | "ESEWA" | "KHALTI" | "BANK";
export type Month = ResidentLedger["months"][number];

export const LABEL: Record<DeskMethod, string> = { BANK: "Bank", CASH: "Cash", ESEWA: "eSewa", KHALTI: "Khalti", QR: "QR" };

/** The cash endpoint's method: a QR is the bank network. */
export const SERVER_METHOD: Record<DeskMethod, "CASH" | "ESEWA" | "KHALTI" | "BANK"> = {
  BANK: "BANK",
  CASH: "CASH",
  ESEWA: "ESEWA",
  KHALTI: "KHALTI",
  QR: "BANK",
};

/** Todo E3: Cash, plus only the online methods this hostel has saved. */
export function deskMethods(profile: PaymentProfile | null): DeskMethod[] {
  if (!profile) return ["CASH"];
  const extra = (kind: string) => profile.extraAccounts.some((account) => account.kind === kind);
  return [
    "CASH" as const,
    ...(profile.staticQrAssetId ? (["QR"] as const) : []),
    ...(profile.esewaId || extra("ESEWA") ? (["ESEWA"] as const) : []),
    ...(profile.khaltiId || extra("KHALTI") ? (["KHALTI"] as const) : []),
    ...(profile.bankAccountNumber || extra("BANK") ? (["BANK"] as const) : []),
  ];
}

/** Todo E1–E2: unpaid months oldest first, the oldest ticked. */
export function unpaidMonths(ledger: ResidentLedger | null): Month[] {
  return (ledger?.months ?? [])
    .filter((month) => month.invoiceId && month.dueAmount - month.paidAmount > 0)
    .sort((a, b) => a.period.localeCompare(b.period));
}

