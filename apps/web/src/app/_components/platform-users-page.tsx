"use client";
import { downloadCsv } from "@/lib/downloads/downloader";

import {
  Download,
  MoreVertical,
  ShieldCheck,
  SlidersHorizontal,
  UserPlus,
  Users,
} from "@/components/icons";
import Link from "next/link";
import { memo, useMemo, useState } from "react";

import { EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import {
  DataTable,
  DetailField,
  DetailSection,
  FilterSelect,
  InitialsAvatar,
  ListPager,
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

  return (
    <div className="mx-auto max-w-[1448px]">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_312px]">
        {/* ── Main column ─────────────────────────────────────────── */}
        <div className="min-w-0 space-y-3">
          <PortalPageHeader
            actions={
              <>
                {/* Residents join through their hostel's activation codes; the
                    platform adds people by invitation, on the Team screen. */}
                <RoleButton asChild tone="platform">
                  <Link href="/platform/team">
                    <UserPlus className="size-3.5" />
                    Add User
                  </Link>
                </RoleButton>
              </>
            }
            description="Every account on the platform — owners, wardens, residents, and guardians."
            title="Users"
          />
          <Message value={message} />

          {/* Filter card */}
          <section className="rounded-xl border border-border bg-card p-3 shadow-sm">
            <SearchField
              className="max-w-none"
              onChange={resetPage(setQuery)}
              placeholder="Search by name, phone, email, room..."
              value={query}
            />
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <FilterSelect
                defaultLabel="All"
                label="Role"
                onChange={resetPage(setRoleFilter)}
                options={roles.map((role) => ({
                  label: readableRole(role),
                  value: role,
                }))}
                value={roleFilter}
              />
              <FilterSelect
                defaultLabel="All"
                label="Status"
                onChange={resetPage(setStatusFilter)}
                options={["ACTIVE", "INVITED", "SUSPENDED", "ARCHIVED", "PENDING"]}
                value={statusFilter}
              />
              <FilterSelect
                defaultLabel="All Hostels"
                label="Hostel"
                onChange={resetPage(setHostelFilter)}
                options={hostels}
                value={hostelFilter}
              />
              <FilterSelect
                defaultLabel="All"
                label="Activation Status"
                onChange={resetPage(setActivationFilter)}
                options={[
                  { label: "Activated", value: "USED" },
                  { label: "Code Sent", value: "PENDING" },
                  { label: "Not Generated", value: "NOT_GENERATED" },
                  { label: "Expired", value: "EXPIRED" },
                ]}
                value={activationFilter}
              />
              <div className="flex items-end">
                <button
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card text-[12.5px] font-semibold text-muted-foreground shadow-sm transition hover:text-foreground"
                  onClick={() => {
                    setQuery("");
                    setRoleFilter("");
                    setStatusFilter("");
                    setHostelFilter("");
                    setActivationFilter("");
                    setPage(1);
                  }}
                  type="button"
                >
                  <SlidersHorizontal className="size-3.5" />
                  Reset Filters
                </button>
              </div>
            </div>
          </section>

          {/* Table card */}
          <section className="rounded-xl border border-border bg-card p-3 shadow-sm">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <p className="text-[12.5px] font-semibold text-foreground">
                Total Users: {data?.total ?? 0}
              </p>
              <RoleButton
                disabled={filtered.length === 0}
                onClick={() =>
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
                  )
                }
                tone="platform"
                variant="outline"
              >
                <Download className="size-3.5" />
                Export
              </RoleButton>
            </div>

            {state === "loading" ? <LoadingRows /> : null}
            {state === "error" ? <EmptyState label="Users could not be loaded." /> : null}
            {state === "ready" && filtered.length === 0 ? (
              <EmptyState label="No users match these filters." />
            ) : null}

            {state === "ready" && filtered.length > 0 ? (
              <>
                <DataTable className="min-w-[1000px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <Th className="w-8" />
                      <Th>User</Th>
                      <Th>Room / Bed</Th>
                      <Th>Guardian Contact</Th>
                      <Th>Emergency Contact</Th>
                      <Th>Fee Status</Th>
                      <Th>Night Status</Th>
                      <Th>Activation</Th>
                      <Th className="w-8" />
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
                              "bg-role-platform-soft/50 [&>td:first-child]:relative [&>td:first-child]:before:absolute [&>td:first-child]:before:inset-y-0 [&>td:first-child]:before:left-0 [&>td:first-child]:before:w-[3px] [&>td:first-child]:before:bg-role-platform",
                          )}
                          key={person.id}
                          onClick={() => {
                            setSelectedId(person.id);
                            setDetailTab("details");
                          }}
                        >
                          <TableCell>
                            <input
                              aria-label={`Select ${person.name}`}
                              checked={isSelected}
                              className="size-3.5 accent-role-platform"
                              onChange={() =>
                                setSelectedId(isSelected ? null : person.id)
                              }
                              onClick={(event) => event.stopPropagation()}
                              type="checkbox"
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <InitialsAvatar
                                name={person.name}
                                size="sm"
                                tone="platform"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="truncate font-semibold text-foreground">
                                    {person.name}
                                  </span>
                                  {person.isDemoData ? (
                                    <DemoDataBadge label={person.demoDataLabel} />
                                  ) : null}
                                </div>
                                <p className="truncate text-[11px] text-muted-foreground">
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
                            {person.guardian ? (
                              <>
                                <p className="text-foreground">{person.guardian.name}</p>
                                <p className="text-[11px] text-muted-foreground">
                                  {person.guardian.phone}
                                </p>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {person.emergencyContact ? (
                              <>
                                <p className="text-foreground">
                                  {person.emergencyContact.name}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {person.emergencyContact.phone}
                                </p>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
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
                          <TableCell>
                            <button
                              aria-label={`Actions for ${person.name}`}
                              className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                              onClick={(event) => event.stopPropagation()}
                              type="button"
                            >
                              <MoreVertical className="size-3.5" />
                            </button>
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
          <aside className="flex max-h-[calc(100vh-8.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm xl:sticky xl:top-0">
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
              <div className="flex justify-end p-2 pb-0">
                <button
                  aria-label="Close details"
                  className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                  onClick={() => setSelectedId(null)}
                  type="button"
                >
                  <svg
                    className="size-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex items-center gap-3 px-3.5 pb-3">
                <InitialsAvatar name={selected.name} size="lg" tone="platform" />
                <div className="min-w-0">
                  <p className="truncate font-heading text-[16px] font-bold text-foreground">
                    {selected.name}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground">
                    {selected.roomNumber || selected.bedNumber
                      ? roomLabel(selected).replace(" / ", " • ")
                      : readableRole(selected.role)}
                  </p>
                  <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
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
                        <p className="py-1 text-[11.5px] text-muted-foreground">
                          No guardian linked to this account.
                        </p>
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
                        <p className="py-1 text-[11.5px] text-muted-foreground">
                          No emergency contact on file.
                        </p>
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
                        <p className="pt-1.5 text-[11px] leading-4 text-muted-foreground">
                          The full ledger for this hostel lives under{" "}
                          <Link
                            className="font-semibold text-role-platform"
                            href="/platform/transactions"
                          >
                            Transactions
                          </Link>
                          .
                        </p>
                      </>
                    ) : (
                      <p className="py-1 text-[11.5px] text-muted-foreground">
                        No payment records for this account.
                      </p>
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
                    <p className="pt-1.5 text-[11px] leading-4 text-muted-foreground">
                      Full action history is in the{" "}
                      <Link
                        className="font-semibold text-role-platform"
                        href="/platform/audit-logs"
                      >
                        Audit Log
                      </Link>
                      .
                    </p>
                  </DetailSection>
                ) : null}

                {detailTab === "documents" ? (
                  <DetailSection title="Documents">
                    <p className="py-1 text-[11.5px] leading-4 text-muted-foreground">
                      Resident documents are uploaded and reviewed by the hostel that owns
                      this record. Hostel-level paperwork is reviewed under{" "}
                      <Link
                        className="font-semibold text-role-platform"
                        href="/platform/hostels"
                      >
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
          <aside className="hidden flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/50 p-8 text-center xl:flex">
            <span className="flex size-10 items-center justify-center rounded-full bg-role-platform-soft text-role-platform">
              <Users className="size-5" />
            </span>
            <p className="text-[13px] font-semibold text-foreground">
              Select a user to see their profile
            </p>
            <p className="text-[11.5px] text-muted-foreground">
              Personal details, guardian, emergency contact, and hostel information appear
              here.
            </p>
            <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              Read-only platform view
            </span>
          </aside>
        )}
      </div>
    </div>
  );
});
