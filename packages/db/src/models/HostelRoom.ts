import { Schema, model, models } from "mongoose";

/**
 * One numbered room on one floor (docs/FIELD_FIXES_2026_10.md §3).
 *
 * The room *type* still prices it (the rate card is keyed by `roomType`) and
 * `Hostel.roomConfigurations` still carries the per-type counts the listing
 * shows; this is the floor plan underneath, so a resident can be put in
 * "Room 204, 2nd floor" and a free bed is a real bed in a real room.
 *
 * Free beds are never stored: they are `beds` minus the live residents whose
 * `roomId` is this room, so nothing has to be kept in step.
 */
const hostelRoomSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    /** 0 = ground floor, 1 = first floor… */
    floor: { max: 200, min: -5, required: true, type: Number },
    number: { maxlength: 20, required: true, trim: true, type: String },
    roomType: { required: true, trim: true, type: String },
    beds: { max: 40, min: 1, required: true, type: Number },
    isDeleted: { default: false, type: Boolean },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// One "204" per hostel. Deleted rooms free their number.
hostelRoomSchema.index(
  { hostelId: 1, number: 1 },
  { name: "hostelId_1_number_1_live", partialFilterExpression: { isDeleted: false }, unique: true },
);
hostelRoomSchema.index({ hostelId: 1, floor: 1 });

export const HostelRoomModel = models.HostelRoom || model("HostelRoom", hostelRoomSchema);
