import { z } from "zod";

import { EXPENSE_AMOUNT_MAX, EXPENSE_PAID_BY } from "@hostel/shared/expenses/categories";
import {
  STOCK_ENTRY_KINDS,
  STOCK_ITEM_NAME_MAX,
  STOCK_KINDS,
  STOCK_LINES_MAX,
  STOCK_QTY_MAX,
  STOCK_SUPPLIER_NAME_MAX,
  STOCK_UNITS,
  STOCK_USE_FOR,
  STOCK_WASTE_REASONS,
} from "@hostel/shared/expenses/stock";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM.");
const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD.");
const qtySchema = z
  .number({ message: "Write how much." })
  .min(0, "Write how much.")
  .max(STOCK_QTY_MAX, "That is too much. Check it.");

/** The spending categories a Bought may be filed under — never cash to a warden or a salary. */
export const STOCK_EXPENSE_CATEGORIES = ["GROCERIES", "VEGETABLES_MEAT", "GAS", "WATER", "CLEANING", "OTHER"] as const;

const rupeesSchema = z.number().int("Whole rupees.").min(0).max(EXPENSE_AMOUNT_MAX);

/** One pack the item is bought in: `SACK` of 25 (kg). Both or neither. */
const packFields = {
  location: z.string().trim().max(40).optional(),
  packSize: z.number().positive().max(STOCK_QTY_MAX).nullable().optional(),
  packUnit: z.enum(STOCK_UNITS).nullable().optional(),
};

/** `scope=all` is the owner's Overall: every building of the group, read-only. */
export const stockHomeQuerySchema = z.object({ period: periodSchema.optional(), scope: z.literal("all").optional() });

export const createStockItemSchema = z.object({
  category: z.enum(STOCK_EXPENSE_CATEGORIES).optional(),
  kind: z.enum(STOCK_KINDS),
  lowAt: qtySchema.nullable().optional(),
  name: z.string().trim().min(1, "Name it.").max(STOCK_ITEM_NAME_MAX),
  unit: z.enum(STOCK_UNITS),
  ...packFields,
});

export const updateStockItemSchema = z
  .object({
    active: z.boolean().optional(),
    category: z.enum(STOCK_EXPENSE_CATEGORIES).optional(),
    kind: z.enum(STOCK_KINDS).optional(),
    lowAt: qtySchema.nullable().optional(),
    name: z.string().trim().min(1).max(STOCK_ITEM_NAME_MAX).optional(),
    unit: z.enum(STOCK_UNITS).optional(),
    ...packFields,
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Nothing to change.",
  });

export const createStockEntrySchema = z
  .object({
    /**
     * BUY, older app builds: the bill's total, all paid. Newer builds send a
     * price per line (`lines[].amount`), `discount`, `tax` and `paid`.
     */
    amount: z.number().int("Whole rupees.").positive().max(EXPENSE_AMOUNT_MAX).optional(),
    /** BUY: the bill's own number, as printed. */
    billNo: z.string().trim().max(40).optional(),
    discount: rupeesSchema.optional(),
    /** BUY: what was paid on the day. Absent: all of it. Less than the total needs a supplier. */
    paid: rupeesSchema.optional(),
    supplierId: objectIdSchema.optional(),
    tax: rupeesSchema.optional(),
    /** USE: who it went to. */
    useFor: z.enum(STOCK_USE_FOR).optional(),
    /** WASTE: why it was thrown away. */
    wasteReason: z.enum(STOCK_WASTE_REASONS).optional(),
    clientRequestId: z.string().trim().min(8).max(64).optional(),
    /** Where it landed / left from / was counted. Defaults to the building you are in. */
    hostelId: objectIdSchema.optional(),
    kind: z.enum(STOCK_ENTRY_KINDS),
    lines: z
      .array(
        z.object({
          /** BUY: the line's price in whole rupees, as on the bill. */
          amount: rupeesSchema.optional(),
          itemId: objectIdSchema,
          /** Entered in the item's pack (2 sacks): `qty` is then worked out from the pack size. */
          packQty: qtySchema.optional(),
          qty: qtySchema,
          /** BUY / OPENING: rupees per unit. */
          rate: z.number().min(0).max(EXPENSE_AMOUNT_MAX).optional(),
        }),
      )
      .min(1, "Add at least one item.")
      .max(STOCK_LINES_MAX),
    note: z.string().trim().max(200).optional(),
    on: calendarDaySchema.optional(),
    paidBy: z.enum(EXPENSE_PAID_BY).default("CASH"),
    photoAssetId: objectIdSchema.optional(),
    /** BUY only: the shop or person it came from. */
    supplier: z.string().trim().max(80).optional(),
    toHostelId: objectIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.kind === "SEND" && !value.toHostelId) {
      context.addIssue({ code: "custom", message: "Pick where it goes.", path: ["toHostelId"] });
    }

    if (value.kind !== "BUY" && (value.amount !== undefined || value.paid !== undefined)) {
      context.addIssue({ code: "custom", message: "Only Bought has an amount.", path: ["amount"] });
    }

    if (value.kind === "WASTE" && !value.wasteReason) {
      context.addIssue({ code: "custom", message: "Say why it was thrown away.", path: ["wasteReason"] });
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

/* -------------------------------------------------------------- suppliers */

export const createStockSupplierSchema = z.object({
  name: z.string().trim().min(1, "Name the shop.").max(STOCK_SUPPLIER_NAME_MAX),
  note: z.string().trim().max(200).optional(),
  /** Owed to them before Stock was used. */
  openingDue: z.number().int("Whole rupees.").min(-EXPENSE_AMOUNT_MAX).max(EXPENSE_AMOUNT_MAX).optional(),
  phone: z.string().trim().max(20).optional(),
});

export const updateStockSupplierSchema = createStockSupplierSchema
  .partial()
  .extend({ active: z.boolean().optional() })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "Nothing to change." });

export const createStockPaymentSchema = z.object({
  amount: z.number().int("Whole rupees.").positive("Write the amount.").max(EXPENSE_AMOUNT_MAX),
  clientRequestId: z.string().trim().min(8).max(64).optional(),
  entryIds: z.array(objectIdSchema).max(50).optional(),
  note: z.string().trim().max(200).optional(),
  on: calendarDaySchema.optional(),
  paidBy: z.enum(EXPENSE_PAID_BY).default("CASH"),
  photoAssetId: objectIdSchema.optional(),
  supplierId: objectIdSchema,
});

export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;
export type CreateStockEntryInput = z.infer<typeof createStockEntrySchema>;
export type CreateStockSupplierInput = z.infer<typeof createStockSupplierSchema>;
export type UpdateStockSupplierInput = z.infer<typeof updateStockSupplierSchema>;
export type CreateStockPaymentInput = z.infer<typeof createStockPaymentSchema>;
