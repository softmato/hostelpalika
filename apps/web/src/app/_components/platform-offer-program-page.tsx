"use client";

import { ChevronLeft, ChevronRight, Gift, HandCoins, Users } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  MetricCard,
  PortalPageHeader,
  SoftBadge,
  TabBar,
  type SoftTone,
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

const ENDPOINT = "/api/v1/platform/offer-program";

type Perk = {
  description: string;
  giftValue: number | null;
  id: string;
  imageUrl: string;
  isActive: boolean;
  kind: "FEE_OFF" | "GIFT";
  partner: string;
  percentOff: number | null;
  sortOrder: number;
  title: string;
};

type AwardStatus = "AWARDED" | "APPLIED" | "DELIVERED" | "CANCELLED";

type Award = {
  appliedAmount: number | null;
  appliedPeriod: string | null;
  awardedAt: string;
  hostelName: string;
  hostelPaidAt: string | null;
  id: string;
  kind: "FEE_OFF" | "GIFT";
  percentOff: number | null;
  residentName: string;
  status: AwardStatus;
  title: string;
};

type Eligible = {
  award: { id: string; status: AwardStatus; title: string } | null;
  bills: number;
  certifiedAmount: number;
  certifiedCount: number;
  hostelName: string;
  residentId: string;
  residentName: string;
  residentStatus: string;
};

type Overview = {
  awards: Award[];
  eligible: Eligible[];
  owedToHostels: { amount: number; count: number };
  perks: Perk[];
  quarter: {
    isCurrent: boolean;
    key: string;
    label: string;
    next: string | null;
    previous: string;
  };
};

const STATUS_TONE: Record<AwardStatus, SoftTone> = {
  APPLIED: "green",
  AWARDED: "amber",
  CANCELLED: "slate",
  DELIVERED: "green",
};

function perkTerms(perk: { kind: string; percentOff: number | null }) {
  return perk.kind === "FEE_OFF" ? `${perk.percentOff}% off next monthly fee` : "Gift";
}

function text(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}

/**
 * The Resident Offer Program, run by the platform owner. Superadmin only:
 * every award is HostelPalika's money or HostelPalika's gift.
 *
 * Each quarter lists residents with certified receipts, best record first. The
 * owner gives some of them a perk; a fee-off comes straight off the resident's
 * open monthly bill as a HostelPalika payment, and "HostelPalika owes hostels"
 * tracks what still has to be settled with the hostel.
 */
export const PlatformOfferProgramPageContent = memo(function PlatformOfferProgramPageContent() {
  const [quarter, setQuarter] = useState<string | null>(null);
  const [tab, setTab] = useState<"eligible" | "awards" | "perks">("eligible");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Perk | null>(null);
  const [perkKind, setPerkKind] = useState<"FEE_OFF" | "GIFT">("FEE_OFF");
  const [choice, setChoice] = useState<Record<string, string>>({});
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();

  const url = quarter ? `${ENDPOINT}?quarter=${quarter}` : ENDPOINT;
  const resource = usePortalResource<Overview>(url, {
    errorMessage: "Could not load the Offer Program.",
  });
  const data = resource.data;
  const activePerks = useMemo(() => (data?.perks ?? []).filter((perk) => perk.isActive), [data]);

  const refresh = useCallback(() => {
    invalidate(url);
    invalidate(ENDPOINT);
  }, [invalidate, url]);

  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      try {
        await action();
        setMessage(done);
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Something went wrong.");
      }
    },
    [refresh],
  );

  const give = useCallback(
    async (row: Eligible) => {
      const perk = activePerks.find((item) => item.id === (choice[row.residentId] ?? activePerks[0]?.id));

      if (!perk || !data) {
        return;
      }

      const ok = await confirm({
        actionLabel: "Give offer",
        description:
          perk.kind === "FEE_OFF"
            ? `${row.residentName} (${row.hostelName}) gets ${perk.percentOff}% off their next monthly fee, paid by HostelPalika to the hostel. If a bill is open it is paid now. They are told by app and email.`
            : `${row.residentName} (${row.hostelName}) gets "${perk.title}". They are told by app and email; mark it delivered once handed over.`,
        title: `Give "${perk.title}" for ${data.quarter.label}?`,
      });

      if (ok) {
        await run(
          () =>
            browserApi(`${ENDPOINT}/awards`, {
              body: JSON.stringify({ perkId: perk.id, quarter: data.quarter.key, residentId: row.residentId }),
              method: "POST",
            }),
          `Offer given to ${row.residentName}.`,
        );
      }
    },
    [activePerks, choice, confirm, data, run],
  );

  const act = useCallback(
    async (award: Award, action: "cancel" | "deliver" | "hostel-paid") => {
      if (action === "cancel") {
        const ok = await confirm({
          actionLabel: "Cancel offer",
          description: `${award.residentName} keeps nothing from "${award.title}". They are not told automatically.`,
          title: "Cancel this offer?",
          tone: "destructive",
        });

        if (!ok) {
          return;
        }
      }

      await run(
        () =>
          browserApi(`${ENDPOINT}/awards/${award.id}`, {
            body: JSON.stringify({ action }),
            method: "PATCH",
          }),
        action === "deliver" ? "Marked delivered." : action === "hostel-paid" ? "Marked paid to hostel." : "Offer cancelled.",
      );
    },
    [confirm, run],
  );

  const savePerk = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const kind = text(form, "kind") as Perk["kind"];
      const payload = {
        description: text(form, "description"),
        imageUrl: text(form, "imageUrl"),
        kind,
        partner: text(form, "partner"),
        sortOrder: Number(text(form, "sortOrder") || 0),
        title: text(form, "title"),
        ...(kind === "FEE_OFF"
          ? { percentOff: Number(text(form, "percentOff")) }
          : { giftValue: text(form, "giftValue") ? Number(text(form, "giftValue")) : null, percentOff: null }),
      };

      await run(async () => {
        await browserApi(editing ? `${ENDPOINT}/perks/${editing.id}` : `${ENDPOINT}/perks`, {
          body: JSON.stringify(payload),
          method: editing ? "PATCH" : "POST",
        });
        formElement.reset();
        setEditing(null);
      }, editing ? "Perk updated." : "Perk added.");
    },
    [editing, run],
  );

  const removePerk = useCallback(
    async (perk: Perk) => {
      const ok = await confirm({
        actionLabel: "Delete perk",
        description: `"${perk.title}" leaves the catalogue. Offers already given keep their own copy.`,
        title: "Delete this perk?",
        tone: "destructive",
      });

      if (ok) {
        await run(() => browserApi(`${ENDPOINT}/perks/${perk.id}`, { method: "DELETE" }), "Perk deleted.");
      }
    },
    [confirm, run],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          data ? (
            <div className="flex items-center gap-1 rounded-md border border-border">
              <button
                aria-label="Previous quarter"
                className="p-2 text-muted-foreground hover:text-foreground"
                onClick={() => setQuarter(data.quarter.previous)}
                type="button"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="min-w-44 text-center text-sm font-semibold text-foreground">
                {data.quarter.label}
              </span>
              <button
                aria-label="Next quarter"
                className="p-2 text-muted-foreground hover:text-foreground disabled:opacity-30"
                disabled={!data.quarter.next}
                onClick={() => setQuarter(data.quarter.next)}
                type="button"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          ) : null
        }
        description="Residents whose payments quoted their reference code and were verified. Each quarter, give some of them a fee off or a gift from HostelPalika."
        title="Resident Offer Program"
      />
      <Message value={message || resource.message} />

      {data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={Users} label="Certified residents" tone="green" value={data.eligible.length} />
          <MetricCard icon={Gift} label="Offers this quarter" value={data.awards.length} />
          <MetricCard
            icon={HandCoins}
            label="HostelPalika owes hostels"
            note={`${data.owedToHostels.count} fee-off payments to settle`}
            tone="amber"
            value={currency(data.owedToHostels.amount)}
          />
        </div>
      ) : null}

      <TabBar
        onChange={(key) => setTab(key as typeof tab)}
        tabs={[
          { key: "eligible", label: "Certified residents" },
          { key: "awards", label: "Offers given" },
          { key: "perks", label: "Perks" },
        ]}
        tone="platform"
        value={tab}
      />

      {resource.state === "loading" ? <LoadingRows /> : null}

      {data && tab === "eligible" ? (
        <Panel title={`Certified in ${data.quarter.label}`}>
          {data.eligible.length === 0 ? (
            <EmptyState label="No certified receipts this quarter yet." />
          ) : activePerks.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">Add an active perk before giving offers.</p>
          ) : null}
          <div className="divide-y divide-border">
            {data.eligible.map((row) => (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3" key={row.residentId}>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">{row.residentName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.hostelName}
                    {row.residentStatus !== "ACTIVE" ? ` · ${row.residentStatus.toLowerCase()}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                    {row.bills} {row.bills === 1 ? "bill" : "bills"} · {row.certifiedCount} receipts ·{" "}
                    {currency(row.certifiedAmount)}
                  </p>
                </div>
                {row.award ? (
                  <SoftBadge tone={STATUS_TONE[row.award.status]}>{row.award.title}</SoftBadge>
                ) : activePerks.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Perk for ${row.residentName}`}
                      className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      onChange={(event) => setChoice((prev) => ({ ...prev, [row.residentId]: event.target.value }))}
                      value={choice[row.residentId] ?? activePerks[0].id}
                    >
                      {activePerks.map((perk) => (
                        <option key={perk.id} value={perk.id}>
                          {perk.title}
                        </option>
                      ))}
                    </select>
                    <button
                      className="h-9 rounded-md bg-role-platform px-3 text-xs font-semibold text-white"
                      onClick={() => void give(row)}
                      type="button"
                    >
                      Give offer
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {data && tab === "awards" ? (
        <Panel title={`Offers for ${data.quarter.label}`}>
          {data.awards.length === 0 ? <EmptyState label="No offers given this quarter." /> : null}
          <div className="divide-y divide-border">
            {data.awards.map((award) => (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3" key={award.id}>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">
                    {award.title} · {award.residentName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {award.hostelName} · {perkTerms(award)}
                    {award.appliedAmount != null
                      ? ` · ${currency(award.appliedAmount)} paid on ${award.appliedPeriod ?? "a bill"}`
                      : ""}
                    {award.hostelPaidAt ? ` · settled with hostel ${award.hostelPaidAt.slice(0, 10)}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SoftBadge tone={STATUS_TONE[award.status]}>
                    {award.status === "AWARDED" && award.kind === "FEE_OFF" ? "Waiting for next bill" : award.status.toLowerCase()}
                  </SoftBadge>
                  {award.kind === "GIFT" && award.status === "AWARDED" ? (
                    <ActionButton label="Mark delivered" onClick={() => void act(award, "deliver")} />
                  ) : null}
                  {award.status === "APPLIED" && !award.hostelPaidAt ? (
                    <ActionButton label="Mark paid to hostel" onClick={() => void act(award, "hostel-paid")} />
                  ) : null}
                  {award.status === "AWARDED" ? (
                    <ActionButton destructive label="Cancel" onClick={() => void act(award, "cancel")} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {data && tab === "perks" ? (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Catalogue">
            {data.perks.length === 0 ? <EmptyState label="No perks yet. Add one on the right." /> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {data.perks.map((perk) => (
                <div className="rounded-lg border border-border p-4" key={perk.id}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-foreground">{perk.title}</p>
                    <SoftBadge tone={perk.isActive ? "green" : "slate"}>{perk.isActive ? "Live" : "Hidden"}</SoftBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {perkTerms(perk)} · {perk.partner}
                    {perk.giftValue ? ` · worth ${currency(perk.giftValue)}` : ""}
                  </p>
                  {perk.description ? <p className="mt-2 text-sm text-muted-foreground">{perk.description}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ActionButton label="Edit" onClick={() => { setEditing(perk); setPerkKind(perk.kind); }} />
                    <ActionButton
                      label={perk.isActive ? "Hide" : "Make live"}
                      onClick={() =>
                        void run(
                          () =>
                            browserApi(`${ENDPOINT}/perks/${perk.id}`, {
                              body: JSON.stringify({ isActive: !perk.isActive }),
                              method: "PATCH",
                            }),
                          perk.isActive ? "Perk hidden." : "Perk is live.",
                        )
                      }
                    />
                    <ActionButton destructive label="Delete" onClick={() => void removePerk(perk)} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={editing ? `Edit ${editing.title}` : "New perk"}>
            <BusyForm className="grid gap-3" key={editing?.id ?? "new"} onSubmit={savePerk}>
              <Input defaultValue={editing?.title} label="Title" name="title" placeholder="Next month 50% off" required />
              <Select
                label="Kind"
                name="kind"
                onChange={(event) => setPerkKind(event.target.value as Perk["kind"])}
                value={perkKind}
              >
                <option value="FEE_OFF">Fee off — next monthly fee</option>
                <option value="GIFT">Gift from HostelPalika</option>
              </Select>
              {perkKind === "FEE_OFF" ? (
                <Input
                  defaultValue={editing?.percentOff ?? 50}
                  hint="Share of the next monthly fee HostelPalika pays. 100 is a free month."
                  label="Percent off"
                  max="100"
                  min="1"
                  name="percentOff"
                  required
                  type="number"
                />
              ) : (
                <Input
                  defaultValue={editing?.giftValue ?? ""}
                  hint="Optional. Shown on the listing."
                  label="Worth (NPR)"
                  min="0"
                  name="giftValue"
                  type="number"
                />
              )}
              <Input defaultValue={editing?.partner} hint="Blank means HostelPalika." label="Given by" name="partner" />
              <TextArea defaultValue={editing?.description} label="Description" name="description" placeholder="What it is and how the resident gets it." />
              <Input defaultValue={editing?.imageUrl} label="Image URL" name="imageUrl" placeholder="https://…" />
              <Input defaultValue={editing?.sortOrder ?? 0} hint="Lower shows first." label="Order" name="sortOrder" type="number" />
              <div className="flex gap-2">
                <SubmitButton className="inline-flex h-11 flex-1 items-center justify-center rounded-md bg-role-platform text-sm font-semibold text-white">
                  {editing ? "Save changes" : "Add perk"}
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
    </div>
  );
});

function ActionButton({
  destructive = false,
  label,
  onClick,
}: {
  destructive?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`rounded-md border border-border px-3 py-1.5 text-xs font-semibold transition hover:bg-muted ${
        destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground"
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
