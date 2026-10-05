import { z } from "zod";

import { hostelRegistrationSchema } from "./hostel-registration.validation";
import { platformHostelCreateSchema } from "./hostel.validation";

const registration = hostelRegistrationSchema.shape;

/** The same property details as registration, with the owner supplied by the session. */
export const branchRequestSchema = platformHostelCreateSchema
  .omit({ ownerId: true })
  .extend({
    contact: z.object({
      phone: z.string().trim().min(7).max(24),
      email: z.string().trim().email().optional(),
    }),
    alternatePhone: registration.alternatePhone,
    cookCount: registration.cookCount,
    landmark: registration.landmark,
    mapLink: registration.mapLink,
    panNumber: registration.panNumber,
    payoutAccount: registration.payoutAccount,
    shortStays: registration.shortStays,
    securityDeposit: registration.securityDeposit,
    totalCapacity: registration.totalCapacity,
    yearEstablished: registration.yearEstablished,
    reuseDocuments: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    const names = new Set<string>();
    input.roomConfigurations.forEach((room, index) => {
      if (names.has(room.roomType.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["roomConfigurations", index, "roomType"],
          message: "Use each room type only once.",
        });
      }
      names.add(room.roomType.toLowerCase());
      if (
        room.rooms < 1 ||
        room.bedsPerRoom < 1 ||
        room.vacantBeds > room.rooms * room.bedsPerRoom
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["roomConfigurations", index],
          message:
            "Enter positive room and bed counts; vacant beds cannot exceed capacity.",
        });
      }
    });
    const beds = input.roomConfigurations.reduce(
      (sum, room) => sum + room.rooms * room.bedsPerRoom,
      0,
    );
    if (input.totalCapacity !== undefined && beds > 0 && input.totalCapacity !== beds) {
      ctx.addIssue({
        code: "custom",
        path: ["totalCapacity"],
        message: `Total capacity is ${input.totalCapacity} beds, but your room counts give ${beds} beds (${input.roomConfigurations.map((room) => `${room.rooms} × ${room.bedsPerRoom} for ${room.roomType}`).join(" + ")}). Set total capacity to ${beds}, or correct the room counts.`,
      });
    }
  });

export type BranchRequestInput = z.infer<typeof branchRequestSchema>;
