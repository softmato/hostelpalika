import { createHmac, timingSafeEqual } from "node:crypto";

import { connectToDatabase } from "@/lib/db";
import { outboundUrl } from "@/lib/site";
import { EmailPreferenceModel } from "@hostel/db/models/EmailPreference";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

import { type EmailTopic, isEmailTopic } from "@/lib/notifications/email-topics";

/**
 * Per-address email opt-outs: the gate `sendNotificationEmail` asks, the signed
 * links every optional email carries, and the account view the app's Settings
 * screen edits. Topics and copy are in `email-topics.ts`.
 */

function normalize(email: string) {
  return email.trim().toLowerCase();
}

function sign(email: string) {
  const secret = process.env.JWT_ACCESS_SECRET ?? "development-email-preference-secret";

  return createHmac("sha256", secret).update(`email-preferences:${email}`).digest("base64url");
}

/**
 * The token in an email's unsubscribe link: the address and its signature.
 *
 * No expiry, deliberately — an unsubscribe link has to work from a year-old
 * email. It grants nothing beyond turning that address's optional mail on and off.
 */
export function emailPreferenceToken(email: string) {
  const address = normalize(email);

  return `${Buffer.from(address).toString("base64url")}.${sign(address)}`;
}

/** The address a token was signed for, or null for anything forged or mangled. */
export function emailFromPreferenceToken(token: string | null | undefined) {
  const [encoded, signature] = (token ?? "").split(".");

  if (!encoded || !signature) {
    return null;
  }

  const email = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = Buffer.from(sign(email));
  const given = Buffer.from(signature);

  return given.length === expected.length && timingSafeEqual(given, expected) ? email : null;
}

/** The footer link (a page) and the `List-Unsubscribe` one-click URL (a POST). */
export function emailPreferenceLinks(email: string, topic: EmailTopic) {
  const query = `token=${encodeURIComponent(emailPreferenceToken(email))}&topic=${topic}`;

  return {
    oneClickUrl: `${outboundUrl()}/api/v1/email-preferences/unsubscribe?${query}`,
    pageUrl: `${outboundUrl()}/email-preferences?${query}`,
  };
}

/**
 * Whether `email` turned `topic` off. A failed lookup answers "no" and the mail
 * goes: an unwanted email is recoverable, a rent reminder lost to a database
 * blip is not.
 */
export async function emailTopicMuted(email: string, topic: EmailTopic) {
  try {
    await connectToDatabase();

    return Boolean(
      await EmailPreferenceModel.exists({ email: normalize(email), mutedTopics: topic }),
    );
  } catch {
    return false;
  }
}

export async function getMutedTopics(email: string): Promise<EmailTopic[]> {
  await connectToDatabase();

  const row = await EmailPreferenceModel.findOne({ email: normalize(email) }).lean<{
    mutedTopics?: string[];
  } | null>();

  return (row?.mutedTopics ?? []).filter(isEmailTopic);
}

export async function setMutedTopics(emails: string[], mutedTopics: EmailTopic[]) {
  await connectToDatabase();

  const muted = [...new Set(mutedTopics)];

  await Promise.all(
    [...new Set(emails.map(normalize))].map((email) =>
      EmailPreferenceModel.updateOne(
        { email },
        { $set: { email, mutedTopics: muted } },
        { upsert: true },
      ),
    ),
  );

  return muted;
}

/**
 * The muted list after the preferences form is sent. **Pure.** Topics the form
 * showed follow its checkboxes; topics it did not show keep their state.
 */
export function mutedAfterForm(
  current: EmailTopic[],
  shown: EmailTopic[],
  receiving: EmailTopic[],
) {
  return [
    ...current.filter((topic) => !shown.includes(topic)),
    ...shown.filter((topic) => !receiving.includes(topic)),
  ];
}

/**
 * Every address this account is mailed at: its own, and the one on its resident
 * record, which `resolveResidentContact` prefers when both exist.
 */
async function accountAddresses(userId: string) {
  await connectToDatabase();

  const [user, residents] = await Promise.all([
    UserModel.findOne({ _id: userId, isDeleted: { $ne: true } })
      .select("email")
      .lean<{ email?: string } | null>(),
    ResidentModel.find({ isDeleted: false, userId })
      .select("email")
      .lean<{ email?: string }[]>(),
  ]);

  return [
    ...new Set(
      [user?.email, ...residents.map((resident) => resident.email)]
        .filter((email): email is string => Boolean(email))
        .map(normalize),
    ),
  ];
}

export async function getAccountEmailPreference(userId: string) {
  const addresses = await accountAddresses(userId);
  const rows = await EmailPreferenceModel.find({ email: { $in: addresses } }).lean<
    { mutedTopics?: string[] }[]
  >();

  return {
    hasEmail: addresses.length > 0,
    mutedTopics: [...new Set(rows.flatMap((row) => row.mutedTopics ?? []))].filter(isEmailTopic),
  };
}

export async function updateAccountEmailPreference(userId: string, mutedTopics: EmailTopic[]) {
  const addresses = await accountAddresses(userId);

  return {
    hasEmail: addresses.length > 0,
    mutedTopics: addresses.length > 0 ? await setMutedTopics(addresses, mutedTopics) : [],
  };
}
