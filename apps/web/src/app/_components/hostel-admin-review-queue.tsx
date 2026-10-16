"use client";

import { AlertTriangle, Check, FileText, Maximize2, X } from "@/components/icons";
import { memo, useState } from "react";

import { currency, Select as FormSelect } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format-month";
import { CLAIM_REJECTION_REASONS } from "@/modules/finance/claim.validation";
import { cn } from "@/lib/utils";

import type { PaymentProof } from "./hostel-admin-shared";
import { EmptyInline, InitialsAvatar, SectionCard } from "./portal-dashboard-ui";

/**
 * The owner's review queue (target §11.4, plan item 3.5).
 *
 * Promoted out of the 340px rail it used to live in. The design note this screen
 * turns on is **"screenshot inline, not behind a click — image, amount and txn
 * ID must be in one glance"**, and a 56px thumbnail in a sidebar met the letter
 * of that and none of its point: the owner still had to open every row to see
 * anything. At full width the shot is large enough to triage from, which is the
 * difference between a screen that survives 40 residents × 12 months and one
 * that does not.
 *
 * **Green ticks and amber warnings do the triage.** The owner scans the amber
 * column, not the rows. Everything green is a row they never have to read, which
 * is what makes `Approve all` safe to offer and worth pressing.
 *
 * **Reject is inline and opens a reason picker**, never a free-text prompt
 * (§6.3): the resident gets a sentence they can act on, the reasons stay
 * countable, and nobody types an accusation into a permanent record. The full
 * modal is still one click away for the claims that need the image legible.
 */

function EvidenceThumb({
  name,
  proof,
}: {
  name: string;
  proof: PaymentProof;
}) {
  const isPdf = (proof.evidenceMimeType ?? "").includes("pdf");

  if (!proof.evidenceAssetId) {
    return (
      <span className="flex h-32 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg bg-muted text-center ring-1 ring-border">
        <InitialsAvatar name={name} size="sm" tone="admin" />
        <span className="px-1 text-[9px] font-semibold uppercase leading-3 text-muted-foreground">
          No file
        </span>
      </span>
    );
  }

  // R2 returns the document itself for a PDF, which an `<img>` renders as a
  // broken icon — a labelled tile says what it is and sends the reviewer to the
  // viewer that can open it.
  if (isPdf) {
    return (
      <span className="flex h-32 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg bg-muted ring-1 ring-border">
        <FileText className="size-6 text-muted-foreground" />
        <span className="text-[9px] font-bold uppercase text-muted-foreground">PDF</span>
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- private asset served through our own authorizing route
    <img
      alt={`Payment proof from ${name}`}
      className="h-32 w-24 shrink-0 rounded-lg object-cover ring-1 ring-border"
      src={`/api/v1/files/${proof.evidenceAssetId}/url?variant=THUMBNAIL`}
    />
  );
}

function ClaimRow({
  bedLabel,
  busy,
  name,
  onApprove,
  onOpen,
  onReject,
  proof,
}: {
  bedLabel: string | null;
  busy: boolean;
  name: string;
  onApprove: () => void;
  onOpen: () => void;
  onReject: (reason: string) => void;
  proof: PaymentProof;
}) {
  const [rejecting, setRejecting] = useState(false);

  return (
    <li className="rounded-xl border border-border/70 bg-muted/10 p-3 transition hover:border-role-admin/40 sm:p-4">
      <div className="flex gap-4">
        {/* The image opens the full review. One tap buys a legible screenshot,
            not a first look at one. */}
        <button
          aria-label={`Open the full review for ${name}`}
          className="group relative shrink-0"
          onClick={onOpen}
          type="button"
        >
          <EvidenceThumb name={name} proof={proof} />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 rounded-b-lg bg-foreground/70 py-1 text-[9.5px] font-semibold text-background opacity-0 transition group-hover:opacity-100">
            <Maximize2 className="size-2.5" />
            Enlarge
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-bold text-foreground">
              {name}
              {/* Bed type replaces room number throughout (§11.4) — it is the
                  attribute the hostel actually thinks in. */}
              {bedLabel ? (
                <span className="font-medium text-muted-foreground"> · {bedLabel}</span>
              ) : null}
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              {timeAgo(proof.occurredAt)}
            </p>
          </div>
          <p className="mt-0.5 text-[12.5px] font-semibold text-foreground">
            Claims {currency(proof.amount)}
            {proof.method ? ` · ${proof.method.replaceAll("_", " ")}` : ""}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground">
            {proof.transactionCode ? `Txn ${proof.transactionCode}` : "No txn code"}
          </p>

          {/* An amber check never blocks approval — the owner can see the
              screenshot and we cannot. It only keeps the row out of
              `Approve all`. */}
          {proof.checks?.length ? (
            <ul className="mt-2 grid gap-0.5 sm:grid-cols-2">
              {proof.checks.map((check) => (
                <li
                  className={cn(
                    "flex items-start gap-1.5 text-[11px] leading-4",
                    check.ok
                      ? "text-muted-foreground"
                      : "font-semibold text-amber-700 dark:text-amber-400",
                  )}
                  key={check.key}
                >
                  {check.ok ? (
                    <Check className="mt-0.5 size-3 shrink-0 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  )}
                  {check.detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {rejecting ? (
        <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <FormSelect
            label="Why is this being rejected?"
            name="rejectionReason"
            onChange={(event) => {
              const code = event.target.value as keyof typeof CLAIM_REJECTION_REASONS;

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
            className="h-9 rounded-lg"
            onClick={() => setRejecting(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
          <Button
            className="h-9 rounded-lg bg-emerald-600 text-white hover:bg-emerald-600/90"
            disabled={busy}
            onClick={onApprove}
            type="button"
          >
            <Check className="size-3.5" />
            Approve
          </Button>
          <Button
            className="h-9 rounded-lg"
            disabled={busy}
            onClick={() => setRejecting(true)}
            type="button"
            variant="destructive"
          >
            <X className="size-3.5" />
            Reject
          </Button>
          <Button
            className="h-9 rounded-lg"
            onClick={onOpen}
            type="button"
            variant="outline"
          >
            Open &amp; review
          </Button>
        </div>
      )}
    </li>
  );
}

export const HostelAdminReviewQueue = memo(function HostelAdminReviewQueue({
  approvingAll,
  bedLabelByResidentId,
  busy,
  claims,
  nameFor,
  onApprove,
  onApproveAll,
  onOpen,
  onReject,
}: {
  approvingAll: boolean;
  bedLabelByResidentId: Map<string, string | null>;
  busy: boolean;
  claims: PaymentProof[];
  nameFor: (proof: PaymentProof) => string;
  onApprove: (eventId: string) => void;
  onApproveAll: () => void;
  onOpen: (eventId: string) => void;
  onReject: (eventId: string, reason: string) => void;
}) {
  const anyGreen = claims.some((proof) => proof.allGreen);

  return (
    <SectionCard
      actions={
        anyGreen ? (
          <Button
            className="h-9 rounded-lg bg-emerald-600 text-white hover:bg-emerald-600/90"
            disabled={approvingAll}
            onClick={onApproveAll}
            size="sm"
            type="button"
          >
            <Check className="size-3.5" />
            {approvingAll ? "Approving…" : "Approve all"}
          </Button>
        ) : null
      }
      description="Every claim waiting on you. Green rows have passed every check."
      title={`To review (${claims.length})`}
    >
      {claims.length === 0 ? (
        <EmptyInline label="No proofs awaiting review." />
      ) : (
        <ul className="grid gap-3">
          {claims.map((proof) => (
            <ClaimRow
              bedLabel={bedLabelByResidentId.get(proof.residentId) ?? null}
              busy={busy}
              key={proof.eventId}
              name={nameFor(proof)}
              onApprove={() => onApprove(proof.eventId)}
              onOpen={() => onOpen(proof.eventId)}
              onReject={(reason) => onReject(proof.eventId, reason)}
              proof={proof}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
});
