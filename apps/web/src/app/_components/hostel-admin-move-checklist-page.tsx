"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import { ClipboardCheck, Home, LogIn, LogOut } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Chip, RowMark } from "@/app/_components/hostel-admin-page-ui";
import { MetricCard, RoleButton, SearchField } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
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
} from "./daily-operations-shared";
// This one takes header actions; the daily-operations header is shared with other portals.
import { PageHeader } from "./core-portal-shared";
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
  const [pickerOpen, setPickerOpen] = useState(false);
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

  const movedInCount = events.filter((event) => event.type === "MOVE_IN").length;
  const livingHere = events.filter(
    (event) => event.type === "MOVE_IN" && !movedOutIds.has(event.residentId),
  ).length;

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
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        action={
          <RoleButton className="h-9 rounded-xl" onClick={() => setPickerOpen(true)} tone="admin" type="button">
            <ClipboardCheck className="size-4" />
            Open checklist
          </RoleButton>
        }
        description="Move-in condition and move-out settlement, per resident."
        icon={ClipboardCheck}
        title="Move-In/Move-Out"
      />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={LogIn} label="Moved in" value={movedInCount} />
        <MetricCard icon={LogOut} label="Moved out" tone="slate" value={movedOutIds.size} />
        <MetricCard icon={Home} label="Still living here" value={livingHere} />
      </div>

      {/* Move-ins are logged when a resident is registered; move-outs once their
          settlement checklist is saved. */}
      <Panel title="Move history">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchField onChange={setSearch} placeholder="Search resident" size="lg" value={search} />
          <FilterButton
            active={(typeFilter === "ALL" ? 0 : 1) + (yearFilter === "ALL" ? 0 : 1)}
            onClear={() => {
              setTypeFilter("ALL");
              setYearFilter("ALL");
            }}
          >
            <FilterChoice
              label="Type"
              onChange={setTypeFilter}
              options={[
                { label: "All", value: "ALL" },
                { label: "Move-in", value: "MOVE_IN" },
                { label: "Move-out", value: "MOVE_OUT" },
              ]}
              value={typeFilter}
            />
            <FilterChoice
              label="Year"
              onChange={setYearFilter}
              options={[{ label: "All years", value: "ALL" }, ...years.map((year) => ({ label: year, value: year }))]}
              value={yearFilter}
            />
          </FilterButton>
        </div>
        {filteredEvents.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-muted-foreground">No move events found.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {filteredEvents.map((event) => (
              <div
                className="flex items-center gap-3 py-2.5 text-[13.5px]"
                key={`${event.residentId}-${event.type}`}
              >
                <RowMark glyph={event.type === "MOVE_IN" ? "log-in" : "log-out"} tone={event.type === "MOVE_IN" ? "brand" : "neutral"} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-foreground">{event.residentName}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {event.type === "MOVE_IN" ? "Moved in" : "Moved out"}
                    {event.roomType ? ` · ${event.roomType}` : ""}
                  </p>
                </div>
                <Chip glyph="calendar">{formatHostelDate(event.date)}</Chip>
                <Button
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
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {event.type === "MOVE_IN" && !movedOutIds.has(event.residentId)
                    ? "Settle move-out"
                    : "Checklist"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Filters hide rows; this reaches any resident regardless of the list. */}
      <Dialog onOpenChange={setPickerOpen} open={pickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open a checklist</DialogTitle>
            <DialogDescription>Any resident, whatever the list shows.</DialogDescription>
          </DialogHeader>
          <Select
            label="Resident"
            name="checklistResident"
            onChange={(event) => setPickedResidentId(event.target.value)}
            value={selectedResidentId}
          >
            {residents.map((resident) => (
              <option key={resident.id} value={resident.id}>
                {resident.firstName} {resident.lastName}
              </option>
            ))}
          </Select>
          <DialogFooter>
            <RoleButton
              disabled={!selectedResidentId}
              onClick={() => {
                setPickerOpen(false);
                openChecklist(selectedResidentId, "MOVE_IN");
              }}
              tone="admin"
              type="button"
            >
              Open checklist
            </RoleButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <SheetDescription>Move-in records the handover; move-out settles the deposit.</SheetDescription>
          </SheetHeader>

          <div className="mx-4 flex gap-1 rounded-xl bg-muted p-1">
            {(["MOVE_IN", "MOVE_OUT"] as const).map((tab) => (
              <button
                className={cn(
                  "flex-1 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition",
                  drawerTab === tab ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
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
                <SubmitButton className="h-10 rounded-xl bg-brand-teal text-white hover:bg-brand-teal/90">
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
                <SubmitButton className="h-10 rounded-xl bg-brand-teal text-white hover:bg-brand-teal/90">
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
