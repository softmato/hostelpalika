import { CircleCheck, MailX, TriangleAlert } from "@/components/icons";
import type { Metadata } from "next";

import { PublicShell } from "@/app/_components/shared";
import {
  emailFromPreferenceToken,
  getMutedTopics,
} from "@/modules/notifications/email-preference.service";
import { EMAIL_TOPICS, emailTopic, isEmailTopic } from "@/modules/notifications/email-topics";
import { maskEmail } from "@/modules/platform-config/setting-change.service";

/**
 * `/email-preferences` — where every optional email's unsubscribe line leads.
 *
 * The signed token in the link is the only credential: most people arriving
 * here are reading mail on a phone, signed in to nothing. Plain HTML forms
 * posting to `/api/v1/email-preferences`, so it works with no JavaScript.
 *
 * Opening the page changes nothing — a link scanner that prefetches it must not
 * unsubscribe anyone. The one-click path is the `List-Unsubscribe` header.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Email preferences",
};

type PageProps = {
  searchParams: Promise<{ error?: string; saved?: string; token?: string; topic?: string }>;
};

const AUDIENCE_HEADING = {
  resident: "If you live in a hostel",
  staff: "If you run a hostel",
} as const;

export default async function EmailPreferencesPage({ searchParams }: PageProps) {
  const { error, saved, token = "", topic: topicParam } = await searchParams;
  const email = emailFromPreferenceToken(token);
  const topic = isEmailTopic(topicParam) ? topicParam : null;

  if (!email) {
    return (
      <PublicShell>
        <div className="mx-auto max-w-xl px-4 py-12 sm:py-20">
          <h1 className="font-heading text-2xl font-semibold text-foreground">
            Email preferences
          </h1>
          <div className="mt-6 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <p className="text-sm text-foreground">
              This link is not valid. Open the unsubscribe link from one of our emails again.
            </p>
          </div>
        </div>
      </PublicShell>
    );
  }

  const muted = await getMutedTopics(email);
  const audience = topic ? emailTopic(topic).audience : null;
  const groups = (["resident", "staff"] as const)
    .filter((group) => !audience || group === audience)
    .map((group) => ({
      group,
      topics: EMAIL_TOPICS.filter((entry) => entry.audience === group),
    }));
  const hidden = (
    <>
      <input name="token" type="hidden" value={token} />
      {topic ? <input name="topic" type="hidden" value={topic} /> : null}
    </>
  );

  return (
    <PublicShell>
      <div className="mx-auto max-w-xl px-4 py-12 sm:py-20">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Email preferences</h1>
        <p className="mt-2 text-sm text-muted-foreground">For {maskEmail(email)}</p>

        {saved ? (
          <div className="mt-6 flex gap-3 rounded-lg border border-success/40 bg-success/5 p-4">
            <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" />
            <p className="text-sm text-foreground">
              {topic && muted.includes(topic)
                ? `You won't get ${emailTopic(topic).label.toLowerCase()} emails any more.`
                : "Saved."}
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="mt-6 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
            <p className="text-sm text-foreground">That did not save. Please try again.</p>
          </div>
        ) : null}

        {topic && !muted.includes(topic) ? (
          <form
            action="/api/v1/email-preferences"
            className="mt-6 flex flex-col gap-4 rounded-lg border border-border p-4 sm:flex-row sm:items-center"
            method="post"
          >
            {hidden}
            <input name="mute" type="hidden" value={topic} />
            <MailX className="size-6 shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <p className="font-semibold text-foreground">
                Stop {emailTopic(topic).label.toLowerCase()} emails?
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {emailTopic(topic).description}.
              </p>
            </div>
            <button
              className="h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground"
              type="submit"
            >
              Unsubscribe
            </button>
          </form>
        ) : null}

        <form action="/api/v1/email-preferences" className="mt-8" method="post">
          {hidden}
          {groups.map(({ group, topics }) => (
            <fieldset className="mt-6 first:mt-0" key={group}>
              <legend className="text-sm font-semibold text-foreground">
                {audience ? "Emails you get" : AUDIENCE_HEADING[group]}
              </legend>
              <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                {topics.map((entry) => (
                  <label
                    className="flex cursor-pointer items-start gap-3 p-4"
                    key={entry.value}
                  >
                    <input name="shown" type="hidden" value={entry.value} />
                    <input
                      className="mt-0.5 size-4 shrink-0 accent-primary"
                      defaultChecked={!muted.includes(entry.value)}
                      name="receive"
                      type="checkbox"
                      value={entry.value}
                    />
                    <span>
                      <span className="block text-sm font-medium text-foreground">
                        {entry.label}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {entry.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}

          <button
            className="mt-6 h-11 rounded-md border border-border px-5 text-sm font-semibold text-foreground"
            type="submit"
          >
            Save
          </button>
        </form>

        <p className="mt-8 text-xs text-muted-foreground">
          Receipts, sign-in codes, plan billing, account and safety emails are always sent.
          Anything turned off here still shows in the app.
        </p>
      </div>
    </PublicShell>
  );
}
