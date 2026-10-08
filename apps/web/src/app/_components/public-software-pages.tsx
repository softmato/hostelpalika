import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { ContentSectionIcon } from "@/components/content-sections";
import { GooglePlayBadge } from "@/components/google-play-badge";
import { formatNpr } from "@/lib/json-ld";
import type {
  ResolvedComparison,
  ResolvedModulePage,
  resolveSoftwarePage,
} from "@/lib/seo-config";
import { cn } from "@/lib/utils";
import type { PlanTier } from "@/modules/platform-config/site-config.validation";

import { OwnerCallout, SeoChip, SeoCrumbs, SeoFaq, SoftmatoCredit } from "./public-seo-blocks";
import { PublicShell } from "./shared";

/**
 * The pages written for hostel owners searching for software: the
 * `/hostel-management-software` pillar, `/features`, one page per module, and
 * the `/vs` comparisons. Server components; the words come from Website Config
 * → SEO and the facts (modules, services, prices) from the plans catalogue.
 */

const PRIMARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground transition hover:bg-primary/90";
const SECONDARY_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-foreground transition hover:border-primary/50";

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-semibold text-primary">{children}</p>;
}

function ModuleIcon({ slug }: { slug: string }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <ContentSectionIcon className="size-5" slug={slug} />
    </span>
  );
}

function PlanBadge({ plan }: { plan: PlanTier | null }) {
  if (!plan) return null;

  return (
    <span className="inline-flex rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary">
      From {plan.name} · {formatNpr(plan.monthly)}/month
    </span>
  );
}

function ClosingBlock({ title }: { title: string }) {
  return (
    <section className="mt-16 space-y-6">
      <OwnerCallout
        body={`Register your hostel, get it verified, and run residents, rent, food and safety from the ${PLATFORM_NAME} app.`}
        title={title}
      />
      <SoftmatoCredit />
    </section>
  );
}

export function SoftwarePage({
  comparisons,
  modules,
  page,
  plans,
}: {
  comparisons: Array<{ href: string; name: string }>;
  modules: ResolvedModulePage[];
  page: ReturnType<typeof resolveSoftwarePage>;
  plans: PlanTier[];
}) {
  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Hostel management software", path: "/hostel-management-software" },
          ]}
        />

        <header className="max-w-3xl">
          <Eyebrow>For hostel owners</Eyebrow>
          <h1 className="mt-2 font-heading text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            {page.headline}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{page.subtitle}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link className={PRIMARY_BUTTON} href="/register-hostel">
              List your hostel
              <ArrowRight className="size-4" />
            </Link>
            <Link className={SECONDARY_BUTTON} href="/plans-pricing">
              See plans & pricing
            </Link>
          </div>
          <GooglePlayBadge className="-ml-2.5 mt-3" />
        </header>

        {page.intro.length ? (
          <div className="mt-10 max-w-3xl space-y-4 text-base leading-relaxed text-muted-foreground">
            {page.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        ) : null}

        {modules.length ? (
          <section className="mt-16">
            <h2 className="font-heading text-2xl font-bold text-foreground">
              Everything a hostel runs on
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {modules.map((entry) => (
                <Link
                  className="group rounded-2xl border border-border bg-surface p-5 transition hover:border-primary/50 hover:shadow-sm"
                  href={`/features/${entry.slug}`}
                  key={entry.slug}
                >
                  <ModuleIcon slug={entry.module.icon} />
                  <h3 className="mt-4 font-heading text-base font-bold text-foreground group-hover:text-primary">
                    {entry.headline}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {entry.module.description}
                  </p>
                  <p className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-primary">
                    {entry.services.length} features
                    <ArrowRight className="size-3.5" />
                  </p>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {page.sections.length ? (
          <section className="mt-16 grid gap-4 md:grid-cols-2">
            {page.sections.map((section) => (
              <div className="rounded-2xl border border-border bg-surface p-6" key={section.title}>
                <div className="flex items-center gap-3">
                  <ModuleIcon slug={section.icon} />
                  <h2 className="font-heading text-lg font-bold text-foreground">{section.title}</h2>
                </div>
                {section.body.map((paragraph) => (
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground" key={paragraph}>
                    {paragraph}
                  </p>
                ))}
              </div>
            ))}
          </section>
        ) : null}

        {page.steps.length ? (
          <section className="mt-16">
            <h2 className="font-heading text-2xl font-bold text-foreground">
              How to start with {PLATFORM_NAME}
            </h2>
            <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {page.steps.map((step, index) => (
                <li className="rounded-2xl border border-border bg-surface p-5" key={step.title}>
                  <span className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 font-heading text-base font-bold text-foreground">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {plans.length ? (
          <section className="mt-16">
            <h2 className="font-heading text-2xl font-bold text-foreground">
              Plans for every size of hostel
            </h2>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {plans.map((plan) => (
                <div
                  className={cn(
                    "rounded-2xl border bg-surface p-6",
                    plan.featured ? "border-primary" : "border-border",
                  )}
                  key={plan.id}
                >
                  <h3 className="font-heading text-lg font-bold text-foreground">
                    {PLATFORM_NAME} {plan.name}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
                  <p className="mt-4 font-heading text-2xl font-bold text-foreground">
                    {formatNpr(plan.monthly)}
                    <span className="text-sm font-medium text-muted-foreground"> / month</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plan.maxResidents ? `Up to ${plan.maxResidents} residents` : "No resident limit"}
                  </p>
                </div>
              ))}
            </div>
            <Link
              className="mt-5 inline-flex items-center gap-1 text-sm font-bold text-primary"
              href="/plans-pricing"
            >
              Compare every plan and feature
              <ArrowRight className="size-4" />
            </Link>
          </section>
        ) : null}

        {comparisons.length ? (
          <section className="mt-16">
            <h2 className="font-heading text-2xl font-bold text-foreground">
              Still on a register book or a spreadsheet?
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {comparisons.map((comparison) => (
                <SeoChip
                  href={comparison.href}
                  key={comparison.href}
                  label={`${PLATFORM_NAME} vs ${comparison.name}`}
                />
              ))}
            </div>
          </section>
        ) : null}

        <SeoFaq entries={page.faq} title={`Questions hostel owners ask about ${PLATFORM_NAME}`} />

        <ClosingBlock title={`Ready to run your hostel on ${PLATFORM_NAME}?`} />
      </div>
    </PublicShell>
  );
}

export function FeaturesHubPage({
  description,
  modules,
  title,
}: {
  description: string;
  modules: ResolvedModulePage[];
  title: string;
}) {
  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Features", path: "/features" },
          ]}
        />

        <header className="max-w-3xl">
          <Eyebrow>Features</Eyebrow>
          <h1 className="mt-2 font-heading text-4xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{description}</p>
        </header>

        <div className="mt-12 space-y-6">
          {modules.map((entry) => (
            <section className="rounded-2xl border border-border bg-surface p-6" key={entry.slug}>
              <div className="flex items-start gap-4">
                <ModuleIcon slug={entry.module.icon} />
                <div className="min-w-0">
                  <h2 className="font-heading text-xl font-bold text-foreground">
                    <Link className="transition hover:text-primary" href={`/features/${entry.slug}`}>
                      {entry.headline}
                    </Link>
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {entry.description}
                  </p>
                </div>
              </div>
              <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                {entry.services.map((service) => (
                  <li key={service.slug}>
                    <Link
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2 text-sm font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
                      href={`/plans-pricing/${service.slug}`}
                    >
                      {service.name}
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <ClosingBlock title={`Every feature, one ${PLATFORM_NAME} account`} />
      </div>
    </PublicShell>
  );
}

export function FeatureModulePage({
  entry,
  others,
}: {
  entry: ResolvedModulePage;
  others: ResolvedModulePage[];
}) {
  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Features", path: "/features" },
            { name: entry.headline, path: `/features/${entry.slug}` },
          ]}
        />

        <header className="max-w-3xl">
          <div className="flex items-center gap-3">
            <ModuleIcon slug={entry.module.icon} />
            <Eyebrow>{entry.module.name}</Eyebrow>
          </div>
          <h1 className="mt-4 font-heading text-4xl font-bold tracking-tight text-foreground">
            {entry.headline}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{entry.description}</p>
        </header>

        {entry.intro.length ? (
          <div className="mt-8 max-w-3xl space-y-4 text-base leading-relaxed text-muted-foreground">
            {entry.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        ) : null}

        <section className="mt-12">
          <h2 className="font-heading text-2xl font-bold text-foreground">What is included</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {entry.services.map((service) => (
              <Link
                className="group flex flex-col rounded-2xl border border-border bg-surface p-5 transition hover:border-primary/50 hover:shadow-sm"
                href={`/plans-pricing/${service.slug}`}
                key={service.slug}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-heading text-base font-bold text-foreground group-hover:text-primary">
                    {service.name}
                  </h3>
                  <PlanBadge plan={service.plan} />
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{service.blurb}</p>
                {service.audience.length ? (
                  <p className="mt-3 text-xs font-medium text-muted-foreground">
                    For {service.audience.join(", ").toLowerCase()}
                  </p>
                ) : null}
                <span className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-primary">
                  How it works
                  <ArrowRight className="size-3.5" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        {others.length ? (
          <section className="mt-16">
            <h2 className="font-heading text-xl font-bold text-foreground">
              More hostel management features
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {others.map((other) => (
                <SeoChip href={`/features/${other.slug}`} key={other.slug} label={other.headline} />
              ))}
            </div>
          </section>
        ) : null}

        <ClosingBlock title={`Run your hostel on ${PLATFORM_NAME}`} />
      </div>
    </PublicShell>
  );
}

export function ComparisonPage({
  comparison,
  others,
}: {
  comparison: ResolvedComparison;
  others: Array<{ href: string; name: string }>;
}) {
  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-[1100px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Hostel management software", path: "/hostel-management-software" },
            { name: comparison.title, path: `/vs/${comparison.slug}` },
          ]}
        />

        <header className="max-w-3xl">
          <Eyebrow>Compare</Eyebrow>
          <h1 className="mt-2 font-heading text-4xl font-bold tracking-tight text-foreground">
            {comparison.title}
          </h1>
          <div className="mt-4 space-y-4 text-lg leading-relaxed text-muted-foreground">
            {comparison.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </header>

        {comparison.rows.length ? (
          <section className="mt-12 overflow-x-auto rounded-2xl border border-border bg-surface">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="w-1/5 px-5 py-4 font-heading font-bold text-foreground" scope="col">
                    The job
                  </th>
                  <th className="px-5 py-4 font-heading font-bold text-muted-foreground" scope="col">
                    {comparison.name}
                  </th>
                  <th className="px-5 py-4 font-heading font-bold text-primary" scope="col">
                    {PLATFORM_NAME}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {comparison.rows.map((row) => (
                  <tr key={row.label}>
                    <th className="px-5 py-4 align-top font-semibold text-foreground" scope="row">
                      {row.label}
                    </th>
                    <td className="px-5 py-4 align-top leading-relaxed text-muted-foreground">
                      {row.them}
                    </td>
                    <td className="px-5 py-4 align-top font-medium leading-relaxed text-foreground">
                      {row.us}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {comparison.stayWith.length ? (
          <section className="mt-12 max-w-3xl rounded-2xl border border-border bg-surface p-6">
            <h2 className="font-heading text-lg font-bold text-foreground">
              When {comparison.name.toLowerCase()} may still be enough
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
              {comparison.stayWith.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <SeoFaq entries={comparison.faq} title="Questions" />

        <section className="mt-16 flex flex-wrap items-center gap-2">
          <Link className={SECONDARY_BUTTON} href="/hostel-management-software">
            See the {PLATFORM_NAME} hostel management system
          </Link>
          {others.map((other) => (
            <SeoChip href={other.href} key={other.href} label={`${PLATFORM_NAME} vs ${other.name}`} />
          ))}
        </section>

        <ClosingBlock title={`Move your hostel to ${PLATFORM_NAME}`} />
      </div>
    </PublicShell>
  );
}
