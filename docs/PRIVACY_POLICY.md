# PRIVACY_POLICY.md — Privacy Policy & Data Protection

> **Superseded planning notes (July 2026).** The policy users read is `content.privacy`
> (and the Terms are `content.terms`) in `apps/web/src/lib/platform-config/site-config.defaults.ts`,
> unless a superadmin overrides it under Website Config → Legal Pages. Change it there, never here.

**Last Updated:** 14 July 2026

This document outlines the privacy practices for the Multi-Hostel SaaS Platform, with special focus on location tracking, data retention, and user rights.

---

## 1. Information We Collect

### 1.1 Account Information
- Name, email address, phone number
- Hostel affiliation, room/bed assignment
- Academic information (if student)
- Guardian contact details (if provided)

### 1.2 Payment Information
- Payment proofs (screenshots/photos uploaded by users)
- Payment status, amounts, due dates
- We do NOT store credit card numbers or bank account details

### 1.3 Location Data **⚠️ IMPORTANT**
- **We collect location data to track hostel attendance**
- **We NEVER store your exact GPS coordinates**
- Only your zone status is stored: INSIDE, NEARBY, OUTSIDE, or UNKNOWN
- Distance from hostel (in meters) is stored, but NOT your exact location
- Collection frequency: 3 times per day (morning, evening, night) - configurable by your hostel

### 1.4 Usage Data
- Pages visited, features used
- Device type, operating system
- Push notification tokens
- Community posts, comments, reactions

### 1.5 Communications
- Messages sent via complaint system
- Community posts and comments
- Emails sent/received through the platform

---

## 2. How We Use Your Information

### 2.1 Core Services
- Manage hostel resident accounts
- Track payment status
- Send notifications (food ready, payment due, announcements)
- Facilitate communication between residents and hostel management

### 2.2 Attendance Tracking
- Monitor hostel attendance automatically via location tracking
- Alert hostel management if resident is absent for extended period (default: 14+ consecutive days)
- Provide attendance reports to hostel administrators
- **Your exact location is NEVER shared with anyone**

### 2.3 Community Features
- Display your posts to other residents (based on visibility settings)
- Enable engagement (likes, comments, reactions)
- Moderate content to maintain safe community

### 2.4 Analytics & Improvement
- Understand feature usage patterns
- Improve platform performance
- Generate aggregated statistics (e.g., "average attendance rate")

---

## 3. Location Tracking Details **⚠️ READ CAREFULLY**

### 3.1 What We Track
- Your mobile app pings the server **3 times per day** (default):
  - Morning check (e.g., 8:00 AM)
  - Evening check (e.g., 6:00 PM)
  - Night check (e.g., 10:00 PM)
- Times are configurable by your hostel admin

### 3.2 What We Store
✅ **We STORE**:
- Zone status: INSIDE (0-50m from hostel), NEARBY (51-200m), OUTSIDE (201m+), or UNKNOWN (phone off)
- Distance in meters (rounded)
- Timestamp of check

❌ **We DO NOT STORE**:
- Your exact latitude/longitude coordinates
- Your precise location address
- Any location data between scheduled checks

### 3.3 How Long We Keep It
- Location data (AttendanceLog) is automatically deleted after **600 days** (default)
- Your hostel may configure a shorter retention period (30-600 days)
- You can request immediate deletion at any time (see §8.3)

### 3.4 Who Can See It
- **Hostel admins/wardens**: See your zone status (INSIDE/NEARBY/OUTSIDE) and attendance patterns
- **Guardians**: See only if you grant permission in your settings
- **Other residents**: CANNOT see your location data
- **Platform admins**: Can see aggregated statistics, NOT individual locations

### 3.5 Why We Need It
- Ensure resident safety
- Track hostel occupancy
- Alert management if resident is absent for extended period
- Comply with hostel policies

### 3.6 Your Consent
- You must consent to location tracking during account activation
- You can withdraw consent by:
  - Requesting account deletion
  - Contacting your hostel administrator (may affect your residency)
- If you disable location permissions on your phone, status will be marked as UNKNOWN

---

## 4. Data Sharing & Disclosure

### 4.1 We Share Your Data With:

**Hostel Management**:
- Your personal info, payment status, attendance, complaints (not anonymous ones)
- Your hostel administrator has access to manage your account

**Guardians** (only if you grant permission):
- Payment summary
- Notices
- Night safety status (zone only, never exact location)
- Academic info
- You control what guardians can see via permission settings

**Other Residents**:
- Your community posts (if you choose PUBLIC visibility)
- Your name and photo (in community posts, unless posted anonymously)
- Your ratings/reviews of hostel

**QuestionCall** (if you click the study button and are a student):
- Your name, email, hostel affiliation
- We do NOT share payment info, location data, or complaints

### 4.2 We DO NOT Share With:
- Third-party advertisers
- Data brokers
- Anyone outside the platform without your explicit consent

### 4.3 Legal Disclosure
We may disclose your information if required by law, court order, or to:
- Protect safety of users
- Prevent fraud or abuse
- Comply with legal obligations

---

## 5. Data Security

### 5.1 Security Measures
- All data encrypted in transit (HTTPS/TLS)
- Database access restricted to authorized personnel only
- Regular security audits
- Secure password hashing (bcrypt)
- Two-factor authentication for administrative accounts

### 5.2 Your Responsibility
- Keep your password secure
- Log out from shared devices
- Report suspicious activity immediately

---

## 6. Cookies & Tracking Technologies

### 6.1 Cookies We Use
- **Authentication cookies**: Keep you logged in (httpOnly, secure)
- **Session cookies**: Maintain your session state
- **Analytics cookies**: Understand usage patterns

### 6.2 You Can Control Cookies
- Browser settings to disable cookies
- Note: Disabling cookies may affect platform functionality

---

## 7. Your Rights (GDPR-Style)

### 7.1 Right to Access
- Request a copy of all your personal data
- Request via Settings → Privacy → "Download My Data"

### 7.2 Right to Rectification
- Update your profile information anytime
- Request corrections via hostel administrator

### 7.3 Right to Erasure ("Right to be Forgotten")
- Request account deletion via Settings → Privacy → "Delete Account"
- 60-day grace period before permanent deletion
- See §8 for details on what gets deleted

### 7.4 Right to Data Portability
- Export your data in JSON/CSV format
- Available in Settings → Privacy → "Download My Data"

### 7.5 Right to Object
- Object to location tracking (may affect residency)
- Opt out of non-essential emails
- Control guardian access permissions

### 7.6 Right to Restrict Processing
- Temporarily freeze your account (contact hostel admin)

---

## 8. Account Deletion & Data Retention

### 8.1 Request Account Deletion
1. Go to **/account/privacy** → "Delete my account"
2. Fill out deletion request form (reason required)
3. Confirm deletion request

**What the button does depends on your account** — the page tells you before you
press it (ARCHITECTURE.md §13.0 is the full table):

- **Most accounts** get the 60-day flow in §8.2.
- **Guardians** are removing their guardian *access*, not their account. It
  becomes an ordinary account, which can then be deleted outright.
- **Current residents cannot delete** while they are living in a hostel — the
  hostel needs that record while you are in a bed. You can delete after moving
  out. Staff accounts are closed by your hostel administrator.
- **Hostel owners** cannot delete on the spot, because their residents' payments
  and records depend on the account. The request goes to the platform owner and
  the account keeps working normally until it is reviewed.

### 8.2 60-Day Grace Period
- Your account is immediately **closed** (cannot log in)
- Data is retained for 60 days
- You can **cancel deletion** anytime during this period, using the link in the
  confirmation email — since your account is closed, that link is how you get
  back in
- After 60 days: permanent deletion executed

### 8.3 What Gets Deleted (After 60 Days)
✅ **Immediately Deleted**:
- Your User account
- Resident profile
- All location data (AttendanceLog)
- All device tokens
- All notification receipts
- All consent logs
- Community posts/comments (set to anonymous, author removed)

⚠️ **Retained for Legal/Audit** (anonymized):
- Payment records (amounts, dates — the link to you is removed with your
  resident profile; see the note in ARCHITECTURE.md §13.2 on why the row itself
  is left alone rather than nulled)
- Receipt records (financial audit trail)
- Audit logs (system security, compliance)
- Aggregated analytics (no personal identifiers)

### 8.4 Location Data Deletion (Without Account Deletion)
- Request via Settings → Privacy → "Delete Location History"
- Hostel admin reviews request
- Approved: All AttendanceLog entries deleted
- Aggregated statistics retained (no personal identifiers)

---

## 9. Children's Privacy

- Platform is intended for users aged 16+
- If under 18, guardian consent may be required (varies by country/hostel policy)
- We do not knowingly collect data from children under 13

---

## 10. International Data Transfers

- Data stored on servers in [specify region, e.g., "Singapore" or "US"]
- If you're in EU/EEA: data transfers comply with GDPR standards
- Adequate safeguards in place (e.g., Standard Contractual Clauses)

---

## 11. Changes to Privacy Policy

### 11.1 Updates
- We may update this policy from time to time
- Changes posted with updated "Last Updated" date
- Significant changes: email notification sent

### 11.2 Your Consent to Changes
- Continued use after changes = acceptance
- For material changes (e.g., new data collection): explicit consent required

---

## 12. Contact & Data Protection Officer

### 12.1 Questions or Concerns
- Email: privacy@[platform-domain].com
- Or contact your hostel administrator

### 12.2 Complaints
- If you believe we've violated your privacy rights:
  - Contact us first: privacy@[platform-domain].com
  - If unresolved, you can file complaint with your local data protection authority

---

## 13. Platform Owner Information

**Platform Owner:** [Company Name]  
**Address:** [Company Address]  
**Email:** privacy@[platform-domain].com  
**Phone:** [Support Phone Number]

---

## Appendix: Location Tracking Technical Details (For Transparency)

### How It Works:
1. Your mobile app requests location permission during activation
2. Background service activates at configured times (3x daily)
3. App gets your current location (latitude/longitude)
4. App sends to server: `{ lat: 27.xxxx, lng: 85.xxxx, timestamp }`
5. **Server immediately calculates**: distance from hostel coordinates
6. **Server determines zone**: INSIDE (≤50m), NEARBY (51-200m), OUTSIDE (>200m)
7. **Server stores**: zone status + distance (e.g., "INSIDE, 32m")
8. **Server DISCARDS**: exact latitude/longitude coordinates
9. **Result**: AttendanceLog entry with zone, distance, timestamp

### Why This Matters:
- Even if our database is compromised, attackers get "INSIDE, 32m" not "27.7172°N, 85.3240°E"
- Privacy by design: we can't share what we don't have

### Battery Impact:
- Location checked only 3 times per day (not continuous tracking)
- Uses "balanced" accuracy (not high-precision GPS)
- Minimal battery drain (< 1% per day)

---

_End of PRIVACY_POLICY.md_
