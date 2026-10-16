import { Pressable, View } from "react-native";

import { HERO_AMOUNT_LEAD_TRIM, HERO_LINE_GAP, PortalHeroCard } from "@/components/portal-shared";
import { StatusText } from "@/components/ui/badge";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import type { ProviderJob } from "@/lib/provider-api";
import {
  isOverdueJob,
  jobCategoryIcon,
  type JobTone,
  jobPlace,
  jobTone,
  jobUrgencyLabel,
} from "@/lib/provider-jobs";

/**
 * The parts the provider's Jobs tab is built out of.
 *
 * ## Why this portal now looks like the other four
 *
 * Jobs opened with a bare `<AppBar title="Jobs" />` — no lockup, no bell — while
 * the resident, guardian, cook and admin homes all open on
 * `<PortalBrandHeader>` over a painted account card. A tradesperson signing in
 * on a phone that also has eSewa and EBL Touch on it was the one audience the
 * app never introduced itself to, and the bell was the sharper problem: the
 * server routes `MAINTENANCE`, `PLUMBER`, `ELECTRICIAN` and `SERVICE_PROVIDER`
 * pushes to `/(provider)`, so a provider had notifications and no control in
 * any of their four tabs that opened them.
 *
 * The hero is the same object as the other four — `ebl-01`'s account card, per
 * `NOTES.md` §2 — carrying what a provider's day is actually about: how much
 * work is waiting, how much of it cannot wait, and how much they have finished.
 * It is drawn from the job list the screen already has, so the front door of
 * this portal costs no second request and has no second way to fail.
 *
 * ## No photograph, and no hostel
 *
 * `PortalHeroCard` falls back to `HeroOrnament` when `photoUrl` is null, which
 * is what this needs: a provider works for several hostels or none, so there is
 * no one building to put behind the card and no listing for the header's eye to
 * open. `PortalBrandHeader` hides that control when no `onHostelPage` is passed.
 */

/* -------------------------------------------------------------------------- */
/* Hero                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Point size of the open-job count.
 *
 * Written as a style, not `text-[40px]`: NativeWind builds its class list from a
 * build-time scan, so an arbitrary value used once resolves to nothing until the
 * bundler rebuilds — and the figure would silently render at body size. Every
 * measured dimension in the portal heroes follows that rule.
 */
const COUNT_SIZE = 42;

export function ProviderHero({
  completed,
  hostelCount,
  name,
  open,
  overdue,
  urgent,
}: {
  completed: number;
  /** Distinct hostels with work on this list — derived, never requested. */
  hostelCount: number;
  name: string;
  open: number;
  overdue: number;
  urgent: number;
}) {
  /*
   * One line about the figure above it, and it changes with the figure.
   *
   * Overdue outranks urgent: a job whose day has already gone by is a promise
   * already broken, and it is the only thing on this card a provider should act
   * on before reading the list.
   */
  const note =
    overdue > 0
      ? `${overdue} past its day`
      : open === 0
        ? "Nothing waiting on you"
        : "Soonest first, below";

  return (
    <PortalHeroCard
      footer={<ProviderHeroRegister completed={completed} urgent={urgent} />}
      photoUrl={null}
    >
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1" style={{ gap: HERO_LINE_GAP }}>
          <Text
            className="font-semibold text-white"
            numberOfLines={1}
            style={{ fontSize: 18 }}
          >
            {name}
          </Text>

          {/*
            Two rows with a glyph each rather than one string joined by a `·` —
            the resident hero learnt on a device that a joined line wraps in the
            middle of whichever fact is longest once a pill sits beside it.
          */}
          <View className="gap-1.5">
            {[
              { icon: "construct", text: "Service provider" },
              {
                icon: "business",
                text:
                  hostelCount === 0
                    ? "No hostel has sent you work yet"
                    : `${hostelCount} ${hostelCount === 1 ? "hostel" : "hostels"} sending you work`,
              },
            ].map((row) => (
              <View className="flex-row items-center gap-1.5" key={row.icon}>
                <Glyph
                  color="rgba(255,255,255,0.75)"
                  name={row.icon as GlyphName}
                  size={12}
                />
                <Text
                  className="flex-1 text-white/80"
                  numberOfLines={1}
                  style={{ fontSize: 13, letterSpacing: 0.3 }}
                >
                  {row.text}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/*
          A frosted pill, not a `<Badge>`. Badge tones resolve to themed tokens —
          `bg-success-soft` on near-black ink — which is correct on a card and
          invisible on the paint. Reaching this screen at all means the record is
          APPROVED (`resolveHome` routes on exactly that), so the pill states a
          fact rather than tracking one.
        */}
        <View className="rounded-full bg-white/20 px-3 py-1.5">
          <Text className="font-semibold text-white" numberOfLines={1} style={{ fontSize: 11 }}>
            Approved
          </Text>
        </View>
      </View>

      <View style={{ gap: 6, marginTop: HERO_AMOUNT_LEAD_TRIM }}>
        <Text
          className="font-semibold uppercase tracking-wider text-white/75"
          numberOfLines={1}
          style={{ fontSize: 11 }}
        >
          Open jobs
        </Text>

        <Text
          className="font-semibold tracking-tight text-white"
          numberOfLines={1}
          /*
            A line box 1.45× the font, for the reason `PaintedAmount` documents:
            no font is bundled, OEM Android skins ship display faces whose
            ascenders run past the Roboto metrics a tighter box assumes, and the
            tops of the digits come back flat.
          */
          style={{ fontSize: COUNT_SIZE, lineHeight: Math.round(COUNT_SIZE * 1.45) }}
        >
          {open}
        </Text>

        <View className="mt-1.5 flex-row items-center gap-1.5">
          <Glyph
            color="rgba(255,255,255,0.8)"
            name={overdue > 0 ? "alert-circle" : "time"}
            size={13}
          />
          <Text className="flex-1 text-white/80" numberOfLines={1} style={{ fontSize: 12 }}>
            {note}
          </Text>
        </View>
      </View>
    </PortalHeroCard>
  );
}

/**
 * The card's second register: the two counts that are not today's queue.
 *
 * `NOTES.md` §11 — a themed surface inside the same corners, carrying a
 * different kind of information from the paint above it. The paint is *what is
 * waiting*; this is how much of it cannot wait and how much is behind them.
 *
 * Each half takes a fixed fraction of the row rather than being sized to its
 * content — the rule the deleted `BannerFacts` left behind, learnt when chips
 * sized to their text gave up width to each other until every one of them
 * ellipsed.
 */
function ProviderHeroRegister({
  completed,
  urgent,
}: {
  completed: number;
  urgent: number;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row items-center px-4 py-3">
      {[
        {
          ink: urgent > 0 ? colors.destructive : colors.mutedForeground,
          label: "Needs attention",
          value: String(urgent),
        },
        {
          ink: colors.mutedForeground,
          label: "Completed",
          value: String(completed),
        },
      ].map((half, index) => (
        <View className="w-1/2 flex-row items-center" key={half.label}>
          {index === 1 ? <View className="mr-3 h-7 w-px bg-border" /> : null}
          <View className="flex-1">
            <Text
              className="font-semibold uppercase tracking-wider text-muted-foreground"
              numberOfLines={1}
              style={{ fontSize: 10 }}
            >
              {half.label}
            </Text>
            <Text
              className="font-bold"
              numberOfLines={1}
              style={{ color: half.ink, fontSize: 17 }}
            >
              {half.value}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The row                                                                    */
/* -------------------------------------------------------------------------- */

const TILE_TINT: Record<JobTone, string> = {
  brand: "bg-brand-soft",
  danger: "bg-destructive-soft",
  neutral: "bg-muted",
  warning: "bg-warning-soft",
};

const TILE_INK: Record<JobTone, "destructive" | "mutedForeground" | "primary" | "warning"> = {
  brand: "primary",
  danger: "destructive",
  neutral: "mutedForeground",
  warning: "warning",
};

/**
 * Width of the right-hand column, in points.
 *
 * Fixed, and that is the whole point of it. The row this replaced put a filled
 * `<StatusPill>` above a filled priority `<Badge>` in `ListRow`'s right slot:
 * two boxes whose widths came from their words, so `Pending`/`Urgent` and
 * `Completed` and `Scheduled` each ended at a different distance from the edge,
 * and the list had a ragged column of coloured rectangles down its right side
 * with the titles beside them starting wherever was left over. `<StatusText>`'s
 * own doc argues against exactly that shape.
 *
 * 84dp holds `Completed` and `Bhadra 12` at the sizes below on a 320dp phone,
 * which are the longest strings either line can carry.
 */
const META_WIDTH = 84;

/**
 * The leading tile, and the gap after it. The row's left column.
 *
 * Named because `<JobRowDivider>` has to start exactly where the text does:
 * `<RowDivider inset>` is `ml-12`, measured for `<ListRow>`'s 36dp circle, and
 * against this row's 40dp tile it lands 4dp early — a hairline that stops just
 * short of the column it is supposed to align with, which is the kind of
 * near-miss that reads as a rendering fault rather than as a choice.
 */
const TILE = 40;

const TILE_GAP = 12;

/** A hairline between job rows, inset to the start of the text column. */
export function JobRowDivider() {
  return <View className="h-px bg-border" style={{ marginLeft: TILE + TILE_GAP }} />;
}

/**
 * One job, as a row.
 *
 * Five facts in two lines and a fixed grid: the trade (the glyph), how urgent
 * and where (line two), what it is (line one), what state it is in and when it
 * is wanted (the right column). The description, the full address, the hostel's
 * number and the voice note are the detail screen's — a row answers "which job
 * is this", not "how do I do it".
 *
 * `onPress` rather than a chevron. Every row here opens, so a column of
 * chevrons is 24 points of screen spent saying what a list already says — and
 * the width it costs comes out of the title, which is the one thing a provider
 * is scanning for.
 */
export function ProviderJobRow({
  job,
  onPress,
  /** Already formatted by the caller through `useDates` — see that hook. */
  when,
}: {
  job: ProviderJob;
  onPress: () => void;
  when: string;
}) {
  const { colors } = useAppTheme();
  const tone = jobTone(job);
  const urgency = jobUrgencyLabel(job);
  const overdue = isOverdueJob(job);
  const place = jobPlace(job);

  return (
    <Pressable
      accessibilityLabel={[
        job.title,
        urgency ? `${urgency} priority` : null,
        place,
        when,
        job.status.toLowerCase(),
      ]
        .filter(Boolean)
        .join(". ")}
      accessibilityRole="button"
      className="flex-row items-center py-3 active:opacity-70"
      onPress={() => {        onPress();
      }}
      style={{ minHeight: 60 }}
    >
      <View
        className={`items-center justify-center rounded-xl ${TILE_TINT[tone]}`}
        style={{ height: TILE, width: TILE }}
      >
        <Glyph
          color={colors[TILE_INK[tone]]}
          name={jobCategoryIcon(job.category) as GlyphName}
          size={19}
        />
      </View>

      <View className="flex-1" style={{ marginLeft: TILE_GAP }}>
        <Text
          className="font-semibold text-foreground"
          numberOfLines={1}
          style={{ fontSize: 15 }}
        >
          {job.title}
        </Text>

        {/*
          The urgency word leads the line rather than sitting in a badge on the
          right, so the left edge of every subtitle still starts in the same
          place and the coloured word is inside the sentence it qualifies. It is
          the words-half of the tile's tint — see `jobUrgencyLabel`.
        */}
        <Text numberOfLines={1} variant="caption">
          {urgency ? (
            <Text
              className="font-semibold"
              style={{ color: tone === "danger" ? colors.destructive : colors.warning }}
            >
              {urgency}
              {place ? " · " : ""}
            </Text>
          ) : null}
          {place}
        </Text>
      </View>

      {/*
        Both lines right-aligned inside a fixed column, so the status and the
        date each sit on the same margin down the whole list.
      */}
      <View
        className="items-end gap-1"
        style={{ marginLeft: TILE_GAP, width: META_WIDTH }}
      >
        <StatusText status={job.status} />
        {when ? (
          /*
            A resolved colour, not a `text-*` class. `variant="caption"` already
            carries `text-muted-foreground`, and adding `text-destructive`
            through `className` does not replace it — both rules reach the
            compiled stylesheet and generation order decides the winner. The
            AppBar shipped a near-invisible subtitle to exactly this bug.
          */
          <Text
            className={overdue ? "font-semibold" : ""}
            numberOfLines={1}
            style={{
              color: overdue ? colors.destructive : colors.mutedForeground,
              fontSize: 11,
            }}
          >
            {when}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
