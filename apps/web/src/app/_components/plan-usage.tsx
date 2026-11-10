"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { formatBsAdDate, hostelDaysBetween } from "@hostel/shared/calendar/bs";

import { AlertTriangle, Check, Lock } from "@/components/icons";
import { useSiteConfig } from "@/components/site-config-provider";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { API_WRITE_EVENT, browserApi, PLAN_LIMIT_EVENT } from "@/lib/browser-api";
import { cn } from "@/lib/utils";

import { freeTierOf } from "./plans-catalog";

/**
 * Where the hostel stands against its plan — `GET /hostel-admin/billing/usage`.
 * Billing draws the meters and the chooser from it; the banner on every screen
 * draws the over-limit clock.
 */
export type PlanUsage = {
  state: "none" | "trial" | "paid" | "free";
  planName: string | null;
  caps: Record<Seat, number | null>;
  used: Record<Seat, number>;
  overLimit: boolean;
  overSince: string | null;
  readOnlyFrom: string | null;
  readOnly: boolean;
  trialEndsAt: string | null;
};

type Seat = "residents" | "wardens" | "cooks";

const SEATS: { id: Seat; label: string }[] = [
  { id: "residents", label: "Residents" },
  { id: "wardens", label: "Warden accounts" },
  { id: "cooks", label: "Cook accounts" },
];

const BILLING = "/hostel-admin/billing";

/** Loads once and again after any portal write, so a move-out updates the meters. */
export function usePlanUsage() {
  const [usage, setUsage] = useState<PlanUsage | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await browserApi<{ usage: PlanUsage | null }>("/api/v1/hostel-admin/billing/usage");
      setUsage(result.usage);
    } catch {
      // A reminder, not a gate: it shows nothing rather than an error on every screen.
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
    const reload = () => void load();
    window.addEventListener(API_WRITE_EVENT, reload);
    return () => window.removeEventListener(API_WRITE_EVENT, reload);
  }, [load]);

  return usage;
}

function seatsOver(usage: PlanUsage) {
  return SEATS.filter(({ id }) => usage.caps[id] !== null && usage.used[id] > usage.caps[id]!);
}

function overLine(usage: PlanUsage) {
  return seatsOver(usage)
    .map(({ id, label }) => `${usage.used[id]} ${label.toLowerCase()} (${usage.planName ?? "Free"} covers ${usage.caps[id]})`)
    .join(", ");
}

/**
 * Top of every hostel-admin screen while a free-tier hostel is over its caps:
 * amber with the day it turns read-only, then red once it has. Not dismissible
 * — it is the only thing standing between the owner and a locked portal.
 */
export function PlanLimitBanner() {
  const usage = usePlanUsage();

  if (!usage?.overLimit || !usage.readOnlyFrom) return null;

  const daysLeft = hostelDaysBetween(new Date(), new Date(usage.readOnlyFrom));
  const tone = usage.readOnly ? "destructive" : "warning";

  return (
    <div className={cn("mb-4 rounded-lg border px-4 py-3", tone === "warning" ? "border-warning/40 bg-warning/10" : "border-destructive/40 bg-destructive/10")}>
      <div className="flex flex-wrap items-center gap-3">
        {usage.readOnly ? <Lock className="size-4 shrink-0 text-destructive" /> : <AlertTriangle className="size-4 shrink-0 text-warning" />}
        <p className="min-w-0 flex-1 text-sm text-foreground">
          <strong className="font-semibold">
            {usage.readOnly
              ? "Your portal is read-only."
              : daysLeft <= 0
                ? "Your portal turns read-only tonight."
                : `Your portal turns read-only on ${formatBsAdDate(new Date(usage.readOnlyFrom))}.`}
          </strong>{" "}
          <span className="text-muted-foreground">
            You have {overLine(usage)}. Upgrade, or move residents out or remove staff to get back within it.
          </span>
        </p>
        <Link
          className={cn(
            "inline-flex shrink-0 items-center rounded-lg px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110",
            usage.readOnly ? "bg-destructive" : "bg-warning",
          )}
          href={BILLING}
        >
          Choose a plan
        </Link>
      </div>
    </div>
  );
}

function Meter({ cap, label, used }: { cap: number | null; label: string; used: number }) {
  const ratio = cap === null ? 0 : cap === 0 ? 1 : Math.min(1, used / cap);
  const over = cap !== null && used > cap;
  const near = !over && cap !== null && ratio >= 0.8;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-semibold tabular-nums", over ? "text-destructive" : near ? "text-warning" : "text-foreground")}>
          {used}
          <span className="font-normal text-muted-foreground"> / {cap === null ? "Unlimited" : cap}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", over ? "bg-destructive" : near ? "bg-warning" : "bg-brand-teal")}
          style={{ width: `${cap === null ? 0 : Math.max(ratio * 100, used > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Billing's plan block: what the hostel is on, its seats against the caps, and
 * the chooser — every plan, Free first, marked "fits" or with the seat that
 * does not, so the owner picks with their own numbers in front of them.
 */
export function PlanUsageCard() {
  const usage = usePlanUsage();
  const config = useSiteConfig();

  if (!usage || usage.state === "none") return null;

  const free = freeTierOf(config.plans);
  const options = [
    { caps: { cooks: free.portalAccess.cooks, residents: free.maxResidents, wardens: free.portalAccess.wardens }, id: "free", name: free.name },
    ...config.plans.plans.map((plan) => ({
      caps: { cooks: plan.portalAccess.cooks, residents: plan.maxResidents, wardens: plan.portalAccess.wardens },
      id: plan.id,
      name: plan.name,
    })),
  ];
  const current = usage.state === "free" ? "free" : usage.state === "paid" ? config.plans.plans.find((plan) => plan.name === usage.planName)?.id : null;
  const heading =
    usage.state === "trial"
      ? `Free trial${usage.trialEndsAt ? ` · ends ${formatBsAdDate(new Date(usage.trialEndsAt))}` : ""}`
      : `${usage.planName ?? "Your plan"}${usage.state === "free" ? " plan" : ""}`;

  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-bold text-foreground">{heading}</h2>
        {usage.overLimit ? (
          <span className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-semibold text-destructive">
            {usage.readOnly ? "Read-only" : "Over the limit"}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {SEATS.map(({ id, label }) => (
          <Meter cap={usage.state === "trial" ? null : usage.caps[id]} key={id} label={label} used={usage.used[id]} />
        ))}
      </div>

      <h3 className="mt-6 text-sm font-semibold text-foreground">
        {usage.state === "trial" ? "After your trial" : "Which plan fits"}
      </h3>
      <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
        {options.map((option) => {
          const short = SEATS.filter(({ id }) => option.caps[id] !== null && usage.used[id] > option.caps[id]!);

          return (
            <li className="flex flex-wrap items-center gap-3 px-4 py-3" key={option.id}>
              <span className="min-w-24 font-semibold text-foreground">{option.name}</span>
              {short.length === 0 ? (
                <span className="inline-flex items-center gap-1 text-sm text-brand-teal">
                  <Check className="size-4" /> Fits
                </span>
              ) : (
                <span className="text-sm text-destructive">
                  {short.map(({ id, label }) => `${usage.used[id]} / ${option.caps[id]} ${label.toLowerCase()}`).join(" · ")}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {option.id === current ? "Current plan" : option.id === "free" ? "Free forever" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The sheet a cap or the read-only lock opens, wherever it was hit:
 * `browserApi` raises `PLAN_LIMIT_EVENT` and this answers with the way out.
 */
export function PlanLimitDialog() {
  const [message, setMessage] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    const open = (event: Event) => setMessage((event as CustomEvent<{ code: string; message: string }>).detail);
    window.addEventListener(PLAN_LIMIT_EVENT, open);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, open);
  }, []);

  return (
    <Dialog onOpenChange={(open) => !open && setMessage(null)} open={message !== null}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{message?.code === "PLAN_OVER_LIMIT" ? "Your portal is read-only" : "You've reached your plan's limit"}</DialogTitle>
          <DialogDescription>{message?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            onClick={() => setMessage(null)}
            type="button"
          >
            Not now
          </button>
          <Link
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110"
            href={BILLING}
            onClick={() => setMessage(null)}
          >
            Compare plans
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
