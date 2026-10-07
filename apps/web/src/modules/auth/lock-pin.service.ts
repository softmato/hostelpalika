import { connectToDatabase } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { COOK_LOGIN_DOMAIN } from "@/modules/food/cook-identity";
import { AuthServiceError, verifyBiometricCode } from "@/modules/auth/auth.service";
import type { LockPinProof } from "@/modules/auth/auth.validation";
import { UserModel } from "@hostel/db/models/User";

/**
 * The account's app-lock PIN — one PIN per account, not per phone.
 *
 * The app opens with it (or the fingerprint), and every web portal asks for it
 * before it renders. Ten wrong tries in a row block it until a new one is set
 * with an email code (or, for a minted cook login with no inbox, the password):
 * the counter is spent before the compare, in one atomic write, so a burst of
 * parallel guesses still gets ten tries, not ten per request. The count is
 * only shown once half of them are gone — a slip of the finger is not a warning.
 */

const MAX_FAILURES = 10;
/** Wrong tries before "N tries left" starts showing. */
const QUIET_FAILURES = 5;

type PinRow = {
  _id: unknown;
  email?: string | null;
  lockPinFailures?: number;
  lockPinHash?: string;
  lockPinSetAt?: Date | null;
  passwordHash?: string;
};

function blocked() {
  return new AuthServiceError(
    "Too many wrong PINs. Reset it with a code sent to your email.",
    "LOCK_PIN_BLOCKED",
    423,
  );
}

async function loadRow(userId: string) {
  const row = await UserModel.findById(userId)
    .select("+lockPinHash +passwordHash email lockPinFailures lockPinSetAt")
    .lean<PinRow>();

  if (!row) throw new AuthServiceError("User no longer has access.", "USER_INACTIVE");

  return row;
}

/** Spends one try, then compares. Throws on a wrong or blocked PIN. */
async function checkPin(userId: string, pin: string) {
  const row = await UserModel.findOneAndUpdate(
    { _id: userId, lockPinFailures: { $lt: MAX_FAILURES }, lockPinSetAt: { $ne: null } },
    { $inc: { lockPinFailures: 1 } },
    { new: true },
  )
    .select("+lockPinHash lockPinFailures")
    .lean<PinRow>();

  if (!row?.lockPinHash) throw blocked();

  if (!(await verifyPassword(pin, row.lockPinHash))) {
    const failures = row.lockPinFailures ?? MAX_FAILURES;
    const left = MAX_FAILURES - failures;
    if (left <= 0) throw blocked();
    throw new AuthServiceError(
      failures <= QUIET_FAILURES
        ? "Wrong PIN. Try again."
        : `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`,
      "LOCK_PIN_INCORRECT",
      400,
    );
  }

  await UserModel.updateOne({ _id: userId }, { $set: { lockPinFailures: 0 } });
}

/**
 * Whoever is changing or removing an existing PIN proves it is them: the
 * current PIN, a code mailed to the account, or — only for a login with no
 * inbox — the account password.
 */
async function assertProof(userId: string, row: PinRow, proof: LockPinProof) {
  if (proof.challengeId && proof.code) {
    await verifyBiometricCode(userId, { challengeId: proof.challengeId, code: proof.code });
    return;
  }

  if (proof.currentPin) {
    await checkPin(userId, proof.currentPin);
    return;
  }

  const noInbox = !row.email || row.email.endsWith(`@${COOK_LOGIN_DOMAIN}`);

  if (proof.password && noInbox && row.passwordHash) {
    if (await verifyPassword(proof.password, row.passwordHash)) return;
    throw new AuthServiceError("That password is not right.", "INVALID_CREDENTIALS", 400);
  }

  throw new AuthServiceError(
    "Enter your current PIN or the code sent to your email.",
    "LOCK_PIN_PROOF_REQUIRED",
    400,
  );
}

/** Sets the first PIN, or replaces one with proof. */
export async function setLockPin(userId: string, input: LockPinProof & { pin: string }) {
  await connectToDatabase();
  const row = await loadRow(userId);

  if (row.lockPinSetAt) await assertProof(userId, row, input);

  await UserModel.updateOne(
    { _id: userId },
    {
      $set: {
        lockPinFailures: 0,
        lockPinHash: await hashPassword(input.pin),
        lockPinSetAt: new Date(),
      },
    },
  );

  return { hasLockPin: true };
}

/** Turns the lock off everywhere — app and web. */
export async function removeLockPin(userId: string, proof: LockPinProof) {
  await connectToDatabase();
  const row = await loadRow(userId);

  if (row.lockPinSetAt) {
    await assertProof(userId, row, proof);
    await UserModel.updateOne(
      { _id: userId },
      { $set: { lockPinFailures: 0, lockPinSetAt: null }, $unset: { lockPinHash: 1 } },
    );
  }

  return { hasLockPin: false };
}

/** The unlock itself. An account with no PIN has nothing to unlock and passes. */
export async function verifyLockPin(userId: string, pin: string) {
  await connectToDatabase();
  const row = await loadRow(userId);

  if (row.lockPinSetAt) await checkPin(userId, pin);

  return { verified: true };
}
