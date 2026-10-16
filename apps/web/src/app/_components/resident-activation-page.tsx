"use client";

import {
  Check,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  MapPin,
  QrCode,
} from "@/components/icons";
import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { checkAuthWithRefresh } from "@/lib/auth-check";
import { useSessionStore, type SessionUser } from "@/stores/session-store";
import { Message } from "./resident-shared";
import { SiteName } from "@/components/site-config-provider";

/**
 * Where a resident turns the code their hostel issued into a working portal.
 *
 * ## Everything on this screen is answered by the code
 *
 * It used to be a mockup wearing a working form: a real input and a real submit
 * button, surrounded by a hostel that did not exist, a resident who was not you,
 * and a QR scanner that scanned nothing. That is worse than an empty screen —
 * somebody about to attach their account to a hostel bed was being shown
 * confident details about a *different* hostel, and the only honest thing on the
 * page was the box they typed into.
 *
 * So the card is now driven by {@link lookupActivation}: type the code, and the
 * server says which hostel and which room type it opens, before the button is
 * pressed. Nothing about the resident comes back with it — the code is a bearer
 * secret, and a screen that printed somebody's name on receipt of one would turn
 * a mislaid code into a small data leak. Recognising your own hostel is enough.
 *
 * ## The QR is a link, not a camera
 *
 * The activation email carries a QR that encodes this page's own URL with the
 * code already in it (`activationUrl`). Scanning it with the phone's ordinary
 * camera lands here with the field filled in, which is why there is no scanner
 * in the page: there was never anything for one to do that the camera the
 * resident is already holding does not do better.
 */

type ActivationTarget = {
  area: string;
  city: string;
  hostelName: string;
  photoUrl: string | null;
  roomType: string;
  verified: boolean;
};

type ActivationStatusResponse = {
  activation: {
    expiresAt: string;
    status: "PENDING" | "USED" | "EXPIRED" | "CANCELLED";
  } | null;
  isActivated: boolean;
  target: ActivationTarget | null;
};

type MeResponse =
  | { data: { user: SessionUser }; success: true }
  | { message: string; success: false };

/** What the right-hand column is saying about the code in the box. */
type CodeState =
  | "empty"
  | "expired"
  | "checking"
  | "ready"
  | "unknown"
  | "unusable"
  | "used";

const STATE_COPY: Record<Exclude<CodeState, "empty">, { note: string; title: string }> = {
  checking: { note: "Looking this code up with your hostel.", title: "Checking" },
  expired: {
    note: "This code has passed its expiry date. Ask your hostel for a new one.",
    title: "Expired",
  },
  ready: {
    note: "This code is valid and ready to link to your account.",
    title: "Ready",
  },
  unknown: {
    note: "No code matches what you have typed. Check it against the one your hostel sent.",
    title: "Not recognised",
  },
  unusable: {
    note: "This code was cancelled — issuing a new one cancels the old. Use the most recent code your hostel sent.",
    title: "Cancelled",
  },
  used: {
    note: "This code has already been redeemed. If that was not you, ask your hostel for a new one.",
    title: "Already used",
  },
};

const DOT_COLOR: Record<Exclude<CodeState, "empty">, string> = {
  checking: "bg-slate-300",
  expired: "bg-red-500",
  ready: "bg-emerald-500",
  unknown: "bg-slate-300",
  unusable: "bg-red-500",
  used: "bg-slate-400",
};

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "?";
  }

  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

function placeOf(target: ActivationTarget) {
  return [target.area, target.city].filter(Boolean).join(", ");
}

export const ResidentActivationPageContent = memo(
  function ResidentActivationPageContent() {
    const searchParams = useSearchParams();
    const [message, setMessage] = useState("");
    const [activated, setActivated] = useState(false);
    /*
     * The hostel and room they ended up linked to, kept separately from
     * `activated` — the lookup can legitimately have come back without a target
     * (a hostel record that could not be read), and a null there must not be
     * able to swallow the success panel of an activation that worked.
     */
    const [activatedTarget, setActivatedTarget] = useState<ActivationTarget | null>(null);
    // Prefilled when the resident followed the link in their activation email,
    // or scanned its QR with their phone camera.
    const [code, setCode] = useState(() => searchParams.get("code")?.trim() ?? "");
    const [activeTab, setActiveTab] = useState<"code" | "qr">("code");
    const [lookup, setLookup] = useState<ActivationStatusResponse | null>(null);
    const [checking, setChecking] = useState(false);

    const user = useSessionStore((state) => state.user);
    const setUser = useSessionStore((state) => state.setUser);
    const sessionChecked = useSessionStore((state) => state.status === "resolved");

    useEffect(() => {
      let cancelled = false;

      void (async () => {
        try {
          const response = await checkAuthWithRefresh();
          const payload = (await response.json().catch(() => null)) as MeResponse | null;

          if (!cancelled) {
            setUser(response.ok && payload?.success ? payload.data.user : null);
          }
        } catch {
          if (!cancelled) {
            setUser(null);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [setUser]);

    /*
     * Looked up as they type, debounced, and only once the code is long enough
     * to be one — the schema's own floor is six characters. Redeeming is
     * single-use and irreversible, so the destination has to be on screen
     * *before* the button rather than confirmed after it.
     */
    const trimmedCode = code.trim();

    useEffect(() => {
      if (trimmedCode.length < 6) {
        setLookup(null);
        setChecking(false);
        return;
      }

      let cancelled = false;
      setChecking(true);

      const timer = window.setTimeout(() => {
        void (async () => {
          try {
            const result = await browserApi<ActivationStatusResponse>(
              `/api/v1/resident/activation-status?code=${encodeURIComponent(trimmedCode)}`,
            );

            if (!cancelled) {
              setLookup(result);
            }
          } catch {
            // A failed lookup is not a failed activation — the code may still
            // be perfectly good. The card simply says nothing.
            if (!cancelled) {
              setLookup(null);
            }
          } finally {
            if (!cancelled) {
              setChecking(false);
            }
          }
        })();
      }, 400);

      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }, [trimmedCode]);

    const codeState = useMemo<CodeState>(() => {
      if (trimmedCode.length < 6) {
        return "empty";
      }

      if (checking) {
        return "checking";
      }

      if (!lookup?.activation) {
        return "unknown";
      }

      if (lookup.activation.status === "USED") {
        return "used";
      }

      if (lookup.activation.status === "CANCELLED") {
        return "unusable";
      }

      if (
        lookup.activation.status === "EXPIRED" ||
        new Date(lookup.activation.expiresAt) <= new Date()
      ) {
        return "expired";
      }

      return "ready";
    }, [checking, lookup, trimmedCode]);

    const target = lookup?.target ?? null;

    const handleActivate = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setMessage("");

        try {
          await browserApi("/api/v1/resident/activate", {
            body: JSON.stringify({
              code: trimmedCode,
              deviceInfo: { source: "web" },
              sessionInfo: { activatedAt: new Date().toISOString() },
            }),
            method: "POST",
          });
          setActivatedTarget(target);
          setActivated(true);
          setMessage("Resident access activated successfully.");
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "Activation failed.");
        }
      },
      [target, trimmedCode],
    );

    return (
      <div className="min-h-screen bg-[#F8FAFC] text-[#0f172a] font-sans flex flex-col justify-between">
        {/* Top Header Bar */}
        <header className="bg-white border-b border-slate-100 shadow-sm sticky top-0 z-50">
          <div className="max-w-[1360px] mx-auto px-4 md:px-8 h-16 flex items-center justify-between">
            {/* Logo */}
            <div className="flex items-center gap-2.5 text-[#0A8A4B]">
              <div className="flex items-center justify-center size-9 bg-[#0A8A4B]/10 rounded-xl">
                <BrandMark className="h-[18px]" />
              </div>
              <span className="font-heading text-2xl font-extrabold text-[#0F172A] tracking-tight">
                <SiteName />
              </span>
            </div>

            {/*
              Only offered once they can actually open them. Before activation
              this account is PUBLIC, and /resident/* turns it away at the door.
            */}
            <nav className="hidden md:flex items-center gap-6 h-full text-sm font-semibold text-slate-500">
              {lookup?.isActivated || activated ? (
                <>
                  <Link
                    href="/resident/dashboard"
                    className="hover:text-[#0A8A4B] transition flex items-center h-full"
                  >
                    Dashboard
                  </Link>
                  <Link
                    href="/resident/profile"
                    className="hover:text-[#0A8A4B] transition flex items-center h-full"
                  >
                    My Profile
                  </Link>
                </>
              ) : null}
              <span className="text-[#0A8A4B] border-b-2 border-[#0A8A4B] h-full flex items-center px-1 font-bold">
                Activate Access
              </span>
            </nav>

            {/* Who is signed in — the account this code will be attached to. */}
            {user ? (
              <div className="flex items-center gap-2">
                <div className="flex size-9 items-center justify-center rounded-full bg-[#EAF6F3] text-[#0A8A4B] font-bold text-sm">
                  {initialsOf(user.name)}
                </div>
                <div className="hidden sm:block text-left">
                  <p className="text-xs font-bold text-[#0F172A] leading-tight">
                    {user.name}
                  </p>
                  <p className="text-[10px] text-slate-400">{user.email ?? ""}</p>
                </div>
              </div>
            ) : sessionChecked ? (
              <Link
                className="text-xs font-bold text-[#0A8A4B] hover:underline"
                href="/login?next=/resident-activation"
              >
                Sign in
              </Link>
            ) : null}
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 max-w-[1360px] mx-auto w-full px-4 md:px-8 py-8">
          {/* Title Block */}
          <div className="mb-6">
            <h1 className="font-heading text-3xl font-extrabold text-[#0F172A]">
              Resident Activation
            </h1>
            <p className="text-sm text-slate-450 mt-1 max-w-3xl">
              Enter the code your hostel gave you to link this account to your bed.
            </p>
          </div>

          {message && (
            <div className="mb-6">
              <Message value={message} />
            </div>
          )}

          {/* Dual Column Layout wrapper */}
          <div className="bg-white rounded-3xl shadow-xl shadow-slate-100/50 border border-slate-100 grid lg:grid-cols-[1.1fr_0.9fr] overflow-hidden">
            {/* Left Column: Form & Details */}
            <div className="p-6 md:p-8 border-b lg:border-b-0 lg:border-r border-slate-100">
              {activated ? (
                <div className="py-12 flex flex-col items-center justify-center text-center space-y-6 animate-in fade-in duration-300">
                  <div className="relative flex size-24 items-center justify-center">
                    <div className="absolute inset-0 rounded-full bg-emerald-500/5 animate-ping duration-1000" />
                    <div className="absolute inset-3 rounded-full bg-emerald-500/10" />
                    <div className="relative flex size-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/15">
                      <CheckCircle2 className="size-10 stroke-[2.5]" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-heading text-2xl font-extrabold text-[#0F172A]">
                      Activation complete
                    </h3>
                    <p className="text-sm text-slate-450 max-w-md mx-auto leading-relaxed">
                      {activatedTarget
                        ? `Your resident access is now active${
                            activatedTarget.roomType
                              ? ` for ${activatedTarget.roomType}`
                              : ""
                          } at ${activatedTarget.hostelName}.`
                        : "Your resident access is now active."}
                    </p>
                  </div>
                  <Link
                    className="inline-flex h-11 items-center justify-center rounded-xl bg-[#0A8A4B] px-6 text-sm font-bold text-white shadow-md shadow-[#0A8A4B]/10 hover:brightness-105 transition"
                    href="/resident/dashboard"
                  >
                    Open Dashboard
                  </Link>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Tabs */}
                  <div className="flex border-b border-slate-100 text-sm font-bold select-none">
                    <button
                      onClick={() => setActiveTab("code")}
                      className={`pb-3 px-2 border-b-2 transition-all ${
                        activeTab === "code"
                          ? "border-[#0A8A4B] text-[#0A8A4B]"
                          : "border-transparent text-slate-400 hover:text-slate-600"
                      }`}
                    >
                      Enter Code
                    </button>
                    <button
                      onClick={() => setActiveTab("qr")}
                      className={`pb-3 px-6 border-b-2 transition-all ${
                        activeTab === "qr"
                          ? "border-[#0A8A4B] text-[#0A8A4B]"
                          : "border-transparent text-slate-400 hover:text-slate-600"
                      }`}
                    >
                      Use the QR
                    </button>
                  </div>

                  {activeTab === "qr" ? (
                    <div className="py-10 text-center space-y-3">
                      <span className="flex size-14 mx-auto items-center justify-center rounded-full bg-[#0A8A4B]/10 text-[#0A8A4B]">
                        <QrCode className="size-8" />
                      </span>
                      <h3 className="text-sm font-bold text-[#0F172A]">
                        Scan it with your phone
                      </h3>
                      <p className="text-xs text-slate-450 max-w-[320px] mx-auto leading-relaxed">
                        The QR in your activation email is a link to this page with the
                        code already filled in. Point your phone&apos;s ordinary camera at
                        it and open the link — no separate scanner needed.
                      </p>
                      <button
                        onClick={() => setActiveTab("code")}
                        className="text-xs font-bold text-[#0A8A4B] hover:underline"
                        type="button"
                      >
                        Type the code instead
                      </button>
                    </div>
                  ) : (
                    <BusyForm className="space-y-6" onSubmit={handleActivate}>
                      {/* Activation Code Input */}
                      <div className="space-y-1.5">
                        <label
                          className="block text-xs font-bold text-[#0F172A]"
                          htmlFor="activation-code"
                        >
                          Activation code
                        </label>
                        <div className="relative flex h-11 items-center rounded-xl border border-slate-200 bg-white px-3 text-[#0f172a] transition focus-within:border-[#0A8A4B] focus-within:ring-2 focus-within:ring-[#0A8A4B]/10">
                          <KeyRound className="mr-2.5 size-4.5 text-slate-400 shrink-0" />
                          <input
                            className="h-full w-full bg-transparent text-sm font-bold outline-none placeholder:text-slate-300 tracking-wider"
                            id="activation-code"
                            name="code"
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="Enter activation code"
                            required
                            type="text"
                            value={code}
                          />
                        </div>
                      </div>

                      {/* What the code opens — read back from the server. */}
                      <div className="space-y-2">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">
                          This code will give you access to:
                        </label>
                        {target ? (
                          <div className="flex flex-col sm:flex-row gap-4 p-4 rounded-2xl border border-slate-100 bg-slate-50/50">
                            {target.photoUrl ? (
                              <div
                                className="w-full sm:w-28 h-20 rounded-xl bg-cover bg-center border border-slate-100 shrink-0"
                                style={{ backgroundImage: `url("${target.photoUrl}")` }}
                              />
                            ) : null}
                            <div className="space-y-1">
                              <div className="flex items-center gap-1.5">
                                <h4 className="text-sm font-bold text-[#0F172A]">
                                  {target.hostelName}
                                </h4>
                                {target.verified ? (
                                  <>
                                    <span className="flex items-center justify-center size-3.5 bg-[#0A8A4B] text-white rounded-full">
                                      <Check className="size-2.5 stroke-[3]" />
                                    </span>
                                    <span className="text-[10px] font-semibold text-[#0A8A4B]">
                                      Verified
                                    </span>
                                  </>
                                ) : null}
                              </div>

                              {placeOf(target) ? (
                                <span className="text-[11px] text-slate-400 flex items-center gap-0.5">
                                  <MapPin className="size-3" /> {placeOf(target)}
                                </span>
                              ) : null}

                              {target.roomType ? (
                                <p className="text-[11px] text-slate-500 font-medium">
                                  Room type:{" "}
                                  <span className="font-bold text-[#0F172A]">
                                    {target.roomType}
                                  </span>
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ) : (
                          <p className="p-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 text-[11px] text-slate-450 leading-relaxed">
                            {codeState === "empty"
                              ? "Enter your code and the hostel it belongs to will appear here, so you can check it before activating."
                              : codeState === "checking"
                                ? "Checking that code…"
                                : "No hostel matches that code yet."}
                          </p>
                        )}
                      </div>

                      {/* The account this code is about to be attached to. */}
                      <div className="space-y-2">
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">
                          Linking to this account
                        </label>
                        {user ? (
                          <div className="flex items-center gap-4 p-4 rounded-2xl border border-slate-100 bg-slate-50/50">
                            <div className="flex size-12 items-center justify-center rounded-full bg-[#EAF6F3] text-[#0A8A4B] font-bold text-base shrink-0">
                              {initialsOf(user.name)}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 flex-1 min-w-0">
                              <div>
                                <span className="block text-[9px] text-slate-400 uppercase tracking-wider">
                                  Full Name
                                </span>
                                <span className="text-xs font-bold text-[#0F172A] block truncate">
                                  {user.name}
                                </span>
                              </div>
                              <div>
                                <span className="block text-[9px] text-slate-400 uppercase tracking-wider">
                                  Email
                                </span>
                                <span className="text-xs font-bold text-[#0F172A] block truncate">
                                  {user.email ?? "—"}
                                </span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="p-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 text-[11px] text-slate-450 leading-relaxed">
                            {sessionChecked ? (
                              <>
                                A code is attached to the account you are signed in
                                with.{" "}
                                <Link
                                  className="font-bold text-[#0A8A4B] hover:underline"
                                  href="/login?next=/resident-activation"
                                >
                                  Sign in first
                                </Link>
                                , then come back to this page.
                              </>
                            ) : (
                              "Checking which account you are signed in with…"
                            )}
                          </p>
                        )}
                      </div>

                      <SubmitButton className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#0A8A4B] text-sm font-bold text-white transition hover:brightness-105 active:scale-[0.99] shadow-md shadow-[#0A8A4B]/10 disabled:cursor-not-allowed disabled:opacity-50">
                        Activate Access
                      </SubmitButton>
                    </BusyForm>
                  )}
                </div>
              )}
            </div>

            {/* Right Column: code status and the rules */}
            {/*
              Stacked from the top rather than spread: with the fake scanner
              gone this column is short, and `justify-between` pushed the two
              real blocks to opposite ends of a mostly empty panel.
            */}
            <div className="p-6 md:p-8 bg-[#EAF6F3]/30 flex flex-col gap-6">
              {/*
                The status of the code in the box, not a legend of the states a
                code can be in. The old panel listed all three at once, which
                told a resident holding a dead code exactly nothing.
              */}
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-[#0F172A]">Activation code</h3>
                {codeState === "empty" ? (
                  <p className="text-[11px] text-slate-450 leading-relaxed">
                    Your hostel issues the code and emails it to you. Codes are valid for
                    a limited time and can be used once.
                  </p>
                ) : (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-slate-100 bg-white p-3">
                    <span
                      className={`size-2 rounded-full mt-1.5 shrink-0 ${DOT_COLOR[codeState]}`}
                    />
                    <div>
                      <h4 className="text-[11px] font-bold text-[#0F172A]">
                        {STATE_COPY[codeState].title}
                      </h4>
                      <p className="text-[10px] text-slate-450 leading-relaxed">
                        {STATE_COPY[codeState].note}
                      </p>
                      {codeState === "ready" && lookup?.activation ? (
                        <p className="text-[10px] text-slate-450 leading-relaxed mt-1">
                          {`Valid until ${new Date(
                            lookup.activation.expiresAt,
                          ).toLocaleDateString()}.`}
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}

                {lookup?.isActivated && !activated ? (
                  <p className="rounded-2xl border border-amber-100 bg-amber-50/60 p-3 text-[10px] text-amber-800 leading-relaxed">
                    This account is already linked to a resident profile. One account
                    holds one live profile at a time, so activating a second one will be
                    refused — ask your hostel if this is unexpected.
                  </p>
                ) : null}
              </div>

              {/* Privacy & Security rules */}
              <div className="pt-4 border-t border-slate-100 flex items-start gap-3 select-none">
                <span className="flex size-8 items-center justify-center rounded-lg bg-[#0A8A4B]/10 text-[#0A8A4B] shrink-0">
                  <LockKeyhole className="size-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-[#0F172A]">
                    Privacy &amp; Security
                  </h4>
                  <ul className="list-disc pl-3 text-[10px] text-slate-450 mt-1 leading-relaxed space-y-1">
                    <li>Activation codes are unique and can only be used once.</li>
                    <li>Issuing a new code cancels any code still outstanding.</li>
                    <li>Only hostel admins can revoke or change your bed assignment.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="text-center text-[10px] text-slate-400 font-semibold border-t border-slate-100 py-4 flex items-center justify-center gap-3 bg-white mt-8 select-none">
          <span>
            &copy; 2026 <SiteName /> Platform. All rights reserved.
          </span>
          <span className="text-slate-200">|</span>
          <span className="flex items-center gap-1">
            Made with <span className="text-red-500">❤️</span> in Nepal 🇳🇵
          </span>
        </footer>
      </div>
    );
  },
);
