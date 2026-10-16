import { z } from "zod";

import { paginationQuerySchema } from "@/lib/pagination";

/**
 * Every price on the wire is **NPR paisa**, an integer — the same unit
 * `StoreProduct.price` stores. The platform's product form takes rupees and
 * multiplies before it posts, so the conversion happens once, in one place, and
 * nothing downstream has to know whether the number it holds is scaled.
 */
const paisa = z.coerce.number().int().min(0).max(100_000_000);

/** Same-origin paths and absolute http(s) links; nothing else is navigable. */
const linkUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value === "" || value.startsWith("/") || /^https?:\/\//i.test(value),
    "Link must start with / or http(s)://",
  );

/**
 * Lowercase, hyphenated, no leading or trailing hyphen. Slugs are the handle the
 * mobile app filters by, so they are validated rather than derived from the name
 * on the fly — a name edited for punctuation must not silently repoint every
 * link that used the old slug.
 */
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.");

const productImage = z
  .object({
    assetId: z.string().trim().max(160).optional(),
    url: linkUrl.optional(),
  })
  .refine(
    (value) => Boolean(value.assetId || value.url),
    "An image needs either an uploaded asset or a URL.",
  );

/* -------------------------------------------------------------------------- */
/* Catalogue — platform owner writes, hostel staff read                       */
/* -------------------------------------------------------------------------- */

export const storeCategoryCreateSchema = z.object({
  icon: z.string().trim().max(60).default("cube"),
  imageAssetId: z.string().trim().max(160).optional(),
  imageUrl: linkUrl.optional(),
  isActive: z.boolean().default(true),
  name: z.string().trim().min(1).max(80),
  priority: z.coerce.number().int().min(-1000).max(1000).default(0),
  slug,
});

export const storeCategoryUpdateSchema = storeCategoryCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

export const storeProductCreateSchema = z
  .object({
    categoryId: z.string().trim().min(1),
    compareAtPrice: paisa.optional(),
    description: z.string().trim().max(4000).optional(),
    images: z.array(productImage).max(8).default([]),
    isActive: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
    /** 0 means "no cap" — see `StoreProduct.maxOrderQuantity`. */
    maxOrderQuantity: z.coerce.number().int().min(0).max(10_000).default(0),
    minOrderQuantity: z.coerce.number().int().min(1).max(10_000).default(1),
    name: z.string().trim().min(1).max(160),
    price: paisa,
    priority: z.coerce.number().int().min(-1000).max(1000).default(0),
    slug,
    stockQuantity: z.coerce.number().int().min(0).max(1_000_000).default(0),
    summary: z.string().trim().max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    trackStock: z.boolean().default(true),
    unit: z.string().trim().max(24).default("piece"),
  })
  .refine(
    (value) =>
      value.maxOrderQuantity === 0 || value.maxOrderQuantity >= value.minOrderQuantity,
    {
      message: "The maximum per order cannot be below the minimum.",
      path: ["maxOrderQuantity"],
    },
  )
  .refine(
    (value) => value.compareAtPrice === undefined || value.compareAtPrice > value.price,
    {
      message: "The struck-through price has to be above the price being charged.",
      path: ["compareAtPrice"],
    },
  );

/**
 * `.partial()` cannot be applied to a refined object, so the update schema
 * restates the shape. The cross-field rules are deliberately **not** repeated
 * here: a PATCH carries one field, and re-checking min against max would need
 * the stored document. The service does that check, against the merged record.
 */
export const storeProductUpdateSchema = z
  .object({
    categoryId: z.string().trim().min(1),
    compareAtPrice: paisa.nullable(),
    description: z.string().trim().max(4000),
    images: z.array(productImage).max(8),
    isActive: z.boolean(),
    isFeatured: z.boolean(),
    maxOrderQuantity: z.coerce.number().int().min(0).max(10_000),
    minOrderQuantity: z.coerce.number().int().min(1).max(10_000),
    name: z.string().trim().min(1).max(160),
    price: paisa,
    priority: z.coerce.number().int().min(-1000).max(1000),
    slug,
    stockQuantity: z.coerce.number().int().min(0).max(1_000_000),
    summary: z.string().trim().max(200),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    trackStock: z.boolean(),
    unit: z.string().trim().max(24),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

/* -------------------------------------------------------------------------- */
/* Shopping                                                                   */
/* -------------------------------------------------------------------------- */

export const storeProductListQuerySchema = z.object({
  ...paginationQuerySchema,
  /** A category **slug**, not an id — the phone filters by the stable handle. */
  category: z.string().trim().max(80).optional(),
  featured: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .optional(),
  search: z.string().trim().max(120).optional(),
  sort: z
    .enum(["recommended", "price-asc", "price-desc", "newest"])
    .default("recommended"),
});

export const storeCartAddSchema = z.object({
  productId: z.string().trim().min(1),
  /**
   * How many to **add**, not what to set. A second tap of "Add to cart" on a
   * product already in the basket has to mean two, which is what every shop in
   * `ui_inspiration_folder` does; the stepper on the cart screen uses PATCH,
   * where the quantity is absolute.
   */
  quantity: z.coerce.number().int().min(1).max(10_000).default(1),
});

export const storeCartItemUpdateSchema = z.object({
  /** Absolute. `0` means the same as removing the line, and is accepted as such. */
  quantity: z.coerce.number().int().min(0).max(10_000),
});

const deliverySchema = z.object({
  addressLine: z.string().trim().min(1).max(300),
  city: z.string().trim().max(120).optional(),
  contactName: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
  /**
   * Loose on purpose: a courier phones this, and a rejected order because
   * someone wrote a landline with a dash in it is a worse failure than a number
   * that needs a second look.
   */
  phone: z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^[0-9+][0-9\s-]*$/, "Use digits, spaces or hyphens."),
});

export const storeOrderCreateSchema = z.object({
  delivery: deliverySchema,
  /** One member today. Named anyway — see `StoreOrder.paymentMethod`. */
  paymentMethod: z.literal("COD").default("COD"),
});

export const storeOrderListQuerySchema = z.object({
  ...paginationQuerySchema,
  status: z
    .enum([
      "all",
      "open",
      "PLACED",
      "CONFIRMED",
      "PACKED",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
    ])
    .default("all"),
});

export const storeOrderCancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/* -------------------------------------------------------------------------- */
/* Fulfilment — platform owner                                                */
/* -------------------------------------------------------------------------- */

export const storeOrderStatusSchema = z.object({
  note: z.string().trim().max(500).optional(),
  status: z.enum(["CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"]),
});

export const platformStoreOrderListQuerySchema = z.object({
  ...storeOrderListQuerySchema.shape,
  hostelId: z.string().trim().max(40).optional(),
});
