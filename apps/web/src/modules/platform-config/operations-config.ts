import { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { PlatformSettingModel } from "@hostel/db/models/PlatformSetting";

/**
 * Runtime-configurable operational knobs (ARCHITECTURE.md §5). Stored as a
 * single `PlatformSetting` document keyed `operations`, separate from the
 * public site-config sections so a website edit can never change how the
 * activation/payment machinery behaves.
 */
export const OPERATIONS_CONFIG_KEY = "operations";

export const operationsConfigSchema = z.object({
  /**
   * Ceilings a hostel admin may not exceed in their own settings. Kept here so
   * the platform decides the outer bounds and each hostel tunes within them
   * (ARCHITECTURE.md §5, PlatformConfig → HostelSettings).
   */
  maxAttendanceRetentionDays: z.number().int().min(30).max(1095).default(600),
  maxInsideZoneRadiusMeters: z.number().int().min(10).max(500).default(100),
  maxNearbyZoneRadiusMeters: z.number().int().min(20).max(2000).default(500),
  /**
   * Minimum gap between two "food ready" announcements for the same meal.
   * Cook credentials are shared kitchen-wide, so this is the blast-radius limit
   * on the one action a leaked cook login can actually abuse: spamming every
   * resident's notifications.
   */
  foodReadyCooldownMinutes: z.number().int().min(0).max(1440).default(120),
  /** Response window a complaint is measured against (PHASES.md §4.1). */
  complaintSlaHours: z.number().int().min(1).max(720).default(72),
  /**
   * How far ahead the **first** rent reminder goes out.
   *
   * A week, because that is how far ahead somebody can actually act on it — the
   * money has to be moved, and a resident paid monthly may need the notice
   * before their own pay lands. It is only the first of three: the ladder in
   * `dunning.service` fixes the other two at three days out and the due day
   * itself, so lowering this shortens the run-up rather than removing notices.
   */
  paymentReminderDaysBefore: z.number().int().min(0).max(30).default(7),
  /**
   * How long a hostel has to clear a plan shortfall before the due bites.
   *
   * Only a team-filed registration can owe anything: the agent publishes the
   * hostel on the strength of having met the owner, and whatever was not
   * collected that day becomes a due with this many days on it. A public
   * registration never reaches the state, because it does not publish until it
   * has paid.
   *
   * Configurable rather than fixed because it is a commercial term, not a
   * technical one — the number a field team can promise an owner is the
   * platform's call, and it will change without any code needing to.
   *
   * Three days by default: registered on 25 Bhadra, due on 28 Bhadra. It is
   * the trial — the hostel is live and fully usable for these days before the
   * balance falls due — and it is also the window on a public owner's invoice
   * after they press Pay now. One number for both, because an owner who asks
   * "how long do I have" should get one answer.
   */
  subscriptionDueGraceDays: z.number().int().min(1).max(180).default(3),
  /**
   * The QR a field agent shows an owner who wants to pay by wallet.
   *
   * It is one image for the whole platform — our own merchant QR — rather than
   * something generated per invoice, because there is no gateway session behind
   * it yet: the owner scans, pays whatever was agreed, and the agent types in
   * what arrived. So this is a picture and a caption, not a payload.
   *
   * Lives in operations rather than in the site config sections because it is
   * how money is taken, not what the website says. A website edit must never be
   * able to change the account money lands in — which is exactly the split this
   * file's header describes.
   *
   * `collectionQrLabel` is what the agent reads out while the owner scans
   * ("HostelDays Pvt. Ltd. — Fonepay"), so the owner can check the name on
   * their own screen before they confirm. That check is the only thing standing
   * between this and a swapped QR, so it is worth a field of its own.
   */
  collectionQrUrl: z.string().trim().max(500).default(""),
  collectionQrLabel: z.string().trim().max(120).default(""),
  /**
   * What a field agent earns on a hostel they registered, as a percent of its
   * setup fee — credited to their wallet the moment that fee clears. Hostels
   * filed before the setup fee earn it on their first plan payment instead.
   * Each credit copies the rate it used, so changing this only affects
   * payments that clear after the change.
   */
  teamCommissionPercent: z.number().min(0).max(100).default(40),
  /**
   * The setup fee a field agent collects at registration, in rupees. It is
   * both the default on the form and the ceiling: an agent may take less,
   * never more. The plan itself is not collected at registration — it starts
   * on its free months.
   */
  teamSetupFee: z.number().int().min(0).max(100_000).default(500),
  sendComplaintEmails: z.boolean().default(true),
  qrActivationExpiryDays: z.number().int().min(1).max(60).default(7),
  receiptNumberPrefix: z.string().trim().min(1).max(10).default("RCP"),
  sendNoticeEmails: z.boolean().default(true),
  sendPaymentEmails: z.boolean().default(true),
});

export type OperationsConfig = z.infer<typeof operationsConfigSchema>;

export const DEFAULT_OPERATIONS_CONFIG: OperationsConfig = operationsConfigSchema.parse(
  {},
);

type PlatformSettingRecord = {
  key: string;
  value: unknown;
};

/**
 * Never throws: a malformed or missing document falls back to the shipped
 * defaults, because every caller is on a path (activation, payment reminders)
 * that must not fail over a configuration read.
 */
export async function getOperationsConfig(): Promise<OperationsConfig> {
  try {
    await connectToDatabase();

    const record = (await PlatformSettingModel.findOne({
      key: OPERATIONS_CONFIG_KEY,
    }).lean()) as PlatformSettingRecord | null;

    if (!record) {
      return DEFAULT_OPERATIONS_CONFIG;
    }

    const parsed = operationsConfigSchema.safeParse(record.value);

    return parsed.success ? parsed.data : DEFAULT_OPERATIONS_CONFIG;
  } catch {
    return DEFAULT_OPERATIONS_CONFIG;
  }
}

/**
 * Superadmin write path. Unlike the read above this **does** throw: a rejected
 * value has to reach the person editing it, not fall back silently to a default
 * that quietly discards what they typed.
 */
export async function saveOperationsConfig(input: unknown, actorId: string) {
  await connectToDatabase();

  const current = await getOperationsConfig();
  // Partial edits merge onto what is stored, so a form that posts one field
  // does not reset the other eight to their shipped defaults.
  const next = operationsConfigSchema.parse({
    ...current,
    ...(typeof input === "object" && input !== null ? input : {}),
  });

  await PlatformSettingModel.findOneAndUpdate(
    { key: OPERATIONS_CONFIG_KEY },
    { $set: { key: OPERATIONS_CONFIG_KEY, updatedBy: actorId, value: next } },
    { new: true, upsert: true },
  );

  return { config: next };
}
