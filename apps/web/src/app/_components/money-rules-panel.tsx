"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * Opening balance, the leaving-month rule and days away, on the web
 * (docs/FIELD_FIXES_2026_10.md §1, §4, §9). Same route as the app's Money rules.
 */

type Rules = {
  leave: { enabled: boolean; foodPerDay: number; minDays: number; mode: "FOOD" | "FULL_DAY" };
  moveOutCharge: "FULL_MONTH" | "TILL_DAY";
  moveOutNoticeDays?: number;
  openingBalance: { amount: number; asOf: string } | null;
};

const ENDPOINT = "/api/v1/hostel-admin/finance/money-rules";
const INPUT = "h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary";

function Pill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        "h-9 flex-1 rounded-lg border text-sm font-medium",
        active ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground hover:bg-muted",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

export function MoneyRulesPanel() {
  const resource = usePortalResource<{ rules: Rules }>(ENDPOINT);
  const rules = resource.data?.rules;

  if (!rules) {
    return null;
  }

  return <MoneyRulesForm key={JSON.stringify(rules)} onSaved={() => resource.refreshAsync()} rules={rules} />;
}

function MoneyRulesForm({ onSaved, rules }: { onSaved: () => Promise<unknown>; rules: Rules }) {
  const [amount, setAmount] = useState(rules.openingBalance ? String(rules.openingBalance.amount) : "");
  const [asOf, setAsOf] = useState(rules.openingBalance?.asOf ?? "");
  const [charge, setCharge] = useState(rules.moveOutCharge);
  const [leave, setLeave] = useState(rules.leave);
  const [notice, setNotice] = useState(String(rules.moveOutNoticeDays ?? 0));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await browserApi(ENDPOINT, { body: JSON.stringify(body), method: "PUT" });
      setMessage(done);
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5 rounded-2xl border border-border bg-card p-5">
      <div>
        <h2 className="font-semibold text-foreground">Money rules</h2>
        {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Opening balance</h3>
        <p className="text-xs text-muted-foreground">Your bank balance the day you started. The statement starts from it.</p>
        <div className="grid grid-cols-2 gap-2">
          <input className={INPUT} inputMode="numeric" onChange={(event) => setAmount(event.target.value.replace(/[^\d-]/g, ""))} placeholder="Rs" value={amount} />
          <input className={INPUT} onChange={(event) => setAsOf(event.target.value)} type="date" value={asOf} />
        </div>
        <Button
          disabled={busy || !amount || !asOf}
          onClick={() => void save({ openingBalance: { amount: Number(amount), asOf } }, "Opening balance saved.")}
          size="sm"
        >
          Save balance
        </Button>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Leaving month</h3>
        <div className="flex gap-2">
          {(
            [
              ["FULL_MONTH", "Full month"],
              ["TILL_DAY", "Till the day"],
            ] as const
          ).map(([value, label]) => (
            <Pill
              active={charge === value}
              key={value}
              label={label}
              onClick={() => {
                setCharge(value);
                void save({ moveOutCharge: value }, "Leaving month saved.");
              }}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">What the move-out form starts on. It can be changed per person.</p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Move-out notice</h3>
        <div className="flex gap-2">
          <input
            className={INPUT}
            inputMode="numeric"
            max={90}
            min={0}
            onChange={(event) => setNotice(event.target.value)}
            type="number"
            value={notice}
          />
          <Button
            disabled={busy || String(rules.moveOutNoticeDays ?? 0) === notice}
            onClick={() => void save({ moveOutNoticeDays: Number(notice) }, "Notice days saved.")}
            type="button"
            variant="outline"
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Days ahead a resident&apos;s leaving day must be. Rent stops on the day they pick.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Days away</h3>
        <label className="flex items-center gap-2 text-sm">
          <input checked={leave.enabled} onChange={(event) => setLeave({ ...leave, enabled: event.target.checked })} type="checkbox" />
          Money off for days at home or on holiday
        </label>
        {leave.enabled ? (
          <>
            <div className="flex gap-2">
              <Pill active={leave.mode === "FOOD"} label="Food only" onClick={() => setLeave({ ...leave, mode: "FOOD" })} />
              <Pill active={leave.mode === "FULL_DAY"} label="Full day" onClick={() => setLeave({ ...leave, mode: "FULL_DAY" })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {leave.mode === "FOOD" ? (
                <label className="grid gap-1 text-xs font-semibold">
                  Food a day (Rs)
                  <input
                    className={INPUT}
                    inputMode="numeric"
                    onChange={(event) => setLeave({ ...leave, foodPerDay: Number(event.target.value) || 0 })}
                    value={leave.foodPerDay || ""}
                  />
                </label>
              ) : null}
              <label className="grid gap-1 text-xs font-semibold">
                At least (days)
                <input
                  className={INPUT}
                  inputMode="numeric"
                  onChange={(event) => setLeave({ ...leave, minDays: Number(event.target.value) || 1 })}
                  value={leave.minDays}
                />
              </label>
            </div>
          </>
        ) : null}
        <Button disabled={busy} onClick={() => void save({ leave }, "Days away saved.")} size="sm" variant="outline">
          Save days away
        </Button>
      </div>
    </section>
  );
}

type Leave = { amount: number; days: number; id: string; label: string; note: string | null };

/** One resident's days away, with add and remove (§9). */
export function ResidentDaysAway({ residentId }: { residentId: string }) {
  const endpoint = `/api/v1/hostel-admin/residents/${residentId}/leave`;
  const resource = usePortalResource<{ leaves: Leave[]; rule: Rules["leave"] }>(endpoint);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const data = resource.data;

  if (!data?.rule.enabled) {
    return null;
  }

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
      setMessage(done);
      await resource.refreshAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/15 p-3 text-sm">
      <p className="font-semibold">Days away</p>
      {data.leaves.map((leave) => (
        <div className="flex items-center gap-2" key={leave.id}>
          <span className="mr-auto">{`${leave.label} · ${leave.days} days`}</span>
          <span className="font-semibold text-success">− Rs {leave.amount.toLocaleString("en-IN")}</span>
          <button
            className="text-xs font-semibold text-destructive"
            disabled={busy}
            onClick={() => void run(() => browserApi(`${endpoint}/${leave.id}`, { method: "DELETE" }), "Removed.")}
            type="button"
          >
            Remove
          </button>
        </div>
      ))}
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <input className={INPUT} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        <input className={INPUT} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        <Button
          disabled={busy || !from || !to}
          onClick={() => void run(() => browserApi(endpoint, { body: JSON.stringify({ from, to }), method: "POST" }), "Days away added.")}
          size="sm"
        >
          Add
        </Button>
      </div>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
