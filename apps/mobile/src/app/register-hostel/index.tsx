import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { IntroHero } from "@/components/intro-hero";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adminQuery, prefetchAdminPortal } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { revalidateSession } from "@/lib/auth-session";
import { fetchQuery } from "@/lib/query-cache";
import { type HostelReferralPreview, previewHostelReferralCode, quickRegisterHostel } from "@/lib/registration-api";
import { toastError } from "@/lib/toast";

/**
 * Register your hostel — the web's `/register-hostel/form`, in the app
 * (docs/QUICK_SIGNUP_KYC_TRIAL.md): owner name, phone, hostel name and an
 * optional referral code on one form. The code is checked as it is typed and
 * who it is from eases in under the field, the same as the web.
 *
 * On success the account is a hostel admin. Instead of dropping the owner on a
 * portal of skeletons, "Setting up your portal" walks the real work — create,
 * rotate the token to the admin role, warm Home's reads (and the rest of the
 * portal behind them) — so Home paints from cache, where the congratulations
 * sheet is waiting.
 */

const SETUP = ["Creating your hostel", "Making you the owner", "Loading your portal", "Opening your portal"];

const LOGO = require("../../../assets/images/logo-mark.png");
const LOGO_LIGHT = require("../../../assets/images/logo-mark-light.png");

export default function RegisterHostelScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const params = useLocalSearchParams<{ ref?: string }>();
  const { colors } = useAppTheme();
  const [ownerName, setOwnerName] = useState(account?.name ?? "");
  const [phone, setPhone] = useState(account?.phone ?? "");
  const [hostelName, setHostelName] = useState("");
  const [code, setCode] = useState((params.ref ?? "").trim().toUpperCase());
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Who the typed referral code is from, once the server has checked it. */
  const [referrer, setReferrer] = useState<HostelReferralPreview | null>(null);
  const [codeError, setCodeError] = useState("");
  /** Index into `SETUP` while the portal is being set up; null on the form. */
  const [setup, setSetup] = useState<number | null>(null);
  const typed = code.trim();

  // Checked as it is typed, the same check (and pause) as the web form.
  useEffect(() => {
    if (typed.length < 4) return;

    let live = true;
    const timer = setTimeout(() => {
      previewHostelReferralCode(typed).then(
        (found) => live && setReferrer(found),
        (failure) => live && setCodeError(readApiError(failure)),
      );
    }, 450);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [typed]);

  const problems = {
    hostelName: hostelName.trim().length < 2 ? "Enter your hostel's name." : null,
    ownerName: ownerName.trim().length < 2 ? "Enter the owner's name." : null,
    phone: phone.replace(/\D/g, "").length < 7 ? "Enter a phone number." : null,
  };

  const submit = async () => {
    setTried(true);
    if (problems.ownerName || problems.phone || problems.hostelName) return;

    setSaving(true);

    if (typed && !referrer) {
      // Checked before the portal is made, so a typo is caught here and not silently dropped.
      try {
        setReferrer(await previewHostelReferralCode(typed));
      } catch (failure) {
        setCodeError(readApiError(failure));
        setSaving(false);
        return;
      }
    }

    setSetup(0);

    try {
      await quickRegisterHostel({
        hostelName: hostelName.trim(),
        ownerName: ownerName.trim(),
        phone: phone.trim(),
        ...(typed ? { referralCode: typed } : {}),
      });

      setSetup(1);
      // Rotates the token onto the admin role before any portal read.
      await revalidateSession();

      setSetup(2);
      prefetchAdminPortal();
      // Home's own reads; prefetchAdminPortal above already started them, so these join it.
      await Promise.allSettled(
        [adminQuery.overview(), adminQuery.subscription(), adminQuery.alerts()].map((query) =>
          fetchQuery(query.key, query.load as () => Promise<unknown>, query.topics),
        ),
      );

      setSetup(3);
      // Let the last step land before the screen changes.
      await new Promise((resolve) => setTimeout(resolve, 450));
      router.replace("/(admin)");
    } catch (failure) {
      setSetup(null);
      toastError("Not registered", readApiError(failure));
    } finally {
      setSaving(false);
    }
  };

  if (!account) {
    return (
      <Screen
        footer={
          <Button
            label="Sign in to start"
            onPress={() => router.push({ params: { next: "/register-hostel" }, pathname: "/(auth)/login" })}
          />
        }
        header={<AppBar showBack title="" />}
        scroll
      >
        <View className="pt-4">
          <IntroHero
            icon="business"
            line="Your portal opens on the account you sign in with."
            orbit={["bed", "wifi", "people"]}
            title="Open your hostel portal"
          />
        </View>
      </Screen>
    );
  }

  if (setup !== null) {
    return <PortalSetup active={setup} hostelName={hostelName.trim()} />;
  }

  return (
    <Screen
      footer={
        <Button
          disabled={Boolean(codeError)}
          label={saving ? "Opening your portal…" : "Open my hostel portal"}
          loading={saving}
          onPress={() => void submit()}
        />
      }
      header={<AppBar showBack title="" />}
      scroll
    >
      <View className="gap-6 pb-6">
        <View className="gap-1">
          <View className="mb-3 h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft">
            <Glyph color={colors.brand} name="business" size={24} />
          </View>
          <Text variant="title">Open your hostel portal</Text>
          <Text variant="muted">Rooms, photos and documents come later, in KYC.</Text>
        </View>

        <View className="gap-4">
          <Input
            autoCapitalize="words"
            autoComplete="name"
            error={tried ? problems.ownerName : null}
            label="Owner's name"
            onChangeText={setOwnerName}
            placeholder="Enter your full name"
            textContentType="name"
            value={ownerName}
          />

          <Input
            autoComplete="tel"
            error={tried ? problems.phone : null}
            keyboardType="phone-pad"
            label="Phone number"
            onChangeText={setPhone}
            placeholder="Enter your phone number"
            textContentType="telephoneNumber"
            value={phone}
          />

          <Input
            autoCapitalize="words"
            error={tried ? problems.hostelName : null}
            label="Hostel name"
            onChangeText={setHostelName}
            placeholder="Enter your hostel name"
            textContentType="organizationName"
            value={hostelName}
          />

          <View className="gap-1.5">
            <Input
              autoCapitalize="characters"
              autoCorrect={false}
              label="Referral code"
              onChangeText={(text) => {
                setCode(text.toUpperCase());
                setReferrer(null);
                setCodeError("");
              }}
              onSubmitEditing={() => void submit()}
              optional
              placeholder="Enter a referral code"
              returnKeyType="done"
              style={typed ? { letterSpacing: 2 } : undefined}
              tone={referrer ? "success" : codeError ? "danger" : undefined}
              trailing={
                referrer ? (
                  <Glyph color={colors.success} name="checkmark-circle" size={18} variant="solid" />
                ) : codeError ? (
                  <Glyph color={colors.destructive} name="alert-circle" size={18} />
                ) : null
              }
              value={code}
            />

            <Reveal open={Boolean(referrer)}>
              {referrer ? (
                <View className="gap-1 pt-1">
                  <ReferrerRow referrer={referrer} />
                  <Text className="text-success" variant="caption">
                    {referrer.rewardText
                      ? `Code accepted. Your plan gets ${referrer.rewardText} extra once your hostel goes live.`
                      : "Code accepted."}
                  </Text>
                </View>
              ) : null}
            </Reveal>
            <Reveal open={Boolean(codeError)}>
              <Text className="text-destructive" variant="caption">
                {codeError}
              </Text>
            </Reveal>
          </View>
        </View>
      </View>
    </Screen>
  );
}

/**
 * Eases its content in and out — the web's `Reveal`. Unmounting on close is
 * safe: the exit animates the last frame, so the panel shuts with its words in.
 */
function Reveal({ children, open }: { children: ReactNode; open: boolean }) {
  return open ? (
    <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
      {children}
    </Animated.View>
  ) : null;
}

/** Who a checked referral code is from — the web's `ReferrerRow`. */
function ReferrerRow({ referrer }: { referrer: HostelReferralPreview }) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row items-center gap-3 pb-1">
      {referrer.coverUrl ? (
        <Image contentFit="cover" source={{ uri: referrer.coverUrl }} style={{ borderRadius: 10, height: 56, width: 56 }} />
      ) : (
        <View className="h-14 w-14 items-center justify-center rounded-lg bg-muted">
          <Glyph color={colors.mutedForeground} name={referrer.kind === "HOSTEL" ? "business" : "ribbon"} size={22} />
        </View>
      )}
      <View className="flex-1">
        <Text variant="caption">{referrer.kind === "HOSTEL" ? "Referred by" : "Partner"}</Text>
        <Text className="text-base font-semibold text-foreground" numberOfLines={1} variant={null}>
          {referrer.from}
        </Text>
      </View>
    </View>
  );
}

/** The web's `BrandSpinner`: the HP mark breathing in a tinted tile, a ring turning round it. */
function BrandSpinner() {
  const { colors, isDark } = useAppTheme();
  const turn = useSharedValue(0);
  const breath = useSharedValue(1);

  useEffect(() => {
    turn.value = withRepeat(withTiming(360, { duration: 1100, easing: Easing.linear }), -1);
    breath.value = withRepeat(withTiming(0.5, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }), -1, true);
  }, [breath, turn]);

  const ring = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));
  const mark = useAnimatedStyle(() => ({ opacity: breath.value }));

  return (
    <View className="h-20 w-20 items-center justify-center rounded-2xl bg-brand-soft">
      <Animated.View style={mark}>
        <Image contentFit="contain" source={isDark ? LOGO_LIGHT : LOGO} style={{ height: 48, width: 48 }} />
      </Animated.View>
      <Animated.View
        style={[
          {
            borderColor: `${colors.brand}33`,
            borderRadius: 24,
            borderTopColor: colors.brand,
            borderWidth: 2,
            bottom: -10,
            left: -10,
            position: "absolute",
            right: -10,
            top: -10,
          },
          ring,
        ]}
      />
    </View>
  );
}

/** One step of the setup list: its circle and the line down to the next, easing green as it is passed. */
function SetupStep({ active, index, label }: { active: number; index: number; label: string }) {
  const { colors } = useAppTheme();
  const done = index < active;
  const current = index === active;
  const last = index === SETUP.length - 1;
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = current ? withRepeat(withTiming(0.4, { duration: 1000 }), -1, true) : 1;
  }, [current, pulse]);

  const circle = useAnimatedStyle(() => ({
    backgroundColor: withTiming(done ? colors.primary : colors.background, { duration: 300 }),
    borderColor: withTiming(done || current ? colors.primary : colors.border, { duration: 300 }),
  }));
  const line = useAnimatedStyle(() => ({
    backgroundColor: withTiming(done ? colors.primary : colors.border, { duration: 500 }),
  }));
  const dot = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View className={`flex-row gap-3 ${last ? "" : "pb-5"}`}>
      {last ? null : <Animated.View style={[{ bottom: 0, left: 11.5, position: "absolute", top: 24, width: 1 }, line]} />}
      <Animated.View className="h-6 w-6 items-center justify-center rounded-full" style={[{ borderWidth: 2 }, circle]}>
        {done ? (
          <Glyph color={colors.primaryForeground} name="checkmark" size={14} />
        ) : current ? (
          <Animated.View className="h-2 w-2 rounded-full bg-primary" style={dot} />
        ) : null}
      </Animated.View>
      <Text
        className={`pt-0.5 text-sm ${current ? "font-medium text-foreground" : done ? "text-foreground" : "text-muted-foreground"}`}
        variant={null}
      >
        {label}
      </Text>
    </View>
  );
}

/** "Setting up your portal" — the web's wait: the HP spinner and the four real steps, live. */
function PortalSetup({ active, hostelName }: { active: number; hostelName: string }) {
  return (
    <Screen>
      <Animated.View
        accessibilityLiveRegion="polite"
        className="flex-1 items-center justify-center px-6"
        entering={FadeIn.duration(200)}
      >
        <BrandSpinner />
        <Text className="mt-10 text-center" variant="title">
          Setting up your portal
        </Text>
        {hostelName ? (
          <Text className="mt-1 text-center" variant="muted">
            {hostelName}
          </Text>
        ) : null}

        <View className="mt-8 w-full" style={{ maxWidth: 320 }}>
          {SETUP.map((label, index) => (
            <SetupStep active={active} index={index} key={label} label={label} />
          ))}
        </View>
      </Animated.View>
    </Screen>
  );
}
