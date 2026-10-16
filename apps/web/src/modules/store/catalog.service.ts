import { Types } from "mongoose";
import type { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { StoreCategoryModel } from "@hostel/db/models/StoreCategory";
import { StoreProductModel } from "@hostel/db/models/StoreProduct";
import { getStoreConfig } from "@/modules/store/store-config";
import { deliveryPromise as resolveDeliveryPromise } from "@/modules/store/delivery-window";
import type { storeProductListQuerySchema } from "@/modules/store/store.validation";

/**
 * Reading the supply catalogue.
 *
 * Everything here is a read for a **hostel** — the shop, the category grid and
 * the product page. The platform's own writes live in `store-admin.service.ts`,
 * and the split is not cosmetic: this file must never return an inactive
 * product or an out-of-window category, and keeping the write path out of it
 * means there is no code here that has ever had a reason to.
 */

type ListQuery = z.infer<typeof storeProductListQuerySchema>;

export type StoreProductImage = { assetId?: string; url?: string };

export type StoreCategoryRecord = {
  _id: Types.ObjectId;
  icon?: string;
  imageAssetId?: string;
  imageUrl?: string;
  isActive: boolean;
  name: string;
  priority: number;
  slug: string;
};

export type StoreProductRecord = {
  _id: Types.ObjectId;
  categoryId: Types.ObjectId;
  compareAtPrice?: number;
  createdAt?: Date;
  description?: string;
  images?: StoreProductImage[];
  isActive: boolean;
  isFeatured: boolean;
  maxOrderQuantity: number;
  minOrderQuantity: number;
  name: string;
  price: number;
  priority: number;
  slug: string;
  stockQuantity: number;
  summary?: string;
  tags?: string[];
  trackStock: boolean;
  unit?: string;
};

export class StoreServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "STORE_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

export function storeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new StoreServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

export function serializeStoreCategory(category: StoreCategoryRecord) {
  return {
    icon: category.icon ?? "cube",
    id: category._id.toString(),
    imageAssetId: category.imageAssetId ?? "",
    imageUrl: category.imageUrl ?? "",
    isActive: category.isActive,
    name: category.name,
    priority: category.priority ?? 0,
    slug: category.slug,
  };
}

/**
 * What a shopper sees.
 *
 * `inStock` is derived here rather than left to the client: "is this buyable"
 * is one rule — track stock, and if so is there any — and a phone re-deriving
 * it from `trackStock` and `stockQuantity` is a second copy that will disagree
 * the first time the rule gains a condition.
 *
 * `stockQuantity` still ships, because the stepper needs a ceiling. It is not a
 * commercial secret: a hostel about to order forty mattresses is entitled to
 * know only twelve exist before it fills a basket it cannot check out.
 */
export function serializeStoreProduct(
  product: StoreProductRecord,
  category?: StoreCategoryRecord,
) {
  return {
    categoryId: product.categoryId.toString(),
    categoryName: category?.name ?? "",
    categorySlug: category?.slug ?? "",
    compareAtPrice: product.compareAtPrice ?? null,
    createdAt: product.createdAt?.toISOString(),
    description: product.description ?? "",
    id: product._id.toString(),
    images: (product.images ?? []).map((image) => ({
      assetId: image.assetId ?? "",
      url: image.url ?? "",
    })),
    inStock: product.trackStock ? product.stockQuantity > 0 : true,
    isFeatured: product.isFeatured,
    maxOrderQuantity: product.maxOrderQuantity ?? 0,
    minOrderQuantity: product.minOrderQuantity ?? 1,
    name: product.name,
    price: product.price,
    slug: product.slug,
    stockQuantity: product.trackStock ? product.stockQuantity : null,
    summary: product.summary ?? "",
    tags: product.tags ?? [],
    trackStock: product.trackStock,
    unit: product.unit ?? "piece",
  };
}

export type StoreProductView = ReturnType<typeof serializeStoreProduct>;

/** Only live categories, best priority first. Used by the shop's tile grid. */
export async function listStoreCategories() {
  await connectToDatabase();

  const categories = await StoreCategoryModel.find({ isActive: true })
    .sort({ priority: -1, name: 1 })
    .lean<StoreCategoryRecord[]>();

  /*
   * A count per category, in one aggregate rather than one query per tile.
   * The grid prints "12 items" under each glyph, and a shop with twenty
   * departments would otherwise be twenty round trips for twenty small numbers.
   */
  const counts = await StoreProductModel.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { isActive: true } },
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
  ]);

  const countByCategory = new Map(
    counts.map((row) => [row._id.toString(), row.count] as const),
  );

  return {
    categories: categories.map((category) => ({
      ...serializeStoreCategory(category),
      productCount: countByCategory.get(category._id.toString()) ?? 0,
    })),
  };
}

/**
 * The shop list: search, category filter, sort, paginate.
 *
 * ## Search does not use the text index when a filter is on
 *
 * Mongo will happily combine `$text` with an equality filter, but `$text` also
 * forces its own relevance sort and quietly overrides `sort`. Since the screen
 * offers "price, low to high" alongside a search box, a query that carried both
 * would return price-sorted-looking results in relevance order. A prefix regex
 * on the name plus a tag match keeps the caller's sort authoritative, which is
 * the behaviour the screen promises. The text index is still what serves a bare
 * search with the default sort.
 */
export async function listStoreProducts(query: ListQuery) {
  await connectToDatabase();

  const filter: Record<string, unknown> = { isActive: true };
  let categoryDoc: StoreCategoryRecord | null = null;

  if (query.category) {
    categoryDoc = await StoreCategoryModel.findOne({
      isActive: true,
      slug: query.category.toLowerCase(),
    }).lean<StoreCategoryRecord | null>();

    if (!categoryDoc) {
      // An unknown slug is an empty shelf, not a 404: the phone reaches this
      // from a saved filter, and blanking the whole screen for a category that
      // was retired is a worse answer than "nothing here".
      return {
        category: null,
        pagination: paginationMeta(query, 0),
        products: [],
      };
    }

    filter.categoryId = categoryDoc._id;
  }

  if (query.featured) {
    filter.isFeatured = true;
  }

  const search = query.search?.trim();
  const useTextIndex = Boolean(search) && query.sort === "recommended" && !query.category;

  if (search) {
    if (useTextIndex) {
      filter.$text = { $search: search };
    } else {
      const pattern = new RegExp(escapeRegex(search), "i");

      filter.$or = [{ name: pattern }, { summary: pattern }, { tags: pattern }];
    }
  }

  const { limit, skip } = paginationRange(query);
  const sort = useTextIndex
    ? ({ score: { $meta: "textScore" } } as const)
    : SORTS[query.sort];

  const cursor = StoreProductModel.find(
    filter,
    useTextIndex ? { score: { $meta: "textScore" } } : undefined,
  )
    .sort(sort as never)
    .skip(skip)
    .limit(limit);

  const [products, total] = await Promise.all([
    cursor.lean<StoreProductRecord[]>(),
    StoreProductModel.countDocuments(filter),
  ]);

  const categories = await categoriesFor(products);

  return {
    category: categoryDoc ? serializeStoreCategory(categoryDoc) : null,
    pagination: paginationMeta(query, total),
    products: products.map((product) =>
      serializeStoreProduct(product, categories.get(product.categoryId.toString())),
    ),
  };
}

/**
 * The shop's landing payload in one request: config, categories, featured, new.
 *
 * Four round trips on a cold app launch over a Nepali mobile connection is the
 * difference between a shop that opens and one that people back out of, and
 * every part of this is small. The phone still has the individual endpoints for
 * everything below the fold.
 */
export async function getStoreHome() {
  await connectToDatabase();

  const [config, categories, featured, latest] = await Promise.all([
    getStoreConfig(),
    listStoreCategories(),
    listStoreProducts({ featured: true, page: 1, pageSize: 8, sort: "recommended" }),
    listStoreProducts({ page: 1, pageSize: 10, sort: "newest" }),
  ]);

  return {
    categories: categories.categories,
    config: {
      closedMessage: config.closedMessage,
      currency: config.currency,
      deliveryPromise: resolveDeliveryPromise(config, new Date()),
      deliveryEstimate: config.deliveryEstimate,
      deliveryFee: config.deliveryFee,
      freeDeliveryThreshold: config.freeDeliveryThreshold,
      isOpen: config.isOpen,
    },
    featured: featured.products,
    latest: latest.products,
  };
}

/**
 * Every department with the first few things on its shelf, in **one** request.
 *
 * The Departments screen draws a horizontal rail per category, and the obvious
 * build — a `listStoreProducts` call per tile — is sixteen round trips on a
 * screen that has to open at once. Same reasoning as `getStoreHome`, and the
 * same answer: the fan-out belongs on this side of the wire.
 *
 * ## One aggregate, sorted before it is grouped
 *
 * `$sort` ahead of `$group` is what makes `$slice` mean "the best twelve" rather
 * than "twelve arbitrary ones" — a group preserves the order it received, and
 * nothing after it re-sorts. `total` is counted before the slice, so a rail
 * showing twelve of forty can say so.
 *
 * ## Search narrows the shelves rather than replacing them
 *
 * A query filters the products and then drops whatever shelf came back empty,
 * so searching "bucket" answers *which departments* stock one. That is the
 * question this screen exists for; the shop's search box is the one that
 * answers "which product", and the two deliberately differ.
 */
export async function getStoreShelves(options: { search?: string } = {}) {
  await connectToDatabase();

  const categories = await StoreCategoryModel.find({ isActive: true })
    .sort({ priority: -1, name: 1 })
    .lean<StoreCategoryRecord[]>();

  if (categories.length === 0) {
    return { shelves: [] };
  }

  const search = options.search?.trim();
  const match: Record<string, unknown> = {
    categoryId: { $in: categories.map((category) => category._id) },
    isActive: true,
  };

  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");

    match.$or = [{ name: pattern }, { summary: pattern }, { tags: pattern }];
  }

  const grouped = await StoreProductModel.aggregate<{
    _id: Types.ObjectId;
    products: StoreProductRecord[];
    total: number;
  }>([
    { $match: match },
    { $sort: { priority: -1, createdAt: -1 } },
    {
      $group: { _id: "$categoryId", products: { $push: "$$ROOT" }, total: { $sum: 1 } },
    },
    { $project: { products: { $slice: ["$products", SHELF_SIZE] }, total: 1 } },
  ]);

  const byCategory = new Map(grouped.map((row) => [row._id.toString(), row] as const));

  return {
    shelves: categories
      .map((category) => {
        const row = byCategory.get(category._id.toString());

        return {
          category: {
            ...serializeStoreCategory(category),
            productCount: row?.total ?? 0,
          },
          products: (row?.products ?? []).map((product) =>
            serializeStoreProduct(product, category),
          ),
          total: row?.total ?? 0,
        };
      })
      /*
       * An empty shelf is dropped while searching and kept otherwise. With no
       * query it is real information — the department exists and is being
       * stocked — but in a result set it is sixteen headings above nothing.
       */
      .filter((shelf) => (search ? shelf.products.length > 0 : true)),
  };
}

/** How many products a rail carries before "See all" takes over. */
const SHELF_SIZE = 12;

/** By id or slug — the phone pushes an id, a shared link carries a slug. */
export async function getStoreProduct(handle: string) {
  await connectToDatabase();

  const product = await StoreProductModel.findOne(
    Types.ObjectId.isValid(handle)
      ? { _id: new Types.ObjectId(handle), isActive: true }
      : { isActive: true, slug: handle.toLowerCase() },
  ).lean<StoreProductRecord | null>();

  if (!product) {
    throw new StoreServiceError("That product is no longer available.", "PRODUCT_NOT_FOUND", 404);
  }

  const category = await StoreCategoryModel.findById(
    product.categoryId,
  ).lean<StoreCategoryRecord | null>();

  /*
   * Four more from the same shelf, minus this one. Fetched as five and sliced
   * rather than filtered in the query: `$ne` on the id would cost an extra index
   * bound for a list nobody paginates.
   */
  const related = await StoreProductModel.find({
    _id: { $ne: product._id },
    categoryId: product.categoryId,
    isActive: true,
  })
    .sort({ priority: -1, createdAt: -1 })
    .limit(4)
    .lean<StoreProductRecord[]>();

  return {
    product: serializeStoreProduct(product, category ?? undefined),
    related: related.map((item) => serializeStoreProduct(item, category ?? undefined)),
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

const SORTS = {
  newest: { createdAt: -1 },
  "price-asc": { price: 1, _id: 1 },
  "price-desc": { price: -1, _id: 1 },
  recommended: { priority: -1, createdAt: -1 },
} as const;

/**
 * `_id` as a tiebreak on the price sorts, and it is not decoration: a shop where
 * forty items cost exactly NPR 250 has no defined order between them, so page 2
 * can repeat a row page 1 already showed. Mongo makes no stability promise
 * without a unique final key.
 */

/** One query for every category the page needs, keyed for the serializer. */
async function categoriesFor(products: readonly StoreProductRecord[]) {
  const ids = [...new Set(products.map((product) => product.categoryId.toString()))];

  if (ids.length === 0) {
    return new Map<string, StoreCategoryRecord>();
  }

  const categories = await StoreCategoryModel.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
  }).lean<StoreCategoryRecord[]>();

  return new Map(categories.map((category) => [category._id.toString(), category] as const));
}

/** A user's search box is not a regex author. */
function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
