import type { Metadata } from "next";
import { Geist, Geist_Mono, Open_Sans } from "next/font/google";

import {
  PLATFORM_NAME,
  PLATFORM_VENDOR,
  PLATFORM_VENDOR_URL,
} from "@hostel/shared/brand/brand";

import { MediaViewerProvider } from "@/components/media-viewer";
import { NotificationSoundListener } from "@/components/notification-sound-listener";
import { QueryProvider } from "@/components/query-provider";
import { SiteConfigProvider } from "@/components/site-config-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { ResidencyInvitePrompt } from "@/components/residency-invite-prompt";
import { Toaster } from "@/components/toaster";
import { SEO_LOCALE } from "@/lib/seo";
import { loadSeo, resolveSeoPage } from "@/lib/seo-config";
import { siteUrl } from "@/lib/site";
import { loadSiteConfig } from "@/lib/site-config-server";

import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const openSans = Open_Sans({
  subsets: ["latin"],
  variable: "--font-open-sans",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Site-wide defaults every page starts from. Pages replace the title,
 * description, canonical and card through `pageMetadata`; what stays from here
 * is the brand, the publisher, the crawler directives and the verification tags
 * pasted into Website Config → SEO.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { fill, seo } = await loadSeo();
  const home = resolveSeoPage(seo, "home", fill);

  return {
    applicationName: PLATFORM_NAME,
    // iPhone has no App Store build yet: Add to Home Screen opens the site
    // full screen, with its own name under the icon.
    appleWebApp: { capable: true, statusBarStyle: "default", title: PLATFORM_NAME },
    authors: [{ name: PLATFORM_VENDOR, url: PLATFORM_VENDOR_URL }],
    category: "business",
    creator: PLATFORM_VENDOR,
    description: home.description,
    keywords: seo.keywords,
    metadataBase: new URL(siteUrl()),
    openGraph: {
      description: home.description,
      images: [{ alt: PLATFORM_NAME, height: 630, url: "/og", width: 1200 }],
      locale: SEO_LOCALE,
      siteName: PLATFORM_NAME,
      title: home.title,
      type: "website",
    },
    publisher: PLATFORM_VENDOR,
    robots: {
      follow: true,
      googleBot: {
        follow: true,
        index: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
      index: true,
    },
    title: {
      default: home.title,
      template: `%s · ${PLATFORM_NAME}`,
    },
    twitter: {
      card: "summary_large_image",
      description: home.description,
      images: ["/og"],
      title: home.title,
    },
    verification: {
      google: seo.verification.google || undefined,
      other: seo.verification.bing ? { "msvalidate.01": seo.verification.bing } : undefined,
    },
  };
}

/*
 * The same window the public layout uses, for every route under this one. A
 * portal page that is otherwise static — `/team/register` is — was prerendered
 * once at build and kept that build's site config until the next deploy, so a
 * plan repriced in Website Config never reached the agent's plan picker.
 */
export const revalidate = 21600;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Loaded here rather than per route group so portals, auth screens, and the
  // marketing site all read branding from the same admin-owned source.
  const siteConfig = await loadSiteConfig();

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${openSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <QueryProvider>
            <SiteConfigProvider config={siteConfig}>
              {/* Any screen can open images or videos full-screen from here. */}
              <MediaViewerProvider>{children}</MediaViewerProvider>
            </SiteConfigProvider>
          </QueryProvider>
          {/* Global feedback surface: live upload progress + one-shot toasts. */}
          <Toaster />
          {/* Plays our tone for a push when a tab is open to play it. */}
          <NotificationSoundListener />
          {/* "Your hostel added you as a resident" — asked once, on any page. */}
          <ResidencyInvitePrompt />
        </ThemeProvider>
      </body>
    </html>
  );
}
