import { type ReactElement, type ReactNode, useMemo } from "react";
import { RefreshControl, SectionList, View } from "react-native";
import Animated from "react-native-reanimated";

import { RowDivider } from "@/components/ui/list-row";
import { FLOATING_CLEARANCE, useOwnScroll } from "@/components/ui/screen";
import { useAppTheme } from "@/hooks/use-app-theme";

// Reanimated's wrapper, so the bottom-chrome scroll handler runs as a worklet
// on the UI thread instead of queueing behind row renders on the JS thread.
const AnimatedSectionList = Animated.createAnimatedComponent(SectionList);

type Row<G extends { rows: readonly unknown[] }> = G["rows"][number];

/**
 * A long, grouped list that only builds the rows on screen — the body of a
 * `<Screen ownScroll padded={false}>`.
 *
 * Every row of a ScrollView list is built before anything moves: 63 statement
 * rows held the JS thread for seconds, so the push waited and so did the back
 * press behind it. This draws a screenful, fills in the next few in small
 * batches while the phone is idle, and drops rows far off screen.
 *
 * `header` is everything above the rows (filters, notices, skeleton, empty
 * state); pass `groups={[]}` while those are showing instead. `card` draws each
 * group's rows as one `<Card padding="px-4 py-1">` with inset dividers, built
 * from per-row segments so the card can still be windowed row by row.
 */
export function Sections<G extends { rows: readonly unknown[] }>({
  card = false,
  floating = false,
  footer,
  groupKey,
  groups,
  header,
  insideTabs = false,
  onRefresh,
  refreshing = false,
  renderHeading,
  renderRow,
  rowGap = 10,
  rowKey,
}: {
  card?: boolean;
  /** The screen has a floating action; the last row has to clear it. */
  floating?: boolean;
  /** Below the last row. */
  footer?: ReactElement | null;
  groupKey: (group: NoInfer<G>) => string;
  groups: readonly G[];
  header?: ReactElement | null;
  insideTabs?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** The day/bucket line on the page, outside the cards (NOTES §5). */
  renderHeading?: (group: NoInfer<G>, index: number) => ReactNode;
  renderRow: (row: Row<G>) => ReactElement;
  rowGap?: number;
  rowKey: (row: Row<G>) => string;
}) {
  const { colors } = useAppTheme();
  const own = useOwnScroll(insideTabs);
  // One component type per gap: an inline arrow would remount every separator on each render.
  const gap = card ? 0 : rowGap;
  const Separator = useMemo(
    () =>
      function Separator() {
        return <View style={{ height: gap }} />;
      },
    [gap],
  );
  const sections = useMemo(
    () => groups.map((group, index) => ({ data: group.rows, group, index, key: groupKey(group) })),
    [groups, groupKey],
  );

  return (
    <AnimatedSectionList
      ItemSeparatorComponent={Separator}
      ListFooterComponent={footer}
      ListHeaderComponent={header}
      contentContainerStyle={{
        paddingBottom: own.scrollPaddingBottom + (floating ? FLOATING_CLEARANCE : 0),
        paddingHorizontal: 20,
      }}
      initialNumToRender={8}
      keyExtractor={(row) => rowKey(row as Row<G>)}
      keyboardShouldPersistTaps="handled"
      maxToRenderPerBatch={4}
      onScroll={own.onScroll}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            colors={[colors.primary]}
            onRefresh={onRefresh}
            refreshing={refreshing}
            tintColor={colors.primary}
          />
        ) : undefined
      }
      renderItem={({ index, item, section }) =>
        card ? (
          <View
            className="px-4"
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderLeftWidth: 1,
              borderRightWidth: 1,
              ...(index === 0 && { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1, paddingTop: 4 }),
              ...(index === section.data.length - 1 && {
                borderBottomLeftRadius: 16,
                borderBottomRightRadius: 16,
                borderBottomWidth: 1,
                paddingBottom: 4,
              }),
            }}
          >
            {index > 0 ? <RowDivider inset /> : null}
            {renderRow(item as Row<G>)}
          </View>
        ) : (
          renderRow(item as Row<G>)
        )
      }
      renderSectionHeader={
        renderHeading
          ? ({ section }) => {
              const { group, index } = section as unknown as { group: G; index: number };
              return (
                <View style={card ? { paddingBottom: 8, paddingTop: 16 } : { paddingBottom: rowGap, paddingTop: 20 }}>
                  {renderHeading(group, index)}
                </View>
              );
            }
          : undefined
      }
      scrollEventThrottle={own.scrollEventThrottle}
      sections={sections as never}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      windowSize={5}
    />
  );
}
