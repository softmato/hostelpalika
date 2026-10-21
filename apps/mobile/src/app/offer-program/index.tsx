import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, ReduceMotion } from "react-native-reanimated";

import { IntroHero } from "@/components/intro-hero";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Grid } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { API_BASE_URL } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { absoluteMediaUrl } from "@/lib/media";
import { type OfferPerk, perkTerms, type PublicOfferPerks } from "@/lib/offer-program-api";
import { publicQuery } from "@/lib/public-queries";

/**
 * The Resident Offer Program's front door: the gifts and perks this quarter,
 * shown as the things themselves, and one button.
 *
 * Public on purpose — a resident reading a payment-confirmation email and a
 * parent paying the rent both arrive here signed out. The rules (nine sections
 * of configured copy) moved behind "How it works" (`rules.tsx`) on 2026-10-21:
 * above the perks they were what everyone scrolled past to find the point.
 *
 * The button depends on who is reading. A resident goes to their own offers; a
 * signed-in non-resident is told to find a hostel rather than to sign up for an
 * account they already have; a visitor can find a hostel or sign in.
 */
export default function OfferProgramScreen() {
  const { account } = useAppSelector((state) => state.auth);
  const query = publicQuery.offerPerks();
  const catalogue = useResource<PublicOfferPerks>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const [open, setOpen] = useState<OfferPerk | null>(null);
  const perks = catalogue.data?.perks ?? [];
  const resident = account?.role === ROLE.RESIDENT;

  return (
    <Screen
      footer={
        <View className="gap-2">
          {resident ? (
            <Button label="My offers" onPress={() => router.push("/offer-program/mine")} />
          ) : (
            <Button label="Find a hostel" onPress={() => router.push("/(browse)/search")} />
          )}
          {account ? null : (
            <Button
              label="Already a resident? Sign in"
              onPress={() => router.push("/(auth)/login")}
              variant="ghost"
            />
          )}
        </View>
      }
      header={<AppBar showBack title="" />}
      onRefresh={catalogue.refresh}
      refreshing={catalogue.refreshing}
      scroll
    >
      <View className="gap-8 pb-6 pt-4">
        <IntroHero
          icon="gift"
          line="Pay with your code. Get perks every quarter."
          orbit={["sparkles", "ribbon", "pricetag"]}
          title="Offer Program"
        />

        <View>
          <SectionHeader
            subtitle={catalogue.data?.quarter}
            title="This quarter"
          />

          {catalogue.loading && !catalogue.data ? (
            <Grid maxColumns={2} minCellWidth={140}>
              {[0, 1].map((key) => (
                <Skeleton height={190} key={key} radius={20} />
              ))}
            </Grid>
          ) : perks.length === 0 ? (
            <Card>
              <EmptyState
                compact
                description="Pay with your reference code to be ready."
                icon="gift"
                title="Perks are on their way"
              />
            </Card>
          ) : (
            <Grid maxColumns={2} minCellWidth={140}>
              {perks.map((perk, index) => (
                <PerkCard index={index} key={perk.id} onPress={() => setOpen(perk)} perk={perk} />
              ))}
            </Grid>
          )}
        </View>

        <Pressable
          accessibilityRole="button"
          className="self-center active:opacity-60"
          hitSlop={8}
          onPress={() => router.push("/offer-program/rules")}
        >
          <Text className="text-primary" variant="label">
            How it works
          </Text>
        </Pressable>
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} title={open?.title ?? "Perk"}>
        {open ? (
          <View className="gap-3 pb-2">
            <Text variant="label">{perkTerms(open)}</Text>
            <Text variant="caption">
              {[`From ${open.partner}`, open.giftValue ? `worth ${formatMoney(open.giftValue)}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {open.description ? <Text>{open.description}</Text> : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** The perk itself: its picture when the platform owner gave one, a tinted mark when not. */
function PerkCard({ index, onPress, perk }: { index: number; onPress: () => void; perk: OfferPerk }) {
  const { colors } = useAppTheme();
  const image = absoluteMediaUrl(perk.imageUrl, API_BASE_URL);
  const feeOff = perk.kind === "FEE_OFF";

  return (
    <Animated.View
      entering={FadeInDown.delay(200 + index * 70)
        .duration(320)
        .reduceMotion(ReduceMotion.System)}
    >
      <Pressable
        accessibilityLabel={`${perk.title}, ${perkTerms(perk)}`}
        accessibilityRole="button"
        className="overflow-hidden rounded-3xl border border-border bg-card active:opacity-80"
        onPress={onPress}
      >
        {image ? (
          <Image contentFit="cover" source={{ uri: image }} style={{ aspectRatio: 1, width: "100%" }} />
        ) : (
          <View className="aspect-square w-full items-center justify-center bg-primary/10">
            <Glyph color={colors.primary} name={feeOff ? "pricetag" : "gift"} size={40} />
          </View>
        )}
        <View className="gap-0.5 p-3">
          <Text numberOfLines={2} variant="label">
            {perk.title}
          </Text>
          <Text className="text-primary" numberOfLines={1} variant="caption">
            {feeOff ? `${perk.percentOff ?? 0}% off` : perk.giftValue ? formatMoney(perk.giftValue) : "Gift"}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}
