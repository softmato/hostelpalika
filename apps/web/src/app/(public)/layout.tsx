import { InstallAppBanner } from "@/components/install-app-banner";
import { JsonLd } from "@/components/json-ld";
import { SiteAnnouncementBanner } from "@/components/site-announcement-banner";
import { SiteConfigProvider } from "@/components/site-config-provider";
import { organizationJsonLd, websiteJsonLd } from "@/lib/json-ld";
import { loadSiteConfig } from "@/lib/site-config-server";
import { DEFAULT_SITE_CONFIG } from "@/modules/platform-config/site-config.defaults";

/**
 * The owner's website configuration already comes from the root layout; this
 * group re-provides it only so the public tree stays correct if it is ever
 * rendered on its own, and adds the site-wide announcement banner.
 * Revalidated rather than static, so a save in the admin portal shows up
 * without a redeploy. Saves revalidate on demand (site-config route, setting
 * changes), so the window only covers data pages like /hostels; each expiry
 * bills ISR writes, and 600s blew the Hobby quota (233K/200K, 2026-09-22).
 * 2026-10-20: 6h, not 1h — each hourly re-render of /, /hostels/[slug] and the
 * city pages was half the project's CPU. Profile, rate and bed changes clear
 * it on demand (`revalidatePublicPages`).
 */
export const revalidate = 21600;

export default async function PublicLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const config = await loadSiteConfig();
  const alternateNames = config.seo.alternateNames;
  const { identity } = config;

  return (
    <SiteConfigProvider config={config}>
      {/*
       * Who runs the site, once per public page: the brand, its other spellings,
       * its parent company and where to reach it. The shipped support number is
       * left out until it is replaced with a real one — structured data is read
       * as a statement of fact.
       */}
      <JsonLd
        data={[
          organizationJsonLd({
            address: identity.address,
            alternateNames,
            email: identity.supportEmail,
            phone:
              identity.supportPhone === DEFAULT_SITE_CONFIG.identity.supportPhone
                ? ""
                : identity.supportPhone,
            // The product page on softmato.com ties this brand to a site Google
            // already trusts; the social links follow once they exist.
            sameAs: [
              "https://softmato.com/products/hostelpalika",
              ...Object.values(config.social).filter(Boolean),
            ],
            vendorLegalName: DEFAULT_SITE_CONFIG.issuer.legalName,
          }),
          websiteJsonLd(alternateNames),
        ]}
      />
      <SiteAnnouncementBanner />
      {children}
      <InstallAppBanner />
    </SiteConfigProvider>
  );
}
