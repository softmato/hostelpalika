"use client";

import { CheckCircle2, CircleAlert, KeyRound, QrCode, Wallet } from "@/components/icons";
import { memo, useMemo, useState } from "react";

import {
  CopyButton,
  ManualMethodPanel,
  MethodIcon,
  methodKey,
  methodLabel,
  type PayMethod,
  PROVIDER_LABEL,
} from "@/app/_components/payment-method-ui";
import { currency } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { monthLabel } from "@/lib/format-month";
import { cn } from "@/lib/utils";

/**
 * What was just agreed at the desk, while the resident is still standing there.
 *
 * ## The reference code has one moment, and this is it
 *
 * Registering somebody raises up to two invoices, each with a reference code the
 * resident is supposed to quote on their transfer. Everything downstream depends
 * on it — statement matching, auto-settlement, the owner's review queue not
 * filling with money nobody can attribute — and it was shown nowhere. The intake
 * ended in a one-line toast, the codes existed only in the database and in an
 * email the resident may not read for a day, and by the time they paid there was
 * nothing to quote. So the codes are printed here, monospaced and one tap to
 * copy, at the one moment the person who owes the money is in the room.
 *
 * ## And how to pay, on the same screen
 *
 * The hostel's own methods come back with the registration
 * (`getHostelPayMethods`), rendered through the same components as the
 * resident's checkout — a warden reading out an eSewa id must be reading the
 * same id the resident's portal will show them.
 *
 * ## Pay later is a real answer, not a dismissal
 *
 * Most residents do not pay at the desk: they transfer that evening, or their
 * guardian does. Closing this without paying is therefore the ordinary path and
 * is labelled as such — the invoices stay open, the codes stay valid, and the
 * resident settles from their own portal. The alternative, an unlabelled close
 * button, reads as "cancel" over money that has already been billed.
 */

export type RegisteredInvoice = {
  amount: number;
  /** Null on the joining invoice — it belongs to no month. */
  period: string | null;
  /** Empty for invoices raised before reference codes existed. */
  referenceCode: string;
  title: string;
};

export type RegistrationOutcome = {
  /** Why the account was not promoted, when it was not. */
  accountLinkReason?: string;
  accountLinked: boolean;
  /** What is owed at the door — the sum of the invoices below. */
  dueNow: number;
  howToPay: {
    displayName: string | null;
    instructions: string | null;
    methods: PayMethod[];
    usable: boolean;
  } | null;
  invoices: RegisteredInvoice[];
  /** Said out loud when no rent was raised: a pending resident owes nothing yet. */
  rentNote: string | null;
  residentId: string;
  residentName: string;
};

/**
 * Why an account could not be turned into a resident login, in words a warden
 * can act on.
 *
 * The server's reason codes are the truth; a sentence per code is what makes the
 * next step obvious. Anything unmapped falls through to the activation code,
 * which is the manual path that always works.
 */
const LINK_REASON: Record<string, string> = {
  ACCOUNT_ALREADY_LINKED:
    "That account is already the login for another resident. Register them with a different email, or move the existing resident out first.",
  ACCOUNT_HAS_NO_EMAIL:
    "The scanned account has no email address on it, so there was nothing to sign in with.",
  ACCOUNT_LINK_FAILED:
    "Their account could not be updated just now. Generate an activation code and they can redeem it themselves.",
  NO_ACCOUNT:
    "No platform account uses that email yet. They can create one and redeem an activation code, or sign up with this exact address.",
  NO_EMAIL:
    "No email was recorded for them, so there is no account to promote. Add one to their profile, or hand them an activation code.",
  ROLE_TOO_PRIVILEGED:
    "That email belongs to an administrator account, which an intake may not change. They need a separate resident login.",
};

function linkReason(reason?: string) {
  return (
    (reason ? LINK_REASON[reason] : null) ??
    "Their account could not be linked automatically. Generate an activation code for them."
  );
}

function InvoiceCard({ invoice }: { invoice: RegisteredInvoice }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-foreground">
          {invoice.title}
          {invoice.period ? (
            <span className="ml-1.5 font-semibold text-muted-foreground">
              {monthLabel(invoice.period)}
            </span>
          ) : null}
        </p>
        <p className="text-base font-extrabold tabular-nums text-foreground">
          {currency(invoice.amount)}
        </p>
      </div>
      {invoice.referenceCode ? (
        <div className="mt-2.5 flex items-center justify-between gap-3 rounded-lg border-2 border-role-admin/40 bg-role-admin/5 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
              Reference code
            </p>
            {/* The one field the resident must type on their transfer, so it
                gets the strongest treatment on the card. */}
            <p className="truncate font-mono text-lg font-extrabold tracking-wide text-foreground">
              {invoice.referenceCode}
            </p>
          </div>
          <CopyButton label="reference code" size="lg" value={invoice.referenceCode} />
        </div>
      ) : (
        <p className="mt-2 text-xs font-semibold text-muted-foreground">
          This invoice carries no reference code. The resident should quote their
          name and room when they pay.
        </p>
      )}
    </div>
  );
}

function HowToPay({ outcome }: { outcome: RegistrationOutcome }) {
  const methods = useMemo(
    () => outcome.howToPay?.methods ?? [],
    [outcome.howToPay],
  );
  const [selected, setSelected] = useState(() =>
    methods.length > 0 ? methodKey(methods[0]) : "",
  );
  /*
   * Always one of the methods on screen, never null: the selected key can name a
   * method that is no longer in the list, and falling back to the first is what
   * keeps a panel under the chips instead of a hole.
   */
  const active = useMemo(
    () => methods.find((method) => methodKey(method) === selected) ?? methods[0],
    [methods, selected],
  );

  if (!outcome.howToPay || !outcome.howToPay.usable || !active) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-amber-500/15 p-3 text-xs font-semibold leading-4 text-amber-800 dark:text-amber-300">
        <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        This hostel has no payment details set up yet, so there is nothing to give
        the resident. Add an eSewa ID, a bank account or a payment QR under Finance
        → Payment profile.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {outcome.howToPay.displayName ? (
        <p className="text-xs font-semibold text-muted-foreground">
          Paid to {outcome.howToPay.displayName}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {methods.map((method) => {
          const key = methodKey(method);

          return (
            <button
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition",
                key === methodKey(active)
                  ? "border-role-admin bg-role-admin/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
              key={key}
              onClick={() => setSelected(key)}
              type="button"
            >
              <MethodIcon method={method} />
              {methodLabel(method)}
            </button>
          );
        })}
      </div>
      {active.kind === "GATEWAY" ? (
        /*
         * A checkout cannot be started from here. Creating a payment intent
         * authorises against the *resident's* session and hands their browser to
         * the provider; a warden pressing it would be paying from their own
         * account. So the button is described rather than offered.
         */
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs font-semibold leading-4 text-muted-foreground">
          <Wallet aria-hidden className="mt-0.5 size-4 shrink-0" />
          {PROVIDER_LABEL[active.provider]} checkout is live for this hostel. The
          resident pays with one tap from their own Fees &amp; Payments screen — it
          settles itself, with no screenshot to review.
        </p>
      ) : (
        <ManualMethodPanel method={active} />
      )}
      {outcome.howToPay.instructions ? (
        <p className="whitespace-pre-line rounded-lg border border-border bg-muted/40 p-3 text-xs font-medium leading-5 text-muted-foreground">
          {outcome.howToPay.instructions}
        </p>
      ) : null}
    </div>
  );
}

export const ResidentRegisteredSummary = memo(function ResidentRegisteredSummary({
  onClose,
  onGenerateActivation,
  outcome,
}: {
  onClose: () => void;
  onGenerateActivation: (residentId: string) => void;
  outcome: RegistrationOutcome | null;
}) {
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open={Boolean(outcome)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {outcome ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 aria-hidden className="size-5 text-emerald-600" />
                {outcome.residentName} is registered
              </DialogTitle>
              <DialogDescription>
                {outcome.invoices.length > 0
                  ? `${currency(outcome.dueNow)} is due. Give them the reference code below — a transfer without it has to be matched by hand.`
                  : "Nothing was invoiced at the door."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg p-3 text-xs font-semibold leading-4",
                  outcome.accountLinked
                    ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                    : "bg-amber-500/15 text-amber-800 dark:text-amber-300",
                )}
              >
                <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">
                  {outcome.accountLinked
                    ? "Their account is now a resident login — they sign in with their own email and land on their resident dashboard."
                    : linkReason(outcome.accountLinkReason)}
                </span>
              </div>

              {outcome.accountLinked ? null : (
                <Button
                  className="w-full"
                  onClick={() => onGenerateActivation(outcome.residentId)}
                  type="button"
                  variant="outline"
                >
                  <QrCode className="size-4" />
                  Generate activation code
                </Button>
              )}

              {outcome.invoices.length > 0 ? (
                <div className="space-y-2.5">
                  {outcome.invoices.map((invoice) => (
                    <InvoiceCard invoice={invoice} key={invoice.title} />
                  ))}
                  {/* The mistake this prevents: one transfer for the total,
                      quoting one code. It settles that invoice and leaves the
                      other open to age towards a dunning notice. */}
                  <p className="text-xs font-medium text-muted-foreground">
                    {outcome.invoices.length > 1
                      ? "Two invoices, so two payments — each quotes its own code. A single transfer for the total settles only the invoice whose code it carries."
                      : "One payment, one code. It works for cash at the desk as well as a transfer — the code is how the payment is matched to them either way."}
                  </p>
                </div>
              ) : null}

              {outcome.rentNote ? (
                <p className="text-xs font-semibold text-muted-foreground">
                  {outcome.rentNote}
                </p>
              ) : null}

              {outcome.invoices.length > 0 ? (
                <section className="space-y-2.5 border-t border-border pt-4">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    How they can pay
                  </h3>
                  <HowToPay outcome={outcome} />
                </section>
              ) : null}
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              {/* Labelled, because closing without paying is the ordinary path
                  and an unlabelled close reads as "cancel" over a real bill. */}
              <Button onClick={onClose} type="button" variant="outline">
                Pay later
              </Button>
              <Button onClick={onClose} type="button">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
});
