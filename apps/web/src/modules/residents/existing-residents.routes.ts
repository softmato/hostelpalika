import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import {
  type ApiPrincipal,
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
  joinDecisionSchema,
  joinLinkUpdateSchema,
  scannedExistingResidentSchema,
} from "@/modules/residents/existing-residents.validation";
import {
  addJoinRequest,
  getJoinLink,
  listJoinRequests,
  returnJoinRequest,
  updateJoinLink,
} from "@/modules/residents/resident-join.service";
import { markAdmissionFormAdded } from "@/modules/residents/admission-form.service";
import { cardFromAdmissionForm } from "@/modules/residents/card-from-form";
import {
  linkResidentAccount,
  openResidentLogin,
  type ResidentRecord,
} from "@/modules/residents/resident.service";
import {
  claimAdmissionDocuments,
  claimApplicantPhoto,
  saveResidentDocuments,
} from "@/modules/residents/applicant-photo";
import { sealDetails } from "@/modules/residents/resident-details";
import { hostelStaffScope } from "@/modules/residents/hostel-staff-scope";
import { assertAgentFiledHostel } from "@/modules/team/team.service";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * The existing-residents routes, written once and mounted twice
 * (docs/EXISTING_RESIDENTS.md, item 6): under the hostel's own staff routes, and
 * under the field team's routes for a hostel that agent filed. The only thing
 * that differs between the two is who may ask, and for which hostel.
 */

type RouteContext = { params: Promise<Record<string, string>> };

type Scope = { hostelId: Types.ObjectId; principal: ApiPrincipal };

type Resolve = (request: NextRequest, context: RouteContext) => Promise<Scope>;

const hostelStaff: Resolve = (request) => hostelStaffScope(request);

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
          const { admissionFormId, details, documents, photo, userResidentId, ...row } =
            scannedExistingResidentSchema.parse(await request.json());
          const photoAssetId = photo ? await claimApplicantPhoto(photo, hostelId) : null;
          const scans = documents ? await claimAdmissionDocuments(documents, hostelId) : [];
          const added = await addScannedExistingResident(hostelId, row, userResidentId, principal);
          const detailsData = sealDetails(details);

          if (added.residentId && (detailsData || photoAssetId)) {
            await ResidentModel.updateOne(
              { _id: added.residentId, hostelId },
              { $set: { ...(detailsData ? { detailsData } : {}), ...(photoAssetId ? { photoAssetId } : {}) } },
            );
          }

          if (added.residentId && scans.length) {
            await saveResidentDocuments(new Types.ObjectId(added.residentId), hostelId, scans, principal.userId);
          }

          if (added.residentId && admissionFormId) {
            await markAdmissionFormAdded(hostelId, admissionFormId, new Types.ObjectId(added.residentId), principal);

            // No card: the form's email becomes their login if it had none, and the form their ID card.
            const resident = userResidentId
              ? null
              : await ResidentModel.findById(added.residentId).lean<ResidentRecord | null>();
            let holder = resident?.userId ?? null;

            if (resident && !holder && resident.email) {
              const login = await openResidentLogin(resident.email, `${resident.firstName} ${resident.lastName}`);
              const link = await linkResidentAccount(resident, hostelId, principal, undefined, false, login);

              holder = link.userId ? new Types.ObjectId(link.userId) : null;
            }

            if (holder) {
              await cardFromAdmissionForm(added.residentId, holder);
            }
          }

          return successResponse(added, "Resident added");
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

/**
 * The join link and the requests it brings in — hostel staff only. The field
 * team files the hostel; the people living there are the hostel's to check.
 */
export const hostelStaffJoin = {
  link: {
    GET: async (request: NextRequest, context: RouteContext) => {
      try {
        const { hostelId, principal } = await hostelStaff(request, context);

        return successResponse(await getJoinLink(hostelId, principal), "Join link loaded");
      } catch (error) {
        return handleRouteError(error);
      }
    },
    PATCH: async (request: NextRequest, context: RouteContext) => {
      try {
        const { hostelId, principal } = await hostelStaff(request, context);
        const input = joinLinkUpdateSchema.parse(await request.json());

        return successResponse(await updateJoinLink(hostelId, input, principal), "Join link saved");
      } catch (error) {
        return handleRouteError(error);
      }
    },
  },
  list: {
    GET: async (request: NextRequest, context: RouteContext) => {
      try {
        const { hostelId } = await hostelStaff(request, context);

        return successResponse(await listJoinRequests(hostelId), "Requests loaded");
      } catch (error) {
        return handleRouteError(error);
      }
    },
  },
  one: {
    POST: async (request: NextRequest, context: RouteContext) => {
      try {
        const { hostelId, principal } = await hostelStaff(request, context);
        const { requestId } = await context.params;
        const decision = joinDecisionSchema.parse(await request.json());

        return decision.action === "add"
          ? successResponse(
              await addJoinRequest(hostelId, requestId ?? "", principal, decision.roomNumber),
              "Resident added",
            )
          : successResponse(
              await returnJoinRequest(hostelId, requestId ?? "", decision.reason, principal),
              "Request sent back",
            );
      } catch (error) {
        return handleRouteError(error);
      }
    },
  },
};
