import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import {
  FLOAT_SHADOW,
  PaintedAmount,
  usePortalPaint,
} from "@/components/portal-shared";
import { copyReference } from "@/components/resident-payments";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Grid, InfoTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import {
  receiptPdfUrl,
  type ResidentFinanceView,
  type ResidentInvoice,
} from "@/lib/finance-api";
import { formatMoney } from "@/lib/format";
import { oneOffLabel } from "@/lib/invoice-ledger";
import {
  activeCodes,
  type CertifiedReceipt,
  certifiedReceipts,
} from "@/lib/offer-program";
import {
  type OfferAward,
  type OfferPerk,
  perkTerms,
  type ResidentOfferProgram,
} from "@/lib/offer-program-api";
import { residentQuery } from "@/lib/resident-queries";
import { toastError } from "@/lib/toast";

/**
 * The resident's Offer Program — this quarter, offers, perks, receipts.
 *
 * ## Two reads, split by who owns the fact
 *
 * Codes and receipts come from the payments payload, as they always have, so
 * this screen and the Payments tab cannot disagree about the same money. The
 * programme endpoint adds only what it alone knows: this quarter's certified
 * total, the perk catalogue, and what the resident has been given.
 *
 * ## Why the title changed back
 *
 * It was `Certified receipts`, because receipts were the only thing here and
 * "Offer Program" named a scheme rather than an object. The screen now holds
 * the programme itself — perks and offers — and the payment-verified email
 * sends people to "Offer Program" in the app, so the bar says that.
 *
 * ## Layout
 *
 * The painted block is the quarter's certified total — the number the
 * programme is judged on. The card straddling it is the code to quote, because
 * that is the one action that earns the next certified receipt and the string a
 * resident copies while a banking app is open. Perks are an icon-tile grid;
 * tapping one opens a sheet with the detail.
 */

/** Matches the Payments tab's card and the invoice header's block. */
const STRADDLE = 22;

export default function OfferProgramScreen() {
  const financeQuery = residentQuery.finance();
  const finance = useResource<ResidentFinanceView>(financeQuery.load, {
    cacheKey: financeQuery.key,
    topics: financeQuery.topics,
  });
  const programmeQuery = residentQuery.offerProgram();
  const programme = useResource<ResidentOfferProgram>(programmeQuery.load, {
    cacheKey: programmeQuery.key,
    topics: programmeQuery.topics,
  });

  const [perk, setPerk] = useState<OfferPerk | null>(null);

  const header = <AppBar showBack title="Offer Program" />;

  if (finance.loading || programme.loading) {
    return (
      <Screen header={header} padded={false} scroll>
        <View className="px-5">
          <Skeleton height={104} radius={20} />
        </View>

        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <Skeleton height={96} radius={18} />
        </View>

        <View className="gap-3 px-5 pt-6">
          <Skeleton height={18} width="34%" />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (finance.error || !finance.data || programme.error || !programme.data) {
    return (
      <Screen header={header}>
        <FailureState
          message={finance.error ?? programme.error ?? "Your Offer Program could not be loaded."}
          onRetry={() => {
            finance.reload();
            programme.reload();
          }}
          title="Couldn't load Offer Program"
        />
      </Screen>
    );
  }

  const codes = activeCodes(finance.data.invoices);
  const receipts = certifiedReceipts(finance.data.invoices);
  const { awards, perks, quarter } = programme.data;

  return (
    <Screen
      header={header}
      onRefresh={() => {
        finance.refresh();
        programme.refresh();
      }}
      padded={false}
      refreshing={finance.refreshing || programme.refreshing}
      scroll
    >
      <QuarterBlock quarter={quarter} />

      <CodesCard codes={codes} />

      <View className="gap-5 px-5 pt-6">
        {awards.length > 0 ? (
          <View>
            <SectionHeader title="Your offers" />
            <Card padding="px-4 py-1">
              {awards.map((award, index) => (
                <View key={award.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <AwardRow award={award} />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader
            subtitle="Given each quarter to residents with certified receipts"
            title="Perks"
          />
          {perks.length === 0 ? (
            <Card>
              <EmptyState
                compact
                description="Keep paying with your reference code."
                icon="gift"
                title="Perks are on their way"
              />
            </Card>
          ) : (
            <Grid maxColumns={3} minCellWidth={100}>
              {perks.map((item) => (
                <InfoTile
                  caption={item.kind === "FEE_OFF" ? `${item.percentOff}% off` : "Gift"}
                  icon={item.kind === "FEE_OFF" ? "pricetag" : "gift"}
                  key={item.id}
                  label={item.title}
                  onPress={() => setPerk(item)}
                />
              ))}
            </Grid>
          )}
        </View>

        <View>
          <SectionHeader
            subtitle={receipts.length === 1 ? "1 receipt" : `${receipts.length} receipts`}
            title="Receipts"
          />

          {receipts.length === 0 ? (
            <Card>
              <EmptyState
                compact
                description="Receipts will appear here after payments are verified."
                icon="receipt"
                title="No receipts yet"
              />
            </Card>
          ) : (
            <Card padding="px-4 py-1">
              {receipts.map((receipt, index) => (
                <View key={receipt.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <ReceiptRow receipt={receipt} />
                </View>
              ))}
            </Card>
          )}
        </View>

        <Card className="gap-2">
          <Text variant="caption">
            A receipt is certified when your payment had its reference code and was
            verified. Anyone can check one at hostelpalika.com/verify-receipt.
          </Text>
          <Text variant="caption">
            A receipt cannot be uploaded back as proof of a payment — for that, use the
            confirmation from the app or bank you paid with.
          </Text>
        </Card>

        <Pressable
          accessibilityRole="button"
          className="self-start active:opacity-60"
          hitSlop={8}
          onPress={() => router.push("/offer-program")}
        >
          <Text className="text-primary" variant="label">
            Programme rules
          </Text>
        </Pressable>
      </View>

      <Sheet onClose={() => setPerk(null)} open={perk !== null} title={perk?.title ?? "Perk"}>
        {perk ? (
          <View className="gap-3 pb-2">
            <Text variant="label">{perkTerms(perk)}</Text>
            <Text variant="caption">
              {[`From ${perk.partner}`, perk.giftValue ? `worth ${formatMoney(perk.giftValue)}` : null]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {perk.description ? <Text>{perk.description}</Text> : null}
            <Text variant="caption">
              Pay every bill with its reference code. At the end of each quarter
              HostelPalika gives perks to residents with certified receipts.
            </Text>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/** The quarter's certified total, painted — rounded bottom corners, card straddling. */
function QuarterBlock({ quarter }: { quarter: ResidentOfferProgram["quarter"] }) {
  const paint = usePortalPaint();

  return (
    <LinearGradient
      colors={[paint.from, paint.to]}
      end={{ x: 1, y: 1 }}
      start={{ x: 0, y: 0 }}
      style={{
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
        overflow: "hidden",
      }}
    >
      <View className="absolute inset-0" style={{ pointerEvents: "none" }}>
        <View
          className="absolute rounded-full bg-white/10"
          style={{ height: 140, right: -50, top: -70, width: 140 }}
        />
      </View>

      <View className="gap-1 px-5 pt-4" style={{ paddingBottom: STRADDLE + 14 }}>
        <Text
          className="font-semibold uppercase tracking-wider"
          numberOfLines={1}
          style={{ color: "rgba(255,255,255,0.7)", fontSize: 10 }}
        >
          {`This quarter · ${quarter.label}`}
        </Text>
        <PaintedAmount size={30} value={formatMoney(quarter.certifiedAmount)} />
        <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 13 }}>
          {quarter.certifiedCount === 1
            ? "1 certified payment"
            : `${quarter.certifiedCount} certified payments`}
        </Text>
      </View>
    </LinearGradient>
  );
}

/**
 * The code to quote, straddling the block. Every code copies on tap — it goes
 * into a bank's remarks field on the same phone, and retyping it by eye is how
 * a payment ends up quoting a code that does not validate.
 */
function CodesCard({ codes }: { codes: ResidentInvoice[] }) {
  return (
    <View className="px-5" style={{ marginTop: -STRADDLE }}>
      <View className="gap-3 rounded-[18px] border border-border bg-card p-4" style={FLOAT_SHADOW}>
        <Text variant="caption">
          {codes.length === 0
            ? "Nothing is due right now, so there is no code to quote."
            : "Put this code in the remarks when you pay"}
        </Text>
        {codes.map((invoice) => (
          <CodeLine invoice={invoice} key={invoice.id} />
        ))}
      </View>
    </View>
  );
}

function CodeLine({ invoice }: { invoice: ResidentInvoice }) {
  const dates = useDates();
  const { colors } = useAppTheme();
  const code = invoice.referenceCode;

  if (!code) {
    return null;
  }

  return (
    <Pressable
      accessibilityHint="Copies the code to your clipboard"
      accessibilityLabel={`Reference ${code}`}
      accessibilityRole="button"
      className="flex-row items-center gap-3 active:opacity-70"
      hitSlop={6}
      onPress={() => copyReference(code)}
    >
      <View className="flex-1 gap-0.5">
        <Text className="font-semibold tracking-wider text-primary" variant="title">
          {code}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {`For ${oneOffLabel(invoice) ?? dates.period(invoice.month)}`}
        </Text>
      </View>
      <Glyph color={colors.primary} name="copy" size={20} />
    </Pressable>
  );
}

function AwardMark({
  certified,
  name,
}: {
  certified: boolean;
  name: GlyphName;
}) {
  const { colors } = useAppTheme();

  return (
    <View
      className={`h-8 w-8 items-center justify-center rounded-full ${certified ? "bg-success-soft" : "bg-muted"}`}
    >
      <Glyph
        color={certified ? colors.success : colors.mutedForeground}
        name={name}
        size={18}
      />
    </View>
  );
}

function AwardRow({ award }: { award: OfferAward }) {
  const state =
    award.status === "APPLIED"
      ? `${formatMoney(award.appliedAmount ?? 0)} paid on your ${award.appliedPeriod ?? "bill"}`
      : award.status === "DELIVERED"
        ? "Delivered"
        : award.kind === "FEE_OFF"
          ? "Comes off your next monthly fee"
          : "Our team will contact you";

  return (
    <ListRow
      left={<AwardMark certified name={award.kind === "FEE_OFF" ? "pricetag" : "gift"} />}
      subtitle={`${award.quarterLabel} · ${state}`}
      title={award.title}
    />
  );
}

/**
 * The receipt number is the title — one receipt per *payment*, so a month
 * somebody part-paid has several and only the number tells them apart. A
 * certified one gets the green check.
 */
function ReceiptRow({ receipt }: { receipt: CertifiedReceipt }) {
  const dates = useDates();
  const { colors } = useAppTheme();

  const [busy, setBusy] = useState(false);

  const save = useCallback(async () => {
    setBusy(true);

    try {
      // The global downloader — progress goes to the toaster and the shade.
      await downloadToDevice({
        extension: "pdf",
        fileName: `receipt-${receipt.number}`,
        label: `Receipt ${receipt.number}`,
        mimeType: "application/pdf",
        url: receiptPdfUrl(receipt.id),
      });
    } catch (caught) {
      toastError("Could not save that receipt", readApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [receipt.id, receipt.number]);

  return (
    <ListRow
      left={
        <AwardMark
          certified={Boolean(receipt.certificationCode)}
          name={receipt.certificationCode ? "shield-checkmark" : "receipt"}
        />
      }
      onPress={() => void save()}
      right={
        <Glyph
          color={busy ? colors.mutedForeground : colors.primary}
          name={busy ? "hourglass" : "download"}
          size={20}
        />
      }
      subtitle={
        [
          formatMoney(receipt.amount),
          receipt.issuedAt ? dates.date(receipt.issuedAt) : null,
          receipt.certificationCode ? "Certified" : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined
      }
      title={`#${receipt.number.replace(/^#/, "")}`}
    />
  );
}
