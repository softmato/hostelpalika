"use client";

import { Copy, HandCoins, Link2, Users } from "lucide-react";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  SoftBadge,
  TabBar,
  ToggleSwitch,
} from "@/app/_components/portal-dashboard-ui";
import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  Select,
  TextArea,
  currency,
} from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

const ENDPOINT = "/api/v1/platform/hostel-referrals";

type Bonus = { days: number; months: number };

type PartnerCode = {
  code: string;
  commissionType: "AMOUNT" | "PERCENT";
  commissionValue: number;
  contact: string;
  id: string;
  link: string;
  name: string;
  note: string;
  offerDays: number;
  offerMonths: number;
  stats: { commission: number; live: number; paid: number; registered: number };
  status: "ACTIVE" | "INACTIVE";
};

type Referral = {
  code: string;
  commission: { amount: number; paidAt: string | null; status: "NONE" | "EARNED" | "PAID" };
  createdAt: string;
  from: string;
  hostelName: string;
  id: string;
  kind: "HOSTEL" | "PARTNER";
  liveAt: string | null;
  refereeReward: string;
  referrerReward: string;
  status: "PENDING" | "LIVE";
};

type Overview = {
  partnerCodes: PartnerCode[];
  referrals: Referral[];
  settings: { enabled: boolean; referee: Bonus; referrer: Bonus };
  totals: { commissionOwed: number; live: number; registered: number };
};

function text(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

function bonusText(months: number, days: number) {
  const parts = [
    months ? `${months} ${months === 1 ? "month" : "months"}` : "",
    days ? `${days} ${days === 1 ? "day" : "days"}` : "",
  ].filter(Boolean);

  return parts.length ? parts.join(" and ") : "Nothing extra";
}

function commissionText(code: Pick<PartnerCode, "commissionType" | "commissionValue">) {
  return code.commissionType === "PERCENT"
    ? `${code.commissionValue}% of the plan price`
    : `${currency(code.commissionValue)} per hostel`;
}

/**
 * Referral settings — superadmin only.
 *
 * Every hostel has its own code (made when its staff open Invite hostels);
 * the rewards for those are the "Hostel program" tab. Partner codes are issued
 * here to marketers: each carries its own offer for the new hostel and the
 * commission the partner earns once that hostel goes live.
 */
export const PlatformReferralsPageContent = memo(function PlatformReferralsPageContent() {
  const [tab, setTab] = useState<"referrals" | "partners" | "program">("referrals");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<PartnerCode | null>(null);
  const [commissionType, setCommissionType] = useState<"AMOUNT" | "PERCENT">("AMOUNT");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();

  const resource = usePortalResource<Overview>(ENDPOINT, {
    errorMessage: "Could not load referral settings.",
  });
  const data = resource.data;

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      try {
        await action();
        setMessage(done);
        invalidate(ENDPOINT);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Something went wrong.");
      }
    },
    [invalidate],
  );

  const copy = useCallback((value: string) => {
    void navigator.clipboard.writeText(value).then(() => setMessage("Copied."));
  }, []);

  const saveCode = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const payload = {
        commissionType: text(form, "commissionType"),
        commissionValue: Number(text(form, "commissionValue") || 0),
        contact: text(form, "contact"),
        name: text(form, "name"),
        note: text(form, "note"),
        offerDays: Number(text(form, "offerDays") || 0),
        offerMonths: Number(text(form, "offerMonths") || 0),
        ...(editing ? {} : { code: text(form, "code") || undefined }),
      };

      await run(async () => {
        await browserApi(editing ? `${ENDPOINT}/codes/${editing.id}` : `${ENDPOINT}/codes`, {
          body: JSON.stringify(payload),
          method: editing ? "PATCH" : "POST",
        });
        formElement.reset();
        setEditing(null);
      }, editing ? "Partner code updated." : "Partner code issued.");
    },
    [editing, run],
  );

  const saveProgram = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);

      await run(
        () =>
          browserApi(ENDPOINT, {
            body: JSON.stringify({
              enabled: enabled ?? data?.settings.enabled ?? true,
              referee: {
                days: Number(text(form, "refereeDays") || 0),
                months: Number(text(form, "refereeMonths") || 0),
              },
              referrer: {
                days: Number(text(form, "referrerDays") || 0),
                months: Number(text(form, "referrerMonths") || 0),
              },
            }),
            method: "PUT",
          }),
        "Hostel program saved.",
      );
    },
    [data, enabled, run],
  );

  const markPaid = useCallback(
    async (referral: Referral) => {
      const ok = await confirm({
        actionLabel: "Mark paid",
        description: `${currency(referral.commission.amount)} to ${referral.from} for ${referral.hostelName}.`,
        title: "Commission paid out?",
      });

      if (ok) {
        await run(
          () => browserApi(`${ENDPOINT}/${referral.id}`, { method: "PATCH" }),
          "Commission marked paid.",
        );
      }
    },
    [confirm, run],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        description="Hostels that registered with another hostel's code or a partner's code, the partner codes you issue for marketing, and what each side gets."
        title="Referral settings"
      />
      <Message value={message || resource.message} />

      {data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Users} label="Registered with a code" value={data.totals.registered} />
          <MetricCard icon={Link2} label="Live" tone="green" value={data.totals.live} />
          <MetricCard
            icon={HandCoins}
            label="Commission owed"
            tone="amber"
            value={currency(data.totals.commissionOwed)}
          />
        </div>
      ) : null}

      <TabBar
        onChange={(key) => setTab(key as typeof tab)}
        tabs={[
          { key: "referrals", label: "Referrals" },
          { key: "partners", label: "Partner codes" },
          { key: "program", label: "Hostel program" },
        ]}
        tone="platform"
        value={tab}
      />

      {resource.state === "loading" ? <LoadingRows /> : null}

      {data && tab === "referrals" ? (
        <Panel title="Hostels registered with a code">
          {data.referrals.length === 0 ? <EmptyState label="No hostel has used a code yet." /> : null}
          <div className="divide-y divide-border">
            {data.referrals.map((referral) => (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3" key={referral.id}>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">{referral.hostelName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {referral.kind === "PARTNER" ? "Partner" : "Hostel"} · {referral.from} · {referral.code} ·{" "}
                    {referral.createdAt.slice(0, 10)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    New hostel gets {referral.refereeReward || "nothing extra"}
                    {referral.kind === "HOSTEL" ? ` · referrer gets ${referral.referrerReward || "nothing extra"}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SoftBadge tone={referral.status === "LIVE" ? "green" : "amber"}>
                    {referral.status === "LIVE" ? "Live" : "Waiting to go live"}
                  </SoftBadge>
                  {referral.commission.status !== "NONE" ? (
                    <SoftBadge tone={referral.commission.status === "PAID" ? "green" : "amber"}>
                      {currency(referral.commission.amount)}{" "}
                      {referral.commission.status === "PAID" ? "paid" : "owed"}
                    </SoftBadge>
                  ) : null}
                  {referral.commission.status === "EARNED" ? (
                    <ActionButton label="Mark paid" onClick={() => void markPaid(referral)} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {data && tab === "partners" ? (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Partner codes">
            {data.partnerCodes.length === 0 ? (
              <EmptyState label="No partner codes yet. Issue one on the right." />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {data.partnerCodes.map((code) => (
                <div className="rounded-lg border border-border p-4" key={code.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{code.name}</p>
                      <p className="font-mono text-sm tracking-wide text-foreground">{code.code}</p>
                    </div>
                    <SoftBadge tone={code.status === "ACTIVE" ? "green" : "slate"}>
                      {code.status === "ACTIVE" ? "Active" : "Paused"}
                    </SoftBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Hostel gets {bonusText(code.offerMonths, code.offerDays).toLowerCase()} · partner earns{" "}
                    {commissionText(code)}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    {code.stats.registered} registered · {code.stats.live} live ·{" "}
                    {currency(code.stats.commission - code.stats.paid)} owed · {currency(code.stats.paid)} paid
                  </p>
                  {code.contact ? <p className="mt-1 text-xs text-muted-foreground">{code.contact}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ActionButton icon label="Copy link" onClick={() => copy(code.link)} />
                    <ActionButton
                      label="Edit"
                      onClick={() => {
                        setEditing(code);
                        setCommissionType(code.commissionType);
                      }}
                    />
                    <ActionButton
                      label={code.status === "ACTIVE" ? "Pause" : "Activate"}
                      onClick={() =>
                        void run(
                          () =>
                            browserApi(`${ENDPOINT}/codes/${code.id}`, {
                              body: JSON.stringify({
                                status: code.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                              }),
                              method: "PATCH",
                            }),
                          code.status === "ACTIVE" ? "Code paused." : "Code is active.",
                        )
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={editing ? `Edit ${editing.code}` : "Issue a partner code"}>
            <BusyForm className="grid gap-3" key={editing?.id ?? "new"} onSubmit={saveCode}>
              <Input defaultValue={editing?.name} label="Partner name" name="name" placeholder="Ram Sharma" required />
              {editing ? null : (
                <Input
                  hint="Leave blank to make one from the name."
                  label="Code"
                  name="code"
                  placeholder="RAM2026"
                />
              )}
              <Input defaultValue={editing?.contact} label="Phone or email" name="contact" />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  defaultValue={editing?.offerMonths ?? 1}
                  label="Hostel gets months"
                  max="24"
                  min="0"
                  name="offerMonths"
                  type="number"
                />
                <Input
                  defaultValue={editing?.offerDays ?? 0}
                  label="and days"
                  max="365"
                  min="0"
                  name="offerDays"
                  type="number"
                />
              </div>
              <Select
                label="Commission"
                name="commissionType"
                onChange={(event) => setCommissionType(event.target.value as "AMOUNT" | "PERCENT")}
                value={commissionType}
              >
                <option value="AMOUNT">Fixed amount per hostel</option>
                <option value="PERCENT">Percent of the plan price</option>
              </Select>
              <Input
                defaultValue={editing?.commissionValue ?? 0}
                hint={
                  commissionType === "PERCENT"
                    ? "Of one billing cycle of the plan the hostel chose. Paid once it goes live."
                    : "Rupees, once the hostel goes live."
                }
                label={commissionType === "PERCENT" ? "Percent" : "Amount (NPR)"}
                max={commissionType === "PERCENT" ? "100" : undefined}
                min="0"
                name="commissionValue"
                type="number"
              />
              <TextArea defaultValue={editing?.note} label="Note" name="note" placeholder="Campaign, city, bank details…" />
              <div className="flex gap-2">
                <SubmitButton className="inline-flex h-11 flex-1 items-center justify-center rounded-md bg-role-platform text-sm font-semibold text-white">
                  {editing ? "Save changes" : "Issue code"}
                </SubmitButton>
                {editing ? (
                  <button
                    className="h-11 rounded-md border border-border px-4 text-sm font-semibold text-foreground"
                    onClick={() => setEditing(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </BusyForm>
          </Panel>
        </div>
      ) : null}

      {data && tab === "program" ? (
        <Panel title="Hostel invites hostel">
          <BusyForm className="grid max-w-xl gap-4" onSubmit={saveProgram}>
            <ToggleSwitch
              checked={enabled ?? data.settings.enabled}
              description="Every hostel's owner and wardens can share their hostel's code. Paused, the codes stop working at registration."
              label="Hostel referral codes are on"
              onChange={setEnabled}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                defaultValue={data.settings.referee.months}
                label="New hostel gets months"
                max="24"
                min="0"
                name="refereeMonths"
                type="number"
              />
              <Input
                defaultValue={data.settings.referee.days}
                label="and days"
                max="365"
                min="0"
                name="refereeDays"
                type="number"
              />
              <Input
                defaultValue={data.settings.referrer.months}
                label="Inviting hostel gets months"
                max="24"
                min="0"
                name="referrerMonths"
                type="number"
              />
              <Input
                defaultValue={data.settings.referrer.days}
                label="and days"
                max="365"
                min="0"
                name="referrerDays"
                type="number"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Added to each hostel&apos;s plan once the new hostel goes live. A change here applies to hostels that
              register from now on.
            </p>
            <SubmitButton className="inline-flex h-11 items-center justify-center rounded-md bg-role-platform px-5 text-sm font-semibold text-white">
              Save
            </SubmitButton>
          </BusyForm>
        </Panel>
      ) : null}
    </div>
  );
});

function ActionButton({ icon = false, label, onClick }: { icon?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
      onClick={onClick}
      type="button"
    >
      {icon ? <Copy className="size-3.5" /> : null}
      {label}
    </button>
  );
}
