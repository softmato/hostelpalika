/**
 * The platform owner's website configuration, as far as the phone needs it.
 *
 * `GET /public/site-config` returns the whole read-only projection —
 * announcement, hero, plans, legal and the rest. This app used to type only
 * `locations`, because the only screen reading it was the Popular Cities row on
 * the home page. That stopped being true when the website's header and footer
 * moved into the Profile tab: Pricing, Legal, Company and the contact block are
 * all owner-editable, and a phone that hardcodes them ships a second, silently
 * diverging copy of the marketing site.
 *
 * So the sections those screens render are typed here, and the rest is still
 * left to arrive and be ignored. `announcement`, `hero`, `stats`, `trustPoints`
 * and `facilities` have no reader on the phone — see `screens-show-data-not-
 * marketing`: the mobile home deliberately dropped the hero copy and the trust
 * tiles, so typing them would describe a payload nothing draws.
 *
 * `publicApi`, not `api`. The route takes no principal and the phone reads it
 * before anyone has signed in, so a 401 interceptor has no business on it.
 */

import type { PlansCatalog } from "@hostel/plans/catalog";

import { APP_NAME } from "@/constants/branding";
import { publicApi } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/**
 * One row of the superadmin's **Locations** page (Website Config → Locations).
 * The endpoint has already dropped the disabled ones — see `getPublicSiteConfig`
 * — so anything that arrives here is meant to be shown.
 */
export type SiteLocation = {
  areas: string[];
  city: string;
};

/**
 * One section of a prose page: an icon slug, a heading, and the claims under it.
 * Authored at Platform → Website Config → Page Content.
 */
export type ContentSection = {
  body: string[];
  icon: string;
  title: string;
};

/**
 * One prose page's copy, as the superadmin panel stores it.
 *
 * This is the whole point of the section: the website and this app render the
 * same privacy policy, the same terms, the same About values and the same FAQ,
 * from one document. Neither client owns the text, so neither can drift.
 *
 * `{siteName}` and `{supportEmail}` survive as placeholders — stored copy cannot
 * interpolate — and `lib/site-content.ts` substitutes them from `identity`.
 */
export type ContentPage = {
  /** Stat strip. Empty on the document pages, which have none. */
  highlights: { label: string; value: string }[];
  intro: string[];
  /** The bordered aside a page closes on. A blank body hides it. */
  noteBody: string;
  noteTitle: string;
  sections: ContentSection[];
  subtitle: string;
};

export type SiteContent = {
  about: ContentPage;
  faq: { answer: string; question: string }[];
  offerProgram: ContentPage;
  privacy: ContentPage;
  registerHostel: ContentPage;
  serviceProviders: ContentPage;
  terms: ContentPage;
};

/** Website Config → Site Identity. Every field but `siteName` may be blank. */
export type SiteIdentity = {
  address: string;
  siteName: string;
  supportEmail: string;
  supportPhone: string;
  tagline: string;
};

/**
 * Website Config → Features. The web header and footer hide a link when its
 * flag is off; the Profile tab does the same, because a surface the owner
 * switched off should not still be advertised on the phone.
 */
export type SiteFeatures = {
  compare: boolean;
  inquiries: boolean;
  publicRegistration: boolean;
  reviews: boolean;
  serviceProviderSignup: boolean;
};

/** One admin-authored legal document. `body` blank means "use the built-in text". */
export type SiteLegalDocument = {
  body: string;
  updatedAt: string;
};

export type SiteLegal = {
  privacy: SiteLegalDocument;
  terms: SiteLegalDocument;
};

/** Website Config → Social. A blank string means "not published". */
export type SiteSocial = {
  facebook: string;
  instagram: string;
  linkedin: string;
  tiktok: string;
  website: string;
  youtube: string;
};

/**
 * Website Config → Plans & Pricing: the whole catalogue, exactly as the website
 * gets it — the tiers with their monthly price and per-cycle discounts, the
 * modules, and every service under them.
 *
 * `PlansCatalog` is the shared shape the arithmetic in `@hostel/plans/catalog`
 * reads; `page` is the headings and closing pitch, which only a renderer needs.
 * This replaced a flat `pricing` array of pre-formatted strings — three cards of
 * free text with no service identity behind them, which meant the app's Pricing
 * screen and the website's were two different products described two different
 * ways from two different sections of the config.
 */
export type SitePlans = PlansCatalog & {
  page: {
    ctaBody: string;
    ctaHref: string;
    ctaLabel: string;
    ctaTitle: string;
    featuredBadge: string;
    footnote: string;
    subtitle: string;
    title: string;
  };
};

/**
 * Website Config → Site Content → QuestionCall: the student resident's row on
 * Home. `url` is https and sits in QuestionCall's `/app` web-app scope.
 */
export type SiteQuestionCall = {
  enabled: boolean;
  label: string;
  url: string;
};

export type MobileSiteConfig = {
  content: SiteContent;
  features: SiteFeatures;
  identity: SiteIdentity;
  legal: SiteLegal;
  locations: SiteLocation[];
  plans: SitePlans;
  questionCall: SiteQuestionCall;
  social: SiteSocial;
};

/** A page with nothing in it — see the `content` note in the fallback below. */
const EMPTY_PAGE: ContentPage = {
  highlights: [],
  intro: [],
  noteBody: "",
  noteTitle: "",
  sections: [],
  subtitle: "",
};

/**
 * What a screen renders when `/public/site-config` has not answered yet, or has
 * failed.
 *
 * The identity, feature and legal values are not invented: they are the shipped
 * defaults from `site-config.defaults.ts`, which is what the website itself
 * falls back to. A Profile tab that renders nothing until a network round-trip
 * completes is a blank menu on every cold start, and the alternative — optional
 * chaining at forty call sites — puts the fallback in the components instead of
 * here.
 *
 * `features` defaults to all-on, matching `featuresSchema`: an owner who has
 * never touched the page has every surface enabled.
 */
export const FALLBACK_SITE_CONFIG: MobileSiteConfig = {
  /*
   * Empty, and deliberately not a copy of the shipped documents.
   *
   * The server owns that text (`site-config.defaults.ts`), and duplicating it
   * here would recreate the exact problem this section exists to remove — a
   * second privacy policy, in the client, silently diverging. A screen that has
   * not heard back yet renders its masthead and nothing under it for one frame;
   * a screen that renders a stale copy of a legal document is worse.
   */
  content: {
    about: EMPTY_PAGE,
    faq: [],
    offerProgram: EMPTY_PAGE,
    privacy: EMPTY_PAGE,
    registerHostel: EMPTY_PAGE,
    serviceProviders: EMPTY_PAGE,
    terms: EMPTY_PAGE,
  },
  features: {
    compare: true,
    inquiries: true,
    publicRegistration: true,
    reviews: true,
    serviceProviderSignup: true,
  },
  identity: {
    address: "Kathmandu, Nepal",
    siteName: APP_NAME,
    supportEmail: "support@softmato.com",
    supportPhone: "",
    tagline: "",
  },
  legal: {
    privacy: { body: "", updatedAt: "" },
    terms: { body: "", updatedAt: "" },
  },
  locations: [],
  /*
   * Empty for the same reason `content` is: the tiers are entirely owner-
   * authored, and three invented plans printed next to a currency symbol is
   * fiction. The Pricing screen has a real loading and error state precisely so
   * it can say nothing until the server answers.
   */
  plans: {
    cycleLabels: { annual: "Annual", halfYearly: "6 months", monthly: "Monthly" },
    event: { endsOn: "", label: "", mode: "standard", note: "" },
    modules: [],
    page: {
      ctaBody: "",
      ctaHref: "/contact",
      ctaLabel: "",
      ctaTitle: "",
      featuredBadge: "Most chosen",
      footnote: "",
      subtitle: "",
      title: "Plans & Pricing",
    },
    plans: [],
    services: [],
  },
  /* The shipped defaults from `site-config.defaults.ts`. */
  questionCall: {
    enabled: true,
    label: "QuestionCall",
    url: "https://questioncall.com/app?install&from=hostelpalika",
  },
  social: {
    facebook: "",
    instagram: "",
    linkedin: "",
    tiktok: "",
    website: "",
    youtube: "",
  },
};

/**
 * The payload as it arrives — every section optional, because an older server
 * (or a projection that grows a section later) is not an error the phone should
 * turn into a blank screen.
 */
type SiteConfigResponse = Partial<MobileSiteConfig>;

/**
 * Fill in whatever the server did not send, section by section.
 *
 * Section-level rather than field-level on purpose: the server validates each
 * section against its own schema before serving it, so a section that arrives
 * is complete. What is worth guarding is a section that does not arrive at all.
 */
function withDefaults(config: SiteConfigResponse): MobileSiteConfig {
  return {
    content: { ...FALLBACK_SITE_CONFIG.content, ...config.content },
    features: { ...FALLBACK_SITE_CONFIG.features, ...config.features },
    identity: { ...FALLBACK_SITE_CONFIG.identity, ...config.identity },
    legal: {
      privacy: { ...FALLBACK_SITE_CONFIG.legal.privacy, ...config.legal?.privacy },
      terms: { ...FALLBACK_SITE_CONFIG.legal.terms, ...config.legal?.terms },
    },
    locations: config.locations ?? [],
    plans: config.plans ?? FALLBACK_SITE_CONFIG.plans,
    questionCall: { ...FALLBACK_SITE_CONFIG.questionCall, ...config.questionCall },
    social: { ...FALLBACK_SITE_CONFIG.social, ...config.social },
  };
}

export async function getSiteConfig() {
  const response = await publicApi.get<ApiEnvelope<{ config: SiteConfigResponse }>>(
    "/public/site-config",
  );

  return withDefaults(unwrap(response).config);
}
