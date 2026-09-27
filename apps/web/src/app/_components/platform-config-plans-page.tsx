"use client";

import { ArrowUpRight, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { memo, useCallback, useMemo, useState } from "react";

import {
  SoftBadge,
  TabBar,
  ToggleSwitch,
} from "@/app/_components/portal-dashboard-ui";
import { useSiteConfig } from "@/components/site-config-provider";
import { currentBsPeriod, formatBsPeriod } from "@hostel/shared/calendar/bs";
import { ContentIcon } from "@/components/content-icon";
import { CONTENT_ICON_SLUGS } from "@/lib/site-content";
import { cn } from "@/lib/utils";

import { InlineText } from "./inline-text";
import {
  BillingToggle,
  PlanCards,
  PlansClosingCta,
  PlansFootnote,
  PlansHeading,
  type PlansEditor,
} from "./plans-cards";
import {
  cycleTotal,
  eventRuns,
  monthlyRateFor,
  orphanedServices,
  savingFor,
  sellingCatalog,
  sellingPlan,
  servicesByModule,
  type BillingCycle,
  type PlanModule,
  type PlanService,
  type PlanTier,
  type PlansConfig,
} from "./plans-catalog";
import {
  ConfigPage,
  ConfigPanel,
  ConfigSaveBar,
  NumberField,
  TextField,
  useSiteConfigDraft,
} from "./platform-config-shared";

/**
 * Platform → Website Config → Plans & Pricing.
 *
 * The screen is the page. `/plans-pricing` is rendered at the top of it from the
 * unsaved draft, using the very same components a visitor gets, and every label
 * on it is typed into where it is read — plan names, descriptions, button text,
 * badge names, service names, the heading, the small print, the closing pitch.
 * A column of inputs above a preview would have been easier to build and would
 * have answered a different question: a pricing card is a piece of writing whose
 * length and line breaks are the design, and only the card itself shows those.
 *
 * What cannot honestly be typed into the page sits in the tabs underneath, and
 * everything down there still moves the preview as it is edited:
 *
 *  - **Catalogue** — the modules and the services inside them. A service's own
 *    page (its what/how/why and its two walkthrough clips) is a screen of its
 *    own, reached from the arrow on any service line, here or on a card.
 *  - **Pricing** — one monthly figure per plan and a percentage off each longer
 *    commitment, with the resulting totals worked out beside them. Caps, seats
 *    and the directory badge live here too, because a number typed onto a card
 *    would be a card that reformats itself under the caret.
 *  - **Links** — where the buttons go. The words on them are edited on the page.
 *
 * One Save for the screen, not one per card: every control here writes into the
 * same `plans` section, so per-card saves would be three buttons that all did
 * the same thing to the same document.
 */
export const PlatformConfigPlansPageContent = memo(
  function PlatformConfigPlansPageContent() {
    const { identity } = useSiteConfig();
    const { error, isDirty, message, reset, save, savingSection, setValue, state, valueFor } =
      useSiteConfigDraft();

    const catalog = valueFor("plans");
    const [cycle, setCycle] = useState<BillingCycle>("annual");
    // In `?tab=` so the palette can deep-link to a field on any tab.
    const router = useRouter();
    const pathname = usePathname();
    const requested = useSearchParams().get("tab") ?? "";
    const tab = ["pricing", "offer", "links"].includes(requested) ? requested : "catalogue";
    const setTab = (key: string) => router.replace(`${pathname}?tab=${key}`, { scroll: false });

    /*
     * The preview is priced the way a visitor's page is priced — through the
     * same `sellingCatalog` the public projection runs — so switching the mode
     * to Event shows the offer on the cards rather than leaving the owner to
     * imagine it. Every control still writes into `catalog`, never into this:
     * an event discounts prices, it never edits them.
     */
    const sold = useMemo(() => sellingCatalog(catalog, currentBsPeriod()), [catalog]);

    const patch = useCallback(
      (changes: Partial<PlansConfig>) => setValue("plans", { ...catalog, ...changes }),
      [catalog, setValue],
    );

    const patchPlan = useCallback(
      (planId: string, changes: Partial<PlanTier>) =>
        patch({
          plans: catalog.plans.map((plan) =>
            plan.id === planId ? { ...plan, ...changes } : plan,
          ),
        }),
      [catalog.plans, patch],
    );

    const patchService = useCallback(
      (slug: string, changes: Partial<PlanService>) =>
        patch({
          services: catalog.services.map((service) =>
            service.slug === slug ? { ...service, ...changes } : service,
          ),
        }),
      [catalog.services, patch],
    );

    const editor: PlansEditor = useMemo(
      () => ({
        onPatchCycleLabels: (changes) =>
          patch({ cycleLabels: { ...catalog.cycleLabels, ...changes } }),
        onPatchPage: (changes) => patch({ page: { ...catalog.page, ...changes } }),
        onPatchPlan: patchPlan,
        onPatchService: patchService,
        serviceHrefFor: (slug) => `/platform/config/plans/${slug}`,
      }),
      [catalog.cycleLabels, catalog.page, patch, patchPlan, patchService],
    );

    const dirty = isDirty("plans");

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Plans & Pricing"]}
        description="The public Plans & Pricing page, edited on the page itself. Type into any label below; prices and the catalogue are in the tabs underneath, and everything moves the preview as you change it."
        error={error}
        message={message}
        state={state}
        title="Plans & Pricing"
      >
        <ConfigSaveBar
          dirty={dirty}
          onReset={() => reset("plans")}
          onSave={() => save("plans")}
          saving={savingSection === "plans"}
        />

        <section className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card px-3.5 py-2.5">
            <div>
              <h2 className="font-heading text-[13.5px] font-bold text-foreground">
                The page itself
              </h2>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Every tinted label is editable. <code>{"{siteName}"}</code> is left as
                written here and replaced with the platform&apos;s name on the live page.
              </p>
            </div>
            <Link
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
              href="/plans-pricing"
              target="_blank"
            >
              Open live page
              <ArrowUpRight className="size-3" />
            </Link>
          </header>

          <div className="px-4 py-6 md:px-6">
            <div className="text-center">
              <PlansHeading catalog={catalog} editor={editor} />
              <BillingToggle
                catalog={sold}
                cycle={cycle}
                editor={editor}
                onCycleChange={setCycle}
              />
            </div>

            <PlanCards animate={false} catalog={sold} cycle={cycle} editor={editor} />

            <PlansFootnote catalog={catalog} editor={editor} identity={identity} />

            <PlansClosingCta
              animate={false}
              catalog={catalog}
              editor={editor}
              identity={identity}
            />
          </div>
        </section>

        <TabBar
          onChange={setTab}
          tabs={[
            { count: catalog.services.length, key: "catalogue", label: "Catalogue" },
            { count: catalog.plans.length, key: "pricing", label: "Pricing" },
            { key: "offer", label: "Offer" },
            { key: "links", label: "Links" },
          ]}
          value={tab}
        />

        {tab === "catalogue" ? (
          <CatalogueTab catalog={catalog} onPatch={patch} onPatchService={patchService} />
        ) : null}
        {tab === "pricing" ? (
          <PricingTab catalog={catalog} onPatch={patch} onPatchPlan={patchPlan} />
        ) : null}
        {tab === "offer" ? (
          <OfferTab catalog={catalog} onPatch={patch} onPatchPlan={patchPlan} />
        ) : null}
        {tab === "links" ? (
          <LinksTab catalog={catalog} onPatch={patch} onPatchPlan={patchPlan} />
        ) : null}
      </ConfigPage>
    );
  },
);

/** Move up / move down / remove, small enough to sit on a row without owning it. */
function RowControls({
  canRemove = true,
  index,
  onMove,
  onRemove,
  removeTitle,
  total,
}: {
  canRemove?: boolean;
  index: number;
  onMove: (delta: number) => void;
  onRemove: () => void;
  removeTitle?: string;
  total: number;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        aria-label="Move up"
        className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-40"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        type="button"
      >
        ↑
      </button>
      <button
        aria-label="Move down"
        className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted disabled:opacity-40"
        disabled={index === total - 1}
        onClick={() => onMove(1)}
        type="button"
      >
        ↓
      </button>
      <button
        aria-label="Remove"
        className="rounded border border-rose-200 px-1.5 py-0.5 text-rose-600 transition hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900 dark:hover:bg-rose-950/40"
        disabled={!canRemove}
        onClick={onRemove}
        title={removeTitle}
        type="button"
      >
        <Trash2 className="size-3" />
      </button>
    </span>
  );
}

function moved<Item>(items: Item[], index: number, delta: number) {
  const target = index + delta;

  if (target < 0 || target >= items.length) {
    return items;
  }

  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];

  return next;
}

/**
 * A slug is an address. It is derived from the name only when the thing is
 * created, never after: a service that has been linked to, indexed and put in a
 * sitemap does not get a new URL because somebody fixed a typo in its title.
 */
function slugify(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || fallback;
}

function uniqueSlug(base: string, taken: Set<string>) {
  if (!taken.has(base)) {
    return base;
  }

  let n = 2;

  while (taken.has(`${base}-${n}`)) {
    n += 1;
  }

  return `${base}-${n}`;
}

function CatalogueTab({
  catalog,
  onPatch,
  onPatchService,
}: {
  catalog: PlansConfig;
  onPatch: (changes: Partial<PlansConfig>) => void;
  onPatchService: (slug: string, changes: Partial<PlanService>) => void;
}) {
  const grouped = servicesByModule(catalog);
  const orphans = orphanedServices(catalog);

  function patchModule(id: string, changes: Partial<PlanModule>) {
    onPatch({
      modules: catalog.modules.map((module) =>
        module.id === id ? { ...module, ...changes } : module,
      ),
    });
  }

  function addService(moduleId: string) {
    const taken = new Set(catalog.services.map((service) => service.slug));

    onPatch({
      services: [
        ...catalog.services,
        {
          audience: [],
          blurb: "",
          demo: { mobileAssetId: "", webAssetId: "" },
          how: [],
          module: moduleId,
          name: "New service",
          plan: catalog.plans[0]?.id ?? "",
          slug: uniqueSlug("new-service", taken),
          what: [],
          why: [],
        },
      ],
    });
  }

  function addModule() {
    const taken = new Set(catalog.modules.map((module) => module.id));

    onPatch({
      modules: [
        ...catalog.modules,
        {
          description: "",
          icon: "sparkles",
          id: uniqueSlug("new-module", taken),
          name: "New module",
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      <ConfigPanel
        description="The nine groups the product is sold in, and every service inside them. Names and one-liners are typed in place; open a service for its walkthrough clips and its what / how / why."
        title="Modules & services"
      >
        <div className="space-y-3">
          {grouped.map(({ module, services }, index) => (
            <ModuleRow
              catalog={catalog}
              index={index}
              key={module.id}
              module={module}
              onAddService={() => addService(module.id)}
              onMove={(delta) =>
                onPatch({ modules: moved(catalog.modules, index, delta) })
              }
              onPatchModule={(changes) => patchModule(module.id, changes)}
              onPatchService={onPatchService}
              onReorderServices={(services) => onPatch({ services })}
              onRemove={() =>
                onPatch({
                  modules: catalog.modules.filter((entry) => entry.id !== module.id),
                })
              }
              onRemoveService={(slug) =>
                onPatch({
                  services: catalog.services.filter((entry) => entry.slug !== slug),
                })
              }
              services={services}
              total={catalog.modules.length}
            />
          ))}

          {orphans.length > 0 ? (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20">
              <p className="text-[12px] font-semibold text-amber-800 dark:text-amber-300">
                {orphans.length} service{orphans.length === 1 ? "" : "s"} in a module that
                no longer exists
              </p>
              <p className="mt-0.5 text-[11px] text-amber-700/80 dark:text-amber-300/70">
                Nothing public renders these. Give each one a module that exists, or
                remove it.
              </p>
              <ul className="mt-2 space-y-1.5">
                {orphans.map((service) => (
                  <li
                    className="flex items-center gap-2 text-[12px] text-foreground"
                    key={service.slug}
                  >
                    <span className="font-semibold">{service.name}</span>
                    <ModulePicker
                      catalog={catalog}
                      onChange={(module) => onPatchService(service.slug, { module })}
                      value={service.module}
                    />
                    <button
                      aria-label="Remove"
                      className="rounded border border-rose-200 px-1.5 py-0.5 text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/40"
                      onClick={() =>
                        onPatch({
                          services: catalog.services.filter(
                            (entry) => entry.slug !== service.slug,
                          ),
                        })
                      }
                      type="button"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
            onClick={addModule}
            type="button"
          >
            <Plus className="size-3.5" />
            Add module
          </button>
        </div>
      </ConfigPanel>
    </div>
  );
}

function ModuleRow({
  catalog,
  index,
  module,
  onAddService,
  onMove,
  onPatchModule,
  onPatchService,
  onRemove,
  onRemoveService,
  onReorderServices,
  services,
  total,
}: {
  catalog: PlansConfig;
  index: number;
  module: PlanModule;
  onAddService: () => void;
  onMove: (delta: number) => void;
  onPatchModule: (changes: Partial<PlanModule>) => void;
  onPatchService: (slug: string, changes: Partial<PlanService>) => void;
  onRemove: () => void;
  onReorderServices: (next: PlanService[]) => void;
  onRemoveService: (slug: string) => void;
  services: PlanService[];
  total: number;
}) {

  return (
    <section className="rounded-lg border border-border/70 bg-muted/10 p-3">
      <header className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-role-platform-soft text-role-platform">
          <ContentIcon className="size-4" slug={module.icon} />
        </span>
        <div className="min-w-0 flex-1">
          <InlineText
            className="block font-heading text-[13.5px] font-bold text-foreground"
            onChange={(name) => onPatchModule({ name })}
            placeholder="Module name"
            value={module.name}
          />
          <InlineText
            className="mt-0.5 block text-[11.5px] text-muted-foreground"
            multiline
            onChange={(description) => onPatchModule({ description })}
            placeholder="One line: what this group of services is for"
            value={module.description}
          />
        </div>
        {/* A slug, not a component: the website resolves it to a lucide icon
            and the app to an Ionicon, so the list is the set both clients
            know. Anything else would render as the generic fallback. */}
        <select
          className="h-7 w-32 shrink-0 rounded-md border border-border bg-background px-1.5 text-[11px] outline-none transition focus:border-role-platform"
          onChange={(event) => onPatchModule({ icon: event.target.value })}
          title="Icon"
          value={module.icon}
        >
          {CONTENT_ICON_SLUGS.includes(module.icon) ? null : (
            <option value={module.icon}>{module.icon || "no icon"}</option>
          )}
          {CONTENT_ICON_SLUGS.map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
        <RowControls
          canRemove={services.length === 0}
          index={index}
          onMove={onMove}
          onRemove={onRemove}
          removeTitle={
            services.length > 0
              ? "Move or remove its services first"
              : "Remove this module"
          }
          total={total}
        />
      </header>

      <ul className="mt-2.5 space-y-1.5">
        {services.map((service, serviceIndex) => (
          <li
            className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5"
            key={service.slug}
          >
            <span className="min-w-0 flex-1">
              <InlineText
                className="block text-[12.5px] font-semibold text-foreground"
                onChange={(name) => onPatchService(service.slug, { name })}
                placeholder="Service name"
                value={service.name}
              />
              <InlineText
                className="mt-0.5 block text-[11px] text-muted-foreground"
                multiline
                onChange={(blurb) => onPatchService(service.slug, { blurb })}
                placeholder="One line, sentence case: what it does"
                value={service.blurb}
              />
              <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/70">
                /plans-pricing/{service.slug}
              </span>
            </span>

            <PlanPicker
              catalog={catalog}
              onChange={(plan) => onPatchService(service.slug, { plan })}
              value={service.plan}
            />

            {service.demo.webAssetId || service.demo.mobileAssetId ? (
              <SoftBadge tone="green">Clip</SoftBadge>
            ) : null}

            <Link
              aria-label={`Open ${service.name}`}
              className="rounded-md border border-border p-1 text-muted-foreground transition hover:border-role-platform/50 hover:text-role-platform"
              href={`/platform/config/plans/${service.slug}`}
              title="Walkthrough clips and the what / how / why"
            >
              <ArrowUpRight className="size-3.5" />
            </Link>

            <RowControls
              index={serviceIndex}
              onMove={(delta) => {
                // Services are one flat list, so moving one inside its module
                // means swapping it with the neighbour that shares that module
                // — wherever the two happen to sit in the whole array.
                const neighbour = services[serviceIndex + delta];

                if (!neighbour) {
                  return;
                }

                const all = [...catalog.services];
                const from = all.findIndex((entry) => entry.slug === service.slug);
                const to = all.findIndex((entry) => entry.slug === neighbour.slug);

                if (from < 0 || to < 0) {
                  return;
                }

                [all[from], all[to]] = [all[to], all[from]];
                onReorderServices(all);
              }}
              onRemove={() => onRemoveService(service.slug)}
              total={services.length}
            />
          </li>
        ))}
      </ul>

      <button
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
        onClick={onAddService}
        type="button"
      >
        <Plus className="size-3" />
        Add service
      </button>

    </section>
  );
}

function ModulePicker({
  catalog,
  onChange,
  value,
}: {
  catalog: PlansConfig;
  onChange: (moduleId: string) => void;
  value: string;
}) {
  return (
    <select
      className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] outline-none transition focus:border-role-platform"
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value={value}>{value}</option>
      {catalog.modules.map((module) => (
        <option key={module.id} value={module.id}>
          {module.name}
        </option>
      ))}
    </select>
  );
}

/** Which plan is the first to carry a service. */
function PlanPicker({
  catalog,
  onChange,
  value,
}: {
  catalog: PlansConfig;
  onChange: (planId: string) => void;
  value: string;
}) {
  const known = catalog.plans.some((plan) => plan.id === value);

  return (
    <select
      className={cn(
        "h-7 shrink-0 rounded-md border bg-background px-1.5 text-[11px] font-semibold outline-none transition focus:border-role-platform",
        known ? "border-border text-foreground" : "border-rose-300 text-rose-600",
      )}
      onChange={(event) => onChange(event.target.value)}
      title="The lowest plan that carries it"
      value={value}
    >
      {known ? null : <option value={value}>{value || "No plan"}</option>}
      {catalog.plans.map((plan) => (
        <option key={plan.id} value={plan.id}>
          From {plan.name}
        </option>
      ))}
    </select>
  );
}

function PricingTab({
  catalog,
  onPatch,
  onPatchPlan,
}: {
  catalog: PlansConfig;
  onPatch: (changes: Partial<PlansConfig>) => void;
  onPatchPlan: (planId: string, changes: Partial<PlanTier>) => void;
}) {
  function addPlan() {
    const taken = new Set(catalog.plans.map((plan) => plan.id));
    const id = uniqueSlug("plan", taken);

    onPatch({
      plans: [
        ...catalog.plans,
        {
          annualDiscountPercent: 0,
          ctaHref: "/register-hostel",
          ctaLabel: "Get started",
          description: "",
          eventDiscountPercent: 0,
          featured: false,
          freeMonths: 0,
          halfYearlyDiscountPercent: 0,
          id,
          listingTier: null,
          maxBranches: 0,
          maxResidents: null,
          monthly: 0,
          name: "New plan",
          portalAccess: { cooks: null, wardens: null },
        },
      ],
    });
  }

  return (
    <div className="space-y-3">
      <ConfigPanel
        description="One monthly price per plan, and a percentage off each longer commitment. The six-month and annual totals are worked out from those two numbers rather than typed, so the figure on the card and the saving advertised beside it can never disagree."
        title="Prices & discounts"
      >
        <div className="space-y-3">
          {catalog.plans.map((plan, index) => (
            <PlanPricingRow
              catalog={catalog}
              index={index}
              key={plan.id}
              onMove={(delta) => onPatch({ plans: moved(catalog.plans, index, delta) })}
              onPatch={(changes) => onPatchPlan(plan.id, changes)}
              onPatchAll={onPatch}
              onRemove={() =>
                onPatch({
                  plans: catalog.plans.filter((entry) => entry.id !== plan.id),
                })
              }
              plan={plan}
            />
          ))}

          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
            onClick={addPlan}
            type="button"
          >
            <Plus className="size-3.5" />
            Add plan
          </button>

          <p className="text-[11px] text-muted-foreground">
            Order matters: plans read cheapest first, and a card lists what it adds over
            the one before it.
          </p>
        </div>
      </ConfigPanel>
    </div>
  );
}

function PlanPricingRow({
  catalog,
  index,
  onMove,
  onPatch,
  onPatchAll,
  onRemove,
  plan,
}: {
  catalog: PlansConfig;
  index: number;
  onMove: (delta: number) => void;
  onPatch: (changes: Partial<PlanTier>) => void;
  onPatchAll: (changes: Partial<PlansConfig>) => void;
  onRemove: () => void;
  plan: PlanTier;
}) {
  const carried = catalog.services.filter((service) => service.plan === plan.id).length;

  return (
    <section className="rounded-lg border border-border/70 bg-muted/10 p-3">
      <header className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-heading text-[13.5px] font-bold text-foreground">
            {plan.name}
          </h3>
          <span className="font-mono text-[10.5px] text-muted-foreground/70">
            {plan.id}
          </span>
          {plan.featured ? <SoftBadge tone="green">Highlighted</SoftBadge> : null}
        </div>
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={plan.featured}
            label="Highlighted"
            // Exactly one card can be the answer. Turning one on turns the
            // others off in the same patch, rather than leaving the page with
            // two "Most chosen" badges and no way to tell which is meant.
            onChange={(featured) =>
              onPatchAll({
                plans: catalog.plans.map((entry) => ({
                  ...entry,
                  featured: featured ? entry.id === plan.id : false,
                })),
              })
            }
          />
          <RowControls
            index={index}
            onMove={onMove}
            onRemove={onRemove}
            removeTitle={
              carried > 0
                ? `${carried} service${carried === 1 ? "" : "s"} start at this plan and will be left without one`
                : "Remove this plan"
            }
            total={catalog.plans.length}
          />
        </div>
      </header>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <NumberField
          label="Monthly price"
          onChange={(monthly) => onPatch({ monthly: monthly ?? 0 })}
          prefix="NPR"
          value={plan.monthly}
        />
        <NumberField
          hint="From the day a hostel goes live. Once per building."
          label="Free months"
          max={24}
          onChange={(freeMonths) => onPatch({ freeMonths: freeMonths ?? 0 })}
          value={plan.freeMonths}
        />
        <NumberField
          hint="Extra hostels under this plan, at no charge. 0 for none."
          label="Branches"
          max={100}
          onChange={(maxBranches) => onPatch({ maxBranches: maxBranches ?? 0 })}
          value={plan.maxBranches}
        />
        <NumberField
          hint="Empty means no ceiling."
          label="Residents"
          nullable
          nullLabel="Unlimited"
          onChange={(maxResidents) => onPatch({ maxResidents })}
          value={plan.maxResidents}
        />
        <NumberField
          hint="Empty means no ceiling."
          label="Warden accounts"
          nullable
          nullLabel="Unlimited"
          onChange={(wardens) =>
            onPatch({ portalAccess: { ...plan.portalAccess, wardens } })
          }
          value={plan.portalAccess.wardens}
        />
        <NumberField
          hint="Empty means no ceiling."
          label="Cook accounts"
          nullable
          nullLabel="Unlimited"
          onChange={(cooks) => onPatch({ portalAccess: { ...plan.portalAccess, cooks } })}
          value={plan.portalAccess.cooks}
        />
      </div>

      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
        <CycleDiscount
          cycle="halfYearly"
          label={catalog.cycleLabels.halfYearly}
          onChange={(halfYearlyDiscountPercent) => onPatch({ halfYearlyDiscountPercent })}
          plan={plan}
          value={plan.halfYearlyDiscountPercent}
        />
        <CycleDiscount
          cycle="annual"
          label={catalog.cycleLabels.annual}
          onChange={(annualDiscountPercent) => onPatch({ annualDiscountPercent })}
          plan={plan}
          value={plan.annualDiscountPercent}
        />
      </div>

      <BadgeEditor onPatch={onPatch} plan={plan} />
    </section>
  );
}

/**
 * ## Offer — the mode switch, and nothing else
 *
 * Two modes, one toggle. **Standard** is the catalogue exactly as the Pricing
 * tab leaves it; nothing on this tab is read while it is on. **Event** runs a
 * dated sale *on top of* those prices — it takes a percentage off each plan's
 * monthly figure until the end of the month named here, and the six-month and
 * annual prices follow, because they were already derived from the monthly one.
 *
 * The standard prices are never touched. Switching back to Standard restores
 * them exactly, which is the whole reason the offer is a percentage stored
 * beside the price rather than a second set of prices to keep in step.
 */
function OfferTab({
  catalog,
  onPatch,
  onPatchPlan,
}: {
  catalog: PlansConfig;
  onPatch: (changes: Partial<PlansConfig>) => void;
  onPatchPlan: (planId: string, changes: Partial<PlanTier>) => void;
}) {
  const { event } = catalog;
  const running = eventRuns(catalog, currentBsPeriod());
  const patchEvent = (changes: Partial<PlansConfig["event"]>) =>
    onPatch({ event: { ...event, ...changes } });

  return (
    <div className="space-y-3">
      <ConfigPanel
        description="Standard runs the prices set on the Pricing tab. Event takes a percentage off each of them until the month you name, and the six-month and annual prices follow on their own. Switching back to Standard restores the full prices — an event never edits them."
        title="Plan mode"
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/10 p-3">
            <div>
              <p className="text-[12.5px] font-semibold text-foreground">
                {event.mode === "event" ? "Event plan" : "Standard plan"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {event.mode === "standard"
                  ? "Full prices. The fields below are ignored."
                  : running
                    ? `Running now — offer prices are live on the page, through ${formatBsPeriod(event.endsOn)}.`
                    : event.endsOn === ""
                      ? "Not running: no month is set, so the offer has no end and is not applied."
                      : `Not running: ${formatBsPeriod(event.endsOn)} has passed. Full prices are live.`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {running ? <SoftBadge tone="green">Live</SoftBadge> : null}
              <ToggleSwitch
                checked={event.mode === "event"}
                label="Event plan"
                onChange={(on) => patchEvent({ mode: on ? "event" : "standard" })}
              />
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-3">
            <TextField
              hint="Bikram Sambat month, like 2083-06. The offer stops at the end of it."
              label="Runs until"
              onChange={(endsOn) => patchEvent({ endsOn: endsOn.trim() })}
              placeholder="2083-06"
              value={event.endsOn}
            />
            <TextField
              hint="The words on the badge above the cards."
              label="Badge"
              onChange={(label) => patchEvent({ label })}
              placeholder="Festival offer"
              value={event.label}
            />
            <TextField
              hint="One line under it. Blank shows nothing."
              label="Note"
              onChange={(note) => patchEvent({ note })}
              placeholder="Dashain and Tihar, on us."
              value={event.note}
            />
          </div>
        </div>
      </ConfigPanel>

      <ConfigPanel
        description="A percentage off each plan's monthly price, and the only discount that applies while the event runs — the six-month and annual discounts are set aside, so a hostel is given one offer rather than two stacked on each other. Six months and a year are simply the offer price times six and twelve."
        title="Discount per plan"
      >
        <div className="space-y-2.5">
          {catalog.plans.map((plan) => (
            <EventDiscount
              catalog={catalog}
              key={plan.id}
              onChange={(eventDiscountPercent) =>
                onPatchPlan(plan.id, { eventDiscountPercent })
              }
              plan={plan}
            />
          ))}

          {catalog.plans.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Add a plan on the Pricing tab first.
            </p>
          ) : null}
        </div>
      </ConfigPanel>
    </div>
  );
}

/** One plan's event discount, with the three prices it produces printed under it. */
function EventDiscount({
  catalog,
  onChange,
  plan,
}: {
  catalog: PlansConfig;
  onChange: (percent: number) => void;
  plan: PlanTier;
}) {
  const money = (rupees: number) => `NPR ${rupees.toLocaleString("en-IN")}`;
  const percent = plan.eventDiscountPercent;
  // Priced through the very function the projection prices with, so the
  // sentence under this field and the card in the preview above cannot quote
  // different numbers — including the part where the cycle discounts drop away.
  const offer = sellingPlan(plan);

  return (
    <section className="rounded-lg border border-border/70 bg-muted/10 p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-[13.5px] font-bold text-foreground">
          {plan.name}
        </h3>
        <span className="font-mono text-[10.5px] text-muted-foreground/70">
          {money(plan.monthly)} a month
        </span>
      </header>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <NumberField
          label="Event discount"
          max={90}
          onChange={(next) => onChange(next ?? 0)}
          suffix="%"
          value={percent}
        />
        <p className="self-center text-[11px] text-muted-foreground">
          {percent > 0 ? (
            <>
              <span className="font-semibold text-foreground">
                {money(offer.monthly)}
              </span>{" "}
              a month during the event — six months{" "}
              {money(cycleTotal(offer, "halfYearly"))}, one year{" "}
              {money(cycleTotal(offer, "annual"))}. The {catalog.cycleLabels.halfYearly}{" "}
              and {catalog.cycleLabels.annual} discounts do not apply on top.
            </>
          ) : (
            "No discount, so this plan stays at its full price during the event."
          )}
        </p>
      </div>
    </section>
  );
}

/** A discount, with the three numbers it produces printed under it. */
function CycleDiscount({
  cycle,
  label,
  onChange,
  plan,
  value,
}: {
  cycle: BillingCycle;
  label: string;
  onChange: (percent: number) => void;
  plan: PlanTier;
  value: number;
}) {
  const money = (rupees: number) => `NPR ${rupees.toLocaleString("en-IN")}`;

  return (
    <div className="rounded-lg border border-border/70 bg-card p-2.5">
      <NumberField
        label={`${label} discount`}
        max={90}
        onChange={(percent) => onChange(percent ?? 0)}
        suffix="%"
        value={value}
      />
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {money(cycleTotal(plan, cycle))} paid once —{" "}
        <span className="font-semibold text-foreground">
          {money(monthlyRateFor(plan, cycle))}
        </span>{" "}
        a month, saving {money(savingFor(plan, cycle))}.
      </p>
    </div>
  );
}

const BADGE_TONES = [
  { label: "No badge", value: "" },
  { label: "Platinum", value: "platinum" },
  { label: "Gold", value: "gold" },
] as const;

/**
 * The directory badge a plan buys. The label and the sentence beside it are
 * typed onto the card above; what lives here is whether there is a badge at
 * all, which metal it is struck in, and the address of its own page.
 */
function BadgeEditor({
  onPatch,
  plan,
}: {
  onPatch: (changes: Partial<PlanTier>) => void;
  plan: PlanTier;
}) {
  return (
    <div className="mt-2.5 rounded-lg border border-border/70 bg-card p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] font-semibold text-foreground">
          Directory badge
        </span>
        <span className="inline-flex overflow-hidden rounded-md border border-border">
          {BADGE_TONES.map((tone) => {
            const active = (plan.listingTier?.tone ?? "") === tone.value;

            return (
              <button
                className={cn(
                  "px-2 py-1 text-[11px] font-semibold transition",
                  active
                    ? "bg-role-platform text-white"
                    : "text-muted-foreground hover:bg-muted",
                )}
                key={tone.value}
                onClick={() =>
                  onPatch({
                    listingTier: tone.value
                      ? {
                          label:
                            plan.listingTier?.label ??
                            `${tone.label} hostel`,
                          note:
                            plan.listingTier?.note ??
                            "Ranked above unbadged listings across search, the map and Compare.",
                          slug:
                            plan.listingTier?.slug ??
                            slugify(`${tone.label} hostel`, "badge"),
                          tone: tone.value,
                        }
                      : null,
                  })
                }
                type="button"
              >
                {tone.label}
              </button>
            );
          })}
        </span>
      </div>

      {plan.listingTier ? (
        <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
          <TextField
            hint="Its own page lives at /plans-pricing/badge/<slug>. Changing it changes that address."
            label="Badge page slug"
            onChange={(slug) =>
              plan.listingTier &&
              onPatch({
                listingTier: {
                  ...plan.listingTier,
                  slug: slugify(slug, plan.listingTier.slug),
                },
              })
            }
            value={plan.listingTier.slug}
          />
          <p className="self-end text-[11px] text-muted-foreground">
            The badge&apos;s name and the line explaining it are edited on the card
            above.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function LinksTab({
  catalog,
  onPatch,
  onPatchPlan,
}: {
  catalog: PlansConfig;
  onPatch: (changes: Partial<PlansConfig>) => void;
  onPatchPlan: (planId: string, changes: Partial<PlanTier>) => void;
}) {
  return (
    <ConfigPanel
      description="Where the buttons go. The words on them are edited on the page above."
      title="Links"
    >
      <div className="grid gap-2.5 sm:grid-cols-2">
        {catalog.plans.map((plan) => (
          <TextField
            key={plan.id}
            label={`${plan.name} button`}
            onChange={(ctaHref) => onPatchPlan(plan.id, { ctaHref })}
            placeholder="/register-hostel"
            value={plan.ctaHref}
          />
        ))}
        <TextField
          hint="The closing call to action under the questions."
          label="Closing button"
          onChange={(ctaHref) => onPatch({ page: { ...catalog.page, ctaHref } })}
          placeholder="/contact"
          value={catalog.page.ctaHref}
        />
      </div>
    </ConfigPanel>
  );
}
