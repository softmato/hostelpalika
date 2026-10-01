# ARCHITECTURE.md — System Architecture & Flows

## 1. Final Tech Stack (decision locked)

| Layer | Choice | Why |
|---|---|---|
| Web app + API | **Next.js 14+ (App Router), TypeScript** — full-stack monolith. Route Handlers (`app/api/**/route.ts`) serve as the REST API for both the web app and, later, the mobile app. | One codebase, one deploy target, fastest path for a small team/timeline. No separate NestJS service to stand up, deploy, and keep in sync. |
| Mobile app | **React Native + Expo (Dev Build)** | Phase 6. Consumes the same REST API. QR camera scanning, native push notifications. |
| Database | **MongoDB** | Flexible schema for rapid iteration, native JSON document storage matches API response shapes, horizontal scaling capability for future growth. |
| ODM | **Mongoose** | Type-safe schemas, validation, middleware hooks, virtuals. Well-established Node.js ODM with excellent TypeScript support. |
| Hosting (DB) | **MongoDB Atlas** | Managed database with automatic backups, connection pooling, free tier for development, easy scaling. |
| UI components | **shadcn/ui** on **Tailwind CSS**, icons via **lucide-react** | Accessible primitives (Radix under the hood), fully in-repo (not an npm black box), matches DESIGN.md tokens. |
| Client server-state | **TanStack Query** | Caching, refetching, optimistic updates for all API calls. |
| Client UI-state | **Zustand** | Small global state (active hostel filter set, comparison tray, modals) — not a replacement for TanStack Query. |
| HTTP client | **Axios** | One shared `apiClient` (interceptors for attaching the access token and silently refreshing on 401) reused by web now and mobile in Phase 6. |
| Validation | **Zod** | Shared schemas between client forms and API route handlers (single source of truth for shape + validation, importable from `packages/shared`). |
| Auth | **Custom JWT** (access + refresh) + **Google OAuth 2.0** | See §3 — the login model is custom enough (admin-issued accounts, role upgrades) that an off-the-shelf auth provider would fight the requirements more than help. |
| File storage | **Cloudflare R2** (S3-compatible API via `@aws-sdk/client-s3`) | No egress fees — important for image-heavy hostel/food photo galleries. |
| Maps | **OpenStreetMap + Leaflet** (default) with runtime fallback to **Google Maps Platform** (Maps JavaScript API, Places API, Geocoding API) | Default: Free OpenStreetMap via Leaflet for most users. Fallback: If `GOOGLE_MAPS_API_KEY` env var is set and API calls succeed, automatically use Google Maps for richer UX (nearby POI, better geocoding). System detects at runtime which provider to use. |
| Email (credential delivery, notices) | **Resend** | Transactional email with template system. Needed from Phase 1 day one: admin-issued account credentials are delivered by email. See EMAIL_SYSTEM.md for all 30+ email scenarios. |
| Push notifications | **Firebase Cloud Messaging** | Phase 6, alongside mobile app. Website uses an in-app notification bell instead (Phase 4). |
| Monorepo tooling | **Turborepo** + **npm workspaces** | `apps/web`, `apps/mobile` (Phase 6), `packages/shared`, `packages/db`. `package-lock.json` is the committed lockfile. |
| Deployment | **Vercel** (web app) | Fits Next.js natively; environment variables per FOLDER_STRUCTURE/ENVIRONMENT docs. |

Full rationale for anything marked "final decision by developer" in the source brief is captured above — treat this table as final unless the client explicitly requests a change.

---

## 2. Multi-Tenancy Model

Each hostel is a **tenant**. Tenant isolation is enforced at the application layer (not separate databases — one MongoDB database, `hostelId` fields everywhere a document belongs to a hostel).

**Non-negotiable rule** (repeated in RULES.md — it belongs in both places): every query that touches hostel-scoped data (`Room`, `Bed`, `Resident`, `Payment`, `Notice`, `Complaint`, `FoodMenu`, `MaintenanceRequest`, etc.) **must** filter by the `hostelId` derived from the authenticated user's session — never from a client-supplied parameter alone. A `HOSTEL_ADMIN`/`WARDEN` session carries exactly one `hostelId`; every repository/query function for hostel-scoped collections takes that `hostelId` as a mandatory argument, not an optional one.

This should be enforced with a thin data-access layer (e.g., `packages/db/src/repositories/*`) so route handlers can't accidentally bypass it by querying Mongoose directly with a client-controlled ID.

---

## 3. Authentication & Authorization Architecture

### 3.1 Unified login gateway

There is exactly **one** login screen and **one** login API for all human users:

```
POST /api/auth/login           { email, password }
POST /api/auth/signup          { email, password }  → sends verification email
POST /api/auth/verify-email    { token }  → verifies email, activates account
GET  /api/auth/google          → redirects to Google OAuth consent
GET  /api/auth/google/callback → Google redirects back here with a code
```

Flow for email/password:
1. User signs up → `User` created with `role: PUBLIC`, `emailVerified: false`
2. System sends verification email with time-limited token
3. User clicks link → `POST /api/auth/verify-email` → sets `emailVerified: true`
4. User can now log in with email/password
5. On login: look up `User` by normalized (lowercased, trimmed) email
6. If not found or wrong password → `401 invalid_credentials` (do not reveal whether the email exists)
7. If `emailVerified: false` → `403 email_not_verified` with option to resend verification
8. Issue access token (short-lived, ~15 min) + refresh token (rotating, ~30 days), set as httpOnly, secure, SameSite=Lax cookies on web
9. Response includes `{ role, redirectPath }` — the frontend redirects based on `role`, it never chooses the role itself

Flow for Google:
1. Verify the Google ID token server-side; extract the verified email + Google subject ID
2. Look up `User` by that email
3. **If found** → log in as that user, using whatever `role` is currently on the record (see §3.2 — this is the key mechanism that makes "already-registered account logs straight into their dashboard" work with zero special-casing at login time)
4. **If not found** → create a new `User` with `role = PUBLIC`, `authProvider = GOOGLE`, `emailVerified = true` (Google already verified it), store the Google subject ID. This is a brand-new public account.

Either method ends the same way: the backend returns which role the account has, and the frontend routes accordingly:

Landing paths are defined in one place — `roleLandingPath` in
`apps/web/src/lib/route-access.ts` — and the same file's `protectedRouteRules`
gate access. As shipped:

| `role` | Redirect | Notes |
|---|---|---|
| `PUBLIC` | `/` | Public homepage |
| `SUPERADMIN` | `/platform/dashboard` | Full platform portal |
| `PLATFORM_MODERATOR` | `/platform/dashboard` | **Same portal**, narrowed by rule: `/platform/config`, `/platform/fee-plans` and `/platform/settings` are SUPERADMIN-only, and every corresponding API guard enforces the same split |
| `HOSTEL_ADMIN` | `/hostel-admin/dashboard` | Also reachable at the tenant-scoped `/{hostel-slug}/admin/...` |
| `WARDEN` | `/hostel-admin/dashboard` | Same shell, capability-gated subset — see §3.3 |
| `COOK` | `/` | No portal landing path by design — COOK reaches exactly one endpoint |
| `RESIDENT` | `/resident/dashboard` | |
| `GUARDIAN` | `/guardian/dashboard` | |

> Earlier drafts listed `/superadmin` and `/moderator` as separate portals.
> They were built as one `/platform` portal separated by route rules rather than
> by URL prefix, so a moderator and a superadmin share every screen they are
> both allowed to see instead of the codebase carrying two near-identical trees.

### 3.2 Account upgrade on admin-issued registration (critical flow — build this exactly)

Because public sign-up (email/password or Google) is open to anyone, and hostel admins later register real people (residents, wardens, guardians) **by email**, the same email can show up twice in time: once as a self-serve public signup, and again as an admin-created record. The system must **never create a duplicate `User` document for the same email.**

When a `HOSTEL_ADMIN` (or the `SUPERADMIN`, for hostel admin accounts) creates a role-holder by email:

1. Look up `User` by that email (case-insensitive)
2. **No existing user** → create a new `User` with the target role, generate a temporary password, send credentials by email, set `mustChangePassword = true`
3. **Existing user with `role = PUBLIC`** → **upgrade in place**:
   - Update `role` to the new role (`RESIDENT` / `WARDEN` / `GUARDIAN` / `HOSTEL_ADMIN`)
   - Attach/create the relevant profile document (`Resident`, `HostelStaff`, `Guardian`) linked to that `userId`
   - Keep their existing password hash and/or Google link intact — do not overwrite their existing login method
   - Send an "your account has been upgraded" email (not a "here is your new password" email) unless they only ever had a Google-only account, in which case also set a temporary password so they can log in with email/password as a fallback
   - Write an `AuditLog` entry — this is a privilege change and must be traceable
4. **Existing user with a role that is already non-`PUBLIC`** → **reject** the creation with a clear conflict error (`409 email_already_has_role`). A person cannot simultaneously hold two hostel-linked roles under this scope. Surface this to the admin doing the registration so they can use a different email or escalate to the superadmin.

This is what satisfies the product requirement: *"if we detect the same Google account is trying to login after that account was already used to register in our system as hostel warden or resident or superadmin, [it should] navigate them to [their] dashboard."* Because the upgrade happens at registration time (step 3 above), by the time that person logs in again — by password or by the same Google account — their `role` field already reflects the correct value, and §3.1's ordinary login flow routes them correctly. No special detection logic is needed at login time; keep it that way. Do not build a second, separate "check if Google email matches a staff record" path at login — it would duplicate logic that already lives in the registration flow and is a common source of bugs.

**Security safeguard (required, not optional):** upgrading a `PUBLIC` account into `HOSTEL_ADMIN` or `SUPERADMIN` (high-privilege roles) must not happen silently on a bare email match alone, because email addresses can be mistyped or, in rare cases, controlled by someone other than the intended person. For these two roles specifically, send a confirmation email to the address first and require the recipient to click a confirmation link (or enter the emailed temporary password) before the upgrade takes effect. `RESIDENT`, `WARDEN`, and `GUARDIAN` upgrades can proceed immediately since they're lower-privilege and the admin doing the registration has already vetted the person out-of-band (in person, by phone, etc.).

### 3.3 Roles & permissions

| Role | Scope | Notes |
|---|---|---|
| `SUPERADMIN` | Whole platform | Only one seeded account initially; can create `PLATFORM_MODERATOR` accounts later |
| `PLATFORM_MODERATOR` | Platform-wide, limited permissions | Can approve hostels, moderate reviews, approve service providers, view reports. CANNOT: change platform config, access billing/subscriptions, manage API keys, create other superadmins. |
| `HOSTEL_ADMIN` | One hostel (owner) | Full control of their own hostel; can create `WARDEN` and `RESIDENT`/`GUARDIAN` accounts under it |
| `WARDEN` | One hostel, subset of admin permissions | Permission flags stored per `HostelStaff` document (e.g., can register residents: yes, can edit hostel profile: no) — configurable by the hostel admin, default set defined in RULES.md |
| `RESIDENT` | Own record only | Cannot see other residents |
| `GUARDIAN` | One linked resident, read-only, limited fields | Visibility is opt-in per field, controlled by the resident (`Guardian.accessPermissions`) |
| `PUBLIC` | Anonymous-equivalent | No hostel-linked data access |

Authorization is enforced with a small `requireRole()` / `requireHostelAccess()` middleware layer on every route handler — never inferred from the URL alone.

### 3.4 Tokens & session

- Access token: JWT, ~15 min expiry, contains `userId`, `role`, `hostelId` (if applicable).
- Refresh token: opaque or JWT, rotated on every use, stored httpOnly cookie on web (Phase 6 mobile: Expo SecureStore).
- Refresh endpoint: `POST /api/auth/refresh`.
- Logout: `POST /api/auth/logout` clears cookies and invalidates the refresh token server-side (store a `tokenVersion` counter on `User` document, bump on logout/password change).
- Rate-limit login attempts per email + per IP; lock out temporarily after repeated failures.

---

## 4. Maps & Location Architecture (Smart Fallback System)

### 4.1 Provider Selection Logic

The system supports two map providers with intelligent runtime selection:

**Default Provider: OpenStreetMap + Leaflet**
- Free, no API key required
- No usage limits or billing
- Suitable for basic hostel location display
- Slightly less rich POI (points of interest) data

**Fallback Provider: Google Maps Platform**
- Richer features: better POI data, street view, detailed nearby search
- Requires billing-enabled Google Cloud project
- Activated only if `GOOGLE_MAPS_API_KEY` (server) and `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (client) env vars are set
- System auto-detects at runtime

### 4.2 Runtime Detection Flow

**Server-side (API routes):**
```typescript
// packages/shared/src/maps/provider.ts
export function getMapProvider(): 'google' | 'osm' {
  if (process.env.GOOGLE_MAPS_API_KEY) {
    // Test if the key works (optional: cache this check)
    try {
      // Make a test geocoding request
      return 'google';
    } catch {
      console.warn('Google Maps API key invalid, falling back to OSM');
      return 'osm';
    }
  }
  return 'osm';
}
```

**Client-side (React components):**
```typescript
// apps/web/lib/maps/client.tsx
export function useMapProvider() {
  const [provider, setProvider] = useState<'google' | 'osm'>('osm');
  
  useEffect(() => {
    if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY) {
      // Test if Google Maps loads successfully
      loadGoogleMaps()
        .then(() => setProvider('google'))
        .catch(() => {
          console.warn('Google Maps failed to load, using OSM');
          setProvider('osm');
        });
    }
  }, []);
  
  return provider;
}
```

### 4.3 Geocoding (Address → Coordinates)

- Hostel `latitude`/`longitude` are set once when a hostel admin saves/updates their address
- **Server-side geocode call** (never client-side to protect API keys)
- Cached on the `Hostel` document — don't re-geocode on every read
- **Provider logic:**
  - If Google Maps available: use Geocoding API
  - Else: use Nominatim (OpenStreetMap geocoding API, free)

**Admin location picker** (`GET /api/v1/hostel-admin/profile/geocode`, staff-only):

- `?q=` accepts a place name, a raw `lat,lng` pair, or a pasted map link
  (Google Maps, OSM, Apple Maps). `maps.app.goo.gl` / `goo.gl` short links are
  followed server-side — the browser cannot read a cross-origin redirect
- `?near=` carries the hostel's saved locality, so an admin searching their own
  hostel's name (which no geocoder in Nepal carries) still resolves nearby
- `?lat=&lng=` reverse-geocodes, which is how placing the pin rewrites the
  address fields above the map. City/province are stripped of administrative
  suffixes ("Kathmandu Metropolitan City" → "Kathmandu") so the value still
  matches the public city filter
- A pin the admin placed is stored with `locationSource: MANUAL` and is never
  overwritten by the address-based geocoder

### 4.4 Map Rendering (Hostel Profile Page)

**Component structure:**
```typescript
// apps/web/components/hostel/HostelMap.tsx
export function HostelMap({ hostel }: { hostel: Hostel }) {
  const provider = useMapProvider();
  
  if (provider === 'google') {
    return <GoogleMapView hostel={hostel} />;
  }
  
  return <LeafletMapView hostel={hostel} />;
}
```

**Google Maps variant:**
- Uses Google Maps JavaScript API
- Restricted browser API key (HTTP referrer restriction)
- Shows hostel marker + nearby POI via Places API

**Leaflet/OSM variant:**
- react-leaflet component
- Free tile server (openstreetmap.org)
- Shows hostel marker only (no rich POI unless manually added)

### 4.5 Nearby Points of Interest

**Goal:** Show colleges, hospitals, bus stops near a hostel

**Implementation:**

*With Google Maps:*
- Use Places API "Nearby Search"
- Server-side call (protect API key)
- Cache results per hostel in database (recompute on address change or weekly)
- Return to client as static array

*With OpenStreetMap:*
- Use Overpass API (free OpenStreetMap query service)
- Query for nearby amenities (schools, hospitals, transit)
- Cache results same way
- Less comprehensive than Google but sufficient

**Data shape:**
```typescript
interface NearbyPlace {
  name: string;
  type: 'college' | 'hospital' | 'bus_stop' | 'other';
  distance: number; // meters
  coordinates: { lat: number; lng: number };
}

// Stored on Hostel document
nearbyPlaces: NearbyPlace[];
nearbyPlacesLastUpdated: Date;
```

### 4.6 College Proximity Search

**Feature:** "Show hostels near [College Name]"

*With Google Maps:*
- Use Places Text Search to find college coordinates
- Use Distance Matrix API to rank hostels by distance
- Cache college coordinates

*With OpenStreetMap:*
- Use Nominatim to find college coordinates
- Calculate distance using Haversine formula
- Sort hostels client-side or server-side

### 4.7 Security & Cost Control

**Google Maps:**
- Client key: restricted by HTTP referrer in Google Cloud Console
- Server key: restricted by API (Geocoding, Places only) and ideally server IP
- Budget alert set on Google Cloud project
- Client-payable costs (PRD.md §5)

**OpenStreetMap:**
- No authentication required
- Respect Nominatim usage policy (max 1 req/sec, User-Agent header)
- Use tile server CDN for map rendering

### 4.8 Configuration Example

**.env (with Google Maps enabled):**
```bash
GOOGLE_MAPS_API_KEY=AIza...server-only-key
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=AIza...browser-key-with-referrer-restriction
```

**.env (OpenStreetMap only):**
```bash
# Leave Google Maps vars empty or unset
# System auto-falls back to OSM
```

---

## 5. PlatformConfig Pattern (Runtime-Configurable Values)

### 5.1 Concept

Certain values must be configurable by the platform owner without code deploys:
- Fee reminder timing (days before due date)
- Complaint SLA timers (hours to first response)
- Referral reward amounts
- Feature flags (enable/disable features per environment)
- Email template toggles
- Subscription pricing tiers
- Points/rewards conversion rates

### 5.2 Implementation

**MongoDB Collection:**
```typescript
// Single document, _id = 'default'
PlatformConfig {
  _id: 'default',
  paymentReminderDaysBefore: 3,
  complaintSlaHours: 24,
  referralRewardPoints: 100,
  features: {
    mobileAppEnabled: false,
    maintenanceRequestsEnabled: true,
    ratingsEnabled: true,
  },
  emailSettings: {
    sendPaymentReminders: true,
    sendNoticeEmails: true,
    digestEmails: false,
  },
  pricing: {
    subscriptionPlans: [ /* array of plan objects */ ],
  },
  updatedAt: Date,
  updatedBy: userId,
}
```

**Server-side Loading:**
1. On server boot (Next.js app initialization):
   - Load `PlatformConfig` from MongoDB
   - Cache in memory (global variable or Redis for multi-instance)
   - Set cache TTL (e.g., 5 minutes)

2. On every request that needs config:
   - Check cache first
   - If cache expired, reload from DB
   - Background revalidation (serve stale while revalidating)

**Client-side Caching:**
1. On first page load:
   - API call to `/api/platform/config` (public endpoint, limited fields)
   - Store in browser cookie/localStorage (encrypted if sensitive)
   - TanStack Query caches the result

2. On subsequent loads:
   - Serve from TanStack Query cache immediately
   - Background refetch to check for updates
   - If config changed, refresh UI components that depend on it

**Admin Update Flow:**
1. Superadmin navigates to `/superadmin/platform-config`
2. Edits values in form
3. `PUT /api/superadmin/platform-config` with partial update
4. Server updates MongoDB document, bumps `updatedAt`, invalidates cache
5. All active clients receive updated config on next refetch (or via WebSocket push)

**Code Example:**
```typescript
// packages/db/src/repositories/platformConfig.repository.ts
let configCache: PlatformConfig | null = null;
let cacheExpiry: number = 0;

export async function getPlatformConfig(): Promise<PlatformConfig> {
  if (configCache && Date.now() < cacheExpiry) {
    return configCache;
  }
  
  configCache = await PlatformConfigModel.findById('default').lean();
  if (!configCache) {
    // Initialize with defaults if not exists
    configCache = await PlatformConfigModel.create(defaultConfig);
  }
  
  cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
  return configCache;
}

export async function updatePlatformConfig(
  updates: Partial<PlatformConfig>,
  updatedBy: string
): Promise<PlatformConfig> {
  const config = await PlatformConfigModel.findByIdAndUpdate(
    'default',
    { $set: { ...updates, updatedAt: new Date(), updatedBy } },
    { new: true, upsert: true }
  );
  
  // Invalidate cache
  configCache = null;
  
  return config.toObject();
}
```

**Client Hook:**
```typescript
// apps/web/hooks/usePlatformConfig.ts
export function usePlatformConfig() {
  return useQuery({
    queryKey: ['platformConfig'],
    queryFn: async () => {
      const res = await apiClient.get('/api/platform/config');
      return res.data as PlatformConfig;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    cacheTime: 30 * 60 * 1000, // 30 minutes
  });
}
```

---

## 6. Payments Architecture (v1 = manual)

- `Payment` documents represent what's owed for a resident for a given period (monthly fee)
- `PaymentProof` subdocuments or separate collection for uploaded proofs
- Proofs uploaded by resident (screenshot/photo of eSewa/Fonepay/Khalti/bank transfer, or cash acknowledgment)
- Always in `status: pending` until a `HOSTEL_ADMIN`/`WARDEN` verifies or rejects
- Verifying a proof updates `Payment.status` and generates a `Receipt` document
- No money moves through the platform itself in v1 — it is a record-keeping and proof-of-payment workflow only
- Automated gateway integration (eSewa/Khalti/connectIPS) is an explicit later phase (source brief §17.2) and out of scope for now
- Subscription/platform billing (`hostel → platform`) is tracked the same way: manual record + expiry alerts, no live gateway in v1

---

## 7. Notifications

- v1 (web): in-app notification bell, backed by the `Notification` collection, polled/pushed via TanStack Query
- Phase 6 (mobile): Firebase Cloud Messaging push, same `Notification` collection as the source of truth; FCM is a delivery channel, not the system of record
- Notification triggers are listed in EMAIL_SYSTEM.md (inquiry received, payment due, proof uploaded/verified/rejected, new notice, food update, complaint update, night-status update, SOS, maintenance status, provider approval)
- Email notifications are sent **in parallel** with in-app notifications for critical events (see EMAIL_SYSTEM.md for matrix)

---

## 8. High-Level Data Flow (public inquiry → resident)

```
Public visitor
   -> browses/searches hostels (no login required)
   -> opens hostel profile
   -> submits Inquiry (name, phone, email, message)
        -> Inquiry document created in that hostel's collection
   -> Hostel admin/warden contacts the person off-platform
   -> Hostel admin/warden manually creates a Resident record (see §3.2 for the
      account-creation/upgrade logic tied to this step)
   -> System generates a QRActivation document with unique code
   -> Resident scans the QR (mobile app camera) or enters the code on web
   -> Resident's account role switches from PUBLIC to RESIDENT
   -> Resident dashboard appears (web or mobile depending on access method)
```

Public users can never self-promote to `RESIDENT` — it always requires a hostel admin/warden action, per source brief §14.

---

## 9. Service Provider Flow

```
Local worker -> public registration form (no login)
             -> ServiceProvider document created with status = pending
Superadmin/
Moderator    -> reviews -> approved / rejected / hidden
Hostel admin -> searches approved providers by category/area/availability
             -> creates a MaintenanceRequest document, contacts provider off-platform
             -> updates MaintenanceRequest.status as work progresses
```

Service providers never get portal accounts or resident data — they are a directory, not a role in the auth system.

---

## 10. Background/Scheduled Jobs

Needed from Phase 3 onward (payments) and Phase 2 (subscriptions):
- Payment due-date reminders (daily job → creates `Notification` documents, sends emails per EMAIL_SYSTEM.md)
- Subscription/platform-payment expiry alerts to the superadmin
- Complaint SLA-timer checks (flag complaints past their configurable window from PlatformConfig)
- Cached "nearby spots" refresh for hostels whose address changed
- Email queue processing (if using a queue-based email system)

Implement as Vercel Cron hitting an internal, auth-protected route handler (e.g., `/api/cron/payment-reminders`) rather than a separate worker service — keeps the monolith simple for this timeline. Protect cron endpoints with a shared secret header to prevent external triggering.

---

## 11. Deployment Architecture

```
Vercel (Next.js web app + API route handlers)
   |-- MongoDB Atlas — via Mongoose
   |-- Cloudflare R2 — file storage (photos, documents, proofs)
   |-- OpenStreetMap / Google Maps Platform — maps, places, geocoding (runtime-detected)
   |-- Resend — transactional email with templates
   |-- (Phase 6) Firebase Cloud Messaging — mobile push
```

No separate backend service, no container orchestration needed for v1 — this is intentional, to fit the timeline. Revisit only if load/scale genuinely requires splitting out a service.

---

## 12. MongoDB Collection Structure (High-Level)

All detailed schemas are in DATABASE.md. Key tenancy pattern:

**Hostel-scoped collections:**
- Every document has `hostelId: ObjectId` field
- Indexes on `hostelId` + other query fields
- Application-layer filtering enforced in repository functions

**Global collections (no hostelId):**
- `User` — single identity table for all roles
- `Hostel` — tenant root document
- `PlatformConfig` — singleton
- `AuditLog` — platform-wide audit trail
- `ServiceProvider` — searchable directory

**Relationship pattern:**
- Mongoose references via `ObjectId` + `.populate()` for joins
- Denormalize frequently-read fields (e.g., `hostelId` on every document for fast filtering)
- No complex joins — prefer embedded subdocuments or separate targeted queries

---

_End of ARCHITECTURE.md_


---

## 7. Push Notification Architecture (Phase 6)

### 7.1 Infrastructure

- **Android**: Firebase Cloud Messaging (FCM)
- **iOS**: Apple Push Notification Service (APNS) via FCM
- **Web**: Browser push notifications via Service Worker (PWA)

### 7.2 Flow

1. **Device Registration**:
   - Mobile app/PWA obtains push token on launch
   - POST /api/user/device-token with { token, platform, deviceInfo }
   - Store in `User.deviceTokens[]` array (supports multiple devices per user)

2. **Notification Creation**:
   - Admin/Cook/System creates Notification document
   - Backend determines target recipients based on targetAudience
   - Creates NotificationReceipt records for each recipient
   - Enqueues push notification jobs

3. **Delivery**:
   - Background job fetches device tokens for recipients
   - Sends via FCM/APNS using Firebase Admin SDK
   - Updates NotificationReceipt with deliveredAt timestamp
   - Tracks failures and retries

4. **Read Tracking**:
   - User opens notification → app calls PATCH /api/notifications/:id/read
   - Updates NotificationReceipt.readAt
   - Decrements badge count

### 7.3 Notification Categories

- **FOOD_READY**: Cook presses button → all residents notified
- **PAYMENT**: Payment due/verified/rejected
- **ATTENDANCE**: Resident absent X days → admin notified
- **SOS**: Emergency alert → admins/wardens/guardians
- **COMMUNITY**: Post engagement (likes, comments)
- **ANNOUNCEMENT**: Admin/superadmin announcements

---

## 8. Location Tracking & Auto-Attendance Architecture

### 8.1 Privacy-First Design

**CRITICAL**: Exact GPS coordinates are NEVER stored. Only zone status (INSIDE/NEARBY/OUTSIDE/UNKNOWN) is persisted.

### 8.2 Mobile Background Service

**Implementation** (Phase 6, using expo-task-manager + expo-location):

```typescript
// Background task that runs at configured times
TaskManager.defineTask('LOCATION_TRACKING', async ({ data, error }) => {
  if (error) {
    console.error(error);
    return;
  }
  
  const { locations } = data;
  const location = locations[0];
  
  // Send to server immediately
  await fetch(`${API_URL}/api/resident/location/ping`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      lat: location.coords.latitude,
      lng: location.coords.longitude,
      timestamp: location.timestamp,
    }),
  });
});

// Register background location updates at configured times
Location.startLocationUpdatesAsync('LOCATION_TRACKING', {
  accuracy: Location.Accuracy.Balanced,
  timeInterval: getTrackingInterval(), // From hostel settings
  distanceInterval: 0,
});
```

### 8.3 Server-Side Zone Calculation

```typescript
// apps/web/app/api/resident/location/ping/route.ts
export async function POST(req: Request) {
  const { lat, lng, timestamp } = await req.json();
  const resident = await getSession(req); // Never trust client hostelId
  
  const hostel = await Hostel.findById(resident.hostelId);
  const settings = await HostelSettings.findOne({ hostelId: resident.hostelId });
  
  // Calculate distance using haversine formula
  const distance = calculateDistance(
    lat, lng,
    hostel.latitude, hostel.longitude
  );
  
  // Determine zone (NEVER store exact coordinates)
  let zone: LocationZone;
  if (distance <= settings.insideZoneRadius) zone = LocationZone.INSIDE;
  else if (distance <= settings.nearbyZoneRadius) zone = LocationZone.NEARBY;
  else zone = LocationZone.OUTSIDE;
  
  // Store ONLY zone and distance, NOT coordinates
  await AttendanceLog.create({
    residentId: resident._id,
    hostelId: resident.hostelId,
    userId: resident.userId,
    checkTime: new Date(timestamp),
    checkType: determineCheckType(timestamp), // morning/evening/night
    zone,
    distance: Math.round(distance), // meters
    source: 'auto',
  });
  
  // Check for attendance alerts (X consecutive days absent)
  await checkAttendanceAlerts(resident._id, resident.hostelId);
  
  return Response.json({ success: true });
}
```

### 8.4 Configuration Hierarchy

1. **Platform Defaults** (PlatformConfig):
   - insideZoneRadius: 50m
   - nearbyZoneRadius: 200m
   - trackingTimes: { morning: '08:00', evening: '18:00', night: '22:00' }
   - dataRetentionDays: 600
   - attendanceAlertThresholdDays: 14

2. **Hostel Overrides** (HostelSettings):
   - Admin can customize within platform limits
   - Superadmin can override any hostel setting

3. **Validation**:
   - insideZoneRadius: 20m - 100m
   - nearbyZoneRadius: 100m - 500m
   - dataRetentionDays: 30 - 600 (platform enforced max)

### 8.5 Data Retention

```typescript
// Cron job: daily cleanup
export async function cleanupOldAttendanceLogs() {
  const hostels = await HostelSettings.find();
  
  for (const hostelSettings of hostels) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - hostelSettings.locationDataRetentionDays);
    
    // Delete raw logs older than retention period
    await AttendanceLog.deleteMany({
      hostelId: hostelSettings.hostelId,
      createdAt: { $lt: cutoffDate },
    });
  }
}
```

---

## 9. Community Feature Architecture

### 9.1 Scope & Visibility

- **HOSTEL_ONLY**: Post visible only to residents of same hostel (tenant-scoped)
- **PUBLIC**: Post visible to all residents across all hostels (cross-tenant)

### 9.2 Moderation System

**Auto-Moderation**:
- Profanity filter using library (e.g., `bad-words` npm package)
- Configurable per hostel via HostelSettings.profanityFilterEnabled
- Flagged words replaced with `***` or post blocked before creation

**Manual Moderation**:
- Residents can report posts/comments with reason
- Admin sees reported content in queue
- Admin can hide (not delete) posts → sets `hidden: true`, `hiddenBy: adminId`
- Hidden posts not visible publicly but remain in database (audit trail)
- Admin can unhide if mistakenly flagged

### 9.3 Engagement Tracking

- Reactions stored in CommunityReaction (one per resident per post/comment)
- Denormalized counts in CommunityPost.reactions: { like: 42, love: 10, ... }
- Comment count denormalized in CommunityPost.commentCount
- Real-time updates via optimistic UI (TanStack Query mutations)

### 9.4 Notifications

When resident's post receives engagement:
- Like/React → create Notification (batched: "X people reacted to your post")
- Comment → create Notification immediately with commenter name
- Push notification sent if mobile app installed

---

## 10. Cook Portal Architecture

### 10.1 Account & Credentials

- Cook is a **separate role** (`COOK`) in User model
- Created during hostel registration if admin enables cook portal
- Credentials sent in same email as hostel admin approval (separate section)
- Multiple cooks can share same credentials (by design for simplicity)

### 10.2 Device Fingerprint Tracking

To identify which cook did what when credentials are shared:

```typescript
// On cook's first login from mobile app
const fingerprint = await DeviceInfo.getUniqueId(); // Expo DeviceInfo
await apiClient.post('/api/cook/device/register', {
  fingerprint,
  deviceName: await DeviceInfo.getDeviceName(),
});

// Store in HostelSettings.cookDeviceFingerprints[]
```

When cook presses "Food Ready":
```typescript
// FoodReadyLog includes cookDeviceFingerprint
await FoodReadyLog.create({
  cookedBy: cookUserId,
  cookDeviceFingerprint: fingerprint,
  // ... other fields
});
```

### 10.3 Food Ready Notification Flow

1. Cook presses "Dinner Ready" button in mobile app
2. App calls POST /api/cook/food-ready with { mealType: 'dinner', customMessage?, fetchFromMenu: true }
3. Server creates FoodReadyLog with timestamp
4. If fetchFromMenu=true, fetches description from today's FoodMenu
5. Creates Notification with category=FOOD_READY, targetAudience=all residents of hostel
6. Sends push notification to all active residents
7. Creates NotificationReceipt for each resident
8. Calculates delay: readyAt - scheduledTime (if menu has scheduled time)

### 10.4 Analytics

Admin dashboard shows:
- Average ready time per meal type (last 30 days)
- Frequency of delays (> 15 min late)
- Patterns: which meals are consistently late
- Cook performance: compare timing by device fingerprint (if multiple cooks)

---

## 11. Configuration System Architecture

### 11.1 Two-Level Hierarchy

```
┌─────────────────────────────────────────┐
│ PlatformConfig (Superadmin)             │
│ - Defaults for all hostels              │
│ - Hard limits (min/max ranges)          │
│ - Platform-wide feature flags           │
└─────────────────────────────────────────┘
                  ↓ (defaults)
┌─────────────────────────────────────────┐
│ HostelSettings (Per Hostel)             │
│ - Can override defaults within limits   │
│ - Hostel admin controls                 │
│ - Superadmin can override any setting   │
└─────────────────────────────────────────┘
```

### 11.2 Setting Resolution Logic

```typescript
async function getEffectiveSetting(hostelId: ObjectId, key: string) {
  const platformConfig = await PlatformConfig.findOne({ key });
  const hostelSettings = await HostelSettings.findOne({ hostelId });
  
  // If hostel has custom value and it's within platform limits, use it
  if (hostelSettings?.[key] !== undefined) {
    const value = hostelSettings[key];
    if (isWithinLimits(value, platformConfig.limits)) {
      return value;
    }
  }
  
  // Otherwise use platform default
  return platformConfig.value;
}
```

### 11.3 Configurable Settings

| Setting | Platform Control | Hostel Control |
|---------|------------------|----------------|
| Location tracking ON/OFF | Can force disable | Can enable/disable |
| Geofence radius | Set min/max (20-500m) | Choose within range |
| Tracking times | Set defaults | Customize times |
| Data retention | Set max (600 days) | Choose ≤ max |
| Attendance alert threshold | Set default (14 days) | Customize |
| Cook portal enabled | Can disable globally | Enable/disable |
| Community enabled | Can disable globally | Enable/disable |
| Profanity filter | Platform default ON | Enable/disable |

---

## 12. QuestionCall Integration Architecture

### 12.1 Redirect Flow

```
Resident (STUDENT) taps the QuestionCall row (site config `questionCall`)
         ↓
Open at once, in the tap:
  phone app → questioncall:// (QuestionCall's native app), else the link
  web       → the link, in a new window
  the link defaults to https://questioncall.com/app?install&from=hostelpalika
         ↓  (alongside, not before)
POST /api/v1/resident/questioncall/click → QuestionCallClick record
         ↓
(Optional) QuestionCall pings back when user signs up
         ↓
Update QuestionCallClick.converted = true
```

The link sits in QuestionCall's web-app scope (`/app`), so on Android an
installed QuestionCall web app takes it instead of a browser tab; `?install`
makes the page open its install sheet (iPhone: Share → Add to Home Screen).
There is no sign-in hand-off: QuestionCall has no endpoint for one.

### 12.2 Analytics Tracking

Superadmin dashboard shows:
- Total clicks (daily/weekly/monthly)
- Click-through rate per hostel
- Conversion rate (clicked → signed up on QuestionCall)
- Top hostels by engagement
- CSV export for detailed analysis

---

## 13. Account Deletion & Data Retention Architecture

**Status: built.** `modules/users/account-deletion.service.ts` (request, cancel,
review), `modules/users/account-purge.service.ts` (the erasure itself), and the
`/api/v1/cron/account-purge` job.

### 13.0 "Delete my account" is four different actions

An account is not one thing, so the button cannot be. Which outcome an account
gets is decided by the server from the account's role and what depends on it —
the caller does not choose. `getAccountDeletionStatus()` returns the pathway so
the UI can say what the button will actually do *before* it is pressed.

| Pathway | Who | What happens |
|---|---|---|
| `SELF_SERVICE` | `PUBLIC`, and residents who have moved out | The 60-day flow in §13.1. |
| `GUARDIAN_RELEASE` | `GUARDIAN` | Their `GuardianAccess` rows are revoked and the account drops to `PUBLIC` with its `hostelIds` cleared. The account survives — a guardian's account outlives their guardianship, and deleting "the guardian" means giving up the link to the resident, not erasing the person. They can then delete the public account outright. |
| `BLOCKED` | An **active** resident; `WARDEN`; `COOK`; platform roles | Refused with `409 DELETION_NOT_ALLOWED` and a reason. A current residency is the hostel's record of who is in a bed tonight and is not the resident's alone to erase — they can delete once they have moved out. Staff accounts are issued by an admin, so retiring one is the admin's action. |
| `PLATFORM_REVIEW` | `HOSTEL_ADMIN` | A `PENDING` request is routed to SUPERADMIN with the owner's reason and their hostel names. **Nothing happens to the account** — no suspension, no revoked sessions — until a superadmin approves it. Approval then starts the same 60-day clock. Queue at `/platform/account-deletions`; rejection closes the row so they can ask again. |

### 13.1 60-Day Grace Period

When a `SELF_SERVICE` request is made (or a `PLATFORM_REVIEW` one is approved):
1. Create/refresh the `AccountDeletionRequest` with `scheduledDeletionAt = now + 60 days`
2. Suspend the account immediately — `User.status = SUSPENDED`. The enum has no
   `DISABLED` member; `SUSPENDED` is the shipped name for the same state and is
   already what the login check refuses on. `tokenVersion` is bumped in the same
   update, because revoking `Session` rows alone would leave an unexpired access
   JWT working.
3. The user cannot log in — so cancellation runs off the **signed
   `cancel-account-deletion` purpose token** in the email link, not a settings
   page (`/cancel-deletion`, `POST /api/v1/auth/cancel-account-deletion`, rate
   limited). The token names one user, cannot be replayed as an access token,
   and expires with the grace period.
4. Daily cron (`/api/v1/cron/account-purge`) picks up requests past
   `scheduledDeletionAt`
5. If past date and not cancelled → execute permanent deletion

### 13.2 What Gets Deleted

**Immediate on Request**:
- User.status = DISABLED
- All device tokens removed
- All sessions invalidated

**After 60 Days**:
- User document deleted
- Resident document deleted
- All `Notification` rows deleted (these *are* the receipts — there is no
  `NotificationReceipt` collection; see DATABASE.md)
- All AttendanceLog deleted (raw location data) — matched on **both** `userId`
  and `residentId`, since the model carries both and matching one leaves rows
- All ConsentLog deleted
- All QuestionCallClick deleted
- All Session and DeviceToken rows deleted
- All CommunityPost/Comment by user set to `authorId = null` and
  `isAnonymous = true`. The post survives because it is part of a conversation
  other residents took part in; the authorship link is what is cut. A purged
  author reads as anonymous to **everyone, moderators included** — there is no
  longer an account to act against, and re-identifying them would undo the
  erasure. `authorId` is nullable on both models for exactly this case.

**Retained for Legal/Audit**:
- Payment records (amounts/dates kept)
- Receipt records (financial audit trail)
- AuditLog entries (compliance) — including an `ACCOUNT_PURGED` entry written by
  the purge itself, which is the only evidence the request was honoured
- Aggregated analytics (no PII)

> **Payments are left untouched, not nulled.** An earlier version of this
> section said to set `Payment.residentId = null`. That cannot be done as
> written: `Payment` carries a unique index on `{ hostelId, residentId, month }`,
> so the second account purged in the same hostel and month would collide on
> `null` and the purge would fail — turning a privacy guarantee into an error.
> It is also unnecessary. Neither `Payment` nor `Receipt` stores a name, email
> or phone; `residentId` is their only link to a person, and the `Resident`
> document it points at is deleted. What is left is an ObjectId resolving to
> nothing — the de-identification this section is asking for, with the ledger
> intact. Resolved 2026-08-02.

---

_End of ARCHITECTURE.md_
