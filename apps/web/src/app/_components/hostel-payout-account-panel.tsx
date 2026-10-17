"use client";

import { useState } from "react";

import { FIELD, useAction } from "@/app/_components/booking-admin-ui";
import { RoleButton, SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { Panel } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import type { PayoutAccountView } from "@/modules/bookings/payout-account.service";

/**
 * Where HostelPalika sends this hostel's share of booking fees. Owner only: a
 * warden's read is refused and the panel draws nothing. Saving a different
 * account sends it back to our check, and nothing is paid out until it passes.
 *
 * It sits on **Bookings → Settings** (docs/BOOKINGS.md item 32), not on Payment
 * Setup: that screen is about how residents pay the hostel, and this is the one
 * account the money moves along in the other direction.
 */

const URL = "/api/v1/hostel-admin/payout-account";

type Method = PayoutAccountView["method"];

const STATUS: Record<PayoutAccountView["status"], { label: string; tone: "amber" | "green" | "rose" }> = {
  PENDING_REVIEW: { label: "Waiting for our check", tone: "amber" },
  REJECTED: { label: "Sent back", tone: "rose" },
  VERIFIED: { label: "Verified", tone: "green" },
};

function PayoutForm({ account, onDone }: { account: PayoutAccountView | null; onDone: () => void }) {
  const [method, setMethod] = useState<Method>(account?.method ?? "BANK");
  const [holderName, setHolderName] = useState(account?.holderName ?? "");
  const [bankName, setBankName] = useState(account?.bankName ?? "");
  const [branch, setBranch] = useState(account?.branch ?? "");
  const [number, setNumber] = useState("");
  const { busy, run } = useAction([URL]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {(["BANK", "ESEWA", "KHALTI"] as const).map((value) => (
          <RoleButton key={value} onClick={() => setMethod(value)} tone="admin" variant={method === value ? "solid" : "outline"}>
            {value === "BANK" ? "Bank" : value === "ESEWA" ? "eSewa" : "Khalti"}
          </RoleButton>
        ))}
      </div>
      <input className={FIELD} onChange={(event) => setHolderName(event.target.value)} placeholder="Name on the account" value={holderName} />
      {method === "BANK" ? (
        <>
          <input className={FIELD} onChange={(event) => setBankName(event.target.value)} placeholder="Bank" value={bankName} />
          <input className={FIELD} onChange={(event) => setBranch(event.target.value)} placeholder="Branch (optional)" value={branch} />
        </>
      ) : null}
      <input
        className={FIELD}
        inputMode={method === "BANK" ? "text" : "numeric"}
        onChange={(event) => setNumber(event.target.value)}
        placeholder={method === "BANK" ? "Account number" : "Mobile number on the wallet"}
        value={number}
      />
      <div className="flex gap-2">
        <RoleButton
          disabled={busy === "payout" || !holderName.trim() || !number.trim()}
          onClick={async () => {
            const saved = await run("payout", URL, { bankName, branch, holderName, method, number }, "Saved. We check it before any payout.", "PUT");

            if (saved) onDone();
          }}
          tone="admin"
        >
          Save
        </RoleButton>
        {account ? (
          <RoleButton onClick={onDone} tone="admin" variant="outline">
            Close
          </RoleButton>
        ) : null}
      </div>
    </div>
  );
}

export function HostelPayoutAccountPanel() {
  const resource = usePortalResource<{ account: PayoutAccountView | null }>(URL);
  const [editing, setEditing] = useState(false);

  if (resource.state !== "ready" || !resource.data) {
    return null;
  }

  const account = resource.data.account;
  const status = account ? STATUS[account.status] : null;

  return (
    <Panel title="Booking payouts">
      <p className="mb-3 text-[12.5px] text-muted-foreground">Your Book button shows once this account is verified.</p>
      {account && !editing ? (
        <div className="space-y-2 text-sm">
          {status ? <SoftBadge tone={status.tone}>{status.label}</SoftBadge> : null}
          <p className="font-semibold text-foreground">
            {account.methodLabel} {account.bankName} {account.maskedNumber}
          </p>
          <p className="text-muted-foreground">{account.holderName}</p>
          {account.status === "REJECTED" && account.reviewNote ? (
            <p className="text-rose-600 dark:text-rose-400">{account.reviewNote}</p>
          ) : null}
          <RoleButton onClick={() => setEditing(true)} tone="admin" variant="outline">
            Change account
          </RoleButton>
        </div>
      ) : (
        <PayoutForm account={account} onDone={() => setEditing(false)} />
      )}
    </Panel>
  );
}
