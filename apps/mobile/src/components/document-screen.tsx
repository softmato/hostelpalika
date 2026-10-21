import * as WebBrowser from "expo-web-browser";
import type { ReactNode } from "react";
import { View } from "react-native";

import {
  InfoActions,
  InfoHeader,
  InfoHighlights,
  InfoIntro,
  InfoNote,
  InfoSections,
  LegalBody,
  LinkedText,
  type InfoIcon,
  type SectionVariant,
} from "@/components/info-page";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { SkeletonText } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useSiteConfig } from "@/hooks/use-site-config";
import { API_BASE_URL } from "@/lib/api";
import type { SiteContent } from "@/lib/site-config-api";
import { fillPlaceholders, resolveContentPage } from "@/lib/site-content";

/**
 * One screen for every prose page the platform publishes.
 *
 * Privacy, Terms, About and the Resident Offer Program are the same document on
 * the phone: a masthead, an intro, a run of icon-headed sections, and a closing
 * note. The website draws them as four page components because each has its own
 * route file and its own extra furniture; here they have neither, so four route
 * files that each say `<DocumentScreen page="terms" …/>` is the whole difference
 * between them.
 *
 * The copy is not in this file and not in those four. It comes from
 * `content.<page>` in the site config — see `lib/site-config-api.ts`. That is
 * the point of the section: the app and the website render one document, and a
 * platform owner edits it in one place.
 *
 * **Every read of the config happens here.** The route files are declarations,
 * not fetchers — one `useSiteConfig()` per screen, or the same GET goes out
 * twice on every one of these screens. Which is why `title` is a template
 * string rather than an interpolated one: `"About {siteName}"` is substituted
 * from the config this component already holds, using the same placeholder
 * vocabulary as every other line of stored copy.
 */
export function DocumentScreen({
  /**
   * The thing this page exists to let someone do — "Start your registration",
   * "Apply as a service provider", the offer program's eligibility block.
   *
   * Rendered **directly under the masthead**, above every word of the copy. See
   * `InfoActions` for why: a partner landing page is read by two people, one who
   * wants the pitch and one who already had it, and only the first of them was
   * being served by a button below nine feature sections.
   *
   * Distinct from `extra`, which stays where it was — after the sections, before
   * the closing note — for anything that only makes sense once the page has been
   * read.
   */
  action,
  comingSoon,
  extra,
  icon,
  /**
   * Names the `legal` document backing this page, if it has one. That gives the
   * screen two things: the "Last updated" line, and the free-text body an owner
   * may have written under Platform → Config → Legal, which replaces the
   * structured sections outright — the same override the website honours.
   */
  legalDocument,
  media,
  page,
  sectionMedia,
  title,
  /** About draws its values as paragraphs; the rest are bulleted claims. */
  variant = "bullets",
  webPath,
}: {
  /** Rendered under the masthead, before the copy. */
  action?: ReactNode;
  /**
   * Replaces everything under `action` with this one quoted line — for a page
   * whose configured copy is not ready to show yet.
   */
  comingSoon?: string;
  /** Rendered between the sections and the closing note. */
  extra?: ReactNode;
  /**
   * The masthead's icon. Leave it out and the page has no masthead at all — for a
   * page whose `action` opens with its own picture and heading, where a second
   * title under the app bar's is the same words three times.
   */
  icon?: InfoIcon;
  legalDocument?: keyof MobileLegal;
  /** Pictures of the product, shown under the action and above the copy. */
  media?: ReactNode;
  page: Exclude<keyof SiteContent, "faq">;
  /** The picture inside each section, by position. */
  sectionMedia?: (index: number) => ReactNode;
  /** Where this document lives on the website, for the can't-load fallback. */
  webPath: string;
  /** Supports `{siteName}` and `{supportEmail}`, like all configured copy. */
  title: string;
  variant?: SectionVariant;
}) {
  const { config, error, loading, refresh, refreshing } = useSiteConfig();
  const { identity } = config;
  const resolved = resolveContentPage(config.content[page], identity);

  const legal = legalDocument ? config.legal[legalDocument] : null;
  const override = legal?.body.trim();
  const heading = fillPlaceholders(title, identity);

  /*
   * Nothing to draw.
   *
   * This is not a hypothetical: the copy lives in the site config, and a server
   * that predates that section simply does not send it. The phone updates
   * through an app store and the API through a deploy, so the two are routinely
   * a version apart — and a legal document that renders as a masthead over
   * white space tells the reader the platform has no privacy policy.
   *
   * The client deliberately does **not** carry its own copy of the text as a
   * fallback (see `FALLBACK_SITE_CONFIG`), because a stale second policy is
   * worse than a missing one. So it says what is true, and points at the
   * website, which always has the current document.
   */
  const isEmpty =
    !override && resolved.sections.length === 0 && resolved.intro.length === 0;
  const webUrl = `${API_BASE_URL.replace(/\/+$/, "")}/${webPath}`;

  return (
    <Screen
      header={<AppBar showBack title={heading} />}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll
    >
      {/*
        `gap-8`, down from `gap-10`. The sections fold now (see `InfoSections`),
        so the page is a list of headings rather than a run of essays, and the
        spacing that separated essays separates a list badly.
      */}
      <View className="gap-8 pb-4">
        {icon ? (
          <InfoHeader
            icon={icon}
            subtitle={
              legal ? `Last updated: ${legal.updatedAt || "July 11, 2026"}` : resolved.subtitle
            }
            title={heading}
          />
        ) : null}

        {/*
          Above the copy, and above the "could not load it" states as well: a
          registration button does not stop working because the platform has not
          shipped its page copy yet.
        */}
        {action ? <InfoActions>{action}</InfoActions> : null}

        {media}

        {comingSoon ? (
          <View className="border-l-2 border-primary py-1 pl-4">
            <Text className="italic leading-6" variant="muted">
              {comingSoon}
            </Text>
          </View>
        ) : (
          <DocumentBody
            error={error}
            extra={extra}
            isEmpty={isEmpty}
            loading={loading}
            override={override}
            refresh={refresh}
            resolved={resolved}
            sectionMedia={sectionMedia}
            variant={variant}
            webUrl={webUrl}
          />
        )}
      </View>
    </Screen>
  );
}

/** The configured copy under the masthead and action. */
function DocumentBody({
  error,
  extra,
  isEmpty,
  loading,
  override,
  refresh,
  resolved,
  sectionMedia,
  variant,
  webUrl,
}: {
  error: string | null | undefined;
  extra?: ReactNode;
  isEmpty: boolean;
  loading: boolean;
  override: string | undefined;
  refresh: () => void;
  resolved: ReturnType<typeof resolveContentPage>;
  sectionMedia?: (index: number) => ReactNode;
  variant: SectionVariant;
  webUrl: string;
}) {
  return (
    <>
        {isEmpty && loading ? (
          <View className="gap-6">
            <SkeletonText lines={4} />
            <SkeletonText lines={5} />
            <SkeletonText lines={3} />
          </View>
        ) : null}

        {isEmpty && !loading && error ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : null}

        {isEmpty && !loading && !error ? (
          <EmptyState icon="document-text"
            action={
              <Button
                label="Read it on the web"
                onPress={() => void WebBrowser.openBrowserAsync(webUrl)}
                variant="outline"
              />
            }
            description="This app could not load it from the platform. The website always has the current version."
            title="Not available here yet"
          />
        ) : null}

        {resolved.intro.length > 0 ? <InfoIntro paragraphs={resolved.intro} /> : null}

        {resolved.highlights.length > 0 ? (
          <InfoHighlights items={resolved.highlights} />
        ) : null}

        {override ? (
          <LegalBody body={override} />
        ) : (
          <InfoSections
            mediaFor={sectionMedia}
            sections={resolved.sections}
            variant={variant}
          />
        )}

        {extra}

        {resolved.noteBody ? (
          <InfoNote title={resolved.noteTitle}>
            <Text className="leading-6" variant="muted">
              <LinkedText>{resolved.noteBody}</LinkedText>
            </Text>
          </InfoNote>
        ) : null}
    </>
  );
}

type MobileLegal = ReturnType<typeof useSiteConfig>["config"]["legal"];
