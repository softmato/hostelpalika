import { ShieldCheck } from "@/components/icons";
import Link from "next/link";

import type { RolePage } from "@/lib/role-pages";

import { OwnerCallout, SeoChip, SeoCrumbs, SeoFaq } from "./public-seo-blocks";
import { PublicShell } from "./shared";

/**
 * `/for/[role]` — what one person in a hostel does on the platform. Server
 * rendered; the words come from `lib/role-pages.ts`.
 */
export function PublicRolePage({
  lockNote,
  others,
  page,
}: {
  lockNote: string;
  others: Array<{ href: string; label: string }>;
  page: RolePage;
}) {
  const owner = page.slug === "owners";

  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-[1100px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Hostel management software", path: "/hostel-management-software" },
            { name: `For ${page.label.toLowerCase()}`, path: `/for/${page.slug}` },
          ]}
        />

        <header className="max-w-3xl">
          <p className="text-sm font-semibold text-primary">For {page.label.toLowerCase()}</p>
          <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {page.headline}
          </h1>
          <p className="mt-4 text-base leading-7 text-muted-foreground">{page.intro}</p>
        </header>

        <section className="mt-10 grid gap-4 sm:grid-cols-2">
          {page.does.map((item) => (
            <div className="rounded-2xl border border-border bg-surface p-6" key={item.title}>
              <h2 className="font-heading text-lg font-bold text-foreground">{item.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
            </div>
          ))}
          <div className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="flex items-center gap-2 font-heading text-lg font-bold text-foreground">
              <ShieldCheck className="size-5 text-primary" />
              PIN and fingerprint lock
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{lockNote}</p>
          </div>
        </section>

        <section className="mt-10 rounded-2xl border border-border bg-surface p-6">
          <h2 className="font-heading text-lg font-bold text-foreground">How you get access</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{page.join}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
              href={owner ? "/register-hostel" : page.slug === "residents" ? "/hostels" : "/login"}
            >
              {owner ? "List your hostel" : page.slug === "residents" ? "Find a hostel" : "Log in"}
            </Link>
            <Link
              className="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/50"
              href={owner ? "/plans-pricing" : "/hostel-management-software"}
            >
              {owner ? "Plans & pricing" : "How the whole hostel works together"}
            </Link>
          </div>
        </section>

        <SeoFaq entries={page.faq} title={`Questions from ${page.label.toLowerCase()}`} />

        <section className="mt-16 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="font-heading text-lg font-bold text-foreground">Everyone else in the hostel</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {others.map((link) => (
                <SeoChip key={link.href} {...link} />
              ))}
            </div>
          </div>
          <OwnerCallout
            body="Rooms, rent, food, staff and parents in one app, and a listing where students search."
            title="Run a hostel?"
          />
        </section>
      </div>
    </PublicShell>
  );
}
