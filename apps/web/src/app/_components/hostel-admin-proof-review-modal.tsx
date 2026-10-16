"use client";

import { AlertTriangle, Check, ExternalLink, FileText, X } from "@/components/icons";
import { memo, useState } from "react";

import { currency, Select as FormSelect } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { dayMonthYearTime, monthLabel } from "@/lib/format-month";
import { CLAIM_REJECTION_REASONS } from "@/modules/finance/claim.validation";

import type { PaymentProof } from "./hostel-admin-shared";
import { InitialsAvatar, SoftBadge } from "./portal-dashboard-ui";

/**
 * The full review of one claim: evidence left, everything else right (§11.4).
 *
 * The queue card stays as it is — the design note that matters most on that
 * screen is "screenshot inline, not behind a click", and burying the thumbnail
 * would cost the owner a tap per resident per month. What the card cannot do is
 * show a bank screenshot at a size where the transaction ID is legible, and
 * squinting at a 48px thumbnail is how a claim gets approved on the strength of
 * "it looks like a receipt".
 *
 * So: the card triages, this decides. The split is deliberate — the image needs
 * the larger half and a fixed pane so it does not scroll away from the numbers
 * being checked against it, while the details column scrolls independently.
 */

/**
 * A flag in the reviewer's language rather than the ledger's.
 *
 * `EVIDENCE NOT MACHINE CHECKED` as a badge tells an owner that something is
 * wrong with our software; what it actually means is that the file is one nothing
 * could inspect, so the judgement is theirs. Unknown codes fall back to the
 * de-underscored constant, so a flag added later still renders.
 */
const FLAG_LABELS: Record<string, string> = {
  EVIDENCE_AMOUNT_NOT_ON_IMAGE: "Claimed amount not found on the screenshot",
  EVIDENCE_ID_NOT_ON_IMAGE: "Transaction ID not found on the screenshot",
  EVIDENCE_NOT_MACHINE_CHECKED: "Nothing could read this file — look at it yourself",
  EVIDENCE_NOT_A_PAYMENT_RECORD: "Does not look like a payment receipt",
  EVIDENCE_NO_TEXT_FOUND: "Nothing on this image matches the claim",
  EVIDENCE_REFERENCE_ON_IMAGE: "This invoice's reference code is on the screenshot",
  EVIDENCE_TEXT_MATCHES_CLAIM: "Screenshot matches the amount and ID",
  SIMILAR_EVIDENCE: "Looks like an earlier screenshot",
};

/** Flags that are good news, so they must not be rendered as warnings. */
const POSITIVE_FLAGS = new Set([
  "EVIDENCE_REFERENCE_ON_IMAGE",
  "EVIDENCE_TEXT_MATCHES_CLAIM",
]);

function ClaimFacts({ proof }: { proof: PaymentProof }) {
  return (
    <dl className="space-y-2">
      {[
        ["Amount claimed", currency(proof.amount)],
        ["Method", proof.method?.replaceAll("_", " ") || "—"],
        ["Period", monthLabel(proof.period)],
        ["Transaction code", proof.transactionCode || "Not provided"],
        ["Submitted", dayMonthYearTime(proof.occurredAt)],
        ["Note from resident", proof.referenceNote || "—"],
      ].map(([label, value]) => (
        <div className="flex items-start justify-between gap-3 text-[12px]" key={label}>
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd
            className={
              label === "Transaction code"
                ? "min-w-0 text-right font-mono font-semibold text-foreground"
                : "min-w-0 text-right font-semibold text-foreground"
            }
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const ProofReviewModal = memo(function ProofReviewModal({
  busy,
  onApprove,
  onClose,
  onReject,
  proof,
  residentName,
}: {
  busy?: boolean;
  onApprove: () => void;
  onClose: () => void;
  onReject: (reason: string) => void;
  proof: PaymentProof | null;
  residentName: string;
}) {
  const [rejecting, setRejecting] = useState(false);

  if (!proof) {
    return null;
  }

  const evidenceUrl = proof.evidenceAssetId
    ? `/api/v1/files/${proof.evidenceAssetId}/url`
    : "";
  const isPdf = (proof.evidenceMimeType ?? "").includes("pdf");
  const decided = proof.status !== "PENDING";

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setRejecting(false);
          onClose();
        }
      }}
      open
    >
      <DialogContent
        className="max-h-[90vh] w-[min(1040px,calc(100%-2rem))] gap-0 overflow-hidden p-0 sm:max-w-[1040px]"
        showCloseButton={false}
      >
        <div className="grid max-h-[90vh] grid-cols-1 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ── Left: the evidence ─────────────────────────────────────── */}
          <div className="relative flex min-h-[260px] items-center justify-center overflow-auto bg-muted/40 p-4 md:max-h-[90vh] md:border-r md:border-border">
            {proof.evidenceAssetId ? (
              <>
                {/* A PDF in an `<img>` renders as a broken-image icon, so a
                    reviewer approving a bank's PDF receipt was deciding on no
                    evidence at all while the row still read "Screenshot
                    attached". Rendered in an object element instead, which uses
                    the browser's own PDF viewer. */}
                {isPdf ? (
                  <object
                    aria-label={`Payment proof from ${residentName}`}
                    className="h-[70vh] max-h-full w-full rounded-lg bg-card shadow-sm"
                    data={evidenceUrl}
                    type="application/pdf"
                  >
                    {/* Shown when the browser has no inline PDF viewer — mobile
                        Safari and most in-app browsers. */}
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                      <FileText className="size-8 text-muted-foreground" />
                      <p className="text-sm font-semibold text-foreground">
                        PDF receipt
                      </p>
                      <a
                        className="rounded-lg border border-border bg-card px-3 py-1.5 text-[11.5px] font-semibold transition hover:bg-muted"
                        href={evidenceUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Open the PDF
                      </a>
                    </div>
                  </object>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={`Payment proof from ${residentName}`}
                    className="max-h-full w-auto max-w-full rounded-lg object-contain shadow-sm"
                    src={evidenceUrl}
                  />
                )}
                <a
                  className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-[11px] font-semibold text-foreground shadow-sm backdrop-blur transition hover:bg-card"
                  href={evidenceUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLink className="size-3" />
                  {isPdf ? "Open in a new tab" : "Open full size"}
                </a>
              </>
            ) : (
              // Never silently blank. "No evidence" is itself a finding — it is
              // one of the five checks, and the owner is about to move money on
              // the strength of a sentence.
              <div className="flex flex-col items-center gap-2 text-center text-muted-foreground">
                <FileText className="size-8" />
                <p className="text-sm font-semibold">No file attached</p>
                <p className="max-w-[24ch] text-[11.5px]">
                  This claim was submitted without a screenshot or receipt.
                </p>
              </div>
            )}
          </div>

          {/* ── Right: the claim, the checks, the decision ─────────────── */}
          <div className="flex min-h-0 flex-col md:max-h-[90vh]">
            <div className="flex items-start gap-3 border-b border-border/60 p-4">
              <InitialsAvatar name={residentName} tone="admin" />
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-[15px]">
                  {residentName}
                </DialogTitle>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  Claims {currency(proof.amount)}
                  {proof.method ? ` · ${proof.method.replaceAll("_", " ")}` : ""}
                </p>
              </div>
              <Button
                aria-label="Close review"
                className="size-8 shrink-0"
                onClick={onClose}
                size="icon"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <ClaimFacts proof={proof} />

              {proof.checks?.length ? (
                <section className="rounded-lg border border-border/70 bg-muted/15 p-3">
                  <h3 className="mb-2 text-[12px] font-bold text-foreground">
                    System checks
                  </h3>
                  <ul className="space-y-1.5">
                    {proof.checks.map((check) => (
                      <li
                        className={`flex items-start gap-2 text-[11.5px] leading-4 ${
                          check.ok
                            ? "text-muted-foreground"
                            : "font-semibold text-amber-700 dark:text-amber-400"
                        }`}
                        key={check.key}
                      >
                        {check.ok ? (
                          <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                        ) : (
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        )}
                        {check.detail}
                      </li>
                    ))}
                  </ul>
                  {/* Said out loud, because an owner who reads amber as "the
                      system says no" stops approving legitimate part payments. */}
                  <p className="mt-2 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                    An amber check never blocks approval — it only keeps this row
                    out of <span className="font-semibold">Approve all</span>.
                  </p>
                </section>
              ) : null}

              {proof.reviewFlags?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {proof.reviewFlags.map((flag) => (
                    <SoftBadge
                      key={flag}
                      tone={POSITIVE_FLAGS.has(flag) ? "green" : "amber"}
                    >
                      {FLAG_LABELS[flag] ?? flag.replaceAll("_", " ")}
                    </SoftBadge>
                  ))}
                </div>
              ) : null}
            </div>

            {decided ? (
              <div className="shrink-0 border-t border-border/60 p-4 text-[12px] text-muted-foreground">
                This claim was already {proof.status.toLowerCase()}.
              </div>
            ) : (
              <div className="shrink-0 space-y-2 border-t border-border/60 p-4">
                {rejecting ? (
                  <>
                    <FormSelect
                      label="Why is this being rejected?"
                      name="rejectionReason"
                      onChange={(event) => {
                        const code = event.target
                          .value as keyof typeof CLAIM_REJECTION_REASONS;

                        if (code) {
                          onReject(CLAIM_REJECTION_REASONS[code]);
                        }
                      }}
                    >
                      <option value="">Choose a reason…</option>
                      {Object.entries(CLAIM_REJECTION_REASONS).map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </FormSelect>
                    <Button
                      className="w-full rounded-lg"
                      onClick={() => setRejecting(false)}
                      type="button"
                      variant="outline"
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      className="h-10 flex-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-600/90"
                      disabled={busy}
                      onClick={onApprove}
                      type="button"
                    >
                      <Check className="size-4" />
                      Approve
                    </Button>
                    <Button
                      className="h-10 flex-1 rounded-lg"
                      disabled={busy}
                      onClick={() => setRejecting(true)}
                      type="button"
                      variant="destructive"
                    >
                      <X className="size-4" />
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
