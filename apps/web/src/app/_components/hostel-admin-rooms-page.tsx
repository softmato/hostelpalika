"use client";

import { BedDouble, DoorOpen, Sparkles } from "@/components/icons";
import { memo } from "react";

import { FloorsPanel } from "@/app/_components/hostel-admin-floors-panel";
import { MetricCard } from "@/app/_components/portal-dashboard-ui";
import { RoomTypesPanel } from "@/app/_components/room-types-panel";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";

import { PageHeader, type RoomConfiguration } from "./core-portal-shared";

/**
 * Rooms & Beds: what a bed is (room types — beds per room, rent, photos), then
 * where the rooms are (floors, each built in place). Both halves are their own
 * panels so Hostel KYC can show the same ones.
 */
export const HostelAdminRoomsPageContent = memo(function HostelAdminRoomsPageContent() {
  const profile = usePortalResource<{ hostel: { roomConfigurations: RoomConfiguration[] } }>(
    hostelAdminEndpoints.profile,
  );
  const totals = (profile.data?.hostel.roomConfigurations ?? []).reduce(
    (summary, config) => ({
      beds: summary.beds + config.rooms * config.bedsPerRoom,
      rooms: summary.rooms + config.rooms,
      vacant: summary.vacant + config.vacantBeds,
    }),
    { beds: 0, rooms: 0, vacant: 0 },
  );
  const taken = totals.beds > 0 ? Math.round(((totals.beds - totals.vacant) / totals.beds) * 100) : 0;

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PageHeader description="Room types, the rooms on each floor, and what is free right now." icon={BedDouble} title="Rooms & Beds" />

      {totals.beds > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={DoorOpen} label="Rooms" value={totals.rooms} />
          <MetricCard icon={BedDouble} label="Beds" note={`${taken}% taken`} value={totals.beds} />
          <MetricCard icon={Sparkles} label="Beds free" value={totals.vacant} />
        </div>
      ) : null}

      <div data-kyc="rates">
        <RoomTypesPanel />
      </div>

      <div data-kyc="rooms">
        <FloorsPanel />
      </div>
    </div>
  );
});
