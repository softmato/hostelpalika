/**
 * The supply store, from the hostel's side.
 *
 * The platform runs one catalogue and every hostel is a customer of it, so
 * nothing here takes a hostel id in the ordinary case — the server reads it off
 * the principal. `hostelId` is accepted only because an owner with two hostels
 * has two baskets and two delivery addresses, and guessing between them would
 * send an order to the wrong gate (`resolveStoreHostelId` on the server has the
 * long version).
 *
 * ## Every amount is paisa
 *
 * `price`, `unitPrice`, `lineTotal`, `subtotal`, `total`, `deliveryFee` — all
 * integers, all hundredths of a rupee. Convert once with `rupees()` from
 * `lib/store-format.ts` at the point of drawing, and never in a reducer.
 *
 * Shapes mirror the serializers in `apps/web/src/modules/store/*`, read from the
 * services rather than guessed from route names.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/**
 * Whether the store is open to hostels. While false, the admin Home tile shows
 * the "coming soon" alert instead of entering `(store)`. Flip it when it ships.
 */
export const STORE_OPEN = false;

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

export type StoreProductImage = { assetId: string; url: string };

export type StoreCategory = {
  /** A glyph name, chosen by the platform owner. Older rows say `bed-outline`; `<Glyph>` resolves that. */
  icon: string;
  id: string;
  imageAssetId: string;
  imageUrl: string;
  isActive: boolean;
  name: string;
  priority: number;
  productCount: number;
  slug: string;
};

export type StoreProduct = {
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  /** The struck-through "was" price, in paisa. Display only. */
  compareAtPrice: number | null;
  createdAt?: string;
  description: string;
  id: string;
  images: StoreProductImage[];
  /** Already decided by the server — never re-derive it from `stockQuantity`. */
  inStock: boolean;
  isFeatured: boolean;
  /** `0` means no cap. */
  maxOrderQuantity: number;
  minOrderQuantity: number;
  name: string;
  price: number;
  slug: string;
  /** `null` when the product does not track stock. */
  stockQuantity: number | null;
  summary: string;
  tags: string[];
  trackStock: boolean;
  unit: string;
};

/** The shopper's slice of the platform's store settings. */
export type StoreDeliveryPromise = {
  arrivesText: string;
  cutoffText: string;
  placedBefore: "morning" | "evening" | "next-day";
};

export type StoreConfig = {
  closedMessage: string;
  currency: string;
  deliveryPromise: StoreDeliveryPromise;
  deliveryEstimate: string;
  deliveryFee: number;
  freeDeliveryThreshold: number;
  isOpen: boolean;
};

export type StoreHome = {
  categories: StoreCategory[];
  config: StoreConfig;
  featured: StoreProduct[];
  latest: StoreProduct[];
};

/** Everything above the fold in one request — see `getStoreHome` on the server. */
export async function getStoreHome() {
  const response = await api.get<ApiEnvelope<StoreHome>>("/store/home");

  return unwrap(response);
}

export async function getStoreCategories() {
  const response =
    await api.get<ApiEnvelope<{ categories: StoreCategory[] }>>("/store/categories");

  return unwrap(response).categories;
}

/**
 * One department and the first few things on its shelf.
 *
 * `total` is the whole shelf; `products` is capped at what the rail draws, so
 * the "See all" beside a heading knows whether there is anything more to see.
 */
export type StoreShelf = {
  category: StoreCategory;
  products: StoreProduct[];
  total: number;
};

/**
 * Every department with its first products, in one request.
 *
 * A `listStoreProducts` call per category would be sixteen round trips for one
 * screen — see `getStoreShelves` on the server. `search` narrows the shelves and
 * drops the ones left empty, which answers "which departments stock a bucket"
 * rather than "which product is a bucket"; the shop's search box answers the
 * second question.
 */
export async function getStoreShelves(search?: string) {
  const response = await api.get<ApiEnvelope<{ shelves: StoreShelf[] }>>(
    "/store/shelves",
    search ? { params: { search } } : undefined,
  );

  return unwrap(response).shelves;
}

export type StoreProductPage = {
  category: StoreCategory | null;
  pagination: { hasMore: boolean; page: number; total: number; totalPages: number };
  products: StoreProduct[];
};

export type StoreProductQuery = {
  /** A category **slug**, not an id. */
  category?: string;
  featured?: boolean;
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: "recommended" | "price-asc" | "price-desc" | "newest";
};

export async function listStoreProducts(query: StoreProductQuery = {}) {
  const response = await api.get<ApiEnvelope<StoreProductPage>>("/store/products", {
    params: query,
  });

  return unwrap(response);
}

export async function getStoreProduct(handle: string) {
  const response = await api.get<
    ApiEnvelope<{ product: StoreProduct; related: StoreProduct[] }>
  >(`/store/products/${handle}`);

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Cart                                                                       */
/* -------------------------------------------------------------------------- */

export type CartTotals = {
  deliveryFee: number;
  /** How much more this basket needs for free delivery. `0` once earned or off. */
  freeDeliveryRemaining: number;
  hasFreeDelivery: boolean;
  itemCount: number;
  subtotal: number;
  total: number;
};

export type CartLine = {
  addedAt?: string;
  availableQuantity: number;
  lineTotal: number;
  /** Why this line could not have what was asked for, if anything. */
  limitedBy: "max" | "stock" | null;
  product: StoreProduct;
  quantity: number;
  /** What was asked for, when stock has since fallen below it. */
  requestedQuantity: number;
  unitPrice: number;
};

export type Cart = {
  config: StoreConfig;
  items: CartLine[];
  totals: CartTotals;
  updatedAt?: string;
};

/**
 * Every cart write returns the whole basket, not a delta.
 *
 * `removed` names products that were delisted while the basket sat open, so the
 * screen can say which line vanished; `clamped` says a quantity was cut down to
 * what is actually available. Both are the server's, and neither is an error —
 * the request succeeded, it just did not do exactly what was asked.
 */
export type CartResult = {
  cart: Cart;
  clamped: "max" | "stock" | null;
  removed: string[];
};

/**
 * `params` is spelled out on every call rather than folded into a wrapper,
 * because axios drops `undefined` params on its own and a helper would only
 * hide that.
 */
function hostelParams(hostelId?: string) {
  return hostelId ? { params: { hostelId } } : undefined;
}

export async function getCart(hostelId?: string) {
  const response = await api.get<ApiEnvelope<CartResult>>("/store/cart", hostelParams(hostelId));

  return unwrap(response);
}

/** Just the tab badge. Cheap enough to call on every store screen. */
export async function getCartCount(hostelId?: string) {
  const response = await api.get<ApiEnvelope<{ itemCount: number; lineCount: number }>>(
    "/store/cart/count",
    hostelParams(hostelId),
  );

  return unwrap(response);
}

/** Additive: calling twice with `1` leaves two in the basket, not one. */
export async function addToCart(
  input: { productId: string; quantity?: number },
  hostelId?: string,
) {
  const response = await api.post<ApiEnvelope<CartResult>>(
    "/store/cart/items",
    input,
    hostelParams(hostelId),
  );

  return unwrap(response);
}

/** Absolute. `0` removes the line. */
export async function setCartQuantity(
  productId: string,
  quantity: number,
  hostelId?: string,
) {
  const response = await api.patch<ApiEnvelope<CartResult>>(
    `/store/cart/items/${productId}`,
    { quantity },
    hostelParams(hostelId),
  );

  return unwrap(response);
}

export async function removeFromCart(productId: string, hostelId?: string) {
  const response = await api.delete<ApiEnvelope<CartResult>>(
    `/store/cart/items/${productId}`,
    hostelParams(hostelId),
  );

  return unwrap(response);
}

export async function clearCart(hostelId?: string) {
  const response = await api.delete<ApiEnvelope<CartResult>>(
    "/store/cart",
    hostelParams(hostelId),
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Checkout and orders                                                        */
/* -------------------------------------------------------------------------- */

export type StoreDelivery = {
  addressLine: string;
  city: string;
  contactName: string;
  note: string;
  phone: string;
};

export type StoreCheckout = {
  cart: Cart;
  /** Pre-filled from the last order, then the hostel record. */
  delivery: StoreDelivery;
  deliveryPromise: StoreDeliveryPromise;
  deliveryEstimate: string;
  paymentMethods: {
    available: boolean;
    description: string;
    id: "COD";
    label: string;
  }[];
};

export async function getCheckout(hostelId?: string) {
  const response = await api.get<ApiEnvelope<StoreCheckout>>(
    "/store/checkout",
    hostelParams(hostelId),
  );

  return unwrap(response);
}

export type StoreOrderStatus =
  | "PLACED"
  | "CONFIRMED"
  | "PACKED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

export type StoreOrderItem = {
  imageAssetId: string;
  imageUrl: string;
  lineTotal: number;
  name: string;
  productId: string;
  quantity: number;
  unit: string;
  unitPrice: number;
};

export type StoreOrder = {
  cancelledAt: string | null;
  cancelledReason: string;
  /** The server's own answer, so the button and the API can never disagree. */
  canCancel: boolean;
  createdAt?: string;
  deliveredAt: string | null;
  delivery: StoreDelivery;
  deliveryFee: number;
  deliveryPromise: string;
  hostelId: string;
  id: string;
  itemCount: number;
  items: StoreOrderItem[];
  orderNumber: string;
  paymentMethod: string;
  paymentStatus: string;
  status: StoreOrderStatus;
  statusLabel: string;
  subtotal: number;
  timeline: { at?: string; note: string; status: string; statusLabel: string }[];
  total: number;
  updatedAt?: string;
};

export type StoreOrderPage = {
  orders: StoreOrder[];
  pagination: { hasMore: boolean; page: number; total: number; totalPages: number };
  summary: { open: number; total: number };
};

export async function listStoreOrders(
  query: { page?: number; pageSize?: number; status?: "all" | "open" } = {},
  hostelId?: string,
) {
  const response = await api.get<ApiEnvelope<StoreOrderPage>>("/store/orders", {
    params: { ...query, ...(hostelId ? { hostelId } : {}) },
  });

  return unwrap(response);
}

export async function getStoreOrder(orderId: string) {
  const response = await api.get<ApiEnvelope<{ order: StoreOrder }>>(
    `/store/orders/${orderId}`,
  );

  return unwrap(response).order;
}

export async function placeStoreOrder(
  input: { delivery: Omit<StoreDelivery, "note"> & { note?: string } },
  hostelId?: string,
) {
  const response = await api.post<ApiEnvelope<{ order: StoreOrder }>>(
    "/store/orders",
    { ...input, paymentMethod: "COD" },
    hostelParams(hostelId),
  );

  return unwrap(response).order;
}

export async function cancelStoreOrder(orderId: string, reason?: string) {
  const response = await api.post<ApiEnvelope<{ order: StoreOrder }>>(
    `/store/orders/${orderId}/cancel`,
    reason ? { reason } : {},
  );

  return unwrap(response).order;
}
