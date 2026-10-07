"use client";

import { Delete, KeyRound, Loader2, LockKeyhole, Mail } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";

import { checkAuthWithRefresh } from "@/lib/auth-check";
import { signOutRequest } from "@/lib/sign-out";

import { AuthError, AuthField, PasswordInput, authInputClass, authPrimaryButtonClass } from "../auth-fields";
import { AuthShell } from "../auth-shell";

type Me = { email: string | null; hasLockPin?: boolean; image: string | null; name: string };

type Envelope<T> =
  | { success: true; data: T; message: string }
  | { success: false; errorCode?: string; message: string };

class RequestError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(path: string, method: string, body?: unknown) {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    method,
  });
  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;

  if (!response.ok || !payload?.success) {
    throw new RequestError(
      payload?.message ?? "Something went wrong. Please try again.",
      payload && !payload.success ? payload.errorCode : undefined,
    );
  }

  return payload.data;
}

/** Only a path on this site — never an absolute or protocol-relative URL. */
function safeNext(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

/** `s••••t@gmail.com`, as the app shows it. */
function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!domain || name.length < 2) return email;
  return `${name[0]}${"•".repeat(Math.min(name.length - 2, 6))}${name.at(-1)}@${domain}`;
}

function hasInbox(email: string | null): email is string {
  return Boolean(email && !email.endsWith("@cook.local"));
}

/**
 * Four boxes and an on-screen number pad — no text field, so a phone never
 * opens its own keyboard over it. A desktop keyboard still types into it.
 */
function PinBoxes({
  disabled,
  label,
  onChange,
  onComplete,
  shake,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  shake?: boolean;
  value: string;
}) {
  const press = useCallback(
    (key: string) => {
      if (disabled) return;
      if (key === "back") {
        onChange(value.slice(0, -1));
        return;
      }
      if (value.length >= 4) return;
      const next = value + key;
      onChange(next);
      if (next.length === 4) onComplete?.(next);
    },
    [disabled, onChange, onComplete, value],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === "Backspace") press("back");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <div className="space-y-6">
      <div
        aria-label={`${label}: ${value.length} of 4 digits`}
        className={`flex justify-center gap-3 ${shake ? "animate-[pin-shake_0.35s]" : ""}`}
        role="status"
      >
        {[0, 1, 2, 3].map((index) => {
          const filled = index < value.length;
          const active = index === Math.min(value.length, 3) && !disabled;
          return (
            <span
              className={`flex size-14 items-center justify-center rounded-2xl border-2 transition ${
                active
                  ? "border-[#0A8A4B] bg-white ring-4 ring-[#0A8A4B]/10"
                  : "border-transparent bg-[#F4F6F8]"
              }`}
              key={index}
            >
              {filled ? <span className="size-3.5 rounded-full bg-[#0F172A]" /> : null}
            </span>
          );
        })}
      </div>

      <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"].map((key, index) =>
          key === "" ? (
            <span key={index} />
          ) : (
            <button
              aria-label={key === "back" ? "Delete" : key}
              className="flex h-14 items-center justify-center rounded-2xl text-[22px] font-semibold text-[#0F172A] transition hover:bg-[#F4F6F8] active:scale-95 active:bg-[#0A8A4B]/10 disabled:opacity-40"
              disabled={disabled}
              key={key}
              onClick={() => press(key)}
              type="button"
            >
              {key === "back" ? <Delete className="size-6 text-slate-500" /> : key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

export function UnlockForm() {
  return (
    <Suspense fallback={null}>
      <UnlockFormContent />
    </Suspense>
  );
}

type Step = "pin" | "code" | "new-pin" | "confirm-pin";

function UnlockFormContent() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const [me, setMe] = useState<Me | null>(null);
  const [step, setStep] = useState<Step>("pin");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  // Who is this for — and is there still a PIN to ask for? `checkAuthWithRefresh`
  // rotates a token that predates a PIN removed on the phone, so "no PIN" means
  // the portal will now let this browser through.
  useEffect(() => {
    void (async () => {
      const response = await checkAuthWithRefresh();
      const payload = (await response.json().catch(() => null)) as Envelope<{ user: Me }> | null;

      if (!response.ok || !payload?.success) {
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }

      if (payload.data.user.hasLockPin === false) {
        window.location.replace(next);
        return;
      }

      setMe(payload.data.user);
    })();
  }, [next, router]);

  function fail(message: string) {
    setError(message);
    setShake(true);
    window.setTimeout(() => setShake(false), 400);
  }

  async function unlock(value: string) {
    setBusy(true);
    setError("");
    try {
      await call("/api/v1/auth/lock-pin/verify", "POST", { pin: value });
      // A full load: the portal's first paint has to go through the proxy again.
      window.location.replace(next);
    } catch (caught) {
      setPin("");
      setBusy(false);
      if (caught instanceof RequestError && caught.code === "LOCK_PIN_BLOCKED") {
        setStep("code");
        setError(caught.message);
        return;
      }
      fail(caught instanceof Error ? caught.message : "That PIN did not work.");
    }
  }

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      const challenge = await call<{ challengeId: string; devCode?: string }>(
        "/api/v1/auth/biometric/code",
        "POST",
      );
      setChallengeId(challenge.challengeId);
      setCode(challenge.devCode ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  function toNewPin(event: FormEvent) {
    event.preventDefault();
    if (me && hasInbox(me.email) ? !/^\d{6}$/.test(code) : !password) {
      setError(me && hasInbox(me.email) ? "Enter the 6-digit code." : "Enter your password.");
      return;
    }
    setError("");
    setStep("new-pin");
  }

  async function saveNewPin(value: string) {
    if (value !== newPin) {
      setConfirmPin("");
      fail("The two PINs do not match. Enter the new PIN again.");
      setNewPin("");
      setStep("new-pin");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await call("/api/v1/auth/lock-pin", "PUT", {
        pin: value,
        ...(challengeId ? { challengeId, code } : { password }),
      });
      window.location.replace(next);
    } catch (caught) {
      setBusy(false);
      setNewPin("");
      setConfirmPin("");
      // A wrong code is the thing to fix, not the PIN.
      setStep("code");
      setError(caught instanceof Error ? caught.message : "Could not save the PIN.");
    }
  }

  async function signOut() {
    await signOutRequest();
    window.location.assign("/login");
  }

  const footer = (
    <>
      Not you?{" "}
      <button className="font-semibold text-[#0A8A4B] hover:underline" onClick={signOut} type="button">
        Sign out
      </button>
    </>
  );

  if (!me) {
    return (
      <AuthShell footer={footer} mode="login">
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-[#0A8A4B]" />
        </div>
      </AuthShell>
    );
  }

  const inbox = hasInbox(me.email);

  return (
    <AuthShell footer={footer} mode="login">
      <style>{`@keyframes pin-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`}</style>

      <div className="flex flex-col items-center text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-[#0A8A4B]/10 text-[#0A8A4B]">
          {step === "pin" ? <LockKeyhole className="size-7" /> : <KeyRound className="size-7" />}
        </span>
        <h1 className="mt-5 font-heading text-[28px] font-extrabold leading-tight tracking-tight text-[#0F172A]">
          {step === "pin"
            ? "Enter your PIN"
            : step === "code"
              ? "Reset your PIN"
              : step === "new-pin"
                ? "Choose a new PIN"
                : "Confirm the new PIN"}
        </h1>

        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-[#F4F6F8] py-2 pl-2 pr-4 text-left">
          {me.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote avatar, any host
            <img alt="" className="size-9 rounded-full object-cover" src={me.image} />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-full bg-[#0A8A4B] text-[14px] font-bold text-white">
              {me.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold text-[#0F172A]">{me.name}</span>
            {me.email ? (
              <span className="block truncate text-[12px] text-slate-500">{maskEmail(me.email)}</span>
            ) : null}
          </span>
        </div>
      </div>

      <div className="mt-8 space-y-5">
        {step === "pin" ? (
          <>
            <p className="text-center text-[13px] text-slate-500">
              The 4-digit PIN you set in the {"app's"} lock.
            </p>
            <PinBoxes
              disabled={busy}
              label="PIN"
              onChange={setPin}
              onComplete={(value) => void unlock(value)}
              shake={shake}
              value={pin}
            />
            <div className="flex h-5 justify-center">
              {busy ? <Loader2 className="size-5 animate-spin text-[#0A8A4B]" /> : null}
            </div>
            <AuthError message={error} />
            <button
              className="mx-auto block text-[13px] font-semibold text-[#0A8A4B] hover:underline"
              onClick={() => {
                setError("");
                setStep("code");
              }}
              type="button"
            >
              Forgot PIN?
            </button>
          </>
        ) : null}

        {step === "code" ? (
          inbox ? (
            challengeId ? (
              <form className="space-y-4" onSubmit={toNewPin}>
                <AuthField hint={`Sent to ${maskEmail(me.email!)}`} htmlFor="unlock-code" label="Code">
                  <input
                    autoComplete="one-time-code"
                    autoFocus
                    className={`${authInputClass} text-center text-[18px] tracking-[0.4em]`}
                    id="unlock-code"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    value={code}
                  />
                </AuthField>
                <AuthError message={error} />
                <button className={authPrimaryButtonClass} type="submit">
                  Next
                </button>
                <button
                  className="mx-auto block text-[13px] font-semibold text-[#0A8A4B] hover:underline disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void sendCode()}
                  type="button"
                >
                  {busy ? "Sending…" : "Send a new code"}
                </button>
              </form>
            ) : (
              <div className="space-y-4">
                <p className="text-center text-[13px] text-slate-500">
                  We will email a 6-digit code to {maskEmail(me.email!)}. Then you choose a new PIN.
                </p>
                <AuthError message={error} />
                <button
                  className={authPrimaryButtonClass}
                  disabled={busy}
                  onClick={() => void sendCode()}
                  type="button"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                  Send code
                </button>
              </div>
            )
          ) : (
            <form className="space-y-4" onSubmit={toNewPin}>
              <AuthField htmlFor="unlock-password" label="Your password">
                <PasswordInput
                  autoComplete="current-password"
                  id="unlock-password"
                  onChange={setPassword}
                  placeholder="Your account password"
                  value={password}
                />
              </AuthField>
              <AuthError message={error} />
              <button className={authPrimaryButtonClass} type="submit">
                Next
              </button>
            </form>
          )
        ) : null}

        {step === "new-pin" ? (
          <>
            <p className="text-center text-[13px] text-slate-500">
              4 digits. It opens the app and this portal.
            </p>
            <PinBoxes
              label="New PIN"
              onChange={setNewPin}
              onComplete={() => {
                setError("");
                setStep("confirm-pin");
              }}
              shake={shake}
              value={newPin}
            />
            <AuthError message={error} />
          </>
        ) : null}

        {step === "confirm-pin" ? (
          <>
            <p className="text-center text-[13px] text-slate-500">Enter the same 4 digits again.</p>
            <PinBoxes
              disabled={busy}
              label="Confirm new PIN"
              onChange={setConfirmPin}
              onComplete={(value) => void saveNewPin(value)}
              value={confirmPin}
            />
            <div className="flex h-5 justify-center">
              {busy ? <Loader2 className="size-5 animate-spin text-[#0A8A4B]" /> : null}
            </div>
            <AuthError message={error} />
          </>
        ) : null}

        {step !== "pin" ? (
          <button
            className="mx-auto block text-[13px] text-slate-500 hover:text-slate-700"
            onClick={() => {
              setError("");
              setNewPin("");
              setConfirmPin("");
              setStep("pin");
            }}
            type="button"
          >
            Back to PIN
          </button>
        ) : null}
      </div>
    </AuthShell>
  );
}
