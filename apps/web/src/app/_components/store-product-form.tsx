"use client";

import { Check, ChevronDown, Plus, ShoppingBag, Sparkles } from "@/components/icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Input, Panel, TextArea } from "@/app/_components/shared-ui";
import { SoftBadge } from "@/app/_components/portal-dashboard-ui";
import {
  StoreImageInput,
  storeImageRows,
  type StoreImageValue,
} from "@/app/_components/store-image-input";
import {
  discountPercent,
  formatPaisa,
  slugify,
  toPaisa,
  toRupees,
  type StoreCategory,
  type StoreProduct,
} from "@/app/_components/store-admin-shared";
import { browserApi } from "@/lib/browser-api";

/**
 * The **Add product** tab: one product form with room to work, and a preview of
 * what the phone will draw beside it.
 *
 * ## Why this is a tab and not the sidebar it used to be
 *
 * The form lived in a 400 px column next to the catalogue list, which is enough
 * width for a name and nothing else — every paired row (`price`/`was`,
 * `min`/`max`) collapsed onto itself and the fields ran together into one
 * undifferentiated stack. Stocking a shop is a *task*, not a glance, and it gets
 * its own screen for the same reason fulfilment does.
 *
 * Editing reuses this exact form rather than a second one. There is one place a
 * product is described, so a field added here cannot be missing there.
 *
 * ## Every field is controlled, and that is what makes the preview honest
 *
 * A `defaultValue` form would need the preview to read the DOM, which only tells
 * you the truth after a render nobody triggered. Holding the values in state
 * means the card on the right is drawn from the same object the POST body is
 * built from — they cannot disagree.
 *
 * ## The preview is a mock, not the real component
 *
 * The mobile card cannot be imported here — it is React Native. So this is a
 * deliberate restatement of its layout (square artwork, name over `per <unit>`,
 * price bottom-left, add button bottom-right, discount badge top-left) in the
 * web's tokens. When the phone's card changes, this has to be changed with it;
 * that cost is the price of showing somebody what they are making before they
 * save it.
 */

const UNITS = ["piece", "set", "pair", "kg", "litre", "metre", "dozen", "packet", "box"];

type FormState = {
  categoryId: string;
  compareAtPrice: string;
  description: string;
  isActive: boolean;
  isFeatured: boolean;
  maxOrderQuantity: string;
  minOrderQuantity: string;
  name: string;
  price: string;
  priority: string;
  slug: string;
  stockQuantity: string;
  summary: string;
  tags: string;
  trackStock: boolean;
  unit: string;
};

const BLANK: FormState = {
  categoryId: "",
  compareAtPrice: "",
  description: "",
  isActive: true,
  isFeatured: false,
  maxOrderQuantity: "0",
  minOrderQuantity: "1",
  name: "",
  price: "",
  priority: "0",
  slug: "",
  stockQuantity: "0",
  summary: "",
  tags: "",
  trackStock: true,
  unit: "piece",
};

/**
 * The house standard, as a product rather than as a paragraph of rules.
 *
 * A worked example is read; a style guide is not. The button that loads it into
 * the form is the point — somebody adding their first product gets the shape of
 * a good one and edits it, instead of guessing at what "summary" means and
 * writing the name again.
 */
const EXAMPLE: FormState = {
  categoryId: "",
  compareAtPrice: "3200",
  description:
    "A 3 inch cotton-filled mattress for a standard single hostel bed.\n\nCover: cotton drill, machine washable.\nFilling: recycled cotton, 4.5 kg.\nSize: 6 ft × 3 ft (183 × 91 cm).\nFits: every single frame and bunk we sell.",
  isActive: true,
  isFeatured: false,
  maxOrderQuantity: "60",
  minOrderQuantity: "1",
  name: "Cotton mattress, 3 inch",
  price: "2450",
  priority: "10",
  slug: "cotton-mattress-3-inch",
  stockQuantity: "120",
  summary: "Single bed, cotton filled — 6 ft × 3 ft",
  tags: "mattress, gaddi, bed, bedding, single",
  trackStock: true,
  unit: "piece",
};

function stateFor(product: StoreProduct | null, fallbackCategoryId: string): FormState {
  if (!product) {
    return { ...BLANK, categoryId: fallbackCategoryId };
  }

  return {
    categoryId: product.categoryId,
    compareAtPrice: product.compareAtPrice ? String(toRupees(product.compareAtPrice)) : "",
    description: product.description,
    isActive: product.isActive,
    isFeatured: product.isFeatured,
    maxOrderQuantity: String(product.maxOrderQuantity),
    minOrderQuantity: String(product.minOrderQuantity),
    name: product.name,
    price: String(toRupees(product.price)),
    priority: "0",
    slug: product.slug,
    stockQuantity: String(product.stockOnHand),
    summary: product.summary,
    tags: product.tags.join(", "),
    trackStock: product.trackStock,
    unit: product.unit,
  };
}

function money(value: string) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

export function StoreProductForm({
  categories,
  editing,
  onCancelEdit,
  onCategoryCreated,
  onSaved,
  setMessage,
}: {
  categories: StoreCategory[];
  editing: StoreProduct | null;
  onCancelEdit: () => void;
  onCategoryCreated: () => void;
  onSaved: (verb: "added" | "updated") => void;
  setMessage: (message: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() =>
    stateFor(editing, categories[0]?.id ?? ""),
  );
  const [images, setImages] = useState(() => storeImageRows(editing?.images ?? []));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

  /*
   * Reloading the fields when the *subject* changes — a different product picked
   * for editing, or edit mode left — rather than on every render of a changed
   * product. Keyed on the id, so a background refetch of the catalogue cannot
   * overwrite what is being typed. (The parent also remounts on `key`; this is
   * the belt to that pair of braces, and costs one string comparison.)
   */
  const subject = editing?.id ?? "new";
  const loaded = useRef(subject);

  useEffect(() => {
    if (loaded.current === subject) {
      return;
    }

    loaded.current = subject;
    setForm(stateFor(editing, categories[0]?.id ?? ""));
    setImages(storeImageRows(editing?.images ?? []));
    setErrors({});
  }, [categories, editing, subject]);

  const set = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((current) => ({ ...current, [key]: value }));
      setErrors((current) => ({ ...current, [key]: undefined }));
    },
    [],
  );

  const fillExample = useCallback(() => {
    setForm({ ...EXAMPLE, categoryId: categories[0]?.id ?? "" });
    setErrors({});
  }, [categories]);

  const priceP = toPaisa(money(form.price));
  const compareP = form.compareAtPrice ? toPaisa(money(form.compareAtPrice)) : null;
  const discount = discountPercent(priceP, compareP);

  const save = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      /*
       * Checked here as well as by the server's zod schema, and not for the sake
       * of duplication: a 422 arrives as one line at the top of the page, where
       * this puts the message under the field it is about.
       */
      const next: Partial<Record<keyof FormState, string>> = {};

      if (!form.name.trim()) {
        next.name = "Every product needs a name.";
      }

      if (!form.categoryId) {
        next.categoryId = "Pick a department, or create one.";
      }

      if (money(form.price) <= 0) {
        next.price = "What does a hostel pay for one?";
      }

      if (compareP !== null && compareP <= priceP) {
        next.compareAtPrice = "The struck-through price has to be above the selling price.";
      }

      const min = Number(form.minOrderQuantity) || 1;
      const max = Number(form.maxOrderQuantity) || 0;

      if (max > 0 && max < min) {
        next.maxOrderQuantity = "The maximum per order cannot be below the minimum.";
      }

      if (Object.keys(next).length > 0) {
        setErrors(next);
        return;
      }

      const payload = {
        categoryId: form.categoryId,
        // `null` clears it on an edit; `undefined` on a create simply omits it.
        compareAtPrice: compareP ?? (editing ? null : undefined),
        description: form.description.trim(),
        images: images.map(
          (row): StoreImageValue =>
            row.assetId ? { assetId: row.assetId } : { url: row.url ?? "" },
        ),
        isActive: form.isActive,
        isFeatured: form.isFeatured,
        maxOrderQuantity: max,
        minOrderQuantity: Math.max(min, 1),
        name: form.name.trim(),
        price: priceP,
        priority: Number(form.priority) || 0,
        slug: form.slug.trim() || slugify(form.name),
        stockQuantity: Number(form.stockQuantity) || 0,
        summary: form.summary.trim(),
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        trackStock: form.trackStock,
        unit: form.unit.trim() || "piece",
      };

      try {
        await browserApi(
          editing
            ? `/api/v1/platform/store/products/${editing.id}`
            : "/api/v1/platform/store/products",
          { body: JSON.stringify(payload), method: editing ? "PATCH" : "POST" },
        );

        if (!editing) {
          setForm({ ...BLANK, categoryId: form.categoryId });
          setImages([]);
        }

        onSaved(editing ? "updated" : "added");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not save the product.");
      }
    },
    [compareP, editing, form, images, onSaved, priceP, setMessage],
  );

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="grid gap-5">
        <ExampleCard onFill={fillExample} />

        <Panel title={editing ? `Edit ${editing.name}` : "New product"}>
          {categories.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              Create a department first — every product sits in one. You can do it from
              the field below without leaving this tab.
            </p>
          ) : null}

          <BusyForm className="grid gap-6" onSubmit={save}>
            <Fieldset title="What it is">
              <Field error={errors.name}>
                <Input
                  label="Name"
                  name="name"
                  onChange={(event) => set("name", event.target.value)}
                  placeholder="Cotton mattress, 3 inch"
                  value={form.name}
                />
              </Field>

              <Field error={errors.categoryId}>
                <CategoryPicker
                  categories={categories}
                  onChange={(id) => set("categoryId", id)}
                  onCreated={onCategoryCreated}
                  setMessage={setMessage}
                  value={form.categoryId}
                />
              </Field>

              <Input
                hint="The one line under the name in a list. State the facts — size, material, what it fits."
                label="Summary"
                name="summary"
                onChange={(event) => set("summary", event.target.value)}
                placeholder="Single bed, cotton filled — 6 ft × 3 ft"
                value={form.summary}
              />

              <TextArea
                label="Description"
                name="description"
                onChange={(event) => set("description", event.target.value)}
                placeholder={"What it is.\n\nCover:\nFilling:\nSize:\nFits:"}
                value={form.description}
              />

              <Input
                hint="Comma separated. These are what the shop's search box matches — include the Nepali word."
                label="Search tags"
                name="tags"
                onChange={(event) => set("tags", event.target.value)}
                placeholder="mattress, gaddi, bed"
                value={form.tags}
              />
            </Fieldset>

            <Fieldset title="Photos">
              <StoreImageInput
                hint="The first one is the thumbnail everywhere — the shop grid, the cart, the order and the notification. Up to 8."
                label="Product photos"
                onChange={setImages}
                rows={images}
                scope="store-product-images"
              />
            </Fieldset>

            <Fieldset title="Price">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field error={errors.price}>
                  <Input
                    hint={`What a hostel pays. Charged per ${form.unit || "piece"}.`}
                    label="Selling price (NPR)"
                    min="0"
                    name="price"
                    onChange={(event) => set("price", event.target.value)}
                    step="0.01"
                    type="number"
                    value={form.price}
                  />
                </Field>
                <Field error={errors.compareAtPrice}>
                  <Input
                    hint="Optional. Shown crossed out beside the selling price, so it has to be higher. Leave blank when there is no offer."
                    label="Struck-through price (NPR)"
                    min="0"
                    name="compareAtPrice"
                    onChange={(event) => set("compareAtPrice", event.target.value)}
                    step="0.01"
                    type="number"
                    value={form.compareAtPrice}
                  />
                </Field>
              </div>

              {discount ? (
                <p className="text-[11px] text-muted-foreground">
                  The shop will show a{" "}
                  <strong className="text-foreground">{discount}% off</strong> badge —{" "}
                  {formatPaisa(priceP)} instead of {formatPaisa(compareP ?? 0)}.
                </p>
              ) : null}

              <label className="grid gap-2 text-sm font-semibold text-foreground">
                Unit
                <input
                  className="h-11 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none focus:border-role-platform"
                  list="store-units"
                  name="unit"
                  onChange={(event) => set("unit", event.target.value)}
                  placeholder="piece"
                  value={form.unit}
                />
                <datalist id="store-units">
                  {UNITS.map((unit) => (
                    <option key={unit} value={unit} />
                  ))}
                </datalist>
                <span className="text-[11px] font-normal text-muted-foreground">
                  What one of them is. Printed beside the price as “per {form.unit || "piece"}”.
                </span>
              </label>
            </Fieldset>

            <Fieldset title="Stock and limits">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Stock on hand"
                  min="0"
                  name="stockQuantity"
                  onChange={(event) => set("stockQuantity", event.target.value)}
                  type="number"
                  value={form.stockQuantity}
                />
                <Input
                  hint="Fewest a hostel can order at once."
                  label="Minimum per order"
                  min="1"
                  name="minOrderQuantity"
                  onChange={(event) => set("minOrderQuantity", event.target.value)}
                  type="number"
                  value={form.minOrderQuantity}
                />
              </div>

              <Field error={errors.maxOrderQuantity}>
                <Input
                  hint="0 means no cap."
                  label="Maximum per order"
                  min="0"
                  name="maxOrderQuantity"
                  onChange={(event) => set("maxOrderQuantity", event.target.value)}
                  type="number"
                  value={form.maxOrderQuantity}
                />
              </Field>

              <Toggle
                checked={form.trackStock}
                label="Track stock — refuse orders once it runs out"
                onChange={(next) => set("trackStock", next)}
              />
            </Fieldset>

            <Fieldset title="Placement">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  hint="Leave blank to build one from the name. Changing it breaks old links."
                  label="Handle"
                  name="slug"
                  onChange={(event) => set("slug", event.target.value)}
                  placeholder={slugify(form.name) || "cotton-mattress-3-inch"}
                  value={form.slug}
                />
                <Input
                  hint="Higher shows first."
                  label="Priority"
                  name="priority"
                  onChange={(event) => set("priority", event.target.value)}
                  type="number"
                  value={form.priority}
                />
              </div>

              <Toggle
                checked={form.isFeatured}
                label="Feature on the shop's front screen"
                onChange={(next) => set("isFeatured", next)}
              />
              <Toggle
                checked={form.isActive}
                label="Live — hostels can see and order it"
                onChange={(next) => set("isActive", next)}
              />
            </Fieldset>

            <div className="flex gap-2">
              <SubmitButton className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-role-platform text-sm font-semibold text-white">
                {editing ? "Save changes" : "Add product"}
              </SubmitButton>
              {editing ? (
                <button
                  className="h-11 rounded-md border border-border px-4 text-sm font-semibold text-foreground"
                  onClick={onCancelEdit}
                  type="button"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </BusyForm>
        </Panel>
      </div>

      <div className="xl:sticky xl:top-4 xl:self-start">
        <PreviewColumn
          categoryName={
            categories.find((category) => category.id === form.categoryId)?.name ?? ""
          }
          comparePaisa={compareP}
          discount={discount}
          form={form}
          imageUrl={images[0]?.previewUrl ?? ""}
          pricePaisa={priceP}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Fieldset({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 font-heading text-[12px] font-bold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/** Wraps a field so its message sits under it rather than at the top of the page. */
function Field({ children, error }: { children: React.ReactNode; error?: string }) {
  return (
    <div className="grid gap-1">
      {children}
      {error ? <p className="text-[11px] font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12.5px] font-semibold text-foreground">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

function ExampleCard({ onFill }: { onFill: () => void }) {
  return (
    <Panel
      action={
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-semibold text-foreground transition hover:bg-muted"
          onClick={onFill}
          type="button"
        >
          <Sparkles className="size-3.5" />
          Fill the form with this
        </button>
      }
      title="What a good product looks like"
    >
      <dl className="grid gap-2 text-[12.5px] sm:grid-cols-2">
        <Row label="Name" value="Cotton mattress, 3 inch" />
        <Row label="Summary" value="Single bed, cotton filled — 6 ft × 3 ft" />
        <Row
          label="Description"
          value="What it is, then Cover / Filling / Size / Fits on their own lines."
        />
        <Row label="Photos" value="3 — the whole thing, a close detail, one in use." />
        <Row label="Unit" value="piece · price is what one costs" />
        <Row label="Tags" value="mattress, gaddi, bed — include the Nepali word" />
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground">
        The name says what it is and its one distinguishing measurement. The summary never
        repeats the name. The description is scannable lines, not a paragraph — a hostel
        owner is checking whether it fits their frames, not reading copy.
      </p>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-2.5 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-foreground">{value}</dd>
    </div>
  );
}

/**
 * A department picker that filters as you type and offers to create what is not
 * there.
 *
 * A `<select>` was fine at four departments and is not at twenty, and it has no
 * answer at all for the case that actually stops somebody: the shelf they need
 * does not exist yet, and creating it means leaving the form they have half
 * filled in.
 */
function CategoryPicker({
  categories,
  onChange,
  onCreated,
  setMessage,
  value,
}: {
  categories: StoreCategory[];
  onChange: (id: string) => void;
  onCreated: () => void;
  setMessage: (message: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const selected = categories.find((category) => category.id === value);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return needle
      ? categories.filter(
          (category) =>
            category.name.toLowerCase().includes(needle) ||
            category.slug.includes(needle),
        )
      : categories;
  }, [categories, query]);

  const exact = matches.some(
    (category) => category.name.toLowerCase() === query.trim().toLowerCase(),
  );

  const create = useCallback(async () => {
    const name = query.trim();

    if (!name) {
      return;
    }

    setCreating(true);

    try {
      const created = await browserApi<{ category: StoreCategory }>(
        "/api/v1/platform/store/categories",
        {
          body: JSON.stringify({
            icon: "cube",
            name,
            priority: 0,
            slug: slugify(name),
          }),
          method: "POST",
        },
      );

      const id = created?.category?.id;

      // The list this picker reads is the parent's, so it has to be refetched
      // before the new id can be found in it — but the selection can be made
      // now, from the id the create returned.
      onCreated();

      if (id) {
        onChange(id);
      }

      setQuery("");
      setOpen(false);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create that category.",
      );
    } finally {
      setCreating(false);
    }
  }, [onChange, onCreated, query, setMessage]);

  return (
    <div className="grid gap-2 text-sm font-semibold text-foreground">
      Category
      <div className="relative">
        <input
          className="h-11 w-full rounded-md border border-border bg-background px-3 pr-9 text-sm font-normal outline-none focus:border-role-platform"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={selected ? selected.name : "Search departments…"}
          value={open ? query : (selected?.name ?? "")}
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

        {open ? (
          <>
            {/* Click-away. A transparent sheet rather than a document listener:
                one element, removed with the menu, nothing to leak. */}
            <button
              aria-hidden
              className="fixed inset-0 z-10 cursor-default"
              onClick={() => {
                setOpen(false);
                setQuery("");
              }}
              tabIndex={-1}
              type="button"
            />
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-surface p-1 shadow-lg">
              {matches.map((category) => (
                <li key={category.id}>
                  <button
                    className="flex w-full items-center justify-between gap-2 rounded px-2.5 py-2 text-left text-sm font-normal text-foreground transition hover:bg-muted"
                    onClick={() => {
                      onChange(category.id);
                      setOpen(false);
                      setQuery("");
                    }}
                    type="button"
                  >
                    <span className="truncate">
                      {category.name}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {category.productCount}
                      </span>
                    </span>
                    {category.id === value ? (
                      <Check className="size-3.5 shrink-0 text-role-platform" />
                    ) : null}
                  </button>
                </li>
              ))}

              {query.trim() && !exact ? (
                <li>
                  <button
                    className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm font-semibold text-role-platform transition hover:bg-muted disabled:opacity-50"
                    disabled={creating}
                    onClick={() => void create()}
                    type="button"
                  >
                    <Plus className="size-3.5" />
                    Create category “{query.trim()}”
                  </button>
                </li>
              ) : null}

              {matches.length === 0 && !query.trim() ? (
                <li className="px-2.5 py-2 text-sm font-normal text-muted-foreground">
                  No departments yet. Type a name to create the first one.
                </li>
              ) : null}
            </ul>
          </>
        ) : null}
      </div>
      <span className="text-[11px] font-normal text-muted-foreground">
        Type to search. Anything that does not match can be created from here.
      </span>
    </div>
  );
}

/**
 * What the hostel will see, drawn from what is currently in the form.
 *
 * The phone frame is not decoration: the whole reason the summary has to be
 * short and the name has to lead with the thing itself is that both are clipped
 * to two lines in a 170 dp tile, and no amount of hint text under a field
 * explains that as well as watching it truncate.
 */
function PreviewColumn({
  categoryName,
  comparePaisa,
  discount,
  form,
  imageUrl,
  pricePaisa,
}: {
  categoryName: string;
  comparePaisa: number | null;
  discount: number | null;
  form: FormState;
  imageUrl: string;
  pricePaisa: number;
}) {
  const name = form.name.trim() || "Product name";
  const unit = form.unit.trim() || "piece";

  return (
    <Panel title="How the app will show it">
      <div className="grid gap-4">
        <div className="mx-auto w-[236px] rounded-[26px] border-[6px] border-foreground/85 bg-background p-2 shadow-sm">
          <div className="mb-2 h-1 w-10 rounded-full bg-foreground/20 mx-auto" />

          {/* The shop grid tile, at the width the phone actually gives it. */}
          <div className="w-[104px] rounded-2xl border border-border bg-surface p-1.5">
            <div className="relative aspect-square overflow-hidden rounded-xl bg-muted">
              {imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img alt="" className="size-full object-cover" src={imageUrl} />
              ) : (
                <span className="grid size-full place-items-center text-muted-foreground">
                  <ShoppingBag className="size-5" />
                </span>
              )}
              {discount ? (
                <span className="absolute left-1 top-1 rounded bg-destructive px-1 py-px text-[8px] font-bold text-white">
                  {discount}% off
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 line-clamp-2 text-[10px] font-semibold leading-tight text-foreground">
              {name}
            </p>
            <p className="text-[9px] text-muted-foreground">per {unit}</p>
            <div className="mt-1 flex items-end justify-between">
              <div>
                <p className="text-[10px] font-bold text-foreground">
                  {formatPaisa(pricePaisa)}
                </p>
                {comparePaisa ? (
                  <p className="text-[8px] text-muted-foreground line-through">
                    {formatPaisa(comparePaisa)}
                  </p>
                ) : null}
              </div>
              <span className="grid size-5 place-items-center rounded-md bg-role-platform text-white">
                <Plus className="size-3" />
              </span>
            </div>
          </div>

          <div className="mt-3 border-t border-border pt-2">
            <p className="text-[11px] font-semibold leading-tight text-foreground">{name}</p>
            <p className="text-[9px] text-muted-foreground">
              {form.summary.trim() || "The summary line goes here"}
            </p>
            <p className="mt-1 text-[11px] font-bold text-foreground">
              {formatPaisa(pricePaisa)}{" "}
              <span className="font-normal text-muted-foreground">/ {unit}</span>
            </p>
            <p className="mt-1.5 whitespace-pre-line text-[9px] leading-snug text-muted-foreground line-clamp-6">
              {form.description.trim() || "The description shows here, in full."}
            </p>
          </div>
        </div>

        {/* And the plain row, as the Products tab will list it. */}
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            In your catalogue
          </p>
          <div className="flex gap-3">
            {imageUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img alt="" className="size-12 shrink-0 rounded-lg object-cover" src={imageUrl} />
            ) : (
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <ShoppingBag className="size-5" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate font-semibold text-foreground">{name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {categoryName || "No category"} · per {unit}
                {form.summary.trim() ? ` · ${form.summary.trim()}` : ""}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {formatPaisa(pricePaisa)}
                {comparePaisa ? ` (was ${formatPaisa(comparePaisa)})` : ""}
                {form.trackStock
                  ? ` · ${Number(form.stockQuantity) || 0} in stock`
                  : " · stock not tracked"}
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {form.isFeatured ? <SoftBadge tone="amber">Featured</SoftBadge> : null}
            <SoftBadge tone={form.isActive ? "green" : "slate"}>
              {form.isActive ? "Live" : "Hidden"}
            </SoftBadge>
            {!imageUrl ? <SoftBadge tone="rose">No photo</SoftBadge> : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}
