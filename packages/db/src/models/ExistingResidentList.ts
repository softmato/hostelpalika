import { Schema, model, models } from "mongoose";

/**
 * The list of people already living in a hostel when it joins the platform
 * (docs/EXISTING_RESIDENTS.md).
 *
 * Rows here are **not residents yet**. They become `Resident` records only when
 * somebody presses "Add all", so a half-filled list is never billed and never
 * counted against a room's beds. One open list per hostel, shared by the field
 * agent who filed the hostel and the hostel's own staff — the agent can start it
 * with the owner at the counter and the owner can finish it later from the app.
 *
 * Money on a row is what the hostel says is true **today**, not history:
 * `paidTill` is the last month the resident has fully paid, `oldDues` is anything
 * else still owed. Nothing earlier is carried over.
 */

const existingResidentRowSchema = new Schema(
  {
    fullName: { default: "", trim: true, type: String },
    phone: { default: "", trim: true, type: String },
    email: { default: "", lowercase: true, trim: true, type: String },
    roomType: { default: "", trim: true, type: String },
    /** Null means "the hostel's normal rate for this room type". */
    monthlyRent: { default: null, min: 0, type: Number },
    depositPaid: { default: 0, min: 0, type: Number },
    /** BS month key, `2083-05`. Null until somebody fills it in. */
    paidTill: { default: null, trim: true, type: String },
    oldDues: { default: 0, min: 0, type: Number },
    /**
     * Rent already handed over for the oldest month still due — "1 month due,
     * Rs 3,000 of it paid". Comes off that month's bill as its own line.
     */
    partPaid: { default: 0, min: 0, type: Number },
    /** Only for the resident's profile. Never used to bill. */
    joinedDate: { default: null, type: Date },
    /**
     * The resident this row became. Set the moment it is created, so a retry
     * after a failure half-way through skips it instead of hitting its own phone
     * number as a duplicate.
     */
    residentId: { default: null, ref: "Resident", type: Schema.Types.ObjectId },
  },
  { _id: true },
);

const existingResidentListSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    status: {
      default: "OPEN",
      enum: ["OPEN", "ADDED"],
      required: true,
      type: String,
    },
    rows: { default: [], type: [existingResidentRowSchema] },
    /**
     * Held while "Add all" runs, so a double press or a second device cannot add
     * the same people twice. Stale after a few minutes, which is how a run that
     * died with the function is allowed to be retried.
     */
    addingSince: { default: null, type: Date },
    addedAt: { default: null, type: Date },
    addedBy: { ref: "User", type: Schema.Types.ObjectId },
    result: {
      added: { default: 0, type: Number },
      billsRaised: { default: 0, type: Number },
      problems: {
        default: [],
        type: [{ _id: false, message: String, name: String }],
      },
    },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

// One open list per hostel. Finished lists stay as the record of what was added.
existingResidentListSchema.index(
  { hostelId: 1 },
  { partialFilterExpression: { status: "OPEN" }, unique: true },
);
existingResidentListSchema.index({ hostelId: 1, createdAt: -1 });

export const ExistingResidentListModel =
  models.ExistingResidentList ||
  model("ExistingResidentList", existingResidentListSchema);
