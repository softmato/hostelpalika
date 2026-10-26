import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

/**
 * `/for/[role]` — one page for each person a hostel runs on, in the words that
 * person searches with: an owner looks for "hostel management software", a
 * warden for "hostel warden app", a resident for "pay hostel fee eSewa", a
 * parent for "hostel app for parents".
 *
 * Every line names a screen or a permission that exists today — the portal
 * routes under `app/(resident)`, `app/(guardian)`, `app/(cook)` and the warden
 * permission list in `modules/wardens/warden.validation.ts`. When a role gains
 * or loses a screen, this file changes with it. Nothing here is a plan.
 */

export type RolePage = {
  description: string;
  does: Array<{ body: string; title: string }>;
  faq: Array<{ answer: string; question: string }>;
  headline: string;
  intro: string;
  join: string;
  label: string;
  slug: string;
  title: string;
};

const LOCK = `The app opens with the account's own 4-digit PIN or a fingerprint, and the web portal asks for the same PIN. Ten wrong PINs in a row block it until it is reset with an email code.`;

export const ROLE_PAGES: RolePage[] = [
  {
    description: `Hostel management software for hostel owners in Nepal: rooms and beds, monthly rent in Bikram Sambat months, eSewa and Khalti checks, staff logins, parents and a public listing — in the ${PLATFORM_NAME} app.`,
    does: [
      {
        body: "Set rooms, beds and the rent for each room type; add residents or bring in the ones already living with you; see vacant beds at any time.",
        title: "Rooms, beds and residents",
      },
      {
        body: "Monthly bills are raised from the rent in Bikram Sambat months. Payment screenshots are read and checked against the invoice before they count, cash can be recorded, and every payment gets a receipt.",
        title: "Rent and payments",
      },
      {
        body: "Create wardens and cooks with their own logins and choose exactly what each warden may do — register residents, approve payments, record cash, run food, notices, complaints, night status, maintenance, expenses and stock.",
        title: "Your staff, on your terms",
      },
      {
        body: "Publish the weekly menu, send notices, follow complaints and maintenance, see who is in each night, and download reports as CSV.",
        title: "The day-to-day",
      },
      {
        body: "Every live hostel gets a public page, a pin on the hostel map, and a place in search and Compare. A paid plan adds a Gold or Platinum badge that lists the hostel first.",
        title: "Found by students and parents",
      },
    ],
    faq: [
      {
        answer: `Register your hostel on the website or in the app and upload its documents. Once the ${PLATFORM_NAME} team has verified them and your plan is paid, the hostel goes live and you can invite your team.`,
        question: `How does a hostel owner start on ${PLATFORM_NAME}?`,
      },
      {
        answer: "Yes — wardens and cooks get their own accounts, and you decide what each warden can do. Changing the rent schedule, reversing payments and the hostel's payout details stay with the owner.",
        question: "Can I give my warden access without giving away control?",
      },
      {
        answer: `Yes, on the Max plan: each branch has its own rooms, rent, staff and public page, and you see every branch side by side with one bill.`,
        question: "Can I run more than one hostel or branch?",
      },
    ],
    headline: "Run your hostel from one app",
    intro: `${PLATFORM_NAME} is hostel management software for owners of boys hostels, girls hostels and co-living houses in Nepal. Rooms, residents, rent, food, staff and parents live in one account, and the same account puts your hostel where students and parents search.`,
    join: "Register your hostel and upload its documents, or have a team member register it with you. Plans are chosen and paid on the website.",
    label: "Hostel owners",
    slug: "owners",
    title: "Hostel Management Software for Hostel Owners in Nepal",
  },
  {
    description: `The ${PLATFORM_NAME} warden app: register residents, check eSewa and Khalti payments, record cash, run food and notices, follow complaints and see who is in each night — with only the access your owner gives you.`,
    does: [
      {
        body: "Register new residents and allocate them to rooms and beds, where the owner has allowed it.",
        title: "Residents and rooms",
      },
      {
        body: "See payments, approve payment proof checked against the invoice, and record cash with a receipt for the resident.",
        title: "Payments",
      },
      {
        body: "See each resident's night status and update it, so the hostel knows who is in tonight. Location is used for the check and never stored.",
        title: "Night status and attendance",
      },
      {
        body: "Publish the food menu, send notices, follow and update complaints and maintenance jobs.",
        title: "Food, notices and complaints",
      },
      {
        body: "Add what you spent for the hostel with a photo of the bill, and keep the stock book — bought, used, wasted — for your building.",
        title: "Expenses and stock",
      },
    ],
    faq: [
      {
        answer: "The hostel owner creates your warden account from the portal or the app and chooses what you can do. You sign in with the details they give you and set your own PIN.",
        question: "How does a warden get a login?",
      },
      {
        answer: "Only what the owner has switched on for you. By default a new warden can register residents, approve payments, record cash and run food, notices, complaints, night status, maintenance and expenses; editing the hostel profile and rooms are off until the owner grants them.",
        question: "What can a warden see and change?",
      },
      {
        answer: "No. Changing the fee schedule, reversing a payment and the hostel's payout details belong to the owner and cannot be granted to a warden.",
        question: "Can a warden change rent or reverse payments?",
      },
    ],
    headline: "The hostel warden app",
    intro: `Wardens run the floor: who lives where, who has paid, what is for dinner and who is in tonight. On ${PLATFORM_NAME} a warden has their own login that opens exactly the work the owner has handed over — nothing more.`,
    join: "Your hostel owner creates your account. There is nothing to buy.",
    label: "Wardens",
    slug: "wardens",
    title: "Hostel Warden App — Residents, Payments, Food & Night Status",
  },
  {
    description: `The ${PLATFORM_NAME} cook app: the hostel's weekly menu and the residents' khata asks — extra meals, eggs, laundry — handed over and added to the month's bill.`,
    does: [
      {
        body: "See and keep the hostel's weekly menu, meal by meal.",
        title: "The menu",
      },
      {
        body: "Residents ask for items on their khata — an egg, an extra meal, laundry — and the cook hands them over in the app. What is handed over goes onto the resident's next rent bill as one line, so nobody keeps a notebook.",
        title: "Khata asks",
      },
      {
        body: "Post photos of the meals the kitchen serves.",
        title: "Meal photos",
      },
    ],
    faq: [
      {
        answer: "The hostel owner creates the cook's login. A cook without an email gets a login made for them and signs in with a password.",
        question: "How does a cook get a login?",
      },
      {
        answer: "No. A cook sees the kitchen — the menu and the khata asks — and nothing about rent or other residents' details.",
        question: "Can a cook see the hostel's money?",
      },
    ],
    headline: "The hostel kitchen, in one app",
    intro: `The cook's side of ${PLATFORM_NAME} is the kitchen and nothing else: the week's menu, the residents' khata asks to hand over, and photos of the food.`,
    join: "Your hostel owner creates your account. There is nothing to buy.",
    label: "Cooks",
    slug: "cooks",
    title: "Hostel Mess & Kitchen App for Cooks — Menu and Khata",
  },
  {
    description: `The ${PLATFORM_NAME} resident app: pay hostel rent with eSewa or Khalti and upload the proof, get receipts and a statement PDF, see the menu, mark night status, raise complaints and send SOS.`,
    does: [
      {
        body: "See each month's bill, pay the way you already do — eSewa, Khalti or bank — and upload the screenshot. It is checked against your bill, and you get a receipt once it is recorded.",
        title: "Pay rent and get receipts",
      },
      {
        body: "Download a statement PDF of every bill and payment with a running balance, and see your khata — the extras you took on account.",
        title: "Statement and khata",
      },
      {
        body: "Mark whether you are in tonight, see attendance, and send an SOS that reaches staff and your guardians at once.",
        title: "Night status and SOS",
      },
      {
        body: "See the week's menu, the hostel's notices, raise complaints and follow them, and review the hostel once you have lived there.",
        title: "Food, notices and complaints",
      },
      {
        body: "Invite your parent or guardian so they can see your fees, notices and safety alerts — and only yours.",
        title: "Your guardians",
      },
    ],
    faq: [
      {
        answer: "Pay with eSewa, Khalti or your bank the way you already do, then upload the payment screenshot in the app. It is checked against your bill before it is recorded, and a receipt follows.",
        question: "How do I pay my hostel fee with eSewa or Khalti?",
      },
      {
        answer: "Your hostel sends you an invite link or adds you, and you sign in with your own account. Residents never pay for the app.",
        question: "How do I get into my hostel's app?",
      },
      {
        answer: "Yes — open Statement in the app or portal to download a PDF of your bills and payments with a running balance.",
        question: "Can I get a statement of everything I have paid?",
      },
      {
        answer: "Only residents who have actually stayed at a hostel can review it, so the reviews on a hostel's page come from people who lived there.",
        question: "Who can review a hostel?",
      },
    ],
    headline: "Your hostel, on your phone",
    intro: `When your hostel runs on ${PLATFORM_NAME}, your bills, receipts, menu, notices and night status are in your own app — and finding your next hostel is on the same site.`,
    join: "Your hostel invites you. Looking for a hostel? Browse verified hostels — searching and contacting them is free.",
    label: "Residents",
    slug: "residents",
    title: "Hostel App for Residents — Pay Rent with eSewa & Khalti, Receipts, Menu",
  },
  {
    description: `The ${PLATFORM_NAME} parent app: see your child's hostel fees, notices, food and safety alerts, with a login linked only to your own child.`,
    does: [
      {
        body: "See what your child's hostel has billed and what has been paid.",
        title: "Fees",
      },
      {
        body: "Get your child's SOS alerts, see the safety status the hostel marks when your child has chosen to share it, and keep your emergency contact details up to date.",
        title: "Safety",
      },
      {
        body: "Read the hostel's notices and see the week's food menu.",
        title: "Notices and food",
      },
    ],
    faq: [
      {
        answer: "Your child invites you by email from their own app. Your login is linked only to your child, and your child decides what is shared.",
        question: "How does a parent get access?",
      },
      {
        answer: "No. A guardian sees their own child's fees, notices, food and safety alerts and nothing about any other resident.",
        question: "Can parents see other residents?",
      },
      {
        answer: `No. Parents and residents never pay for ${PLATFORM_NAME}; the hostel's plan covers their accounts.`,
        question: "Do parents pay for the app?",
      },
    ],
    headline: "Know your child's hostel, from home",
    intro: `Parents of hostel residents in Nepal get their own ${PLATFORM_NAME} login, linked only to their own child: fees, notices, the menu and safety alerts, without calling the hostel.`,
    join: "Your child invites you by email from their app. There is nothing to buy.",
    label: "Parents",
    slug: "parents",
    title: "Hostel App for Parents — Your Child's Fees, Notices & Safety",
  },
];

export function rolePage(slug: string) {
  return ROLE_PAGES.find((page) => page.slug === slug) ?? null;
}

export const ROLE_LOCK_NOTE = LOCK;
