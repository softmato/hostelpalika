import { useCallback, useState } from "react";
import { View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { getPayoutAccount, type PayoutAccount, savePayoutAccount } from "@/lib/admin-bookings-api";
import { readApiError } from "@/lib/api-contract";
import type { RefundAccountInput, RefundMethod } from "@/lib/booking-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Where the platform sends this hostel's share of booking fees — docs/BOOKINGS.md
 * item 26. Owner only: a warden's read is refused and the card draws nothing.
 * The Book button shows on the hostel only once this account is verified.
 */

const METHODS: readonly { label: string; value: RefundMethod }[] = [
  { label: "Bank", value: "BANK" },
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
];

const STATUS: Record<PayoutAccount["status"], { label: string; tone: "danger" | "success" | "warning" }> = {
  PENDING_REVIEW: { label: "Waiting for our check", tone: "warning" },
  REJECTED: { label: "Sent back", tone: "danger" },
  VERIFIED: { label: "Verified", tone: "success" },
};

export const EMPTY_PAYOUT_ACCOUNT: RefundAccountInput = {
  bankName: "",
  branch: "",
  holderName: "",
  method: "BANK",
  number: "",
};

/**
 * The same fields, held by a form that sends them later — hostel registration.
 * Kept out of the registration draft on purpose: an account number does not
 * belong in AsyncStorage.
 */
export function RegistrationPayoutFields({
  onChange,
  value,
}: {
  onChange: (next: RefundAccountInput) => void;
  value: RefundAccountInput;
}) {
  const set = (patch: Partial<RefundAccountInput>) => onChange({ ...value, ...patch });

  return (
    <View className="gap-3">
      <ChoiceChips columns={3} onToggle={(method) => set({ method })} options={METHODS} value={value.method} />
      <Input label="Name on the account" onChangeText={(holderName) => set({ holderName })} value={value.holderName} />
      {value.method === "BANK" ? (
        <>
          <Input label="Bank" onChangeText={(bankName) => set({ bankName })} value={value.bankName} />
          <Input label="Branch (optional)" onChangeText={(branch) => set({ branch })} value={value.branch} />
        </>
      ) : null}
      <Input
        keyboardType={value.method === "BANK" ? "default" : "number-pad"}
        label={value.method === "BANK" ? "Account number" : "Mobile number on the wallet"}
        onChangeText={(number) => set({ number })}
        value={value.number}
      />
    </View>
  );
}

export function PayoutAccountFields({
  onSaved,
  value,
}: {
  onSaved: () => void;
  value: PayoutAccount | null;
}) {
  const [method, setMethod] = useState<RefundMethod>(value?.method ?? "BANK");
  const [holderName, setHolderName] = useState(value?.holderName ?? "");
  const [bankName, setBankName] = useState(value?.bankName ?? "");
  const [branch, setBranch] = useState(value?.branch ?? "");
  const [number, setNumber] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);

    try {
      await savePayoutAccount({ bankName, branch, holderName, method, number });
      toastSuccess("Payout account saved", "We check it before any payout.");
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check the account and try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="gap-3">
      <ChoiceChips columns={3} onToggle={setMethod} options={METHODS} value={method} />
      <Input label="Name on the account" onChangeText={setHolderName} value={holderName} />
      {method === "BANK" ? (
        <>
          <Input label="Bank" onChangeText={setBankName} value={bankName} />
          <Input label="Branch (optional)" onChangeText={setBranch} value={branch} />
        </>
      ) : null}
      <Input
        keyboardType={method === "BANK" ? "default" : "number-pad"}
        label={method === "BANK" ? "Account number" : "Mobile number on the wallet"}
        onChangeText={setNumber}
        value={number}
      />
      <Button disabled={!holderName.trim() || !number.trim()} label="Save" loading={saving} onPress={() => void save()} />
    </View>
  );
}

/** One read, one cache entry — Finance's row and this card share it. */
export function usePayoutAccount() {
  return useResource<PayoutAccount | null>(useCallback(() => getPayoutAccount(), []), {
    cacheKey: "hostel-payout-account",
  });
}

/** The row subtitle: where the money goes and whether it can go yet. */
export function payoutAccountSummary(account: PayoutAccount | null) {
  return account
    ? `${account.methodLabel} ${account.maskedNumber} · ${STATUS[account.status].label.toLowerCase()}`
    : "Not added — the Book button stays off";
}

export function PayoutAccountCard() {
  const account = usePayoutAccount();
  const [editing, setEditing] = useState(false);

  if (account.loading || account.error) {
    return null;
  }

  const data = account.data ?? null;
  const status = data ? STATUS[data.status] : null;

  return (
    <View>
      <SectionHeader subtitle="Where we send your share when someone books a bed" title="Booking payouts" />
      <Card className="gap-3">
        {data && !editing ? (
          <>
            {status ? (
              <View className="flex-row">
                <Badge label={status.label} tone={status.tone} />
              </View>
            ) : null}
            <Text className="text-base font-semibold text-foreground">
              {data.methodLabel} {data.bankName} {data.maskedNumber}
            </Text>
            <Text variant="caption">{data.holderName}</Text>
            {data.status === "REJECTED" && data.reviewNote ? (
              <Text className="text-sm text-destructive">{data.reviewNote}</Text>
            ) : null}
            <Button label="Change account" onPress={() => setEditing(true)} variant="outline" />
          </>
        ) : (
          <PayoutAccountFields
            onSaved={() => {
              setEditing(false);
              account.refresh();
            }}
            value={data}
          />
        )}
      </Card>
    </View>
  );
}
