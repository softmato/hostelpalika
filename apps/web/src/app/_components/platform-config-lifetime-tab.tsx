"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { SoftBadge, ToggleSwitch } from "@/app/_components/portal-dashboard-ui";
import { useSiteConfig } from "@/components/site-config-provider";
import type { LifetimeConfig } from "@/modules/platform-config/site-config.validation";
import {
  formatLifetimeDay,
  lifetimeMonthsEquivalent,
  lifetimeSeatsLeft,
  lifetimeTotalSeats,
  lifetimeWindow,
  nepalDay,
} from "@hostel/shared/plans/lifetime";

import { LifetimeDeal, useLifetimeAvailability } from "./lifetime-deal";
import type { PlansConfig } from "./plans-catalog";
import {
  ConfigPanel,
  ConfigSaveBar,
  NumberField,
  TextAreaField,
  TextField,
} from "./platform-config-shared";

/**
 * Platform → Website Config → Plans & Pricing → **Lifetime**.
 *
 * The lifetime deal's own tab, writing its own `lifetime` section with its own
 * Save — it never touches the `plans` section the other tabs edit, so a deal
 * switched on, repriced or deleted here cannot move a tier, a cycle discount or
 * an event offer.
 *
 * Seats sold are read live (the same endpoint the public page reads), so the
 * owner sees how many of each tier are gone before changing how many there are.
 */
export function LifetimeTab({
  catalog,
  deal,
  dirty,
  onChange,
  onReset,
  onSave,
  saving,
}: {
  catalog: PlansConfig;
  deal: LifetimeConfig;
  dirty: boolean;
  onChange: (next: LifetimeConfig) => void;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { identity } = useSiteConfig();
  const [refresh, setRefresh] = useState(0);
  const { availability, failed } = useLifetimeAvailability(refresh);
  const saleWindow = lifetimeWindow(deal);
  const patch = (changes: Partial<LifetimeConfig>) => onChange({ ...deal, ...changes });
  const patchOffer = (planId: string, changes: Partial<LifetimeConfig["offers"][number]>) =>
    patch({
      offers: deal.offers.map((offer) => (offer.planId === planId ? { ...offer, ...changes } : offer)),
    });
  const soldOf = (planId: string) =>
    availability?.offers.find((entry) => entry.planId === planId)?.sold ?? 0;
  const totalSold = deal.offers.reduce((sum, offer) => sum + soldOf(offer.planId), 0);
  const offered = new Set(deal.offers.map((offer) => offer.planId));
  const missing = catalog.plans.filter((plan) => !offered.has(plan.id));

  return (
    <div className="space-y-3">
      <ConfigSaveBar
        dirty={dirty}
        onReset={onReset}
        onSave={() => {
          onSave();
          // Seat counts don't change on save, but the window and offers might.
          setRefresh((count) => count + 1);
        }}
        saving={saving}
      />

      <ConfigPanel
        description="One payment buys a plan for life — every feature of that plan, no renewals, no free months. Kept apart from the regular plans: nothing on this tab changes a tier, a cycle discount or an event offer. Seats are taken when a hostel's payment settles."
        title="Lifetime deal"
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/10 p-3">
            <div>
              <p className="text-[12.5px] font-semibold text-foreground">
                {saleWindow === "open"
                  ? "On sale now"
                  : saleWindow === "upcoming"
                    ? "Scheduled"
                    : saleWindow === "ended"
                      ? "Ended"
                      : "Switched off"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {saleWindow === "off"
                  ? "Hidden from the pricing page and the team form."
                  : saleWindow === "upcoming"
                    ? `Opens on ${formatLifetimeDay(deal.startsOn)} (Nepal time).`
                    : saleWindow === "ended"
                      ? `Closed after ${formatLifetimeDay(deal.endsOn)}. Hostels that bought it keep it.`
                      : deal.endsOn
                        ? `Shown on the pricing page and the team form through ${formatLifetimeDay(deal.endsOn)}.`
                        : "Shown on the pricing page and the team form, with no end date."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {saleWindow === "open" ? <SoftBadge tone="green">Live</SoftBadge> : null}
              <ToggleSwitch
                checked={deal.enabled}
                label="On sale"
                onChange={(enabled) => patch({ enabled })}
              />
            </div>
          </div>

          <div className="grid gap-2.5 sm:grid-cols-3">
            <DayField
              hint="First day it can be bought, Nepal time."
              label="Starts on"
              onChange={(startsOn) => patch({ startsOn })}
              value={deal.startsOn}
            />
            <DayField
              hint="Last day it can be bought. Blank means no end."
              label="Ends on"
              onChange={(endsOn) => patch({ endsOn })}
              value={deal.endsOn}
            />
            <div className="flex flex-col justify-end gap-1.5">
              <button
                className="h-9 rounded-lg border border-border px-2.5 text-[11.5px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
                onClick={() => patch({ endsOn: oneMonthFrom(deal.startsOn || nepalDay()) })}
                type="button"
              >
                Run for one month from the start
              </button>
              <span className="text-[10.5px] text-muted-foreground">
                Today is {formatLifetimeDay(nepalDay())} in Nepal.
              </span>
            </div>
          </div>
        </div>
      </ConfigPanel>

      <ConfigPanel
        description="A price and a number of seats for each plan. A seat is taken when a hostel's lifetime payment settles; the seats left is what the pricing page and the team form show."
        title="Price & seats per plan"
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">
                {lifetimeTotalSeats(deal)} seats
              </span>{" "}
              across {deal.offers.filter((offer) => offer.price > 0).length} plans
              {availability ? ` · ${totalSold} sold` : ""}
            </span>
            {failed ? <span className="text-warning">Could not count seats sold.</span> : null}
          </div>

          {deal.offers.map((offer) => {
            const plan = catalog.plans.find((entry) => entry.id === offer.planId);
            const sold = soldOf(offer.planId);
            const months = plan ? lifetimeMonthsEquivalent(offer.price, plan.monthly) : null;

            return (
              <section
                className="rounded-lg border border-border/70 bg-muted/10 p-3"
                key={offer.planId}
              >
                <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-heading text-[13.5px] font-bold text-foreground">
                      {plan?.name ?? offer.planId}
                    </h3>
                    <span className="font-mono text-[10.5px] text-muted-foreground/70">
                      {offer.planId}
                    </span>
                    {!plan ? <SoftBadge tone="amber">Plan removed — not sold</SoftBadge> : null}
                  </div>
                  <button
                    aria-label={`Remove the lifetime offer on ${plan?.name ?? offer.planId}`}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                    onClick={() =>
                      patch({ offers: deal.offers.filter((entry) => entry.planId !== offer.planId) })
                    }
                    title="Remove this offer"
                    type="button"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </header>

                <div className="grid gap-2.5 sm:grid-cols-3">
                  <NumberField
                    hint="Paid once."
                    label="Lifetime price"
                    onChange={(price) => patchOffer(offer.planId, { price: price ?? 0 })}
                    prefix="NPR"
                    value={offer.price}
                  />
                  <NumberField
                    hint="How many hostels may buy it."
                    label="Seats"
                    onChange={(seats) => patchOffer(offer.planId, { seats: seats ?? 0 })}
                    value={offer.seats}
                  />
                  <div className="self-center text-[11px] text-muted-foreground">
                    {availability ? (
                      <p>
                        <span className="font-semibold text-foreground">
                          {sold} sold · {lifetimeSeatsLeft(offer, sold)} left
                        </span>
                        {sold > offer.seats ? " — more sold than seats now set." : ""}
                      </p>
                    ) : (
                      <p>Counting seats…</p>
                    )}
                    {months && plan ? (
                      <p className="mt-0.5">
                        The price of about {months} months of {plan.name} at NPR{" "}
                        {plan.monthly.toLocaleString("en-IN")}/month.
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>
            );
          })}

          {missing.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {missing.map((plan) => (
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
                  key={plan.id}
                  onClick={() =>
                    patch({ offers: [...deal.offers, { planId: plan.id, price: 0, seats: 0 }] })
                  }
                  type="button"
                >
                  <Plus className="size-3.5" />
                  Lifetime offer on {plan.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </ConfigPanel>

      <ConfigPanel
        description="The words on the lifetime block of the pricing page. {siteName} is replaced with the platform's name on the live page."
        title="Wording"
      >
        <div className="grid gap-2.5 sm:grid-cols-2">
          <TextField
            label="Badge"
            onChange={(badge) => patch({ badge })}
            placeholder="Founding 50 · Lifetime"
            value={deal.badge}
          />
          <TextField
            label="Button"
            onChange={(ctaLabel) => patch({ ctaLabel })}
            placeholder="Claim lifetime"
            value={deal.ctaLabel}
          />
          <TextField
            label="Heading"
            onChange={(title) => patch({ title })}
            placeholder="Pay once. Use it for life."
            value={deal.title}
          />
          <TextAreaField
            label="Under the heading"
            onChange={(subtitle) => patch({ subtitle })}
            rows={2}
            value={deal.subtitle}
          />
          <div className="sm:col-span-2">
            <TextAreaField
              label="Small print"
              onChange={(note) => patch({ note })}
              rows={2}
              value={deal.note}
            />
          </div>
        </div>
      </ConfigPanel>

      <section className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <header className="border-b border-border/60 bg-card px-3.5 py-2.5">
          <h2 className="font-heading text-[13.5px] font-bold text-foreground">Preview</h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">
            The block as it sits under the plan cards on the pricing page, from this unsaved draft.
          </p>
        </header>
        <div className="px-4 pb-6 md:px-6">
          <LifetimeDeal
            availability={availability}
            catalog={catalog}
            deal={deal}
            identity={identity}
            preview
          />
        </div>
      </section>
    </div>
  );
}

/** One calendar month on from a `YYYY-MM-DD` day, as the same kind of day. */
function oneMonthFrom(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, date));

  // 31 Jan + 1 month overflows into March; pull it back to the month's last day.
  if (next.getUTCMonth() !== (month % 12)) {
    next.setUTCDate(0);
  }

  return next.toISOString().slice(0, 10);
}

function DayField({
  hint,
  label,
  onChange,
  value,
}: {
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-semibold text-foreground">{label}</span>
      <input
        className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] outline-none transition focus:border-role-platform focus:ring-2 focus:ring-role-platform/15"
        onChange={(event) => onChange(event.target.value)}
        type="date"
        value={value}
      />
      {hint ? <span className="mt-1 block text-[10.5px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
