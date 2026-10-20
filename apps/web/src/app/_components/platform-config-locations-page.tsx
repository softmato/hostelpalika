"use client";

import { memo } from "react";

import { ToggleSwitch } from "@/app/_components/portal-dashboard-ui";
import { FactChip } from "@/app/_components/platform-page-ui";
import {
  ConfigCard,
  ConfigPage,
  Repeater,
  TextAreaField,
  TextField,
  parseListField,
  useSiteConfigDraft,
} from "./platform-config-shared";

export const PlatformConfigLocationsPageContent = memo(
  function PlatformConfigLocationsPageContent() {
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

    const locations = valueFor("locations");

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Locations"]}
        description="Cities and areas for search, compare and registration; a disabled city leaves the site at once."
        error={error}
        message={message}
        state={state}
        title="Locations"
      >
        <ConfigCard
          description="Comma separated; they fill each city's area dropdown."
          dirty={isDirty("locations")}
          onReset={() => reset("locations")}
          onSave={() => save("locations")}
          saving={savingSection === "locations"}
          title="Cities & Areas"
        >
          {/* The cities search offers today, each with how many areas it has. */}
          <div className="flex flex-wrap gap-1.5">
            {locations
              .filter((location) => location.city)
              .map((location) => (
                <FactChip glyph="location" key={location.city} tone={location.enabled ? "brand" : "neutral"}>
                  {`${location.city} · ${location.areas.length} areas`}
                </FactChip>
              ))}
          </div>
          <Repeater
            addLabel="Add city"
            emptyLabel="No cities configured — public search filters will be empty."
            items={locations}
            makeItem={() => ({ areas: [], city: "", enabled: true })}
            max={40}
            onChange={(next) => setValue("locations", next)}
            renderRow={(location, patch) => (
              <div className="space-y-2.5">
                <div className="grid gap-2.5 sm:grid-cols-[1fr_200px]">
                  <TextField
                    label="City"
                    onChange={(city) => patch({ city })}
                    placeholder="Kathmandu"
                    value={location.city}
                  />
                  <ToggleSwitch
                    checked={location.enabled}
                    label="Show publicly"
                    onChange={(enabled) => patch({ enabled })}
                  />
                </div>
                <TextAreaField
                  hint="Comma separated, e.g. Baneshwor, Koteshwor, Kirtipur"
                  label="Areas"
                  onChange={(value) => patch({ areas: parseListField(value) })}
                  rows={2}
                  value={location.areas.join(", ")}
                />
              </div>
            )}
          />
        </ConfigCard>
      </ConfigPage>
    );
  },
);
