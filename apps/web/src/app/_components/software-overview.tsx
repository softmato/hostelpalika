import {
  Bed,
  Building2,
  CalendarCheck,
  ChefHat,
  ChevronDown,
  ClipboardCheck,
  Globe,
  HardHat,
  Megaphone,
  QrCode,
  Receipt,
  ShieldAlert,
  Smartphone,
  TrendingUp,
  Undo2,
  UserRound,
  Users,
  Wallet,
  Wrench,
} from "@/components/icons";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

import { ContentSectionIcon } from "@/components/content-sections";
import { MoreToggle as More } from "@/components/smooth-collapse";
import { formatNpr } from "@/lib/json-ld";
import type { ResolvedModulePage } from "@/lib/seo-config";
import { cn } from "@/lib/utils";

import { ServiceIcon } from "./service-icon";

/**
 * The long, plain-language tour of the whole product for `/hostel-management-software`:
 * who uses it, how a hostel runs on it from sign-up to move-out, every feature
 * module with every service inside it, and the platform-wide extras.
 *
 * Everything is rendered in the HTML — the "Read more" panels are native
 * `<details>`, so a reader sees a short, clean page and a crawler or an LLM
 * still gets the complete text. The module/service facts come from the plans
 * catalogue (so they cannot drift from pricing); the roles, workflow and extras
 * below are written once, from what the app and the web portals actually ship.
 */

type Icon = ComponentType<{ className?: string }>;

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-sm font-semibold text-primary">{children}</p>;
}

function Heading({ children, lead }: { children: ReactNode; lead?: string }) {
  return (
    <div className="max-w-3xl">
      <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {children}
      </h2>
      {lead ? <p className="mt-3 text-base leading-relaxed text-muted-foreground">{lead}</p> : null}
    </div>
  );
}

function IconTile({ Icon, className }: { Icon: Icon; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary",
        className,
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
      {items.map((item) => (
        <li className="flex gap-2.5" key={item}>
          <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- roles */

const ROLES: Array<{
  Icon: Icon;
  does: string[];
  name: string;
  tagline: string;
  where: string;
}> = [
  {
    Icon: Building2,
    does: [
      "Registers the hostel, completes KYC and signs the agreement, then sets rooms, rent, food and payment details.",
      "Sees occupancy, dues, collections, expenses, complaints and tonight's night status on one dashboard.",
      "Adds branches, wardens and cooks, decides what each of them can open, and reads the audit trail of who changed what.",
    ],
    name: "Hostel owner",
    tagline: "Runs the whole hostel and every branch.",
    where: "Phone app and web portal",
  },
  {
    Icon: HardHat,
    does: [
      "Scans a resident's QR card at the gate, takes roll call and sees who is in tonight.",
      "Handles move-in and move-out checks, complaints, repair requests and SOS alerts.",
      "Receives cash from residents and hands it to the owner with a confirmation on both sides.",
    ],
    name: "Warden",
    tagline: "Runs the floor day to day.",
    where: "Phone app and web portal",
  },
  {
    Icon: ChefHat,
    does: [
      "Sees today's menu, marks each meal ready and gets low-stock alerts.",
      "Logs what was bought for the kitchen and sees what residents thought of each meal.",
      "Many cooks per hostel, each with their own login.",
    ],
    name: "Cook",
    tagline: "Has a kitchen screen of their own.",
    where: "Phone app and web portal",
  },
  {
    Icon: Users,
    does: [
      "Joins through the hostel's link or QR, sends their details with an ID card and carries a QR card afterwards.",
      "Sees every invoice, pays by eSewa or Khalti, uploads proof and keeps the receipt and running balance.",
      "Marks night status, reads the menu and notices, raises complaints and repairs, and presses SOS when it matters.",
    ],
    name: "Resident",
    tagline: "Pays, eats, checks in and asks for help from one app.",
    where: "Phone app and web portal",
  },
  {
    Icon: UserRound,
    does: [
      "Has their own login, linked to their child and nobody else's.",
      "Sees fee status, notices, the food menu and safety alerts.",
      "Is told at the same moment as the staff when the resident raises SOS.",
    ],
    name: "Parent or guardian",
    tagline: "Sees what they should, nothing they should not.",
    where: "Phone app and web portal",
  },
  {
    Icon: Wrench,
    does: [
      "Applies once, is verified, and then receives repair jobs from hostels.",
      "Opens the ticket, hears the voice note or sees the photo, and does the job.",
      "Carries a verified card that hostels can trust.",
    ],
    name: "Repair worker",
    tagline: "Plumbers, electricians and carpenters on call.",
    where: "Phone app and web portal",
  },
  {
    Icon: Globe,
    does: [
      "Searches hostels by city and area, opens the map, saves favourites and compares side by side.",
      "Reads photos, rooms, rent, facilities and reviews from people who actually lived there.",
      "Sends an enquiry or books a bed, and reads the community board before deciding.",
    ],
    name: "Anyone looking for a hostel",
    tagline: "Finds a verified hostel before ever visiting.",
    where: "Website, phone app and installable web app",
  },
];

export function RolesSection() {
  return (
    <section className="mt-20">
      <Eyebrow>Who it is for</Eyebrow>
      <Heading lead="One platform, a separate screen for every person in a hostel. Nobody sees more than their job needs.">
        Seven kinds of people, each with their own screen
      </Heading>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ROLES.map((role) => (
          <article className="hp-card flex flex-col rounded-2xl border border-border bg-surface p-5" key={role.name}>
            <div className="flex items-center gap-3">
              <IconTile Icon={role.Icon} />
              <div className="min-w-0">
                <h3 className="font-heading text-base font-bold text-foreground">{role.name}</h3>
                <p className="text-xs font-medium text-muted-foreground">{role.where}</p>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-foreground">{role.tagline}</p>
            <More label={`See all ${role.does.length} things they do`}>
              <Bullets items={role.does} />
            </More>
          </article>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- workflow */

const WORKFLOW: Array<{
  Icon: Icon;
  details: string[];
  summary: string;
  title: string;
}> = [
  {
    Icon: Building2,
    details: [
      "Sign up with a few details and the portal opens straight away.",
      "KYC is a guided set of steps — owner, building, rooms, food, photos, payment details — finished with a drawn signature on the agreement, which is emailed back as a letterhead PDF once the hostel is approved.",
      "Until KYC is approved the hostel stays unpublished, so nothing unverified ever appears in search.",
    ],
    summary: "Register the hostel and get it verified.",
    title: "Register and verify",
  },
  {
    Icon: Bed,
    details: [
      "Add floors, rooms and beds. The room and bed map shows what is free.",
      "Set one rent for each room type. The public listing, every invoice and the pricing shown to visitors all read from it.",
      "Add the week's food menu, your eSewa, Khalti or bank details for collection, photos, facilities and your public page.",
    ],
    summary: "Rooms, rent, food and payment details.",
    title: "Set up the building",
  },
  {
    Icon: QrCode,
    details: [
      "Share the hostel's join link or QR. The resident sends their room and rent with their ID card, and staff approve or send it back.",
      "Or scan the printed admission form's QR, which carries the paper form's fields into the portal.",
      "Residents already living in the hostel are brought in through the existing-residents list with the month each has paid up to, so nobody is billed twice.",
      "Admission fee and security deposit are raised as one joining invoice with a single reference code. Each resident gets a QR ID card.",
    ],
    summary: "A link, a QR or an existing list — no retyping.",
    title: "Bring residents in",
  },
  {
    Icon: Receipt,
    details: [
      "Invoices are raised automatically every Bikram Sambat month from the rent for each room type.",
      "A late fine can start after a number of free days. Khata items — things a resident took on credit — are added to the next rent bill.",
      "Part payments are recorded against the invoice. Reminders go to the resident and then to their guardian on a schedule you set.",
    ],
    summary: "Monthly invoices in the Nepali calendar, raised on their own.",
    title: "Bill every month",
  },
  {
    Icon: Wallet,
    details: [
      "Residents pay by eSewa or Khalti and upload the screenshot. It is read, checked against the invoice and flagged if the amount, receiver or reference is wrong.",
      "Wallet and bank statements are matched line by line against what the portal recorded.",
      "Cash a warden collects is handed over with a confirmation and a count of what is left in the box.",
      "Every payment gets a receipt with a verification code that anyone can check on the website.",
    ],
    summary: "Proof is checked before anyone marks it paid.",
    title: "Collect and verify",
  },
  {
    Icon: CalendarCheck,
    details: [
      "Residents mark inside or outside once a day. Wardens see who is in tonight. Location is used for the check and is never stored.",
      "The cook publishes the menu, marks meals ready and logs purchases. Residents rate each meal.",
      "Notices go out to everyone at once, and scheduled push notices (for example a weekly reminder) run on their own.",
    ],
    summary: "Attendance, meals and notices without a group chat.",
    title: "Run the day",
  },
  {
    Icon: ShieldAlert,
    details: [
      "Complaints and enquiries arrive with a status and an owner and stay open until closed.",
      "A repair request carries a photo or a voice note, is assigned to staff or a verified repair worker, and closes when the fault is fixed.",
      "One press of SOS in the resident's app alerts staff and guardians together.",
    ],
    summary: "Problems have an owner, a status and an end.",
    title: "Fix things and keep people safe",
  },
  {
    Icon: TrendingUp,
    details: [
      "A public page, a pin on the map and reviews from real residents bring in enquiries and bookings.",
      "Residents who pay on time and bring a friend earn against next month through the offer and referral programs.",
      "Add branches under your main hostel and read every building side by side in Overall, with one bill.",
      "Reports, monthly trends, an occupancy and revenue forecast, an audit trail and an API with webhooks complete the picture.",
    ],
    summary: "Be found, be chosen, and see every building at once.",
    title: "Grow and control",
  },
  {
    Icon: Undo2,
    details: [
      "A move-out checklist is ticked on the way out, and the money owed either way is settled and written to the statement.",
      "The resident's login returns to a public account, so they keep the app and their history.",
      "A hostel that ends its plan clears its bills, leaves through a request, and receives its records.",
    ],
    summary: "Checklist, settlement and a clean exit.",
    title: "Move out and leave",
  },
];

export function WorkflowSection() {
  return (
    <section className="mt-20">
      <Eyebrow>How it works</Eyebrow>
      <Heading lead="From the day you register to the day a resident leaves, in the order a hostel actually lives it.">
        One hostel, start to finish
      </Heading>
      {/* A vertical flow: step 1 is open in full, each next step is a short card, and a
          dashed line with an arrow runs from one icon down to the next. */}
      {/* An S-shaped path: cards zig-zag left, right, left…, and a dashed curve flows from
          each card to the next with an arrow head. Below `lg` it is one column with a
          straight dashed drop. Step 1 starts open. */}
      <ol className="mt-10">
        {WORKFLOW.map((step, index) => {
          const last = index === WORKFLOW.length - 1;
          const right = index % 2 === 1;

          return (
            <li key={step.title}>
              <div
                className={cn(
                  "hp-card rounded-2xl border border-border bg-surface p-5 lg:w-[46%]",
                  right && "lg:ml-auto",
                )}
              >
                <div className="flex items-center gap-3">
                  <IconTile
                    className="size-12 rounded-2xl bg-primary text-primary-foreground shadow-md"
                    Icon={step.Icon}
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wider text-primary">
                      Step {index + 1}
                    </p>
                    <h3 className="font-heading text-base font-bold text-foreground">{step.title}</h3>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-foreground">{step.summary}</p>
                <More defaultOpen={index === 0} label="Full details">
                  <Bullets items={step.details} />
                </More>
              </div>
              {last ? null : (
                <>
                  <div aria-hidden className="flex flex-col items-center lg:hidden">
                    <span className="hp-dash-v h-10 w-0.5" />
                    <ChevronDown className="hp-nudge-y size-5 text-primary" />
                  </div>
                  <div aria-hidden className="relative hidden h-28 lg:block">
                    <svg
                      className="absolute inset-0 size-full text-primary"
                      fill="none"
                      preserveAspectRatio="none"
                      viewBox="0 0 100 100"
                    >
                      <path
                        className="hp-dash-path"
                        d={right ? "M75 0 C75 45 25 55 25 92" : "M25 0 C25 45 75 55 75 92"}
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                    <ChevronDown
                      className="hp-nudge-y absolute bottom-0 size-6 -translate-x-1/2 text-primary"
                      style={{ left: right ? "25%" : "75%" }}
                    />
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------- module atlas */

export function ModuleAtlas({ modules }: { modules: ResolvedModulePage[] }) {
  if (modules.length === 0) return null;

  return (
    <section className="mt-20">
      <Eyebrow>Every feature</Eyebrow>
      <Heading
        lead={`${modules.length} areas, ${modules.reduce(
          (total, entry) => total + entry.services.length,
          0,
        )} features. Open any area to see each feature and the plan it starts on.`}
      >
        Everything a hostel runs on
      </Heading>
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {modules.map((entry) => (
          <article
            className="hp-card flex flex-col rounded-2xl border border-border bg-surface p-5"
            id={entry.slug}
            key={entry.slug}
          >
            <div className="flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ContentSectionIcon className="size-5" slug={entry.module.icon} />
              </span>
              <div className="min-w-0">
                <h3 className="font-heading text-base font-bold text-foreground">
                  <Link className="transition hover:text-primary" href={`/features/${entry.slug}`}>
                    {entry.module.name}
                  </Link>
                </h3>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                  {entry.module.description}
                </p>
              </div>
            </div>
            <More label={`See all ${entry.services.length} features`}>
              <ul className="grid gap-3">
                {entry.services.map((service) => (
                  <li className="flex gap-3" key={service.slug}>
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <ServiceIcon
                        className="size-4"
                        fallbackSlug={entry.module.icon}
                        slug={service.slug}
                      />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        <Link
                          className="transition hover:text-primary"
                          href={`/plans-pricing/${service.slug}`}
                        >
                          {service.name}
                        </Link>
                        {service.plan ? (
                          <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                            {service.plan.name} · {formatNpr(service.plan.monthly)}/mo
                          </span>
                        ) : null}
                      </p>
                      <p className="text-sm leading-relaxed text-muted-foreground">{service.blurb}</p>
                      {service.audience.length ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          For {service.audience.join(", ").toLowerCase()}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </More>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- extras */

const EXTRAS: Array<{ Icon: Icon; body: string; title: string }> = [
  {
    Icon: CalendarCheck,
    body: "Billing months follow the Bikram Sambat calendar, so a period is Baisakh or Bhadra, not a guess in AD.",
    title: "Built on the Nepali calendar",
  },
  {
    Icon: Smartphone,
    body: "A dedicated Android app and an installable web app, plus a browser portal for each role. The same account works in all of them.",
    title: "Phone first, web too",
  },
  {
    Icon: QrCode,
    body: "Every receipt carries a code that anyone can check on the website, so a screenshot cannot be passed off as a payment.",
    title: "Receipts you can verify",
  },
  {
    Icon: Megaphone,
    body: "Screens update while they are open and a push reaches phones when the app is shut. Emails are limited to one routine message a day, with an unsubscribe on every one.",
    title: "Notifications that respect people",
  },
  {
    Icon: ClipboardCheck,
    body: "A 4-digit PIN and fingerprint unlock the app and every web portal. Staff only see the parts their job needs, and every change is written to an audit trail.",
    title: "Locked, scoped and logged",
  },
  {
    Icon: Users,
    body: "A community board for each audience, a map and compare tool for people choosing a hostel, a supply store for mattresses and cleaning supplies, and a network of verified repair workers.",
    title: "More than software",
  },
];

export function ExtrasSection() {
  return (
    <section className="mt-20">
      <Eyebrow>And across the platform</Eyebrow>
      <Heading>Details that make it feel made for Nepal</Heading>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {EXTRAS.map((extra) => (
          <article className="hp-card rounded-2xl border border-border bg-surface p-5" key={extra.title}>
            <IconTile Icon={extra.Icon} />
            <h3 className="mt-4 font-heading text-base font-bold text-foreground">{extra.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{extra.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
