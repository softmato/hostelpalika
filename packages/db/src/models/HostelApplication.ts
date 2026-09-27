import { Schema, model, models } from "mongoose";

const hostelApplicationSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    applicantId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    submittedBy: { ref: "User", required: true, type: Schema.Types.ObjectId },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "NEEDS_MORE_INFO"],
      default: "PENDING",
    },
    /**
     * Which desk this application came in at, and the reason the two behave
     * differently.
     *
     * `PUBLIC` is an owner filing for themselves: it queues, a superadmin reads
     * the documents, and the hostel publishes only once the plan is paid for.
     *
     * `TEAM` is one of our own field staff filing on the owner's behalf, having
     * met them and seen the papers. The review this queue exists to perform has
     * already happened in person, so a team application is approved, verified
     * and published on submission, and any shortfall in what was collected
     * becomes a due rather than a barrier.
     *
     * It is stored rather than inferred from `submittedByAgentId` being set,
     * because "who filed it" and "what rules it plays by" are separate facts —
     * an agent who later loses their role must not retroactively turn a
     * published hostel back into a queued one.
     *
     * `BRANCH` is the owner of a Max hostel adding another building under its
     * plan (`hostel-branch.service.ts`). It queues like `PUBLIC`, but only a
     * superadmin approves it, after calling the branch — and it has no plan to
     * pay for, so approval publishes it.
     */
    source: { type: String, enum: ["PUBLIC", "TEAM", "BRANCH"], default: "PUBLIC" },
    /** The field-team member who filed it. Null on a public application. */
    submittedByAgentId: { ref: "User", default: null, type: Schema.Types.ObjectId },
    reviewedBy: { ref: "User", type: Schema.Types.ObjectId },
    reviewedAt: Date,
    rejectionReason: { type: String, trim: true },
    // Superadmin "documents needed" requests. When populated with an unresolved
    // entry the application status is NEEDS_MORE_INFO and the owner is asked to
    // provide the listed documents.
    requestedDocuments: {
      default: [],
      type: [
        {
          _id: false,
          documentType: { required: true, trim: true, type: String },
          note: { trim: true, type: String },
        },
      ],
    },
    infoRequestNote: { type: String, trim: true },
    infoRequestedAt: Date,
    infoRequestedBy: { ref: "User", type: Schema.Types.ObjectId },
    notes: { type: String, trim: true },
    snapshot: { default: {}, type: Schema.Types.Mixed },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

hostelApplicationSchema.index({ hostelId: 1, status: 1 });
hostelApplicationSchema.index({ applicantId: 1, status: 1 });
hostelApplicationSchema.index({ status: 1, createdAt: -1 });
hostelApplicationSchema.index({ submittedByAgentId: 1, createdAt: -1 });

export const HostelApplicationModel =
  models.HostelApplication || model("HostelApplication", hostelApplicationSchema);
