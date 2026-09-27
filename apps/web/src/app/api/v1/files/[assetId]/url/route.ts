import { NextResponse, type NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, errorResponse, successResponse } from "@/lib/api-response";
import { connectToDatabase } from "@/lib/db";
import { HOSTEL_STAFF_ROLES, PLATFORM_ROLES } from "@/lib/permissions";
import { getPresignedReadUrl } from "@/lib/r2";
import { isValidDocumentClaimToken } from "@/lib/registration-documents";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    assetId: string;
  }>;
};

const VALID_VARIANTS = new Set(["ORIGINAL", "THUMBNAIL", "MEDIUM", "LARGE"]);

/*
 * One person's evidence or the office's own books. They carry a `hostelId` so
 * the hostel's staff can read them — not so every resident, guardian and the
 * shared cook login on that hostel can, which is what the same-hostel grant
 * alone allowed: any of them could open a neighbour's bank screenshot, the
 * hostel's bank statement or an anonymous complaint recording by id. The
 * hostel's collection QR stays hostel-wide on purpose: residents pay with it.
 */
const STAFF_ONLY_KINDS = new Set([
  "COMPLAINT_NOTE",
  "MAINTENANCE_NOTE",
  "PAYMENT_PROOF",
  "STATEMENT",
]);

/**
 * The one grant that reaches outside a hostel, and it is deliberately narrow.
 *
 * A maintenance voice note is recorded by a warden and has to be listened to by
 * the contractor coming to fix the thing — who is not staff, is not in
 * `principal.hostelIds`, and would otherwise be refused by the default-deny
 * below. Every other kind of asset stays exactly as locked as it was.
 *
 * Four conditions, all required, and each one closes a different door:
 *
 *  1. the asset is a `MAINTENANCE_NOTE`, so a payment proof can never take this
 *     path even if somebody attached one to a request;
 *  2. the caller has an **approved** provider profile, so a rejected or hidden
 *     one loses access with the approval rather than keeping it;
 *  3. a live maintenance request references this exact asset; and
 *  4. that request is assigned to *this* provider.
 *
 * The query is the authorization — there is no branch that widens on a missing
 * field, which is the shape of the bug the default-deny comment below records.
 */
async function isAssignedProvider(
  fileAsset: { _id: unknown; kind?: string },
  userId: string,
): Promise<boolean> {
  if (fileAsset.kind !== "MAINTENANCE_NOTE") {
    return false;
  }

  const provider = await ServiceProviderModel.findOne({
    isDeleted: { $ne: true },
    status: "APPROVED",
    userId,
  })
    .select("_id")
    .lean<{ _id: unknown } | null>();

  if (!provider) {
    return false;
  }

  const assigned = await MaintenanceRequestModel.exists({
    isDeleted: false,
    providerId: provider._id,
    voiceNoteAssetId: fileAsset._id,
  });

  return Boolean(assigned);
}

function resolveVariantKey(
  fileAsset: {
    key: string;
    variants?: Array<{ key: string; variant: string }>;
  },
  variant: string,
) {
  if (variant === "ORIGINAL") {
    return fileAsset.key;
  }

  const match = fileAsset.variants?.find((v) => v.variant === variant);
  return match?.key ?? fileAsset.key;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { assetId } = await context.params;
    const { searchParams } = new URL(request.url);
    const rawVariant = searchParams.get("variant") ?? "ORIGINAL";
    const variant = rawVariant.toUpperCase();
    /*
     * `?format=json` answers with the resolved URL instead of redirecting to it.
     *
     * The 302 is right for an `<img>`: the browser or the image loader follows
     * it and never thinks about the hop. It is wrong for anything that has to
     * **carry the bearer token**, because the token is on the request to *us*
     * and following the redirect re-sends those headers to R2 — which reads any
     * `Authorization` header as SigV4 and rejects the request outright. That is
     * the failure `lib/asset-viewer.ts` already documents for public URLs, seen
     * from the other side.
     *
     * The mobile audio player is the case that needs this: it is handed the
     * presigned URL directly and sends no headers of ours to storage at all.
     * Authorization is unchanged — every check below runs first, and what comes
     * back is the same URL the redirect would have pointed at.
     */
    const asJson = searchParams.get("format") === "json";

    if (!VALID_VARIANTS.has(variant)) {
      return errorResponse(
        `Invalid variant. Must be one of: ${[...VALID_VARIANTS].join(", ")}`,
        "INVALID_VARIANT",
        422,
      );
    }

    /*
     * Nothing else in this route connects before the lookup below — the
     * principal is only loaded for private files. A fresh serverless instance
     * serving only photo redirects would otherwise queue the query in
     * Mongoose's buffer until it timed out, which is the intermittent 500 on
     * public listing galleries.
     */
    await connectToDatabase();

    const fileAsset = await FileAssetModel.findOne({
      _id: assetId,
      isDeleted: false,
      status: "ACTIVE",
    });

    if (!fileAsset) {
      return errorResponse("File asset not found", "NOT_FOUND", 404);
    }

    let targetUrl: string | null = null;

    if (fileAsset.accessLevel === "PUBLIC") {
      const resolvedKey = resolveVariantKey(fileAsset, variant);
      const publicBase = process.env.R2_PUBLIC_URL;

      if (publicBase) {
        targetUrl = `${publicBase}/${resolvedKey}`;
      }
    }

    /*
     * A registration document between upload and submission. Nobody owns it
     * yet, so no principal can be authorised against it, but the uploader still
     * needs to see what they attached. The claim token from the upload response
     * is the proof. It already lets its holder claim the file, so letting them
     * read it grants nothing more. Once an application claims the file this path
     * closes, and the owner and platform checks below take over.
     */
    const claim = searchParams.get("claim");

    if (
      !targetUrl &&
      claim &&
      fileAsset.kind === "REGISTRATION_DOCUMENT" &&
      !fileAsset.ownerId &&
      isValidDocumentClaimToken(fileAsset._id.toString(), claim)
    ) {
      targetUrl = await getPresignedReadUrl(
        fileAsset.bucket,
        resolveVariantKey(fileAsset, variant),
      );
    }

    if (!targetUrl) {
      const principal = await loadApiPrincipal(request);

      if (!principal) {
        return errorResponse(
          "Authentication required for private assets",
          "UNAUTHENTICATED",
          401,
        );
      }

      // Default-deny. Access is granted by a positive reason, never by the
      // absence of one: the previous form short-circuited on a missing
      // `hostelId`, and since payment proofs never carried one, every
      // authenticated user could read every resident's bank screenshot.
      // An unlabelled asset is now readable by its owner and the platform only.
      const isOwner = fileAsset.ownerId?.toString() === principal.userId;
      const isPlatform = PLATFORM_ROLES.includes(principal.role);
      const isSameHostel =
        Boolean(fileAsset.hostelId) &&
        principal.hostelIds.includes(String(fileAsset.hostelId)) &&
        (!STAFF_ONLY_KINDS.has(fileAsset.kind ?? "") ||
          HOSTEL_STAFF_ROLES.includes(principal.role));

      /*
       * Checked last and only when nothing else already granted access: it is
       * two extra queries, and the overwhelmingly common caller here is the
       * hostel that owns the asset.
       */
      const isProvider =
        !isOwner && !isPlatform && !isSameHostel
          ? await isAssignedProvider(fileAsset, principal.userId)
          : false;

      if (!isOwner && !isPlatform && !isSameHostel && !isProvider) {
        return errorResponse("Access denied", "FORBIDDEN", 403);
      }

      const resolvedKey = resolveVariantKey(fileAsset, variant);
      targetUrl = await getPresignedReadUrl(fileAsset.bucket, resolvedKey);
    }

    if (asJson) {
      return successResponse({ url: targetUrl }, "File URL resolved");
    }

    const redirect = NextResponse.redirect(targetUrl, 302);

    /*
     * A public object's address does not change, because every upload gets a
     * unique key. So browsers, the app's image cache and Vercel's edge may keep
     * this hop for a day, and a gallery of thirteen photos stops costing
     * thirteen function runs and database reads on every view. Signed
     * redirects for private files expire, so they are never cached.
     */
    if (fileAsset.accessLevel === "PUBLIC" && process.env.R2_PUBLIC_URL) {
      redirect.headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
    }

    return redirect;
  } catch (error) {
    return handleRouteError(error);
  }
}
