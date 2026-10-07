"use client";

import {
  AlertTriangle,
  Banknote,
  Check,
  ChevronDown,
  Copy,
  FileText,
  HelpCircle,
  Loader2,
  ScanLine,
  Upload,
  XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useState, type FormEvent } from "react";

import { currency, Input as FormInput } from "@/app/_components/shared-ui";
import { useMediaViewer } from "@/components/media-viewer";
import { FileUploaderView, useUploader } from "@/components/uploads";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { dayMonthYear, monthLabel } from "@/lib/format-month";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { field, optionalField } from "./resident-shared";
import { RoleButton } from "./portal-dashboard-ui";
import { ModalAmount, ResidentFlowModal } from "./resident-flow-modal";
import { OfferProgramBadge, OfferProgramCallout } from "./resident-offer-program";
import { ShareReceiptSteps } from "./share-receipt-steps";
import {
  STAGE_LABELS,
  useEvidenceReader,
  type EvidenceStage,
} from "./use-evidence-reader";

/**
 * "I've paid — submit proof" (target §11.2, §11.3; plan item 3.4).
 *
 * Lifted out of the payments page once it stopped being a form and became a
 * screen: it now carries the reference code, a per-method guide to finding a
 * transaction id, and the two instant rejections — and none of that is about the
 * list of months it used to sit under.
 *
 * Three things carry the design:
 *
 * - **The amount is pre-filled** (§11.2). Most people pay exactly what is owed,
 *   and a typed amount is a mismatch waiting to happen. Still editable, because
 *   part payments are legitimate.
 * - **The reference code is on the form, not just on the pay screen.** By the
 *   time a resident is here they have left our screen, paid in another app, and
 *   come back — and the checkbox asking whether they used the code is the last
 *   moment anyone can catch a transfer that will land unattributable.
 * - **Rejections are a card, not a line of grey text** (§11.3). A duplicate
 *   screenshot is the single most common failed submission, and "it was
 *   submitted on 2 Jul for July rent" is the difference between a resident who
 *   goes and finds the right one and a support message.
 */

/**
 * How the resident paid, as **one dropdown and one button**.
 *
 * It was six chips of equal weight, and that was the wrong shape for the
 * question. Five of the six — eSewa, Khalti, Fonepay, bank, other — are the same
 * answer as far as this form is concerned: *an app, with a receipt, carrying a
 * transaction ID*. The sixth, cash, is a different kind of payment altogether:
 * no receipt, no ID, a person's name where the ID goes. Giving all six equal
 * weight made the resident choose between six things when there are really two.
 *
 * So: a dropdown for the app, defaulting to **Auto**, and cash on its own.
 *
 * **Auto is the default because we are better at this than the resident is.**
 * The receipt names its own issuer and `evidence-receipt.ts` reads it off a known
 * layout — while the resident is picking from a row of buttons, from memory, in
 * an app that is not the one they paid with. That is exactly how a Khalti receipt
 * gets submitted as eSewa and earns an amber flag nobody needed.
 */
const AUTO_METHOD = "AUTO";

const APP_METHODS = [
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
  { label: "Fonepay", value: "FONEPAY" },
  { label: "Bank transfer", value: "BANK_TRANSFER" },
  { label: "Another app", value: "OTHER" },
] as const;

/** The dropdown's word for a method, for the "we read it" line. */
function methodLabel(value: string): string {
  return APP_METHODS.find((option) => option.value === value)?.label ?? value;
}

/**
 * Where the transaction id actually is, per app (§11.2's `show me where`).
 *
 * The mockup calls for an annotated screenshot of each provider's history with
 * the id circled, and notes it would cut support load more than anything else on
 * the screen. Those images do not exist yet, so this is the same navigation
 * written out — it is the part that goes stale slowest, and it can ship today.
 * When the annotated images land they belong here, above the steps.
 */
const WHERE_TO_LOOK: Record<string, string[]> = {
  BANK_TRANSFER: [
    "Open your bank's app and go to your statement or transaction history.",
    "Tap the transfer you just made.",
    "The ID is the long number labelled Reference No, Transaction ID or RRN.",
  ],
  ESEWA: [
    "Open eSewa and tap the menu, then Transaction History.",
    "Tap the payment you just made.",
    "The ID sits at the top, labelled Transaction Code — it looks like 8823119471.",
  ],
  FONEPAY: [
    "Open the app you scanned the QR with and find its transaction history.",
    "Tap the payment you just made.",
    "Use the number labelled Transaction ID, Trace ID or Reference.",
  ],
  KHALTI: [
    "Open Khalti and tap Transactions at the bottom.",
    "Tap the payment you just made.",
    "The ID is shown as Transaction ID or Purchase Order ID.",
  ],
  OTHER: [
    "Find the payment in whatever app or receipt you paid with.",
    "Use whichever number it calls a transaction, reference or receipt ID.",
  ],
};

type PayInstructions = {
  bedLabel: string | null;
  referenceCode: string | null;
};

/**
 * An instant rejection (§11.3).
 *
 * These never reach the owner's queue, so this screen is the only place the
 * resident learns anything — which is why it says what collided and when, and
 * leaves them on a form they can correct rather than sending them back a step.
 */
type Rejection = {
  detail: string;
  title: string;
};

/**
 * Turns the server's error into the card, or into null when it is an ordinary
 * failure that belongs in the page's message line.
 *
 * Branching on `errorCode`, never on the message text: the codes are the stable
 * contract (§5.1) and the copy is not.
 */
function rejectionFrom(error: unknown): Rejection | null {
  if (!(error instanceof ApiRequestError)) {
    return null;
  }

  const details = (error.details ?? {}) as {
    priorPeriod?: string | null;
    priorSubmittedAt?: string | null;
    transactionCode?: string | null;
  };
  const when = details.priorSubmittedAt
    ? `It was submitted on ${dayMonthYear(details.priorSubmittedAt)}`
    : "It was already submitted";
  const forWhat = details.priorPeriod
    ? ` for ${monthLabel(details.priorPeriod)} rent.`
    : ".";

  if (error.errorCode === "EVIDENCE_ALREADY_USED") {
    return {
      detail: `${when}${forWhat} Please upload the screenshot for THIS payment. If you think this is a mistake, contact your hostel admin.`,
      title: "This screenshot was already used",
    };
  }

  // Gap fix 3. Like the duplicate cases, the *file* is what has to change — so
  // this is a rejection card that clears the upload, not an inline error that
  // leaves the resident staring at a filename they think is fine.
  if (error.errorCode === "EVIDENCE_NOT_READABLE") {
    return {
      detail:
        "It is blank or too small to read. Please upload the screenshot from the app you paid with — the one showing the amount and the transaction ID.",
      title: "That image cannot be read",
    };
  }

  // The form blocks this before submit whenever the read reached the browser, so
  // reaching here means the read only happened server-side — OCR off in the
  // browser's request, a stream that died, a client that skipped it. Same
  // treatment either way: the file is what has to change.
  if (error.errorCode === "EVIDENCE_NOT_A_PAYMENT") {
    return {
      detail:
        "There is no app name, no amount and no transaction ID on it. Please upload the screenshot or receipt from the app you paid with — the one showing the money leaving your account.",
      title: "That is not a payment receipt",
    };
  }

  // The receipt is genuine and readable, and it is the wrong transaction: money
  // arriving rather than leaving, one that failed, or one paid to somebody who is
  // not this hostel. The form blocks all three at upload whenever the read reached
  // the browser, so arriving here means it did not — and the file is still what
  // has to change, so it gets the card rather than the inline line.
  //
  // The server's sentence verbatim: it names the account or the direction it
  // actually read, and a fixed string here could only say something vaguer about
  // the resident's own file.
  if (error.errorCode === "EVIDENCE_WRONG_TRANSACTION") {
    return { detail: error.message, title: "This receipt cannot be used as proof" };
  }

  if (error.errorCode === "TXN_ID_ALREADY_CLAIMED") {
    return {
      detail: `${details.transactionCode ?? "That ID"} was ${
        details.priorPeriod ? `used for ${monthLabel(details.priorPeriod)} rent` : "already recorded"
      }. Each payment has its own ID.`,
      title: "Transaction ID already recorded",
    };
  }

  return null;
}

/**
 * What is happening to the screenshot, while it is happening.
 *
 * The stages come from the server as it reaches them, so this is a report rather
 * than an animation — if the decode is slow, "Opening your screenshot" is what
 * stays on screen, because that is what is actually slow. A second of silent
 * spinner on a screen about money is a screen people back out of.
 *
 * The three outcomes read very differently on purpose: working, worked, or "type
 * it yourself" — and the last is not an error. Autofill sits on top of a form that
 * already worked, so a screenshot nothing could read costs the resident the two
 * fields they would have typed anyway, and telling them about OCR would be
 * telling them about our problem.
 */
function EvidenceStatus({
  notAReceipt,
  notPayment,
  refusal,
  statementGuidance,
  stage,
  unreadable,
  wasFilled,
}: {
  notAReceipt: boolean;
  notPayment: boolean;
  /** The server's own sentence for a file it will refuse. Wins over every other state. */
  refusal: string | null;
  /** A whole statement rather than one receipt. Amber — they may still submit. */
  statementGuidance: string | null;
  stage: EvidenceStage;
  unreadable: boolean;
  wasFilled: boolean;
}) {
  if (stage === "idle") return null;

  if (stage !== "done") {
    return (
      <p
        aria-live="polite"
        className="flex items-center gap-2 rounded-xl bg-role-resident/10 p-3 text-[13px] font-semibold text-role-resident"
        role="status"
      >
        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
        {STAGE_LABELS[stage]}
      </p>
    );
  }

  // Shown ahead of every other verdict, because it is the most specific thing we
  // know about the file. "This does not look like a receipt" is a guess about a
  // file we read badly; "that receipt shows money coming into your account" is a
  // fact about a file we read perfectly well — and it is the one the resident
  // can act on without wondering whether we simply failed to read it.
  if (refusal) {
    return (
      <div
        aria-live="polite"
        className="rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-[13px] text-destructive"
        role="status"
      >
        <p className="flex items-center gap-2 font-bold">
          <XCircle aria-hidden className="size-4 shrink-0" />
          This receipt cannot be used as proof
        </p>
        <p className="mt-1 pl-6 leading-5 text-foreground">{refusal}</p>
      </div>
    );
  }

  // The refusal. Red rather than amber, and it does not say "you can still
  // submit", because they cannot: the submit path refuses this file too, and a
  // screen that invites a click the server will reject is worse than one that
  // says no here.
  if (notPayment) {
    return (
      <div
        aria-live="polite"
        className="rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-[13px] text-destructive"
        role="status"
      >
        <p className="flex items-center gap-2 font-bold">
          <XCircle aria-hidden className="size-4 shrink-0" />
          This is not a payment receipt
        </p>
        <p className="mt-1 pl-6 leading-5 text-foreground">
          There is no app name, no amount and no transaction ID anywhere on it, so
          it cannot be used as proof. Please upload the screenshot or receipt from
          the app you paid with.
        </p>
      </div>
    );
  }

  // A statement is a real payment record and their payment is probably on it, so
  // this never blocks. What it does is ask for the one file that settles in a
  // glance instead of the one a reviewer has to search.
  if (statementGuidance) {
    return (
      <div
        aria-live="polite"
        className="rounded-xl border border-amber-500/50 bg-amber-500/15 p-3 text-[13px] text-amber-900 dark:text-amber-200"
        role="status"
      >
        <p className="flex items-center gap-2 font-bold">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          That is a statement, not a receipt
        </p>
        <p className="mt-1 pl-6 leading-5">{statementGuidance}</p>
      </div>
    );
  }

  // Loudest of the ones that still let them through, and the only one that is a
  // fact about their file rather than about our software: they can fix it now, in
  // ten seconds.
  if (notAReceipt) {
    return (
      <div
        aria-live="polite"
        className="rounded-xl border border-amber-500/50 bg-amber-500/15 p-3 text-[13px] text-amber-900 dark:text-amber-200"
        role="status"
      >
        <p className="flex items-center gap-2 font-bold">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />
          This does not look like a payment receipt
        </p>
        <p className="mt-1 pl-6 leading-5">
          We could not find a payment app, an amount or a transaction ID on it. Check
          you picked the right file — you can still submit, but your hostel
          will have to look at it by hand.
        </p>
      </div>
    );
  }

  if (wasFilled) {
    return (
      <p
        aria-live="polite"
        className="flex items-center gap-2 rounded-xl bg-emerald-500/15 p-3 text-[13px] font-semibold text-emerald-800 dark:text-emerald-300"
        role="status"
      >
        <ScanLine aria-hidden className="size-4 shrink-0" />
        We read your receipt and filled in what we found. Please check it.
      </p>
    );
  }

  // **Always says something.** An earlier version returned null here, so a read
  // that succeeded but filled nothing in — a receipt carrying only the reference
  // code — left the resident watching a spinner vanish into silence. There is no
  // outcome now that produces no sentence.
  return (
    <p
      aria-live="polite"
      className="flex items-center gap-2 rounded-xl bg-muted p-3 text-[13px] text-muted-foreground"
      role="status"
    >
      <ScanLine aria-hidden className="size-4 shrink-0" />
      {unreadable
        ? "We could not read this one — please fill in the amount and transaction ID yourself."
        : "Uploaded. Please fill in the amount and transaction ID."}
    </p>
  );
}

/**
 * The uploaded screenshot, big enough to check against the fields.
 *
 * The uploader's own chip is a filename and a size, which answers "did it upload"
 * and not "is this the right one" — and the resident is now being asked to verify
 * an amount and a ten-digit id that we read *off this image*. They cannot do that
 * against a filename.
 *
 * **Opens the app's own viewer, never a new tab.** `target="_blank"` to the asset
 * endpoint is a plain top-level navigation, and a navigation cannot do what
 * `browserApi` does on a 401 — refresh the access token and replay the request. So
 * once the token had aged out, tapping the receipt produced a raw
 * `UNAUTHENTICATED` JSON page. {@link useMediaViewer} keeps the request a
 * subresource of a page that is already authenticated, stays inside the portal, and
 * zooms — which is what a resident squinting at a transaction id actually needs.
 */
function EvidencePreview({
  assetId,
  mimeType,
}: {
  assetId: string;
  mimeType?: string;
}) {
  const { open: openViewer } = useMediaViewer();
  const src = `/api/v1/files/${assetId}/url`;
  // The endpoint's path carries no extension for the lightbox to infer from, so a
  // PDF receipt would be rendered as an image — the broken-image icon this
  // codebase has already been bitten by once, in the reviewer's own modal.
  const isPdf = (mimeType ?? "").includes("pdf");
  const kind = isPdf ? "pdf" : "image";

  return (
    <button
      className="group relative block w-full overflow-hidden rounded-xl border border-border bg-muted/40"
      onClick={() => openViewer([{ kind, src, title: "Your payment receipt" }])}
      type="button"
    >
      {/* **A PDF is not an `<img>`.** The lightbox already knew that — `kind`
          above has said `pdf` since it was written — but this thumbnail did not,
          so a bank's PDF receipt drew the browser's broken-image icon under the
          words "The payment receipt you uploaded". The resident's reasonable
          reading of that is that their upload failed, and the fix they reach for
          is uploading it again.

          Browsers will not render a PDF inside an `<img>` at any size, and there
          is no thumbnail to be had without rasterising the first page on the
          server — which is real work for a picture nobody studies. What the
          resident needs from this block is confirmation that the *right file*
          arrived, so it says so in words and stays tappable for the viewer that
          can actually display it. */}
      {isPdf ? (
        <object
          aria-label="The payment receipt you uploaded"
          className="pointer-events-none h-64 w-full bg-card"
          data={src}
          type="application/pdf"
        >
          {/* The fallback the reviewer's modal also carries: mobile Safari and
              most in-app browsers have no inline PDF viewer, and an `<object>`
              they cannot render collapses to nothing at all. Naming the file in
              words is what keeps "did my upload work?" answered there. */}
          <span className="flex items-center justify-center gap-2 px-4 py-8 text-sm font-medium text-muted-foreground">
            <FileText aria-hidden className="size-5 shrink-0" />
            PDF receipt uploaded — tap to open it
          </span>
        </object>
      ) : (
        <>
          {/* `object-contain` on purpose: a bank screenshot is tall and narrow,
              and cropping it to fill would cut off the transaction id, which is
              the one thing the resident is here to check. */}
          {/* Plain `<img>`, same as the reviewer's own modal: the source is a
              private endpoint that 302s to a short-lived presigned URL, which
              `next/image` cannot optimise and should not cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="The payment receipt you uploaded"
            className="mx-auto max-h-72 w-auto object-contain"
            src={src}
          />
        </>
      )}
      {/* Outside the branch, because both need it — and the PDF branch needs it
          most, since `pointer-events-none` on the embed means the whole block is
          one target and nothing else says so. */}
      <span className="absolute bottom-2 right-2 rounded-md bg-background/90 px-2 py-1 text-[11px] font-semibold text-muted-foreground opacity-0 transition group-hover:opacity-100">
        {isPdf ? "Tap to open" : "Tap to zoom"}
      </span>
    </button>
  );
}

function ReferenceCheck({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [code]);

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      {/* Informational, not a gate (§11.2). A resident who forgot the code has
          still paid, and blocking the claim would leave real money with no way
          to be reported — it costs the owner a manual match, which is exactly
          what the owner's queue is for. */}
      <label className="flex items-start gap-2.5 text-[12.5px] leading-5 text-foreground">
        <input
          className="mt-0.5 size-4 shrink-0 accent-role-resident"
          name="referenceUsed"
          type="checkbox"
        />
        <span>
          I entered{" "}
          <span className="font-mono font-bold tracking-wide">{code}</span> in the
          remarks
        </span>
      </label>
      <div className="mt-2 flex items-center justify-between gap-2 pl-6">
        <p className="text-[11px] leading-4 text-muted-foreground">
          Did not use it? Submit anyway — your hostel will match it by hand.
        </p>
        <button
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition",
            copied
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border hover:bg-muted",
          )}
          onClick={copy}
          type="button"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export const ResidentClaimForm = memo(function ResidentClaimForm({
  invoiceId,
  month,
  onCancel,
  onSubmitted,
  outstanding,
}: {
  invoiceId: string;
  /** Null on a one-off invoice, which belongs to no month. `monthLabel` prints it. */
  month: string | null;
  onCancel: () => void;
  onSubmitted: (message: string) => void;
  outstanding: number;
}) {
  const [showWhere, setShowWhere] = useState(false);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  const [error, setError] = useState("");
  // The same endpoint the pay screen reads, for the same invoice — so the code
  // on this form cannot disagree with the one they were just shown.
  const instructions = usePortalResource<PayInstructions>(
    residentEndpoints.payInstructions(invoiceId),
    { errorMessage: "" },
  );
  const referenceCode = instructions.data?.referenceCode ?? "";
  // Progress and upload errors surface in the global toaster; this only holds
  // the resulting asset id for the form submit.
  const proofUpload = useUploader({
    accept: "image/jpeg,image/png,image/webp,application/pdf",
    accessLevel: "PRIVATE",
    assetKind: "PAYMENT_PROOF",
    kind: "document",
    label: "Payment proof",
    optimizeImage: true,
  });
  const proofAssetId = proofUpload.files[0]?.assetId ?? "";
  const { clear: clearProof } = proofUpload;

  /**
   * The screenshot fills the form in.
   *
   * Two fields and a payment method are on the receipt the resident just
   * uploaded, and asking them to copy a ten-digit transaction id across from a
   * screenshot they are holding is the single most error-prone thing on this
   * screen — a mistyped id is one of the two instant rejections.
   *
   * **Never overwrites typing.** Each field is filled only while untouched, so a
   * resident who has already corrected something keeps their value; and every
   * filled field says where it came from, because a number that appears by itself
   * in a form about money is a number nobody trusts.
   */
  const evidence = useEvidenceReader();
  /**
   * Only what the resident has actually typed.
   *
   * **Derived, not synchronised.** The obvious build — an effect that copies the
   * recognised fields into state — is a cascading render *and* a race: the
   * screenshot arrives after first paint, so any field the resident had already
   * touched would be overwritten by a value they had just corrected. Here their
   * edit is the override and the screenshot is only the fallback, so "never
   * clobber typing" is a property of the shape rather than a check that has to
   * hold.
   */
  const [edits, setEdits] = useState<{
    amount?: string;
    method?: string;
    transactionCode?: string;
  }>({});
  const { read: readEvidence, reset: resetEvidence } = evidence;
  const found = evidence.fields;

  const amount =
    edits.amount ??
    (found?.amount !== undefined
      ? String(found.amount)
      : outstanding
        ? String(outstanding)
        : "");
  const transactionCode = edits.transactionCode ?? found?.transactionCode ?? "";
  /**
   * What the resident chose, which may be `AUTO` — the default.
   *
   * Kept apart from {@link method} deliberately. The dropdown has to keep showing
   * `Auto` after a receipt resolves it to eSewa, or the setting silently changes
   * under the resident and their *next* upload is locked to the app the *last* one
   * happened to be.
   */
  const selection = edits.method ?? AUTO_METHOD;
  /** What the receipt itself says the app was. Null until one is read. */
  const detected = found?.method ?? null;
  /**
   * The method actually submitted: the resident's choice, or what we read.
   *
   * Empty when `Auto` is set and nothing has been read yet — an honest "we do not
   * know", which the form asks about rather than guessing. The old default was
   * `ESEWA`, so a resident who uploaded a bank receipt and never touched the chips
   * declared a wallet payment they had not made.
   */
  const method = selection === AUTO_METHOD ? (detected ?? "") : selection;
  const isCash = method === "CASH";
  /** Which fields the resident is looking at values they did not type. */
  const filled = {
    amount: edits.amount === undefined && found?.amount !== undefined,
    method: selection === AUTO_METHOD && Boolean(detected),
    transactionCode:
      edits.transactionCode === undefined && Boolean(found?.transactionCode),
  };

  useEffect(() => {
    if (proofAssetId) {
      // The invoice goes with the read so the server can check *this month's*
      // reference code against the receipt, rather than the form guessing from
      // whatever code the extractor happened to find on the image.
      void readEvidence(proofAssetId, invoiceId);
    } else {
      resetEvidence();
    }
  }, [invoiceId, proofAssetId, readEvidence, resetEvidence]);

  /**
   * The two read results that stop the form rather than informing it.
   *
   * Everything else the reader returns is a hint the resident may override —
   * they can correct an amount, retype an id, submit a receipt we thought looked
   * odd. These two are not hints: the submit path refuses both outright, so
   * leaving the button live would let them fill in the whole form to be told no.
   * The wording is the server's, verbatim, so the resident does not read two
   * different explanations of the same refusal.
   *
   * `notPayment` is the *narrow* verdict, not the amber "this does not look like a
   * receipt" warning: a page of text with no app name, no money, no transaction
   * and no date. A real receipt that merely read badly is still submitted, with a
   * warning, because refusing genuine proof is the worse failure by far.
   */
  const blockReason = evidence.systemDocument
    ? "That is a receipt your hostel issued, not a record of your payment. Please upload the screenshot or receipt from the app you paid with — the one showing the money leaving your account."
    : evidence.notPayment
      ? "That file does not look like a payment at all — there is no app name, no amount and no transaction ID on it. Please upload the screenshot or receipt from the app you paid with."
      : // The three the server computed rather than this screen: the receipt shows
        // money arriving instead of leaving, the transaction failed, or it was
        // paid to somebody who is not this hostel. Taken as prose because each
        // names something specific about *their* file — which account, which
        // direction — that a fixed string here could not say.
        (evidence.refusal ?? "");

  useEffect(() => {
    if (blockReason) {
      toast.warning({
        description: blockReason,
        title: "That file cannot be used as proof",
      });
    }
    // Fires on the transition into the blocked state, which is once per read.
  }, [blockReason]);

  /**
   * One place a submit failure is reported, and it reports in two.
   *
   * The banner is the durable copy — it stays on screen while the resident fixes
   * whatever it names, which for the longer refusals ("that is a receipt your
   * hostel issued…") is the whole point. The toast is the one that *arrives*: it
   * renders in the global viewport above the modal, so it is seen even if the
   * banner is scrolled past, and it is the same feedback channel every upload in
   * this product already uses.
   *
   * Both from one call, because the failure mode of two separate calls is a
   * message that appears in one place and not the other — and the half that goes
   * missing is always the one somebody forgot to add to a new branch.
   */
  const fail = useCallback((message: string) => {
    setError(message);
    // `warning`, not `error`: every one of these is a fixable thing about the
    // upload, not a fault. The tone the resident sees should match the fact
    // that they are one file away from being done.
    toast.warning({ description: message, title: "Proof not submitted" });
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      if (!proofAssetId) {
        fail("Please upload a proof image first.");
        return;
      }

      // `Auto` with nothing read off the file. Asked rather than guessed: the
      // method decides whether a transaction ID is required and it is recorded
      // on the claim, so a default here would put a wallet payment the resident
      // never made onto their own record.
      if (!method) {
        fail(
          "We could not tell which app your receipt is from. Please choose it from the list.",
        );
        return;
      }

      setError("");
      setRejection(null);

      try {
        await browserApi(`${residentEndpoints.payments}/${invoiceId}/claims`, {
          body: JSON.stringify({
            // Read from the form rather than from state so a value the browser
            // autofilled, or one changed between render and submit, is the one
            // sent — the inputs are the record here, state only mirrors them.
            amount: Number(field(form, "amount")),
            paymentMethod: method,
            proofImageAssetId: proofAssetId,
            referenceNote: optionalField(form, "referenceNote"),
            transactionCode: optionalField(form, "transactionCode"),
          }),
          method: "POST",
        });
        formElement.reset();
        clearProof();
        onSubmitted(
          "Proof submitted. Your hostel will confirm it and email you a receipt.",
        );
      } catch (cause) {
        const instant = rejectionFrom(cause);

        if (instant) {
          // The screenshot is the thing that has to change, so it goes — the
          // resident is one upload away from a valid claim rather than back at
          // the start of the form.
          clearProof();
          setRejection(instant);
          return;
        }

        fail(cause instanceof Error ? cause.message : "Could not submit proof.");
      }
    },
    [clearProof, fail, invoiceId, method, onSubmitted, proofAssetId],
  );

  const description = `For ${monthLabel(month)}${
    instructions.data?.bedLabel ? ` · ${instructions.data.bedLabel}` : ""
  }`;

  if (rejection) {
    return (
      <ResidentFlowModal
        description={description}
        onClose={onCancel}
        title="Submit payment proof"
      >
        <div className="rounded-xl border-2 border-destructive/50 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 font-heading text-base font-bold text-destructive">
            <XCircle aria-hidden className="size-5 shrink-0" />
            {rejection.title}
          </p>
          <p className="mt-2 text-[13px] leading-5 text-foreground">
            {rejection.detail}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <RoleButton onClick={() => setRejection(null)} tone="resident" type="button">
              Try again
            </RoleButton>
            <Button onClick={onCancel} type="button" variant="outline">
              Cancel
            </Button>
          </div>
        </div>
      </ResidentFlowModal>
    );
  }

  const steps = WHERE_TO_LOOK[method] ?? WHERE_TO_LOOK.OTHER;

  return (
    <ResidentFlowModal
      amount={<ModalAmount label="Outstanding" value={currency(outstanding)} />}
      badge={<OfferProgramBadge />}
      description={description}
      footer={
        // Pinned, so the button is one tap away from wherever they are in the
        // form — the old layout put it under a receipt preview that can be
        // taller than a phone screen. `form` attaches it to the form it submits
        // across the scroll boundary.
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={onCancel} type="button" variant="ghost">
            Cancel
          </Button>
          <RoleButton
            disabled={
              proofUpload.isUploading || !proofAssetId || Boolean(blockReason)
            }
            form="resident-claim-form"
            tone="resident"
            type="submit"
          >
            <Upload className="size-4" />
            {blockReason
              ? "Upload a different file"
              : proofAssetId
                ? "Submit proof"
                : "Upload a receipt first"}
          </RoleButton>
        </div>
      }
      onClose={onCancel}
      title="Submit payment proof"
    >
      <form className="grid gap-4" id="resident-claim-form" onSubmit={submit}>
        {/* **At the top, not next to the button that produced it.**
            The submit button is pinned to the modal footer, so an error rendered
            beside it sat at the bottom of a scrolling body — below the fold on
            every phone and on a normal desktop window. A resident pressed
            Submit, the modal did not close, and the sentence explaining why was
            off-screen: from where they sat, the button had simply stopped
            working. It belongs where the eye returns after a failed submit,
            which is the top of what changed. `role="alert"` so a screen reader
            hears it without the focus having to move. */}
        {error || blockReason ? (
          <p
            className="flex items-start gap-2 rounded-xl bg-amber-500/15 p-3 text-[12.5px] font-semibold text-amber-800 dark:text-amber-300"
            role="alert"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error || blockReason}
          </p>
        ) : null}

        {/* Sharing from the bank app on the phone skips this form entirely. */}
        <ShareReceiptSteps />

        <div className="grid gap-2">
          <label className="text-sm font-semibold text-foreground">
            Screenshot or receipt
          </label>
          {/* Said *before* they upload, not after.
              A resident who does not know the file fills the form in types the
              amount and the ten-digit id first, and then the read arrives and
              deliberately does not overwrite what they typed — so the feature they
              were never told about is the one that never runs. One sentence in
              front of the picker is what makes it a reason to upload first. */}
          {!proofAssetId && !proofUpload.isUploading ? (
            <p className="flex items-start gap-2 rounded-xl border border-role-resident/30 bg-role-resident/5 p-2.5 text-[12.5px] leading-5 text-muted-foreground">
              <ScanLine
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-role-resident"
              />
              <span>
                <span className="font-semibold text-foreground">
                  Upload it first and we will fill the form in for you.
                </span>{" "}
                We read the amount, the transaction ID and which app you paid with
                straight off your receipt — screenshot or PDF. You can change
                anything we get wrong.
              </span>
            </p>
          ) : null}
          <FileUploaderView
            label="Upload receipt"
            size="lg"
            tone="resident"
            uploader={proofUpload}
          />
          {proofAssetId && !proofUpload.isUploading ? (
            <EvidencePreview
              assetId={proofAssetId}
              mimeType={proofUpload.files[0]?.mimeType}
            />
          ) : null}
          <EvidenceStatus
            notAReceipt={evidence.notAReceipt}
            notPayment={evidence.notPayment}
            refusal={evidence.refusal}
            statementGuidance={evidence.statementGuidance}
            stage={proofUpload.isUploading ? "uploading" : evidence.stage}
            unreadable={evidence.unreadable}
            wasFilled={filled.amount || filled.method || filled.transactionCode}
          />
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold text-foreground">
            How did you pay?
          </legend>
          {/* One row, two controls, and the split is the question itself: which
              app (a list, so Auto can lead it) or cash (not an app at all). */}
          <div className="flex items-stretch gap-2">
            <div className="relative flex-1">
              <select
                aria-label="Which app did you pay with?"
                className={cn(
                  "h-11 w-full appearance-none rounded-xl border bg-background px-3.5 pr-9 text-sm font-semibold transition",
                  isCash
                    ? "border-border text-muted-foreground"
                    : "border-role-resident bg-role-resident/5 text-foreground",
                )}
                onChange={(event) => {
                  setEdits((current) => ({ ...current, method: event.target.value }));
                  setShowWhere(false);
                }}
                value={isCash ? AUTO_METHOD : selection}
              >
                <option value={AUTO_METHOD}>Auto — read it from my receipt</option>
                {APP_METHODS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
            {/* Cash stands apart because it *is* apart: no receipt to read, no
                transaction ID to find, and the field beside it asks for a
                person's name instead. Folding it into the list would put a
                payment with no evidence one tap from four that have some. */}
            <button
              aria-pressed={isCash}
              className={cn(
                "flex h-11 items-center gap-1.5 rounded-xl border px-4 text-sm font-semibold transition",
                isCash
                  ? "border-role-resident bg-role-resident/10 text-role-resident"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
              onClick={() => {
                setEdits((current) => ({
                  ...current,
                  method: isCash ? AUTO_METHOD : "CASH",
                }));
                setShowWhere(false);
              }}
              type="button"
            >
              <Banknote aria-hidden className="size-4" />
              Cash
            </button>
          </div>
          {/* One line, and only when it says something. Auto that has resolved
              reports what it read; Auto that has not stays silent rather than
              explaining itself before there is a file to explain. */}
          {!isCash && selection === AUTO_METHOD && detected ? (
            <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-700 dark:text-emerald-400">
              <ScanLine aria-hidden className="size-3.5" />
              Read from your receipt: {methodLabel(detected)}
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Pre-filled with what is owed (§11.2). Still editable — part
              payments are legitimate and common — but the default is the
              number that will not trip the amount check. */}
          <FormInput
            hint={
              filled.amount ? (
                <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                  Read from your screenshot
                  {Number(amount) !== outstanding && outstanding > 0
                    ? ` · this invoice's balance is ${currency(outstanding)}`
                    : ""}
                </span>
              ) : undefined
            }
            label="Amount paid (NPR)"
            min="1"
            name="amount"
            onChange={(event) =>
              setEdits((current) => ({ ...current, amount: event.target.value }))
            }
            required
            step="0.01"
            type="number"
            value={amount}
          />
          <div>
            <FormInput
              hint={
                filled.transactionCode ? (
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                    Read from your screenshot — check it matches
                  </span>
                ) : undefined
              }
              label={
                isCash ? "Who did you give the cash to?" : "Transaction ID"
              }
              name="transactionCode"
              onChange={(event) =>
                setEdits((current) => ({
                  ...current,
                  transactionCode: event.target.value,
                }))
              }
              required={!isCash}
              value={transactionCode}
            />
            {/* Cash has no transaction id to hunt for, so the helper would be
                pointing at a screen that does not exist. */}
            {isCash ? null : (
              <button
                aria-expanded={showWhere}
                className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-semibold text-role-resident underline-offset-2 hover:underline"
                onClick={() => setShowWhere((value) => !value)}
                type="button"
              >
                <HelpCircle aria-hidden className="size-3.5" />
                Show me where to find this
              </button>
            )}
          </div>
        </div>

        {showWhere && !isCash ? (
          <ol className="grid list-decimal gap-1.5 rounded-xl border border-border bg-muted/20 py-3 pl-9 pr-4 text-[12.5px] leading-5 text-muted-foreground">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : null}

        {/* The programme, in whichever of its states this upload has reached.
            Once we have read the receipt we *know* whether the code is on it, so
            asking the resident to tick a box claiming they used it would be
            asking a question we have already answered — and answered better. The
            checkbox stays for the receipt nothing could read, and the plain
            reminder stands in before anything has been uploaded at all. */}
        {/* Nothing at all while the file is one of ours. The code genuinely is
            on it — we printed it there — so every state of this callout would be
            an encouragement to submit the one file that cannot be accepted, and
            the banner above has already said what to do instead. */}
        {evidence.systemDocument ? null : evidence.reference ? (
          <OfferProgramCallout
            code={evidence.reference.code}
            state={evidence.reference.found ? "confirmed" : "missed"}
          />
        ) : referenceCode ? (
          proofAssetId ? (
            <ReferenceCheck code={referenceCode} />
          ) : (
            <OfferProgramCallout code={referenceCode} state="reminder" />
          )
        ) : (
          <OfferProgramCallout state="unavailable" />
        )}

        <div className="grid gap-1.5">
          <label className="text-sm font-semibold text-foreground">
            Anything your hostel should know? (optional)
          </label>
          <Textarea
            className="min-h-20 rounded-xl"
            maxLength={200}
            name="referenceNote"
            placeholder="Paid from my brother's eSewa, etc."
          />
        </div>

      </form>
    </ResidentFlowModal>
  );
});
