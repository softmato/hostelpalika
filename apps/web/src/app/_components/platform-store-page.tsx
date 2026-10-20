"use client";

import {
  Boxes,
  Eye,
  EyeOff,
  Package,
  PackageX,
  Pencil,
  Plus,
  ShoppingBag,
  Tags,
  Trash2,
} from "@/components/icons";
import { resolveGlyph } from "@hostel/shared/constants/glyphs";
import Link from "next/link";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  TabBar,
  ToggleSwitch,
} from "@/app/_components/portal-dashboard-ui";
import { FactChip } from "@/app/_components/platform-page-ui";
import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [categoryFormOpen, setCategoryFormOpen] = useState(false);

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
        setCategoryFormOpen(false);
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
  const openProductForm = (product: StoreProduct | null) => {
    setEditingProduct(product);
    setTab("add");
  };
  const openCategoryForm = (category: StoreCategory | null) => {
    editCategory(category);
    setCategoryFormOpen(true);
  };

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          <>
            <RoleButton asChild variant="outline">
              <Link href="/platform/store/orders">
                <Package className="size-3.5" />
                {counts?.openOrders ? `${counts.openOrders} to fulfil` : "Orders"}
              </Link>
            </RoleButton>
            <RoleButton onClick={() => openProductForm(null)} type="button">
              <Plus className="size-3.5" />
              New product
            </RoleButton>
          </>
        }
        description="The catalogue every hostel orders from, and what delivery costs."
        title="Supply Store"
      />
      <Message value={message || products.message} />

      {counts ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={ShoppingBag}
            label="Live products"
            note={counts.products > 0 ? `${Math.round((counts.live / counts.products) * 100)}% of all` : undefined}
            value={counts.live}
          />
          <MetricCard icon={Boxes} label="Products" value={counts.products} />
          <MetricCard icon={Tags} label="Categories" value={counts.categories} />
          <MetricCard
            icon={PackageX}
            label="Out of stock"
            tone={counts.outOfStock > 0 ? "amber" : "slate"}
            value={counts.outOfStock}
          />
        </div>
      ) : null}

      <TabBar
        onChange={(key) => setTab(key as typeof tab)}
        tabs={[
          { key: "products", label: "Products" },
          { key: "categories", label: "Categories" },
          { key: "settings", label: "Delivery & fees" },
        ]}
        tone="platform"
        value={tab === "add" ? "products" : tab}
      />

      {tab === "products" || tab === "add" ? (
        <Panel title="Catalogue">
          {products.state === "loading" ? <LoadingRows /> : null}
          {products.state === "ready" && productRows.length === 0 ? (
            <EmptyState label="Nothing in the shop yet. Add a category first, then a product." />
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {productRows.map((product) => (
              <article
                className="group overflow-hidden rounded-2xl border border-border/70 bg-card transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={product.id}
              >
                <div className="relative aspect-[4/3] overflow-hidden bg-muted">
                  {product.images[0]?.url ? (
                    /* A catalogue thumbnail from whatever host the supplier
                       gave us. `next/image` would need every one of those
                       hosts added to `remotePatterns`, which turns adding a
                       product into a deploy. */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      alt=""
                      className="size-full object-cover transition duration-500 group-hover:scale-[1.03]"
                      src={product.images[0].url}
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-muted-foreground">
                      <ShoppingBag className="size-8" />
                    </span>
                  )}
                  <span className="absolute left-2.5 top-2.5 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                    {product.isActive ? "Live" : "Hidden"}
                  </span>
                </div>

                <div className="space-y-3 p-4">
                  <div className="min-w-0">
                    <h3 className="truncate font-heading text-[15px] font-bold tracking-tight text-foreground">{product.name}</h3>
                    <p className="truncate text-[12.5px] text-muted-foreground">
                      {product.categoryName || "No category"} · per {product.unit}
                    </p>
                  </div>

                  <p className="text-[15px] font-bold tabular-nums text-foreground">
                    {formatPaisa(product.price)}
                    {product.compareAtPrice ? (
                      <span className="ml-1.5 text-[12px] font-normal text-muted-foreground line-through">
                        {formatPaisa(product.compareAtPrice)}
                      </span>
                    ) : null}
                  </p>

                  <div className="flex flex-wrap gap-1.5">
                    {product.trackStock ? (
                      <FactChip glyph="cube" tone={product.stockOnHand <= 0 ? "rose" : "neutral"}>
                        {product.stockOnHand <= 0 ? "Out of stock" : `${product.stockOnHand} in stock`}
                      </FactChip>
                    ) : (
                      <FactChip glyph="cube">Stock not tracked</FactChip>
                    )}
                    {product.isFeatured ? <FactChip glyph="star" tone="brand">Featured</FactChip> : null}
                    {/* Visible to the one person who can fix it. A product
                        with no photograph draws a glyph on the phone, which
                        reads as a failed image rather than as a gap in the
                        catalogue. */}
                    {product.images.length === 0 ? <FactChip glyph="image-off" tone="amber">No photo</FactChip> : null}
                  </div>

                  <div className="flex gap-2">
                    <Button onClick={() => openProductForm(product)} size="sm" type="button" variant="outline">
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    <Button onClick={() => void toggleProduct(product)} size="sm" type="button" variant="ghost">
                      {product.isActive ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      {product.isActive ? "Hide" : "Make live"}
                    </Button>
                    <Button
                      aria-label={`Delete ${product.name}`}
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={() => void removeProduct(product)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      ) : null}

      {/* The product studio — the form, its example and its preview — in one
          wide dialog. A create keeps it open, cleared, for the next product. */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setEditingProduct(null);
            setTab("products");
          }
        }}
        open={tab === "add"}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>{editingProduct ? `Edit ${editingProduct.name}` : "New product"}</DialogTitle>
            <DialogDescription>Prices are in rupees; stock and order limits are per unit.</DialogDescription>
          </DialogHeader>
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
        </DialogContent>
      </Dialog>

      {tab === "categories" ? (
        <Panel
          action={
            <Button onClick={() => openCategoryForm(null)} size="sm" type="button" variant="outline">
              <Plus className="size-3.5" />
              New category
            </Button>
          }
          title="Departments"
        >
          {categories.state === "loading" ? <LoadingRows /> : null}
          {categories.state === "ready" && categoryRows.length === 0 ? (
            <EmptyState label="No categories yet." />
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {categoryRows.map((category) => (
              <div
                className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3.5 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={category.id}
              >
                <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-role-team-soft text-role-team">
                  {category.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" className="size-full object-cover" src={category.imageUrl} />
                  ) : (
                    <Glyph className="size-5" name={resolveGlyph(category.icon)} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13.5px] font-semibold text-foreground">{category.name}</p>
                    {category.isActive ? null : <SoftBadge tone="slate">Hidden</SoftBadge>}
                  </div>
                  <p className="truncate text-[12px] text-muted-foreground">
                    {category.productCount} {category.productCount === 1 ? "product" : "products"} · /{category.slug}
                  </p>
                </div>
                <Button
                  aria-label={`Edit ${category.name}`}
                  onClick={() => openCategoryForm(category)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  aria-label={`Delete ${category.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void removeCategory(category)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          setCategoryFormOpen(open);
          if (!open) editCategory(null);
        }}
        open={categoryFormOpen}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCategory ? `Edit ${editingCategory.name}` : "New category"}</DialogTitle>
            <DialogDescription>Higher priority shows first in the shop grid.</DialogDescription>
          </DialogHeader>
          <BusyForm className="grid gap-3" key={editingCategory?.id ?? "new"} onSubmit={saveCategory}>
            <Input defaultValue={editingCategory?.name} label="Name" name="name" placeholder="Bedding" required />
            <Input
              defaultValue={editingCategory?.slug}
              hint="Blank builds one from the name."
              label="Handle"
              name="slug"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                defaultValue={editingCategory?.icon ?? "bed"}
                hint="A glyph name: bed, water, restaurant."
                label="Icon"
                name="icon"
              />
              <Input defaultValue={editingCategory?.priority ?? 0} label="Priority" name="priority" type="number" />
            </div>
            <StoreImageInput
              hint="Optional; the icon shows when there is none."
              label="Tile image"
              maxImages={1}
              onChange={setCategoryImage}
              rows={categoryImage}
              scope="store-category-image"
            />
            <DialogFooter>
              <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">
                {editingCategory ? "Save changes" : "Add category"}
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>

      {tab === "settings" ? (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Delivery and fees">
            {settings.state === "loading" || !config ? (
              <LoadingRows />
            ) : (
              <BusyForm className="grid max-w-xl gap-3" onSubmit={saveSettings}>
                <Input
                  defaultValue={toRupees(config.deliveryFee)}
                  hint="On every order under the free-delivery line."
                  label="Delivery fee (NPR)"
                  min="0"
                  name="deliveryFee"
                  step="0.01"
                  type="number"
                />
                <Input
                  defaultValue={toRupees(config.freeDeliveryThreshold)}
                  hint="0 turns the rule off; it does not make delivery free."
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
                  hint="Orders above this are refused."
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

                <div>
                  <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">Save settings</SubmitButton>
                </div>
              </BusyForm>
            )}
          </Panel>

          <Panel title="Shop status">
            {config ? (
              <ToggleSwitch
                checked={config.isOpen}
                description="Closed stops new orders and shows the closed message."
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
