import { router } from "expo-router";
import { View } from "react-native";

import { PortalBrandHeader } from "@/components/portal-shared";
import { JobRowDivider, ProviderHero, ProviderJobRow } from "@/components/provider-home";
import { Card, SectionHeader } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import type { ProviderJob, ProviderJobBoard } from "@/lib/provider-api";
import {
  completedJobCount,
  isOpenJob,
  openJobCount,
  overdueJobCount,
  sortProviderJobs,
  urgentJobCount,
} from "@/lib/provider-jobs";
import { providerQuery } from "@/lib/provider-queries";

/**
 * The provider's job board: open jobs they can accept (their trade first, then
 * every other trade), then their own work, open first.
 *
 * Accepting happens on the job screen, which is also where a provider reads the
 * description before committing — a one-tap accept on a row would take jobs
 * nobody had read.
 *
 * ## Nothing about residents appears here
 *
 * `listOwnServiceProviderJobs` returns the hostel's name, area and phone and
 * deliberately no resident details: a maintenance job is about a place. The
 * `location` string ("Room 204") is free text the admin typed, not a link to
 * anybody.
 *
 * ## The front door of a portal, not a list with a label on it
 *
 * This tab opened on `<AppBar title="Jobs" />` while every other role's home
 * opened on the platform lockup, the bell and a painted account card. Two things
 * were actually wrong with that. The app never said what it was to the one
 * audience that installs it for work rather than for a room — and the bell was
 * missing from all four provider tabs, in a portal the server routes four push
 * categories to. `<ProviderHero>` carries the rest; see `provider-home.tsx`.
 *
 * ## Against `provider-jobs-page.tsx` (§5.4)
 *
 * The web draws each job as a full card — title, hostel, description, category,
 * location, schedule and phone. **The rows stay rows here.** A provider opens
 * this to answer "how much work do I have and where", and eight cards deep
 * enough to hold a description is two jobs per screenful; the detail screen
 * already carries the description, the voice note and the call button, which is
 * the tap the web card exists to save and a phone does not need saving.
 *
 * What the rows lacked was a grid. Every fact sat wherever its neighbour left
 * room — see `META_WIDTH` in `provider-home.tsx` for the ragged right edge that
 * fixed.
 */
export default function ProviderJobsScreen() {
  const dates = useDates();
  const account = useAppSelector((state) => state.auth.account);
  const query = providerQuery.jobs();
  const board = useResource<ProviderJobBoard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
   * No hostel page and no SOS: a provider works for several hostels or none, so
   * there is no one listing for the eye to open — `PortalBrandHeader` hides that
   * control when no handler is passed.
   */
  const header = <PortalBrandHeader />;

  if (board.loading) {
    return (
      /* The hero, then a heading and rows — the shape it lands in (NOTES §9). */
      <Screen header={header} insideTabs padded={false} scroll>
        <View className="px-3.5">
          <Skeleton height={210} radius={18} />
        </View>

        <View className="gap-3 px-5 pt-6">
          <Skeleton height={18} width="40%" />
          <Skeleton height={230} radius={16} />
        </View>
      </Screen>
    );
  }

  if (board.error || !board.data) {
    return (
      <Screen header={header} insideTabs padded={false}>
        <View className="px-5">
          <ErrorState
            message={board.error ?? "Your jobs could not be loaded."}
            onRetry={board.reload}
          />
        </View>
      </Screen>
    );
  }

  const jobs = board.data.jobs;
  const mine = board.data.available.filter((job) => job.inMyTrade);
  const others = board.data.available.filter((job) => !job.inMyTrade);
  const sorted = sortProviderJobs(jobs);
  const open = sorted.filter(isOpenJob);
  const closed = sorted.filter((job) => !isOpenJob(job));

  /*
   * How many buildings this provider is working for, from the list itself. It is
   * the one fact the hero states that is not a count of jobs, and deriving it
   * here rather than asking `/service-providers/me` keeps the portal's front
   * door on a single request with a single way to fail.
   */
  const hostelCount = new Set(
    jobs.map((job) => job.hostelName.trim()).filter(Boolean),
  ).size;

  /**
   * When a job is wanted, in the reader's own calendar.
   *
   * A scheduled day is a commitment and reads as one; without a schedule the
   * honest thing to show is when the hostel raised it, because that is the only
   * date the job has. `relativeDay` collapses today and yesterday to words —
   * which is most of what an open queue contains.
   */
  const when = (job: ProviderJob) =>
    job.scheduledFor
      ? dates.relativeDay(job.scheduledFor)
      : job.createdAt
        ? dates.relativeDay(job.createdAt)
        : "";

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={board.refresh}
      padded={false}
      refreshing={board.refreshing}
      scroll
    >
      <ProviderHero
        completed={completedJobCount(jobs)}
        hostelCount={hostelCount}
        name={account?.name || "Your work"}
        open={openJobCount(jobs)}
        overdue={overdueJobCount(jobs)}
        urgent={urgentJobCount(jobs)}
      />

      <View className="gap-6 px-5 pt-6">
        {sorted.length === 0 && board.data.available.length === 0 ? (
          <Card>
            <EmptyState icon="briefcase"
              description="When a hostel raises work in your trade, you'll be notified and it appears here to accept."
              title="No jobs yet"
            />
          </Card>
        ) : null}

        {[
          { list: mine, subtitle: "Accept one to get the hostel's number", title: "In your trade" },
          { list: others, subtitle: "Open to any provider", title: "Other trades" },
        ].map((section) =>
          section.list.length > 0 ? (
            <View key={section.title}>
              <SectionHeader
                subtitle={section.subtitle}
                title={`${section.title} · ${section.list.length}`}
              />
              <Card>
                {section.list.map((job, index) => (
                  <View key={job.id}>
                    {index > 0 ? <JobRowDivider /> : null}
                    <ProviderJobRow
                      job={job}
                      onPress={() => router.push(`/job/${job.id}`)}
                      when={when(job)}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ) : null,
        )}

        {open.length > 0 ? (
          <View>
            {/*
              The heading sits on the page, outside the card — NOTES §5. It also
              carries the count, so the section says how much work it holds
              before a row of it is read.
            */}
            <SectionHeader subtitle="Soonest first" title={`Your open jobs · ${open.length}`} />
            <Card>
              {open.map((job, index) => (
                <View key={job.id}>
                  {index > 0 ? <JobRowDivider /> : null}
                  <ProviderJobRow
                    job={job}
                    onPress={() => router.push(`/job/${job.id}`)}
                    when={when(job)}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {closed.length > 0 ? (
          <View>
            {/*
              Its own card under its own heading, rather than the hairline-plus-
              caption divider this list used to draw inside a single card.
              That was written to keep the open list on the first screenful — but
              closed work sorts *below* open work, so a heading between them
              costs the open rows nothing and buys the boundary a shape the rest
              of the app already uses.
            */}
            <SectionHeader
              subtitle="Completed and cancelled"
              title={`Past work · ${closed.length}`}
            />
            <Card>
              {closed.map((job, index) => (
                <View key={job.id}>
                  {index > 0 ? <JobRowDivider /> : null}
                  <ProviderJobRow
                    job={job}
                    onPress={() => router.push(`/job/${job.id}`)}
                    when={when(job)}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {open.length === 0 && closed.length > 0 ? (
          <Text className="px-1" variant="caption">
            Nothing of yours is open right now. New jobs in your trade arrive as a
            notification.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
