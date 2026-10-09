import { PLATFORM_NAME, PLATFORM_PLAY_STORE_URL } from "@hostel/shared/brand/brand";

import { DEFAULT_LIFETIME } from "./lifetime.defaults";
import { DEFAULT_PLANS } from "./plans.defaults";
import { DEFAULT_SEO } from "./seo.defaults";
import type { SiteConfig } from "./site-config.validation";

/**
 * Shipped defaults. A section that has never been saved falls back to these, so
 * the public site always renders even on a fresh database.
 */
export const DEFAULT_SITE_CONFIG: SiteConfig = {
  apps: { androidApkUrl: "", androidPlayUrl: PLATFORM_PLAY_STORE_URL, demoVideoUrl: "" },
  announcement: {
    enabled: false,
    link: "",
    linkLabel: "",
    message: "",
    tone: "info",
  },
  /**
   * All blank, deliberately. Blank is not "unset and broken" here — each field
   * resolves to a working fallback (see `emailSchema`), so a fresh database
   * sends correctly branded mail from `info@`, `alert@`, `billing@` and friends
   * without anyone visiting the settings page.
   */
  email: {
    alertMailbox: "",
    billingMailbox: "",
    domain: "",
    infoMailbox: "",
    noreplyMailbox: "",
    replyTo: "",
    securityMailbox: "",
    senderName: "",
    supportMailbox: "",
  },
  /**
   * The shipped copy for every prose page on the website and in the app.
   *
   * This is the single source. It was previously seven hardcoded arrays inside
   * seven page components in `apps/web`, plus — the moment the phone grew the
   * same screens — a second set inside `apps/mobile`. See `contentSchema` for
   * why that could not stand.
   *
   * **Every line of the privacy policy must describe something the code
   * actually does.** That rule used to live at the top of
   * `public-privacy-page.tsx`; it lives here now, because this is where the
   * text is. The policy previously promised four things that did not exist —
   * deletion from account settings, a data export, a cookie preferences page,
   * and a 30-day deletion window when the code uses 60 — and never mentioned
   * that the mobile app collects location at all. A policy that overstates is
   * worse than a short one, because each unkept promise is the part someone
   * relies on. If you change what the platform collects or retains, change this.
   *
   * `{siteName}` and `{supportEmail}` are substituted by each client from the
   * `identity` section.
   */
  content: {
    about: {
      highlights: [],
      intro: [
        "{siteName} was founded with a simple goal — make finding and managing student accommodation in Nepal easy, transparent, and trustworthy. What started as a directory has grown into a full-featured platform serving students, hostel owners, wardens, and guardians across the country.",
        "Today, {siteName} powers hundreds of verified hostel listings, processes thousands of inquiries every month, and provides hostel teams with modern tools to manage rooms, residents, payments, food quality, and safety.",
        "We are headquartered in Kathmandu, Nepal, and our team is passionate about using technology to solve real problems for students and hostel operators alike.",
      ],
      noteBody: "Reach out at {supportEmail} — or visit our office in Kathmandu, Nepal.",
      noteTitle: "Want to know more?",
      sections: [
        {
          body: [
            "We believe every student deserves honest, verified information about their accommodation. Every listing on {siteName} goes through a verification process to ensure accuracy.",
          ],
          icon: "shield",
          title: "Trust & Transparency",
        },
        {
          body: [
            "Everything we build starts with the student experience — from easy search and comparison tools to seamless communication with hostel teams.",
          ],
          icon: "users",
          title: "Student First",
        },
        {
          body: [
            "We are modernising Nepal's hostel ecosystem with digital tools for payments, complaints, food feedback, and real-time vacancy tracking.",
          ],
          icon: "target",
          title: "Innovation",
        },
        {
          body: [
            "Hostel admins, wardens, and platform owners are held to clear standards. Our audit-logged system ensures every action is traceable.",
          ],
          icon: "eye",
          title: "Accountability",
        },
        {
          body: [
            "{siteName} connects not just students to hostels, but also families, guardians, and local service providers into one trusted network.",
          ],
          icon: "heart",
          title: "Community",
        },
        {
          body: [
            "Built for Nepal, by a team that understands the local landscape. We design for Nepali students, hostel culture, and the unique needs of the valley.",
          ],
          icon: "building",
          title: "Local First",
        },
      ],
      subtitle: "Our mission, our values, and the team behind Nepal's hostel platform",
    },
    /**
     * Two answers name a control rather than a fact, and each client rewrites
     * those for its own chrome — the website says "the Sign Up button on the top
     * right", the app says "the Profile tab". Everything else is shared text.
     */
    faq: [
      {
        answer:
          "Create an account from the sign-up form, fill in your details, verify your email or phone via OTP, and you are ready to go.",
        question: "How do I create an account?",
      },
      {
        answer:
          "Open Register Hostel and fill out the registration form. Our team will review and verify your listing within 2–3 business days.",
        question: "How do I list my hostel?",
      },
      {
        answer:
          "Yes, you can update your name, email, phone, and profile photo from your account settings after logging in.",
        question: "Can I update my personal information?",
      },
      {
        answer:
          "Use the inquiry system on the hostel detail page, or reach out to our support team directly via email or phone.",
        question: "How do I report an issue with a hostel?",
      },
      {
        answer:
          "Absolutely. We use encryption for all data in transit and at rest, and we never share your personal information with third parties without your consent.",
        question: "Is my data secure on {siteName}?",
      },
    ],
    offerProgram: {
      highlights: [],
      intro: [
        "The Resident Offer Program is how {siteName} makes sure a payment reaches the right month, the right resident and the right hostel — without anyone having to chase it. It costs you one extra step when you pay, and it is the difference between a payment credited the same day and one sitting in a queue waiting to be identified by hand.",
        "Anyone can read the rules below. Applying needs a resident account.",
      ],
      noteBody:
        "Your hostel administration is the right first stop — they can see your invoices, your payments and every receipt issued to you. You can also reach them from the Fees & Payments page in your resident portal.",
      noteTitle: "Not sure about a payment or a receipt?",
      sections: [
        {
          body: [
            "Every invoice you receive carries its own reference code — something like RUP-4821-K.",
            "Quote that code when you pay, and your payment is matched to the right month automatically, usually within minutes instead of waiting on a manual check.",
            "When your hostel verifies a payment that quoted its code, {siteName} issues a certified receipt — stamped for the Resident Offer Program, with a verification code anyone can check.",
            "Every quarter (three Nepali months), {siteName} gives offers to residents with certified receipts.",
          ],
          icon: "sparkles",
          title: "What the Resident Offer Program is",
        },
        {
          body: [
            "You must be a resident of a hostel that uses this platform — the programme runs on the invoices your hostel issues you.",
            "Your resident account must be active, with at least one invoice raised against it.",
            "There is no fee and no minimum. Eligibility is per resident, not per hostel.",
            "If you are not a resident yet, join a hostel on the platform first — the button below will not be available until then.",
          ],
          icon: "user-plus",
          title: "Who is eligible",
        },
        {
          body: [
            "Copy the reference code from your invoice or from the Fees & Payments page in your resident portal.",
            "Paste it into the remarks, purpose or notes field when you make the transfer or wallet payment.",
            "If your bank strips that field or does not offer one, pay as normal — your rent still counts. Only payments that quote the code are certified in the programme.",
          ],
          icon: "badge-check",
          title: "What you need to do",
        },
        {
          body: [
            "Upload your payment screenshot in the resident portal. We email you straight away to confirm we have it.",
            "Nothing is credited to your account until your hostel verifies the payment — a submitted proof is not yet a settled payment.",
            "Once it is verified, we email you the receipt as a PDF and keep a copy in the app and your portal. If your payment quoted its code, the receipt is added to the Resident Offer Program automatically.",
          ],
          icon: "receipt",
          title: "What happens after you pay",
        },
        {
          body: [
            "At the end of each quarter — Baisakh to Asar, Shrawan to Aswin, Kartik to Poush, Magh to Chaitra — {siteName} looks at who holds certified receipts for that quarter.",
            "Residents chosen get either part or all of their next monthly fee paid by {siteName} to their hostel, or a gift from {siteName}.",
            "A fee offer is taken off your next monthly bill by itself. For a gift, our team contacts you.",
            "The perks on offer are listed under Offer Program in the app and your resident portal. Paying every bill with its code is what counts.",
          ],
          icon: "gift",
          title: "Quarterly offers",
        },
        {
          body: [
            "A receipt number unique to that one payment — no two receipts ever share it, even for the same month.",
            "The amount paid, the date it was issued, and the exact dates the payment covers.",
            "The invoice reference code it was matched against, and — for a certified receipt — the Resident Offer Program stamp, a verification code and a QR code.",
            "If a receipt is ever corrected, the original is marked VOID and a replacement is issued with its own number. Both stay readable.",
          ],
          icon: "file-text",
          title: "What is on your receipt",
        },
        {
          body: [
            "Anyone holding a certified receipt — a landlord, a parent, a bank — can scan its QR code or enter its verification code on the Verify a receipt page (/verify-receipt).",
            "The page shows the amount, the hostel, the month and the resident's first name as {siteName} recorded them. If they differ from the paper, the paper is not genuine.",
          ],
          icon: "qr-code",
          title: "Checking a receipt",
        },
        {
          body: [
            "A receipt is our record that the hostel received money. It is not evidence that you sent it — those are opposite directions.",
            "Receipts we issue are marked so our system recognises them, and uploading one as proof of a payment will be refused, including a screenshot of it.",
            "For proof, upload the confirmation from the app or bank you paid with — the screen showing the money leaving your account.",
            "This protects you as much as the hostel: it is what stops one payment being counted twice and your balance going wrong.",
          ],
          icon: "shield-check",
          title: "Why a receipt cannot be used as payment proof",
        },
      ],
      subtitle: "Pay with your code, get certified receipts, and get quarterly offers",
    },
    privacy: {
      highlights: [],
      intro: [
        "{siteName} (“we”, “our”, or “us”) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our hostel management platform.",
        "By using {siteName}, you agree to the collection and use of information in accordance with this policy. If you do not agree, please discontinue use of the platform.",
      ],
      noteBody: "Contact our Data Protection team at {supportEmail}.",
      noteTitle: "Questions about this policy?",
      sections: [
        {
          body: [
            "Personal information you provide when creating an account (name, email, phone number, role).",
            "Hostel details, photos, pricing, and facility information submitted by hostel admins.",
            "Resident data including room assignments, fee records, food preferences, and complaint history.",
            "Guardian information provided for resident emergency contacts and account linking.",
            "Payment evidence you upload — screenshots or receipts — which are stored privately and readable only by you and your hostel's staff.",
            "Identity documents you choose to add to your resident profile, encrypted at rest.",
            "If your hostel uses attendance tracking and you consent, whether you were inside or outside the hostel each day. See 'Location & Attendance' below.",
            "Usage data such as page visits, feature interactions, and device information to improve our service.",
          ],
          icon: "database",
          title: "Information We Collect",
        },
        {
          body: [
            "To operate, maintain, and improve the {siteName} platform and all its features.",
            "To facilitate communication between hostel admins, residents, and guardians.",
            "To process payments, generate receipts, and manage financial records.",
            "To send service-related notifications, updates, and important account information.",
            "To detect, prevent, and address technical issues, fraud, or abuse of the platform.",
          ],
          icon: "eye",
          title: "How We Use Your Information",
        },
        {
          body: [
            "Attendance tracking is optional. It runs only in the mobile app, only if your hostel has enabled it, and only after you have explicitly consented — the server refuses location data from an account that has not.",
            "Your coordinates are never stored. The app sends a reading, the server converts it into a single answer — inside the hostel, or outside — and discards the position. There is no map, no route and no location history to retrieve, because none is kept.",
            "One reading per day is retained. A later reading replaces an earlier one rather than adding to it.",
            "Your hostel's staff and any guardian you have linked can see the daily inside/outside status. They cannot see where you were.",
            "You can withdraw consent at any time, and you can delete your attendance history from the app, which removes those daily records outright.",
          ],
          icon: "map-pin",
          title: "Location & Attendance",
        },
        {
          body: [
            "We do not sell your personal information to third parties.",
            "Hostel-relevant resident data is shared only with the respective hostel administration.",
            "Guardian accounts receive limited, privacy-first access to resident information.",
            "We may share anonymised, aggregated data for analytics and platform improvement.",
            "We will disclose information if required by law or to protect the rights and safety of our users.",
          ],
          icon: "shield",
          title: "Data Sharing & Disclosure",
        },
        {
          body: [
            "All data transmitted between your device and our servers is encrypted using TLS/SSL protocols.",
            "Passwords are hashed and salted — we never store plain-text passwords.",
            "Payment evidence and identity documents are stored in private storage with no public address. They are reachable only through a link that we generate for an authorised viewer and that expires after fifteen minutes.",
            "The personal details on your resident profile are encrypted before they are written to our database.",
            "Each hostel's data is isolated from every other hostel's. A request for a record belonging to another hostel is answered as though it does not exist.",
            "Access to personal data is restricted to authorised personnel only.",
            "We regularly review and update our security practices to maintain data integrity.",
            "In the event of a data breach, affected users will be notified within 72 hours.",
          ],
          icon: "lock",
          title: "Data Security",
        },
        {
          body: [
            "You can review and update the personal details on your profile at any time while signed in.",
            "You can request account deletion from Privacy & your data in your account. What that does depends on who you are: a public user or a moved-out resident is closed immediately; a guardian's account is returned to a normal public account; a hostel owner's request is reviewed by us first, and their account stays active until it is approved.",
            "A resident who is still living in a hostel cannot delete their account, because the hostel needs an accurate record of who is in residence. Ask your hostel to complete your move-out first.",
            "Once a deletion starts, the account is closed at once and permanently erased 60 days later. During those 60 days you can cancel using the link in the confirmation email — you cannot sign in to cancel, which is why the link exists.",
            "Erasure removes your account, profile, notifications, devices, sessions and any attendance records. Payment and receipt records are kept, because a hostel's financial history cannot develop gaps — but they hold only amounts and dates, with nothing left linking them to you. Posts and comments you wrote stay in the conversation as anonymous.",
            "You can opt out of non-essential communications via your notification preferences.",
            "You have the right to file a complaint with your local data protection authority.",
          ],
          icon: "mail",
          title: "Your Rights & Choices",
        },
        {
          body: [
            "We set four cookies, all of them our own and all essential: two that keep you signed in, one that stops a single visitor inflating a hostel's view count, and one that limits how often search can call our language model.",
            "None of them can be read by JavaScript in your browser, and none is used for advertising.",
            "We use no third-party analytics, advertising or tracking cookies, so there is nothing here to opt out of and no consent banner to click through.",
            "You may block cookies in your browser settings, but signing in will not work without the session cookies.",
          ],
          icon: "globe",
          title: "Cookies & Tracking",
        },
      ],
      subtitle: "",
    },
    registerHostel: {
      // Growth claims under "Get your hostel more popular". The live counts
      // above them come from `getPublicPlatformStats`, not from here.
      highlights: [
        { label: "More enquiries once your hostel is listed", value: "3×" },
        { label: "Faster to fill an empty bed", value: "2×" },
        { label: "Less time chasing rent", value: "70%" },
        { label: "Parents who trust a hostel they can see", value: "9 in 10" },
      ],
      intro: [
        "Run your hostel from one place: rooms, residents, rent and food. Your residents and their parents get an app of their own.",
      ],
      noteBody:
        "List your property, manage residents, and give everyone their own portal — all from one place.",
      noteTitle: "Ready to bring your hostel online?",
      sections: [
        {
          body: [
            "Open the dashboard and see how your hostel is doing today.",
            "Beds filled and beds empty",
            "Who has paid this month and who has not",
            "New complaints and requests waiting for you",
          ],
          icon: "layout-dashboard",
          title: "Everything on one screen",
        },
        {
          body: [
            "Add your rooms once and set one rent for each sharing type.",
            "Single, two, three or four sharing",
            "Empty beds are counted for you",
            "Your public page always shows the same rates",
          ],
          icon: "bed",
          title: "Rooms and rates",
        },
        {
          body: [
            "Add a new resident from your phone, step by step.",
            "Room, rent and joining fee in one go",
            "Admission fee and deposit on one bill",
            "They get their own login the same day",
          ],
          icon: "user-plus",
          title: "Register a resident in minutes",
        },
        {
          body: [
            "Scan the resident's card and check their details before you save.",
            "Name, photo, age and home address",
            "Where they are from and what they do",
            "One person can live in only one hostel at a time",
          ],
          icon: "qr-code",
          title: "Know who is moving in",
        },
        {
          body: [
            "Write your fee card and every month's bills are raised on their own.",
            "Months follow the Nepali calendar",
            "Change rates from a future month, old bills stay as they were",
            "Import your eSewa or Khalti statement to match payments",
          ],
          icon: "wallet",
          title: "Set your fees once",
        },
        {
          body: [
            "Residents pay into your own eSewa, Khalti or bank account.",
            "Add your wallet and bank QR once",
            "Each bill has its own reference code",
            "Every payment shows who paid and for which month",
          ],
          icon: "credit-card",
          title: "Money goes straight to you",
        },
        {
          body: [
            "All payments and bills for the month, in one place.",
            "Paid, part paid or due, next to each name",
            "Cash and online payments together",
            "Totals for the month counted for you",
          ],
          icon: "receipt",
          title: "Every rupee in one list",
        },
        {
          body: [
            "Residents see their room, bill, food menu and notices on their phone.",
            "This week's menu and today's meals",
            "Report a complaint with a photo",
            "Night check-in and an SOS button",
          ],
          icon: "home",
          title: "An app for your residents",
        },
        {
          body: [
            "No more chasing rent at the door.",
            "Pay by eSewa or Khalti",
            "Or send a payment screenshot for you to confirm",
            "The receipt stays in their app",
          ],
          icon: "wallet",
          title: "Residents pay from their phone",
        },
        {
          body: [
            "Each resident gets an ID card with a QR code in the app.",
            "Photo, room and hostel on the card",
            "Staff can scan it to check who someone is",
            "Nothing to print or lose",
          ],
          icon: "badge-check",
          title: "A digital ID card for every resident",
        },
        {
          body: [
            "Parents get their own login with just what they need to see.",
            "Fee status and receipts",
            "Food menu and hostel notices",
            "Night check-in summary and emergency contact",
          ],
          icon: "heart",
          title: "Parents stay in the loop",
        },
        {
          body: [
            "Every hostel gets a public page students can find and share.",
            "Photos, rates and facilities",
            "Students call you or send an enquiry",
            "Reviews from people who lived there",
          ],
          icon: "building",
          title: "Your own hostel page",
        },
        {
          body: [
            "Your hostel shows up on the map near their college.",
            "Distance and walking directions",
            "Price and rating on each hostel card",
            "Open your page straight from the map",
          ],
          icon: "map-pin",
          title: "Students find you on the map",
        },
        {
          body: [
            "Verified hostels appear in the app's top picks and nearby lists.",
            "Search by city, area or college",
            "Compare hostels side by side",
            "A verified badge builds trust",
          ],
          icon: "sparkles",
          title: "Show up where students search",
        },
      ],
      subtitle: "For Hostel Owners & Operators",
    },
    /*
     * Read by the public `/service-providers` page and the app's Service
     * providers screen.
     *
     * Two claims were removed here rather than reworded, because neither was
     * true: jobs are **not** broadcast to every matching provider, and there is
     * no "first to accept wins" race. A hostel picks a named provider out of
     * their directory and assigns the job to them. That is a materially
     * different promise to a tradesperson — it makes the profile, not the
     * reaction time, the thing that wins work — and the copy now says so.
     *
     * The city is gone for the same reason: we serve Nepal, and a page that
     * names one city tells everybody outside it that they are not invited.
     *
     * `*asterisks*` in `subtitle` mark the words the hero paints in the brand
     * green; see `renderEmphasis` on the page.
     */
    serviceProviders: {
      highlights: [],
      intro: [
        "Join {siteName} as a service provider and receive real maintenance jobs — plumbing, electrical, cleaning and more.",
        "Hostels raise maintenance requests, and pick a provider in their area to send them to.",
      ],
      noteBody:
        "By continuing you agree this account is used to receive job offers from hostels in your trade and area. No web dashboard is required — once approved, you'll manage jobs from the {siteName} Provider mobile app.",
      noteTitle: "Before you apply",
      sections: [
        {
          body: [
            "Fill in a short form. Only your name, phone, trades and area are required.",
          ],
          icon: "user-plus",
          title: "Apply",
        },
        {
          body: [
            "Our team checks your application and emails you the result with a clear reason.",
          ],
          icon: "badge-check",
          title: "We review",
        },
        {
          body: [
            "On approval you are emailed your Provider Identity Card, with a QR code you show at the gate.",
          ],
          icon: "shield",
          title: "Get verified",
        },
        {
          body: [
            "Hostels send you jobs in the Provider app. You agree the price with them directly — we take no cut.",
          ],
          icon: "wrench",
          title: "Start getting work",
        },
      ],
      subtitle: "Get Steady Maintenance Work from *Hostels* in Nepal",
    },
    terms: {
      highlights: [],
      intro: [
        "Welcome to {siteName}. These Terms & Regulations (“Terms”) govern your access to and use of the {siteName} platform, including any related services, content, and functionality offered through our website and mobile applications.",
        "Please read these terms carefully before using the platform. Depending on your role — hostel admin, resident, guardian, or service provider — additional role-specific terms may apply.",
      ],
      noteBody:
        "Reach out to our support team at {supportEmail} or use the in-app support system.",
      noteTitle: "Have questions?",
      sections: [
        {
          body: [
            "By accessing or using {siteName}, you agree to be bound by these Terms & Regulations.",
            "If you do not agree with any part of these terms, you must not use the platform.",
            "{siteName} reserves the right to update these terms at any time. Users will be notified of material changes via email or platform notice.",
            "Continued use of the platform after changes constitutes acceptance of the updated terms.",
          ],
          icon: "file-text",
          title: "Acceptance of Terms",
        },
        {
          body: [
            "You must provide accurate, current, and complete information when creating an account.",
            "You are solely responsible for maintaining the confidentiality of your login credentials.",
            "Sharing your account with unauthorised individuals is strictly prohibited.",
            "You must notify {siteName} immediately of any unauthorised use of your account.",
            "Each user may hold only one active account unless otherwise authorised.",
            "Users must be at least 16 years of age to create an account on {siteName}.",
          ],
          icon: "user-check",
          title: "User Accounts & Responsibilities",
        },
        {
          body: [
            "All hostel listings must include accurate and up-to-date information including pricing, availability, and facilities.",
            "Photos submitted must be genuine representations of the property — stock photos or misleading imagery are prohibited.",
            "Hostel admins are responsible for keeping room inventory, pricing, and vacancy status current.",
            "Any form of discriminatory listing criteria based on caste, religion, gender, or ethnicity is strictly forbidden.",
            "{siteName} reserves the right to remove or suspend listings that violate these rules.",
          ],
          icon: "home",
          title: "Hostel Listing Rules",
        },
        {
          body: [
            "All fee payments processed through {siteName} are subject to the stated service charges.",
            "{siteName} uses third-party payment processors and is not liable for any issues arising from their services.",
            "Refund policies are determined by individual hostels — {siteName} does not guarantee refunds.",
            "Platform owners and hostel admins are responsible for accurate financial reporting and tax compliance.",
            "Any disputes regarding payments must be raised within 14 days of the transaction date.",
          ],
          icon: "credit-card",
          title: "Payments & Financial Terms",
        },
        {
          body: [
            "Using the platform for any unlawful purpose or in violation of any applicable laws.",
            "Attempting to gain unauthorised access to any part of the platform, user accounts, or systems.",
            "Uploading or transmitting viruses, malware, or any code designed to disrupt the platform.",
            "Harassing, threatening, or abusing other users, hostel staff, or {siteName} personnel.",
            "Engaging in any activity that interferes with or disrupts the platform's services.",
            "Using bots, scrapers, or automated tools to extract data without prior written consent.",
          ],
          icon: "ban",
          title: "Prohibited Activities",
        },
        {
          body: [
            "{siteName} is provided “as is” without warranties of any kind, either express or implied.",
            "We do not guarantee that the platform will be uninterrupted, secure, or error-free at all times.",
            "{siteName} is not responsible for the actions, conduct, or content of hostel admins, residents, or guardians.",
            "In no event shall {siteName} be liable for any indirect, incidental, or consequential damages.",
            "The total liability of {siteName} for any claims shall not exceed the fees paid by you in the preceding 12 months.",
          ],
          icon: "alert-triangle",
          title: "Limitation of Liability",
        },
        {
          body: [
            "Any disputes arising from these terms shall first be attempted to be resolved through informal negotiation.",
            "If a dispute cannot be resolved informally, it shall be settled by binding arbitration in Kathmandu, Nepal.",
            "Users agree to resolve disputes on an individual basis — class actions are waived to the extent permitted by law.",
            "These terms are governed by the laws of Nepal, without regard to its conflict of law provisions.",
          ],
          icon: "scale",
          title: "Dispute Resolution",
        },
        {
          body: [
            "For questions about these terms, contact us at {supportEmail}.",
            "Legal notices should be sent to: {siteName} Legal, Kathmandu, Nepal.",
            "Response times for legal inquiries are typically within 5–7 business days.",
            "For urgent platform issues, use the in-app support system for fastest resolution.",
          ],
          icon: "mail",
          title: "Contact & Support",
        },
      ],
      subtitle: "",
    },
  },
  facilities: [
    { enabled: true, icon: "wifi", label: "Free WiFi", slug: "wifi" },
    { enabled: true, icon: "utensils", label: "Meals Included", slug: "meals" },
    { enabled: true, icon: "shirt", label: "Laundry", slug: "laundry" },
    { enabled: true, icon: "car", label: "Parking", slug: "parking" },
    { enabled: true, icon: "shield", label: "24/7 Security", slug: "security" },
    { enabled: true, icon: "camera", label: "CCTV", slug: "cctv" },
    { enabled: true, icon: "zap", label: "Power Backup", slug: "power-backup" },
    { enabled: true, icon: "droplet", label: "Hot Water", slug: "hot-water" },
    { enabled: true, icon: "book", label: "Study Room", slug: "study-room" },
    { enabled: true, icon: "dumbbell", label: "Gym", slug: "gym" },
  ],
  features: {
    compare: true,
    inquiries: true,
    publicRegistration: true,
    reviews: true,
    serviceProviderSignup: true,
  },
  hero: {
    headline: "Find a hostel you can actually trust",
    primaryCtaHref: "/hostels",
    primaryCtaLabel: "Browse Hostels",
    searchPlaceholder: "Search by city, area, or hostel name",
    secondaryCtaHref: "/register-hostel",
    secondaryCtaLabel: "List Your Hostel",
    subheadline:
      "Verified hostels across Nepal with real photos, transparent pricing, and honest resident reviews.",
  },
  identity: {
    address: "Kathmandu, Nepal",
    siteName: PLATFORM_NAME,
    /**
     * Published in the public footer, so it has to be a domain that exists.
     * The previous default was `support@hostelhub.com.np` — a plausible-looking
     * address nobody owns — which sat unnoticed until it leaked into the email
     * `Reply-To` and bounced. A placeholder that looks real is worse than an
     * obvious one; this is the actual Softmato support address.
     */
    supportEmail: "support@softmato.com",
    supportPhone: "+977-1-5432123",
    tagline: "Find & manage hostels in Nepal",
  },
  /**
   * The parent company, as it prints on a plan invoice or receipt.
   *
   * Real details, not placeholders — see `issuerSchema` for why a document
   * carrying a plausible-looking PAN is worse than one carrying an obvious
   * blank. `vatRegistered: false` is the current fact and it puts the "no VAT
   * is charged on this document" footnote on the page.
   */
  issuer: {
    address: "Kathmandu, Nepal",
    email: "info@softmato.com",
    legalName: "Softmato Technology Private Limited",
    pan: "623692242",
    phone: "9709155982",
    productName: PLATFORM_NAME,
    vatRegistered: false,
  },
  legal: {
    privacy: { body: "", updatedAt: "" },
    refund: { body: "", updatedAt: "" },
    terms: { body: "", updatedAt: "" },
  },
  /** The lifetime deal — kept apart from `plans`; see `lifetimeSchema`. */
  lifetime: DEFAULT_LIFETIME,
  /**
   * The cities the platform is open in. Two surfaces read this, and the second
   * one is why the order matters:
   *
   * 1. The public site's search and registration filters (`areas` fills the
   *    area dropdown under each city).
   * 2. The mobile home screen's **Popular Cities** row, which draws one card per
   *    enabled city **in this order** and shows each one's real listing count —
   *    `0` included. So this list is the launch plan, not a report: a city
   *    belongs here as soon as the business is open in it, and its card is what
   *    the first hostel there will have been found through.
   *
   * Edited at Website Config → Locations, which is where it should be changed —
   * these are the shipped defaults for a fresh database, nothing more.
   */
  locations: [
    {
      areas: ["Baneshwor", "Koteshwor", "Kirtipur", "Dillibazar", "Bhaisepati"],
      city: "Kathmandu",
      enabled: true,
    },
    { areas: ["Lalitpur", "Bagdol", "Jhamsikhel"], city: "Lalitpur", enabled: true },
    { areas: ["Suryabinayak", "Thimi"], city: "Bhaktapur", enabled: true },
    { areas: ["Lakeside", "Bagar", "Chipledhunga"], city: "Pokhara", enabled: true },
    { areas: ["Bharatpur", "Narayangarh", "Sauraha"], city: "Chitwan", enabled: true },
    { areas: ["Biratnagar"], city: "Biratnagar", enabled: true },
  ],
  /**
   * The whole Plans & Pricing catalogue — tiers, modules, services and the
   * writing on every service page. Authored in Platform → Website Config →
   * Plans & Pricing; see `plans.defaults.ts` for why it is data rather than a
   * component constant.
   */
  plans: DEFAULT_PLANS,
  questionCall: {
    enabled: true,
    label: "QuestionCall",
    url: "https://questioncall.com/app?install&from=hostelpalika",
  },
  /** Page titles, descriptions and the marketing pages written for search — see `seo.defaults.ts`. */
  seo: DEFAULT_SEO,
  social: {
    facebook: "",
    instagram: "",
    linkedin: "",
    tiktok: "",
    website: "",
    youtube: "",
  },
  stats: [
    { label: "Verified hostels", suffix: "+", value: "1,248" },
    { label: "Active residents", suffix: "+", value: "18,742" },
    { label: "Cities covered", suffix: "", value: "12" },
    { label: "Average rating", suffix: "/5", value: "4.6" },
  ],
  trustPoints: [
    {
      description:
        "Every listing is checked against ownership papers before it goes live.",
      icon: "shield",
      title: "Verified listings only",
    },
    {
      description:
        "Monthly rent, deposit, and extra charges shown upfront — no surprises.",
      icon: "wallet",
      title: "Transparent pricing",
    },
    {
      description: "Reviews come from activated residents, not anonymous accounts.",
      icon: "star",
      title: "Real resident reviews",
    },
    {
      description: "Guardians get fee and safety visibility without invading privacy.",
      icon: "users",
      title: "Built for families",
    },
  ],
};
