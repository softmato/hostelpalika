"use client";

import React, { useCallback, useMemo, useState } from "react";
import { Check, Copy, Gift } from "@/components/icons";
import { EmptyState, Panel, StatusBadge, currency } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { Message, PageHeader, type Referral } from "./portal-shared";

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

function StatTile({
  hint,
  label,
  value,
}: {
  hint: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

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
      <div className="mx-auto max-w-[900px] space-y-6">
        <PageHeader
          description="Share your referral code with a friend joining the hostel."
          icon={Gift}
          title="Referral"
        />
        <Message value={message} />
        <Panel title="Your Code">
          {referralCode ? (
            <div className="space-y-4">
              <p className="break-all font-mono text-3xl font-bold tracking-widest text-role-resident sm:text-4xl">
                {referralCode.code}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {shareUrl || referralCode.link}
                </code>
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-resident"
                  onClick={handleCopy}
                  type="button"
                >
                  {copied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              {/* "Converted" is the only number tied to real money: it counts
                  friends whose first payment the hostel has verified. */}
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile
                  hint="Friends you referred"
                  label="Sent"
                  value={String(summary.sent)}
                />
                <StatTile
                  hint="Registered at the hostel"
                  label="Joined"
                  value={String(summary.joined)}
                />
                <StatTile
                  hint="First payment verified"
                  label="Converted"
                  value={String(summary.converted)}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {rewardTotal > 0
                  ? `You've earned ${currency(rewardTotal)} in rewards across ${referralCode.rewardCount} referral(s). Your hostel applies rewards manually.`
                  : "No rewards recorded yet — your hostel adds these manually once a referral converts."}
              </p>
            </div>
          ) : (
            <EmptyState label="Referral code is not loaded." />
          )}
        </Panel>
        <Panel title="Referred Inquiries">
          {referrals.length === 0 ? (
            <EmptyState label="No referrals yet. Share your code to get started." />
          ) : null}
          <div className="space-y-3">
            {referrals.map((referral) => (
              <div className="rounded-lg border border-border p-4" key={referral.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{referral.name}</p>
                    <p className="text-sm text-muted-foreground">{referral.phone}</p>
                    {referral.reward && referral.reward.amount > 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Reward {currency(referral.reward.amount)} ·{" "}
                        {referral.reward.status}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    <StatusBadge>{referral.status}</StatusBadge>
                    {referral.converted ? <StatusBadge>CONVERTED</StatusBadge> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    );
  },
);
