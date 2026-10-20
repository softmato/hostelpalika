"use client";

import { AlertTriangle, Home, MapPin, ShieldCheck, Users } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { type NightStatusRow, Message } from "./daily-operations-shared";
import { PageHeader } from "./core-portal-shared";
import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { Chip, MoreMenu, ShareBar, type ChipTone } from "@/app/_components/hostel-admin-page-ui";
import { InitialsAvatar, MetricCard, RoleButton, SearchField } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

/** docs/DESIGN.md status colours: outside is normal life, not a warning; only SOS is red. */
const STATUS_TONE: Record<string, ChipTone> = {
  INSIDE_HOSTEL: "brand",
  MARKED_SAFE: "brand",
  NOT_VERIFIED: "warn",
  OUTSIDE_HOSTEL: "neutral",
  SOS: "bad",
};

function label(status: string) {
  const text = status.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const HostelAdminNightStatusPage = memo(function HostelAdminNightStatusPage() {
  const [actionMessage, setActionMessage] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const statusResource = usePortalResource<{ statuses: NightStatusRow[] }>(
    hostelAdminEndpoints.nightStatus,
    { errorMessage: "Could not load statuses." },
  );

  const rows = useMemo(() => statusResource.data?.statuses ?? [], [statusResource.data]);
  const state = statusResource.state;
  const message = actionMessage || statusResource.message;

  const count = (status: string) => rows.filter((row) => row.status.status === status).length;
  const statuses = useMemo(() => [...new Set(rows.map((row) => row.status.status))], [rows]);
  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();

    return rows.filter(
      (row) =>
        (statusFilter === "ALL" || row.status.status === statusFilter) &&
        (!query ||
          `${row.resident.firstName} ${row.resident.lastName} ${row.resident.phone}`.toLowerCase().includes(query)),
    );
  }, [rows, search, statusFilter]);

  const override = useCallback(
    async (residentId: string, statusValue: string) => {
      const reason = window.prompt("Override reason")?.trim();

      if (!reason) {
        return;
      }

      try {
        await browserApi(`${hostelAdminEndpoints.nightStatus}/${residentId}/override`, {
          body: JSON.stringify({ reason, status: statusValue }),
          method: "PATCH",
        });
        setActionMessage("Status overridden.");
        invalidate(hostelAdminEndpoints.nightStatus);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not override status.",
        );
      }
    },
    [invalidate],
  );

  /**
   * The nightly reality is "everyone is in except three people", so marking the
   * whole roster and then correcting the exceptions is the fast path. Each row
   * still goes through the same audited override endpoint — the bulk action is
   * a convenience in the UI, not a bypass in the API.
   */
  const bulkMark = useCallback(
    async (statusValue: string) => {
      const pending = rows.filter((row) => row.status.status !== statusValue);

      if (pending.length === 0) {
        setActionMessage("Everyone is already marked that way.");

        return;
      }

      const confirmed = await confirm({
        actionLabel: "Mark all",
        description: `This overrides the recorded status for ${pending.length} resident${pending.length === 1 ? "" : "s"} at once. Each override is logged against your account.`,
        title: `Mark ${pending.length} resident${pending.length === 1 ? "" : "s"} as ${statusValue.replaceAll("_", " ").toLowerCase()}?`,
        tone: "destructive",
      });

      if (!confirmed) {
        return;
      }

      const reason = window.prompt("Reason for this bulk update")?.trim();

      if (!reason) {
        return;
      }

      const results = await Promise.allSettled(
        pending.map((row) =>
          browserApi(`${hostelAdminEndpoints.nightStatus}/${row.resident.id}/override`, {
            body: JSON.stringify({ reason, status: statusValue }),
            method: "PATCH",
          }),
        ),
      );
      const failed = results.filter((result) => result.status === "rejected").length;

      setActionMessage(
        failed === 0
          ? `${pending.length} residents updated.`
          : `${pending.length - failed} updated, ${failed} failed.`,
      );
      invalidate(hostelAdminEndpoints.nightStatus);
    },
    [confirm, invalidate, rows],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PageHeader
        action={
          <>
            <MoreMenu label="More bulk actions">
              <DropdownMenuItem onSelect={() => void bulkMark("OUTSIDE_HOSTEL")}>
                <MapPin className="size-4" />
                Mark all outside
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void bulkMark("NOT_VERIFIED")}>
                <AlertTriangle className="size-4" />
                Mark all not verified
              </DropdownMenuItem>
            </MoreMenu>
            <RoleButton className="h-9 rounded-xl" onClick={() => void bulkMark("INSIDE_HOSTEL")} tone="admin" type="button">
              <Home className="size-4" />
              Mark all inside
            </RoleButton>
          </>
        }
        description="Where every resident is tonight. Status only, never a location."
        icon={ShieldCheck}
        title="Night Status"
      />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Home} label="Inside" value={count("INSIDE_HOSTEL") + count("MARKED_SAFE")} />
        <MetricCard icon={MapPin} label="Outside" tone="slate" value={count("OUTSIDE_HOSTEL")} />
        <MetricCard
          icon={AlertTriangle}
          label="Not verified"
          tone={count("NOT_VERIFIED") > 0 ? "amber" : "slate"}
          value={count("NOT_VERIFIED")}
        />
        <MetricCard icon={Users} label="Residents" value={rows.length} />
      </div>

      {rows.length > 0 ? (
        <div className="rounded-2xl border border-border/70 bg-card px-4 py-3">
          <ShareBar
            label="inside or safe"
            total={rows.length}
            value={count("INSIDE_HOSTEL") + count("MARKED_SAFE")}
          />
        </div>
      ) : null}

      <Panel>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchField onChange={setSearch} placeholder="Search name or phone" size="lg" value={search} />
          <FilterButton active={statusFilter === "ALL" ? 0 : 1} onClear={() => setStatusFilter("ALL")}>
            <FilterChoice
              label="Status"
              onChange={setStatusFilter}
              options={[
                { label: "All", value: "ALL" },
                ...statuses.map((status) => ({ label: label(status), value: status })),
              ]}
              value={statusFilter}
            />
          </FilterButton>
        </div>

        {state === "loading" ? <LoadingRows /> : null}
        {state === "error" ? (
          <EmptyState label="Night status could not be loaded." />
        ) : null}
        {state === "ready" && shown.length === 0 ? (
          <EmptyState label={rows.length === 0 ? "No residents." : "Nothing matches."} />
        ) : null}
        <div className="divide-y divide-border/60">
          {shown.map((row) => {
            const name = `${row.resident.firstName} ${row.resident.lastName}`;

            return (
              <div className="flex flex-wrap items-center gap-3 py-2.5" key={row.resident.id}>
                <InitialsAvatar name={name} size="sm" tone="admin" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-foreground">{name}</p>
                  <p className="text-[12px] text-muted-foreground">{row.resident.phone}</p>
                </div>
                <Chip tone={STATUS_TONE[row.status.status] ?? "neutral"}>{label(row.status.status)}</Chip>
                <div className="flex gap-1">
                  {["INSIDE_HOSTEL", "OUTSIDE_HOSTEL", "MARKED_SAFE"].map((item) => (
                    <Button
                      key={item}
                      onClick={() => void override(row.resident.id, item)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {item === "INSIDE_HOSTEL" ? "Inside" : item === "OUTSIDE_HOSTEL" ? "Outside" : "Safe"}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
});
