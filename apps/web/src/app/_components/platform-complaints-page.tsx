"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import { AlarmClock, CheckCircle2, MessageSquare, TimerOff } from "@/components/icons";
import Link from "next/link";
import { memo, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
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
import { FilterButton, FilterChoice } from "@/components/filter-panel";
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
  return Number.isNaN(date.getTime()) ? "—" : formatHostelDate(date);
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
    const switchTab = (next: string) => {
      setTab(next);
      setPage(1);
    };
    const resolvedCount = statusCounts.RESOLVED ?? 0;

    return (
      <div className="mx-auto max-w-[1448px] space-y-4">
        <PortalPageHeader description="Resident complaints everywhere, and which hostels miss their deadline." title="Complaints" />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            active={tab === "ALL" && !overdueOnly}
            icon={MessageSquare}
            label="Complaints"
            onClick={() => {
              switchTab("ALL");
              setOverdueOnly(false);
            }}
            value={data?.total ?? 0}
          />
          <MetricCard
            active={tab === "PENDING"}
            icon={AlarmClock}
            label="Open"
            note={`${statusCounts.IN_PROGRESS ?? 0} in progress`}
            onClick={() => switchTab("PENDING")}
            tone={(statusCounts.PENDING ?? 0) + (statusCounts.IN_PROGRESS ?? 0) > 0 ? "amber" : "teal"}
            value={(statusCounts.PENDING ?? 0) + (statusCounts.IN_PROGRESS ?? 0)}
          />
          <MetricCard
            active={overdueOnly}
            icon={TimerOff}
            label="Past deadline"
            onClick={() => {
              setOverdueOnly(!overdueOnly);
              setPage(1);
            }}
            tone={overdue > 0 ? "rose" : "teal"}
            value={overdue}
          />
          <MetricCard
            active={tab === "RESOLVED"}
            icon={CheckCircle2}
            label="Resolved"
            note={complaints.length > 0 ? `${Math.round((resolvedCount / complaints.length) * 100)}% of all` : undefined}
            onClick={() => switchTab("RESOLVED")}
            value={resolvedCount}
          />
        </div>

        <Panel>
          <TabBar
            className="mb-3"
            onChange={switchTab}
            tabs={TABS.map((item) => ({ ...item, count: tabCount(item.key) }))}
            value={tab}
          />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchField
              onChange={(next) => {
                setQuery(next);
                setPage(1);
              }}
              placeholder="Search title, hostel or category"
              value={query}
            />
            <FilterButton
              active={(categoryFilter ? 1 : 0) + (hostelFilter ? 1 : 0) + (overdueOnly ? 1 : 0)}
              onClear={() => {
                setCategoryFilter("");
                setHostelFilter("");
                setOverdueOnly(false);
                setPage(1);
              }}
            >
              <FilterChoice
                label="Deadline"
                onChange={(next) => {
                  setOverdueOnly(next === "late");
                  setPage(1);
                }}
                options={[
                  { label: "Any", value: "any" },
                  { label: "Past deadline", value: "late" },
                ]}
                value={overdueOnly ? "late" : "any"}
              />
              <FilterChoice
                label="Category"
                onChange={(next) => {
                  setCategoryFilter(next);
                  setPage(1);
                }}
                options={[{ label: "All", value: "" }, ...categories.map((item) => ({ label: item, value: item }))]}
                value={categoryFilter}
              />
              <FilterChoice
                label="Hostel"
                onChange={(next) => {
                  setHostelFilter(next);
                  setPage(1);
                }}
                options={[{ label: "All", value: "" }, ...hostels.map((item) => ({ label: item, value: item }))]}
                value={hostelFilter}
              />
            </FilterButton>
          </div>

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
                          <p className="truncate text-[13.5px] font-semibold text-foreground">
                            {complaint.title}
                          </p>
                          {complaint.isAnonymous ? (
                            <p className="text-[12px] text-muted-foreground">Anonymous</p>
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
                        <SoftBadge tone="slate">{complaint.category}</SoftBadge>
                      </TableCell>
                      <TableCell>
                        <SoftBadge tone={statusToneFromLabel(complaint.status)}>
                          {complaint.status.replaceAll("_", " ")}
                        </SoftBadge>
                      </TableCell>
                      <TableCell>
                        {complaint.isOverdue ? (
                          <SoftBadge tone="rose">Past deadline</SoftBadge>
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
