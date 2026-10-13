import { Schema, model, models } from "mongoose";

/**
 * A resident asking to move to a free bed in another room of the same hostel
 * (docs/FIELD_FIXES_2026_10.md §3.8). Nothing moves until a warden confirms;
 * confirming re-checks the bed is still free. One open request per resident.
 */
const roomChangeRequestSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    residentId: { ref: "Resident", required: true, type: Schema.Types.ObjectId },
    fromRoomId: { default: null, ref: "HostelRoom", type: Schema.Types.ObjectId },
    toRoomId: { ref: "HostelRoom", required: true, type: Schema.Types.ObjectId },
    note: { maxlength: 200, trim: true, type: String },
    status: {
      default: "PENDING",
      enum: ["PENDING", "APPROVED", "DECLINED", "CANCELLED"],
      type: String,
    },
    declineReason: { maxlength: 200, trim: true, type: String },
    decidedBy: { ref: "User", type: Schema.Types.ObjectId },
    decidedAt: Date,
    requestedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

roomChangeRequestSchema.index(
  { residentId: 1 },
  { name: "residentId_1_pending", partialFilterExpression: { status: "PENDING" }, unique: true },
);
roomChangeRequestSchema.index({ hostelId: 1, status: 1, createdAt: -1 });

export const RoomChangeRequestModel =
  models.RoomChangeRequest || model("RoomChangeRequest", roomChangeRequestSchema);
