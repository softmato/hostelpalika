/**
 * The user guide — one text for the website's `/guide` page, the app's Guide screen
 * and `/llms.txt`, so a person, the app and an AI assistant all read the same thing.
 *
 * Organised by who is reading: one section per role (owner, warden, resident,
 * guardian, cook, visitor). Inside a section the chapters follow the order things
 * happen in real life — a resident joins, gets a bill, pays, and one day leaves.
 *
 * Written for people, not developers: short sentences, the screen's own names, what
 * to tap and what happens next. When a flow changes in code, change the chapter here
 * and bump the version in Platform → Website Config → Legal Pages.
 *
 * Pictures live in the website's `/guide/` folder (the app loads them from the site).
 * They are taken from the live portal and app; residents' faces and phone numbers
 * are blurred. `shot` is one screen on a laptop and a phone; `flow` is a row of
 * phones, numbered, one per step.
 *
 * Import-free apart from the brand name: the app pulls this file in through a metro
 * alias (`@hostel/guide/*`), like the calendar and plans files.
 */
import { PLATFORM_NAME } from "../brand/brand";

export type GuideRole =
  "owner" | "warden" | "resident" | "guardian" | "cook" | "visitor";

export interface GuidePicture {
  /** `/guide/<name>.webp`, 1536x1024, transparent. */
  src: string;
  caption: string;
}

export interface GuideChapter {
  id: string;
  title: string;
  /** One line under the title: what this chapter answers. */
  summary: string;
  body?: string[];
  steps?: string[];
  note?: { title: string; body: string };
  /** The same screen on a laptop and a phone. */
  shot?: GuidePicture;
  /** A numbered row of phone screens, one per step. */
  flow?: GuidePicture;
  widget?: GuideWidget;
}

/** A part of the page rendered from code rather than prose (web and app map the slug). */
export type GuideWidget = "share-receipt" | "access-table" | "troubleshooting";

export interface GuideGroup {
  /** URL segment: `/guide/<slug>/<chapter id>`. */
  slug: string;
  /** Sidebar heading. */
  label: string;
  /** Who reads this group. */
  audience: GuideRole[];
  /** One line under the group heading. */
  intro: string;
  chapters: GuideChapter[];
}

const pic = (name: string, caption: string): GuidePicture => ({
  caption,
  src: `/guide/${name}.webp`,
});

export const GUIDE_GROUPS: GuideGroup[] = [
  {
    audience: ["owner", "warden", "resident", "guardian", "cook", "visitor"],
    chapters: [
      {
        body: [
          `${PLATFORM_NAME} keeps one record of your hostel: rooms, the people living in them, what they owe and what happens every day. You, your wardens, your cook, your residents and their guardians all use the same app — each sees only their part.`,
          "Every date is in Bikram Sambat. A bill's month is a BS month, for example Kartik 2083.",
        ],
        id: "what-it-is",
        shot: pic(
          "admin-vs-warden",
          "Same hostel, two people: the owner’s phone on the left, the warden’s on the right.",
        ),
        summary: "One record of your hostel, shared by everyone in it.",
        title: `What ${PLATFORM_NAME} does`,
      },
      {
        id: "sign-up",
        note: {
          body: "Your hostel shows on the public site only after KYC is approved. Until then you can set everything up in private.",
          title: "Nothing is public yet",
        },
        steps: [
          "Open Register your hostel and enter your hostel name, your name and your phone or email.",
          "You land in your portal straight away, on a free trial.",
          "Finish Hostel KYC: owner, hostel, documents, photos, rooms, money, and a signed agreement.",
          "We check it and approve it. You get an email when it is done.",
        ],
        summary: "Three fields to start, KYC to go live.",
        title: "Signing up your hostel",
        shot: pic(
          "sign-up",
          "Register your hostel on the web, or from the app’s Home.",
        ),
      },
      {
        body: [
          "There is one sign-in for everyone. After you sign in you land in the right place on your own: owner, warden, resident, guardian or cook.",
          "Sign in with Google, or with your email and password. Forgot it? Tap Forgot password.",
        ],
        id: "sign-in",
        shot: pic(
          "sign-in",
          "The sign-in page on the web, and the PIN in the app.",
        ),
        summary: "One sign-in; the app knows where to send you.",
        title: "Signing in",
      },
      {
        body: [
          "Set a 4-digit PIN in Settings → App lock. After that the app asks for the PIN or your fingerprint every time it opens — and the website portal asks for the same PIN.",
          "Forgot it? Tap Forgot PIN? and a code goes to your email.",
        ],
        id: "app-lock",
        shot: pic(
          "security",
          "The PIN on the website, the PIN in the app, and the fingerprint prompt.",
        ),
        summary: "PIN and fingerprint, on the phone and the web.",
        title: "Locking the app",
      },
    ],
    intro:
      "What the platform is, how a hostel joins, and how everyone signs in.",
    label: "Getting started",
    slug: "start",
  },
  {
    audience: ["owner"],
    chapters: [
      {
        body: [
          "Home is the hostel at a glance: money collected this month, what is still due, how many residents, how many beds are free.",
          "Tap the eye to hide the amounts when someone is looking over your shoulder.",
          "The tiles under it are the jobs you do most: Add resident, Scan resident, Add expense, Night status, Statement, Stock.",
        ],
        id: "home",
        shot: pic(
          "finding-your-way",
          "Home on the web and in the app — the same numbers, laid out for each screen.",
        ),
        summary: "The whole hostel on one screen.",
        title: "Home",
      },
      {
        body: [
          "There are three ways to bring a new resident in. Pick whichever suits the moment.",
        ],
        flow: pic(
          "flow-join-ways",
          "1 Scan their HostelPalika ID card · 2 Show your hostel's Form QR · 3 Fill the form by hand.",
        ),
        id: "add-resident",
        note: {
          body: "Filling the form yourself is the most common way: it is quick, and you check every detail as you type.",
          title: "Not sure? Fill the form",
        },
        steps: [
          "Scan ID — if they already have a HostelPalika card, scan its QR. Their details fill themselves in. No camera? Tap Type the ID instead and enter the code under the QR (it looks like HH-4K7M-9XQ2).",
          "Form QR — show your hostel's own QR (or share the link). They scan it with their phone and fill the admission form themselves. It lands in your Residents tab and you get a notification.",
          "Fill it in by hand — tap They have no card — fill it in by hand, and type the form for them.",
        ],
        summary: "Scan their card, let them scan your QR, or fill the form.",
        title: "Adding a resident — three ways in",
      },
      {
        body: [
          "Step 2 of 3 is the admission form — the same as your paper form, on the phone.",
        ],
        flow: pic(
          "flow-join-form",
          "1 Photo and ID document · 2 Health and signature · 3 Name, phone and the email that becomes their login.",
        ),
        id: "admission-form",
        note: {
          body: "The email you type becomes their login. They sign in with Google, or tap Forgot password to set one. No email? They can still live here; they just will not have the app.",
          title: "The email is their login",
        },
        steps: [
          "Photo — take one now or upload one.",
          "Documents — a clear photo of their citizenship or ID (required) and their guardian's (optional).",
          "Personal — first and last name, contact number, email, date of birth, gender, blood group, food (veg, egg, non-veg), and whether they are a student or working.",
          "Address, citizenship, study, family, health — fill what you have.",
          "Signature — they sign on the screen. It goes on the back of their ID card.",
          "Tap Next — bed and money. If something required is missing, the form tells you which field.",
        ],
        summary: "Step 2: who they are.",
        title: "The admission form",
      },
      {
        body: [
          "Step 3 of 3 puts them in a bed and works out what they pay. Nothing here needs a calculator.",
        ],
        flow: pic(
          "flow-join-bed",
          "1 Pick the room · 2 See exactly what they pay · 3 Registered — the joining bill and its QR.",
        ),
        id: "bed-and-money",
        note: {
          body: "Rent 16,000 a month, moving in on the 24th: this month is cut to the days left (2,800), plus the admission fee (2,000). The screen shows Due at move-in before you save.",
          title: "What it costs is worked out for you",
        },
        steps: [
          "Where they sleep — pick the room type. Each shows how many beds are free.",
          "Which room — pick the floor, then the room. Full rooms are not offered.",
          "Moving in on — today, or the day they arrive.",
          "Billing — Calendar month (a bill on the 1st of every month) or Same day each month (a bill on the day they joined).",
          "What it costs — monthly rent, this month's part, admission fee and what is due at move-in. Tap Edit to change a fee for this one resident, with a reason.",
          "Referral code — if someone sent them, type the code.",
          "Tap Register them. The Registered screen shows their monthly rent, the joining bill's reference code, and a QR they can pay right there.",
        ],
        summary: "Step 3: room, move-in day, billing and the first bill.",
        title: "Bed, date and money",
      },
      {
        body: [
          "The moment you tap Register them, three things happen on their own:",
        ],
        flow: pic(
          "flow-notify",
          "1 The phone notification · 2 The same news in Notifications.",
        ),
        id: "after-registering",
        shot: pic(
          "resident-registered",
          "The new resident on the web list, and the Registered screen with the joining bill's QR.",
        ),
        steps: [
          "The resident's app turns into their hostel home: their room, what they owe, and a Pay now button.",
          "Their first bills are made — the joining bill (admission fee and deposit) and this month's rent.",
          "You, the owner and the other wardens get a notification: New resident registered, with their room and moving-in day.",
        ],
        summary:
          "Bills, the resident's app and everyone's notification — automatic.",
        title: "What happens next",
      },
      {
        body: [
          "Residents already living in a hostel that joins HostelPalika go in from Residents → Add as existing resident, with the month they have paid till. Billing starts from the next month.",
        ],
        id: "existing-residents",
        shot: pic(
          "join-link",
          "The resident list on the web, and a resident's profile in the app.",
        ),
        summary: "Bring in people who already live here.",
        title: "Residents already living here",
      },
      {
        body: [
          "Rooms & Beds shows every floor, how many rooms, and which beds are free. A room can be numbered (Room 304) or just a type (Two sharing).",
        ],
        id: "rooms",
        steps: [
          "Add a floor: tap Add floor. It copies the floor below.",
          "Change a room: tap it. Fix the number or the type.",
          "Swap numbers: hold two rooms, tap Renumber. 101 and 102 trade places.",
          "Move a resident: open Rooms & Beds, pick the person, pick a free bed.",
          "Remove a floor: tap the bin next to the floor name. If people live there, the app asks where each one goes first. Then the floor goes.",
        ],
        note: {
          body: "A room with people in it cannot be deleted. Move them first.",
          title: "Lived-in rooms stay",
        },
        shot: pic(
          "rooms-and-beds",
          "Rooms & Beds: every floor, how many rooms, how many beds are free.",
        ),
        summary: "Floors, rooms and which beds are free.",
        title: "Rooms and beds",
      },
      {
        body: [
          "Room rates sets one monthly rent per room type. That rent is the only price — the public listing and every new bill read it from here.",
          "Need a different rent for one resident? Edit What it costs when you add them, with a reason.",
        ],
        id: "room-rates",
        shot: pic("room-rates", "Room rates on the web and in the app."),
        summary: "One monthly rent per room type.",
        title: "Room rates",
      },
      {
        body: [
          "Settings → The hostel is what the public listing shows: about, contact, map pin, facilities, house rules, how to find the gate, and photos.",
          "Change it here and the listing changes too.",
          "Hostel KYC asks for the same things the first time, one step at a time. Your work saves when you tap Save & next or go back.",
        ],
        id: "hostel-page",
        summary: "Your listing, house rules and map pin.",
        title: "Your hostel page",
      },
      {
        body: [
          "Payments shows every resident for a month: who has paid, who still owes, and who is overdue, with any late fine added.",
          "Cash at the desk? Open the resident and record it. eSewa and Khalti payments made in the app clear on their own.",
        ],
        id: "payments",
        shot: pic(
          "payments",
          "Payments on the web, and a claim waiting to be verified in the app.",
        ),
        summary: "Who has paid, who still owes.",
        title: "Payments",
      },
      {
        body: [
          "A resident pays at the desk? Tap Collect, then tap their name.",
        ],
        id: "collect-payment",
        steps: [
          "You see every month they still owe. The oldest is ticked.",
          "Tick more months if they pay more. The total changes.",
          "Pick Cash, or the eSewa, Khalti or bank you set up.",
          "Online? The QR or number shows in the sheet. Let them scan it.",
          "Tap Collect. The months are paid.",
          "The resident gets a receipt in the app and their points.",
        ],
        summary: "Cash or QR at the desk, month by month.",
        title: "Collecting a payment",
      },
      {
        body: [
          "When a resident pays to your QR, eSewa, Khalti or bank, they send you the screenshot from their app. It waits for you under Payments → Claims to verify.",
        ],
        flow: pic(
          "flow-verify",
          "1 A claim to verify, with the receipt and the checks · 2 Approved · 3 The resident's bill goes down.",
        ),
        id: "verify-payments",
        note: {
          body: "Every claim shows the checks the app already did: is it a payment screenshot, was it paid to you, does the amount and reference match. Approve only what you can see in your own account.",
          title: "Check it, then approve",
        },
        steps: [
          "Open Payments. A card shows 1 claim to verify.",
          "Tap the receipt to see it full size.",
          "Tap Approve (or Reject with a reason).",
          "The payment is recorded, a receipt is issued, and the resident's balance updates straight away.",
          "The resident gets points for the day they sent the receipt, not the day you approve. So approving late never costs them.",
        ],
        summary: "Approve the screenshots residents send.",
        title: "Confirming a payment",
      },
      {
        body: ["Bills make themselves. Nobody has to press anything."],
        id: "how-bills-work",
        note: {
          body: "Rent 6,200. Joins Bhadra 20 (Bhadra has 31 days). Calendar month: first bill is 12 of 31 days = 2,400, then 6,200 every 1st. Same day: 6,200 now, then 6,200 every 20th.",
          title: "Example",
        },
        steps: [
          "Calendar month — the first bill covers the days left this month. Then one bill on the 1st of every month.",
          "Same day each month — a full month from the day they joined, then a bill on that same day every month.",
          "Reminders go out on their own: 7 and 5 days before the due date, then twice a day from 3 days before until it is paid.",
          "Late fine (if you turn it on) — a small amount every day a bill stays unpaid after the free days. You can waive it.",
          "Khata — extras like eggs or laundry. They land on the next bill.",
        ],
        shot: pic(
          "reminders-fines-khata",
          "Late fine: how much a day, and after how many free days.",
        ),
        summary: "Monthly bills, reminders, late fine and khata.",
        title: "How bills work",
      },
      {
        body: [
          "Add expense records what the hostel spends, with a photo of the bill. It lands in the Statement straight away.",
        ],
        flow: pic(
          "flow-expense",
          "1 How much · 2 What it was for, who paid and the bill photo · 3 In the Statement.",
        ),
        id: "expenses",
        shot: pic(
          "expenses-reports",
          "Expenses on the web by category and staff cash, and Expense added in the app.",
        ),
        steps: [
          "Tap Add expense and type the amount.",
          "Spent on — groceries, vegetables & meat, gas, electricity, water, internet, salary, building rent, repair, cleaning or other.",
          "What was it — optional, e.g. Rice 25 kg.",
          "Date and Paid by — cash, eSewa, Khalti or bank.",
          "Photo of the bill — take one or pick from the gallery.",
          "Save. A warden's cash expenses come out of their cash box (My cash) on Home.",
        ],
        note: {
          body: "Paid in eSewa, Khalti or your bank app? Open the payment there, tap Share and pick HostelPalika. Add expense opens with the receipt attached and the amount already read. The receipt picture stays on the expense.",
          title: "Faster: share the receipt",
        },
        summary: "Spending, with the bill photo.",
        title: "Adding an expense",
      },
      {
        body: [
          "Statement is every rupee in and out, newest first, with the running balance. Rent, part payments, one-off charges and expenses all sit in one list.",
          "Reports turns it into collection, occupancy and expense charts, and exports a PDF for any date range.",
        ],
        id: "statement",
        shot: pic(
          "resident-balance",
          "Transactions: every bill, what came in against it and what is still owed.",
        ),
        summary: "Money in, money out, and the balance.",
        title: "Statement and reports",
      },
      {
        body: [
          "Reports turns the books into collection, occupancy and expense charts, and exports a PDF for any date range.",
        ],
        id: "reports",
        shot: pic("reports", "Reports: collection, occupancy and expenses."),
        summary: "Charts and PDF exports for any dates.",
        title: "Reports",
      },
      {
        body: [
          "Move in / out lists who arrived and who left, newest first.",
          "A resident gives notice in their app: the day they are leaving, at least your notice days ahead. Rent stops on that day.",
          "You and the resident get a reminder the day before and on the day. On the day, Home shows Leaving today — tap Move out to settle the last bill, the deposit and any dues. Their login goes back to a normal public account, and their history stays with you.",
        ],
        id: "move-out",
        shot: pic("move-in", "Move in / out: who arrived and who left."),
        summary: "Notice, the last day and the final bill.",
        title: "Moving in and out",
      },
      {
        body: [
          "Add wardens from Wardens and cooks from Cooks. For each warden, switch on only what they need — for example, seeing money or not. The list shows how many of the permissions each one has.",
          "Need someone for a day? Give them a temporary login that ends on its own. Audit log shows who changed what, and when.",
        ],
        id: "team",
        shot: pic(
          "staff",
          "Warden permissions on the web, and the cook roster in the app.",
        ),
        summary: "Wardens, cooks and what each can do.",
        title: "Your team",
      },
      {
        body: [
          "Plan billing shows your plan and what is due. Pay by QR and upload the proof.",
          "Leaving the platform? Settings → Leave lets you clear your bills and download all your data first.",
        ],
        id: "plan",
        shot: pic("plan", "Settings on the web, and App lock on the phone."),
        summary: "Your plan, and leaving if you need to.",
        title: "Plan and account",
      },
    ],
    intro: "Residents, money and the hostel, in the order it happens.",
    label: "Hostel owner / admin",
    slug: "owner",
  },
  {
    audience: ["warden"],
    chapters: [
      {
        body: [
          "A warden uses the same portal and app as the owner. The owner decides what you can do — for example, whether you see money. Anything switched off simply is not in your menu.",
          "Money you collect in cash goes into your cash box (My cash on Home). When you hand it over, the owner taps Got it.",
        ],
        id: "warden-what",
        summary: "The same screens as the owner, minus what is switched off.",
        title: "What a warden sees",
        shot: pic(
          "warden-permissions",
          "The owner switches each permission on or off (web); the warden’s Home (app).",
        ),
      },
      {
        body: [
          "Adding residents, confirming payments and adding expenses work exactly as they do for the owner — follow the chapters under Hostel owner / admin.",
        ],
        id: "warden-same",
        shot: pic(
          "admin-vs-warden",
          "Same hostel, two people: the owner’s phone on the left, the warden’s on the right.",
        ),
        summary: "The same steps as the owner.",
        title: "Residents, payments and expenses",
      },
      {
        body: [
          "Cash you collect or spend goes through your cash box — My cash on Home shows what you hold.",
          "When you hand cash to the owner, they tap Got it and it leaves your box.",
        ],
        id: "warden-cash",
        shot: pic(
          "expenses-reports",
          "Staff cash on the web, and the expense flow in the app.",
        ),
        summary: "Cash you collect, and handing it over.",
        title: "Your cash box",
      },
      {
        body: [
          "Set the weekly menu and meal times once. Residents see today's meals on their Home.",
          "The cook posts a photo of each meal and taps Food ready — every resident gets a push. Residents can rate the food.",
        ],
        id: "food",
        shot: pic("food", "The weekly menu and meal times."),
        summary: "The weekly menu, meal times and the meal call.",
        title: "Food",
      },
      {
        body: [
          "Every night residents answer In or Out — on Android right from the notification. Night Status shows who is inside, who is out and who has not answered.",
          "Location attendance only notes inside, nearby or away. Nobody's location is ever saved.",
        ],
        id: "night-status",
        shot: pic(
          "attendance",
          "Night status: who is in, who is out, who has not answered.",
        ),
        summary: "Who is in, who is out, who has not answered.",
        title: "Night status",
      },
      {
        body: [
          "Post a notice and everyone gets it in the app. Schedule it for later, or repeat it daily or weekly — like Clothes Washing every Saturday.",
        ],
        id: "notices",
        shot: pic("notices", "Push notices — running, scheduled and sent."),
        summary: "Post now, later, or every week.",
        title: "Notices",
      },
      {
        body: [
          "The bell at the top holds your alerts: new claims, complaints, join requests and SOS.",
          "Tap one to open it. The number on the bell goes away when you open them.",
          "Daily routines, like meal times or Clothes Washing, are repeating notices. Set them once under Push notices.",
        ],
        id: "alerts",
        summary: "The bell, and routines that repeat.",
        title: "Alerts and routines",
      },
      {
        body: [
          "Residents raise a complaint with a photo; you update it until it is fixed, and they see every update.",
          "Repairs can carry a voice note and go to a verified service provider.",
        ],
        id: "complaints",
        shot: pic("complaints", "Complaints on the web, repairs in the app."),
        summary: "From photo to fixed.",
        title: "Complaints and repairs",
      },
      {
        body: [
          "Stock tracks what you bought, what you used and what is left, across the main hostel and branches. Order supplies from the store and pay on delivery.",
        ],
        id: "stock",
        shot: pic("stock", "Stock: what you have, what is running low."),
        summary: "What you have and what is running low.",
        title: "Stock",
      },
    ],
    intro: "You run the day. The owner sets what you can see.",
    label: "Warden",
    slug: "warden",
  },
  {
    audience: ["resident"],
    chapters: [
      {
        body: [
          "Your hostel adds you — at the desk, by scanning your HostelPalika ID card, or you fill their form yourself by scanning the hostel's QR. The email on the form becomes your login.",
          "Sign in with Google, or tap Forgot password to set one. The app opens straight on your hostel.",
        ],
        id: "joining",
        summary: "Your hostel adds you; the app turns into your hostel.",
        title: "Joining your hostel",
        flow: pic(
          "joining",
          "1 Before: a public account · 2 After: your hostel’s home.",
        ),
      },
      {
        body: [
          "Home shows your room, what you still owe, the deposit the hostel holds, today's food and any urgent notice.",
          "The tiles take you to your digital ID card, a call to the hostel, notices, your profile, guardians, location and night history.",
        ],
        flow: pic(
          "resident-tour",
          "1 Home · 2 Payments · 3 Your digital ID card · 4 Night history.",
        ),
        id: "resident-home",
        summary: "Your room, your bills, your requests.",
        title: "Your Home",
      },
      {
        body: [
          "Right after you join, the app shows your first bills: the joining bill (admission fee and deposit) and this month's rent. Pay this next always shows the oldest one.",
        ],
        flow: pic(
          "flow-resident-first",
          "1 Your hostel home · 2 What you owe · 3 Pay now — the QR and the reference code.",
        ),
        id: "first-bill",
        steps: [
          "Tap Pay now. You see the amount, your month code and the hostel's QR.",
          "Tap Copy next to the month code.",
          "Pay in your bank or wallet app. Paste the code in the remarks.",
          "Share the receipt to HostelPalika, or upload a screenshot.",
          "Wait for the hostel to approve it. You get a notification.",
        ],
        summary: "Copy the code, pay, share the receipt.",
        title: "How to pay your fee",
      },
      {
        body: [
          "Paid to the QR or by bank? Send the screenshot so the hostel can confirm it.",
        ],
        flow: pic(
          "flow-pay-proof",
          "1 Upload the receipt · 2 The app reads it · 3 It stops a wrong amount · 4 Sent to your hostel.",
        ),
        id: "send-proof",
        widget: "share-receipt",
        note: {
          body: "The app reads the amount and transaction ID from your screenshot. If the amount is far more than you owe, it stops you and asks you to check — so a typo never becomes a wrong record.",
          title: "It checks for you",
        },
        steps: [
          "Tap I've paid and choose your receipt screenshot (or share it straight from your bank app to HostelPalika).",
          "Check the amount, method and transaction ID it filled in.",
          "Tap Submit claim. You see Sent to your hostel, and the bill shows Pending proof.",
          "When the hostel approves it, you get a notification and your balance goes down. The receipt has a QR anyone can check at /verify-receipt.",
        ],
        summary: "I've paid → upload the screenshot → the hostel confirms.",
        title: "Sending payment proof",
      },
      {
        body: [
          "Your month code is yours. It stays the same every month. Only the month part changes.",
          "The first part is you. The last part is the month and the year.",
          "Put it in the remarks when you pay. Then the hostel knows it is you, and which month you paid.",
        ],
        id: "month-code",
        note: {
          body: "Bhadra 2083: RUP-482K-BHA83. Next month, Ashwin 2083: RUP-482K-ASW83.",
          title: "Two examples",
        },
        summary: "Same code every month, new month part.",
        title: "Your month code",
      },
      {
        body: [
          "Pay early, get more points.",
          "Points count from the day you send the receipt. Not the day the hostel approves it.",
          "One bill gives points once. A rejected receipt gives none.",
          "More points put you first for gifts and fee-off in the Resident Offer Program.",
        ],
        id: "credit-score",
        note: {
          body: "Day 1 to 4 of the month: 10 points. Day 5 to 7: 8. Day 8 to 15: 5. After that: 2.",
          title: "Points",
        },
        summary: "Pay early, get more points.",
        title: "Credit score",
      },
      {
        body: [
          "You can pay at the office too.",
          "Pay cash to the warden. Or scan the warden's QR with eSewa, Khalti or your bank.",
          "The warden ticks the months you paid. You get a receipt in the app, and your points.",
          "The day the warden records it is your points day.",
        ],
        id: "pay-at-office",
        summary: "Cash or the warden's QR.",
        title: "Pay at the office",
      },
      {
        body: [
          "More holds everything else: Profile, My room, Moving out, Night status, Location & attendance, Night history, Guardians and Complaints.",
          "Guardians — invite a parent; they get their own login and see only what you share.",
          "Complaints — report a problem with a photo and follow every update.",
          "SOS — the red button in the header alerts your warden, the owner and your guardians at once. Use it only in an emergency.",
        ],
        flow: pic(
          "resident-more",
          "1 More · 2 Guardians · 3 Complaints · 4 Moving out.",
        ),
        id: "resident-more",
        summary: "Guardians, complaints, night status and SOS.",
        title: "Everything else",
      },
      {
        body: [
          "Night status — every night, answer In or Out. On Android you can answer right from the notification.",
          "Location — if you turn it on, the app only notes whether you are inside, nearby or away. Your location is never saved.",
        ],
        id: "resident-night",
        summary: "In or out tonight.",
        title: "Night status",
        flow: pic(
          "night",
          "1 Night history · 2 Location: inside, nearby or away — never where.",
        ),
      },
      {
        body: [
          "More → Moving out. Pick your leaving day (at least your hostel's notice days ahead) and an optional reason, then tap I'm leaving.",
          "Rent stops on that day. You can change or cancel it until then. On the day the warden settles your last bill and deposit, and your account goes back to a normal public account — your receipts stay with you.",
        ],
        id: "resident-leaving",
        summary: "Give notice; rent stops on the day.",
        title: "Moving out",
        flow: pic(
          "leaving",
          "1 More → Moving out · 2 Pick the day; rent stops then.",
        ),
      },
    ],
    intro: "Your room, your bills and your requests — nobody else's.",
    label: "Resident",
    slug: "resident",
  },
  {
    audience: ["cook"],
    chapters: [
      {
        body: [
          "Today shows the meals. Tap Food ready when a meal is served — every resident gets a push.",
          "Menu is the weekly plan. Photos is where meal pictures go. Khata is where you ask for or give items like eggs.",
          "If the owner allows it, you can enter stock used and add market expenses (your own entries only).",
        ],
        id: "cook-home",
        summary: "Today, menu, photos and khata.",
        title: "For cooks",
        flow: pic(
          "cook",
          "1 What the cook can do, set by the owner · 2 The weekly menu.",
        ),
      },
    ],
    intro: "You post the menu and tell everyone food is ready.",
    label: "Cook",
    slug: "cook",
  },
  {
    audience: ["guardian"],
    chapters: [
      {
        body: [
          "Your child invites you from their app. You get your own login.",
          "Fee Summary — what is due and what is paid. Safety Summary — night status and any SOS. You also see notices, the food menu and the hostel's emergency contact.",
        ],
        id: "guardian-home",
        summary: "Fees and safety, at a glance.",
        title: "For guardians",
      },
    ],
    intro: "You follow your child's fees and safety.",
    label: "Guardian",
    slug: "guardian",
  },
  {
    audience: ["visitor"],
    chapters: [
      {
        body: [
          "Anyone can use the app without joining a hostel: search hostels by city or near a college, see them on the map, compare, save, read reviews and send an inquiry or book a bed.",
          "Your HostelPalika ID card is in the header. Show it at any hostel and they can register you by scanning it.",
        ],
        id: "visitor",
        summary: "Find a hostel, and carry your ID card.",
        title: "Before you join a hostel",
        flow: pic("visitor", "1 Home · 2 Search · 3 Map · 4 A hostel’s page."),
      },
    ],
    intro: "Find a hostel, and carry your ID card.",
    label: "Visitor",
    slug: "visitor",
  },
  {
    audience: ["owner", "warden", "resident", "guardian", "cook", "visitor"],
    chapters: [
      {
        id: "who-can-do-what",
        summary: "Every role, every area, on one table.",
        title: "Who can do what",
        widget: "access-table",
      },
      {
        id: "troubleshooting",
        summary: "The usual reasons, and the fix.",
        title: "When something looks wrong",
        widget: "troubleshooting",
      },
    ],
    intro: "Quick answers.",
    label: "Reference",
    slug: "reference",
  },
];

/** Every chapter in reading order, with its group — for prev/next, search and the sitemap. */
export const GUIDE_PAGES = GUIDE_GROUPS.flatMap((group) =>
  group.chapters.map((chapter) => ({
    chapter,
    group,
    href: `/guide/${group.slug}/${chapter.id}`,
  })),
);

export function findGuidePage(groupSlug: string, chapterId: string) {
  const i = GUIDE_PAGES.findIndex(
    (p) => p.group.slug === groupSlug && p.chapter.id === chapterId,
  );
  if (i < 0) return null;
  return {
    ...GUIDE_PAGES[i],
    next: GUIDE_PAGES[i + 1] ?? null,
    prev: GUIDE_PAGES[i - 1] ?? null,
  };
}

/** "Who can do what" — one row per area, one cell per role. */
export const GUIDE_ACCESS: {
  area: string;
  cells: Record<Exclude<GuideRole, "visitor">, string>;
}[] = [
  {
    area: "Rooms & rates",
    cells: {
      cook: "—",
      guardian: "—",
      owner: "Edit",
      resident: "—",
      warden: "Edit",
    },
  },
  {
    area: "Residents",
    cells: {
      cook: "—",
      guardian: "—",
      owner: "Edit",
      resident: "Own",
      warden: "Edit",
    },
  },
  {
    area: "Bills & payments",
    cells: {
      cook: "—",
      guardian: "View",
      owner: "Edit",
      resident: "Pay",
      warden: "If allowed",
    },
  },
  {
    area: "Expenses & reports",
    cells: {
      cook: "Own",
      guardian: "—",
      owner: "Edit",
      resident: "—",
      warden: "If allowed",
    },
  },
  {
    area: "Food",
    cells: {
      cook: "Edit",
      guardian: "View",
      owner: "Edit",
      resident: "View",
      warden: "Edit",
    },
  },
  {
    area: "Night status & SOS",
    cells: {
      cook: "—",
      guardian: "View",
      owner: "View",
      resident: "Send",
      warden: "View",
    },
  },
  {
    area: "Complaints",
    cells: {
      cook: "—",
      guardian: "—",
      owner: "Edit",
      resident: "Raise",
      warden: "Edit",
    },
  },
  {
    area: "Notices",
    cells: {
      cook: "View",
      guardian: "View",
      owner: "Post",
      resident: "View",
      warden: "Post",
    },
  },
  {
    area: "Staff & plan",
    cells: {
      cook: "—",
      guardian: "—",
      owner: "Edit",
      resident: "—",
      warden: "—",
    },
  },
];

export const GUIDE_TROUBLE: { problem: string; fix: string }[] = [
  {
    fix: "Your role does not allow it. Ask the hostel owner to turn it on for you in Wardens.",
    problem: "A screen I was told about is missing",
  },
  {
    fix: "Bank and QR payments clear only after staff approve the screenshot. eSewa and Khalti in the app clear at once.",
    problem: "I paid but my bill still shows due",
  },
  {
    fix: "The amount on your screenshot is much more than you owe. Check the amount, or pay the bill it belongs to.",
    problem: "Couldn't submit my payment proof",
  },
  {
    fix: "Use Forgot password on the sign-in screen. Forgot your PIN? Tap Forgot PIN? and a code goes to your email.",
    problem: "I cannot sign in",
  },
  {
    fix: "Check Settings → Notifications in the app, and allow notifications for the app in your phone's settings.",
    problem: "I do not get notifications",
  },
  {
    fix: "Your hostel's KYC is not approved yet. Finish Hostel KYC and wait for the approval email.",
    problem: "My hostel does not show on the website",
  },
];

/** One chapter as Markdown — the page's "Copy as Markdown" button and the whole-guide file. */
export function chapterAsMarkdown(c: GuideChapter, heading = "#") {
  const out = [`${heading} ${c.title}`, "", `_${c.summary}_`, ""];
  c.body?.forEach((p) => out.push(p, ""));
  c.steps?.forEach((st, i) => out.push(`${i + 1}. ${st}`));
  if (c.steps) out.push("");
  if (c.note) out.push(`> **${c.note.title}.** ${c.note.body}`, "");
  return out.join("\n").trimEnd();
}

/**
 * The whole guide as Markdown — for `/llms.txt` readers and anyone who wants it as
 * plain text. Same words as the page, in the same order.
 */
export function guideAsMarkdown(
  meta: { version: string; updatedAt: string },
  siteUrl = "",
) {
  const out: string[] = [
    `# How to use ${PLATFORM_NAME}`,
    "",
    `Version ${meta.version} · Updated ${meta.updatedAt}. Pictures: ${siteUrl}/guide`,
    "",
  ];
  for (const s of GUIDE_GROUPS) {
    if (s.slug === "reference") continue;
    out.push(`## ${s.label}`, "", s.intro, "");
    for (const c of s.chapters) out.push(chapterAsMarkdown(c, "###"), "");
  }
  out.push(
    "## Who can do what",
    "",
    "| Area | Owner | Warden | Resident | Guardian | Cook |",
    "|---|---|---|---|---|---|",
  );
  for (const r of GUIDE_ACCESS) {
    out.push(
      `| ${r.area} | ${r.cells.owner} | ${r.cells.warden} | ${r.cells.resident} | ${r.cells.guardian} | ${r.cells.cook} |`,
    );
  }
  out.push("", "## When something looks wrong", "");
  for (const t of GUIDE_TROUBLE) out.push(`- **${t.problem}.** ${t.fix}`);
  return out.join("\n");
}
