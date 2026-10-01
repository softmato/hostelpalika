/**
 * What a file is *for*, as opposed to what format it is in.
 *
 * `UploadKind` ("image", "document", …) answers "which bytes are acceptable".
 * This answers "which part of the product is this evidence for", which is what
 * the authorization layer needs: a payment screenshot must be readable only
 * inside its own hostel, so a financial asset without a `hostelId` is a bug we
 * refuse to create rather than one we discover later.
 */
export const FILE_ASSET_KINDS = [
  "GENERIC",
  /**
   * A resident describing a complaint out loud, attached to one complaint.
   *
   * Separate from `MAINTENANCE_NOTE` precisely because that kind is the one
   * that widens outside the hostel: `files/{assetId}/url` hands a
   * `MAINTENANCE_NOTE` to the assigned service provider. A resident complaining
   * about the kitchen staff — or recording their own voice anonymously — must
   * never be readable by a contractor, so this kind takes the default path and
   * stays owner, hostel and platform only.
   */
  "COMPLAINT_NOTE",
  /**
   * A spoken description of a maintenance problem, attached to one request.
   *
   * Its own kind rather than `GENERIC` because it is the only asset in the
   * product read by somebody outside the hostel — the assigned service provider
   * — and `files/{assetId}/url` grants that access only for this kind. A
   * `GENERIC` asset stays hostel-and-owner-only, which is the default that
   * should never widen by accident.
   */
  "MAINTENANCE_NOTE",
  "PAYMENT_PROOF",
  "PAYMENT_QR",
  "STATEMENT",
  /**
   * A hostel owner's or a tradesperson's registration document: citizenship,
   * licence, PAN. Written only by `POST /public/files/upload`, always private,
   * and owned by nobody until the application that names it claims it with the
   * token from that upload (`lib/registration-documents.ts`). Takes the default
   * read path, so only the owner and the platform can open it.
   */
  "REGISTRATION_DOCUMENT",
  /**
   * A screenshot of a booking fee paid to HostelPalika, or of a refund or payout
   * we sent. The money is the platform's, not a hostel's, so this kind is
   * **never** given a `hostelId` at presign — not even a resident's own hostel —
   * and takes the default read path: the uploader and platform staff only.
   */
  "BOOKING_PAYMENT_PROOF",
  /**
   * The screenshot of a booking refund or payout a superadmin sent. A platform
   * money record, so the same rule: never hostel-scoped, platform staff only.
   */
  "BOOKING_TRANSFER_PROOF",
  /**
   * A photo of a shop bill or a payment screenshot attached to a hostel
   * expense (docs/EXPENSES_PLAN.md). The hostel's own books, so financial —
   * tenant-scoped at presign — and staff-only to read: never a resident, a
   * guardian or anyone else holding the same `hostelId`.
   */
  "EXPENSE_RECEIPT",
] as const;

/** Kinds that must never be scoped to a hostel, whoever uploads them. */
const PLATFORM_ONLY_KINDS = new Set<FileAssetKind>(["BOOKING_PAYMENT_PROOF", "BOOKING_TRANSFER_PROOF"]);

export function isPlatformOnlyAssetKind(value: unknown): boolean {
  return isFileAssetKind(value) && PLATFORM_ONLY_KINDS.has(value);
}

export type FileAssetKind = (typeof FILE_ASSET_KINDS)[number];

/**
 * Kinds that carry money evidence. Every one of these must be tenant-scoped at
 * presign time — see docs/FINANCE_IMPLEMENTATION_PLAN.md item 0.1.
 */
const FINANCIAL_KINDS = new Set<FileAssetKind>([
  "PAYMENT_PROOF",
  "PAYMENT_QR",
  "STATEMENT",
  "EXPENSE_RECEIPT",
]);

export function isFileAssetKind(value: unknown): value is FileAssetKind {
  return typeof value === "string" && FILE_ASSET_KINDS.includes(value as FileAssetKind);
}

export function isFinancialAssetKind(value: unknown): boolean {
  return isFileAssetKind(value) && FINANCIAL_KINDS.has(value);
}
