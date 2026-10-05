import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { BillExtras } from "@/components/bill-extras";
import { Sheet } from "@/components/ui/sheet";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { hasWalletLogo, WalletMark } from "@/components/ui/wallet-mark";
import {
  CopyButton,
  ManualMethodPanel,
  methodCaption,
  methodKey,
  methodLabel,
  methodProvider,
  PROVIDER_LABEL,
} from "@/components/pay-methods";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { planHandoff } from "@/lib/checkout";
import {
  type PayInstructions,
  type PayMethod,
  startCheckout,
} from "@/lib/finance-api";
import { formatDueLabel, formatMoney } from "@/lib/format";
import { residentQuery } from "@/lib/resident-queries";
import { toastError } from "@/lib/toast";
import { openPaymentUrl } from "@/lib/wallet";

/**
 * How to pay one invoice (target §11.1).
 *
 * **One method at a time.** Six panels of account numbers open at once is how
 * somebody pays the right hostel from the wrong app. The server sends the
 * methods already ordered — live checkouts first, then QR, then wallet ids,
 * then bank — so the primary is simply `methods[0]` and the rest are a list of
 * rows. No client-side opinion about which method is best can drift out of step
 * with the server's.
 *
 * ## The fold became a list of rows, and that is the whole redesign
 *
 * The alternatives lived behind a **disclosure** — a card whose header said
 * "Other ways to pay" with a chevron, which expanded into a column of every
 * remaining method's full panel: bank name, account name, account number, wallet
 * ids, QR, all at once, stacked. Two failures in one control. Closed, it hid the
 * existence of the methods a resident actually uses, so somebody with only a
 * bank account saw one eSewa button and a chevron. Open, it was the six-panels
 * problem the primary card exists to avoid, just one tap deeper.
 *
 * They are `<ListRow>`s now — name, one-line description, chevron — and tapping
 * one opens a **bottom sheet** with that method's details and nothing else.
 * `NOTES.md` §3 is explicit that a menu of destinations is rows or tiles rather
 * than expanded panels, and §6 is explicit that the thing a row opens is a
 * sheet. A resident scanning the list sees every way they *could* pay in one
 * screenful, and reads account numbers for exactly one of them.
 *
 * ## The reference code keeps the strongest treatment on the screen
 *
 * Statement matching, auto-settlement and the owner's review queue staying
 * empty all depend on the resident typing it into a banking app on another
 * device — so it is large, spaced, and one tap to copy.
 *
 * The instruction to submit proof afterwards is scoped to the *manual* methods:
 * a gateway payment settles itself, and telling a resident who just paid
 * through one to wait for approval is how they pay twice.
 *
 * ## No sticky footer
 *
 * It had one saying "I've paid — submit proof", which is a button asserting the
 * past tense on a screen the resident has not acted on yet. Worse, it was the
 * heaviest control on a screen whose actual primary action is the accented
 * button inside the recommended card — two filled greens, one of them wrong.
 * The claim form is reached from the Payments tab and from the invoice's own
 * footer, both of which are screens where "I have already paid" is a true thing
 * to be saying. Here the last word is the note that says when proof is needed.
 *
 * ## Every glyph on this screen is coloured
 *
 * Four `<Ionicons>` here carried **no `color`**, which renders black — so the
 * method icon on the primary card, the disclosure chevron, each folded method's
 * icon and the copy glyph were all invisible on a dark card in dark mode. It is
 * the same fault the Payments tab's statement button had, and the same fix: read
 * the resolved token.
 */

export default function PayInvoiceScreen() {
  const { colors } = useAppTheme();

  const { id } = useLocalSearchParams<{ id: string }>();
  const query = residentQuery.payInstructions(id);
  const instructions = useResource<PayInstructions>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /** Which alternative method's sheet is up, by `methodKey`. */
  const [openMethod, setOpenMethod] = useState<string | null>(null);

  const data = instructions.data;
  const header = <AppBar showBack title="Pay now" />;

  if (instructions.loading) {
    return (
      /* The amount card, the reference, then the recommended and other panels. */
      <Screen header={header} scroll>
        <View className="gap-4 pt-1">
          <Skeleton height={106} radius={16} />
          <Skeleton height={86} radius={16} />
          <Skeleton height={18} width="40%" />
          <Skeleton height={140} radius={16} />
          <Skeleton height={18} width="46%" />
          <Skeleton height={200} radius={16} />
        </View>
      </Screen>
    );
  }

  if (instructions.error || !data) {
    return (
      <Screen header={header}>
        <FailureState
          message={instructions.error ?? "Payment methods could not be loaded."}
          onRetry={instructions.reload}
          title="Couldn't load methods"
        />
      </Screen>
    );
  }

  const primary = data.methods[0] ?? null;
  const others = data.methods.slice(1);
  // Scoped to the whole list, not to the primary: a resident who opened a
  // sheet and paid by bank transfer is exactly the case where a missing
  // reference costs the owner a manual match.
  const needsReference = data.methods.some(
    (method) => method.kind !== "GATEWAY",
  );
  const sheetMethod =
    others.find((method) => methodKey(method) === openMethod) ?? null;

  return (
    <Screen
      header={header}
      onRefresh={instructions.refresh}
      refreshing={instructions.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        <AmountCard instructions={data} needsReference={needsReference} />

        {data.usable && primary ? (
          <>
            <View>
              <SectionHeader title="Recommended" />
              <Card className="gap-3">
                {/*
                  The provider's own mark where a generic glyph used to be. On a
                  card whose whole job is "this is who you are about to pay", a
                  `phone-portrait-outline` in our green identified nothing —
                  eSewa and Khalti drew the *same* glyph. `<WalletMark>` falls
                  back to one for a method that has no logo (bank, QR).
                */}
                <View className="flex-row items-center gap-2.5">
                  <WalletMark name={methodProvider(primary)} size={32} />
                  <Text variant="label">{methodLabel(primary)}</Text>
                </View>
                <MethodPanel invoiceId={id} method={primary} />
              </Card>
            </View>

            {others.length > 0 ? (
              <View>
                <SectionHeader title="Other ways to pay" />

                {/*
                  Rows, not an accordion. Each opens a sheet holding one
                  method's details — `NOTES.md` §3 and §6, and the argument in
                  this file's header comment.
                */}
                <Card padding="px-4 py-1">
                  {others.map((method, index) => (
                    <View key={methodKey(method)}>
                      {index > 0 ? <RowDivider /> : null}
                      <ListRow
                        left={
                          <WalletMark name={methodProvider(method)} size={36} />
                        }
                        onPress={() => setOpenMethod(methodKey(method))}
                        subtitle={methodCaption(method)}
                        title={methodLabel(method)}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}
          </>
        ) : (
          /*
            `usable: false` means the hostel has configured no way to be paid at
            all. Not an error and not an empty list — a fact about their setup,
            and the resident's rent is still due. So it says what to do next
            rather than only what is missing, and the claim route stays open:
            money paid in cash at the office still has to reach the record.
          */
          <Card>
            <EmptyState
              action={
                <Button
                  label="I've paid — submit proof"
                  onPress={() => router.push(`/invoice/${id}/claim`)}
                  variant="outline"
                />
              }
              compact
              description="Your hostel has not set up any payment method yet. Ask them how to pay, then submit your receipt so it still reaches your record."
              icon="card-outline"
              title="No payment methods"
              tone="warning"
            />
          </Card>
        )}

        {data.instructions ? (
          <Card>
            <Text variant="muted">{data.instructions}</Text>
          </Card>
        ) : null}

        {/*
          The last word on the screen, and scoped. A gateway checkout settles
          itself; telling somebody who just paid through one to submit a
          screenshot and wait is how they end up paying twice.
        */}
        {needsReference ? (
          <Card className="flex-row items-start gap-2.5">
            <Ionicons
              color={colors.mutedForeground}
              name="information-circle-outline"
              size={16}
            />
            <Text className="flex-1" variant="caption">
              After payment, submit proof only for manual methods.
            </Text>
          </Card>
        ) : null}
      </View>

      <Sheet
        onClose={() => setOpenMethod(null)}
        open={Boolean(sheetMethod)}
        title={sheetMethod ? methodLabel(sheetMethod) : undefined}
      >
        {sheetMethod ? (
          <View className="gap-3 pb-2">
            {hasWalletLogo(methodProvider(sheetMethod)) ? (
              <WalletMark name={methodProvider(sheetMethod)} size={44} />
            ) : null}
            <MethodPanel invoiceId={id} method={sheetMethod} />
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/**
 * What is being paid.
 *
 * The screen's whole first question — *how much, for what, by when, and what to
 * type in the remarks* — in the object the eye lands on. A plain card on the page
 * rather than a straddling one on paint: this screen's bar is not accented any
 * more (see `index.tsx` for why a pushed screen's bar says what the screen is
 * rather than what the record is), and a card pulled up onto nothing is a card
 * with a negative margin bug.
 *
 * ## The reference code lives in this card, not the one below it
 *
 * It shipped as a second `<Card>` stacked under this one, which put a border and
 * a gap between two halves of a single instruction: the resident opens their
 * banking app, types the amount, then types the code. Splitting those across two
 * objects made the code look like a separate topic the screen had moved on to.
 * One card, one hairline, both halves — the mockup's Pay-now screen has it this
 * way for the same reason.
 */
function AmountCard({
  instructions,
  needsReference,
}: {
  instructions: PayInstructions;
  needsReference: boolean;
}) {
  const dates = useDates();

  const dueLabel = formatDueLabel(instructions.dueDate);
  const late = Boolean(dueLabel?.includes("overdue"));
  const dueToday = dueLabel === "Due today";

  return (
    <Card className="gap-4">
      <View className="gap-1">
        <View className="flex-row items-start justify-between gap-3">
          <Text className="flex-1" variant="caption">
            Amount due
          </Text>

          {/*
            The lateness is a pill, and the only thing on the card wearing the
            destructive tone.

            It used to be a `·`-joined tail on the due-date line, which put the
            whole line — the date included — in red, so the card's loudest
            colour was spent on a fact that is not itself alarming. Worse, the
            red was applied as a resolved `style` colour because
            `variant="caption"`'s `text-muted-foreground` beat `text-destructive`
            in the compiled sheet: order decided it, not the call site. A
            `<Badge>` sidesteps both. The date goes back to grey, the status
            lands where the eye already goes for status on this screen, and it
            is the same "Overdue" chip the mockup's summary cards wear.
          */}
          {dueLabel ? (
            <Badge
              label={dueLabel}
              tone={late ? "danger" : dueToday ? "warning" : "neutral"}
            />
          ) : null}
        </View>

        <Money size="display" value={instructions.amountDue} />

        <BillExtras lines={instructions.extras} />

        {/* So they can sanity-check their own bill: "is this the right rent" is
          only answerable if the screen says what it is rent for. */}
        {instructions.bedLabel ? (
          <Text variant="muted">{instructions.bedLabel}</Text>
        ) : null}

        {instructions.dueDate ? (
          <Text variant="caption">
            {`Due date: ${dates.dateBoth(instructions.dueDate)}`}
          </Text>
        ) : null}

        {/*
          Below the amount now, not above it.

          The old note here said the opposite — a credit read after the number
          is a credit already ignored — and it was written when this badge was
          the card's only pill. It is not any more: sitting first it pushed
          "Amount due" and the lateness chip down a row and opened the card with
          a green pill about money the resident does *not* have to send, which is
          not the screen's question. It is a footnote to the amount, and reads as
          one from directly under it.
        */}
        {instructions.credit > 0 ? (
          <Badge
            className="mt-1"
            label={`${formatMoney(instructions.credit)} credit applied`}
            tone="success"
          />
        ) : null}
      </View>

      {instructions.referenceCode ? (
        <>
          <View className="h-px bg-border" />
          <ReferenceSection
            code={instructions.referenceCode}
            needsReference={needsReference}
          />
        </>
      ) : null}
    </Card>
  );
}

/**
 * The reference code, given the loudest treatment on the screen.
 *
 * A *section* of `<AmountCard>` rather than a card of its own — see that
 * component's note — so it renders no border and no background beyond the
 * painted block the code itself sits in.
 *
 * It carried a painted `bg-brand-soft` block for one revision and that was one
 * treatment too many: the code already sits alone under its own label, below a
 * hairline, in the heaviest weight on the card. A green box around it added a
 * second filled surface to a screen whose only filled surface should be the
 * accented pay button further down. The mockup's Pay-now card is a label, the
 * code, and a bare copy glyph on white — nothing else — and that is what this is.
 *
 * The copy affordance is the glyph on its own, in the brand green, no border and
 * no "Copy" label. `<DetailLine>` below still uses the bordered chip, and should:
 * a bank account number sits in a list of three near-identical rows where the
 * chip is what says which one you are about to take. Here there is exactly one
 * thing to copy on the whole card.
 *
 * The paragraph underneath used to argue the case for typing it — faster
 * confirmation, hand-matching, sometimes wrong. Three sentences of reasoning on
 * a screen whose reader is mid-payment and holding a second phone. It says what
 * the code buys them and stops; the argument, and the eligibility rules, live on
 * the offer-program screen the `i` opens.
 *
 * ## The `i` sits in the sentence, not in the header
 *
 * It began as a tile at the top-right of the section, which is the position a
 * screen uses for an action on the *section* — and this is not that. It explains
 * one noun in one sentence, so it belongs at the end of that sentence, small, the
 * way a footnote marker does. The whole line is the tap target; the glyph is only
 * the marker.
 *
 * `--info` exists for exactly this: "explain this", never "do this". Nothing blue
 * on this screen performs an action.
 */
function ReferenceSection({
  code,
  needsReference,
}: {
  code: string;
  needsReference: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="gap-2">
      <Text variant="caption">Reference code</Text>

      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-2xl font-bold tracking-wider text-foreground">
          {code}
        </Text>
        <CopyButton label="reference code" tone="glyph" value={code} />
      </View>

      {needsReference ? (
        <Pressable
          accessibilityHint="Opens the Resident Offer Program"
          accessibilityLabel="Fill this code as remark in your payment to get resident offer program. About the Resident Offer Program"
          accessibilityRole="button"
          className="active:opacity-70"
          hitSlop={6}
          onPress={() => router.push("/offer-program")}
        >
          {/*
            The glyph is nested *inside* the sentence, not laid beside it in a
            row. As a row sibling it was pushed to the card's right edge by the
            text's `flex-1` and ended up hanging in the white space after
            "program" — an icon floating at the margin, which reads as a control
            for the whole block rather than a marker on one phrase. Inline, it
            wraps with the last word the way a footnote marker does. `<Ionicons>`
            renders a glyph font inside a `<Text>`, so it nests.
          */}
          <Text variant="caption">
            Fill this code as remark in your payment to get resident offer
            program{" "}
            <Ionicons color={colors.info} name="information-circle" size={13} />
          </Text>
        </Pressable>
      ) : (
        <Text variant="caption">
          Added automatically when you pay through the app.
        </Text>
      )}
    </View>
  );
}

function MethodPanel({
  invoiceId,
  method,
}: {
  invoiceId: string;
  method: PayMethod;
}) {
  if (method.kind === "GATEWAY") {
    return <GatewayPanel invoiceId={invoiceId} method={method} />;
  }

  return <ManualMethodPanel method={method} />;
}

/**
 * Starts a live checkout and hands the resident to the provider.
 *
 * Every provider the server offers can be opened: a `REDIRECT` goes straight to
 * the wallet, and a `FORM_POST` — eSewa — goes through the server's `/pay`
 * relay, which is the only place the signature can be rebuilt. A handoff kind
 * this build does not recognise is reported *here*, after the intent exists but
 * before the resident thinks they have paid.
 */
function GatewayPanel({
  invoiceId,
  method,
}: {
  invoiceId: string;
  method: Extract<PayMethod, { kind: "GATEWAY" }>;
}) {
  const [busy, setBusy] = useState(false);
  const label = PROVIDER_LABEL[method.provider];

  const start = useCallback(async () => {
    setBusy(true);

    try {
      const intent = await startCheckout(invoiceId, method.provider);
      /*
       * The reference, not the signed fields, is what identifies this attempt
       * to the relay page — the server rebuilds the signature from the stored
       * intent, so nothing secret travels through a URL.
       */
      const plan = planHandoff(intent.handoff, {
        baseUrl: API_BASE_URL,
        reference: intent.reference,
      });

      if (plan.kind === "OPEN_URL") {
        /*
         * Handed to the OS, so the wallet's own app takes it when installed —
         * it already holds the session, the balance and the biometric unlock
         * that a web form makes the resident re-enter. See `lib/wallet.ts`.
         *
         * Not awaited-then-trusted: the status screen is pushed either way and
         * asks the provider, because leaving for the app and coming back is no
         * more evidence of payment than a browser closing was.
         */
        router.push(`/checkout/${encodeURIComponent(intent.reference)}`);
        await openPaymentUrl(plan.url);
        return;
      }

      if (plan.kind === "SHOW_QR") {
        router.push(`/checkout/${encodeURIComponent(intent.reference)}`);
        return;
      }

      toastError(`${label} isn't available here yet`, plan.reason);
    } catch (caught) {
      toastError(`Could not open ${label}`, readApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [invoiceId, label, method.provider]);

  return (
    <View className="gap-2">
      <Text variant="muted">{`Pay securely via ${label}.`}</Text>

      <Button
        label={busy ? `Opening ${label}…` : `Pay with ${label}`}
        loading={busy}
        onPress={() => void start()}
      />

      <Text className="text-center" variant="caption">
        Opens the {label} app if you have it. Confirms automatically — no
        screenshot needed.
      </Text>

      {method.sandbox ? (
        <View className="rounded-xl bg-warning-soft p-2.5">
          <Text className="text-warning" variant="caption">
            Test mode — this is a sandbox merchant and moves no real money.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
