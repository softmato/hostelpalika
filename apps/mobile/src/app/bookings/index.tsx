import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, FailureState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { API_BASE_URL } from "@/lib/api";
import { type BookingSummary, isOpenBooking, listMyBookings } from "@/lib/booking-api";
import { absoluteMediaUrl } from "@/lib/media";

/**
 * My bookings — docs/BOOKINGS.md item 23. Open ones first (they have a next
 * step), then everything that has ended, each under its heading outside the card.
 */
export default function MyBookingsScreen() {
  const bookings = useResource<BookingSummary[]>(useCallback(() => listMyBookings(), []), {
    cacheKey: "my-bookings",
  });
  const dates = useDates();
  const header = <AppBar showBack title="My bookings" />;

  if (bookings.loading) {
    return (
      <Screen header={header} scroll>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  if (bookings.error || !bookings.data) {
    return (
      <Screen header={header}>
        <FailureState message={bookings.error ?? "Your bookings could not be loaded."} onRetry={bookings.reload} />
      </Screen>
    );
  }

  if (bookings.data.length === 0) {
    return (
      <Screen header={header}>
        <EmptyState
          action={<Button label="Find a hostel" onPress={() => router.push("/hostels")} />}
          description="Book a bed from a hostel's room types."
          icon="calendar"
          title="No bookings yet"
        />
      </Screen>
    );
  }

  const open = bookings.data.filter((booking) => isOpenBooking(booking.status));
  const ended = bookings.data.filter((booking) => !isOpenBooking(booking.status));

  const group = (title: string, rows: BookingSummary[]) =>
    rows.length > 0 ? (
      <View>
        <SectionHeader title={title} />
        <Card padding="px-4 py-1">
          {rows.map((booking) => {
            const cover = absoluteMediaUrl(booking.coverPhotoUrl, API_BASE_URL);

            return (
              <ListRow
                icon="bed"
                key={booking.id}
                left={
                  cover ? (
                    <Image
                      contentFit="cover"
                      source={{ uri: cover }}
                      style={{ borderRadius: 10, height: 44, width: 44 }}
                      transition={150}
                    />
                  ) : undefined
                }
                onPress={() => router.push({ params: { id: booking.id }, pathname: "/booking/[id]" })}
                right={<Badge label={booking.statusLabel} tone={isOpenBooking(booking.status) ? "success" : "neutral"} />}
                subtitle={`${booking.roomType} · ${booking.code} · ${dates.date(booking.createdAt)}`}
                title={booking.hostelName}
              />
            );
          })}
        </Card>
      </View>
    ) : null;

  return (
    <Screen header={header} onRefresh={bookings.refresh} refreshing={bookings.refreshing} scroll>
      <View className="gap-6">
        {group("Open", open)}
        {group("Ended", ended)}
        <Button
          label="How booking works"
          onPress={() => router.push("/legal/how-booking-works")}
          variant="ghost"
        />
      </View>
    </Screen>
  );
}
