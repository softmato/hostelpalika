"use client";

import { useState, type FormEvent } from "react";

import { Panel } from "@/app/_components/shared-ui";
import { Pencil } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { toast } from "@/stores/toast-store";
import { FactChip } from "./platform-page-ui";

const OPERATIONS_ENDPOINT = "/api/v1/platform/operations-config";

/** `ROOM_REPAIR` → `Room repair`. */
function tradeLabel(trade: string) {
  const text = trade.toLowerCase().replace(/_/g, " ");

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The minimum call-out fee per maintenance trade — the platform's, not the
 * hostel's. Hostels see these read-only when they raise a job, and each request
 * keeps the figure it was raised at, so a change here only affects new jobs.
 *
 * Saved through operations config, which merges a partial body onto what is
 * stored and audits the save.
 */
export function MaintenanceChargesPanel() {
  const resource = usePortalResource<{
    config: { maintenanceMinimumCharges: Record<string, number> };
  }>(OPERATIONS_ENDPOINT, { errorMessage: "Could not load the call-out charges." });
  const saved = resource.data?.config.maintenanceMinimumCharges ?? null;
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const values =
    draft ??
    Object.fromEntries(Object.entries(saved ?? {}).map(([trade, amount]) => [trade, String(amount)]));
  const dirty =
    saved !== null && Object.entries(values).some(([trade, value]) => Number(value) !== saved[trade]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);

    try {
      await browserApi(OPERATIONS_ENDPOINT, {
        body: JSON.stringify({
          maintenanceMinimumCharges: Object.fromEntries(
            Object.entries(values).map(([trade, value]) => [trade, Number(value)]),
          ),
        }),
        method: "PUT",
      });
      setDraft(null);
      setEditing(false);
      resource.refresh();
      toast.success({ title: "Call-out charges saved" });
    } catch (error) {
      toast.error({
        description: error instanceof Error ? error.message : "Something went wrong.",
        title: "Charges not saved",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      action={
        saved === null ? null : (
          <Button onClick={() => setEditing(true)} size="sm" type="button" variant="outline">
            <Pencil className="size-3.5" />
            Edit
          </Button>
        )
      }
      title="Call-out charges"
    >
      {saved === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {resource.message || "Loading…"}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(saved).map(([trade, amount]) => (
            <FactChip glyph="build" key={trade}>{`${tradeLabel(trade)} · Rs ${amount.toLocaleString("en-IN")}`}</FactChip>
          ))}
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          setEditing(open);
          if (!open) setDraft(null);
        }}
        open={editing}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Call-out charges</DialogTitle>
            <DialogDescription>The least a job costs per trade. Hostels cannot change it; new jobs only.</DialogDescription>
          </DialogHeader>
          <form onSubmit={save}>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.keys(saved ?? {}).map((trade) => (
                <label className="text-xs font-semibold text-foreground" key={trade}>
                  {tradeLabel(trade)} (Rs)
                  <input
                    className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm tabular-nums outline-none focus:border-role-team"
                    max={100000}
                    min={0}
                    onChange={(event) => setDraft({ ...values, [trade]: event.target.value })}
                    required
                    step="1"
                    type="number"
                    value={values[trade] ?? ""}
                  />
                </label>
              ))}
            </div>
            <DialogFooter className="mt-4">
              <button
                className="h-10 rounded-lg bg-brand-teal px-4 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-50"
                disabled={saving || !dirty}
                type="submit"
              >
                {saving ? "Saving…" : "Save charges"}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}
