"use client";

import { AlertTriangle, KeyRound, Pencil, ShieldCheck, Trash2, Zap } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { EmptyState, Input, LoadingRows } from "@/app/_components/shared-ui";
import { Chip } from "@/app/_components/hostel-admin-page-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { Message, PageHeader, field } from "./portal-shared";

/**
 * Online checkout setup, one card per provider (target §11.8 and §6.7, item 6.6).
 *
 * Every provider is shown whether or not it is configured, so this reads as a
 * list of what the hostel *could* accept rather than a list of what somebody
 * already set up. An owner who has never opened it sees three cards and what
 * each one needs from their bank.
 *
 * **A stored key is never displayed, only replaced.** The server returns a
 * fingerprint and a date; there is no reveal endpoint and none can be added
 * without changing that signature. Leaving the key field blank keeps whatever is
 * stored, which is what an owner editing a merchant code will always do.
 *
 * The Fonepay card is the one that says no. A personal wallet is stored happily
 * — an owner should be able to record what they have — but it cannot be switched
 * on, because a personal account credits about NPR 5,000 a day and rent payments
 * would start failing partway through the month with the resident seeing the
 * network's rejection rather than anything we could explain.
 */

type SecretView = {
  configured: boolean;
  fingerprint: string | null;
  rotatedAt: string | null;
};

type GatewayHealthStatus = "DEGRADED" | "FAILING" | "HEALTHY" | "QUIET" | "UNKNOWN";

type GatewayConfig = {
  accountKind: "MERCHANT" | "PERSONAL";
  blockedReason: string | null;
  enabled: boolean;
  enabledAt: string | null;
  health: { detail: string | null; status: GatewayHealthStatus } | null;
  lastEventAt: string | null;
  merchantCode: string | null;
  mode: "LIVE" | "SANDBOX";
  payable: boolean;
  provider: "ESEWA" | "FONEPAY" | "KHALTI";
  secret: SecretView;
};

/**
 * How each verdict reads on the screen.
 *
 * `FAILING` gets destructive styling and the plainest wording available, because
 * it means residents are trying to pay and cannot — the one state where a
 * softened phrase costs the owner a month of rent.
 */
const HEALTH_STYLE: Record<
  Exclude<GatewayHealthStatus, "UNKNOWN">,
  { className: string; label: string }
> = {
  DEGRADED: {
    className: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    label: "Some payments are failing",
  },
  FAILING: {
    className: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
    label: "Payments are not going through",
  },
  HEALTHY: {
    className: "bg-role-team-soft text-role-team",
    label: "Working",
  },
  QUIET: {
    className: "bg-muted text-muted-foreground",
    label: "No payments lately",
  },
};

function HealthBanner({ health }: { health: GatewayConfig["health"] }) {
  if (!health || health.status === "UNKNOWN") {
    return null;
  }

  const style = HEALTH_STYLE[health.status];

  return (
    <div className={cn("rounded-xl px-3 py-2.5 text-[13px]", style.className)}>
      <p className="flex items-center gap-2 font-semibold">
        {health.status === "HEALTHY" ? (
          <ShieldCheck aria-hidden="true" className="size-4" />
        ) : (
          <AlertTriangle aria-hidden="true" className="size-4" />
        )}
        {style.label}
      </p>
      {health.detail ? <p className="mt-1 leading-5">{health.detail}</p> : null}
    </div>
  );
}

const PROVIDER_COPY: Record<
  GatewayConfig["provider"],
  {
    help: string;
    merchantLabel: string | null;
    name: string;
    secretLabel: string;
    where: string;
  }
> = {
  ESEWA: {
    help: "Residents pay on eSewa's own screen and the invoice settles itself — no screenshot, no approval.",
    merchantLabel: "Product code",
    name: "eSewa",
    secretLabel: "Secret key",
    where: "From your eSewa merchant account. Test mode works today with eSewa's public test merchant — leave both fields blank for that.",
  },
  FONEPAY: {
    help: "Fonepay's QR is read by every bank app in Nepal, which is why it is worth having as a merchant.",
    merchantLabel: "Merchant code",
    name: "Fonepay",
    secretLabel: "Shared secret",
    where: "Issued by the bank that holds your merchant account, not by Fonepay. Ask them to enable dynamic QR / online acceptance.",
  },
  KHALTI: {
    help: "Residents pay on Khalti's own screen and the invoice settles itself.",
    merchantLabel: null,
    name: "Khalti",
    secretLabel: "Secret key",
    where: "From your Khalti merchant dashboard. Khalti identifies you by this key alone, so there is no merchant code to enter.",
  },
};

function SecretState({ secret }: { secret: SecretView }) {
  if (!secret.configured) {
    return (
      <p className="text-[12px] text-muted-foreground">
        No key stored yet. Test mode does not need one.
      </p>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-[12px] font-semibold text-role-team">
      <KeyRound aria-hidden="true" className="size-3.5" />
      Key installed · {secret.fingerprint}
      {secret.rotatedAt
        ? ` · replaced ${new Date(secret.rotatedAt).toLocaleDateString()}`
        : ""}
    </p>
  );
}

function GatewayCard({
  config,
  onDelete,
  onSave,
  saving,
}: {
  config: GatewayConfig;
  onDelete: (provider: GatewayConfig["provider"]) => void;
  /** `true` when the server took it, so the dialog can close. */
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  saving: boolean;
}) {
  const copy = PROVIDER_COPY[config.provider];
  const [accountKind, setAccountKind] = useState(config.accountKind);
  const [open, setOpen] = useState(false);
  const set = config.secret.configured || Boolean(config.merchantCode);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const secret = field(form, "secret");

      void onSave({
        accountKind,
        enabled: form.get("enabled") === "on",
        merchantCode: field(form, "merchantCode"),
        mode: form.get("mode") === "LIVE" ? "LIVE" : "SANDBOX",
        provider: config.provider,
        // Omitted rather than sent empty: an empty field means "leave the stored
        // key alone", which is what an owner editing a merchant code intends.
        ...(secret ? { secret } : {}),
      }).then((ok) => {
        if (ok) setOpen(false);
      });
    },
    [accountKind, config.provider, onSave],
  );

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-10 items-center justify-center rounded-full bg-role-team-soft text-role-team">
            <Zap aria-hidden="true" className="size-[18px]" />
          </span>
          <h3 className="font-heading text-[15px] font-bold text-foreground">{copy.name}</h3>
        </div>
        {config.payable ? (
          <Chip glyph="flash" tone="brand">Live</Chip>
        ) : config.enabled ? (
          <Chip tone="warn">Not shown to residents</Chip>
        ) : (
          <Chip>{set ? "Off" : "Not set"}</Chip>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">{copy.help}</p>
      <HealthBanner health={config.health} />
      <div className="flex flex-wrap gap-1.5">
        <Chip glyph="key" tone={config.secret.configured ? "brand" : "neutral"}>
          {config.secret.configured ? `Key ${config.secret.fingerprint ?? "installed"}` : "No key"}
        </Chip>
        <Chip glyph={config.mode === "LIVE" ? "cash" : "flask"}>{config.mode === "LIVE" ? "Real money" : "Test mode"}</Chip>
        {config.merchantCode ? <Chip glyph="pricetag">{config.merchantCode}</Chip> : null}
      </div>
      <div className="mt-auto flex gap-2 pt-1">
        <Button onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
          <Pencil aria-hidden="true" className="size-3.5" />
          {set ? "Edit" : "Set up"}
        </Button>
        {set ? (
          <Button
            className="text-muted-foreground hover:text-destructive"
            disabled={saving}
            onClick={() => onDelete(config.provider)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
            Remove
          </Button>
        ) : null}
      </div>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{copy.name}</DialogTitle>
            <DialogDescription>{copy.where}</DialogDescription>
          </DialogHeader>
      <form className="space-y-3" onSubmit={submit}>
        {config.provider === "FONEPAY" ? (
          <fieldset className="rounded-xl border border-border p-3">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Account type
            </legend>
            <div className="flex flex-wrap gap-4 text-[13.5px]">
              {(["MERCHANT", "PERSONAL"] as const).map((kind) => (
                <label className="flex items-center gap-2" key={kind}>
                  <input
                    checked={accountKind === kind}
                    name={`accountKind-${config.provider}`}
                    onChange={() => setAccountKind(kind)}
                    type="radio"
                  />
                  {kind === "MERCHANT" ? "Registered merchant" : "Personal wallet"}
                </label>
              ))}
            </div>
            {/* A personal Fonepay account receives about NPR 5,000 a day, so rent
                would start failing partway through the month. It is stored but
                never switched on; the personal QR belongs on Payment Setup. */}
            {accountKind === "PERSONAL" ? (
              <p className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-[12px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                About NPR 5,000 a day only — it cannot run online checkout.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {copy.merchantLabel ? (
          <Input
            defaultValue={config.merchantCode ?? ""}
            label={copy.merchantLabel}
            name="merchantCode"
            placeholder={config.provider === "ESEWA" ? "EPAYTEST" : ""}
          />
        ) : null}

        <Input
          hint="Blank keeps the stored key. It can be replaced, never read back."
          label={copy.secretLabel}
          name="secret"
          placeholder="••••••••••••"
          type="password"
        />
        <SecretState secret={config.secret} />

        <div className="flex flex-wrap items-center gap-4 text-[13.5px]">
          <label className="flex items-center gap-2">
            <input
              defaultChecked={config.mode === "LIVE"}
              name="mode"
              type="checkbox"
              value="LIVE"
            />
            Live mode (real money)
          </label>
          <label className="flex items-center gap-2">
            <input defaultChecked={config.enabled} name="enabled" type="checkbox" />
            Offer this to residents
          </label>
        </div>

        {config.blockedReason ? (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-[12px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {config.blockedReason}
          </p>
        ) : null}

        <div className="flex justify-end">
          <button
            className="h-10 rounded-xl bg-brand-teal px-4 text-[13.5px] font-semibold text-white transition hover:bg-brand-teal/90 disabled:opacity-60"
            disabled={saving}
            type="submit"
          >
            Save {copy.name}
          </button>
        </div>
      </form>
        </DialogContent>
      </Dialog>
    </article>
  );
}

export const HostelAdminPaymentGatewaysPageContent = memo(
  function HostelAdminPaymentGatewaysPageContent() {
    const [message, setMessage] = useState("");
    const [saving, setSaving] = useState(false);

    const resource = usePortalResource<{ gateways: GatewayConfig[] }>(
      hostelAdminEndpoints.paymentGateways,
      { errorMessage: "Could not load payment gateways." },
    );
    const gateways = resource.data?.gateways ?? [];

    const save = useCallback(
      async (body: Record<string, unknown>) => {
        setSaving(true);
        setMessage("");

        try {
          await browserApi(hostelAdminEndpoints.paymentGateways, {
            body: JSON.stringify(body),
            method: "PUT",
          });
          setMessage("Saved.");
          await resource.refreshAsync();
          return true;
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save this gateway.",
          );
          return false;
        } finally {
          setSaving(false);
        }
      },
      [resource],
    );

    const remove = useCallback(
      async (provider: GatewayConfig["provider"]) => {
        setSaving(true);
        setMessage("");

        try {
          await browserApi(
            `${hostelAdminEndpoints.paymentGateways}?provider=${provider}`,
            { method: "DELETE" },
          );
          setMessage("Removed, along with its stored key.");
          await resource.refreshAsync();
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not remove this gateway.",
          );
        } finally {
          setSaving(false);
        }
      },
      [resource],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          description="One-tap rent payments that settle themselves."
          icon={Zap}
          title="Online checkout"
        />

        <Message value={message} />

        {/* We hold a merchant code and a signing key — enough to request a
            payment and check one, nothing else. No bank login, banking password
            or card details, and a key can be replaced but never read back. */}
        <p className="flex items-center gap-2 rounded-xl bg-role-team-soft px-4 py-3 text-[13.5px] font-semibold text-role-team">
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
          Money goes straight to your own account. We never see your bank login.
        </p>

        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="Payment gateways could not be loaded." />
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {gateways.map((config) => (
            <GatewayCard
              config={config}
              key={config.provider}
              onDelete={remove}
              onSave={save}
              saving={saving}
            />
          ))}
        </div>
      </div>
    );
  },
);
