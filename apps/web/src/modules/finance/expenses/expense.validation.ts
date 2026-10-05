import { z } from "zod";

import {
  CUSTOM_EXPENSE_CATEGORY,
  EXPENSE_AMOUNT_MAX,
  EXPENSE_CATEGORY_KEYS,
  EXPENSE_CUSTOM_CATEGORY_NAME_MAX,
  EXPENSE_PAID_BY,
  EXPENSE_WHAT_MAX,
  STAFF_CASH_CATEGORY,
} from "@hostel/shared/expenses/categories";

export const expenseReceiptReadSchema = z.object({ assetId: z.string().regex(/^[a-f\d]{24}$/i) });

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");

/** `2083-06` — a Bikram Sambat month, the only month this product speaks. */
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM.");

/**
 * The day the money went, as a calendar day (`2026-10-01`), never an instant.
 * The app picks it in Bikram Sambat and sends the Gregorian day it converts to,
 * so the server never has to guess which calendar a string is in.
 */
const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.");

export const expenseHomeQuerySchema = z.object({
  hostelId: objectIdSchema.optional(),
  period: periodSchema.optional(),
});

export const createExpenseSchema = z
  .object({
    /** Whole rupees (ADR-1): refused at the boundary, never rounded. */
    amount: z
      .number({ message: "Write how much you paid." })
      .int("Write the amount in whole rupees.")
      .positive("Write how much you paid.")
      .max(EXPENSE_AMOUNT_MAX, "That amount is too big. Check it."),
    category: z.enum([...EXPENSE_CATEGORY_KEYS, CUSTOM_EXPENSE_CATEGORY]),
    clientRequestId: z.string().trim().min(8).max(64).optional(),
    customCategoryId: objectIdSchema.optional(),
    hostelId: objectIdSchema.optional(),
    paidBy: z.enum(EXPENSE_PAID_BY).default("CASH"),
    photoAssetId: objectIdSchema.optional(),
    salaryFor: z
      .object({
        name: z.string().trim().min(1, "Write their name.").max(120, "Their name is too long."),
        userId: objectIdSchema.optional(),
      })
      .optional(),
    sharedReceipt: z.boolean().optional(),
    spentOn: calendarDaySchema.optional(),
    /** `STAFF_CASH` only: which warden got the money. */
    cashTo: z.object({ userId: objectIdSchema }).optional(),
    what: z.string().trim().max(EXPENSE_WHAT_MAX).optional(),
  })
  .superRefine((value, context) => {
    if (value.category === STAFF_CASH_CATEGORY && !value.cashTo) {
      context.addIssue({
        code: "custom",
        message: "Pick the warden who got the money.",
        path: ["cashTo"],
      });
    }

    if (value.category === CUSTOM_EXPENSE_CATEGORY && !value.customCategoryId) {
      context.addIssue({
        code: "custom",
        message: "Pick one of your categories.",
        path: ["customCategoryId"],
      });
    }

    if (value.category === "OTHER" && !value.what) {
      context.addIssue({
        code: "custom",
        message: "Write what it was for.",
        path: ["what"],
      });
    }
  });

/** Shown to the person who added it, so it has to be a real sentence. */
export const voidExpenseSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

/** The warden's answer to cash handed to them. Saying "not received" needs no essay. */
export const respondStaffCashSchema = z.object({
  accept: z.boolean(),
  note: z.string().trim().max(300).optional(),
});

export const staffWalletQuerySchema = z.object({
  hostelId: objectIdSchema.optional(),
  userId: objectIdSchema.optional(),
});

export const createExpenseCategorySchema = z.object({
  hostelId: objectIdSchema.optional(),
  name: z.string().trim().min(2).max(EXPENSE_CUSTOM_CATEGORY_NAME_MAX),
});

export const updateExpenseCategorySchema = z
  .object({
    hidden: z.boolean().optional(),
    name: z.string().trim().min(2).max(EXPENSE_CUSTOM_CATEGORY_NAME_MAX).optional(),
  })
  .refine((value) => value.hidden !== undefined || value.name !== undefined, {
    message: "Nothing to change.",
  });

export const cookExpensesSchema = z.object({
  enabled: z.boolean(),
  hostelId: objectIdSchema.optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
