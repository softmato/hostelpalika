"use client";

import { useState } from "react";

import { currency } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * Rent, admission fee, form fee and deposit for one resident at registration
 * (docs/FIELD_FIXES_2026_10.md §2). Shows the rate card; Edit lets the desk
 * change any of them under one reason. Only the changed figures are posted —
 * as hidden `charge.<key>` fields plus `feeReason` — so the form stays FormData
 * and an untouched charge keeps following the rate card.
 */

export type ChargeKey = "admissionFee" | "depositAmount" | "formFee" | "monthlyFee";

type Standard = { admissionFee: number; depositAmount: number; formFee: number; monthlyRent: number | null };

const ROWS: [ChargeKey, string][] = [
  ["monthlyFee", "Monthly rent"],
  ["admissionFee", "Admission fee"],
  ["formFee", "Form fee"],
  ["depositAmount", "Security deposit"],
];

export const CHARGE_KEYS = ROWS.map(([key]) => key);

const REASONS = ["Short stay", "Relative"];

function rateOf(standard: Standard, key: ChargeKey) {
  return key === "monthlyFee" ? standard.monthlyRent : standard[key];
}

/** Mount with `key={roomType}` so a new room type starts from its own rate card. */
export function ResidentCharges({ roomType }: { roomType: string }) {
  const quote = usePortalResource<{ quote: { standard?: Standard } }>(
    roomType ? `/api/v1/hostel-admin/residents/intake-quote?roomType=${encodeURIComponent(roomType)}` : null,
  );
  const [edits, setEdits] = useState<Partial<Record<ChargeKey, string>> | null>(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [other, setOther] = useState("");
  const standard = quote.data?.quote.standard;
  const span = "sm:col-span-2 lg:col-span-3";

  if (!roomType || !standard) {
    return (
      <p className={cn(span, "text-xs text-muted-foreground")}>
        {!roomType
          ? "Pick a room type to see the charges."
          : quote.state === "error"
            ? "Charges could not be loaded."
            : "Loading charges…"}
      </p>
    );
  }

  const changed = new Set(
    ROWS.map(([key]) => key).filter((key) => {
      const value = edits?.[key];
      return value !== undefined && value !== "" && Number(value) !== rateOf(standard, key);
    }),
  );

  return (
    <div className={cn(span, "overflow-hidden rounded-xl border border-border")}>
      {ROWS.map(([key, label]) => {
        const rate = rateOf(standard, key);
        return (
          <div className="flex items-center gap-3 border-b border-border px-3 py-2" key={key}>
            <span className="mr-auto text-sm">{label}</span>
            {changed.has(key) ? (
              <span className="text-xs text-muted-foreground line-through">{rate === null ? "—" : currency(rate)}</span>
            ) : null}
            {edits ? (
              <input
                aria-label={label}
                className={cn(
                  "h-9 w-32 rounded-md border bg-background px-2 text-right text-sm tabular-nums outline-none focus:border-primary",
                  changed.has(key) ? "border-primary" : "border-border",
                )}
                inputMode="numeric"
                onChange={(event) => setEdits({ ...edits, [key]: event.target.value.replace(/\D/g, "") })}
                placeholder={rate === null ? "Rs" : String(rate)}
                value={edits[key] ?? ""}
              />
            ) : (
              <span className="text-sm font-semibold tabular-nums">
                {rate === null ? "Set by the rate card" : currency(rate)}
              </span>
            )}
            {changed.has(key) ? <input name={`charge.${key}`} type="hidden" value={edits?.[key]} /> : null}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2 bg-muted/20 px-3 py-2.5">
        {edits && changed.size > 0 ? (
          <>
            <span className="text-xs font-semibold text-muted-foreground">Why</span>
            {[...REASONS, "Other"].map((value) => (
              <button
                className={cn(
                  "h-8 rounded-full border px-3 text-xs font-semibold",
                  reason === value ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground",
                )}
                key={value}
                onClick={() => setReason(value)}
                type="button"
              >
                {value}
              </button>
            ))}
            {reason === "Other" ? (
              <input
                className="h-8 min-w-40 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary"
                minLength={3}
                onChange={(event) => setOther(event.target.value)}
                placeholder="Why these charges"
                required
                value={other}
              />
            ) : null}
            <input name="feeReason" type="hidden" value={reason === "Other" ? other.trim() : reason} />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {edits ? "Type a different amount for this resident." : "From the rate card."}
          </span>
        )}
        <button
          className="ml-auto text-xs font-semibold text-primary"
          onClick={() => setEdits(edits ? null : {})}
          type="button"
        >
          {edits ? "Use the rate card" : "Edit charges"}
        </button>
      </div>
    </div>
  );
}
