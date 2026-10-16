/**
 * What the platform is doing with a service provider's application, in words.
 *
 * ## Why this is one file and not five strings
 *
 * The same five states are reported in four places — the Profile tab of the
 * browsing shell, the "Become a service provider" landing screen, the wizard's
 * confirmation, and the provider's own card once they are in — and until this
 * file they were written out separately in each. They had already drifted:
 * the landing screen told applicants that jobs are "broadcast by hostels in your
 * trades and area", which is a marketplace this product deliberately does not
 * have (`lib/provider-api.ts` and PHASES.md §6.1 both say so), while the card
 * tab told an applicant with no record to "apply from the website" months after
 * `service-providers/apply` shipped.
 *
 * A status is a promise about what happens next. Four copies of a promise is
 * four chances to make a different one.
 *
 * ## Pure, and therefore tested
 *
 * No React and no API client, so Vitest can run it — the same reason
 * `provider-jobs.ts` sits beside `provider-api.ts` rather than inside it.
 */

import type { ProviderApplication } from "@/lib/provider-api";
import type { BadgeTone } from "@/lib/status";

/**
 * How long review takes, stated once.
 *
 * The number is a commitment the platform makes to a tradesperson who has just
 * handed over their documents and their face, and it is the single question
 * they have while waiting. It is written the same way here, in the approval
 * emails and on the website's registration funnel; if it changes, it changes in
 * all of them.
 */
export const PROVIDER_REVIEW_WINDOW = "1–2 business days";

export type ProviderApplicationStatus = ProviderApplication["status"];

export type ProviderStatusPanel = {
  /**
   * Offer the application form.
   *
   * True only with no record at all or a rejected one — `registerPublicServiceProvider`
   * answers 409 for anything else, so a button that is offered and refused is
   * worse than no button.
   */
  canApply: boolean;
  body: string;
  /** Glyph for the panel's leading tile. */
  icon: string;
  /** True once there is work to go and look at. */
  showJobs: boolean;
  title: string;
  tone: BadgeTone;
};

const PANELS: Record<ProviderApplicationStatus, ProviderStatusPanel> = {
  APPROVED: {
    canApply: false,
    body: "You're listed as a verified provider. Work a hostel assigns you by name arrives in this app, and you'll be notified when it does.",
    icon: "checkmark-circle",
    showJobs: true,
    title: "You're an approved provider",
    tone: "success",
  },
  HIDDEN: {
    canApply: false,
    body: "The platform has hidden your listing, so hostels cannot find you or send you new work. Contact support if that is unexpected.",
    icon: "eye-off",
    showJobs: false,
    title: "Your listing is hidden",
    tone: "neutral",
  },
  INACTIVE: {
    canApply: false,
    body: "Your listing is marked inactive, so no new work will be assigned to you. Contact support to bring it back.",
    icon: "pause-circle",
    showJobs: false,
    title: "Your listing is inactive",
    tone: "neutral",
  },
  PENDING_APPROVAL: {
    canApply: false,
    /*
     * Three facts, and the order is the order they are wanted in: what is
     * happening, how long it takes, and how they will hear. "Documents" is named
     * explicitly because that is what the applicant spent the wizard doing —
     * a photo of themselves and their trade papers — and a review that does not
     * mention them reads as a queue rather than as a check.
     */
    body: `We're verifying your details and documents. It usually takes ${PROVIDER_REVIEW_WINDOW}, and we'll email you either way — no jobs can be assigned to you until it's done.`,
    icon: "time",
    showJobs: false,
    title: "Your application is under review",
    tone: "warning",
  },
  REJECTED: {
    canApply: true,
    body: "Your application wasn't approved. You can correct the details and send it again.",
    icon: "close-circle",
    showJobs: false,
    title: "Not approved",
    tone: "danger",
  },
};

/** No application at all — the ordinary state of nearly every account. */
const UNAPPLIED: ProviderStatusPanel = {
  canApply: true,
  body: "Five short steps, right here in the app — your trades, where you work, and a photo of yourself for your provider ID card.",
  icon: "construct",
  showJobs: false,
  title: "Apply to join",
  tone: "neutral",
};

/**
 * The panel for a record, or for the absence of one.
 *
 * `null` is the normal answer from `getOwnProvider`, not an error: most accounts
 * have never applied. A rejected record keeps its reason in the body, because
 * "not approved" without the why is the state people write to support about.
 */
export function providerStatusPanel(
  application: ProviderApplication | null,
): ProviderStatusPanel {
  return providerStatusPanelFor(
    application?.status ?? null,
    application?.rejectionReason,
  );
}

/**
 * The panel for a bare status.
 *
 * For the one caller that has a status without a record: the "Become a service
 * provider" landing screen knows from `/auth/me` that the account is an approved
 * provider even on the launch where the record lookup has not answered yet, and
 * offering that person the form because the fetch is a beat behind is how they
 * end up sending a second application the server refuses.
 */
export function providerStatusPanelFor(
  status: ProviderApplicationStatus | null,
  rejectionReason?: string,
): ProviderStatusPanel {
  if (!status) {
    return UNAPPLIED;
  }

  const panel = PANELS[status] ?? UNAPPLIED;

  if (status === "REJECTED" && rejectionReason) {
    return {
      ...panel,
      body: `Your application wasn't approved: ${rejectionReason} Correct it and send it again.`,
    };
  }

  return panel;
}

/**
 * Does this account have an application worth reporting on a screen that is
 * about something else?
 *
 * The Profile tab of the browsing shell shows a banner for exactly these: a
 * record that is *in motion*. An approved provider never sees that screen — they
 * are routed to their own tabs — and an account that never applied has nothing
 * to be told.
 */
export function isApplicationInFlight(application: ProviderApplication | null): boolean {
  return Boolean(application) && application?.status !== "APPROVED";
}
