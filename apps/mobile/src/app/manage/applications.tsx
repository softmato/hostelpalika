import { router } from "expo-router";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Card, SectionHeader } from "@/components/ui/card";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import type { AdmissionForm, AdmissionForms } from "@/lib/admission-form-api";
import { adminQuery } from "@/lib/admin-queries";
import { formatTime } from "@/lib/format";

/**
 * Admission forms people filled through the hostel's Form QR, waiting for a
 * bed. Grouped by the day they came in, heading outside the cards; a row opens
 * the normal intake at the form, read back — pick a bed, register.
 */
export default function ApplicationsScreen() {
  const dates = useDates();
  const query = adminQuery.admissionForms();
  const forms = useResource<AdmissionForms>(query.load, { cacheKey: query.key, topics: query.topics });
  const header = <AppBar accent centerTitle showBack subtitle="Filled through your Form QR" title="Admission forms" />;

  if (forms.loading) {
    return (
      <Screen header={header}>
        <SkeletonRows rows={4} />
      </Screen>
    );
  }

  if (forms.error || !forms.data) {
    return (
      <Screen header={header}>
        <ErrorState message={forms.error ?? "The forms could not be loaded."} onRetry={forms.reload} />
      </Screen>
    );
  }

  const days = new Map<string, AdmissionForm[]>();

  for (const form of forms.data.forms) {
    const day = dates.date(form.submittedAt);

    days.set(day, [...(days.get(day) ?? []), form]);
  }

  return (
    <Screen header={header} onRefresh={forms.refresh} refreshing={forms.refreshing} scroll>
      {days.size === 0 ? (
        <Card>
          <EmptyState
            compact
            description="Open Register a resident and swipe to Form QR. Whoever scans it and sends the form shows up here."
            title="No forms waiting"
          />
        </Card>
      ) : (
        <View className="gap-5 pt-1">
          {[...days].map(([day, list]) => (
            <View className="gap-2" key={day}>
              <SectionHeader title={day} />
              {list.map((form) => {
                const name = `${form.firstName} ${form.lastName}`.trim();

                return (
                  <CardRow
                    key={form.id}
                    left={<PersonAvatar image={form.photo} name={name} size="md" />}
                    onPress={() => router.push({ params: { application: form.id }, pathname: "/manage/resident/new" })}
                    subtitle={[form.phone, form.details?.institution, formatTime(form.submittedAt)]
                      .filter(Boolean)
                      .join(" · ")}
                    title={name}
                  />
                );
              })}
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}
