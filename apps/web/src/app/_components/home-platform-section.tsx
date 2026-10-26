"use client";

import {
  ArrowRight,
  BedDouble,
  ChefHat,
  Receipt,
  Search,
  ShieldCheck,
  Smartphone,
  Store,
  Users,
  Utensils,
  Wallet,
  Wrench,
} from "@/components/icons";
import type { IconComponent } from "@/components/icons";
import Link from "next/link";

import { useSiteConfig } from "@/components/site-config-provider";

type Tile = { Icon: IconComponent; body: string; title: string };

/*
 * Words on this page are what search engines read as "what is HostelPalika",
 * and the home page used to say only "find a hostel". Every line below is
 * something the product does today (see seo.defaults.ts → software) — no
 * counts, ratings or prices. Written for the owner first: they are the buyer.
 */
const ROLES: Tile[] = [
  {
    Icon: Store,
    body: "Rent collected, dues, expenses, occupancy and every branch in one place — with a bank-style statement and running balance you can download.",
    title: "Hostel owner & admin",
  },
  {
    Icon: ShieldCheck,
    body: "Night status, who is out, complaints and maintenance requests — on a login that opens only the warden's own work.",
    title: "Warden",
  },
  {
    Icon: ChefHat,
    body: "The weekly menu and a food-ready alert for residents, so the kitchen stops running on shouted messages.",
    title: "Cook",
  },
  {
    Icon: Users,
    body: "Pays rent by eSewa or Khalti with the proof checked, gets a receipt and a running balance, marks night status and raises complaints.",
    title: "Resident",
  },
  {
    Icon: Smartphone,
    body: "A login linked only to their child: fees, notices and safety alerts, and nothing about anyone else.",
    title: "Parent & guardian",
  },
  {
    Icon: Wrench,
    body: "Verified repair workers receive the hostel's maintenance requests on the same platform.",
    title: "Service provider",
  },
];

const OWNER_BENEFITS: Tile[] = [
  {
    Icon: Receipt,
    body: "Invoices go out every Bikram Sambat month from your rent for each room type, and dues are followed up for you.",
    title: "Rent billed on its own",
  },
  {
    Icon: Wallet,
    body: "eSewa and Khalti screenshots are read and checked against the invoice; wallet statements are matched line by line.",
    title: "Payments checked, not guessed",
  },
  {
    Icon: BedDouble,
    body: "A room and bed map you allocate from, with vacant beds always current and residents already living with you brought in at the month they paid up to.",
    title: "Rooms, beds and residents",
  },
  {
    Icon: Utensils,
    body: "Food menus, night attendance, notices, complaints and maintenance — the whole daily routine in one account.",
    title: "Daily life, not just billing",
  },
  {
    Icon: Search,
    body: "Every live hostel gets a public page with photos, rooms, rent and reviews, a pin on the map, and a place in search and Compare.",
    title: "New residents find you",
  },
  {
    Icon: ShieldCheck,
    body: "Records download as CSV for Excel, personal profiles are encrypted, and each person sees only what their role allows.",
    title: "Your records stay yours",
  },
];

function TileGrid({ columns, tiles }: { columns: string; tiles: Tile[] }) {
  return (
    <div className={`mt-6 grid gap-4 ${columns}`}>
      {tiles.map(({ Icon, body, title }) => (
        <div className="rounded-2xl border border-border bg-card p-5" key={title}>
          <span className="flex size-10 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal">
            <Icon className="size-5" />
          </span>
          <h3 className="mt-4 text-sm font-extrabold text-foreground">{title}</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{body}</p>
        </div>
      ))}
    </div>
  );
}

export function HomePlatformSection() {
  const { siteName } = useSiteConfig().identity;

  return (
    <section className="bg-surface py-14">
      <div className="mx-auto max-w-[1448px] px-4 sm:px-6">
        <span className="text-xs font-bold uppercase tracking-wide text-brand-teal">
          What {siteName} is
        </span>
        <h2 className="mt-2 max-w-3xl font-heading text-3xl font-extrabold leading-tight text-foreground sm:text-4xl">
          The hostel management eco-software for Nepal
        </h2>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {siteName} has two sides on one platform. Students and parents search, compare and book
          verified boys, girls and co-living hostels. Hostels run on the same platform: owners,
          wardens, cooks, residents, parents and service providers each get their own screens, so
          the register book, the rent notebook, the spreadsheet and the WhatsApp group are replaced
          by one system built around the hostel&apos;s daily life — rooms, rent, food, attendance,
          safety, expenses and records.
        </p>

        <h3 className="mt-10 text-lg font-extrabold text-foreground">
          One platform, a seat for everyone in the hostel
        </h3>
        <TileGrid columns="sm:grid-cols-2 lg:grid-cols-3" tiles={ROLES} />

        <h3 className="mt-12 text-lg font-extrabold text-foreground">
          Built for the person who runs the hostel
        </h3>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Hostel owners spend the month chasing rent, checking screenshots and answering parents.
          {siteName} takes that work off the owner&apos;s desk.
        </p>
        <TileGrid columns="sm:grid-cols-2 lg:grid-cols-3" tiles={OWNER_BENEFITS} />

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-5 py-3 text-sm font-bold text-white transition hover:brightness-105"
            href="/hostel-management-software"
          >
            See the hostel management software <ArrowRight className="size-4" />
          </Link>
          <Link
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-sm font-bold text-foreground transition hover:bg-muted"
            href="/register-hostel"
          >
            List your hostel
          </Link>
          <Link
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-sm font-bold text-foreground transition hover:bg-muted"
            href="/plans-pricing"
          >
            Plans &amp; pricing
          </Link>
          <Link
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-sm font-bold text-foreground transition hover:bg-muted"
            href="/features"
          >
            All features
          </Link>
        </div>
      </div>
    </section>
  );
}
