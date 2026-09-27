import { Schema, model, models } from "mongoose";

/**
 * The platform-wide "resident identity" a user fills in once so they never have
 * to re-type the same personal details at every hostel they apply to.
 *
 * Everything personal lives inside `encryptedData` as a single AES-256-GCM blob
 * (see apps/web/src/lib/personal-data-crypto.ts). Nothing here is queryable by
 * field on purpose — the only lookup key is `User.userResidentId`, which is a
 * random public handle and not personal data itself. That keeps a database dump
 * useless without the encryption key.
 */
const userResidentProfileSchema = new Schema(
  {
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    /** `v1.<iv>.<tag>.<ciphertext>` — never store plaintext personal fields here. */
    encryptedData: { type: String, required: true },
    /** Schema version of the decrypted payload, so future migrations can branch. */
    payloadVersion: { type: Number, default: 1 },
    completedAt: Date,
    /**
     * HMAC of the card's primary email (`personalLookupHash`), never the address
     * itself — the one field that must be matchable, so no two cards can claim
     * the same email while the blob stays opaque.
     */
    primaryEmailHash: { type: String, default: null },
    /**
     * The same for the card's main phone, keyed on `residentPhoneKey` so the
     * spellings of one number match. Set on save; a card saved before this
     * existed gains it the next time it is edited.
     */
    primaryPhoneHash: { type: String, default: null },
    /*
     * The ID-card photo. Deliberately NOT inside `encryptedData`: the bytes live
     * in R2 as a PRIVATE FileAsset and this is only an opaque handle to them, so
     * encrypting it would buy nothing while forcing every photo change to
     * re-write the whole personal blob.
     */
    photoAssetId: { ref: "FileAsset", type: Schema.Types.ObjectId },
    /** Cache-buster for the photo proxy — a new photo must not serve a stale one. */
    photoUpdatedAt: Date,
    /*
     * A photographed signature, for holders who signed on paper instead of on
     * the screen. The drawn alternative lives inside `encryptedData` as stroke
     * data; exactly one of the two is ever set, and `saveResidentIdentity`
     * clears whichever one was not chosen so the card can never hold two
     * different signatures and have to guess.
     *
     * Same handle-not-bytes arrangement as the photo above, and the same
     * PRIVATE bucket: a signature is the most forgeable thing on the card.
     */
    signatureAssetId: { ref: "FileAsset", type: Schema.Types.ObjectId },
    /** Cache-buster for the signature proxy, as above. */
    signatureUpdatedAt: Date,
    /** Bumped every time a hostel pulls this profile via QR / resident id. */
    shareCount: { type: Number, default: 0, min: 0 },
    lastSharedAt: Date,
    lastSharedWithHostelId: { ref: "Hostel", type: Schema.Types.ObjectId },
    /** User can switch sharing off without deleting the profile. */
    sharingEnabled: { type: Boolean, default: true },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

userResidentProfileSchema.index({ userId: 1 }, { unique: true });
userResidentProfileSchema.index({ primaryEmailHash: 1 });
userResidentProfileSchema.index({ primaryPhoneHash: 1 });

export const UserResidentProfileModel =
  models.UserResidentProfile ||
  model("UserResidentProfile", userResidentProfileSchema);
