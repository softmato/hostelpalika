"use client";

import { memo } from "react";

import {
  ConfigCard,
  ConfigPage,
  TextAreaField,
  TextField,
  useSiteConfigDraft,
} from "./platform-config-shared";

export const PlatformConfigLegalPageContent = memo(
  function PlatformConfigLegalPageContent() {
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

    const legal = valueFor("legal");

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Legal Pages"]}
        description="Text for /terms and /privacy; an empty body keeps the built-in copy."
        error={error}
        message={message}
        state={state}
        title="Legal Pages"
      >
        <ConfigCard
          description="Blank lines split paragraphs; lines starting with # are headings."
          dirty={isDirty("legal")}
          onReset={() => reset("legal")}
          onSave={() => save("legal")}
          saving={savingSection === "legal"}
          title="Policy Content"
        >
          <div className="space-y-4">
            <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/15 p-2.5">
              <p className="text-[12px] font-bold text-foreground">Terms of Service</p>
              <TextField
                label="Last updated"
                onChange={(updatedAt) =>
                  setValue("legal", { ...legal, terms: { ...legal.terms, updatedAt } })
                }
                placeholder="22 July 2026"
                value={legal.terms.updatedAt}
              />
              <TextAreaField
                label="Body"
                onChange={(body) =>
                  setValue("legal", { ...legal, terms: { ...legal.terms, body } })
                }
                rows={10}
                value={legal.terms.body}
              />
            </div>

            <div className="space-y-2.5 rounded-lg border border-border/70 bg-muted/15 p-2.5">
              <p className="text-[12px] font-bold text-foreground">Privacy Policy</p>
              <TextField
                label="Last updated"
                onChange={(updatedAt) =>
                  setValue("legal", {
                    ...legal,
                    privacy: { ...legal.privacy, updatedAt },
                  })
                }
                placeholder="22 July 2026"
                value={legal.privacy.updatedAt}
              />
              <TextAreaField
                label="Body"
                onChange={(body) =>
                  setValue("legal", { ...legal, privacy: { ...legal.privacy, body } })
                }
                rows={10}
                value={legal.privacy.body}
              />
            </div>
          </div>
        </ConfigCard>
      </ConfigPage>
    );
  },
);
