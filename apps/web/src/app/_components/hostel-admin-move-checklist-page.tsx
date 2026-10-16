"use client";

import { ClipboardCheck, LogIn, LogOut } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import {
  combineResources,
  useInvalidateResources,
  usePortalResource,
} from "@/lib/portal-query";
import {
  field,
  type Resident,
  Message,
  optionalNumber,
  PageHeader,
} from "./daily-operations-shared";
import { Input, Panel, Select, TextArea } from "@/app/_components/shared-ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type MoveEvent = {
  date: string;
  residentId: string;
  residentName: string;
  residentStatus: string;
  roomType: string;
  type: "MOVE_IN" | "MOVE_OUT";
};

export const HostelAdminMoveChecklistPage = memo(function HostelAdminMoveChecklistPage() {
  // Empty until the admin picks someone; the first resident stands in until
  // then, so no effect is needed to seed the selection once the list arrives.
  const [pickedResidentId, setPickedResidentId] = useState("");
  // The checklists are paperwork, not a daily view — they live in a drawer
  // opened from a history row, so the page reads as the move record it is.
  const [drawerResidentId, setDrawerResidentId] = useState("");
  const [drawerTab, setDrawerTab] = useState<"MOVE_IN" | "MOVE_OUT">("MOVE_IN");
  const [actionMessage, setActionMessage] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [yearFilter, setYearFilter] = useState("ALL");
  const invalidate = useInvalidateResources();

  const errorMessage = "Could not load residents.";
  const residentsResource = usePortalResource<{ residents: Resident[] }>(
    hostelAdminEndpoints.residents,
    { errorMessage },
  );
  const eventsResource = usePortalResource<{ events: MoveEvent[] }>(
    hostelAdminEndpoints.moveEvents,
    { errorMessage },
  );

  const residents = useMemo(
    () => residentsResource.data?.residents ?? [],
    [residentsResource.data],
  );
  const events = useMemo(() => eventsResource.data?.events ?? [], [eventsResource.data]);
  const selectedResidentId = pickedResidentId || residents[0]?.id || "";
  const movedOutIds = useMemo(
    () =>
      new Set(
        events.filter((item) => item.type === "MOVE_OUT").map((item) => item.residentId),
      ),
    [events],
  );
  const drawerResident = useMemo(
    () => residents.find((resident) => resident.id === drawerResidentId),
    [drawerResidentId, residents],
  );
  const message =
    actionMessage || combineResources(residentsResource, eventsResource).message;

  const years = useMemo(
    () =>
      Array.from(new Set(events.map((event) => event.date.slice(0, 4)))).sort((a, b) =>
        b.localeCompare(a),
      ),
    [events],
  );

  const filteredEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => {
      if (typeFilter !== "ALL" && event.type !== typeFilter) return false;
      if (yearFilter !== "ALL" && !event.date.startsWith(yearFilter)) return false;
      if (query && !event.residentName.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [events, search, typeFilter, yearFilter]);

  const openChecklist = useCallback((residentId: string, tab: "MOVE_IN" | "MOVE_OUT") => {
    setActionMessage("");
    setDrawerResidentId(residentId);
    setDrawerTab(tab);
  }, []);

  const moveIn = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);

      try {
        await browserApi(
          `${hostelAdminEndpoints.residents}/${drawerResidentId}/move-in`,
          {
            body: JSON.stringify({
              bedCondition: field(form, "bedCondition"),
              depositAmount: optionalNumber(form, "depositAmount"),
              documentsCollected: field(form, "documentsCollected")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              itemsProvided: field(form, "itemsProvided")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              roomCondition: field(form, "roomCondition"),
              roomPhotoAssetIds: field(form, "roomPhotoAssetIds")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              rulesAccepted: form.get("rulesAccepted") === "on",
            }),
            method: "POST",
          },
        );
        setActionMessage("Move-in checklist saved.");
        setDrawerResidentId("");
        invalidate(hostelAdminEndpoints.moveEvents);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not save move-in.",
        );
      }
    },
    [drawerResidentId, invalidate],
  );

  const moveOut = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);

      try {
        await browserApi(
          `${hostelAdminEndpoints.residents}/${drawerResidentId}/move-out`,
          {
            body: JSON.stringify({
              damageNotes: field(form, "damageNotes"),
              depositRefundAmount: optionalNumber(form, "depositRefundAmount"),
              depositRefundDecision: field(form, "depositRefundDecision"),
              finalReceiptAssetId: field(form, "finalReceiptAssetId"),
              itemReturnNotes: field(form, "itemReturnNotes"),
            }),
            method: "POST",
          },
        );
        setActionMessage("Move-out checklist saved.");
        setDrawerResidentId("");
        invalidate(hostelAdminEndpoints.residents, hostelAdminEndpoints.moveEvents);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not save move-out.",
        );
      }
    },
    [drawerResidentId, invalidate],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PageHeader
        description="Record move-in condition and move-out settlement."
        icon={ClipboardCheck}
        title="Move-In/Move-Out"
      />
      <Message value={message} />

      <Panel title="Move History (automatic)">
        <p className="mb-3 text-sm text-muted-foreground">
          Move-ins are logged automatically when a resident is registered; move-outs are
          logged once their settlement checklist is completed. Open a row to record the
          condition checklist or settle a deposit.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Input
            label="Search resident"
            name="moveSearch"
            onChange={(event) => setSearch(event.target.value)}
            value={search}
          />
          <Select
            label="Type"
            name="moveType"
            onChange={(event) => setTypeFilter(event.target.value)}
            value={typeFilter}
          >
            <option value="ALL">All</option>
            <option value="MOVE_IN">Move-in</option>
            <option value="MOVE_OUT">Move-out</option>
          </Select>
          <Select
            label="Year"
            name="moveYear"
            onChange={(event) => setYearFilter(event.target.value)}
            value={yearFilter}
          >
            <option value="ALL">All years</option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        </div>
        {filteredEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No move events found.</p>
        ) : (
          <div className="divide-y divide-border overflow-x-auto rounded-lg border border-border">
            {filteredEvents.map((event) => (
              <div
                className="flex items-center gap-3 px-4 py-3 text-sm"
                key={`${event.residentId}-${event.type}`}
              >
                {event.type === "MOVE_IN" ? (
                  <LogIn className="size-4 shrink-0 text-emerald-600" />
                ) : (
                  <LogOut className="size-4 shrink-0 text-rose-600" />
                )}
                <span className="min-w-0 flex-1 truncate font-semibold text-foreground">
                  {event.residentName}
                </span>
                <span className="text-muted-foreground">
                  {event.type === "MOVE_IN" ? "Moved in" : "Moved out"}
                </span>
                <span className="whitespace-nowrap font-medium text-foreground">
                  {new Date(event.date).toLocaleDateString()}
                </span>
                <button
                  className="whitespace-nowrap rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-foreground hover:border-role-admin hover:text-role-admin"
                  onClick={() =>
                    // A move-in row for someone still living here is really an
                    // invitation to settle their move-out.
                    openChecklist(
                      event.residentId,
                      event.type === "MOVE_IN" && !movedOutIds.has(event.residentId)
                        ? "MOVE_OUT"
                        : event.type,
                    )
                  }
                  type="button"
                >
                  {event.type === "MOVE_IN" && !movedOutIds.has(event.residentId)
                    ? "Settle move-out"
                    : "Checklist"}
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Open a checklist directly">
        <p className="mb-3 text-sm text-muted-foreground">
          Filters hide rows — use this to reach any resident regardless of the list above.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-[16rem] flex-1 gap-2 text-sm font-semibold text-foreground">
            Resident
            <select
              className="h-11 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none focus:border-role-admin"
              onChange={(event) => setPickedResidentId(event.target.value)}
              value={selectedResidentId}
            >
              {residents.map((resident) => (
                <option key={resident.id} value={resident.id}>
                  {resident.firstName} {resident.lastName}
                </option>
              ))}
            </select>
          </label>
          <button
            className="h-11 rounded-md bg-role-admin px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!selectedResidentId}
            onClick={() => openChecklist(selectedResidentId, "MOVE_IN")}
            type="button"
          >
            Open checklist
          </button>
        </div>
      </Panel>

      <Sheet
        onOpenChange={(open) => {
          if (!open) setDrawerResidentId("");
        }}
        open={Boolean(drawerResidentId)}
      >
        <SheetContent className="w-full sm:max-w-xl" side="right">
          <SheetHeader className="border-b border-border">
            <SheetTitle>
              {drawerResident
                ? `${drawerResident.firstName} ${drawerResident.lastName}`
                : "Resident"}
            </SheetTitle>
            <SheetDescription>
              Move-in records the handover condition; move-out settles the deposit against
              it.
            </SheetDescription>
          </SheetHeader>

          <div className="flex gap-2 px-4">
            {(["MOVE_IN", "MOVE_OUT"] as const).map((tab) => (
              <button
                className={
                  drawerTab === tab
                    ? "rounded-md bg-role-admin px-3 py-1.5 text-xs font-semibold text-white"
                    : "rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
                }
                key={tab}
                onClick={() => setDrawerTab(tab)}
                type="button"
              >
                {tab === "MOVE_IN" ? "Move-In" : "Move-Out"}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {drawerTab === "MOVE_IN" ? (
              <BusyForm className="grid gap-3" onSubmit={moveIn}>
                <Input label="Documents collected" name="documentsCollected" />
                <Input label="Room photo asset ids" name="roomPhotoAssetIds" />
                <Input label="Deposit amount" name="depositAmount" type="number" />
                <TextArea label="Room condition" name="roomCondition" />
                <TextArea label="Bed condition" name="bedCondition" />
                <Input label="Items provided" name="itemsProvided" />
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input name="rulesAccepted" type="checkbox" />
                  Rules accepted
                </label>
                <SubmitButton className="h-11 rounded-md bg-role-admin text-sm font-semibold text-white">
                  Save Move-In
                </SubmitButton>
              </BusyForm>
            ) : (
              <BusyForm className="grid gap-3" onSubmit={moveOut}>
                <TextArea label="Damage notes" name="damageNotes" />
                <TextArea label="Item return notes" name="itemReturnNotes" />
                <Input label="Refund amount" name="depositRefundAmount" type="number" />
                <Select label="Refund decision" name="depositRefundDecision">
                  {["PENDING", "APPROVED", "PARTIAL", "FORFEITED"].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
                <Input label="Final receipt asset id" name="finalReceiptAssetId" />
                <SubmitButton className="h-11 rounded-md bg-role-admin text-sm font-semibold text-white">
                  Save Move-Out
                </SubmitButton>
              </BusyForm>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
});
