"use client";

import React, { useCallback, useMemo, useState } from "react";
import { BadgeCheck, Check, Copy, Gift, Send, UserCheck } from "@/components/icons";
import { EmptyState, currency } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { SectionTitle, ShareBar, titleCase } from "./daily-portal-ui";
import {
  InitialsAvatar,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
} from "./portal-dashboard-ui";
import { Message, type Referral } from "./portal-shared";

type ReferralCode = {
  code: string;
  convertedCount: number;
  joinedCount: number;
  link: string;
  rewardCount: number;
};

type ReferralSummary = {
  converted: number;
  joined: number;
  rewardApprovedAmount: number;
  rewardPaidAmount: number;
  sent: number;
};

const EMPTY_SUMMARY: ReferralSummary = {
  converted: 0,
  joined: 0,
  rewardApprovedAmount: 0,
  rewardPaidAmount: 0,
  sent: 0,
};

export const ResidentReferralPageContent = React.memo(
  function ResidentReferralPageContent() {
    const referralResource = usePortalResource<{
      referralCode: ReferralCode;
      referrals: Referral[];
      summary: ReferralSummary;
    }>(residentEndpoints.referral, { errorMessage: "Could not load referral." });

    const referralCode = referralResource.data?.referralCode ?? null;
    const referrals = useMemo(
      () => referralResource.data?.referrals ?? [],
      [referralResource.data],
    );
    const summary = referralResource.data?.summary ?? EMPTY_SUMMARY;
    const message = referralResource.message;
    const [copied, setCopied] = useState(false);

    // The stored link is relative so it works on any deploy; the shareable one
    // has to carry the origin the resident is actually looking at.
    const shareUrl = useMemo(() => {
      if (!referralCode) {
        return "";
      }

      return typeof window === "undefined"
        ? referralCode.link
        : new URL(referralCode.link, window.location.origin).toString();
    }, [referralCode]);

    const handleCopy = useCallback(async () => {
      if (!shareUrl) {
        return;
      }

      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopied(false);
      }
    }, [shareUrl]);

    const rewardTotal = summary.rewardApprovedAmount + summary.rewardPaidAmount;

    return (
      <div className="mx-auto max-w-[900px] space-y-5">
        <PortalPageHeader
          actions={
            referralCode ? (
              <RoleButton className="h-9 px-4" onClick={handleCopy} tone="team">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy link"}
              </RoleButton>
            ) : null
          }
          description="Share your code with a friend who is joining."
          title="Referral"
        />
        <Message value={message} />

        {referralCode ? (
          <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 sm:flex-row sm:items-center">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-role-team-soft text-role-team">
              <Gift className="size-7" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Your code</p>
              <p className="break-all font-mono text-[30px] font-bold leading-tight tracking-widest text-foreground">
                {referralCode.code}
              </p>
              <p className="truncate text-[12.5px] text-muted-foreground">{shareUrl || referralCode.link}</p>
            </div>
            <div className="text-left sm:text-right">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Rewards</p>
              <p className="font-heading text-[22px] font-bold text-foreground tabular-nums">{currency(rewardTotal)}</p>
            </div>
          </section>
        ) : (
          <EmptyState label="Referral code is not loaded." />
        )}

        {/* "Converted" is the only number tied to real money: it counts friends
            whose first payment the hostel has verified. */}
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Send} label="Sent" value={String(summary.sent)} />
          <MetricCard icon={UserCheck} label="Joined" value={String(summary.joined)} />
          <MetricCard icon={BadgeCheck} label="First payment made" value={String(summary.converted)} />
        </div>
        {summary.sent > 0 ? (
          <ShareBar
            label={`${summary.converted} of ${summary.sent} have paid`}
            total={summary.sent}
            value={summary.converted}
          />
        ) : null}

        <section className="space-y-3">
          <SectionTitle>People you referred</SectionTitle>
          <SectionCard>
            {referrals.length === 0 ? (
              <EmptyState label="No referrals yet. Share your code to start." />
            ) : (
              <div className="divide-y divide-border/60">
                {referrals.map((referral) => (
                  <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0" key={referral.id}>
                    <InitialsAvatar name={referral.name} tone="team" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold text-foreground">{referral.name}</p>
                      <p className="truncate text-[12px] text-muted-foreground">
                        {referral.phone}
                        {referral.reward && referral.reward.amount > 0
                          ? ` · ${currency(referral.reward.amount)} ${titleCase(referral.reward.status)}`
                          : ""}
                      </p>
                    </div>
                    <SoftBadge tone={referral.converted ? "green" : statusToneFromLabel(referral.status)}>
                      {referral.converted ? "Paid" : titleCase(referral.status)}
                    </SoftBadge>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
          {/* Rewards are added by hand once a referral pays. */}
          <p className="text-[12.5px] text-muted-foreground">Your hostel adds rewards once a friend pays.</p>
        </section>
      </div>
    );
  },
);
