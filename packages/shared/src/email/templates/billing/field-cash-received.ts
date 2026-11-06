import { detailsTable, emailLayout, escapeHtml, paragraph, smallPrint } from "../layout";
import { formatRupees } from "./subscription-invoice";

/** Sent once Softmato has cash a field agent collected: the receipt follows after it is verified. */
export function fieldCashReceivedEmail(input: {
  amount: number;
  collectedBy: string | null;
  planName: string;
  transactionId: string;
}) {
  return {
    category: "billing" as const,
    html: emailLayout({
      bodyHtml: [
        paragraph(`We have your cash payment for <strong>${escapeHtml(input.planName)}</strong>.`),
        detailsTable([
          { emphasis: true, label: "Amount", value: formatRupees(input.amount) },
          { label: "Received by", value: input.collectedBy || "Field agent" },
          { label: "Reference", value: input.transactionId },
        ]),
        smallPrint("Your receipt will be emailed to you once we verify this cash. Thank you for your patience."),
      ].join(""),
      eyebrow: "Cash received",
      heading: "Cash payment received",
      preheader: `${formatRupees(input.amount)} cash received. Your receipt follows once it is confirmed.`,
    }),
    subject: `${formatRupees(input.amount)} cash received — receipt to follow`,
  };
}
