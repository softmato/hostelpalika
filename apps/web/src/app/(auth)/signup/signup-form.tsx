"use client";

import { Mail, Phone } from "@/components/icons";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  type FormEvent,
} from "react";

import { CodeSlots } from "@/components/code-slots";
import { destinationForRole } from "@/lib/route-access";
import { Role } from "@/lib/roles";

import {
  AuthError,
  AuthField,
  AuthHeading,
  PasswordInput,
  authInputClass,
  authPrimaryButtonClass,
} from "../auth-fields";
import { GoogleAuthButton } from "../google-auth-button";
import { AuthShell } from "../auth-shell";
import { SiteName } from "@/components/site-config-provider";

type AuthResponse<T> =
  | {
      success: true;
      data: T;
      message: string;
    }
  | {
      success: false;
      errorCode: string;
      message: string;
    };

type OtpRequestData = {
  challengeId: string;
  devCode?: string;
  expiresAt: string;
};

type RegisterData = {
  user: {
    id: string;
    role: string;
  };
};

type SignupStep = "details" | "verify";

type SignupFormProps = {
  googleClientId: string;
};

async function authRequest<T>(path: string, body: unknown) {
  const response = await fetch(path, {
    body: JSON.stringify(body),
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as AuthResponse<T> | null;

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.message ?? "Request failed. Please try again.");
  }

  return payload.data;
}

export function SignupForm({ googleClientId }: SignupFormProps) {
  return (
    <Suspense fallback={null}>
      <SignupFormContent googleClientId={googleClientId} />
    </Suspense>
  );
}

function SignupFormContent({ googleClientId }: SignupFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Signup details state
  const [step, setStep] = useState<SignupStep>("details");
  const [activeTab, setActiveTab] = useState<"email" | "phone">("email");
  const [challengeId, setChallengeId] = useState("");
  const [devCode, setDevCode] = useState("");
  const [error, setError] = useState("");
  const [isResending, setIsResending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form Fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreeToTerms, setAgreeToTerms] = useState(false);

  // OTP inputs
  const [otpArray, setOtpArray] = useState<string[]>(Array(6).fill(""));

  // Timer state
  const [countdown, setCountdown] = useState(42);

  const identifier = email.trim().toLowerCase();
  const nextParam = searchParams.get("next");

  const redirectAfterAuth = useCallback(
    (role: Role) => {
      router.push(destinationForRole(role, nextParam));
      router.refresh();
    },
    [nextParam, router],
  );

  const handleGoogleSuccess = useCallback(
    (user: { role: Role }) => {
      redirectAfterAuth(user.role);
    },
    [redirectAfterAuth],
  );

  // Countdown timer effect
  useEffect(() => {
    if (step !== "verify" || countdown <= 0) return;

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [step, countdown]);

  async function sendOtp() {
    const data = await authRequest<OtpRequestData>("/api/v1/auth/otp/request", {
      channel: "email",
      identifier,
      purpose: "registration",
    });

    setChallengeId(data.challengeId);
    setDevCode(data.devCode ?? "");
    setOtpArray(Array(6).fill(""));
    setCountdown(42);
    setStep("verify");
  }

  async function requestOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!agreeToTerms) {
      setError("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }

    setIsSubmitting(true);

    try {
      await sendOtp();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not send OTP. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resendOtp() {
    setError("");
    setIsResending(true);

    try {
      await sendOtp();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not resend OTP. Please try again.",
      );
    } finally {
      setIsResending(false);
    }
  }

  async function completeSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    const fullCode = otpArray.join("");
    if (fullCode.length < 6) {
      setError("Please enter the full 6-digit OTP.");
      setIsSubmitting(false);
      return;
    }

    try {
      await authRequest("/api/v1/auth/otp/verify", {
        challengeId,
        code: fullCode,
      });
      await authRequest<RegisterData>("/api/v1/auth/register", {
        email: identifier,
        name,
        otpChallengeId: challengeId,
        password,
      });

      redirectAfterAuth(Role.PUBLIC);
    } catch (signupError) {
      setError(
        signupError instanceof Error
          ? signupError.message
          : "Could not complete signup. Please try again.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // Format timer countdown
  const formatTimer = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins.toString().padStart(2, "0")}:${remainingSecs.toString().padStart(2, "0")}`;
  };

  const loginLink = nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : "/login";

  const loginFooter = (
    <>
      Already have an account?{" "}
      <Link className="font-semibold text-[#0A8A4B] hover:underline" href={loginLink}>
        Log in
      </Link>
    </>
  );

  // Render OTP Verification Screen
  if (step === "verify") {
    return (
      <AuthShell
        footer={
          <>
            Wrong email?{" "}
            <button
              className="font-semibold text-[#0A8A4B] hover:underline"
              onClick={() => {
                setStep("details");
                setError("");
              }}
              type="button"
            >
              Go back and edit it
            </button>
          </>
        }
        mode="signup"
      >
        <div className="flex flex-col gap-7">
          <AuthHeading
            subtitle={`Enter the 6-digit code we sent to ${identifier}`}
            title="Verify your email"
          />

          <AuthError message={error} />

          {devCode ? (
            <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-center text-[13px] text-amber-800">
              Development code:{" "}
              <span className="font-mono font-bold tracking-wider">{devCode}</span>
            </div>
          ) : null}

          <form className="flex flex-col gap-5" onSubmit={completeSignup}>
            <div className="flex justify-center">
              <CodeSlots
                accentColor="#0A8A4B"
                autoFocus
                dangerColor="#DC2626"
                digitColor="#ffffff"
                edgeColor="#CBD5E1"
                gap={10}
                inkColor="#0A8A4B"
                length={6}
                onChange={(code) => setOtpArray(Array.from({ length: 6 }, (_, at) => code[at] ?? ""))}
                radius={14}
                slotColor="#EEF2F6"
                slotSize={52}
                value={otpArray.join("")}
              />
            </div>

            <p className="text-center text-[13px] text-slate-500">
              Didn&apos;t get the code?{" "}
              {countdown > 0 ? (
                <span className="font-semibold text-[#0F172A]">
                  Resend in {formatTimer(countdown)}
                </span>
              ) : (
                <button
                  className="font-semibold text-[#0A8A4B] hover:underline"
                  disabled={isResending}
                  onClick={resendOtp}
                  type="button"
                >
                  {isResending ? "Resending…" : "Resend code"}
                </button>
              )}
            </p>

            <button
              className={authPrimaryButtonClass}
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Verifying…" : "Verify & continue"}
            </button>
          </form>
        </div>
      </AuthShell>
    );
  }

  // Render Signup Details Screen (step === "details")
  return (
    <AuthShell footer={loginFooter} mode="signup">
      <div className="flex flex-col gap-7">
        <AuthHeading
          subtitle={
            <>
              Join <SiteName /> to discover and book hostels
            </>
          }
          title="Create account"
        />

        <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-[#F4F6F8] p-1">
          <button
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] font-medium transition ${
              activeTab === "email"
                ? "bg-white text-[#0A8A4B] shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
            onClick={() => setActiveTab("email")}
            type="button"
          >
            <Mail className="size-4" />
            Email
          </button>
          <button
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] font-medium transition ${
              activeTab === "phone"
                ? "bg-white text-[#0A8A4B] shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
            onClick={() => setActiveTab("phone")}
            type="button"
          >
            <Phone className="size-4" />
            Phone
          </button>
        </div>

        <AuthError message={error} />

        {activeTab === "phone" ? (
          <div className="space-y-3 text-center">
            <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-[#0A8A4B]/10 text-[#0A8A4B]">
              <Phone className="size-5" />
            </span>
            <h2 className="text-[15px] font-semibold text-[#0F172A]">
              Phone signup is in the app
            </h2>
            <p className="mx-auto max-w-[300px] text-[13px] leading-relaxed text-slate-500">
              SMS signups are handled in the mobile app. Register with email here on the
              web.
            </p>
            <button
              className="text-[13px] font-semibold text-[#0A8A4B] hover:underline"
              onClick={() => setActiveTab("email")}
              type="button"
            >
              Use email instead
            </button>
          </div>
        ) : (
          <form className="flex flex-col gap-5" onSubmit={requestOtp}>
            <AuthField htmlFor="signup-name" label="Full name">
              <input
                autoComplete="name"
                className={authInputClass}
                id="signup-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="Enter your full name"
                required
                type="text"
                value={name}
              />
            </AuthField>

            <AuthField htmlFor="signup-email" label="Email">
              <input
                autoComplete="email"
                className={authInputClass}
                id="signup-email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Enter your email"
                required
                type="email"
                value={email}
              />
            </AuthField>

            <AuthField
              hint="At least 8 characters, with a mix of letters, numbers and symbols."
              htmlFor="signup-password"
              label="Password"
            >
              <PasswordInput
                autoComplete="new-password"
                id="signup-password"
                minLength={8}
                onChange={setPassword}
                placeholder="Create a password"
                value={password}
              />
            </AuthField>

            <label className="flex cursor-pointer select-none items-start gap-2.5 text-[13px] text-slate-500">
              <input
                checked={agreeToTerms}
                className="mt-0.5 size-4 cursor-pointer rounded border-slate-300 text-[#0A8A4B] focus:ring-[#0A8A4B]"
                onChange={(event) => setAgreeToTerms(event.target.checked)}
                type="checkbox"
              />
              <span>
                I agree to the{" "}
                <Link
                  className="font-semibold text-[#0A8A4B] hover:underline"
                  href="/terms"
                >
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link
                  className="font-semibold text-[#0A8A4B] hover:underline"
                  href="/privacy"
                >
                  Privacy Policy
                </Link>
              </span>
            </label>

            <div className="flex flex-col gap-3 pt-1">
              <button
                className={authPrimaryButtonClass}
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Sending code…" : "Create account"}
              </button>

              <GoogleAuthButton
                clientId={googleClientId}
                onError={setError}
                onSuccess={handleGoogleSuccess}
              />
            </div>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
