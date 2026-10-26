import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AuthDivider, GoogleSignInButton } from "@/components/google-sign-in-button";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { APP_NAME, logo } from "@/constants/branding";
import { resolveHome } from "@/constants/roles";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError, readApiErrorCode } from "@/lib/api-contract";
import { register, requestOtp, verifyOtp } from "@/lib/auth-api";
import { startSession } from "@/lib/auth-session";
import {
  isCompleteOtpCode,
  normalizeOtpCode,
  type RegisterErrors,
  validateRegister,
} from "@/lib/auth-form";
import { toastInfo } from "@/lib/toast";

/**
 * Create an account: details → email OTP → account.
 *
 * ## Two steps, one screen
 *
 * The code arrives while the user is looking at the app, so pushing a second
 * route to type it in means a back button that would throw the challenge away
 * and a `challengeId` threaded through navigation params. It is one screen with
 * a step, and Back from the code step returns to the details with everything
 * still filled in.
 *
 * ## Why the details are validated before the OTP is requested
 *
 * `/auth/otp/request` sends an email on every call and allows **five in fifteen
 * minutes**. A password rejected afterwards by `/auth/register` would have cost
 * one of those five for a mistake the phone could see. So the whole draft is
 * checked here first, against the same limits the server uses
 * (`lib/auth-form.ts`), and only then is a code sent.
 *
 * ## The account this creates
 *
 * `registerPublicAccount` makes a `PUBLIC` account — not a resident. Someone
 * signing up on their own is a person looking for a hostel; becoming a resident
 * happens later, by redeeming the QR code their hostel gives them. So this
 * lands in `(browse)`, and the copy does not promise a dashboard.
 */

const RESEND_SECONDS = 60;

export default function RegisterScreen() {
  const { colors } = useAppTheme();
  const [step, setStep] = useState<"code" | "details">("details");

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<RegisterErrors>({});

  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
   * The server enforces a 60-second resend cooldown and answers
   * `OTP_RESEND_COOLDOWN` with a 429. Counting it down here means the button is
   * simply unavailable rather than available-and-then-rejected — and a rejected
   * resend still spends one of the five attempts.
   */
  useEffect(() => {
    if (resendIn <= 0) {
      return;
    }

    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);

    return () => clearTimeout(timer);
  }, [resendIn]);

  const sendCode = useCallback(
    async (options: { resend?: boolean } = {}) => {
      const found = validateRegister({ email, name, password });

      setErrors(found);

      if (Object.keys(found).length > 0) {
        setStep("details");
        return;
      }

      setError(null);
      setSubmitting(true);

      try {
        const challenge = await requestOtp({
          channel: "email",
          identifier: email.trim(),
          purpose: "registration",
        });

        setChallengeId(challenge.challengeId);
        setCode("");
        setCodeError(null);
        setResendIn(RESEND_SECONDS);
        setStep("code");

        if (options.resend) {
          toastInfo("Code sent", "Check your inbox again.");
        }

        /*
         * Outside production the server returns the code it just emailed, so
         * the flow can be finished on a device without waiting on mail
         * delivery. `__DEV__` is false in any release build, so this cannot
         * reach a real user even if the server ever leaked it.
         */
        if (__DEV__ && challenge.devCode) {
          setCode(challenge.devCode);
        }
      } catch (caught) {
        if (readApiErrorCode(caught) === "ACCOUNT_ALREADY_EXISTS") {
          setErrors((current) => ({
            ...current,
            email: "This email already has an account. Try signing in.",
          }));
        } else {
          setError(readApiError(caught, "Could not send your code."));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, name, password],
  );

  const submit = useCallback(async () => {
    if (!challengeId) {
      return;
    }

    const cleaned = normalizeOtpCode(code);

    if (!isCompleteOtpCode(cleaned)) {
      setCodeError("Enter the 6-digit code from your email.");
      return;
    }

    setCodeError(null);
    setError(null);
    setSubmitting(true);

    try {
      await verifyOtp(challengeId, cleaned);

      const result = await register({
        email: email.trim(),
        name: name.trim(),
        otpChallengeId: challengeId,
        password,
      });
      const auth = await startSession(result);

      router.replace(
        resolveHome({
          isApprovedProvider: result.user.isServiceProvider,
          isResidentActivated: auth.isResidentActivated ?? true,
          role: result.user.role,
        }),
      );
    } catch (caught) {
      const errorCode = readApiErrorCode(caught);

      /*
       * An address that is already registered is a wrong *field*, not a wrong
       * code — so it is reported back on the details step where the address is,
       * with the way out. Left on the code step it reads as the code being
       * wrong, and the user retypes it until they run out of attempts.
       */
      if (errorCode === "ACCOUNT_ALREADY_EXISTS") {
        setStep("details");
        setErrors((current) => ({
          ...current,
          email: "There is already an account for this email. Try signing in.",
        }));
      } else {
        setCodeError(readApiError(caught, "That code did not work."));
      }
    } finally {
      setSubmitting(false);
    }
  }, [challengeId, code, email, name, password]);

  const header = (
    <AppBar
      onBack={step === "code" ? () => setStep("details") : undefined}
      showBack
      subtitle={step === "code" ? email.trim() : undefined}
      title={step === "code" ? "Check your email" : ""}
    />
  );

  if (step === "code") {
    return (
      <Screen
        footer={
          <Button
            label="Verify and continue"
            loading={submitting}
            onPress={() => void submit()}
            size="lg"
          />
        }
        header={header}
        scroll
      >
        <View className="gap-6 pt-2">
          <Text variant="muted">
            We sent a 6-digit code to {email.trim()}. It expires in a few minutes.
          </Text>

          <Input
            autoComplete="one-time-code"
            leading={<Glyph color={colors.mutedForeground} name="key" size={18} />}
            error={codeError}
            keyboardType="number-pad"
            label="Verification code"
            maxLength={6}
            onChangeText={(value) => setCode(normalizeOtpCode(value))}
            onSubmitEditing={() => void submit()}
            placeholder="123456"
            returnKeyType="go"
            textContentType="oneTimeCode"
            value={code}
          />

          {error ? (
            <Text className="text-destructive" variant="caption">
              {error}
            </Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            className="self-start py-2"
            disabled={resendIn > 0 || submitting}
            onPress={() => void sendCode({ resend: true })}
          >
            <Text
              className={resendIn > 0 ? "text-muted-foreground" : "text-primary"}
              variant="label"
            >
              {resendIn > 0 ? `Resend code in ${resendIn}s` : "Send a new code"}
            </Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          label="Send verification code"
          loading={submitting}
          onPress={() => void sendCode()}
          size="lg"
        />
      }
      header={header}
      scroll
    >
      <View className="gap-6 pt-2">
        <View className="items-center gap-3">
          <Image cachePolicy="memory-disk" contentFit="contain" source={logo.mark} style={{ height: 56, width: 56 }} />
          <Text variant="display">Create account</Text>
          <Text className="text-center" variant="muted">
            Join {APP_NAME} to save hostels and send inquiries.
          </Text>
        </View>

        <View className="gap-4">
          <Input
            autoCapitalize="words"
            autoComplete="name"
            error={errors.name}
            label="Full name"
            leading={<Glyph color={colors.mutedForeground} name="person" size={18} />}
            onChangeText={setName}
            placeholder="Sita Sharma"
            returnKeyType="next"
            value={name}
          />

          <Input
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            error={errors.email}
            hint="We send your verification code here."
            keyboardType="email-address"
            label="Email"
            leading={<Glyph color={colors.mutedForeground} name="mail" size={18} />}
            onChangeText={setEmail}
            placeholder="you@example.com"
            returnKeyType="next"
            value={email}
          />

          <Input
            autoCapitalize="none"
            autoComplete="new-password"
            error={errors.password}
            hint="At least 8 characters."
            label="Password"
            leading={<Glyph color={colors.mutedForeground} name="lock-closed" size={18} />}
            onChangeText={setPassword}
            onSubmitEditing={() => void sendCode()}
            placeholder="Choose a password"
            returnKeyType="go"
            secure
            value={password}
          />
        </View>

        {error ? (
          <Text className="text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}

        <AuthDivider />

        {/*
         * Still "Continue with", not "Sign up with". `/auth/google` creates the
         * account or links an existing one depending on what it finds, so a
         * label promising a *new* account would be wrong for anyone who already
         * registered with this address on the website — and they are the people
         * most likely to end up on this screen by mistake.
         *
         * It skips the OTP step entirely, which is correct: Google has already
         * proved the address, and `verifyGoogleIdToken` refuses a token whose
         * `email_verified` is false.
         */}
        <GoogleSignInButton disabled={submitting} onError={setError} />

        <Pressable
          accessibilityRole="button"
          className="self-center py-2"
          onPress={() => router.replace("/(auth)/login")}
        >
          <Text variant="muted">
            Already have an account? <Text className="text-primary">Sign in</Text>
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
