"use client";

import {
  AlertTriangle,
  Banknote,
  Check,
  Loader2,
  Sparkles,
} from "@/components/icons";
import { memo, useCallback, useState } from "react";

import {
  CopyButton,
  ManualMethodPanel,
  methodKey,
  methodLabel,
  type PayMethod,
  PROVIDER_LABEL,
} from "@/app/_components/payment-method-ui";
import { currency, EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import { WalletMark } from "@/components/wallet-mark";
import { browserApi } from "@/lib/browser-api";
import { monthLabel } from "@/lib/format-month";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { cn } from "@/lib/utils";
import { DueBar } from "./daily-portal-ui";
import { ModalAmount, ResidentFlowModal } from "./resident-flow-modal";
import {
  OFFER_PROGRAM_NAME,
  OfferProgramBadge,
  OfferProgramCallout,
} from "./resident-offer-program";
import { BillExtraRows, type BillLine } from "@/app/_components/khata-pages";

/**
 * How to pay one invoice (target §11.1, plan item 3.3).
 *
 * Laid out as a checkout: **methods on the left, an order summary on the
 * right.** The previous single column asked the resident to hold the amount and
 * the reference code in their head while they scrolled down to the QR — and
 * they are typing that code into a banking app on another device, so anything
 * that scrolls off screen is something they have to remember. The summary rail
 * does not move.
 *
 * **Opened as a modal** (see {@link ResidentFlowModal}). It was a section
 * injected into the middle of Fees & Payments, which meant a checkout rendered
 * beside an outstanding total, a status filter and every month the resident had
 * ever paid — and, on a phone, frequently below the fold they were looking at.
 *
 * **The reference code keeps the strongest treatment on the screen.** Everything
 * downstream depends on the resident actually typing it: statement matching,
 * auto-settlement, and the owner's review queue not filling with transfers
 * nobody can attribute. It is large, monospaced, one tap to copy, and it sits in
 * the rail that stays put.
 *
 * **One method is shown at a time.** Each way to pay is a card with the
 * provider's own logo; the picked one opens below. Six panels of account
 * numbers open at once is how somebody pays the right hostel from the wrong
 * app. Picking a logo first mirrors how they already think — "I'll use eSewa"
 * — and means the details on screen are only ever the ones they need.
 *
 * Methods come from the server already ordered and already filtered to the ones
 * the hostel actually configured, so this renders what it is given rather than
 * deciding what counts as a payment method.
 */

type IntentHandoff =
  | { kind: "REDIRECT"; url: string }
  | { kind: "FORM_POST"; url: string; fields: Record<string, string> }
  | { kind: "QR"; payload: string };

type PayInstructions = {
  amountDue: number;
  bedLabel: string | null;
  extras?: BillLine[];
  credit: number;
  displayName: string | null;
  dueDate: string | null;
  instructions: string | null;
  invoiceId: string;
  methods: PayMethod[];
  period: string | null;
  referenceCode: string | null;
  status: string;
  tier: "TIER_0" | "TIER_1";
  usable: boolean;
};

/**
 * Sends the browser to the provider.
 *
 * A form POST is built and submitted rather than fetched, because the resident's
 * browser has to be the thing that arrives at eSewa — a `fetch` would put *our*
 * server in the session and the payment could never complete. The form is
 * removed either way; a navigation is starting, but a failed one should not
 * leave hidden inputs holding a signature on the page.
 */
function handOff(handoff: IntentHandoff) {
  if (handoff.kind === "REDIRECT") {
    window.location.assign(handoff.url);
    return;
  }

  if (handoff.kind !== "FORM_POST") {
    return;
  }

  const form = document.createElement("form");

  form.action = handoff.url;
  form.method = "POST";
  form.style.display = "none";

  for (const [name, value] of Object.entries(handoff.fields)) {
    const input = document.createElement("input");

    input.name = name;
    input.type = "hidden";
    input.value = value;
    form.append(input);
  }

  document.body.append(form);
  form.submit();
  form.remove();
}

function GatewayPanel({
  amount,
  invoiceId,
  method,
}: {
  amount: number;
  invoiceId: string;
  method: Extract<PayMethod, { kind: "GATEWAY" }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = PROVIDER_LABEL[method.provider];

  const start = useCallback(() => {
    setBusy(true);
    setError("");

    browserApi<{ handoff: IntentHandoff }>(residentEndpoints.checkout(invoiceId), {
      body: JSON.stringify({ provider: method.provider }),
      method: "POST",
    })
      .then((result) => handOff(result.handoff))
      .catch((cause: Error) => {
        // The navigation never started, so the resident is still here and has to
        // be told why rather than left looking at a button that did nothing.
        setError(cause.message || `Could not open ${label}. Please try again.`);
        setBusy(false);
      });
  }, [invoiceId, label, method.provider]);

  return (
    <div className="space-y-3">
      <button
        className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-brand-teal px-4 py-3 text-[14px] font-bold text-white transition hover:bg-brand-teal/90 disabled:opacity-60"
        disabled={busy}
        onClick={start}
        type="button"
      >
        {busy ? (
          <Loader2 aria-hidden className="size-5 animate-spin" />
        ) : (
          <WalletMark name={method.provider} size={28} />
        )}
        {busy ? `Opening ${label}…` : `Pay ${currency(amount)} with ${label}`}
      </button>
      <p className="text-center text-[12.5px] text-muted-foreground">Confirms itself. No screenshot needed.</p>
      {method.sandbox ? (
        <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 p-2.5 text-[12px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Test mode — a sandbox merchant, no real money moves.
        </p>
      ) : null}
      {error ? (
        <p className="text-center text-[12.5px] font-semibold text-rose-600">{error}</p>
      ) : null}
    </div>
  );
}

/**
 * One method, expanded.
 *
 * The manual half is {@link ManualMethodPanel}, shared with the owner preview
 * and the intake desk; only a live checkout is rendered here, because starting
 * one needs this resident’s own session.
 */
function MethodPanel({
  amount,
  invoiceId,
  method,
}: {
  amount: number;
  invoiceId: string;
  method: PayMethod;
}) {
  if (method.kind === "GATEWAY") {
    return <GatewayPanel amount={amount} invoiceId={invoiceId} method={method} />;
  }

  return <ManualMethodPanel method={method} />;
}

/** The method's name on its card, and one short line of what it is. */
function methodCaption(method: PayMethod) {
  switch (method.kind) {
    case "GATEWAY":
      return "Confirms itself";
    case "BANK":
      return method.bankName
        ? `${method.bankName} · ••${method.accountNumber.slice(-4)}`
        : `Account ••${method.accountNumber.slice(-4)}`;
    case "QR":
      return "Any payment app";
    default:
      return method.id;
  }
}

function methodMarkName(method: PayMethod) {
  return method.kind === "GATEWAY"
    ? method.provider
    : method.kind === "BANK"
      ? method.bankName || "BANK"
      : method.kind;
}

export const ResidentPayInvoicePanel = memo(function ResidentPayInvoicePanel({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const resource = usePortalResource<PayInstructions>(
    residentEndpoints.payInstructions(invoiceId),
    { errorMessage: "Could not load payment instructions." },
  );
  const instructions = resource.data ?? null;
  const [picked, setPicked] = useState<string | null>(null);

  const methods = instructions?.methods ?? [];
  // **One method shown at a time** (target §11.1). The server already ranks the
  // methods — live checkouts, then QR, then wallet ids, then bank — so the one
  // open on arrival is simply the one it put first, and no client-side opinion
  // about which method is best can drift out of step with it. The rest are
  // logo cards a tap away: six panels of account numbers open at once is how
  // somebody pays the right hostel from the wrong app.
  const selected = methods.find((method) => methodKey(method) === picked) ?? methods[0] ?? null;
  // Needed unless every route on this screen settles itself. Scoping it to the
  // selected one would hide the instruction from a resident who switched to a
  // bank transfer — the one case where an unreferenced payment costs the owner
  // a manual match.
  const needsReference = methods.some((method) => method.kind !== "GATEWAY");

  return (
    <ResidentFlowModal
      amount={
        instructions ? (
          <ModalAmount label="To pay" value={currency(instructions.amountDue)} />
        ) : null
      }
      badge={<OfferProgramBadge />}
      description={
        instructions?.period
          ? `Rent for ${monthLabel(instructions.period)}`
          : "This invoice"
      }
      onClose={onClose}
      title="Complete your payment"
      wide
    >
      <>
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="Payment instructions could not be loaded." />
        ) : null}

        {instructions ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            {/* ── Left: pay with ─────────────────────────────────────── */}
            <div className="min-w-0 space-y-4">
              {instructions.usable ? (
                <>
                  <div>
                    <h3 className="font-heading text-[15px] font-semibold text-foreground">Pay with</h3>
                    {instructions.displayName ? (
                      <p className="text-[12.5px] text-muted-foreground">
                        To <span className="font-semibold text-foreground">{instructions.displayName}</span>
                      </p>
                    ) : null}
                  </div>

                  {/* A logo card per way to pay: the brand's own mark is what
                      tells eSewa from Khalti at a glance. */}
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {methods.map((method) => {
                      const on = selected !== null && methodKey(method) === methodKey(selected);

                      return (
                        <button
                          aria-pressed={on}
                          className={cn(
                            "flex flex-col items-start gap-2.5 rounded-2xl border bg-card p-3.5 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0",
                            on ? "border-transparent ring-2 ring-brand-teal" : "border-border/70",
                          )}
                          key={methodKey(method)}
                          onClick={() => setPicked(methodKey(method))}
                          type="button"
                        >
                          <span className="flex w-full items-start justify-between gap-2">
                            <WalletMark name={methodMarkName(method)} size={40} />
                            {on ? (
                              <span className="flex size-5 items-center justify-center rounded-full bg-brand-teal text-white">
                                <Check aria-hidden className="size-3" />
                              </span>
                            ) : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13.5px] font-semibold text-foreground">{methodLabel(method)}</span>
                            <span className="block truncate text-[11.5px] text-muted-foreground">{methodCaption(method)}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {selected ? (
                    <div className="rounded-2xl border border-border/70 bg-muted/30 p-4" key={methodKey(selected)}>
                      <MethodPanel
                        amount={instructions.amountDue}
                        invoiceId={instructions.invoiceId}
                        method={selected}
                      />
                    </div>
                  ) : null}

                  {instructions.instructions ? (
                    <p className="rounded-xl bg-muted/40 p-3 text-[13px] leading-5">
                      {instructions.instructions}
                    </p>
                  ) : null}

                  {/* Scoped to the manual methods on purpose: a gateway payment
                      settles itself, and telling a resident who just paid
                      through one to wait for approval is how they pay twice. */}
                  {needsReference ? (
                    <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      <Banknote aria-hidden className="size-4 shrink-0" />
                      <span>
                        Paid by QR, wallet or bank? Close this and tap{" "}
                        <span className="font-semibold text-foreground">I&apos;ve paid</span>.
                      </span>
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-[13.5px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-300">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <p>
                    <span className="font-semibold">No payment details set up yet.</span> Ask your hostel how to
                    pay, then send your screenshot with I&apos;ve paid.
                  </p>
                </div>
              )}
            </div>

            {/* ── Right: the summary that does not move ──────────────── */}
            <aside className="lg:sticky lg:top-4 lg:self-start">
              <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    Amount to pay
                  </p>
                  <p className="mt-1 font-heading text-[34px] font-bold leading-none tracking-tight text-foreground tabular-nums">
                    {currency(instructions.amountDue)}
                  </p>
                  {/* Next to the amount so they can sanity-check their own bill
                      before paying it — "is this the right rent" is answerable
                      only if the screen says what it is rent for. */}
                  {instructions.bedLabel ? (
                    <p className="mt-1.5 text-[12.5px] font-medium text-muted-foreground">
                      {instructions.bedLabel} · {monthLabel(instructions.period)}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[12.5px] font-medium text-muted-foreground">
                      {monthLabel(instructions.period)}
                    </p>
                  )}
                  {/* Beside the amount, never after it is decided on: a credit
                      read too late is a credit already ignored. */}
                  {instructions.credit > 0 ? (
                    <p className="mt-2 inline-block rounded-full bg-role-team-soft px-2.5 py-0.5 text-[11.5px] font-semibold text-role-team">
                      {currency(instructions.credit)} credit applied
                    </p>
                  ) : null}
                  <div className="mt-3">
                    <BillExtraRows lines={instructions.extras} />
                  </div>
                </div>

                {instructions.dueDate ? <DueBar dueDate={instructions.dueDate} /> : null}

                {/* The single most important element on the screen. It stays in
                    the rail so it is still visible while they are typing it into
                    a banking app on another device. */}
                {instructions.referenceCode ? (
                  <div
                    className={cn(
                      "rounded-2xl border-2 p-3 transition",
                      needsReference ? "border-brand-teal/50 bg-role-team-soft/40" : "border-border bg-card",
                    )}
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {needsReference ? "Put this in the remarks" : "Your reference"}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className="font-mono text-xl font-bold tracking-widest text-foreground">
                        {instructions.referenceCode}
                      </span>
                      <CopyButton label="reference code" size="lg" value={instructions.referenceCode} />
                    </div>
                    {/* The programme is what makes this instruction worth
                        following, so it is said here, at the moment they are
                        about to type it. */}
                    <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <Sparkles aria-hidden className="size-3.5 shrink-0 text-role-team" />
                      {needsReference
                        ? `Faster to confirm, and keeps you in the ${OFFER_PROGRAM_NAME}.`
                        : `Added for you, so it counts for the ${OFFER_PROGRAM_NAME}.`}
                    </p>
                  </div>
                ) : (
                  <OfferProgramCallout state="unavailable" />
                )}
              </div>
            </aside>
          </div>
        ) : null}
      </>
    </ResidentFlowModal>
  );
});
