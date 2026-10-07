"use client";

import { motion } from "framer-motion";
import { useState } from "react";

import { useSiteConfig } from "@/components/site-config-provider";

import { LifetimeDeal, useLifetimeAvailability } from "./lifetime-deal";
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
 * Three cards over one billing toggle, then the questions. A card is a flat
 * checklist — mark, name, price, button, then what this plan adds over the one
 * before it — because that is how a pricing card is read: down the ticks, not
 * through sub-headings.
 *
 * Every service name in a card links to its own detail page: the question a
 * hostel owner has about a line item is "what is that one", and a card has no
 * room to answer it. That is also why the full module-by-module catalogue is
 * *not* repeated underneath — it was the same set of services a second time,
 * one scroll below the cards that already link to every one of them. What the
 * space is worth more for is the question the reader is actually stuck on, so
 * the FAQ has it.
 *
 * Everything on the page — the tiers, the prices, the discounts, every service
 * name and every word of the headings — is the `plans` site-config section, so
 * the platform owner changes it in Platform → Website Config → Plans & Pricing
 * rather than by shipping a build. This file is the shell and the entrance
 * animation; the page itself is `plans-cards.tsx`, which that admin screen
 * renders too, so the editor cannot drift from what a visitor sees.
 */
export function PublicPlansPricingPage() {
  const { identity, lifetime, plans: catalog } = useSiteConfig();
  const [cycle, setCycle] = useState<BillingCycle>("annual");
  const { availability } = useLifetimeAvailability();
  const { container, item, reduced } = useEntranceVariants();

  return (
    <PublicShell active="plans-pricing">
      <div className="mx-auto max-w-[1320px] px-5 pb-24 pt-10 md:px-8">
        <motion.header
          animate="show"
          className="text-center"
          initial="hidden"
          variants={container}
        >
          <PlansHeading catalog={catalog} variants={item} />

          <motion.div variants={item}>
            <BillingToggle catalog={catalog} cycle={cycle} onCycleChange={setCycle} />
          </motion.div>
        </motion.header>

        <PlanCards catalog={catalog} cycle={cycle} />

        <motion.div
          animate={{ opacity: 1 }}
          initial={{ opacity: 0 }}
          transition={{ delay: reduced ? 0 : 0.5, duration: 0.4 }}
        >
          <PlansFootnote catalog={catalog} identity={identity} />
        </motion.div>

        {/* Its own block under the tiers — the cards above are untouched by it. */}
        <LifetimeDeal
          availability={availability}
          catalog={catalog}
          deal={lifetime}
          identity={identity}
        />

        <PlansFaq />

        <PlansClosingCta catalog={catalog} identity={identity} />
      </div>
    </PublicShell>
  );
}
