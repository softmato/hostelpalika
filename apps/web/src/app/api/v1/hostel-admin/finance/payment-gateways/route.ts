import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  deleteGatewayConfig,
  listGatewayConfigs,
  saveGatewayConfig,
} from "@/modules/finance/gateway/gateway-config.service";
import {
  GATEWAY_PROVIDERS,
  gatewayConfigSaveSchema,
} from "@/modules/finance/gateway/gateway-config.validation";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/**
 * Per-provider gateway setup (target §11.8 and §6.7, plan item 6.1).
 *
 * Its own endpoint rather than fields on the payment profile, because a signing
 * secret must not travel through a general-purpose PATCH that also writes
 * display text. That endpoint is broad and its payload is handled like any
 * other; widening it to carry a secret would make every field added to it later
 * a decision about secrets.
 *
 * Read and write are both `managePaymentProfile`, not `viewPayments` — item 0.5
 * split those apart precisely so the warden who approves proofs cannot change
 * where the money is asked to go. Even the read is restricted here: it lists
 * merchant codes and which keys are installed.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "managePaymentProfile");
    const hostelId = resolveAdminHostelId(
      principal,
      new URL(request.url).searchParams.get("hostelId") ?? undefined,
    );

    return withEtag(request, successResponse(
      { gateways: await listGatewayConfigs(hostelId) },
      "Payment gateways",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

const saveSchema = gatewayConfigSaveSchema.extend({
  hostelId: z.string().optional(),
});

export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "managePaymentProfile");
    const input = saveSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      { gateways: await saveGatewayConfig(hostelId, input, principal) },
      "Payment gateway saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

const deleteSchema = z.object({
  hostelId: z.string().optional(),
  provider: z.enum(GATEWAY_PROVIDERS),
});

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "managePaymentProfile");
    const url = new URL(request.url);
    const input = deleteSchema.parse({
      hostelId: url.searchParams.get("hostelId") ?? undefined,
      provider: url.searchParams.get("provider"),
    });
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      { gateways: await deleteGatewayConfig(hostelId, input.provider, principal) },
      "Payment gateway removed",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
