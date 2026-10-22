import { useState } from "react";
import { View } from "react-native";

import { useKycDraft } from "@/components/manage/kyc-draft";
import { RoomsFloorsEditor } from "@/components/manage/rooms-floors-editor";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { formatDateIn } from "@/lib/calendar";
import { dayInputFromNow, startOfDayIso } from "@/lib/manage-dates";
import { type MoneyRules, moneyRulesQuery, saveMoneyRules } from "@/lib/money-rules-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * KYC step: rooms & floors — the same editor as Settings → Rooms. It saves as
 * it goes, so the wizard's own save has nothing to send.
 */
export function KycRoomsStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  useKycDraft({ busy: false, dirty: false, save: async () => true });

  return <RoomsFloorsEditor onChanged={onSaved} />;
}

/**
 * KYC step: the bank's closing balance the day they start with us, so the
 * app's statement balance matches the bank (docs/FIELD_FIXES_2026_10.md §4).
 */
export function KycOpeningStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const query = moneyRulesQuery();
  const rules = useResource<MoneyRules>(query.load, { cacheKey: query.key, topics: query.topics });

  if (rules.loading) return <SkeletonCard rows={2} />;
  if (rules.error || !rules.data) {
    return <ErrorState message={rules.error ?? "Could not load."} onRetry={rules.reload} />;
  }

  return <OpeningBalanceForm onSaved={onSaved} saved={rules.data.openingBalance} />;
}

/** Amount + day. In KYC the wizard's button saves it; elsewhere it has its own. */
export function OpeningBalanceForm({
  onSaved,
  saved,
  standalone = false,
}: {
  onSaved: () => Promise<void> | void;
  saved: MoneyRules["openingBalance"];
  standalone?: boolean;
}) {
  const { colors } = useAppTheme();
  const [amount, setAmount] = useState(saved ? String(saved.amount) : "");
  const [asOf, setAsOf] = useState(saved?.asOf ?? dayInputFromNow(0));
  const [busy, setBusy] = useState(false);

  const rupees = Number(amount.replace(/[^\d-]/g, ""));
  const validDay = Boolean(startOfDayIso(asOf));
  const valid = amount.trim() !== "" && Number.isFinite(rupees) && validDay;
  const dirty = amount !== (saved ? String(saved.amount) : "") || asOf !== (saved?.asOf ?? dayInputFromNow(0));

  const save = async () => {
    if (!valid) {
      toastError("Check the amount and day", "Type the bank balance, and the day as YYYY-MM-DD.");
      return false;
    }

    setBusy(true);
    try {
      await saveMoneyRules({ openingBalance: { amount: rupees, asOf } });
      await onSaved();
      return true;
    } catch (error) {
      toastError("Not saved", readApiError(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  useKycDraft({ busy, dirty: !standalone && dirty, save });

  return (
    <View className="gap-4">
      <Input
        hint="Use minus for an overdraft."
        keyboardType="numbers-and-punctuation"
        label="Bank balance (Rs)"
        leading={<Glyph color={colors.mutedForeground} name="wallet" size={18} />}
        variant="line"
        onChangeText={setAmount}
        placeholder="250000"
        value={amount}
      />
      <Input
        hint={validDay ? formatDateIn("BS", startOfDayIso(asOf) as string) : "Write the day as YYYY-MM-DD"}
        keyboardType="numbers-and-punctuation"
        label="On the day"
        leading={<Glyph color={colors.mutedForeground} name="calendar" size={18} />}
        variant="line"
        onChangeText={setAsOf}
        value={asOf}
      />
      {standalone ? (
        <Button
          disabled={!dirty || !valid}
          label="Save"
          loading={busy}
          onPress={() => void save().then((ok) => ok && toastSuccess("Opening balance saved"))}
        />
      ) : null}
    </View>
  );
}
