import { Schema, model, models } from "mongoose";

/**
 * A hostel's join link (docs/EXISTING_RESIDENTS.md, "Join link").
 *
 * One per hostel. Staff share it — WhatsApp group, one person, a printed QR —
 * and anybody already living there opens it, signs in with their ID card and
 * says which room they are in and what rent is paid. What they send is a
 * `ResidentApplication`; nobody becomes a resident until staff press Add.
 *
 * `used` counts requests, not sends: an edit or a re-send after "Send back" is
 * the same request and never counts again. When `used` reaches `cap` the link
 * takes no new requests, so a link that leaks into a big group cannot fill the
 * hostel's queue with strangers. "New link" changes `token`, which kills every
 * copy of the old one already shared.
 */
const residentJoinLinkSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    token: { required: true, trim: true, type: String },
    enabled: { default: true, type: Boolean },
    cap: { default: 20, max: 2000, min: 1, required: true, type: Number },
    used: { default: 0, min: 0, type: Number },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

residentJoinLinkSchema.index({ hostelId: 1 }, { unique: true });
residentJoinLinkSchema.index({ token: 1 }, { unique: true });

export const ResidentJoinLinkModel =
  models.ResidentJoinLink || model("ResidentJoinLink", residentJoinLinkSchema);
