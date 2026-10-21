"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { usePortalResource } from "@/lib/portal-query";

type Agreement = {
  issuedAt: string | null;
  refCode: string | null;
  sentAt: string | null;
  sentTo: string;
  signature: string;
  signedAt: string;
  signerName: string;
} | null;

/**
 * A hostel's signed service agreement on the review screen: who signed and
 * how, whether it is issued and emailed, and the PDF itself — a marked preview
 * until the KYC is approved, so the signer can be checked against the ID before
 * approving. Superadmin only, like the route.
 */
export function ReviewAgreement({ hostelId }: { hostelId: string }) {
  const url = `/api/v1/platform/hostels/${encodeURIComponent(hostelId)}/agreement`;
  const resource = usePortalResource<{ agreement: Agreement }>(url);

  if (resource.state === "error") {
    return <p className="text-sm text-muted-foreground">Only a superadmin can see the agreement.</p>;
  }

  if (resource.state !== "ready") {
    return <div className="h-10 animate-pulse rounded-md bg-muted" />;
  }

  const agreement = resource.data?.agreement;

  if (!agreement) {
    return <p className="text-sm text-muted-foreground">Not signed yet. It is the last step of the owner&apos;s KYC.</p>;
  }

  return (
    <div className="space-y-2 text-sm">
      <svg aria-label={`Signature of ${agreement.signerName}`} className="h-14 w-44 text-foreground" role="img" viewBox="0 0 600 200">
        <path d={agreement.signature} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={6} />
      </svg>
      <p className="font-semibold text-foreground">
        {agreement.signerName} · signed {formatHostelDateTime(new Date(agreement.signedAt))}
      </p>
      <p className="text-muted-foreground">
        {agreement.refCode
          ? `${agreement.refCode} · ${agreement.sentAt ? `emailed to ${agreement.sentTo} ${formatHostelDateTime(new Date(agreement.sentAt))}` : "issued, not emailed yet"}`
          : "Waiting for KYC approval — approving issues it and emails it to the owner."}
      </p>
      <a className="inline-flex font-semibold text-role-platform hover:underline" href={`${url}?format=pdf`} rel="noopener" target="_blank">
        {agreement.refCode ? "Open agreement PDF" : "Preview agreement PDF"}
      </a>
    </div>
  );
}
