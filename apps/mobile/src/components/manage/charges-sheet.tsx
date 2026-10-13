import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import type { ChargeOverrides, IntakeQuote } from "@/lib/admin-manage-api";
import { formatMoney } from "@/lib/format";

const REASONS = [
  { label: "Short stay", value: "Short stay" },
  { label: "Relative", value: "Relative" },
  { label: "Other", value: "OTHER" },
] as const;

type Key = keyof ChargeOverrides;

const FIELDS: [Key, string][] = [
  ["monthlyFee", "Monthly rent"],
  ["admissionFee", "Admission fee"],
  ["formFee", "Form fee"],
  ["depositAmount", "Deposit"],
];

export type Charges = ChargeOverrides & { reason: string };

type Standard = NonNullable<IntakeQuote["standard"]>;

function rateOf(standard: Standard | null, key: Key) {
  if (!standard) return null;
  return key === "monthlyFee" ? standard.monthlyRent : standard[key];
}

/**
 * One resident's rent, admission fee, form fee and deposit, with the reason
 * they differ from the rate card (docs/FIELD_FIXES_2026_10.md §2). Only the
 * figures actually changed are kept; rent then bills every month, the other
 * three go on the joining bill. "Use the rate card" clears them all.
 */
export function ChargesSheet({
  onClose,
  onSave,
  open,
  standard,
  value,
}: {
  onClose: () => void;
  onSave: (charges: Charges | null) => void;
  open: boolean;
  /** The rate card's figures for this room type. */
  standard: Standard | null;
  value: Charges | null;
}) {
  const [amounts, setAmounts] = useState<Partial<Record<Key, string>>>({});
  const [pick, setPick] = useState<string>("Short stay");
  const [other, setOther] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Each opening starts from what is set, or the rate card.
  if (open && !seeded) {
    const preset = REASONS.find((reason) => reason.value === value?.reason);

    setSeeded(true);
    setAmounts(
      Object.fromEntries(
        FIELDS.map(([key]) => [key, String(value?.[key] ?? rateOf(standard, key) ?? "")]),
      ),
    );
    setPick(value ? (preset ? preset.value : "OTHER") : "Short stay");
    setOther(value && !preset ? value.reason : "");
  }

  if (!open && seeded) setSeeded(false);

  const changed = FIELDS.map(([key]) => key).filter((key) => {
    const typed = amounts[key]?.trim() ?? "";
    return typed !== "" && Number(typed) !== rateOf(standard, key);
  });
  const reason = pick === "OTHER" ? other.trim() : pick;
  const valid = changed.length > 0 && reason.length >= 3;

  const field = (key: Key, label: string) => {
    const rate = rateOf(standard, key);
    return (
      <View className="flex-1" key={key}>
        <Input
          hint={rate === null ? "Not on the rate card" : `Normal ${formatMoney(rate)}`}
          keyboardType="number-pad"
          label={label}
          onChangeText={(text) => setAmounts({ ...amounts, [key]: text.replace(/\D/g, "") })}
          value={amounts[key] ?? ""}
        />
      </View>
    );
  };

  return (
    <Sheet
      footer={
        <View className="gap-2">
          <Button
            disabled={!valid}
            label={changed.length > 1 ? `Use these ${changed.length} charges` : "Use this charge"}
            onPress={() =>
              onSave({ ...Object.fromEntries(changed.map((key) => [key, Number(amounts[key])])), reason })
            }
          />
          {value ? <Button label="Use the rate card" onPress={() => onSave(null)} variant="ghost" /> : null}
        </View>
      }
      onClose={onClose}
      open={open}
      title="Their charges"
    >
      <View className="gap-4 pb-2">
        <View className="flex-row gap-3">{FIELDS.slice(0, 2).map(([key, label]) => field(key, label))}</View>
        <View className="flex-row gap-3">{FIELDS.slice(2).map(([key, label]) => field(key, label))}</View>
        <ChoiceChips label="Why" onToggle={setPick} options={REASONS} value={pick} />
        {pick === "OTHER" ? (
          <Input label="Reason" onChangeText={setOther} placeholder="Staff member's child, festival offer" value={other} />
        ) : null}
        <Text variant="caption">Rent changes every bill. The rest go on the joining bill. The rate card never charges them.</Text>
      </View>
    </Sheet>
  );
}
