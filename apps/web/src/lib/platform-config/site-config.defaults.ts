import { PLATFORM_NAME, PLATFORM_PLAY_STORE_URL } from "@hostel/shared/brand/brand";

import { DEFAULT_LIFETIME } from "@/lib/platform-config/lifetime.defaults";
import { DEFAULT_PLANS } from "@/lib/platform-config/plans.defaults";
import { DEFAULT_SEO } from "@/lib/platform-config/seo.defaults";
import type { SiteConfig } from "@/lib/platform-config/site-config.validation";

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
            "Your monthly bill carries your month code — something like RUP-482K-BHA83. Your part stays the same every month; only the month changes.",
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
        "This policy explains what {siteName} collects, why, who can see it, how long we keep it and what you can do about it. {siteName} is run by Softmato Technology Private Limited, Kathmandu, Nepal (“we”, “us”).",
        "It covers our website, apps and services. By using {siteName}, you agree to this policy. If you do not agree, please do not use {siteName}.",
      ],
      noteBody: "Write to us at {supportEmail}.",
      noteTitle: "Questions about this policy?",
      sections: [
        {
          body: [
            "Your account details: name, email, phone number and role.",
            "Hostel details, photos, prices and facilities that hostel owners add.",
            "What your hostel keeps about you: room, rent and fees, receipts, food choices, attendance, notices and complaints.",
            "Guardian details added for emergency contact and linking.",
            "Payment screenshots or receipts you upload. They are kept private. Only you, your hostel's staff and our team (when checking a payment) can open them.",
            "ID documents you add to your resident profile, stored encrypted.",
            "Photos, voice notes and files you attach to complaints, repair requests and posts, and what you write in posts, comments and reviews.",
            "If your hostel uses attendance and you agree, whether you were inside or outside the hostel each day. See 'Location and attendance' below.",
            "Technical details: IP address, phone or browser type, app version and sign-in times. We use these to keep accounts safe and stop abuse.",
            "How you use {siteName}, like pages you open and buttons you tap, so we can improve it.",
          ],
          icon: "database",
          title: "What we collect",
        },
        {
          body: [
            "To run and improve {siteName}.",
            "To help hostels, residents and guardians talk to each other.",
            "To handle payments, make receipts and keep money records.",
            "To check hostels and their papers before giving the Verified badge.",
            "To send you account and service messages.",
            "To find and stop faults, fraud, spam and misuse, and to apply our Terms.",
            "To follow the law, including tax rules and lawful requests from the authorities.",
          ],
          icon: "eye",
          title: "Why we use it",
        },
        {
          body: [
            "If you live in a hostel that uses {siteName}, the hostel decides what it records about you. The hostel must collect it fairly and with your consent, as the Individual Privacy Act, 2075 asks. We only store and handle it for the hostel.",
            "Your hostel's staff can see their own residents' records. Other hostels cannot.",
            "To see, fix or remove what a hostel has recorded about you, ask the hostel first. If they cannot help, write to us and we will work with them.",
            "When you move out, the hostel keeps the records it needs, such as your stay and payments.",
          ],
          icon: "building",
          title: "Your hostel and your details",
        },
        {
          body: [
            "Children should not sign up on their own. Anyone under 18 can use {siteName} only if a parent or guardian agrees.",
            "A hostel that adds a resident under 18 must have that agreement and is responsible for it.",
            "If a child's details were added without that agreement, write to {supportEmail} and we will help remove them.",
          ],
          icon: "heart",
          title: "Residents under 18",
        },
        {
          body: [
            "Attendance is optional. It works only in the app, only if your hostel turns it on, and only after you say yes. The server refuses location from anyone who has not.",
            "We never store your exact location. The app sends a reading, the server turns it into one answer — inside or outside the hostel — and throws the location away. There is no map, route or location history, because none is kept.",
            "Only one answer per day is kept. A newer one replaces the older one.",
            "Your hostel's staff and any guardian you linked can see whether you were inside or outside each day. They cannot see where you were.",
            "You can say no at any time, and you can delete your attendance history from the app.",
            "When you use your current location — for example to find hostels near you or to put a hostel on the map — we use it only for that request and do not save it to your account.",
          ],
          icon: "map-pin",
          title: "Location and attendance",
        },
        {
          body: [
            "We never sell your personal details.",
            "Resident details are shared only with your own hostel.",
            "Guardians see only what the resident chooses to share.",
            "Your name is shown on community posts, comments and reviews you publish.",
            "We share data with the companies listed below, only so they can do their job for us.",
            "We may share totals and statistics that do not show who anyone is.",
            "If {siteName} is sold or merged, your details may move to the new owner, who must follow this policy.",
            "We share details when the law asks, or when we need to protect the safety or rights of our users, the public or {siteName}, or to look into fraud and misuse.",
          ],
          icon: "shield",
          title: "Who we share it with",
        },
        {
          body: [
            "MongoDB Atlas (our database, with servers in Mumbai, India) and Cloudflare (file storage). This means your data is kept outside Nepal. By using {siteName} you agree to this.",
            "Resend, which sends our emails.",
            "Google, Apple and your browser's push services, which deliver notifications.",
            "Google Maps and OpenStreetMap, which turn addresses into map points and back.",
            "eSewa and Khalti, which handle online payments. We never see your wallet PIN or password.",
            "Google Cloud Vision, which reads the text on payment screenshots to match a payment to its bill.",
            "AI services that read some searches you type, to turn them into search filters. Only the search words are sent — never your name or account — so do not type personal details into search.",
            "Google, if you choose to sign in with Google.",
          ],
          icon: "wrench",
          title: "Companies that help us",
        },
        {
          body: [
            "Everything between your phone and our servers is encrypted (HTTPS).",
            "Passwords are scrambled (hashed and salted). We never keep them as plain text.",
            "Payment proofs and ID documents are kept in private storage with no public link. We make a link only for someone allowed to see them, and it stops working after 15 minutes.",
            "Your resident profile details are encrypted before we save them.",
            "Each hostel's data is kept apart. A request for another hostel's record is answered as if it does not exist.",
            "We limit how often sign-ins, codes, password resets, invites and posts can be repeated, to stop guessing, spam and bots.",
            "Only staff who need it can see personal data.",
            "We keep checking and improving our security.",
            "If a security problem affects your personal data, we will tell you, and the authorities where the law asks, as soon as we can.",
            "No system is 100% safe. We work hard to protect your data, but we cannot promise it will never be seen, changed or lost by someone who should not have it.",
          ],
          icon: "lock",
          title: "Keeping your data safe",
        },
        {
          body: [
            "We keep your account while it is open, and erase it as described in 'Your rights' when you delete it.",
            "Payment, invoice and receipt records, and our activity logs, are kept as long as tax and accounting laws ask, even after an account is closed.",
            "Our backups are replaced over time, so deleted data can stay in a backup for a short while before it is overwritten.",
            "Security records, like one-time codes and failed sign-ins, are deleted on their own when no longer needed.",
          ],
          icon: "file-text",
          title: "How long we keep it",
        },
        {
          body: [
            "You can see and change your profile details any time while signed in.",
            "You can ask us at {supportEmail} for a copy of your personal data, or to correct it.",
            "You can ask to delete your account from Privacy & your data in your account. What happens depends on who you are: a public user or a resident who has moved out is closed at once; a guardian's account goes back to a normal account; a hostel owner's request is checked by us first, and the account stays open until we approve it.",
            "A resident still living in a hostel cannot delete their account, because the hostel needs a true record of who lives there. Ask your hostel to complete your move-out first.",
            "Once deletion starts, the account is closed at once and fully erased 60 days later. In those 60 days you can cancel with the link in the email — you cannot sign in to cancel, which is why the link exists.",
            "Erasing removes your account, profile, notifications, devices, sign-ins and attendance records. Payment and receipt records stay, because a hostel's money records cannot have gaps, but they keep only amounts and dates, with nothing linking them to you. Posts and comments you wrote stay, shown as anonymous.",
            "You can turn off non-essential messages in your notification settings.",
            "You can complain to the authority that Nepal's law names for privacy matters.",
          ],
          icon: "user-check",
          title: "Your rights",
        },
        {
          body: [
            "We use only our own cookies, and only the ones we need: to keep you signed in, to remember that you unlocked the app lock, to stop one visitor counting many times on a hostel's views, and to limit how often search uses AI.",
            "None of them can be read by scripts in your browser, and none are used for ads.",
            "We use no outside analytics, ad or tracking cookies, so there is nothing to turn off and no cookie banner.",
            "You can block cookies in your browser, but then you cannot stay signed in.",
          ],
          icon: "globe",
          title: "Cookies",
        },
        {
          body: [
            "We may update this policy as {siteName} changes or the law asks. The date at the top shows the latest version.",
            "If a change makes a big difference to how we use your details, we tell you by email or in the app before it starts.",
            "If you keep using {siteName} after a change, you accept the new policy.",
          ],
          icon: "mail",
          title: "Changes to this policy",
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
        "Welcome to {siteName}. These terms are the rules for using our website and apps. {siteName} is run by Softmato Technology Private Limited, a company in Nepal (“we”, “us”).",
        "Please read them. Hostel owners, residents, guardians and service providers may have a few extra rules for their role.",
      ],
      noteBody:
        "Reach out to our support team at {supportEmail} or use the in-app support system.",
      noteTitle: "Have questions?",
      sections: [
        {
          body: [
            "When you make an account or use {siteName}, you agree to these terms and our Privacy Policy.",
            "Ticking a box, tapping a button or simply using the app counts as signing, the same as signing on paper (Electronic Transactions Act, 2063).",
            "If you do not agree, do not use {siteName}.",
            "If you use {siteName} for a hostel or a business, you confirm that you are allowed to agree for it.",
            "We may change these terms. We will tell you about big changes by email or in the app. The date at the top shows the latest version.",
            "If you keep using {siteName} after a change, you accept the new terms.",
          ],
          icon: "file-text",
          title: "Agreeing to these terms",
        },
        {
          body: [
            "Give us true and up-to-date details.",
            "Keep your password secret. You are responsible for everything done from your account, including by wardens, cooks or anyone you let in.",
            "Do not share your account with anyone.",
            "Tell us straight away if someone else uses your account.",
            "One person, one account, unless we allow more.",
            "You must be 18 or older to make your own account. A resident under 18 can use {siteName} only if a parent or guardian agrees, and the hostel that adds them must get that agreement.",
          ],
          icon: "user-check",
          title: "Your account",
        },
        {
          body: [
            "{siteName} is software. We do not own, run or check any hostel. We are not a landlord or an agent, and we are not part of any deal between a hostel and its residents, guardians, staff or service providers.",
            "Each hostel is fully responsible for its building, licences, safety, services, prices, rules and staff, and for what it shows on {siteName}.",
            "The Verified badge only means we checked the papers a hostel sent us at that time. It does not promise that the hostel is good, safe or legal. Check for yourself before you pay or move in.",
            "Ratings, reviews and posts are written by users. We do not check them first and we are not responsible for them.",
            "Service providers work for themselves. The hostel and the provider agree the job and the price between them.",
          ],
          icon: "building",
          title: "What we are, and what we are not",
        },
        {
          body: [
            "Listings must show true, current prices, free beds and facilities.",
            "Photos must be real photos of the hostel. No stock or misleading photos.",
            "Keep your rooms, prices and free beds up to date.",
            "Do not refuse anyone because of caste, religion, gender or ethnicity.",
            "Have every registration and licence the law asks for, and follow the law on tax, safety and residents' personal details.",
            "Only add residents' or guardians' details, documents or photos with their consent, as the Individual Privacy Act, 2075 asks.",
            "We can remove or pause a listing that breaks these rules.",
          ],
          icon: "home",
          title: "Rules for hostel listings",
        },
        {
          body: [
            "Rent, deposits and fees that residents pay go straight to the hostel's own eSewa, Khalti, bank or QR. We never hold that money and we are not responsible for it.",
            "Each hostel sets its own fees and refund rules, and sorts out any disagreement about them.",
            "Booking fees and plan fees paid to us follow our Refund Policy and, for hostels, the agreement signed during KYC.",
            "Pay us only inside {siteName}, or to the official QR or bank account on your invoice. We are not responsible for money paid to anyone else.",
            "Online payments go through services like eSewa and Khalti. We are not responsible if they fail, are late or charge you.",
            "Hostels keep their own accounts and pay their own taxes.",
            "Tell us about a problem with a payment you made to us within 14 days.",
          ],
          icon: "credit-card",
          title: "Money",
        },
        {
          body: [
            "What you add — listings, photos, reviews, posts, comments and files — stays yours.",
            "You let us, free of charge, store, show, resize and share it on {siteName} and use it to promote {siteName} — for example a hostel's photos in search, on the map or in our ads. This stops when you delete it, except copies others already shared or that the law makes us keep.",
            "Only add what you have the right to add, and nothing that breaks the law or someone's copyright or privacy.",
            "We can remove or hide anything that breaks these rules or the law, or that we think is harmful, without warning.",
            "Reviews must be honest and about a real stay. No paid, fake or swapped reviews.",
          ],
          icon: "badge-check",
          title: "What you add",
        },
        {
          body: [
            "Break the law using {siteName}.",
            "Try to get into accounts, data or systems that are not yours.",
            "Upload viruses or anything that harms the platform.",
            "Harass, threaten or abuse anyone — users, hostel staff or our team.",
            "Slow down or break the platform.",
            "Use bots or scrapers to copy data without our written OK.",
            "Send spam, ads, chain messages or invitations people did not ask for.",
            "Make fake or extra accounts, or switch accounts, phones or networks to get around limits or bans.",
            "Post fake listings, fake reviews, fake payment proof or someone else's documents.",
            "Pretend to be someone else, another hostel or {siteName}.",
            "Share someone's personal details without their OK, or post hateful, sexual, or false and harmful content, or anything that puts children at risk.",
            "Copy, take apart or resell {siteName}, or use it to build a rival service.",
            "Test {siteName} for security holes without our written OK. If you find one, tell us at {supportEmail} and do not use or share it.",
            "Raise false SOS or safety alerts.",
            "If you break these rules, we can remove your content, pause or close your account, and report you to the police where the law asks.",
          ],
          icon: "ban",
          title: "Things you must not do",
        },
        {
          body: [
            "SOS, night check-in, attendance and notifications help a hostel stay in touch with its residents. They are not an emergency service and do not replace the police, fire brigade or ambulance.",
            "In an emergency, first call Police on 100, Fire on 101 or Ambulance on 102.",
            "Alerts need phones, internet, app stores and push services that we do not control, so we cannot promise that any alert arrives, is seen or is acted on in time.",
            "Attendance uses the phone's location, which can be wrong. It is not proof of where someone was.",
          ],
          icon: "alert-triangle",
          title: "SOS is not an emergency service",
        },
        {
          body: [
            "We may add, change or remove features, and limit how often a feature can be used, to keep things fair and safe.",
            "We may pause {siteName} for upkeep or for reasons we cannot control.",
            "Keep your own copies of records you need. Hostels can download their records and ask us for a full copy, as their agreement says. We keep backups, but if data is lost, the most we do is bring back our latest backup.",
          ],
          icon: "layout-dashboard",
          title: "When the service changes or stops",
        },
        {
          body: [
            "You can stop using {siteName} and delete your account at any time, as our Privacy Policy explains.",
            "We can pause, limit or close any account, listing or content, with or without warning, if we believe it breaks these terms or the law, puts others at risk, or could get us into legal or money trouble.",
            "A hostel with a signed agreement is paused or ended the way that agreement says.",
            "Some parts keep applying after an account is closed: What you add, If something goes wrong, Covering our costs, and Disagreements.",
          ],
          icon: "lock",
          title: "Closing an account",
        },
        {
          body: [
            "{siteName} works with services we do not control, like eSewa, Khalti, Google and map providers. Their own rules apply, and we are not responsible for them.",
          ],
          icon: "globe",
          title: "Other companies' services",
        },
        {
          body: [
            "The {siteName} name, logo, apps, website and software belong to Softmato Technology Private Limited.",
            "Do not copy, change or share any part of them, or use our name or logo, without our written OK.",
          ],
          icon: "shield-check",
          title: "Our name and software",
        },
        {
          body: [
            "We provide {siteName} as it is, as far as the law allows. We do not promise it will suit every need.",
            "We do not promise that {siteName} will always work, be safe from attack or be free of mistakes, or that everything on it is complete or correct.",
            "We are not responsible for what hostels, residents, guardians, staff, service providers or other users do, say, offer or post.",
            "As far as the law allows, we do not pay for indirect loss — such as lost profit, lost income, lost bookings, lost data or harm to your name.",
            "As far as the law allows, if we ever owe you money, the most we will pay is what you paid us in the 12 months before the problem. If you paid us nothing, the most is Rs 1,000.",
            "None of this takes away any right that the law says cannot be taken away.",
          ],
          icon: "alert-triangle",
          title: "If something goes wrong",
        },
        {
          body: [
            "If someone makes a claim against us because of how you used {siteName}, what you added, a rule or law you broke, or your dealings with other users, you pay the losses and costs this causes us, including reasonable lawyer fees.",
            "For a hostel, this includes claims about its building, its residents' details and what its staff do.",
          ],
          icon: "shield",
          title: "Covering our costs",
        },
        {
          body: [
            "If you have a problem with us, write to us first. We will both try honestly to sort it out within 30 days.",
            "If we cannot, one arbitrator in Kathmandu decides it, under the Arbitration Act, 2055. It can be in English or Nepali, and the decision is final.",
            "We can still ask a Kathmandu court for urgent help, for example to stop someone misusing {siteName} or its data.",
            "Each person brings their own claim. No group claims, as far as the law allows.",
            "As far as the law allows, a claim must be made within one year of what caused it.",
            "For a hostel with a signed agreement, that agreement's rules on disagreements apply instead.",
            "These terms follow the laws of Nepal.",
          ],
          icon: "scale",
          title: "Disagreements",
        },
        {
          body: [
            "These terms, our Privacy Policy, our Refund Policy and, for hostels, their signed agreement are the full deal between you and us. If the hostel agreement says something different, the agreement wins.",
            "If one part of these terms cannot be used, the rest still applies.",
            "If we do not act on a rule straight away, we can still act on it later.",
            "We can pass these terms to a company that takes over {siteName}. You cannot pass yours to someone else without our written OK.",
            "We are not responsible for delays or failures caused by things we cannot control, like power cuts, internet or network failures, disasters, strikes or government action.",
            "We may send notices to your account email or inside the app. They count as received once sent.",
            "If these terms are translated, the English version is the one that counts.",
          ],
          icon: "file-text",
          title: "Other things",
        },
        {
          body: [
            "Questions about these terms: {supportEmail}.",
            "Legal notices: Softmato Technology Private Limited, Kathmandu, Nepal, or {supportEmail}.",
            "For urgent problems with the app, use in-app support — it is the fastest.",
          ],
          icon: "mail",
          title: "Contact us",
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
    supportLines: [],
    tagline: "A Hostel Management Eco-Software",
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
    guide: { updatedAt: "18 November 2026", version: "1.0" },
    privacy: { body: "", updatedAt: "18 November 2026" },
    refund: { body: "", updatedAt: "" },
    terms: { body: "", updatedAt: "18 November 2026" },
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
  logs: { levels: {
    auth: "default",
    database: "default",
    email: "default",
    http: "default",
    jobs: "default",
    llm: "default",
    payments: "default",
    push: "default",
    realtime: "default",
    redis: "default",
    security: "default",
    storage: "default",
  } },
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
  appNotice: {
    audience: "EVERYONE",
    buttonLabel: "",
    enabled: false,
    id: "",
    link: "",
    message: "",
    title: "",
  },
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
