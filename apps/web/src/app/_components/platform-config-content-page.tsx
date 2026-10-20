"use client";

import { memo } from "react";

import { useSiteConfig } from "@/components/site-config-provider";
import { CONTENT_ICON_SLUGS } from "@/lib/site-content";
import type {
  ContentPage,
  ContentSection,
} from "@/modules/platform-config/site-config.validation";

import {
  ConfigCard,
  ConfigPage,
  Repeater,
  TextAreaField,
  TextField,
  useSiteConfigDraft,
} from "./platform-config-shared";

/**
 * Platform → Website Config → **Page Content**.
 *
 * The one screen that edits the prose the platform publishes: the privacy
 * policy, the terms, About, the Resident Offer Program explainer, the two
 * partner landing pages, and the FAQ. All of it used to be constants inside
 * page components, duplicated once the mobile app grew the same screens — see
 * `contentSchema` for why that had to end.
 *
 * ## Everything here opens pre-filled
 *
 * `useSiteConfigDraft` falls back to `DEFAULT_SITE_CONFIG`, and the shipped
 * documents *are* that section's default. So a fresh database shows the real
 * policy in these fields rather than empty boxes, Reset restores the shipped
 * text, and an owner who never opens this page still serves a complete site.
 *
 * ## One editor shape for seven pages
 *
 * Every page is `subtitle` + `intro` + `sections` + a closing note, and the
 * differences are which of those it uses — the legal pages have no highlights,
 * the landing pages have no note worth calling a note. Rather than seven bespoke
 * cards, there is one `PageEditor` and a card per page. A field a page does not
 * use is left blank and simply does not render on the public side.
 */

const BODY_HINT = "One claim per line. Each becomes a bullet on the page.";
const ICON_HINT = `Icon name, e.g. ${CONTENT_ICON_SLUGS.slice(0, 4).join(", ")}. Unknown names fall back to a generic mark.`;
const PLACEHOLDER_HINT =
  "{siteName} and {supportEmail} are replaced with the values from Site Identity.";

/** Textareas hold one entry per line; the stored value is a string array. */
function linesToList(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function PageEditor({
  onChange,
  page,
  liveStats,
  showHighlights = false,
}: {
  /** Counted by the server; shown read-only above the editable claims. */
  liveStats?: { label: string; value: number }[];
  onChange: (next: ContentPage) => void;
  page: ContentPage;
  showHighlights?: boolean;
}) {
  return (
    <div className="space-y-4">
      <TextField
        hint={PLACEHOLDER_HINT}
        label="Subtitle"
        onChange={(subtitle) => onChange({ ...page, subtitle })}
        placeholder="The one line under the page title"
        value={page.subtitle}
      />

      <TextAreaField
        hint="One paragraph per line, shown above the first section."
        label="Intro paragraphs"
        onChange={(value) => onChange({ ...page, intro: linesToList(value) })}
        rows={4}
        value={page.intro.join("\n")}
      />

      {liveStats ? (
        <div>
          <p className="mb-1 text-[11.5px] font-semibold text-foreground">
            Live counts
          </p>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Counted from the platform every few minutes. A count under 10 is hidden. Not editable.
          </p>
          {liveStats.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {liveStats.map((item) => (
                <div className="rounded-lg border border-border px-3 py-2" key={item.label}>
                  <p className="text-sm font-bold text-foreground">
                    {item.value.toLocaleString("en-US")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{item.label}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">Nothing big enough to show yet.</p>
          )}
        </div>
      ) : null}

      {showHighlights ? (
        <div>
          <p className="mb-1 text-[11.5px] font-semibold text-foreground">
            Highlights (stat strip)
          </p>
          <Repeater<{ label: string; value: string }>
            addLabel="Add highlight"
            emptyLabel="No stats shown on this page."
            items={page.highlights}
            makeItem={() => ({ label: "", value: "" })}
            max={8}
            onChange={(highlights) => onChange({ ...page, highlights })}
            renderRow={(item, patch) => (
              <div className="grid gap-2 sm:grid-cols-2">
                <TextField
                  label="Value"
                  onChange={(value) => patch({ value })}
                  placeholder="500+"
                  value={item.value}
                />
                <TextField
                  label="Label"
                  onChange={(label) => patch({ label })}
                  placeholder="Hostels Onboarded"
                  value={item.label}
                />
              </div>
            )}
          />
        </div>
      ) : null}

      <div>
        <p className="mb-1 text-[11.5px] font-semibold text-foreground">Sections</p>
        <Repeater<ContentSection>
          addLabel="Add section"
          emptyLabel="This page has no sections yet."
          items={page.sections}
          makeItem={() => ({ body: [], icon: "sparkles", title: "" })}
          max={24}
          onChange={(sections) => onChange({ ...page, sections })}
          renderRow={(item, patch) => (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
                <TextField
                  label="Heading"
                  onChange={(title) => patch({ title })}
                  placeholder="Data Security"
                  value={item.title}
                />
                <TextField
                  hint={ICON_HINT}
                  label="Icon"
                  onChange={(icon) => patch({ icon })}
                  placeholder="shield"
                  value={item.icon}
                />
              </div>
              <TextAreaField
                hint={BODY_HINT}
                label="Body"
                onChange={(value) => patch({ body: linesToList(value) })}
                rows={5}
                value={item.body.join("\n")}
              />
            </div>
          )}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <TextField
          label="Closing note title"
          onChange={(noteTitle) => onChange({ ...page, noteTitle })}
          placeholder="Questions about this policy?"
          value={page.noteTitle}
        />
        <TextAreaField
          hint="Leave blank to hide the closing note entirely."
          label="Closing note body"
          onChange={(noteBody) => onChange({ ...page, noteBody })}
          rows={2}
          value={page.noteBody}
        />
      </div>
    </div>
  );
}

export const PlatformConfigContentPageContent = memo(
  function PlatformConfigContentPageContent() {
    const {
      error,
      isDirty,
      message,
      reset,
      save,
      savingSection,
      setValue,
      state,
      valueFor,
    } = useSiteConfigDraft();
  const livePlatformStats = useSiteConfig().platformStats;

    const content = valueFor("content");
    const dirty = isDirty("content");
    const saving = savingSection === "content";

    /*
     * Every card writes the same section, so they share one Save. Splitting the
     * saves would mean seven concurrent writes to a single `PlatformSetting`
     * document, where the last one to land silently discards the other six.
     */
    const cardProps = {
      dirty,
      onReset: () => reset("content"),
      onSave: () => void save("content"),
      saving,
    };

    const setPage = (key: keyof typeof content, next: ContentPage) =>
      setValue("content", { ...content, [key]: next });

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Page Content"]}
        description="The words of every prose page, on the website and in the app."
        error={error}
        message={message}
        state={state}
        title="Page Content"
      >
        <ConfigCard
          {...cardProps}
          description="/privacy and the app's Privacy screen; a Legal Pages body replaces these sections."
          title="Privacy Policy"
        >
          <PageEditor
            onChange={(next) => setPage("privacy", next)}
            page={content.privacy}
          />
        </ConfigCard>

        <ConfigCard
          {...cardProps}
          description="/terms and the app's Terms screen."
          title="Terms & Regulations"
        >
          <PageEditor onChange={(next) => setPage("terms", next)} page={content.terms} />
        </ConfigCard>

        <ConfigCard
          {...cardProps}
          description="/about and the app's About screen; each body is one paragraph."
          title="About Us"
        >
          <PageEditor onChange={(next) => setPage("about", next)} page={content.about} />
        </ConfigCard>

        <ConfigCard
          {...cardProps}
          description="/resident-offer-program, linked from every payment email."
          title="Resident Offer Program"
        >
          <PageEditor
            onChange={(next) => setPage("offerProgram", next)}
            page={content.offerProgram}
          />
        </ConfigCard>

        <ConfigCard
          {...cardProps}
          description="The features on /register-hostel: a section's first line is its sentence, the rest are bullets."
          title="Register Hostel"
        >
          <PageEditor
            onChange={(next) => setPage("registerHostel", next)}
            liveStats={livePlatformStats}
            page={content.registerHostel}
            showHighlights
          />
        </ConfigCard>

        <ConfigCard
          {...cardProps}
          description="The pitch on /service-providers; the provider count beside it is live."
          title="Service Providers"
        >
          <PageEditor
            onChange={(next) => setPage("serviceProviders", next)}
            page={content.serviceProviders}
            showHighlights
          />
        </ConfigCard>

        <ConfigCard
          {...cardProps}
          description="/contact and the app's Contact screen."
          title="Frequently Asked Questions"
        >
          <Repeater<{ answer: string; question: string }>
            addLabel="Add question"
            emptyLabel="No questions yet."
            items={content.faq}
            makeItem={() => ({ answer: "", question: "" })}
            max={20}
            onChange={(faq) => setValue("content", { ...content, faq })}
            renderRow={(item, patch) => (
              <div className="space-y-2">
                <TextField
                  label="Question"
                  onChange={(question) => patch({ question })}
                  value={item.question}
                />
                <TextAreaField
                  hint={PLACEHOLDER_HINT}
                  label="Answer"
                  onChange={(answer) => patch({ answer })}
                  rows={3}
                  value={item.answer}
                />
              </div>
            )}
          />
        </ConfigCard>
      </ConfigPage>
    );
  },
);
