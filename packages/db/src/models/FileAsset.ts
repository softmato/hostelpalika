import { Schema, model, models } from "mongoose";

import { validateFileAssetMetadata } from "@hostel/shared/utils/file-assets";

const variantSchema = new Schema(
  {
    variant: {
      type: String,
      enum: ["ORIGINAL", "THUMBNAIL", "MEDIUM", "LARGE"],
      required: true,
    },
    key: { type: String, required: true },
    width: { type: Number },
    height: { type: Number },
    sizeBytes: { type: Number },
    mimeType: { type: String },
  },
  { _id: false },
);

const fileAssetSchema = new Schema(
  {
    hostelId: { ref: "Hostel", type: Schema.Types.ObjectId },
    ownerId: { ref: "User", type: Schema.Types.ObjectId },
    storageProvider: { type: String, required: true },
    bucket: { type: String, required: true },
    key: { type: String, required: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    accessLevel: {
      type: String,
      enum: ["PUBLIC", "PRIVATE", "PROTECTED"],
      default: "PRIVATE",
    },
    /**
     * What the file is *for*, as opposed to what format it is in — mirrors
     * `FILE_ASSET_KINDS` in `apps/web/src/lib/file-asset-kinds.ts`.
     *
     * The presign route has always accepted this and, until now, only used it to
     * refuse an untenanted financial upload before creating the row. It was
     * never stored, so nothing downstream could ask what an asset was for — and
     * `files/{assetId}/url`, which decides who may read the bytes, is exactly
     * the place that has to ask: `MAINTENANCE_NOTE` is the one kind readable by
     * somebody outside the hostel.
     *
     * No default. A row written before this existed has no kind, which reads as
     * `GENERIC` everywhere — the narrowest possible answer, and the right one
     * for an asset whose purpose nobody recorded.
     */
    kind: {
      enum: [
        "GENERIC",
        "COMPLAINT_NOTE",
        "MAINTENANCE_NOTE",
        "PAYMENT_PROOF",
        "PAYMENT_QR",
        "REGISTRATION_DOCUMENT",
        "STATEMENT",
        "BOOKING_PAYMENT_PROOF",
        "BOOKING_TRANSFER_PROOF",
        "EXPENSE_RECEIPT",
      ],
      type: String,
    },
    publicUrl: String,
    /**
     * Set once the bytes are confirmed to exist in storage and to match what
     * the client declared. Until then the row is a reservation, not a file:
     * a presign that is never followed by a PUT leaves one behind, and nothing
     * may use an unconfirmed asset as evidence (target §13.3).
     */
    uploadCompletedAt: Date,
    /** SHA-256 of the stored bytes, read back from storage — never client-sent. */
    contentHash: String,
    /**
     * 64-bit dHash of the image, as 16 hex characters (plan item 3.4).
     *
     * Answers "does this *look* like one we have seen?", where `contentHash`
     * answers "are these the same bytes?". A perceptual match is evidence, not
     * proof, and may only flag a claim for review — never auto-reject it.
     * Absent for anything that is not a decodable image.
     */
    perceptualHash: String,
    /**
     * Set when the uploaded bytes are a document *this system* generated — a
     * receipt or a statement (plan item 3.4 follow-on).
     *
     * Recorded at upload rather than enforced there: the file itself is
     * perfectly legitimate to store, and a resident may have good reason to
     * upload their own receipt somewhere. What it may never be is *evidence of
     * payment*, and that rule belongs to the finance module, which reads this.
     */
    systemDocumentKind: { type: String, enum: ["RECEIPT", "STATEMENT"] },
    /**
     * What the decoded image measures (gap fixes 2 and 3). Images only.
     *
     * Derived from the bytes at completion, because reading the object back a
     * second time when a claim is submitted would double the storage round-trips
     * on the one path a resident is actually waiting on.
     *
     * `nearBlank` is the load-bearing field, and it is *recorded* here rather
     * than enforced: a 4×4 white PNG is a perfectly legal image and a
     * meaningless proof of payment, so the rule belongs to the finance module —
     * same division as `systemDocumentKind` above.
     */
    imageInsight: {
      contrast: Number,
      height: Number,
      nearBlank: Boolean,
      width: Number,
    },
    /**
     * What the *file* says about how it was made — editor signatures, JPEG
     * quantization tables, camera EXIF, screen-shaped dimensions.
     *
     * The counterpart to `imageInsight`, and the division is the same one as
     * above: measured here at upload, judged by the finance module. Every field
     * has an innocent explanation on its own, so none of it may ever refuse an
     * upload — a resident who cropped their bank balance out of a screenshot
     * before sending it is behaving well, and this records that they did, not
     * that they should be stopped.
     *
     * Computed at upload rather than at claim because the bytes are already in
     * hand, the claim path is the one a resident waits on, and holding the
     * signal for unclaimed assets is what makes it possible to notice the same
     * doctored file being tried against three different invoices.
     */
    provenance: {
      container: String,
      editorSignature: String,
      hasCameraExif: Boolean,
      jpegQuality: Number,
      quantTablesStandard: Boolean,
      screenshotShape: Boolean,
      softwareTag: String,
    },
    variants: { type: [variantSchema], default: [] },
    status: { type: String, enum: ["ACTIVE", "DELETED"], default: "ACTIVE" },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

fileAssetSchema.pre("validate", function validateUploadPolicy() {
  const asset = this as {
    invalidate(path: string, message: string): void;
    mimeType?: string;
    sizeBytes?: number;
  };
  const violation = validateFileAssetMetadata({
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  });

  if (violation) {
    asset.invalidate("mimeType", violation);
  }
});

fileAssetSchema.index({ hostelId: 1, status: 1 });
fileAssetSchema.index({ ownerId: 1, status: 1 });
fileAssetSchema.index({ key: 1 }, { unique: true });
// Drives the abandoned-presign sweep: rows with no completion, oldest first.
fileAssetSchema.index({ uploadCompletedAt: 1, createdAt: 1 });

export const FileAssetModel =
  models.FileAsset || model("FileAsset", fileAssetSchema);
