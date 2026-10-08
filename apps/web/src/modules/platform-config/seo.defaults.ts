import type { SeoConfig, SeoPageKey } from "./site-config.validation";

/** Where each titled page lives — for the admin editor's labels and the sitemap. */
export const SEO_PAGE_ROUTES: Record<SeoPageKey, { label: string; path: string }> = {
  about: { label: "About", path: "/about" },
  community: { label: "Community", path: "/community" },
  compare: { label: "Compare hostels", path: "/compare" },
  contact: { label: "Contact", path: "/contact" },
  features: { label: "Features", path: "/features" },
  home: { label: "Home", path: "/" },
  hostels: { label: "Browse hostels", path: "/hostels" },
  login: { label: "Log in", path: "/login" },
  map: { label: "Hostel map", path: "/map" },
  offerProgram: { label: "Resident Offer Program", path: "/resident-offer-program" },
  plansPricing: { label: "Plans & Pricing", path: "/plans-pricing" },
  privacy: { label: "Privacy policy", path: "/privacy" },
  registerHostel: { label: "List your hostel", path: "/register-hostel" },
  serviceProviders: { label: "Service providers", path: "/service-providers" },
  signup: { label: "Sign up", path: "/signup" },
  software: { label: "Hostel management software", path: "/hostel-management-software" },
  terms: { label: "Terms of service", path: "/terms" },
  refundPolicy: { label: "Refund policy", path: "/refund-policy" },
  howBookingWorks: { label: "How booking works", path: "/how-booking-works" },
};

/**
 * The shipped search copy — the default value of the `seo` config section, and
 * the fallback for any page title or description an owner leaves blank.
 *
 * ## What is written here, and what is not
 *
 * Titles lead with what the reader typed (hostels in Nepal, hostel management
 * system, resident management) and end with the brand, which the title template
 * adds. Every claim is something the product does today, checked against the
 * plans catalogue — no invented counts, awards, response times or "free" where
 * nothing is free. Pages about a city or a hostel are not here: their copy is
 * computed from the listings themselves.
 *
 * `{siteName}` and `{fromPrice}` are filled at render time.
 */
export const DEFAULT_SEO: SeoConfig = {
  alternateNames: [
    "hostelpalika",
    "hostelpalika.com",
    "Hostel Palika",
    "Palika Hostel",
    "PalikaHostel",
    "HostelPalika Nepal",
  ],
  comparisons: [
    {
      description:
        "Running your hostel on Excel or Google Sheets? See where a spreadsheet stops — rent, payment proof, parents and night attendance — and what {siteName} does instead.",
      faq: [
        {
          answer:
            "Yes. When your hostel joins, the residents already living there are added through the existing-residents list, with the month each of them has paid up to, so nobody is billed twice.",
          question: "Can I bring the residents from my spreadsheet into {siteName}?",
        },
        {
          answer:
            "No. {siteName} has a dedicated app designed for phones, with its own screens for owners, wardens, cooks, residents and parents. Everything also works in a web browser when a bigger screen is easier.",
          question: "Do my staff need a computer?",
        },
      ],
      intro: [
        "Most hostels in Nepal start with a spreadsheet: one sheet for residents, one for rent, a column for every month. It works until the hostel fills up, a second person edits the file, or a parent calls to ask whether their child has paid.",
        "This is a plain comparison of a spreadsheet and {siteName} for the jobs a hostel does every month.",
      ],
      name: "Excel & Google Sheets",
      rows: [
        {
          label: "Monthly rent",
          them: "Typed or copied every month. A missed row is a missed bill.",
          us: "Invoices raised automatically every month from your rent for each room type.",
        },
        {
          label: "Payment proof",
          them: "eSewa and Khalti screenshots arrive on WhatsApp and are checked by eye.",
          us: "Screenshots are read and checked against the invoice, and wallet statements are matched line by line.",
        },
        {
          label: "Receipts and balances",
          them: "Worked out by hand when someone asks.",
          us: "A receipt for every recorded payment and a running balance on each resident's phone.",
        },
        {
          label: "Rooms and vacancies",
          them: "Worked out from rows and memory.",
          us: "A room and bed map you allocate from, with vacant beds always current.",
        },
        {
          label: "Who is in tonight",
          them: "Not tracked, or kept in a separate paper register.",
          us: "Night status from every resident. Location is used for the check and never stored.",
        },
        {
          label: "Parents",
          them: "Calls and messages to the owner.",
          us: "Their own login, showing fees, notices and safety alerts for their child only.",
        },
        {
          label: "On a phone",
          them: "A spreadsheet squeezed onto a small screen.",
          us: "A dedicated {siteName} app designed for phones, with separate screens for owners, wardens, cooks, residents and parents.",
        },
        {
          label: "Staff access",
          them: "Anyone with the file can see and change everything.",
          us: "Wardens and cooks get their own accounts, limited to the part of the work they do.",
        },
        {
          label: "Finding new residents",
          them: "Nothing — the sheet is private.",
          us: "A public page, a pin on the hostel map and a place in search where students and parents compare hostels.",
        },
        {
          label: "Cost",
          them: "Free, plus the hours spent keeping it right.",
          us: "Plans from {fromPrice} a month.",
        },
      ],
      slug: "excel-spreadsheets",
      stayWith: [
        "You run a small house with a handful of long-term residents who pay in cash, and one person keeps the sheet.",
        "You only need a record of who lives where — not billing, parents, food or attendance.",
      ],
      title: "{siteName} vs Excel for Hostel Management",
    },
    {
      description:
        "Still keeping residents, rent and night attendance in a register book? Compare a paper register with {siteName}, the hostel management system built for Nepal.",
      faq: [
        {
          answer:
            "Many hostels keep both at first. {siteName} does not stop you writing things down; it makes sure the record that matters is not the only copy.",
          question: "Can I keep my register book as well?",
        },
      ],
      intro: [
        "The register book is how most hostels in Nepal have always run: names and phone numbers at the front, rent ticked month by month, and another book at the gate for the night.",
        "It costs nothing and never needs charging. But it exists in one place, only the person holding it can answer a question, and it cannot tell a worried parent anything at ten at night.",
      ],
      name: "Paper register & notebooks",
      rows: [
        {
          label: "Resident records",
          them: "One book at the desk. Lost or soaked, it is gone.",
          us: "Every resident, room, guardian and history kept online and open in the {siteName} app on any staff phone.",
        },
        {
          label: "Rent due",
          them: "Worked out by turning pages at the start of the month.",
          us: "Invoices raised automatically in Bikram Sambat months, with each resident's running balance.",
        },
        {
          label: "Receipts",
          them: "Handwritten, if at all.",
          us: "A receipt for every recorded payment, on the resident's phone.",
        },
        {
          label: "Night attendance",
          them: "A gate register someone has to read.",
          us: "Night status from each resident and a list of who is in tonight for the warden.",
        },
        {
          label: "Emergencies",
          them: "Phone calls, one person at a time.",
          us: "One SOS press alerts the hostel staff and the resident's guardians together.",
        },
        {
          label: "Complaints",
          them: "Told to whoever is at the desk, and forgotten.",
          us: "Logged with a status and a person responsible until they are closed.",
        },
        {
          label: "Food menu",
          them: "Written on a board in the dining hall.",
          us: "The week's menu on every resident's phone, and a rating for each meal.",
        },
      ],
      slug: "paper-register",
      stayWith: [
        "Your staff and residents do not use smartphones, or the hostel has no dependable internet.",
        "You want a signed paper record as well as a digital one — plenty of hostels keep both.",
      ],
      title: "{siteName} vs a Hostel Register Book",
    },
  ],
  keywords: [
    "HostelPalika",
    "hostelpalika",
    "hostelpalika.com",
    "Hostel Palika",
    "palikahostel",
    "Palika Hostel",
    "hostel",
    "hostels in Nepal",
    "Nepal hostel",
    "hostel Nepal",
    "hostels in Kathmandu",
    "boys hostel in Kathmandu",
    "girls hostel in Kathmandu",
    "hostel near me",
    "hostel system",
    "hostel management system",
    "hostel management software",
    "hostel management app",
    "hostel app Nepal",
    "hostel management system Nepal",
    "hostel software Nepal",
    "resident management system",
    "hostel fee management",
    "hostel billing software",
    "hostel mess management",
    "hostel attendance system",
    "PG management software",
    "Softmato",
    "HostelPalika by Softmato",
  ],
  modulePages: [
    {
      description:
        "A resident management system for hostels: every resident, room and bed in one list, a live bed map, one joining bill, QR resident cards and move-in checks.",
      headline: "Resident Management System for Hostels",
      intro: [
        "Every resident, the bed they hold, their guardian and their history sit in one list your wardens work from — no register book to reconcile at the end of the month.",
        "Rooms and vacancies show as a map you allocate from, a new resident's admission fee and deposit go out as a single bill, and every move-in and move-out is ticked against the same checklist.",
      ],
      moduleId: "residents-rooms",
      slug: "resident-room-management",
    },
    {
      description:
        "Hostel fee collection and billing software: monthly rent invoices raised on their own, eSewa and Khalti payment proof checked against the bill, and dues followed up.",
      headline: "Hostel Fee Collection & Billing Software",
      intro: [
        "Set one rent for each room type and invoices are raised every Bikram Sambat month, each with a receipt and a running balance on the resident's phone.",
        "When a resident sends an eSewa or Khalti screenshot, it is read and checked against the invoice before anyone marks it paid, and the wallet statement is matched against what the portal recorded.",
      ],
      moduleId: "fees-payments",
      slug: "fee-collection-billing",
    },
    {
      description:
        "Hostel mess and food management: the week's menu on every resident's phone, a cook screen with a ready log and stock alerts, and a rating for every meal.",
      headline: "Hostel Mess & Food Management",
      intro: [
        "The week's menu is published once and residents read it in the {siteName} app, so the board in the dining hall is no longer the only place it lives.",
        "Cooks get their own screen for today's menu, what is ready and what is running low, and residents rate each meal while they still remember it.",
      ],
      moduleId: "food-kitchen",
      slug: "mess-food-management",
    },
    {
      description:
        "A hostel attendance and safety system: daily attendance and night status that show who is in tonight, without storing locations, and an SOS that reaches staff and parents.",
      headline: "Hostel Attendance & Safety System",
      intro: [
        "Residents mark themselves inside or outside once a day, and wardens see who is in tonight at a glance. Location is used for the check and never stored.",
        "In an emergency, one press in the resident's app alerts the hostel staff and the resident's guardians together.",
      ],
      moduleId: "attendance-safety",
      slug: "attendance-safety",
    },
    {
      description:
        "Hostel notices and complaint management: notices residents actually read, complaints and enquiries with a status and an owner, and push updates to their phones.",
      headline: "Hostel Notices & Complaint Management",
      intro: [
        "Notices reach every resident at once, and complaints and enquiries come back with a status and a person responsible, so nothing is lost in a group chat.",
        "Staff screens update themselves while they are open, and a push notification reaches residents when the app is closed.",
      ],
      moduleId: "communication",
      slug: "notices-complaints",
    },
    {
      description:
        "Hostel maintenance management: faults reported with a photo or a voice note, assigned to staff or a verified repair worker, and closed when they are fixed.",
      headline: "Hostel Maintenance Management",
      intro: [
        "A resident reports what is broken with a photo, or simply says it in a voice note, and the request is assigned instead of being remembered.",
        "Verified plumbers, electricians and carpenters can be reached from the ticket, and the request stays open until the fault is fixed.",
      ],
      moduleId: "maintenance",
      slug: "maintenance-management",
    },
    {
      description:
        "A parent portal for hostels: each guardian gets a login linked only to their own child, with fees, notices, the menu and safety alerts.",
      headline: "Parent Portal for Hostels",
      intro: [
        "A guardian's login is linked to their own ward and nobody else's. They see what a parent needs — fees, notices, the menu and safety alerts — and nothing about other residents.",
        "Fewer calls to the owner, and a parent who can check for themselves instead of waiting to hear back.",
      ],
      moduleId: "guardian",
      slug: "parent-portal",
    },
    {
      description:
        "Get your hostel found in Nepal: a public page with photos, rooms, rent and real reviews, a pin on the hostel map, and a place where students compare hostels.",
      headline: "Hostel Listing & Marketing in Nepal",
      intro: [
        "Your hostel gets a public page with photos, rooms, rent and facilities, and reviews that only people who actually lived there can leave.",
        "It appears on the hostel map with directions that open on the visitor's phone, and in search and Compare, where students and parents choose between hostels.",
      ],
      moduleId: "listing-growth",
      slug: "listing-marketing",
    },
    {
      description:
        "Hostel reports and analytics: a daily dashboard of occupancy, dues and complaints, monthly trends, an audit trail, and control over more than one property.",
      headline: "Hostel Reports & Analytics",
      intro: [
        "One screen shows occupancy, dues, open complaints and tonight's night status, and monthly trends show whether collection and complaints are getting better or worse.",
        "Operators with more than one building see every property side by side, with staff and rooms scoped to their own building and a record of who changed what.",
      ],
      moduleId: "reporting",
      slug: "reports-analytics",
    },
  ],
  pages: {
    about: {
      description:
        "{siteName} is a hostel platform for Nepal — find verified hostels, and run a hostel's residents, rent, food and safety. A product of Softmato, Kathmandu.",
      title: "About {siteName}",
    },
    community: {
      description:
        "Ask about hostels in Nepal, share photos and read what people living in hostels say about rent, food, rooms and daily life.",
      title: "Hostel Community — Questions & Answers From Residents in Nepal",
    },
    compare: {
      description:
        "Compare up to three hostels in Nepal side by side — rent, room types, facilities, food, ratings and location — and choose the right one.",
      title: "Compare Hostels in Nepal Side by Side",
    },
    contact: {
      description:
        "Questions about finding a hostel, listing yours, plans or your account? Contact the {siteName} team by email or phone.",
      title: "Contact {siteName}",
    },
    features: {
      description:
        "Everything the {siteName} hostel management system does — residents and rooms, fee collection, food, attendance and safety, notices, maintenance, parents and reports.",
      title: "Hostel Management System Features",
    },
    home: {
      description:
        "Find verified boys, girls and co-living hostels across Nepal with real photos, rent and reviews. Hostel owners run residents, fees, food and safety on {siteName}.",
      title: "{siteName} — Hostels in Nepal & Hostel Management System",
    },
    hostels: {
      description:
        "Search verified hostels in Nepal — Kathmandu, Lalitpur, Bhaktapur, Pokhara and more. Filter by area, rent, room type, food and facilities, then compare and enquire.",
      title: "Hostels in Nepal — Boys, Girls & Co-living Hostels",
    },
    login: {
      description:
        "Log in to {siteName}. Residents, parents, hostel owners, wardens and cooks all sign in here.",
      title: "Log in",
    },
    map: {
      description:
        "Every verified hostel on {siteName} on one map of Nepal. Search by area, see what is nearby and get directions to the door.",
      title: "Hostel Map of Nepal — Find a Hostel Near You",
    },
    offerProgram: {
      description:
        "How rent payments are matched to the right month, verified by your hostel, and receipted under the {siteName} Resident Offer Program.",
      title: "Resident Offer Program",
    },
    plansPricing: {
      description:
        "Hostel management system pricing in Nepal. Plans from {fromPrice} a month — see what each plan includes for residents, fees, food, safety and reports.",
      title: "Hostel Management Software Pricing — Plans & Features",
    },
    privacy: {
      description:
        "How {siteName} collects, uses and protects the personal data of residents, guardians, hostel staff and visitors.",
      title: "Privacy Policy",
    },
    registerHostel: {
      description:
        "List your hostel on {siteName} to reach students and parents searching for hostels in Nepal, and manage residents, rent and daily work from the same account.",
      title: "List Your Hostel in Nepal",
    },
    serviceProviders: {
      description:
        "Plumbers, electricians, cleaners and other tradespeople: register with {siteName} and get matched with maintenance jobs from hostels across Nepal.",
      title: "Hostel Maintenance Jobs for Tradespeople in Nepal",
    },
    signup: {
      description:
        "Create your {siteName} account to contact hostels in Nepal, join the hostel community and follow your hostel once you move in.",
      title: "Create an Account",
    },
    software: {
      description:
        "Hostel management system and app for Nepal: residents and beds, rent in Bikram Sambat months, eSewa and Khalti payment checks, food menus, night attendance and parents.",
      title: "Hostel Management System & Software in Nepal",
    },
    terms: {
      description:
        "The terms for using {siteName} — for people looking for hostels, residents, guardians, hostel owners and their staff.",
      title: "Terms of Service",
    },
    refundPolicy: {
      description:
        "What a room booking on {siteName} costs, when the booking fee is refunded in full, and how much comes back after the hostel confirms.",
      title: "Refund Policy",
    },
    howBookingWorks: {
      description:
        "How booking a hostel bed on {siteName} works: the booking fee, the payment check, how long the hostel has to answer, how long your bed is held and how you move in.",
      title: "How Booking Works",
    },
  },
  software: {
    faq: [
      {
        answer:
          "It is the system that replaces the register book, the rent notebook and the notice board. {siteName} keeps residents, rooms, monthly rent, payments, food menus, attendance and complaints in one account that staff, residents and parents use in the {siteName} app or a web browser.",
        question: "What is a hostel management system?",
      },
      {
        answer:
          "Yes. The {siteName} app is on Google Play for Android phones, with separate home screens for hostel owners, wardens, cooks, residents and parents, so each person sees only their own work. On an iPhone, open the website and add the app to your home screen. The same account also works on the web.",
        question: "Is there a {siteName} app?",
      },
      {
        answer:
          "Register your hostel online and upload its documents, or have a {siteName} team member register it with you. Once the documents are verified and your plan is active, the hostel goes live and your team can start adding rooms and residents.",
        question: "How do I start using {siteName}?",
      },
      {
        answer:
          "Plans start from {fromPrice} a month, and paying for six months or a year costs less per month. Everything each plan includes is listed on the Plans & Pricing page, so you know exactly what you are paying for.",
        question: "How much does {siteName} cost?",
      },
      {
        answer:
          "Plans are paid on the {siteName} website: scan the {siteName} QR code with your bank or wallet app and upload the payment proof. The {siteName} team confirms it and your plan shows as paid. Real-time online payment is being added.",
        question: "How do I pay for my plan?",
      },
      {
        answer:
          "No. Residents and parents do not buy a plan — their accounts come with the hostel's plan.",
        question: "Do residents or parents have to pay for {siteName}?",
      },
      {
        answer:
          "They are added through the existing-residents list, with the month each of them has already paid up to, so nobody is billed for a month they have paid.",
        question: "What about the residents already living in my hostel?",
      },
      {
        answer:
          "Yes. Residents pay the way they already do and upload the payment screenshot, which is checked against their invoice before the payment is recorded.",
        question: "Can residents pay hostel fees with eSewa or Khalti?",
      },
      {
        answer:
          "Yes. Rent periods are Bikram Sambat months, so invoices, receipts and dues show the months residents and parents already use.",
        question: "Does billing follow the Nepali calendar?",
      },
      {
        answer:
          "Yes. Wardens and cooks get their own logins that open only the part of the work they do. How many staff accounts you can add depends on your plan.",
        question: "Can my wardens and cooks have their own accounts?",
      },
      {
        answer:
          "Each guardian gets their own login linked only to their ward. They see fees, notices and safety alerts for their child and nothing about other residents.",
        question: "Can parents see their child's hostel details?",
      },
      {
        answer:
          "Residents' personal profiles are encrypted before they are stored, registration documents are kept in private storage that only reviewers can open, attendance checks never store a location, and every staff member, resident and parent sees only what their role allows.",
        question: "Is our data safe and private?",
      },
      {
        answer:
          "Yes. Resident, collection, complaint and occupancy reports download as CSV files that open in Excel or Google Sheets, so your records are never locked in.",
        question: "Can I take my data out of {siteName}?",
      },
      {
        answer:
          "Yes. Each hostel is listed as a boys, girls or co-living hostel, and the same tools run all three.",
        question: "Does it work for boys hostels, girls hostels and co-living?",
      },
      {
        answer:
          "Yes, on the Max plan. Add branches of your hostel from Branches in the portal or the app. Each branch has its own rooms, rent, staff, KYC and payment details and its own public page, and Overall shows every branch side by side with one bill for all of them.",
        question: "Can I manage more than one hostel?",
      },
      {
        answer:
          "Open Branches in your hostel portal or the app and tap Add branch. You fill in the branch's name, address, rooms and rent; it can use a different PAN and payout account from the main hostel. We review it before it goes live.",
        question: "How do I add a branch?",
      },
      {
        answer:
          "Yes. Every live hostel gets a public page with photos, rooms, rent and reviews, a pin on the hostel map, and a place in search and Compare, where students and parents choose where to stay.",
        question: "Will students and parents be able to find my hostel?",
      },
      {
        answer:
          "Write to or call the {siteName} team from the Contact page. Larger operators on the top plan also get their data migrated for them and a named account manager.",
        question: "Where do I get help?",
      },
      {
        answer:
          "{siteName} is a product of Softmato Technology Private Limited, a software company in Kathmandu, Nepal. More about Softmato is at softmato.com.",
        question: "Who makes {siteName}?",
      },
    ],
    headline: "Hostel management system built for Nepal",
    intro: [
      "{siteName} is hostel management software for boys hostels, girls hostels and co-living houses in Nepal. The rooms you rent, the people who live in them, what they owe and what they eat are kept in one place your whole team works from.",
      "It is also where students and parents look for hostels, so the hostel you run on {siteName} is a hostel they can find, compare and contact.",
      "{siteName} is a product of Softmato, a software company in Kathmandu, Nepal.",
    ],
    sections: [
      {
        body: [
          "Hostel owners, wardens, cooks, residents, parents and verified repair workers all work on the same {siteName} platform, and it is where students and parents look for hostels too. A new resident can go from finding your hostel to paying their first rent without leaving it, and the hostel can order its supplies here as well, paid on delivery.",
        ],
        icon: "globe",
        title: "One connected platform, not five separate tools",
      },
      {
        body: [
          "Rent periods follow the Bikram Sambat calendar, so invoices, receipts and dues read the way residents and parents already count months.",
        ],
        icon: "receipt",
        title: "Rent billed in Bikram Sambat months",
      },
      {
        body: [
          "Residents pay the way they already do and send the proof. The screenshot is read and checked against the invoice, wallet statements are matched line by line, and anything that does not add up is flagged before it is marked paid.",
        ],
        icon: "wallet",
        title: "eSewa and Khalti payments, checked",
      },
      {
        body: [
          "Residents mark whether they are in each night and wardens see who is out. Location is used for the check and never stored, and an SOS reaches staff and guardians at the same moment.",
        ],
        icon: "shield-check",
        title: "Night status parents can rely on",
      },
      {
        body: [
          "The {siteName} app is designed for phones first. Owners, wardens, cooks, residents and parents each get their own screens: a cook sees the kitchen, a parent sees their own child, and nobody sees more than their job needs. The same account works on the web.",
        ],
        icon: "users",
        title: "A dedicated app for every role in the hostel",
      },
      {
        body: [
          "Your hostel gets a public page with photos, room rent and reviews from real residents, a pin on the hostel map, and a place in search and Compare.",
        ],
        icon: "building",
        title: "Found by the people looking for a room",
      },
    ],
    steps: [
      {
        body: "Fill in your hostel's details and upload its documents online, or have a {siteName} team member register it with you.",
        title: "Register your hostel",
      },
      {
        body: "The {siteName} team checks the documents, so every hostel on the platform is a real, verified hostel.",
        title: "Get verified",
      },
      {
        body: "Pick the plan that fits your hostel — monthly, six-monthly or yearly — then pay for it on the website by QR and upload the proof.",
        title: "Choose your plan",
      },
      {
        body: "Add rooms, beds and the rent for each room type, bring in the residents already living with you, and invite wardens, cooks and parents to the app.",
        title: "Set up rooms and people",
      },
      {
        body: "Invoices go out, payments are checked, the menu is published and night status comes in — the whole month's work in one place.",
        title: "Run the month from the app",
      },
    ],
    subtitle:
      "Residents, rooms, rent, food, attendance and parents — one system and one dedicated app instead of a register book, a spreadsheet and three WhatsApp groups.",
  },
  verification: { bing: "", google: "" },
};
