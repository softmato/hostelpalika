"use client";

import { AlertTriangle, KeyRound, ShieldCheck, Trash2, Zap } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { EmptyState, Input, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
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
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    label: "Some payments are failing",
  },
  FAILING: {
    className: "border-destructive/40 bg-destructive/10 text-destructive",
    label: "Payments are not going through",
  },
  HEALTHY: {
    className:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    label: "Working",
  },
  QUIET: {
    className: "border-border bg-muted/50 text-muted-foreground",
    label: "No payments lately",
  },
};

function HealthBanner({ health }: { health: GatewayConfig["health"] }) {
  if (!health || health.status === "UNKNOWN") {
    return null;
  }

  const style = HEALTH_STYLE[health.status];

  return (
    <div className={`rounded-lg border p-3 text-sm ${style.className}`}>
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
      <p className="text-xs text-muted-foreground">
        No key stored yet. Test mode does not need one.
      </p>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
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
  onSave: (body: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const copy = PROVIDER_COPY[config.provider];
  const [accountKind, setAccountKind] = useState(config.accountKind);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const secret = field(form, "secret");

      onSave({
        accountKind,
        enabled: form.get("enabled") === "on",
        merchantCode: field(form, "merchantCode"),
        mode: form.get("mode") === "LIVE" ? "LIVE" : "SANDBOX",
        provider: config.provider,
        // Omitted rather than sent empty: an empty field means "leave the stored
        // key alone", which is what an owner editing a merchant code intends.
        ...(secret ? { secret } : {}),
      });
    },
    [accountKind, config.provider, onSave],
  );

  return (
    <Panel
      action={
        config.payable ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-700 dark:text-emerald-400">
            <Zap aria-hidden="true" className="size-3" />
            Live
          </span>
        ) : config.enabled ? (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-800 dark:text-amber-300">
            Not shown to residents
          </span>
        ) : null
      }
      title={copy.name}
    >
      <form className="space-y-3" onSubmit={submit}>
        <HealthBanner health={config.health} />
        <p className="text-sm text-muted-foreground">{copy.help}</p>

        {config.provider === "FONEPAY" ? (
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Account type
            </legend>
            <div className="flex flex-wrap gap-4 text-sm">
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
            {accountKind === "PERSONAL" ? (
              <p className="mt-2 flex items-start gap-2 rounded-md bg-amber-500/15 p-2 text-xs leading-4 font-semibold text-amber-800 dark:text-amber-300">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                A personal Fonepay account can only receive about NPR 5,000 per day, so
                rent payments would start failing partway through the month. It cannot be
                used for online checkout — collect through your bank account instead, and
                upload your personal QR on the payment details page if you want residents
                to see it.
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
          hint="Leave blank to keep the key already stored. It can be replaced, never read back."
          label={copy.secretLabel}
          name="secret"
          placeholder="••••••••••••"
          type="password"
        />
        <SecretState secret={config.secret} />
        <p className="text-xs leading-4 text-muted-foreground">{copy.where}</p>

        <div className="flex flex-wrap items-center gap-4 text-sm">
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
          <p className="flex items-start gap-2 rounded-md bg-amber-500/15 p-2 text-xs leading-4 font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {config.blockedReason}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-md bg-role-hostel-admin px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
            disabled={saving}
            type="submit"
          >
            Save {copy.name}
          </button>
          {config.secret.configured || config.merchantCode ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-2 text-sm font-semibold text-destructive transition hover:bg-destructive/10"
              onClick={() => onDelete(config.provider)}
              type="button"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Remove
            </button>
          ) : null}
        </div>
      </form>
    </Panel>
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
        } catch (error) {
          setMessage(
            error instanceof Error ? error.message : "Could not save this gateway.",
          );
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
      <div className="space-y-5">
        <PageHeader
          description="One-tap rent payments that settle themselves."
          icon={Zap}
          title="Online checkout"
        />

        <Message value={message} />

        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm leading-5">
          <p className="flex items-center gap-2 font-semibold">
            <ShieldCheck aria-hidden="true" className="size-4" />
            Money goes straight to your own account.
          </p>
          <p className="mt-1 text-muted-foreground">
            We hold a merchant code and a signing key — enough to request a payment and
            check one, and nothing else. We never ask for your bank login, your banking
            password, or card details, and a key you enter here can be replaced but never
            read back, by us or by anyone.
          </p>
        </div>

        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="Payment gateways could not be loaded." />
        ) : null}

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
    );
  },
);
