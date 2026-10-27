"use client";

import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import Link from "next/link";
import { memo } from "react";

import { EmptyState } from "@/app/_components/shared-ui";
import {
  EmptyInline,
  InitialsAvatar,
  PortalPageHeader,
  RoleButton,
  SectionCard,
} from "@/app/_components/portal-dashboard-ui";
import { Glyph, type GlyphName } from "@/components/glyph";
import { ResidentIdCard } from "@/components/resident-identity";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { CardSkeletons, FactChip, SectionTitle, titleCase } from "./daily-portal-ui";
import { type ResidentDashboard, type ResidentSummary, Message } from "./resident-shared";

type Profile = {
  accommodation: ResidentDashboard["accommodation"];
  emergencyContacts: Array<{
    id: string;
    name: string;
    phone: string;
    relation: string;
  }>;
  guardians: Array<{
    firstName: string;
    id: string;
    lastName: string;
    phone: string;
    relation: string;
  }>;
  hostel: ResidentDashboard["hostel"];
  resident: ResidentSummary;
};

/** One person in the contacts list: avatar, name, relation, a call link. */
function ContactRow({
  kind,
  name,
  phone,
  relation,
}: {
  kind: "Guardian" | "Emergency";
  name: string;
  phone: string;
  relation: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <InitialsAvatar name={name} size="md" tone="team" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-semibold text-foreground">{name}</p>
        <p className="truncate text-[12px] text-muted-foreground">{relation}</p>
      </div>
      <span
        className={
          kind === "Emergency"
            ? "rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
            : "rounded-full bg-role-team-soft px-2 py-0.5 text-[11px] font-semibold text-role-team"
        }
      >
        {kind}
      </span>
      <a
        aria-label={`Call ${name}`}
        className="flex size-9 items-center justify-center rounded-xl border border-border text-foreground transition hover:bg-muted"
        href={`tel:${phone}`}
        title={phone}
      >
        <Glyph className="size-4" name="call" />
      </a>
    </div>
  );
}

export const ResidentProfilePageContent = memo(function ResidentProfilePageContent() {
  const profileResource = usePortalResource<{ profile: Profile }>(
    residentEndpoints.profile,
    { errorMessage: "Could not load profile." },
  );

  const profile = profileResource.data?.profile ?? null;
  const state = profileResource.state;
  const message = profileResource.message;
  const bedTypeLabel = roomTypeLabel(profile?.accommodation.roomType) || "—";
  const fullName = profile ? `${profile.resident.firstName} ${profile.resident.lastName}` : "";
  const contactCount = (profile?.guardians.length ?? 0) + (profile?.emergencyContacts.length ?? 0);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        actions={
          <RoleButton asChild className="h-9 px-4" tone="team" variant="outline">
            <Link href="/resident/guardians">
              <Glyph className="size-4" name="shield" />
              Guardians
            </Link>
          </RoleButton>
        }
        description="Your record, your ID card and your contacts."
        title="My Profile"
      />
      <Message value={message} />
      {state === "loading" ? <CardSkeletons count={2} /> : null}
      {state === "error" ? <EmptyState label="Profile could not be loaded." /> : null}

      {profile ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-5">
            <SectionCard>
              <div className="flex items-center gap-4">
                <InitialsAvatar name={fullName} size="lg" tone="team" />
                <div className="min-w-0">
                  <p className="truncate font-heading text-[18px] font-bold tracking-tight text-foreground">
                    {fullName}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    {profile.hostel?.name ?? "Your hostel"}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                <FactChip
                  glyph="checkmark-circle"
                  tone={profile.resident.status === "ACTIVE" ? "brand" : "neutral"}
                >
                  {titleCase(profile.resident.status)}
                </FactChip>
                <FactChip glyph="bed">{bedTypeLabel}</FactChip>
                {profile.resident.residentType ? (
                  <FactChip glyph="school">{titleCase(profile.resident.residentType)}</FactChip>
                ) : null}
              </div>
              <ul className="mt-3 divide-y divide-border/60 text-[13.5px]">
                {(
                  [
                    ["call", profile.resident.phone || "No phone"],
                    ["mail", profile.resident.email || "No email"],
                  ] as [GlyphName, string][]
                ).map(([glyph, value]) => (
                  <li className="flex items-center gap-3 py-2.5" key={glyph}>
                    <Glyph className="size-4 shrink-0 text-muted-foreground" name={glyph} />
                    <span className="min-w-0 truncate text-foreground">{value}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>

            <div className="space-y-3">
              <SectionTitle>
                Contacts <span className="font-normal text-muted-foreground">· {contactCount}</span>
              </SectionTitle>
              <SectionCard>
                {contactCount === 0 ? (
                  <EmptyInline label="No guardians or emergency contacts yet." />
                ) : (
                  <div className="divide-y divide-border/60">
                    {profile.guardians.map((guardian) => (
                      <ContactRow
                        key={guardian.id}
                        kind="Guardian"
                        name={`${guardian.firstName} ${guardian.lastName}`}
                        phone={guardian.phone}
                        relation={guardian.relation}
                      />
                    ))}
                    {profile.emergencyContacts.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        kind="Emergency"
                        name={contact.name}
                        phone={contact.phone}
                        relation={contact.relation}
                      />
                    ))}
                  </div>
                )}
              </SectionCard>
            </div>
          </div>

          <div className="space-y-3">
            <SectionTitle>ID card</SectionTitle>
            <SectionCard>
              <ResidentIdCard />
            </SectionCard>
          </div>
        </div>
      ) : null}
    </div>
  );
});
