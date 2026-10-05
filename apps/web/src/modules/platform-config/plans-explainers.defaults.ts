/**
 * What each service is, how it works, and why it is built that way.
 *
 * Kept out of `plans-catalog.ts` on purpose: the catalogue is the structure the
 * pricing page reads on every render — plans, modules, slugs — and this is the
 * prose only a detail page ever needs. One file per job keeps the catalogue
 * scannable and lets the writing grow without pushing the structure off screen.
 *
 * The rule for what goes in here is only what the product actually does. Where a
 * service is still being built, its entry says what it will do in the same plain
 * terms and invents no numbers, no guarantees and no response times — a page
 * that oversells is worse than a page that is short.
 */
export type ServiceExplainer = {
  how: string[];
  what: string[];
  why: string[];
};

export const DEFAULT_SERVICE_EXPLAINERS: Record<string, ServiceExplainer> = {
  admissions: {
    how: [
      "It is raised once, when the resident joins, and it carries no month the way rent does — one invoice, one reference code, both amounts on it.",
    ],
    what: [
      "The admission fee and the security deposit raised together as a single invoice when a resident moves in.",
    ],
    why: [
      "Joining is one moment for the resident, so it should be one payment and one receipt. Splitting it into two bills means two things to chase, two things to reconcile, and a deposit that goes missing from the paperwork the day it has to be returned.",
    ],
  },
  "admission-agreements": {
    how: [
      "The hostel publishes its terms once. A joining resident reads and signs them on their own phone, and the signed copy is stored against their record where staff and the resident can both find it.",
    ],
    what: [
      "The joining agreement read and signed on the resident's phone, kept with their record instead of in a drawer.",
    ],
    why: [
      "A signed paper only settles an argument if someone can produce it. Two years and three wardens later, nobody can — and the terms a resident agreed to become whatever both sides remember.",
    ],
  },
  "api-access": {
    how: [
      "Keys are issued per account and scoped to what they are for. Residents, invoices and payments can be read by another system, and a webhook fires the moment one of them changes, so nothing has to poll.",
    ],
    what: [
      "The hostel's own data, readable by whatever else the operator already runs, with a callback when it changes.",
    ],
    why: [
      "An operator at this size already has an accountant, a spreadsheet or a system of their own. Their data should reach it without a person retyping it once a month — and retyping is where the numbers stop matching.",
    ],
  },
  "audit-log": {
    how: [
      "Changes are written as they happen and read back per record: who made the change, when, and from where.",
    ],
    what: ["A record of who changed what, when, and from where."],
    why: [
      "Not for suspicion. For the day a rent looks wrong, a resident swears they were marked paid, or a room shows free when it is not — and the only useful question is what changed and who changed it.",
    ],
  },
  "cook-portal": {
    how: [
      "A cook signs in to their own account and sees the kitchen and nothing else — today's menu, the log of what has been served, and what is running low.",
    ],
    what: ["The kitchen's own screen: today's menu, the ready log and stock alerts."],
    why: [
      "Kitchen staff should not need the owner's portal, or the owner's password, to do their own job. Sharing one login to mark a meal ready is how a hostel ends up with an audit trail that names the owner for everything.",
    ],
  },
  "daily-attendance": {
    how: [
      "The resident marks themselves in or out from their phone, once a day, and the warden sees tonight's night status build up: who is in, who is out, and who never answered.",
      "The check confirms the resident is at the hostel without keeping where they were. Coordinates are never stored — a test in the codebase fails if they ever are.",
    ],
    what: [
      "Inside or outside, marked once a day, and the roll of who is in the building tonight.",
    ],
    why: [
      "A hostel is responsible for who is under its roof tonight, and a paper register answers that question only if someone is standing at the desk. Tracking where a resident actually goes answers a question nobody asked, so the design refuses to collect it.",
    ],
  },
  "dues-chasing": {
    how: [
      "You set the ladder: a reminder to the resident, a firmer one later, then the guardian. Each step is sent only while the invoice is still unpaid, and the whole sequence stops the moment it is settled.",
    ],
    what: [
      "The follow-up on an overdue invoice, sent for you instead of remembered by you.",
    ],
    why: [
      "Chasing dues is the job every owner puts off, because it is the one that costs a relationship. Every week it is put off is a week the money is harder to collect — and a schedule does the asking without anyone having to be the villain.",
    ],
  },
  "finance-reports": {
    how: [
      "Collections, dues and arrears for a month, built from the same ledger the invoices sit on, and exportable.",
    ],
    what: ["The month's money in a form you can hand to someone else."],
    why: [
      "The figure an owner needs for a partner, a landlord or a loan has to come from the same place the resident's own screen reads, or the two will differ and both will be defended.",
    ],
  },
  "food-menu": {
    how: [
      "The week's menu is set per meal and published once. Residents open the app to today; the kitchen works from the same list.",
    ],
    what: [
      "What the kitchen is cooking this week, in the resident's hand instead of on the mess door.",
    ],
    why: [
      "A menu on the mess door answers the question only for the people already standing at the mess door.",
    ],
  },
  "guardian-accounts": {
    how: [
      "The guardian is invited, signs in as themselves, and is linked to their ward and nobody else's. What they can see is decided by the resident, and every part of it starts switched off.",
    ],
    what: [
      "A parent's own account, tied to their ward alone, showing only what that resident has allowed.",
    ],
    why: [
      "Parents ask anyway, and they ask the warden at the worst possible time. Giving them their own answer is better for everyone — but the resident is an adult, so nothing opens until they open it.",
    ],
  },
  "inventory-management": {
    how: [
      "Three taps, each when goods actually move: Bought when they arrive, Send when they go to a branch, and a Count of what is left. The branch taps Got it, so a short delivery shows up the same day.",
    ],
    what: [
      "How much of each item was bought, how much went to each building, and what is left in every store.",
    ],
    why: [
      "Bulk rice split between two buildings by hand is the stock nobody can account for at the end of the month.",
    ],
  },
  "map-presence": {
    how: [
      "A pin placed from the hostel's address, shown wherever visitors browse by area, with directions that open in their own phone's map.",
    ],
    what: ["A pin on the map, and directions from wherever the visitor is."],
    why: [
      "Almost nobody looks for a hostel in general. They look for one near a campus, an office or a bus route, which is a question only a map can answer.",
    ],
  },
  "meal-feedback": {
    how: [
      "Residents rate the meal that was actually served, from their own app, meal by meal. The ratings sit next to the menu, so a pattern shows up on its own.",
    ],
    what: ["What residents thought of the food, per meal."],
    why: [
      "Complaints arrive as moods and arguments, months after the fact. A rating against one meal is small enough to be honest and specific enough for the kitchen to act on.",
    ],
  },
  "monthly-invoicing": {
    how: [
      "Invoices are raised for the month automatically, on the Bikram Sambat calendar — a period is a BS month, not a Gregorian one borrowed and relabelled. The receipt and the running balance land on the resident's own ledger, in order.",
    ],
    what: [
      "The month's bills raised for you, with the receipt and the balance kept against each resident.",
    ],
    why: [
      "Nepali hostels bill by Nepali months. Software that quietly bills the 1st to the 31st of a foreign calendar makes the owner do the translation forever, and gets the length of the month wrong twice a year.",
    ],
  },
  "move-checklist": {
    how: [
      "The same list is ticked twice — once at move-in, once at move-out — and kept against both the room and the resident who signed it.",
    ],
    what: ["The room's handover list, ticked on the way in and on the way out."],
    why: [
      "Almost every deposit argument is about the state of a room months ago. The only thing that settles it is what both sides agreed to on the day, written down.",
    ],
  },
  "multi-property-control": {
    how: [
      "Each building keeps its own rooms, residents and staff, so a warden sees their property and not the others. The owner's view puts them side by side, and billing arrives as one.",
    ],
    what: [
      "Every property side by side, scoped to its own staff and rooms, on one bill.",
    ],
    why: [
      "Running three buildings as three separate accounts means logging in three times, adding up by hand, and never quite knowing which one is carrying the others.",
    ],
  },
  "maintenance-requests": {
    how: [
      "A resident raises the fault against their room with a photo. It is assigned, worked, and closed with a note the resident can see.",
    ],
    what: [
      "A fault reported with a photo, assigned to someone, and closed when it is actually fixed.",
    ],
    why: [
      "“I told the warden” is not a record and it is not a queue. Without one, the loudest resident is repaired first and the quiet leak runs for a month.",
    ],
  },
  notices: {
    how: [
      "A notice is posted once and delivered to the people it concerns. A complaint carries a status, an owner and a closing note. An enquiry from the public page lands in the same inbox as both.",
    ],
    what: [
      "Notices going out, and complaints and enquiries coming in — each with a status and someone answerable for it.",
    ],
    why: [
      "A board, a group chat and a phone call are three places for a message to be missed, and none of them can be asked later what was decided.",
    ],
  },
  notifications: {
    how: [
      "Panels update themselves as things change, and a push arrives when the app is closed. Delivery is scoped, so a resident, a warden and a guardian are each told only what is theirs.",
    ],
    what: ["Screens that update on their own, and a push when the app is shut."],
    why: [
      "Software that has to be refreshed to be right gets checked once a week, and an SOS or an unpaid invoice is not a once-a-week thing.",
    ],
  },
  "occupancy-forecast": {
    how: [
      "Read forward from what is already known — notice periods served, checkouts planned, and the rate card — rather than from a guess about next month.",
    ],
    what: ["The beds coming free and the rent expected in the months ahead."],
    why: [
      "A bed you learn is empty on the first of the month is empty for that month. A bed you know is coming free in six weeks can be filled in six weeks.",
    ],
  },
  "offer-program": {
    how: [
      "Eligibility is computed from the ledger — paid on time, still living here, brought someone who joined — and what is earned lands as a credit against the next invoice rather than as cash.",
    ],
    what: [
      "A discount a resident earns rather than negotiates: for paying on time, and for bringing someone who stays.",
    ],
    why: [
      "Collection improves when paying early is worth something, and a resident who recommends the place costs less than any advertising the hostel could buy.",
    ],
  },
  "operations-analytics": {
    how: [
      "The same figures the dashboard shows for today, kept and lined up month against month: occupancy, collection rate, complaint load.",
    ],
    what: ["How the hostel has moved across months, not just where it is today."],
    why: [
      "One month is weather. The line across six is the business, and it is the only thing that tells an owner whether a change they made worked.",
    ],
  },
  "operations-dashboard": {
    how: [
      "Occupancy, dues, open complaints and tonight's night status, read live from the records the rest of the portal writes.",
    ],
    what: ["The four numbers the day starts with, on one screen."],
    why: [
      "The morning question is always the same, and answering it by opening four screens means it gets asked less often than it should.",
    ],
  },
  "payment-evidence": {
    how: [
      "The screenshot is read for the amount, the date, the payee and the transaction id, then checked against the invoice it claims to pay. Anything that does not line up is flagged for a person instead of quietly accepted.",
      "Only details the payer cannot control are trusted — the payee and the direction of the transfer among them — so an edited or reused image does not pass by looking right.",
    ],
    what: [
      "A payment screenshot read and checked against the invoice it is offered for.",
    ],
    why: [
      "A screenshot is the most common proof of payment in Nepal and also the easiest to edit, crop or send twice. Checking it is what makes accepting one safe enough to do at all.",
    ],
  },
  "priority-support": {
    how: [
      "Existing registers and rent records are imported at setup rather than typed in by the hostel, and the same named person stays with the account afterwards.",
    ],
    what: [
      "Your data moved for you, one person who knows the account, and a queue that reaches them first.",
    ],
    why: [
      "The riskiest week is the first one. A large hostel switching systems mid-month cannot afford to be learning the software and rebuilding its resident list at the same time.",
    ],
  },
  "provider-network": {
    how: [
      "Plumbers, electricians and carpenters are onboarded and verified on the platform. A ticket is assigned to one of them and carries the room, the photo and any voice note with it.",
    ],
    what: [
      "Verified trades, reachable from the ticket rather than from a list of numbers.",
    ],
    why: [
      "A hostel's own list of numbers is only as good as the last person who answered it, and the search for someone who will come today starts again with every repair.",
    ],
  },
  "public-listing": {
    how: [
      "Built from the records the portal already keeps — the rate card sets the price, the bed map sets what is free — so the page cannot advertise something the hostel is not.",
    ],
    what: [
      "The hostel's public page: photos, rooms, rent and facilities, kept current by the portal itself.",
    ],
    why: [
      "A listing maintained separately from the hostel's own data is out of date the day after it is written, and the first thing a visitor finds wrong is the price.",
    ],
  },
  "public-page-branding": {
    how: [
      "Sections, order and imagery are chosen for the hostel instead of fixed by one template, and the hostel's name and colours are carried through the portal, the resident app and every document it produces.",
    ],
    what: [
      "The public page arranged the way the hostel wants it, and its brand on everything the software prints.",
    ],
    why: [
      "At a certain size a hostel is a business with a name of its own, and looking like every other listing on the platform costs it the thing it has spent years building.",
    ],
  },
  "rate-card": {
    how: [
      "Rent is set once per room type. The public listing's price and every invoice raised are projected from that one card, so a rent is changed in exactly one place.",
    ],
    what: ["One rent per room type, and the record of what each room holds."],
    why: [
      "When rent lives in the listing, the resident's record and the invoice, the three drift apart, and a resident is eventually billed a price the site never advertised.",
    ],
  },
  reconciliation: {
    how: [
      "Export the wallet's own statement and each line is matched against a recorded payment. What matches is settled; what does not is listed for a person to look at.",
    ],
    what: [
      "The month's money as the wallet saw it, set against the month as the portal recorded it.",
    ],
    why: [
      "Money that reached the wallet but never reached the ledger is invisible until someone reconciles it — and by then it is a month of digging through screenshots.",
    ],
  },
  "resident-directory": {
    how: [
      "A resident is created once, at admission or from an invite, and every other screen reads that one record — the bed map, the month's invoices, attendance, complaints. Change the room or the guardian and it changes everywhere.",
    ],
    what: [
      "Every resident, the bed they hold, the guardian attached to them, and the history of both.",
    ],
    why: [
      "The alternative is the same person written into a register, a rent diary and a group chat, with the three disagreeing by the second month and nobody sure which is right.",
    ],
  },
  "resident-id-cards": {
    how: [
      "The card is generated from the resident's own record, so it works for as long as they live there and stops the moment they check out. The warden scans the resident, not a number written on paper.",
    ],
    what: [
      "A resident registered once and carried as a QR card the warden scans at the gate.",
    ],
    why: [
      "Gate checks that depend on recognising faces stop working the week a new warden starts, and a handwritten pass is worth exactly as much as the paper it is on.",
    ],
  },
  reviews: {
    how: [
      "Left by residents of that hostel and shown on its listing, next to the facts the portal already publishes.",
    ],
    what: [
      "The hostel judged by the people who slept in it, on the same page that advertises it.",
    ],
    why: [
      "Every hostel describes itself well. The only account a family weighs against that is one from someone who has already slept there.",
    ],
  },
  "room-bed-map": {
    how: [
      "Rooms carry a type and their beds. Allocating a resident takes a bed and checking them out frees it, and what is free feeds the public listing without anyone updating it twice.",
    ],
    what: ["Rooms, the beds in them, and what is free — as a map you allocate from."],
    why: [
      "Occupancy is the number the whole business runs on. Counting it by hand at month end is counting it too late to do anything about it.",
    ],
  },
  "sos-alerts": {
    how: [
      "Raised from the resident's own header, it reaches staff and permitted guardians at once. The alert stays active for the day and clears when staff settle it.",
    ],
    what: ["One press that reaches staff and guardians at the same moment."],
    why: [
      "In an emergency the part that fails is finding the right number. One press, from a screen already open, removes that step entirely.",
    ],
  },
  "supply-store": {
    how: [
      "One catalogue serves every hostel on the platform. Order from the portal and pay cash when it arrives — no card, no advance.",
    ],
    what: [
      "Mattresses, buckets and cleaning supplies, ordered in the portal and paid on delivery.",
    ],
    why: [
      "Restocking is the errand that eats a morning and always happens on the day something else has gone wrong.",
    ],
  },
  "voice-notes": {
    how: [
      "Recorded on the resident's phone, stored with the ticket, and played back by whoever is doing the repair. Nothing is transcribed — the recording is the report.",
    ],
    what: ["Say what is broken instead of typing it."],
    why: [
      "Describing a leak in written English is a barrier for the person who has to report it; holding a phone and talking is not. Transcribing it would only add a version that can be wrong.",
    ],
  },
  "warden-roles": {
    how: [
      "Staff are invited to the hostel and given a role, and the role decides which screens exist for them. The money side is a separate permission from the day-to-day one.",
    ],
    what: ["Staff accounts holding only the parts of the portal a job needs."],
    why: [
      "Everyone sharing the owner's login is one resignation away from a problem, and it makes every record of who did what meaningless.",
    ],
  },
};

