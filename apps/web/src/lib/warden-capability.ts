import type { WardenPermissionKey } from "@/lib/wardens/warden.validation";

/**
 * Which stored permission keys grant a capability (target §13.4, plan item 0.5,
 * D7).
 *
 * `verifyPayments` was one flat flag covering eight operations, held by every
 * warden by default. It is now six capabilities — and because the flag is a
 * stored value on live `HostelMember` rows rather than a computed one, splitting
 * it means every existing row has to be rewritten (`web:migrate:payment-caps`)
 * *and* the old key has to keep working until that migration has certainly run
 * everywhere. Otherwise every warden silently loses payment access on deploy.
 *
 * The alias grants only what a warden should have had all along: view, approve,
 * and cash entry. It deliberately does **not** grant `reversePayments`,
 * `manageFeeSchedule` or `managePaymentProfile` — the whole point of the split
 * is that those were never meant to travel with proof verification, so honouring
 * the alias for them would preserve the hole this closes.
 */
const DEPRECATED_ALIASES: Partial<Record<WardenPermissionKey, string[]>> = {
  approvePayments: ["verifyPayments"],
  recordCash: ["verifyPayments"],
  viewPayments: ["verifyPayments"],
};

/**
 * Every stored key that satisfies `capability`, for use as a `$in` filter.
 * Always includes the capability itself.
 */
export function grantingPermissionKeys(capability: WardenPermissionKey): string[] {
  return [capability, ...(DEPRECATED_ALIASES[capability] ?? [])];
}
