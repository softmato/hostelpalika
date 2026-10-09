import type { NextRequest } from "next/server";

import type { ApiPrincipal } from "@/lib/api-auth";
import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse, errorResponse } from "@/lib/api-response";
import { connectToDatabase } from "@/lib/db";
import {
  isFileAssetKind,
  isFinancialAssetKind,
  isPlatformOnlyAssetKind,
} from "@/lib/file-asset-kinds";
import { validateFileAssetMetadata } from "@/lib/file-assets";
import { Role } from "@/lib/roles";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { bucketForAccessLevel, getPresignedUploadUrl, generateFileKey } from "@/lib/r2";
import {
  ResidentAccessError,
  findCurrentResident,
} from "@/modules/residents/resident-access";

export const runtime = "nodejs";

/**
 * Which hostel an asset belongs to, or null when it genuinely belongs to none
 * (a platform admin's own upload). An explicit `hostelId` must be one the caller
 * can reach; otherwise a caller scoped to exactly one hostel gets that one.
 *
 * A resident is answered from their resident profile first, because that is the
 * hostel `submitClaim` checks a payment proof against (`assertClaimAssetUsable`).
 * The token's `hostelIds` is the account's whole scope, not the resident's
 * tenancy, and it can carry more than one: an account added to a second hostel
 * that never got a profile there kept both. "Exactly one" then resolved to
 * nothing and every proof upload was refused, while the invoice beside it —
 * which goes through `findCurrentResident` — loaded fine.
 *
 * Staff arrive already narrowed to the branch they are working in
 * (`x-hostel-id`, see `activeHostel`), so an owner with branches gets that one.
 */
async function resolveAssetHostelId(principal: ApiPrincipal, requested?: string) {
  if (requested) {
    const allowed =
      principal.role === Role.SUPERADMIN ||
      (principal.allHostelIds ?? principal.hostelIds).includes(requested);

    return allowed ? requested : null;
  }

  if (principal.role === Role.RESIDENT) {
    const resident = await findCurrentResident(principal).catch((error: unknown) => {
      // No live profile is not a failure here — a resident between hostels can
      // still upload a non-financial file, and falls through to the token.
      if (error instanceof ResidentAccessError) return null;
      throw error;
    });

    if (resident) {
      return resident.hostelId.toString();
    }
  }

  return principal.hostelIds.length === 1 ? principal.hostelIds[0] : null;
}

export async function POST(request: NextRequest) {
  try {
    // `require…`, not `load…`: it narrows an owner with branches to the active
    // one. Without it `hostelIds` held both and every receipt upload was refused.
    const principal = await requireApiPrincipal(request);

    const body = (await request.json()) as {
      accessLevel?: "PUBLIC" | "PRIVATE" | "PROTECTED";
      fileName?: string;
      hostelId?: string;
      kind?: string;
      mimeType?: string;
      sizeBytes?: number;
    };

    const {
      fileName,
      hostelId: requestedHostelId,
      kind,
      mimeType,
      sizeBytes,
      accessLevel,
    } = body;

    if (!fileName || !mimeType || !sizeBytes) {
      return errorResponse(
        "fileName, mimeType, and sizeBytes are required",
        "VALIDATION_ERROR",
        422,
      );
    }

    const validation = validateFileAssetMetadata({ mimeType, sizeBytes });

    if (validation) {
      return errorResponse(validation, "FILE_TYPE_NOT_ALLOWED", 422);
    }

    await connectToDatabase();

    // Booking money belongs to the platform: its proofs are never readable by a
    // hostel, so they are never scoped to one — whatever the caller asked for.
    const hostelId = isPlatformOnlyAssetKind(kind)
      ? null
      : await resolveAssetHostelId(principal, requestedHostelId);

    if (requestedHostelId && !hostelId && !isPlatformOnlyAssetKind(kind)) {
      return errorResponse("Access denied", "FORBIDDEN", 403);
    }

    // Money evidence that is not tenant-scoped cannot be authorized on read, so
    // it must never be created. Failing here is loud and fixable; failing on
    // read is a cross-tenant leak.
    if (isFinancialAssetKind(kind) && !hostelId) {
      return errorResponse(
        "A hostelId is required for payment-related uploads.",
        "HOSTEL_SCOPE_REQUIRED",
        422,
      );
    }

    // The bucket follows the access level, not the caller: a PRIVATE asset must
    // land somewhere with no public base URL. The previous form read one env var
    // with a hardcoded `?? "hostelpalika-uploads"` fallback, which on a
    // misconfigured deployment presigned an upload to a bucket that did not
    // exist and failed at the PUT rather than here.
    const resolvedAccessLevel = accessLevel ?? "PRIVATE";
    const bucket = bucketForAccessLevel(resolvedAccessLevel);
    const key = generateFileKey("uploads", fileName);
    const fileAsset = await FileAssetModel.create({
      storageProvider: "CLOUDFLARE_R2",
      bucket,
      key,
      fileName,
      hostelId: hostelId ?? undefined,
      /*
       * Stored, not just checked. The kind decides who may read the bytes back
       * — `files/{assetId}/url` widens a `MAINTENANCE_NOTE` to the provider the
       * job was assigned to and nothing else — and until this line it was
       * inspected here and then thrown away, so no reader could ask.
       *
       * An unrecognised kind is dropped rather than refused: the allowlist is a
       * server concern and a client sending a kind this build has not heard of
       * gets the narrowest treatment, which is exactly what an absent kind
       * already means.
       */
      kind: isFileAssetKind(kind) ? kind : undefined,
      mimeType,
      sizeBytes,
      accessLevel: resolvedAccessLevel,
      status: "ACTIVE",
      createdBy: principal.userId,
      ownerId: principal.userId,
    });

    // No size handed to the signer — see `getPresignedUploadUrl`. The declared
    // `sizeBytes` is checked above and again against the stored object at
    // `/complete`, which is where a wrong one has to fail.
    const presignedUrl = await getPresignedUploadUrl(bucket, key, mimeType);

    return successResponse(
      {
        assetId: fileAsset._id.toString(),
        key,
        presignedUrl,
      },
      "Presigned URL generated",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
