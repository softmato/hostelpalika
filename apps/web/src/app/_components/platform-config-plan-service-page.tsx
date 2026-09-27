"use client";

import { ArrowLeft, Monitor, Plus, Smartphone, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useId } from "react";

import { SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { useUploader } from "@/components/uploads";
import { ContentIcon } from "@/components/content-icon";
import { cn } from "@/lib/utils";

import { InlineText } from "./inline-text";
import {
  getService,
  type PlanService,
  type PlansConfig,
} from "./plans-catalog";
import {
  ConfigPage,
  ConfigPanel,
  ConfigSaveBar,
  TextField,
  parseListField,
  useSiteConfigDraft,
} from "./platform-config-shared";

/**
 * One service, on its own screen.
 *
 * Reached from the arrow on any service line — on a plan card or in the
 * catalogue — because the two things this page holds have nowhere to live on a
 * pricing card: the walkthrough clips, and the three sections of writing that
 * make up the public detail page.
 *
 * ## Two clips, not one
 *
 * The website plays a landscape recording inside a page eight hundred pixels
 * wide; the app plays a portrait one held in a hand. The same file cannot be
 * both — a landscape clip on a phone is a letterboxed strip, and a portrait one
 * on the site is two black columns with a sliver of product between them — so
 * the service carries one of each and each surface plays its own.
 *
 * Both are uploaded PUBLIC through the universal uploader, which means progress
 * appears in the global toaster rather than in a bar built here, and the stored
 * value is a `FileAsset` id rather than a URL: the object can be moved, the
 * bucket can be renamed, and the page still finds it.
 */
export const PlatformConfigPlanServicePageContent = memo(
  function PlatformConfigPlanServicePageContent({ slug }: { slug: string }) {
    const { error, isDirty, message, reset, save, savingSection, setValue, state, valueFor } =
      useSiteConfigDraft();

    const catalog = valueFor("plans");
    const service = getService(catalog, slug);

    const patchService = useCallback(
      (changes: Partial<PlanService>) =>
        setValue("plans", {
          ...catalog,
          services: catalog.services.map((entry) =>
            entry.slug === slug ? { ...entry, ...changes } : entry,
          ),
        }),
      [catalog, setValue, slug],
    );

    return (
      <ConfigPage
        breadcrumb={[
          "Home",
          "Website Config",
          { href: "/platform/config/plans", label: "Plans & Pricing" },
          service?.name ?? slug,
        ]}
        description="What this service is, how it works, why it is built that way — and the walkthrough clip each surface plays above them."
        error={error}
        message={message}
        state={state}
        title={service?.name ?? "Service"}
      >
        <Link
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground transition hover:text-role-platform"
          href="/platform/config/plans"
        >
          <ArrowLeft className="size-3.5" />
          Plans &amp; Pricing
        </Link>

        {service ? (
          <>
            <ConfigSaveBar
              dirty={isDirty("plans")}
              onReset={() => reset("plans")}
              onSave={() => save("plans")}
              saving={savingSection === "plans"}
            />

            <ServiceHeader
              catalog={catalog}
              onPatch={patchService}
              service={service}
            />

            <ConfigPanel
              description="Recorded once per surface. The website plays the landscape clip above the three sections below; the app plays the portrait one. Leave a slot empty and that surface keeps its placeholder frame rather than showing a dead player."
              title="Walkthrough clips"
            >
              <div className="grid gap-3 lg:grid-cols-2">
                <VideoSlot
                  assetId={service.demo.webAssetId}
                  hint="Landscape, 16:9. What a hostel owner sees on a laptop."
                  icon={<Monitor className="size-3.5" />}
                  label="Website clip"
                  onChange={(webAssetId) =>
                    patchService({ demo: { ...service.demo, webAssetId } })
                  }
                />
                <VideoSlot
                  assetId={service.demo.mobileAssetId}
                  hint="Portrait, 9:16. What the same thing looks like in the app."
                  icon={<Smartphone className="size-3.5" />}
                  label="App clip"
                  onChange={(mobileAssetId) =>
                    patchService({ demo: { ...service.demo, mobileAssetId } })
                  }
                />
              </div>
            </ConfigPanel>

            <ConfigPanel
              description="The three questions a hostel owner has about a line item on a pricing card, in the order they ask them. A section left empty says so on the public page rather than showing invented copy — which is the honest answer while something is still being built."
              title="What, how and why"
            >
              <div className="space-y-3">
                <ExplainerEditor
                  body={service.what}
                  heading={`What ${service.name.toLowerCase()} is`}
                  label="What"
                  onChange={(what) => patchService({ what })}
                  placeholder="One or two sentences. What it does, not why it is wonderful."
                />
                <ExplainerEditor
                  body={service.how}
                  heading="How it works"
                  label="How"
                  onChange={(how) => patchService({ how })}
                  placeholder="The mechanism, in the order it happens."
                />
                <ExplainerEditor
                  body={service.why}
                  heading="Why it is built this way"
                  label="Why"
                  onChange={(why) => patchService({ why })}
                  placeholder="The problem it exists to solve. No invented numbers, no guarantees."
                />
              </div>
            </ConfigPanel>
          </>
        ) : (
          <ConfigPanel title="No such service">
            <p className="text-[12.5px] text-muted-foreground">
              Nothing in the catalogue has the slug{" "}
              <span className="font-mono text-foreground">{slug}</span>. It may have been
              renamed or removed.
            </p>
          </ConfigPanel>
        )}
      </ConfigPage>
    );
  },
);

/**
 * The head of the public detail page, editable in place — the module chip, the
 * title, the standfirst and the two facts under the rule.
 */
function ServiceHeader({
  catalog,
  onPatch,
  service,
}: {
  catalog: PlansConfig;
  onPatch: (changes: Partial<PlanService>) => void;
  service: PlanService;
}) {
  const serviceModule = catalog.modules.find((entry) => entry.id === service.module);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card px-3.5 py-2.5">
        <h2 className="font-heading text-[13.5px] font-bold text-foreground">
          The page&apos;s head
        </h2>
        <span className="font-mono text-[10.5px] text-muted-foreground/70">
          /plans-pricing/{service.slug}
        </span>
      </header>

      <div className="px-4 py-5 md:px-6">
        <span className="inline-flex items-center gap-2 rounded-full bg-brand-teal/10 px-3 py-1 text-xs font-semibold text-brand-teal">
          <ContentIcon className="size-3.5" slug={serviceModule?.icon ?? "sparkles"} />
          {serviceModule?.name ?? service.module}
        </span>

        <InlineText
          as="h1"
          className="mt-4 block font-heading text-3xl font-bold tracking-tight text-foreground"
          onChange={(name) => onPatch({ name })}
          placeholder="Service name"
          value={service.name}
        />
        <InlineText
          className="mt-3 block max-w-2xl text-base text-muted-foreground"
          multiline
          onChange={(blurb) => onPatch({ blurb })}
          placeholder="One line, sentence case: what it does"
          value={service.blurb}
        />

        <div className="mt-6 grid gap-2.5 border-t border-border pt-4 sm:grid-cols-2">
          <TextField
            hint="Comma separated. Shown as “Used by” on the page."
            label="Used by"
            onChange={(value) => onPatch({ audience: parseListField(value) })}
            placeholder="Hostel admin, Warden"
            value={service.audience.join(", ")}
          />
          <div>
            <span className="mb-1 block text-[11.5px] font-semibold text-foreground">
              Module and plan
            </span>
            <div className="flex gap-2">
              <select
                className="h-9 w-full rounded-lg border border-border bg-background px-2 text-[12.5px] outline-none transition focus:border-role-platform"
                onChange={(event) => onPatch({ module: event.target.value })}
                value={service.module}
              >
                {catalog.modules.some((entry) => entry.id === service.module) ? null : (
                  <option value={service.module}>{service.module}</option>
                )}
                {catalog.modules.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <select
                className="h-9 w-full rounded-lg border border-border bg-background px-2 text-[12.5px] outline-none transition focus:border-role-platform"
                onChange={(event) => onPatch({ plan: event.target.value })}
                value={service.plan}
              >
                {catalog.plans.some((entry) => entry.id === service.plan) ? null : (
                  <option value={service.plan}>{service.plan || "No plan"}</option>
                )}
                {catalog.plans.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    From {entry.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One clip slot.
 *
 * `useUploader` rather than `<FileUploader>`: the field has its own trigger and
 * its own preview — the stored clip, played back the way the public page plays
 * it — so the component's file list would be a second copy of what is already
 * on screen. Progress still goes to the global toaster, which is the point of
 * going through the shared uploader at all.
 */
function VideoSlot({
  assetId,
  hint,
  icon,
  label,
  onChange,
}: {
  assetId: string;
  hint: string;
  icon: React.ReactNode;
  label: string;
  onChange: (assetId: string) => void;
}) {
  const inputId = useId();
  const uploader = useUploader({
    accessLevel: "PUBLIC",
    kind: "video",
    label,
    maxFiles: 1,
    onChange: (files) => {
      const uploaded = files[0]?.assetId;

      if (uploaded) {
        onChange(uploaded);
      }
    },
  });

  return (
    <div className="rounded-lg border border-border/70 bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
          {icon}
          {label}
          {assetId ? <SoftBadge tone="green">Uploaded</SoftBadge> : null}
        </span>
        <span className="flex items-center gap-1.5">
          <label
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground transition hover:border-role-platform/50 hover:text-role-platform",
              uploader.isUploading && "pointer-events-none opacity-50",
            )}
            htmlFor={inputId}
          >
            <Upload className="size-3" />
            {assetId ? "Replace" : "Upload"}
          </label>
          {assetId ? (
            <button
              aria-label={`Remove the ${label}`}
              className="rounded-md border border-rose-200 px-1.5 py-1 text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/40"
              onClick={() => {
                onChange("");
                uploader.clear();
              }}
              type="button"
            >
              <Trash2 className="size-3" />
            </button>
          ) : null}
        </span>
      </div>

      <input
        accept={uploader.accept}
        className="sr-only"
        id={inputId}
        // Cleared first so the field's own one-file limit never refuses a
        // replacement: the clip that counts is the one in the draft, not the
        // one this hook happens to be holding.
        onChange={(event) => {
          uploader.clear();
          void uploader.handleInputChange(event);
        }}
        type="file"
      />

      <div className="mt-2 overflow-hidden rounded-lg border border-border bg-black">
        {assetId ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- a silent
          // product walkthrough; the written sections below are its alternative.
          <video
            className="aspect-video w-full"
            controls
            preload="metadata"
            src={`/api/v1/files/${assetId}/url`}
          />
        ) : (
          <label
            className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-1.5 bg-muted/40 text-center"
            htmlFor={inputId}
          >
            <Upload className="size-5 text-muted-foreground" />
            <span className="px-4 text-[11.5px] text-muted-foreground">
              No clip yet — {uploader.hint}
            </span>
          </label>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * One of the three written sections, drawn the way the public page draws it and
 * typed into directly. One paragraph per entry, because that is how the page
 * renders them — a single textarea split on blank lines looks the same until
 * somebody leaves two blank lines and loses a paragraph.
 */
function ExplainerEditor({
  body,
  heading,
  label,
  onChange,
  placeholder,
}: {
  body: string[];
  heading: string;
  label: string;
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  return (
    <section className="border-l-2 border-brand-teal/30 pl-5">
      <p className="text-xs font-bold uppercase tracking-wider text-brand-teal">
        {label}
      </p>
      <h3 className="mt-1 font-heading text-lg font-bold text-foreground">{heading}</h3>

      <div className="mt-2.5 space-y-2">
        {body.map((paragraph, index) => (
          <div className="flex items-start gap-2" key={index}>
            <InlineText
              className="block flex-1 text-sm leading-relaxed text-muted-foreground"
              multiline
              onChange={(next) =>
                onChange(body.map((entry, i) => (i === index ? next : entry)))
              }
              placeholder={placeholder}
              value={paragraph}
            />
            <button
              aria-label="Remove paragraph"
              className="mt-0.5 shrink-0 rounded border border-rose-200 px-1.5 py-0.5 text-rose-600 transition hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950/40"
              onClick={() => onChange(body.filter((_, i) => i !== index))}
              type="button"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}

        {body.length === 0 ? (
          <p className="text-sm text-muted-foreground/70">
            Not written yet — this is what the public page will say.
          </p>
        ) : null}

        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition hover:border-role-platform/40 hover:text-role-platform"
          onClick={() => onChange([...body, ""])}
          type="button"
        >
          <Plus className="size-3" />
          Add paragraph
        </button>
      </div>
    </section>
  );
}
