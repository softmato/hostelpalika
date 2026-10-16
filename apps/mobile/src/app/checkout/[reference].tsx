import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Glyph } from "@/components/ui/glyph";
import { FactRow } from "@/components/ui/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { isCheckoutFinished } from "@/lib/checkout";
import { type CheckoutStatus, getCheckoutStatus } from "@/lib/finance-api";
import { humanizeEnum } from "@/lib/format";

/**
 * Where the resident lands after a gateway handoff.
 *
 * ## The browser closing is not evidence
 *
 * The intent's return URL is built server-side as a **web** page —
 * `{siteUrl}/resident/payments/checkout/{reference}` — with no mobile scheme in
 * it, so the in-app browser never redirects to `hostelpalika://` and there is
 * nothing to deep-link off. That is fine, because the browser closing was never
 * proof of anything: a resident can dismiss it mid-payment, or complete one and
 * lose signal before the redirect. So this screen asks the *server*, which asks
 * the *provider*, which is the only authority there is.
 *
 * ## Polling that stops
 *
 * Every second is too fast — the server calls the provider on each poll — and
 * never stopping drains a phone left on this screen. So it backs off, and it
 * halts on `settled`, on a terminal status, or once the intent expires
 * (`lib/checkout.ts`). A resident who genuinely paid but whose intent expired
 * still has the manual route: the claim form.
 */

const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 15_000;

export default function CheckoutStatusScreen() {
  const { reference } = useLocalSearchParams<{ reference: string }>();
  const { colors } = useAppTheme();

  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** Bumped by the retry button to restart the loop from the first delay. */
  const [attempt, setAttempt] = useState(0);

  /*
   * The whole loop lives inside the effect.
   *
   * A `useCallback` that schedules itself is a reference to a variable that
   * does not exist yet at the moment it is captured, so each tick re-enters
   * whichever version React had first — a stale closure that survives every
   * later render. Local `let`s are also what makes the cleanup exact: the
   * cancel flag and the pending timer belong to *this* run of the effect, not
   * to the component.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = FIRST_DELAY_MS;

    async function tick() {
      try {
        const next = await getCheckoutStatus(reference);

        if (cancelled) {
          return;
        }

        setStatus(next);
        setError(null);

        if (isCheckoutFinished(next)) {
          setDone(true);
          return;
        }
      } catch (caught) {
        if (cancelled) {
          return;
        }

        // A failed poll is not a failed payment — an unreachable server says
        // nothing about whether the provider took the money. Keep polling, and
        // keep whatever status is already on screen.
        setError(readApiError(caught));
      }

      // Backs off geometrically: the first answer matters most, and by the
      // tenth the resident has usually stopped watching.
      delay = Math.min(delay * 1.6, MAX_DELAY_MS);
      timer = setTimeout(() => void tick(), delay);
    }

    // Sets no state before its first `await`, so the effect body itself never
    // triggers a synchronous re-render.
    void tick();

    return () => {
      cancelled = true;

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [attempt, reference]);

  const settled = status?.settled ?? false;
  const header = <AppBar showBack title="Payment status" />;

  if (!status && error) {
    return (
      <Screen header={header}>
        <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        done ? (
          <Button
            label={settled ? "Done" : "Back to the invoice"}
            onPress={() =>
              status ? router.replace(`/invoice/${status.invoiceId}`) : router.back()
            }
          />
        ) : undefined
      }
      header={header}
    >
      <View className="flex-1 items-center justify-center gap-4">
        <View className="items-center gap-3">
          {done ? (
            <Glyph
              color={settled ? colors.success : colors.warning}
              name={settled ? "checkmark-circle" : "alert-circle"}
              size={64}
            />
          ) : (
            <ActivityIndicator color={colors.primary} size="large" />
          )}

          <Text className="text-center" variant="title">
            {settled
              ? "Payment confirmed"
              : done
                ? "Not confirmed"
                : "Confirming your payment"}
          </Text>

          <Text className="text-center" variant="muted">
            {settled
              ? "It is on your ledger and your invoice has been updated."
              : done
                ? "We could not confirm this payment with the provider. If the money left your account, submit your proof and your hostel will sort it out."
                : "Checking with the provider. This usually takes a few seconds."}
          </Text>
        </View>

        {/*
          `<FactRow>`, not three hand-rolled label/value rows.

          `NOTES.md` §8 — a detail screen's facts are a two-column label/value
          grid, and this kit's `<FactRow>` is that idea — and the version here
          was the component re-typed three times without the one thing it
          actually carries: a value that **wraps** rather than being squeezed.
          On a 320dp phone the right-hand column is about 150dp, which a long
          reference does not fit in, so the row that matters most to a resident
          chasing a payment was the one being truncated.
        */}
        {status ? (
          <Card className="w-full gap-2">
            <FactRow label="Amount" value={<Money value={status.amount} />} />
            <FactRow label="Provider" value={humanizeEnum(status.provider)} />
            <FactRow label="Reference" value={status.reference} />

            {status.sandbox ? (
              <Badge label="Test mode — no real money" tone="warning" />
            ) : null}
          </Card>
        ) : null}

        {done && !settled && status ? (
          <Button
            label="Submit proof instead"
            onPress={() => router.replace(`/invoice/${status.invoiceId}/claim`)}
            variant="outline"
          />
        ) : null}
      </View>
    </Screen>
  );
}
