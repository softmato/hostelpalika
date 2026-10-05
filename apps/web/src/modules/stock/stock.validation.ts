import { z } from "zod";

import { EXPENSE_AMOUNT_MAX, EXPENSE_PAID_BY } from "@hostel/shared/expenses/categories";
import {
  STOCK_ENTRY_KINDS,
  STOCK_ITEM_NAME_MAX,
  STOCK_KINDS,
  STOCK_LINES_MAX,
  STOCK_QTY_MAX,
  STOCK_UNITS,
} from "@hostel/shared/expenses/stock";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM.");
const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.");
const qtySchema = z
  .number({ message: "Write how much." })
  .min(0, "Write how much.")
  .max(STOCK_QTY_MAX, "That is too much. Check it.");

/** The spending categories a Bought may be filed under — never cash to a warden or a salary. */
export const STOCK_EXPENSE_CATEGORIES = ["GROCERIES", "VEGETABLES_MEAT", "GAS", "CLEANING", "OTHER"] as const;

/** `scope=all` is the owner's Overall: every building of the group, read-only. */
export const stockHomeQuerySchema = z.object({ period: periodSchema.optional(), scope: z.literal("all").optional() });

export const createStockItemSchema = z.object({
  category: z.enum(STOCK_EXPENSE_CATEGORIES).optional(),
  kind: z.enum(STOCK_KINDS),
  lowAt: qtySchema.nullable().optional(),
  name: z.string().trim().min(1, "Name it.").max(STOCK_ITEM_NAME_MAX),
  unit: z.enum(STOCK_UNITS),
});

export const updateStockItemSchema = z
  .object({
    active: z.boolean().optional(),
    category: z.enum(STOCK_EXPENSE_CATEGORIES).optional(),
    kind: z.enum(STOCK_KINDS).optional(),
    lowAt: qtySchema.nullable().optional(),
    name: z.string().trim().min(1).max(STOCK_ITEM_NAME_MAX).optional(),
    unit: z.enum(STOCK_UNITS).optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Nothing to change.",
  });

export const createStockEntrySchema = z
  .object({
    /** BUY only. Whole rupees; with it, the Bought also writes one expense. */
    amount: z.number().int("Whole rupees.").positive().max(EXPENSE_AMOUNT_MAX).optional(),
    clientRequestId: z.string().trim().min(8).max(64).optional(),
    /** Where it landed / left from / was counted. Defaults to the building you are in. */
    hostelId: objectIdSchema.optional(),
    kind: z.enum(STOCK_ENTRY_KINDS),
    lines: z
      .array(z.object({ itemId: objectIdSchema, qty: qtySchema }))
      .min(1, "Add at least one item.")
      .max(STOCK_LINES_MAX),
    note: z.string().trim().max(200).optional(),
    on: calendarDaySchema.optional(),
    paidBy: z.enum(EXPENSE_PAID_BY).default("CASH"),
    photoAssetId: objectIdSchema.optional(),
    toHostelId: objectIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "SEND" && !value.toHostelId) {
      context.addIssue({ code: "custom", message: "Pick where it goes.", path: ["toHostelId"] });
    }

    if (value.kind !== "BUY" && value.amount !== undefined) {
      context.addIssue({ code: "custom", message: "Only Bought has an amount.", path: ["amount"] });
    }

    if (value.kind !== "COUNT" && value.lines.some((line) => line.qty <= 0)) {
      context.addIssue({ code: "custom", message: "Write how much of each item.", path: ["lines"] });
    }
  });

export const receiveStockSchema = z.object({
  /** What actually came, per item. Absent items arrived in full. */
  lines: z.array(z.object({ itemId: objectIdSchema, receivedQty: qtySchema })).max(STOCK_LINES_MAX).optional(),
});

export const cancelStockEntrySchema = z.object({ reason: z.string().trim().min(3).max(300) });

export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;
export type CreateStockEntryInput = z.infer<typeof createStockEntrySchema>;
