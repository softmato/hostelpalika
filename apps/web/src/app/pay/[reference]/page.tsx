import type { Metadata } from "next";

import { serverApi, ServerApiError } from "@/lib/server-api";

type FormPostHandoff = {
  amount: number;
  /** Emission order is the signature's order. Never re-sort this. */
  fields: Record<string, string>;
  reference: string;
  sandbox: boolean;
  url: string;
};

/**
 * The eSewa hand-off relay.
 *
 * ## What it is for
 *
 * eSewa's checkout is a signed **form POST**, and a phone can only open URLs.
 * `expo-web-browser` and `Linking.openURL` both take a URL; Chrome refuses to
 * navigate to a `data:` URL carrying a self-submitting form; and re-signing the
 * fields on the client would put the merchant secret on a handset. So the app
 * opens this page instead, and the page carries the form. The secret stays on
 * the server and the *resident's* browser is still what arrives at eSewa, which
 * is the requirement that made `FORM_POST` a handoff kind in the first place.
 *
 * The web portal does not use this — it holds the fields already and posts them
 * itself. This page exists for clients that cannot.
 *
 * ## Why it submits itself but still shows a button
 *
 * The auto-submit is the happy path: nobody wants an interstitial. But a page
 * whose only way forward is a script is a dead end the moment the script does
 * not run — a stricter browser, a slow connection cut mid-load, a WebView with
 * JS disabled — and the dead end would be in the middle of paying rent. The
 * button is the fallback, and it is a real submit control on a real form, not a
 * second code path.
 *
 * ## No session, deliberately
 *
 * The browser this opens in has no app session; that is the problem being
 * solved. The API (`buildFormPostHandoff`) is what bounds the exposure — `CREATED` only,
 * unexpired only, and nothing on the page but an amount and a merchant form.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // Not a page anybody should reach from a search result: it is a step inside
  // one person's checkout, and it is dead fifteen minutes later.
  robots: { follow: false, index: false },
  title: "Continue to payment",
};

export default async function GatewayRelayPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;

  let handoff: FormPostHandoff;

  try {
    handoff = (
      await serverApi<{ handoff: FormPostHandoff }>(
        `/api/v1/public/payments/${encodeURIComponent(decodeURIComponent(reference))}/handoff`,
        { revalidate: 0 },
      )
    ).handoff;
  } catch (error) {
    return (
      <RelayShell>
        <h1 className="text-lg font-semibold text-stone-900">
          {error instanceof ServerApiError && error.code?.startsWith("HANDOFF_")
            ? "This payment link cannot be used"
            : "Something went wrong"}
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          {error instanceof ServerApiError && error.code?.startsWith("HANDOFF_")
            ? error.message
            : "Please go back to the app and start the payment again."}
        </p>
        <p className="mt-6 text-sm text-stone-500">
          You can close this page and try again from the app. Nothing has been
          charged.
        </p>
      </RelayShell>
    );
  }

  return (
    <RelayShell>
      <h1 className="text-lg font-semibold text-stone-900">Continue to eSewa</h1>
      <p className="mt-2 text-sm text-stone-600">
        {`Paying NPR ${handoff.amount.toLocaleString()} for ${handoff.reference}.`}
      </p>

      {handoff.sandbox ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
          Test mode — no real money will move.
        </p>
      ) : null}

      <form action={handoff.url} className="mt-6" id="gateway-handoff" method="POST">
        {/*
          Emitted in the order `createIntent` built them. eSewa signs its fields
          positionally against `signed_field_names`, so re-sorting these — which
          is what an object spread through anything that normalises key order
          would do — produces a signature error that mentions nothing about
          ordering.
        */}
        {Object.entries(handoff.fields).map(([name, value]) => (
          <input key={name} name={name} type="hidden" value={value} />
        ))}

        <button
          className="w-full rounded-xl bg-[#0a8a4b] px-4 py-3 text-sm font-semibold text-white"
          type="submit"
        >
          Continue to eSewa
        </button>
      </form>

      <p className="mt-4 text-sm text-stone-500">
        You&apos;ll come back to the app once eSewa is done. If this page does not
        move on its own, use the button.
      </p>

      {/*
        Inline and dependency-free: this runs before any bundle would have
        loaded, which is the point — the fewer things between opening the page
        and reaching eSewa, the fewer ways rent fails to get paid.
      */}
      <script
        dangerouslySetInnerHTML={{
          __html: `document.getElementById("gateway-handoff").submit();`,
        }}
      />
    </RelayShell>
  );
}

function RelayShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-5 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-6 text-center">
        {children}
      </div>
    </main>
  );
}
