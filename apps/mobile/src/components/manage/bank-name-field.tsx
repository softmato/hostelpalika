import { Pressable, ScrollView, View } from "react-native";

import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { WalletMark } from "@/components/ui/wallet-mark";
import { BANK_NAMES } from "@/lib/payment-logos";

/**
 * The bank, typed or tapped. Under the field sits a row of banks with their own
 * marks, narrowed by what has been typed; tapping one fills the name in the
 * spelling the logo resolver reads, so the account shows its bank's logo
 * everywhere after. Free text still works for a bank that is not listed.
 */
export function BankNameField({
  label = "Bank",
  onChange,
  value,
}: {
  label?: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const query = value.trim().toLowerCase();
  const picked = BANK_NAMES.some((name) => name === value.trim());
  const matches = BANK_NAMES.filter((name) => !query || name.toLowerCase().includes(query));

  return (
    <View className="gap-2">
      <Input
        label={label}
        leading={value.trim() ? <WalletMark name={value} size={24} /> : undefined}
        onChangeText={onChange}
        placeholder="Nabil Bank"
        value={value}
      />
      {picked || matches.length === 0 ? null : (
        <ScrollView
          contentContainerStyle={{ gap: 8 }}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {matches.map((name) => (
            <Pressable
              accessibilityLabel={`Pick ${name}`}
              accessibilityRole="button"
              className="min-h-11 flex-row items-center gap-2 rounded-xl border border-border px-3 active:opacity-70"
              key={name}
              onPress={() => onChange(name)}
            >
              <WalletMark name={name} size={24} square />
              <Text variant="label">{name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
