"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ChevronDown,
  HardHat,
  Home,
  Plus,
  UserRound,
  type IconComponent,
} from "@/components/icons";
import Image from "next/image";
import { useState } from "react";

import { useSiteConfig } from "@/components/site-config-provider";
import { cn } from "@/lib/utils";

import { MOCKUPS, type Mockup } from "./portal-mockups";

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Who is asking.
 *
 * Three people open this page and none of them want the same answer: someone
 * living in a hostel, someone running one, and a plumber deciding whether to
 * register. Grouping by person rather than by feature means nobody reads six
 * answers about staff permissions to find out how to pay their rent.
 */
type FaqRole = "resident" | "hostel" | "provider";

type FaqEntry = {
  answer: string;
  id: string;
  question: string;
  role: FaqRole;
};

const ROLES: { icon: IconComponent; id: FaqRole; label: string }[] = [
  { icon: Home, id: "hostel", label: "Hostel owners" },
  { icon: UserRound, id: "resident", label: "Residents" },
  { icon: HardHat, id: "provider", label: "Service providers" },
];

/**
 * The questions people actually type into a contact form before they buy, in
 * the words they use — short, direct, and answered in two or three plain
 * sentences. A visitor who has to read a sentence twice has already decided
 * the software is complicated.
 *
 * `{site}` is filled in with the site name at render, so this list never
 * hard-codes the brand.
 *
 * Every answer is a claim about what the product does. When the product
 * changes, this changes with it.
 */
const FAQS: FaqEntry[] = [
  // Hostel owner and warden.
  {
    answer:
      "Software to run your hostel. Rooms, residents, rent, food, complaints and reports sit in one place, and your residents get a phone app for their side of it.",
    id: "hostel-what",
    question: "What is {site}?",
    role: "hostel",
  },
  {
    answer:
      "No. If you can use a phone for calls and messages, you can use this. Every screen is one list and the button you need on it.",
    id: "hostel-skills",
    question: "Do I need technical skills?",
    role: "hostel",
  },
  {
    answer:
      "One price for the whole hostel, set by how many residents you have. The three plans are above. Pay every month, or once for the year and pay less.",
    id: "hostel-cost",
    question: "How much does it cost?",
    role: "hostel",
  },
  {
    answer:
      "Register your hostel, add your rooms and your rent, then add your residents. After that the bills for each month are raised for you.",
    id: "hostel-start",
    question: "How do I start?",
    role: "hostel",
  },
  {
    answer:
      "One list for the month. Every name shows paid, part paid or due, and the totals are counted for you.",
    id: "hostel-dues",
    question: "How do I see who has paid and who has not?",
    role: "hostel",
  },
  {
    answer:
      "Yes. A month here is a Bikram Sambat month — Bhadra 2083, not August 2026. Bills and reports follow it.",
    id: "hostel-calendar",
    question: "Does it use the Nepali calendar?",
    role: "hostel",
  },
  {
    answer:
      "Yes. Each staff member gets their own login and sees only their own work. You decide whether they can see the money side.",
    id: "hostel-staff",
    question: "Can my warden use it too?",
    role: "hostel",
  },
  {
    answer:
      "Yes, on the Max plan. Each building keeps its own rooms and residents, and you get one report and one bill for all of them.",
    id: "hostel-multi",
    question: "Can I run more than one hostel?",
    role: "hostel",
  },
  {
    answer:
      "Your hostel's data is yours alone — no other hostel can see it. Every change is saved with who made it and when.",
    id: "hostel-safe",
    question: "Is my data safe?",
    role: "hostel",
  },
  {
    answer:
      "You can move up or down a plan whenever you want. Your residents, bills and old records stay exactly where they are.",
    id: "hostel-change-plan",
    question: "Can I change my plan later?",
    role: "hostel",
  },

  // Resident.
  {
    answer:
      "See your room, your bill, this week's food menu and the hostel's notices. You can also pay rent, mark attendance and report anything broken.",
    id: "resident-what",
    question: "What can I do in the app?",
    role: "resident",
  },
  {
    answer:
      "Open your bill and pay with eSewa, Khalti or Fonepay. The bill turns to paid on its own and the receipt stays in the app.",
    id: "resident-pay",
    question: "How do I pay my rent?",
    role: "resident",
  },
  {
    answer:
      "Send the payment screenshot on that same bill. The app checks the amount and the date, the hostel confirms it, and you can watch the status change.",
    id: "resident-unpaid",
    question: "I paid but my bill still shows due. What do I do?",
    role: "resident",
  },
  {
    answer:
      "Open a repair request. Add a photo, or just record a voice note saying what is wrong. You can see when someone takes it and when it is fixed.",
    id: "resident-repair",
    question: "How do I report something broken?",
    role: "resident",
  },
  {
    answer:
      "Yes. The week's menu is in the app, and you can say what you thought of each meal.",
    id: "resident-food",
    question: "Can I see the food menu?",
    role: "resident",
  },
  {
    answer:
      "No. Attendance only saves that you were in or out for the day. Your location is never stored.",
    id: "resident-location",
    question: "Does the app track my location?",
    role: "resident",
  },
  {
    answer:
      "Only what you allow. Your parent gets their own login, and every part of it stays switched off until you turn it on.",
    id: "resident-guardian",
    question: "What can my parents see?",
    role: "resident",
  },
  {
    answer:
      "No. The hostel pays for the software. For you the app is free.",
    id: "resident-cost",
    question: "Do I have to pay for the app?",
    role: "resident",
  },

  // Service provider.
  {
    answer:
      "Plumbers, electricians, carpenters and anyone who does repair work. Sign up, say what work you do and which areas you cover.",
    id: "provider-join",
    question: "Who can join as a service provider?",
    role: "provider",
  },
  {
    answer:
      "Hostels near you send jobs to your phone. Once a hostel has checked your details, they can reach you straight from a repair request.",
    id: "provider-work",
    question: "How do I get work?",
    role: "provider",
  },
  {
    answer:
      "Yes. The job comes with the room, a photo, and often a voice note from the resident saying what is wrong.",
    id: "provider-details",
    question: "Can I see the problem before I go?",
    role: "provider",
  },
  {
    answer:
      "No. You take the job, and you mark it done when it is finished.",
    id: "provider-typing",
    question: "Do I have to type a lot?",
    role: "provider",
  },
];

function firstIdFor(role: FaqRole) {
  return FAQS.find((faq) => faq.role === role)?.id ?? "";
}

/**
 * The FAQ block on Plans & Pricing.
 *
 * A picture of the product on the left and the answers on the right. The
 * picture is here because the questions beside it are about a thing the reader
 * has not seen yet — "how do I see who has paid" is a much smaller question
 * once the list it describes is on screen.
 *
 * The picture follows the role tabs: an owner sees the dashboard, a resident
 * sees their own fees screen.
 */
export function PlansFaq() {
  const { identity } = useSiteConfig();
  const [role, setRole] = useState<FaqRole>("hostel");
  const [openId, setOpenId] = useState(() => firstIdFor("hostel"));
  const reduced = useReducedMotion();

  const entries = FAQS.filter((faq) => faq.role === role).map((faq) => ({
    ...faq,
    question: faq.question.replace("{site}", identity.siteName),
  }));

  function selectRole(next: FaqRole) {
    setRole(next);
    // Open the first answer of the group the reader just switched to. Landing
    // on a column of closed rows reads as "nothing here"; one open answer shows
    // the shape of the rest.
    setOpenId(firstIdFor(next));
  }

  return (
    <section className="mt-20">
      <div className="text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-teal">
          Have any questions?
        </p>
        <h2 className="mt-2 font-heading text-2xl font-bold tracking-tight text-foreground">
          Frequently asked questions
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Short answers, in plain words. Pick who you are.
        </p>
      </div>

      <div className="mt-9 grid items-start gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        {/* Sticky on wide screens: the answers are long, and the whole point of
            the picture is that it stays beside them. */}
        <div className="lg:sticky lg:top-24">
          <FaqPreview reduced={reduced} role={role} />
        </div>

        <div>
          <RoleTabs onSelect={selectRole} role={role} />

          {/*
           * Keyed on the role, so React throws the old list away and the rows
           * play their entrance again — the switch reads as a change of
           * subject rather than as text rewriting itself in place.
           *
           * Deliberately NOT wrapped in AnimatePresence. `mode="wait"` keeps
           * the outgoing list mounted until its exit finishes, and here that
           * exit never ran: the tab flipped, the state changed, and the column
           * went on showing the previous person's questions. Same trap the
           * price figure on the cards documents.
           */}
          <motion.ul
            animate={{ opacity: 1, y: 0 }}
            className="mt-5 space-y-3"
            initial={{ opacity: 0, y: reduced ? 0 : 8 }}
            key={role}
            transition={{ duration: reduced ? 0.12 : 0.24, ease: EASE }}
          >
            {entries.map((faq, index) => (
              <FaqRow
                delay={reduced ? 0 : index * 0.04}
                entry={faq}
                key={faq.id}
                onToggle={() =>
                  setOpenId((current) => (current === faq.id ? "" : faq.id))
                }
                open={openId === faq.id}
                reduced={reduced}
              />
            ))}
          </motion.ul>
        </div>
      </div>
    </section>
  );
}

/**
 * Segmented, and carrying the same sliding pill as the billing toggle above —
 * two controls on one page that behave differently are two things to learn.
 */
function RoleTabs({
  onSelect,
  role,
}: {
  onSelect: (next: FaqRole) => void;
  role: FaqRole;
}) {
  return (
    <div
      aria-label="Who is asking"
      className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-surface p-1 shadow-sm"
      role="tablist"
    >
      {ROLES.map((option) => {
        const selected = role === option.id;

        return (
          <button
            aria-selected={selected}
            className={cn(
              "relative flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors sm:text-sm",
              selected ? "text-white" : "text-muted-foreground hover:text-foreground",
            )}
            key={option.id}
            onClick={() => onSelect(option.id)}
            role="tab"
            type="button"
          >
            {selected ? (
              <motion.span
                className="absolute inset-0 rounded-xl bg-brand-teal shadow-sm"
                layoutId="faq-role-pill"
                transition={{ damping: 30, stiffness: 380, type: "spring" }}
              />
            ) : null}
            <option.icon className="relative size-4 shrink-0" />
            <span className="relative truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One question.
 *
 * Height is animated by framer here rather than by the CSS grid trick the plan
 * cards use, because unlike the saving pill this element genuinely goes from
 * absent to present: there is no server-rendered height to fight, and the
 * answer must be unmounted while closed so a closed row is never read out by a
 * screen reader or tabbed into.
 */
function FaqRow({
  delay,
  entry,
  onToggle,
  open,
  reduced,
}: {
  delay: number;
  entry: FaqEntry;
  onToggle: () => void;
  open: boolean;
  reduced: boolean | null;
}) {
  return (
    <motion.li
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "overflow-hidden rounded-2xl border bg-surface shadow-sm transition-colors",
        open ? "border-brand-teal/50" : "border-border hover:border-brand-teal/35",
      )}
      initial={{ opacity: 0, y: reduced ? 0 : 8 }}
      transition={{ delay, duration: reduced ? 0.12 : 0.35, ease: EASE }}
    >
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
        onClick={onToggle}
        type="button"
      >
        {/* The plus becomes a minus by rotating, so the open state is shown by
            a movement rather than by swapping one icon for another. */}
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
            open ? "bg-brand-teal text-white" : "bg-brand-teal/10 text-brand-teal",
          )}
        >
          <Plus
            className={cn("size-4 transition-transform duration-300", open && "rotate-45")}
          />
        </span>
        <span className="flex-1 text-sm font-semibold text-foreground">
          {entry.question}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-300",
            open && "rotate-180 text-brand-teal",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="overflow-hidden"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0.12 : 0.32, ease: EASE }}
          >
            <p className="px-5 pb-5 pl-[60px] text-sm leading-relaxed text-muted-foreground">
              {entry.answer}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.li>
  );
}

/**
 * The screen beside each group of answers. A plumber has no portal of their
 * own on the web, so providers see the dashboard the hostel sends jobs from.
 */
const PREVIEWS: Record<FaqRole, { image: Mockup; label: string }[]> = {
  hostel: [
    { image: MOCKUPS.wardenDashboard, label: "Dashboard" },
    { image: MOCKUPS.wardenTransactions, label: "Who has paid" },
  ],
  provider: [{ image: MOCKUPS.wardenDashboard, label: "Where hostels send jobs from" }],
  resident: [
    { image: MOCKUPS.residentFees, label: "Pay your rent" },
    { image: MOCKUPS.residentPortal, label: "Your room, menu and notices" },
  ],
};

/**
 * Screens of the product, swapped with the role tabs. The mockups carry no
 * backdrop of their own, so the soft brand wash behind them is the only frame.
 */
function FaqPreview({ reduced, role }: { reduced: boolean | null; role: FaqRole }) {
  const [primary, secondary] = PREVIEWS[role];

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-[26px] border border-border bg-gradient-to-br from-brand-teal/10 via-background to-background p-4 sm:p-6"
      initial={{ opacity: 0, y: reduced ? 0 : 12 }}
      key={role}
      transition={{ duration: reduced ? 0.12 : 0.4, ease: EASE }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {primary.label}
      </p>
      <Image
        alt={primary.image.alt}
        className="mt-2 h-auto w-full"
        height={primary.image.height}
        sizes="(min-width: 1024px) 520px, 100vw"
        src={primary.image.src}
        width={primary.image.width}
      />
      {secondary ? (
        <>
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {secondary.label}
          </p>
          <Image
            alt={secondary.image.alt}
            className="mt-2 h-auto w-full"
            height={secondary.image.height}
            sizes="(min-width: 1024px) 520px, 100vw"
            src={secondary.image.src}
            width={secondary.image.width}
          />
        </>
      ) : null}
    </motion.div>
  );
}
