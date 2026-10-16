import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import {
  acceptGuardianInvitation,
  type GuardianInvitationResult,
} from "@/lib/guardian-api";

/**
 * `hostelpalika://guardian-invite?token=…` — the emailed guardian invitation.
 *
 * ## The path matches the email, deliberately
 *
 * `guardian-invite.service.ts` builds `acceptUrl` as
 * `{siteUrl}/guardian-invite?token=<token>`, so this route's file name is that
 * path. The moment verified app links are configured (M6's open item), the
 * https link in the email opens *this* screen instead of the browser, with no
 * further work — and until then `hostelpalika://guardian-invite?token=…` already
 * resolves here, cold start and warm alike, because expo-router treats the file
 * name as the handler.
 *
 * ## Accepting does not sign you in
 *
 * `acceptGuardianInvitation` returns `{ accepted, accountCreated, email,
 * hostelName, requiresLogin }` and **no session** — the server emails
 * credentials for a freshly created or upgraded account rather than minting a
 * token for whoever opened a link. So the success state hands off to login with
 * the address prefilled rather than pretending to land the user in the app.
 *
 * ## One tap only
 *
 * Accepting clears the token server-side, so a second attempt returns
 * `GUARDIAN_INVITATION_INVALID`. The button is therefore gone once it has
 * succeeded — not merely disabled — and the error copy names expiry (7 days)
 * and reuse as the two likely causes rather than saying "something went wrong".
 */
export default function GuardianInviteScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const { colors } = useAppTheme();

  const token = params.token?.trim() ?? "";

  const [result, setResult] = useState<GuardianInvitationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      setResult(await acceptGuardianInvitation({ token }));
    } catch (caught) {
      setError(readApiError(caught, "This invitation could not be accepted."));
    } finally {
      setBusy(false);
    }
  }, [token]);

  if (!token) {
    return (
      <Screen header={<AppBar showBack title="Guardian invitation" />} scroll>
        <Card className="gap-3">
          <Text variant="label">This link is missing its invitation token</Text>
          <Text variant="muted">
            Open the link from your email exactly as it was sent — copying only part
            of it drops the token that identifies the invitation.
          </Text>
          <Button
            label="Browse hostels"
            onPress={() => router.replace("/(browse)")}
            variant="outline"
          />
        </Card>
      </Screen>
    );
  }

  if (result) {
    return (
      <Screen header={<AppBar title="Guardian invitation" />} scroll>
        <View className="gap-4 pt-1">
          <Card className="gap-3">
            <View className="flex-row items-center gap-2">
              <Glyph color={colors.success} name="checkmark-circle" size={22} />
              <Text variant="subtitle">Invitation accepted</Text>
            </View>
            <Text variant="muted">
              {`You are now a guardian for a resident at ${result.hostelName}.`}
            </Text>
            <Text variant="muted">
              {result.accountCreated
                ? `We emailed sign-in details to ${result.email}.`
                : `Sign in with your existing account (${result.email}).`}
            </Text>
          </Card>

          <Card className="gap-2">
            <Text variant="label">What you will be able to see</Text>
            <Text variant="muted">
              Only what the resident chose to share, section by section — they can
              change or withdraw any of it at any time, and the hostel cannot grant it
              on your behalf.
            </Text>
          </Card>

          <Button
            label="Go to sign in"
            onPress={() =>
              router.replace({
                params: { identifier: result.email },
                pathname: "/(auth)/login",
              })
            }
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen header={<AppBar showBack title="Guardian invitation" />} scroll>
      <View className="gap-4 pt-1">
        <Card className="gap-3">
          <View className="flex-row items-center gap-2">
            <Glyph color={colors.primary} name="shield-checkmark" size={22} />
            <Text variant="subtitle">You have been invited as a guardian</Text>
          </View>
          <Text variant="muted">
            A resident has invited you as their guardian. Accepting links your account
            to them so you can see only what they chose to share — they can change or
            withdraw that at any time.
          </Text>
        </Card>

        {error ? (
          <Card className="gap-2">
            <Text variant="label">That didn&apos;t work</Text>
            <Text variant="muted">{error}</Text>
            <Text variant="caption">
              Invitations expire after seven days and can only be accepted once. Ask the
              resident to send a fresh one.
            </Text>
          </Card>
        ) : null}

        <Button
          label="Accept invitation"
          loading={busy}
          onPress={() => void accept()}
        />
      </View>
    </Screen>
  );
}
