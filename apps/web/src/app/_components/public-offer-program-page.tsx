"use client";

import { ArrowRight } from "@/components/icons";
import Link from "next/link";

import { PublicShell } from "@/app/_components/shared";
import {
  ContentHeader,
  ContentIntro,
  ContentNote,
  ContentSections,
} from "@/components/content-sections";
import { useSiteConfig } from "@/components/site-config-provider";
import { Button } from "@/components/ui/button";
import { resolveContentPage } from "@/lib/site-content";
import { useSessionStore } from "@/stores/session-store";

/**
 * The public explainer for the Resident Offer Program.
 *
 * **Public, and deliberately so.** Every other surface that mentions the
 * programme is behind a login, but the two moments a resident most wants to read
 * about it are moments they are not logged in: the confirmation email that lands
 * seconds after they submit a payment proof, and the conversation with a parent
 * or guardian who is paying the rent and has no account at all.
 *
 * **The same shell as the legal pages**, on purpose. This is a page of plain
 * answers to plain questions, and the privacy/terms layout is what the site
 * already uses for that. It is not a landing page and should not grow into one
 * here — a deeper treatment is later work.
 *
 * The copy answers, in order, the four things residents actually ask: what it is,
 * what to do, what they get, and why the receipt cannot be reused. The last one
 * is not decoration — residents have tried to re-submit an issued receipt as
 * proof of a later payment, and telling them plainly why that does not work is
 * cheaper than the rejection it otherwise becomes.
 *
 * That copy now lives in the site config under `content.offerProgram`, because
 * the app shows the same explainer and a resident must not be able to read two
 * different accounts of how their rent is matched.
 */

/**
 * The apply block — the one part of this page that is not the same for everyone.
 *
 * Three states, and the distinction that matters is the third: a signed-in user
 * who is not a resident. Showing them "Apply" would send them to a portal they
 * cannot open, and showing them the signed-out pitch would tell them to create an
 * account they already have. Both are dead ends, and both are what a two-state
 * check produces.
 *
 * `status === "unknown"` renders the block disabled rather than absent. The
 * session resolves a beat after first paint, and a button that appears late moves
 * the page under whoever was already reading it — worse than one that is briefly
 * inert.
 *
 * **Apply routes into the portal rather than writing anything.** Eligibility is a
 * property of being a resident with invoices, which is already true or already
 * false by the time anyone reads this page; there is no approval to grant. The
 * button takes an eligible resident to the screen where their code lives and
 * where the programme is actually used.
 */
function ApplyBlock() {
  const status = useSessionStore((state) => state.status);
  const user = useSessionStore((state) => state.user);
  const isResident = Boolean(user?.userResidentId);

  if (status === "unknown") {
    return (
      <div className="mt-16 rounded-xl border border-border bg-muted/50 p-6">
        <p className="text-sm text-muted-foreground">Checking your account…</p>
      </div>
    );
  }

  if (isResident) {
    return (
      <div className="mt-16 rounded-xl border border-primary/30 bg-primary/5 p-6">
        <p className="font-semibold text-foreground">You are eligible</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your resident account qualifies for the Resident Offer Program. Apply to
          start using your reference code on your next payment.
        </p>
        <Button asChild className="mt-4">
          <Link href="/resident/payments">
            Apply for the Resident Offer Program
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    );
  }

  if (user) {
    // Signed in, but not as a resident — an owner, a warden, a guardian, a
    // visitor with an account. Saying "become a resident" is the honest answer
    // and it is not the same as "sign up".
    return (
      <div className="mt-16 rounded-xl border border-border bg-muted/50 p-6">
        <p className="font-semibold text-foreground">
          This programme is for residents
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account is signed in, but it is not a resident account. The Resident
          Offer Program runs on the invoices a hostel issues you, so you need to be a
          resident of a hostel on the platform to be eligible.
        </p>
        <Button asChild className="mt-4" variant="outline">
          <Link href="/hostels">
            Find a hostel
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-16 rounded-xl border border-border bg-muted/50 p-6">
      <p className="font-semibold text-foreground">Become a resident to be eligible</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The Resident Offer Program is open to residents of hostels on this platform.
        Join a hostel first — once your resident account is active and your first
        invoice is raised, you can apply from this page.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/hostels">
            Find a hostel
            <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/login">Already a resident? Sign in</Link>
        </Button>
      </div>
    </div>
  );
}

export function PublicOfferProgramPage() {
  const { content, identity } = useSiteConfig();
  const page = resolveContentPage(content.offerProgram, identity);

  return (
    <PublicShell active="offer-program">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <ContentHeader
          icon="sparkles"
          subtitle={page.subtitle}
          title="Resident Offer Program"
        />

        <ContentIntro paragraphs={page.intro} />

        <ContentSections sections={page.sections} />

        {/* Apply — the only part of the page that depends on who is reading it. */}
        <ApplyBlock />

        <ContentNote body={page.noteBody} className="mt-8" title={page.noteTitle} />
      </div>
    </PublicShell>
  );
}
