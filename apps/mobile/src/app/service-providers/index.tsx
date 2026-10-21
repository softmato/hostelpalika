import { router } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { IntroHero, IntroSteps } from "@/components/intro-hero";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import type { ProviderApplication } from "@/lib/provider-api";
import { providerQuery } from "@/lib/provider-queries";
import { providerStatusPanelFor } from "@/lib/provider-status";

/**
 * "Become a service provider" — the first glimpse from Home's door.
 *
 * Icons first, almost no words (2026-10-21): the configured pitch, stats and
 * "where your jobs come from" mockups were two screenfuls before the one
 * control on the page, and they still live on the website's
 * `/service-providers`. What stays is what the reader needs: who they are to
 * us right now, and the one thing to do next.
 *
 * ## Four states, and the third is the one a two-state check gets wrong
 *
 * An approved provider must not be shown "Apply" — there is nothing left to
 * apply for and the server would 409 them. Someone with an application *under
 * review* must not be shown it either, but the honest thing to tell them is
 * different: they are waiting, not finished. Only a rejected applicant may apply
 * again (`ACTIVE_APPLICATION_STATUSES` in the service). The sentences for those
 * states come from `lib/provider-status.ts`, shared with the Profile banner.
 */
export default function ServiceProvidersScreen() {
  const account = useAppSelector((state) => state.auth.account);

  /*
   * Only asked when there is a session — the route reads the caller's own
   * `userId`. `null` is the normal answer ("never applied"), and a failed lookup
   * must not strand someone who has never applied: it falls through to Apply.
   */
  const query = providerQuery.application();
  const application = useResource<ProviderApplication | null>(
    useCallback(
      () => (account ? query.load().catch(() => null) : Promise.resolve(null)),
      [account, query],
    ),
    { cacheKey: account ? query.key : undefined, topics: query.topics },
  );

  /*
   * The record when there is one, the token's flag when there is not: the
   * lookup can lag `/auth/me`, and offering the form in that gap is how
   * somebody sends a second application the server refuses.
   */
  const panel = providerStatusPanelFor(
    application.data?.status ?? (account?.isServiceProvider ? "APPROVED" : null),
    application.data?.rejectionReason,
  );
  const fresh = panel.canApply && !application.data;
  const loading = Boolean(account) && application.loading;

  return (
    <Screen
      footer={
        loading ? null : panel.showJobs ? (
          <Button label="Go to your jobs" onPress={() => router.push("/(provider)")} />
        ) : panel.canApply ? (
          <Button
            label={application.data ? "Start a new application" : "Apply now"}
            onPress={() => router.push("/service-providers/apply")}
          />
        ) : null
      }
      header={<AppBar showBack title="" />}
      scroll
    >
      {loading ? (
        <View className="items-center gap-3 pt-6">
          <Skeleton height={200} radius={100} width={200} />
          <Skeleton height={22} width="60%" />
          <Skeleton height={14} width="75%" />
        </View>
      ) : (
        <View className="gap-10 pb-6 pt-4">
          <IntroHero
            icon="construct"
            line={fresh ? "Hostels send repair jobs to you." : panel.body}
            orbit={["hammer", "flash", "water"]}
            title={fresh ? "Work with hostels" : application.data && panel.canApply ? "Apply again" : panel.title}
          />

          {fresh ? (
            <IntroSteps
              steps={[
                { icon: "construct", label: "Your trades" },
                { icon: "location", label: "Your area" },
                { icon: "camera", label: "Photo ID" },
              ]}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}
