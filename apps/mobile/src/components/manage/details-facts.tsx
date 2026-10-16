import { Linking, View } from "react-native";

import { Card, SectionHeader } from "@/components/ui/card";
import { Chip, FactRow } from "@/components/ui/layout";
import { Text } from "@/components/ui/text";
import { detailsSections, type ResidentDetails } from "@/lib/resident-details";

/**
 * The admission form read back as facts — label left, value right, a call
 * chip under anybody with a number. `page` is a section header over a card,
 * for a screen; `sheet` is the lighter heading the resident's See details
 * sheet uses, so a card is not drawn inside a panel.
 */
export function DetailsFacts({
  details,
  variant = "page",
}: {
  details: ResidentDetails | null | undefined;
  variant?: "page" | "sheet";
}) {
  return (
    <>
      {detailsSections(details).map((section) => {
        const rows = section.facts.map((fact) => (
          <FactRow
            key={`${fact.label}-${fact.value}`}
            label={fact.label}
            value={
              fact.phone ? (
                <View className="items-end gap-1.5">
                  <Text className="text-right text-sm font-medium text-foreground">{fact.value}</Text>
                  <Chip
                    icon="call"
                    label={fact.phone}
                    onPress={() => void Linking.openURL(`tel:${fact.phone}`)}
                    tone="brand"
                  />
                </View>
              ) : (
                fact.value
              )
            }
          />
        ));

        return variant === "sheet" ? (
          <View className="gap-0.5" key={section.title}>
            <Text className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </Text>
            <View className="rounded-2xl border border-border bg-card px-3 py-1">{rows}</View>
          </View>
        ) : (
          <View key={section.title}>
            <SectionHeader title={section.title} />
            <Card padding="px-4 py-1">{rows}</Card>
          </View>
        );
      })}
    </>
  );
}
