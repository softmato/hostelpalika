import { extractClaimFields } from "../evidence-ocr";
import { parseReceipt } from "../evidence-receipt";
import { readEvidenceDirection } from "../evidence-direction";

/** Auto-save is opt-in on the device; uncertain documents always remain editable. */
export function expenseReceiptSuggestions(text: string | null) {
  const fields = text ? extractClaimFields(text) : {};
  const receipt = parseReceipt(text);
  const direction = readEvidenceDirection(text);
  const description = [receipt.payee, receipt.remarks].filter(Boolean).join(" · ").slice(0, 160) || "Shared payment receipt";
  const badStatus = /\b(failed|pending|cancelled|canceled|reversed|refunded|unsuccessful)\b/i.test(text || "");
  const confirmed = /\b(successful|success|completed|paid|transferred)\b/i.test(text || "");
  const autoSaveEligible = Boolean(!badStatus && confirmed && !direction.isLedgerView && direction.direction === "DEBIT"
    && direction.outcome === "SUCCESS" && receipt.shape === "RECEIPT"
    && receipt.txnId && receipt.payee && fields.amount && fields.method && receipt.amount === fields.amount);
  return { fields, description, autoSaveEligible };
}
