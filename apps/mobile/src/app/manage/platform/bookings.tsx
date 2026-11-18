import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { Figures, Quiet, Rows, Section, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { fileAssetUrl } from "@/lib/finance-api";
import { formatMoney } from "@/lib/format";
import {
  type BookingPaymentToCheck,
  type BookingTransfer,
  listBookingPayments,
  listBookingTransfers,
  markTransferSent,
  type RevealedAccount,
  revealTransferAccount,
  reviewBookingPayment,
} from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Bookings — the two queues HostelPalika promised to work on time (docs/BOOKINGS.md):
 * booking screenshots to check, then refunds and payouts to send by hand. The
 * full account number is revealed on request only (audited server-side), copied,
 * and the transfer is closed with the bank's transaction ID. Rest of the web's
 * Bookings page (holds, paused hostels, settings) stays on the web.
 */
export default function PlatformBookingsScreen() {
  const payments = useResource(listBookingPayments, { cacheKey: "platform:bookings:payments" });
  const transfers = useResource(listBookingTransfers, { cacheKey: "platform:bookings:transfers" });
  const [open, setOpen] = useState<BookingTransfer | null>(null);
  const dates = useDates();

  const toSend = (transfers.data ?? []).reduce((sum, row) => sum + row.amount, 0);
  const refresh = () => {
    payments.refresh();
    transfers.refresh();
  };

  return (
    <Screen header={<AppBar showBack title="Bookings" />} onRefresh={refresh} refreshing={payments.refreshing || transfers.refreshing} scroll>
      <View className="gap-6 pt-2">
        <Figures
          items={[
            { label: "To check", loading: payments.loading, tone: payments.data?.length ? "warning" : undefined, value: payments.data?.length },
            { label: "To send", loading: transfers.loading, tone: transfers.data?.length ? "warning" : undefined, value: transfers.data?.length },
            { label: "Amount out", loading: transfers.loading, value: formatMoney(toSend) },
          ]}
        />

        <Section count={payments.data?.length} title="Screenshots to check">
          {payments.loading ? (
            <SkeletonRows rows={2} />
          ) : !payments.data?.length ? (
            <Quiet>{payments.error ?? "No booking payment is waiting."}</Quiet>
          ) : (
            <Rows inset={false}>
              {payments.data.map((payment) => (
                <PaymentItem key={payment.id} onDone={refresh} payment={payment} />
              ))}
            </Rows>
          )}
        </Section>

        <Section count={transfers.data?.length} title="Money to send">
          {transfers.loading ? (
            <SkeletonRows rows={2} />
          ) : !transfers.data?.length ? (
            <Quiet>{transfers.error ?? "No refund or payout is due."}</Quiet>
          ) : (
            <Rows>
              {transfers.data.map((row) => (
                <TintRow
                  icon={row.kind === "REFUND" ? "arrow-undo" : "send"}
                  key={row.id}
                  onPress={() => setOpen(row)}
                  subtitle={[row.kind === "REFUND" ? `Refund to ${row.guestName}` : "Payout", row.bookingCode, row.dueSince ? `due ${dates.ago(row.dueSince)}` : null].filter(Boolean).join(" · ")}
                  title={row.hostelName}
                  tone={row.blocked ? "danger" : row.kind === "REFUND" ? "warning" : "brand"}
                  value={formatMoney(row.amount)}
                />
              ))}
            </Rows>
          )}
        </Section>
      </View>

      <TransferSheet
        onClose={() => setOpen(null)}
        onSent={() => {
          setOpen(null);
          transfers.refresh();
        }}
        transfer={open}
      />
    </Screen>
  );
}

function PaymentItem({ onDone, payment }: { onDone: () => void; payment: BookingPaymentToCheck }) {
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const [busy, setBusy] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [note, setNote] = useState("");
  const [openedAt] = useState(Date.now);
  const late = new Date(payment.checkBy).getTime() < openedAt;

  async function review(approve: boolean) {
    if (!approve && note.trim().length < 3) {
      toastError("Say why", "The person reads this note.");
      return;
    }
    setBusy(true);
    try {
      await reviewBookingPayment(payment.id, approve, note);
      toastSuccess(approve ? "Approved — the hostel has been asked" : "Sent back to the person");
      onDone();
    } catch (error) {
      toastError("That did not go through", readApiError(error));
      setBusy(false);
    }
  }

  return (
    <View className="gap-3 py-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {payment.guest.name}
          </Text>
          <Text numberOfLines={1} variant="caption">
            {[payment.hostelName, payment.roomType, payment.bookingCode].join(" · ")}
          </Text>
        </View>
        <Text className="font-amount text-lg font-bold tabular-nums">{formatMoney(payment.amount)}</Text>
      </View>

      <Pressable
        accessibilityLabel="Payment screenshot"
        accessibilityRole="imagebutton"
        className="overflow-hidden rounded-2xl active:opacity-80"
        onPress={() => openAssetViewer([{ assetId: payment.proofAssetId, title: payment.guest.name }])}
      >
        <Image
          cachePolicy="memory-disk"
          contentFit="cover"
          source={{ headers: token ? { Authorization: `Bearer ${token}` } : undefined, uri: fileAssetUrl(payment.proofAssetId) }}
          style={{ height: 200, width: "100%" }}
        />
      </Pressable>

      <View>
        {payment.reference ? <FactRow label="Reference" value={payment.reference} /> : null}
        <FactRow label="Sent" value={dates.ago(payment.submittedAt)} />
        <FactRow label="Check by" value={<Text className={`text-sm font-medium ${late ? "text-destructive" : "text-foreground"}`}>{dates.ago(payment.checkBy)}</Text>} />
        {payment.note ? <FactRow label="Their note" value={payment.note} /> : null}
      </View>

      {refusing ? <Input label="Why (they read this)" maxLength={500} multiline onChangeText={setNote} placeholder="e.g. The amount does not match" value={note} /> : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          {refusing ? (
            <Button disabled={busy} label="Back" onPress={() => setRefusing(false)} variant="ghost" />
          ) : (
            <Button disabled={busy} label="Refuse" onPress={() => setRefusing(true)} variant="outline" />
          )}
        </View>
        <View className="flex-1">
          {refusing ? (
            <Button disabled={busy} label="Send back" loading={busy} onPress={() => void review(false)} variant="danger" />
          ) : (
            <Button disabled={busy} label="Approve" loading={busy} onPress={() => void review(true)} />
          )}
        </View>
      </View>
    </View>
  );
}

function TransferSheet({ onClose, onSent, transfer }: { onClose: () => void; onSent: () => void; transfer: BookingTransfer | null }) {
  const [account, setAccount] = useState<RevealedAccount | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [transactionId, setTransactionId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function close() {
    setAccount(null);
    setTransactionId("");
    setNote("");
    onClose();
  }

  async function reveal() {
    if (!transfer) return;
    setRevealing(true);
    try {
      setAccount(await revealTransferAccount(transfer.id));
    } catch (error) {
      toastError("Could not show the number", readApiError(error));
    } finally {
      setRevealing(false);
    }
  }

  async function sent() {
    if (!transfer) return;
    setBusy(true);
    try {
      await markTransferSent(transfer.id, transactionId, note);
      toastSuccess(`Marked sent — ${formatMoney(transfer.amount)}`);
      setAccount(null);
      setTransactionId("");
      setNote("");
      onSent();
    } catch (error) {
      toastError("Not marked sent", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  const destination = transfer?.destination;

  return (
    <Sheet onClose={close} open={transfer !== null} tall title={transfer ? `${transfer.kind === "REFUND" ? "Refund" : "Payout"} · ${formatMoney(transfer.amount)}` : ""}>
      {transfer ? (
        <View className="gap-4 pb-2">
          <View>
            <FactRow label={transfer.kind === "REFUND" ? "To" : "Hostel"} value={transfer.kind === "REFUND" ? transfer.guestName : transfer.hostelName} />
            <FactRow label="Booking" value={`${transfer.bookingCode} · ${transfer.roomType}`} />
            {destination ? (
              <>
                <FactRow label="Method" value={destination.methodLabel} />
                {destination.bankName ? <FactRow label="Bank" value={destination.bankName} /> : null}
                <FactRow label="Holder" value={destination.holderName} />
                <FactRow label="Number" value={account?.number ?? destination.maskedNumber} />
              </>
            ) : null}
          </View>

          {transfer.blocked ? (
            <Text className="text-sm text-destructive">
              {transfer.blocked === "NO_PAYOUT_ACCOUNT" ? "The hostel has not added a payout account yet." : "The hostel's payout account is not verified yet."}
            </Text>
          ) : (
            <>
              {account ? (
                <Button
                  icon="copy"
                  label="Copy number"
                  onPress={() => {
                    void Clipboard.setStringAsync(account.number);
                    toastSuccess("Number copied");
                  }}
                  variant="outline"
                />
              ) : (
                <Button icon="eye" label="Show full number" loading={revealing} onPress={() => void reveal()} variant="outline" />
              )}
              <Input autoCapitalize="characters" label="Transaction ID" onChangeText={setTransactionId} placeholder="From the bank or wallet" value={transactionId} />
              <Input label="Note (optional)" maxLength={500} onChangeText={setNote} value={note} />
              <Button disabled={transactionId.trim().length < 3} label="Mark sent" loading={busy} onPress={() => void sent()} />
            </>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}
