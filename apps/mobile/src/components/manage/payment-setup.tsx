import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { BankNameField } from "@/components/manage/bank-name-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { WalletMark, walletLabel } from "@/components/ui/wallet-mark";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { type ExtraPaymentAccount, type PaymentProfile, updatePaymentProfile } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { viewerSourceFor } from "@/lib/asset-viewer";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * Where residents are asked to send money — the pieces Payment setup and Hostel
 * KYC's "Rent payments" step both draw, over one cached payment profile.
 *
 * ## The QR saves on its own
 *
 * Uploading patches `staticQrAssetId` immediately. The server reads a **new** QR
 * and fills the payee name and number from it, so they come back filled before
 * anything else is touched, and the bytes are never stranded by a back-press.
 *
 * ## The QR's payee fields are sent only when changed
 *
 * Sending them unchanged stamps `qrPayeeSource: "MANUAL"`, which stops a later
 * re-read from correcting them — see `Field.onlyIfChanged`.
 */

type Draft = Record<string, string>;

type Field = {
  hint?: string;
  key: keyof PaymentProfile;
  keyboard?: "number-pad" | "numbers-and-punctuation";
  label: string;
  multiline?: boolean;
  number?: boolean;
  onlyIfChanged?: boolean;
};

export type PaymentSection = "bank" | "cadence" | "cash" | "esewa" | "khalti" | "name" | "note" | "qr";

const SHEETS: Record<PaymentSection, { fields: Field[]; title: string }> = {
  bank: {
    fields: [
      { key: "bankName", label: "Bank" },
      { key: "bankAccountName", label: "Account name" },
      { key: "bankAccountNumber", keyboard: "numbers-and-punctuation", label: "Account number" },
    ],
    title: "Bank",
  },
  cadence: {
    fields: [
      {
        hint: "1–90 days.",
        key: "statementCadenceDays",
        keyboard: "number-pad",
        label: "Remind me every (days)",
        number: true,
      },
    ],
    title: "Statement reminder",
  },
  cash: {
    fields: [
      {
        hint: "0 means every cash entry needs a second approver.",
        key: "cashApprovalThreshold",
        keyboard: "number-pad",
        label: "Second approver above (Rs)",
        number: true,
      },
    ],
    title: "Cash approval",
  },
  esewa: {
    fields: [{ key: "esewaId", keyboard: "numbers-and-punctuation", label: "eSewa ID" }],
    title: "eSewa",
  },
  khalti: {
    fields: [{ key: "khaltiId", keyboard: "numbers-and-punctuation", label: "Khalti ID" }],
    title: "Khalti",
  },
  name: {
    fields: [{ key: "displayName", label: "Hostel or owner name" }],
    title: "Name residents see",
  },
  note: {
    fields: [{ key: "paymentInstructions", label: "Shown under the pay options", multiline: true }],
    title: "Note for residents",
  },
  qr: {
    fields: [
      {
        hint: "Read from your QR. Fix it only if it came back wrong.",
        key: "qrPayeeName",
        label: "Name on the QR",
        onlyIfChanged: true,
      },
      {
        key: "qrPayeeNumber",
        keyboard: "numbers-and-punctuation",
        label: "Number on the QR",
        onlyIfChanged: true,
      },
    ],
    title: "Name and number on the QR",
  },
};

/** `onSaved` runs after every write — KYC re-reads its ticks from it. */
export function usePaymentSetup({ onSaved }: { onSaved?: () => void } = {}) {
  const token = useAppSelector((state) => state.auth.accessToken);
  const [section, setSection] = useState<PaymentSection | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [qrBusy, setQrBusy] = useState<"remove" | "upload" | null>(null);

  const query = adminQuery.paymentProfile();
  const resource = useResource<PaymentProfile>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const profile = resource.data ?? null;
  const { setData } = resource;

  const written = (next: PaymentProfile) => {
    setData(() => next);
    onSaved?.();
  };

  const stored = (key: keyof PaymentProfile) => {
    const value = profile?.[key];

    return value === null || value === undefined ? "" : String(value);
  };

  const openSection = (next: PaymentSection) => {
    setDraft(Object.fromEntries(SHEETS[next].fields.map((field) => [field.key, stored(field.key)])));
    setSection(next);
  };

  const save = async () => {
    if (!section) {
      return;
    }

    const input: Record<string, number | string | undefined> = {};

    for (const field of SHEETS[section].fields) {
      const raw = (draft[field.key] ?? "").trim();

      if (field.onlyIfChanged) {
        input[field.key] = draft[field.key] === stored(field.key) ? undefined : raw;
      } else if (field.number) {
        input[field.key] = raw ? Number(raw) : undefined;
      } else {
        input[field.key] = raw || undefined;
      }
    }

    setSaving(true);

    try {
      written(await updatePaymentProfile(input as Parameters<typeof updatePaymentProfile>[0]));
      toastSuccess("Saved");
      setSection(null);
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  };

  const pickQr = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to upload your QR.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
    });
    const picked = result.canceled ? null : result.assets[0];

    if (!picked) {
      return;
    }

    setQrBusy("upload");

    try {
      const assetId = await uploadAsset(picked, { kind: "PAYMENT_QR", label: "Payment QR" });

      written(await updatePaymentProfile({ staticQrAssetId: assetId }));
      toastSuccess("QR saved");
    } catch (error) {
      toastError("That QR did not upload", readApiError(error));
    } finally {
      setQrBusy(null);
    }
  };

  /** The extra-accounts list is one field on the server, so a change sends the whole list. */
  const saveExtraAccounts = async (next: ExtraPaymentAccount[]) => {
    setSaving(true);

    try {
      written(
        await updatePaymentProfile({
          extraAccounts: next.map((account) => ({
            accountName: account.accountName?.trim() || undefined,
            bankName: account.bankName?.trim() || undefined,
            kind: account.kind,
            number: account.number.trim(),
          })),
        }),
      );
      toastSuccess("Saved");
      return true;
    } catch (error) {
      toastError("Could not save", readApiError(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeQr = async () => {
    setQrBusy("remove");

    try {
      written(await updatePaymentProfile({ staticQrAssetId: null }));
      toastSuccess("QR removed");
    } catch (error) {
      toastError("Could not remove it", readApiError(error));
    } finally {
      setQrBusy(null);
    }
  };

  const qrSource = profile?.staticQrAssetId
    ? viewerSourceFor({ assetId: profile.staticQrAssetId }, { baseUrl: API_BASE_URL, token })
    : null;

  return {
    closeSection: () => setSection(null),
    draft,
    openSection,
    pickQr,
    profile,
    qrBusy,
    qrSource,
    removeQr,
    resource,
    save,
    saveExtraAccounts,
    saving,
    section,
    setDraft,
  };
}

export type PaymentSetup = ReturnType<typeof usePaymentSetup>;

/** Whether residents can pay at all, and how many of the four ways are set. */
export function PaymentStatusCard({ profile }: { profile: PaymentProfile }) {
  const ways = Math.min(
    4,
    [profile.staticQrAssetId, profile.bankAccountNumber, profile.esewaId, profile.khaltiId].filter(Boolean)
      .length + (profile.extraAccounts?.length ?? 0),
  );

  return (
    <Card className="gap-3">
      <View className="flex-row flex-wrap gap-2">
        <Badge
          label={profile.usable ? "Residents can pay" : "Not set up"}
          tone={profile.usable ? "success" : "danger"}
        />
        <Badge
          label={profile.payeeVerifiable ? "Receipts checked" : "Receipts not checked"}
          tone={profile.payeeVerifiable ? "success" : "warning"}
        />
      </View>
      <Meter label={`${ways} of 4 ways to pay set up`} percent={ways * 25} />
    </Card>
  );
}

export function PaymentQrCard({ setup }: { setup: PaymentSetup }) {
  const { colors } = useAppTheme();
  const { openSection, pickQr, profile, qrBusy, qrSource, removeQr } = setup;

  return (
    <View>
      <SectionHeader title="QR" />
      <Card className="gap-3">
        <View className="flex-row items-center gap-4">
          {qrSource ? (
            <Image
              contentFit="cover"
              source={qrSource}
              style={{
                borderColor: colors.border,
                borderRadius: 14,
                borderWidth: 1,
                height: 112,
                width: 112,
              }}
            />
          ) : (
            <Pressable
              accessibilityLabel="Upload your QR"
              accessibilityRole="button"
              className="h-28 w-28 items-center justify-center rounded-2xl border border-dashed border-border active:opacity-70"
              onPress={() => void pickQr()}
            >
              <Ionicons color={colors.mutedForeground} name="qr-code-outline" size={36} />
            </Pressable>
          )}

          <View className="flex-1 gap-2">
            <Button
              disabled={qrBusy === "remove"}
              label={qrSource ? "Replace" : "Upload QR"}
              loading={qrBusy === "upload"}
              onPress={() => void pickQr()}
              size="sm"
              variant={qrSource ? "outline" : "primary"}
            />
            {qrSource ? (
              <Button
                disabled={qrBusy === "upload"}
                label="Remove"
                loading={qrBusy === "remove"}
                onPress={() => void removeQr()}
                size="sm"
                variant="ghost"
              />
            ) : null}
          </View>
        </View>

        {qrSource ? (
          <View className="border-t border-border">
            <ListRow
              icon="scan-outline"
              iconBgColor="#5E5CE6"
              onPress={() => openSection("qr")}
              subtitle={
                [profile?.qrPayeeName, profile?.qrPayeeNumber].filter(Boolean).join(" · ") ||
                "Not read yet"
              }
              title="Name on the QR"
            />
          </View>
        ) : null}
      </Card>
    </View>
  );
}

export function PaymentDestinations({ setup }: { setup: PaymentSetup }) {
  const { openSection, profile } = setup;
  const [account, setAccount] = useState<number | "new" | null>(null);
  const extra = profile?.extraAccounts ?? [];

  return (
    <View>
      <SectionHeader title="Where money goes" />
      <Card padding="px-4 py-1">
        <ListRow
          left={<WalletMark name={profile?.bankName} size={32} />}
          onPress={() => openSection("bank")}
          subtitle={
            profile?.bankAccountNumber
              ? `${profile.bankName ?? "Bank"} · ${profile.bankAccountNumber}`
              : "Not set"
          }
          title="Bank"
        />
        <RowDivider inset />
        <ListRow
          left={<WalletMark name="ESEWA" size={32} />}
          onPress={() => openSection("esewa")}
          subtitle={profile?.esewaId || "Not set"}
          title="eSewa"
        />
        <RowDivider inset />
        <ListRow
          left={<WalletMark name="KHALTI" size={32} />}
          onPress={() => openSection("khalti")}
          subtitle={profile?.khaltiId || "Not set"}
          title="Khalti"
        />
        <ExtraAccountRows accounts={extra} onOpen={setAccount} />
      </Card>
      <ExtraAccountSheet editing={account} onClose={() => setAccount(null)} setup={setup} />
    </View>
  );
}

const ACCOUNT_KINDS = [
  { label: "Bank", value: "BANK" },
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
] as const;

/** One row per extra account, then "Add another account". */
export function ExtraAccountRows({
  accounts,
  onOpen,
}: {
  accounts: ExtraPaymentAccount[];
  onOpen: (index: number | "new") => void;
}) {
  return (
    <>
      {accounts.map((account, index) => (
        <View key={`${account.kind}:${account.number}`}>
          <RowDivider inset />
          <ListRow
            left={<WalletMark name={account.kind === "BANK" ? account.bankName : account.kind} size={32} />}
            onPress={() => onOpen(index)}
            subtitle={account.number}
            title={account.kind === "BANK" ? account.bankName || "Bank" : walletLabel(account.kind)}
          />
        </View>
      ))}
      {accounts.length < 6 ? (
        <>
          <RowDivider inset />
          <ListRow icon="add" onPress={() => onOpen("new")} title="Add another account" />
        </>
      ) : null}
    </>
  );
}

/** Add or change one extra account. It saves on its own, like the QR. */
export function ExtraAccountSheet({
  editing,
  onClose,
  setup,
}: {
  editing: number | "new" | null;
  onClose: () => void;
  setup: PaymentSetup;
}) {
  const accounts = setup.profile?.extraAccounts ?? [];
  const blank: ExtraPaymentAccount = { accountName: "", bankName: "", kind: "BANK", number: "" };
  const [draft, setDraft] = useState<ExtraPaymentAccount>(blank);
  const [openFor, setOpenFor] = useState<number | "new" | null>(null);

  // Seeded once per open, so a refetch behind the sheet does not wipe the typing.
  if (editing !== openFor) {
    setOpenFor(editing);
    setDraft(typeof editing === "number" ? { ...blank, ...accounts[editing] } : blank);
  }

  const save = async () => {
    if (!draft.number.trim()) {
      toastError("Add the number", draft.kind === "BANK" ? "Enter the account number." : "Enter the wallet ID.");
      return;
    }

    const next =
      typeof editing === "number"
        ? accounts.map((account, index) => (index === editing ? draft : account))
        : [...accounts, draft];

    if (await setup.saveExtraAccounts(next)) onClose();
  };

  const remove = async () => {
    if (typeof editing !== "number") return;
    if (await setup.saveExtraAccounts(accounts.filter((_, index) => index !== editing))) onClose();
  };

  return (
    <Sheet
      footer={<Button label="Save" loading={setup.saving} onPress={() => void save()} />}
      onClose={onClose}
      open={editing !== null}
      title={editing === "new" ? "Add an account" : "Account"}
    >
      <View className="gap-3 pb-2">
        <Segmented
          onChange={(kind) => setDraft((current) => ({ ...current, kind }))}
          options={ACCOUNT_KINDS}
          value={draft.kind}
        />
        {draft.kind === "BANK" ? (
          <BankNameField
            onChange={(bankName) => setDraft((current) => ({ ...current, bankName }))}
            value={draft.bankName ?? ""}
          />
        ) : null}
        <Input
          label="Name on the account"
          onChangeText={(accountName) => setDraft((current) => ({ ...current, accountName }))}
          value={draft.accountName ?? ""}
        />
        <Input
          keyboardType="numbers-and-punctuation"
          label={draft.kind === "BANK" ? "Account number" : `${walletLabel(draft.kind)} ID`}
          onChangeText={(number) => setDraft((current) => ({ ...current, number }))}
          value={draft.number}
        />
        {typeof editing === "number" ? (
          <Button disabled={setup.saving} label="Remove this account" onPress={() => void remove()} variant="ghost" />
        ) : null}
      </View>
    </Sheet>
  );
}

export function PaymentSheet({ setup }: { setup: PaymentSetup }) {
  const { closeSection, draft, save, saving, section, setDraft } = setup;
  const sheet = section ? SHEETS[section] : null;

  return (
    <Sheet
      footer={<Button label="Save" loading={saving} onPress={() => void save()} />}
      onClose={closeSection}
      open={sheet !== null}
      title={sheet?.title ?? ""}
    >
      <View className="gap-3 pb-2">
        {sheet?.fields.map((field) => field.key === "bankName" ? (
          <BankNameField
            key={field.key}
            onChange={(value) => setDraft((prev) => ({ ...prev, bankName: value }))}
            value={draft.bankName ?? ""}
          />
        ) : (
          <Input
            hint={field.hint}
            key={field.key}
            keyboardType={field.keyboard}
            label={field.label}
            multiline={field.multiline}
            onChangeText={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
            style={field.multiline ? { height: 96 } : undefined}
            value={draft[field.key] ?? ""}
          />
        ))}
      </View>
    </Sheet>
  );
}
