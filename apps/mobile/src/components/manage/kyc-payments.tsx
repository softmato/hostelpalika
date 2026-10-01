import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { usePaymentSetup } from "@/components/manage/payment-setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { updatePaymentProfile, type PaymentProfile } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { toastError } from "@/lib/toast";

type PaymentField = "bankName" | "bankAccountName" | "bankAccountNumber" | "esewaId" | "khaltiId" | "qrPayeeName" | "qrPayeeNumber";
const GROUPS: { key: string; title: string; icon: "business-outline" | "wallet-outline"; fields: [PaymentField, string][] }[] = [
  { key: "bank", title: "Bank", icon: "business-outline", fields: [["bankName", "Bank"], ["bankAccountName", "Name"], ["bankAccountNumber", "Account number"]] },
  { key: "esewa", title: "eSewa", icon: "wallet-outline", fields: [["esewaId", "eSewa ID"]] },
  { key: "khalti", title: "Khalti", icon: "wallet-outline", fields: [["khaltiId", "Khalti ID"]] },
];
const mask = (value?: string | null) => value ? `•••• ${value.slice(-4)}` : "Not added";

/** Rent fields are one draft; only the QR image is saved immediately. */
export function KycPayments({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const setup = usePaymentSetup({ onSaved: () => void onSaved() });
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<Partial<Record<PaymentField, string>>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const profile = setup.profile;
  const value = (field: PaymentField) => draft[field] ?? profile?.[field] ?? "";
  const changes = Object.fromEntries(Object.entries(draft).filter(([field, text]) => text !== (profile?.[field as keyof PaymentProfile] ?? "")));
  const dirty = Object.keys(changes).length > 0;
  const save = async () => {
    setSaving(true);
    try {
      const next = await updatePaymentProfile(changes);
      setup.resource.setData(() => next);
      setDraft({});
      await onSaved();
      return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving || Boolean(setup.qrBusy), save });
  if (setup.resource.loading) return <SkeletonCard rows={3} />;
  if (setup.resource.error || !profile) return <ErrorState message={setup.resource.error ?? "Could not load payments."} onRetry={setup.resource.reload} />;
  const field = ([key, label]: [PaymentField, string]) => <Input key={key} label={label} value={value(key)} onChangeText={text => setDraft(previous => ({ ...previous, [key]: text }))} keyboardType={/Number|Id/.test(key) ? "numbers-and-punctuation" : "default"} />;
  return <View className="gap-4">
    <View className="flex-row"><Badge label={profile.usable ? "Ready to pay" : "Add a way to pay"} tone={profile.usable ? "success" : "neutral"} /></View>
    <Card className="items-center gap-3">
      {setup.qrSource ? <Image source={setup.qrSource} contentFit="contain" style={{ width: 176, height: 176 }} /> : <Ionicons name="qr-code-outline" color={colors.mutedForeground} size={72} />}
      {profile.qrPayeeName ? <Text variant="subtitle">{profile.qrPayeeName}</Text> : null}
      {profile.qrPayeeNumber ? <Text variant="muted">{mask(profile.qrPayeeNumber)}</Text> : null}
      <View className="w-full flex-row gap-2"><Button className="flex-1" label={setup.qrBusy ? "Uploading…" : setup.qrSource ? "Change QR" : "Add QR"} disabled={Boolean(setup.qrBusy)} variant="outline" onPress={() => void setup.pickQr()} />{setup.qrSource ? <Button className="flex-1" label="Edit name" variant="outline" onPress={() => setEditing(editing === "qr" ? null : "qr")} /> : null}</View>
      {editing === "qr" ? <View className="w-full gap-3"><Text variant="muted">Change only if wrong.</Text>{field(["qrPayeeName", "Name on QR"])}{field(["qrPayeeNumber", "Number on QR"])}</View> : null}
    </Card>
    <Card padding="p-0" className="overflow-hidden">{GROUPS.map((group, at) => <View key={group.key} className={at ? "border-t border-border" : ""}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: editing === group.key }} onPress={() => setEditing(editing === group.key ? null : group.key)} className="min-h-20 flex-row items-center gap-3 p-4">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft"><Ionicons name={group.icon} color={colors.primary} size={22} /></View>
        <View className="flex-1 gap-1"><Text variant="subtitle">{group.title}</Text><Text variant="muted">{group.key === "bank" && value("bankAccountNumber") ? `${value("bankName")} · ${mask(value("bankAccountNumber"))}` : mask(value(group.fields[group.fields.length - 1][0]))}</Text></View>
        <Ionicons name={editing === group.key ? "chevron-up" : value(group.fields[group.fields.length - 1][0]) ? "pencil-outline" : "add"} size={22} color={colors.primary} />
      </Pressable>
      {editing === group.key ? <View className="gap-3 px-4 pb-4">{group.fields.map(field)}</View> : null}
    </View>)}</Card>
    <View className="flex-row items-center gap-2"><Ionicons name="shield-checkmark-outline" size={20} color={profile.payeeVerifiable ? colors.primary : colors.warning} /><Text variant="muted">{profile.payeeVerifiable ? "We can check receipts" : "Receipts need a check"}</Text></View>
    {dirty ? <Text variant="muted" className="text-warning">Not saved</Text> : null}
  </View>;
}
