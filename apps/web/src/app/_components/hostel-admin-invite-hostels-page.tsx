"use client";

import { Building2, Clock, Copy, Mail, MessageCircle, Share2 } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { RowMark } from "@/app/_components/hostel-admin-page-ui";
import { MetricCard, PortalPageHeader, RoleButton, SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { EmptyState, Input, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { Message } from "./core-portal-shared";

const ENDPOINT = "/api/v1/hostel-admin/hostel-referrals";

type Overview = {
  code: string;
  enabled: boolean;
  link: string;
  referrals: {
    createdAt: string;
    hostelName: string;
    id: string;
    rewardAdded: boolean;
    rewardText: string;
    status: "PENDING" | "LIVE";
  }[];
  theyGet: { text: string };
  youGet: { text: string };
};

function shareText(data: Overview) {
  return [
    `We run our hostel on ${PLATFORM_NAME}.`,
    data.theyGet.text
      ? `Register yours with our code ${data.code} and get ${data.theyGet.text} extra, free:`
      : `Register yours with our code ${data.code}:`,
    data.link,
  ].join(" ");
}

/**
 * Invite hostels — this hostel's referral code. Owner and wardens see the same
 * code: it belongs to the hostel, so whoever shares it, the hostel is rewarded.
 */
export const HostelAdminInviteHostelsPageContent = memo(function HostelAdminInviteHostelsPageContent() {
  const [message, setMessage] = useState("");
  const [inviting, setInviting] = useState(false);
  const resource = usePortalResource<Overview>(ENDPOINT, {
    errorMessage: "Could not load your referral code.",
  });
  const data = resource.data;

  const copy = useCallback((value: string, done: string) => {
    void navigator.clipboard.writeText(value).then(() => setMessage(done));
  }, []);

  const share = useCallback(async () => {
    if (!data) {
      return;
    }

    if (navigator.share) {
      await navigator.share({ text: shareText(data), title: PLATFORM_NAME }).catch(() => {});
    } else {
      copy(shareText(data), "Invite copied. Paste it anywhere.");
    }
  }, [copy, data]);

  const invite = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    try {
      await browserApi(`${ENDPOINT}/invite`, {
        body: JSON.stringify({
          email: String(form.get("email") ?? "").trim(),
          name: String(form.get("name") ?? "").trim() || undefined,
        }),
        method: "POST",
      });
      formElement.reset();
      setInviting(false);
      setMessage("Invite sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The invite could not be sent.");
    }
  }, []);

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {/* When a hostel registers with this code and goes live, both hostels
          get extra plan time. */}
      <PortalPageHeader
        actions={
          data ? (
            <>
              <Button className="h-9 gap-2 rounded-xl" onClick={() => setInviting(true)} type="button" variant="outline">
                <Mail className="size-4" />
                Invite by email
              </Button>
              <RoleButton className="h-9 rounded-xl" onClick={() => void share()} tone="admin" type="button">
                <Share2 className="size-4" />
                Share
              </RoleButton>
            </>
          ) : undefined
        }
        description="Other hostels that join with your code earn you both extra plan time."
        title="Invite hostels"
      />
      {inviting ? null : <Message value={message || resource.message} />}
      {resource.state === "loading" ? <LoadingRows /> : null}

      {data ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Your referral code">
            {!data.enabled ? (
              <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[13px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                Hostel referrals are paused right now.
              </p>
            ) : null}
            <div className="rounded-2xl bg-role-team-soft p-5 text-center">
              <p className="font-mono text-3xl font-bold tracking-[0.2em] text-foreground">{data.code}</p>
              <p className="mt-2 break-all text-[12px] text-muted-foreground">{data.link}</p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-muted/60 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">They get</p>
                <p className="text-[13.5px] font-semibold text-foreground">{data.theyGet.text || "Nothing extra"}</p>
              </div>
              <div className="rounded-xl bg-muted/60 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">You get, per hostel</p>
                <p className="text-[13.5px] font-semibold text-foreground">{data.youGet.text || "Nothing extra"}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <ShareButton
                icon={MessageCircle}
                label="WhatsApp"
                onClick={() =>
                  window.open(`https://wa.me/?text=${encodeURIComponent(shareText(data))}`, "_blank", "noopener")
                }
              />
              <ShareButton icon={Copy} label="Copy link" onClick={() => copy(data.link, "Link copied.")} />
              <ShareButton icon={Copy} label="Copy code" onClick={() => copy(data.code, "Code copied.")} />
            </div>
          </Panel>

          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <MetricCard icon={Building2} label="Hostels joined" value={data.referrals.length} />
              <MetricCard
                icon={Clock}
                label="Waiting to go live"
                tone="slate"
                value={data.referrals.filter((referral) => referral.status === "PENDING").length}
              />
            </div>
            <Panel title="Hostels you invited">
              {data.referrals.length === 0 ? (
                <EmptyState label="No hostel has registered with your code yet." />
              ) : null}
              <div className="divide-y divide-border/60">
                {data.referrals.map((referral) => (
                  <div className="flex flex-wrap items-center gap-3 py-2.5" key={referral.id}>
                    <RowMark glyph="business" tone={referral.status === "LIVE" ? "brand" : "neutral"} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold text-foreground">{referral.hostelName}</p>
                      <p className="text-[12px] text-muted-foreground">Registered {referral.createdAt.slice(0, 10)}</p>
                    </div>
                    <SoftBadge tone={referral.status === "LIVE" ? "green" : "amber"}>
                      {referral.status === "PENDING"
                        ? "Waiting to go live"
                        : referral.rewardAdded
                          ? `${referral.rewardText || "Live"} added`
                          : "Live · adding your time"}
                    </SoftBadge>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      ) : null}

      <Dialog onOpenChange={setInviting} open={inviting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite by email</DialogTitle>
            <DialogDescription>We email them your code and link.</DialogDescription>
          </DialogHeader>
          <Message value={message} />
          <BusyForm className="grid gap-3" onSubmit={invite}>
            <Input label="Their name" name="name" placeholder="Optional" />
            <Input label="Email" name="email" placeholder="owner@example.com" required type="email" />
            <DialogFooter>
              <SubmitButton className="h-10 gap-2 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90">
                <Mail className="size-4" />
                Send invite
              </SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function ShareButton({
  icon: Icon,
  label,
  onClick,
  primary = false,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      className={
        primary
          ? "inline-flex h-9 items-center gap-2 rounded-xl bg-brand-teal px-3.5 text-[13px] font-semibold text-white"
          : "inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3.5 text-[13px] font-semibold text-foreground hover:bg-muted"
      }
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
