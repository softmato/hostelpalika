import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import {
  type ApiPrincipal,
  assertHostelScopedApiAccess,
  requireHostelCapability,
  requireTeamPrincipal,
} from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  addExistingResidents,
  addExistingResidentsFile,
  addScannedExistingResident,
  clearExistingResidents,
  existingResidentsTemplate,
  getExistingResidents,
  saveExistingResidentRows,
} from "@/modules/residents/existing-residents.service";
import {
  existingResidentRowsSchema,
  existingResidentsFileSchema,
  scannedExistingResidentSchema,
} from "@/modules/residents/existing-residents.validation";
import { assertAgentFiledHostel } from "@/modules/team/team.service";

/**
 * The existing-residents routes, written once and mounted twice
 * (docs/EXISTING_RESIDENTS.md, item 6): under the hostel's own staff routes, and
 * under the field team's routes for a hostel that agent filed. The only thing
 * that differs between the two is who may ask, and for which hostel.
 */

type RouteContext = { params: Promise<Record<string, string>> };

type Scope = { hostelId: Types.ObjectId; principal: ApiPrincipal };

type Resolve = (request: NextRequest, context: RouteContext) => Promise<Scope>;

const hostelStaff: Resolve = async (request) => {
  const principal = await requireHostelCapability(request, "registerResidents");
  const requested = request.nextUrl.searchParams.get("hostelId");

  if (requested) {
    assertHostelScopedApiAccess(principal, requested);

    return { hostelId: new Types.ObjectId(requested), principal };
  }

  if (principal.hostelIds.length === 1) {
    return { hostelId: new Types.ObjectId(principal.hostelIds[0]), principal };
  }

  throw Object.assign(new Error("A hostelId is required for this action."), {
    errorCode: "HOSTEL_SCOPE_REQUIRED",
    status: 422,
  });
};

const fieldTeam: Resolve = async (request, context) => {
  const principal = await requireTeamPrincipal(request);
  const { id } = await context.params;
  const hostelId = await assertAgentFiledHostel(principal, id ?? "");

  return { hostelId, principal };
};

function handlers(resolve: Resolve) {
  return {
    list: {
      DELETE: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId } = await resolve(request, context);

          return successResponse(await clearExistingResidents(hostelId), "List cleared");
        } catch (error) {
          return handleRouteError(error);
        }
      },
      GET: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId } = await resolve(request, context);

          return successResponse(await getExistingResidents(hostelId), "List loaded");
        } catch (error) {
          return handleRouteError(error);
        }
      },
      PUT: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId, principal } = await resolve(request, context);
          const { rows } = existingResidentRowsSchema.parse(await request.json());

          return successResponse(
            await saveExistingResidentRows(hostelId, rows, principal),
            "List saved",
          );
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
    add: {
      POST: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId, principal } = await resolve(request, context);

          return successResponse(await addExistingResidents(hostelId, principal), "Residents added");
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
    one: {
      POST: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId, principal } = await resolve(request, context);
          const { userResidentId, ...row } = scannedExistingResidentSchema.parse(await request.json());

          return successResponse(
            await addScannedExistingResident(hostelId, row, userResidentId, principal),
            "Resident added",
          );
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
    file: {
      POST: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId, principal } = await resolve(request, context);
          const { contentBase64 } = existingResidentsFileSchema.parse(await request.json());

          return successResponse(
            await addExistingResidentsFile(hostelId, contentBase64, principal),
            "File read",
          );
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
    template: {
      GET: async (request: NextRequest, context: RouteContext) => {
        try {
          const { hostelId } = await resolve(request, context);
          const { body, fileName } = await existingResidentsTemplate(hostelId);

          return new Response(new Uint8Array(body), {
            headers: {
              "Cache-Control": "private, no-store",
              "Content-Disposition": `attachment; filename="${fileName}"`,
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          });
        } catch (error) {
          return handleRouteError(error);
        }
      },
    },
  };
}

export const hostelStaffExistingResidents = handlers(hostelStaff);
export const fieldTeamExistingResidents = handlers(fieldTeam);
