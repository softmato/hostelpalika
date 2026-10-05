"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  BedDouble,
  Building2,
  DoorOpen,
  FileText,
  MapPin,
  Phone,
  ShieldCheck,
  Utensils,
} from "lucide-react";
import type { ReactNode } from "react";
import type { getBranchDetails } from "@/modules/hostels/hostel-branch.service";
import { usePortalResource } from "@/lib/portal-query";
import { SectionCard, SoftBadge } from "./portal-dashboard-ui";

type Details = Awaited<ReturnType<typeof getBranchDetails>>;
const money = (value?: number) =>
  value == null ? "Not added" : `NPR ${value.toLocaleString("en-IN")}`;
const statusLabel: Record<string, string> = {
  PENDING_APPROVAL: "Waiting for our call",
  PUBLISHED: "Live",
  REJECTED: "Not approved",
  APPROVED: "Approved",
};
function Fact({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium">
        {value === undefined || value === null || value === "" ? "Not added" : value}
      </dd>
    </div>
  );
}

export function HostelBranchDetailPage({ branchId }: { branchId: string }) {
  const resource = usePortalResource<Details>(
    `/api/v1/hostel-admin/branches/${encodeURIComponent(branchId)}`,
  );
  const pathname = usePathname();
  const back = pathname.substring(0, pathname.lastIndexOf("/"));
  const data = resource.data;
  const hostel = data?.hostel;
  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <Link
        href={back}
        className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All branches
      </Link>
      {resource.state === "loading" ? (
        <div className="animate-pulse rounded-2xl border border-border bg-card p-8 text-sm text-muted-foreground">
          Loading branch details…
        </div>
      ) : null}
      {resource.state === "error" ? (
        <div role="alert" className="rounded-xl border border-destructive/20 bg-card p-5">
          <p className="text-sm text-destructive">{resource.message}</p>
          <button
            type="button"
            onClick={resource.refresh}
            className="mt-3 text-sm font-semibold text-brand-teal"
          >
            Try again
          </button>
        </div>
      ) : null}
      {hostel && data ? (
        <>
          <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-4">
                <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand-teal/10 text-brand-teal">
                  <Building2 className="size-7" strokeWidth={1.6} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">
                    {hostel.parentHostelId
                      ? `Branch of ${data.main.name}`
                      : "Main hostel"}
                  </p>
                  <h1 className="mt-1 text-2xl font-bold">{hostel.name}</h1>
                  <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MapPin className="size-4 shrink-0" />
                    {[hostel.location?.area, hostel.location?.city]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <SoftBadge
                  tone={
                    hostel.status === "PUBLISHED"
                      ? "green"
                      : hostel.status === "REJECTED"
                        ? "rose"
                        : "amber"
                  }
                >
                  {statusLabel[hostel.status] ?? hostel.status}
                </SoftBadge>
                {hostel.status === "PUBLISHED" ? (
                  <Link
                    href={`/${encodeURIComponent(hostel.slug)}/admin/dashboard`}
                    className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-3 py-2 text-xs font-semibold text-white"
                  >
                    Open workspace <ArrowUpRight className="size-4" />
                  </Link>
                ) : null}
              </div>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 border-t border-border pt-5 sm:grid-cols-4">
              {[
                [Building2, "Floors", hostel.totalFloors],
                [DoorOpen, "Rooms", hostel.capacitySummary.totalRooms],
                [BedDouble, "Beds", hostel.capacitySummary.totalBeds],
                [BedDouble, "Vacant beds", hostel.capacitySummary.vacantBeds],
              ].map(([Icon, label, value]) => {
                const Glyph = Icon as typeof Building2;
                return (
                  <div key={String(label)} className="rounded-xl bg-muted/40 p-3">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Glyph className="size-4" />
                      {String(label)}
                    </p>
                    <p className="mt-2 text-xl font-semibold">
                      {value == null ? "—" : String(value)}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <SectionCard title="About this hostel" icon={Building2}>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                {hostel.description || "No description added."}
              </p>
              <dl className="mt-5 grid grid-cols-2 gap-4">
                <Fact
                  label="Hostel type"
                  value={
                    { BOYS: "Boys", GIRLS: "Girls", CO_LIVING: "Co-living" }[
                      hostel.hostelType
                    ]
                  }
                />
                <Fact label="Year established" value={hostel.yearEstablished} />
                <Fact label="PAN / VAT" value={hostel.panNumber} />
                <Fact
                  label="Verification"
                  value={hostel.verificationStatus?.replaceAll("_", " ")}
                />
              </dl>
            </SectionCard>
            <SectionCard title="Contact & location" icon={Phone}>
              <dl className="grid grid-cols-2 gap-4">
                <Fact label="Phone" value={hostel.contact.phone} />
                <Fact label="Alternate phone" value={hostel.contact.alternatePhone} />
                <Fact label="Email" value={hostel.contact.email} />
                <Fact label="Street address" value={hostel.location?.address} />
                <Fact label="Area" value={hostel.location?.area} />
                <Fact label="City" value={hostel.location?.city} />
                <Fact label="Province" value={hostel.location?.province} />
                <Fact label="Landmark" value={hostel.location?.landmark} />
                <Fact label="Map link" value={hostel.location?.mapLink} />
              </dl>
            </SectionCard>
          </div>
          <SectionCard title="Rooms & pricing" icon={BedDouble}>
            <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Fact label="Security deposit" value={money(hostel.securityDeposit)} />
              <Fact label="Admission fee" value={money(hostel.pricing.admissionFee)} />
              <Fact label="Form fee" value={money(hostel.pricing.formFee)} />
            </dl>
            <div className="grid gap-3 sm:grid-cols-2">
              {hostel.roomConfigurations.map((room) => (
                <div key={room.roomType} className="rounded-xl border border-border p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <BedDouble className="size-4 text-brand-teal" />
                    {room.roomType}
                  </h3>
                  <dl className="mt-4 grid grid-cols-2 gap-3">
                    <Fact label="Rooms" value={room.rooms} />
                    <Fact label="Beds per room" value={room.bedsPerRoom} />
                    <Fact label="Vacant beds" value={room.vacantBeds} />
                    <Fact label="Monthly rent / bed" value={money(room.monthlyRent)} />
                    <Fact
                      label="Deposit"
                      value={money(room.securityDeposit ?? hostel.securityDeposit)}
                    />
                    <Fact label="Meals" value={room.mealInclusion} />
                  </dl>
                </div>
              ))}
            </div>
            {!hostel.roomConfigurations.length ? (
              <p className="text-sm text-muted-foreground">No room types added yet.</p>
            ) : null}
          </SectionCard>
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <SectionCard title="Facilities & meals" icon={Utensils}>
              <div className="flex flex-wrap gap-2">
                {hostel.facilities.map((facility) => (
                  <span
                    key={facility}
                    className="rounded-lg border border-border bg-muted/30 px-2.5 py-1 text-xs"
                  >
                    {facility}
                  </span>
                ))}
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-4">
                <Fact label="Meals per day" value={hostel.food.mealsPerDay} />
                <Fact
                  label="Meal options"
                  value={[
                    hostel.food.hasVeg ? "Vegetarian" : "",
                    hostel.food.hasNonVeg ? "Non-vegetarian" : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                />
                <Fact label="Food notes" value={hostel.food.notes} />
                <Fact
                  label="Short stays"
                  value={
                    hostel.shortStays?.enabled
                      ? `Available · minimum ${hostel.shortStays.minNights ?? 1} nights`
                      : "Not offered"
                  }
                />
              </dl>
              {hostel.shortStays?.enabled ? (
                <dl className="mt-4 grid grid-cols-2 gap-3">
                  {hostel.shortStays.rates?.map((rate) => (
                    <Fact
                      key={rate.roomType}
                      label={`${rate.roomType} / night`}
                      value={money(rate.dailyRate)}
                    />
                  ))}
                </dl>
              ) : null}
            </SectionCard>
            <SectionCard title="House rules" icon={ShieldCheck}>
              {hostel.rules.length ? (
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {hostel.rules.map((rule, index) => (
                    <li className="flex gap-2" key={index}>
                      <span className="text-brand-teal">•</span>
                      {rule}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No house rules added.</p>
              )}
            </SectionCard>
          </div>
          <SectionCard title="Documents" icon={FileText}>
            {data.documents.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.documents.map((document) => (
                  <div
                    key={document.id}
                    className="flex items-start justify-between gap-3 rounded-xl border border-border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{document.type}</p>
                      {document.rejectionReason ? (
                        <p className="mt-1 text-xs text-destructive">
                          {document.rejectionReason}
                        </p>
                      ) : null}
                    </div>
                    <SoftBadge
                      tone={
                        document.status === "APPROVED"
                          ? "green"
                          : document.status === "REJECTED"
                            ? "rose"
                            : "amber"
                      }
                    >
                      {document.status.toLowerCase()}
                    </SoftBadge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No documents added.</p>
            )}
          </SectionCard>
          {hostel.photos.some((photo) => photo.url) ? (
            <SectionCard title="Photos">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {hostel.photos
                  .filter((photo) => photo.url)
                  .map((photo, index) => (
                    <a
                      key={photo.id ?? index}
                      href={photo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="overflow-hidden rounded-xl border border-border"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.url}
                        alt={
                          photo.alt ||
                          `${hostel.name} ${photo.kind?.toLowerCase() ?? "photo"}`
                        }
                        className="aspect-[4/3] w-full object-cover"
                      />
                    </a>
                  ))}
              </div>
            </SectionCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
