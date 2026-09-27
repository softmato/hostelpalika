"use client";

import { useState } from "react";

import { FIELD, useAction } from "@/app/_components/booking-admin-ui";
import { RoleButton } from "@/app/_components/portal-dashboard-ui";
import { Panel } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import type { ShortStaySettingsView } from "@/modules/bookings/short-stay-settings.service";

/**
 * Short stays on **Bookings → Settings**: on or off, the fewest nights, and a
 * daily rate per room type that may not go below its floor (monthly ÷ 30 plus
 * the platform's markup). The guest pays us upfront; the hostel's share is
 * paid out at check-in.
 */

const URL = "/api/v1/hostel-admin/bookings/short-stays";

const rupees = (value: number) => `Rs ${value.toLocaleString("en-IN")}`;

function ShortStaysForm({ settings }: { settings: ShortStaySettingsView }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [minNights, setMinNights] = useState(String(settings.minNights));
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(settings.rooms.map((room) => [room.roomType, room.dailyRate ? String(room.dailyRate) : ""])),
  );
  const { busy, run } = useAction([URL]);

  const payload = {
    enabled,
    minNights: Number(minNights),
    rates: settings.rooms
      .filter((room) => Number(rates[room.roomType]) > 0)
      .map((room) => ({ dailyRate: Number(rates[room.roomType]), roomType: room.roomType })),
  };

  return (
    <div className="space-y-4 text-sm">
      <label className="flex items-center gap-3 font-semibold text-foreground">
        <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
        Take short stays
      </label>

      <label className="block text-muted-foreground">
        Fewest nights
        <input
          className={`${FIELD} mt-1 w-28`}
          max={settings.limits.maxNights}
          min={1}
          onChange={(event) => setMinNights(event.target.value)}
          type="number"
          value={minNights}
        />
      </label>

      <div className="space-y-2">
        {settings.rooms.map((room) => (
          <label className="grid items-center gap-2 sm:grid-cols-[1fr_10rem]" key={room.roomType}>
            <span>
              <span className="font-semibold text-foreground">{room.roomType}</span>
              <span className="block text-xs text-muted-foreground">
                {room.floor && room.monthlyRent
                  ? `${rupees(room.monthlyRent)} a month · at least ${rupees(room.floor)} a night`
                  : "Set a monthly rent on the rate card first"}
              </span>
            </span>
            <input
              className={FIELD}
              disabled={!room.floor}
              inputMode="numeric"
              min={room.floor ?? 1}
              onChange={(event) => setRates((current) => ({ ...current, [room.roomType]: event.target.value }))}
              placeholder="Rs a night"
              type="number"
              value={rates[room.roomType] ?? ""}
            />
          </label>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Up to {settings.limits.maxNights} nights. The guest pays the nights and the booking fee to us upfront. You get{" "}
        {settings.limits.hostelSharePercent}% of the nights once they check in by card scan. They are never billed monthly
        rent.
      </p>

      <RoleButton
        disabled={busy === "short-stays"}
        onClick={() => void run("short-stays", URL, payload, "Short stays saved.", "PUT")}
        tone="admin"
      >
        Save
      </RoleButton>
    </div>
  );
}

export function HostelShortStaysPanel() {
  const resource = usePortalResource<ShortStaySettingsView>(URL);

  if (resource.state !== "ready" || !resource.data) {
    return null;
  }

  return (
    <Panel title="Short stays">
      <ShortStaysForm key={JSON.stringify(resource.data)} settings={resource.data} />
    </Panel>
  );
}
