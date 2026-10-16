"use client";

import { AlertTriangle, CheckCircle2, Coins, Upload } from "@/components/icons";
import { memo, useCallback, useRef, useState } from "react";

import { currency, EmptyState, LoadingRows, Select } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { monthLabel } from "@/lib/format-month";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { uploadFile } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";
import { mimeTypeForStatement } from "@hostel/shared/utils/file-assets";
import { OrphanAssignPicker } from "./hostel-admin-orphan-assign";
import { PortalPageHeader, SectionCard } from "./portal-dashboard-ui";

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
      <div className="mx-auto max-w-[1100px] space-y-6">
        <PortalPageHeader
          breadcrumb={["Payments", "Reconcile"]}
          description="Upload your eSewa, Khalti or bank statement and settle the month against what actually arrived."
          title="Reconcile"
        />

        {message ? (
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
            {message}
          </div>
        ) : null}

        <SectionCard title="Upload a statement">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Provider"
              name="provider"
              onChange={(event) => setProvider(event.target.value)}
              value={provider}
            >
              {PROVIDERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold">
              <Upload aria-hidden="true" className="size-4" />
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
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Export the statement from your own wallet or bank and upload it as it came —
            CSV, XLS or XLSX all work, no converting. Overlapping date ranges are fine: a
            transaction already read is never counted twice.
          </p>
        </SectionCard>

        {rows.length > 0 ? (
          <SectionCard title="Past uploads">
            <ul className="grid gap-2">
              {rows.map((row) => (
                <li key={row.statementImportId}>
                  <button
                    className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm ${
                      row.statementImportId === activeId
                        ? "border-primary bg-primary/5"
                        : "border-border"
                    }`}
                    disabled={row.status !== "READY"}
                    onClick={() => setSelectedId(row.statementImportId)}
                    type="button"
                  >
                    <span className="font-medium">
                      {row.fileName ?? `${row.provider} statement`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {shortDate(row.uploadedAt)} ·{" "}
                      {row.status === "READY"
                        ? `${row.rowCount} transactions read`
                        : row.status === "FAILED"
                          ? (row.errorDetail ?? "Could not be read")
                          : "Reading…"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </SectionCard>
        ) : null}

        {reconciliation.state === "loading" ? <LoadingRows /> : null}
        {!activeId && imports.state === "ready" ? (
          <EmptyState label="Upload a statement to reconcile this month." />
        ) : null}

        {view ? (
          <>
            <p className="text-sm text-muted-foreground">
              {view.fileName ?? "Statement"} · {view.rowCount} transactions read ·
              uploaded {shortDate(view.uploadedAt)}
            </p>

            {/* Bucket 1 — read, not worked. */}
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
                  <CheckCircle2 aria-hidden="true" className="size-4" />
                  {view.buckets.matched.length} matched · {currency(view.matchedTotal)}
                </p>
                {pendingMatched > 0 ? (
                  <button
                    className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
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
                    type="button"
                  >
                    Approve all {pendingMatched}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-emerald-900/80 dark:text-emerald-200/80">
                Real transaction found. Amount and reference agree.
              </p>
              {/* **Read, not worked** — but readable in full. It used to stop at
                  eight rows with nothing saying so, which turns the one bucket
                  the owner is meant to believe into one they cannot check: the
                  header says 38 matched and the list shows 8. Collapsed behind a
                  count instead, so the default is still a glance. */}
              <ul
                className={cn(
                  "mt-3 grid gap-1 text-sm",
                  showAllMatched ? "max-h-80 overflow-y-auto pr-1" : "",
                )}
              >
                {(showAllMatched
                  ? view.buckets.matched
                  : view.buckets.matched.slice(0, 8)
                ).map((row) => (
                  <li className="flex flex-wrap justify-between gap-2" key={row.eventId}>
                    <span>
                      {row.residentName || "Unknown"}
                      {row.period ? ` · ${monthLabel(row.period)}` : ""}
                    </span>
                    <span className="text-muted-foreground">
                      {currency(row.amount)} · {row.referenceCode ?? row.why}
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
                  className="mt-2 text-sm font-semibold text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-300"
                  onClick={() => setShowAllMatched((value) => !value)}
                  type="button"
                >
                  {showAllMatched
                    ? "Show fewer"
                    : `Show all ${view.buckets.matched.length}`}
                </button>
              ) : null}
            </div>

            {/* Bucket 2 — a resident says they paid, the statement disagrees. */}
            {view.buckets.claimedNoTransaction.length > 0 ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
                <p className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-300">
                  <AlertTriangle aria-hidden="true" className="size-4" />
                  {view.buckets.claimedNoTransaction.length} claimed, no transaction found
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs uppercase">
                    Needs you
                  </span>
                </p>
                <ul className="mt-3 grid gap-3">
                  {view.buckets.claimedNoTransaction.map((row) => (
                    <li
                      className="rounded-lg border border-border bg-background p-3"
                      key={row.claimEventId}
                    >
                      <p className="text-sm font-medium">
                        {row.residentName}
                        {row.bedLabel ? ` · ${row.bedLabel}` : ""}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">{row.why}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          className="h-9 rounded-lg"
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
                          className="h-9 rounded-lg"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              hostelAdminEndpoints.paymentClaimApprove(row.claimEventId),
                              null,
                              "Approved. Recorded against your name.",
                            )
                          }
                          type="button"
                          variant="outline"
                        >
                          Approve anyway
                        </Button>
                        <Button
                          className="h-9 rounded-lg"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              hostelAdminEndpoints.paymentClaimAsk(row.claimEventId),
                              null,
                              "Asked the resident for clearer details.",
                            )
                          }
                          type="button"
                          variant="outline"
                        >
                          Ask resident
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Bucket 2b — approved on trust, and still not in the account.
                Read-only on purpose (item E.6): the money is already credited
                and the resident already told it landed, so there is no one-tap
                correction here that would not be worse than the problem. What
                the owner needs is the names, so they can go and ask. */}
            {view.buckets.approvedNotInStatement.length > 0 ? (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4">
                <p className="flex items-center gap-2 font-semibold text-rose-900 dark:text-rose-300">
                  <AlertTriangle aria-hidden="true" className="size-4" />
                  {view.buckets.approvedNotInStatement.length} approved, never in a
                  statement
                  <span className="rounded bg-rose-500/20 px-2 py-0.5 text-xs uppercase">
                    Check
                  </span>
                </p>
                <p className="mt-1 text-sm text-rose-900/80 dark:text-rose-200/80">
                  These were approved on the strength of a screenshot and the money
                  has not appeared in this statement. Usually statement lag — but this
                  is the list a forged receipt ends up on.
                </p>
                <ul className="mt-3 grid gap-3">
                  {view.buckets.approvedNotInStatement.map((row) => (
                    <li
                      className="rounded-lg border border-border bg-background p-3"
                      key={row.claimEventId}
                    >
                      <p className="text-sm font-medium">
                        {row.residentName} · {currency(row.amount)}
                        {row.period ? ` · ${monthLabel(row.period)}` : ""}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">{row.why}</p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        Approved
                        {row.approvedAt ? ` ${shortDate(row.approvedAt)}` : ""}
                        {row.approvedByName ? ` by ${row.approvedByName}` : ""}
                        {row.transactionCode ? ` · txn ${row.transactionCode}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Bucket 3 — money nobody claimed. */}
            {view.buckets.orphans.length > 0 ? (
              <div className="rounded-lg border border-border bg-muted/60 p-4">
                <p className="flex items-center gap-2 font-semibold text-foreground">
                  <Coins aria-hidden="true" className="size-4" />
                  {view.buckets.orphans.length} payment
                  {view.buckets.orphans.length === 1 ? "" : "s"} nobody claimed
                  <span className="rounded bg-foreground px-2 py-0.5 text-xs uppercase text-background">
                    Needs you
                  </span>
                </p>
                <ul className="mt-3 grid gap-3">
                  {view.buckets.orphans.map((row) => (
                    <li
                      className="rounded-lg border border-border bg-background p-3"
                      key={row.eventId}
                    >
                      <p className="text-sm font-medium">
                        {currency(row.amount)} · {shortDate(row.occurredAt)}
                        {row.counterpartyName ? ` · from "${row.counterpartyName}"` : ""}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {row.providerTxnId ? `Txn ${row.providerTxnId}. ` : ""}
                        Remarks: {row.remarks?.trim() || "(empty)"}
                      </p>
                      {row.suggestions.length > 0 ? (
                        <ul className="mt-2 grid gap-2">
                          {row.suggestions.map((suggestion) => (
                            <li
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                              key={suggestion.invoiceId}
                            >
                              <span className="text-sm">
                                Suggested: {suggestion.why}
                                <span className="ml-2 text-xs uppercase text-muted-foreground">
                                  {suggestion.confidence}
                                </span>
                              </span>
                              <button
                                className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    hostelAdminEndpoints.paymentEventAssign(row.eventId),
                                    { invoiceId: suggestion.invoiceId },
                                    `Assigned to ${suggestion.residentName}.`,
                                  )
                                }
                                type="button"
                              >
                                Assign
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {/* Always available, not only when the ladder scored
                          nothing (§11.5). A suggestion is a suggestion, and the
                          owner who knows the transfer came from a resident's
                          parent needs a way to say so that does not depend on us
                          having guessed. */}
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
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  },
);
