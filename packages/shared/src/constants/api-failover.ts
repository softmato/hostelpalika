/**
 * Go (`api.hostelpalika.com`) is the API; the TS routes deployed with the web
 * (`hostelpalika.com`) are its standby, and cost nothing until a request is sent
 * to them. One breaker per process (a browser tab, a server instance, the app)
 * picks the origin. Shared by the web (`fetch`) and the app (axios feeds it
 * through `reportFailure` / `reportSuccess`); it lives under `constants/` only
 * because that alias already resolves in both bundlers. No imports.
 *
 * - Down means unreachable: a network error, a timeout, or 502/504 from Caddy
 *   (no Go behind it). Any other answer, 500 included, is Go answering.
 * - One failure never moves traffic. It triggers a health probe; only a failed
 *   probe, or a second failure inside the window, trips the breaker. A blip on
 *   one phone's network stays on Go.
 * - Tripped, it probes `/api/v1/health` every {@link PROBE_EVERY_MS}; two
 *   healthy answers in a row send traffic back to Go.
 * - A GET that fails is retried on the standby at once. A write is not: after
 *   a network error Go may have saved it, so the caller sees the error and its
 *   retry goes to whichever side is up. No double writes.
 */
export const FAIL_WINDOW_MS = 30_000;
export const PROBE_EVERY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 3_000;
const HEALTHY_PROBES_TO_RETURN = 2;

/** `AbortSignal.timeout`, which Hermes (the app's engine) may not have. */
function timeoutSignal(ms: number) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

type Fetch = typeof fetch;

export class ApiBreaker {
  private lastFailure = 0;
  private trippedAt = 0;
  private healthyProbes = 0;
  private lastProbe = 0;
  private probing: Promise<boolean> | null = null;

  constructor(
    readonly primary: string,
    readonly standby: string,
    private readonly fetcher: Fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {}

  /** True while requests go to the standby. */
  get onStandby() {
    return this.trippedAt > 0;
  }

  /** Where a request should go now; also schedules the probe back to Go. */
  origin() {
    if (!this.enabled) return this.primary;
    if (this.onStandby) this.probeIfDue();
    return this.onStandby ? this.standby : this.primary;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.enabled) return this.fetcher(this.primary + path, init);
    if (this.onStandby) {
      this.probeIfDue();
      return this.fetcher(this.standby + path, init);
    }
    const method = (init.method ?? "GET").toUpperCase();
    const retryable = method === "GET" || method === "HEAD";
    try {
      const signal = init.signal ?? timeoutSignal(REQUEST_TIMEOUT_MS);
      const response = await this.fetcher(this.primary + path, { ...init, signal });
      if (response.status !== 502 && response.status !== 504) {
        this.reportSuccess();
        return response;
      }
      void this.reportFailure();
      // Caddy answered for Go: the request never reached it, so even a write is safe to resend.
      return this.fetcher(this.standby + path, init);
    } catch (error) {
      if (init.signal?.aborted) throw error; // the caller cancelled it
      void this.reportFailure();
      if (retryable) return this.fetcher(this.standby + path, init);
      throw error;
    }
  }

  private get enabled() {
    return this.primary !== this.standby;
  }

  /** Go answered: a lone earlier failure was a blip. */
  reportSuccess() {
    this.lastFailure = 0;
  }

  /**
   * Go was unreachable (network error, timeout, 502/504). A second failure in
   * the window, or a failed probe, trips the breaker.
   */
  async reportFailure() {
    const now = this.now();
    const second = this.lastFailure > 0 && now - this.lastFailure < FAIL_WINDOW_MS;
    this.lastFailure = now;
    if (second || !(await this.probe())) this.trip();
  }

  private trip() {
    if (!this.trippedAt) this.trippedAt = this.now();
    this.healthyProbes = 0;
    this.lastProbe = this.now();
  }

  private probeIfDue() {
    if (this.probing || this.now() - this.lastProbe < PROBE_EVERY_MS) return;
    void this.probe().then((ok) => {
      this.healthyProbes = ok ? this.healthyProbes + 1 : 0;
      if (this.healthyProbes >= HEALTHY_PROBES_TO_RETURN) {
        this.trippedAt = 0;
        this.lastFailure = 0;
        this.healthyProbes = 0;
      }
    });
  }

  private probe(): Promise<boolean> {
    this.probing ??= this.fetcher(`${this.primary}/api/v1/health`, {
      cache: "no-store",
      credentials: "omit",
      signal: timeoutSignal(PROBE_TIMEOUT_MS),
    })
      .then((response) => response.ok, () => false)
      .finally(() => {
        this.lastProbe = this.now();
        this.probing = null;
      });
    return this.probing;
  }
}
