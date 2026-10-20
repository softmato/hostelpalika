"use client";

import { Pencil, Wallet } from "@/components/icons";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { toast } from "@/stores/toast-store";

import { FactChip } from "./platform-page-ui";
import { shortDate } from "./platform-team-types";
import { EmptyState, Panel } from "./shared-ui";

type TeamWallet = {
  agentId: string;
  balance: number;
  earned: number;
  email: string;
  lastPayoutAt: string | null;
  name: string;
  paidOut: number;
};

const METHODS = ["CASH", "BANK", "ESEWA", "KHALTI", "OTHER"] as const;
const INPUT =
  "mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-role-team";

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function PayDialog({
  onClose,
  onPaid,
  wallet,
}: {
  onClose: () => void;
  onPaid: () => void;
  wallet: TeamWallet;
}) {
  const [amount, setAmount] = useState(String(wallet.balance));
  const [method, setMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);

    try {
      await browserApi(`/api/v1/platform/team/wallets/${wallet.agentId}`, {
        body: JSON.stringify({ amount: Number(amount), method, note, reference }),
        method: "POST",
      });
      toast.success({ title: `Paid ${rupees(Number(amount))} to ${wallet.name}` });
      onPaid();
    } catch (error) {
      toast.error({ description: errorText(error), title: "Payout not recorded" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pay {wallet.name}</DialogTitle>
          <DialogDescription>Wallet balance {rupees(wallet.balance)}.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          <label className="block text-xs font-semibold text-foreground">
            Amount (Rs)
            <input
              className={INPUT}
              max={wallet.balance}
              min={0.01}
              onChange={(event) => setAmount(event.target.value)}
              required
              step="0.01"
              type="number"
              value={amount}
            />
          </label>
          <label className="block text-xs font-semibold text-foreground">
            Paid by
            <select
              className={INPUT}
              onChange={(event) => setMethod(event.target.value as (typeof METHODS)[number])}
              value={method}
            >
              {METHODS.map((option) => (
                <option key={option} value={option}>
                  {option.charAt(0) + option.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-foreground">
            Reference <span className="font-normal text-muted-foreground">(optional)</span>
            <input className={INPUT} maxLength={120} onChange={(event) => setReference(event.target.value)} value={reference} />
          </label>
          <label className="block text-xs font-semibold text-foreground">
            Note <span className="font-normal text-muted-foreground">(optional)</span>
            <input className={INPUT} maxLength={300} onChange={(event) => setNote(event.target.value)} value={note} />
          </label>
          <button
            className="h-10 w-full rounded-lg bg-brand-teal text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60"
            disabled={saving}
            type="submit"
          >
            {saving ? "Recording…" : "Record payout"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Field-team commission: the rate every new registration earns, what each
 * member has earned and been paid, and the button that pays them.
 */
export function TeamCommissionPanel() {
  const resource = usePortalResource<{
    ratePercent: number;
    setupFee: number;
    wallets: TeamWallet[];
  }>("/api/v1/platform/team/wallets");
  const wallets = resource.data?.wallets ?? [];
  const savedRate = resource.data?.ratePercent ?? null;
  const savedFee = resource.data?.setupFee ?? null;
  const [rateDraft, setRateDraft] = useState<string | null>(null);
  const [feeDraft, setFeeDraft] = useState<string | null>(null);
  const rate = rateDraft ?? (savedRate === null ? "" : String(savedRate));
  const fee = feeDraft ?? (savedFee === null ? "" : String(savedFee));
  const [savingRate, setSavingRate] = useState(false);
  const [editingRate, setEditingRate] = useState(false);
  const [paying, setPaying] = useState<TeamWallet | null>(null);

  async function saveRate(event: FormEvent) {
    event.preventDefault();
    setSavingRate(true);

    try {
      await browserApi("/api/v1/platform/operations-config", {
        body: JSON.stringify({ teamCommissionPercent: Number(rate), teamSetupFee: Number(fee) }),
        method: "PUT",
      });
      setRateDraft(null);
      setFeeDraft(null);
      setEditingRate(false);
      resource.refresh();
      toast.success({ title: `Setup fee ${rupees(Number(fee))}, commission ${rate}%` });
    } catch (error) {
      toast.error({ description: errorText(error), title: "Rate not saved" });
    } finally {
      setSavingRate(false);
    }
  }

  const owed = wallets.reduce((sum, wallet) => sum + wallet.balance, 0);

  return (
    <Panel
      action={
        <Button onClick={() => setEditingRate(true)} size="sm" type="button" variant="outline">
          <Pencil className="size-3.5" />
          Edit
        </Button>
      }
      title="Commission"
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        <FactChip glyph="receipt">{`Setup fee ${rupees(savedFee ?? 0)}`}</FactChip>
        <FactChip glyph="percent">{`${savedRate ?? 0}% to the agent`}</FactChip>
        <FactChip glyph="wallet" tone="brand">
          {`Agent gets ${rupees(Math.round((savedFee ?? 0) * (savedRate ?? 0)) / 100)}`}
        </FactChip>
        <FactChip glyph="time" tone={owed > 0 ? "amber" : "neutral"}>{`${rupees(owed)} to pay out`}</FactChip>
      </div>

      <Dialog onOpenChange={setEditingRate} open={editingRate}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Commission</DialogTitle>
            <DialogDescription>A percent of the fee, credited when it clears; the fee is the most an agent may collect.</DialogDescription>
          </DialogHeader>
        <form className="space-y-3" onSubmit={saveRate}>
          <label className="block text-xs font-semibold text-foreground">
            Setup fee (Rs)
            <input
              className={INPUT}
              max={100000}
              min={0}
              onChange={(event) => setFeeDraft(event.target.value)}
              required
              step="1"
              type="number"
              value={fee}
            />
          </label>
          <label className="block text-xs font-semibold text-foreground">
            Rate (%)
            <input
              className={INPUT}
              max={100}
              min={0}
              onChange={(event) => setRateDraft(event.target.value)}
              required
              step="0.01"
              type="number"
              value={rate}
            />
          </label>
          <p className="text-[12px] text-muted-foreground">
            The agent gets {rupees(Math.round((Number(fee) || 0) * (Number(rate) || 0)) / 100)} of each fee.
          </p>
          <button
            className="h-10 w-full rounded-lg bg-brand-teal text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
            disabled={savingRate || (Number(rate) === savedRate && Number(fee) === savedFee)}
            type="submit"
          >
            {savingRate ? "Saving…" : "Save"}
          </button>
        </form>
        </DialogContent>
      </Dialog>

      {wallets.length === 0 ? (
        <EmptyState label="No team members yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-border text-left">
                {["Member", "Earned", "Paid out", "Balance", "Last payout", ""].map((heading) => (
                  <th
                    className="px-3 py-2.5 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground"
                    key={heading}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {wallets.map((wallet) => (
                <tr key={wallet.agentId}>
                  <td className="px-3 py-3">
                    <p className="text-[13.5px] font-semibold text-foreground">{wallet.name}</p>
                    <p className="text-[12px] text-muted-foreground">{wallet.email}</p>
                  </td>
                  <td className="px-3 py-3 tabular-nums text-foreground">{rupees(wallet.earned)}</td>
                  <td className="px-3 py-3 tabular-nums text-foreground">{rupees(wallet.paidOut)}</td>
                  <td className="px-3 py-3 font-semibold tabular-nums text-foreground">
                    {rupees(wallet.balance)}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {wallet.lastPayoutAt ? shortDate(wallet.lastPayoutAt) : "—"}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-teal px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-40"
                      disabled={wallet.balance <= 0}
                      onClick={() => setPaying(wallet)}
                      type="button"
                    >
                      <Wallet className="size-3.5" /> Pay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paying ? (
        <PayDialog
          onClose={() => setPaying(null)}
          onPaid={() => {
            setPaying(null);
            resource.refresh();
          }}
          wallet={paying}
        />
      ) : null}
    </Panel>
  );
}
