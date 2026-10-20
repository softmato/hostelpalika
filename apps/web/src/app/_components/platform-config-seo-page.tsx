"use client";

import { memo } from "react";

import { CONTENT_ICON_SLUGS } from "@/lib/site-content";
import { DEFAULT_SEO, SEO_PAGE_ROUTES } from "@/modules/platform-config/seo.defaults";
import {
  SEO_PAGE_KEYS,
  type ContentSection,
  type SeoComparison,
  type SeoConfig,
  type SeoModulePage,
} from "@/modules/platform-config/site-config.validation";

import {
  ConfigCard,
  ConfigPage,
  parseListField,
  Repeater,
  TextAreaField,
  TextField,
  useSiteConfigDraft,
} from "./platform-config-shared";

/**
 * Platform → Website Config → **SEO**.
 *
 * Everything a search result shows about the platform: each page's title and
 * description, the verification tags Search Console and Bing ask for, the
 * spellings of the brand, and the pages written to be found — the hostel
 * management software page, one page per feature module, and the comparisons.
 *
 * Titles and descriptions left blank publish the shipped text shown as the
 * placeholder, so an empty box can never become an empty `<title>`.
 */

type Faq = SeoConfig["software"]["faq"][number];
type Step = SeoConfig["software"]["steps"][number];

const FILL_HINT = "{siteName} and {fromPrice} are filled in on the page.";
const ICON_HINT = `Icon name, e.g. ${CONTENT_ICON_SLUGS.slice(0, 5).join(", ")}.`;

function lines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function lengthHint(value: string, fallback: string, ideal: number) {
  const length = (value || fallback).length;
  return `${length}/${ideal} characters${value ? "" : " (shipped text)"}${length > ideal ? " — Google may cut the end" : ""}`;
}

function FaqEditor({ items, onChange }: { items: Faq[]; onChange: (next: Faq[]) => void }) {
  return (
    <Repeater<Faq>
      addLabel="Add question"
      emptyLabel="No questions yet."
      items={items}
      makeItem={() => ({ answer: "", question: "" })}
      max={24}
      onChange={onChange}
      renderRow={(item, patch) => (
        <div className="space-y-2">
          <TextField
            label="Question"
            onChange={(question) => patch({ question })}
            value={item.question}
          />
          <TextAreaField
            label="Answer"
            onChange={(answer) => patch({ answer })}
            rows={3}
            value={item.answer}
          />
        </div>
      )}
    />
  );
}

export const PlatformConfigSeoPageContent = memo(function PlatformConfigSeoPageContent() {
  const { error, isDirty, message, reset, save, savingSection, setValue, state, valueFor } =
    useSiteConfigDraft();

  const seo = valueFor("seo");
  const moduleIds = valueFor("plans").modules.map((module) => module.id);
  const update = (patch: Partial<SeoConfig>) => setValue("seo", { ...seo, ...patch });
  const card = {
    dirty: isDirty("seo"),
    onReset: () => reset("seo"),
    onSave: () => save("seo"),
    saving: savingSection === "seo",
  };

  return (
    <ConfigPage
      breadcrumb={["Home", "Website Config", "SEO"]}
      description="What search engines show, and the pages written for people searching for us."
      error={error}
      message={message}
      state={state}
      title="SEO"
    >
      <ConfigCard
        {...card}
        description="Verification tags and the words the site is written around."
        title="Search Engines"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            hint="Search Console → HTML tag → only the content value."
            label="Google verification code"
            onChange={(google) => update({ verification: { ...seo.verification, google } })}
            value={seo.verification.google}
          />
          <TextField
            hint="Bing Webmaster Tools → meta tag msvalidate.01 → only the content value."
            label="Bing verification code"
            onChange={(bing) => update({ verification: { ...seo.verification, bing } })}
            value={seo.verification.bing}
          />
        </div>
        <TextAreaField
          hint="One per line. Declared to Google as other names for the site, so each of them leads to it."
          label="Other spellings of the brand"
          onChange={(value) => update({ alternateNames: lines(value) })}
          rows={4}
          value={seo.alternateNames.join("\n")}
        />
        <TextAreaField
          hint="Comma or line separated. Printed as meta keywords; the page titles below matter far more."
          label="Keywords"
          onChange={(value) => update({ keywords: parseListField(value) })}
          rows={4}
          value={seo.keywords.join(", ")}
        />
      </ConfigCard>

      <ConfigCard
        {...card}
        description={`Title and description in search results; blank uses the shipped text. ${FILL_HINT}`}
        title="Page Titles & Descriptions"
      >
        <div className="space-y-3">
          {SEO_PAGE_KEYS.map((key) => {
            const page = seo.pages[key];
            const shipped = DEFAULT_SEO.pages[key];
            const setPage = (patch: Partial<typeof page>) =>
              update({ pages: { ...seo.pages, [key]: { ...page, ...patch } } });

            return (
              <div
                className="space-y-2 rounded-lg border border-border/70 bg-muted/15 p-2.5"
                key={key}
              >
                <p className="text-[12px] font-bold text-foreground">
                  {SEO_PAGE_ROUTES[key].label}{" "}
                  <span className="font-medium text-muted-foreground">
                    {SEO_PAGE_ROUTES[key].path}
                  </span>
                </p>
                <TextField
                  hint={lengthHint(page.title, shipped.title, 60)}
                  label="Title"
                  onChange={(title) => setPage({ title })}
                  placeholder={shipped.title}
                  value={page.title}
                />
                <TextAreaField
                  hint={lengthHint(page.description, shipped.description, 160)}
                  label="Description"
                  onChange={(description) => setPage({ description })}
                  placeholder={shipped.description}
                  rows={2}
                  value={page.description}
                />
              </div>
            );
          })}
        </div>
      </ConfigCard>

      <ConfigCard
        {...card}
        description={`/hostel-management-software, for owners searching for hostel software. ${FILL_HINT}`}
        title="Hostel Management Software Page"
      >
        <TextField
          label="Headline"
          onChange={(headline) => update({ software: { ...seo.software, headline } })}
          value={seo.software.headline}
        />
        <TextAreaField
          label="Subtitle"
          onChange={(subtitle) => update({ software: { ...seo.software, subtitle } })}
          rows={2}
          value={seo.software.subtitle}
        />
        <TextAreaField
          hint="One paragraph per line."
          label="Intro"
          onChange={(value) => update({ software: { ...seo.software, intro: lines(value) } })}
          rows={4}
          value={seo.software.intro.join("\n")}
        />
        <div>
          <p className="mb-1 text-[11.5px] font-semibold text-foreground">Sections</p>
          <Repeater<ContentSection>
            addLabel="Add section"
            items={seo.software.sections}
            makeItem={() => ({ body: [], icon: "sparkles", title: "" })}
            max={12}
            onChange={(sections) => update({ software: { ...seo.software, sections } })}
            renderRow={(item, patch) => (
              <div className="space-y-2">
                <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
                  <TextField
                    label="Heading"
                    onChange={(title) => patch({ title })}
                    value={item.title}
                  />
                  <TextField
                    hint={ICON_HINT}
                    label="Icon"
                    onChange={(icon) => patch({ icon })}
                    value={item.icon}
                  />
                </div>
                <TextAreaField
                  hint="One paragraph per line."
                  label="Body"
                  onChange={(value) => patch({ body: lines(value) })}
                  rows={3}
                  value={item.body.join("\n")}
                />
              </div>
            )}
          />
        </div>
        <div>
          <p className="mb-1 text-[11.5px] font-semibold text-foreground">How it works</p>
          <Repeater<Step>
            addLabel="Add step"
            items={seo.software.steps}
            makeItem={() => ({ body: "", title: "" })}
            max={8}
            onChange={(steps) => update({ software: { ...seo.software, steps } })}
            renderRow={(item, patch) => (
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                <TextField label="Step" onChange={(title) => patch({ title })} value={item.title} />
                <TextAreaField
                  label="What happens"
                  onChange={(body) => patch({ body })}
                  rows={2}
                  value={item.body}
                />
              </div>
            )}
          />
        </div>
        <div>
          <p className="mb-1 text-[11.5px] font-semibold text-foreground">Questions owners ask</p>
          <FaqEditor
            items={seo.software.faq}
            onChange={(faq) => update({ software: { ...seo.software, faq } })}
          />
        </div>
      </ConfigCard>

      <ConfigCard
        {...card}
        description={`/features/[slug], one page per plan module. Module ids: ${moduleIds.join(", ")}.`}
        title="Feature Pages"
      >
        <Repeater<SeoModulePage>
          addLabel="Add feature page"
          items={seo.modulePages}
          makeItem={() => ({
            description: "",
            headline: "",
            intro: [],
            moduleId: moduleIds[0] ?? "",
            slug: "",
          })}
          max={24}
          onChange={(modulePages) => update({ modulePages })}
          renderRow={(item, patch) => (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <TextField
                  label="Headline"
                  onChange={(headline) => patch({ headline })}
                  value={item.headline}
                />
                <TextField
                  hint={moduleIds.includes(item.moduleId) ? undefined : "No module has this id."}
                  label="Module id"
                  onChange={(moduleId) => patch({ moduleId })}
                  value={item.moduleId}
                />
                <TextField
                  hint="lowercase-with-dashes"
                  label="URL slug"
                  onChange={(slug) => patch({ slug })}
                  value={item.slug}
                />
              </div>
              <TextAreaField
                hint={lengthHint(item.description, "", 160)}
                label="Description"
                onChange={(description) => patch({ description })}
                rows={2}
                value={item.description}
              />
              <TextAreaField
                hint="One paragraph per line."
                label="Intro"
                onChange={(value) => patch({ intro: lines(value) })}
                rows={3}
                value={item.intro.join("\n")}
              />
            </div>
          )}
        />
      </ConfigCard>

      <ConfigCard
        {...card}
        description={`/vs/[slug], comparisons with how hostels run today. ${FILL_HINT}`}
        title="Comparison Pages"
      >
        <Repeater<SeoComparison>
          addLabel="Add comparison"
          items={seo.comparisons}
          makeItem={() => ({
            description: "",
            faq: [],
            intro: [],
            name: "",
            rows: [],
            slug: "",
            stayWith: [],
            title: "",
          })}
          max={12}
          onChange={(comparisons) => update({ comparisons })}
          renderRow={(item, patch) => (
            <div className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <TextField
                  hint="What we are compared with, e.g. Excel & Google Sheets"
                  label="Compared with"
                  onChange={(name) => patch({ name })}
                  value={item.name}
                />
                <TextField label="Title" onChange={(title) => patch({ title })} value={item.title} />
                <TextField
                  hint="lowercase-with-dashes"
                  label="URL slug"
                  onChange={(slug) => patch({ slug })}
                  value={item.slug}
                />
              </div>
              <TextAreaField
                label="Description"
                onChange={(description) => patch({ description })}
                rows={2}
                value={item.description}
              />
              <TextAreaField
                hint="One paragraph per line."
                label="Intro"
                onChange={(value) => patch({ intro: lines(value) })}
                rows={3}
                value={item.intro.join("\n")}
              />
              <div>
                <p className="mb-1 text-[11.5px] font-semibold text-foreground">Rows</p>
                <Repeater<SeoComparison["rows"][number]>
                  addLabel="Add row"
                  items={item.rows}
                  makeItem={() => ({ label: "", them: "", us: "" })}
                  max={20}
                  onChange={(rows) => patch({ rows })}
                  renderRow={(row, patchRow) => (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <TextField
                        label="Job"
                        onChange={(label) => patchRow({ label })}
                        value={row.label}
                      />
                      <TextAreaField
                        label="The other way"
                        onChange={(them) => patchRow({ them })}
                        rows={2}
                        value={row.them}
                      />
                      <TextAreaField
                        label="On the platform"
                        onChange={(us) => patchRow({ us })}
                        rows={2}
                        value={row.us}
                      />
                    </div>
                  )}
                />
              </div>
              <TextAreaField
                hint="One per line — when the other way is honestly the better choice."
                label="Stay with it if"
                onChange={(value) => patch({ stayWith: lines(value) })}
                rows={3}
                value={item.stayWith.join("\n")}
              />
              <div>
                <p className="mb-1 text-[11.5px] font-semibold text-foreground">Questions</p>
                <FaqEditor items={item.faq} onChange={(faq) => patch({ faq })} />
              </div>
            </div>
          )}
        />
      </ConfigCard>
    </ConfigPage>
  );
});
