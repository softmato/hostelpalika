import { useState } from "react";
import { Pressable, View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph } from "@/components/ui/glyph";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { updateManagedHostel } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { toastError } from "@/lib/toast";

const SUGGESTED_RULES = ["No smoking", "Gate closes at 9 PM", "Keep rooms clean", "No loud music", "Pay rent on time", "No food in rooms"];
export function RulesStep({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: string[] }) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const rules = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => {
    const next = rules.map(rule => rule.trim()).filter(Boolean);
    setSaving(true);
    try { await updateManagedHostel({ rules: next }); await onSaved(); setDraft(null); setEditing(null); return true; }
    catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  const shift = (direction: number) => {
    if (menu === null || menu + direction < 0 || menu + direction >= rules.length) return;
    const next = [...rules];
    [next[menu], next[menu + direction]] = [next[menu + direction], next[menu]];
    setDraft(next); setEditing(null); setMenu(null);
  };
  return <View className="gap-4">
    {rules.length ? <Card padding="p-0">{rules.map((rule, at) => <View key={at} className={`flex-row items-center gap-3 p-4 ${at ? "border-t border-border" : ""}`}>
      <View className="h-8 w-8 items-center justify-center rounded-full bg-muted"><Text variant="label">{at + 1}</Text></View>
      {editing === at ? <View className="flex-1"><Input accessibilityLabel={`Rule ${at + 1}`} multiline autoFocus value={rule} placeholder="Add a rule" onChangeText={text => setDraft(rules.map((value, index) => index === at ? text : value))} /></View> : <Pressable accessibilityRole="button" accessibilityLabel={`Edit rule ${at + 1}`} onPress={() => setEditing(at)} className="min-h-11 flex-1 justify-center"><Text>{rule || "Add a rule"}</Text></Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={`Rule ${at + 1} options`} onPress={() => setMenu(at)} className="h-11 w-11 items-center justify-center"><Glyph name="ellipsis-vertical" color={colors.foreground} size={20} /></Pressable>
    </View>)}</Card> : null}
    <Button label="+ Add rule" variant="outline" onPress={() => { setDraft([...rules, ""]); setEditing(rules.length); }} />
    <Text variant="subtitle">Tap to add</Text>
    <View className="flex-row flex-wrap gap-2">{SUGGESTED_RULES.filter(rule => !rules.includes(rule)).map(rule => <Pressable key={rule} accessibilityRole="button" onPress={() => setDraft([...rules, rule])} className="min-h-12 justify-center rounded-xl border border-border px-3"><Text variant="label">+ {rule}</Text></Pressable>)}</View>
    <Sheet open={menu !== null} onClose={() => setMenu(null)} title="Rule options"><View className="gap-2"><Button label="Edit" variant="outline" onPress={() => { setEditing(menu); setMenu(null); }} /><Button label="Move up" variant="outline" disabled={menu === 0} onPress={() => shift(-1)} /><Button label="Move down" variant="outline" disabled={menu === rules.length - 1} onPress={() => shift(1)} /><Button label="Remove" variant="ghost" onPress={() => { setDraft(rules.filter((_, at) => at !== menu)); setEditing(null); setMenu(null); }} /></View></Sheet>
  </View>;
}
