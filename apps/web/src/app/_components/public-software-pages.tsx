import { ArrowRight, BadgeCheck, ShieldCheck, Users } from "@/components/icons";
import Link from "next/link";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { ContentSectionIcon } from "@/components/content-sections";
import { GooglePlayBadge } from "@/components/google-play-badge";
import { AreaAccordion, MoreToggle, ToggleCard } from "@/components/smooth-collapse";
import { formatNpr } from "@/lib/json-ld";
import { ROLE_LINKS } from "@/lib/role-links";
import type {
  ResolvedComparison,
  ResolvedModulePage,
  resolveSoftwarePage,
} from "@/lib/seo-config";
import { cn } from "@/lib/utils";
import type { PlanTier } from "@/modules/platform-config/site-config.validation";

import { OwnerCallout, SeoChip, SeoCrumbs, SeoFaq, SoftmatoCredit } from "./public-seo-blocks";
import { PublicShell } from "./shared";
import { ServiceIcon } from "./service-icon";
import { SoftwareHeroVisual } from "./software-hero";
import { ExtrasSection, ModuleAtlas, RolesSection, WorkflowSection } from "./software-overview";

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
      {children}
    </h2>
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
  const [lead, ...moreIntro] = page.intro;

  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-[1200px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Hostel management software", path: "/hostel-management-software" },
          ]}
        />

        <header className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <p className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">
              <ShieldCheck className="size-4" />
              For hostel owners
            </p>
            <h1 className="mt-4 font-heading text-3xl font-bold tracking-tight text-foreground md:text-4xl">
              {page.headline}
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {page.subtitle}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link className={PRIMARY_BUTTON} href="/register-hostel">
                List your hostel
                <ArrowRight className="size-4" />
              </Link>
              <Link className={SECONDARY_BUTTON} href="/plans-pricing">
                See plans & pricing
              </Link>
              <GooglePlayBadge />
            </div>
          </div>
          <SoftwareHeroVisual />
        </header>

        {lead ? (
          <div className="sr-only">
            <p>{lead}</p>
            {moreIntro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        ) : null}

        <RolesSection />
        <ModuleAtlas modules={modules} />

        {page.sections.length ? (
          <section className="mt-20 grid gap-4 md:grid-cols-2">
            {page.sections.map((section) => {
              const [first, ...rest] = section.body;

              return (
                <div
                  className="hp-card rounded-2xl border border-border bg-surface p-6"
                  key={section.title}
                >
                  <div className="flex items-center gap-3">
                    <ModuleIcon slug={section.icon} />
                    <h2 className="font-heading text-lg font-bold text-foreground">{section.title}</h2>
                  </div>
                  {first ? (
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{first}</p>
                  ) : null}
                  {rest.length ? (
                    <MoreToggle>
                      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                        {rest.map((paragraph) => (
                          <p key={paragraph}>{paragraph}</p>
                        ))}
                      </div>
                    </MoreToggle>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        <ExtrasSection />

        {page.steps.length ? (
          <section className="mt-20">
            <SectionTitle>Start in {page.steps.length} steps</SectionTitle>
            <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
              {page.steps.map((step, index) => (
                <li className="relative" key={step.title}>
                  {index < page.steps.length - 1 ? (
                    <span
                      aria-hidden
                      className="absolute left-[3.25rem] right-[-1.25rem] top-[1.125rem] hidden items-center lg:flex"
                    >
                      <span className="hp-dash-h h-0.5 flex-1" />
                      <ArrowRight className="hp-nudge-x -ml-1 size-4 shrink-0 text-primary" />
                    </span>
                  ) : null}
                  <span className="flex size-10 items-center justify-center rounded-full bg-primary font-heading text-base font-bold text-primary-foreground">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 font-heading text-base font-bold text-foreground">
                    {step.title}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {plans.length ? (
          <section className="mt-20">
            <SectionTitle>Plans for every size of hostel</SectionTitle>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {plans.map((plan) => (
                <div
                  className={cn(
                    "hp-card rounded-2xl border bg-surface p-6",
                    plan.featured ? "border-primary shadow-md" : "border-border",
                  )}
                  key={plan.id}
                >
                  <h3 className="flex items-center gap-2 font-heading text-lg font-bold text-foreground">
                    {plan.featured ? <BadgeCheck className="size-5 text-primary" /> : null}
                    {plan.name}
                  </h3>
                  <p className="mt-4 font-heading text-3xl font-bold text-foreground">
                    {formatNpr(plan.monthly)}
                    <span className="text-sm font-medium text-muted-foreground"> / month</span>
                  </p>
                  <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Users className="size-4 text-primary" />
                    {plan.maxResidents ? `Up to ${plan.maxResidents} residents` : "No resident limit"}
                  </p>
                </div>
              ))}
            </div>
            <Link
              className="mt-6 inline-flex items-center gap-1 text-sm font-bold text-primary"
              href="/plans-pricing"
            >
              Compare every plan
              <ArrowRight className="size-4" />
            </Link>
          </section>
        ) : null}

        <section className="mt-20">
          <SectionTitle>What each person in the hostel gets</SectionTitle>
          <div className="mt-5 flex flex-wrap gap-2">
            {ROLE_LINKS.map((role) => (
              <SeoChip href={`/for/${role.slug}`} key={role.slug} label={`For ${role.label.toLowerCase()}`} />
            ))}
          </div>
        </section>

        <WorkflowSection />

        <SeoFaq entries={page.faq} title="Questions hostel owners ask" />

        {comparisons.length ? (
          <section className="mt-20">
            <SectionTitle>Still on a register book or a spreadsheet?</SectionTitle>
            <div className="mt-5 flex flex-wrap gap-2">
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
          <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            {title}
          </h1>
          <p className="sr-only">{description}</p>
        </header>

        <div className="mt-10 space-y-4">
          {modules.map((entry, moduleIndex) => (
            <AreaAccordion
              count={entry.services.length}
              defaultOpen={moduleIndex === 0}
              href={`/features/${entry.slug}`}
              icon={<ModuleIcon slug={entry.module.icon} />}
              id={entry.slug}
              key={entry.slug}
              subtitle={entry.headline}
              title={entry.module.name}
            >
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {entry.services.map((service, index) => (
                  <li key={service.slug}>
                    <Link
                      className="hp-card group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface p-5 transition hover:-translate-y-0.5"
                      href={`/plans-pricing/${service.slug}`}
                    >
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -right-1 -top-3 font-heading text-6xl font-extrabold text-primary/10"
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <ServiceIcon
                          className="size-5"
                          fallbackSlug={entry.module.icon}
                          slug={service.slug}
                        />
                      </span>
                      <span className="mt-4 block font-heading text-base font-bold text-foreground group-hover:text-primary">
                        {service.name}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-muted-foreground">
                        {service.blurb}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </AreaAccordion>
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
          <div className="sr-only">
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
          <h1 className="font-heading text-4xl font-bold tracking-tight text-foreground">
            {comparison.title}
          </h1>
          <div className="sr-only">
            {comparison.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </header>

        {comparison.rows.length ? (
          <section className="mt-10 space-y-3">
            {comparison.rows.map((row) => (
              <ToggleCard defaultOpen key={row.label} title={row.label}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-muted/40 p-4">
                    <p className="font-heading text-sm font-bold text-muted-foreground">
                      {comparison.name}
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{row.them}</p>
                  </div>
                  <div className="rounded-xl bg-primary/10 p-4">
                    <p className="font-heading text-sm font-bold text-primary">{PLATFORM_NAME}</p>
                    <p className="mt-1.5 text-sm font-medium leading-relaxed text-foreground">
                      {row.us}
                    </p>
                  </div>
                </div>
              </ToggleCard>
            ))}
          </section>
        ) : null}

        {comparison.stayWith.length ? (
          <section className="mt-3">
            <ToggleCard title={`When ${comparison.name.toLowerCase()} may still be enough`}>
              <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">
                {comparison.stayWith.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </ToggleCard>
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
