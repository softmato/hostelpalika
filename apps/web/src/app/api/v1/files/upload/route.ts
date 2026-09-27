import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { NextRequest } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse, errorResponse } from "@/lib/api-response";
import {
  type AccessLevel,
  bucketForAccessLevel,
  generateFileKey,
  getR2Client,
} from "@/lib/r2";
import {
  IMAGE_INSPECTION_UNAVAILABLE,
  type ImageInsight,
  inspectImage,
  isInspectableImage,
} from "@/lib/uploads/image-integrity";
import { contentTypeMismatch } from "@/lib/uploads/sniff";
import { hashBytes } from "@/lib/uploads/verify";
import { computePerceptualHash, systemDocumentKind } from "@/modules/finance/evidence";
import { readEvidenceProvenance } from "@/modules/finance/evidence-provenance";
import { FileAssetModel } from "@hostel/db/models/FileAsset";

export const runtime = "nodejs";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const MAX_SIZE = 10 * 1024 * 1024;

function r2Configured() {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_BUCKET_PUBLIC &&
    process.env.R2_BUCKET_PRIVATE
  );
}

export async function POST(request: NextRequest) {
  try {
    const principal = await loadApiPrincipal(request);
    if (!principal) {
      return errorResponse("Authentication required", "UNAUTHENTICATED", 401);
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const accessLevel = (formData.get("accessLevel") as string) ?? "PUBLIC";

    if (!file) {
      return errorResponse("File is required", "VALIDATION_ERROR", 422);
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return errorResponse(
        "File type not allowed. Accepted: JPEG, PNG, WebP, PDF",
        "FILE_TYPE_NOT_ALLOWED",
        422,
      );
    }

    if (file.size > MAX_SIZE) {
      return errorResponse("File size exceeds 10 MB limit", "FILE_TOO_LARGE", 422);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name;
    const mimeType = file.type;
    const sizeBytes = file.size;

    // `file.type` is the browser's guess from the extension, so this door needs
    // the same byte-level check as the presigned one (gap fix 1) — otherwise a
    // renamed binary is simply stored labelled `image/png` here instead.
    const mismatch = contentTypeMismatch(mimeType, buffer);

    if (mismatch) {
      return errorResponse(mismatch, "UPLOAD_CONTENT_MISMATCH", 422);
    }

    let imageInsight: ImageInsight | null = null;

    if (isInspectableImage(mimeType)) {
      const inspection = await inspectImage(buffer);

      // A deployment with no `sharp` binary inspects nothing, and that must not
      // read as "damaged file" to the person uploading — same call as in the
      // presigned route's completion step.
      if (inspection !== IMAGE_INSPECTION_UNAVAILABLE) {
        if (!inspection) {
          return errorResponse(
            "This image could not be opened — it may be damaged or incomplete. Please upload it again.",
            "UPLOAD_IMAGE_UNDECODABLE",
            422,
          );
        }

        imageInsight = inspection;
      }
    }

    let url: string;

    if (r2Configured()) {
      const key = generateFileKey("uploads", fileName);
      const bucket = bucketForAccessLevel(accessLevel as AccessLevel);

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      });

      await getR2Client().send(command);

      // Only a PUBLIC asset has an unsigned URL. Building one for a PRIVATE
      // asset used to produce a link into a bucket that no longer serves it —
      // and, before the split, one that served it permanently and unsigned.
      // Everything else is reached through the authorised read route.
      const publicBase = process.env.R2_PUBLIC_URL;
      url =
        accessLevel === "PUBLIC" && publicBase
          ? `${publicBase.replace(/\/+$/, "")}/${key}`
          : key;

      await FileAssetModel.create({
        storageProvider: "CLOUDFLARE_R2",
        bucket,
        key,
        fileName,
        mimeType,
        sizeBytes,
        accessLevel,
        status: "ACTIVE",
        createdBy: principal.userId,
        ownerId: principal.userId,
        // The bytes passed through this process, so type, size and hash are
        // measured rather than declared — no separate verification leg needed.
        contentHash: hashBytes(buffer),
        imageInsight: imageInsight ?? undefined,
        // Reads the container, not the picture, so it needs no decoder and
        // cannot fail the upload — an unparseable header records nothing.
        provenance: readEvidenceProvenance(buffer) ?? undefined,
        perceptualHash: (await computePerceptualHash(buffer)) ?? undefined,
        systemDocumentKind: (await systemDocumentKind(buffer)) ?? undefined,
        uploadCompletedAt: new Date(),
      });
    } else {
      const uploadDir = join(process.cwd(), "public", "uploads", "hostel-documents");
      if (!existsSync(uploadDir)) {
        await mkdir(uploadDir, { recursive: true });
      }

      // From the checked type, never the client's name: `public/` is served
      // from our own origin, and a PDF named `x.html` would be served as a page.
      const ext = mimeType.split("/")[1];
      const uniqueName = `${crypto.randomUUID()}.${ext}`;
      const filePath = join(uploadDir, uniqueName);
      await writeFile(filePath, buffer);

      url = `/uploads/hostel-documents/${uniqueName}`;
    }

    return successResponse({ url, fileName, mimeType, sizeBytes }, "File uploaded", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
