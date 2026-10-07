import { EXPENSE_WHAT_MAX } from "@hostel/shared/expenses/categories";
import { extractClaimFields } from "../evidence-ocr";
import { parseReceipt } from "../evidence-receipt";
import { readEvidenceDirection } from "../evidence-direction";
import { receiptBank, receiptCategory } from "../receipt-labels";

/** Auto-save is opt-in on the device; uncertain documents always remain editable. */
export function expenseReceiptSuggestions(text: string | null) {
  const fields = text ? extractClaimFields(text) : {};
  const receipt = parseReceipt(text);
  const direction = readEvidenceDirection(text);
  const description = [receipt.payee, receipt.remarks].filter(Boolean).join(" · ").slice(0, EXPENSE_WHAT_MAX) || "Shared payment receipt";
  const badStatus = /\b(failed|pending|cancelled|canceled|reversed|refunded|unsuccessful)\b/i.test(text || "");
  const confirmed = /\b(successful|success|completed|paid|transferred)\b/i.test(text || "");
  const autoSaveEligible = Boolean(!badStatus && confirmed && !direction.isLedgerView && direction.direction === "DEBIT"
    && direction.outcome === "SUCCESS" && receipt.shape === "RECEIPT"
    && receipt.txnId && receipt.payee && fields.amount && fields.method && receipt.amount === fields.amount);
  // Duplicate key: spacing and case differ between a PDF and a screenshot of one payment.
  const txnId = receipt.txnId?.replace(/\s+/g, "").toUpperCase() || null;
  // Pre-fills on the sheet, marked "Auto" there; null leaves its defaults (Other, plain Bank).
  const category = receiptCategory(text, receipt);
  const bank = receiptBank(text);
  return { fields, description, autoSaveEligible, category, bank, txnId: txnId && txnId.length >= 6 ? txnId : null };
}
