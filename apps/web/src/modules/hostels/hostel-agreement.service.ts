import "server-only";

import { createHash } from "node:crypto";

import { Types } from "mongoose";

import { hostelCalendarDay } from "@hostel/shared/calendar/bs";
import { sendEmail, type EmailAttachment } from "@hostel/shared/email/sender";
import { hostelAgreementEmail } from "@hostel/shared/email/templates/hostel/hostel-kyc";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelAgreementModel } from "@hostel/db/models/HostelAgreement";
import { HostelAgreementSignatureModel } from "@hostel/db/models/HostelAgreementSignature";
import { HostelModel } from "@hostel/db/models/Hostel";
import { PlatformDocumentSequenceModel } from "@hostel/db/models/PlatformDocumentSequence";
import { UserModel } from "@hostel/db/models/User";
import { connectToDatabase } from "@/lib/db";
import { documentFileName, loadIssuer } from "@/modules/billing/documents/issue";
import { loadAgreementSeals } from "@/modules/hostels/agreement-seals";
import { renderAgreementDocument } from "@/modules/hostels/hostel-agreement-document";
import {
  AGREEMENT_TITLE,
  agreementIntro,
  agreementTerms,
  type AgreementParties,
  type AgreementSection,
} from "@/modules/hostels/hostel-agreement-terms";
import { HostelServiceError } from "@/modules/hostels/hostel.service";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { agreementRef } from "@/modules/team/registration-track-sheet";

/**
 * The service agreement an owner signs on the last KYC step, and the PDF of it
 * emailed when the KYC is approved (`completeKycApproval`). A hostel that is
 * already verified — every hostel from before the quick sign-up — gets it the
 * moment its owner signs.
 */

/** The paper agreements' one run (`registration-track-sheet.service.ts`): one numbering for both. */
const RUN = { fiscalYear: "LIFETIME", kind: "HOSTEL_AGREEMENT" } as const;

/**
 * The company's address, email and phone as printed on the letterhead the
 * agreement sits on (`agreement-letterhead.ts`). Not the `issuer` config, which
 * serves invoices and can drift from paper that is printed and fixed.
 */
export const LETTERHEAD_COMPANY = {
  address: "Mid-Baneshwor, Kathmandu",
  email: "work@softmato.com",
  phone: "9819748466",
} as const;

type SignatureRecord = {
  approvedByName?: string;
  ip?: string;
  issuedAt?: Date | null;
  parties: AgreementParties;
  refCode?: string | null;
  sentAt?: Date | null;
  signature: string;
  signedAt: Date;
  signerName: string;
  terms: AgreementSection[];
  textHash: string;
  userAgent?: string;
};

async function agreementParties(hostelId: Types.ObjectId): Promise<{ ownerId: string | null; parties: AgreementParties }> {
  const hostel = await HostelModel.findById(hostelId)
    .select("name ownerId location contact")
    .lean<{
      contact?: { phone?: string };
      location?: { address?: string; area?: string; city?: string };
      name?: string;
      ownerId?: Types.ObjectId;
    } | null>();

  if (!hostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const [owner, issuer, identity] = await Promise.all([
    hostel.ownerId
      ? UserModel.findById(hostel.ownerId).select("name email phone").lean<{ email?: string; name?: string; phone?: string } | null>()
      : null,
    loadIssuer(),
    getSiteConfigSection("identity"),
  ]);
  const place = hostel.location ?? {};

  const parties: AgreementParties = {
    // Contact details as the letterhead prints them, so the page never disagrees with itself.
    company: { ...LETTERHEAD_COMPANY, legalName: issuer.legalName, pan: issuer.pan, supportPhone: identity.supportPhone || LETTERHEAD_COMPANY.phone },
    hostel: {
      address: [place.address, place.area, place.city].map((part) => part?.trim()).filter(Boolean).join(", "),
      name: hostel.name ?? "",
    },
    owner: { email: owner?.email ?? "", name: owner?.name ?? "", phone: owner?.phone ?? hostel.contact?.phone ?? "" },
  };

  return { ownerId: hostel.ownerId ? String(hostel.ownerId) : null, parties };
}

function fingerprint(parties: AgreementParties, terms: AgreementSection[]) {
  return createHash("sha256").update(JSON.stringify({ intro: agreementIntro(parties), parties, terms })).digest("hex");
}

export async function hasSignedAgreement(hostelId: Types.ObjectId) {
  return Boolean(await HostelAgreementSignatureModel.exists({ hostelId }));
}

/** What the sign step shows: the text to read, and the signature once given. */
export async function getHostelAgreement(hostelId: string | Types.ObjectId) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const signed = await HostelAgreementSignatureModel.findOne({ hostelId: id }).lean<SignatureRecord | null>();
  const { parties: current } = await agreementParties(id);
  const parties = signed?.parties ?? current;

  return {
    intro: agreementIntro(parties),
    parties,
    signed: signed
      ? {
          issuedAt: signed.issuedAt?.toISOString() ?? null,
          refCode: signed.refCode ?? null,
          sentAt: signed.sentAt?.toISOString() ?? null,
          signature: signed.signature,
          signedAt: signed.signedAt.toISOString(),
          signerName: signed.signerName,
        }
      : null,
    terms: signed?.terms ?? agreementTerms(current),
    title: AGREEMENT_TITLE,
  };
}

/**
 * The owner signs. They can sign again until the agreement is issued — after
 * that it is final, and the PDF in their inbox is the agreement.
 */
export async function signHostelAgreement(
  hostelId: string | Types.ObjectId,
  userId: string,
  input: { signature: string; signerName: string },
  meta: { ip: string; userAgent: string },
) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const { ownerId, parties } = await agreementParties(id);

  if (ownerId !== userId) {
    throw new HostelServiceError("Only the hostel owner can sign the agreement.", "AGREEMENT_OWNER_ONLY", 403);
  }

  const final = () => new HostelServiceError("Your agreement is already signed and sent.", "AGREEMENT_FINAL", 409);

  if (await HostelAgreementSignatureModel.exists({ hostelId: id, refCode: { $ne: null } })) throw final();

  const terms = agreementTerms(parties);
  const saved = await HostelAgreementSignatureModel.findOneAndUpdate(
    { hostelId: id, refCode: null },
    {
      $set: {
        ip: meta.ip.slice(0, 64),
        parties,
        signature: input.signature,
        signedAt: new Date(),
        signedBy: new Types.ObjectId(userId),
        signerName: input.signerName,
        terms,
        textHash: fingerprint(parties, terms),
        userAgent: meta.userAgent.slice(0, 300),
      },
      $setOnInsert: { hostelId: id },
    },
    { new: true, upsert: true },
  )
    .lean()
    // The unique index refuses the upsert once a signed row has its code.
    .catch((error: { code?: number }) => {
      if (error?.code === 11000) return null;
      throw error;
    });

  if (!saved) throw final();

  await AuditLogModel.create({
    action: "HOSTEL_AGREEMENT_SIGNED",
    actorId: userId,
    entityId: id.toString(),
    entityType: "Hostel",
    hostelId: id,
  });

  // Verified already (no KYC review, or approved before this step existed): send it now.
  const hostel = await HostelModel.findById(id).select("kyc").lean<{ kyc?: { required?: boolean; status?: string | null } } | null>();

  if (!hostel?.kyc?.required || hostel.kyc.status === "APPROVED") {
    await sendHostelAgreement(id, null).catch((error: unknown) =>
      console.error(
        JSON.stringify({
          action: "hostel_agreement_send_failed",
          hostelId: id.toString(),
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }

  return getHostelAgreement(id);
}

/**
 * Gives the signed agreement its number and its company side (who approved)
 * and returns the PDF to attach. `null` when the owner has not signed.
 * Idempotent: an agreement issued once keeps its number.
 */
export async function issueHostelAgreement(
  hostelId: Types.ObjectId,
  approverId: string | null,
): Promise<{ attachment: EmailAttachment; refCode: string } | null> {
  await connectToDatabase();

  let record = await HostelAgreementSignatureModel.findOne({ hostelId }).lean<SignatureRecord | null>();

  if (!record) return null;

  if (!record.refCode) {
    const approver = approverId
      ? await UserModel.findById(approverId).select("name").lean<{ name?: string } | null>()
      : null;
    const run = await PlatformDocumentSequenceModel.findOneAndUpdate(
      RUN,
      { $inc: { sequence: 1 } },
      { new: true, setDefaultsOnInsert: true, upsert: true },
    ).lean<{ sequence: number } | null>();
    const sequence = run?.sequence ?? 1;
    const now = new Date();
    const refCode = agreementRef(sequence, now);
    // A racing issue loses here and burns its number — a gap, never a code given twice.
    const won = await HostelAgreementSignatureModel.findOneAndUpdate(
      { hostelId, refCode: null },
      { $set: { approvedByName: approver?.name ?? "", issuedAt: now, refCode } },
      { new: true },
    ).lean<SignatureRecord | null>();

    if (won) {
      record = won;
      await HostelAgreementModel.create({
        createdBy: approverId ? new Types.ObjectId(approverId) : undefined,
        hostelName: won.parties.hostel.name,
        location: won.parties.hostel.address,
        notes: "Signed electronically at KYC",
        ownerName: won.signerName,
        phone: won.parties.owner.phone,
        refCode,
        sequence,
        signedOn: hostelCalendarDay(won.signedAt),
        status: "SIGNED",
      });
    } else {
      record = await HostelAgreementSignatureModel.findOne({ hostelId }).lean<SignatureRecord | null>();
      if (!record?.refCode) return null;
    }
  }

  return { attachment: await renderRecord(record), refCode: record.refCode! };
}

/**
 * One record, printed. Issued: its number, and the founders' signatures and
 * stamp. Not issued yet (a superadmin looking before approving): marked as a
 * preview, with the company's side left empty.
 */
async function renderRecord(record: SignatureRecord): Promise<EmailAttachment> {
  const issued = Boolean(record.refCode);
  const [issuer, seals] = await Promise.all([loadIssuer(), issued ? loadAgreementSeals() : null]);
  const content = await renderAgreementDocument({
    approvedByName: record.approvedByName ?? "",
    ip: record.ip ?? "",
    issuedAt: record.issuedAt ?? null,
    issuer,
    parties: record.parties,
    refCode: record.refCode ?? null,
    seals,
    signature: record.signature,
    signedAt: record.signedAt,
    signerName: record.signerName,
    terms: record.terms,
    textHash: record.textHash,
    userAgent: record.userAgent ?? "",
  });

  return {
    content,
    filename: `HostelPalika-Agreement-${issued ? documentFileName(record.refCode!) : "preview.pdf"}`,
  };
}

export async function markHostelAgreementSent(hostelId: Types.ObjectId, to: string) {
  await HostelAgreementSignatureModel.updateOne({ hostelId }, { $set: { sentAt: new Date(), sentTo: to } });
}

/** Issues the agreement and emails it on its own — for a hostel that is already verified. */
async function sendHostelAgreement(hostelId: Types.ObjectId, approverId: string | null) {
  const issued = await issueHostelAgreement(hostelId, approverId);
  const record = await HostelAgreementSignatureModel.findOne({ hostelId }).lean<SignatureRecord | null>();
  const to = record?.parties.owner.email;

  if (!issued || !to || record?.sentAt) return;

  const delivery = await sendEmail({
    to,
    ...hostelAgreementEmail({ hostelName: record.parties.hostel.name, ownerName: record.signerName, refCode: issued.refCode }),
    attachments: [issued.attachment],
  });

  if (delivery.sent) await markHostelAgreementSent(hostelId, to);
}

/** The issued PDF, for the owner's own download. `null` before it is issued. */
export async function hostelAgreementPdf(hostelId: string | Types.ObjectId) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));

  if (!(await HostelAgreementSignatureModel.exists({ hostelId: id, refCode: { $ne: null } }))) return null;

  return issueHostelAgreement(id, null);
}

/** Where a hostel's agreement stands, for the platform's review screen. */
export async function platformHostelAgreement(hostelId: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(hostelId)) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const record = await HostelAgreementSignatureModel.findOne({ hostelId: new Types.ObjectId(hostelId) }).lean<
    (SignatureRecord & { sentTo?: string }) | null
  >();

  return record
    ? {
        issuedAt: record.issuedAt?.toISOString() ?? null,
        refCode: record.refCode ?? null,
        sentAt: record.sentAt?.toISOString() ?? null,
        sentTo: record.sentTo ?? "",
        signature: record.signature,
        signedAt: record.signedAt.toISOString(),
        signerName: record.signerName,
      }
    : null;
}

/** Any hostel's agreement as a PDF — issued, or a preview while it waits for approval. */
export async function platformHostelAgreementPdf(hostelId: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(hostelId)) return null;

  const record = await HostelAgreementSignatureModel.findOne({ hostelId: new Types.ObjectId(hostelId) }).lean<SignatureRecord | null>();

  return record ? renderRecord(record) : null;
}
