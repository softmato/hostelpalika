"use client";

import { Boxes, PackageX, Plus, ShoppingBag, Tags } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  SoftBadge,
  TabBar,
  ToggleSwitch,
  ViewAllLink,
} from "@/app/_components/portal-dashboard-ui";
import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
} from "@/app/_components/shared-ui";
import {
  StoreImageInput,
  storeImageRows,
} from "@/app/_components/store-image-input";
import {
  formatPaisa,
  slugify,
  toPaisa,
  toRupees,
  type StoreCategory,
  type StoreProduct,
} from "@/app/_components/store-admin-shared";
import { StoreProductForm } from "@/app/_components/store-product-form";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

const PRODUCTS_ENDPOINT = "/api/v1/platform/store/products";
const CATEGORIES_ENDPOINT = "/api/v1/platform/store/categories";
const CONFIG_ENDPOINT = "/api/v1/platform/store/config";
const SUMMARY_ENDPOINT = "/api/v1/platform/store/summary";

type Tab = "products" | "add" | "categories" | "settings";

type StoreSettings = {
  closedMessage: string;
  currency: string;
  deliveryEstimate: string;
  deliveryFee: number;
  freeDeliveryThreshold: number;
  isOpen: boolean;
  maxOrderTotal: number;
  deliverySchedule: {
    cutoffCopy: string;
    eveningArrivalText: string;
    eveningCutoffHour: number;
    morningArrivalText: string;
    morningCutoffHour: number;
    timezone: string;
  };
};

function text(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

function number(form: FormData, key: string, fallback = 0) {
  const value = Number(text(form, key));

  return Number.isFinite(value) ? value : fallback;
}

/**
 * The supply store's catalogue, as the platform owner sees it.
 *
 * Superadmin only: what the platform sells and for how much is a commercial
 * decision, the same reasoning that keeps a PLATFORM_MODERATOR off `/platform/
 * sponsors` (`route-access.ts`).
 *
 * Three tabs rather than three pages — products, the departments they sit in,
 * and the delivery rules — because editing a product almost always means
 * glancing at the category list, and a page load between the two would make
 * adding a shelf feel like a different job from stocking it. Orders **are** a
 * separate page: fulfilment is a different task done by a different person on a
 * different day.
 */
export const PlatformStorePageContent = memo(function PlatformStorePageContent() {
  const [tab, setTab] = useState<Tab>("products");
  const [message, setMessage] = useState("");
  const [editingProduct, setEditingProduct] = useState<StoreProduct | null>(null);
  const [editingCategory, setEditingCategory] = useState<StoreCategory | null>(null);
  const [categoryImage, setCategoryImage] = useState(() => storeImageRows([]));

  /*
   * Picking a category to edit and loading its tile picture are one action, so
   * they are one function. Split across a `setState` and an effect keyed on the
   * selection — the obvious build — the effect fires again on every background
   * refetch of the category list and throws away an image just chosen.
   */
  const editCategory = useCallback((category: StoreCategory | null) => {
    setEditingCategory(category);
    setCategoryImage(
      storeImageRows(
        category?.imageUrl || category?.imageAssetId
          ? [{ assetId: category.imageAssetId, url: category.imageUrl }]
          : [],
      ),
    );
  }, []);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();

  const products = usePortalResource<{
    products: StoreProduct[];
    summary: { live: number; total: number };
  }>(PRODUCTS_ENDPOINT, { errorMessage: "Could not load the catalogue." });

  const categories = usePortalResource<{ categories: StoreCategory[] }>(CATEGORIES_ENDPOINT, {
    errorMessage: "Could not load the categories.",
  });

  const summary = usePortalResource<{
    summary: {
      categories: number;
      live: number;
      openOrders: number;
      outOfStock: number;
      products: number;
    };
  }>(SUMMARY_ENDPOINT, { errorMessage: "Could not load the store summary." });

  const settings = usePortalResource<{ config: StoreSettings }>(CONFIG_ENDPOINT, {
    errorMessage: "Could not load the store settings.",
  });

  const productRows = useMemo(() => products.data?.products ?? [], [products.data]);
  const categoryRows = useMemo(() => categories.data?.categories ?? [], [categories.data]);
  const config = settings.data?.config;

  const refresh = useCallback(() => {
    invalidate(PRODUCTS_ENDPOINT);
    invalidate(CATEGORIES_ENDPOINT);
    invalidate(SUMMARY_ENDPOINT);
  }, [invalidate]);

  /* ------------------------------------------------------------------ products */

  const toggleProduct = useCallback(
    async (product: StoreProduct) => {
      try {
        await browserApi(`${PRODUCTS_ENDPOINT}/${product.id}`, {
          body: JSON.stringify({ isActive: !product.isActive }),
          method: "PATCH",
        });
        setMessage(product.isActive ? "Product hidden from the shop." : "Product is live.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not update.");
      }
    },
    [refresh],
  );

  const removeProduct = useCallback(
    async (product: StoreProduct) => {
      const confirmed = await confirm({
        actionLabel: "Delete product",
        description: `"${product.name}" leaves the shop and is pulled out of every hostel's open cart. Orders already placed keep their own copy and are unaffected.`,
        title: "Delete this product?",
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      try {
        await browserApi(`${PRODUCTS_ENDPOINT}/${product.id}`, { method: "DELETE" });
        setMessage("Product deleted.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not delete.");
      }
    },
    [confirm, refresh],
  );

  /* ---------------------------------------------------------------- categories */

  const saveCategory = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const name = text(form, "name");
      const payload = {
        icon: text(form, "icon") || "cube",
        imageAssetId: categoryImage[0]?.assetId ?? "",
        imageUrl: categoryImage[0]?.url ?? "",
        name,
        priority: number(form, "priority"),
        slug: text(form, "slug") || slugify(name),
      };

      try {
        await browserApi(
          editingCategory
            ? `${CATEGORIES_ENDPOINT}/${editingCategory.id}`
            : CATEGORIES_ENDPOINT,
          { body: JSON.stringify(payload), method: editingCategory ? "PATCH" : "POST" },
        );
        formElement.reset();
        editCategory(null);
        setMessage(editingCategory ? "Category updated." : "Category added.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not save the category.");
      }
    },
    [categoryImage, editCategory, editingCategory, refresh],
  );

  const removeCategory = useCallback(
    async (category: StoreCategory) => {
      const confirmed = await confirm({
        actionLabel: "Delete category",
        description: `"${category.name}" is removed from the shop's grid. Categories that still hold products cannot be deleted — switch them off instead.`,
        title: "Delete this category?",
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      try {
        await browserApi(`${CATEGORIES_ENDPOINT}/${category.id}`, { method: "DELETE" });
        setMessage("Category deleted.");
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not delete.");
      }
    },
    [confirm, refresh],
  );

  /* ------------------------------------------------------------------ settings */

  const patchSettings = useCallback(
    async (patch: Partial<StoreSettings>) => {
      try {
        await browserApi(CONFIG_ENDPOINT, {
          body: JSON.stringify(patch),
          method: "PATCH",
        });
        setMessage("Store settings saved.");
        invalidate(CONFIG_ENDPOINT);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not save the settings.");
      }
    },
    [invalidate],
  );

  const saveSettings = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const form = new FormData(event.currentTarget);

      await patchSettings({
        closedMessage: text(form, "closedMessage"),
        deliveryEstimate: text(form, "deliveryEstimate"),
        deliveryFee: toPaisa(number(form, "deliveryFee")),
        freeDeliveryThreshold: toPaisa(number(form, "freeDeliveryThreshold")),
        maxOrderTotal: toPaisa(number(form, "maxOrderTotal")),
        deliverySchedule: {
          eveningArrivalText: text(form, "eveningArrivalText"),
          eveningCutoffHour: number(form, "eveningCutoffHour", 16),
          morningArrivalText: text(form, "morningArrivalText"),
          morningCutoffHour: number(form, "morningCutoffHour", 10),
          timezone: config?.deliverySchedule.timezone ?? "Asia/Kathmandu",
          cutoffCopy: config?.deliverySchedule.cutoffCopy ?? "",
        },
      });
    },
    [config, patchSettings],
  );

  const counts = summary.data?.summary;

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        description="The supply catalogue every hostel orders from — products, the departments they sit in, and what delivery costs."
        title="Supply Store"
      />
      <Message value={message || products.message} />

      {counts ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={ShoppingBag}
            label="Live products"
            tone="green"
            value={counts.live}
          />
          <MetricCard icon={Boxes} label="Total products" value={counts.products} />
          <MetricCard icon={Tags} label="Categories" value={counts.categories} />
          <MetricCard
            icon={PackageX}
            label="Out of stock"
            tone={counts.outOfStock > 0 ? "amber" : "slate"}
            value={counts.outOfStock}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabBar
          onChange={(key) => setTab(key as typeof tab)}
          tabs={[
            { key: "products", label: "Products" },
            { key: "add", label: editingProduct ? "Edit product" : "Add product" },
            { key: "categories", label: "Categories" },
            { key: "settings", label: "Delivery & fees" },
          ]}
          tone="platform"
          value={tab}
        />
        <ViewAllLink
          href="/platform/store/orders"
          label={
            counts?.openOrders
              ? `${counts.openOrders} order${counts.openOrders === 1 ? "" : "s"} to fulfil`
              : "Orders"
          }
        />
      </div>

      {tab === "products" ? (
        <div className="grid gap-5">
          <Panel
            action={
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-role-platform px-3 text-xs font-semibold text-white"
                onClick={() => {
                  setEditingProduct(null);
                  setTab("add");
                }}
                type="button"
              >
                <Plus className="size-3.5" />
                New product
              </button>
            }
            title="Catalogue"
          >
            {products.state === "loading" ? <LoadingRows /> : null}
            {products.state === "ready" && productRows.length === 0 ? (
              <EmptyState label="Nothing in the shop yet. Add a category first, then a product." />
            ) : null}

            <div className="space-y-3">
              {productRows.map((product) => (
                <div className="rounded-lg border border-border p-4" key={product.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 gap-3">
                      {product.images[0]?.url ? (
                        /* A catalogue thumbnail from whatever host the supplier
                           gave us. `next/image` would need every one of those
                           hosts added to `remotePatterns`, which turns adding a
                           product into a deploy. */
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt=""
                          className="size-12 shrink-0 rounded-lg object-cover"
                          src={product.images[0].url}
                        />
                      ) : (
                        <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                          <ShoppingBag className="size-5" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground">
                          {product.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {product.categoryName || "No category"} · per {product.unit}
                          {product.summary ? ` · ${product.summary}` : ""}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {formatPaisa(product.price)}
                          {product.compareAtPrice
                            ? ` (was ${formatPaisa(product.compareAtPrice)})`
                            : ""}
                          {product.trackStock
                            ? ` · ${product.stockOnHand} in stock`
                            : " · stock not tracked"}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {product.images.length === 0 ? (
                        <SoftBadge tone="amber">No photo</SoftBadge>
                      ) : null}
                      {product.isFeatured ? (
                        <SoftBadge tone="amber">Featured</SoftBadge>
                      ) : null}
                      <SoftBadge tone={product.isActive ? "green" : "slate"}>
                        {product.isActive ? "Live" : "Hidden"}
                      </SoftBadge>
                      {product.trackStock && product.stockOnHand <= 0 ? (
                        <SoftBadge tone="rose">Out of stock</SoftBadge>
                      ) : null}
                      {/* Visible to the one person who can fix it. A product
                          with no photograph draws a glyph on the phone, which
                          reads as a failed image rather than as a gap in the
                          catalogue. */}
                      {product.images.length === 0 ? (
                        <SoftBadge tone="amber">No photo</SoftBadge>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                      onClick={() => {
                        setEditingProduct(product);
                        setTab("add");
                      }}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                      onClick={() => void toggleProduct(product)}
                      type="button"
                    >
                      {product.isActive ? "Hide" : "Make live"}
                    </button>
                    <button
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10"
                      onClick={() => void removeProduct(product)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

      {tab === "add" ? (
        <StoreProductForm
          categories={categoryRows}
          editing={editingProduct}
          key={editingProduct?.id ?? "new"}
          onCancelEdit={() => {
            setEditingProduct(null);
            setTab("products");
          }}
          onCategoryCreated={refresh}
          onSaved={(verb) => {
            setMessage(verb === "added" ? "Product added." : "Product updated.");
            setEditingProduct(null);
            refresh();

            if (verb === "updated") {
              // An edit is finished business — go back to the list it was
              // started from. A create is not: stocking a shop is a run of
              // them, so the form stays put, cleared and ready.
              setTab("products");
            }
          }}
          setMessage={setMessage}
        />
      ) : null}

      {tab === "categories" ? (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Departments">
            {categories.state === "loading" ? <LoadingRows /> : null}
            {categories.state === "ready" && categoryRows.length === 0 ? (
              <EmptyState label="No categories yet. Create one on the right." />
            ) : null}

            <div className="space-y-3">
              {categoryRows.map((category) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
                  key={category.id}
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-foreground">{category.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {category.slug} · {category.productCount}{" "}
                      {category.productCount === 1 ? "product" : "products"} · glyph{" "}
                      {category.icon}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <SoftBadge tone={category.isActive ? "green" : "slate"}>
                      {category.isActive ? "Live" : "Hidden"}
                    </SoftBadge>
                    <button
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                      onClick={() => editCategory(category)}
                      type="button"
                    >
                      Edit
                    </button>
                    <button
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-destructive transition hover:bg-destructive/10"
                      onClick={() => void removeCategory(category)}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={editingCategory ? `Edit ${editingCategory.name}` : "New category"}>
            <BusyForm
              className="grid gap-3"
              key={editingCategory?.id ?? "new"}
              onSubmit={saveCategory}
            >
              <Input
                defaultValue={editingCategory?.name}
                label="Name"
                name="name"
                placeholder="Bedding"
                required
              />
              <Input
                defaultValue={editingCategory?.slug}
                hint="Leave blank to build one from the name. The app filters by this."
                label="Handle"
                name="slug"
              />
              <Input
                defaultValue={editingCategory?.icon ?? "bed"}
                hint="One of our glyph names — bed, water, restaurant. An unknown name shows a plain circle."
                label="Icon"
                name="icon"
              />
              <StoreImageInput
                hint="Optional photograph for the tile. The icon above is used when there is none."
                label="Tile image"
                maxImages={1}
                onChange={setCategoryImage}
                rows={categoryImage}
                scope="store-category-image"
              />
              <Input
                defaultValue={editingCategory?.priority ?? 0}
                hint="Higher shows first in the shop's grid."
                label="Priority"
                name="priority"
                type="number"
              />

              <div className="flex gap-2">
                <SubmitButton className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-role-platform text-sm font-semibold text-white">
                  {editingCategory ? "Save changes" : "Add category"}
                </SubmitButton>
                {editingCategory ? (
                  <button
                    className="h-11 rounded-md border border-border px-4 text-sm font-semibold text-foreground"
                    onClick={() => editCategory(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </BusyForm>
          </Panel>
        </div>
      ) : null}

      {tab === "settings" ? (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Delivery and fees">
            {settings.state === "loading" || !config ? (
              <LoadingRows />
            ) : (
              <BusyForm className="grid max-w-xl gap-3" onSubmit={saveSettings}>
                <Input
                  defaultValue={toRupees(config.deliveryFee)}
                  hint="Charged on every order that misses the free-delivery threshold."
                  label="Delivery fee (NPR)"
                  min="0"
                  name="deliveryFee"
                  step="0.01"
                  type="number"
                />
                <Input
                  defaultValue={toRupees(config.freeDeliveryThreshold)}
                  hint="Spend this much and delivery is free. Set 0 to turn the rule off entirely — it does not make delivery free."
                  label="Free delivery over (NPR)"
                  min="0"
                  name="freeDeliveryThreshold"
                  step="0.01"
                  type="number"
                />
                <Input
                  defaultValue={config.deliveryEstimate}
                  hint="Printed under the total at checkout."
                  label="Delivery estimate"
                  name="deliveryEstimate"
                />
                <DeliveryWindowFields schedule={config.deliverySchedule} />
                <Input
                  defaultValue={toRupees(config.maxOrderTotal)}
                  hint="A guard against a mistyped quantity. Orders above this are refused."
                  label="Single-order limit (NPR)"
                  min="0"
                  name="maxOrderTotal"
                  step="0.01"
                  type="number"
                />
                <Input
                  defaultValue={config.closedMessage}
                  hint="Shown in the app when the store is closed."
                  label="Closed message"
                  name="closedMessage"
                />

                <SubmitButton className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-role-platform text-sm font-semibold text-white">
                  Save settings
                </SubmitButton>
              </BusyForm>
            )}
          </Panel>

          <Panel title="Shop status">
            {config ? (
              <ToggleSwitch
                checked={config.isOpen}
                description="Closing keeps the catalogue intact and stops new orders. The app shows the closed message rather than hiding the Store button — a button that vanishes reads as a bug."
                label="Store is open"
                onChange={(next) => void patchSettings({ isOpen: next })}
              />
            ) : (
              <LoadingRows />
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
});

function DeliveryWindowFields({
  schedule,
}: {
  schedule: StoreSettings["deliverySchedule"];
}) {
  const [morningCutoffHour, setMorningCutoffHour] = useState(
    String(schedule.morningCutoffHour),
  );
  const [eveningCutoffHour, setEveningCutoffHour] = useState(
    String(schedule.eveningCutoffHour),
  );
  const [morningArrivalText, setMorningArrivalText] = useState(
    schedule.morningArrivalText,
  );
  const [eveningArrivalText, setEveningArrivalText] = useState(
    schedule.eveningArrivalText,
  );

  const [currentNepalHour] = useState(
    () => new Date(Date.now() + (5 * 60 + 45) * 60 * 1000).getUTCHours(),
  );
  const arrivesText =
    currentNepalHour < Number(eveningCutoffHour) ? morningArrivalText : eveningArrivalText;

  return (
    <fieldset className="grid gap-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">Delivery windows</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Morning cutoff (Nepal time)"
          max="23"
          min="0"
          name="morningCutoffHour"
          onChange={(event) => setMorningCutoffHour(event.target.value)}
          type="number"
          value={morningCutoffHour}
        />
        <Input
          label="Evening cutoff (Nepal time)"
          max="23"
          min="0"
          name="eveningCutoffHour"
          onChange={(event) => setEveningCutoffHour(event.target.value)}
          type="number"
          value={eveningCutoffHour}
        />
      </div>
      <Input
        label="Before evening cutoff, arrives"
        name="morningArrivalText"
        onChange={(event) => setMorningArrivalText(event.target.value)}
        value={morningArrivalText}
      />
      <Input
        label="After evening cutoff, arrives"
        name="eveningArrivalText"
        onChange={(event) => setEveningArrivalText(event.target.value)}
        value={eveningArrivalText}
      />
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        An order placed now arrives {arrivesText}.
      </p>
    </fieldset>
  );
}
