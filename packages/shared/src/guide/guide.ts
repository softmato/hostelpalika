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
          `${PLATFORM_NAME} is an app for running a hostel. It keeps the rooms, the residents, the bills and the daily work in one place.`,
          "The owner, the wardens, the cook, the residents and their guardians all use the same app. Each person sees only their own part.",
          "All dates are in Bikram Sambat. A bill is for one BS month, for example Kartik 2083.",
        ],
        id: "what-it-is",
        shot: pic(
          "admin-vs-warden",
          "The same hostel on two phones. The owner is on the left, the warden is on the right.",
        ),
        summary: "One app for the whole hostel.",
        title: `What ${PLATFORM_NAME} is`,
      },
      {
        id: "sign-up",
        note: {
          body: "People can find your hostel on the website only after we approve your KYC. Until then, you can set up everything in private.",
          title: "Your hostel is private at first",
        },
        steps: [
          "Open Register your hostel. Type your hostel name, your name, and your phone or email.",
          "Your portal opens right away. You start on a free trial.",
          "Fill in Hostel KYC. This form shows us that your hostel is real. It asks about the owner, the hostel, documents, photos, rooms and money. At the end you sign the agreement.",
          "We check your details and approve them. You get an email when it is done.",
        ],
        summary: "Sign up in a minute. Fill in KYC to show your hostel to the public.",
        title: "Add your hostel",
        shot: pic(
          "sign-up",
          "Register your hostel on the website, or from Home in the app.",
        ),
      },
      {
        body: [
          "Everyone uses the same sign-in page. After you sign in, the app opens the right screens for you: owner, warden, resident, guardian or cook.",
          "Sign in with Google, or with your email and password. If you forget the password, tap Forgot password.",
        ],
        id: "sign-in",
        shot: pic(
          "sign-in",
          "The sign-in page on the website, and the PIN screen in the app.",
        ),
        summary: "Everyone signs in the same way. The app opens your own screens.",
        title: "Sign in",
      },
      {
        body: [
          "Go to Settings → App lock and set a 4-digit PIN. After that, the app asks for the PIN or your fingerprint each time you open it. The website portal asks for the same PIN.",
          "If you forget the PIN, tap Forgot PIN?. We send a code to your email.",
        ],
        id: "app-lock",
        shot: pic(
          "security",
          "The PIN on the website, the PIN in the app, and the fingerprint check.",
        ),
        summary: "Protect the app with a PIN or your fingerprint.",
        title: "Lock the app",
      },
    ],
    intro: "What the app is, how to add your hostel, and how to sign in.",
    label: "Start here",
    slug: "start",
  },
  {
    audience: ["owner"],
    chapters: [
      {
        body: [
          "Home shows the main numbers of your hostel: money collected this month, money still due, the number of residents, and the free beds.",
          "Tap the eye to hide the amounts when other people can see your screen.",
          "The tiles below are shortcuts to your daily work: Add resident, Scan resident, Add expense, Night status, Statement and Stock.",
        ],
        id: "home",
        shot: pic(
          "finding-your-way",
          "Home on the website and in the app. The numbers are the same.",
        ),
        summary: "See your whole hostel on one screen.",
        title: "Home",
      },
      {
        body: [
          "There are three ways to add a new resident. Use the one that fits the moment.",
        ],
        flow: pic(
          "flow-join-ways",
          "1 Scan their HostelPalika ID card · 2 Show your hostel's Form QR · 3 Fill in the form by hand.",
        ),
        id: "add-resident",
        note: {
          body: "Most hostels fill in the form themselves. It is quick, and you can check each detail as you type.",
          title: "Not sure which one? Fill in the form",
        },
        steps: [
          "Scan ID: use this if the person already has a HostelPalika ID card. Scan the QR on the card, and their details fill in on their own. No camera? Tap Type the ID and enter the code under the QR. It looks like HH-4K7M-9XQ2.",
          "Form QR: show your hostel's QR, or send the link. The person scans it and fills in the admission form on their own phone. The form comes to your Residents tab, and you get a notification.",
          "Fill in by hand: tap They have no card — fill it in by hand, then type the form for them.",
        ],
        summary: "Three ways to add someone. Pick the one that is easiest.",
        title: "Add a resident",
      },
      {
        body: [
          "This is step 2 of 3. The admission form is the same as your paper form, but on the phone.",
        ],
        flow: pic(
          "flow-join-form",
          "1 Photo and ID document · 2 Health and signature · 3 Name, phone and the login email.",
        ),
        id: "admission-form",
        note: {
          body: "The resident signs in with the email you type here. They can use Google, or tap Forgot password to set a password. A resident with no email can still live in the hostel, but cannot use the app.",
          title: "The email is their login",
        },
        steps: [
          "Photo: take a photo now, or upload one.",
          "Documents: add a clear photo of their citizenship or ID. This one is required. You can also add their guardian's ID.",
          "Personal: type their first and last name, contact number, email, date of birth, gender and blood group. Choose their food (veg, egg or non-veg). Choose student or working.",
          "Address, citizenship, study, family and health: fill in what you know.",
          "Signature: the resident signs on the screen. The signature is printed on the back of their ID card.",
          "Tap Next — bed and money. If a required field is empty, the form shows you which one.",
        ],
        summary: "Step 2 of 3: the resident's details.",
        title: "Fill in the admission form",
      },
      {
        body: [
          "This is step 3 of 3. You choose a bed, and the app works out how much the resident pays. You do not need a calculator.",
        ],
        flow: pic(
          "flow-join-bed",
          "1 Choose the room · 2 See what they pay · 3 Registered: the joining bill and its QR.",
        ),
        id: "bed-and-money",
        note: {
          body: "Example: the rent is 16,000 a month and the resident moves in on the 24th. They pay only for the days left this month (2,800), plus the admission fee (2,000). The screen shows Due at move-in before you save.",
          title: "The app does the maths",
        },
        steps: [
          "Where they sleep: choose the room type. Each type shows how many beds are free.",
          "Which room: choose the floor, then the room. Full rooms are not shown.",
          "Moving in on: choose today, or the day they will arrive.",
          "Billing: choose Calendar month for a bill on the 1st of every month. Choose Same day each month for a bill on the day they joined.",
          "What it costs: this shows the monthly rent, the rent for the rest of this month, the admission fee, and the amount due at move-in. To change a fee for this resident only, tap Edit and write a reason.",
          "Referral code: if someone sent this resident to you, type their code.",
          "Tap Register them. The Registered screen shows the monthly rent, the code of the joining bill, and a QR. The resident can pay right there.",
        ],
        summary: "Step 3 of 3: the room, the move-in day and the first bill.",
        title: "Choose the bed and see the bill",
      },
      {
        body: [
          "When you tap Register them, the app does three things on its own:",
        ],
        flow: pic(
          "flow-notify",
          "1 The notification on the phone · 2 The same message in Notifications.",
        ),
        id: "after-registering",
        shot: pic(
          "resident-registered",
          "The new resident in the list on the website, and the Registered screen with the QR of the joining bill.",
        ),
        steps: [
          "The resident's app changes to their hostel Home. It shows their room, what they owe, and a Pay now button.",
          "The app makes their first bills: the joining bill (admission fee and deposit) and this month's rent.",
          "You, the owner and the other wardens get a notification. It says New resident registered, with the room and the move-in day.",
        ],
        summary: "The app makes the bills and tells everyone.",
        title: "After you register a resident",
      },
      {
        body: [
          "Some residents lived in your hostel before you started using HostelPalika. Add them from Residents → Add as existing resident, and choose the last month they have paid for. Their bills start from the next month.",
        ],
        id: "existing-residents",
        shot: pic(
          "join-link",
          "The resident list on the website, and a resident's profile in the app.",
        ),
        summary: "For residents who lived in the hostel before you joined.",
        title: "Add people who already live here",
      },
      {
        body: [
          "Rooms & Beds shows each floor, its rooms, and which beds are free. A room can have a number (Room 304) or only a type (Two sharing).",
        ],
        id: "rooms",
        steps: [
          "Add a floor: tap Add floor. The new floor is a copy of the floor below it.",
          "Change a room: tap the room, then change its number or its type.",
          "Swap two room numbers: press and hold two rooms, then tap Renumber. Room 101 and Room 102 swap numbers.",
          "Move a resident: open Rooms & Beds, choose the person, then choose a free bed.",
          "Remove a floor: tap the bin next to the floor name. If people live on that floor, the app first asks where each person should go. Then it removes the floor.",
        ],
        note: {
          body: "Move the residents to another bed first. Then you can delete the room.",
          title: "You cannot delete a room with people in it",
        },
        shot: pic(
          "rooms-and-beds",
          "Rooms & Beds: each floor, its rooms, and the free beds.",
        ),
        summary: "See your floors, rooms and free beds. Change them here.",
        title: "Rooms and beds",
      },
      {
        body: [
          "In Room rates you set one monthly rent for each room type. The app uses this rent everywhere: on your public page and on every new bill.",
          "Does one resident pay a different rent? When you add them, tap Edit under What it costs and write a reason.",
        ],
        id: "room-rates",
        shot: pic("room-rates", "Room rates on the website and in the app."),
        summary: "Set one monthly rent for each room type.",
        title: "Room rates",
      },
      {
        body: [
          "Settings → The hostel holds what the public sees: about, contact, map pin, facilities, house rules, how to find the gate, and photos.",
          "When you change something here, your public page changes too.",
          "Hostel KYC asks for the same details the first time, one step at a time. Your work is saved when you tap Save & next or go back.",
        ],
        id: "hostel-page",
        summary: "What people see about your hostel on the website.",
        title: "Your hostel page",
      },
      {
        body: [
          "Payments lists every resident for the month. You see who has paid, who still owes, and who is late. If you use a late fine, it is added here.",
          "If a resident pays cash at the desk, open the resident and record it. Payments made with eSewa or Khalti inside the app are marked paid on their own.",
        ],
        id: "payments",
        shot: pic(
          "payments",
          "Payments on the website, and a payment waiting for your check in the app.",
        ),
        summary: "See who has paid and who still owes.",
        title: "Payments",
      },
      {
        body: [
          "Use this when a resident pays you in person. Tap Collect, then tap their name.",
        ],
        id: "collect-payment",
        steps: [
          "You see every month they still owe. The oldest month is already ticked.",
          "If they pay for more months, tick those too. The total changes.",
          "Choose how they pay: Cash, or the eSewa, Khalti or bank account you set up.",
          "For an online payment, the QR or the number shows on the screen. Let the resident scan it.",
          "Tap Collect. Those months are now paid.",
          "The resident gets a receipt in the app, and their points.",
        ],
        summary: "Take cash or a QR payment, and mark the months as paid.",
        title: "Take a payment at the desk",
      },
      {
        body: [
          "When a resident pays to your QR, eSewa, Khalti or bank, they send you a screenshot of the payment. The app calls this a claim. It waits for you under Payments → Claims to verify.",
        ],
        flow: pic(
          "flow-verify",
          "1 A claim to check, with the receipt and the checks · 2 Approved · 3 The resident's bill goes down.",
        ),
        id: "verify-payments",
        note: {
          body: "Each claim shows the checks the app has already done. Is it a payment screenshot? Was it paid to you? Do the amount and the reference match? Approve only when you can see the money in your own account.",
          title: "Check first, then approve",
        },
        steps: [
          "Open Payments. A card shows 1 claim to verify.",
          "Tap the receipt to see it in full size.",
          "Tap Approve. Or tap Reject and write a reason.",
          "The app records the payment, makes a receipt, and updates the resident's balance right away.",
          "The resident gets points for the day they sent the receipt, not the day you approve it. So a late approval does not hurt them.",
        ],
        summary: "Residents send a screenshot. You check it and approve it.",
        title: "Check a payment screenshot",
      },
      {
        body: ["The app makes every bill on its own. You do not have to press anything."],
        id: "how-bills-work",
        note: {
          body: "The rent is 6,200. The resident joins on Bhadra 20, and Bhadra has 31 days. With Calendar month, the first bill is for 12 of 31 days (2,400), then 6,200 on every 1st. With Same day, they pay 6,200 now, then 6,200 on every 20th.",
          title: "Example",
        },
        steps: [
          "Calendar month: the first bill is only for the days left in this month. After that, there is one bill on the 1st of every month.",
          "Same day each month: the first bill is for one full month from the day they joined. After that, there is a bill on that same day every month.",
          "Reminders: the app reminds the resident 7 days and 5 days before the due date. From 3 days before, it reminds them twice a day until they pay.",
          "Late fine: this is off until you turn it on. After the free days, the app adds a small amount for each day a bill stays unpaid. You can remove a fine.",
          "Khata: these are extras like eggs or laundry. They are added to the next bill.",
        ],
        shot: pic(
          "reminders-fines-khata",
          "Late fine: how much per day, and after how many free days.",
        ),
        summary: "The app makes bills, sends reminders and adds fines for you.",
        title: "How bills work",
      },
      {
        body: [
          "Use Add expense to record money the hostel spends. Add a photo of the bill. The expense shows in the Statement right away.",
        ],
        flow: pic(
          "flow-expense",
          "1 How much · 2 What it was for, who paid, and the bill photo · 3 In the Statement.",
        ),
        id: "expenses",
        shot: pic(
          "expenses-reports",
          "Expenses on the website, by category and staff cash. Expense added in the app.",
        ),
        steps: [
          "Tap Add expense and type the amount.",
          "Spent on: choose one. Groceries, vegetables & meat, gas, electricity, water, internet, salary, building rent, repair, cleaning or other.",
          "What was it: you can add a short note, for example Rice 25 kg.",
          "Date and Paid by: choose cash, eSewa, Khalti or bank.",
          "Photo of the bill: take a photo, or choose one from the gallery.",
          "Tap Save. If a warden pays in cash, the amount comes out of their cash box (My cash on Home).",
        ],
        note: {
          body: "Did you pay with eSewa, Khalti or your bank app? Open the payment in that app, tap Share, and choose HostelPalika. Add expense opens with the receipt attached and the amount filled in. The receipt picture stays with the expense.",
          title: "A faster way: share the receipt",
        },
        summary: "Record what the hostel spends, with a photo of the bill.",
        title: "Add an expense",
      },
      {
        body: [
          "The Statement lists all the money that came in and went out. The newest is at the top, and each line shows the balance after it. Rent, part payments, extra charges and expenses are all in this one list.",
          "For charts and PDF files of the same numbers, open Reports.",
        ],
        id: "statement",
        shot: pic(
          "resident-balance",
          "Transactions: each bill, the money paid for it, and what is still owed.",
        ),
        summary: "All money in and out, with the balance.",
        title: "Statement",
      },
      {
        body: [
          "Reports shows your numbers as charts: money collected, beds filled, and expenses. Choose any dates, and save the report as a PDF.",
        ],
        id: "reports",
        shot: pic("reports", "Reports: money collected, beds filled and expenses."),
        summary: "Charts of your money and beds, and PDF files.",
        title: "Reports",
      },
      {
        body: [
          "Move in / out lists who arrived and who left. The newest is at the top.",
          "A resident tells you they are leaving from their app. They choose their last day. It must be at least your notice days from today. Rent stops on that day.",
          "You and the resident get a reminder the day before, and on the day. On the day, Home shows Leaving today. Tap Move out to settle the last bill, the deposit and any dues. After that, their login becomes a normal public account again. Their history stays with you.",
        ],
        id: "move-out",
        shot: pic("move-in", "Move in / out: who arrived and who left."),
        summary: "How a resident leaves, and what you do on the last day.",
        title: "Move in and move out",
      },
      {
        body: [
          "Add wardens from Wardens, and cooks from Cooks. For each warden, turn on only what they need. For example, you choose if they can see money. The list shows how many permissions each warden has.",
          "Do you need someone for one day? Give them a temporary login. It stops working on its own. The Audit log shows who changed what, and when.",
        ],
        id: "team",
        shot: pic(
          "staff",
          "Warden permissions on the website, and the cook list in the app.",
        ),
        summary: "Add wardens and cooks, and choose what each one can do.",
        title: "Your staff",
      },
      {
        body: [
          "Plan billing shows your plan and how much you owe. Pay by QR, then upload a photo of the payment.",
          "Do you want to leave the platform? Go to Settings → Leave. You can clear your bills and download all your data first.",
        ],
        id: "plan",
        shot: pic("plan", "Settings on the website, and App lock on the phone."),
        summary: "Pay for your plan, or leave the platform.",
        title: "Your plan and account",
      },
    ],
    intro: "How to run your hostel: residents, rooms, money and staff.",
    label: "Hostel owner",
    slug: "owner",
  },
  {
    audience: ["warden"],
    chapters: [
      {
        body: [
          "A warden uses the same portal and app as the owner. The owner decides what you can do. For example, the owner chooses if you can see money. If something is turned off for you, it does not show in your menu.",
          "Cash you collect goes into your cash box. This is My cash on Home. When you give the cash to the owner, the owner taps Got it.",
        ],
        id: "warden-what",
        summary: "You use the owner's screens. The owner chooses which ones.",
        title: "What a warden can see",
        shot: pic(
          "warden-permissions",
          "The owner turns each permission on or off (website). The warden's Home (app).",
        ),
      },
      {
        body: [
          "You add residents, check payments and add expenses in the same way as the owner. Follow the chapters under Hostel owner.",
        ],
        id: "warden-same",
        shot: pic(
          "admin-vs-warden",
          "The same hostel on two phones. The owner is on the left, the warden is on the right.",
        ),
        summary: "These work the same as for the owner.",
        title: "Residents, payments and expenses",
      },
      {
        body: [
          "Your cash box counts the cash you collect and the cash you spend. My cash on Home shows how much you hold now.",
          "When you give cash to the owner, the owner taps Got it. That amount then leaves your cash box.",
        ],
        id: "warden-cash",
        shot: pic(
          "expenses-reports",
          "Staff cash on the website, and adding an expense in the app.",
        ),
        summary: "The cash you hold, and how to hand it over.",
        title: "Your cash box",
      },
      {
        body: [
          "Set the weekly menu and the meal times once. Residents then see today's meals on their Home.",
          "The cook adds a photo of each meal and taps Food ready. Every resident gets a notification. Residents can rate the food.",
        ],
        id: "food",
        shot: pic("food", "The weekly menu and meal times."),
        summary: "Set the weekly menu, and tell residents when food is ready.",
        title: "Food",
      },
      {
        body: [
          "Every night, each resident answers In or Out. On Android they can answer from the notification. Night Status shows who is in, who is out, and who has not answered.",
          "Location attendance records only three things: inside, nearby or away. The app never saves where a person is.",
        ],
        id: "night-status",
        shot: pic(
          "attendance",
          "Night status: who is in, who is out, who has not answered.",
        ),
        summary: "See who is in and who is out each night.",
        title: "Night status",
      },
      {
        body: [
          "Write a notice and everyone gets it in the app. You can send it now, set it for later, or repeat it every day or every week. For example: Clothes Washing every Saturday.",
        ],
        id: "notices",
        shot: pic("notices", "Push notices: running, set for later, and sent."),
        summary: "Send a message to everyone, now or later.",
        title: "Notices",
      },
      {
        body: [
          "The bell at the top holds your alerts: new payment claims, complaints, join requests and SOS.",
          "Tap an alert to open it. The number on the bell clears when you open the list.",
          "A daily routine, like meal times or Clothes Washing, is a notice that repeats. Set it once under Push notices.",
        ],
        id: "alerts",
        summary: "The bell shows what needs you. Routines repeat on their own.",
        title: "Alerts and daily routines",
      },
      {
        body: [
          "A resident reports a problem with a photo. You add updates until it is fixed. The resident sees every update.",
          "For a repair, you can add a voice note and send the job to a repair service that we have checked.",
        ],
        id: "complaints",
        shot: pic("complaints", "Complaints on the website, repairs in the app."),
        summary: "A resident reports a problem. You update it until it is fixed.",
        title: "Complaints and repairs",
      },
      {
        body: [
          "Stock records what you bought, what you used, and what is left. It works for the main hostel and for each branch. You can also order supplies from the store and pay when they arrive.",
        ],
        id: "stock",
        shot: pic("stock", "Stock: what you have, what is running low."),
        summary: "Know what you have and what is running low.",
        title: "Stock",
      },
    ],
    intro: "Your daily work. The owner decides what you can see.",
    label: "Warden",
    slug: "warden",
  },
  {
    audience: ["resident"],
    chapters: [
      {
        body: [
          "Your hostel adds you in one of three ways. The staff fill in your form at the desk. Or they scan your HostelPalika ID card. Or you scan the hostel's QR and fill in the form yourself. The email on the form becomes your login.",
          "Sign in with Google, or tap Forgot password to set a password. The app then opens on your hostel.",
        ],
        id: "joining",
        summary: "Your hostel adds you. Then the app shows your hostel.",
        title: "Join your hostel",
        flow: pic(
          "joining",
          "1 Before: a public account · 2 After: your hostel's Home.",
        ),
      },
      {
        body: [
          "Home shows your room, the money you still owe, the deposit the hostel holds, today's food, and any urgent notice.",
          "The tiles open your digital ID card, a call to the hostel, notices, your profile, guardians, location and night history.",
        ],
        flow: pic(
          "resident-tour",
          "1 Home · 2 Payments · 3 Your digital ID card · 4 Night history.",
        ),
        id: "resident-home",
        summary: "Your room, your bills and today's food on one screen.",
        title: "Your Home",
      },
      {
        body: [
          "Right after you join, the app shows your first bills: the joining bill (admission fee and deposit) and this month's rent. Pay this next always shows your oldest bill.",
        ],
        flow: pic(
          "flow-resident-first",
          "1 Your hostel Home · 2 What you owe · 3 Pay now: the QR and your code.",
        ),
        id: "first-bill",
        steps: [
          "Tap Pay now. You see the amount, your month code and the hostel's QR.",
          "Tap Copy next to the month code.",
          "Pay in your bank or wallet app. Paste the code in the remarks box.",
          "Share the receipt to HostelPalika, or upload a screenshot of it.",
          "Wait for the hostel to approve it. You get a notification when they do.",
        ],
        summary: "Copy your code, pay, then send the receipt.",
        title: "Pay your fee",
      },
      {
        body: [
          "Did you pay to the QR or by bank? The hostel cannot see that payment on its own. Send the screenshot so they can confirm it.",
        ],
        flow: pic(
          "flow-pay-proof",
          "1 Upload the receipt · 2 The app reads it · 3 It stops a wrong amount · 4 Sent to your hostel.",
        ),
        id: "send-proof",
        widget: "share-receipt",
        note: {
          body: "The app reads the amount and the transaction ID from your screenshot. If the amount is much more than you owe, the app stops and asks you to check. This way a typing mistake does not become a wrong record.",
          title: "The app checks for you",
        },
        steps: [
          "Tap I've paid and choose your receipt screenshot. You can also share it from your bank app to HostelPalika.",
          "The app fills in the amount, the method and the transaction ID. Check that they are right.",
          "Tap Submit claim. You see Sent to your hostel, and the bill shows Pending proof.",
          "When the hostel approves it, you get a notification and your balance goes down. Your receipt has a QR. Anyone can check it at /verify-receipt.",
        ],
        summary: "Upload the screenshot so the hostel can confirm your payment.",
        title: "Send your payment receipt",
      },
      {
        body: [
          "Your month code is a short code that is only yours. You get it with every bill.",
          "The first part is you, and it never changes. The last part is the month and the year, so it changes every month.",
          "Type the code in the remarks when you pay. Then the hostel knows who paid, and for which month.",
        ],
        id: "month-code",
        note: {
          body: "Bhadra 2083: RUP-482K-BHA83. The next month, Ashwin 2083: RUP-482K-ASW83.",
          title: "Two examples",
        },
        summary: "A short code that tells the hostel who paid, and for which month.",
        title: "Your month code",
      },
      {
        body: [
          "You get points each time you pay a bill. The earlier in the month you pay, the more points you get.",
          "Points count from the day you send the receipt, not the day the hostel approves it.",
          "Each bill gives points only once. A rejected receipt gives no points.",
          "Residents with more points are first in line for gifts and fee discounts in the Resident Offer Program.",
        ],
        id: "credit-score",
        note: {
          body: "Day 1 to 4 of the month: 10 points. Day 5 to 7: 8 points. Day 8 to 15: 5 points. After that: 2 points.",
          title: "How many points",
        },
        summary: "Pay early and get more points.",
        title: "Credit score",
      },
      {
        body: [
          "You can also pay at the hostel office.",
          "Give cash to the warden. Or scan the warden's QR with eSewa, Khalti or your bank app.",
          "The warden ticks the months you paid. You get a receipt in the app, and your points.",
          "Your points count from the day the warden records the payment.",
        ],
        id: "pay-at-office",
        summary: "Pay the warden with cash or a QR.",
        title: "Pay at the office",
      },
      {
        body: [
          "More holds the rest of your screens: Profile, My room, Moving out, Night status, Location & attendance, Night history, Guardians and Complaints.",
          "Guardians: invite a parent. They get their own login and see only what you share.",
          "Complaints: report a problem with a photo, and follow each update.",
          "SOS: the red button at the top alerts your warden, the owner and your guardians at the same time. Use it only in an emergency.",
        ],
        flow: pic(
          "resident-more",
          "1 More · 2 Guardians · 3 Complaints · 4 Moving out.",
        ),
        id: "resident-more",
        summary: "Guardians, complaints, night status and SOS.",
        title: "The More menu",
      },
      {
        body: [
          "Night status: every night, answer In or Out. On Android you can answer from the notification.",
          "Location: if you turn it on, the app records only inside, nearby or away. It never saves where you are.",
        ],
        id: "resident-night",
        summary: "Tell the hostel if you are in or out tonight.",
        title: "Night status",
        flow: pic(
          "night",
          "1 Night history · 2 Location: inside, nearby or away. Never the place.",
        ),
      },
      {
        body: [
          "Go to More → Moving out. Choose your last day. It must be at least your hostel's notice days from today. You can add a reason. Then tap I'm leaving.",
          "Rent stops on that day. You can change or cancel it before then. On the day, the warden settles your last bill and your deposit. Your account becomes a normal public account again, and you keep your receipts.",
        ],
        id: "resident-leaving",
        summary: "Tell the hostel your last day. Rent stops on that day.",
        title: "Move out",
        flow: pic(
          "leaving",
          "1 More → Moving out · 2 Choose the day. Rent stops then.",
        ),
      },
    ],
    intro: "Your room, your bills and your requests.",
    label: "Resident",
    slug: "resident",
  },
  {
    audience: ["cook"],
    chapters: [
      {
        body: [
          "Today shows today's meals. When a meal is served, tap Food ready. Every resident gets a notification.",
          "Menu is the plan for the week. Photos holds the meal pictures. In Khata you ask for items like eggs, or give them.",
          "If the owner allows it, you can record the stock you used and add market expenses. You see only your own entries.",
        ],
        id: "cook-home",
        summary: "Today's meals, the menu, photos and khata.",
        title: "The cook's screens",
        flow: pic(
          "cook",
          "1 What the cook can do, as set by the owner · 2 The weekly menu.",
        ),
      },
    ],
    intro: "Set the menu and tell everyone when food is ready.",
    label: "Cook",
    slug: "cook",
  },
  {
    audience: ["guardian"],
    chapters: [
      {
        body: [
          "Your child invites you from their app. You get your own login.",
          "Fee Summary shows what is due and what is paid. Safety Summary shows night status and any SOS. You also see notices, the food menu and the hostel's emergency contact.",
        ],
        id: "guardian-home",
        summary: "See your child's fees and safety.",
        title: "The guardian's screens",
      },
    ],
    intro: "See your child's fees and safety.",
    label: "Guardian",
    slug: "guardian",
  },
  {
    audience: ["visitor"],
    chapters: [
      {
        body: [
          "You can use the app before you join any hostel. Search hostels by city or near a college, and see them on the map. Compare them, save them and read reviews. Then send a question or book a bed.",
          "Your HostelPalika ID card is at the top of the app. Show it at any hostel, and the staff can add you by scanning it.",
        ],
        id: "visitor",
        summary: "Search for a hostel, and carry your ID card in the app.",
        title: "Find a hostel",
        flow: pic("visitor", "1 Home · 2 Search · 3 Map · 4 A hostel's page."),
      },
    ],
    intro: "Find a hostel before you join one.",
    label: "Visitor",
    slug: "visitor",
  },
  {
    audience: ["owner", "warden", "resident", "guardian", "cook", "visitor"],
    chapters: [
      {
        id: "who-can-do-what",
        summary: "One table for every role and every part of the app.",
        title: "Who can do what",
        widget: "access-table",
      },
      {
        id: "troubleshooting",
        summary: "Common problems, and how to fix them.",
        title: "Fix a problem",
        widget: "troubleshooting",
      },
    ],
    intro: "Who can do what, and quick fixes.",
    label: "Help",
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
    fix: "Your role is not allowed to use it. Ask the hostel owner to turn it on for you in Wardens.",
    problem: "I cannot find a screen",
  },
  {
    fix: "A bank or QR payment is marked paid only after the staff approve your screenshot. An eSewa or Khalti payment made inside the app is marked paid at once.",
    problem: "I paid, but my bill still shows as due",
  },
  {
    fix: "The amount on your screenshot is much more than you owe. Check the amount, or pay the bill that the amount belongs to.",
    problem: "I could not send my payment receipt",
  },
  {
    fix: "Tap Forgot password on the sign-in screen. If you forgot your PIN, tap Forgot PIN?. We send a code to your email.",
    problem: "I cannot sign in",
  },
  {
    fix: "Open Settings → Notifications in the app and turn them on. Also allow notifications for the app in your phone's settings.",
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
  out.push("", "## Fix a problem", "");
  for (const t of GUIDE_TROUBLE) out.push(`- **${t.problem}.** ${t.fix}`);
  return out.join("\n");
}
