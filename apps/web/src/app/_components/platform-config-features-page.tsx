"use client";

import { memo } from "react";

import { ToggleSwitch } from "@/app/_components/portal-dashboard-ui";
import { ConfigCard, ConfigPage, useSiteConfigDraft } from "./platform-config-shared";

const FLAGS: Array<{
  description: string;
  key:
    | "compare"
    | "inquiries"
    | "publicRegistration"
    | "reviews"
    | "serviceProviderSignup";
  label: string;
}> = [
  {
    description:
      "Lets visitors send an inquiry from a hostel page. Turning this off hides every inquiry form.",
    key: "inquiries",
    label: "Public inquiries",
  },
  {
    description: "Shows the side-by-side hostel comparison tool and its entry points.",
    key: "compare",
    label: "Hostel comparison",
  },
  {
    description:
      "Allows hostel owners to submit a new listing from the public site. Existing listings are unaffected.",
    key: "publicRegistration",
    label: "Public hostel registration",
  },
  {
    description: "Opens the service provider application form to the public.",
    key: "serviceProviderSignup",
    label: "Service provider signup",
  },
  {
    description:
      "Displays resident ratings and reviews on public listings. Existing reviews are kept, just hidden.",
    key: "reviews",
    label: "Public reviews",
  },
];

export const PlatformConfigFeaturesPageContent = memo(
  function PlatformConfigFeaturesPageContent() {
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

    const features = valueFor("features");

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Feature Flags"]}
        description="Kill switches for public surfaces; changes reach the site within a minute."
        error={error}
        message={message}
        state={state}
        title="Feature Flags"
      >
        <ConfigCard
          dirty={isDirty("features")}
          onReset={() => reset("features")}
          onSave={() => save("features")}
          saving={savingSection === "features"}
          title="Public Surfaces"
        >
          <div className="divide-y divide-border/60">
            {FLAGS.map((flag) => (
              <ToggleSwitch
                checked={features[flag.key]}
                description={flag.description}
                key={flag.key}
                label={flag.label}
                onChange={(next) =>
                  setValue("features", { ...features, [flag.key]: next })
                }
              />
            ))}
          </div>
        </ConfigCard>
      </ConfigPage>
    );
  },
);
