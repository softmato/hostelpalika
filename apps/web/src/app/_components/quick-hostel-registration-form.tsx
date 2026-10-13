"use client";

import { useState, type FormEvent } from "react";

import { useReferralCodeFromUrl } from "@/app/_components/register-hostel-start";
import { PublicShell } from "@/app/_components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkAuthWithRefresh } from "@/lib/auth-check";
import { ApiRequestError, browserApi } from "@/lib/browser-api";
import { useSessionStore } from "@/stores/session-store";

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
  const code = referralCode || referralFromUrl;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);

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

      await checkAuthWithRefresh();
      window.location.assign(`/${encodeURIComponent(result.slug)}/admin?welcome=1`);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : "Could not register. Please try again.");
      setSaving(false);
    }
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
