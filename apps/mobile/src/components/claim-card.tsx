import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import type { AlertActions } from "@/components/admin-alerts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import type { AdminClaim, AdminClaimCheck } from "@/lib/admin-api";
import { approveClaim } from "@/lib/admin-api";
import type { AlertRow } from "@/lib/admin-alerts";
import { API_BASE_URL } from "@/lib/api";
import { openAssetViewer, viewerSourceFor } from "@/lib/asset-viewer";
import { formatMoney, humanizeEnum } from "@/lib/format";
import { useAppSelector } from "@/hooks/redux";

/**
 * One payment claim, drawn as the thing being decided rather than as a queue row.
 *
 * ## Why this is not `<AlertCard>`
 *
 * `AlertCard` serves four queues — SOS, complaints, inquiries, claims — and the
 * shape they share is "a title, a subtitle and the buttons its kind earns".
 * That is the right shape for three of them and the wrong one for this: nothing
 * else in the app is a decision about money made against a photograph, and the
 * evidence was reachable only behind a `View proof` button, three taps and a
 * full-screen overlay away from the row it belongs to.
 *
 * The combined Alerts queue still uses `AlertCard`, and should — there the label
 * is the only thing telling four sources apart. This is the Payments tab, where
 * every card is a claim and the question is always the same one.
 *
 * ## The screenshot is on the card
 *
 * Approving is the one action on this screen that moves money, and it is
 * approved against an image of somebody else's banking app. A thumbnail on the
 * card is what makes "does this look like a payment to us at all" a glance
 * rather than a navigation, and tapping it still opens the zooming viewer,
 * because the amount on a re-compressed phone screenshot is four points tall.
 *
 * ## Failed checks are shown; passing ones are counted
 *
 * The server runs six checks and hands back all six with a sentence each. All
 * six on the card is a wall of green text that trains people to skip the two
 * lines that matter, so the card prints **every check that did not pass** and
 * collapses the rest into one line. An amber check is never an accusation —
 * `review.service` is explicit that a flag only moves a decision in front of a
 * human — which is exactly why the amber ones are the ones a human is shown.
 *
 * The sentences are the server's own, verbatim. "Claimed 12000 against 5000
 * outstanding" was written carefully and a client paraphrase of it is a client
 * opinion about somebody's rent.
 */

/** A short word for each check, to sit in front of the server's sentence. */
const CHECK_LABEL: Record<AdminClaimCheck["key"], string> = {
  AMOUNT: "Amount",
  EVIDENCE: "Screenshot",
  // Deliberately distinct from `Screenshot`: that one is about what the receipt
  // says, this one is about whether the file is what it looks like.
  FILE: "File",
  INVOICE_OPEN: "Invoice",
  PAYEE: "Paid to you",
  REFERENCE: "Reference",
  SIMILARITY: "Duplicate",
};

export function ClaimCard({
  actions,
  claim,
  room,
  row,
}: {
  actions: AlertActions;
  claim: AdminClaim;
  /** The resident's room, joined from the invoice matrix. Absent is normal. */
  room?: string;
  row: AlertRow;
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const busy = actions.busyId === row.id;

  /*
   * A payment proof is a `PRIVATE` asset, so this is the authorising route with
   * a bearer token on it — not a bare URL. `viewerSourceFor` owns that choice
   * for the whole app; building the URL here would be the fifth place that
   * remembers the header, and the one that forgets it renders a blank square.
   */
  const thumbnail = claim.evidenceAssetId
    ? viewerSourceFor(
        { assetId: claim.evidenceAssetId },
        { baseUrl: API_BASE_URL, token },
      )
    : null;

  const failed = claim.checks.filter((check) => !check.ok);
  const passed = claim.checks.length - failed.length;

  const openEvidence = () =>
    openAssetViewer([
      {
        assetId: claim.evidenceAssetId ?? undefined,
        caption: [claim.method, claim.confirmation].filter(Boolean).join(" · "),
        mimeType: claim.evidenceMimeType ?? undefined,
        title: `${claim.residentName || "Claim"} · ${formatMoney(claim.amount)}`,
      },
    ]);

  return (
    <Card className="gap-3">
      <View className="flex-row gap-3">
        <View className="w-[76px] items-center gap-1">
          {thumbnail ? (
            <>
              <Pressable
                accessibilityLabel="Enlarge the payment screenshot"
                accessibilityRole="imagebutton"
                onPress={openEvidence}
              >
                <Image
                  cachePolicy="memory-disk"
                  contentFit="cover"
                  source={thumbnail}
                  style={{
                    backgroundColor: colors.muted,
                    borderRadius: 12,
                    height: 76,
                    width: 76,
                  }}
                />
              </Pressable>
              <Text className="text-center text-[10px] text-muted-foreground">
                tap to enlarge
              </Text>
            </>
          ) : (
            /*
              Said, not left blank. "No screenshot" is itself one of the six
              checks and the strongest reason on the card to look harder before
              approving — an empty square would read as an image that failed to
              load, which is a different and much less alarming fact.
            */
            <View className="h-[76px] w-[76px] items-center justify-center gap-1 rounded-xl border border-dashed border-border">
              <Glyph
                color={colors.mutedForeground}
                name="image"
                size={20}
              />
              <Text className="text-center text-[10px] text-muted-foreground">
                no proof
              </Text>
            </View>
          )}
        </View>

        <View className="flex-1 gap-0.5">
          <Text numberOfLines={1} variant="subtitle">
            {claim.residentName || "Unnamed resident"}
          </Text>

          {room ? (
            <Text numberOfLines={1} variant="caption">
              {room}
            </Text>
          ) : null}

          <Text className="text-sm text-foreground">
            <Text className="text-sm font-semibold text-foreground">
              Claims {formatMoney(claim.amount)}
            </Text>
            {` · ${humanizeEnum(claim.method)} · ${dates.ago(claim.occurredAt)}`}
          </Text>

          {claim.transactionCode ? (
            <Text numberOfLines={1} variant="caption">
              Txn {claim.transactionCode}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="gap-1.5 border-t border-border pt-3">
        {failed.map((check) => (
          <View className="flex-row items-start gap-2" key={check.key}>
            <Glyph
              color={colors.warning}
              name="alert-circle"
              size={14}
              style={{ marginTop: 1 }}
            />
            <Text className="flex-1" variant="caption">
              <Text className="text-xs font-semibold text-foreground">
                {CHECK_LABEL[check.key]}
              </Text>
              {` — ${check.detail}`}
            </Text>
          </View>
        ))}

        {passed > 0 ? (
          <View className="flex-row items-start gap-2">
            <Glyph
              color={colors.success}
              name="checkmark-circle"
              size={14}
              style={{ marginTop: 1 }}
            />
            <Text className="flex-1" variant="caption">
              {failed.length === 0
                ? "Every check passed"
                : `${passed} other check(s) passed`}
            </Text>
          </View>
        ) : null}
      </View>

      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          label="Approve"
          loading={busy}
          onPress={() =>
            void actions.run(
              row.id,
              () => approveClaim(row.id),
              `Verified ${formatMoney(claim.amount)}`,
            )
          }
          size="sm"
        />
        <Button
          className="flex-1"
          disabled={busy}
          label="Reject"
          onPress={() => actions.ask("reject", row)}
          size="sm"
          variant="outline"
        />
      </View>
    </Card>
  );
}
