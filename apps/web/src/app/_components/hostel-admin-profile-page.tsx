"use client";

import {
  Building2,
  Home,
  ImagePlus,
  LayoutDashboard,
  Loader2,
  MapPin,
  Phone,
  ShieldAlert,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import { EmptyState, Input, Panel, Select, TextArea } from "@/app/_components/shared-ui";
import {
  LocationPicker,
  type LocationPickerValue,
} from "@/components/maps/location-picker";
import { useMediaViewer } from "@/components/media-viewer";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { photosOfKind } from "@/lib/hostel-photos";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadFiles } from "@/lib/uploads/uploader";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import {
  csvField,
  DemoDataBadge,
  field,
  Hostel,
  Message,
  numberField,
  optionalField,
  PageHeader,
} from "./core-portal-shared";

const NAME_CHANGE_LIMIT = 2;
const PHOTO_LIMITS = { EXTERIOR: 3, INTERIOR: 20 } as const;

/** The address inputs, controlled so the map picker can write into them. */
type AddressFields = {
  address: string;
  area: string;
  city: string;
  province: string;
};

type SectionId =
  | "overview"
  | "identity"
  | "location"
  | "contact"
  | "photos"
  | "requests";

type SectionDef = {
  description: string;
  icon: LucideIcon;
  id: SectionId;
  label: string;
};

/**
 * Order matters — this is the left rail, read top to bottom as "what is this
 * hostel / where is it / how do we reach it / what does it look like".
 *
 * **Rooms & Pricing and Food used to sit between Contact and Photos.** Both were
 * a second, weaker copy of a screen that already owns the data — room types and
 * rent belong to Rooms & Beds and the fee schedule, meals to Food & Menu — and
 * two editors for one field is how the two disagree. Facilities and house rules
 * were the only things in either section with no other home, so they moved up
 * into Identity rather than leaving with it.
 */
const SECTIONS: SectionDef[] = [
  {
    description: "Read-only summary of what the platform has on file.",
    icon: LayoutDashboard,
    id: "overview",
    label: "Overview",
  },
  {
    description: "Name, building details, facilities and rules for your listing.",
    icon: Building2,
    id: "identity",
    label: "Identity",
  },
  {
    description: "Address and the exact map pin seekers navigate to.",
    icon: MapPin,
    id: "location",
    label: "Location",
  },
  {
    description: "How enquiring students and parents reach you.",
    icon: Phone,
    id: "contact",
    label: "Contact",
  },
  {
    description: "Exterior and interior photos for the public gallery.",
    icon: ImagePlus,
    id: "photos",
    label: "Photos",
  },
  {
    description: "Changes the platform team has to verify before they apply.",
    icon: ShieldAlert,
    id: "requests",
    label: "Locked Changes",
  },
];

/** Sections whose fields belong to the single profile form and one save press. */
const FORM_SECTIONS = new Set<SectionId>(["identity", "location", "contact"]);

/**
 * A file the admin just picked, rendered from a local object URL so the grid
 * fills in on click. It blurs under a spinner until its upload lands.
 */
type PendingPhoto = {
  id: string;
  previewUrl: string;
  uploaded?: boolean;
};

/**
 * One block inside the right-hand panel. Inactive blocks stay mounted but
 * hidden so their inputs remain part of the form — switching sections must
 * never quietly drop edits the admin already typed elsewhere.
 */
function SectionBody({
  active,
  children,
  section,
}: {
  active: boolean;
  children: ReactNode;
  section: SectionDef;
}) {
  return (
    <div className={active ? "space-y-4" : "hidden"} hidden={!active}>
      <div>
        <h2 className="font-heading text-base font-bold text-foreground">
          {section.label}
        </h2>
        <p className="mt-0.5 text-xs font-medium text-muted-foreground">
          {section.description}
        </p>
      </div>
      {children}
    </div>
  );
}

/** Groups related settings rows under a quiet heading. */
function FieldGroup({
  children,
  hint,
  title,
}: {
  children: ReactNode;
  hint?: string;
  title: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-bold text-foreground">{title}</h3>
      {hint ? (
        <p className="mt-0.5 text-xs font-medium text-muted-foreground">{hint}</p>
      ) : null}
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * One settings line: label and description on the left, the control on the
 * right, separated from its neighbours by a hairline. Stacks on narrow screens
 * so the control never gets squeezed.
 */
function SettingsRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border/60 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="sm:max-w-[52%]">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs font-normal text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="w-full sm:w-[300px] sm:shrink-0">{children}</div>
    </div>
  );
}

/**
 * A settings line whose control needs the full width (long text, the map).
 * Same hairline rhythm as SettingsRow, but stacked.
 */
function SettingsBlock({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="border-b border-border/60 py-3.5 last:border-b-0">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {description ? (
        <p className="mt-0.5 text-xs font-normal text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

export const HostelAdminProfilePageContent = memo(
  function HostelAdminProfilePageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [saving, setSaving] = useState(false);
    const [uploadingKind, setUploadingKind] = useState<"" | "EXTERIOR" | "INTERIOR">("");
    const [pendingByKind, setPendingByKind] = useState<Record<string, PendingPhoto[]>>(
      {},
    );
    // Photos whose delete is in flight — mirrored on the upload treatment, so a
    // removal blurs under a spinner instead of sitting crisp until the round trip.
    const [deletingIds, setDeletingIds] = useState<string[]>([]);
    const { open: openViewer } = useMediaViewer();
    const [sendingRequest, setSendingRequest] = useState(false);
    const [activeSection, setActiveSection] = useState<SectionId>("overview");
    // The admin's unsaved pin, tagged with the hostel it belongs to so a
    // workspace switch cannot carry one hostel's marker onto another.
    const [pinOverride, setPinOverride] = useState<{
      hostelId: string;
      value: LocationPickerValue;
    } | null>(null);
    // The address fields are controlled so the location picker can write into
    // them — placing the pin from a map link or a search result rewrites the
    // address text, otherwise the listing says one place and the map shows
    // another. Same hostel-tagged shape as the pin, for the same reason.
    const [addressDraft, setAddressDraft] = useState<{
      fields: AddressFields;
      hostelId: string;
    } | null>(null);

    // Same cache entry as the Rooms & Beds and Fee Plans screens.
    const profileResource = usePortalResource<{ hostel: Hostel }>(
      hostelAdminEndpoints.profile,
      { errorMessage: "Could not load profile." },
    );

    const hostel = profileResource.data?.hostel ?? null;
    const message = actionMessage || profileResource.message;
    const { refreshAsync: reloadProfile } = profileResource;

    const hostelId = hostel?.id;
    const savedLat = hostel?.location?.lat;
    const savedLng = hostel?.location?.lng;
    const savedSource = hostel?.location?.locationSource;

    // What the picker shows: the admin's unsaved pin if there is one, otherwise
    // whatever the server has. Derived rather than copied into state by an
    // effect, so a background refetch can never silently discard an unsaved drag.
    const location: LocationPickerValue = useMemo(() => {
      if (pinOverride && pinOverride.hostelId === hostelId) {
        return pinOverride.value;
      }

      return {
        coordinates:
          savedLat != null && savedLng != null ? { lat: savedLat, lng: savedLng } : null,
        source: savedSource === "MANUAL" ? "MANUAL" : "GEOCODED",
      };
    }, [hostelId, pinOverride, savedLat, savedLng, savedSource]);

    const setLocation = useCallback(
      (value: LocationPickerValue) => {
        if (hostelId) {
          setPinOverride({ hostelId, value });
        }
      },
      [hostelId],
    );

    // Same derivation as the pin: the admin's unsaved edits if there are any,
    // otherwise the server's copy.
    const savedAddress = hostel?.location;
    const addressFields: AddressFields = useMemo(() => {
      if (addressDraft && addressDraft.hostelId === hostelId) {
        return addressDraft.fields;
      }

      return {
        address: savedAddress?.address ?? "",
        area: savedAddress?.area ?? "",
        city: savedAddress?.city ?? "",
        province: savedAddress?.province ?? "",
      };
    }, [addressDraft, hostelId, savedAddress]);

    const editAddress = useCallback(
      (patch: Partial<AddressFields>) => {
        if (!hostelId) {
          return;
        }
        setAddressDraft((previous) => ({
          fields: {
            ...(previous && previous.hostelId === hostelId
              ? previous.fields
              : {
                  address: savedAddress?.address ?? "",
                  area: savedAddress?.area ?? "",
                  city: savedAddress?.city ?? "",
                  province: savedAddress?.province ?? "",
                }),
            ...patch,
          },
          hostelId,
        }));
      },
      [hostelId, savedAddress],
    );

    /**
     * Address parts the picker resolved for the pin. Only the parts the geocoder
     * actually returned are written — a provider that knows the city but not the
     * street must not blank out a street the admin typed themselves.
     */
    const applyResolvedAddress = useCallback(
      (parts: { address?: string; area?: string; city?: string; province?: string }) => {
        const patch: Partial<AddressFields> = {};
        for (const key of ["address", "area", "city", "province"] as const) {
          const value = parts[key]?.trim();
          if (value) {
            patch[key] = value;
          }
        }

        if (Object.keys(patch).length > 0) {
          editAddress(patch);
        }
      },
      [editAddress],
    );

    const nameLocked = useMemo(
      () =>
        hostel != null &&
        ["APPROVED", "PUBLISHED"].includes(hostel.status ?? "") &&
        (hostel.nameChangeCount ?? 0) >= NAME_CHANGE_LIMIT,
      [hostel],
    );

    // ROOM photos belong to a room type and are managed on the Rooms & Beds
    // screen, so they stay out of both grids here.
    const photosByKind = useMemo(
      () => ({
        EXTERIOR: photosOfKind(hostel?.photos, "EXTERIOR"),
        INTERIOR: photosOfKind(hostel?.photos, "INTERIOR"),
      }),
      [hostel],
    );

    // Seeds the location search box. Deduplicated because admins routinely put
    // the same word in `address` and `area` ("Narephat, Narephat, Kathmandu")
    // and geocoders return nothing at all for the repeated form.
    const addressHint = useMemo(() => {
      const seen = new Set<string>();

      return [
        addressFields.address,
        addressFields.area,
        addressFields.city,
        addressFields.province,
        "Nepal",
      ]
        .map((part) => part?.trim())
        .filter((part): part is string => {
          const key = part?.toLowerCase();
          if (!part || !key || seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .join(", ");
    }, [addressFields]);

    const uploadPhotos = useCallback(
      async (
        event: ChangeEvent<HTMLInputElement>,
        kind: "EXTERIOR" | "INTERIOR",
        freeSlots: number,
      ) => {
        const chosen = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (chosen.length === 0) return;

        // Trim to what still fits rather than letting the server reject the tail
        // of the batch one 422 at a time.
        const files = chosen.slice(0, freeSlots);
        const skipped = chosen.length - files.length;
        const noun = kind === "EXTERIOR" ? "Exterior" : "Interior";

        // Show the picked files straight away, blurred under a spinner, so the
        // grid reacts to the click instead of to the round trip.
        const pending: PendingPhoto[] = files.map((file) => ({
          id: crypto.randomUUID(),
          previewUrl: URL.createObjectURL(file),
        }));

        setPendingByKind((prev) => ({ ...prev, [kind]: pending }));
        setUploadingKind(kind);
        try {
          let added = 0;

          // One file at a time so each preview sharpens as its own upload lands,
          // rather than the whole batch clearing at once. uploadFiles registers
          // every file with the global upload store, so the always-mounted
          // toaster still shows byte-level progress.
          for (const [index, file] of files.entries()) {
            const [outcome] = await uploadFiles([file], {
              accessLevel: "PUBLIC",
              kind: "image",
              label: `${noun} photo`,
              scope: `hostel-photos:${kind}`,
              // Failures already toast; the summary below covers the successes.
              silent: true,
            });

            if (!outcome?.ok || !outcome.result.assetId) {
              // A file that failed should stop pretending it is on its way.
              setPendingByKind((prev) => ({
                ...prev,
                [kind]: (prev[kind] ?? []).filter(
                  (item) => item.id !== pending[index].id,
                ),
              }));
              URL.revokeObjectURL(pending[index].previewUrl);
              continue;
            }

            await browserApi(`${hostelAdminEndpoints.profile}/photos`, {
              body: JSON.stringify({
                fileAssetId: outcome.result.assetId,
                kind,
                // Relative on purpose: this string is persisted, and an origin
                // baked in here follows the photo forever. Uploads made from a
                // dev machine stored http://localhost:3000/... and every
                // visitor to production then requested images from their own
                // machine. The path resolves against whatever host serves it.
                url: `/api/v1/files/${outcome.result.assetId}/url`,
              }),
              method: "POST",
            });
            added += 1;

            // Drop the blur — this one is stored, even though the refreshed list
            // has not come back yet.
            setPendingByKind((prev) => ({
              ...prev,
              [kind]: (prev[kind] ?? []).map((item) =>
                item.id === pending[index].id ? { ...item, uploaded: true } : item,
              ),
            }));
          }

          setActionMessage(
            [
              added > 0
                ? `Added ${added} ${noun.toLowerCase()} photo(s).`
                : `No ${noun.toLowerCase()} photos were added.`,
              skipped > 0
                ? `${skipped} skipped — at most ${PHOTO_LIMITS[kind]} ${noun.toLowerCase()} photo(s).`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
          await reloadProfile();
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not upload photos.",
          );
        } finally {
          // The stored photos are on screen now, so the local previews can go.
          setPendingByKind((prev) => {
            const next = { ...prev };
            delete next[kind];
            return next;
          });
          for (const item of pending) {
            URL.revokeObjectURL(item.previewUrl);
          }
          setUploadingKind("");
        }
      },
      [reloadProfile],
    );

    const deletePhoto = useCallback(
      async (photoId?: string) => {
        if (!photoId) return;
        setDeletingIds((prev) => (prev.includes(photoId) ? prev : [...prev, photoId]));
        try {
          await browserApi(`${hostelAdminEndpoints.profile}/photos/${photoId}`, {
            method: "DELETE",
          });
          setActionMessage("Photo removed.");
          await reloadProfile();
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not remove photo.",
          );
        } finally {
          // The refreshed list has dropped it by now; a failed delete gets its
          // photo back sharp and clickable.
          setDeletingIds((prev) => prev.filter((id) => id !== photoId));
        }
      },
      [reloadProfile],
    );

    const sendChangeRequest = useCallback(async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      setSendingRequest(true);
      try {
        await browserApi(`${hostelAdminEndpoints.profile}/change-request`, {
          body: JSON.stringify({
            changeType: field(form, "changeType"),
            reason: optionalField(form, "reason"),
            requestedValue: field(form, "requestedValue"),
          }),
          method: "POST",
        });
        formElement.reset();
        setActionMessage(
          "Change request sent to the platform team. You'll get an email once it's applied.",
        );
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not send the change request.",
        );
      } finally {
        setSendingRequest(false);
      }
    }, []);

    const save = useCallback(
      async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        // Inactive sections are hidden rather than unmounted, and the browser
        // cannot focus a hidden `required` input to complain about it. So the
        // required checks live here, and a failure jumps to the guilty section.
        const requiredFields: Array<[SectionId, string, string]> = [
          ...(nameLocked
            ? []
            : ([["identity", "name", "Hostel name"]] as Array<
                [SectionId, string, string]
              >)),
          ["location", "area", "Area"],
          ["location", "city", "City"],
        ];

        for (const [section, name, label] of requiredFields) {
          if (!String(form.get(name) ?? "").trim()) {
            setActiveSection(section);
            setActionMessage(`${label} is required.`);
            return;
          }
        }

        setSaving(true);
        try {
          await browserApi(hostelAdminEndpoints.profile, {
            body: JSON.stringify({
              contact: {
                email: optionalField(form, "email"),
                phone: optionalField(form, "phone"),
              },
              description: optionalField(form, "description"),
              facilities: csvField(form, "facilities"),
              hostelType: field(form, "hostelType"),
              location: {
                address: optionalField(form, "address"),
                area: field(form, "area"),
                city: field(form, "city"),
                province: optionalField(form, "province"),
                // Sending the pin with locationSource=MANUAL is what stops the
                // server re-geocoding it back to the area centroid.
                ...(location.coordinates
                  ? {
                      lat: location.coordinates.lat,
                      lng: location.coordinates.lng,
                      locationSource: location.source,
                    }
                  : {}),
              },
              ...(nameLocked ? {} : { name: field(form, "name") }),
              /*
                **`food`, `pricing` and `roomTypes` are deliberately not sent.**
                Their inputs left with the Rooms & Pricing and Food sections, and
                every key in this body is written unconditionally — so keeping
                them here would post an empty room-type list, a blank rent range
                and `hasVeg: false` on every save, quietly wiping fields this form
                no longer even shows. The PATCH schema makes each one optional,
                so omitting them leaves what the hostel already has.
              */
              rules: csvField(form, "rules"),
              totalFloors: numberField(form, "totalFloors"),
              // Written once: the box only shows while empty, and the server ignores a second.
              ...(field(form, "panNumber")
                ? { panNumber: field(form, "panNumber")?.replace(/\s/g, "") }
                : {}),
            }),
            method: "PATCH",
          });
          setActionMessage("Profile saved.");
          await reloadProfile();
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not save profile.",
          );
        } finally {
          setSaving(false);
        }
      },
      [location, nameLocked, reloadProfile],
    );

    const sectionById = useMemo(
      () =>
        Object.fromEntries(SECTIONS.map((section) => [section.id, section])) as Record<
          SectionId,
          SectionDef
        >,
      [],
    );

    if (!hostel) {
      return (
        <div className="mx-auto max-w-[1100px] space-y-6">
          <PageHeader
            description="Real hostel listing fields stored in MongoDB and shown publicly after approval."
            icon={Home}
            title="Hostel Profile"
          />
          <Message value={message} />
          <EmptyState label="Profile is not loaded." />
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-[1100px] space-y-5">
        <PageHeader
          description="Real hostel listing fields stored in MongoDB and shown publicly after approval."
          icon={Home}
          title="Hostel Profile"
        />
        <Message value={message} />
        {hostel.isDemoData ? <DemoDataBadge label={hostel.demoDataLabel} /> : null}

        <div className="grid gap-5 md:grid-cols-[210px_1fr] md:items-start">
          <nav
            aria-label="Profile sections"
            className="flex gap-1 overflow-x-auto md:sticky md:top-4 md:flex-col md:overflow-visible"
          >
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const active = section.id === activeSection;

              return (
                <button
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "flex shrink-0 items-center gap-2.5 rounded-lg bg-role-admin/10 px-3 py-2 text-sm font-semibold text-role-admin"
                      : "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                  }
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  type="button"
                >
                  <Icon className="size-4 shrink-0" />
                  {section.label}
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 space-y-5">
            <Panel className={activeSection === "overview" ? "" : "hidden"}>
              <SectionBody active section={sectionById.overview}>
                <dl className="text-sm">
                  {[
                    ["Status", hostel.status ?? "—"],
                    ["Slug", hostel.slug ?? "—"],
                    ["Type", hostel.hostelType ?? "—"],
                    [
                      "Location",
                      [
                        hostel.location?.address,
                        hostel.location?.area,
                        hostel.location?.city,
                      ]
                        .filter(Boolean)
                        .join(", ") || "—",
                    ],
                    [
                      "Map pin",
                      hostel.location?.lat != null && hostel.location?.lng != null
                        ? `${hostel.location.lat.toFixed(5)}, ${hostel.location.lng.toFixed(5)} (${
                            hostel.location.locationSource === "MANUAL"
                              ? "placed by you"
                              : "estimated from address"
                          })`
                        : "Not set",
                    ],
                    ["Phone", hostel.contact?.phone || "—"],
                    ["Email", hostel.contact?.email || "—"],
                    ["Floors", String(hostel.totalFloors ?? 0)],
                    ["PAN/VAT", hostel.panNumber || "Not given"],
                    ["Total rooms", String(hostel.capacitySummary?.totalRooms ?? 0)],
                    ["Total beds", String(hostel.capacitySummary?.totalBeds ?? 0)],
                    ["Vacant beds", String(hostel.capacitySummary?.vacantBeds ?? 0)],
                    [
                      "Name changes used",
                      `${hostel.nameChangeCount ?? 0} of ${NAME_CHANGE_LIMIT}`,
                    ],
                    ["Facilities", hostel.facilities.join(", ") || "—"],
                    ["Room types", hostel.roomTypes.join(", ") || "—"],
                  ].map(([label, value]) => (
                    <div
                      className="flex flex-col gap-1 border-b border-border/60 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
                      key={label}
                    >
                      <dt className="font-medium text-muted-foreground">{label}</dt>
                      <dd className="text-foreground sm:max-w-[60%] sm:text-right">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </SectionBody>
            </Panel>

            <Panel className={FORM_SECTIONS.has(activeSection) ? "" : "hidden"}>
              <form className="space-y-4" key={hostel.id} onSubmit={save}>
                <SectionBody
                  active={activeSection === "identity"}
                  section={sectionById.identity}
                >
                  <FieldGroup title="Listing">
                    <SettingsRow
                      description={
                        nameLocked
                          ? "Locked — use Locked Changes to request a rename."
                          : ["APPROVED", "PUBLISHED"].includes(hostel.status ?? "")
                            ? `${NAME_CHANGE_LIMIT - (hostel.nameChangeCount ?? 0)} name change(s) left after approval.`
                            : "Shown as the title of your public listing."
                      }
                      label="Hostel name"
                    >
                      {nameLocked ? (
                        <p className="flex h-11 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-muted-foreground">
                          {hostel.name}
                        </p>
                      ) : (
                        <Input defaultValue={hostel.name} label={null} name="name" />
                      )}
                    </SettingsRow>

                    <SettingsRow description="Who the hostel accommodates." label="Type">
                      <Select
                        defaultValue={hostel.hostelType}
                        label=""
                        name="hostelType"
                        required
                      >
                        {["BOYS", "GIRLS", "CO_LIVING"].map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </Select>
                    </SettingsRow>

                    <SettingsRow
                      description="Building detail only — rooms are managed as one list."
                      label="Number of floors"
                    >
                      <Input
                        defaultValue={hostel.totalFloors ?? 0}
                        label={null}
                        min="0"
                        name="totalFloors"
                        type="number"
                      />
                    </SettingsRow>

                    <SettingsRow
                      description={
                        hostel.panNumber
                          ? "Set. Branches must match it — ask us to correct a mistake."
                          : "Nine digits, from your PAN/VAT certificate. Set once; branches must match it."
                      }
                      label="PAN/VAT number"
                    >
                      {hostel.panNumber ? (
                        <p className="font-mono text-sm font-semibold text-foreground">{hostel.panNumber}</p>
                      ) : (
                        <Input label={null} name="panNumber" placeholder="601234567" />
                      )}
                    </SettingsRow>

                    <SettingsBlock
                      description="A short paragraph seekers read before enquiring."
                      label="Description"
                    >
                      <TextArea
                        defaultValue={hostel.description}
                        label=""
                        name="description"
                      />
                    </SettingsBlock>
                  </FieldGroup>

                  {/*
                    These two came off the Rooms & Pricing section when it was
                    removed, and they are here rather than gone because neither
                    is about rooms or about money: they are listing copy, and
                    this form is the only place in the portal that edits them.
                    Room types and the rent range left with that section — those
                    are owned by Rooms & Beds and by the fee schedule.
                  */}
                  <FieldGroup
                    hint="Comma separated. These drive the filters seekers use."
                    title="What you offer"
                  >
                    <SettingsRow
                      description="e.g. WiFi, Hot water, Study table"
                      label="Facilities"
                    >
                      <Input
                        defaultValue={hostel.facilities.join(", ")}
                        label={null}
                        name="facilities"
                        placeholder="WiFi, Hot water, Study table"
                      />
                    </SettingsRow>
                    <SettingsRow
                      description="e.g. No smoking, Gate closes 9pm"
                      label="House rules"
                    >
                      <Input
                        defaultValue={hostel.rules.join(", ")}
                        label={null}
                        name="rules"
                        placeholder="No smoking, Gate closes 9pm"
                      />
                    </SettingsRow>
                  </FieldGroup>
                </SectionBody>

                <SectionBody
                  active={activeSection === "location"}
                  section={sectionById.location}
                >
                  <FieldGroup
                    hint="Used for search and filtering, and as the starting guess for the map pin."
                    title="Address"
                  >
                    <SettingsRow
                      description="The locality seekers filter by."
                      label="Area"
                    >
                      <Input
                        label={null}
                        name="area"
                        onChange={(event) => editAddress({ area: event.target.value })}
                        placeholder="e.g. Balkumari"
                        value={addressFields.area}
                      />
                    </SettingsRow>
                    <SettingsRow label="City">
                      <Input
                        label={null}
                        name="city"
                        onChange={(event) => editAddress({ city: event.target.value })}
                        placeholder="e.g. Lalitpur"
                        value={addressFields.city}
                      />
                    </SettingsRow>
                    <SettingsRow
                      description="Improves geocoding accuracy."
                      label="Province"
                    >
                      <Input
                        label={null}
                        name="province"
                        onChange={(event) =>
                          editAddress({ province: event.target.value })
                        }
                        placeholder="e.g. Bagmati"
                        value={addressFields.province}
                      />
                    </SettingsRow>
                    <SettingsRow
                      description="Street or tole, plus a landmark if there is one."
                      label="Street address"
                    >
                      <Input
                        label={null}
                        name="address"
                        onChange={(event) => editAddress({ address: event.target.value })}
                        value={addressFields.address}
                      />
                    </SettingsRow>
                  </FieldGroup>

                  <FieldGroup
                    hint="This pin — not the address text — is what the public map shows, and what nearby colleges, hospitals and parks are measured from."
                    title="Exact map pin"
                  >
                    <SettingsBlock
                      description="Paste your Google Maps link, search for your hostel, use your current location while standing at the building, or drag the marker onto your gate. Placing the pin updates the address above."
                      label="Place your hostel"
                    >
                      <LocationPicker
                        addressHint={addressHint}
                        onChange={setLocation}
                        onResolvedAddress={applyResolvedAddress}
                        value={location}
                      />
                      {location.source !== "MANUAL" ? (
                        <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-foreground">
                          This pin was estimated from your address, so it may sit in the
                          middle of the neighbourhood rather than on your building. Place
                          it yourself for an accurate listing.
                        </p>
                      ) : null}
                    </SettingsBlock>
                  </FieldGroup>
                </SectionBody>

                <SectionBody
                  active={activeSection === "contact"}
                  section={sectionById.contact}
                >
                  <FieldGroup
                    hint="Shown on your public listing and used for enquiry replies."
                    title="Public contact"
                  >
                    <SettingsRow
                      description="The only number published on your listing."
                      label="Phone"
                    >
                      <Input
                        defaultValue={hostel.contact?.phone}
                        label={null}
                        name="phone"
                      />
                    </SettingsRow>
                    <SettingsRow
                      description="Used for enquiry replies, never shown publicly."
                      label="Email"
                    >
                      <Input
                        defaultValue={hostel.contact?.email}
                        label={null}
                        name="email"
                        type="email"
                      />
                    </SettingsRow>
                  </FieldGroup>
                </SectionBody>

                <div className="sticky bottom-0 -mx-3.5 -mb-3.5 flex items-center justify-between gap-3 rounded-b-xl border-t border-border bg-surface/95 px-3.5 py-3 backdrop-blur">
                  <p className="text-xs font-medium text-muted-foreground">
                    One save covers every section.
                  </p>
                  <Button
                    className="h-10 bg-role-admin text-sm font-semibold text-white hover:bg-role-admin/85"
                    loading={saving}
                    type="submit"
                  >
                    Save Profile
                  </Button>
                </div>
              </form>
            </Panel>

            <Panel className={activeSection === "photos" ? "" : "hidden"}>
              <SectionBody active section={sectionById.photos}>
                <p className="text-sm text-muted-foreground">
                  Exterior photos (max {PHOTO_LIMITS.EXTERIOR}) are shown first; interior
                  photos (max {PHOTO_LIMITS.INTERIOR}) fill the gallery. Room photos live
                  on the Rooms &amp; Beds screen.
                </p>
                {(
                  [
                    ["EXTERIOR", "Exterior / main photos"],
                    ["INTERIOR", "Interior photos"],
                  ] as const
                ).map(([kind, title]) => {
                  const pending = pendingByKind[kind] ?? [];
                  // Previews count against the limit while they are in flight.
                  const used = photosByKind[kind].length + pending.length;

                  return (
                    <div
                      className="border-b border-border/60 py-3.5 last:border-b-0"
                      key={kind}
                    >
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="text-sm font-medium text-foreground">
                          {title}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            {used}/{PHOTO_LIMITS[kind]}
                          </span>
                        </h3>
                        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-role-admin px-3 py-1.5 text-xs font-semibold text-role-admin transition hover:bg-role-admin/10">
                          <ImagePlus className="size-4" />
                          {uploadingKind === kind ? "Uploading..." : "Add photos"}
                          <input
                            accept={acceptAttribute("image")}
                            className="hidden"
                            disabled={uploadingKind !== "" || used >= PHOTO_LIMITS[kind]}
                            multiple
                            onChange={(event) =>
                              void uploadPhotos(event, kind, PHOTO_LIMITS[kind] - used)
                            }
                            type="file"
                          />
                        </label>
                      </div>
                      {used === 0 ? (
                        <p className="text-sm text-muted-foreground">No photos yet.</p>
                      ) : (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                          {photosByKind[kind].map((photo, photoIndex) => {
                            const deleting =
                              photo.id != null && deletingIds.includes(photo.id);

                            return (
                              <div className="group relative" key={photo.id ?? photo.url}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  alt={photo.alt || "Hostel photo"}
                                  className={
                                    deleting
                                      ? "h-28 w-full rounded-lg border border-border object-cover blur-[2px] brightness-90 transition"
                                      : "h-28 w-full cursor-zoom-in rounded-lg border border-border object-cover transition"
                                  }
                                  onClick={() =>
                                    deleting
                                      ? undefined
                                      : openViewer(
                                          photosByKind[kind].map((item) => ({
                                            src: item.url ?? "",
                                            title,
                                          })),
                                          photoIndex,
                                        )
                                  }
                                  src={photo.url}
                                />
                                {deleting ? (
                                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/25">
                                    <Loader2 className="size-6 animate-spin text-white" />
                                  </div>
                                ) : (
                                  <Button
                                    className="absolute right-1.5 top-1.5 size-7 opacity-0 transition group-hover:opacity-100"
                                    onClick={() => void deletePhoto(photo.id)}
                                    size="icon"
                                    type="button"
                                    variant="destructive"
                                  >
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                )}
                              </div>
                            );
                          })}
                          {pending.map((item) => (
                            <div className="relative" key={item.id}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                alt=""
                                className={
                                  item.uploaded
                                    ? "h-28 w-full rounded-lg border border-border object-cover transition"
                                    : "h-28 w-full rounded-lg border border-border object-cover blur-[2px] brightness-90 transition"
                                }
                                src={item.previewUrl}
                              />
                              {item.uploaded ? null : (
                                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/25">
                                  <Loader2 className="size-6 animate-spin text-white" />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </SectionBody>
            </Panel>

            <Panel className={activeSection === "requests" ? "" : "hidden"}>
              <SectionBody active section={sectionById.requests}>
                <p className="text-sm text-muted-foreground">
                  Extra hostel-name changes, owner-name changes and account-email changes
                  are verified by the platform team. Send a request and you&apos;ll
                  receive an acknowledgement email once it&apos;s applied.
                </p>
                <form onSubmit={sendChangeRequest}>
                  <SettingsRow label="What do you want to change?">
                    <Select label="" name="changeType" required>
                      <option value="HOSTEL_NAME">Hostel name</option>
                      <option value="OWNER_NAME">Owner name</option>
                      <option value="OWNER_EMAIL">Owner account email</option>
                    </Select>
                  </SettingsRow>
                  <SettingsRow
                    description="What it should be changed to."
                    label="New value"
                  >
                    <Input label={null} name="requestedValue" required />
                  </SettingsRow>
                  <SettingsBlock
                    description="Helps the platform team verify the request faster."
                    label="Reason (optional)"
                  >
                    <TextArea label="" name="reason" />
                  </SettingsBlock>
                  <div className="pt-4">
                    <Button
                      className="h-11 bg-role-admin text-sm font-semibold text-white hover:bg-role-admin/85"
                      loading={sendingRequest}
                      type="submit"
                    >
                      Send Request
                    </Button>
                  </div>
                </form>
              </SectionBody>
            </Panel>
          </div>
        </div>
      </div>
    );
  },
);
