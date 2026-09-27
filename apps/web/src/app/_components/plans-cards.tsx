"use client";

import { motion, useReducedMotion, type Variants } from "framer-motion";
import { ArrowUpRight, Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { PublicSiteConfig } from "@/components/site-config-provider";
import { fillPlaceholders } from "@/lib/site-content";
import { cn } from "@/lib/utils";

import { GetPlanButton } from "./get-plan-button";
import { InlineText } from "./inline-text";
import { TIER_TONE } from "./listing-tier-tone";
import { PlanMark } from "./plan-mark";
import { StarsCtaCard } from "./stars-cta-card";
import {
  bestDiscountPercent,
  bestEventPercent,
  bestSaving,
  billingCycles,
  cardServicesForPlan,
  cycleTotal,
  listingTierHref,
  monthlyRateFor,
  planBelow,
  planRank,
  portalAccessLines,
  residentRangeLabel,
  savingFor,
  serviceHref,
  type BillingCycle,
  type Plan,
  type PlanService,
  type PlanTier,
  type PlansConfig,
} from "./plans-catalog";

/**
 * The plan cards, and the billing toggle above them.
 *
 * Lifted out of the public page because two screens now draw them: the visitor's
 * `/plans-pricing`, and Platform → Website Config → Plans & Pricing, where the
 * owner edits the catalogue by typing into the cards themselves. One component
 * is the only way that second screen can honestly claim to be a preview — a
 * second copy styled to match would start matching and stop.
 *
 * The `editor` prop is the whole difference between the two. Absent, every label
 * is text and every service is a link to its public page, exactly as before.
 * Present, each label becomes an {@link InlineText} writing back into the admin's
 * draft, and each service line grows a button that opens its own admin page.
 */

/**
 * The one easing and the one distance every entrance on this page uses, so the
 * header, the cards and the catalogue read as a single movement rather than
 * three components each animating to their own taste.
 */
export const EASE = [0.22, 1, 0.36, 1] as const;
const RISE = 18;

/*
 * The saving pill's open/close lives in CSS, not here.
 *
 * Annual carries a pill that monthly does not, so the block under the price is
 * genuinely two heights. Reserving the taller one leaves a hole under the price
 * for as long as monthly is selected, and dropping it with no tween makes the
 * button below it jump.
 *
 * Framer was the obvious reach for this and is the wrong tool three times over.
 * `layout` on the card: the grid stretches all three cards to the tallest, so
 * the card's own box never changes, and framer held a vertical `scale()` on it
 * that stretched the border radius and every glyph inside. `layout="position"`
 * on the blocks: it moves elements with transforms instead of reflowing them,
 * and left the button and the feature list holding a permanent
 * `translateY(37px)` — exactly cancelling the collapse, so the dead space came
 * back as a transform. An animated `height: auto`: the element never left its
 * server-rendered inline style at all.
 *
 * `grid-template-rows: 0fr -> 1fr` over an `overflow-hidden` child is the plain
 * CSS answer, needs no measurement, and reflows everything below it properly.
 */

/**
 * What an editing surface has to supply. Every callback patches one record in
 * the caller's draft; nothing here knows how that draft is stored or saved.
 */
export type PlansEditor = {
  onPatchCycleLabels: (patch: Partial<PlansConfig["cycleLabels"]>) => void;
  onPatchPage: (patch: Partial<PlansConfig["page"]>) => void;
  onPatchPlan: (planId: string, patch: Partial<PlanTier>) => void;
  onPatchService: (slug: string, patch: Partial<PlanService>) => void;
  /** Where a service line goes when opened — its admin page, not its public one. */
  serviceHrefFor: (slug: string) => string;
};

/**
 * Entrance variants, built once per render against the visitor's motion
 * setting. Under `prefers-reduced-motion` the content still fades — what goes
 * is the travel and the stagger, which is the part that causes trouble.
 */
export function useEntranceVariants() {
  const reduced = useReducedMotion();

  const container: Variants = {
    hidden: {},
    show: {
      transition: {
        delayChildren: reduced ? 0 : 0.08,
        staggerChildren: reduced ? 0 : 0.09,
      },
    },
  };

  const item: Variants = {
    hidden: { opacity: 0, y: reduced ? 0 : RISE },
    show: {
      opacity: 1,
      transition: { duration: reduced ? 0.2 : 0.55, ease: EASE },
      y: 0,
    },
  };

  return { container, item, reduced };
}

/**
 * A price. The currency is set smaller than the figure and slightly muted, so
 * the eye lands on the number it is here to compare rather than on three
 * identical "NPR"s. Sized in `em` rather than a fixed pixel value, so the same
 * relationship holds whether this sits in the headline price or mid-sentence
 * in the caption underneath it.
 */
export function Money({ rupees }: { rupees: number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-[0.72em] font-semibold text-muted-foreground">NPR</span>{" "}
      {rupees.toLocaleString("en-IN")}
    </span>
  );
}

/** Editable when an editor is supplied, plain text when it is not. */
function Label({
  as,
  className,
  editor,
  multiline,
  onChange,
  placeholder,
  value,
}: {
  as?: Parameters<typeof InlineText>[0]["as"];
  className?: string;
  editor?: PlansEditor;
  multiline?: boolean;
  onChange: (next: string) => void;
  placeholder?: string;
  value: string;
}) {
  if (!editor) {
    return <>{value}</>;
  }

  return (
    <InlineText
      as={as}
      className={className}
      multiline={multiline}
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  );
}

/**
 * Segmented, not a switch: three labelled thirds say what each one means, where
 * a bare toggle makes the reader work out which state they are looking at.
 */
export function BillingToggle({
  catalog,
  cycle,
  editor,
  onCycleChange,
}: {
  catalog: PlansConfig;
  cycle: BillingCycle;
  editor?: PlansEditor;
  onCycleChange: (next: BillingCycle) => void;
}) {
  const eventPercent = bestEventPercent(catalog);

  return (
    <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
      <div
        aria-label="Billing period"
        className="inline-flex rounded-full border border-border bg-surface p-1 shadow-sm"
        role="tablist"
      >
        {billingCycles(catalog).map((option) => {
          const selected = cycle === option.id;

          return (
            <button
              aria-selected={selected}
              className={cn(
                "relative rounded-full px-5 py-2 text-sm font-semibold transition-colors",
                selected ? "text-white" : "text-muted-foreground hover:text-foreground",
              )}
              key={option.id}
              onClick={() => onCycleChange(option.id)}
              role="tab"
              type="button"
            >
              {/* The fill is one shared element that slides between the thirds,
                  so the toggle reads as a thing being moved rather than three
                  backgrounds swapping. */}
              {selected ? (
                <motion.span
                  className="absolute inset-0 rounded-full bg-brand-teal shadow-sm"
                  layoutId="billing-cycle-pill"
                  transition={{ damping: 30, stiffness: 380, type: "spring" }}
                />
              ) : null}
              <span className="relative">
                <Label
                  editor={editor}
                  onChange={(label) => editor?.onPatchCycleLabels({ [option.id]: label })}
                  placeholder="Cycle"
                  value={option.label}
                />
              </span>
            </button>
          );
        })}
      </div>
      {/* The event badge sits on every cycle, because the offer is on every
          cycle — unlike the cycle saving beside it, which is only true off
          monthly. It shows at all only while an event is actually running: the
          projection stamps `listMonthly` when it is, and nothing else does. */}
      {eventPercent > 0 ? (
        <span className="rounded-full bg-brand-teal px-3 py-1 text-xs font-bold text-white">
          {catalog.event.label} — {eventPercent}% off
        </span>
      ) : null}
      {/* Never on monthly outside an event: a saving on screen while monthly is
          selected is advertising a discount the reader is not currently
          getting. Keyed on the cycle so the figure re-enters when it changes,
          rather than silently becoming a different number.

          In rupees during an event, because the event zeroes the cycle
          discounts — the offer is the discount — and a percentage badge would
          have nothing left to quote but "0%". */}
      {eventPercent > 0 || cycle !== "monthly" ? (
        <motion.span
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-full bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-teal"
          initial={{ opacity: 0, scale: 0.9 }}
          key={cycle}
          transition={{ duration: 0.22, ease: EASE }}
        >
          {eventPercent > 0 ? (
            <>
              Save up to <Money rupees={bestSaving(catalog, cycle)} />
            </>
          ) : (
            `Save up to ${bestDiscountPercent(catalog, cycle)}%`
          )}
        </motion.span>
      ) : null}
    </div>
  );
}

/** "Everything in Go, plus:" for every plan but the first, which has none below. */
function listHeadingFor(catalog: PlansConfig, plan: Plan) {
  const below = planBelow(catalog, plan.id);

  return below ? `Everything in ${below.name}, plus:` : "Included:";
}

/**
 * One ticked line in a plan card, and the only one there is.
 *
 * Every line in the list goes somewhere — the caps and the badge as much as the
 * services — because a reader who wants "3 cook portal accounts" explained has
 * the same question as one who wants "Cook portal" explained, and a line that
 * looks like a fact but behaves like a link (or the reverse) is worse than
 * either. The two weights are the only difference between them: the caps and
 * the badge carry the plan's own terms and lead in `foreground`, the services
 * under them read one step back.
 *
 * A line with no `href` is a line whose target no longer exists — an owner has
 * removed the service that explained it — and it renders as plain text rather
 * than as a link into a 404.
 */
function PlanLine({
  action,
  after,
  checkClassName,
  children,
  href,
  muted = false,
}: {
  /** Trailing control, outside the label. The editor's "open" button. */
  action?: ReactNode;
  /**
   * Trailing text that explains the line without being part of its name — the
   * badge's "ranked above unbadged listings", say. Outside the underline on
   * purpose: dotted-underlining a whole sentence turns the cue that says "this
   * opens" into decoration on the sentence next to it.
   */
  after?: ReactNode;
  /** Tier badges tint their own tick; everything else takes the brand's. */
  checkClassName?: string;
  children: ReactNode;
  href: string | null;
  muted?: boolean;
}) {
  const tone = muted ? "font-medium text-foreground/80" : "font-semibold text-foreground";
  const body = (
    <>
      <Check
        className={cn("mt-0.5 size-4 shrink-0", checkClassName ?? "text-brand-teal")}
      />
      <span>
        <span
          className={cn(
            href &&
              "underline decoration-border decoration-dotted underline-offset-4 transition group-hover:decoration-brand-teal",
          )}
        >
          {children}
        </span>
        {after}
      </span>
    </>
  );

  if (action) {
    return (
      <span className={cn("flex items-start gap-2.5 text-sm", tone)}>
        {body}
        {action}
      </span>
    );
  }

  if (!href) {
    return <span className={cn("flex items-start gap-2.5 text-sm", tone)}>{body}</span>;
  }

  return (
    <Link
      className={cn(
        "group flex items-start gap-2.5 text-sm transition hover:text-brand-teal",
        tone,
      )}
      href={href}
    >
      {body}
    </Link>
  );
}

/** The editor's "open this service's own page" affordance. */
function OpenServiceButton({ href, name }: { href: string; name: string }) {
  return (
    <Link
      aria-label={`Open ${name}`}
      className="ml-auto shrink-0 rounded-md border border-border p-1 text-muted-foreground transition hover:border-role-platform/50 hover:text-role-platform"
      href={href}
      title={`Open ${name} — walkthrough clips and the what/how/why`}
    >
      <ArrowUpRight className="size-3.5" />
    </Link>
  );
}

export function PlanCard({
  catalog,
  cycle,
  editor,
  plan,
  reduced,
}: {
  catalog: PlansConfig;
  cycle: BillingCycle;
  editor?: PlansEditor;
  plan: Plan;
  reduced: boolean | null;
}) {
  const rate = monthlyRateFor(plan, cycle);
  const ctaClass = cn(
    "inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold transition",
    plan.featured
      ? "bg-brand-teal text-white shadow-sm hover:brightness-110"
      : "border border-brand-teal/40 text-brand-teal hover:bg-brand-teal/10",
  );
  const services = cardServicesForPlan(catalog, plan.id);
  /*
   * One "was" figure, never two. An event and a cycle discount both come off
   * the same list price, so the struck number is that list price whenever
   * either is in play — printing the event price struck as well would put two
   * crossed-out numbers on a card and leave the reader deciding which counts.
   */
  const struck = plan.listMonthly ?? (cycle === "monthly" ? null : plan.monthly);
  const saving = savingFor(plan, cycle);
  const patch = (changes: Partial<PlanTier>) => editor?.onPatchPlan(plan.id, changes);

  return (
    // Only the blocks inside move; the card itself is deliberately NOT a
    // `layout` element. The grid stretches all three cards to the tallest, so
    // the card's own box never changes size between cycles — asking framer to
    // animate it anyway makes it measure a change that is not there and hold a
    // vertical `scale()` on the card, which stretches the border radius and
    // every glyph inside it.
    <article
      className={cn(
        "relative flex w-full flex-col rounded-2xl border bg-surface p-6 shadow-sm transition-colors",
        plan.featured
          ? "border-brand-teal/60 ring-1 ring-brand-teal/30"
          : "border-border hover:border-brand-teal/40",
      )}
    >
      {plan.featured ? (
        <span className="absolute -top-3 left-6 rounded-full bg-brand-teal px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white">
          <Label
            editor={editor}
            onChange={(featuredBadge) => editor?.onPatchPage({ featuredBadge })}
            placeholder="Badge"
            value={catalog.page.featuredBadge}
          />
        </span>
      ) : null}

      {/* Mark, name and badge on one baseline. Floating the mark above the
          name left a gap that read as a missing element and made the roof look
          detached from the card's top corner. */}
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal">
          <PlanMark rank={planRank(catalog, plan.id)} />
        </span>
        <div className="min-w-0">
          <h2 className="font-heading text-2xl font-bold leading-none text-foreground">
            <Label
              editor={editor}
              onChange={(name) => patch({ name })}
              placeholder="Plan"
              value={plan.name}
            />
          </h2>
          {plan.listingTier ? (
            <span
              className={cn(
                "mt-1.5 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold",
                TIER_TONE[plan.listingTier.tone].badge,
              )}
            >
              <Label
                editor={editor}
                onChange={(label) =>
                  plan.listingTier &&
                  patch({ listingTier: { ...plan.listingTier, label } })
                }
                placeholder="Badge"
                value={plan.listingTier.label}
              />
            </span>
          ) : null}
        </div>
      </div>

      <p className="mt-3 min-h-[40px] text-sm text-muted-foreground">
        <Label
          editor={editor}
          multiline
          onChange={(description) => patch({ description })}
          placeholder="Who this plan is for"
          value={plan.description}
        />
      </p>

      {/*
       * Annual keeps the monthly price on screen beside it, struck through and
       * faded, rather than replacing it. Swapping the figure outright leaves
       * the reader nothing to compare the discount against — they see a smaller
       * number and have to remember the bigger one. Small and low-contrast so
       * it never competes with the price actually being charged.
       *
       * The figure is keyed on the cycle so React remounts it and the enter
       * animation replays. Deliberately no AnimatePresence: `mode="wait"` holds
       * the *old* number on screen until its exit finishes, and when that exit
       * does not land the card shows last cycle's price under this cycle's
       * caption.
       */}
      {plan.freeMonths ? (
        <p className="mt-4 text-sm font-semibold text-brand-teal">
          First {plan.freeMonths} {plan.freeMonths === 1 ? "month" : "months"} free, then
        </p>
      ) : null}
      <div className={cn("flex items-baseline gap-2.5", plan.freeMonths ? "mt-1" : "mt-4")}>
        <motion.span
          animate={{ opacity: 1, y: 0 }}
          className="font-heading text-3xl font-bold tracking-tight text-foreground"
          initial={{ opacity: 0, y: reduced ? 0 : -8 }}
          key={cycle}
          transition={{ duration: reduced ? 0.12 : 0.28, ease: EASE }}
        >
          <Money rupees={rate} />
        </motion.span>

        {struck !== null ? (
          <motion.span
            animate={{ opacity: 1 }}
            className="text-base font-semibold text-muted-foreground/50 line-through"
            initial={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            <Money rupees={struck} />
          </motion.span>
        ) : null}
      </div>

      {/* Plain words on purpose: most people reading this are pricing a hostel,
          not parsing billing terms. One sentence, one number. */}
      <p className="mt-2 text-sm text-muted-foreground">
        {cycle === "monthly" ? (
          "Paid every month."
        ) : (
          <>
            {cycle === "annual" ? "One year costs " : "Six months cost "}
            <Money rupees={cycleTotal(plan, cycle)} />, paid once.
          </>
        )}
      </p>

      {/* The saving pill opens and closes on `grid-template-rows: 0fr -> 1fr`,
          which is the one way to transition to a content-sized height in plain
          CSS. It reflows the button and the list below it rather than moving
          them, so nothing is left holding a transform. */}
      <div
        aria-hidden={saving <= 0}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none",
          saving <= 0 ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className="overflow-hidden">
          <p className="pt-3">
            {/* inline-block, never inline-flex: a flex container drops the
                whitespace text nodes between its children, so the amount welds
                onto the word before it and the pill reads as one long token. */}
            <span className="inline-block rounded-full bg-brand-teal/10 px-2.5 py-1 text-xs font-semibold text-brand-teal">
              Save <Money rupees={saving} />
            </span>
          </p>
        </div>
      </div>

      <div className="mt-6">
        {editor ? (
          <span
            className={cn(
              "inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold",
              plan.featured
                ? "bg-brand-teal text-white shadow-sm"
                : "border border-brand-teal/40 text-brand-teal",
            )}
          >
            <Label
              editor={editor}
              onChange={(ctaLabel) => patch({ ctaLabel })}
              placeholder="Button"
              value={plan.ctaLabel}
            />
          </span>
        ) : plan.ctaHref.startsWith("/register-hostel") ? (
          <GetPlanButton
            className={ctaClass}
            cycle={cycle}
            label={plan.ctaLabel}
            planId={plan.id}
            registerHref={plan.ctaHref}
          />
        ) : (
          <Link className={ctaClass} href={{ pathname: plan.ctaHref, query: { plan: plan.id } }}>
            {plan.ctaLabel}
          </Link>
        )}
      </div>

      <div className="mt-7 flex-1 border-t border-border/60 pt-6">
        <p className="text-sm font-bold text-foreground">
          {listHeadingFor(catalog, plan)}
        </p>

        <ul className="mt-3 space-y-2">
          {/* Capacity first, on its own line: it is what the price is set by,
              and it is the number a hostel owner checks before reading another
              word of the card. */}
          <li>
            <PlanLine href={editor ? null : serviceHref("resident-directory")}>
              {residentRangeLabel(catalog, plan)}
            </PlanLine>
          </li>

          {/* Then who gets an account, per role. "How many of my people can log
              in" is a different question from "how many beds does it cover",
              and a hostel with two wardens and a kitchen team needs it answered
              before it needs a feature list. */}
          {portalAccessLines(catalog, plan).map((line) => (
            <li key={line.id}>
              <PlanLine href={editor ? null : line.href}>{line.label}</PlanLine>
            </li>
          ))}

          {/* The badge is a plan benefit, not a service, so it sits with the
              cap above the catalogue lines rather than inside them. */}
          {plan.listingTier ? (
            <li>
              <PlanLine
                after={
                  <span className="font-normal text-muted-foreground">
                    {" — "}
                    <Label
                      editor={editor}
                      multiline
                      onChange={(note) =>
                        plan.listingTier &&
                        patch({ listingTier: { ...plan.listingTier, note } })
                      }
                      placeholder="What the badge buys"
                      value={plan.listingTier.note}
                    />
                  </span>
                }
                checkClassName={TIER_TONE[plan.listingTier.tone].check}
                href={editor ? null : listingTierHref(plan.listingTier.slug)}
              >
                <span className={TIER_TONE[plan.listingTier.tone].label}>
                  <Label
                    editor={editor}
                    onChange={(label) =>
                      plan.listingTier &&
                      patch({ listingTier: { ...plan.listingTier, label } })
                    }
                    placeholder="Badge"
                    value={plan.listingTier.label}
                  />
                </span>{" "}
                badge
              </PlanLine>
            </li>
          ) : null}

          {services.map((service) => (
            <li key={service.slug}>
              <PlanLine
                action={
                  editor ? (
                    <OpenServiceButton
                      href={editor.serviceHrefFor(service.slug)}
                      name={service.name}
                    />
                  ) : null
                }
                href={editor ? null : serviceHref(service.slug)}
                muted
              >
                <Label
                  editor={editor}
                  onChange={(name) => editor?.onPatchService(service.slug, { name })}
                  placeholder="Service"
                  value={service.name}
                />
              </PlanLine>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}

/**
 * The row of cards. One container drives the whole row so they arrive left to
 * right rather than all at once, which is what makes the middle one read as the
 * answer instead of one of three.
 *
 * The admin editor passes `animate={false}`: a staggered entrance is right once,
 * on a marketing page, and wrong on a screen the owner is typing into.
 */
export function PlanCards({
  animate = true,
  catalog,
  cycle,
  editor,
}: {
  animate?: boolean;
  catalog: PlansConfig;
  cycle: BillingCycle;
  editor?: PlansEditor;
}) {
  const { container, item, reduced } = useEntranceVariants();
  const className = "mt-10 grid gap-5 lg:grid-cols-3";

  if (!animate) {
    return (
      <div className={className}>
        {catalog.plans.map((plan) => (
          <div className="flex" key={plan.id}>
            <PlanCard
              catalog={catalog}
              cycle={cycle}
              editor={editor}
              plan={plan}
              reduced
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <motion.div
      animate="show"
      className={className}
      initial="hidden"
      variants={container}
    >
      {catalog.plans.map((plan) => (
        <motion.div className="flex" key={plan.id} variants={item}>
          <PlanCard
            catalog={catalog}
            cycle={cycle}
            editor={editor}
            plan={plan}
            reduced={reduced}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}

/**
 * The page's own heading and standfirst.
 *
 * A framer `variants` prop rather than a hardcoded entrance: the public page
 * renders these inside its staggered header container and passes the shared
 * item variant, and the admin preview renders them with nothing — a motion
 * element with no variants and no parent orchestrator is a plain element.
 */
export function PlansHeading({
  catalog,
  editor,
  variants,
}: {
  catalog: PlansConfig;
  editor?: PlansEditor;
  variants?: Variants;
}) {
  return (
    <>
      <motion.h1
        className="font-heading text-3xl font-bold tracking-tight text-foreground md:text-4xl"
        variants={variants}
      >
        <Label
          editor={editor}
          onChange={(title) => editor?.onPatchPage({ title })}
          placeholder="Page title"
          value={catalog.page.title}
        />
      </motion.h1>
      {catalog.page.subtitle || editor ? (
        <motion.p
          className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground"
          variants={variants}
        >
          <Label
            editor={editor}
            multiline
            onChange={(subtitle) => editor?.onPatchPage({ subtitle })}
            placeholder="One line under the title"
            value={catalog.page.subtitle}
          />
        </motion.p>
      ) : null}
    </>
  );
}

/**
 * `{siteName}` survives into the editor rather than being substituted there.
 *
 * The admin is typing into the stored string, so showing them the resolved
 * brand name would have the next keystroke write that name back over the
 * placeholder — and a platform that renamed itself would then rename itself
 * everywhere except the sentences an owner had once edited.
 */
type SiteIdentity = PublicSiteConfig["identity"];

function renderCopy(text: string, identity: SiteIdentity, editor?: PlansEditor) {
  return editor ? text : fillPlaceholders(text, identity);
}

export function PlansFootnote({
  catalog,
  editor,
  identity,
}: {
  catalog: PlansConfig;
  editor?: PlansEditor;
  identity: SiteIdentity;
}) {
  if (!catalog.page.footnote && !editor) {
    return null;
  }

  return (
    <p className="mt-6 text-center text-xs text-muted-foreground">
      <Label
        editor={editor}
        multiline
        onChange={(footnote) => editor?.onPatchPage({ footnote })}
        placeholder="The small print under the cards"
        value={renderCopy(catalog.page.footnote, identity, editor)}
      />
    </p>
  );
}

export function PlansClosingCta({
  animate = true,
  catalog,
  editor,
  identity,
}: {
  animate?: boolean;
  catalog: PlansConfig;
  editor?: PlansEditor;
  identity: SiteIdentity;
}) {
  const { item } = useEntranceVariants();
  const { ctaBody, ctaHref, ctaLabel, ctaTitle } = catalog.page;

  if (!ctaTitle && !ctaBody && !editor) {
    return null;
  }

  const body = (
    <>
      <div>
        <h2 className="font-heading text-lg font-bold text-white">
          <Label
            editor={editor}
            onChange={(next) => editor?.onPatchPage({ ctaTitle: next })}
            placeholder="Closing question"
            value={renderCopy(ctaTitle, identity, editor)}
          />
        </h2>
        <p className="mt-1 max-w-xl text-sm text-emerald-50/85">
          <Label
            editor={editor}
            multiline
            onChange={(next) => editor?.onPatchPage({ ctaBody: next })}
            placeholder="The answer, in two sentences"
            value={renderCopy(ctaBody, identity, editor)}
          />
        </p>
      </div>
      {editor ? (
        <span className="inline-flex shrink-0 items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand-teal shadow-sm">
          <Label
            editor={editor}
            onChange={(next) => editor.onPatchPage({ ctaLabel: next })}
            placeholder="Button"
            value={ctaLabel}
          />
        </span>
      ) : (
        <Link
          className="inline-flex shrink-0 items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand-teal shadow-sm transition hover:bg-emerald-50"
          href={ctaHref || "/contact"}
        >
          {fillPlaceholders(ctaLabel, identity)}
        </Link>
      )}
    </>
  );

  if (!animate) {
    return (
      <StarsCtaCard
        className="mt-20"
        contentClassName="flex flex-col items-center gap-5 p-8 text-center md:flex-row md:justify-between md:text-left"
      >
        {body}
      </StarsCtaCard>
    );
  }

  return (
    <motion.section
      className="mt-20"
      initial="hidden"
      variants={item}
      viewport={{ amount: 0.3, once: true }}
      whileInView="show"
    >
      <StarsCtaCard contentClassName="flex flex-col items-center gap-5 p-8 text-center md:flex-row md:justify-between md:text-left">
        {body}
      </StarsCtaCard>
    </motion.section>
  );
}
