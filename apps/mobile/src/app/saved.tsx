import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback, useEffect } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { EmptyState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { useSavedHostels } from "@/hooks/use-saved";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";
import type { PublicHostel } from "@/lib/public-api";
import { publicQuery } from "@/lib/public-queries";
import type { SavedHostel } from "@/lib/saved-hostels";

/**
 * Saved hostels — the shortlist, on a screen of its own.
 *
 * ## Why this exists
 *
 * The Profile tab's "Saved hostels" row used to `push("/(browse)")`, i.e. the
 * Home tab, on the reasoning that Home already draws a Saved row. What that
 * actually did was switch tabs and drop the reader at the top of a discovery
 * feed with their shortlist somewhere below five other sections — a row you have
 * to go looking for, in a horizontal carousel, three screenfuls down. Tapping a
 * row labelled "Saved hostels" and landing on a screen that is mostly not your
 * saved hostels is the kind of thing that reads as a broken link.
 *
 * So the row now leads here, and this screen is only the shortlist: a full-width
 * vertical list, every entry visible, each removable where it sits. The
 * horizontal row on Home stays exactly as it is — it is a *glance* at the
 * shortlist inside a browsing screen, and this is the shortlist itself.
 *
 * ## Device-local, and it says so
 *
 * There is no favourites collection on the server (`lib/saved-hostels.ts`), so
 * this list does not follow anyone to another phone. The subtitle says that
 * where it is always visible rather than in a toast that disappears.
 *
 * ## The prices refresh, the list does not depend on it
 *
 * Each entry is a stored snapshot, so this screen renders complete and instantly
 * with no network at all — including offline, and including a hostel that has
 * since dropped out of the server's first-60 window. Pull-to-refresh folds newer
 * prices and photos in through `sync`, which writes nothing when nothing has
 * changed. A failed fetch is therefore not an error state here: there is nothing
 * on screen that came from it.
 */
export default function SavedHostelsScreen() {
  const { items, remove, sync } = useSavedHostels();

  const query = publicQuery.hostels();
  const hostels = useResource<PublicHostel[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const all = hostels.data;

  useEffect(() => {
    if (all) {
      sync(all);
    }
  }, [all, sync]);

  const confirmRemove = useCallback(
    (item: SavedHostel) => {
      Alert.alert(`Remove ${item.name}?`, "It comes off your shortlist on this phone.", [
        { style: "cancel", text: "Keep it" },
        { onPress: () => remove(item.id), style: "destructive", text: "Remove" },
      ]);
    },
    [remove],
  );

  return (
    <Screen
      header={
        <AppBar
          showBack
          subtitle={
            items.length > 0
              ? `${items.length} kept on this phone`
              : "Kept on this phone"
          }
          title="Saved hostels"
        />
      }
      onRefresh={hostels.refresh}
      refreshing={hostels.refreshing}
      scroll
    >
      {items.length === 0 ? (
        <EmptyState
          action={
            <Button
              label="Browse hostels"
              onPress={() => router.push("/(browse)/search")}
            />
          }
          description="Tap the heart on any hostel and it lands here. The list stays on this phone — it does not follow your account to another device."
          title="Nothing shortlisted yet"
        />
      ) : (
        <View className="gap-3 pb-4 pt-1">
          {items.map((item) => (
            <SavedListRow
              item={item}
              key={item.id}
              onRemove={() => confirmRemove(item)}
            />
          ))}

          <Text className="px-1 pt-2" variant="caption">
            Prices and photos are as fresh as the last time each hostel appeared in
            a listing. Pull down to update them.
          </Text>
        </View>
      )}
    </Screen>
  );
}

/**
 * One shortlisted hostel, full width.
 *
 * Deliberately not `<HostelCard>`: that component takes a `PublicHostel` and
 * draws a rating, vacancy and facility icons from it. A snapshot has none of
 * those — and `lib/saved-hostels.ts` explains why it does not store them, which
 * is that a stale rating or a stale "2 beds free" is a lie where a stale price is
 * merely old. A name, a place and a last-known price is what a snapshot can
 * honestly say, so that is what this draws.
 */
function SavedListRow({
  item,
  onRemove,
}: {
  item: SavedHostel;
  onRemove: () => void;
}) {
  const { colors } = useAppTheme();

  const uri = absoluteMediaUrl(item.coverUrl, API_BASE_URL);

  return (
    <Pressable
      accessibilityLabel={`${item.name}, ${item.place}`}
      accessibilityRole="button"
      className="flex-row items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card active:opacity-80"
      onPress={() => router.push(`/hostel/${item.slug}`)}
    >
      {uri ? (
        <Image
          accessibilityLabel={item.name}
          contentFit="cover"
          source={{ uri }}
          style={{ backgroundColor: colors.muted, height: 88, width: 88 }}
          transition={150}
        />
      ) : (
        <View
          className="items-center justify-center"
          style={{ backgroundColor: colors.muted, height: 88, width: 88 }}
        >
          <Glyph color={colors.mutedForeground} name="image" size={22} />
        </View>
      )}

      <View className="flex-1 gap-0.5 py-2">
        <Text numberOfLines={1} variant="label">
          {item.name}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {item.place}
        </Text>
        <Text className="text-primary" variant="label">
          {item.price}
        </Text>
      </View>

      {/*
        A filled heart that unsaves, not an outline that saves — the state this
        row is in is "saved", and every heart in the app is a toggle. `hitSlop`
        rather than a bigger glyph, so it is comfortably tappable without
        competing with the row itself for the eye.
      */}
      <Pressable
        accessibilityLabel={`Remove ${item.name} from saved`}
        accessibilityRole="button"
        className="px-4 py-6"
        hitSlop={6}
        onPress={onRemove}
      >
        <Glyph color={colors.primary} name="heart" size={22} />
      </Pressable>
    </Pressable>
  );
}
