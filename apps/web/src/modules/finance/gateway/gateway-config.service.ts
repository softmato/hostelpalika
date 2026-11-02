import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import {
  describeSecret,
  isGatewayPayable,
  isProduction,
  putSecret,
} from "@/modules/finance/gateway/secret-store";
import { EncryptedSecretModel } from "@hostel/db/models/EncryptedSecret";
import {
  findGateway,
  FONEPAY_PERSONAL_DAILY_LIMIT,
  type GatewayAccountKind,
  type GatewayConfig,
  type GatewayHealthStatus,
  type GatewayMode,
  type GatewayProviderName,
  HostelPaymentProfileModel,
  isGatewayEligible,
} from "@hostel/db/models/HostelPaymentProfile";

import { GATEWAY_PROVIDERS, type GatewayConfigSaveInput } from "./gateway-config.validation";

/**
 * The owner's gateway setup screen (target §11.8, plan item 6.1).
 *
 * Every provider is returned whether or not it is configured, so the screen is a
 * list of what this hostel *could* accept rather than a list of what somebody
 * already set up. An owner who has never opened it sees three cards and what
 * each one needs.
 *
 * **Nothing here returns a secret.** `secret` on the way in is written straight
 * to `EncryptedSecret`; on the way out there is a fingerprint and a date. A key
 * that has been stored can be replaced, never displayed — see `secret-store.ts`.
 */

export type GatewaySecretView = {
  configured: boolean;
  fingerprint: string | null;
  rotatedAt: string | null;
};

export type GatewayConfigView = {
  accountKind: GatewayAccountKind;
  /** Whether the owner has switched it on. */
  enabled: boolean;
  enabledAt: string | null;
  /**
   * What the last health check concluded, and the sentence behind it.
   *
   * Read from the stored verdict rather than recomputed here: this endpoint is
   * opened whenever an owner edits a merchant code, and recounting a week of
   * attempts on every one of those would make an infrequent job's work into a
   * per-request cost. The daily run is what keeps it current.
   */
  health: { detail: string | null; status: GatewayHealthStatus } | null;
  lastEventAt: string | null;
  lastVerifiedAt: string | null;
  merchantCode: string | null;
  mode: GatewayMode;
  /** Why this entry cannot be enabled, in words for the owner. Null when it can. */
  blockedReason: string | null;
  /** Whether residents are actually being offered it right now. */
  payable: boolean;
  provider: GatewayProviderName;
  secret: GatewaySecretView;
  webhookSecret: GatewaySecretView;
};

/** What each provider needs before it can be switched on, for the setup screen. */
export const GATEWAY_REQUIREMENTS: Record<
  GatewayProviderName,
  { merchantCodeLabel: string | null; secretLabel: string }
> = {
  ESEWA: {
    merchantCodeLabel: "Product code (eSewa calls it the merchant/service code)",
    secretLabel: "Secret key",
  },
  FONEPAY: {
    merchantCodeLabel: "Merchant code (issued by your bank, not by Fonepay)",
    secretLabel: "Shared secret",
  },
  KHALTI: {
    merchantCodeLabel: null,
    secretLabel: "Live secret key (from the Khalti merchant dashboard)",
  },
};

const PERSONAL_ACCOUNT_MESSAGE =
  `A personal wallet can only receive about NPR ` +
  `${FONEPAY_PERSONAL_DAILY_LIMIT.toLocaleString("en-IN")} per day, so rent payments ` +
  `would start failing partway through the month. Use a registered merchant ` +
  `account for online payments, or collect this one through your bank account instead.`;

/**
 * Why this entry cannot go live, phrased for the person who has to fix it.
 *
 * Returned as prose rather than a code because it is the only text on the screen
 * that tells an owner what to ask their bank for, and every one of these has a
 * different answer.
 */
function blockedReasonFor(entry: GatewayConfig | null): string | null {
  if (!entry) {
    return null;
  }

  if (entry.accountKind === "PERSONAL") {
    return PERSONAL_ACCOUNT_MESSAGE;
  }

  if (!isGatewayEligible(entry)) {
    return `Add the ${GATEWAY_REQUIREMENTS[entry.provider].merchantCodeLabel ?? "merchant code"} first.`;
  }

  if (entry.mode === "SANDBOX" && isProduction()) {
    return "This is still in test mode, so it is not shown to residents. Switch it to live once your merchant account is approved.";
  }

  return null;
}

function toSecretView(described: {
  configured: boolean;
  fingerprint: string | null;
  rotatedAt: Date | null;
}): GatewaySecretView {
  return {
    configured: described.configured,
    fingerprint: described.fingerprint,
    rotatedAt: described.rotatedAt ? described.rotatedAt.toISOString() : null,
  };
}

export async function listGatewayConfigs(
  hostelId: Types.ObjectId | string,
): Promise<GatewayConfigView[]> {
  await connectToDatabase();

  const profile = await HostelPaymentProfileModel.findOne({ hostelId })
    .select("gateways")
    .lean<{ gateways?: GatewayConfig[] } | null>();

  return Promise.all(
    GATEWAY_PROVIDERS.map(async (provider) => {
      const entry = findGateway(profile, provider);
      const [secret, webhookSecret] = await Promise.all([
        describeSecret(hostelId, provider, "GATEWAY_SECRET"),
        describeSecret(hostelId, provider, "GATEWAY_WEBHOOK_SECRET"),
      ]);

      return {
        accountKind: entry?.accountKind ?? "MERCHANT",
        blockedReason: blockedReasonFor(entry),
        enabled: Boolean(entry?.enabledAt),
        enabledAt: entry?.enabledAt ? new Date(entry.enabledAt).toISOString() : null,
        // Null until the daily job has run at least once against this entry —
        // "unknown" is honest, and better than a green tick nobody earned.
        health:
          entry?.healthStatus && entry.healthStatus !== "UNKNOWN"
            ? {
                detail: entry.healthDetail ?? null,
                status: entry.healthStatus as GatewayHealthStatus,
              }
            : null,
        lastEventAt: entry?.lastEventAt
          ? new Date(entry.lastEventAt).toISOString()
          : null,
        lastVerifiedAt: entry?.lastVerifiedAt
          ? new Date(entry.lastVerifiedAt).toISOString()
          : null,
        merchantCode: entry?.merchantCode ?? null,
        mode: entry?.mode ?? "SANDBOX",
        payable: isGatewayPayable(entry),
        provider,
        secret: toSecretView(secret),
        webhookSecret: toSecretView(webhookSecret),
      };
    }),
  );
}

/**
 * Creates or updates one provider's entry, and stores its secret if one was sent.
 *
 * The two writes are ordered **secret first**. A crash between them leaves a
 * stored key with no enabled entry, which is inert; the other order would leave
 * an entry marked live with no key behind it, and the resident-facing failure
 * for that is a checkout that dies after the resident has committed to paying.
 */
export async function saveGatewayConfig(
  hostelId: Types.ObjectId | string,
  input: GatewayConfigSaveInput,
  principal: ApiPrincipal,
): Promise<GatewayConfigView[]> {
  await connectToDatabase();

  const profile = await HostelPaymentProfileModel.findOne({ hostelId })
    .select("gateways")
    .lean<{ gateways?: GatewayConfig[] } | null>();

  const existing = findGateway(profile, input.provider);

  if (input.secret) {
    await putSecret({
      hostelId,
      plaintext: input.secret,
      principal,
      provider: input.provider,
      purpose: "GATEWAY_SECRET",
    });
  }

  if (input.webhookSecret) {
    await putSecret({
      hostelId,
      plaintext: input.webhookSecret,
      principal,
      provider: input.provider,
      purpose: "GATEWAY_WEBHOOK_SECRET",
    });
  }

  const merchantCode =
    input.merchantCode === undefined
      ? (existing?.merchantCode ?? null)
      : input.merchantCode || null;

  const next: GatewayConfig = {
    accountKind: input.accountKind,
    enabledAt: existing?.enabledAt ?? null,
    merchantCode,
    mode: input.mode,
    provider: input.provider,
  };

  if (input.enabled !== undefined) {
    next.enabledAt = input.enabled ? (existing?.enabledAt ?? new Date()) : null;
  }

  if (next.enabledAt) {
    await assertEnablable(hostelId, next);
  }

  await writeEntry(hostelId, input.provider, next, principal);

  await auditFinanceAction(principal, {
    action: "GATEWAY_CONFIG_UPDATED",
    // No money moves; the audit envelope requires both amounts, and zero is honest.
    amountAfter: 0,
    amountBefore: 0,
    entityId: new Types.ObjectId(String(hostelId)),
    entityType: "HostelPaymentProfile",
    hostelId,
    reason:
      `${input.provider} ${input.accountKind} ${input.mode}` +
      `${next.enabledAt ? " enabled" : " disabled"}` +
      `${input.secret ? " (secret written)" : ""}`,
    source: "GATEWAY_CONFIG_EDITOR",
  });

  return listGatewayConfigs(hostelId);
}

/**
 * Everything that must be true before residents are sent to a provider.
 *
 * Checked here rather than only in the form, because the form is one caller and
 * this is the invariant. Enabling a gateway is the single action on this screen
 * that can misdirect somebody's money.
 */
async function assertEnablable(
  hostelId: Types.ObjectId | string,
  entry: GatewayConfig,
): Promise<void> {
  if (entry.accountKind === "PERSONAL") {
    throw new FinanceServiceError(PERSONAL_ACCOUNT_MESSAGE, "GATEWAY_NOT_ELIGIBLE");
  }

  if (!isGatewayEligible(entry)) {
    throw new FinanceServiceError(
      `${entry.provider} needs a merchant code before it can take payments.`,
      "GATEWAY_NOT_CONFIGURED",
    );
  }

  if (entry.mode !== "LIVE") {
    return;
  }

  const secret = await describeSecret(hostelId, entry.provider, "GATEWAY_SECRET");

  if (!secret.configured) {
    throw new FinanceServiceError(
      `Enter the ${GATEWAY_REQUIREMENTS[entry.provider].secretLabel.toLowerCase()} before going live.`,
      "GATEWAY_NOT_CONFIGURED",
    );
  }
}

/**
 * Upserts one entry in the array without rewriting the others.
 *
 * Two statements rather than one because MongoDB's positional operator cannot
 * both match a missing element and create it. The `$set` runs first and matches
 * nothing when the entry is new; the `$push` is then guarded by a filter that
 * matches only when it is still absent, so a concurrent save cannot produce two
 * entries for one provider.
 */
async function writeEntry(
  hostelId: Types.ObjectId | string,
  provider: GatewayProviderName,
  entry: GatewayConfig,
  principal: ApiPrincipal,
): Promise<void> {
  const fields = {
    "gateways.$.accountKind": entry.accountKind,
    "gateways.$.enabledAt": entry.enabledAt ?? null,
    "gateways.$.merchantCode": entry.merchantCode ?? null,
    "gateways.$.mode": entry.mode,
    "gateways.$.updatedBy": principal.userId,
  };

  /*
   * Matched on the slot itself (FIN-10). The arrayFilters form threw on a profile
   * with no `gateways` array, and an unchanged save (modifiedCount 0) fell through
   * to the push and its upsert, which collided with the profile's unique hostelId.
   */
  const updated = await HostelPaymentProfileModel.updateOne(
    { hostelId, "gateways.provider": provider },
    { $set: fields },
  );

  if (updated.matchedCount > 0) {
    return;
  }

  await HostelPaymentProfileModel.updateOne(
    { hostelId, "gateways.provider": { $ne: provider } },
    {
      $push: { gateways: { ...entry, updatedBy: principal.userId } },
      $setOnInsert: { createdBy: principal.userId, hostelId },
    },
    { upsert: true },
  );
}

/**
 * Removes a provider entirely, including its stored keys.
 *
 * The keys go with it. Leaving them behind means a hostel that removed a
 * provider still holds a signing secret for it, which is a credential nobody is
 * watching and nobody meant to keep.
 */
export async function deleteGatewayConfig(
  hostelId: Types.ObjectId | string,
  provider: GatewayProviderName,
  principal: ApiPrincipal,
): Promise<GatewayConfigView[]> {
  await connectToDatabase();

  await HostelPaymentProfileModel.updateOne(
    { hostelId },
    { $pull: { gateways: { provider } } },
  );

  await EncryptedSecretModel.deleteMany({ hostelId, provider });

  await auditFinanceAction(principal, {
    action: "GATEWAY_CONFIG_REMOVED",
    amountAfter: 0,
    amountBefore: 0,
    entityId: new Types.ObjectId(String(hostelId)),
    entityType: "HostelPaymentProfile",
    hostelId,
    reason: `${provider} removed, stored keys deleted`,
    source: "GATEWAY_CONFIG_EDITOR",
  });

  return listGatewayConfigs(hostelId);
}
