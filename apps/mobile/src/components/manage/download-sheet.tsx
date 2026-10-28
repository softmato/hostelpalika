import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

export type DownloadFormat = "csv" | "pdf";

/** `months` counts back from this month, this month included; `0` is everything on record. */
export type DownloadChoice = { format: DownloadFormat; months: number };

const SPANS = [
  { label: "1 month", value: "1" },
  { label: "3 months", value: "3" },
  { label: "6 months", value: "6" },
  { label: "1 year", value: "12" },
  { label: "All", value: "0" },
  { label: "Custom", value: "custom" },
] as const;

type Span = (typeof SPANS)[number]["value"];

const FORMATS: { glyph: GlyphName; label: string; note: string; value: DownloadFormat }[] = [
  { glyph: "document-text", label: "PDF", note: "To read, print or send", value: "pdf" },
  { glyph: "grid", label: "CSV", note: "Opens in Excel", value: "csv" },
];

/**
 * The one download sheet every report uses: how far back, then which file.
 * Nothing downloads until Download is pressed. `formats` narrows the file
 * choice for a report the server only prints one way; `spans` narrows the
 * range for an endpoint that accepts only some of them.
 */
export function DownloadSheet({
  busy = false,
  children,
  formats = ["pdf", "csv"],
  onClose,
  onDownload,
  open,
  spans,
  title = "Download",
}: {
  busy?: boolean;
  /** Other one-tap documents, listed under the range and file choices. */
  children?: ReactNode;
  formats?: readonly DownloadFormat[];
  onClose: () => void;
  onDownload: (choice: DownloadChoice) => void;
  open: boolean;
  /** Which of 1 · 3 · 6 · 12 · 0 (all) · custom to offer. Default: every one. */
  spans?: readonly Span[];
  title?: string;
}) {
  const { colors } = useAppTheme();
  const [span, setSpan] = useState<Span>("1");
  const [custom, setCustom] = useState(2);
  const [picked, setFormat] = useState<DownloadFormat>(formats[0] ?? "pdf");
  const format = formats.includes(picked) ? picked : (formats[0] ?? "pdf");

  const options = spans ? SPANS.filter((option) => spans.includes(option.value)) : SPANS;
  const months = span === "custom" ? custom : Number(span);

  return (
    <Sheet
      footer={
        <Button
          icon="download"
          label={`Download ${format.toUpperCase()}`}
          loading={busy}
          onPress={() => onDownload({ format, months })}
        />
      }
      onClose={onClose}
      open={open}
      title={title}
    >
      <View className="gap-5 pb-2">
        <ChoiceChips columns={3} label="How far back" onToggle={setSpan} options={options} value={span} />

        {span === "custom" ? (
          <View className="flex-row items-center justify-between rounded-2xl border border-border bg-card px-3 py-2">
            <Text variant="label">Last</Text>
            <View className="flex-row items-center gap-3">
              <Stepper disabled={custom <= 2} glyph="remove" label="One month fewer" onPress={() => setCustom(custom - 1)} />
              <Text className="min-w-20 text-center text-base font-semibold text-foreground">
                {`${custom} months`}
              </Text>
              <Stepper disabled={custom >= 24} glyph="add" label="One month more" onPress={() => setCustom(custom + 1)} />
            </View>
          </View>
        ) : null}

        {formats.length > 1 ? (
          <View className="gap-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">File</Text>
            <View className="flex-row gap-3">
              {FORMATS.filter((item) => formats.includes(item.value)).map((item) => {
                const selected = item.value === format;

                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    className={`min-h-16 flex-1 flex-row items-center gap-3 rounded-2xl border px-3 py-3 active:opacity-80 ${
                      selected ? "border-primary bg-brand-soft" : "border-border bg-card"
                    }`}
                    key={item.value}
                    onPress={() => setFormat(item.value)}
                  >
                    <Glyph color={selected ? colors.primary : colors.mutedForeground} name={item.glyph} size={22} />
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">{item.label}</Text>
                      <Text variant="caption">{item.note}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {children}
      </View>
    </Sheet>
  );
}

function Stepper({
  disabled,
  glyph,
  label,
  onPress,
}: {
  disabled: boolean;
  glyph: GlyphName;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className={`h-11 w-11 items-center justify-center rounded-full border border-border active:opacity-60 ${
        disabled ? "opacity-30" : ""
      }`}
      disabled={disabled}
      onPress={onPress}
    >
      <Glyph color={colors.foreground} name={glyph} size={18} />
    </Pressable>
  );
}

/** `{ from, to }` BS months for a choice, ending at `to`. `months: 0` reaches back to `earliest`. */
export function spanPeriods(
  months: number,
  to: string,
  earliest: string,
  addMonths: (period: string, delta: number) => string,
) {
  return { from: months === 0 ? earliest : addMonths(to, -(months - 1)), to };
}
