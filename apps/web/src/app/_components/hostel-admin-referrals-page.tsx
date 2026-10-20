"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

import React, { useCallback, useMemo, useState, type FormEvent } from "react";
import { BadgeCheck, Gift, HandCoins, Trophy, UserCheck, Users, Wallet } from "@/components/icons";
import { EmptyState, LoadingRows, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Chip, ShareBar } from "@/app/_components/hostel-admin-page-ui";
import { InitialsAvatar, SearchField } from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { StatTile, money } from "./report-widgets";
import {
  Message,
  PageHeader,
  optionalField,
  optionalNumber,
  type Referral,
} from "./portal-shared";

type AdminReferral = Referral & {
  createdAt?: string;
  email: string;
  message: string;
  referrerName: string;
  referrerPhone: string;
};

type ReferralsResponse = {
  referrals: AdminReferral[];
  summary: {
    byStatus: Record<string, number>;
    converted: number;
    joined: number;
    pendingConfirmation: number;
    rewardApprovedAmount: number;
    rewardPaidAmount: number;
    rewardPendingAmount: number;
    total: number;
  };
  topReferrers: Array<{
    code: string;
    id: string;
    joinedCount: number;
    name: string;
    rewardCount: number;
    roomType: string;
  }>;
};

const FILTERS = [
  { label: "All", value: "" },
  { label: "Awaiting confirmation", value: "INQUIRY_CREATED" },
  { label: "Joined", value: "JOINED" },
  { label: "Rewarded", value: "REWARDED" },
  { label: "Cancelled", value: "CANCELLED" },
];

function shortDate(value?: string) {
  return value
    ? formatHostelDate(value)
    : "—";
}

export const HostelAdminReferralsPageContent = React.memo(
  function HostelAdminReferralsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [filter, setFilter] = useState("");
    const [search, setSearch] = useState("");
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const invalidate = useInvalidateResources();
    const referralsResource = usePortalResource<ReferralsResponse>(
      hostelAdminEndpoints.referrals,
      { errorMessage: "Could not load referrals." },
    );

    const data = referralsResource.data;
    const referrals = useMemo(() => data?.referrals ?? [], [data]);
    const summary = data?.summary;
    const topReferrers = useMemo(() => data?.topReferrers ?? [], [data]);
    const message = actionMessage || referralsResource.message;
    const visible = useMemo(() => {
      const query = search.trim().toLowerCase();

      return referrals.filter(
        (referral) =>
          (!filter || referral.status === filter) &&
          (!query ||
            `${referral.name} ${referral.phone} ${referral.referrerName}`.toLowerCase().includes(query)),
      );
    }, [filter, referrals, search]);
    const confirming = referrals.find((referral) => referral.id === confirmingId) ?? null;
    const topCount = topReferrers[0]?.joinedCount ?? 0;

    const confirm = useCallback(
      async (event: FormEvent<HTMLFormElement>, referralId: string) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        try {
          await browserApi(`${hostelAdminEndpoints.referrals}/${referralId}/confirm`, {
            body: JSON.stringify({
              rewardAmount: optionalNumber(form, "rewardAmount"),
              rewardNotes: optionalField(form, "rewardNotes"),
              rewardType: optionalField(form, "rewardType"),
            }),
            method: "PATCH",
          });
          setActionMessage("Referral confirmed as joined.");
          setConfirmingId(null);
          invalidate(hostelAdminEndpoints.referrals);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not confirm referral.",
          );
        }
      },
      [invalidate],
    );

    const setRewardStatus = useCallback(
      async (referralId: string, status: string) => {
        try {
          await browserApi(`${hostelAdminEndpoints.referrals}/${referralId}/reward`, {
            body: JSON.stringify({ status }),
            method: "PATCH",
          });
          setActionMessage(
            status === "PAID" ? "Reward marked as paid." : `Reward set to ${status}.`,
          );
          invalidate(hostelAdminEndpoints.referrals);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not update reward.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          description="Who your residents brought in, and their rewards."
          icon={Gift}
          title="Referrals"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatTile
            hint={`${summary?.pendingConfirmation ?? 0} awaiting confirmation`}
            icon={Users}
            label="Referrals received"
            value={summary?.total ?? 0}
          />
          <StatTile
            hint="Referred people who moved in"
            icon={UserCheck}
            label="Joined"
            tone="good"
            value={summary?.joined ?? 0}
          />
          {/* Set automatically the first time a referred resident has a payment
              verified — nothing here is typed by hand. */}
          <StatTile
            hint="First payment verified"
            icon={BadgeCheck}
            label="Converted"
            tone="good"
            value={summary?.converted ?? 0}
          />
          <StatTile
            hint="Approved but not yet handed over"
            icon={HandCoins}
            label="Rewards owed"
            tone={(summary?.rewardApprovedAmount ?? 0) > 0 ? "warn" : "default"}
            value={money(summary?.rewardApprovedAmount ?? 0)}
          />
          <StatTile
            hint="Settled with the referrer"
            icon={Wallet}
            label="Rewards paid"
            tone="good"
            value={money(summary?.rewardPaidAmount ?? 0)}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
          <Panel title="Referrals">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <SearchField onChange={setSearch} placeholder="Search name, phone, referrer" size="lg" value={search} />
              <FilterButton active={filter ? 1 : 0} onClear={() => setFilter("")}>
                <FilterChoice
                  label="Stage"
                  onChange={setFilter}
                  options={FILTERS.map((option) => ({
                    label:
                      option.value && summary?.byStatus[option.value]
                        ? `${option.label} ${summary.byStatus[option.value]}`
                        : option.label,
                    value: option.value,
                  }))}
                  value={filter}
                />
              </FilterButton>
            </div>

            {referralsResource.state === "loading" ? <LoadingRows /> : null}
            {referralsResource.state === "ready" && visible.length === 0 ? (
              <EmptyState
                label={
                  referrals.length === 0
                    ? "No referrals yet. Residents share their code from the resident app."
                    : "No referrals in this stage."
                }
              />
            ) : null}

            <div className="divide-y divide-border/60">
              {visible.map((referral) => (
                <div className="space-y-2 py-3" key={referral.id}>
                  <div className="flex flex-wrap items-start gap-3">
                    <InitialsAvatar name={referral.name} size="sm" tone="admin" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold text-foreground">{referral.name}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {referral.phone} · by{" "}
                        <span className="font-semibold text-foreground">{referral.referrerName}</span>
                        {referral.referrerPhone ? ` (${referral.referrerPhone})` : ""} · {shortDate(referral.createdAt)}
                      </p>
                    </div>
                    <StatusBadge>{referral.status}</StatusBadge>
                  </div>

                  {referral.message ? (
                    <p className="ml-12 rounded-xl bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">
                      {referral.message}
                    </p>
                  ) : null}

                  <div className="ml-12 flex flex-wrap items-center gap-1.5">
                    {referral.reward ? (
                      <Chip glyph="gift" tone={referral.reward.status === "PAID" ? "brand" : "neutral"}>
                        {`${money(referral.reward.amount)} · ${referral.reward.status.toLowerCase()}`}
                      </Chip>
                    ) : null}
                    {referral.status === "INQUIRY_CREATED" ? (
                      <Button
                        className="bg-brand-teal text-white hover:bg-brand-teal/90"
                        onClick={() => setConfirmingId(referral.id)}
                        size="sm"
                        type="button"
                      >
                        Confirm joined
                      </Button>
                    ) : (
                      <>
                        {referral.reward?.status !== "PAID" ? (
                          <Button
                            className="bg-brand-teal text-white hover:bg-brand-teal/90"
                            onClick={() => void setRewardStatus(referral.id, "PAID")}
                            size="sm"
                            type="button"
                          >
                            Mark paid
                          </Button>
                        ) : null}
                        {referral.reward?.status !== "APPROVED" &&
                        referral.reward?.status !== "PAID" ? (
                          <Button
                            onClick={() => void setRewardStatus(referral.id, "APPROVED")}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Approve reward
                          </Button>
                        ) : null}
                        {referral.reward?.status !== "CANCELLED" ? (
                          <Button
                            className="text-muted-foreground"
                            onClick={() => void setRewardStatus(referral.id, "CANCELLED")}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Cancel reward
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Dialog onOpenChange={(open) => (open ? null : setConfirmingId(null))} open={confirming !== null}>
            <DialogContent className="sm:max-w-md">
              {confirming ? (
                <>
                  <DialogHeader>
                    <DialogTitle>{confirming.name} joined</DialogTitle>
                    <DialogDescription>{`The reward for ${confirming.referrerName}.`}</DialogDescription>
                  </DialogHeader>
                  <BusyForm
                    className="grid gap-3"
                    key={confirming.id}
                    onSubmit={(event) => confirm(event, confirming.id)}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <select
                        aria-label="Reward type"
                        className="h-10 rounded-xl border border-border bg-background px-2 text-[13.5px]"
                        defaultValue="DISCOUNT"
                        name="rewardType"
                      >
                        {["DISCOUNT", "CASH", "SERVICE_CREDIT", "OTHER"].map((type) => (
                          <option key={type} value={type}>
                            {type.replaceAll("_", " ")}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label="Reward amount"
                        className="h-10 rounded-xl border border-border bg-background px-3 text-[13.5px]"
                        min="0"
                        name="rewardAmount"
                        placeholder="Reward amount"
                        type="number"
                      />
                    </div>
                    <input
                      aria-label="Reward notes"
                      className="h-10 rounded-xl border border-border bg-background px-3 text-[13.5px]"
                      name="rewardNotes"
                      placeholder="Reward notes"
                    />
                    <DialogFooter>
                      <SubmitButton className="h-10 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90">
                        Confirm joined
                      </SubmitButton>
                    </DialogFooter>
                  </BusyForm>
                </>
              ) : null}
            </DialogContent>
          </Dialog>

          <Panel title="Top Referrers">
            {topReferrers.length === 0 ? (
              <EmptyState label="No resident has brought anyone in yet." />
            ) : null}
            <ol className="grid gap-3">
              {topReferrers.map((referrer, index) => (
                <li className="flex items-center gap-3" key={referrer.id}>
                  <span
                    className={
                      index === 0
                        ? "flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-teal text-[13px] font-bold text-white"
                        : "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-bold text-foreground"
                    }
                  >
                    {index === 0 ? <Trophy className="size-4" /> : index + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-[13.5px] font-semibold text-foreground">{referrer.name}</p>
                      <span className="text-[12.5px] font-bold text-foreground">{referrer.joinedCount}</span>
                    </div>
                    <ShareBar total={topCount} value={referrer.joinedCount} />
                    <p className="truncate text-[11.5px] text-muted-foreground">
                      Code {referrer.code}
                      {referrer.roomType ? ` · ${referrer.roomType}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    );
  },
);
