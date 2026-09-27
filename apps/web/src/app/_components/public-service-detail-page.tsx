"use client";

import { ArrowLeft, ArrowRight, ArrowUpRight, Check, PlayCircle } from "lucide-react";
import Link from "next/link";

import { ContentIcon } from "@/components/content-icon";
import { cn } from "@/lib/utils";

import {
  getPlan,
  getServiceModule,
  planIncludes,
  serviceHref,
  type PlanService,
  type PlansConfig,
} from "./plans-catalog";
import { PublicShell } from "./shared";
import { StarsCtaCard } from "./stars-cta-card";

/**
 * One service, explained.
 *
 * The three questions a hostel owner has about a line item on a pricing card
 * are what it is, how it works, and why it is built that way — so the page is
 * those three, in that order, under a demo. The writing lives on the service
 * itself in the `plans` config section, authored in Platform → Website Config →
 * Plans & Pricing; a service with nothing written for it still renders, with
 * each section saying so rather than showing invented copy. A section that says
 * nothing is honest, one that says something we made up is not.
 */
export function PublicServiceDetailPage({
  catalog,
  service,
}: {
  catalog: PlansConfig;
  service: PlanService;
}) {
  const serviceModule = getServiceModule(catalog, service.module);
  const plan = getPlan(catalog, service.plan);
  const siblings = catalog.services.filter(
    (other) => other.module === service.module && other.slug !== service.slug,
  );

  return (
    <PublicShell active="plans-pricing">
      <div className="mx-auto max-w-[980px] px-5 pb-24 pt-10 md:px-8">
        <Link
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-brand-teal"
          href="/plans-pricing"
        >
          <ArrowLeft className="size-4" />
          Plans &amp; Pricing
        </Link>

        <header className="mt-6">
          {serviceModule ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-teal">
              <ContentIcon className="size-3.5" slug={serviceModule.icon ?? "sparkles"} />
              {serviceModule.name}
            </span>
          ) : null}

          <h1 className="mt-4 font-heading text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            {service.name}
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            {service.blurb}
          </p>

          <dl className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-border py-4 text-sm">
            {service.audience.length > 0 ? (
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Used by</dt>
                <dd className="font-semibold text-foreground">
                  {service.audience.join(", ")}
                </dd>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">From</dt>
              <dd className="font-semibold text-foreground">
                {plan?.name ?? catalog.plans[0]?.name ?? "—"}
              </dd>
            </div>
          </dl>
        </header>

        <DemoSlot assetId={service.demo.webAssetId} serviceName={service.name} />

        <div className="mt-12 space-y-8">
          <Explainer
            body={service.what}
            heading={`What ${service.name.toLowerCase()} is`}
            label="What"
          />
          <Explainer body={service.how} heading="How it works" label="How" />
          <Explainer body={service.why} heading="Why it is built this way" label="Why" />
        </div>

        <PlanMatrix catalog={catalog} service={service} />

        {siblings.length > 0 && serviceModule ? (
          <section className="mt-16">
            <h2 className="font-heading text-lg font-bold text-foreground">
              Rest of {serviceModule.name}
            </h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {siblings.map((sibling) => (
                <li key={sibling.slug}>
                  <Link
                    className="group flex h-full flex-col rounded-xl border border-border bg-surface p-4 transition hover:border-brand-teal/50 hover:shadow-sm"
                    href={serviceHref(sibling.slug)}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground transition group-hover:text-brand-teal">
                        {sibling.name}
                      </span>
                      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition group-hover:text-brand-teal" />
                    </span>
                    <span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                      {sibling.blurb}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <StarsCtaCard
          className="mt-16"
          contentClassName="flex flex-col items-center gap-5 p-8 text-center md:flex-row md:justify-between md:text-left"
        >
          <p className="text-sm text-emerald-50/85">
            <span className="font-semibold text-white">{service.name}</span> comes with
            the {plan?.name ?? catalog.plans[0]?.name ?? "entry"} plan and every plan
            above it.
          </p>
          <Link
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand-teal shadow-sm transition hover:bg-emerald-50"
            href="/register-hostel"
          >
            Register your hostel
            <ArrowRight className="size-4" />
          </Link>
        </StarsCtaCard>
      </div>
    </PublicShell>
  );
}

/**
 * The walkthrough, when the owner has recorded one.
 *
 * The asset is uploaded PUBLIC, so `files/{id}/url` resolves it for a signed-out
 * visitor and redirects to the object — no token on the request, and nothing on
 * this page knows the bucket. Until a clip exists the frame stays as it was: a
 * labelled, non-interactive placeholder rather than a play button that does
 * nothing, so nobody clicks it expecting a video.
 */
function DemoSlot({ assetId, serviceName }: { assetId: string; serviceName: string }) {
  if (assetId) {
    return (
      <figure className="mt-10 overflow-hidden rounded-2xl border border-border bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a product
            walkthrough with no dialogue; the three sections below are the text
            alternative. */}
        <video
          className="aspect-video w-full"
          controls
          playsInline
          preload="metadata"
          src={`/api/v1/files/${assetId}/url`}
        />
      </figure>
    );
  }

  return (
    <figure className="mt-10 overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex aspect-video flex-col items-center justify-center gap-3 bg-muted/50 text-center">
        <PlayCircle className="size-10 text-muted-foreground" aria-hidden />
        <figcaption className="px-6 text-sm text-muted-foreground">
          A walkthrough of {serviceName} goes here.
        </figcaption>
      </div>
    </figure>
  );
}

function Explainer({
  body,
  heading,
  label,
}: {
  body: string[];
  heading: string;
  label: string;
}) {
  return (
    <section className="border-l-2 border-brand-teal/30 pl-5">
      <p className="text-xs font-bold uppercase tracking-wider text-brand-teal">
        {label}
      </p>
      <h2 className="mt-1 font-heading text-xl font-bold text-foreground">{heading}</h2>
      {body.length > 0 ? (
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">
          {body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground/70">Not written yet.</p>
      )}
    </section>
  );
}

function PlanMatrix({
  catalog,
  service,
}: {
  catalog: PlansConfig;
  service: PlanService;
}) {
  return (
    <section className="mt-16">
      <h2 className="font-heading text-lg font-bold text-foreground">
        Plans that include it
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {catalog.plans.map((plan) => {
          const included = planIncludes(catalog, plan.id, service);

          return (
            <li
              className={cn(
                "rounded-xl border p-4",
                included
                  ? "border-brand-teal/40 bg-brand-teal/5"
                  : "border-border bg-surface",
              )}
              key={plan.id}
            >
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {included ? (
                  <Check className="size-4 text-brand-teal" />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
                {plan.name}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {included ? "Included" : "Not in this plan"}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
