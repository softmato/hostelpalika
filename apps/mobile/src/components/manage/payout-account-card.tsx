import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { useKycDraft } from "@/components/manage/kyc-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getPayoutAccount, type PayoutAccount, savePayoutAccount } from "@/lib/admin-bookings-api";
import { readApiError } from "@/lib/api-contract";
import type { RefundAccountInput, RefundMethod } from "@/lib/booking-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Where the platform sends this hostel's share of booking fees — docs/BOOKINGS.md
 * item 26. Owner only: a warden's read is refused and the card says so.
 * The Book button shows on the hostel only once this account is verified.
 */

const METHODS: readonly { label: string; value: RefundMethod }[] = [
  { label: "Bank", value: "BANK" },
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
];

const STATUS: Record<PayoutAccount["status"], { label: string; tone: "danger" | "success" | "warning" }> = {
  PENDING_REVIEW: { label: "In review", tone: "warning" },
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
  onCancel,
  onSaved,
  value,
}: {
  onCancel?: () => void;
  onSaved: () => Promise<void> | void;
  value: PayoutAccount | null;
}) {
  const [method, setMethod] = useState<RefundMethod>(value?.method ?? "BANK");
  const [holderName, setHolderName] = useState(value?.holderName ?? "");
  const [bankName, setBankName] = useState(value?.bankName ?? "");
  const [branch, setBranch] = useState(value?.branch ?? "");
  const [number, setNumber] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty = number !== "" || holderName !== (value?.holderName ?? "") || bankName !== (value?.bankName ?? "") || branch !== (value?.branch ?? "") || method !== (value?.method ?? "BANK");
  const save = async () => {
    if (!holderName.trim() || !number.trim() || (method === "BANK" && !bankName.trim())) {
      toastError("Check the account", "Add the name, bank and number.");
      return false;
    }
    setSaving(true);

    try {
      await savePayoutAccount({ bankName, branch, holderName, method, number });
      toastSuccess("Payout account saved", "We check it before any payout.");
      await onSaved();
      return true;
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check the account and try again."));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const inWizard = useKycDraft({ dirty, busy: saving, save });

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
      {value ? <Text variant="muted">For safety, enter the full number.</Text> : null}
      {!inWizard ? <Button disabled={!holderName.trim() || !number.trim()} label={saving ? "Saving…" : "Save"} onPress={() => void save()} /> : null}
      {onCancel ? <Button label="Cancel" variant="ghost" disabled={saving} onPress={onCancel} /> : null}
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
  return (
    <View>
      <SectionHeader subtitle="Where we send your share when someone books a bed" title="Booking payouts" />
      <PayoutAccountPanel />
    </View>
  );
}

/** The card alone — Hostel KYC titles the step itself. */
export function PayoutAccountPanel({ onSaved }: { onSaved?: () => void }) {
  const account = usePayoutAccount();
  const [editing, setEditing] = useState(false);
  const { colors } = useAppTheme();
  if (account.loading) return <SkeletonCard rows={3} />;
  if (account.error) return <ErrorState message={account.error} onRetry={account.reload} />;

  const data = account.data ?? null;
  const status = data ? STATUS[data.status] : null;

  return (
    <Card className="gap-3">
      {data && !editing ? (
        <>
          {status ? (
            <View className="flex-row">
              <Badge label={status.label} tone={status.tone} />
            </View>
          ) : null}
          <View className="flex-row items-center gap-3"><Ionicons name={data.method === "BANK" ? "business-outline" : "wallet-outline"} color={colors.primary} size={28} /><Text variant="subtitle">{data.bankName || data.methodLabel}</Text></View>
          <Text variant="title" style={{ fontVariant: ["tabular-nums"] }}>{data.maskedNumber}</Text>
          <Text variant="caption">{data.holderName}</Text>
          {data.status === "REJECTED" && data.reviewNote ? (
            <Text className="text-sm text-destructive">{data.reviewNote}</Text>
          ) : null}
          <Button label="Change" onPress={() => setEditing(true)} variant="outline" />
        </>
      ) : (
        <PayoutAccountFields
          onCancel={data ? () => setEditing(false) : undefined}
          onSaved={async () => {
            await account.refresh();
            onSaved?.();
            setEditing(false);
          }}
          value={data}
        />
      )}
    </Card>
  );
}
