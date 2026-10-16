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
  acceptCookInvitation,
  type CookInvitationResult,
} from "@/lib/cook-invite-api";

/**
 * `hostelpalika://cook-invite?token=…` — the emailed cook invitation.
 *
 * The sibling of `guardian-invite.tsx`, and deliberately the same shape,
 * because it is the same problem: an emailed link that grants a scoped role on
 * an address the recipient already controls.
 *
 * ## The path matches the email
 *
 * `cook-roster.service.ts` builds `acceptUrl` as
 * `{siteUrl}/cook-invite?token=<token>`, so this route's file name is that
 * path. Once verified app links are configured the https link in the email
 * opens this screen instead of the browser with no further work, and until then
 * `hostelpalika://cook-invite?token=…` already resolves here.
 *
 * ## Accepting does not sign you in
 *
 * The server returns no session — it creates or upgrades an account and emails
 * the credentials — so the success state hands off to login with the address
 * prefilled rather than pretending to land the cook in the app.
 *
 * ## One tap only
 *
 * Accepting clears the token server-side, so a second attempt returns
 * `COOK_INVITATION_INVALID`. The button is therefore *gone* once it has
 * succeeded, not merely disabled, and the error copy names expiry (7 days) and
 * reuse as the two likely causes.
 */
export default function CookInviteScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const { colors } = useAppTheme();

  const token = params.token?.trim() ?? "";

  const [result, setResult] = useState<CookInvitationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accept = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      setResult(await acceptCookInvitation({ token }));
    } catch (caught) {
      setError(readApiError(caught, "This invitation could not be accepted."));
    } finally {
      setBusy(false);
    }
  }, [token]);

  if (!token) {
    return (
      <Screen header={<AppBar showBack title="Cook invitation" />} scroll>
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
      <Screen header={<AppBar title="Cook invitation" />} scroll>
        <View className="gap-4 pt-1">
          <Card className="gap-3">
            <View className="flex-row items-center gap-2">
              <Glyph color={colors.success} name="checkmark-circle" size={22} />
              <Text variant="subtitle">Invitation accepted</Text>
            </View>
            <Text variant="muted">
              {`You are now the cook for ${result.hostelName}.`}
            </Text>
            <Text variant="muted">
              {result.accountCreated
                ? `We emailed sign-in details to ${result.email}.`
                : `Sign in with your existing account (${result.email}).`}
            </Text>
          </Card>

          <Card className="gap-2">
            <Text variant="label">What you will be able to do</Text>
            <Text variant="muted">
              Tell residents a meal is ready, and post photos of what was served. The
              account cannot see resident records, money or complaints.
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
    <Screen header={<AppBar showBack title="Cook invitation" />} scroll>
      <View className="gap-4 pt-1">
        <Card className="gap-3">
          <View className="flex-row items-center gap-2">
            <Glyph color={colors.primary} name="flame" size={22} />
            <Text variant="subtitle">You have been invited to run a kitchen</Text>
          </View>
          <Text variant="muted">
            A hostel has invited you as their cook. Accepting turns this email address
            into your sign-in — you keep your own account and your own password.
          </Text>
        </Card>

        {error ? (
          <Card className="gap-2">
            <Text variant="label">That didn&apos;t work</Text>
            <Text variant="muted">{error}</Text>
            <Text variant="caption">
              Invitations expire after seven days and can only be accepted once. Ask the
              hostel to send a fresh one.
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
