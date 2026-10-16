"use client";

import React, { useCallback, useMemo, useState, type FormEvent } from "react";
import { Gift, Trophy } from "@/components/icons";
import { EmptyState, LoadingRows, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
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
    ? new Date(value).toLocaleDateString("en", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
}

export const HostelAdminReferralsPageContent = React.memo(
  function HostelAdminReferralsPageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [filter, setFilter] = useState("");
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
    const visible = useMemo(
      () => referrals.filter((referral) => !filter || referral.status === filter),
      [filter, referrals],
    );

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
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Track who your residents brought in, confirm the ones who joined, and settle their rewards."
          icon={Gift}
          title="Referrals"
        />
        <Message value={message} />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatTile
            hint={`${summary?.pendingConfirmation ?? 0} awaiting confirmation`}
            label="Referrals received"
            value={summary?.total ?? 0}
          />
          <StatTile
            hint="Referred people who moved in"
            label="Joined"
            tone="good"
            value={summary?.joined ?? 0}
          />
          {/* Set automatically the first time a referred resident has a payment
              verified — nothing here is typed by hand. */}
          <StatTile
            hint="First payment verified"
            label="Converted"
            tone="good"
            value={summary?.converted ?? 0}
          />
          <StatTile
            hint="Approved but not yet handed over"
            label="Rewards owed"
            tone={(summary?.rewardApprovedAmount ?? 0) > 0 ? "warn" : "default"}
            value={money(summary?.rewardApprovedAmount ?? 0)}
          />
          <StatTile
            hint="Settled with the referrer"
            label="Rewards paid"
            tone="good"
            value={money(summary?.rewardPaidAmount ?? 0)}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
          <Panel title="Referrals">
            <div className="mb-4 flex flex-wrap gap-2">
              {FILTERS.map((option) => (
                <button
                  className={
                    filter === option.value
                      ? "rounded-full border border-role-admin bg-role-admin px-3.5 py-1.5 text-xs font-semibold text-white"
                      : "rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground"
                  }
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  type="button"
                >
                  {option.label}
                  {option.value && summary?.byStatus[option.value] ? (
                    <span className="ml-1.5 opacity-70">
                      {summary.byStatus[option.value]}
                    </span>
                  ) : null}
                </button>
              ))}
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

            <div className="grid gap-3">
              {visible.map((referral) => (
                <div className="rounded-lg border border-border p-4" key={referral.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground">{referral.name}</p>
                      <p className="text-sm text-muted-foreground">{referral.phone}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Referred by{" "}
                        <span className="font-semibold text-foreground">
                          {referral.referrerName}
                        </span>
                        {referral.referrerPhone ? ` (${referral.referrerPhone})` : ""} ·{" "}
                        {shortDate(referral.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <StatusBadge>{referral.status}</StatusBadge>
                      {referral.reward ? (
                        <span className="text-xs font-semibold text-muted-foreground">
                          {money(referral.reward.amount)} · {referral.reward.status}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {referral.message ? (
                    <p className="mt-3 rounded-md bg-muted/40 p-2.5 text-sm text-muted-foreground">
                      {referral.message}
                    </p>
                  ) : null}

                  {referral.status === "INQUIRY_CREATED" ? (
                    <BusyForm
                      className="mt-4 grid gap-2 sm:grid-cols-[110px_1fr_1fr_auto]"
                      onSubmit={(event) => confirm(event, referral.id)}
                    >
                      <select
                        className="h-10 rounded-md border border-border bg-background px-2 text-sm"
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
                        className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                        min="0"
                        aria-label="Reward amount"
                        name="rewardAmount"
                        placeholder="Reward amount"
                        type="number"
                      />
                      <input
                        className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                        aria-label="Reward notes"
                        name="rewardNotes"
                        placeholder="Reward notes"
                      />
                      <SubmitButton className="h-10 rounded-md bg-role-admin px-4 text-sm font-semibold text-white">
                        Confirm Joined
                      </SubmitButton>
                    </BusyForm>
                  ) : (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {referral.reward?.status !== "PAID" ? (
                        <button
                          className="rounded-md bg-role-admin px-3.5 py-2 text-sm font-semibold text-white"
                          onClick={() => void setRewardStatus(referral.id, "PAID")}
                          type="button"
                        >
                          Mark Reward Paid
                        </button>
                      ) : null}
                      {referral.reward?.status !== "APPROVED" &&
                      referral.reward?.status !== "PAID" ? (
                        <button
                          className="rounded-md border border-role-admin px-3.5 py-2 text-sm font-semibold text-role-admin"
                          onClick={() => void setRewardStatus(referral.id, "APPROVED")}
                          type="button"
                        >
                          Approve Reward
                        </button>
                      ) : null}
                      {referral.reward?.status !== "CANCELLED" ? (
                        <button
                          className="rounded-md border border-border px-3.5 py-2 text-sm font-semibold text-muted-foreground"
                          onClick={() => void setRewardStatus(referral.id, "CANCELLED")}
                          type="button"
                        >
                          Cancel Reward
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Top Referrers">
            {topReferrers.length === 0 ? (
              <EmptyState label="No resident has brought anyone in yet." />
            ) : null}
            <ol className="grid gap-2.5">
              {topReferrers.map((referrer, index) => (
                <li
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                  key={referrer.id}
                >
                  <span
                    className={
                      index === 0
                        ? "flex size-8 shrink-0 items-center justify-center rounded-full bg-role-admin text-sm font-bold text-white"
                        : "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-foreground"
                    }
                  >
                    {index === 0 ? <Trophy className="size-4" /> : index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-foreground">
                      {referrer.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Code {referrer.code}
                      {referrer.roomType ? ` · ${referrer.roomType}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-foreground">
                      {referrer.joinedCount}
                    </p>
                    <p className="text-[11px] text-muted-foreground">joined</p>
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
