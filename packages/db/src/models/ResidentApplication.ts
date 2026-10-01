import { Schema, model, models } from "mongoose";

/**
 * A request to be added as an existing resident, sent by the person themself
 * through their hostel's join link (`ResidentJoinLink`).
 *
 * The person's name, phone and face are their ID card's, read when they send it
 * and again by staff when they check it — never typed here. What they type is
 * only what the card cannot know: the room, and what rent is paid.
 *
 * One request per person per hostel. "Send back" (REJECTED) with a reason lets
 * them fix it and send again; that is the same request, `sends` goes up, and the
 * link's count does not. Add turns it into a resident through the same path as
 * the scan desk's "Add as existing resident", and it stays ADDED as the record.
 */
const residentApplicationSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    linkId: { ref: "ResidentJoinLink", type: Schema.Types.ObjectId },
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    /** Their ID card id, `HH-4K7M-9XQ2` — how staff open the card and its photo. */
    cardId: { required: true, trim: true, type: String },
    /** Snapshots from the card at the last send, for the list. */
    fullName: { required: true, trim: true, type: String },
    phone: { default: "", trim: true, type: String },
    email: { default: "", lowercase: true, trim: true, type: String },
    roomType: { required: true, trim: true, type: String },
    /** BS month key the rent is paid till — the same answer as the scan desk's. */
    paidTill: { required: true, trim: true, type: String },
    partPaid: { default: 0, min: 0, type: Number },
    depositPaid: { default: 0, min: 0, type: Number },
    joinedDate: { default: null, type: Date },
    note: { default: "", maxlength: 300, trim: true, type: String },
    status: {
      default: "PENDING",
      enum: ["PENDING", "REJECTED", "ADDED"],
      required: true,
      type: String,
    },
    rejectReason: { default: "", maxlength: 300, trim: true, type: String },
    sends: { default: 1, min: 1, type: Number },
    sentAt: { default: () => new Date(), type: Date },
    decidedAt: { default: null, type: Date },
    decidedBy: { ref: "User", type: Schema.Types.ObjectId },
    residentId: { default: null, ref: "Resident", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

residentApplicationSchema.index({ hostelId: 1, userId: 1 }, { unique: true });
residentApplicationSchema.index({ hostelId: 1, status: 1, sentAt: -1 });
// The person's own open request, on their app home (`getMyJoinRequest`).
residentApplicationSchema.index({ userId: 1, status: 1 });

export const ResidentApplicationModel =
  models.ResidentApplication || model("ResidentApplication", residentApplicationSchema);
