"use client";

import { memo } from "react";

import { FilterSelect, ToggleSwitch } from "@/app/_components/portal-dashboard-ui";
import {
  ConfigCard,
  ConfigPage,
  TextAreaField,
  TextField,
  useSiteConfigDraft,
} from "./platform-config-shared";

export const PlatformConfigAnnouncementsPageContent = memo(
  function PlatformConfigAnnouncementsPageContent() {
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

    const announcement = valueFor("announcement");
    const social = valueFor("social");

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Announcements"]}
        description="The site-wide banner and the footer's social links."
        error={error}
        message={message}
        state={state}
        title="Announcements"
      >
        <div className="space-y-4">
          <ConfigCard
            description="For maintenance windows, launches or seasonal notices."
            dirty={isDirty("announcement")}
            onReset={() => reset("announcement")}
            onSave={() => save("announcement")}
            saving={savingSection === "announcement"}
            title="Announcement Banner"
          >
            <ToggleSwitch
              checked={announcement.enabled}
              description="Off removes the banner from every public page."
              label="Show the banner"
              onChange={(enabled) =>
                setValue("announcement", { ...announcement, enabled })
              }
            />

            <TextAreaField
              label="Message"
              onChange={(bannerMessage) =>
                setValue("announcement", { ...announcement, message: bannerMessage })
              }
              placeholder="New hostels added in Pokhara this week."
              rows={2}
              value={announcement.message}
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <TextField
                label="Link label"
                onChange={(linkLabel) =>
                  setValue("announcement", { ...announcement, linkLabel })
                }
                placeholder="Browse now"
                value={announcement.linkLabel}
              />
              <TextField
                label="Link URL"
                onChange={(link) => setValue("announcement", { ...announcement, link })}
                placeholder="/hostels"
                value={announcement.link}
              />
              <FilterSelect
                defaultLabel="Info"
                label="Tone"
                onChange={(tone) =>
                  setValue("announcement", {
                    ...announcement,
                    tone: (tone || "info") as typeof announcement.tone,
                  })
                }
                options={[
                  { label: "Info", value: "info" },
                  { label: "Success", value: "success" },
                  { label: "Warning", value: "warning" },
                ]}
                value={announcement.tone}
              />
            </div>
          </ConfigCard>

          <ConfigCard
            description="An empty field hides that icon in the footer."
            dirty={isDirty("social")}
            onReset={() => reset("social")}
            onSave={() => save("social")}
            saving={savingSection === "social"}
            title="Social Profiles"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Facebook"
                onChange={(facebook) => setValue("social", { ...social, facebook })}
                placeholder="https://facebook.com/..."
                value={social.facebook}
              />
              <TextField
                label="Instagram"
                onChange={(instagram) => setValue("social", { ...social, instagram })}
                placeholder="https://instagram.com/..."
                value={social.instagram}
              />
              <TextField
                label="YouTube"
                onChange={(youtube) => setValue("social", { ...social, youtube })}
                placeholder="https://youtube.com/..."
                value={social.youtube}
              />
              <TextField
                label="TikTok"
                onChange={(tiktok) => setValue("social", { ...social, tiktok })}
                placeholder="https://tiktok.com/@..."
                value={social.tiktok}
              />
              <TextField
                label="LinkedIn"
                onChange={(linkedin) => setValue("social", { ...social, linkedin })}
                placeholder="https://linkedin.com/company/..."
                value={social.linkedin}
              />
              <TextField
                label="Website"
                onChange={(website) => setValue("social", { ...social, website })}
                placeholder="https://..."
                value={social.website}
              />
            </div>
          </ConfigCard>
        </div>
      </ConfigPage>
    );
  },
);
