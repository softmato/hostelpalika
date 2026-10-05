import { REALTIME_TOPIC } from "@/constants/topics";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { defineQuery, type Query } from "@/lib/query-cache";

/**
 * Late fine and khata — the API for all three portals that touch them.
 *
 * Late fine: `/hostel-admin/finance/late-fine` (+ a waive on one bill).
 * Khata: the warden's screen reads `/hostel-admin/finance/khata`, the kitchen
 * reads `/cook/khata` (staff may too), the resident `/resident/finance/khata`.
 * Every write publishes the `payments` topic, so all three stay live together.
 */

/* ---------------------------------- Late fine --------------------------------- */

export type LateFineMode = "PER_DAY_AMOUNT" | "PER_DAY_PERCENT";

export type LateFine = {
  enabled: boolean;
  graceDays: number;
  mode: LateFineMode;
  rate: number;
};

export async function getLateFine() {
  const response = await api.get<ApiEnvelope<{ lateFine: LateFine }>>(
    "/hostel-admin/finance/late-fine",
  );

  return unwrap(response).lateFine;
}

export async function saveLateFine(input: LateFine) {
  const response = await api.put<ApiEnvelope<{ lateFine: LateFine }>>(
    "/hostel-admin/finance/late-fine",
    input,
  );

  return unwrap(response).lateFine;
}

export async function waiveLateFine(invoiceId: string) {
  const response = await api.post<ApiEnvelope<{ invoiceId: string }>>(
    `/hostel-admin/finance/invoices/${encodeURIComponent(invoiceId)}/waive-fine`,
    {},
  );

  return unwrap(response);
}

/** "Rs 50 a day" / "1% of the bill a day" — the rule in one phrase. */
export function lateFineRate(fine: Pick<LateFine, "mode" | "rate">) {
  return fine.mode === "PER_DAY_AMOUNT"
    ? `Rs ${fine.rate.toLocaleString("en-US")} a day`
    : `${fine.rate}% of the bill a day`;
}

/* ------------------------------------ Khata ----------------------------------- */

export type KhataStatus = "NONE" | "REQUESTED" | "ACTIVE" | "DECLINED" | "CLOSED";

export type KhataItem = {
  active: boolean;
  id: string;
  /** A PUBLIC asset — loads bare through `assetUrl`. */
  imageAssetId?: string | null;
  name: string;
  price: number;
};

export type KhataEntry = {
  amount: number;
  /** Already on a rent bill. */
  billed: boolean;
  createdAt: string;
  decidedAt: string | null;
  id: string;
  name: string;
  note: string | null;
  quantity: number;
  resident: { id: string; name: string; roomNumber: string | null } | null;
  status: "REQUESTED" | "GIVEN" | "DECLINED" | "CANCELLED";
  unitPrice: number;
};

export type KhataOrders = { recent: KhataEntry[]; waiting: KhataEntry[] };

export type KhataAccount = {
  id: string;
  name: string;
  requestedAt: string | null;
  roomNumber: string | null;
  /** Taken and not yet on a bill. */
  unbilled: number;
};

export type KhataOverview = KhataOrders & {
  accounts: KhataAccount[];
  items: KhataItem[];
  requests: KhataAccount[];
};

/** One rent bill that carried khata. */
export type KhataBill = {
  amount: number;
  invoiceId: string;
  /** Quantity across the bill, not rows — "Egg ×4" counts 4. */
  items: number;
  /** "Bhadra 2083 BS". */
  label: string;
  paid: boolean;
};

export type ResidentKhata = {
  /** Optional: an older API sends none. */
  bills?: KhataBill[];
  entries: KhataEntry[];
  items: KhataItem[];
  status: KhataStatus;
  unbilled: number;
};

export async function getKhataOverview() {
  return unwrap(await api.get<ApiEnvelope<KhataOverview>>("/hostel-admin/finance/khata"));
}

export async function saveKhataItems(items: (Omit<KhataItem, "id"> & { id?: string })[]) {
  const response = await api.put<ApiEnvelope<{ items: KhataItem[] }>>(
    "/hostel-admin/finance/khata",
    { items },
  );

  return unwrap(response).items;
}

export async function decideKhataAccount(residentId: string, action: "APPROVE" | "DECLINE" | "CLOSE") {
  return unwrap(
    await api.post<ApiEnvelope<{ residentId: string; status: KhataStatus }>>(
      `/hostel-admin/finance/khata/residents/${encodeURIComponent(residentId)}`,
      { action },
    ),
  );
}

export async function listKhataOrders() {
  return unwrap(await api.get<ApiEnvelope<KhataOrders>>("/cook/khata"));
}

export async function decideKhataOrder(entryId: string, action: "GIVE" | "DECLINE") {
  return unwrap(
    await api.post<ApiEnvelope<KhataEntry>>(`/cook/khata/${encodeURIComponent(entryId)}`, { action }),
  );
}

export async function getResidentKhata() {
  return unwrap(await api.get<ApiEnvelope<ResidentKhata>>("/resident/finance/khata"));
}

export type ResidentKhataAction =
  | { action: "OPEN" }
  | { action: "ASK"; itemId: string; note?: string; quantity: number }
  | { action: "CANCEL"; entryId: string };

export async function residentKhataAction(input: ResidentKhataAction) {
  return unwrap(await api.post<ApiEnvelope<ResidentKhata>>("/resident/finance/khata", input));
}

export const khataQuery = {
  admin: (): Query<KhataOverview> =>
    defineQuery("admin:khata", [REALTIME_TOPIC.PAYMENTS], getKhataOverview),
  lateFine: (): Query<LateFine> =>
    defineQuery("admin:late-fine", [REALTIME_TOPIC.PAYMENTS], getLateFine),
  orders: (): Query<KhataOrders> =>
    defineQuery("khata:orders", [REALTIME_TOPIC.PAYMENTS], listKhataOrders),
  resident: (): Query<ResidentKhata> =>
    defineQuery("resident:khata", [REALTIME_TOPIC.PAYMENTS], getResidentKhata),
} as const;

/** A picture for an item by its name, so the price list reads at a glance. */
export function khataIcon(name: string) {
  const word = name.toLowerCase();

  if (/egg|anda/.test(word)) return "egg-outline" as const;
  if (/tea|coffee|chiya|milk|doodh/.test(word)) return "cafe-outline" as const;
  if (/wash|laundry|cloth|iron|lugaa/.test(word)) return "shirt-outline" as const;
  if (/water|pani/.test(word)) return "water-outline" as const;
  if (/meal|rice|khana|dal|food|chicken|meat|momo/.test(word)) return "restaurant-outline" as const;
  if (/snack|noodle|chow|biscuit/.test(word)) return "fast-food-outline" as const;

  return "basket-outline" as const;
}
