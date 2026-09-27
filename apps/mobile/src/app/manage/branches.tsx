import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { EMPTY_PAYOUT_ACCOUNT, RegistrationPayoutFields } from "@/components/manage/payout-account-card";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getBranches, requestBranch } from "@/lib/admin-api";
import { updateManagedHostel } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { uploadPublicFile } from "@/lib/public-uploads";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Branches — other buildings the owner runs, under the main hostel's plan
 * (Max includes some). Same rules as the website's Branches page: the main
 * hostel's PAN/VAT number and certificate, a payout account in the main
 * hostel's name, and our call to the branch before it goes live.
 *
 * Switching between branches is Home's chip; this screen only lists and adds.
 */

type RoomRow = { beds: string; rent: string; rooms: string; type: string };

const EMPTY_ROOM: RoomRow = { beds: "", rent: "", rooms: "", type: "" };
const HOSTEL_TYPES = [
  { label: "Co-living", value: "CO_LIVING" },
  { label: "Boys", value: "BOYS" },
  { label: "Girls", value: "GIRLS" },
] as const;
const STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  PENDING_APPROVAL: { label: "Waiting for our call", tone: "warning" },
  PUBLISHED: { label: "Live", tone: "success" },
  REJECTED: { label: "Not approved", tone: "danger" },
};

export default function BranchesScreen() {
  const branches = useResource(getBranches, { cacheKey: "admin:branch-list" });
  const [adding, setAdding] = useState(false);
  const header = <AppBar accent centerTitle showBack title="Branches" />;

  if (branches.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (branches.error || !branches.data) {
    return (
      <Screen header={header}>
        <ErrorState message={branches.error ?? "Could not load branches."} onRetry={branches.reload} />
      </Screen>
    );
  }

  const { allowance, main } = branches.data;
  const blocked =
    allowance.cap === 0
      ? `${allowance.planName ?? "Your plan"} does not include branches. Max does.`
      : !allowance.active
        ? "Your plan has to be active — clear any due first."
        : allowance.used >= allowance.cap
          ? `${allowance.planName} includes ${allowance.cap}, and all are in use.`
          : null;

  return (
    <Screen header={header} onRefresh={branches.refresh} refreshing={branches.refreshing} scroll>
      <View className="gap-5 pt-1">
        <View className="gap-3">
          <SectionHeader
            subtitle={`${allowance.used} of ${allowance.cap} on ${allowance.planName ?? "your plan"} · no extra cost`}
            title={`Branches of ${main.name}`}
          />
          {branches.data.branches.length > 0 ? (
            <Card className="gap-1 px-0 py-1">
              {branches.data.branches.map((branch) => {
                const status = STATUS[branch.status] ?? { label: branch.status, tone: "neutral" as const };

                return (
                  <ListRow
                    icon="git-branch-outline"
                    key={branch.id}
                    right={<Badge label={status.label} tone={status.tone} />}
                    subtitle={[branch.area, branch.city].filter(Boolean).join(", ")}
                    title={branch.name}
                  />
                );
              })}
            </Card>
          ) : (
            <Text variant="caption">No branches yet.</Text>
          )}
        </View>

        {blocked ? (
          <Card>
            <Text variant="caption">{blocked}</Text>
          </Card>
        ) : !main.panNumber ? (
          <MainPanForm hostelName={main.name} onSaved={branches.refresh} />
        ) : adding ? (
          <BranchForm
            mainPan={main.panNumber ?? ""}
            onCancel={() => setAdding(false)}
            onFiled={() => {
              setAdding(false);
              branches.refresh();
            }}
          />
        ) : (
          <Button label="Add a branch" onPress={() => setAdding(true)} />
        )}
      </View>
    </Screen>
  );
}

/**
 * Every branch has to match the main hostel's PAN/VAT number, so a hostel that
 * never gave one gives it here first. Written once; a correction goes through us.
 */
function MainPanForm({ hostelName, onSaved }: { hostelName: string; onSaved: () => void }) {
  const [pan, setPan] = useState("");
  const [saving, setSaving] = useState(false);
  const valid = /^\d{9}$/.test(pan.replace(/\s/g, ""));

  async function save() {
    setSaving(true);

    try {
      await updateManagedHostel({ panNumber: pan.replace(/\s/g, "") });
      toastSuccess("PAN/VAT saved", "Every branch has to match it.");
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="gap-3">
      <Text variant="subtitle">{`${hostelName}'s PAN/VAT number`}</Text>
      <Text variant="caption">
        Nine digits, from your PAN/VAT certificate. Every branch has to be under the same number, and it
        can only be set once.
      </Text>
      <Input keyboardType="number-pad" label="PAN/VAT number" onChangeText={setPan} value={pan} />
      <Button disabled={!valid} label="Save" loading={saving} onPress={() => void save()} />
    </Card>
  );
}

function BranchForm({
  mainPan,
  onCancel,
  onFiled,
}: {
  mainPan: string;
  onCancel: () => void;
  onFiled: () => void;
}) {
  const { colors } = useAppTheme();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [area, setArea] = useState("");
  const [city, setCity] = useState("Kathmandu");
  const [address, setAddress] = useState("");
  const [hostelType, setHostelType] = useState<"BOYS" | "CO_LIVING" | "GIRLS">("CO_LIVING");
  const [rooms, setRooms] = useState<RoomRow[]>([{ ...EMPTY_ROOM }]);
  const [pan, setPan] = useState(mainPan);
  const [certificate, setCertificate] = useState<{ claimToken: string; fileAssetId: string; fileName: string } | null>(null);
  const [payout, setPayout] = useState(EMPTY_PAYOUT_ACCOUNT);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const setRoom = (index: number, patch: Partial<RoomRow>) =>
    setRooms((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const attachCertificate = useCallback(async () => {
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = picked.canceled ? null : picked.assets[0];

    if (!asset) return;

    setUploading(true);

    try {
      const uploaded = await uploadPublicFile(asset, { label: "PAN/VAT certificate" });

      if (uploaded.claimToken && uploaded.fileAssetId) {
        setCertificate({
          claimToken: uploaded.claimToken,
          fileAssetId: uploaded.fileAssetId,
          fileName: uploaded.fileName,
        });
      }
    } catch (error) {
      toastError("Upload failed", readApiError(error));
    } finally {
      setUploading(false);
    }
  }, []);

  async function submit() {
    if (!certificate) {
      toastError("PAN/VAT certificate", "Add a photo of the branch's PAN/VAT certificate.");
      return;
    }

    const roomConfigurations = rooms
      .filter((row) => row.type.trim() && Number(row.rooms) > 0)
      .map((row) => {
        const count = Number(row.rooms);
        const beds = Number(row.beds) || 1;

        return {
          bedsPerRoom: beds,
          mealInclusion: "Included",
          monthlyRent: Number(row.rent) || undefined,
          rooms: count,
          roomType: row.type.trim(),
          vacantBeds: count * beds,
        };
      });

    setSaving(true);

    try {
      await requestBranch({
        contact: { phone: phone.trim() },
        documents: [
          { claimToken: certificate.claimToken, documentType: "PAN / VAT document", fileAssetId: certificate.fileAssetId },
        ],
        hostelType,
        location: { address: address.trim() || undefined, area: area.trim(), city: city.trim() },
        name: name.trim(),
        panNumber: pan.replace(/\s/g, ""),
        payoutAccount: { ...payout, holderName: payout.holderName.trim(), number: payout.number.trim() },
        roomConfigurations,
        roomTypes: roomConfigurations.map((row) => row.roomType),
      });
      toastSuccess(`${name.trim()} sent`, "We call the branch before it goes live.");
      onFiled();
    } catch (error) {
      toastError("Not sent", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="gap-4">
      <SectionHeader
        subtitle="Same PAN/VAT as your hostel, and a payout account in the same name."
        title="Add a branch"
      />
      <Card className="gap-3">
        <Input label="Branch name" onChangeText={setName} value={name} />
        <Input keyboardType="phone-pad" label="Phone at the branch (we call it)" onChangeText={setPhone} value={phone} />
        <Input label="Area" onChangeText={setArea} value={area} />
        <Input label="City" onChangeText={setCity} value={city} />
        <Input label="Address" onChangeText={setAddress} value={address} />
        <ChoiceChips columns={3} label="Type" onToggle={setHostelType} options={HOSTEL_TYPES} value={hostelType} />
      </Card>

      <Card className="gap-3">
        <Text variant="label">Rooms</Text>
        {rooms.map((row, index) => (
          <View className="gap-2" key={index}>
            <Input label="Room type" onChangeText={(type) => setRoom(index, { type })} placeholder="e.g. 2 seater" value={row.type} />
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Input keyboardType="number-pad" label="Rooms" onChangeText={(value) => setRoom(index, { rooms: value })} value={row.rooms} />
              </View>
              <View className="flex-1">
                <Input keyboardType="number-pad" label="Beds each" onChangeText={(beds) => setRoom(index, { beds })} value={row.beds} />
              </View>
              <View className="flex-1">
                <Input keyboardType="number-pad" label="Rent / month" onChangeText={(rent) => setRoom(index, { rent })} value={row.rent} />
              </View>
            </View>
          </View>
        ))}
        <Pressable className="self-start py-1" onPress={() => setRooms((current) => [...current, { ...EMPTY_ROOM }])}>
          <Text className="font-semibold text-primary" variant={null}>
            + Another room type
          </Text>
        </Pressable>
      </Card>

      <Card className="gap-3">
        <Input keyboardType="number-pad" label="PAN/VAT number (same as your hostel's)" onChangeText={setPan} value={pan} />
        <Pressable
          accessibilityRole="button"
          className="flex-row items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 active:bg-muted"
          disabled={uploading}
          onPress={() => void attachCertificate()}
        >
          <Ionicons color={colors.primary} name={certificate ? "document-attach" : "document-attach-outline"} size={20} />
          <Text className="flex-1" numberOfLines={1} variant="body">
            {uploading ? "Uploading…" : certificate ? certificate.fileName : "Add the PAN/VAT certificate"}
          </Text>
        </Pressable>
      </Card>

      <Card className="gap-3">
        <Text variant="label">Payout account — in your hostel&apos;s name</Text>
        <RegistrationPayoutFields onChange={setPayout} value={payout} />
      </Card>

      <View className="gap-2">
        <Button
          disabled={uploading || !name.trim() || !area.trim() || !phone.trim()}
          label="Send for approval"
          loading={saving}
          onPress={() => void submit()}
        />
        <Button label="Cancel" onPress={onCancel} variant="outline" />
      </View>
    </View>
  );
}
