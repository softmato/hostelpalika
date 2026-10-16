import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { InfoHeader, type InfoIcon } from "@/components/info-page";
import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSiteConfig } from "@/hooks/use-site-config";
import type { SiteIdentity } from "@/lib/site-config-api";
import { fillPlaceholders } from "@/lib/site-content";

/**
 * Contact Us — a port of `apps/web/src/app/_components/public-contact-page.tsx`.
 *
 * ## The support channels are tappable here, and that is the point
 *
 * The web prints the email and the phone number as text inside a card. On a
 * phone the number *is* the action: a support line you have to memorise and
 * retype into the dialler is a support line nobody calls. So each method card
 * that has a `tel:` or `mailto:` behind it becomes a pressable, and the two that
 * do not — the office address and the opening hours — stay flat. Same cards,
 * same order, same descriptions.
 *
 * A card whose detail is blank is dropped rather than drawn empty: every
 * identity field except the site name is optional in Website Config, and an
 * "Email" card with nothing under it tells the reader the platform has no
 * support email, which is not what a blank field means.
 *
 * ## The FAQ is the platform's, not this screen's
 *
 * The questions and answers come from Platform → Website Config → Page Content,
 * the same list `/contact` renders. Two answers name a control rather than a
 * fact and are rewritten below for this app's chrome — see `APP_ANSWERS`.
 */
type ContactMethod = {
  description: string;
  details: string[];
  href?: string;
  icon: InfoIcon;
  title: string;
};

const buildContactMethods = (identity: SiteIdentity): ContactMethod[] =>
  [
    {
      description: "We respond within 24 hours on business days.",
      details: [identity.supportEmail].filter(Boolean),
      href: identity.supportEmail ? `mailto:${identity.supportEmail}` : undefined,
      icon: "mail" as const,
      title: "Email",
    },
    {
      description: "Available Monday to Friday, 9 AM — 5 PM NPT.",
      details: [identity.supportPhone].filter(Boolean),
      href: identity.supportPhone
        ? `tel:${identity.supportPhone.replace(/\s/g, "")}`
        : undefined,
      icon: "call" as const,
      title: "Phone",
    },
    {
      description: "Walk-ins welcome during business hours.",
      details: [identity.address].filter(Boolean),
      icon: "location" as const,
      title: "Office",
    },
    {
      description: "Nepal Time (NPT, UTC+5:45).",
      details: ["Sunday — Friday: 9 AM — 5 PM", "Saturday: Closed"],
      icon: "time" as const,
      title: "Business Hours",
    },
  ].filter((method) => method.details.length > 0);

/**
 * Two of the platform's stored answers name a control rather than a fact — how
 * to create an account, how to list a hostel — and the stored wording describes
 * a web page ("Open Register Hostel and fill out the registration form"). Here
 * they name this app's own chrome instead. Keyed on the question rather than on
 * a position, so reordering the list in the admin panel cannot mis-target it,
 * and any question the platform adds later simply shows its stored answer.
 */
const APP_ANSWERS: Record<string, string> = {
  "How do I create an account?":
    "Open the Profile tab and choose Create account. Fill in your details, verify your email with the code we send, and you are ready to go.",
  "How do I list my hostel?":
    "Open the Profile tab and choose Register your hostel. Our team will review and verify your listing within 2–3 business days.",
};

function MethodCard({ description, details, href, icon, title }: ContactMethod) {
  const { colors } = useAppTheme();

  const body = (
    <Card className="gap-2">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-brand-soft">
        <Glyph color={colors.primary} name={icon} size={20} />
      </View>
      <Text variant="subtitle">{title}</Text>
      {details.map((detail) => (
        <Text className="text-sm font-medium text-primary" key={detail}>
          {detail}
        </Text>
      ))}
      <Text variant="caption">{description}</Text>
    </Card>
  );

  if (!href) {
    return body;
  }

  return (
    <Pressable
      accessibilityRole="button"
      className="active:opacity-70"
      onPress={() => void Linking.openURL(href)}
    >
      {body}
    </Pressable>
  );
}

/** The web's `<details>` element, which React Native has no equivalent of. */
function FaqRow({
  answer,
  onToggle,
  open,
  question,
}: {
  answer: string;
  onToggle: () => void;
  open: boolean;
  question: string;
}) {
  const { colors } = useAppTheme();

  return (
    <Card className="gap-0 p-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="flex-row items-center gap-3 p-4 active:opacity-70"
        onPress={onToggle}
      >
        <Glyph color={colors.primary} name="help-circle" size={18} />
        <Text className="flex-1" variant="label">
          {question}
        </Text>
        <Glyph
          color={colors.mutedForeground}
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
        />
      </Pressable>

      {open ? (
        <View className="border-t border-border px-4 py-3">
          <Text className="leading-6" variant="muted">
            {answer}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

export default function ContactScreen() {
  const { config, refresh, refreshing } = useSiteConfig();
  const { identity } = config;
  const faqs = config.content.faq.map((faq) => ({
    answer: fillPlaceholders(APP_ANSWERS[faq.question] ?? faq.answer, identity),
    question: fillPlaceholders(faq.question, identity),
  }));
  // The web opens the first question by default, so the accordion reads as an
  // accordion rather than as five inert rows.
  const [openFaq, setOpenFaq] = useState(0);

  return (
    <Screen
      header={<AppBar showBack title="Contact" />}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll
    >
      <View className="gap-8 pb-4">
        <InfoHeader
          icon="chatbubbles"
          subtitle={`We are here to help — get in touch with the ${identity.siteName} team`}
          title="Contact Us"
        />

        <View className="gap-3">
          {buildContactMethods(identity).map((method) => (
            <MethodCard key={method.title} {...method} />
          ))}
        </View>

        {/* Hidden rather than drawn as a heading over nothing, for the same
            reason `DocumentScreen` shows a fallback: the questions come from the
            platform, and a server that predates that section sends none. */}
        {faqs.length > 0 ? (
          <View className="gap-3">
            <Text variant="title">Frequently Asked Questions</Text>
            {faqs.map((faq, index) => (
              <FaqRow
                answer={faq.answer}
                key={faq.question}
                onToggle={() => setOpenFaq(openFaq === index ? -1 : index)}
                open={openFaq === index}
                question={faq.question}
              />
            ))}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
