"use client";

import { Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";

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

import { shortDate } from "./platform-team-types";

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
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-role-platform";

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
            className="h-10 w-full rounded-lg bg-role-platform text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60"
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
    <div className="app-card overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <h2 className="text-sm font-bold text-foreground">Commission</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The agent gets{" "}
            <strong className="font-semibold text-foreground">
              {rupees(Math.round((Number(fee) || 0) * (Number(rate) || 0)) / 100)} of a{" "}
              {rupees(Number(fee) || 0)} setup fee
            </strong>{" "}
            — the rate is a percent, so a fee the agent lowers earns less. Credited when the fee
            clears. The fee is also the most an agent may collect. {rupees(owed)} waiting to be
            paid out.
          </p>
        </div>
        <form className="flex items-end gap-2" onSubmit={saveRate}>
          <label className="text-xs font-semibold text-foreground">
            Setup fee (Rs)
            <input
              className="mt-1 h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm tabular-nums outline-none focus:border-role-platform"
              max={100000}
              min={0}
              onChange={(event) => setFeeDraft(event.target.value)}
              required
              step="1"
              type="number"
              value={fee}
            />
          </label>
          <label className="text-xs font-semibold text-foreground">
            Rate (%)
            <input
              className="mt-1 h-9 w-24 rounded-lg border border-border bg-background px-2 text-sm tabular-nums outline-none focus:border-role-platform"
              max={100}
              min={0}
              onChange={(event) => setRateDraft(event.target.value)}
              required
              step="0.01"
              type="number"
              value={rate}
            />
          </label>
          <button
            className="h-9 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition hover:bg-muted disabled:opacity-50"
            disabled={savingRate || (Number(rate) === savedRate && Number(fee) === savedFee)}
            type="submit"
          >
            {savingRate ? "Saving…" : "Save"}
          </button>
        </form>
      </div>

      {wallets.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">No team members yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {["Member", "Earned", "Paid out", "Balance", "Last payout", ""].map((heading) => (
                  <th
                    className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
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
                  <td className="px-4 py-3">
                    <p className="font-semibold text-foreground">{wallet.name}</p>
                    <p className="text-xs text-muted-foreground">{wallet.email}</p>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{rupees(wallet.earned)}</td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{rupees(wallet.paidOut)}</td>
                  <td className="px-4 py-3 font-semibold tabular-nums text-foreground">
                    {rupees(wallet.balance)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {wallet.lastPayoutAt ? shortDate(wallet.lastPayoutAt) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-role-platform px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-40"
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
    </div>
  );
}
