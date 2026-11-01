"use client";

import { Check, Loader2, X } from "@/components/icons";
import { useState, type ReactNode } from "react";

import { Select as FormSelect } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { CLAIM_REJECTION_REASONS } from "@/modules/finance/claim.validation";

type Reason = keyof typeof CLAIM_REJECTION_REASONS;

/**
 * Approve / Reject for one claim, shared by the queue row and the review modal.
 *
 * Reject is three steps in the same spot — pick a reason, then "Reject this?" —
 * so one stray tap on a select can no longer reject a payment. The button that
 * is working shows a spinner and both stay disabled until the request settles.
 */
export function ProofActions({
  extra,
  onApprove,
  onReject,
  processing,
  size = "md",
}: {
  extra?: ReactNode;
  onApprove: () => void;
  onReject: (reason: string) => void;
  /** Which action is in flight for this claim, if any. */
  processing: "approve" | "reject" | null;
  size?: "md" | "sm";
}) {
  const [step, setStep] = useState<"idle" | "reason" | "confirm">("idle");
  const [reason, setReason] = useState<Reason | "">("");
  const height = size === "sm" ? "h-9" : "h-10";
  const icon = size === "sm" ? "size-3.5" : "size-4";
  const busy = processing !== null;

  function back() {
    setStep("idle");
    setReason("");
  }

  if (step === "reason") {
    return (
      <div className="space-y-2">
        <FormSelect
          label="Why is this being rejected?"
          name="rejectionReason"
          onChange={(event) => {
            const code = event.target.value as Reason | "";

            setReason(code);

            if (code) {
              setStep("confirm");
            }
          }}
          value={reason}
        >
          <option value="">Choose a reason…</option>
          {Object.entries(CLAIM_REJECTION_REASONS).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </FormSelect>
        <Button className={`${height} w-full rounded-lg`} onClick={back} type="button" variant="outline">
          Cancel
        </Button>
      </div>
    );
  }

  if (step === "confirm" && reason) {
    return (
      <div className="space-y-2">
        <p className="text-[13px] font-semibold text-foreground">Reject this?</p>
        <p className="text-[12px] text-muted-foreground">
          The resident is told: {CLAIM_REJECTION_REASONS[reason]}
        </p>
        <div className="flex gap-2">
          <Button
            className={`${height} flex-1 rounded-lg`}
            disabled={busy}
            onClick={() => onReject(CLAIM_REJECTION_REASONS[reason])}
            type="button"
            variant="destructive"
          >
            {processing === "reject" ? <Loader2 className={`${icon} animate-spin`} /> : <Check className={icon} />}
            {processing === "reject" ? "Rejecting…" : "Yes, reject"}
          </Button>
          <Button
            className={`${height} flex-1 rounded-lg`}
            disabled={busy}
            onClick={() => setStep("reason")}
            type="button"
            variant="outline"
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        className={`${height} flex-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-600/90`}
        disabled={busy}
        onClick={onApprove}
        type="button"
      >
        {processing === "approve" ? <Loader2 className={`${icon} animate-spin`} /> : <Check className={icon} />}
        {processing === "approve" ? "Approving…" : "Approve"}
      </Button>
      <Button
        className={`${height} flex-1 rounded-lg`}
        disabled={busy}
        onClick={() => setStep("reason")}
        type="button"
        variant="destructive"
      >
        <X className={icon} />
        Reject
      </Button>
      {extra}
    </div>
  );
}
