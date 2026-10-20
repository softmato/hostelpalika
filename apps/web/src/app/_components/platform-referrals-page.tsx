"use client";

import { Copy, HandCoins, Link2, Plus, Users } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { FactChip, ShareBar } from "@/app/_components/platform-page-ui";
import {
  InitialsAvatar,
  MetricCard,
  PortalPageHeader,
  RoleButton,
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [codeFormOpen, setCodeFormOpen] = useState(false);
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
        setCodeFormOpen(false);
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

  const openCodeForm = (code: PartnerCode | null) => {
    setEditing(code);
    setCommissionType(code?.commissionType ?? "AMOUNT");
    setCodeFormOpen(true);
  };

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          <RoleButton
            onClick={() => {
              setTab("partners");
              openCodeForm(null);
            }}
            type="button"
          >
            <Plus className="size-3.5" />
            Issue partner code
          </RoleButton>
        }
        description="Hostels that joined with a code, the partner codes you issue, and what each side gets."
        title="Referral settings"
      />
      <Message value={message || resource.message} />

      {data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Users} label="Joined with a code" value={data.totals.registered} />
          <MetricCard
            icon={Link2}
            label="Live"
            note={data.totals.registered > 0 ? `${Math.round((data.totals.live / data.totals.registered) * 100)}% of joined` : undefined}
            value={data.totals.live}
          />
          <MetricCard
            icon={HandCoins}
            label="Commission owed"
            tone={data.totals.commissionOwed > 0 ? "amber" : "teal"}
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
                <div className="flex min-w-0 items-center gap-3">
                  <InitialsAvatar name={referral.hostelName} size="sm" tone="team" />
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-[13.5px] font-semibold text-foreground">
                      {referral.hostelName}
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        via {referral.from} · {referral.createdAt.slice(0, 10)}
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <FactChip glyph={referral.kind === "PARTNER" ? "briefcase" : "business"}>{`${referral.kind === "PARTNER" ? "Partner" : "Hostel"} · ${referral.code}`}</FactChip>
                      <FactChip glyph="gift">{`New hostel: ${referral.refereeReward || "nothing extra"}`}</FactChip>
                      {referral.kind === "HOSTEL" ? (
                        <FactChip glyph="gift">{`Referrer: ${referral.referrerReward || "nothing extra"}`}</FactChip>
                      ) : null}
                    </div>
                  </div>
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
          <Panel title="Partner codes">
            {data.partnerCodes.length === 0 ? (
              <EmptyState label="No partner codes yet. Issue one from the header." />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.partnerCodes.map((code) => (
                <div
                  className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  key={code.id}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold text-foreground">{code.name}</p>
                      <p className="font-mono text-[13px] tracking-wide text-role-team">{code.code}</p>
                    </div>
                    <SoftBadge tone={code.status === "ACTIVE" ? "green" : "slate"}>
                      {code.status === "ACTIVE" ? "Active" : "Paused"}
                    </SoftBadge>
                  </div>
                  <ShareBar label="live" part={code.stats.live} total={code.stats.registered} />
                  <div className="flex flex-wrap gap-1.5">
                    <FactChip glyph="gift">{`Hostel gets ${bonusText(code.offerMonths, code.offerDays).toLowerCase()}`}</FactChip>
                    <FactChip glyph="hand-coins">{`Earns ${commissionText(code)}`}</FactChip>
                    <FactChip glyph="time" tone={code.stats.commission - code.stats.paid > 0 ? "amber" : "neutral"}>
                      {`${currency(code.stats.commission - code.stats.paid)} owed`}
                    </FactChip>
                    <FactChip glyph="checkmark-circle">{`${currency(code.stats.paid)} paid`}</FactChip>
                    {code.contact ? <FactChip glyph="call">{code.contact}</FactChip> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ActionButton icon label="Copy link" onClick={() => copy(code.link)} />
                    <ActionButton label="Edit" onClick={() => openCodeForm(code)} />
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
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          setCodeFormOpen(open);
          if (!open) setEditing(null);
        }}
        open={codeFormOpen}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.code}` : "Issue a partner code"}</DialogTitle>
            <DialogDescription>Commission is paid once the hostel goes live.</DialogDescription>
          </DialogHeader>
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
                hint={commissionType === "PERCENT" ? "Of one billing cycle of the chosen plan." : undefined}
                label={commissionType === "PERCENT" ? "Percent" : "Amount (NPR)"}
                max={commissionType === "PERCENT" ? "100" : undefined}
                min="0"
                name="commissionValue"
                type="number"
              />
              <TextArea defaultValue={editing?.note} label="Note" name="note" placeholder="Campaign, city, bank details…" />
              <DialogFooter>
                <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">
                  {editing ? "Save changes" : "Issue code"}
                </SubmitButton>
              </DialogFooter>
            </BusyForm>
        </DialogContent>
      </Dialog>

      {data && tab === "program" ? (
        <Panel title="Hostel invites hostel">
          <BusyForm className="grid max-w-xl gap-4" onSubmit={saveProgram}>
            <ToggleSwitch
              checked={enabled ?? data.settings.enabled}
              description="Owners and wardens share their hostel's code; paused, codes stop working."
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
            <p className="text-[12.5px] text-muted-foreground">Added once the new hostel goes live; applies to new registrations.</p>
            <div>
              <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">Save</SubmitButton>
            </div>
          </BusyForm>
        </Panel>
      ) : null}
    </div>
  );
});

function ActionButton({ icon = false, label, onClick }: { icon?: boolean; label: string; onClick: () => void }) {
  return (
    <Button onClick={onClick} size="sm" type="button" variant="outline">
      {icon ? <Copy className="size-3.5" /> : null}
      {label}
    </Button>
  );
}
