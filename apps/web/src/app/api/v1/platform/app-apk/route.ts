import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  getPresignedUploadUrl,
  getPublicUrl,
  publicBucket,
  withKeyPrefix,
} from "@/lib/r2";

export const runtime = "nodejs";

/** Extension → content type and folder. The extension is the only switch. */
const KINDS = {
  apk: { contentType: "application/vnd.android.package-archive", folder: "app" },
  mp4: { contentType: "video/mp4", folder: "video" },
  webm: { contentType: "video/webm", folder: "video" },
} as const;

const bodySchema = z.object({
  fileName: z.string().trim().regex(/\.(apk|mp4|webm)$/i, "Choose an .apk, .mp4 or .webm file."),
  size: z.number().int().positive().max(300 * 1024 * 1024, "A file over 300 MB is too big."),
});

/**
 * A presigned PUT straight to the public bucket, for the Android APK and the
 * Register Hostel demo video.
 *
 * Outside the shared upload pipeline on purpose: that pipeline sniffs every
 * file against an image/document allowlist, and an APK or a film is neither.
 * Only a superadmin reaches this, and the URL it returns is what the site
 * config's `apps.androidApkUrl` / `apps.demoVideoUrl` points at once the form
 * is saved.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const { fileName } = bodySchema.parse(await request.json());
    const extension = fileName.split(".").pop()!.toLowerCase() as keyof typeof KINDS;
    const { contentType, folder } = KINDS[extension];
    const stem = fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
    const key = withKeyPrefix(`${folder}/${stem}-${Date.now()}.${extension}`);

    return successResponse(
      {
        contentType,
        uploadUrl: await getPresignedUploadUrl(publicBucket(), key, contentType),
        url: getPublicUrl(key),
      },
      "Upload URL ready",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
