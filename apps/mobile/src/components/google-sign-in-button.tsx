import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";

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
        <GoogleMark />
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

/**
 * Google's own four-colour G. Their sign-in branding rules ask for this mark,
 * in these colours, on a Google button — the one place our glyph set does not
 * draw the icon.
 */
function GoogleMark() {
  return (
    <Svg height={18} viewBox="0 0 24 24" width={18}>
      <Path d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" fill="#4285F4" />
      <Path d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z" fill="#34A853" />
      <Path d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29A11.96 11.96 0 0 0 0 12c0 1.94.47 3.76 1.29 5.38l3.98-3.09Z" fill="#FBBC05" />
      <Path d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" fill="#EA4335" />
    </Svg>
  );
}
