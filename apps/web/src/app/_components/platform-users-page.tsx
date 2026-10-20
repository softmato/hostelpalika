"use client";
import { downloadCsv } from "@/lib/downloads/downloader";

import { Download, ShieldCheck, UserPlus, UserRound, Users, X } from "@/components/icons";
import Link from "next/link";
import { memo, useMemo, useState } from "react";

import { EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import {
  DataTable,
  DetailField,
  DetailSection,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PanelTabs,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SoftBadge,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { DemoDataBadge, Message } from "./core-portal-shared";

type Contact = {
  name: string;
  phone: string;
  relation: string;
};

type DirectoryPerson = {
  activationStatus: string;
  bedNumber: string;
  createdAt: string | null;
  demoDataLabel: string;
  email: string;
  emergencyContact: Contact | null;
  feeMonth: string;
  feeStatus: string;
  guardian: Contact | null;
  hostelCount: number;
  hostelId: string;
  hostelName: string;
  id: string;
  isDemoData: boolean;
  lastLoginAt: string | null;
  moveInDate: string | null;
  name: string;
  nightStatus: string;
  phone: string;
  residentId: string | null;
  residentStatus: string;
  role: string;
  roomNumber: string;
  stayType: string;
  status: string;
};

type DirectoryResponse = {
  people: DirectoryPerson[];
  roleCounts: Record<string, number>;
  total: number;
};

const DETAIL_TABS = [
  { key: "details", label: "Details" },
  { key: "payments", label: "Payments" },
  { key: "activity", label: "Activity" },
  { key: "documents", label: "Documents" },
];

const PAGE_SIZE = 10;

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

function formatDateTime(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function readableRole(role: string) {
  return role
    .split("_")
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

function roomLabel(person: DirectoryPerson) {
  if (!person.roomNumber && !person.bedNumber) return "—";
  if (person.roomNumber && person.bedNumber) {
    return `${person.roomNumber} / Bed ${person.bedNumber}`;
  }
  return person.roomNumber || `Bed ${person.bedNumber}`;
}

/** "Inside Hostel" style pill copy from the raw night-status enum. */
function nightStatusLabel(value: string) {
  switch (value) {
    case "INSIDE_HOSTEL":
      return "Inside Hostel";
    case "OUTSIDE_HOSTEL":
      return "Outside";
    case "MARKED_SAFE":
      return "Marked Safe";
    case "SOS_TRIGGERED":
      return "SOS";
    case "NOT_VERIFIED":
      return "Not Verified";
    default:
      return "";
  }
}

function activationLabel(value: string) {
  switch (value) {
    case "USED":
      return "Activated";
    case "PENDING":
      return "Code Sent";
    case "EXPIRED":
      return "Expired";
    case "CANCELLED":
      return "Cancelled";
    case "NOT_GENERATED":
      return "Not Generated";
    default:
      return "";
  }
}

export const PlatformUsersPageContent = memo(function PlatformUsersPageContent() {
  const directory = usePortalResource<DirectoryResponse>(platformEndpoints.users, {
    errorMessage: "Could not load users.",
  });
  const { data, message, state } = directory;
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [hostelFilter, setHostelFilter] = useState("");
  const [activationFilter, setActivationFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState("details");

  const people = useMemo(() => data?.people ?? [], [data]);

  const hostels = useMemo(
    () => Array.from(new Set(people.map((person) => person.hostelName).filter(Boolean))),
    [people],
  );

  const roles = useMemo(
    () => Array.from(new Set(people.map((person) => person.role))),
    [people],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();

    return people.filter((person) => {
      if (roleFilter && person.role !== roleFilter) return false;
      if (statusFilter && person.status !== statusFilter) return false;
      if (hostelFilter && person.hostelName !== hostelFilter) return false;
      if (activationFilter && person.activationStatus !== activationFilter) return false;
      if (!term) return true;

      return `${person.name} ${person.email} ${person.phone} ${person.roomNumber} ${person.hostelName}`
        .toLowerCase()
        .includes(term);
    });
  }, [activationFilter, hostelFilter, people, query, roleFilter, statusFilter]);

  const paged = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const selected = people.find((person) => person.id === selectedId) ?? null;

  function resetPage<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(1);
    };
  }

  // The three biggest roles get a tile each; a tile filters the list to its role.
  const topRoles = Object.entries(data?.roleCounts ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  const activeFilters = [roleFilter, statusFilter, hostelFilter, activationFilter].filter(Boolean).length;
  const exportUsers = () =>
    downloadCsv(
      "users",
      [
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "phone", label: "Phone" },
        { key: "role", label: "Role" },
        { key: "status", label: "Status" },
        { key: "hostelName", label: "Hostel" },
        { key: "activationStatus", label: "Activation" },
        { key: "createdAt", label: "Joined" },
        { key: "lastLoginAt", label: "Last login" },
      ],
      filtered,
    );

  return (
    <div className="mx-auto max-w-[1448px]">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_312px]">
        {/* ── Main column ─────────────────────────────────────────── */}
        <div className="min-w-0 space-y-3">
          <PortalPageHeader
            actions={
              <>
                <RoleButton disabled={filtered.length === 0} onClick={exportUsers} tone="team" variant="outline">
                  <Download className="size-3.5" />
                  Export
                </RoleButton>
                {/* Residents join through their hostel's activation codes; the
                    platform adds people by invitation, on the Team screen. */}
                <RoleButton asChild tone="team">
                  <Link href="/platform/team">
                    <UserPlus className="size-3.5" />
                    Add user
                  </Link>
                </RoleButton>
              </>
            }
            description="Every account on the platform."
            title="Users"
          />
          <Message value={message} />

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              active={!roleFilter}
              icon={Users}
              label="Users"
              onClick={() => resetPage(setRoleFilter)("")}
              value={(data?.total ?? 0).toLocaleString()}
            />
            {topRoles.map(([role, count]) => (
              <MetricCard
                active={roleFilter === role}
                icon={UserRound}
                key={role}
                label={readableRole(role)}
                onClick={() => resetPage(setRoleFilter)(roleFilter === role ? "" : role)}
                value={count.toLocaleString()}
              />
            ))}
          </div>

          <section className="rounded-2xl border border-border/70 bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <SearchField onChange={resetPage(setQuery)} placeholder="Search name, phone, email, room" value={query} />
              <FilterButton
                active={activeFilters}
                onClear={() => {
                  setRoleFilter("");
                  setStatusFilter("");
                  setHostelFilter("");
                  setActivationFilter("");
                  setPage(1);
                }}
              >
                <FilterChoice
                  label="Role"
                  onChange={resetPage(setRoleFilter)}
                  options={[{ label: "All", value: "" }, ...roles.map((role) => ({ label: readableRole(role), value: role }))]}
                  value={roleFilter}
                />
                <FilterChoice
                  label="Status"
                  onChange={resetPage(setStatusFilter)}
                  options={[
                    { label: "All", value: "" },
                    { label: "Active", value: "ACTIVE" },
                    { label: "Invited", value: "INVITED" },
                    { label: "Suspended", value: "SUSPENDED" },
                    { label: "Archived", value: "ARCHIVED" },
                    { label: "Pending", value: "PENDING" },
                  ]}
                  value={statusFilter}
                />
                <FilterChoice
                  label="Activation"
                  onChange={resetPage(setActivationFilter)}
                  options={[
                    { label: "All", value: "" },
                    { label: "Activated", value: "USED" },
                    { label: "Code sent", value: "PENDING" },
                    { label: "Not generated", value: "NOT_GENERATED" },
                    { label: "Expired", value: "EXPIRED" },
                  ]}
                  value={activationFilter}
                />
                {/* Hostels can run long, so this one is a list, not chips. */}
                <label className="block">
                  <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Hostel</span>
                  <select
                    className="h-9 w-full rounded-xl border border-border bg-background px-3 text-[13px]"
                    onChange={(event) => resetPage(setHostelFilter)(event.target.value)}
                    value={hostelFilter}
                  >
                    <option value="">All hostels</option>
                    {hostels.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </FilterButton>
              <span className="ml-auto text-[12.5px] font-medium text-muted-foreground">{filtered.length} shown</span>
            </div>

            {state === "loading" ? <LoadingRows /> : null}
            {state === "error" ? <EmptyState label="Users could not be loaded." /> : null}
            {state === "ready" && filtered.length === 0 ? (
              <EmptyState label="No users match these filters." />
            ) : null}

            {state === "ready" && filtered.length > 0 ? (
              <>
                <DataTable className="min-w-[720px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <Th>User</Th>
                      <Th>Room / Bed</Th>
                      <Th>Fee</Th>
                      <Th>Night</Th>
                      <Th>Activation</Th>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paged.map((person) => {
                      const isSelected = person.id === selectedId;

                      return (
                        <TableRow
                          className={cn(
                            "cursor-pointer",
                            isSelected &&
                              "bg-role-team-soft/60 [&>td:first-child]:relative [&>td:first-child]:before:absolute [&>td:first-child]:before:inset-y-0 [&>td:first-child]:before:left-0 [&>td:first-child]:before:w-[3px] [&>td:first-child]:before:bg-role-team",
                          )}
                          key={person.id}
                          onClick={() => {
                            setSelectedId(person.id);
                            setDetailTab("details");
                          }}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <InitialsAvatar
                                name={person.name}
                                size="sm"
                                tone="team"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="truncate text-[13.5px] font-semibold text-foreground">
                                    {person.name}
                                  </span>
                                  {person.isDemoData ? (
                                    <DemoDataBadge label={person.demoDataLabel} />
                                  ) : null}
                                </div>
                                <p className="truncate text-[12px] text-muted-foreground">
                                  {readableRole(person.role)}
                                  {person.hostelName ? ` · ${person.hostelName}` : ""}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {roomLabel(person)}
                          </TableCell>
                          <TableCell>
                            {person.feeStatus ? (
                              <SoftBadge tone={statusToneFromLabel(person.feeStatus)}>
                                {person.feeStatus.replaceAll("_", " ")}
                              </SoftBadge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {person.nightStatus ? (
                              <SoftBadge
                                tone={statusToneFromLabel(
                                  nightStatusLabel(person.nightStatus),
                                )}
                              >
                                {nightStatusLabel(person.nightStatus)}
                              </SoftBadge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {person.activationStatus ? (
                              <SoftBadge
                                tone={statusToneFromLabel(
                                  activationLabel(person.activationStatus),
                                )}
                              >
                                {activationLabel(person.activationStatus)}
                              </SoftBadge>
                            ) : (
                              <SoftBadge tone={statusToneFromLabel(person.status)}>
                                {person.status}
                              </SoftBadge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </DataTable>
                <ListPager
                  onPageChange={setPage}
                  page={page}
                  pageSize={PAGE_SIZE}
                  showPageSize
                  total={filtered.length}
                  unit="users"
                />
              </>
            ) : null}
          </section>
        </div>

        {/* ── Right inspector ─────────────────────────────────────── */}
        {selected ? (
          <aside className="flex max-h-[calc(100vh-8.5rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-card xl:sticky xl:top-0">
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
              <div className="flex justify-end p-2 pb-0">
                <button
                  aria-label="Close details"
                  className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  onClick={() => setSelectedId(null)}
                  type="button"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex items-center gap-3 px-3.5 pb-3">
                <InitialsAvatar name={selected.name} size="lg" tone="team" />
                <div className="min-w-0">
                  <p className="truncate font-heading text-[16px] font-bold text-foreground">
                    {selected.name}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground">
                    {selected.roomNumber || selected.bedNumber
                      ? roomLabel(selected).replace(" / ", " • ")
                      : readableRole(selected.role)}
                  </p>
                  <span className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-role-team-soft px-2 py-0.5 text-[10.5px] font-semibold text-role-team">
                    <span className="size-1.5 rounded-full bg-current" />
                    {selected.nightStatus
                      ? nightStatusLabel(selected.nightStatus)
                      : selected.status}
                  </span>
                </div>
              </div>

              <div className="px-3.5">
                <PanelTabs onChange={setDetailTab} tabs={DETAIL_TABS} value={detailTab} />
              </div>

              <div className="space-y-2.5 p-3.5">
                {detailTab === "details" ? (
                  <>
                    <DetailSection title="Personal Information">
                      <DetailField label="Full Name" value={selected.name} />
                      <DetailField label="Role" value={readableRole(selected.role)} />
                      <DetailField label="Phone" value={selected.phone || "—"} />
                      <DetailField label="Email" value={selected.email || "—"} />
                      <DetailField
                        label="Account Status"
                        value={
                          <SoftBadge tone={statusToneFromLabel(selected.status)}>
                            {selected.status}
                          </SoftBadge>
                        }
                      />
                    </DetailSection>

                    <DetailSection title="Guardian Information">
                      {selected.guardian ? (
                        <>
                          <DetailField label="Name" value={selected.guardian.name} />
                          <DetailField
                            label="Relationship"
                            value={selected.guardian.relation}
                          />
                          <DetailField label="Phone" value={selected.guardian.phone} />
                        </>
                      ) : (
                        <p className="py-1 text-[12px] text-muted-foreground">No guardian linked.</p>
                      )}
                    </DetailSection>

                    <DetailSection title="Emergency Contact">
                      {selected.emergencyContact ? (
                        <>
                          <DetailField
                            label="Name"
                            value={selected.emergencyContact.name}
                          />
                          <DetailField
                            label="Relationship"
                            value={selected.emergencyContact.relation}
                          />
                          <DetailField
                            label="Phone"
                            value={selected.emergencyContact.phone}
                          />
                        </>
                      ) : (
                        <p className="py-1 text-[12px] text-muted-foreground">No emergency contact.</p>
                      )}
                    </DetailSection>

                    <DetailSection title="Hostel Information">
                      <DetailField label="Hostel" value={selected.hostelName || "—"} />
                      <DetailField label="Room / Bed" value={roomLabel(selected)} />
                      <DetailField
                        label="Date of Join"
                        value={formatDate(selected.moveInDate ?? selected.createdAt)}
                      />
                      <DetailField label="Stay Type" value={selected.stayType || "—"} />
                      <DetailField
                        label="Activation"
                        value={
                          selected.activationStatus
                            ? activationLabel(selected.activationStatus)
                            : "—"
                        }
                      />
                    </DetailSection>
                  </>
                ) : null}

                {detailTab === "payments" ? (
                  <DetailSection title="Latest Payment">
                    {selected.feeStatus ? (
                      <>
                        <DetailField label="Period" value={selected.feeMonth || "—"} />
                        <DetailField
                          label="Status"
                          value={
                            <SoftBadge tone={statusToneFromLabel(selected.feeStatus)}>
                              {selected.feeStatus.replaceAll("_", " ")}
                            </SoftBadge>
                          }
                        />
                        <Link className="inline-block pt-1.5 text-[12px] font-semibold text-role-team" href="/platform/transactions">
                          Full ledger in Transactions
                        </Link>
                      </>
                    ) : (
                      <p className="py-1 text-[12px] text-muted-foreground">No payments yet.</p>
                    )}
                  </DetailSection>
                ) : null}

                {detailTab === "activity" ? (
                  <DetailSection title="Account Activity">
                    <DetailField
                      label="Last login"
                      value={formatDateTime(selected.lastLoginAt)}
                    />
                    <DetailField
                      label="Registered"
                      value={formatDateTime(selected.createdAt)}
                    />
                    <DetailField
                      label="Night status"
                      value={
                        selected.nightStatus
                          ? nightStatusLabel(selected.nightStatus)
                          : "—"
                      }
                    />
                    <DetailField
                      label="Linked hostels"
                      value={String(selected.hostelCount)}
                    />
                    <Link className="inline-block pt-1.5 text-[12px] font-semibold text-role-team" href="/platform/audit-logs">
                      Full history in the Audit Log
                    </Link>
                  </DetailSection>
                ) : null}

                {detailTab === "documents" ? (
                  <DetailSection title="Documents">
                    <p className="py-1 text-[12px] text-muted-foreground">
                      The hostel keeps resident papers; hostel papers are in{" "}
                      <Link className="font-semibold text-role-team" href="/platform/hostels">
                        Hostel Approvals
                      </Link>
                      .
                    </p>
                  </DetailSection>
                ) : null}
              </div>
            </div>
          </aside>
        ) : (
          <aside className="hidden flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-card/50 p-8 text-center xl:flex">
            <span className="flex size-12 items-center justify-center rounded-full bg-role-team-soft text-role-team">
              <Users className="size-[22px]" />
            </span>
            <p className="text-[13.5px] font-semibold text-foreground">Pick a user to see their profile</p>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              Read only
            </span>
          </aside>
        )}
      </div>
    </div>
  );
});
