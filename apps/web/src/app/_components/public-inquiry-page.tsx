"use client";

import {
  BadgeCheck,
  Calendar,
  CheckCircle2,
  Mail,
  MapPin,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  UserRound,
  Loader2,
  Utensils,
} from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { maybePromptForResidentProfile } from "@/components/resident-identity";
import { browserApi } from "@/lib/browser-api";
import { readReferralCode } from "@/lib/referral-code";
import { cn } from "@/lib/utils";
import {
  Breadcrumbs,
  FormField,
  PublicShell,
  SectionCard,
  StatusPill,
  formatMoney,
} from "./shared";
import {
  DEFAULT_HOSTEL_IMAGE,
  hasFood,
  mapPublicHostelToSummary,
  roomTypeLabel,
  type PublicHostel,
} from "./public-hostel-data";

function slugifyRoom(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function PublicInquiryPageContent() {
  const searchParams = useSearchParams();
  const referralCode = readReferralCode(searchParams);
  const hostelSlug = searchParams
    ? searchParams.get("hostel") || "green-view-hostel"
    : "green-view-hostel";
  const preselectedRoom = searchParams ? searchParams.get("room") || "" : "";

  const [hostel, setHostel] = useState<PublicHostel | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedRoomType, setSelectedRoomType] = useState(preselectedRoom);
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    /*
     * Skipped entirely for a referral link. The early return further down picks
     * the referral form, but an early return does not stop an effect — without
     * this the page would still fetch `green-view-hostel` (the default slug) on
     * every referral visit, for a column it never renders.
     */
    if (referralCode) {
      return;
    }

    async function loadHostel() {
      setState("loading");
      setMessage("");

      try {
        const data = await browserApi<{ hostel: PublicHostel }>(
          `/api/v1/public/hostels/${encodeURIComponent(hostelSlug)}`,
        );
        const firstRoom = data.hostel.roomTypes[0] ?? "";
        const matchedRoom =
          data.hostel.roomTypes.find(
            (roomType) =>
              slugifyRoom(roomTypeLabel(roomType)) === preselectedRoom ||
              slugifyRoom(roomType) === preselectedRoom,
          ) ?? firstRoom;

        setHostel(data.hostel);
        setSelectedRoomType(matchedRoom);
        setState("ready");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not load hostel.");
        setState("error");
      }
    }

    void loadHostel();
  }, [hostelSlug, preselectedRoom, referralCode]);

  const hostelSummary = hostel ? mapPublicHostelToSummary(hostel) : null;
  const roomOptions = useMemo(() => {
    const roomTypes = hostel?.roomTypes.length ? hostel.roomTypes : ["Room"];
    const minRent = hostel?.pricing?.monthlyRentMin ?? hostelSummary?.price ?? 0;
    const maxRent = hostel?.pricing?.monthlyRentMax ?? minRent;

    return roomTypes.map((roomType, index) => ({
      id: roomType,
      name: roomTypeLabel(roomType),
      rent:
        roomTypes.length <= 1
          ? minRent
          : Math.round(minRent + ((maxRent - minRent) / (roomTypes.length - 1)) * index),
    }));
  }, [hostel, hostelSummary?.price]);

  /*
   * A referral link is a different form, not a variant of this one.
   *
   * The code resolves to a hostel **server-side** (`createReferredInquiry` files
   * against `referralCode.hostelId`), and no public endpoint maps a code to a
   * hostel — so this page genuinely cannot name the hostel, cannot show its
   * photo, and cannot offer its room types. Rendering the hostel column anyway
   * would mean showing `green-view-hostel`, the default slug, to someone whose
   * friend lives somewhere else entirely.
   *
   * The fetch above is skipped for the same reason — see its guard.
   */
  if (referralCode) {
    return <ReferredInquiryForm code={referralCode} />;
  }

  if (state === "loading") {
    return (
      <PublicShell active="browse">
        <div className="mx-auto max-w-[1360px] px-6 py-10">
          <div className="h-96 animate-pulse rounded-xl border border-border bg-muted" />
        </div>
      </PublicShell>
    );
  }

  if (!hostel || !hostelSummary) {
    return (
      <PublicShell active="browse">
        <div className="mx-auto max-w-[900px] px-6 py-16 text-center">
          <h1 className="text-2xl font-bold text-foreground">Hostel unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {message || "This hostel is not accepting public inquiries right now."}
          </p>
        </div>
      </PublicShell>
    );
  }

  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: "Hostels", href: "/hostels" },
    { label: hostel.name, href: `/hostels/${hostel.slug}` },
    { label: "Inquiry" },
  ];

  const handleFormSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessage("");

    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    const value = (name: string) => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    setSubmitting(true);
    try {
      const result = await browserApi<{ shouldCollectProfile?: boolean }>(
        `/api/v1/public/hostels/${hostel.id}/inquiries`,
        {
          body: JSON.stringify({
            email: value("email") || undefined,
            gender: value("gender") || undefined,
            message: value("message") || undefined,
            name: value("name"),
            phone: value("phone"),
            preferredRoomType: value("preferredRoomType") || undefined,
            preferredVisitDate: value("preferredVisitDate") || undefined,
          }),
          method: "POST",
        },
      );
      setSubmitted(true);
      formElement.reset();

      // Someone who just enquired is about to be asked for these exact details
      // by the hostel — the best possible moment to offer the one-time profile.
      if (result.shouldCollectProfile) {
        window.setTimeout(() => maybePromptForResidentProfile("INQUIRY"), 900);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not submit inquiry.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicShell active="browse">
      <Breadcrumbs items={breadcrumbItems} />

      <section className="mx-auto grid max-w-[1360px] gap-8 px-6 pb-12 lg:grid-cols-[0.4fr_0.6fr]">
        {/* Left Hostel Card Summary */}
        <div className="space-y-5">
          <SectionCard title="Inquire About This Hostel">
            <div className="p-4 space-y-4">
              <div
                className="h-48 rounded-lg bg-cover bg-center relative"
                style={{
                  backgroundImage: `url("${hostelSummary.image || DEFAULT_HOSTEL_IMAGE}")`,
                }}
              >
                <div className="absolute right-3 top-3">
                  <StatusPill tone="success">Verified</StatusPill>
                </div>
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">{hostel.name}</h1>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <MapPin className="size-3 text-brand-teal" /> {hostelSummary.address}
                </p>
                <div className="mt-2.5 flex items-center gap-1 text-xs text-warning">
                  <Star className="size-3.5 fill-warning text-warning" />
                  <span className="font-semibold">
                    {hostelSummary.rating ? hostelSummary.rating.toFixed(1) : "New"}
                  </span>
                  <span className="text-muted-foreground font-normal">
                    ({hostelSummary.reviews} reviews)
                  </span>
                </div>
              </div>

              <div className="border-t border-border/50 pt-3 flex justify-between items-center">
                <p className="text-sm font-bold text-foreground">
                  {formatMoney(hostelSummary.price)}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    / month
                  </span>
                </p>
                <button
                  onClick={() => alert("Image gallery view coming soon!")}
                  className="rounded border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted transition"
                >
                  View Photos
                </button>
              </div>

              {/* Room select radio cards */}
              <div className="border-t border-border/50 pt-4 space-y-2">
                <p className="text-xs font-bold text-foreground">Select Room Type</p>
                {roomOptions.map((room) => (
                  <button
                    key={room.id}
                    onClick={() => setSelectedRoomType(room.id)}
                    className={cn(
                      "w-full text-left rounded-lg border p-3 flex justify-between items-center transition",
                      selectedRoomType === room.id
                        ? "border-brand-teal bg-brand-teal/5 text-brand-teal ring-1 ring-brand-teal"
                        : "border-border bg-surface text-foreground hover:bg-muted",
                    )}
                  >
                    <div>
                      <p className="text-xs font-bold">{room.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {formatMoney(room.rent)} / month
                      </p>
                    </div>
                    <div
                      className={cn(
                        "size-4 rounded-full border-2 flex items-center justify-center shrink-0",
                        selectedRoomType === room.id
                          ? "border-brand-teal bg-brand-teal"
                          : "border-muted-foreground/45 bg-transparent",
                      )}
                    >
                      {selectedRoomType === room.id && (
                        <div className="size-1.5 rounded-full bg-surface" />
                      )}
                    </div>
                  </button>
                ))}
              </div>

              <div className="border-t border-border/50 pt-3 grid grid-cols-2 gap-2.5 text-[10px] text-muted-foreground">
                <div className="flex items-center gap-1">
                  <ShieldCheck className="size-3.5 text-brand-teal" />{" "}
                  {hostel.facilities[0] ?? "Verified listing"}
                </div>
                <div className="flex items-center gap-1">
                  <Utensils className="size-3.5 text-brand-teal" />{" "}
                  {hasFood(hostel) ? "Meals available" : "Food details on request"}
                </div>
                <div className="flex items-center gap-1">
                  <ShieldCheck className="size-3.5 text-brand-teal" />{" "}
                  {hostel.facilities[1] ?? "Verified profile"}
                </div>
                <div className="flex items-center gap-1">
                  <BadgeCheck className="size-3.5 text-brand-teal" />{" "}
                  {hostel.verificationStatus === "VERIFIED"
                    ? "Platform verified"
                    : "Published"}
                </div>
              </div>

              <div className="border-t border-border/50 pt-3 text-[11px] text-muted-foreground space-y-1.5">
                <p className="font-semibold text-foreground">About This Hostel</p>
                <p className="leading-relaxed">
                  Clean, safe and student-friendly environment. Fully furnished rooms with
                  published facilities, transparent pricing, and hostel-managed follow-up.
                  {hostel.description ? ` ${hostel.description}` : ""}
                </p>
              </div>

              <div className="bg-emerald-50 text-[10px] text-success rounded-lg p-3 mt-3 flex items-start gap-1.5">
                <ShieldCheck className="size-4 shrink-0 text-success" fill="none" />
                <span>Trusted by 10,000+ students and families across Nepal.</span>
              </div>
            </div>
          </SectionCard>
        </div>

        {/* Right Form column */}
        <div>
          <SectionCard
            action={
              <div className="hidden sm:flex items-center gap-1.5 text-xs text-brand-teal font-semibold">
                <ShieldCheck className="size-4 text-brand-teal" />
                <span>Verified Secure Encryption</span>
              </div>
            }
            title="Your Inquiry Details"
            description="Please fill in the details below and we'll share it with the hostel. No payments required to submit inquiry."
          >
            {submitted ? (
              <div className="p-8 text-center space-y-4">
                <div className="size-16 rounded-full bg-emerald-100 text-success flex items-center justify-center mx-auto">
                  <CheckCircle2 className="size-10" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-foreground">
                    Inquiry Submitted Successfully!
                  </h3>
                  <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                    Thank you! Your inquiry details have been forwarded to {hostel.name}
                    &apos;s warden. They will review your preferences and contact you
                    shortly at your registered number.
                  </p>
                </div>
                <div className="pt-4">
                  <button
                    onClick={() => setSubmitted(false)}
                    className="rounded-lg bg-brand-teal px-6 py-2.5 text-xs font-semibold text-white shadow hover:brightness-105 transition"
                  >
                    Send Another Inquiry
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleFormSubmit} className="space-y-4 p-1">
                {message ? (
                  <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm font-semibold text-danger">
                    {message}
                  </div>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField
                    icon={UserRound}
                    label="Full Name *"
                    name="name"
                    placeholder="Enter your full name"
                    required
                  />
                  <div>
                    <label className="block text-sm font-semibold text-foreground">
                      Phone Number *
                      <span className="mt-2 flex h-12 items-center gap-2 rounded-lg border border-border bg-surface px-3 shadow-sm focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15 transition">
                        <select className="bg-transparent text-xs font-semibold text-foreground border-none outline-none cursor-pointer">
                          <option>NP (+977)</option>
                          <option>IN (+91)</option>
                        </select>
                        <span className="text-muted-foreground/30">|</span>
                        <input
                          className="h-full w-full bg-transparent text-sm font-normal outline-none placeholder:text-muted-foreground"
                          name="phone"
                          placeholder="98XXXXXXXX"
                          required
                          type="tel"
                        />
                      </span>
                    </label>
                  </div>
                  <FormField
                    icon={Mail}
                    label="Email Address *"
                    name="email"
                    placeholder="Enter your email address"
                    required
                    type="email"
                  />
                  <div>
                    <label className="block text-sm font-semibold text-foreground">
                      Gender *
                      <select
                        className="mt-2 flex h-12 w-full items-center rounded-lg border border-border bg-surface px-3 shadow-sm outline-none focus:border-brand-teal cursor-pointer text-sm font-normal text-foreground"
                        name="gender"
                        required
                      >
                        <option value="">Select gender</option>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-foreground">
                      Preferred Room Type *
                      <select
                        name="preferredRoomType"
                        value={selectedRoomType}
                        onChange={(e) => setSelectedRoomType(e.target.value)}
                        className="mt-2 flex h-12 w-full items-center rounded-lg border border-border bg-surface px-3 shadow-sm outline-none focus:border-brand-teal cursor-pointer text-sm font-normal text-foreground"
                      >
                        {roomOptions.map((room) => (
                          <option key={room.id} value={room.id}>
                            {room.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-foreground">
                      Expected Move-in Date *
                      <span className="mt-2 flex h-12 items-center gap-3 rounded-lg border border-border bg-surface px-3 shadow-sm focus-within:border-brand-teal transition">
                        <Calendar className="size-4 text-muted-foreground" />
                        <input
                          className="h-full w-full bg-transparent text-sm font-normal outline-none placeholder:text-muted-foreground cursor-pointer"
                          name="preferredVisitDate"
                          required
                          type="date"
                        />
                      </span>
                    </label>
                  </div>
                </div>

                <label className="block text-sm font-semibold text-foreground">
                  Additional Notes (Optional)
                  <textarea
                    maxLength={300}
                    name="message"
                    className="mt-2 min-h-24 w-full rounded-lg border border-border bg-surface p-3 text-sm font-normal outline-none focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15 transition placeholder:text-muted-foreground"
                    placeholder="Tell the hostel about your study location, dietary constraints, or schedule preferences."
                  />
                  <span className="text-[10px] text-muted-foreground text-right block mt-1">
                    Max 300 characters
                  </span>
                </label>

                <div className="flex items-start gap-2 pt-2">
                  <input
                    required
                    className="size-4 rounded border-border mt-0.5 cursor-pointer"
                    type="checkbox"
                    id="agree"
                  />
                  <label
                    htmlFor="agree"
                    className="text-xs text-muted-foreground leading-relaxed cursor-pointer select-none"
                  >
                    I agree that my details will be shared with {hostel.name} and I may be
                    contacted by the hostel administration regarding availability.
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-teal font-semibold text-white shadow hover:brightness-110 transition disabled:opacity-60"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {submitting ? "Submitting..." : "Submit Inquiry"}
                </button>

                <p className="text-[10px] text-center text-muted-foreground mt-3">
                  Your information is secure and will only be used for this inquiry.
                </p>
              </form>
            )}
          </SectionCard>
        </div>
      </section>
    </PublicShell>
  );
}

/**
 * The `?ref=` form — a friend's referral link.
 *
 * ## Deliberately smaller than the ordinary inquiry
 *
 * `referredInquiryCreateSchema` takes **name, phone, optional email, optional
 * message** and the code. Nothing else. So there is no gender field, no room
 * type and no move-in date here — not because they would be unwelcome, but
 * because the server has nowhere to put them, and a required field whose value
 * is discarded is a worse form than a short one.
 *
 * ## The hostel is not named, on purpose
 *
 * The code resolves to a hostel inside `createReferredInquiry`; the client never
 * learns which. A page that guessed would send someone's phone number to the
 * wrong hostel with complete confidence, so the copy says "your friend's hostel"
 * — the same call `apps/mobile/src/app/ref/[code].tsx` makes, for the same
 * reason.
 *
 * ## `REFERRAL_ALREADY_EXISTS` is not a red box
 *
 * The service rejects a second inquiry from the same phone against the same code
 * with a 409. That is someone submitting twice, which is not an error worth
 * alarming them over — they are already in the queue and the referrer is already
 * credited, so they get told exactly that.
 */
function ReferredInquiryForm({ code }: { code: string }) {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const value = (name: string) => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    setSubmitting(true);

    try {
      await browserApi("/api/v1/public/inquiries/with-referral", {
        body: JSON.stringify({
          email: value("email") || undefined,
          message: value("message") || undefined,
          name: value("name"),
          phone: value("phone"),
          referralCode: code,
        }),
        method: "POST",
      });

      setSubmitted(true);
      formElement.reset();
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : "Could not send that.";

      setError(
        /already exists/i.test(text)
          ? "You have already sent this one — the hostel has your details and your friend has the credit."
          : text,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PublicShell active="browse">
      <Breadcrumbs
        items={[
          { label: "Home", href: "/" },
          { label: "Hostels", href: "/hostels" },
          { label: "Referral" },
        ]}
      />

      <section className="mx-auto max-w-[720px] px-6 pb-12">
        <SectionCard
          title="You have been referred"
          description="Send your details and the hostel will get back to you — your friend gets the credit."
        >
          {submitted ? (
            <div className="space-y-4 p-8 text-center">
              <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-emerald-100 text-success">
                <CheckCircle2 className="size-10" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-foreground">Inquiry sent</h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                  Your details are with the hostel and your friend has been credited.
                  They will contact you on the number you gave.
                </p>
              </div>
              <Link
                className="inline-flex h-11 items-center justify-center rounded-lg bg-brand-teal px-6 text-xs font-semibold text-white shadow transition hover:brightness-105"
                href="/hostels"
              >
                Browse other hostels
              </Link>
            </div>
          ) : (
            <form className="space-y-4 p-1" onSubmit={handleSubmit}>
              <div className="flex items-start gap-2.5 rounded-lg border border-brand-teal/20 bg-brand-teal/5 p-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-teal" />
                <p className="text-xs text-muted-foreground">
                  This goes straight to your friend&apos;s hostel. You do not need an
                  account, and nothing is payable to send it.
                </p>
              </div>

              {error ? (
                <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-sm font-semibold text-danger">
                  {error}
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  icon={UserRound}
                  label="Full Name *"
                  name="name"
                  placeholder="Enter your full name"
                  required
                />
                <div>
                  <label className="block text-sm font-semibold text-foreground">
                    Phone Number *
                    <span className="mt-2 flex h-12 items-center gap-2 rounded-lg border border-border bg-surface px-3 shadow-sm transition focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15">
                      <span className="text-xs font-semibold text-foreground">
                        NP (+977)
                      </span>
                      <span className="text-muted-foreground/30">|</span>
                      <input
                        className="h-full w-full bg-transparent text-sm font-normal outline-none placeholder:text-muted-foreground"
                        name="phone"
                        placeholder="98XXXXXXXX"
                        required
                        type="tel"
                      />
                    </span>
                  </label>
                </div>
              </div>

              <FormField
                icon={Mail}
                label="Email Address"
                name="email"
                placeholder="Optional — for a written reply"
                type="email"
              />

              <label className="block text-sm font-semibold text-foreground">
                Anything to add?
                <textarea
                  className="mt-2 w-full rounded-lg border border-border bg-surface p-3 text-sm font-normal outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
                  maxLength={1200}
                  name="message"
                  placeholder="When you are looking to move in, or anything you want to ask."
                  rows={4}
                />
              </label>

              <button
                className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand-teal font-semibold text-white shadow transition hover:brightness-110 disabled:opacity-60"
                disabled={submitting}
                type="submit"
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                {submitting ? "Sending..." : "Send inquiry"}
              </button>

              <p className="mt-3 text-center text-[10px] text-muted-foreground">
                Your information is secure and will only be used for this inquiry.
              </p>
            </form>
          )}
        </SectionCard>
      </section>
    </PublicShell>
  );
}

export function PublicInquiryPage() {
  return (
    <Suspense fallback={null}>
      <PublicInquiryPageContent />
    </Suspense>
  );
}
