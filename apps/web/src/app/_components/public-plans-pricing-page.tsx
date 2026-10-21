"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState, useSyncExternalStore } from "react";

import { getPlan } from "@hostel/shared/plans/catalog";
import { lifetimeOfferFor, lifetimeWindow } from "@hostel/shared/plans/lifetime";

import { Infinity as InfinityIcon, LayoutList, Timer } from "@/components/icons";
import { useSiteConfig } from "@/components/site-config-provider";
import { cn } from "@/lib/utils";

import { LifetimeDeal, useLifetimeAvailability } from "./lifetime-deal";
import { LeavePromise } from "./leave-promise";
import { PlansFaq } from "./plans-faq";
import {
  BillingToggle,
  PlanCards,
  PlansClosingCta,
  PlansFootnote,
  PlansHeading,
  useEntranceVariants,
} from "./plans-cards";
import type { BillingCycle } from "./plans-catalog";
import { PublicShell } from "./shared";

/**
 * Plans & Pricing.
 *
 * Two modules in one place, switched by a chip — **Standard plans** (the three
 * cards over the billing toggle) and **Lifetime offer** (the pay-once deal,
 * while it is on sale). One shows at a time, sliding in from the side of its
 * chip; the visitor's last pick is remembered on this browser, so a return
 * visit opens where they left. A card is a flat checklist — mark, name, price,
 * button, then what this plan adds over the one before it.
 *
 * Everything on the page is the `plans` and `lifetime` site-config sections
 * (Platform → Website Config); the trial length is Platform → Operations.
 */

type Module = "standard" | "lifetime";

const MODULE_KEY = "hostelpalika:pricing-module";

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readModule(): Module {
  try {
    return window.localStorage.getItem(MODULE_KEY) === "lifetime" ? "lifetime" : "standard";
  } catch {
    return "standard";
  }
}

export function PublicPlansPricingPage({ trialDays }: { trialDays: number }) {
  const { identity, lifetime, plans: catalog } = useSiteConfig();
  const [cycle, setCycle] = useState<BillingCycle>("annual");
  // The stored pick, read after hydration (the server renders Standard); a click overrides it.
  const stored = useSyncExternalStore(subscribeStorage, readModule, () => "standard" as const);
  const [picked, setPicked] = useState<Module | null>(null);
  const chosen = picked ?? stored;
  const { availability } = useLifetimeAvailability();
  const { container, item, reduced } = useEntranceVariants();

  // The lifetime chip exists only while the deal is on sale with something to sell.
  const lifetimeOpen =
    lifetimeWindow(lifetime) === "open" &&
    lifetime.offers.some((offer) => getPlan(catalog, offer.planId) && lifetimeOfferFor(lifetime, offer.planId));
  const shown: Module = lifetimeOpen ? chosen : "standard";

  function pick(next: Module) {
    setPicked(next);
    try {
      window.localStorage.setItem(MODULE_KEY, next);
    } catch {
      // Private mode: the pick lasts this visit only.
    }
  }

  const direction = shown === "lifetime" ? 1 : -1;

  return (
    <PublicShell active="plans-pricing">
      <div className="mx-auto max-w-[1320px] px-5 pb-24 pt-10 md:px-8">
        <motion.header animate="show" className="text-center" initial="hidden" variants={container}>
          <PlansHeading catalog={catalog} variants={item} />

          {lifetimeOpen ? (
            <motion.div className="mt-6 flex justify-center" variants={item}>
              <div className="relative inline-flex rounded-full border border-border bg-muted/60 p-1">
                {(
                  [
                    { icon: LayoutList, id: "standard", label: "Standard plans" },
                    { icon: InfinityIcon, id: "lifetime", label: "Lifetime offer" },
                  ] as const
                ).map((chip) => (
                  <button
                    aria-pressed={shown === chip.id}
                    className={cn(
                      "relative z-10 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
                      shown === chip.id ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                    key={chip.id}
                    onClick={() => pick(chip.id)}
                    type="button"
                  >
                    {shown === chip.id ? (
                      <motion.span
                        className="absolute inset-0 -z-10 rounded-full bg-primary shadow-sm"
                        layoutId="pricing-chip"
                        transition={{ damping: 30, stiffness: 380, type: "spring" }}
                      />
                    ) : null}
                    <chip.icon className="size-4" />
                    {chip.label}
                  </button>
                ))}
              </div>
            </motion.div>
          ) : null}
        </motion.header>

        <AnimatePresence custom={direction} initial={false} mode="wait">
          <motion.section
            animate={{ opacity: 1, x: 0 }}
            custom={direction}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -40 * direction }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 40 * direction }}
            key={shown}
            transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {shown === "standard" ? (
              <>
                <div className="mt-6 flex flex-col items-center gap-3">
                  <BillingToggle catalog={catalog} cycle={cycle} onCycleChange={setCycle} />
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-foreground">
                    <Timer className="size-3.5 text-primary" />
                    Every plan starts with a {trialDays}-day free trial
                  </span>
                </div>
                <PlanCards catalog={catalog} cycle={cycle} />
                <PlansFootnote catalog={catalog} identity={identity} />
              </>
            ) : (
              <div className="[&>section]:mt-8">
                <LifetimeDeal availability={availability} catalog={catalog} deal={lifetime} identity={identity} />
              </div>
            )}
          </motion.section>
        </AnimatePresence>

        {/* Before the questions: the answer to "can I leave, and what happens to my data". */}
        <LeavePromise className="mx-auto mt-14 max-w-5xl" />

        <PlansFaq />

        <PlansClosingCta catalog={catalog} identity={identity} />
      </div>
    </PublicShell>
  );
}
