import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { z } from "zod";

/**
 * Every editable slice of the public website. Each key is stored as its own
 * `PlatformSetting` document so a save only ever rewrites the section the admin
 * actually touched.
 */

const trimmed = z.string().trim();
const optionalUrl = trimmed.max(300).or(z.literal("")).default("");

export const identitySchema = z.object({
  address: trimmed.max(200).default(""),
  /** Pinned: the platform name is a code constant, not something a stored row can rename. */
  siteName: z.string().optional().transform((): string => PLATFORM_NAME),
  supportEmail: trimmed.email().or(z.literal("")).default(""),
  supportPhone: trimmed.max(40).default(""),
  tagline: trimmed.max(160).default(""),
});

/**
 * Who transactional email comes from (docs/EMAIL_SYSTEM.md §0).
 *
 * Every field is optional-with-a-blank-default on purpose: a blank falls back
 * to something sensible rather than sending mail from an empty address.
 * `senderName` falls back to the site name, `replyTo` to the support email,
 * and each mailbox to its shipped local-part. So the platform owner can leave
 * the whole section alone and still get correct, branded mail.
 *
 * `domain` is the one field with teeth. It must be a domain verified in Resend;
 * anything else is not a cosmetic mistake, it is every email bouncing. It is
 * editable here because a platform owner who moves off the shared Softmato
 * domain has nowhere else to say so, but the UI labels the risk.
 */
const mailbox = trimmed
  .max(40)
  .regex(
    /^$|^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i,
    "Use the part before the @ only — letters, digits, dot, dash, underscore.",
  )
  .default("");

export const emailSchema = z.object({
  alertMailbox: mailbox,
  billingMailbox: mailbox,
  domain: trimmed
    .max(120)
    .regex(
      /^$|^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i,
      "Enter a bare domain such as softmato.com — no @, protocol, or path.",
    )
    .default(""),
  infoMailbox: mailbox,
  noreplyMailbox: mailbox,
  replyTo: trimmed.email().or(z.literal("")).default(""),
  securityMailbox: mailbox,
  senderName: trimmed.max(60).default(""),
  supportMailbox: mailbox,
});

export const heroSchema = z.object({
  headline: trimmed.min(1).max(120),
  primaryCtaHref: trimmed.max(200).default("/hostels"),
  primaryCtaLabel: trimmed.max(40).default("Browse Hostels"),
  searchPlaceholder: trimmed.max(120).default("Search by city, area, or hostel name"),
  secondaryCtaHref: trimmed.max(200).default("/register-hostel"),
  secondaryCtaLabel: trimmed.max(40).default("List Your Hostel"),
  subheadline: trimmed.max(280).default(""),
});

export const statsSchema = z
  .array(
    z.object({
      label: trimmed.min(1).max(60),
      suffix: trimmed.max(10).default(""),
      value: trimmed.min(1).max(20),
    }),
  )
  .max(8);

export const trustPointsSchema = z
  .array(
    z.object({
      description: trimmed.max(240).default(""),
      icon: trimmed.max(40).default("shield"),
      title: trimmed.min(1).max(80),
    }),
  )
  .max(12);

export const locationsSchema = z
  .array(
    z.object({
      areas: z.array(trimmed.min(1).max(60)).max(60).default([]),
      city: trimmed.min(1).max(60),
      enabled: z.boolean().default(true),
    }),
  )
  .max(40);

export const facilitiesSchema = z
  .array(
    z.object({
      enabled: z.boolean().default(true),
      icon: trimmed.max(40).default("sparkles"),
      label: trimmed.min(1).max(60),
      slug: trimmed.min(1).max(60),
    }),
  )
  .max(60);

export const announcementSchema = z.object({
  enabled: z.boolean().default(false),
  link: optionalUrl,
  linkLabel: trimmed.max(40).default(""),
  message: trimmed.max(240).default(""),
  tone: z.enum(["info", "success", "warning"]).default("info"),
});

/**
 * Where the phone app comes from. The Play link is what Android visitors are
 * sent to; the APK is a direct download a superadmin uploads (R2, public
 * bucket) for phones that cannot reach the store. iOS has no app yet — the
 * website installs as a PWA instead.
 */
export const appsSchema = z.object({
  androidApkUrl: optionalUrl,
  androidPlayUrl: optionalUrl,
});

/**
 * The QuestionCall row on a student resident's home, web and app alike.
 *
 * `url` is where the row sends people: QuestionCall's installable web app. It
 * must stay inside that app's `/app` scope, because on Android a link into an
 * installed web app's scope opens the installed app rather than a tab. `?install`
 * is what makes QuestionCall's page offer its install sheet at once. Https only:
 * residents open this link, so the editor must not be able to hand them a
 * `javascript:` one.
 */
export const questionCallSchema = z.object({
  enabled: z.boolean().default(true),
  label: trimmed.min(1).max(40).default("QuestionCall"),
  url: trimmed
    .max(300)
    .url()
    .refine((value) => value.startsWith("https://"), "Use an https:// link.")
    .default("https://questioncall.com/app?install&from=hostelpalika"),
});

export const socialSchema = z.object({
  facebook: optionalUrl,
  instagram: optionalUrl,
  linkedin: optionalUrl,
  tiktok: optionalUrl,
  website: optionalUrl,
  youtube: optionalUrl,
});

/**
 * ## Page copy, as configuration
 *
 * Everything below used to be hardcoded in the page components — the privacy
 * sections in `public-privacy-page.tsx`, the terms in `public-terms-page.tsx`,
 * the values in `public-about-page.tsx`, the FAQ in `public-contact-page.tsx`,
 * and so on. That was survivable while the website was the only client.
 *
 * It stopped being survivable when the mobile app grew the same pages. Two
 * hardcoded copies of a privacy policy is two privacy policies, and the one the
 * user read is whichever client they happened to open. The platform cannot
 * state its own terms two ways.
 *
 * So the copy moved here: authored in Platform → Website Config → Page Content,
 * served by `/public/site-config`, rendered by both clients. The shipped text is
 * the **default value** of this section, not a fallback buried in a component —
 * which is what makes the admin page open pre-filled with the real document
 * instead of an empty textarea, and what makes "reset" mean something.
 *
 * ### Icons are slugs, not components
 *
 * A stored icon is a name like `shield` or `receipt`. The website maps it to a
 * lucide component and the app maps it to an Ionicons glyph, each with a
 * fallback for a slug it does not know. Neither client can store a React
 * component in Mongo, and a slug an editor typed wrong must degrade to a
 * generic icon rather than to a crash.
 *
 * ### `{siteName}` and `{supportEmail}` are substituted at render time
 *
 * The old copy interpolated those with template literals. Stored text cannot,
 * so the two braces survive as placeholders and each client replaces them from
 * the `identity` section. An owner who renames the platform renames it
 * everywhere, including in sentences they never edited.
 */
const contentSectionSchema = z.object({
  /** One paragraph per entry, rendered as a bulleted list. */
  body: z.array(trimmed.min(1).max(800)).max(24).default([]),
  icon: trimmed.max(40).default("sparkles"),
  title: trimmed.min(1).max(120),
});

/** A `label`/`value` pair — the stat strips on the two partner landing pages. */
const contentHighlightSchema = z.object({
  label: trimmed.min(1).max(60),
  value: trimmed.min(1).max(30),
});

const contentPageSchema = z.object({
  /** Stat strip. Empty on the document pages, which have none. */
  highlights: z.array(contentHighlightSchema).max(8).default([]),
  /** The paragraphs between the title and the first section. */
  intro: z.array(trimmed.min(1).max(1200)).max(6).default([]),
  sections: z.array(contentSectionSchema).max(24).default([]),
  /** The one line under the page title. */
  subtitle: trimmed.max(200).default(""),
  /** The bordered aside each page closes on. Blank body hides it. */
  noteBody: trimmed.max(1200).default(""),
  noteTitle: trimmed.max(160).default(""),
});

export const contentSchema = z.object({
  about: contentPageSchema,
  /** Shared by the website's Contact page and the app's Contact screen. */
  faq: z
    .array(
      z.object({
        answer: trimmed.min(1).max(1200),
        question: trimmed.min(1).max(200),
      }),
    )
    .max(20)
    .default([]),
  offerProgram: contentPageSchema,
  privacy: contentPageSchema,
  registerHostel: contentPageSchema,
  serviceProviders: contentPageSchema,
  terms: contentPageSchema,
});

export type ContentPage = z.infer<typeof contentPageSchema>;
export type ContentSection = z.infer<typeof contentSectionSchema>;

/**
 * `body` here is the **free-text override**: plain text with `#` headings and
 * `-` bullets, which replaces the structured sections in `content` entirely.
 * It exists for an owner whose lawyer hands them a document rather than a list
 * of claims. `updatedAt` is shown under the title either way.
 */
export const legalSchema = z.object({
  privacy: z.object({
    body: trimmed.max(20000).default(""),
    updatedAt: trimmed.max(40).default(""),
  }),
  terms: z.object({
    body: trimmed.max(20000).default(""),
    updatedAt: trimmed.max(40).default(""),
  }),
  /**
   * The booking refund policy (docs/BOOKINGS.md). Blank `body` renders the
   * shipped policy with the live booking terms filled in. Changing either field
   * changes the policy version, so a person part-way through a checkout is asked
   * to accept the new text before they can book.
   */
  refund: z
    .object({
      body: trimmed.max(20000).default(""),
      updatedAt: trimmed.max(40).default(""),
    })
    .default({ body: "", updatedAt: "" }),
});

/**
 * Who the plan invoice and the plan receipt are issued **by**.
 *
 * Not `identity`, and the distinction is the whole reason this is its own
 * section. `identity` is the *site*: the name in the header, the support
 * address in the footer, the tagline on the marketing page. This is the *legal
 * person* whose PAN goes on a tax document — the parent company — and the two
 * are only accidentally similar. HostelPalika is the product line printed in the
 * receipt's "For" row; Softmato Technology Private Limited is the entity that
 * received the money, and an accountant reconciling a payment needs the second
 * one.
 *
 * ## Every field prints, so every field is real
 *
 * The defaults are the parent company's actual registered details rather than
 * placeholders. `identity.supportEmail` already carries the note explaining
 * why — a plausible-looking address nobody owns survives review and then
 * bounces — and it is worse here: a wrong PAN on a document a hostel files
 * with its own accounts is a problem discovered by somebody else, months later.
 *
 * ## `vatRegistered` changes what the document asserts
 *
 * PAN-registered and VAT-registered are different registrations in Nepal, and
 * a document that charges no VAT has to say why. False prints the footnote the
 * supplied documents carry; true drops it, because a VAT-registered issuer
 * showing a line explaining that it charges none would be asserting something
 * untrue. There is no VAT arithmetic behind the flag on purpose — the day this
 * company registers, the rate and the breakdown are a change to the renderer,
 * not a number typed into a settings form.
 */
export const issuerSchema = z.object({
  address: trimmed.max(200).default(""),
  email: trimmed.email().or(z.literal("")).default(""),
  /** The registered name, exactly as it appears on the PAN certificate. */
  legalName: trimmed.min(1).max(120),
  pan: trimmed
    .max(20)
    .regex(/^$|^[0-9]{9}$/, "A Nepali PAN is nine digits.")
    .default(""),
  phone: trimmed.max(40).default(""),
  /** The receipt's "For" row — what the money bought, not who sold it. */
  productName: z.string().optional().transform((): string => PLATFORM_NAME),
  vatRegistered: z.boolean().default(false),
});

export const featuresSchema = z.object({
  compare: z.boolean().default(true),
  inquiries: z.boolean().default(true),
  publicRegistration: z.boolean().default(true),
  reviews: z.boolean().default(true),
  serviceProviderSignup: z.boolean().default(true),
});

/**
 * ## Plans & Pricing, as configuration
 *
 * The `/plans-pricing` page — its three tiers, the modules the product is sold
 * in, every service inside a module, and the what/how/why written for each one.
 *
 * This used to be two hardcoded files (`plans-catalog.ts` and
 * `plans-explainers.ts`), and the catalogue's own doc comment said what had to
 * happen when the owner needed to change a tier without a deploy: *the config
 * section grows to hold this shape — plans keyed by id, services keyed by slug*.
 * This is that section. The shipped catalogue is now its **default value**, so a
 * fresh database renders the same page it always did and the admin screen opens
 * pre-filled with the real thing rather than an empty form.
 *
 * It is deliberately not the older `pricing` section next door. That one is
 * three flat cards of free text serving `/pricing` and the app's Pricing screen;
 * nothing in it has a service identity, so nothing in it can be linked to,
 * compared across tiers, or given a detail page.
 *
 * ### Prices are set monthly, and the longer cycles are discounts off it
 *
 * A tier stores one price — `monthly` — plus a percentage off for each longer
 * commitment. The six-month and annual totals are *derived* from those, never
 * stored, which is what keeps the figure on the card and the "Save 17%" badge
 * beside it from ever disagreeing. An owner types the discount they mean to
 * advertise and the arithmetic follows.
 *
 * ### Icons are slugs, `{siteName}` is substituted
 *
 * Same two rules as `content` above, for the same two reasons: a React
 * component cannot be stored in Mongo, and a platform that renames itself must
 * rename itself in sentences nobody edited.
 */
const planListingTierSchema = z.object({
  label: trimmed.min(1).max(60),
  note: trimmed.max(240).default(""),
  slug: trimmed.min(1).max(60),
  /** The metal the directory badge is struck in — not a brand colour. */
  tone: z.enum(["gold", "platinum"]).default("platinum"),
});

/** `null` means "no ceiling", which is a different fact from a cap of zero. */
const cap = z.number().int().min(0).max(1_000_000).nullable().default(null);

const planTierSchema = z.object({
  /** Percent off twelve months bought one month at a time. */
  annualDiscountPercent: z.number().min(0).max(90).default(0),
  ctaHref: trimmed.max(200).default("/register-hostel"),
  ctaLabel: trimmed.min(1, "A plan's button needs a label.").max(40),
  description: trimmed.max(240).default(""),
  /** Percent off `monthly` while the catalogue is in event mode. Ignored in standard mode. */
  eventDiscountPercent: z.number().min(0).max(90).default(0),
  /** Branches a hostel on this plan may add, at no extra charge. 0 means none. */
  maxBranches: z.number().int().min(0).max(100).default(0),
  /** The highlighted card. One only — the admin screen enforces it. */
  featured: z.boolean().default(false),
  /**
   * Months a hostel runs on this plan free, from the day it goes live. Claimed
   * once per building (`FreePlanClaim`), never per account.
   */
  freeMonths: z.number().int().min(0).max(24).default(0),
  /** Percent off six months bought one month at a time. */
  halfYearlyDiscountPercent: z.number().min(0).max(90).default(0),
  id: trimmed.min(1).max(40),
  /** The badge this plan wears in the public directory. `null` on free tiers. */
  listingTier: planListingTierSchema.nullable().default(null),
  /**
   * Never authored and never saved — `sellingCatalog` stamps it on the way out
   * of the public projection so a card can strike through the pre-event price.
   * It is declared here only because this schema is also the wire type.
   */
  listMonthly: z.number().min(0).max(10_000_000).optional(),
  maxResidents: cap,
  /** Rupees per month when billed monthly. Every other figure derives from it. */
  monthly: z.number().min(0).max(10_000_000).default(0),
  name: trimmed.min(1, "Every plan needs a name.").max(40),
  /** Staff seats. Residents are absent: their ceiling is `maxResidents`. */
  portalAccess: z
    .object({ cooks: cap, wardens: cap })
    .default({ cooks: null, wardens: null }),
});

const planModuleSchema = z.object({
  description: trimmed.max(240).default(""),
  icon: trimmed.max(40).default("sparkles"),
  id: trimmed.min(1).max(60),
  name: trimmed.min(1, "Every module needs a name.").max(80),
});

/**
 * A written section. Blank paragraphs are dropped rather than refused: the
 * admin screen adds an empty one when the owner clicks "Add paragraph", and
 * saving before they type into it should lose the empty box, not the save.
 */
const prose = z
  .array(trimmed.max(1200))
  .max(12)
  .default([])
  .transform((paragraphs) => paragraphs.filter(Boolean));

const planServiceSchema = z.object({
  /** Who touches this day to day. Shown on the detail page, not on the cards. */
  audience: z.array(trimmed.min(1).max(40)).max(8).default([]),
  /** One line, sentence case. What it does — not why it is wonderful. */
  blurb: trimmed.max(300).default(""),
  /**
   * The walkthrough, one clip per surface: a landscape one for the website and
   * a portrait one for the phone. `FileAsset` ids, uploaded PUBLIC, so the
   * detail page can play them without a signed URL. Blank means the page keeps
   * its "a walkthrough goes here" frame rather than showing a dead player.
   */
  demo: z
    .object({
      mobileAssetId: trimmed.max(60).default(""),
      webAssetId: trimmed.max(60).default(""),
    })
    .default({ mobileAssetId: "", webAssetId: "" }),
  how: prose,
  module: trimmed.min(1).max(60),
  name: trimmed.min(1, "Every service needs a name.").max(80),
  /** The lowest plan that carries it. Every plan above carries it too. */
  plan: trimmed.min(1).max(40),
  slug: trimmed.min(1).max(80),
  what: prose,
  why: prose,
});

export const plansSchema = z.object({
  /** What the billing toggle calls each cycle. */
  cycleLabels: z
    .object({
      annual: trimmed.min(1).max(30).default("Annual"),
      halfYearly: trimmed.min(1).max(30).default("6 months"),
      monthly: trimmed.min(1).max(30).default("Monthly"),
    })
    .default({ annual: "Annual", halfYearly: "6 months", monthly: "Monthly" }),
  /**
   * The mode switch. `standard` is the catalogue exactly as it has always been
   * — nothing below this field is read. `event` runs a dated sale on top of the
   * same prices; see `PlanEventLike` in the shared catalogue for what it does
   * to the arithmetic. Switching back to `standard` restores the standard
   * prices untouched, because an event never edits them.
   */
  event: z
    .object({
      /** BS period key, inclusive — the offer stops at the end of this month. */
      endsOn: trimmed
        .regex(/^\d{4}-\d{2}$/, "Use a Bikram Sambat month, like 2083-06.")
        .or(z.literal(""))
        .default(""),
      label: trimmed.max(40).default("Festival offer"),
      mode: z.enum(["standard", "event"]).default("standard"),
      note: trimmed.max(200).default(""),
    })
    .default({ endsOn: "", label: "Festival offer", mode: "standard", note: "" }),
  modules: z.array(planModuleSchema).max(24).default([]),
  /** The page's own headings and closing call to action. */
  page: z
    .object({
      ctaBody: trimmed.max(400).default(""),
      ctaHref: trimmed.max(200).default("/contact"),
      ctaLabel: trimmed.max(60).default("Talk to us"),
      ctaTitle: trimmed.max(120).default(""),
      featuredBadge: trimmed.max(30).default("Most chosen"),
      footnote: trimmed.max(400).default(""),
      subtitle: trimmed.max(300).default(""),
      title: trimmed.min(1).max(80).default("Plans & Pricing"),
    })
    .default({
      ctaBody: "",
      ctaHref: "/contact",
      ctaLabel: "Talk to us",
      ctaTitle: "",
      featuredBadge: "Most chosen",
      footnote: "",
      subtitle: "",
      title: "Plans & Pricing",
    }),
  /** Cheapest first. Card order and "everything in X" chaining both follow it. */
  plans: z.array(planTierSchema).max(6).default([]),
  services: z.array(planServiceSchema).max(200).default([]),
});

/**
 * ## Search, as configuration
 *
 * What Google shows for each page — its title and description — plus the words
 * the marketing pages are written around. A marketing owner changes a title
 * after reading Search Console, not after waiting for a deploy.
 *
 * ### Blank means "the shipped text"
 *
 * Every page's title and description default to blank here, and the public page
 * falls back to the shipped value in `seo.defaults.ts` for any field left empty.
 * So a stored row written before a page existed still gives that page a real
 * title, and clearing a field can never publish an empty `<title>`.
 *
 * `{siteName}` and `{fromPrice}` (the cheapest plan's monthly price) are
 * substituted when the page renders, so a price change cannot leave a stale
 * number sitting in a title.
 */
export const SEO_PAGE_KEYS = [
  "home",
  "hostels",
  "map",
  "compare",
  "community",
  "software",
  "features",
  "plansPricing",
  "registerHostel",
  "serviceProviders",
  "offerProgram",
  "about",
  "contact",
  "privacy",
  "terms",
  "refundPolicy",
  "howBookingWorks",
  "login",
  "signup",
] as const;

export type SeoPageKey = (typeof SEO_PAGE_KEYS)[number];

const seoPageSchema = z
  .object({
    description: trimmed.max(220).default(""),
    title: trimmed.max(80).default(""),
  })
  .default({ description: "", title: "" });

const seoFaqSchema = z.object({
  answer: trimmed.min(1).max(1200),
  question: trimmed.min(1).max(200),
});

const seoParagraphs = (max: number) => z.array(trimmed.min(1).max(1200)).max(max).default([]);

const seoSlug = trimmed
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and dashes.");

/** A `/features/[module]` page: one plan module, named the way owners search for it. */
const seoModulePageSchema = z.object({
  description: trimmed.max(220).default(""),
  /** The H1 and the title — "Hostel Fee Collection & Billing Software", not "Fees & Payments". */
  headline: trimmed.min(1).max(80),
  intro: seoParagraphs(4),
  /** `plans.modules[].id`. A page whose module was removed from the catalogue is a 404. */
  moduleId: trimmed.min(1).max(60),
  slug: seoSlug,
});

/**
 * A `/vs/[slug]` page. `stayWith` is the part that makes it believable: every
 * honest comparison says when the other option is the right call.
 */
const seoComparisonSchema = z.object({
  description: trimmed.max(220).default(""),
  faq: z.array(seoFaqSchema).max(8).default([]),
  intro: seoParagraphs(4),
  /** What we are compared with, as the reader calls it: "Excel & Google Sheets". */
  name: trimmed.min(1).max(60),
  rows: z
    .array(
      z.object({
        label: trimmed.min(1).max(80),
        them: trimmed.min(1).max(240),
        us: trimmed.min(1).max(240),
      }),
    )
    .max(20)
    .default([]),
  slug: seoSlug,
  stayWith: z.array(trimmed.min(1).max(400)).max(6).default([]),
  title: trimmed.max(80).default(""),
});

export const seoSchema = z.object({
  comparisons: z.array(seoComparisonSchema).max(12).default([]),
  /** Other ways people write the brand — declared as `alternateName` in structured data. */
  alternateNames: z.array(trimmed.min(1).max(60)).max(12).default([]),
  keywords: z.array(trimmed.min(1).max(80)).max(40).default([]),
  modulePages: z.array(seoModulePageSchema).max(24).default([]),
  pages: z
    .object(
      Object.fromEntries(SEO_PAGE_KEYS.map((key) => [key, seoPageSchema])) as Record<
        SeoPageKey,
        typeof seoPageSchema
      >,
    )
    .default(
      Object.fromEntries(
        SEO_PAGE_KEYS.map((key) => [key, { description: "", title: "" }]),
      ) as Record<SeoPageKey, { description: string; title: string }>,
    ),
  /**
   * The `/hostel-management-software` page. `faq` is where an owner's doubts get
   * answered before they have to ask; `steps` is the whole onboarding, in order.
   */
  software: z
    .object({
      faq: z.array(seoFaqSchema).max(24).default([]),
      headline: trimmed.max(100).default(""),
      intro: seoParagraphs(4),
      sections: z.array(contentSectionSchema).max(12).default([]),
      steps: z
        .array(z.object({ body: trimmed.min(1).max(400), title: trimmed.min(1).max(80) }))
        .max(8)
        .default([]),
      subtitle: trimmed.max(300).default(""),
    })
    .default({ faq: [], headline: "", intro: [], sections: [], steps: [], subtitle: "" }),
  /** The HTML-tag codes from Google Search Console and Bing Webmaster Tools. */
  verification: z
    .object({
      bing: trimmed.max(120).default(""),
      google: trimmed.max(120).default(""),
    })
    .default({ bing: "", google: "" }),
});

export type SeoConfig = z.infer<typeof seoSchema>;
export type SeoComparison = z.infer<typeof seoComparisonSchema>;
export type SeoModulePage = z.infer<typeof seoModulePageSchema>;

export type PlanListingTier = z.infer<typeof planListingTierSchema>;
export type PlanModule = z.infer<typeof planModuleSchema>;
export type PlanService = z.infer<typeof planServiceSchema>;
export type PlanTier = z.infer<typeof planTierSchema>;
export type PlansConfig = z.infer<typeof plansSchema>;

export const siteConfigSectionSchemas = {
  announcement: announcementSchema,
  apps: appsSchema,
  content: contentSchema,
  email: emailSchema,
  facilities: facilitiesSchema,
  features: featuresSchema,
  hero: heroSchema,
  identity: identitySchema,
  issuer: issuerSchema,
  legal: legalSchema,
  locations: locationsSchema,
  plans: plansSchema,
  questionCall: questionCallSchema,
  seo: seoSchema,
  social: socialSchema,
  stats: statsSchema,
  trustPoints: trustPointsSchema,
} as const;

export type SiteConfigSection = keyof typeof siteConfigSectionSchemas;

export const SITE_CONFIG_SECTIONS = Object.keys(
  siteConfigSectionSchemas,
) as SiteConfigSection[];

export function isSiteConfigSection(value: string): value is SiteConfigSection {
  return (SITE_CONFIG_SECTIONS as string[]).includes(value);
}

export type SiteConfig = {
  [Section in SiteConfigSection]: z.infer<(typeof siteConfigSectionSchemas)[Section]>;
};
