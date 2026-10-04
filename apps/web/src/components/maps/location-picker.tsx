"use client";

import { Crosshair, Link2, Loader2, MapPin, Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { parseMapLink } from "@/lib/maps/map-links";
import type { AddressParts, Coordinates, GeocodeResult } from "@/lib/maps/types";

/** Kathmandu — only used when a hostel has no pin and no address to geocode. */
const FALLBACK_CENTER: Coordinates = { lat: 27.7172, lng: 85.324 };

const DraggablePinMap = dynamic(
  () => import("./draggable-pin-map").then((mod) => mod.DraggablePinMap),
  {
    loading: () => <div className="h-full w-full animate-pulse bg-muted" />,
    ssr: false,
  },
);

export type LocationPickerValue = {
  coordinates: Coordinates | null;
  /** MANUAL once the admin has moved the pin or accepted a search result. */
  source: "MANUAL" | "GEOCODED";
};

/** The address fields the picker resolved, in the order it fills them in. */
const PART_LABELS: Array<[keyof AddressParts, string]> = [
  ["address", "street address"],
  ["area", "area"],
  ["city", "city"],
  ["province", "province"],
];

function describeParts(parts: AddressParts): string {
  const filled = PART_LABELS.filter(([key]) => Boolean(parts[key])).map(
    ([, label]) => label,
  );
  return filled.length > 0 ? filled.join(", ") : "";
}

/**
 * Lets a hostel admin place their hostel exactly. Four ways in: paste a Google
 * Maps link, type a place and pick from the results, press "use my current
 * location", or drag the pin.
 *
 * Any of those marks the value MANUAL, which stops the server-side geocoder
 * from moving the pin back to the area centroid on the next save. Everything
 * except a plain drag also reports the resolved address upward, so the address
 * fields above the map describe the same place the pin sits on.
 */
export function LocationPicker({
  addressHint,
  initialQuery,
  lookupPath = "/api/v1/hostel-admin/profile/geocode",
  onChange,
  onResolvedAddress,
  value,
}: {
  /** Current address fields — seeds the box and disambiguates bare names. */
  addressHint: string;
  initialQuery?: string;
  /**
   * The geocode endpoint to search through. Two desks place this same pin — a
   * hostel admin on their own listing, and a team agent registering a hostel
   * that has no id to authorise against yet — so the guard differs while the
   * lookup behind it does not (`modules/hostels/hostel-geocode.service.ts`).
   */
  lookupPath?: string;
  onChange: (next: LocationPickerValue) => void;
  /** Called when a lookup produced an address for the placed pin. */
  onResolvedAddress?: (parts: AddressParts) => void;
  value: LocationPickerValue;
}) {
  // null means "the admin has not typed yet", so the box shows the address
  // fields. Derived rather than synced in an effect — the hint arrives after
  // the profile loads, and copying it into state would fight the admin's typing.
  const [typedQuery, setTypedQuery] = useState<string | null>(null);
  const query = typedQuery ?? initialQuery ?? addressHint;
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState("");
  // Ignore responses from a search the admin has already typed past.
  const requestIdRef = useRef(0);

  const coordinates = value.coordinates;

  /** Move the pin without disturbing the results list. */
  const applyPin = useCallback(
    (next: Coordinates) => {
      onChange({ coordinates: next, source: "MANUAL" });
    },
    [onChange],
  );

  /** Push a resolved address up to the form, and say so. */
  const applyAddress = useCallback(
    (parts: AddressParts | undefined, prefix: string) => {
      const filled = parts ? describeParts(parts) : "";
      if (!parts || !filled) {
        setNote(prefix);
        return;
      }

      onResolvedAddress?.(parts);
      setNote(`${prefix} Address fields updated (${filled}).`);
    },
    [onResolvedAddress],
  );

  const search = useCallback(
    async (term: string) => {
      const trimmed = term.trim();
      if (trimmed.length < 2) {
        setNote("Paste a Google Maps link, or type at least 2 characters.");
        return;
      }

      const isLink = parseMapLink(trimmed) !== null;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setSearching(true);
      setNote(isLink ? "Reading the map link…" : "");
      try {
        const response = await browserApi<{ results: GeocodeResult[] }>(
          // The address fields go along as context: an admin searching their
          // own hostel's name gives a geocoder nothing to work with otherwise.
          `${lookupPath}?q=${encodeURIComponent(trimmed)}` +
            (addressHint ? `&near=${encodeURIComponent(addressHint)}` : ""),
        );
        if (requestIdRef.current !== requestId) {
          return;
        }

        const [best] = response.results;
        if (!best) {
          setResults([]);
          setNote(
            isLink
              ? "That link did not contain a location. Open it in Google Maps, then copy the link from the Share panel."
              : "No match. Try a nearby landmark, then drag the pin.",
          );
          return;
        }

        // Searching should move the map, not just list places to click. The
        // list stays open underneath so a different match is one click away.
        applyPin(best.coordinates);

        if (isLink) {
          // A pasted pin is unambiguous — one result, no list to choose from.
          setResults([]);
          applyAddress(best.address, "Pinned to your map link.");
          return;
        }

        setResults(response.results);
        applyAddress(
          best.address,
          response.results.length > 1
            ? "Moved to the closest match — pick another below, or drag the pin onto your building."
            : "Moved to the match — drag the pin onto your building to fine-tune.",
        );
      } catch (error) {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setNote(error instanceof Error ? error.message : "Location search failed.");
      } finally {
        if (requestIdRef.current === requestId) {
          setSearching(false);
        }
      }
    },
    [addressHint, applyAddress, applyPin, lookupPath],
  );

  const choose = useCallback(
    (result: GeocodeResult) => {
      applyPin(result.coordinates);
      setResults([]);
      applyAddress(result.address, "Pin moved.");
    },
    [applyAddress, applyPin],
  );

  /** Ask the server what address a placed pin sits on. */
  const describePin = useCallback(
    async (next: Coordinates, prefix: string) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      try {
        const response = await browserApi<{ results: GeocodeResult[] }>(
          `${lookupPath}?lat=${next.lat}&lng=${next.lng}`,
        );
        if (requestIdRef.current !== requestId) {
          return;
        }
        applyAddress(response.results[0]?.address, prefix);
      } catch {
        // The pin is valid without its address text; keep the placement note.
        if (requestIdRef.current === requestId) {
          setNote(prefix);
        }
      }
    },
    [applyAddress, lookupPath],
  );

  const useDeviceLocation = useCallback(() => {
    if (!("geolocation" in navigator) || !window.isSecureContext) {
      setNote(
        window.isSecureContext
          ? "This browser cannot share a location. Search or drag the pin instead."
          : "Location only works over https. Search or drag the pin instead.",
      );
      return;
    }

    setLocating(true);
    setNote("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        setResults([]);
        const next = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        applyPin(next);
        setNote("Pinned to your device location — drag to fine-tune.");
        void describePin(next, "Pinned to your device location.");
      },
      (error) => {
        setLocating(false);
        setNote(
          error.code === error.PERMISSION_DENIED
            ? "Location is blocked for this site. Allow it from the lock icon in the address bar, or search or drag the pin instead."
            : "Could not get a location fix. Turn on location services, or search or drag the pin instead.",
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  }, [applyPin, describePin]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="flex min-w-56 flex-1 items-center rounded-md border border-border bg-surface">
          <Search className="ml-3 size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search a place, landmark, or paste a Google Maps link"
            className="h-11 w-full bg-transparent px-3 text-sm outline-none"
            onChange={(event) => setTypedQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // The picker lives inside the profile form; Enter here must
                // search, not submit the whole profile.
                event.preventDefault();
                void search(query);
              }
            }}
            onPaste={(event) => {
              // A pasted map link has exactly one meaning, so resolve it
              // immediately rather than making the admin press Search too.
              const pasted = event.clipboardData.getData("text").trim();
              if (!pasted || !parseMapLink(pasted)) {
                return;
              }
              event.preventDefault();
              setTypedQuery(pasted);
              void search(pasted);
            }}
            placeholder="Paste a Google Maps link, or search a place or landmark"
            value={query}
          />
        </div>
        <Button
          className="h-11"
          loading={searching}
          onClick={() => void search(query)}
          type="button"
          variant="outline"
        >
          Search
        </Button>
        <Button
          className="h-11"
          disabled={locating}
          onClick={useDeviceLocation}
          type="button"
          variant="outline"
        >
          {locating ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Crosshair className="mr-2 size-4" />
          )}
          Use my location
        </Button>
      </div>

      {/* Beside the buttons, not under the map: a refusal printed below a
          288px map read as "nothing happened". */}
      {note ? (
        <p aria-live="polite" className="text-xs font-semibold text-foreground">
          {note}
        </p>
      ) : null}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Link2 className="mt-0.5 size-3.5 shrink-0" />
        <span>
          On Google Maps, find your hostel, tap <strong>Share</strong> →{" "}
          <strong>Copy link</strong>, and paste it above. Short{" "}
          <code className="font-mono">maps.app.goo.gl</code> links work too.
        </span>
      </p>

      {results.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {results.map((result) => (
            <li key={`${result.coordinates.lat},${result.coordinates.lng}`}>
              <button
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
                onClick={() => choose(result)}
                type="button"
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-brand-teal" />
                <span className="text-foreground">{result.label ?? "Unnamed place"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="h-72 overflow-hidden rounded-lg border border-border">
        <DraggablePinMap
          onChange={(next) => onChange({ coordinates: next, source: "MANUAL" })}
          value={coordinates ?? FALLBACK_CENTER}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="font-medium text-muted-foreground">
          {coordinates ? (
            <>
              Pin at{" "}
              <span className="font-mono text-foreground">
                {coordinates.lat.toFixed(6)}, {coordinates.lng.toFixed(6)}
              </span>
              {value.source === "MANUAL" ? (
                <span className="ml-2 rounded bg-brand-teal-soft/40 px-1.5 py-0.5 font-semibold text-brand-teal">
                  Placed by you
                </span>
              ) : (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-semibold text-muted-foreground">
                  Estimated from address
                </span>
              )}
            </>
          ) : (
            "No pin yet — search for your hostel or drag the marker onto it."
          )}
        </p>
        {coordinates && value.source === "MANUAL" ? (
          <button
            className="font-semibold text-muted-foreground underline hover:text-foreground"
            onClick={() => onChange({ coordinates, source: "GEOCODED" })}
            type="button"
          >
            Let the address decide again
          </button>
        ) : null}
      </div>
    </div>
  );
}
