import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import {
  geocodeHostelLocation,
  type GeocodeHit,
  requestHostelChange,
  updateManagedHostel,
} from "@/lib/admin-manage-api";
import { type AdminSettingsData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { formatMoney, humanizeEnum } from "@/lib/format";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";
import { PLATFORM_NAME } from "@hostel/brand/brand";

/**
 * Settings — the hostel itself, and the switches that change how it behaves.
 *
 * ## Which of these are admin-only, and why the screen does not hide them
 *
 * The profile edits want `editHostelProfile`; the community and attendance
 * switches, and every warden route, want `requireHostelAdminPrincipal` — a
 * *role*, not a grant, so no warden can be given them. Each block loads on its
 * own and a refused one says so where it stands, rather than the screen
 * pretending the hostel has no settings.
 *
 * ## Three fields are not editable here, on purpose
 *
 * After approval a hostel may rename itself a fixed number of times, and the
 * owner's own name and account email are never directly editable. All three go
 * through `POST profile/change-request` to the platform team. The rename counter
 * is shown rather than left to be discovered by typing, because the failure is a
 * 403 at save time and by then the person has retyped their sign.
 *
 * ## The location picker is a search box, not a map
 *
 * `profile/geocode` resolves a place name, a pasted Google Maps link or a raw
 * `lat,lng`. On a phone the pasted-link case is the *common* one — somebody
 * shares the hostel's pin over Viber and it arrives as `maps.app.goo.gl/…` —
 * which is exactly what the server-side resolver exists to handle, since a
 * client cannot follow that redirect.
 */

const HOSTEL_TYPE_OPTIONS = [
  { description: "Men only.", label: "Boys", value: "BOYS" },
  { description: "Women only.", label: "Girls", value: "GIRLS" },
  { description: "Open to everyone.", label: "Co-living", value: "CO_LIVING" },
] as const;

const CHANGE_TYPES = [
  {
    description: "Past the rename limit, or before approval is through.",
    label: "Hostel name",
    value: "HOSTEL_NAME",
  },
  { description: "The registered owner.", label: "Owner name", value: "OWNER_NAME" },
  {
    description: "The address the owner signs in with.",
    label: "Owner email",
    value: "OWNER_EMAIL",
  },
] as const;

type Panel =
  | "about"
  | "change"
  | "contact"
  | "facilities"
  | "gate"
  | "location"
  | "pricing"
  | "rules"
  | null;

/*
 * `SettingsData` and its loader are `adminQuery.settings()` — see
 * `lib/admin-queries.ts`.
 */

function toNumber(value: string) {
  const parsed = Number(value.trim());

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export default function ManageSettingsScreen() {
  const query = adminQuery.settings();
  const settings = useResource<AdminSettingsData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [panel, setPanel] = useState<Panel>(null);
  // `?panel=rules` — Hostel KYC opens the exact panel it is asking for.
  const { panel: linkedPanel } = useLocalSearchParams<{ panel?: Exclude<Panel, null> }>();
  const linkedOpened = useRef(false);
  const [saving, setSaving] = useState(false);
  // One draft object rather than a state per field: every panel below edits a
  // slice of the same hostel record, and a save sends only the keys it touched.
  const [form, setForm] = useState<Record<string, string>>({});
  const [listDraft, setListDraft] = useState<string[]>([]);
  const [listEntry, setListEntry] = useState("");
  const [changeType, setChangeType] = useState<"HOSTEL_NAME" | "OWNER_NAME" | "OWNER_EMAIL">(
    "HOSTEL_NAME",
  );
  const [geoQuery, setGeoQuery] = useState("");
  const [geoHits, setGeoHits] = useState<GeocodeHit[]>([]);
  const [geoBusy, setGeoBusy] = useState(false);

  const { colors } = useAppTheme();
  const hostel = settings.data?.hostel ?? null;
  const community = settings.data?.community ?? null;
  const attendance = settings.data?.attendance ?? null;

  const { setData } = settings;

  /*
   * Three of the saves on this screen do not re-ask the server afterwards, and
   * that is not an optimism: `updateManagedHostel`, `updateCommunitySettings`
   * and `updateAttendanceSettings` each answer with the object they just wrote,
   * which is the same object `loadSettings` would fetch back. Writing it
   * straight into the resource is the authoritative value arriving one round
   * trip earlier — `use-resource`'s `setData` files it to the cache too, so the
   * next screen reading `admin:settings` gets it as well.
   */

  const patch = useCallback(
    async (input: Parameters<typeof updateManagedHostel>[0], message: string) => {
      setSaving(true);

      try {
        const hostel = await updateManagedHostel(input);

        setData((current) => (current ? { ...current, hostel } : current));
        toastSuccess(message);
        setPanel(null);
      } catch (error) {
        toastError("Could not save", readApiError(error, "That did not save."));
      } finally {
        setSaving(false);
      }
    },
    [setData],
  );

  const openPanel = useCallback(
    (next: Panel) => {
      if (!hostel) {
        return;
      }

      if (next === "about") {
        setForm({
          description: hostel.description,
          hostelType: hostel.hostelType,
          name: hostel.name,
          panNumber: hostel.panNumber ?? "",
          totalFloors: String(hostel.totalFloors ?? 0),
        });
      }

      if (next === "gate") {
        setForm({
          note: hostel.arrivalGuide?.note ?? "",
          photoUrl: hostel.arrivalGuide?.photoUrl ?? "",
        });
      }

      if (next === "contact") {
        setForm({
          email: hostel.contact.email ?? "",
          phone: hostel.contact.phone ?? "",
        });
      }

      if (next === "location") {
        setForm({
          address: hostel.location.address ?? "",
          area: hostel.location.area ?? "",
          city: hostel.location.city ?? "",
          lat: hostel.location.lat ? String(hostel.location.lat) : "",
          lng: hostel.location.lng ? String(hostel.location.lng) : "",
          // Set to "MANUAL" only when a search hit is picked in this sheet.
          pinSource: "",
          province: hostel.location.province ?? "",
        });
        setGeoHits([]);
        setGeoQuery("");
      }

      if (next === "pricing") {
        setForm({
          admissionFee: hostel.pricing.admissionFee ? String(hostel.pricing.admissionFee) : "",
          monthlyRentMax: hostel.pricing.monthlyRentMax
            ? String(hostel.pricing.monthlyRentMax)
            : "",
          monthlyRentMin: hostel.pricing.monthlyRentMin
            ? String(hostel.pricing.monthlyRentMin)
            : "",
        });
      }

      if (next === "facilities") {
        setListDraft([...hostel.facilities]);
        setListEntry("");
      }

      if (next === "rules") {
        setListDraft([...hostel.rules]);
        setListEntry("");
      }

      if (next === "change") {
        setForm({ reason: "", requestedValue: "" });
      }

      setPanel(next);
    },
    [hostel],
  );

  useEffect(() => {
    if (hostel && linkedPanel && !linkedOpened.current) {
      linkedOpened.current = true;
      openPanel(linkedPanel);
    }
  }, [hostel, linkedPanel, openPanel]);

  const searchPlaces = useCallback(async () => {
    if (geoQuery.trim().length < 2) {
      return;
    }

    setGeoBusy(true);

    try {
      setGeoHits(await geocodeHostelLocation(geoQuery.trim()));
    } catch (error) {
      toastError("Could not look that up", readApiError(error));
    } finally {
      setGeoBusy(false);
    }
  }, [geoQuery]);

  const submitChangeRequest = useCallback(async () => {
    const requestedValue = form.requestedValue?.trim() ?? "";

    if (requestedValue.length < 2) {
      toastError("Say what it should be", "Two characters at least.");
      return;
    }

    setSaving(true);

    try {
      await requestHostelChange({
        changeType,
        reason: form.reason?.trim() || undefined,
        requestedValue,
      });
      toastSuccess("Sent to the platform team", "They will confirm by email.");
      setPanel(null);
    } catch (error) {
      toastError("Could not send it", readApiError(error));
    } finally {
      setSaving(false);
    }
  }, [changeType, form]);

  if (settings.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Settings" />}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (settings.error || !hostel) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Settings" />}>
        <ErrorState message={settings.error ?? "No hostel"} onRetry={settings.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      header={<AppBar accent centerTitle showBack subtitle={hostel.name} title="Settings" />}
      onRefresh={settings.refresh}
      refreshing={settings.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="gap-3">
          <View className="flex-row items-start gap-3">
            <View className="flex-1">
              <Text variant="subtitle">{hostel.name}</Text>
              <Text variant="caption">{`/${hostel.slug}`}</Text>
            </View>
          </View>

          <View className="flex-row flex-wrap gap-2">
            <Badge
              label={hostel.status === "PUBLISHED" ? "Published" : humanizeEnum(hostel.status)}
              tone={hostel.status === "PUBLISHED" ? "success" : "warning"}
            />
            <Badge
              label={
                hostel.verificationStatus === "VERIFIED" ? "Verified" : "Awaiting verification"
              }
              tone={hostel.verificationStatus === "VERIFIED" ? "success" : "warning"}
            />
            <Badge label={humanizeEnum(hostel.hostelType)} tone="info" />
          </View>

          {hostel.nameChangeCount > 0 ? (
            <Text variant="caption">
              {`Renamed ${hostel.nameChangeCount} time(s) since approval`}
            </Text>
          ) : null}
        </Card>

        <View>
          <SectionHeader subtitle="What the public listing says" title="The hostel" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="business"
              iconBgColor="#007AFF"
              onPress={() => openPanel("about")}
              subtitle={hostel.description ? "Name, description, type" : "No description yet"}
              title="About"
            />
            <RowDivider inset />
            <ListRow
              icon="call"
              iconBgColor="#34C759"
              onPress={() => openPanel("contact")}
              subtitle={hostel.contact.phone || "No phone on file"}
              title="Contact"
            />
            <RowDivider inset />
            <ListRow
              icon="location"
              iconBgColor="#FF3B30"
              onPress={() => openPanel("location")}
              subtitle={
                [hostel.location.area, hostel.location.city].filter(Boolean).join(", ") ||
                "Not set"
              }
              title="Location"
            />
            <RowDivider inset />
            <ListRow
              icon="cash"
              iconBgColor="#30D158"
              onPress={() => router.push("/manage/finance/rates")}
              subtitle={
                hostel.pricing.monthlyRentMin
                  ? `${formatMoney(hostel.pricing.monthlyRentMin)} – ${formatMoney(hostel.pricing.monthlyRentMax)}`
                  : "No price range set"
              }
              title="Pricing"
            />
            <RowDivider inset />
            <ListRow
              icon="sparkles"
              iconBgColor="#AF52DE"
              onPress={() => openPanel("facilities")}
              subtitle={`${hostel.facilities.length} listed`}
              title="Facilities"
            />
            <RowDivider inset />
            <ListRow
              icon="document-text"
              iconBgColor="#FF9500"
              onPress={() => openPanel("rules")}
              subtitle={`${hostel.rules.length} listed`}
              title="House rules"
            />
            <RowDivider inset />
            <ListRow
              icon="flag"
              iconBgColor="#0a8a4b"
              onPress={() => openPanel("gate")}
              subtitle={
                hostel.arrivalGuide
                  ? hostel.arrivalGuide.note || "Photo added"
                  : "How visitors spot your entrance"
              }
              title="Finding the gate"
            />
            <RowDivider inset />
            <ListRow
              icon="bed"
              iconBgColor="#5E5CE6"
              onPress={() => router.push("/manage/rooms")}
              subtitle={`${hostel.roomConfigurations.length} room type(s) · ${hostel.photos.length} photo(s)`}
              title="Rooms, beds and photos"
            />
          </Card>
        </View>

        <View>
          <SectionHeader subtitle="Who else runs this hostel" title="People" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="people"
              iconBgColor="#30B0C7"
              onPress={() => router.push("/manage/wardens")}
              subtitle="Invite, suspend and set what each one may do"
              title="Wardens"
            />
            <RowDivider inset />
            <ListRow
              icon="gift"
              iconBgColor="#FF2D55"
              onPress={() => router.push("/manage/referrals")}
              subtitle="Confirm who joined, and record the reward"
              title="Referrals"
            />
            <RowDivider inset />
            <ListRow
              icon="megaphone"
              iconBgColor="#34C759"
              onPress={() => router.push("/manage/invite-hostels")}
              subtitle="Your hostel's code for other hostels"
              title="Invite hostels"
            />
          </Card>
        </View>

        {/*
          Labels only: each row opens the screen that edits it, and its state is
          the subtitle (field review, 2026-10-27). Community and attendance are
          the owner's — a staff account gets `null` and simply has no row.
        */}
        <View>
          <SectionHeader subtitle="Hostel-wide behaviour" title="Switches" />
          <Card padding="px-4 py-1">
            {community ? (
              <>
                <ListRow
                  icon="chatbubbles"
                  iconBgColor="#30B0C7"
                  onPress={() => router.push("/manage/community-settings")}
                  subtitle={
                    community.enabled
                      ? `On · profanity filter ${community.profanityFilterEnabled ? "on" : "off"}`
                      : "Off"
                  }
                  title="Community"
                />
                <RowDivider inset />
              </>
            ) : null}
            <ListRow
              icon="document-text"
              iconBgColor="#FF9500"
              onPress={() => router.push("/manage/form-details")}
              subtitle="What the admission form asks for"
              title="Admission form"
            />
            {attendance ? (
              <>
                <RowDivider inset />
                <ListRow
                  icon="location"
                  iconBgColor="#FF3B30"
                  onPress={() => router.push("/manage/attendance-settings")}
                  subtitle={
                    attendance.enabled
                      ? `On · ${attendance.pingTimes.length} check-in(s) a day`
                      : "Off"
                  }
                  title="Attendance"
                />
                <RowDivider inset />
                <ListRow
                  icon="moon"
                  iconBgColor="#5E5CE6"
                  onPress={() => router.push("/manage/night-status-settings")}
                  subtitle={
                    attendance.nightStatus.promptEnabled
                      ? `Asking every night from ${attendance.nightStatus.promptTime}`
                      : "Off"
                  }
                  title="Night status"
                />
              </>
            ) : null}
          </Card>
        </View>

        <View>
          <SectionHeader
            subtitle="Locked fields go to the platform team"
            title="Ask for a change"
          />
          <Card padding="px-4 py-1">
            <ListRow
              icon="mail"
              iconBgColor="#8E8E93"
              onPress={() => openPanel("change")}
              subtitle="Hostel name past the limit, owner name, owner email"
              title="Request a change"
            />
          </Card>
        </View>

        {/* Owner only, like the community switches (docs/HOSTEL_LEAVE_PLATFORM.md). */}
        {community === null ? null : (
          <View>
            <SectionHeader title="Your data" />
            <Card padding="px-4 py-1">
              <ListRow
                icon="cloud-upload"
                iconBgColor={colors.brand}
                onPress={() => router.push("/manage/backup")}
                subtitle="Encrypted copy in your Google Drive"
                title="Backup"
              />
              <RowDivider inset />
              <ListRow
                icon="door"
                iconBgColor={colors.destructive}
                onPress={() => router.push("/manage/leave")}
                subtitle="Take your hostel off and get your data"
                title={`Leave ${PLATFORM_NAME}`}
              />
            </Card>
          </View>
        )}
      </View>

      {/* ------------------------------------------------------------------ */}
      {/*
        "Find the gate" — the map shows this within 200 m of the hostel and
        reads the note out on arrival. Kathmandu addresses stop a few lanes
        short; a landmark and a photo of the door do not.
      */}
      <Sheet
        footer={
          <Button
            label="Save"
            loading={saving}
            onPress={() =>
              void patch(
                { arrivalGuide: { note: form.note?.trim() ?? "", photoUrl: form.photoUrl ?? "" } },
                "Saved",
              )
            }
          />
        }
        onClose={() => setPanel(null)}
        open={panel === "gate"}
        title="Finding the gate"
      >
        <View className="gap-3 pb-2">
          <Input
            hint="Up to 240 characters. Say what a visitor sees, e.g. blue gate beside Bhatbhateni."
            label="How to spot it"
            maxLength={240}
            multiline
            onChangeText={(note) => setForm((prev) => ({ ...prev, note }))}
            style={{ height: 96 }}
            value={form.note ?? ""}
          />
          {form.photoUrl ? (
            <Image
              cachePolicy="memory-disk"
              contentFit="cover"
              source={{ uri: form.photoUrl }}
              style={{ borderRadius: 14, height: 160, width: "100%" }}
            />
          ) : null}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button
                label={form.photoUrl ? "Change photo" : "Add a photo of the gate"}
                loading={saving}
                onPress={() =>
                  void (async () => {
                    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

                    if (!permission.granted) {
                      toastError("Photo access needed", "Allow it to add the gate photo.");
                      return;
                    }

                    const picked = await ImagePicker.launchImageLibraryAsync({
                      mediaTypes: ["images"],
                      quality: 0.7,
                    });
                    const asset = picked.canceled ? null : picked.assets[0];

                    if (!asset) return;

                    try {
                      const uploaded = await uploadPublicFile(asset, {
                        label: "Gate photo",
                        visibility: "public",
                      });

                      setForm((prev) => ({ ...prev, photoUrl: uploaded.url }));
                    } catch (error) {
                      toastError("That photo didn't upload", readApiError(error));
                    }
                  })()
                }
                variant="outline"
              />
            </View>
            {form.photoUrl ? (
              <Button
                label="Remove"
                onPress={() => setForm((prev) => ({ ...prev, photoUrl: "" }))}
                variant="ghost"
              />
            ) : null}
          </View>
        </View>
      </Sheet>

      <Sheet
        footer={
          <Button
            label="Save"
            loading={saving}
            onPress={() =>
              void patch(
                {
                  description: form.description?.trim(),
                  hostelType: form.hostelType,
                  name: form.name?.trim(),
                  totalFloors: toNumber(form.totalFloors ?? "0"),
                  ...(!hostel?.panNumber && form.panNumber?.trim()
                    ? { panNumber: form.panNumber.replace(/\s/g, "") }
                    : {}),
                },
                "Saved",
              )
            }
          />
        }
        onClose={() => setPanel(null)}
        open={panel === "about"}
        title="About the hostel"
      >
        <View className="gap-3 pb-2">
          <Input
            hint={
              hostel.nameChangeCount > 0
                ? `Renamed ${hostel.nameChangeCount} time(s) already. Once the limit is reached this becomes a change request.`
                : undefined
            }
            label="Name"
            onChangeText={(name) => setForm((prev) => ({ ...prev, name }))}
            value={form.name ?? ""}
          />
          <Select
            label="Who it is for"
            onChange={(hostelType) => setForm((prev) => ({ ...prev, hostelType }))}
            options={HOSTEL_TYPE_OPTIONS}
            value={form.hostelType ?? null}
          />
          <Input
            hint="Up to 2000 characters. This is the first thing a visitor reads."
            label="Description"
            multiline
            onChangeText={(description) => setForm((prev) => ({ ...prev, description }))}
            style={{ height: 132 }}
            value={form.description ?? ""}
          />
          <Input
            hint="Descriptive only — rooms are a flat list, not grouped by floor."
            keyboardType="number-pad"
            label="Floors"
            onChangeText={(totalFloors) => setForm((prev) => ({ ...prev, totalFloors }))}
            value={form.totalFloors ?? ""}
          />
          <Input
            editable={!hostel?.panNumber}
            hint={
              hostel?.panNumber
                ? "Set once. To correct it, send a change request below."
                : "9 digits. It can be set once — branches have to match it."
            }
            keyboardType="number-pad"
            label="PAN/VAT number"
            maxLength={9}
            onChangeText={(panNumber) => setForm((prev) => ({ ...prev, panNumber }))}
            value={form.panNumber ?? ""}
          />
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          <Button
            label="Save"
            loading={saving}
            onPress={() =>
              void patch(
                {
                  contact: {
                    email: form.email?.trim() || undefined,
                    phone: form.phone?.trim() || undefined,
                  },
                },
                "Contact saved",
              )
            }
          />
        }
        onClose={() => setPanel(null)}
        open={panel === "contact"}
        title="Contact"
      >
        <View className="gap-3 pb-2">
          <Input
            hint="Shown on the public listing as a tap-to-call."
            keyboardType="phone-pad"
            label="Phone"
            onChangeText={(phone) => setForm((prev) => ({ ...prev, phone }))}
            value={form.phone ?? ""}
          />
          <Input
            autoCapitalize="none"
            hint="Kept private. Inbound mail goes through the inquiry form instead."
            keyboardType="email-address"
            label="Email"
            onChangeText={(email) => setForm((prev) => ({ ...prev, email }))}
            value={form.email ?? ""}
          />
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          <Button
            label="Save"
            loading={saving}
            onPress={() =>
              void patch(
                {
                  location: {
                    // Sent even when empty: the server merges location field by
                    // field, and an empty string is how a cleared one reaches it.
                    address: form.address?.trim() ?? "",
                    area: form.area?.trim() || undefined,
                    city: form.city?.trim() || undefined,
                    lat: form.lat ? Number(form.lat) : undefined,
                    lng: form.lng ? Number(form.lng) : undefined,
                    // A picked pin is the owner's choice: KYC counts only MANUAL
                    // pins, and the re-geocode after save leaves them in place.
                    ...(form.pinSource === "MANUAL" && form.lat && form.lng
                      ? { locationSource: "MANUAL" as const }
                      : {}),
                    province: form.province?.trim() ?? "",
                  },
                },
                "Location saved",
              )
            }
          />
        }
        onClose={() => setPanel(null)}
        open={panel === "location"}
        title="Location"
      >
        <View className="gap-3 pb-2">
          <Input
            hint="A place name, a pasted Google Maps link, or a raw lat,lng."
            label="Find it"
            onChangeText={setGeoQuery}
            onSubmitEditing={() => void searchPlaces()}
            placeholder="Baluwatar, Kathmandu"
            returnKeyType="search"
            value={geoQuery}
          />

          <Button
            label="Search"
            loading={geoBusy}
            onPress={() => void searchPlaces()}
            size="sm"
            variant="outline"
          />

          {geoHits.map((hit) => (
            <Pressable
              accessibilityRole="button"
              className="rounded-xl border border-border p-3 active:opacity-70"
              key={`${hit.lat},${hit.lng}`}
              onPress={() => {
                setForm((prev) => ({
                  ...prev,
                  address: hit.address ?? prev.address,
                  area: hit.area ?? prev.area,
                  city: hit.city ?? prev.city,
                  lat: String(hit.lat),
                  lng: String(hit.lng),
                  pinSource: "MANUAL",
                  province: hit.province ?? prev.province,
                }));
                setGeoHits([]);
              }}
            >
              <Text numberOfLines={2}>{hit.displayName ?? `${hit.lat}, ${hit.lng}`}</Text>
              <Text variant="caption">{`${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`}</Text>
            </Pressable>
          ))}

          <Input
            label="Area"
            onChangeText={(area) => setForm((prev) => ({ ...prev, area }))}
            value={form.area ?? ""}
          />
          <Input
            label="City"
            onChangeText={(city) => setForm((prev) => ({ ...prev, city }))}
            value={form.city ?? ""}
          />
          <Input
            label="Street address"
            onChangeText={(address) => setForm((prev) => ({ ...prev, address }))}
            value={form.address ?? ""}
          />
          <Input
            label="Province"
            onChangeText={(province) => setForm((prev) => ({ ...prev, province }))}
            value={form.province ?? ""}
          />

          <Text variant="caption">
            {form.lat && form.lng
              ? `Pinned at ${form.lat}, ${form.lng}. Saving re-checks what is nearby.`
              : "No pin yet — searching above sets one, and the listing map needs it."}
          </Text>
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          <Button
            label="Save"
            loading={saving}
            onPress={() =>
              void patch(
                {
                  pricing: {
                    admissionFee: form.admissionFee ? toNumber(form.admissionFee) : undefined,
                    monthlyRentMax: form.monthlyRentMax
                      ? toNumber(form.monthlyRentMax)
                      : undefined,
                    monthlyRentMin: form.monthlyRentMin
                      ? toNumber(form.monthlyRentMin)
                      : undefined,
                  },
                },
                "Pricing saved",
              )
            }
          />
        }
        onClose={() => setPanel(null)}
        open={panel === "pricing"}
        title="Pricing"
      >
        <View className="gap-3 pb-2">
          <Text variant="caption">{"Shown on your public listing."}</Text>
          <Input
            keyboardType="number-pad"
            label="Cheapest room (NPR)"
            onChangeText={(monthlyRentMin) => setForm((prev) => ({ ...prev, monthlyRentMin }))}
            value={form.monthlyRentMin ?? ""}
          />
          <Input
            keyboardType="number-pad"
            label="Dearest room (NPR)"
            onChangeText={(monthlyRentMax) => setForm((prev) => ({ ...prev, monthlyRentMax }))}
            value={form.monthlyRentMax ?? ""}
          />
          <Input
            keyboardType="number-pad"
            label="Admission fee (NPR)"
            onChangeText={(admissionFee) => setForm((prev) => ({ ...prev, admissionFee }))}
            value={form.admissionFee ?? ""}
          />

        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          <Button
            label="Save"
            loading={saving}
            onPress={() =>
              void patch(
                panel === "rules" ? { rules: listDraft } : { facilities: listDraft },
                panel === "rules" ? "Rules saved" : "Facilities saved",
              )
            }
          />
        }
        onClose={() => setPanel(null)}
        open={panel === "facilities" || panel === "rules"}
        title={panel === "rules" ? "House rules" : "Facilities"}
      >
        <View className="gap-3 pb-2">
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <Input
                label={panel === "rules" ? "Add a rule" : "Add a facility"}
                onChangeText={setListEntry}
                onSubmitEditing={() => {
                  const entry = listEntry.trim();

                  if (entry) {
                    setListDraft((prev) => [...prev, entry]);
                    setListEntry("");
                  }
                }}
                placeholder={panel === "rules" ? "No guests after 9pm" : "Hot water"}
                returnKeyType="done"
                value={listEntry}
              />
            </View>
            <Button
              label="Add"
              onPress={() => {
                const entry = listEntry.trim();

                if (entry) {
                  setListDraft((prev) => [...prev, entry]);
                  setListEntry("");
                }
              }}
            />
          </View>

          <View className="flex-row flex-wrap gap-2">
            {listDraft.map((entry, index) => (
              <Chip
                icon="close-circle"
                key={`${entry}-${index}`}
                label={entry}
                onPress={() =>
                  setListDraft((prev) => prev.filter((_, position) => position !== index))
                }
                tone="brand"
              />
            ))}
          </View>

          {listDraft.length === 0 ? (
            <Text variant="muted">Nothing listed yet.</Text>
          ) : (
            <Text variant="caption">Tap one to remove it.</Text>
          )}
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          <Button label="Send it" loading={saving} onPress={() => void submitChangeRequest()} />
        }
        onClose={() => setPanel(null)}
        open={panel === "change"}
        title="Request a change"
      >
        <View className="gap-3 pb-2">
          <Text variant="caption">{"Verified fields. The platform team confirms by email."}</Text>

          <Select
            label="What should change"
            onChange={setChangeType}
            options={CHANGE_TYPES}
            value={changeType}
          />

          <Input
            label="It should be"
            onChangeText={(requestedValue) => setForm((prev) => ({ ...prev, requestedValue }))}
            value={form.requestedValue ?? ""}
          />

          <Input
            hint="Optional, but it is what the reviewer reads first."
            label="Why"
            multiline
            onChangeText={(reason) => setForm((prev) => ({ ...prev, reason }))}
            style={{ height: 96 }}
            value={form.reason ?? ""}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

