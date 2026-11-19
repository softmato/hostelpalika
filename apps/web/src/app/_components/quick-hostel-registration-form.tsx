"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import {
  type ReferralPreview,
  ReferrerRow,
  Reveal,
  useReferralCodeFromUrl,
} from "@/app/_components/register-hostel-start";
import { PublicShell } from "@/app/_components/shared";
import { BrandSpinner } from "@/components/brand-mark";
import { Building2, Check, CircleAlert, CircleCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, InputGroupInput } from "@/components/ui/input";
import { checkAuthWithRefresh } from "@/lib/auth-check";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { BRANCH_GC_MS, BRANCH_STALE_MS, branchRequestOptions, portalResourceKey } from "@/lib/branch-cache";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";

const SETUP = ["Creating your hostel", "Making you the owner", "Loading your portal", "Opening your portal"];

/**
 * Register your hostel — three fields, the same as the app
 * (docs/QUICK_SIGNUP_KYC_TRIAL.md). Owner name, phone and hostel name open
 * the hostel portal on the signed-in account, on the free trial; the rest is
 * the KYC, inside the portal.
 *
 * After it lands the account is a hostel admin but this tab's token still says
 * public, so the session is re-checked (which rotates it) before going to the
 * portal by its slug.
 */
export function QuickHostelRegistrationForm() {
  const user = useSessionStore((state) => state.user);
  const referralFromUrl = useReferralCodeFromUrl();
  const [ownerName, setOwnerName] = useState(user?.name ?? "");
  const [phone, setPhone] = useState("");
  const [hostelName, setHostelName] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Index into `SETUP` while the portal is being set up; null on the form. */
  const [setup, setSetup] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const code = referralCode || referralFromUrl;
  const typed = code.trim();
  // The code is checked as it is typed, the same check as the landing page's dialog.
  const [preview, setPreview] = useState<ReferralPreview | null>(null);
  const [codeError, setCodeError] = useState("");
  // Kept after they clear so their panels can ease shut with content still in them.
  const [shown, setShown] = useState<ReferralPreview | null>(null);
  const [lastCodeError, setLastCodeError] = useState("");

  useEffect(() => {
    if (typed.length < 4) return;

    let live = true;
    const timer = window.setTimeout(() => {
      browserApi<ReferralPreview>(`/api/v1/public/hostel-referral-codes/${encodeURIComponent(typed)}`).then(
        (found) => {
          if (!live) return;
          setShown(found);
          setPreview(found);
        },
        (caught: unknown) => {
          if (!live) return;
          const message = caught instanceof Error ? caught.message : "That code could not be checked.";
          setLastCodeError(message);
          setCodeError(message);
        },
      );
    }, 450);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [typed]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    setSetup(0);

    try {
      const result = await browserApi<{ slug: string }>("/api/v1/public/hostels/quick-register", {
        body: JSON.stringify({
          hostelName: hostelName.trim(),
          ownerName: ownerName.trim(),
          phone: phone.trim(),
          ...(code.trim() ? { referralCode: code.trim() } : {}),
        }),
        method: "POST",
      });

      setSetup(1);
      await checkAuthWithRefresh();

      // Warm what the portal's first screen reads, under the keys it reads them
      // by. `query-provider` parks the cache on `pagehide` and restores it on the
      // portal, so the dashboard paints from data instead of skeletons.
      setSetup(2);
      const slug = encodeURIComponent(result.slug);
      await Promise.allSettled(
        [hostelAdminEndpoints.dashboardReport, hostelAdminEndpoints.profile, "/api/v1/hostel-admin/subscription"].map(
          (url) =>
            queryClient.prefetchQuery({
              gcTime: BRANCH_GC_MS,
              queryFn: () => browserApi(url, branchRequestOptions(slug)),
              queryKey: portalResourceKey(url, slug),
              staleTime: BRANCH_STALE_MS,
            }),
        ),
      );

      setSetup(3);
      window.location.assign(`/${slug}/admin?welcome=1`);
    } catch (caught) {
      setSetup(null);
      setError(caught instanceof ApiRequestError ? caught.message : "Could not register. Please try again.");
      setSaving(false);
    }
  }

  if (setup !== null) {
    return <PortalSetup active={setup} hostelName={hostelName.trim()} />;
  }

  return (
    <PublicShell active="register-hostel">
      <section className="mx-auto w-full max-w-xl px-4 py-10 sm:py-16">
        <div className="relative rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          <ReferrerCard open={Boolean(preview)} preview={shown} />
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
            Open your hostel portal
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Rooms, photos and documents come later, in KYC.</p>

          <form className="mt-6 grid gap-4" onSubmit={(event) => void submit(event)}>
            <Field id="owner-name" label="Owner's name">
              <Input
                autoComplete="name"
                minLength={2}
                onChange={(event) => setOwnerName(event.target.value)}
                placeholder="Enter your full name"
                required
                value={ownerName}
              />
            </Field>

            <Field id="owner-phone" label="Phone number">
              <Input
                autoComplete="tel"
                inputMode="tel"
                minLength={7}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="Enter your phone number"
                required
                type="tel"
                value={phone}
              />
            </Field>

            <Field id="hostel-name" label="Hostel name">
              <Input
                minLength={2}
                onChange={(event) => setHostelName(event.target.value)}
                placeholder="Enter your hostel name"
                required
                value={hostelName}
              />
            </Field>

            <Field id="referral-code" label="Referral code" optional>
              <InputGroup
                className={cn(preview && "border-success focus-within:border-success focus-within:ring-success")}
              >
                <InputGroupInput
                  aria-describedby={preview || codeError ? "referral-code-status" : undefined}
                  aria-invalid={Boolean(codeError) || undefined}
                  autoCapitalize="characters"
                  className="font-mono uppercase tracking-widest placeholder:font-sans placeholder:normal-case placeholder:tracking-normal"
                  onChange={(event) => {
                    setReferralCode(event.target.value.toUpperCase());
                    setPreview(null);
                    setCodeError("");
                  }}
                  placeholder="Enter a referral code"
                  value={code}
                />
                {preview ? <CircleCheck className="text-success" /> : null}
                {codeError ? <CircleAlert className="text-destructive" /> : null}
              </InputGroup>
              <div id="referral-code-status">
                <div className="xl:hidden">
                <Reveal open={Boolean(preview)}>
                  {shown ? (
                    <div className="grid gap-1 pt-1">
                      <ReferrerRow preview={shown} />
                      <p className="text-[13px] text-success">
                        {shown.rewardText
                          ? `Code accepted. Your plan gets ${shown.rewardText} extra once your hostel goes live.`
                          : "Code accepted."}
                      </p>
                    </div>
                  ) : null}
                </Reveal>
                </div>
                <Reveal open={Boolean(codeError)}>
                  <p className="text-[13px] text-destructive">{codeError || lastCodeError}</p>
                </Reveal>
              </div>
            </Field>

            {error ? (
              <p
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                role="alert"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            ) : null}

            <Button className="mt-2 h-11 w-full text-sm font-semibold" disabled={saving || Boolean(codeError)} type="submit">
              {saving ? "Opening your portal…" : "Open my hostel portal"}
            </Button>
          </form>
        </div>
      </section>
    </PublicShell>
  );
}

/**
 * The hostel a referral code is from, eased in beside the card on wide screens
 * (`xl`, where the gutter fits it) so the form never moves while they type.
 * Narrower screens get the same news inline under the field instead.
 */
function ReferrerCard({ open, preview }: { open: boolean; preview: ReferralPreview | null }) {
  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "absolute bottom-0 left-full ml-6 hidden w-72 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-[opacity,translate] duration-500 ease-out xl:block",
        open ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-4 opacity-0",
      )}
    >
      {preview ? (
        <>
          {preview.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt={preview.from} className="aspect-[16/10] w-full object-cover" src={preview.coverUrl} />
          ) : (
            <div className="flex aspect-[16/10] items-center justify-center bg-muted text-muted-foreground">
              <Building2 className="size-8" />
            </div>
          )}
          <div className="grid gap-3 p-4">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{preview.kind === "HOSTEL" ? "Referred by" : "Partner"}</p>
              <p className="truncate font-semibold text-foreground">{preview.from}</p>
            </div>
            <p className="flex items-start gap-2 text-[13px] text-success">
              <CircleCheck className="mt-px size-4 shrink-0" />
              {preview.rewardText
                ? `Code accepted. Your plan gets ${preview.rewardText} extra once your hostel goes live.`
                : "Code accepted."}
            </p>
          </div>
        </>
      ) : null}
    </aside>
  );
}

/** "Setting up your portal": the HostelPalika wait and the four real steps, live. */
function PortalSetup({ active, hostelName }: { active: number; hostelName: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <section aria-live="polite" className="flex w-full max-w-sm flex-col items-center">
        <BrandSpinner />
        <h1 className="mt-10 text-center font-heading text-2xl font-bold tracking-tight text-foreground">
          Setting up your portal
        </h1>
        {hostelName ? <p className="mt-1 text-center text-sm text-muted-foreground">{hostelName}</p> : null}

        <ol className="mt-8 grid w-full max-w-xs">
          {SETUP.map((label, index) => (
            <li className="relative flex gap-3 pb-5 last:pb-0" key={label}>
              {index < SETUP.length - 1 ? (
                <span
                  className={cn(
                    "absolute top-6 bottom-0 left-3 w-px -translate-x-1/2 transition-colors duration-500",
                    index < active ? "bg-primary" : "bg-border",
                  )}
                />
              ) : null}
              <span
                className={cn(
                  "relative flex size-6 shrink-0 items-center justify-center rounded-full border-2 bg-background transition-colors duration-300",
                  index < active && "border-primary bg-primary text-primary-foreground",
                  index === active && "border-primary",
                  index > active && "border-border",
                )}
              >
                {index < active ? (
                  <Check className="size-3.5" />
                ) : index === active ? (
                  <span className="size-2 animate-pulse rounded-full bg-primary" />
                ) : null}
              </span>
              <span
                className={cn(
                  "pt-0.5 text-sm transition-colors duration-300",
                  index === active ? "font-medium text-foreground" : index < active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
