import AntDesign from "@expo/vector-icons/AntDesign";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { resolveHome } from "@/constants/roles";
import { readApiError } from "@/lib/api-contract";
import { signInWithGoogle } from "@/lib/auth-api";
import { startSession } from "@/lib/auth-session";
import { isGoogleSignInAvailable, requestGoogleIdToken } from "@/lib/google-auth";

/**
 * "Continue with Google", on both login and register.
 *
 * One component rather than a button plus a copy of the flow on each screen:
 * the flow is six steps ending in a `router.replace`, and the second copy is
 * where the routing drifts. Errors go back to the screen through `onError` so
 * they land in the message slot it already has — a toast on top of a form with
 * an empty error line reads as two different things having gone wrong.
 *
 * **It renders its own Pressable instead of the `Button` primitive.** Google's
 * branding guidelines want their mark on the button, and `Button` takes a
 * `label` string and nothing else. Height, radius and border are copied from
 * `Button`'s `outline`/`lg` so it still lines up with the sign-in button above
 * it.
 */
export function GoogleSignInButton({
  disabled = false,
  label = "Continue with Google",
  next,
  onError,
}: {
  disabled?: boolean;
  label?: string;
  /** Where to land instead of home — a join link the person was on. */
  next?: string | null;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  // Nothing to offer in a build with no client id — and a button that always
  // reports "not set up" is worse than no button.
  if (!isGoogleSignInAvailable) {
    return null;
  }

  async function onPress() {
    onError(null);
    setBusy(true);

    try {
      const token = await requestGoogleIdToken();

      if (!token.ok) {
        // `null` is a cancellation. Clearing rather than setting is the point:
        // backing out of the account sheet must leave the form as it was.
        onError(token.message);
        return;
      }

      const result = await signInWithGoogle(token.idToken);
      const auth = await startSession(result);

      router.replace(
        next ??
        resolveHome({
          isApprovedProvider: result.user.isServiceProvider,
          isResidentActivated: auth.isResidentActivated ?? true,
          role: result.user.role,
        }),
      );
    } catch (caught) {
      /*
       * Past the Google sheet, so this is our own API answering: a suspended
       * account, an unverified Google address (`GOOGLE_EMAIL_UNVERIFIED`), the
       * rate limit at ten in fifteen minutes, or the server having no
       * `GOOGLE_CLIENT_ID` at all. The server's message is the useful one.
       */
      onError(readApiError(caught, "Could not sign you in with Google."));
    } finally {
      setBusy(false);
    }
  }

  const blocked = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: blocked }}
      className={`h-14 flex-row items-center justify-center gap-3 rounded-2xl border border-border px-6 active:opacity-80 ${
        blocked ? "opacity-40" : ""
      }`}
      disabled={blocked}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator size="small" />
      ) : (
        <AntDesign color="#4285F4" name="google" size={18} />
      )}

      <Text className="font-semibold text-base text-foreground">{label}</Text>
    </Pressable>
  );
}

/** The "or" rule between the password form and the Google button. */
export function AuthDivider({ label = "or" }: { label?: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="h-px flex-1 bg-border" />
      <Text variant="caption">{label}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
}
