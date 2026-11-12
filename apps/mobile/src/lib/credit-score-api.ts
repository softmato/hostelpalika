/**
 * Resident credit score — `GET /resident/credit-score` (todo B4/C4).
 * Typed off `CreditScore` in `apps/web/src/modules/finance/credit-score.service.ts`.
 */
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

export type CreditScore = {
  approved: number;
  history: { day: number; invoiceId: string; paidAt: string; period: string; points: number; source: string }[];
  /** `RUP-482K` — the fixed part of every month code. */
  paymentCode: string | null;
  rules: { days: string; points: number }[];
  score: number;
  shared: number;
};

export async function getCreditScore(): Promise<CreditScore> {
  return unwrap(await api.get<ApiEnvelope<CreditScore>>("/resident/credit-score"));
}
