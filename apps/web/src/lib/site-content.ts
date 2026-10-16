import {
  AlertTriangle,
  Ban,
  BadgeCheck,
  Bed,
  Bell,
  Building2,
  CreditCard,
  Database,
  Eye,
  FileText,
  Gift,
  Globe,
  Heart,
  Home,
  LayoutDashboard,
  Lock,
  Mail,
  MapPin,
  QrCode,
  Receipt,
  Scale,
  Shield,
  ShieldCheck,
  Sparkles,
  Target,
  UserCheck,
  UserPlus,
  UserRound,
  Users,
  Utensils,
  WalletCards,
  Wrench,
  type IconComponent,
} from "@/components/icons";

import type { PublicSiteConfig } from "@/modules/platform-config/site-config.service";
import type { ContentPage } from "@/modules/platform-config/site-config.validation";

/**
 * Reading page copy that lives in the site config rather than in a component.
 *
 * Two things have to happen between the database and the screen, and both of
 * them are here so the phone can mirror them exactly (`apps/mobile/src/lib/
 * site-content.ts` is the same two functions).
 */

type SiteIdentity = PublicSiteConfig["identity"];

/**
 * Stored copy cannot interpolate, so it carries `{siteName}` and
 * `{supportEmail}` and they are replaced here.
 *
 * `supportEmail` is optional in the config, and a sentence that renders
 * "Contact our Data Protection team at ." is worse than one that names no
 * address at all — so a blank falls back to a phrase rather than to nothing.
 */
export function fillPlaceholders(text: string, identity: SiteIdentity) {
  return text
    .replaceAll("{siteName}", identity.siteName)
    .replaceAll("{supportEmail}", identity.supportEmail || "our support team");
}

/**
 * The FAQ moved to Platform → Website Config → Page Content (`content.faq`),
 * because the app's Contact screen asks and answers the same five questions.
 *
 * Two of the stored answers name a control — how to create an account, how to
 * list a hostel — and each client rewrites those for its own chrome: the site
 * says "the Sign Up button on the top right corner of any page", the app says
 * "the Profile tab". The substitution is keyed on the question rather than on
 * an index so reordering the list in the admin panel cannot mis-target it.
 *
 * It lives here rather than in the Contact page so the page and its FAQPage
 * structured data print the same answers.
 */
const WEB_ANSWERS: Record<string, string> = {
  "How do I create an account?":
    "Click the Sign Up button on the top right corner of any page. Fill in your details, verify your email or phone via OTP, and you are ready to go.",
  "How do I list my hostel?":
    "Navigate to the Register Hostel page and fill out the registration form. Our team will review and verify your listing within 2–3 business days.",
};

/** The Contact page FAQ exactly as the website shows it. */
export function resolveWebFaq(
  faq: Array<{ answer: string; question: string }>,
  identity: SiteIdentity,
) {
  return faq.map((entry) => ({
    answer: fillPlaceholders(WEB_ANSWERS[entry.question] ?? entry.answer, identity),
    question: fillPlaceholders(entry.question, identity),
  }));
}

/** The same substitution across a whole page, so call sites read the plain text. */
export function resolveContentPage(page: ContentPage, identity: SiteIdentity) {
  const fill = (text: string) => fillPlaceholders(text, identity);

  return {
    highlights: page.highlights,
    intro: page.intro.map(fill),
    noteBody: fill(page.noteBody),
    noteTitle: fill(page.noteTitle),
    sections: page.sections.map((section) => ({
      body: section.body.map(fill),
      icon: section.icon,
      title: fill(section.title),
    })),
    subtitle: fill(page.subtitle),
  };
}

/**
 * Slug → icon. An editor types a name into a text field, so an unknown slug is
 * an ordinary typo and has to degrade rather than throw; `Sparkles` is the
 * schema's own default and the neutral choice.
 */
const CONTENT_ICONS: Record<string, IconComponent> = {
  "alert-triangle": AlertTriangle,
  "badge-check": BadgeCheck,
  ban: Ban,
  bed: Bed,
  bell: Bell,
  building: Building2,
  "credit-card": CreditCard,
  database: Database,
  eye: Eye,
  "file-text": FileText,
  gift: Gift,
  globe: Globe,
  heart: Heart,
  home: Home,
  "layout-dashboard": LayoutDashboard,
  lock: Lock,
  mail: Mail,
  "map-pin": MapPin,
  "qr-code": QrCode,
  receipt: Receipt,
  scale: Scale,
  shield: Shield,
  "shield-check": ShieldCheck,
  sparkles: Sparkles,
  target: Target,
  "user-check": UserCheck,
  "user-plus": UserPlus,
  "user-round": UserRound,
  users: Users,
  utensils: Utensils,
  wallet: WalletCards,
  wrench: Wrench,
};

export function contentIcon(slug: string): IconComponent {
  return CONTENT_ICONS[slug] ?? Sparkles;
}

/** Every slug the admin editor offers as a hint. Sorted for a stable list. */
export const CONTENT_ICON_SLUGS = Object.keys(CONTENT_ICONS).sort();
