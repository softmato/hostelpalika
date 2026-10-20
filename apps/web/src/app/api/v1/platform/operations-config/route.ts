import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import {
  getOperationsConfig,
  operationsConfigSchema,
  saveOperationsConfig,
} from "@/modules/platform-config/operations-config";
import {
  getPendingSettingChange,
  requestSettingChange,
} from "@/modules/platform-config/setting-change.service";

export const runtime = "nodejs";

/**
 * The operational knobs behind activation, payments, complaints and attendance
 * — separate from the public site config so a website edit can never change how
 * the machinery behaves. Superadmin only (PHASES.md §5.1).
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const [config, pendingQrChange] = await Promise.all([
      getOperationsConfig(),
      getPendingSettingChange("collection-qr"),
    ]);

    return withEtag(request, successResponse({ config, pendingQrChange }, "Operations configuration loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Saves everything except the collection QR at once.
 *
 * The QR decides which account customers' money lands in, so a change to it is
 * held back and only applied from the confirm link emailed to the superadmin —
 * the rest of the form still saves in the same request.
 */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;
    const current = await getOperationsConfig();

    const { collectionQrLabel, collectionQrUrl, ...rest } = body;
    const qrTouched =
      (collectionQrUrl !== undefined && String(collectionQrUrl).trim() !== current.collectionQrUrl) ||
      (collectionQrLabel !== undefined &&
        String(collectionQrLabel).trim() !== current.collectionQrLabel);

    // Validate the rest before any email goes out, so a form that fails sends nothing.
    operationsConfigSchema.parse({ ...current, ...rest });

    // Then the QR request, before the save: if its email cannot be sent the
    // whole request fails and nothing at all has changed.
    const pendingQrChange = qrTouched
      ? await requestSettingChange(
          "collection-qr",
          {
            collectionQrLabel: collectionQrLabel ?? current.collectionQrLabel,
            collectionQrUrl: collectionQrUrl ?? current.collectionQrUrl,
          },
          principal,
        )
      : await getPendingSettingChange("collection-qr");

    const result = await saveOperationsConfig(rest, principal.userId);

    await AuditLogModel.create({
      action: "PLATFORM_OPERATIONS_CONFIG_UPDATED",
      actorId: principal.userId,
      entityId: "operations",
      entityType: "PlatformSetting",
      metadata: { config: result.config },
    });

    return successResponse(
      { ...result, pendingQrChange },
      qrTouched
        ? `Saved. The QR change waits for the confirm link we emailed to ${pendingQrChange?.sentTo}.`
        : "Operations configuration saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
