"use client";

import { ChevronLeft, ChevronRight, Gift, HandCoins, Percent, Plus, Users } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  InitialsAvatar,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SoftBadge,
  TabBar,
  type SoftTone,
} from "@/app/_components/portal-dashboard-ui";
import { FactChip } from "@/app/_components/platform-page-ui";
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
  const [perkFormOpen, setPerkFormOpen] = useState(false);
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
        setPerkFormOpen(false);
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

  const openPerkForm = (perk: Perk | null) => {
    setEditing(perk);
    setPerkKind(perk?.kind ?? "FEE_OFF");
    setPerkFormOpen(true);
  };

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          data ? (
            <>
            <div className="flex items-center gap-1 rounded-xl border border-border">
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
            <RoleButton onClick={() => openPerkForm(null)} type="button">
              <Plus className="size-3.5" />
              New perk
            </RoleButton>
            </>
          ) : null
        }
        description="Each quarter, give certified residents a fee off or a gift."
        title="Resident Offer Program"
      />
      <Message value={message || resource.message} />

      {data ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard
            active={tab === "eligible"}
            icon={Users}
            label="Certified residents"
            onClick={() => setTab("eligible")}
            value={data.eligible.length}
          />
          <MetricCard
            active={tab === "awards"}
            icon={Gift}
            label="Offers this quarter"
            note={data.eligible.length > 0 ? `${Math.round((data.awards.length / data.eligible.length) * 100)}% of certified` : undefined}
            onClick={() => setTab("awards")}
            value={data.awards.length}
          />
          <MetricCard
            icon={HandCoins}
            label="We owe hostels"
            note={`${data.owedToHostels.count} to settle`}
            tone={data.owedToHostels.amount > 0 ? "amber" : "teal"}
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
                <div className="flex min-w-0 items-center gap-3">
                  <InitialsAvatar name={row.residentName} size="sm" tone="team" />
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-[13.5px] font-semibold text-foreground">
                      {row.residentName}
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        {row.hostelName}
                        {row.residentStatus !== "ACTIVE" ? ` · ${row.residentStatus.toLowerCase()}` : ""}
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <FactChip glyph="document-text">{`${row.bills} ${row.bills === 1 ? "bill" : "bills"}`}</FactChip>
                      <FactChip glyph="receipt">{`${row.certifiedCount} receipts`}</FactChip>
                      <FactChip glyph="cash">{currency(row.certifiedAmount)}</FactChip>
                    </div>
                  </div>
                </div>
                {row.award ? (
                  <SoftBadge tone={STATUS_TONE[row.award.status]}>{row.award.title}</SoftBadge>
                ) : activePerks.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Perk for ${row.residentName}`}
                      className="h-9 rounded-xl border border-border bg-background px-2 text-sm text-foreground"
                      onChange={(event) => setChoice((prev) => ({ ...prev, [row.residentId]: event.target.value }))}
                      value={choice[row.residentId] ?? activePerks[0].id}
                    >
                      {activePerks.map((perk) => (
                        <option key={perk.id} value={perk.id}>
                          {perk.title}
                        </option>
                      ))}
                    </select>
                    <RoleButton className="h-9" onClick={() => void give(row)} type="button">
                      <Gift className="size-3.5" />
                      Give offer
                    </RoleButton>
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
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-[13.5px] font-semibold text-foreground">
                    {award.title} · {award.residentName}
                    <span className="ml-1.5 font-normal text-muted-foreground">{award.hostelName}</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <FactChip glyph="gift">{perkTerms(award)}</FactChip>
                    {award.appliedAmount != null ? (
                      <FactChip glyph="cash">{`${currency(award.appliedAmount)} on ${award.appliedPeriod ?? "a bill"}`}</FactChip>
                    ) : null}
                    {award.hostelPaidAt ? (
                      <FactChip glyph="checkmark-circle" tone="brand">{`Settled ${award.hostelPaidAt.slice(0, 10)}`}</FactChip>
                    ) : null}
                  </div>
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
          <Panel title="Catalogue">
            {data.perks.length === 0 ? <EmptyState label="No perks yet. Add one from the header." /> : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.perks.map((perk) => (
                <div
                  className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  key={perk.id}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                      {perk.kind === "FEE_OFF" ? <Percent className="size-4" /> : <Gift className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-foreground">{perk.title}</p>
                      <p className="truncate text-[12.5px] text-muted-foreground">{perk.partner || "HostelPalika"}</p>
                    </div>
                    <SoftBadge tone={perk.isActive ? "green" : "slate"}>{perk.isActive ? "Live" : "Hidden"}</SoftBadge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <FactChip glyph="gift">{perkTerms(perk)}</FactChip>
                    {perk.giftValue ? <FactChip glyph="cash">{`Worth ${currency(perk.giftValue)}`}</FactChip> : null}
                  </div>
                  {perk.description ? <p className="line-clamp-2 text-[13px] text-muted-foreground">{perk.description}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <ActionButton label="Edit" onClick={() => openPerkForm(perk)} />
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
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          setPerkFormOpen(open);
          if (!open) setEditing(null);
        }}
        open={perkFormOpen}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.title}` : "New perk"}</DialogTitle>
            <DialogDescription>A fee off is paid by HostelPalika to the hostel; 100% is a free month.</DialogDescription>
          </DialogHeader>
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
              <div className="grid grid-cols-[1fr_110px] gap-3">
                <Input defaultValue={editing?.imageUrl} label="Image URL" name="imageUrl" placeholder="https://…" />
                <Input defaultValue={editing?.sortOrder ?? 0} hint="Lower first." label="Order" name="sortOrder" type="number" />
              </div>
              <DialogFooter>
                <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">
                  {editing ? "Save changes" : "Add perk"}
                </SubmitButton>
              </DialogFooter>
            </BusyForm>
        </DialogContent>
      </Dialog>
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
    <Button
      className={destructive ? "text-muted-foreground hover:text-destructive" : undefined}
      onClick={onClick}
      size="sm"
      type="button"
      variant={destructive ? "ghost" : "outline"}
    >
      {label}
    </Button>
  );
}
