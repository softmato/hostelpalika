import { describe, expect, it } from "vitest";
import { expenseReceiptSuggestions } from "./receipt-suggestions";
describe("shared expense suggestions", () => {
  const clear = "eSewa\nPayment Successful\nMoney sent\nAmount: 300\nTransaction Code: 8823119471\nSent to: Sunrise Boys Hostel\nRemarks: Groceries";
  it("permits a complete successful outgoing receipt", () => {
    expect(expenseReceiptSuggestions(clear).autoSaveEligible).toBe(true);
  });
  it("never auto-saves incoming, failed or pending receipts with otherwise complete fields", () => {
    for (const text of [clear + "\nTransaction failed", clear + "\nPending", clear.replace("Money sent", "Money received\nReceived from Ramesh")]) {
      expect(expenseReceiptSuggestions(text).autoSaveEligible).toBe(false);
    }
  });
  it.each([null, "", "eSewa Amount: 300 Payment pending", "eSewa Amount: 300 Transaction failed", "eSewa statement Opening balance: 1000 Closing balance: 700"])("requires review for %s", (text) => {
    expect(expenseReceiptSuggestions(text).autoSaveEligible).toBe(false);
  });
  it("keeps fields editable when parsing is incomplete", () => {
    const result = expenseReceiptSuggestions("eSewa Amount: 300");
    expect(result.fields.amount).toBe(300);
    expect(result.autoSaveEligible).toBe(false);
  });
});
