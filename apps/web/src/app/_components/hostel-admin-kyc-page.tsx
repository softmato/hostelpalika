"use client";

import {
  Check,
  ChevronRight,
  Clock,
  FileText,
  House,
  ImageIcon,
  Landmark,
  ListChecks,
  Lock,
  MapPin,
  QrCode,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tags,
  UtensilsCrossed,
  Wallet,
  Building2,
  type IconComponent,
} from "@/components/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useEffect, useState, type ReactNode } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { KycStepBody, type Kyc, WIDE_STEPS } from "@/app/_components/kyc-steps";
import { PortalPageHeader } from "@/app/_components/portal-dashboard-ui";
import { StepFlow } from "@/app/_components/registration-step-shell";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { API_WRITE_EVENT, browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/v1/hostel-admin/kyc";

/** One screen per step, every one filled in place (`kyc-steps.tsx`). */
const STEPS: Record<string, { hint: string; icon: IconComponent; title: string }> = {
  details: { hint: "Who lives here, and the address", icon: House, title: "Hostel details" },
  rates: { hint: "Each room type and its monthly rent", icon: Tags, title: "Room types & rent" },
  documents: { hint: "Owner ID and PAN / VAT", icon: FileText, title: "Documents" },
  facilities: { hint: "Tap what you offer", icon: Sparkles, title: "Facilities" },
  food: { hint: "Your weekly menu", icon: UtensilsCrossed, title: "Weekly food" },
  location: { hint: "Drop the pin on your door", icon: MapPin, title: "Map pin" },
  payments: { hint: "Where residents pay rent", icon: QrCode, title: "Rent payments" },
  payout: { hint: "Where booking money lands", icon: Landmark, title: "Booking payout" },
  opening: { hint: "Your bank balance when you start", icon: Wallet, title: "Opening balance" },
  photos: { hint: "Outside and inside", icon: ImageIcon, title: "Photos" },
  rooms: { hint: "Each floor and its room numbers", icon: Building2, title: "Rooms & floors" },
  rules: { hint: "One rule per line", icon: ListChecks, title: "House rules" },
};

const PRIMARY = "inline-flex h-11 w-full items-center justify-center rounded-xl bg-brand-teal px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50";
const GHOST = "inline-flex h-11 w-full items-center justify-center rounded-xl px-5 text-sm font-semibold text-muted-foreground transition hover:bg-muted";
const FOOT_PRIMARY = "inline-flex h-10 items-center justify-center rounded-xl bg-brand-teal px-5 text-sm font-semibold text-white transition hover:opacity-90";
const FOOT_GHOST = "inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-semibold text-muted-foreground transition hover:bg-muted disabled:invisible";
const OUTLINE = "inline-flex h-11 w-full items-center justify-center rounded-xl border border-border px-5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:opacity-50";

function errorText(caught: unknown) {
  return caught instanceof Error ? caught.message : "That did not save.";
}

function Ring({ percent, size = 112 }: { percent: number; size?: number }) {
  const stroke = size / 10;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;

  return (
    <div className="relative shrink-0" style={{ height: size, width: size }}>
      <svg className="-rotate-90" height={size} width={size}>
        <circle className="stroke-muted" cx={size / 2} cy={size / 2} fill="none" r={radius} strokeWidth={stroke} />
        <circle
          className="stroke-brand-teal transition-[stroke-dashoffset] duration-700 ease-out"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          strokeDasharray={length}
          strokeDashoffset={length * (1 - percent / 100)}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-bold text-foreground" style={{ fontSize: size / 4.5 }}>
        {percent}%
      </span>
    </div>
  );
}

/** Dashboard nudge. Renders nothing once KYC is complete, or for a warden. */
export function HostelKycBanner() {
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<{ kyc: Kyc }>(ENDPOINT);
  const kyc = resource.data?.kyc;

  // A quick sign-up's banner stays until our team approves it.
  if (!kyc || ((!kyc.review || kyc.review.status === "APPROVED") && kyc.percent >= 100)) {
    return null;
  }

  const inReview = kyc.review?.status === "SUBMITTED";

  return (
    <Link
      className="group flex items-center gap-4 rounded-2xl border border-brand-teal/30 bg-brand-teal/5 p-4 transition hover:bg-brand-teal/10"
      href={workspaceHref("/hostel-admin/kyc")}
    >
      <Ring percent={kyc.percent} size={56} />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-foreground">{inReview ? "KYC in review" : "Complete hostel KYC"}</p>
        <p className="text-sm text-muted-foreground">
          {inReview ? "We check it within 24 hours" : "Send it for review to open every feature"}
        </p>
      </div>
      <ChevronRight className="size-5 text-brand-teal transition group-hover:translate-x-0.5" />
    </Link>
  );
}

/**
 * Hostel KYC — a guided walk through what a hostel still has to finish. Every
 * section sits in the list; one opens at a time with Back / Next. Small forms
 * save in place; the heavy editors (menu, map, rate card) open with their spot
 * ringed and come back here once it is saved (`kyc-focus.tsx`).
 */
export const HostelAdminKycPageContent = memo(function HostelAdminKycPageContent() {
  const router = useRouter();
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<{ kyc: Kyc }>(ENDPOINT, {
    errorMessage: "Could not load hostel KYC.",
  });
  const kyc = resource.data?.kyc;
  const [index, setIndex] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const { refresh } = resource;

  // A save in any step — the embedded editors included — re-reads, so the tick lands.
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(API_WRITE_EVENT, refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(API_WRITE_EVENT, refresh);
    };
  }, [refresh]);

  if (!kyc) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="h-96 animate-pulse rounded-2xl bg-muted" />
        <div className="h-96 animate-pulse rounded-3xl bg-muted" />
        {resource.message ? <p className="text-sm text-destructive">{resource.message}</p> : null}
      </div>
    );
  }

  const steps = kyc.steps;
  const review = kyc.review ?? null;
  const doneCount = steps.filter((item) => item.done).length;
  const firstOpen = steps.findIndex((item) => !item.done);
  const current = index ?? Math.max(0, firstOpen);
  const showFinish = finished || (index === null && firstOpen === -1);
  const step = steps[current];
  const meta = STEPS[step.key];
  const go = (at: number) => {
    setFinished(false);
    setIndex(at);
  };
  // Next skips what is already done; past the last open one is the finish card.
  const advance = () => {
    const after = steps.findIndex((item, at) => at > current && !item.done);

    if (after === -1) setFinished(true);
    else setIndex(after);
  };
  const saved = async () => {
    await resource.refreshAsync();
    advance();
  };
  const status = !review
    ? null
    : review.status === "APPROVED"
      ? { label: "Verified", tone: "success" }
      : review.status === "SUBMITTED"
        ? { label: "In review", tone: "muted" }
        : review.status === "REJECTED"
          ? { label: "Sent back", tone: "danger" }
          : review.missing.length > 0
            ? { label: `${review.missing.length} required left`, tone: "warning" }
            : { label: "Ready to send", tone: "success" };

  const Icon = step.done ? Check : meta.icon;

  return (
    <div className="space-y-4">
      <PortalPageHeader description={`${doneCount} of ${steps.length} sections done`} title="Hostel KYC" />

      <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
        <aside className="rounded-2xl border border-border bg-card p-2 lg:sticky lg:top-4">
          <div className="space-y-2 px-3 pb-3 pt-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-semibold text-foreground">{kyc.percent}% done</span>
              {status ? (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    status.tone === "success" && "bg-brand-teal/10 text-brand-teal",
                    status.tone === "warning" && "bg-warning/10 text-warning",
                    status.tone === "danger" && "bg-destructive/10 text-destructive",
                    status.tone === "muted" && "bg-muted text-muted-foreground",
                  )}
                >
                  {status.label}
                </span>
              ) : null}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand-teal transition-[width] duration-700 ease-out"
                style={{ width: `${kyc.percent}%` }}
              />
            </div>
          </div>

          <ol className="hidden space-y-0.5 lg:block">
            {steps.map((item, at) => {
              const StepIcon = STEPS[item.key]?.icon ?? FileText;
              const active = !showFinish && at === current;

              return (
                <li key={item.key}>
                  <button
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition",
                      active ? "bg-brand-teal/10" : "hover:bg-muted",
                    )}
                    onClick={() => go(at)}
                    type="button"
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg",
                        item.done ? "bg-brand-teal text-white" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {item.done ? <Check className="size-4" strokeWidth={3} /> : <StepIcon className="size-4" />}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate text-foreground", active && "font-semibold")}>
                      {STEPS[item.key]?.title ?? item.key}
                    </span>
                    {!item.done && item.required ? (
                      <span aria-label="Required" className="size-1.5 shrink-0 rounded-full bg-warning" title="Required" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>

          {review && !showFinish && (review.canSubmit || review.status === "SUBMITTED") ? (
            <div className="px-1 pb-1 pt-2">
              <button className={review.canSubmit ? PRIMARY : OUTLINE} onClick={() => setFinished(true)} type="button">
                {review.canSubmit ? "Review & send" : "See status"}
              </button>
            </div>
          ) : null}
        </aside>

        {showFinish ? (
          <FinishCard
            kyc={kyc}
            onDashboard={() => router.push(workspaceHref("/hostel-admin/dashboard"))}
            onGo={go}
            onSubmitted={() => void resource.refreshAsync()}
          />
        ) : (
          <StepFlow className="rounded-3xl border border-border bg-card" stepKey={current}>
            <div className="flex flex-col items-center gap-3 px-6 pt-8 text-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
                <Icon className="size-7" strokeWidth={step.done ? 3 : 2} />
              </span>
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  Step {current + 1} of {steps.length}
                  {step.required ? " · Required" : ""}
                </p>
                <h2 className="mt-1 text-xl font-bold text-foreground">{meta.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{step.done ? "Saved — change anything below." : meta.hint}</p>
              </div>
            </div>

            <div className={cn("mx-auto w-full px-6 py-6", WIDE_STEPS.has(step.key) ? "max-w-3xl" : "max-w-md")}>
              <KycStepBody
                kyc={kyc}
                key={step.key}
                onChange={() => void resource.refreshAsync()}
                onSaved={saved}
                stepKey={step.key}
              />
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
              <button className={FOOT_GHOST} disabled={current === 0} onClick={() => setIndex(current - 1)} type="button">
                Back
              </button>
              <button className={step.done ? FOOT_PRIMARY : FOOT_GHOST} onClick={advance} type="button">
                {step.done ? "Next" : "Skip for now"}
              </button>
            </div>
          </StepFlow>
        )}
      </div>
    </div>
  );
});

const BENEFITS: [IconComponent, string][] = [
  [Smartphone, "Full access to the web and app portals"],
  [FileText, "An agreement letter between you and HostelPalika"],
];

/**
 * Where the walk ends: what the review asks next. A quick sign-up sends it
 * to our team; an older hostel (no review) just sees how far it got.
 */
function FinishCard({
  kyc,
  onDashboard,
  onGo,
  onSubmitted,
}: {
  kyc: Kyc;
  onDashboard: () => void;
  onGo: (at: number) => void;
  onSubmitted: () => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = kyc.review ?? null;
  const firstOpen = kyc.steps.findIndex((item) => !item.done);
  const firstMissing = review ? kyc.steps.findIndex((item) => review.missing.includes(item.key)) : -1;

  async function submit() {
    const ok = await confirm({
      actionLabel: "Send",
      cancelLabel: "Check again",
      description: "Our team checks it within 24 hours. Please make sure everything you entered is correct.",
      title: "Send your KYC for submission?",
    });

    if (!ok) return;

    setBusy(true);
    setError(null);

    try {
      await browserApi(`${ENDPOINT}/submit`, { body: "{}", method: "POST" });
      onSubmitted();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const badge = (Glyph: IconComponent, tone = "bg-brand-teal/10 text-brand-teal") => (
    <span className={cn("flex size-20 items-center justify-center rounded-full", tone)}>
      <Glyph className="size-9" />
    </span>
  );
  const dashboard = (variant: string) => (
    <button className={variant} onClick={onDashboard} type="button">
      Back to dashboard
    </button>
  );

  let icon: ReactNode = <Ring percent={kyc.percent} size={120} />;
  let title = `${kyc.percent}% done`;
  let line = "Finish the rest any time.";
  let benefits = false;
  let actions: ReactNode = (
    <>
      <button className={PRIMARY} onClick={() => onGo(Math.max(0, firstOpen))} type="button">
        Continue
      </button>
      {dashboard(GHOST)}
    </>
  );

  if (!review) {
    if (kyc.percent >= 100) {
      icon = badge(Check);
      title = "All sections done";
      line = "Your hostel is set up.";
      actions = dashboard(PRIMARY);
    }
  } else if (review.status === "APPROVED") {
    icon = badge(ShieldCheck);
    title = "Verified";
    line = "Every feature is open on the web and the app.";
    actions = dashboard(PRIMARY);
  } else if (review.status === "SUBMITTED") {
    icon = badge(Clock, "bg-muted text-muted-foreground");
    title = "Sent for review";
    line = "We check it within 24 hours. You can still edit anything until then. Once approved you get:";
    benefits = true;
    actions = dashboard(GHOST);
  } else if (review.canSubmit) {
    icon = badge(Send);
    title = "Send for submission";
    line = "Every required section is done. Once our team approves it you get:";
    benefits = true;
    actions = (
      <>
        <button className={PRIMARY} disabled={busy} onClick={() => void submit()} type="button">
          {busy ? "Sending…" : "Send for submission"}
        </button>
        {firstOpen >= 0 ? (
          <button className={GHOST} onClick={() => onGo(firstOpen)} type="button">
            Finish the optional sections first
          </button>
        ) : null}
      </>
    );
  } else {
    title = "Almost there";
    line = `Finish ${review.missing.map((key) => STEPS[key]?.title ?? key).join(", ")} to send it for review.`;
    actions = (
      <button className={PRIMARY} onClick={() => onGo(Math.max(0, firstMissing))} type="button">
        Continue
      </button>
    );
  }

  return (
    <StepFlow className="flex flex-col items-center gap-4 rounded-3xl border border-border bg-card px-6 py-10 text-center" stepKey={99}>
      {confirmDialog}
      {icon}
      <div className="space-y-1">
        <h2 className="text-2xl font-bold text-foreground">{title}</h2>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{line}</p>
      </div>
      {review?.status === "REJECTED" ? (
        <p className="w-full max-w-sm rounded-xl bg-destructive/10 px-4 py-3 text-left text-sm text-destructive">
          Sent back: {review.note ?? "please check and send it again."}
        </p>
      ) : null}
      {benefits ? (
        <ul className="w-full max-w-sm space-y-2 text-left">
          {BENEFITS.map(([Glyph, text]) => (
            <li className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm text-foreground" key={text}>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                <Glyph className="size-4" />
              </span>
              {text}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid w-full max-w-sm gap-2 pt-2">{actions}</div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {review && review.status !== "APPROVED" ? (
        <p className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
          <Lock className="size-3.5" />
          Only our verification team sees your documents.
        </p>
      ) : null}
    </StepFlow>
  );
}
