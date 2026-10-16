import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { InquiryFields } from "@/components/inquiry-fields";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import {
  hasInquiryErrors,
  type InquiryErrors,
  normalizePhone,
  validateInquiry,
} from "@/lib/inquiry-form";
import { sendReferredInquiry } from "@/lib/public-api";
import { parseReferralLink } from "@/lib/referral-link";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * `hostelpalika://ref/<code>` — a resident's referral link.
 *
 * ## Cold start and warm start are both expo-router's job
 *
 * The file name *is* the deep-link handler. expo-router resolves
 * `hostelpalika://ref/ABC123` to this route whether the app was already running or
 * was launched by the tap, so there is no `getInitialURL`/`addEventListener`
 * pair to write and, more to the point, no cold-start case to forget.
 *
 * ## This is the only consumer of a referral link in the product
 *
 * `referral.service.ts` has been handing residents a `/inquiry?ref=<code>` link
 * to share, but the web's `/inquiry` page reads `hostel` and `room` and ignores
 * `ref` entirely — and nothing outside a test has ever called
 * `/public/inquiries/with-referral`. So every referral shared until now has been
 * dropped, and this screen is the first thing that credits one. Logged in
 * MOBILE_APP_PHASES.md §M6; the web page needs the same treatment.
 *
 * ## The hostel cannot be named
 *
 * The server resolves the code to `referralCode.hostelId` and files the inquiry
 * against *that* hostel. No public endpoint maps a code to a hostel, so the app
 * genuinely does not know which one this is. The copy therefore says "your
 * friend's hostel" rather than inventing a name — a screen that guessed and got
 * it wrong would send someone's details to the wrong place with confidence.
 */
export default function ReferralInquiryScreen() {
  const params = useLocalSearchParams<{ code: string }>();
  const account = useAppSelector((state) => state.auth.account);
  const { colors } = useAppTheme();

  // Through the same parser as a pasted link: the route param is usually a bare
  // code, but a malformed or over-long one must not be posted, and a link that
  // arrives with the query string attached still resolves.
  const code = parseReferralLink(params.code ?? "");

  const [draft, setDraft] = useState({
    email: account?.email ?? "",
    message: "",
    name: account?.name ?? "",
    phone: account?.phone ?? "",
  });
  const [errors, setErrors] = useState<InquiryErrors>({});
  const [busy, setBusy] = useState(false);

  const patch = useCallback((next: Partial<typeof draft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const submit = useCallback(async () => {
    if (!code) {
      return;
    }

    const found = validateInquiry(draft);

    setErrors(found);

    if (hasInquiryErrors(found)) {
      return;
    }

    setBusy(true);

    try {
      await sendReferredInquiry({
        email: draft.email.trim() || undefined,
        message: draft.message.trim() || undefined,
        name: draft.name.trim(),
        phone: normalizePhone(draft.phone),
        referralCode: code,
      });

      toastSuccess(
        "Inquiry sent",
        "The hostel will get back to you, and your friend gets the credit.",
      );

      // `back()` would return to whatever was underneath — and on a cold start
      // from the link there is nothing underneath at all.
      router.replace("/(browse)");
    } catch (caught) {
      toastError("Could not send that", readApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [code, draft]);

  if (!code) {
    return (
      <Screen header={<AppBar showBack title="Referral" />}>
        <Card className="gap-3">
          <Text variant="label">That referral link doesn&apos;t look right</Text>
          <Text variant="muted">
            Ask your friend to send it again, or browse hostels and message one
            directly — you can still do everything else from here.
          </Text>
          <Button
            label="Browse hostels"
            onPress={() => router.replace("/(browse)")}
            variant="outline"
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button label="Send inquiry" loading={busy} onPress={() => void submit()} />
      }
      header={<AppBar showBack title="You've been referred" />}
      scroll
    >
      <View className="gap-4 pt-1">
        <Card className="gap-3">
          <View className="flex-row items-center gap-2">
            <Glyph color={colors.primary} name="gift" size={18} />
            <Text variant="label">Referral code {code}</Text>
          </View>
          <Text variant="muted">
            A friend has referred you to their hostel. Send your details and the
            hostel will reply to you directly — it does not reserve a bed.
          </Text>
        </Card>

        <InquiryFields busy={busy} draft={draft} errors={errors} onChange={patch} />
      </View>
    </Screen>
  );
}
