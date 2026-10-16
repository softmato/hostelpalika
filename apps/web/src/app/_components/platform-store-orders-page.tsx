"use client";

import { Banknote, PackageCheck, Truck } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  SoftBadge,
  TabBar,
  ViewAllLink,
} from "@/app/_components/portal-dashboard-ui";
import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

const ORDERS_ENDPOINT = "/api/v1/platform/store/orders";

/**
 * The lifecycle table, restated for the browser.
 *
 * It is a copy of `store-status.ts`'s `TRANSITIONS` and it should not be: the
 * portal bundle cannot import a module that pulls in Mongoose. Keeping it beside
 * the buttons it draws, with this note, is the honest version — the API is still
 * the authority, and a row that disagrees gets a 409 with a readable message
 * rather than doing something the server did not sanction.
 */
const NEXT_STATUSES: Record<string, { label: string; value: OrderStatus }[]> = {
  CANCELLED: [],
  CONFIRMED: [
    { label: "Mark packed", value: "PACKED" },
    { label: "Out for delivery", value: "SHIPPED" },
    { label: "Cancel", value: "CANCELLED" },
  ],
  DELIVERED: [],
  PACKED: [
    { label: "Out for delivery", value: "SHIPPED" },
    { label: "Cancel", value: "CANCELLED" },
  ],
  PLACED: [
    { label: "Confirm", value: "CONFIRMED" },
    { label: "Mark packed", value: "PACKED" },
    { label: "Cancel", value: "CANCELLED" },
  ],
  SHIPPED: [{ label: "Mark delivered", value: "DELIVERED" }],
};

type OrderStatus =
  | "PLACED"
  | "CONFIRMED"
  | "PACKED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

type StoreOrder = {
  createdAt?: string;
  delivery: {
    addressLine: string;
    city: string;
    contactName: string;
    note: string;
    phone: string;
  };
  deliveryFee: number;
  hostelName: string;
  id: string;
  itemCount: number;
  items: {
    lineTotal: number;
    name: string;
    productId: string;
    quantity: number;
    unit: string;
    unitPrice: number;
  }[];
  orderNumber: string;
  paymentMethod: string;
  paymentStatus: string;
  status: OrderStatus;
  statusLabel: string;
  subtotal: number;
  timeline: { at?: string; note: string; status: string; statusLabel: string }[];
  total: number;
};

type OrdersPayload = {
  orders: StoreOrder[];
  summary: { deliveredRevenue: number; open: number; total: number };
};

function formatPaisa(paisa: number) {
  return new Intl.NumberFormat("en-NP", {
    currency: "NPR",
    maximumFractionDigits: 2,
    style: "currency",
  }).format(paisa / 100);
}

const STATUS_TONE: Record<OrderStatus, "amber" | "green" | "rose" | "slate"> = {
  CANCELLED: "rose",
  CONFIRMED: "amber",
  DELIVERED: "green",
  PACKED: "amber",
  PLACED: "amber",
  SHIPPED: "amber",
};

/**
 * The fulfilment queue: what hostels have ordered and where each one has got to.
 *
 * Its own page rather than a fourth tab on `/platform/store`, because packing
 * orders and stocking the catalogue are different jobs — usually different
 * people, certainly different days — and a tab would put a queue that needs
 * clearing behind a form that does not.
 *
 * Cash on delivery means the money arrives with the courier, so `Mark delivered`
 * is also the payment event. The revenue tile therefore counts delivered orders
 * only; anything else would swing every time something is cancelled.
 */
export const PlatformStoreOrdersPageContent = memo(
  function PlatformStoreOrdersPageContent() {
    const [filter, setFilter] = useState<"open" | "all" | "DELIVERED" | "CANCELLED">("open");
    const [message, setMessage] = useState("");
    const [expanded, setExpanded] = useState<string | null>(null);
    const invalidate = useInvalidateResources();
    const { confirm, confirmDialog } = useConfirm();

    const url = `${ORDERS_ENDPOINT}?status=${filter}`;
    const resource = usePortalResource<OrdersPayload>(url, {
      errorMessage: "Could not load the orders.",
    });

    const orders = useMemo(() => resource.data?.orders ?? [], [resource.data]);
    const summary = resource.data?.summary;

    const refresh = useCallback(() => {
      // Every tab is the same collection through a different filter, so one
      // status change has to clear all of them, not only the one in front of us.
      for (const status of ["open", "all", "DELIVERED", "CANCELLED"]) {
        invalidate(`${ORDERS_ENDPOINT}?status=${status}`);
      }
    }, [invalidate]);

    const move = useCallback(
      async (order: StoreOrder, status: OrderStatus, label: string) => {
        if (status === "CANCELLED") {
          const confirmed = await confirm({
            actionLabel: "Cancel order",
            description: `${order.orderNumber} for ${order.hostelName || "this hostel"} is cancelled and everything on it goes back into stock. This cannot be undone.`,
            title: "Cancel this order?",
            tone: "destructive",
          });

          if (!confirmed) {
            return;
          }
        }

        try {
          await browserApi(`${ORDERS_ENDPOINT}/${order.id}/status`, {
            body: JSON.stringify({ note: label, status }),
            method: "PATCH",
          });
          setMessage(`${order.orderNumber} — ${label.toLowerCase()}.`);
          refresh();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not update the order.",
          );
        }
      },
      [confirm, refresh],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        {confirmDialog}
        <PortalPageHeader
          description="Supply orders placed by hostels. Cash on delivery — marking an order delivered is what records it as paid."
          title="Store Orders"
        />
        <Message value={message || resource.message} />

        {summary ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard
              icon={Truck}
              label="To fulfil"
              tone={summary.open > 0 ? "amber" : "slate"}
              value={summary.open}
            />
            <MetricCard icon={PackageCheck} label="Orders (this view)" value={summary.total} />
            <MetricCard
              icon={Banknote}
              label="Collected on delivery"
              tone="green"
              value={formatPaisa(summary.deliveredRevenue)}
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabBar
            onChange={(key) => setFilter(key as typeof filter)}
            tabs={[
              { key: "open", label: "To fulfil" },
              { key: "DELIVERED", label: "Delivered" },
              { key: "CANCELLED", label: "Cancelled" },
              { key: "all", label: "All" },
            ]}
            tone="platform"
            value={filter}
          />
          <ViewAllLink href="/platform/store" label="Catalogue" />
        </div>

        <Panel title="Orders">
          {resource.state === "loading" ? <LoadingRows /> : null}
          {resource.state === "ready" && orders.length === 0 ? (
            <EmptyState
              label={
                filter === "open"
                  ? "Nothing waiting. Every order has been delivered or cancelled."
                  : "No orders in this view."
              }
            />
          ) : null}

          <div className="space-y-3">
            {orders.map((order) => {
              const isOpen = expanded === order.id;

              return (
                <div className="rounded-lg border border-border p-4" key={order.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">
                        {order.orderNumber}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {order.hostelName}
                        </span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {order.itemCount} {order.itemCount === 1 ? "item" : "items"} ·{" "}
                        {formatPaisa(order.total)} · {order.paymentMethod}
                        {order.createdAt
                          ? ` · ${new Date(order.createdAt).toLocaleString()}`
                          : ""}
                      </p>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {order.delivery.contactName} · {order.delivery.phone} ·{" "}
                        {order.delivery.addressLine}
                        {order.delivery.city ? `, ${order.delivery.city}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <SoftBadge tone={STATUS_TONE[order.status]}>
                        {order.statusLabel}
                      </SoftBadge>
                      <SoftBadge tone={order.paymentStatus === "PAID" ? "green" : "slate"}>
                        {order.paymentStatus === "PAID" ? "Paid" : "Unpaid"}
                      </SoftBadge>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(NEXT_STATUSES[order.status] ?? []).map((next) => (
                      <button
                        className={
                          next.value === "CANCELLED"
                            ? "rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10"
                            : "rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                        }
                        key={next.value}
                        onClick={() => void move(order, next.value, next.label)}
                        type="button"
                      >
                        {next.label}
                      </button>
                    ))}
                    <button
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-muted"
                      onClick={() => setExpanded(isOpen ? null : order.id)}
                      type="button"
                    >
                      {isOpen ? "Hide detail" : "Show detail"}
                    </button>
                  </div>

                  {isOpen ? (
                    <div className="mt-4 grid gap-4 border-t border-border pt-4 lg:grid-cols-2">
                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Items
                        </p>
                        <ul className="space-y-1.5">
                          {order.items.map((item) => (
                            <li
                              className="flex justify-between gap-3 text-xs text-foreground"
                              key={item.productId}
                            >
                              <span className="min-w-0 truncate">
                                {item.quantity} × {item.name}
                                <span className="text-muted-foreground">
                                  {" "}
                                  ({formatPaisa(item.unitPrice)}/{item.unit})
                                </span>
                              </span>
                              <span className="shrink-0 font-semibold tabular-nums">
                                {formatPaisa(item.lineTotal)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <div className="mt-3 space-y-1 border-t border-border pt-2 text-xs">
                          <p className="flex justify-between text-muted-foreground">
                            <span>Subtotal</span>
                            <span className="tabular-nums">
                              {formatPaisa(order.subtotal)}
                            </span>
                          </p>
                          <p className="flex justify-between text-muted-foreground">
                            <span>Delivery</span>
                            <span className="tabular-nums">
                              {order.deliveryFee === 0
                                ? "Free"
                                : formatPaisa(order.deliveryFee)}
                            </span>
                          </p>
                          <p className="flex justify-between font-semibold text-foreground">
                            <span>Total</span>
                            <span className="tabular-nums">{formatPaisa(order.total)}</span>
                          </p>
                        </div>
                      </div>

                      <div>
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          History
                        </p>
                        <ol className="space-y-2">
                          {order.timeline.map((entry, index) => (
                            <li
                              className="text-xs text-muted-foreground"
                              key={`${entry.status}-${entry.at ?? index}`}
                            >
                              <span className="font-semibold text-foreground">
                                {entry.statusLabel}
                              </span>
                              {entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ""}
                              {entry.note ? ` · ${entry.note}` : ""}
                            </li>
                          ))}
                        </ol>
                        {order.delivery.note ? (
                          <p className="mt-3 rounded-md bg-muted p-2 text-xs text-foreground">
                            Courier note: {order.delivery.note}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    );
  },
);
