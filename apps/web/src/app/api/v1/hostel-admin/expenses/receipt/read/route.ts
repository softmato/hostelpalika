import { rateLimitPublicForm } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";
import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { readExpenseReceipt, resolveExpenseActor } from "@/modules/finance/expenses/expense.service";
import { expenseReceiptReadSchema } from "@/modules/finance/expenses/expense.validation";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, { limit: 30, namespace: "expense-receipt-read", windowMs: 60 * 60 * 1000 });
    if (limited) return limited;
    const principal = await requireHostelCapability(request, "recordExpenses");
    const { assetId } = expenseReceiptReadSchema.parse(await request.json());
    const actor = await resolveExpenseActor(principal);
    return successResponse(await readExpenseReceipt(actor, assetId), "Receipt read");
  } catch (error) { return handleRouteError(error); }
}
