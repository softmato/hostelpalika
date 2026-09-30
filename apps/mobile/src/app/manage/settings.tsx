import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { CalendarPreferenceCard } from "@/components/calendar-preference";
import { NightStatusPromptCard } from "@/components/night-status-prompt-card";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import {
  type AttendanceSettings,
  type CommunitySettings,
  geocodeHostelLocation,
  type GeocodeHit,
  requestHostelChange,
  updateAttendanceSettings,
  updateCommunitySettings,
  updateManagedHostel,
} from "@/lib/admin-manage-api";
import { type AdminSettingsData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { formatMoney, humanizeEnum } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

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
  | "attendance"
  | "change"
  | "contact"
  | "facilities"
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
  const [attendanceDraft, setAttendanceDraft] = useState<AttendanceSettings | null>(null);

  const hostel = settings.data?.hostel ?? null;
  const community = settings.data?.community ?? null;
  const attendance = settings.data?.attendance ?? null;

  const { refresh, setData } = settings;

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

      if (next === "attendance") {
        setAttendanceDraft(attendance);
      }

      setPanel(next);
    },
    [attendance, hostel],
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

  const saveCommunity = useCallback(
    async (input: Partial<CommunitySettings>) => {
      try {
        const community = await updateCommunitySettings(input);

        setData((current) => (current ? { ...current, community } : current));
      } catch (error) {
        toastError("Could not change that", readApiError(error));
      }
    },
    [setData],
  );

  const saveAttendance = useCallback(async () => {
    if (!attendanceDraft) {
      return;
    }

    if (attendanceDraft.nearbyZoneRadiusMeters <= attendanceDraft.insideZoneRadiusMeters) {
      toastError(
        "Check the geofence",
        "The nearby radius has to be larger than the inside one — the server refuses it otherwise.",
      );
      return;
    }

    setSaving(true);

    try {
      const attendance = await updateAttendanceSettings(attendanceDraft);

      setData((current) => (current ? { ...current, attendance } : current));
      toastSuccess("Attendance settings saved");
      setPanel(null);
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }, [attendanceDraft, setData]);

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
              {`Renamed ${hostel.nameChangeCount} time(s) since approval. Past the platform's limit, a rename becomes a change request.`}
            </Text>
          ) : null}
        </Card>

        <View>
          <SectionHeader subtitle="What the public listing says" title="The hostel" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="business-outline"
              iconBgColor="#007AFF"
              onPress={() => openPanel("about")}
              subtitle={hostel.description ? "Name, description, type" : "No description yet"}
              title="About"
            />
            <RowDivider inset />
            <ListRow
              icon="call-outline"
              iconBgColor="#34C759"
              onPress={() => openPanel("contact")}
              subtitle={hostel.contact.phone || "No phone on file"}
              title="Contact"
            />
            <RowDivider inset />
            <ListRow
              icon="location-outline"
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
              icon="cash-outline"
              iconBgColor="#30D158"
              onPress={() => openPanel("pricing")}
              subtitle={
                hostel.pricing.monthlyRentMin
                  ? `${formatMoney(hostel.pricing.monthlyRentMin)} – ${formatMoney(hostel.pricing.monthlyRentMax)}`
                  : "No price range set"
              }
              title="Pricing"
            />
            <RowDivider inset />
            <ListRow
              icon="sparkles-outline"
              iconBgColor="#AF52DE"
              onPress={() => openPanel("facilities")}
              subtitle={`${hostel.facilities.length} listed`}
              title="Facilities"
            />
            <RowDivider inset />
            <ListRow
              icon="document-text-outline"
              iconBgColor="#FF9500"
              onPress={() => openPanel("rules")}
              subtitle={`${hostel.rules.length} listed`}
              title="House rules"
            />
            <RowDivider inset />
            <ListRow
              icon="bed-outline"
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
              icon="people-outline"
              iconBgColor="#30B0C7"
              onPress={() => router.push("/manage/wardens")}
              subtitle="Invite, suspend and set what each one may do"
              title="Wardens"
            />
            <RowDivider inset />
            <ListRow
              icon="gift-outline"
              iconBgColor="#FF2D55"
              onPress={() => router.push("/manage/referrals")}
              subtitle="Confirm who joined, and record the reward"
              title="Referrals"
            />
            <RowDivider inset />
            <ListRow
              icon="megaphone-outline"
              iconBgColor="#34C759"
              onPress={() => router.push("/manage/invite-hostels")}
              subtitle="Your hostel's code for other hostels"
              title="Invite hostels"
            />
          </Card>
        </View>

        <View>
          <SectionHeader subtitle="Hostel-wide behaviour" title="Switches" />

          <Card className="gap-3">
            {community === null ? (
              <Text variant="muted">
                The community switches are for the hostel owner. This account signs in
                as staff, so they are not shown.
              </Text>
            ) : (
              <>
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text variant="label">Community</Text>
                    <Text variant="caption">
                      Lets your residents post on the platform-wide board.
                    </Text>
                  </View>
                  <Toggle
                    accessibilityLabel="Community enabled"
                    onChange={(enabled) => void saveCommunity({ enabled })}
                    value={community.enabled}
                  />
                </View>

                <View className="flex-row items-center justify-between gap-3 border-t border-border pt-3">
                  <View className="flex-1">
                    <Text variant="label">Profanity filter</Text>
                    <Text variant="caption">
                      Holds posts with flagged language for a moderator instead of
                      publishing them.
                    </Text>
                  </View>
                  <Toggle
                    accessibilityLabel="Profanity filter enabled"
                    onChange={(profanityFilterEnabled) =>
                      void saveCommunity({ profanityFilterEnabled })
                    }
                    value={community.profanityFilterEnabled}
                  />
                </View>
              </>
            )}
          </Card>
        </View>

        <CalendarPreferenceCard />

        <View>
          <SectionHeader
            subtitle="The geofence, and how long its records are kept"
            title="Attendance"
          />
          {attendance === null ? (
            <Card>
              <Text variant="muted">
                The geofence is hostel-level configuration and belongs to the owner, so
                it is not shown for this account.
              </Text>
            </Card>
          ) : (
            <Card className="gap-3">
              <View className="flex-row items-center justify-between gap-3">
                <View className="flex-1">
                  <Text variant="label">
                    {attendance.enabled ? "Tracking on" : "Tracking off"}
                  </Text>
                  <Text variant="caption">
                    {attendance.enabled
                      ? `${attendance.pingTimes.length} check-in(s) a day`
                      : "Residents are not asked to check in."}
                  </Text>
                </View>
                <Toggle
                  accessibilityLabel="Attendance tracking enabled"
                  onChange={(enabled) => {
                    setAttendanceDraft({ ...attendance, enabled });
                    void updateAttendanceSettings({ enabled })
                      .then(() => refresh())
                      .catch((error: unknown) =>
                        toastError("Could not change that", readApiError(error)),
                      );
                  }}
                  value={attendance.enabled}
                />
              </View>

              <View className="gap-1 border-t border-border pt-3">
                <FactRow label="Inside" value={`${attendance.insideZoneRadiusMeters} m`} />
                <FactRow label="Nearby" value={`${attendance.nearbyZoneRadiusMeters} m`} />
                <FactRow label="Check-ins" value={attendance.pingTimes.join(", ") || "—"} />
                <FactRow label="Alert after" value={`${attendance.absenceAlertDays} day(s)`} />
                <FactRow label="Kept for" value={`${attendance.retentionDays} day(s)`} />
              </View>

              <Text variant="caption">
                Only the zone is stored — inside, nearby or outside. A check-in&apos;s
                coordinates are discarded as it lands, so nothing here can be turned
                into a location history.
              </Text>

              <Button
                label="Change the geofence"
                onPress={() => openPanel("attendance")}
                size="sm"
                variant="outline"
              />
            </Card>
          )}
        </View>

        {attendance === null ? null : (
          <View>
            <SectionHeader
              subtitle="Asked at your hour, again until answered"
              title="Night status"
            />
            <NightStatusPromptCard
              onSaved={refresh}
              settings={attendance.nightStatus}
            />
          </View>
        )}

        <View>
          <SectionHeader
            subtitle="Locked fields go to the platform team"
            title="Ask for a change"
          />
          <Card padding="px-4 py-1">
            <ListRow
              icon="mail-outline"
              iconBgColor="#8E8E93"
              onPress={() => openPanel("change")}
              subtitle="Hostel name past the limit, owner name, owner email"
              title="Request a change"
            />
          </Card>
        </View>
      </View>

      {/* ------------------------------------------------------------------ */}
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
          <Text variant="caption">
            The range shown on the public listing and in search filters. Per-room-type
            rent is set on the Rooms screen and is what a resident is actually billed.
          </Text>
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
                icon="close-circle-outline"
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
        footer={<Button label="Save" loading={saving} onPress={() => void saveAttendance()} />}
        onClose={() => setPanel(null)}
        open={panel === "attendance"}
        title="Geofence and retention"
      >
        {attendanceDraft ? (
          <View className="gap-3 pb-2">
            <Input
              hint="10–500 m. Inside this circle counts as being in the hostel."
              keyboardType="number-pad"
              label="Inside radius (m)"
              onChangeText={(value) =>
                setAttendanceDraft((prev) =>
                  prev ? { ...prev, insideZoneRadiusMeters: toNumber(value) } : prev,
                )
              }
              value={String(attendanceDraft.insideZoneRadiusMeters)}
            />
            <Input
              hint="20–2000 m, and it must be larger than the inside radius."
              keyboardType="number-pad"
              label="Nearby radius (m)"
              onChangeText={(value) =>
                setAttendanceDraft((prev) =>
                  prev ? { ...prev, nearbyZoneRadiusMeters: toNumber(value) } : prev,
                )
              }
              value={String(attendanceDraft.nearbyZoneRadiusMeters)}
            />
            <Input
              hint="Up to six, as HH:mm, separated by commas."
              label="Check-in times"
              onChangeText={(value) =>
                setAttendanceDraft((prev) =>
                  prev
                    ? {
                        ...prev,
                        pingTimes: value
                          .split(",")
                          .map((time) => time.trim())
                          .filter(Boolean)
                          .slice(0, 6),
                      }
                    : prev,
                )
              }
              placeholder="06:00, 22:00"
              value={attendanceDraft.pingTimes.join(", ")}
            />
            <Input
              hint="1–90. How many days away before the hostel and the guardian are told."
              keyboardType="number-pad"
              label="Alert after (days)"
              onChangeText={(value) =>
                setAttendanceDraft((prev) =>
                  prev ? { ...prev, absenceAlertDays: toNumber(value) } : prev,
                )
              }
              value={String(attendanceDraft.absenceAlertDays)}
            />
            <Input
              hint="30–1095. Older check-in rows are deleted."
              keyboardType="number-pad"
              label="Keep records for (days)"
              onChangeText={(value) =>
                setAttendanceDraft((prev) =>
                  prev ? { ...prev, retentionDays: toNumber(value) } : prev,
                )
              }
              value={String(attendanceDraft.retentionDays)}
            />
          </View>
        ) : null}
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
          <Text variant="caption">
            These three cannot be edited directly once a hostel is approved — they are
            what the platform verified. A person reads the request and confirms by
            email.
          </Text>

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

