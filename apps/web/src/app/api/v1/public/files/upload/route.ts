import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { NextRequest } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

import { handleRouteError, successResponse, errorResponse } from "@/lib/api-response";
import { connectToDatabase } from "@/lib/db";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { generateFileKey, getR2Client, privateBucket, publicBucket } from "@/lib/r2";
import { issueDocumentClaimToken } from "@/lib/registration-documents";
import { contentTypeMismatch } from "@/lib/uploads/sniff";
import { FileAssetModel } from "@hostel/db/models/FileAsset";

export const runtime = "nodejs";

/**
 * Unauthenticated, rate-limited uploads for the registration forms, where there
 * is no hostel (and often no account) to scope a presign to.
 *
 * Private by default. A `visibility=private` upload is a registration document
 * (citizenship, licence, PAN): it lands in the private bucket and answers with a
 * `fileAssetId` and a `claimToken`, never a URL. The application that names it
 * claims it, and it is read afterwards through `files/{assetId}/url`. See
 * `lib/registration-documents.ts`.
 *
 * `visibility=public` is for pictures that are meant to be seen: listing photos
 * and the collection QR. It accepts images only, so a PDF or a text file can
 * never be published through here, whatever the client asks for.
 */

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
];

const PUBLIC_TYPES = ["image/jpeg", "image/png", "image/webp"];

const MAX_SIZE = 5 * 1024 * 1024;

function r2Configured(bucketVariable: "R2_BUCKET_PRIVATE" | "R2_BUCKET_PUBLIC") {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env[bucketVariable]
  );
}

export async function POST(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      namespace: "public-file-upload",
    });

    if (rateLimited) {
      return rateLimited;
    }

    // Before the R2 put, so a database that cannot be reached fails the upload
    // instead of leaving an object in storage with no FileAsset row pointing at it.
    await connectToDatabase();

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const visibility = formData.get("visibility") === "public" ? "public" : "private";

    if (!file) {
      return errorResponse("File is required", "VALIDATION_ERROR", 422);
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return errorResponse(
        "File type not allowed. Accepted: JPEG, PNG, WebP, PDF, TXT",
        "FILE_TYPE_NOT_ALLOWED",
        422,
      );
    }

    if (visibility === "public" && !PUBLIC_TYPES.includes(file.type)) {
      return errorResponse(
        "Only JPEG, PNG or WebP images can be published.",
        "FILE_TYPE_NOT_ALLOWED",
        422,
      );
    }

    if (file.size > MAX_SIZE) {
      return errorResponse("File size exceeds 5 MB limit", "FILE_TOO_LARGE", 422);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name;
    const mimeType = file.type;
    const sizeBytes = file.size;

    // `file.type` is the client's claim. The signed-in upload already checks the
    // bytes; this anonymous door needs it more.
    const mismatch = contentTypeMismatch(mimeType, buffer);

    if (mismatch) {
      return errorResponse(mismatch, "UPLOAD_CONTENT_MISMATCH", 422);
    }

    if (visibility === "private") {
      // No disk fallback: `public/uploads` is served to anyone, which is the
      // exposure this branch exists to prevent.
      if (!r2Configured("R2_BUCKET_PRIVATE")) {
        return errorResponse(
          "Document storage is not configured on this deployment.",
          "STORAGE_NOT_CONFIGURED",
          503,
        );
      }

      const bucket = privateBucket();
      const key = generateFileKey("registration-documents", fileName);

      await getR2Client().send(
        new PutObjectCommand({
          Body: buffer,
          Bucket: bucket,
          ContentType: mimeType,
          Key: key,
        }),
      );

      const asset = await FileAssetModel.create({
        accessLevel: "PRIVATE",
        bucket,
        fileName,
        key,
        kind: "REGISTRATION_DOCUMENT",
        mimeType,
        sizeBytes,
        status: "ACTIVE",
        storageProvider: "CLOUDFLARE_R2",
        // The bytes are in hand and were just written, so the upload is
        // complete. Without this the abandoned-upload sweep would delete it.
        uploadCompletedAt: new Date(),
      });
      const fileAssetId = asset._id.toString();

      return successResponse(
        {
          claimToken: issueDocumentClaimToken(fileAssetId),
          fileAssetId,
          fileName,
          mimeType,
          sizeBytes,
        },
        "File uploaded",
        { status: 201 },
      );
    }

    let url: string;

    if (r2Configured("R2_BUCKET_PUBLIC")) {
      const key = generateFileKey("public-uploads", fileName);
      const bucket = publicBucket();

      await getR2Client().send(
        new PutObjectCommand({
          Body: buffer,
          Bucket: bucket,
          ContentType: mimeType,
          Key: key,
        }),
      );

      const publicUrl = process.env.R2_PUBLIC_URL;
      url = publicUrl ? `${publicUrl}/${key}` : key;

      await FileAssetModel.create({
        accessLevel: "PUBLIC",
        bucket,
        fileName,
        key,
        mimeType,
        sizeBytes,
        status: "ACTIVE",
        storageProvider: "CLOUDFLARE_R2",
        uploadCompletedAt: new Date(),
      });
    } else {
      const uploadDir = join(process.cwd(), "public", "uploads", "hostel-photos");
      if (!existsSync(uploadDir)) {
        await mkdir(uploadDir, { recursive: true });
      }

      // From the checked type, never the client's name: `public/` is served
      // from our own origin, and `x.html` sent as image/png would be a page.
      const ext = mimeType.split("/")[1];
      const uniqueName = `${crypto.randomUUID()}.${ext}`;
      const filePath = join(uploadDir, uniqueName);
      await writeFile(filePath, buffer);

      url = `/uploads/hostel-photos/${uniqueName}`;
    }

    return successResponse({ url, fileName, mimeType, sizeBytes }, "File uploaded", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
