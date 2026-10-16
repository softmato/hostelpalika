import { router } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { DocumentScreen } from "@/components/document-screen";
import { MockupImage } from "@/components/mockup-image";
import { IconPoint } from "@/components/step-flow";
import { Button } from "@/components/ui/button";
import { Lottie } from "@/components/ui/lottie";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { MOCKUPS } from "@/lib/portal-mockups";
import type { ProviderApplication } from "@/lib/provider-api";
import { providerQuery } from "@/lib/provider-queries";
import { providerStatusPanelFor } from "@/lib/provider-status";

/**
 * "Become a service provider" — the app's version of `/service-providers`.
 *
 * The pitch, the stat strip and the sections are the platform's configured copy,
 * shared with the website's hero. What is different is who is reading: this
 * screen is inside the app an approved provider will actually work from, so it
 * can say that plainly, recognise a provider who has already been approved
 * instead of inviting them to apply twice, and — since 2026-08-19 — take the
 * application itself rather than handing it to a browser.
 *
 * ## The apply block moved to the top
 *
 * It used to be `extra`, i.e. after the intro, the four stats and every section.
 * On a phone that is two screenfuls of scrolling before the one control on the
 * page. A tradesperson who opened this screen having already decided to apply had
 * to read the argument for applying in order to find the button. See
 * `InfoActions`.
 */
export default function ServiceProvidersScreen() {
  const account = useAppSelector((state) => state.auth.account);

  /*
   * Only asked when there is a session — the route reads the caller's own
   * `userId`, so signed out there is nothing to ask about. `null` from it is the
   * normal answer ("never applied"), not an error, and a failed lookup must not
   * strand someone who has never applied: it falls through to the ordinary CTA.
   */
  const query = providerQuery.application();
  const application = useResource<ProviderApplication | null>(
    useCallback(
      () => (account ? query.load().catch(() => null) : Promise.resolve(null)),
      [account, query],
    ),
    { cacheKey: account ? query.key : undefined, topics: query.topics },
  );

  return (
    <DocumentScreen
      action={
        <ApplyBlock
          application={application.data}
          isApproved={Boolean(account?.isServiceProvider)}
          isSignedIn={Boolean(account)}
          loading={application.loading}
        />
      }
      comingSoon="More about working with hostels is being designed — it arrives in an upcoming update."
      icon="construct"
      extra={<JobSource />}
      page="serviceProviders"
      webPath="service-providers"
      title="Service providers"
    />
  );
}

/**
 * Where a job comes from, in the two screens it passes through: a resident
 * reports the fault, the hostel sends it to a provider by name. Same pair as the
 * website's How it works.
 */
function JobSource() {
  return (
    <View className="gap-4">
      <Text variant="subtitle">Where your jobs come from</Text>
      {[
        { label: "A resident reports what is broken", mockup: MOCKUPS.residentPortal },
        { label: "The hostel sends the job to you", mockup: MOCKUPS.wardenDashboard },
      ].map(({ label, mockup }) => (
        <View className="gap-2 rounded-3xl border border-border bg-muted/40 p-4" key={label}>
          <MockupImage mockup={mockup} />
          <Text className="font-semibold">{label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Four states, and the third is the one a two-state check gets wrong.
 *
 * An approved provider must not be shown "Apply" — there is nothing left to
 * apply for and the server would 409 them. Someone with an application *under
 * review* must not be shown it either, for the same reason, but the honest thing
 * to tell them is different: they are waiting, not finished. Only a rejected
 * applicant may apply again, which is `isApplicationOpen` on the website and the
 * `ACTIVE_APPLICATION_STATUSES` check in the service.
 *
 * All four sentences come from `lib/provider-status.ts`, which is also what the
 * Profile tab's banner and the provider's own card tab read. They used to be
 * written out here, and this copy was the one that drifted: it promised jobs
 * "broadcast by hostels in your trades and area" to somebody deciding whether to
 * apply, and there is no broadcast anywhere in the product — a hostel admin
 * assigns a provider by name, which is the whole of the marketplace.
 */
function ApplyBlock({
  application,
  isApproved,
  isSignedIn,
  loading,
}: {
  application: ProviderApplication | null;
  isApproved: boolean;
  isSignedIn: boolean;
  loading: boolean;
}) {
  if (isSignedIn && loading) {
    // The block's own shape. The lookup resolves a beat after the first frame,
    // and a card that appears late shifts the page under whoever was reading.
    return (
      <View className="items-center gap-3">
        <Skeleton height={140} radius={70} width={140} />
        <Skeleton height={22} width="70%" />
        <Skeleton height={14} width="85%" />
        <Skeleton className="mt-2" height={48} />
      </View>
    );
  }

  /*
   * The record when there is one, the token's flag when there is not.
   * `/auth/me` says whether this account is an approved provider on every
   * launch; the record lookup can be a beat behind it or have failed outright,
   * and offering the form in that gap is how somebody sends a second
   * application the server refuses.
   */
  const panel = providerStatusPanelFor(
    application?.status ?? (isApproved ? "APPROVED" : null),
    application?.rejectionReason,
  );

  // One animation, one line, one action — the ID card invitation's shape (`IdCardPrompt`).
  return (
    <View className="gap-5">
      <View className="items-center gap-3">
        <Lottie
          loop={false}
          size={150}
          source={require("../../../assets/lottie/provider-apply.lottie")}
        />
        <Text className="text-center" variant="title">
          {panel.canApply && application ? "Apply again" : panel.title}
        </Text>
        <Text className="text-center" variant="muted">
          {panel.body}
        </Text>
      </View>

      {panel.canApply && !application ? (
        <View className="gap-3">
          <IconPoint
            delay={250}
            icon="construct"
            text="Pick every trade you work in and the area you cover."
          />
          <IconPoint
            delay={400}
            icon="camera"
            text="A photo taken on this phone becomes your provider ID card."
          />
          <IconPoint
            delay={550}
            icon="cloud-done"
            text="Your progress saves as you go, so you can finish later."
          />
        </View>
      ) : null}

      {panel.showJobs ? (
        <Button
          label="Go to your jobs"
          onPress={() => router.push("/(provider)")}
        />
      ) : null}

      {panel.canApply ? (
        <Button
          label={
            application
              ? "Start a new application"
              : "Apply as a service provider"
          }
          onPress={() => router.push("/service-providers/apply")}
        />
      ) : null}
    </View>
  );
}
