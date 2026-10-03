import { expect, it } from "vitest";
import { deepLinkForNotification } from "./push-routing";
import { webLinkForNotification } from "./web-routing";

it("opens Expenses for receipt confirmations on native and web", () => {
  const input = { category: "PAYMENT", actionUrl: "/app/expenses", data: { type: "SHARED_RECEIPT_SAVED" } };
  expect(deepLinkForNotification(input)).toBe("/expenses");
  expect(webLinkForNotification(input)).toBe("/app/expenses");
});
