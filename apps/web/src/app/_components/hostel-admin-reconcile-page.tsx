"use client";

import { AlertTriangle, CheckCircle2, Coins, FileSpreadsheet, Upload } from "@/components/icons";
import { memo, useCallback, useRef, useState } from "react";

import { currency, EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import { Chip, Eyebrow, RowMark } from "@/app/_components/hostel-admin-page-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { monthLabel } from "@/lib/format-month";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";
import { mimeTypeForStatement } from "@hostel/shared/utils/file-assets";
import { OrphanAssignPicker } from "./hostel-admin-orphan-assign";
import { MetricCard, PortalPageHeader, RoleButton, SectionCard } from "./portal-dashboard-ui";

/**
 * Re-labels a picked file with the MIME type its extension implies.
 *
 * A `.xls` chosen on a machine without Excel arrives from the browser as
 * `application/octet-stream` or with no type at all, and would be refused at the
 * door by an allowlist that is narrow on purpose. The bytes are untouched; only
 * the label changes, and nothing downstream trusts the label anyway — the parser
 * reads the real format from the file's magic bytes.
 */
function labelled(file: File): File {
  const mimeType = mimeTypeForStatement(file.name, file.type);

  if (!mimeType || mimeType === file.type) {
    return file;
  }

  return new File([file], file.name, { lastModified: file.lastModified, type: mimeType });
}

/**
 * Tier 0.5 reconciliation (target §11.5, plan item 4.3).
 *
 * **This is the screen that sells the product**, and its shape is the argument:
 * eighty-four transactions, three buckets, and the owner touches two of them.
 * Forty-one residents' month of finance work in about ninety seconds.
 *
 * Three rules it must not lose:
 *
 * - **The matched bucket is read, not worked.** Rows whose reference code
 *   verified are already settled by the import; the count and the total are
 *   there to be believed, not confirmed one at a time.
 * - **Every suggestion is a suggestion.** The orphan bucket's "Suggested:
 *   Suman Tamang" is one tap, and that tap is the owner's — never an automatic
 *   match, no matter how confident the score.
 * - **`Approve anyway` exists.** Statements lag by days. An owner trapped behind
 *   data that cannot resolve the question abandons the feature, so the button is
 *   there and the server records who pressed it.
 */

type StatementImportRow = {
  errorDetail: string | null;
  fileName: string | null;
  matchedCount: number;
  orphanCount: number;
  provider: string;
  rowCount: number;
  statementImportId: string;
  status: string;
  suggestedCount: number;
  uploadedAt: string;
};

type Suggestion = {
  confidence: string;
  invoiceId: string;
  residentId: string;
  residentName: string;
  why: string;
};

type Reconciliation = {
  buckets: {
    approvedNotInStatement: {
      amount: number;
      approvedAt: string | null;
      approvedByName: string | null;
      claimEventId: string;
      period: string | null;
      residentName: string;
      transactionCode: string | null;
      why: string;
    }[];
    claimedNoTransaction: {
      amount: number;
      bedLabel: string | null;
      claimEventId: string;
      period: string | null;
      residentName: string;
      transactionCode: string | null;
      why: string;
    }[];
    matched: {
      amount: number;
      claimEventId: string | null;
      confirmsClaim: boolean;
      eventId: string;
      occurredAt: string;
      period: string | null;
      referenceCode: string | null;
      residentName: string;
      status: string;
      why: string;
    }[];
    orphans: {
      amount: number;
      counterpartyName: string | null;
      eventId: string;
      occurredAt: string;
      providerTxnId: string | null;
      remarks: string | null;
      suggestions: Suggestion[];
    }[];
  };
  fileName: string | null;
  matchedTotal: number;
  rowCount: number;
  statementImportId: string;
  uploadedAt: string;
};

const PROVIDERS = [
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
  { label: "Bank", value: "BANK" },
];

function shortDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export const HostelAdminReconcilePageContent = memo(
  function HostelAdminReconcilePageContent() {
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [provider, setProvider] = useState("ESEWA");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [showAllMatched, setShowAllMatched] = useState(false);
    const [uploadOpen, setUploadOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const imports = usePortalResource<{ imports: StatementImportRow[] }>(
      hostelAdminEndpoints.statements,
      { errorMessage: "Could not load past statement uploads." },
    );

    const rows = imports.data?.imports ?? [];
    const activeId = selectedId ?? rows.find((row) => row.status === "READY")?.statementImportId ?? null;

    const reconciliation = usePortalResource<Reconciliation>(
      activeId ? hostelAdminEndpoints.statement(activeId) : null,
      { errorMessage: "Could not load this reconciliation." },
    );

    const refreshAll = useCallback(async () => {
      await Promise.all([imports.refreshAsync(), reconciliation.refreshAsync()]);
    }, [imports, reconciliation]);

    const upload = useCallback(
      async (file: File | undefined) => {
        if (!file) return;

        setBusy(true);
        setMessage("");

        try {
          // `STATEMENT` is a financial kind, so presign scopes the asset to this
          // hostel (item 0.1) — the same check that stops an owner reconciling
          // against somebody else's file.
          const uploaded = await uploadFile(labelled(file), {
            assetKind: "STATEMENT",
            kind: "document",
            label: "Statement",
            silent: true,
          });

          if (!uploaded?.assetId) {
            setMessage("The statement could not be uploaded.");
            return;
          }

          const result = await browserApi<{
            rowCount: number;
            statementImportId: string;
          }>(hostelAdminEndpoints.statements, {
            body: JSON.stringify({ assetId: uploaded.assetId, provider }),
            method: "POST",
          });

          setSelectedId(result?.statementImportId ?? null);
          setMessage(`Read ${result?.rowCount ?? 0} transactions.`);
          setUploadOpen(false);
          await imports.refreshAsync();
        } catch (error) {
          // The parser's own message names the row it stopped at — far more
          // useful than "upload failed", so it is shown verbatim.
          setMessage(
            error instanceof Error ? error.message : "That statement could not be read.",
          );
        } finally {
          setBusy(false);
          if (fileInputRef.current) fileInputRef.current.value = "";
        }
      },
      [imports, provider],
    );

    const act = useCallback(
      async (url: string, body: Record<string, unknown> | null, note: string) => {
        setBusy(true);
        setMessage("");

        try {
          await browserApi(url, {
            ...(body ? { body: JSON.stringify(body) } : {}),
            method: "POST",
          });
          setMessage(note);
          await refreshAll();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "That did not work.");
        } finally {
          setBusy(false);
        }
      },
      [refreshAll],
    );

    const view = reconciliation.data ?? null;
    const pendingMatched =
      // A confirming row is pending and always will be — it is evidence for a
      // claim that already holds the money, never a second credit. Counting it
      // here would put a number on the button that the sweep cannot work through,
      // so "Approve all 4" would settle three and still say 4.
      view?.buckets.matched.filter(
        (row) => row.status === "PENDING" && !row.confirmsClaim,
      ).length ?? 0;

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PortalPageHeader
          actions={
            <RoleButton className="h-9 rounded-xl" onClick={() => setUploadOpen(true)} tone="admin" type="button">
              <Upload aria-hidden="true" className="size-4" />
              Upload statement
            </RoleButton>
          }
          breadcrumb={["Payments", "Reconcile"]}
          description="Settle the month against what actually reached your account."
          title="Reconcile"
        />

        {message && !uploadOpen ? (
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13.5px]">
            {message}
          </div>
        ) : null}

        <Dialog onOpenChange={setUploadOpen} open={uploadOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Upload a statement</DialogTitle>
              {/* As exported from the wallet or bank, no converting. Overlapping
                  ranges are fine: a transaction already read is never counted twice. */}
              <DialogDescription>CSV, XLS or XLSX, as it came. Overlaps are never counted twice.</DialogDescription>
            </DialogHeader>
            {message ? <p className="text-[12.5px] text-muted-foreground">{message}</p> : null}
            <div>
              <Eyebrow className="mb-2">From</Eyebrow>
              <div className="flex gap-1.5">
                {PROVIDERS.map((option) => (
                  <button
                    aria-pressed={provider === option.value}
                    className={cn(
                      "flex-1 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition active:scale-95",
                      provider === option.value
                        ? "border-transparent bg-foreground text-background"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                    key={option.value}
                    onClick={() => setProvider(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <label
              className={cn(
                "flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border py-8 text-[13px] font-semibold text-muted-foreground transition",
                busy ? "opacity-60" : "cursor-pointer hover:border-brand-teal hover:text-brand-teal",
              )}
            >
              <Upload aria-hidden="true" className="size-6" />
              {busy ? "Working…" : "Choose file"}
              <input
                accept=".csv,.xls,.xlsx,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                disabled={busy}
                onChange={(event) => void upload(event.target.files?.[0])}
                ref={fileInputRef}
                type="file"
              />
            </label>
          </DialogContent>
        </Dialog>

        {rows.length > 0 ? (
          <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
            {rows.map((row) => (
              <button
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-left text-[12.5px] transition",
                  row.statementImportId === activeId
                    ? "border-transparent bg-role-team-soft text-role-team"
                    : "border-border text-foreground hover:border-foreground/30",
                  row.status === "FAILED" && "text-rose-700 dark:text-rose-300",
                )}
                disabled={row.status !== "READY"}
                key={row.statementImportId}
                onClick={() => setSelectedId(row.statementImportId)}
                title={row.status === "FAILED" ? (row.errorDetail ?? "Could not be read") : undefined}
                type="button"
              >
                <FileSpreadsheet className="size-3.5 shrink-0" />
                <span className="max-w-[14rem] truncate font-semibold">{row.fileName ?? `${row.provider} statement`}</span>
                <span className="text-muted-foreground">
                  {shortDate(row.uploadedAt)} ·{" "}
                  {row.status === "READY" ? `${row.rowCount} read` : row.status === "FAILED" ? "failed" : "reading…"}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {reconciliation.state === "loading" ? <LoadingRows /> : null}
        {!activeId && imports.state === "ready" ? (
          <EmptyState label="Upload a statement to reconcile this month." />
        ) : null}

        {view ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                icon={CheckCircle2}
                label="Matched"
                note={currency(view.matchedTotal)}
                noteTone="green"
                value={view.buckets.matched.length}
              />
              <MetricCard
                icon={AlertTriangle}
                label="Claimed, not found"
                tone={view.buckets.claimedNoTransaction.length > 0 ? "amber" : "slate"}
                value={view.buckets.claimedNoTransaction.length}
              />
              <MetricCard
                icon={AlertTriangle}
                label="Approved, not in statement"
                tone={view.buckets.approvedNotInStatement.length > 0 ? "rose" : "slate"}
                value={view.buckets.approvedNotInStatement.length}
              />
              <MetricCard
                icon={Coins}
                label="Nobody claimed"
                tone={view.buckets.orphans.length > 0 ? "amber" : "slate"}
                value={view.buckets.orphans.length}
              />
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              {view.fileName ?? "Statement"} · {view.rowCount} transactions read · uploaded{" "}
              {shortDate(view.uploadedAt)}
            </p>

            {/* Bucket 1 — read, not worked. */}
            <SectionCard
              actions={
                pendingMatched > 0 ? (
                  <RoleButton
                    disabled={busy}
                    onClick={() =>
                      void act(
                        hostelAdminEndpoints.statementApproveMatched(
                          view.statementImportId,
                        ),
                        null,
                        "Matched payments approved.",
                      )
                    }
                    tone="admin"
                    type="button"
                  >
                    Approve all {pendingMatched}
                  </RoleButton>
                ) : null
              }
              icon={CheckCircle2}
              title={`${view.buckets.matched.length} matched · ${currency(view.matchedTotal)}`}
            >
              <p className="mb-2 text-[12.5px] text-muted-foreground">Real transaction found. Amount and reference agree.</p>
              {/* **Read, not worked** — but readable in full. It used to stop at
                  eight rows with nothing saying so, which turns the one bucket
                  the owner is meant to believe into one they cannot check: the
                  header says 38 matched and the list shows 8. Collapsed behind a
                  count instead, so the default is still a glance. */}
              <ul
                className={cn(
                  "divide-y divide-border/60 text-[13.5px]",
                  showAllMatched ? "max-h-80 overflow-y-auto pr-1" : "",
                )}
              >
                {(showAllMatched
                  ? view.buckets.matched
                  : view.buckets.matched.slice(0, 8)
                ).map((row) => (
                  <li className="flex flex-wrap items-center justify-between gap-2 py-2" key={row.eventId}>
                    <span className="flex items-center gap-2">
                      <CheckCircle2 aria-hidden="true" className="size-3.5 text-role-team" />
                      <span className="font-medium text-foreground">{row.residentName || "Unknown"}</span>
                      {row.period ? <span className="text-muted-foreground">{monthLabel(row.period)}</span> : null}
                    </span>
                    <span className="text-[12.5px] text-muted-foreground">
                      <span className="font-semibold text-foreground">{currency(row.amount)}</span> ·{" "}
                      {row.referenceCode ?? row.why}
                      {/* Said plainly, because otherwise this row reads as one
                          the sweep skipped. It is the good news: money a warden
                          took on trust has turned up in the account. */}
                      {row.confirmsClaim ? " · confirms an approved claim" : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {view.buckets.matched.length > 8 ? (
                <button
                  className="mt-2 text-[12.5px] font-semibold text-role-team underline-offset-2 hover:underline"
                  onClick={() => setShowAllMatched((value) => !value)}
                  type="button"
                >
                  {showAllMatched
                    ? "Show fewer"
                    : `Show all ${view.buckets.matched.length}`}
                </button>
              ) : null}
            </SectionCard>

            {/* Bucket 2 — a resident says they paid, the statement disagrees. */}
            {view.buckets.claimedNoTransaction.length > 0 ? (
              <SectionCard
                actions={<Chip tone="warn">Needs you</Chip>}
                icon={AlertTriangle}
                title={`${view.buckets.claimedNoTransaction.length} claimed, no transaction found`}
              >
                <ul className="divide-y divide-border/60">
                  {view.buckets.claimedNoTransaction.map((row) => (
                    <li className="flex flex-wrap items-center gap-3 py-3" key={row.claimEventId}>
                      <RowMark glyph="warning" tone="warn" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-semibold text-foreground">
                          {row.residentName}
                          {row.bedLabel ? <span className="font-normal text-muted-foreground"> · {row.bedLabel}</span> : null}
                        </p>
                        <p className="text-[12.5px] text-muted-foreground">{row.why}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              hostelAdminEndpoints.paymentClaimReject(row.claimEventId),
                              {
                                rejectionReason:
                                  "We have not received this payment yet.",
                              },
                              "Claim rejected. The resident has been told why.",
                            )
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Reject
                        </Button>
                        {/* **This must exist.** Statements lag by days, so an
                            owner trapped behind data that cannot resolve the
                            question abandons the feature. The server records who
                            pressed it. */}
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              hostelAdminEndpoints.paymentClaimApprove(row.claimEventId),
                              null,
                              "Approved. Recorded against your name.",
                            )
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Approve anyway
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              hostelAdminEndpoints.paymentClaimAsk(row.claimEventId),
                              null,
                              "Asked the resident for clearer details.",
                            )
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Ask resident
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}

            {/* Bucket 2b — approved on trust, and still not in the account.
                Read-only on purpose (item E.6): the money is already credited
                and the resident already told it landed, so there is no one-tap
                correction here that would not be worse than the problem. What
                the owner needs is the names, so they can go and ask. Usually
                statement lag — but this is the list a forged receipt ends up on. */}
            {view.buckets.approvedNotInStatement.length > 0 ? (
              <SectionCard
                actions={<Chip tone="bad">Check</Chip>}
                icon={AlertTriangle}
                title={`${view.buckets.approvedNotInStatement.length} approved, never in a statement`}
              >
                <p className="mb-2 text-[12.5px] text-muted-foreground">Approved from a screenshot; the money has not shown up.</p>
                <ul className="divide-y divide-border/60">
                  {view.buckets.approvedNotInStatement.map((row) => (
                    <li className="flex items-center gap-3 py-3" key={row.claimEventId}>
                      <RowMark glyph="alert-circle" tone="bad" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-semibold text-foreground">
                          {row.residentName} · {currency(row.amount)}
                          {row.period ? <span className="font-normal text-muted-foreground"> · {monthLabel(row.period)}</span> : null}
                        </p>
                        <p className="text-[12.5px] text-muted-foreground">{row.why}</p>
                        <p className="text-[12px] text-muted-foreground">
                          Approved
                          {row.approvedAt ? ` ${shortDate(row.approvedAt)}` : ""}
                          {row.approvedByName ? ` by ${row.approvedByName}` : ""}
                          {row.transactionCode ? ` · txn ${row.transactionCode}` : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}

            {/* Bucket 3 — money nobody claimed. */}
            {view.buckets.orphans.length > 0 ? (
              <SectionCard
                actions={<Chip tone="warn">Needs you</Chip>}
                icon={Coins}
                title={`${view.buckets.orphans.length} payment${view.buckets.orphans.length === 1 ? "" : "s"} nobody claimed`}
              >
                <ul className="divide-y divide-border/60">
                  {view.buckets.orphans.map((row) => (
                    <li className="space-y-2 py-3" key={row.eventId}>
                      <div className="flex items-center gap-3">
                        <RowMark glyph="cash" tone="neutral" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13.5px] font-semibold text-foreground">
                            {currency(row.amount)}
                            <span className="font-normal text-muted-foreground">
                              {" "}
                              · {shortDate(row.occurredAt)}
                              {row.counterpartyName ? ` · from "${row.counterpartyName}"` : ""}
                            </span>
                          </p>
                          <p className="text-[12.5px] text-muted-foreground">
                            {row.providerTxnId ? `Txn ${row.providerTxnId}. ` : ""}
                            Remarks: {row.remarks?.trim() || "(empty)"}
                          </p>
                        </div>
                      </div>
                      {row.suggestions.length > 0 ? (
                        <ul className="grid gap-2 pl-12">
                          {row.suggestions.map((suggestion) => (
                            <li
                              className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2"
                              key={suggestion.invoiceId}
                            >
                              <span className="text-[13px]">
                                Suggested: {suggestion.why}
                                <span className="ml-2 text-[11px] font-semibold uppercase text-muted-foreground">
                                  {suggestion.confidence}
                                </span>
                              </span>
                              <RoleButton
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    hostelAdminEndpoints.paymentEventAssign(row.eventId),
                                    { invoiceId: suggestion.invoiceId },
                                    `Assigned to ${suggestion.residentName}.`,
                                  )
                                }
                                tone="admin"
                                type="button"
                              >
                                Assign
                              </RoleButton>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/* Always available, not only when the ladder scored
                          nothing (§11.5). A suggestion is a suggestion, and the
                          owner who knows the transfer came from a resident's
                          parent needs a way to say so that does not depend on us
                          having guessed. */}
                      <div className="pl-12">
                        <OrphanAssignPicker
                          busy={busy}
                          onAssign={(invoiceId, residentName) =>
                            void act(
                              hostelAdminEndpoints.paymentEventAssign(row.eventId),
                              { invoiceId },
                              `Assigned to ${residentName}.`,
                            )
                          }
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ) : null}
          </>
        ) : null}
      </div>
    );
  },
);
