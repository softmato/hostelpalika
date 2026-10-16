import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";

import { SignatureInk } from "@/components/signature-pad";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { APP_NAME } from "@/constants/branding";
import { CARD_ASPECT, CARD_COLORS, type IdCard } from "@/lib/id-card";
import { signatureStrokes } from "@/lib/signature";

/**
 * One face of the ID card.
 *
 * ## Every colour here is a literal, on purpose
 *
 * This is the only component in the app that ignores the theme. The card is a
 * *document*: `apps/web` paints these same values onto a canvas for the preview,
 * the downloaded PNG and the image attached to the holder's email, and the reason
 * given there applies just as much on a phone — an ID card that turns dark
 * because the viewer had dark mode on is not an ID card. A warden comparing the
 * card on a resident's screen against the one in their inbox has to see the same
 * document.
 *
 * ## It is the same drawing, not a similar one
 *
 * This used to keep the web's order and copy but lay them out with flexbox, and
 * the result did not read as the same card: the header was a rounded rectangle in
 * mid-green where the web has a dark block that bows downward, the portrait sat
 * below that block instead of straddling it, the footer was a flat accent bar
 * instead of the dark crown, and the detail rows lost their colon column. Beside
 * the browser it looked like a different issuer.
 *
 * So it now works the way the canvas does. `platform-id-card.ts` draws on a fixed
 * 640×1000 grid; this measures the card once and places every element at those
 * same coordinates times `s = width / 640`. Font sizes, gaps, radii and the curve
 * geometry all scale with it — which is also why nothing here is a theme token or
 * a `className`. The web's own preview renders that grid at about 375 px, which
 * is roughly a phone's width, so the two land within a pixel of each other.
 *
 * The one thing a canvas has that React Native does not is an arbitrary path, and
 * the header and footer are bezier curves. {@link Sweep} explains what stands in
 * for them.
 */

/** The web's drawing grid. Every coordinate below is in these units. */
const CARD_W = 640;

/* Palette, straight from `platform-id-card.ts`. */
const { brand: BRAND, hairline: HAIRLINE, ink: INK, muted: MUTED, paper: PAPER } =
  CARD_COLORS;

/** The portrait placeholder's wash — `#e4f2ea` in `drawPortrait`. */
const PLACEHOLDER = "#e4f2ea";

/** `platform-id-card.ts`'s `SIGNATURE_BOX`, in card units. */
const SIGNATURE_BOX = { height: 80, width: 240, x: 338, y: 726 };

export function IdCardFace({
  card,
  face,
  photo,
  qrDataUrl,
  siteLabel,
}: {
  card: IdCard;
  face: "back" | "front";
  /** An `<Image source>` for the holder's portrait, or null. */
  photo: { headers?: Record<string, string>; uri: string } | null;
  /** `data:` PNG from the server. **Null is a real case** — see below. */
  qrDataUrl: string | null;
  siteLabel: string;
}) {
  // Measured rather than assumed: the card is `width: "100%"` inside whatever
  // padding the screen gives it, and every coordinate below is a fraction of it.
  const [width, setWidth] = useState(0);
  const s = width / CARD_W;

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{
        aspectRatio: CARD_ASPECT,
        backgroundColor: PAPER,
        borderColor: HAIRLINE,
        borderRadius: 30 * s,
        borderWidth: s > 0 ? 1 : 0,
        overflow: "hidden",
        width: "100%",
      }}
    >
      {s <= 0 ? null : face === "front" ? (
        <CardFront card={card} photo={photo} qrDataUrl={qrDataUrl} s={s} />
      ) : (
        <CardBack card={card} s={s} siteLabel={siteLabel} />
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The primitives the canvas has and React Native does not                    */
/* -------------------------------------------------------------------------- */

/**
 * The header's downward bow, and the footer's upward crown.
 *
 * `drawHeaderSweep` fills a bezier whose two control points sit `bulge` below the
 * edge. There is no path API here, so this is an **ellipse clipped by the card**,
 * fitted to that bezier rather than guessed at. Two things have to agree for the
 * shapes to be indistinguishable — how deep the curve dips at the middle, and how
 * steeply it leaves the card's edge:
 *
 * - the bezier's depth at the middle is `0.75 × bulge`;
 * - its slope where it meets the edge is `bulge ÷ (0.28 × CARD_W)`.
 *
 * An ellipse running about 43% wider than the card — semi-axis `CARD_W / 2 / 0.7`,
 * so only its flatter middle is ever visible — matches that slope exactly when its
 * vertical semi-axis is `3.5 ×` the depth. Both numbers fall out of the same
 * algebra, which is why the constant is 0.7 rather than something that looked
 * about right.
 *
 * Drawn as a circle squashed by `scaleY`, because a numeric `borderRadius` can
 * only ever describe a circle or a stadium, never an ellipse.
 */
const SWEEP_U = 0.7;
const SWEEP_A = CARD_W / 2 / SWEEP_U;

function Sweep({
  bulge,
  color,
  edgeY,
  s,
  up = false,
}: {
  /** The web variant's `bulge`, in card units. Zero draws a straight edge. */
  bulge: number;
  color: string;
  /** Where the edge meets the left and right sides of the card. */
  edgeY: number;
  s: number;
  /** Footers bow upward. */
  up?: boolean;
}) {
  const depth = bulge * 0.75;
  // A provider's card is flat (`bulge: 0`); it still needs a rectangle's worth of
  // height or `scaleY` collapses the view to nothing.
  const b = Math.max(depth * 3.5, 0.5);
  const centerY = up ? edgeY - depth + b : edgeY + depth - b;

  return (
    <View
      style={{
        backgroundColor: color,
        borderRadius: SWEEP_A * s,
        height: SWEEP_A * 2 * s,
        left: (CARD_W / 2 - SWEEP_A) * s,
        position: "absolute",
        top: (centerY - SWEEP_A) * s,
        transform: [{ scaleY: b / SWEEP_A }],
        width: SWEEP_A * 2 * s,
      }}
    />
  );
}

/**
 * One `fillText` call.
 *
 * Canvas positions text by its **baseline**; React Native positions a box. With a
 * line height of `1.15em` the glyphs sit centred in it, which puts the baseline
 * `0.875em` below the box's top — so that is what is subtracted to land on the
 * web's y coordinate. `includeFontPadding` is Android-only and would otherwise
 * add font-dependent slack above the ascender, shifting the whole line.
 *
 * `left` and `right` are the canvas x of each edge, so a line is given the same
 * room the web's `ellipsize` measures against and truncates in the same place.
 */
function Line({
  align = "left",
  baseline,
  children,
  color,
  left,
  right,
  s,
  size,
  spacing = 0,
  weight,
}: {
  align?: "center" | "left";
  baseline: number;
  children: string;
  color: string;
  left: number;
  right: number;
  s: number;
  size: number;
  spacing?: number;
  weight: "500" | "600" | "700" | "800";
}) {
  const fontSize = size * s;

  return (
    <Text
      numberOfLines={1}
      style={{
        color,
        fontSize,
        fontWeight: weight,
        includeFontPadding: false,
        left: left * s,
        letterSpacing: spacing * s,
        lineHeight: fontSize * 1.15,
        position: "absolute",
        right: (CARD_W - right) * s,
        textAlign: align,
        top: baseline * s - fontSize * 0.875,
      }}
    >
      {children}
    </Text>
  );
}

/** A straight `stroke()`ed rule. */
function Rule({
  dashed = false,
  from,
  s,
  to,
  y,
}: {
  dashed?: boolean;
  from: number;
  s: number;
  to: number;
  y: number;
}) {
  return (
    <View
      style={{
        borderColor: HAIRLINE,
        // Dashed via a border, since React Native has no `setLineDash`.
        borderStyle: dashed ? "dashed" : "solid",
        borderTopWidth: 2 * s,
        left: from * s,
        position: "absolute",
        top: y * s,
        width: (to - from) * s,
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Shared chrome                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `drawHeaderSweep` then `drawBrandLockup`.
 *
 * The accent line trailing the curve is three stacked sweeps rather than a
 * stroke: an accent one 23 below the edge, a paper one 17 below covering all but
 * its lowest sliver, and the ink one on top closing the header — which leaves
 * exactly the 6-unit arc the canvas strokes. 17 and 23 rather than 20 and 26
 * because `ctx.stroke` centres its line width on the path, so the web's 6-unit
 * line straddles its 20-unit offset instead of hanging below it.
 */
function Header({
  accent,
  bulge,
  centerY,
  edgeY,
  s,
  title,
}: {
  accent: string;
  bulge: number;
  centerY: number;
  edgeY: number;
  s: number;
  title: string;
}) {
  return (
    <>
      <Sweep bulge={bulge} color={accent} edgeY={edgeY + 23} s={s} />
      <Sweep bulge={bulge} color={PAPER} edgeY={edgeY + 17} s={s} />
      <View
        style={{
          backgroundColor: INK,
          height: edgeY * s,
          left: 0,
          position: "absolute",
          right: 0,
          top: 0,
        }}
      />
      <Sweep bulge={bulge} color={INK} edgeY={edgeY} s={s} />

      <View
        style={{
          alignItems: "center",
          left: 0,
          position: "absolute",
          right: 0,
          top: (centerY - 22) * s,
        }}
      >
        <Glyph color={accent} name="home" size={44 * s} />
      </View>

      <Line
        align="center"
        baseline={centerY + 60}
        color={PAPER}
        left={40}
        right={CARD_W - 40}
        s={s}
        size={30}
        spacing={3}
        weight="800"
      >
        {APP_NAME.toUpperCase()}
      </Line>

      <Line
        align="center"
        baseline={centerY + 88}
        color={accent}
        left={40}
        right={CARD_W - 40}
        s={s}
        size={14}
        spacing={2}
        weight="600"
      >
        {title}
      </Line>
    </>
  );
}

/**
 * `drawFooterSweep(946)` — the dark crown that closes both faces.
 *
 * 986, not 946: the web's argument is the *control* line, and its path meets the
 * card's sides 40 below it, 70 under the control points. Those are the two
 * numbers {@link Sweep} needs.
 */
function Footer({ s }: { s: number }) {
  return <Sweep bulge={70} color={INK} edgeY={986} s={s} up />;
}

/* -------------------------------------------------------------------------- */
/* Front                                                                      */
/* -------------------------------------------------------------------------- */

function CardFront({
  card,
  photo,
  qrDataUrl,
  s,
}: {
  card: IdCard;
  photo: { headers?: Record<string, string>; uri: string } | null;
  qrDataUrl: string | null;
  s: number;
}) {
  return (
    <>
      <Header
        accent={card.accent}
        bulge={card.bulge.front}
        centerY={96}
        edgeY={262}
        s={s}
        title={card.title}
      />

      <Portrait accent={card.accent} fullName={card.fullName} photo={photo} s={s} />

      <Line
        align="center"
        baseline={478}
        color={INK}
        left={40}
        right={CARD_W - 40}
        s={s}
        size={38}
        weight="800"
      >
        {card.fullName}
      </Line>

      <Line
        align="center"
        baseline={510}
        color={BRAND}
        left={48}
        right={CARD_W - 48}
        s={s}
        size={19}
        spacing={2}
        weight="700"
      >
        {card.role.toUpperCase()}
      </Line>

      <Rule from={120} s={s} to={CARD_W - 120} y={538} />

      {card.rows.map(([label, value], index) => {
        const baseline = 578 + index * 38;

        return (
          <View key={label}>
            <Line
              baseline={baseline}
              color={BRAND}
              left={78}
              right={216}
              s={s}
              size={17}
              weight="800"
            >
              {label}
            </Line>
            <Line
              baseline={baseline}
              color={MUTED}
              left={216}
              right={232}
              s={s}
              size={17}
              weight="600"
            >
              :
            </Line>
            <Line
              baseline={baseline}
              color={INK}
              left={232}
              right={CARD_W - 70}
              s={s}
              size={17}
              weight="600"
            >
              {value}
            </Line>
          </View>
        );
      })}

      <Qr qrDataUrl={qrDataUrl} residentId={card.residentId} s={s} />

      <Footer s={s} />

      {/*
        Printed on the crown, in paper, and after it — the QR block ends 11 units
        above the sweep, so there is no white left to caption into. The web makes
        the same call.
      */}
      <Line
        align="center"
        baseline={952}
        color={PAPER}
        left={40}
        right={CARD_W - 40}
        s={s}
        size={14}
        spacing={1}
        weight="600"
      >
        {qrDataUrl ? "SCAN TO SHARE MY DETAILS" : "READ THIS ID OUT INSTEAD"}
      </Line>
    </>
  );
}

/** First and last initial, as `initialsOf` does — not just the first letter. */
function initialsOf(fullName: string) {
  const parts = fullName.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";

  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * `drawPortrait` at (320, 322), radius 94.
 *
 * The white disc is 105 across and carries the accent ring on its outer 4 units,
 * which is what makes the portrait read as a cut-out straddling the header sweep
 * rather than a photo sitting below it.
 */
function Portrait({
  accent,
  fullName,
  photo,
  s,
}: {
  accent: string;
  fullName: string;
  photo: { headers?: Record<string, string>; uri: string } | null;
  s: number;
}) {
  const ring = 105;
  const radius = 94;

  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: PAPER,
        borderColor: accent,
        borderRadius: ring * s,
        borderWidth: 4 * s,
        height: ring * 2 * s,
        justifyContent: "center",
        left: (CARD_W / 2 - ring) * s,
        position: "absolute",
        top: (322 - ring) * s,
        width: ring * 2 * s,
      }}
    >
      <View
        style={{
          alignItems: "center",
          backgroundColor: PLACEHOLDER,
          borderRadius: radius * s,
          height: radius * 2 * s,
          justifyContent: "center",
          overflow: "hidden",
          width: radius * 2 * s,
        }}
      >
        {photo ? (
          <Image
            contentFit="cover"
            source={photo}
            style={{ height: "100%", width: "100%" }}
          />
        ) : (
          // Initials, not a generic silhouette: a card with a grey person icon
          // reads as a card that failed to load rather than one with no photo.
          <Text
            style={{
              color: BRAND,
              fontSize: radius * 0.8 * s,
              fontWeight: "800",
              includeFontPadding: false,
            }}
          >
            {initialsOf(fullName)}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * The QR in its paper card, or the typed id when the server could not render one.
 *
 * `getResidentIdentityQr` wraps its `qrcode` import in a `try` and returns
 * **`null` with a 200** on failure, so this is a real state and not a loading
 * one. The id in large caps is the manual-entry path the server's own comment
 * points at, so the card still works at a desk.
 */
function Qr({
  qrDataUrl,
  residentId,
  s,
}: {
  qrDataUrl: string | null;
  residentId: string;
  s: number;
}) {
  const size = 158;

  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: PAPER,
        borderColor: HAIRLINE,
        borderRadius: 16 * s,
        borderWidth: 2 * s,
        height: (size + 24) * s,
        justifyContent: "center",
        left: ((CARD_W - size) / 2 - 12) * s,
        position: "absolute",
        top: (752 - 12) * s,
        width: (size + 24) * s,
      }}
    >
      {qrDataUrl ? (
        <Image
          contentFit="contain"
          source={{ uri: qrDataUrl }}
          style={{ height: size * s, width: size * s }}
        />
      ) : (
        <Text
          style={{
            color: INK,
            fontSize: 22 * s,
            fontWeight: "800",
            includeFontPadding: false,
            letterSpacing: 2 * s,
            textAlign: "center",
          }}
        >
          {residentId}
        </Text>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Back                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The back is the one face the web lays out by flowing text, so this does too:
 * `drawBack` wraps each bullet and advances `y` by however many lines it took,
 * which no fixed coordinate can stand in for. The block starts at the web's y and
 * keeps its sizes, line height and spacing; the signature panel below it is fixed
 * on the canvas and is fixed here.
 */
function CardBack({
  card,
  s,
  siteLabel,
}: {
  card: IdCard;
  s: number;
  siteLabel: string;
}) {
  return (
    <>
      <Header
        accent={card.accent}
        bulge={card.bulge.back}
        centerY={62}
        edgeY={168}
        s={s}
        title={card.title}
      />

      <Line
        baseline={336}
        color={BRAND}
        left={62}
        right={CARD_W - 62}
        s={s}
        size={20}
        spacing={1}
        weight="800"
      >
        HOW THIS CARD WORKS
      </Line>

      <View
        style={{
          left: 62 * s,
          position: "absolute",
          top: 363 * s,
          width: (CARD_W - 124) * s,
        }}
      >
        {card.backBullets.map((bullet) => (
          <View
            key={bullet}
            style={{
              flexDirection: "row",
              marginBottom: 18 * s,
              paddingLeft: 2 * s,
            }}
          >
            <View
              style={{
                backgroundColor: card.accent,
                borderRadius: 6 * s,
                height: 12 * s,
                marginTop: 5 * s,
                width: 12 * s,
              }}
            />
            <Text
              style={{
                color: MUTED,
                flex: 1,
                fontSize: 16 * s,
                fontWeight: "500",
                includeFontPadding: false,
                lineHeight: 24 * s,
                marginLeft: 16 * s,
              }}
            >
              {bullet}
            </Text>
          </View>
        ))}

        <View
          style={{ borderColor: HAIRLINE, borderTopWidth: 2 * s, marginTop: 23 * s }}
        />

        <Text
          style={{
            color: BRAND,
            fontSize: 14 * s,
            fontWeight: "800",
            includeFontPadding: false,
            letterSpacing: 2 * s,
            marginTop: 38 * s,
          }}
        >
          {card.idLabel}
        </Text>

        <Text
          style={{
            color: INK,
            fontSize: 30 * s,
            fontWeight: "800",
            includeFontPadding: false,
            letterSpacing: 2 * s,
            marginTop: 8 * s,
          }}
        >
          {card.residentId}
        </Text>

        <Text
          style={{
            color: MUTED,
            fontSize: 15 * s,
            fontWeight: "500",
            includeFontPadding: false,
            marginTop: 9 * s,
          }}
        >
          Issued {card.issuedOn}
        </Text>
      </View>

      {/*
        The web's `SIGNATURE_BOX` — the right-hand column, since the id and
        issue date on the left run down to where the ink would be.
      */}
      {card.signature ? (
        <View
          style={{
            height: SIGNATURE_BOX.height * s,
            left: SIGNATURE_BOX.x * s,
            position: "absolute",
            top: SIGNATURE_BOX.y * s,
            width: SIGNATURE_BOX.width * s,
          }}
        >
          <SignatureInk
            color={INK}
            height={SIGNATURE_BOX.height * s}
            strokes={signatureStrokes(card.signature)}
            width={SIGNATURE_BOX.width * s}
          />
        </View>
      ) : null}

      <Rule
        dashed
        from={SIGNATURE_BOX.x}
        s={s}
        to={SIGNATURE_BOX.x + SIGNATURE_BOX.width}
        y={812}
      />

      <Line
        baseline={838}
        color={MUTED}
        left={SIGNATURE_BOX.x}
        right={CARD_W - 62}
        s={s}
        size={14}
        weight="600"
      >
        Cardholder signature
      </Line>

      <Line
        baseline={892}
        color={INK}
        left={62}
        right={CARD_W - 62}
        s={s}
        size={15}
        weight="700"
      >
        {siteLabel}
      </Line>

      <Footer s={s} />
    </>
  );
}
