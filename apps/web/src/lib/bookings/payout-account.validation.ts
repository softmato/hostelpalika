import { z } from "zod";

/**
 * What an owner types for their payout account, checked the same way on the
 * registration forms, the admin screens and the API.
 *
 * Numbers are normalised before they are checked or sealed: spaces and dashes
 * copied from a cheque book or a bank app are dropped, letters upper-cased. A
 * wallet is the 10-digit Nepali mobile number the wallet is registered to.
 */
export const PAYOUT_METHOD_VALUES = ["BANK", "ESEWA", "KHALTI"] as const;

export type PayoutMethod = (typeof PAYOUT_METHOD_VALUES)[number];

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  BANK: "Bank account",
  ESEWA: "eSewa",
  KHALTI: "Khalti",
};

export function normalizePayoutNumber(value: string) {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

const WALLET_NUMBER = /^9[678]\d{8}$/;
const BANK_ACCOUNT_NUMBER = /^[A-Z0-9]{6,24}$/;

export const payoutAccountInputSchema = z
  .object({
    bankName: z.string().trim().max(120).default(""),
    branch: z.string().trim().max(120).default(""),
    holderName: z.string().trim().min(2, "Enter the name on the account.").max(120),
    method: z.enum(PAYOUT_METHOD_VALUES),
    number: z
      .string()
      .max(40)
      .transform((value) => normalizePayoutNumber(value)),
  })
  .superRefine((input, context) => {
    if (input.method === "BANK") {
      if (input.bankName.length < 2) {
        context.addIssue({
          code: "custom",
          message: "Enter the bank's name.",
          path: ["bankName"],
        });
      }

      if (!BANK_ACCOUNT_NUMBER.test(input.number)) {
        context.addIssue({
          code: "custom",
          message: "Enter the account number: 6 to 24 letters or digits.",
          path: ["number"],
        });
      }

      return;
    }

    if (!WALLET_NUMBER.test(input.number)) {
      context.addIssue({
        code: "custom",
        message: `Enter the 10-digit mobile number your ${PAYOUT_METHOD_LABELS[input.method]} account uses.`,
        path: ["number"],
      });
    }
  })
  .transform((input) =>
    input.method === "BANK" ? input : { ...input, bankName: "", branch: "" },
  );

export type PayoutAccountInput = z.input<typeof payoutAccountInputSchema>;
export type PayoutAccountValue = z.output<typeof payoutAccountInputSchema>;

export const payoutAccountReviewSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

/** `••••4821` */
export function maskedPayoutNumber(last4: string) {
  return `••••${last4}`;
}
