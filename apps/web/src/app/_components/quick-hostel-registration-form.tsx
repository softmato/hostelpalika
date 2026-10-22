"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { useReferralCodeFromUrl } from "@/app/_components/register-hostel-start";
import { PublicShell } from "@/app/_components/shared";
import { Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
      <section className="mx-auto w-full max-w-md px-4 py-10 sm:py-16">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
          Open your hostel portal
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Three details now. Photos, rooms and documents go in your KYC, any time after.
        </p>

        <form className="mt-8 grid gap-5" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-2">
            <Label htmlFor="owner-name">Owner&apos;s name</Label>
            <Input
              autoComplete="name"
              id="owner-name"
              minLength={2}
              onChange={(event) => setOwnerName(event.target.value)}
              required
              value={ownerName}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="owner-phone">Phone number</Label>
            <Input
              autoComplete="tel"
              id="owner-phone"
              inputMode="tel"
              minLength={7}
              onChange={(event) => setPhone(event.target.value)}
              required
              type="tel"
              value={phone}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="hostel-name">Hostel name</Label>
            <Input
              id="hostel-name"
              minLength={2}
              onChange={(event) => setHostelName(event.target.value)}
              required
              value={hostelName}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="referral-code">Referral code (optional)</Label>
            <Input
              autoCapitalize="characters"
              id="referral-code"
              onChange={(event) => setReferralCode(event.target.value.toUpperCase())}
              value={code}
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}

          <Button disabled={saving} size="lg" type="submit">
            {saving ? "Opening your portal…" : "Open my hostel portal"}
          </Button>
        </form>
      </section>
    </PublicShell>
  );
}

/** "Setting up your portal": one bar and the four real steps behind it. */
function PortalSetup({ active, hostelName }: { active: number; hostelName: string }) {
  const percent = Math.round(((active + 1) / SETUP.length) * 100);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <section aria-live="polite" className="w-full max-w-sm">
        <h1 className="text-center font-heading text-2xl font-bold tracking-tight text-primary">
          Setting up your portal
        </h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">{hostelName}</p>

        <div
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="mt-8 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>

        <ol className="mt-8 grid gap-4">
          {SETUP.map((label, index) => (
            <li className="flex items-center gap-3 text-sm" key={label}>
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  index < active && "border-primary bg-primary text-primary-foreground",
                  index === active && "border-primary",
                  index > active && "border-muted",
                )}
              >
                {index < active ? (
                  <Check className="size-3.5" />
                ) : index === active ? (
                  <span className="size-2 animate-pulse rounded-full bg-primary" />
                ) : null}
              </span>
              <span className={index === active ? "font-medium text-foreground" : "text-muted-foreground"}>
                {label}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
