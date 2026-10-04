# DATABASE.md — Schema & Relationships

Database: **MongoDB**. ODM: **Mongoose**. Schemas live at `packages/db/src/models/`. Models below are written Mongoose-style with TypeScript interfaces.

## Build status (end of Phase 5 — verified 2026-08-02)

`packages/db/src/models/` holds **72 models** — more than are written up below,
because each phase added supporting collections (`EmergencyContact`,
`NoticeReadStatus`, `OtpChallenge`, `FileAsset`, `MaintenanceComment`,
`ReferralReward`, `SOSAlert`, `DeviceToken`, and others) whose shape is
self-evident from the model file. This document covers the ones with a decision
worth recording.

Three names here were **renamed or restructured** during implementation; the
prose in each section is the shipped design:

| In earlier drafts | Shipped as |
|---|---|
| `HostelStaff` | `HostelMember` (capability keys as an array) |
| `PlatformConfig` | `PlatformSetting` (key/value, one doc per section) |
| `Room` + `Bed` collections | `Hostel.roomConfigurations` + `capacitySummary` |

Phase 4 built `AttendanceLog`, `AttendanceAlert`, `ConsentLog`, `CommunityPost`,
`CommunityComment`, `CommunityReaction` and `CommunityReport`. Phase 5 built
`QuestionCallClick` and `NotificationCampaign`.

Not built, with the reason for each:

| Model | Status |
|---|---|
| `NotificationReceipt` | **Superseded — will not be built.** The per-recipient `Notification` row *is* the receipt. Counting rows cannot drift the way a `deliveryStats` counter can. |
| `AccountDeletionRequest` | **Built** (2026-08-02, `TODO.md` B5). Described below; see ARCHITECTURE.md §13 for the four deletion pathways. |
| `Subscription` | **Deliberately outside the pilot.** Platform→hostel billing is manual record-keeping in v1 (ARCHITECTURE.md §6). PRD.md §9.2 still lists it as a platform-owner feature, so it needs a client decision before it is either built or removed from scope. Tracked in `TODO.md` Track B8. |

## Conventions

- All primary keys: `_id ObjectId` (Mongoose default)
- All models: `createdAt: Date`, `updatedAt: Date` (via `timestamps: true`)
- Soft-delete only where explicitly noted (`deletedAt?: Date`); everything else is a hard delete guarded by role checks
- Every hostel-scoped model has a **mandatory, indexed** `hostelId: ObjectId` — this is the tenant-isolation key (see ARCHITECTURE.md §2)
- Money fields: **`Number`**, currency assumed NPR platform-wide (no
  multi-currency in v1). An early draft of this file said `Decimal128 (never
  Number)`, which contradicted RULES.md §6 and every shipped model
  (`Invoice.totalAmount`, `PaymentEvent.amount`, `FeeSchedule.rates[].monthlyAmount`, …).
  Resolved 2026-08-02 in favour of `Number`: NPR amounts at hostel scale are
  whole rupees well inside IEEE-754 exact-integer range, and `Decimal128` would
  force `.toString()` conversions through every service and API response for no
  precision benefit. Never use a `string` for a value that gets arithmetic.
- Enums: TypeScript string literal unions, validated via Mongoose enum

---

## Enums

```typescript
export enum Role {
  SUPERADMIN = 'SUPERADMIN',
  PLATFORM_MODERATOR = 'PLATFORM_MODERATOR',
  HOSTEL_ADMIN = 'HOSTEL_ADMIN',
  WARDEN = 'WARDEN',
  COOK = 'COOK',
  RESIDENT = 'RESIDENT',
  GUARDIAN = 'GUARDIAN',
  PUBLIC = 'PUBLIC',
  // Planned for Phase 6 (PRD.md §8.6) — not in the codebase yet. A
  // SERVICE_PROVIDER role existed once and was folded back into PUBLIC
  // (see LEGACY_ROLE_MAP in packages/shared/src/types/roles.ts); re-adding
  // it now is deliberate, not a resurrection of dead code.
  // SERVICE_PROVIDER = 'SERVICE_PROVIDER',
}

export enum AuthProvider {
  LOCAL = 'LOCAL',
  GOOGLE = 'GOOGLE',
}

export enum HostelStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
}

export enum VerificationStatus {
  UNVERIFIED = 'UNVERIFIED',
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum RoomType {
  ONE_SEATER = 'ONE_SEATER',
  TWO_SEATER = 'TWO_SEATER',
  THREE_SEATER = 'THREE_SEATER',
  FOUR_SEATER = 'FOUR_SEATER',
  DORMITORY = 'DORMITORY',
}

export enum BedStatus {
  AVAILABLE = 'AVAILABLE',
  OCCUPIED = 'OCCUPIED',
  RESERVED = 'RESERVED',
  UNDER_REPAIR = 'UNDER_REPAIR',
}

export enum ResidentStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  MOVED_OUT = 'MOVED_OUT',
  INACTIVE = 'INACTIVE',
}

export enum PaymentStatus {
  UNPAID = 'UNPAID',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
}

export enum PaymentMethod {
  ESEWA = 'ESEWA',
  FONEPAY = 'FONEPAY',
  KHALTI = 'KHALTI',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CASH = 'CASH',
}

export enum ProofVerificationStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum NightStatusValue {
  INSIDE = 'INSIDE',
  OUTSIDE = 'OUTSIDE',
  NOT_VERIFIED = 'NOT_VERIFIED',
  SOS = 'SOS',
}

export enum NoticeCategory {
  GENERAL = 'GENERAL',
  FEE = 'FEE',
  FOOD = 'FOOD',
  RULE = 'RULE',
  EMERGENCY = 'EMERGENCY',
  MAINTENANCE = 'MAINTENANCE',
}

export enum ComplaintCategory {
  FOOD = 'FOOD',
  WATER = 'WATER',
  ROOM = 'ROOM',
  WIFI = 'WIFI',
  PAYMENT = 'PAYMENT',
  CLEANLINESS = 'CLEANLINESS',
  SECURITY = 'SECURITY',
  MAINTENANCE = 'MAINTENANCE',
  OTHER = 'OTHER',
}

export enum ComplaintStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  REJECTED = 'REJECTED',
}

export enum ServiceCategory {
  PLUMBER = 'PLUMBER',
  ELECTRICIAN = 'ELECTRICIAN',
  DOCTOR_CLINIC = 'DOCTOR_CLINIC',
  INTERNET_TECHNICIAN = 'INTERNET_TECHNICIAN',
  CLEANER = 'CLEANER',
  CARPENTER = 'CARPENTER',
  PAINTER = 'PAINTER',
  ROOM_REPAIR = 'ROOM_REPAIR',
  WATER_SUPPLIER = 'WATER_SUPPLIER',
  APPLIANCE_REPAIR = 'APPLIANCE_REPAIR',
  OTHER = 'OTHER',
}

export enum ProviderStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  HIDDEN = 'HIDDEN',
}

export enum MaintenanceStatus {
  PENDING = 'PENDING',
  CONTACTED = 'CONTACTED',
  SCHEDULED = 'SCHEDULED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum InquiryStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  CONVERTED = 'CONVERTED',
  CLOSED = 'CLOSED',
}

export enum QRStatus {
  PENDING = 'PENDING',
  ACTIVATED = 'ACTIVATED',
  EXPIRED = 'EXPIRED',
}

export enum NotificationPriority {
  INFO = 'INFO',
  NORMAL = 'NORMAL',
  URGENT = 'URGENT',
}

export enum NotificationCategory {
  ANNOUNCEMENT = 'ANNOUNCEMENT',
  ALERT = 'ALERT',
  REMINDER = 'REMINDER',
  INFO = 'INFO',
  FOOD_READY = 'FOOD_READY',
  ATTENDANCE = 'ATTENDANCE',
  SYSTEM = 'SYSTEM',
}

export enum LocationZone {
  INSIDE = 'INSIDE',      // 0-50m from hostel (configurable)
  NEARBY = 'NEARBY',      // 51-200m from hostel (configurable)
  OUTSIDE = 'OUTSIDE',    // 201m+ from hostel
  UNKNOWN = 'UNKNOWN',    // Phone off or app closed
}

export enum CommunityPostVisibility {
  PUBLIC = 'PUBLIC',           // Visible to all residents across all hostels
  HOSTEL_ONLY = 'HOSTEL_ONLY', // Visible only to residents of same hostel
}

export enum ResidentType {
  STUDENT = 'STUDENT',
  WORKING_PROFESSIONAL = 'WORKING_PROFESSIONAL',
  OTHER = 'OTHER',
}
```

---

## Core Identity

### User

Single identity collection for every human across every role. See ARCHITECTURE.md §3.2 for the "upgrade in place" rule.

```typescript
interface IUser {
  _id: ObjectId;
  email: string; // unique, lowercase, trimmed
  emailVerified: boolean;
  passwordHash?: string; // nullable for Google-only accounts
  googleId?: string; // unique if set
  authProvider: AuthProvider;
  role: Role;
  mustChangePassword: boolean;
  isActive: boolean;
  tokenVersion: number; // bump to invalidate all refresh tokens
  // Public, shareable handle for the portable resident identity (`HH-XXXX-XXXX`).
  // Minted lazily on the user's first UserResidentProfile save, so most accounts
  // have none. Not personal data on its own — see UserResidentProfile.
  userResidentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>({
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true, 
    trim: true,
    index: true,
  },
  emailVerified: { type: Boolean, default: false },
  passwordHash: { type: String },
  googleId: { type: String, unique: true, sparse: true, index: true },
  authProvider: { 
    type: String, 
    enum: Object.values(AuthProvider), 
    required: true 
  },
  role: { 
    type: String, 
    enum: Object.values(Role), 
    default: Role.PUBLIC,
    index: true,
  },
  mustChangePassword: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true, index: true },
  tokenVersion: { type: Number, default: 0 },
  userResidentId: { type: String, trim: true, uppercase: true },
}, { timestamps: true });

// Indexes
UserSchema.index({ email: 1 });
UserSchema.index({ googleId: 1 }, { sparse: true });
UserSchema.index({ role: 1, isActive: 1 });
UserSchema.index({ userResidentId: 1 }, { sparse: true, unique: true });

export const UserModel = model<IUser>('User', UserSchema);
```

---

### UserResidentProfile

The "fill it once, reuse it everywhere" personal profile behind a user's
`userResidentId` and QR code. See PHASES.md §5A and API.md §18.

**Everything personal is one encrypted blob.** No personal field is stored as a
column, indexed, or queryable — deliberately. The only lookup key is
`User.userResidentId`, which is a random public handle, so a database dump is
useless without `PERSONAL_DATA_ENCRYPTION_KEY`.

```typescript
interface IUserResidentProfile {
  _id: ObjectId;
  userId: ObjectId; // ref User, unique
  // AES-256-GCM envelope: `v1.<iv>.<authTag>.<ciphertext>`, fresh IV per write.
  // Decrypts to the ResidentProfileData payload below.
  encryptedData: string;
  payloadVersion: number; // schema version of the decrypted payload
  completedAt?: Date; // absent until the first successful save
  shareCount: number; // bumped each time a hostel pulls this profile
  lastSharedAt?: Date;
  lastSharedWithHostelId?: ObjectId; // ref Hostel
  sharingEnabled: boolean; // user can switch sharing off without deleting
  createdBy?: ObjectId; // ref User
  updatedBy?: ObjectId; // ref User
  isDeleted: boolean;
  deletedAt?: Date;
  deletedBy?: ObjectId; // ref User
  createdAt: Date;
  updatedAt: Date;
}

// The decrypted shape of `encryptedData`. Never persisted in the clear.
// Every field feeds something that already exists downstream:
interface ResidentProfileData {
  // → Resident
  fullName: string;
  primaryPhone: string;
  primaryEmail: string;      // the account email
  occupation: 'STUDENT' | 'WORKING_PROFESSIONAL' | 'OTHER';
  // → Inquiry, and BOYS/GIRLS/CO_LIVING matching
  gender: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY';
  budgetRange?: string;
  // → SOSAlert + safety handling
  bloodGroup: 'A+'|'A-'|'B+'|'B-'|'AB+'|'AB-'|'O+'|'O-'|'UNKNOWN';
  medicalNotes?: string;
  // → Guardian (email is how the guardian-portal invite is sent)
  guardianName: string;
  guardianRelation: string;
  guardianPhone: string;
  guardianEmail?: string;
  secondGuardianName?: string;
  secondGuardianRelation?: string;
  secondGuardianPhone?: string;
  secondGuardianEmail?: string;
  // → EmergencyContact (falls back to the primary guardian when blank)
  emergencyContactName?: string;
  emergencyContactRelation?: string;
  emergencyContactPhone?: string;
  // → MoveInChecklist.documentsCollected
  governmentIdType?: 'CITIZENSHIP'|'PASSPORT'|'DRIVING_LICENSE'|'STUDENT_ID'|'NATIONAL_ID'|'OTHER';
  governmentIdNumber?: string;
  // → Hostel.food (veg / non-veg service planning)
  dietaryPreference: 'NO_PREFERENCE'|'VEG'|'NON_VEG'|'EGGETARIAN'|'VEGAN';
  // → the "educationInfo" named in PHASES.md §2.1
  institution?: string;
  courseOrDesignation?: string;
  // Supporting detail
  dateOfBirth?: string;      // YYYY-MM-DD; `age` is derived on read, never stored
  alternatePhone?: string;
  backupEmail?: string;      // at most two emails total, must differ from primaryEmail
  permanentAddress?: string;
  city?: string;
  province?: string;
  interests: string[];       // max 12, de-duplicated
}

const UserResidentProfileSchema = new Schema<IUserResidentProfile>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  encryptedData: { type: String, required: true },
  payloadVersion: { type: Number, default: 1 },
  completedAt: { type: Date },
  shareCount: { type: Number, default: 0, min: 0 },
  lastSharedAt: { type: Date },
  lastSharedWithHostelId: { type: Schema.Types.ObjectId, ref: 'Hostel' },
  sharingEnabled: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

UserResidentProfileSchema.index({ userId: 1 }, { unique: true });

export const UserResidentProfileModel =
  model<IUserResidentProfile>('UserResidentProfile', UserResidentProfileSchema);
```

**Deliberately absent:** room, bed, deposit, move-in date. Those are the warden's
call per hostel, not portable facts about a person, and live on `Resident`.

**Key rotation warning:** changing `PERSONAL_DATA_ENCRYPTION_KEY` makes every
stored profile permanently unreadable. There is no re-encryption path yet.

---

## Hostel & Verification

### Hostel

Root document for each tenant.

```typescript
interface INearbyPlace {
  name: string;
  type: 'college' | 'hospital' | 'bus_stop' | 'pharmacy' | 'market' | 'other';
  distance: number; // meters
  coordinates: { lat: number; lng: number };
}

interface IHostel {
  _id: ObjectId;
  ownerId: ObjectId; // ref User
  name: string;
  type: 'boys' | 'girls' | 'co-living';
  description?: string;
  address: string;
  city: string;
  area: string;
  latitude?: number;
  longitude?: number;
  contactPhone: string;
  contactEmail?: string;
  rules?: string;
  facilities: string[]; // ['wifi', 'parking', 'gym', 'laundry', ...]
  facilityDetails?: {
    totalToilets?: number;
    parkingCapacity?: { bikes?: number; cars?: number; };
    hasGarden?: boolean;
    hasCCTV?: boolean;
    hasGenerator?: boolean;
    hasElevator?: boolean;
    hasWaterPurifier?: boolean;
    notes?: string; // additional facility notes
  };
  photos: string[]; // R2 URLs
  status: HostelStatus;
  verificationStatus: VerificationStatus;
  rejectionReason?: string;
  
  // Cached data
  nearbyPlaces: INearbyPlace[];
  nearbyPlacesLastUpdated?: Date;

  // Denormalised running total of de-duplicated public-page visits, so the
  // admin dashboard reads one number instead of aggregating HostelPageView.
  // The event rows remain authoritative for unique/recent breakdowns.
  publicViewCount: number;
  
  // Pricing (monthly per bed)
  rentPerBed?: number; // can vary by room, this is a display value
  
  createdAt: Date;
  updatedAt: Date;
}

const HostelSchema = new Schema<IHostel>({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['boys', 'girls', 'co-living'], required: true },
  description: { type: String },
  address: { type: String, required: true },
  city: { type: String, required: true, index: true },
  area: { type: String, required: true },
  latitude: { type: Number },
  longitude: { type: Number },
  contactPhone: { type: String, required: true, index: true },
  contactEmail: { type: String },
  rules: { type: String },
  facilities: [{ type: String }],
  photos: [{ type: String }],
  status: { 
    type: String, 
    enum: Object.values(HostelStatus), 
    default: HostelStatus.PENDING,
    index: true,
  },
  verificationStatus: { 
    type: String, 
    enum: Object.values(VerificationStatus), 
    default: VerificationStatus.UNVERIFIED 
  },
  rejectionReason: { type: String },
  nearbyPlaces: [{
    name: String,
    type: { type: String, enum: ['college', 'hospital', 'bus_stop', 'pharmacy', 'market', 'other'] },
    distance: Number,
    coordinates: {
      lat: Number,
      lng: Number,
    }
  }],
  nearbyPlacesLastUpdated: { type: Date },
  publicViewCount: { type: Number, default: 0, min: 0 },
  rentPerBed: { type: Number },
}, { timestamps: true });

// Indexes
HostelSchema.index({ status: 1 });
HostelSchema.index({ city: 1, type: 1 });
HostelSchema.index({ contactPhone: 1 }); // for duplicate detection
HostelSchema.index({ latitude: 1, longitude: 1 }); // for geo queries

export const HostelModel = model<IHostel>('Hostel', HostelSchema);
```

### HostelDocument

Verification documents uploaded by hostel owner.

```typescript
interface IHostelDocument {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel
  type: 'citizenship' | 'ownership_proof' | 'lease_agreement' | 'tax_clearance' | 'other';
  fileUrl: string; // R2 URL
  status: VerificationStatus;
  reviewedBy?: ObjectId; // ref User (superadmin/moderator)
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const HostelDocumentSchema = new Schema<IHostelDocument>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  type: { 
    type: String, 
    enum: ['citizenship', 'ownership_proof', 'lease_agreement', 'tax_clearance', 'other'], 
    required: true 
  },
  fileUrl: { type: String, required: true },
  status: { 
    type: String, 
    enum: Object.values(VerificationStatus), 
    default: VerificationStatus.PENDING,
    index: true,
  },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  rejectionReason: { type: String },
}, { timestamps: true });

HostelDocumentSchema.index({ hostelId: 1, status: 1 });

export const HostelDocumentModel = model<IHostelDocument>('HostelDocument', HostelDocumentSchema);
```

### HostelMember

Links a User to a hostel they work for, with per-member capability flags. This is
the model the codebase ships; it supersedes the `HostelStaff` name used in earlier
drafts. One membership row per (hostel, user), so the same person can hold a role
at more than one hostel without duplicating their account.

Permissions are stored as an **array of enabled capability keys** rather than a
boolean-per-flag sub-document: adding a twelfth capability then costs a constant
in `WARDEN_PERMISSION_KEYS` instead of a schema migration across every row.

```typescript
type HostelCapability =
  | 'registerResidents'
  | 'editHostelProfile'
  | 'manageRooms'
  | 'verifyPayments'
  | 'manageFood'
  | 'manageNotices'
  | 'viewComplaints'
  | 'updateComplaints'
  | 'viewNightStatus'
  | 'updateNightStatus'
  | 'manageMaintenance';

interface IHostelMember {
  _id: ObjectId;
  hostelId: ObjectId;  // ref Hostel
  userId: ObjectId;    // ref User
  role: Role;          // HOSTEL_ADMIN | WARDEN | COOK
  permissions: HostelCapability[];   // enabled keys only
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REMOVED';
  createdBy?: ObjectId;
  updatedBy?: ObjectId;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

HostelMemberSchema.index({ hostelId: 1, userId: 1 }, { unique: true });
HostelMemberSchema.index({ hostelId: 1, role: 1, status: 1 });
HostelMemberSchema.index({ userId: 1, status: 1 });

export const HostelMemberModel = model<IHostelMember>('HostelMember', HostelMemberSchema);
```

The canonical key list and the default grant for a new warden live in
`apps/web/src/modules/wardens/warden.validation.ts`. Routes enforce them through
`requireHostelCapability()`, which returns `CAPABILITY_DENIED` (403).
Deactivating a warden sets `status: 'SUSPENDED'` — memberships are never hard
deleted, because audit entries reference them.

---

## Rooms & Beds

Rooms and beds are **not** separate collections. They live on the hostel as
`Hostel.roomConfigurations`, one entry per room type, with a denormalised
`Hostel.capacitySummary` kept in step by the capacity service.

The earlier design gave every physical bed its own document and every resident a
`bedId`. Nepali hostels do not sell a numbered bed — they sell "a place in a four
sharing room", and the warden decides which bed on the day. Modelling per-bed rows
meant a hostel could not be listed until someone had typed in every bed in the
building, and it produced two sources of truth for vacancy that drifted apart.
Room-type level configuration is what admins actually maintain, so it is what is
stored.

```typescript
interface IRoomConfiguration {
  roomType: string;        // 'Single', 'Two Sharing', 'Four Sharing', …
  monthlyRent?: number;    // NPR per bed — authoritative price for this type
  bedsPerRoom?: number;
  rooms?: number;          // how many rooms of this type exist
  vacantBeds?: number;     // remaining vacancy, decremented on admission
  mealInclusion?: 'Included' | 'Not Included' | 'Optional';
}

interface ICapacitySummary {
  totalRooms: number;      // Σ rooms
  totalBeds: number;       // Σ rooms × max(1, bedsPerRoom)
  vacantBeds: number;      // Σ vacantBeds
}
```

`Hostel.roomTypes` stays as a flat string array purely so listing filters have
something indexable; `roomConfigurations` is the authoritative record.

**Vacancy is only ever changed through `modules/hostels/hostel-capacity.service.ts`.**
It owns `claimBedForRoomType()`, `releaseBedForRoomType()`,
`moveBedBetweenRoomTypes()` and `refreshCapacitySummary()`, so that:

- a room type with `vacantBeds === 0` raises `ROOM_TYPE_FULL` (409) instead of
  going negative;
- a failed resident intake gives the bed back rather than leaking vacancy;
- `capacitySummary` is recomputed on every write and never hand-edited.

`Resident` therefore stores `roomType: string`, not `roomId`/`bedId`. The
"one bed, one active resident" rule from the indexing summary is enforced by the
capacity counters rather than by a unique index on `bedId`.

---

## Residents & Guardians

### Resident

```typescript
interface IResident {
  _id: ObjectId;
  hostelId: ObjectId;   // ref Hostel - MANDATORY for tenant isolation
  userId?: ObjectId;    // ref User, set once the account is created/upgraded
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  roomType: string;     // matches Hostel.roomConfigurations[].roomType
  moveInDate: Date;
  depositAmount: number;
  monthlyFee: number;   // recurring fee used when payment records are generated
  residentType: ResidentType;  // STUDENT | WORKING_PROFESSIONAL | OTHER
  status: ResidentStatus;      // PENDING | ACTIVE | SUSPENDED | MOVED_OUT
  createdBy?: ObjectId;
  updatedBy?: ObjectId;
  isDemoData: boolean;
  isDeleted: boolean;   // soft delete
  deletedAt?: Date;
  deletedBy?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// Deletion is soft, so a plain unique index would keep a removed resident's
// phone reserved forever and make re-registering the same person fail with a
// raw E11000. The partial filter scopes uniqueness to residents still on the roll.
ResidentSchema.index(
  { hostelId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
ResidentSchema.index({ hostelId: 1, status: 1 });
ResidentSchema.index({ hostelId: 1, roomType: 1 });
ResidentSchema.index({ userId: 1, status: 1 });

export const ResidentModel = model<IResident>('Resident', ResidentSchema);
```

Guardians and emergency contacts are **not** free-text fields on the resident —
they are their own `Guardian` and `EmergencyContact` documents, created
automatically at intake when a portable profile (Phase 5A) is imported.

### Guardian

```typescript
interface IGuardianAccessPermissions {
  feeStatus: boolean;
  receipts: boolean;
  notices: boolean;
  foodMenu: boolean;
  nightSafety: boolean;
  complaintStatus: boolean; // if true, guardian can see complaint titles/status, not full details
}

interface IGuardian {
  _id: ObjectId;
  userId?: ObjectId; // ref User, nullable until guardian accepts invitation
  residentId: ObjectId; // ref Resident, unique - one guardian per resident
  relation: string; // 'mother', 'father', 'uncle', etc.
  phone: string;
  accessPermissions: IGuardianAccessPermissions;
  invitationToken?: string; // for initial invitation flow
  invitationExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GuardianSchema = new Schema<IGuardian>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true, index: true },
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, unique: true, index: true },
  relation: { type: String, required: true },
  phone: { type: String, required: true },
  accessPermissions: {
    type: {
      feeStatus: { type: Boolean, default: true },
      receipts: { type: Boolean, default: false },
      notices: { type: Boolean, default: true },
      foodMenu: { type: Boolean, default: true },
      nightSafety: { type: Boolean, default: true },
      complaintStatus: { type: Boolean, default: false },
    },
    default: {},
  },
  invitationToken: { type: String, index: true, sparse: true },
  invitationExpiresAt: { type: Date },
}, { timestamps: true });

export const GuardianModel = model<IGuardian>('Guardian', GuardianSchema);
```

---

## QR Activation

```typescript
interface IQRActivation {
  _id: ObjectId;
  residentId: ObjectId; // ref Resident, unique
  code: string; // unique 8-12 char alphanumeric
  qrImageUrl?: string; // R2 URL to generated QR image
  status: QRStatus;
  expiresAt: Date;
  activatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const QRActivationSchema = new Schema<IQRActivation>({
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, unique: true, index: true },
  code: { type: String, required: true, unique: true, index: true },
  qrImageUrl: { type: String },
  status: { 
    type: String, 
    enum: Object.values(QRStatus), 
    default: QRStatus.PENDING,
    index: true,
  },
  expiresAt: { type: Date, required: true, index: true },
  activatedAt: { type: Date },
}, { timestamps: true });

QRActivationSchema.index({ code: 1 });
QRActivationSchema.index({ status: 1, expiresAt: 1 });

export const QRActivationModel = model<IQRActivation>('QRActivation', QRActivationSchema);
```

---

## Payments

Rebuilt in Block 2 of [FINANCE_IMPLEMENTATION_PLAN.md](FINANCE_IMPLEMENTATION_PLAN.md).
`Payment` and `PaymentProof` **no longer exist** — they were deleted in item 2.8.
The section below described a `Payment` shape (`periodMonth`, `amountDue`) that
never matched the shipped code either; the models are now the authority and this
is a map to them, not a second copy.

The old design made one document the invoice, the ledger *and* the balance, with
a mutable `paidAmount` that nothing could verify. The new one separates them:

| Model | File | What it is |
|---|---|---|
| `Invoice` | `packages/db/src/models/Invoice.ts` | What a resident owes for a period. **No `paidAmount`** — if you want one, you want `InvoiceBalance`. Unique on `(hostelId, residentId, period, kind)` over non-void statuses: the double-billing control |
| `PaymentEvent` | `PaymentEvent.ts` | One attempt to pay, and the settlement record when it succeeds. **The only thing that writes money.** Unique `idempotencyKey` platform-wide; unique `(hostelId, provider, providerTxnId)` and `(hostelId, evidenceHash)` are the fraud controls |
| `InvoiceBalance` | `InvoiceBalance.ts` | A cache of `sum(SETTLED CREDIT) − sum(SETTLED DEBIT)`. Treated as a cache: disagreement with the events is a `LEDGER_DRIFT` finding, never a silent overwrite |
| `Receipt` | `Receipt.ts` | One per settled event, **immutable**. A wrong one is voided and reissued; both stay readable |
| `ReceiptCounter` | `ReceiptCounter.ts` | Atomic `$inc` sequences per hostel, keyed `(hostelId, kind, period)`. `kind` is `RECEIPT` or `REFERENCE` |
| `FeeSchedule` | `FeeSchedule.ts` | The rate card, by bed type. Never edited — a change opens a new schedule so historical invoices stay explainable |
| `HostelPaymentProfile` | `HostelPaymentProfile.ts` | How residents pay this hostel: QR, wallet ids, bank account, and `cashApprovalThreshold` |

Invariants enforced at the schema layer rather than by convention:

- **Integrality** — every amount is whole NPR rupees (ADR-1), validated on the
  field, so summing an event log is exact and drift can never be rounding noise.
- **Immutability** — a settled `PaymentEvent`'s `amount`, `direction`,
  `invoiceId` and `confirmation` cannot be rewritten, and neither can a
  `Receipt`'s. Both guards live in `pre('save')` and the update hooks, because
  service-layer enforcement is defeated by one forgotten `updateOne`.
- **`Invoice.totalAmount` must equal the sum of its lines**, checked in
  `pre('validate')` rather than trusted.

`Invoice.legacyPaymentId` is migration bookkeeping — the `Payment` row an invoice
was migrated from, unique so `migrate-finance-ledger.mjs` is safe to re-run.

---

## Attendance / Night Safety

### NightStatusLog

```typescript
interface INightStatusLog {
  _id: ObjectId;
  residentId: ObjectId; // ref Resident
  hostelId: ObjectId; // denormalized
  date: Date; // date only, no time (e.g., 2026-08-15 00:00:00)
  status: NightStatusValue;
  source: 'manual' | 'app' | 'auto'; // how it was set
  overriddenBy?: ObjectId; // ref User (warden who manually overrode)
  overrideReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NightStatusLogSchema = new Schema<INightStatusLog>({
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, index: true },
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  date: { type: Date, required: true },
  status: { 
    type: String, 
    enum: Object.values(NightStatusValue), 
    required: true 
  },
  source: { 
    type: String, 
    enum: ['manual', 'app', 'auto'], 
    required: true 
  },
  overriddenBy: { type: Schema.Types.ObjectId, ref: 'User' },
  overrideReason: { type: String },
}, { timestamps: true });

// Unique constraint: one status per resident per date
NightStatusLogSchema.index({ residentId: 1, date: 1 }, { unique: true });
NightStatusLogSchema.index({ hostelId: 1, date: 1 });
NightStatusLogSchema.index({ hostelId: 1, status: 1, date: 1 });

export const NightStatusLogModel = model<INightStatusLog>('NightStatusLog', NightStatusLogSchema);
```

---

## Food

### FoodRoutine

One document per hostel. The routine repeats every week, so meals are keyed by
day of week and carry no dates — "Friday dinner" is a fact about Fridays. The
optional month end treat lives alongside them rather than as that day's dinner,
which is what used to overwrite it.

```typescript
interface IFoodRoutine {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel - MANDATORY for tenant isolation, unique
  timings: Partial<Record<MealType, string>>; // one timing per meal, all week
  meals: Array<{
    dayOfWeek: 'SUNDAY' | ... | 'SATURDAY';
    mealType: 'BREAKFAST' | 'LUNCH' | 'SNACKS' | 'DINNER';
    items: string[];
    note?: string; // shows as a "special food"
  }>;
  monthEndSpecial?: { items: string[]; note?: string } | null;
  updatedBy?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

FoodRoutineSchema.index({ hostelId: 1 }, { unique: true });
```

Saving is a single upsert of the whole document: a cell the admin cleared is
simply absent from `meals`.

### FoodPhoto

```typescript
interface IFoodPhoto {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel
  date: Date;
  mealType: 'breakfast' | 'lunch' | 'snacks' | 'dinner';
  photoUrl: string; // R2 URL
  uploadedBy: ObjectId; // ref User (hostel admin/warden)
  createdAt: Date;
  updatedAt: Date;
}

const FoodPhotoSchema = new Schema<IFoodPhoto>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  date: { type: Date, required: true, index: true },
  mealType: { 
    type: String, 
    enum: ['breakfast', 'lunch', 'snacks', 'dinner'], 
    required: true 
  },
  photoUrl: { type: String, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

FoodPhotoSchema.index({ hostelId: 1, date: 1, mealType: 1 });

export const FoodPhotoModel = model<IFoodPhoto>('FoodPhoto', FoodPhotoSchema);
```

---

## Notices, Complaints

### Notice

```typescript
interface INotice {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel - MANDATORY for tenant isolation
  title: string;
  body: string;
  category: NoticeCategory;
  isUrgent: boolean;
  targetAudience: 'ALL' | 'RESIDENTS' | 'GUARDIANS'; // who should see/receive this
  createdBy: ObjectId; // ref User (hostel admin/warden)
  createdAt: Date;
  updatedAt: Date;
}

const NoticeSchema = new Schema<INotice>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  category: { 
    type: String, 
    enum: Object.values(NoticeCategory), 
    default: NoticeCategory.GENERAL 
  },
  isUrgent: { type: Boolean, default: false, index: true },
  targetAudience: { 
    type: String, 
    enum: ['ALL', 'RESIDENTS', 'GUARDIANS'], 
    default: 'ALL' 
  },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

NoticeSchema.index({ hostelId: 1, createdAt: -1 });
NoticeSchema.index({ hostelId: 1, isUrgent: 1, createdAt: -1 });

export const NoticeModel = model<INotice>('Notice', NoticeSchema);
```

`targetAudience` was added 2026-08-01 and is load-bearing in two places: the resident fan-out skips
a `GUARDIANS` notice entirely, and the guardian dashboard only queries `ALL`/`GUARDIANS`. Shipped
field name is `content`, not `body`; enum values are SCREAMING_SNAKE like every other enum here.

### Complaint

```typescript
interface IComplaint {
  _id: ObjectId;
  residentId: ObjectId; // ref Resident
  hostelId: ObjectId; // denormalized
  category: ComplaintCategory;
  title: string;
  description: string;
  photoUrl?: string; // R2 URL
  isAnonymous: boolean;
  status: ComplaintStatus;
  slaDueAt: Date;        // set on create from the `operations` setting complaintSlaHours (default 72)
  slaBreachedAt?: Date;  // stamped once by the complaint-SLA cron; its absence is what makes that job idempotent
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintSchema = new Schema<IComplaint>({
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, index: true },
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  category: { 
    type: String, 
    enum: Object.values(ComplaintCategory), 
    required: true 
  },
  title: { type: String, required: true, trim: true },
  description: { type: String, required: true },
  photoUrl: { type: String },
  isAnonymous: { type: Boolean, default: false },
  status: { 
    type: String, 
    enum: Object.values(ComplaintStatus), 
    default: ComplaintStatus.PENDING,
    index: true,
  },
  slaDeadline: { type: Date, index: true },
  resolvedAt: { type: Date },
}, { timestamps: true });

ComplaintSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
ComplaintSchema.index({ residentId: 1, createdAt: -1 });

export const ComplaintModel = model<IComplaint>('Complaint', ComplaintSchema);
```

### ComplaintUpdate

```typescript
interface IComplaintUpdate {
  _id: ObjectId;
  complaintId: ObjectId; // ref Complaint
  authorId: ObjectId; // ref User (admin/warden/resident)
  authorRole: Role; // to display "Admin replied" vs "Resident replied"
  message: string;
  statusChange?: ComplaintStatus; // if this update changed the status
  createdAt: Date;
  updatedAt: Date;
}

const ComplaintUpdateSchema = new Schema<IComplaintUpdate>({
  complaintId: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, index: true },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  authorRole: { 
    type: String, 
    enum: Object.values(Role), 
    required: true 
  },
  message: { type: String, required: true },
  statusChange: { type: String, enum: Object.values(ComplaintStatus) },
}, { timestamps: true });

ComplaintUpdateSchema.index({ complaintId: 1, createdAt: 1 });

export const ComplaintUpdateModel = model<IComplaintUpdate>('ComplaintUpdate', ComplaintUpdateSchema);
```

---

## Ratings

### RatingReview

All seven categories shipped 2026-08-01 (`roomRating`, `locationRating` and `managementRating` were
added then). Only `overallRating` is required — a resident can rate their stay without scoring every
dimension, and the public per-category averages skip the reviews that left a category blank rather
than counting them as zero.

```typescript
{
  hostelId: ObjectId;    // ref Hostel
  residentId: ObjectId;  // ref Resident
  userId: ObjectId;      // ref User
  overallRating: number;         // 1-5, required
  foodRating?: number;           // 1-5
  cleanlinessRating?: number;    // 1-5
  safetyRating?: number;         // 1-5 — surfaced publicly as "Security"
  roomRating?: number;           // 1-5
  locationRating?: number;       // 1-5
  managementRating?: number;     // 1-5
  comment?: string;
  status: 'VISIBLE' | 'HIDDEN';  // moderated by superadmin
  hiddenAt?: Date;
  hiddenBy?: ObjectId;           // ref User
}

// One review per resident per hostel. Re-submitting updates it rather than 409ing.
RatingReviewSchema.index({ hostelId: 1, residentId: 1 }, { unique: true });
RatingReviewSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
```

Public reads (`listPublicHostelReviews`) go through a separate serializer that returns the reviewer
as a first name plus an initial and an `isVerifiedResident` flag — never the resident or user id.
The moderation reason lives in `ReviewModerationLog`, not on the review itself.

> Deviations: `*Rating` field suffixes to match the API payload; a `status` enum instead of
> `isHidden`, consistent with every other moderatable record; `security` is stored as
> `safetyRating` (renaming it now would need a migration for no behavioural gain).

---

## Move-in / Move-out

### MoveInChecklist

```typescript
interface IMoveInChecklistItem {
  item: string; // 'ID copy collected', 'Room photos taken', 'Key issued', etc.
  checked: boolean;
  checkedAt?: Date;
  checkedBy?: ObjectId; // ref User
}

interface IMoveInChecklist {
  _id: ObjectId;
  residentId: ObjectId; // ref Resident, unique
  hostelId: ObjectId; // denormalized
  items: IMoveInChecklistItem[];
  rulesAcceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MoveInChecklistSchema = new Schema<IMoveInChecklist>({
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, unique: true, index: true },
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  items: [{
    item: { type: String, required: true },
    checked: { type: Boolean, default: false },
    checkedAt: { type: Date },
    checkedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  }],
  rulesAcceptedAt: { type: Date },
}, { timestamps: true });

export const MoveInChecklistModel = model<IMoveInChecklist>('MoveInChecklist', MoveInChecklistSchema);
```

### MoveOutChecklist

```typescript
interface IMoveOutChecklistItem {
  item: string;
  checked: boolean;
  checkedAt?: Date;
  checkedBy?: ObjectId; // ref User
}

interface IMoveOutChecklist {
  _id: ObjectId;
  residentId: ObjectId; // ref Resident, unique
  hostelId: ObjectId; // denormalized
  items: IMoveOutChecklistItem[];
  pendingFeeChecked: boolean;
  damageNotes?: string;
  itemsReturned: boolean;
  depositRefund?: number;
  exitDate?: Date;
  finalReceiptUrl?: string; // R2 URL
  createdAt: Date;
  updatedAt: Date;
}

const MoveOutChecklistSchema = new Schema<IMoveOutChecklist>({
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, unique: true, index: true },
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  items: [{
    item: { type: String, required: true },
    checked: { type: Boolean, default: false },
    checkedAt: { type: Date },
    checkedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  }],
  pendingFeeChecked: { type: Boolean, default: false },
  damageNotes: { type: String },
  itemsReturned: { type: Boolean, default: false },
  depositRefund: { type: Number },
  exitDate: { type: Date },
  finalReceiptUrl: { type: String },
}, { timestamps: true });

export const MoveOutChecklistModel = model<IMoveOutChecklist>('MoveOutChecklist', MoveOutChecklistSchema);
```

---

## Service Providers & Maintenance

### ServiceProvider

```typescript
interface IServiceProvider {
  _id: ObjectId;
  name: string;          // shipped as `fullName`
  phone: string;
  /**
   * Optional. Added 2026-08-02 so the §6.1/§6.2/§6.3 emails in EMAIL_SYSTEM.md
   * could be implemented at all — before it existed the directory collected no
   * address, so "registration received / approved / rejected" had no recipient.
   * Still optional on purpose: many local tradespeople have no working mailbox
   * and the directory is reachable by phone. A provider without one is fully
   * usable, just never emailed.
   */
  email?: string;
  category: ServiceCategory;
  area: string; // city/locality
  availability: string; // 'Weekdays', '24/7', 'On call', etc.
  description?: string;
  photoUrl?: string; // R2 URL
  documentUrl?: string; // R2 URL (ID proof)
  status: ProviderStatus;
  reviewedBy?: ObjectId; // ref User (superadmin/moderator)
  reviewedAt?: Date;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceProviderSchema = new Schema<IServiceProvider>({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, index: true },
  category: { 
    type: String, 
    enum: Object.values(ServiceCategory), 
    required: true,
    index: true,
  },
  area: { type: String, required: true, index: true },
  availability: { type: String },
  description: { type: String },
  photoUrl: { type: String },
  documentUrl: { type: String },
  status: { 
    type: String, 
    enum: Object.values(ProviderStatus), 
    default: ProviderStatus.PENDING,
    index: true,
  },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  rejectionReason: { type: String },
}, { timestamps: true });

ServiceProviderSchema.index({ category: 1, area: 1, status: 1 });

export const ServiceProviderModel = model<IServiceProvider>('ServiceProvider', ServiceProviderSchema);
```

#### Planned for Phase 6 — app account + job marketplace (PRD.md §8.6/§9.6, not yet built)

Today a `ServiceProvider` is a directory listing with no account behind it — registration is anonymous and approval only sends an email. The mobile job-marketplace flow needs the listing linked to a real, logged-in account:

```typescript
interface IServiceProvider {
  // ...existing fields above, plus:

  /**
   * The applicant's account, captured at registration because registration
   * now requires signing in with Google first (PRD.md §8.6). Absent on any
   * provider that predates this flow. On approval, THIS user's role is
   * upgraded PUBLIC → SERVICE_PROVIDER (§8.3's account-upgrade pattern) —
   * unlike the Cook Portal, which mints a synthetic per-hostel account
   * because a shared kitchen has no one real mailbox.
   */
  userId?: ObjectId; // ref User

  /**
   * Stable public code minted the moment the application is submitted (same
   * alphabet and collision-retry approach as generateResidentId() in
   * resident-identity.service.ts, prefixed to be visually distinguishable
   * from a resident ID at a glance) — NOT deferred to approval. The card
   * renders immediately at registration, status and all, so it exists
   * before `providerCode` would otherwise be available.
   */
  providerCode?: string;
}
```

The ID card is a single object that exists for the lifetime of the application, not
something that appears on approval — it renders right after the form is submitted,
carrying a visible status tag (`PENDING_APPROVAL`/`REJECTED`/`HIDDEN`/`INACTIVE`), and
the tag simply clears once `status` flips to `APPROVED`. **The card's own display is
never the authority for whether someone may work** — the hostel-admin "scan provider
card" lookup re-reads live `status` from the database on every scan, so a pending or
rejected provider's code can never resolve as valid no matter what the card shows
(the same principle as `lookupResidentProfile` re-checking `sharingEnabled` live
rather than trusting anything client-side).

`ServiceProviderApplication` and `ServiceProviderDocument` (the review-queue snapshot and uploaded-document rows created alongside `ServiceProvider` in `registerPublicServiceProvider`) are unaffected by this change.

### MaintenanceRequest

```typescript
interface IMaintenanceRequest {
  _id: ObjectId;
  hostelId: ObjectId;      // ref Hostel - MANDATORY for tenant isolation
  providerId?: ObjectId;   // ref ServiceProvider, set when contacted
  // Free text ("Room 204", "2nd floor bathroom"). There are no Room or Bed
  // records to reference — the hostel tracks room types and counts only.
  location?: string;
  category: ServiceCategory;
  title: string;
  description?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  status: MaintenanceStatus;  // PENDING | CONTACTED | SCHEDULED | COMPLETED | CANCELLED
  scheduledFor?: Date;
  completedAt?: Date;
  costNote?: string;       // informal tracking, not binding
  remarks?: string;
  requestedBy: ObjectId;   // ref User (hostel admin/warden)
  createdBy?: ObjectId;
  updatedBy?: ObjectId;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

MaintenanceRequestSchema.index({ hostelId: 1, status: 1, category: 1 });
MaintenanceRequestSchema.index({ hostelId: 1, providerId: 1, createdAt: -1 });

export const MaintenanceRequestModel =
  model<IMaintenanceRequest>('MaintenanceRequest', MaintenanceRequestSchema);
```

Per-request discussion lives in `MaintenanceComment`, and the status trail in
`MaintenanceHistory`, rather than being embedded here.

#### Planned for Phase 6 — job broadcast + claim (PRD.md §8.6/§9.6, not yet built)

Today `providerId` is only ever set by a hostel admin hand-picking a provider — there is no "open to whoever gets there first" state. Broadcasting is additive, not a new `status` value, so a claimed broadcast still flows through the existing PENDING → CONTACTED → SCHEDULED → COMPLETED/CANCELLED lifecycle unchanged:

```typescript
interface IMaintenanceRequest {
  // ...existing fields above, plus:

  /** True while the request is open for any matching approved provider to claim. */
  broadcast: boolean; // default false
  broadcastAt?: Date;

  /**
   * Set the instant a provider claims a broadcast request. Distinguishes
   * "picked by the admin" (providerId set, claimedAt absent) from "claimed
   * off the feed" (both set) for reporting, without a separate status.
   */
  claimedAt?: Date;

  /** The hostel-admin "scan provider card" check-in on arrival (PRD.md §9.6). */
  checkedInAt?: Date;
  checkedInBy?: ObjectId; // ref User (the hostel admin who scanned the card)
}
```

**Claiming is a single atomic update, not read-then-write** — the same shape as `mintResidentId()`'s collision retry in `resident-identity.service.ts`: `findOneAndUpdate({ _id, broadcast: true, providerId: null }, { $set: { providerId, status: 'CONTACTED', broadcast: false, claimedAt: now } })`. Whichever request reaches Mongo first gets a match and the update; every later request matches zero documents and reports "already claimed" instead of overwriting the winner. Notifying providers when a request is broadcast, and dropping it from every other provider's feed once claimed, follow the same push-notification path already used for other roles (MOBILE_STATUS.md's push-delivery gap applies here too — today that would land as an in-app `Notification` only).

## Inquiries, Referral, Notifications, Subscriptions

### Inquiry

```typescript
interface IInquiry {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel
  name: string;
  phone: string;
  email?: string;
  message?: string;
  status: InquiryStatus;
  followedUpAt?: Date;
  convertedToResidentId?: ObjectId; // ref Resident, if converted
  createdAt: Date;
  updatedAt: Date;
}

const InquirySchema = new Schema<IInquiry>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true },
  email: { type: String, trim: true, lowercase: true },
  message: { type: String },
  status: { 
    type: String, 
    enum: Object.values(InquiryStatus), 
    default: InquiryStatus.NEW,
    index: true,
  },
  followedUpAt: { type: Date },
  convertedToResidentId: { type: Schema.Types.ObjectId, ref: 'Resident' },
}, { timestamps: true });

InquirySchema.index({ hostelId: 1, status: 1, createdAt: -1 });

export const InquiryModel = model<IInquiry>('Inquiry', InquirySchema);
```

### HostelPageView

One row per visit to a hostel's **public** detail page (`/hostels/{slug}`). Two
consumers, which is why the raw events are kept rather than only a counter:

1. The hostel admin dashboard — "how many people looked at my listing", plus
   unique visitors and a 30-day figure.
2. The resident-identity prompt — a visitor who has viewed hostels 3+ times is
   clearly room-hunting, which is when we offer the fill-once profile
   (see API.md §18.3).

Writes are **de-duplicated per visitor per hostel within 30 minutes**, so a page
refresh or a back-navigation does not inflate the count.

```typescript
interface IHostelPageView {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel
  userId: ObjectId | null; // ref User; null for signed-out visitors
  // Opaque per-browser id from the httpOnly `hh_visitor` cookie.
  // Not personal data — it identifies a browser, not a person.
  visitorKey: string;
  referrer?: string; // truncated to 300 chars
  userAgent?: string; // SHA-256 prefix, never the raw string
  createdAt: Date; // no updatedAt — these rows are immutable
}

const HostelPageViewSchema = new Schema<IHostelPageView>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  visitorKey: { type: String, required: true, index: true },
  referrer: { type: String, trim: true },
  userAgent: { type: String, trim: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

HostelPageViewSchema.index({ hostelId: 1, createdAt: -1 });
HostelPageViewSchema.index({ hostelId: 1, visitorKey: 1, createdAt: -1 }); // dedupe window
HostelPageViewSchema.index({ userId: 1, createdAt: -1 });
HostelPageViewSchema.index({ visitorKey: 1, createdAt: -1 }); // prompt threshold

export const HostelPageViewModel =
  model<IHostelPageView>('HostelPageView', HostelPageViewSchema);
```

`Hostel.publicViewCount` is the denormalised running total, incremented in the
same request. The admin dashboard reads that single number instead of
aggregating this collection; the event rows stay authoritative for the
unique-visitor and recent-traffic breakdowns.

**Growth note:** this collection is append-only and unbounded. The 30-minute
dedupe keeps it proportional to real sessions rather than page loads, but a TTL
or periodic roll-up is worth adding before the platform carries serious traffic.

---

### Referral / ReferralCode / ReferralReward

The draft folded "a resident's code" and "a person they referred" into one
document. As built these are three collections, because one code produces many
referrals and a reward has its own lifecycle:
[`Referral.ts`](../packages/db/src/models/Referral.ts),
[`ReferralCode.ts`](../packages/db/src/models/ReferralCode.ts),
[`ReferralReward.ts`](../packages/db/src/models/ReferralReward.ts).

```typescript
// One per resident, per hostel. Minted lazily on first dashboard visit.
ReferralCode {
  hostelId, residentId, userId;
  code: string;              // unique, e.g. HH12341234
  status: 'ACTIVE' | 'INACTIVE';
  joinedCount: number;       // referees who registered
  convertedCount: number;    // referees whose first payment was verified (Phase 5)
  rewardCount: number;
}

// One per referred person.
Referral {
  hostelId, referralCodeId, referrerResidentId;
  inquiryId?, joinedResidentId?;
  name, phone, email?, message?;
  status: 'INQUIRY_CREATED' | 'JOINED' | 'REWARDED' | 'CANCELLED';
  confirmedAt?, confirmedBy?;
  // Phase 5. Kept as its own flag rather than a `status` value so it can be
  // true while the reward is still PENDING, APPROVED or already PAID.
  converted: boolean;        // default false
  convertedAt?: Date;
  convertedPaymentId?: ObjectId;  // ref Payment
  isDeleted: boolean;
}
```

Indexes: `{ hostelId, status, createdAt }`, `{ hostelId, phone }`,
`{ referrerResidentId, status }`, and `{ hostelId, joinedResidentId, converted }`
— the last one is the conversion lookup run on every verified payment.

**Who sets `converted`.** Only `markReferralConverted`, called from
`approveClaim` (`modules/finance/review.service.ts`) after the money is credited. The update filter carries
`converted: { $ne: true }`, so a second verified payment for the same resident
matches nothing and the counter cannot drift. It swallows its own failures: the
payment is already verified by then, and referral bookkeeping must not turn a
successful verification into a failed request.

`Referral.rewardApplied` from the draft is not a field — a reward is a
`ReferralReward` row with its own `status` (`PENDING` → `APPROVED` → `PAID`), so
the amount, type and payout note live with it instead of a bare boolean.

### Notification

↔ **Superseded by the as-built definition** under "Notifications & Push
Messaging" below, which this earlier draft predates. Differences worth naming:
the shipped model uses `category` (not `type`), derives read state from
`readAt` (there is no `isRead` boolean), and adds `campaignId`, `priority` and
`deliveredAt` in Phase 5.

### Subscription

```typescript
interface ISubscription {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel
  plan: string; // 'free', 'basic', 'premium'
  amount: number;
  status: 'active' | 'expired' | 'pending';
  periodStart: Date;
  periodEnd: Date;
  paidAt?: Date;
  proofUrl?: string; // R2 URL, manual payment proof
  verifiedBy?: ObjectId; // ref User (superadmin)
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  plan: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['active', 'expired', 'pending'], 
    default: 'pending',
    index: true,
  },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true, index: true },
  paidAt: { type: Date },
  proofUrl: { type: String },
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: { type: Date },
}, { timestamps: true });

SubscriptionSchema.index({ hostelId: 1, periodEnd: 1 });

export const SubscriptionModel = model<ISubscription>('Subscription', SubscriptionSchema);
```

---

## Platform Config & Audit

### PlatformSetting

Platform-owner-editable configuration, shipped as a **key/value collection**
rather than the single `PlatformConfig` singleton earlier drafts described. One
document per section, `value` deliberately `Mixed`.

The split matters for blast radius: editing website copy and changing how the
activation/payment machinery behaves are different privileges and different
review bars, so they are different documents. A bad hero-copy save cannot alter
QR expiry.

```typescript
interface IPlatformSetting {
  _id: ObjectId;
  key: string;    // unique — the section name
  value: unknown; // Mixed; validated by that section's zod schema before write
  updatedBy?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

PlatformSettingSchema.index({ key: 1 }, { unique: true });

export const PlatformSettingModel =
  model<IPlatformSetting>('PlatformSetting', PlatformSettingSchema);
```

**Keys in use**

| Key | Owner | Contents |
|---|---|---|
| `operations` | `modules/platform-config/operations-config.ts` | `qrActivationExpiryDays`, `paymentReminderDaysBefore`, `receiptNumberPrefix`, `foodReadyCooldownMinutes`, `sendNoticeEmails`, `sendPaymentEmails` |
| `hero`, `identity`, `stats`, `trustPoints`, `features`, `facilities`, `locations`, `pricing`, `legal`, `social`, `announcement` | `modules/platform-config/site-config.*` | Public website content, one document per section |

Validation lives with the section's zod schema in the web app, never in the
schema — the collection only persists an already-validated shape. Reads never
throw: a missing or malformed document falls back to the shipped defaults,
because callers are on paths (activation, payment reminders) that must not fail
over a configuration read.

### AuditLog

```typescript
interface IAuditLog {
  _id: ObjectId;
  actorId?: ObjectId; // ref User, nullable for system actions
  action: string; // 'role_upgrade', 'hostel_approved', 'payment_verified', etc.
  entityType: string; // 'User', 'Hostel', 'Payment', etc.
  entityId: string; // stringified ObjectId of the affected entity
  metadata?: Record<string, any>; // before/after values, reason, etc.
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>({
  actorId: { type: Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true, index: true },
  entityType: { type: String, required: true, index: true },
  entityId: { type: String, required: true, index: true },
  metadata: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true },
});

AuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
AuditLogSchema.index({ actorId: 1, createdAt: -1 });

export const AuditLogModel = model<IAuditLog>('AuditLog', AuditLogSchema);
```

---

## Indexing Strategy Summary

- Every hostel-scoped collection is indexed on `hostelId` — this is what makes tenant-scoped queries fast
- `User.email` and `User.googleId` are unique — enables the account-upgrade logic in ARCHITECTURE.md §3.2
- `Resident` has a unique `(hostelId, phone)` index with `partialFilterExpression: { isDeleted: false }` — one active registration per phone number per hostel, while still letting a removed resident be re-registered later
- `RatingReview` has a unique compound index on `(residentId, hostelId)` — enforces "one review per resident per hostel"
- All timestamp-based queries (notices, complaints, payments) have compound indexes including `createdAt` or `dueDate` for efficient sorting
- `User.userResidentId` is unique (sparse) — it is the single lookup key for a portable resident profile, and sparse because most accounts never create one
- `UserResidentProfile` is indexed **only** on `userId`; no personal field is indexed, because every one of them lives inside the encrypted blob
- `HostelPageView` carries `(hostelId, visitorKey, createdAt)` for the 30-minute dedupe check and `(visitorKey, createdAt)` for the profile-prompt threshold — both are per-request reads on the public detail page, so they must not table-scan

---

## Notifications & Push Messaging

### Notification (as built)

One row **per recipient** — it is both the feed entry and the delivery receipt.
[`packages/db/src/models/Notification.ts`](../packages/db/src/models/Notification.ts).

```typescript
{
  userId: ObjectId;            // ref User — the recipient
  hostelId?: ObjectId;         // ref Hostel
  title: string;
  body: string;
  category: string;            // 'PAYMENT' | 'COMPLAINT' | 'ANNOUNCEMENT' | …
  channel: 'IN_APP' | 'PUSH' | 'EMAIL' | 'SMS';   // default IN_APP
  data: Record<string, unknown>;

  // Phase 5
  campaignId?: ObjectId;       // ref NotificationCampaign — null for system alerts
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';  // default NORMAL
  deliveredAt?: Date;          // reached the feed (in-app: written)
  readAt?: Date;               // opened

  status: 'QUEUED' | 'SENT' | 'FAILED';
  createdBy?, updatedBy?: ObjectId;
}
```

Indexes: `{ userId, readAt, createdAt }`, `{ hostelId, status }`,
`{ campaignId, readAt }` — the last is what delivery stats aggregate over.

### NotificationCampaign

One row per **authored broadcast** (PHASES.md §5.1).
[`packages/db/src/models/NotificationCampaign.ts`](../packages/db/src/models/NotificationCampaign.ts).

```typescript
{
  hostelId?: ObjectId;         // null for a platform-wide campaign
  title: string;
  body: string;
  category: string;            // default 'ANNOUNCEMENT'
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  audience: 'ALL' | 'RESIDENTS' | 'GUARDIANS' | 'SPECIFIC';
  residentIds: ObjectId[];     // used when audience = SPECIFIC
  hostelIds: ObjectId[];       // platform campaigns may target a subset
  scope: 'HOSTEL' | 'PLATFORM';
  scheduledFor?: Date;         // absent = send now, in the same request
  sentAt?: Date;
  status: 'SCHEDULED' | 'SENT' | 'CANCELLED' | 'FAILED';
  recipientCount: number;      // written at dispatch
  failureReason?: string;
  createdBy?, updatedBy?: ObjectId;
}
```

Indexes: `{ hostelId, createdAt }`, `{ scope, createdAt }`, and
`{ status, scheduledFor }` — the dispatch cron's only query.

**Why a campaign and receipts rather than one document with a `deliveryStats`
counter** (the draft's shape): a counter has to be kept in step with the rows it
counts, and drifts the first time a write half-fails. Counting the receipts
cannot drift, and it stays right when someone opens a months-old notification.

### EmailPreference

Which optional emails an **address** has turned off (EMAIL_SYSTEM.md, "Per-person
opt-out"). Keyed by address rather than account, because a resident can be
mailed with no login.
[`packages/db/src/models/EmailPreference.ts`](../packages/db/src/models/EmailPreference.ts).

```typescript
{
  email: string;          // lower-cased, unique
  mutedTopics: string[];  // EmailTopic values; no row = everything on
}
```

Indexes: `{ email }` unique.

**Why `NotificationReceipt` was not built.** The per-recipient `Notification`
row already carries `campaignId`, `deliveredAt` and `readAt` — a separate
receipt collection would duplicate every row for no extra fact. Push-specific
per-device receipts may justify one in Phase 6; nothing in Phase 5 needed it.

`GUARDIANS` resolves through `GuardianAccess` (status `ACTIVE`, `userId` set),
not through `Guardian` — a `Guardian` record on its own is a contact detail the
hostel holds, not somebody with a login to notify.


### FoodReadyLog

Tracks when cook presses "Food Ready" button.

```typescript
interface IFoodReadyLog {
  _id: ObjectId;
  hostelId: ObjectId; // ref Hostel
  date: Date;
  mealType: 'breakfast' | 'lunch' | 'snacks' | 'dinner';
  readyAt: Date; // actual time when cook pressed button
  scheduledTime?: Date; // planned time from food menu (optional)
  delayMinutes?: number; // calculated: readyAt - scheduledTime
  cookedBy: ObjectId; // ref User (cook role)
  cookDeviceFingerprint?: string; // to identify which cook if multiple share credentials
  notificationId?: ObjectId; // ref Notification - the notification that was sent
  customMessage?: string; // optional message from cook
  foodMenuId?: ObjectId; // ref FoodMenu - if linked to today's menu
  createdAt: Date;
  updatedAt: Date;
}

const FoodReadyLogSchema = new Schema<IFoodReadyLog>({
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  date: { type: Date, required: true, index: true },
  mealType: { 
    type: String, 
    enum: ['breakfast', 'lunch', 'snacks', 'dinner'], 
    required: true 
  },
  readyAt: { type: Date, required: true, default: Date.now },
  scheduledTime: { type: Date },
  delayMinutes: { type: Number },
  cookedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  cookDeviceFingerprint: { type: String },
  notificationId: { type: Schema.Types.ObjectId, ref: 'Notification' },
  customMessage: { type: String },
  foodMenuId: { type: Schema.Types.ObjectId, ref: 'FoodMenu' },
}, { timestamps: true });

FoodReadyLogSchema.index({ hostelId: 1, date: 1, mealType: 1 });
FoodReadyLogSchema.index({ hostelId: 1, readyAt: -1 });

export const FoodReadyLogModel = model<IFoodReadyLog>('FoodReadyLog', FoodReadyLogSchema);
```

---

## Location Tracking & Auto-Attendance

### AttendanceLog

One zone reading per resident **per day**. Shipped 2026-08-01 in
[`packages/db/src/models/AttendanceLog.ts`](../packages/db/src/models/AttendanceLog.ts).

**The privacy invariant:** no coordinates, ever. `POST /api/v1/resident/location/ping` takes
`{ lat, lng }`, computes the distance to the hostel pin, derives a zone, and discards them. Only the
zone and a rounded distance are persisted. `attendance-zone.test.ts` asserts the latitude/longitude
never appear in the Mongo update — keep that test passing.

```typescript
{
  hostelId: ObjectId;    // ref Hostel
  residentId: ObjectId;  // ref Resident
  userId: ObjectId;      // ref User
  day: Date;             // UTC midnight — the bucket the reading belongs to
  recordedAt: Date;
  zone: 'INSIDE' | 'NEARBY' | 'OUTSIDE' | 'UNKNOWN';
  distanceMeters?: number;  // rounded; absent when the zone is UNKNOWN
  source: 'MOBILE_PING' | 'MANUAL_OVERRIDE';
  overrideReason?: string;  // required on a manual override
  overriddenBy?: ObjectId;  // ref User
}

// The unique index is what makes the ping handler an upsert rather than an append.
AttendanceLogSchema.index({ residentId: 1, day: -1 }, { unique: true });
AttendanceLogSchema.index({ hostelId: 1, day: -1 });
AttendanceLogSchema.index({ hostelId: 1, zone: 1, day: -1 });
```

> **Deviation from the original spec, decided 2026-08-01.** This file previously described a row per
> *scheduled check* (`checkTime` + `checkType: morning|evening|night`), i.e. three rows per resident
> per day. The shipped model keys on the day instead, and a later ping overwrites an earlier one.
>
> What that buys: everything §4.1 actually asks for is expressed in days — a day-coloured calendar,
> an absence streak counted in days, a retention window counted in days — and the day key makes all
> three a direct query instead of an aggregation. It also cuts stored rows ~3×, which matters against
> a 600-day retention default.
>
> What it costs: intra-day detail. You cannot see "present at 8am, gone by 10pm" — the last reading
> of the day wins. For a night-safety product that is arguably the right reading to keep, but it is a
> real loss. If per-check granularity is ever needed, change the unique index to
> `{ residentId, recordedAt }` and add a `checkType`; nothing else in the service depends on
> one-row-per-day except the upsert filter.

### AttendanceAlert

Raised when a resident's absence streak reaches the hostel's `absenceAlertDays`. Shipped in
[`packages/db/src/models/AttendanceAlert.ts`](../packages/db/src/models/AttendanceAlert.ts).

```typescript
{
  hostelId: ObjectId;       // ref Hostel
  residentId: ObjectId;     // ref Resident
  consecutiveDays: number;
  lastSeenAt?: Date;
  status: 'OPEN' | 'RESOLVED';
  resolutionNote?: string;
  resolvedAt?: Date;
  resolvedBy?: ObjectId;    // ref User
}

// At most one open alert per resident: a continuing absence updates the day count
// on the existing alert instead of raising a new one every night.
AttendanceAlertSchema.index(
  { residentId: 1, status: 1 },
  { partialFilterExpression: { status: 'OPEN' }, unique: true },
);
AttendanceAlertSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
```

> Deviations from the earlier draft: a `status` enum instead of a `resolved` boolean (so a third
> state can be added without a migration), and no `alertSentTo` array — who was emailed is already
> in the `Notification` collection and the cron's structured logs, and duplicating it here would be
> a second source of truth that drifts.

---

## Community Feature

Shipped 2026-08-01. Four collections, all hostel-scoped:
[`CommunityPost`](../packages/db/src/models/CommunityPost.ts),
[`CommunityComment`](../packages/db/src/models/CommunityComment.ts),
[`CommunityReaction`](../packages/db/src/models/CommunityReaction.ts),
[`CommunityReport`](../packages/db/src/models/CommunityReport.ts).

**How anonymity works, and why it is worth reading before changing anything.** `authorId` is stored
on every post and comment, including anonymous ones. Anonymity is applied in the *serializer*, in
one place, and is lifted for the hostel-admin moderation view -- an admin dealing with harassment has
to know who wrote it. Storing anonymous posts without an author would make them unmoderatable, which
is how anonymous feeds become unusable. `community-anonymity.test.ts` locks both halves: the
resident feed must not contain the author's name, and the moderation view must.

### CommunityPost

```typescript
{
  hostelId: ObjectId;           // ref Hostel
  authorId: ObjectId;           // ref User - always set, even when anonymous
  authorResidentId?: ObjectId;  // ref Resident
  body: string;                 // max 4000, profanity-masked on write
  mediaAssetIds: string[];      // FileAsset ids, max 6 - photos only for now
  isAnonymous: boolean;
  visibility: 'PUBLIC' | 'HOSTEL_ONLY';   // default HOSTEL_ONLY
  isAnnouncement: boolean;      // staff-posted, pinned above the feed
  status: 'VISIBLE' | 'HIDDEN';
  hiddenAt?: Date;
  hiddenBy?: ObjectId;          // ref User
  hiddenReason?: string;
  reportCount: number;
  commentCount: number;
  reactionCount: number;
}

CommunityPostSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
CommunityPostSchema.index({ visibility: 1, status: 1, createdAt: -1 });
CommunityPostSchema.index({ authorId: 1, createdAt: -1 });
```

A resident deleting their own post sets `status: HIDDEN` with `hiddenReason: "Removed by author"` --
a soft delete, per RULES.md 12.3, so a moderation trail survives the author changing their mind.

`visibility: PUBLIC` is stored and indexed but nothing renders a cross-hostel feed yet: a resident
opening Community sees their own building. The flag is the forward-compatible half of the decision,
not a shipped surface.

### CommunityComment

```typescript
{
  postId: ObjectId;      // ref CommunityPost
  hostelId: ObjectId;    // ref Hostel
  authorId: ObjectId;    // ref User
  body: string;          // max 2000, profanity-masked on write
  isAnonymous: boolean;
  status: 'VISIBLE' | 'HIDDEN';
  hiddenAt?: Date;
  hiddenBy?: ObjectId;
}

CommunityCommentSchema.index({ postId: 1, createdAt: 1 });
CommunityCommentSchema.index({ hostelId: 1, status: 1 });
```

Commenting notifies the post author in-app, unless they are commenting on themselves. The
notification never names an anonymous commenter.

### CommunityReaction

```typescript
{
  postId: ObjectId;    // ref CommunityPost
  hostelId: ObjectId;  // ref Hostel
  userId: ObjectId;    // ref User
  type: 'LIKE' | 'LOVE' | 'LAUGH' | 'SAD' | 'ANGRY' | 'SUPPORT';
}

// One reaction per user per post - switching type replaces the row.
CommunityReactionSchema.index({ postId: 1, userId: 1 }, { unique: true });
CommunityReactionSchema.index({ postId: 1, type: 1 });
```

The endpoint is a toggle: posting the same type twice removes the reaction. `reactionCount` on the
post is maintained alongside, so the feed does not aggregate per render.

### CommunityReport

```typescript
{
  postId: ObjectId;       // ref CommunityPost
  commentId?: ObjectId;   // ref CommunityComment
  hostelId: ObjectId;     // ref Hostel
  reportedBy: ObjectId;   // ref User
  reason: string;         // max 500
  status: 'OPEN' | 'ACTIONED' | 'DISMISSED';
  reviewedAt?: Date;
  reviewedBy?: ObjectId;
}

// The same user reporting the same post twice is one report, not two.
CommunityReportSchema.index({ postId: 1, reportedBy: 1 }, { unique: true });
CommunityReportSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
```

Hiding a post marks its open reports `ACTIONED`; restoring one marks them `DISMISSED`. Both write an
`AuditLog` entry.

> **On the profanity filter.** `modules/community/profanity.ts` masks a short list of obvious words
> and nothing else. It is a speed bump, not moderation -- the real control is the report to hide
> flow. It is documented here so nobody mistakes it for a safety feature.

> Deviations from the earlier draft: `content` to `body`; `mediaUrls` to `mediaAssetIds` (the
> project stores FileAsset ids and resolves URLs at read time, per the universal uploader);
> denormalised `authorName` dropped (it would go stale and it is exactly the field that must not
> exist on an anonymous post); the embedded `reactions: { like, love, ... }` counter object replaced
> by the `CommunityReaction` collection plus a single `reactionCount`, because per-user reaction
> state is needed to render the viewer's own choice and to enforce one-per-user.

---

## QuestionCall Integration & Analytics

### QuestionCallClick

Tracks when residents click the QuestionCall integration button.
Built in Phase 5 — [`packages/db/src/models/QuestionCallClick.ts`](../packages/db/src/models/QuestionCallClick.ts).
The shape below is what shipped, with one clarification: `converted` is written
**only** by QuestionCall's own webhook (`POST /api/v1/integrations/questioncall/conversion`,
authenticated by `QUESTIONCALL_WEBHOOK_SECRET`). The platform never infers a
signup it cannot prove, so with no webhook configured every click reads
`converted: false` and the analytics conversion rate is honestly 0%.

```typescript
interface IQuestionCallClick {
  _id: ObjectId;
  residentId: ObjectId; // ref Resident
  userId: ObjectId; // ref User (denormalized)
  hostelId: ObjectId; // ref Hostel (denormalized)
  clickedAt: Date;
  deviceType?: string; // 'web', 'android', 'ios'
  converted: boolean; // did they actually sign up on QuestionCall?
  conversionTrackedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const QuestionCallClickSchema = new Schema<IQuestionCallClick>({
  residentId: { type: Schema.Types.ObjectId, ref: 'Resident', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hostelId: { type: Schema.Types.ObjectId, ref: 'Hostel', required: true, index: true },
  clickedAt: { type: Date, required: true, default: Date.now, index: true },
  deviceType: { type: String, enum: ['web', 'android', 'ios'] },
  converted: { type: Boolean, default: false, index: true },
  conversionTrackedAt: { type: Date },
}, { timestamps: true });

QuestionCallClickSchema.index({ hostelId: 1, clickedAt: -1 });
QuestionCallClickSchema.index({ userId: 1, clickedAt: -1 });
QuestionCallClickSchema.index({ converted: 1, clickedAt: -1 });

export const QuestionCallClickModel = model<IQuestionCallClick>('QuestionCallClick', QuestionCallClickSchema);
```

---

## Hostel Configuration & Settings

### HostelSettings

Per-hostel operational settings — the second level of the PlatformSetting → HostelSettings
hierarchy. One document per hostel.
[`packages/db/src/models/HostelSettings.ts`](../packages/db/src/models/HostelSettings.ts).

```typescript
{
  hostelId: ObjectId;  // ref Hostel, unique

  // Cook Portal (Phase 3)
  cookPortalEnabled: boolean;        // default false
  cookName?: string;
  cookUserId?: ObjectId;             // ref User — the shared kitchen login
  cookCredentialIssuedAt?: Date;     // only the bcrypt hash is stored; this is what the UI shows

  // Location tracking & attendance (Phase 4)
  attendance: {
    enabled: boolean;                     // default false — opt-in per hostel
    insideZoneRadiusMeters: number;       // default 50,  max 500
    nearbyZoneRadiusMeters: number;       // default 200, max 2000
    absenceAlertDays: number;             // default 14,  max 90
    retentionDays: number;                // default 600, max 1095 (platform ceiling)
    pingTimes: string[];                  // HH:mm, default ['06:00','08:00','22:00']
  };

  // Community feed (Phase 5)
  community: {
    enabled: boolean;                     // default true — turning it off blocks new posts
    profanityFilterEnabled: boolean;      // default true
  };

  createdBy?: ObjectId;
  updatedBy?: ObjectId;
}
```

Validation lives in `attendance.validation.ts`; the service additionally rejects a nearby radius
that is not larger than the inside radius (`422 INVALID_GEOFENCE`). The maxima above are the
platform ceilings a hostel admin cannot exceed.

> Deviations from the earlier draft, decided 2026-08-01:
> - Attendance settings are nested under `attendance` rather than flattened, so the whole block can
>   be read and merged over `ATTENDANCE_DEFAULTS` in one step.
> - `pingTimes` is an array instead of a `{morning, evening, night}` object — the default is three
>   times but nothing in the design depends on it being exactly three.
> - `geofenceRadiusMeters` is gone; it duplicated `insideZoneRadiusMeters` and nothing read it.
> - `cookDeviceFingerprints` is gone; per-announcement attribution comes from
>   `FoodReadyLog.deviceInfo` instead (PHASES.md §3.1), which is where it actually lives.
> - `communityFeatureEnabled` / `communityModerationEnabled` / `profanityFilterEnabled` landed in
>   Phase 5 as the `community` block above, now that the Settings screen turns them on and
>   `createCommunityPost` reads them. `notificationsEnabled` / `timezone` remain **not implemented**
>   — still switches nothing reads.

> **Platform ceilings (Phase 5).** The `max…` values above are no longer only schema maxima:
> `updateAttendanceSettings` reads `maxInsideZoneRadiusMeters`, `maxNearbyZoneRadiusMeters` and
> `maxAttendanceRetentionDays` from the `operations` PlatformSetting and rejects anything above them
> (`GEOFENCE_ABOVE_PLATFORM_LIMIT` / `RETENTION_ABOVE_PLATFORM_LIMIT`, 422). Retention is the
> privacy-relevant one — a hostel must not be able to keep raw location rows longer than the
> platform allows.

### PlatformConfig

Superseded — see **PlatformSetting** under "Platform Config & Audit". The two
sections described the same key/value collection; there is one implementation and
it is documented there.

---

## Consent & Privacy

### ConsentLog

Append-only record of consents given and withdrawn.
[`packages/db/src/models/ConsentLog.ts`](../packages/db/src/models/ConsentLog.ts).

```typescript
{
  userId: ObjectId;       // ref User
  hostelId?: ObjectId;    // ref Hostel
  residentId?: ObjectId;  // ref Resident
  consentType: 'LOCATION_TRACKING' | 'TERMS_OF_USE' | 'PRIVACY_POLICY';
  granted: boolean;
  policyVersion?: string; // version of the text the user actually saw
  recordedAt: Date;
  source: 'WEB' | 'MOBILE';
}

ConsentLogSchema.index({ userId: 1, consentType: 1, recordedAt: -1 });
ConsentLogSchema.index({ hostelId: 1, consentType: 1 });
```

**Rows are never updated.** A withdrawal is a new row with `granted: false`, so the history of who
agreed to what and when survives intact. `hasLocationConsent()` therefore reads the *latest* row
per user and type, not any row — which is what makes withdrawal take effect on the very next ping.

> Deviations: enum values are SCREAMING_SNAKE to match every other enum in the codebase;
> `consented` → `granted`; `consentedAt` → `recordedAt`; `consentVersion` → optional
> `policyVersion` (a consent recorded before there is a versioned policy text is still worth having).
> `ipAddress` / `userAgent` are **deliberately not stored** — this is a privacy record, and
> retaining a per-consent IP to prove a privacy choice is self-defeating.

### AccountDeletionRequest

Tracks requests from users to delete their account (60-day grace period).

Two shapes share the collection, distinguished by `kind` (ARCHITECTURE.md §13.0):

- **`SELF_SERVICE`** — the 60-day countdown. `scheduledDeletionAt` is set on
  creation and the purge cron acts on it.
- **`PLATFORM_REVIEW`** — a hostel owner's request, routed to SUPERADMIN.
  `scheduledDeletionAt` is **deliberately left unset** until approval, which is
  the mechanism that keeps the purge cron away from an unreviewed request.
  Approval sets it and starts the same clock; rejection sets `cancelled` so the
  unique `userId` index does not block a later request.

The `requested*` fields snapshot who the account was at request time, so the
review queue still reads correctly after the user is purged.

```typescript
interface IAccountDeletionRequest {
  _id: ObjectId;
  userId: ObjectId; // ref User, unique (only one open request per user)
  reason: string;
  kind: 'SELF_SERVICE' | 'PLATFORM_REVIEW';
  requestedRole: string;
  requestedEmail: string;
  requestedName?: string;
  hostelIds: ObjectId[];    // context for the reviewer
  requestedAt: Date;
  scheduledDeletionAt?: Date; // requestedAt + 60 days; unset until approval on PLATFORM_REVIEW
  cancelled: boolean;
  cancelledAt?: Date;
  executed: boolean;
  executedAt?: Date;
  // PLATFORM_REVIEW only
  reviewStatus?: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedAt?: Date;
  reviewedBy?: ObjectId;    // ref User
  reviewNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AccountDeletionRequestSchema = new Schema<IAccountDeletionRequest>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  reason: { type: String, required: true },
  kind: { type: String, enum: ['SELF_SERVICE', 'PLATFORM_REVIEW'], required: true, default: 'SELF_SERVICE' },
  requestedRole: { type: String, required: true },
  requestedEmail: { type: String, required: true, lowercase: true, trim: true },
  requestedName: { type: String, trim: true },
  hostelIds: [{ type: Schema.Types.ObjectId, ref: 'Hostel' }],
  requestedAt: { type: Date, required: true, default: Date.now },
  scheduledDeletionAt: { type: Date },
  cancelled: { type: Boolean, default: false },
  cancelledAt: { type: Date },
  executed: { type: Boolean, default: false },
  executedAt: { type: Date },
  reviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'] },
  reviewedAt: { type: Date },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewNote: { type: String, trim: true },
}, { timestamps: true });

// The purge cron's query: due, still live.
AccountDeletionRequestSchema.index({ scheduledDeletionAt: 1, executed: 1, cancelled: 1 });
// The superadmin review queue.
AccountDeletionRequestSchema.index({ kind: 1, reviewStatus: 1, requestedAt: -1 });

export const AccountDeletionRequestModel = model<IAccountDeletionRequest>('AccountDeletionRequest', AccountDeletionRequestSchema);
```

---

## Cook Portal

**Note:** Cook users are tracked via `User` model with `role = COOK`. Cook-specific data (name, device fingerprints) is stored in `HostelSettings.cookName` and `HostelSettings.cookDeviceFingerprints`.

---

## Migrations (Mongoose)

Mongoose doesn't have a formal migration system like Prisma. Use a migrations folder with timestamped scripts:

```
packages/db/migrations/
  001_seed_platform_config.ts
  002_create_indexes.ts
  003_add_nearby_places_field.ts
```

Run migrations manually during deployment or via a migration runner script.

---

_End of DATABASE.md_



## Independent branch details (2026-10-04)

No migration required. Every branch remains a full Hostel with the existing ownerId; parentHostelId links shared plan billing. Branches keep separate residents, rooms, payments, settings, optional PAN and HostelPayoutAccount. PAN and payout-holder equality with the billing hostel are no longer creation requirements. Branch capacitySummary is derived from submitted roomConfigurations when present. Payout secrets remain encrypted and scoped to the individual hostel.
