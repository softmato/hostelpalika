"use client";

import { AlarmClock, CheckCircle2, MessageSquare, TimerOff } from "@/components/icons";
import Link from "next/link";
import { memo, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  FilterBar,
  FilterSelect,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
  SearchField,
  SoftBadge,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

type PlatformComplaint = {
  category: string;
  createdAt: string | null;
  hostelId: string;
  hostelName: string;
  id: string;
  isAnonymous: boolean;
  isOverdue: boolean;
  resolvedAt: string | null;
  slaDueAt: string | null;
  status: string;
  title: string;
};

type ComplaintsResponse = {
  complaints: PlatformComplaint[];
  statusCounts: Record<string, number>;
  total: number;
};

const TABS = [
  { key: "ALL", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "IN_PROGRESS", label: "In progress" },
  { key: "RESOLVED", label: "Resolved" },
  { key: "REJECTED", label: "Rejected" },
];

const PAGE_SIZE = 12;

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export const PlatformComplaintsPageContent = memo(
  function PlatformComplaintsPageContent() {
    const complaintsResource = usePortalResource<ComplaintsResponse>(
      platformEndpoints.complaints,
      { errorMessage: "Could not load complaints." },
    );
    const { data, message, state } = complaintsResource;
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState("ALL");
    const [categoryFilter, setCategoryFilter] = useState("");
    const [hostelFilter, setHostelFilter] = useState("");
    const [overdueOnly, setOverdueOnly] = useState(false);
    const [page, setPage] = useState(1);

    const complaints = useMemo(() => data?.complaints ?? [], [data]);
    const statusCounts = data?.statusCounts ?? {};

    const overdue = useMemo(
      () => complaints.filter((complaint) => complaint.isOverdue).length,
      [complaints],
    );

    const hostels = useMemo(
      () => Array.from(new Set(complaints.map((complaint) => complaint.hostelName))),
      [complaints],
    );

    const categories = useMemo(
      () => Array.from(new Set(complaints.map((complaint) => complaint.category))),
      [complaints],
    );

    const filtered = useMemo(() => {
      const term = query.trim().toLowerCase();

      return complaints.filter((complaint) => {
        if (tab !== "ALL" && complaint.status !== tab) return false;
        if (overdueOnly && !complaint.isOverdue) return false;
        if (categoryFilter && complaint.category !== categoryFilter) return false;
        if (hostelFilter && complaint.hostelName !== hostelFilter) return false;
        if (!term) return true;
        return `${complaint.title} ${complaint.hostelName} ${complaint.category}`
          .toLowerCase()
          .includes(term);
      });
    }, [categoryFilter, complaints, hostelFilter, overdueOnly, query, tab]);

    const paged = useMemo(
      () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      [filtered, page],
    );

    const tabCount = (key: string) =>
      key === "ALL" ? complaints.length : (statusCounts[key] ?? 0);

    return (
      <div className="mx-auto max-w-[1448px] space-y-4">
        <PortalPageHeader
          breadcrumb={["Home", "Complaints"]}
          description="Platform-level oversight of resident complaints — spot hostels breaching their resolution SLA."
          title="Complaints"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={MessageSquare}
            label="Total Complaints"
            note="Across all hostels"
            tone="teal"
            value={data?.total ?? 0}
          />
          <MetricCard
            icon={AlarmClock}
            label="Open"
            note="Pending or in progress"
            noteTone="amber"
            tone="amber"
            value={(statusCounts.PENDING ?? 0) + (statusCounts.IN_PROGRESS ?? 0)}
          />
          <MetricCard
            icon={TimerOff}
            label="SLA Breached"
            note="Past deadline, unresolved"
            noteTone="rose"
            tone="rose"
            value={overdue}
          />
          <MetricCard
            icon={CheckCircle2}
            label="Resolved"
            note="Closed successfully"
            noteTone="green"
            tone="green"
            value={statusCounts.RESOLVED ?? 0}
          />
        </div>

        <Panel>
          <TabBar
            className="mb-3"
            onChange={(next) => {
              setTab(next);
              setPage(1);
            }}
            tabs={TABS.map((item) => ({ ...item, count: tabCount(item.key) }))}
            value={tab}
          />

          <FilterBar>
            <SearchField
              onChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
              placeholder="Search complaints by title, hostel, category..."
              value={query}
            />
            <div className="flex flex-wrap items-center gap-2">
              <FilterSelect
                defaultLabel="All Categories"
                onChange={(next) => {
                  setCategoryFilter(next);
                  setPage(1);
                }}
                options={categories}
                value={categoryFilter}
              />
              <FilterSelect
                defaultLabel="All Hostels"
                onChange={(next) => {
                  setHostelFilter(next);
                  setPage(1);
                }}
                options={hostels}
                value={hostelFilter}
              />
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11.5px] font-semibold text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                <input
                  checked={overdueOnly}
                  className="size-3.5 accent-current"
                  onChange={(event) => {
                    setOverdueOnly(event.target.checked);
                    setPage(1);
                  }}
                  type="checkbox"
                />
                SLA breached only
              </label>
            </div>
          </FilterBar>

          {state === "loading" ? <LoadingRows /> : null}
          {state === "error" ? (
            <EmptyState label="Complaints could not be loaded." />
          ) : null}
          {state === "ready" && filtered.length === 0 ? (
            <EmptyState label="No complaints match these filters." />
          ) : null}

          {state === "ready" && filtered.length > 0 ? (
            <>
              <DataTable className="min-w-[820px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Complaint</Th>
                    <Th>Hostel</Th>
                    <Th>Category</Th>
                    <Th>Status</Th>
                    <Th>SLA</Th>
                    <Th>Raised</Th>
                    <Th>Resolved</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((complaint) => (
                    <TableRow key={complaint.id}>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-foreground">
                            {complaint.title}
                          </p>
                          {complaint.isAnonymous ? (
                            <p className="text-[11px] text-muted-foreground">
                              Submitted anonymously
                            </p>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <InitialsAvatar
                            name={complaint.hostelName}
                            size="sm"
                            tone="platform"
                          />
                          <Link
                            className="truncate font-medium text-foreground transition hover:text-role-platform"
                            href={`/platform/hostels/${complaint.hostelId}`}
                          >
                            {complaint.hostelName}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone="teal">{complaint.category}</SoftBadge>
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(complaint.status)}>
                          {complaint.status.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      <TableCell>
                        {complaint.isOverdue ? (
                          <SoftBadge tone="rose">Breached</SoftBadge>
                        ) : (
                          <span className="text-[11.5px] text-muted-foreground">
                            {formatDate(complaint.slaDueAt)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(complaint.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(complaint.resolvedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
              <ListPager
                onPageChange={setPage}
                page={page}
                pageSize={PAGE_SIZE}
                showPageSize
                total={filtered.length}
                unit="complaints"
              />
            </>
          ) : null}
        </Panel>
      </div>
    );
  },
);
