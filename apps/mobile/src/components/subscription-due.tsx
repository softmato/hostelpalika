import { router } from "expo-router";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { type AdminSubscription, hasClaimInReview } from "@/lib/admin-api";

/**
 * "Pay this much, by this date" — the plan shortfall a team registration leaves.
 *
 * ## Why this card exists at all
 *
 * A hostel our field team registered goes live the moment the agent submits it,
 * whether or not the owner paid the whole plan price that day. Anything short
 * becomes a due, and the owner is then running a published listing while owing
 * money — so the reminder has to reach them where they actually work, which for
 * most hostel owners is the phone rather than the portal.
 *
 * ## Why it is a card and not a strip
 *
 * `NOTES.md` §11: two registers of information in one card, separated by a rule
 * — the claim on top, the position below it. That is exactly the shape of this
 * message. The amount and what it is for lead; the deadline and the action sit
 * under a hairline. A one-line coloured strip could carry the number but not the
 * date, and the date is the half that makes it actionable.
 *
 * The tone is `warning`, not `destructive`. Nothing has gone wrong — an agreement
 * is being honoured on a schedule — and painting it red would make an ordinary
 * instalment look like a suspension notice.
 *
 * ## It renders nothing far more often than it renders
 *
 * Every hostel that registered itself paid before it was published, so it never
 * owes anything and never sees this. `PAST_DUE` with money actually outstanding
 * is the only state that produces a card; everything else returns `null` rather
 * than an empty state, because there is no news to give.
 *
 * ## Two states, and the second one exists to stop a hostel paying twice
 *
 * A balance stays outstanding while a manual payment claim is being reviewed —
 * only settled money moves it — so an owner who paid an hour ago and sent us
 * the screenshot on the website would otherwise be looking at exactly the card
 * they were looking at before. The natural reading of that is that the first
 * attempt did not take. So while a claim is in review the card says so; the
 * amount stays, because it is still owed and the card would be lying by
 * omission without it.
 *
 * ## It states the balance and never takes the payment
 *
 * No *Pay now*, no link to the website, no QR — and that is the store's rule,
 * not a gap. A plan is business software, and Google Play's Payments policy
 * requires Play Billing for that when it is bought in the app, and bans in-app
 * buttons, links, webviews and messaging that lead to any other way of paying.
 * The owner pays on the website's billing page. This card gives them the amount,
 * the deadline and the invoice, which is everything a payment made elsewhere
 * needs.
 *
 * `manage/pay-plan` (our QR plus a proof upload) was removed on 2026-09-15 for
 * exactly this reason. Do not add a pay or "open the website" button back: it is
 * the pattern the policy names.
 */
export function SubscriptionDueCard({
  state,
}: {
  state: AdminSubscription | null;
}) {
  const dates = useDates();

  if (
    !state ||
    state.subscription.status !== "PAST_DUE" ||
    state.outstanding <= 0
  ) {
    return null;
  }

  const reviewing = hasClaimInReview(state);

  /*
   * The date, in the reader's own calendar — not "in 12 days".
   *
   * A countdown has to read the clock during render, which is impure and gives
   * a number that silently goes stale on a screen somebody leaves open. The date
   * is also the more useful half: an owner arranging a payment needs the day
   * they have to hit, and `useDates` gives it to them in Bikram Sambat if that
   * is what they read the rest of the app in.
   */

  return (
    <Card className="gap-3 border-warning/40 bg-warning/5">
      <ListRow
        icon={reviewing ? "time-outline" : "alert-circle-outline"}
        right={<Money owed size="large" value={state.outstanding} />}
        subtitle={
          reviewing
            ? "We are checking the proof you sent"
            : state.subscription.planName
              ? `Balance on your ${state.subscription.planName}`
              : "Balance on your plan"
        }
        title={reviewing ? "Payment in review" : "Payment due"}
      />

      {/*
        Date on its own line, the action on the next: the long form of a BS date
        ("Aswin 8, 2083 BS · Thursday") beside a button is wider than a 360dp
        card.
      */}
      <View className="gap-3 border-t border-border pt-3">
        <Text variant="caption">
          {reviewing
            ? "We will email you within 1–2 working days. Your plan keeps working until then."
            : state.subscription.dueBy
              ? `Due by ${dates.dateLong(state.subscription.dueBy)}`
              : "Your listing stays live in the meantime."}
        </Text>

        <View className="flex-row items-center justify-end">
          {/*
            The card's one action is the invoice. The owner may want to check
            what the balance is actually for, forward it to whoever holds the
            money, or see what was already collected in the field. Sending them
            to hunt for it under More is how a due card becomes something people
            dismiss rather than act on.
          */}
          <Button
            label="View billing"
            onPress={() => router.push("/manage/billing")}
            size="sm"
            variant="outline"
          />
        </View>
      </View>
    </Card>
  );
}

/**
 * "Enjoy the free Go plan this month" — while a hostel is on its free months.
 *
 * Facts only, like the due card above: which month this is, how many are left,
 * and the last free day. The website's copy of this card also says where the
 * plan is recharged afterwards; the app may not (Play payments rule).
 */
export function FreeMonthCard({ state }: { state: AdminSubscription | null }) {
  const dates = useDates();
  const now = state?.subscription.freeMonthNow;

  if (!state || !now) {
    return null;
  }

  return (
    <Card className="gap-3">
      <ListRow
        icon="gift-outline"
        subtitle={
          now.left > 0
            ? `${now.left} more free ${now.left === 1 ? "month" : "months"} after this one`
            : "Your last free month"
        }
        title={`Enjoy the free ${state.subscription.planName ? `${state.subscription.planName} plan` : "plan"} this month`}
      />
      <View className="border-t border-border pt-3">
        <Text variant="caption">
          Free month {now.month} of {now.of} · free until{" "}
          {dates.dateLong(state.subscription.freeUntil ?? now.endsAt)}
        </Text>
      </View>
    </Card>
  );
}
