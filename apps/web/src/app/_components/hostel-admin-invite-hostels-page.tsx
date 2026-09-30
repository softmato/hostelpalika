"use client";

import { Copy, Mail, MessageCircle, Share2 } from "lucide-react";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { PortalPageHeader, SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { EmptyState, Input, LoadingRows, Panel } from "@/app/_components/shared-ui";
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
      setMessage("Invite sent.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The invite could not be sent.");
    }
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PortalPageHeader
        description="Share your hostel's code with other hostel owners. When a hostel registers with it and goes live, both hostels get extra plan time."
        title="Invite hostels"
      />
      <Message value={message || resource.message} />
      {resource.state === "loading" ? <LoadingRows /> : null}

      {data ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <Panel title="Your referral code">
            {!data.enabled ? (
              <p className="mb-3 text-sm text-muted-foreground">Hostel referrals are paused right now.</p>
            ) : null}
            <div className="rounded-xl bg-role-admin/10 p-5 text-center">
              <p className="font-mono text-3xl font-bold tracking-[0.2em] text-foreground">{data.code}</p>
              <p className="mt-2 break-all text-xs text-muted-foreground">{data.link}</p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">They get</p>
                <p className="font-semibold text-foreground">{data.theyGet.text || "Nothing extra"}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">You get, per hostel</p>
                <p className="font-semibold text-foreground">{data.youGet.text || "Nothing extra"}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <ShareButton icon={Share2} label="Share" onClick={() => void share()} primary />
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

          <Panel title="Invite by email">
            <BusyForm className="grid gap-3" onSubmit={invite}>
              <Input label="Their name" name="name" placeholder="Optional" />
              <Input label="Email" name="email" placeholder="owner@example.com" required type="email" />
              <SubmitButton className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-role-admin text-sm font-semibold text-white">
                <Mail className="size-4" />
                Send invite
              </SubmitButton>
            </BusyForm>
          </Panel>

          <div className="lg:col-span-2">
            <Panel title="Hostels you invited">
              {data.referrals.length === 0 ? (
                <EmptyState label="No hostel has registered with your code yet." />
              ) : null}
              <div className="divide-y divide-border">
                {data.referrals.map((referral) => (
                  <div className="flex flex-wrap items-center justify-between gap-3 py-3" key={referral.id}>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{referral.hostelName}</p>
                      <p className="text-xs text-muted-foreground">Registered {referral.createdAt.slice(0, 10)}</p>
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
          ? "inline-flex h-10 items-center gap-2 rounded-md bg-role-admin px-4 text-sm font-semibold text-white"
          : "inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-semibold text-foreground hover:bg-muted"
      }
      onClick={onClick}
      type="button"
    >
      <Icon className="size-4" />
      {label}
    </button>
  );
}
