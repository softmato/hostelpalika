"use client";

import { Loader2, Upload } from "lucide-react";
import { memo, useState } from "react";

import { ToggleSwitch } from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { sendWithProgress } from "@/lib/uploads/transport";

import {
  ConfigCard,
  ConfigPage,
  Repeater,
  TextAreaField,
  TextField,
  useSiteConfigDraft,
} from "./platform-config-shared";

/**
 * Uploads an APK or the demo video straight to R2 and hands back its public
 * URL. The row is only live once the section is saved, so a half-finished
 * upload changes nothing.
 */
function PublicFileUploadButton({
  accept,
  label,
  onError,
  onUploaded,
}: {
  accept: string;
  label: string;
  onError: (message: string) => void;
  onUploaded: (url: string) => void;
}) {
  const [percent, setPercent] = useState<number | null>(null);

  async function upload(file: File) {
    onError("");
    setPercent(0);

    try {
      const target = await browserApi<{ contentType: string; uploadUrl: string; url: string }>(
        "/api/v1/platform/app-apk",
        { body: JSON.stringify({ fileName: file.name, size: file.size }), method: "POST" },
      );
      const result = await sendWithProgress({
        body: file,
        headers: { "Content-Type": target.contentType },
        method: "PUT",
        onProgress: (progress) => setPercent(progress.percent),
        url: target.uploadUrl,
      });

      if (result.status >= 300) throw new Error(`Upload failed (${result.status}).`);

      onUploaded(target.url);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setPercent(null);
    }
  }

  return (
    <label className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition hover:border-role-platform">
        {percent === null ? <Upload className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
        {percent === null ? label : `Uploading ${percent}%`}
        <input
          accept={accept}
          className="sr-only"
          disabled={percent !== null}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];

            if (file) void upload(file);

            event.currentTarget.value = "";
          }}
          type="file"
        />
    </label>
  );
}

export const PlatformConfigSitePageContent = memo(
  function PlatformConfigSitePageContent() {
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

    const identity = valueFor("identity");
    const email = valueFor("email");
    const hero = valueFor("hero");
    const stats = valueFor("stats");
    const trustPoints = valueFor("trustPoints");
    const apps = valueFor("apps");
    const questionCall = valueFor("questionCall");
    const [apkError, setApkError] = useState("");
    const [videoError, setVideoError] = useState("");

    return (
      <ConfigPage
        breadcrumb={["Home", "Website Config", "Site Content"]}
        description="Brand details, homepage hero copy, headline numbers, and trust points shown to every public visitor."
        error={error}
        message={message}
        state={state}
        title="Site Content"
      >
        <div className="space-y-4">
          <ConfigCard
            description="Used in the header, footer, page titles, and support links."
            dirty={isDirty("identity")}
            onReset={() => reset("identity")}
            onSave={() => save("identity")}
            saving={savingSection === "identity"}
            title="Site Identity"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                hint="Set in code (packages/shared/src/brand/brand.ts)."
                label="Site name"
                onChange={() => undefined}
                readOnly
                value={identity.siteName}
              />
              <TextField
                label="Tagline"
                onChange={(tagline) => setValue("identity", { ...identity, tagline })}
                value={identity.tagline}
              />
              <TextField
                hint="Shown in the public footer and inquiry confirmations."
                label="Support email"
                onChange={(supportEmail) =>
                  setValue("identity", { ...identity, supportEmail })
                }
                value={identity.supportEmail}
              />
              <TextField
                label="Support phone"
                onChange={(supportPhone) =>
                  setValue("identity", { ...identity, supportPhone })
                }
                value={identity.supportPhone}
              />
              <TextField
                label="Address"
                onChange={(address) => setValue("identity", { ...identity, address })}
                value={identity.address}
              />
            </div>
          </ConfigCard>

          <ConfigCard
            description="Who transactional email comes from. Every field can be left blank — blank uses the sensible fallback shown in its hint, so this section only needs touching to override something."
            dirty={isDirty("email")}
            onReset={() => reset("email")}
            onSave={() => save("email")}
            saving={savingSection === "email"}
            title="Email Sending"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                hint={`Shown as the sender name. Blank uses the site name (${identity.siteName || "—"}).`}
                label="Sender name"
                onChange={(senderName) => setValue("email", { ...email, senderName })}
                placeholder={identity.siteName}
                value={email.senderName}
              />
              <TextField
                hint="Where replies go. Must be a mailbox that actually RECEIVES — a wrong address here does not fail on send, it bounces days later in someone else's inbox. Blank uses the general mailbox on the sending domain, which is the safe answer."
                label="Reply-to address"
                onChange={(replyTo) => setValue("email", { ...email, replyTo })}
                placeholder={`${email.infoMailbox || "info"}@${email.domain || "softmato.com"}`}
                value={email.replyTo}
              />
            </div>

            <TextField
              hint="Must be a domain VERIFIED IN RESEND — an unverified one bounces every email, it does not degrade. Blank uses the domain set on the server, which is the right answer unless you run your own."
              label="Sending domain"
              onChange={(domain) => setValue("email", { ...email, domain })}
              placeholder="softmato.com"
              value={email.domain}
            />

            <p className="text-xs text-slate-500">
              Mail is sent from a different mailbox depending on what it is, so a
              receipt and an emergency alert never arrive looking alike. Verifying
              the domain covers every mailbox on it for <em>sending</em> — but a
              reply only reaches a person if that address also exists as a
              forwarding alias. Replies are pointed at the general mailbox for
              that reason; no-reply mail carries no reply address at all.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                hint="Notices, approvals, invitations. Default: info"
                label="General mailbox"
                onChange={(infoMailbox) => setValue("email", { ...email, infoMailbox })}
                placeholder="info"
                value={email.infoMailbox}
              />
              <TextField
                hint="SOS, overdue fees, gateway outages. Default: alert"
                label="Alert mailbox"
                onChange={(alertMailbox) => setValue("email", { ...email, alertMailbox })}
                placeholder="alert"
                value={email.alertMailbox}
              />
              <TextField
                hint="Invoices, receipts, reminders. Default: billing"
                label="Billing mailbox"
                onChange={(billingMailbox) =>
                  setValue("email", { ...email, billingMailbox })
                }
                placeholder="billing"
                value={email.billingMailbox}
              />
              <TextField
                hint="OTPs, resets, credentials. Default: security"
                label="Security mailbox"
                onChange={(securityMailbox) =>
                  setValue("email", { ...email, securityMailbox })
                }
                placeholder="security"
                value={email.securityMailbox}
              />
              <TextField
                hint="Inquiries and complaint threads. Default: support"
                label="Support mailbox"
                onChange={(supportMailbox) =>
                  setValue("email", { ...email, supportMailbox })
                }
                placeholder="support"
                value={email.supportMailbox}
              />
              <TextField
                hint="Machine mail with no reply path. Default: noreply"
                label="No-reply mailbox"
                onChange={(noreplyMailbox) =>
                  setValue("email", { ...email, noreplyMailbox })
                }
                placeholder="noreply"
                value={email.noreplyMailbox}
              />
            </div>
          </ConfigCard>

          <ConfigCard
            description="The first thing visitors read on the homepage."
            dirty={isDirty("hero")}
            onReset={() => reset("hero")}
            onSave={() => save("hero")}
            saving={savingSection === "hero"}
            title="Homepage Hero"
          >
            <TextField
              label="Headline"
              onChange={(headline) => setValue("hero", { ...hero, headline })}
              value={hero.headline}
            />
            <TextAreaField
              label="Subheadline"
              onChange={(subheadline) => setValue("hero", { ...hero, subheadline })}
              rows={2}
              value={hero.subheadline}
            />
            <TextField
              label="Search placeholder"
              onChange={(searchPlaceholder) =>
                setValue("hero", { ...hero, searchPlaceholder })
              }
              value={hero.searchPlaceholder}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Primary button label"
                onChange={(primaryCtaLabel) =>
                  setValue("hero", { ...hero, primaryCtaLabel })
                }
                value={hero.primaryCtaLabel}
              />
              <TextField
                label="Primary button link"
                onChange={(primaryCtaHref) =>
                  setValue("hero", { ...hero, primaryCtaHref })
                }
                value={hero.primaryCtaHref}
              />
              <TextField
                label="Secondary button label"
                onChange={(secondaryCtaLabel) =>
                  setValue("hero", { ...hero, secondaryCtaLabel })
                }
                value={hero.secondaryCtaLabel}
              />
              <TextField
                label="Secondary button link"
                onChange={(secondaryCtaHref) =>
                  setValue("hero", { ...hero, secondaryCtaHref })
                }
                value={hero.secondaryCtaHref}
              />
            </div>
          </ConfigCard>

          <ConfigCard
            description="The counter strip under the hero. Values are shown exactly as typed."
            dirty={isDirty("stats")}
            onReset={() => reset("stats")}
            onSave={() => save("stats")}
            saving={savingSection === "stats"}
            title="Headline Stats"
          >
            <Repeater
              addLabel="Add stat"
              emptyLabel="No stats — the counter strip will be hidden."
              items={stats}
              makeItem={() => ({ label: "", suffix: "", value: "" })}
              max={8}
              onChange={(next) => setValue("stats", next)}
              renderRow={(stat, patch) => (
                <div className="grid gap-2.5 sm:grid-cols-3">
                  <TextField
                    label="Value"
                    onChange={(value) => patch({ value })}
                    placeholder="1,248"
                    value={stat.value}
                  />
                  <TextField
                    label="Suffix"
                    onChange={(suffix) => patch({ suffix })}
                    placeholder="+"
                    value={stat.suffix}
                  />
                  <TextField
                    label="Label"
                    onChange={(label) => patch({ label })}
                    placeholder="Verified hostels"
                    value={stat.label}
                  />
                </div>
              )}
            />
          </ConfigCard>

          <ConfigCard
            description="The “why trust us” cards on the homepage."
            dirty={isDirty("trustPoints")}
            onReset={() => reset("trustPoints")}
            onSave={() => save("trustPoints")}
            saving={savingSection === "trustPoints"}
            title="Trust Points"
          >
            <Repeater
              addLabel="Add trust point"
              items={trustPoints}
              makeItem={() => ({ description: "", icon: "shield", title: "" })}
              max={12}
              onChange={(next) => setValue("trustPoints", next)}
              renderRow={(point, patch) => (
                <div className="space-y-2.5">
                  <div className="grid gap-2.5 sm:grid-cols-[1fr_140px]">
                    <TextField
                      label="Title"
                      onChange={(title) => patch({ title })}
                      value={point.title}
                    />
                    <TextField
                      hint="shield · wallet · star · users"
                      label="Icon"
                      onChange={(icon) => patch({ icon })}
                      value={point.icon}
                    />
                  </div>
                  <TextAreaField
                    label="Description"
                    onChange={(description) => patch({ description })}
                    rows={2}
                    value={point.description}
                  />
                </div>
              )}
            />
          </ConfigCard>

          <ConfigCard
            description="Where the phone app comes from. Android visitors and the team's QR go to the Play listing; the APK is used only when the Play link is blank. iOS installs the website as an app until the iPhone app ships."
            dirty={isDirty("apps")}
            onReset={() => reset("apps")}
            onSave={() => save("apps")}
            saving={savingSection === "apps"}
            title="Mobile App"
          >
            <TextField
              label="Play Store link"
              onChange={(androidPlayUrl) => setValue("apps", { ...apps, androidPlayUrl })}
              value={apps.androidPlayUrl}
            />
            <div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <TextField
                    label="APK file"
                    onChange={(androidApkUrl) => setValue("apps", { ...apps, androidApkUrl })}
                    placeholder="Upload an APK, or paste its link"
                    value={apps.androidApkUrl}
                  />
                </div>
                <PublicFileUploadButton
                  accept=".apk,application/vnd.android.package-archive"
                  label="Upload APK"
                  onError={setApkError}
                  onUploaded={(androidApkUrl) => setValue("apps", { ...apps, androidApkUrl })}
                />
              </div>
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                Direct download, used by /get-app only when the Play Store link is blank. Save after
                uploading.
              </p>
              {apkError ? <p className="mt-1 text-xs text-destructive">{apkError}</p> : null}
            </div>
            <div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <TextField
                    label="Demo video"
                    onChange={(demoVideoUrl) => setValue("apps", { ...apps, demoVideoUrl })}
                    placeholder="Upload an MP4, or paste its link"
                    value={apps.demoVideoUrl}
                  />
                </div>
                <PublicFileUploadButton
                  accept="video/mp4,video/webm,.mp4,.webm"
                  label="Upload video"
                  onError={setVideoError}
                  onUploaded={(demoVideoUrl) => setValue("apps", { ...apps, demoVideoUrl })}
                />
              </div>
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                Plays from Watch Demo on Register Hostel. Use a web-compressed MP4 (fast start)
                — it streams as it plays. Save after uploading.
              </p>
              {videoError ? <p className="mt-1 text-xs text-destructive">{videoError}</p> : null}
            </div>
          </ConfigCard>

          <ConfigCard
            description="A row on the home of every student resident, on the website and in the app. It opens QuestionCall's installed app, or its install page."
            dirty={isDirty("questionCall")}
            onReset={() => reset("questionCall")}
            onSave={() => save("questionCall")}
            saving={savingSection === "questionCall"}
            title="QuestionCall"
          >
            <ToggleSwitch
              checked={questionCall.enabled}
              description="When off, the row is removed for every resident."
              label="Show the row"
              onChange={(enabled) => setValue("questionCall", { ...questionCall, enabled })}
            />
            <TextField
              label="Label"
              onChange={(label) => setValue("questionCall", { ...questionCall, label })}
              value={questionCall.label}
            />
            <TextField
              hint="Keep it under questioncall.com/app — links there open the installed app. ?install shows its install sheet."
              label="Link"
              onChange={(url) => setValue("questionCall", { ...questionCall, url })}
              value={questionCall.url}
            />
          </ConfigCard>
        </div>
      </ConfigPage>
    );
  },
);
