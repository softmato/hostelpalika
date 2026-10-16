"use client";

import { Loader2 } from "@/components/icons";
import { memo, useMemo, useState } from "react";

import { currency } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { dayMonthYearBoth, monthLabel } from "@/lib/format-month";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";

import type { Resident } from "./hostel-admin-shared";
import { SearchField } from "./portal-dashboard-ui";

/**
 * `Assign to: [ search residents ]` — the orphan bucket's manual path (§11.5).
 *
 * The suggestion list handles the credits the matching ladder can score. This
 * handles the rest, and there are always some: a transfer sent from a parent's
 * account with no remarks matches nobody, and telling the owner to "assign it
 * from the Payments screen once you know whose it is" left the one row they
 * genuinely have to think about as the only row with no way to act on it.
 *
 * Two steps, deliberately: pick the resident, then pick the month. The owner
 * knows *who* from the name on the transfer and has to look at what is open to
 * know *which invoice* — collapsing that into one list of every open invoice in
 * the hostel is a list nobody can scan.
 */

type Ledger = {
  months: {
    dueAmount: number;
    dueDate: string | null;
    invoiceId: string | null;
    paidAmount: number;
    period: string;
    status: string;
  }[];
};

export const OrphanAssignPicker = memo(function OrphanAssignPicker({
  busy,
  onAssign,
}: {
  busy: boolean;
  onAssign: (invoiceId: string, residentName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [residentId, setResidentId] = useState("");

  const residentsResource = usePortalResource<{ residents: Resident[] }>(
    hostelAdminEndpoints.residents,
    { errorMessage: "Could not load residents." },
  );
  // Only once a resident is chosen. Fetching every resident's ledger up front to
  // populate a picker most orphans never need is a request per resident.
  const ledgerResource = usePortalResource<Ledger>(
    residentId ? hostelAdminEndpoints.residentLedger(residentId) : null,
    { errorMessage: "Could not load this resident's months." },
  );

  const residents = useMemo(
    () => residentsResource.data?.residents ?? [],
    [residentsResource.data],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      return [];
    }

    return residents
      .filter((resident) =>
        `${resident.firstName} ${resident.lastName}`.toLowerCase().includes(needle),
      )
      .slice(0, 6);
  }, [query, residents]);

  const chosen = residents.find((resident) => resident.id === residentId) ?? null;
  const chosenName = chosen ? `${chosen.firstName} ${chosen.lastName}` : "";
  // Settled months cannot take another payment, and offering them is how a
  // credit lands on a paid invoice and turns into an overpayment nobody meant.
  const open = (ledgerResource.data?.months ?? []).filter(
    (month) => month.invoiceId && month.status !== "PAID",
  );

  if (chosen) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">
            Which month is this for {chosenName}?
          </p>
          <Button
            className="h-8 rounded-lg"
            onClick={() => setResidentId("")}
            size="sm"
            type="button"
            variant="ghost"
          >
            Change resident
          </Button>
        </div>

        {ledgerResource.state === "loading" ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            Loading their months…
          </p>
        ) : null}

        {ledgerResource.state === "ready" && open.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {chosenName} has no unpaid month for this to settle. If they overpaid,
            record it against the month it belongs to from the Payments screen.
          </p>
        ) : null}

        {open.length > 0 ? (
          <ul className="mt-2 grid gap-2">
            {open.map((month) => (
              <li key={month.invoiceId}>
                <button
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm transition hover:border-role-admin/50 hover:bg-muted/40 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => onAssign(month.invoiceId!, chosenName)}
                  type="button"
                >
                  <span className="font-semibold text-foreground">
                    {monthLabel(month.period)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {currency(Math.max(0, month.dueAmount - month.paidAmount))} still owed
                    {month.dueDate ? ` · due ${dayMonthYearBoth(month.dueDate)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2">
      <SearchField
        className="max-w-none"
        onChange={setQuery}
        placeholder="Assign to — search residents…"
        value={query}
      />
      {query.trim() && matches.length === 0 && residentsResource.state === "ready" ? (
        <p className="mt-2 text-sm text-muted-foreground">No resident by that name.</p>
      ) : null}
      {matches.length > 0 ? (
        <ul className="mt-2 grid gap-1.5">
          {matches.map((resident) => (
            <li key={resident.id}>
              <button
                className="w-full rounded-lg border border-border px-3 py-2 text-left text-sm transition hover:border-role-admin/50 hover:bg-muted/40"
                onClick={() => setResidentId(resident.id)}
                type="button"
              >
                <span className="font-semibold text-foreground">
                  {resident.firstName} {resident.lastName}
                </span>
                {resident.phone ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {resident.phone}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
