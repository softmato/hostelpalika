import { Schema, model, models } from "mongoose";

import { ROLE_VALUES } from "@hostel/shared/types/roles";
import { AuthProvider } from "@hostel/shared/types/enums";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true },
    image: { type: String, default: null },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: Date,
    phone: { type: String, trim: true },
    phoneVerifiedAt: Date,
    passwordHash: { type: String, select: false },
    authProvider: {
      type: String,
      enum: Object.values(AuthProvider),
      default: AuthProvider.LOCAL,
    },
    googleId: { type: String, trim: true },
    /**
     * Public, shareable handle for this person's platform-wide resident
     * identity (format `HH-XXXX-XXXX`). A hostel warden types it in — or scans
     * the user's QR — to pull the encrypted profile in UserResidentProfile
     * instead of re-typing every personal detail by hand. Minted lazily the
     * first time the user saves a resident profile, so most accounts have none.
     */
    userResidentId: { type: String, trim: true, uppercase: true },
    role: { type: String, enum: ROLE_VALUES, required: true },
    /**
     * The role this account held immediately before a platform grant took it
     * over, and nothing else.
     *
     * A platform invitation may now land on an address that already belongs to
     * a resident, a warden, a cook or a service provider's public account, and
     * accepting it moves that one account onto the field team. `role` is a
     * single value, so the old one has to be written down somewhere or the
     * grant is a one-way door: removing somebody from the team would leave a
     * former warden sitting on PUBLIC with no way back short of a hand-written
     * database edit.
     *
     * Set on accept, read once by "remove from team", and cleared the moment it
     * is spent — a stale value here would restore a role the account has since
     * been moved off deliberately.
     */
    previousRole: { type: String, enum: ROLE_VALUES },
    mustChangePassword: { type: Boolean, default: false },
    /**
     * The app-lock PIN (4 digits, bcrypt). Unlocks the app beside the
     * fingerprint, and every web portal asks for it before it opens.
     * `lockPinSetAt` is the readable "has a PIN" flag; `lockPinFailures`
     * counts wrong tries, and at 10 only an email code can set a new one.
     */
    lockPinHash: { type: String, select: false },
    lockPinSetAt: { type: Date, default: null },
    lockPinFailures: { type: Number, default: 0 },
    tokenVersion: { type: Number, default: 0 },
    hostelIds: [{ ref: "Hostel", type: Schema.Types.ObjectId }],
    status: {
      type: String,
      enum: ["ACTIVE", "INVITED", "SUSPENDED", "ARCHIVED"],
      default: "ACTIVE",
    },
    lastLoginAt: Date,
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
    isDemoData: { type: Boolean, default: false },
    demoDataLabel: { type: String, trim: true },
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { sparse: true, unique: true });
userSchema.index({ phone: 1 }, { sparse: true, unique: true });
userSchema.index({ googleId: 1 }, { sparse: true, unique: true });
userSchema.index({ userResidentId: 1 }, { sparse: true, unique: true });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ hostelIds: 1, status: 1 });

export const UserModel = models.User || model("User", userSchema);
