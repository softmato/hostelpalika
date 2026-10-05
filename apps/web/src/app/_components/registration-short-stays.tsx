"use client";

import { useEffect, useState } from "react";

import { browserApi } from "@/lib/browser-api";

/**
 * "Do you offer short stays?" — the same block on the team form and the public
 * form. Each room type's daily rate shows its floor (monthly ÷ 30 plus the
 * platform's markup) as it is typed; the server checks it again on submit.
 */

export type ShortStayDraft = {
  enabled: boolean;
  minNights: string;
  /** Keyed by the room type's name as typed on the form. */
  rates: Record<string, string>;
};

export const EMPTY_SHORT_STAYS: ShortStayDraft = { enabled: false, minNights: "1", rates: {} };

type Room = { monthlyRent: string; roomType: string };

function floorOf(monthlyRent: string, markup: number | null) {
  const monthly = Number(monthlyRent);

  return markup === null || !(monthly > 0) ? null : Math.max(1, Math.ceil((monthly * (100 + markup)) / 3000));
}

/** The body the server takes, or undefined when the hostel takes no short stays. */
export function shortStaysPayload(draft: ShortStayDraft, rooms: Room[]) {
  if (!draft.enabled) return undefined;

  return {
    enabled: true,
    minNights: Number(draft.minNights) || 1,
    rates: rooms
      .filter((room) => room.roomType.trim() && Number(draft.rates[room.roomType]) > 0)
      .map((room) => ({ dailyRate: Number(draft.rates[room.roomType]), roomType: room.roomType.trim() })),
  };
}

export function RegistrationShortStays({
  onChange,
  rooms,
  value,
}: {
  onChange: (next: ShortStayDraft) => void;
  rooms: Room[];
  value: ShortStayDraft;
}) {
  const [terms, setTerms] = useState<{ hostelSharePercent: number; maxNights: number; minMarkupPercent: number } | null>(null);

  useEffect(() => {
    void browserApi<{ policy: { shortStay: { hostelSharePercent: number; maxNights: number; minMarkupPercent: number } } }>(
      "/api/v1/bookings/policy",
    )
      .then((data) => setTerms(data.policy.shortStay))
      .catch(() => undefined);
  }, []);

  const named = rooms.filter((room) => room.roomType.trim());

  return (
    <div className="space-y-3 rounded-lg border border-border p-4 text-sm">
      <label className="flex items-start gap-3 font-semibold text-foreground">
        <input
          checked={value.enabled}
          className="mt-1"
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          type="checkbox"
        />
        <span>
          Offers short stays
          <span className="block text-xs font-normal text-muted-foreground">
            Guests book a few nights{terms ? ` (up to ${terms.maxNights})` : ""} and pay us upfront. The hostel gets{" "}
            {terms ? `${terms.hostelSharePercent}%` : "its share"} of the nights once the guest checks in.
          </span>
        </span>
      </label>

      {value.enabled ? (
        <>
          <label className="block text-xs font-semibold text-foreground">
            Fewest nights
            <input
              className="input-field mt-2 block w-28"
              inputMode="numeric"
              onChange={(event) => onChange({ ...value, minNights: event.target.value })}
              value={value.minNights}
            />
          </label>
          {named.map((room) => {
            const floor = floorOf(room.monthlyRent, terms?.minMarkupPercent ?? null);
            const rate = value.rates[room.roomType] ?? "";
            const low = floor !== null && rate !== "" && Number(rate) < floor;

            return (
              <label className="grid items-center gap-2 sm:grid-cols-[1fr_10rem]" key={room.roomType}>
                <span>
                  <span className="font-semibold text-foreground">{room.roomType}</span>
                  <span className={`block text-xs ${low ? "text-destructive" : "text-muted-foreground"}`}>
                    {floor ? `At least Rs ${floor.toLocaleString("en-IN")} a night` : "Enter its monthly rent first"}
                  </span>
                </span>
                <input
                  className="input-field w-full min-w-0"
                  inputMode="numeric"
                  onChange={(event) =>
                    onChange({ ...value, rates: { ...value.rates, [room.roomType]: event.target.value } })
                  }
                  placeholder="Rs a night"
                  value={rate}
                />
              </label>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
