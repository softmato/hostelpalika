# PRD.md — Standalone API: requirements

## 1. Problem

The HostelPalika backend is 512 Next.js route files inside `apps/web`, running as
Vercel serverless functions. That costs us:

- **Cold starts** — a function that has gone cold adds hundreds of milliseconds to
  seconds before any code runs. The PWA has already hit 20 s timeouts from
  cold-start index floods.
- **Coupling** — the web cannot move host, plan or framework without moving the
  whole backend with it. The web cannot drop to Vercel Hobby while it carries
  the API, crons and Mongo connections.
- **No long-lived process** — no in-memory pools, no local Redis, no in-process
  scheduler, no own WebSockets. Crons are driven by cron-job.org over HTTP;
  "finish after the response" needs `after()` because the function is frozen.
- **Single-threaded CPU work** — PDF rendering, bcrypt, xlsx parsing, image
  processing and receipt hashing block Node's event loop for every other
  request on that instance.

## 2. Goal

One standalone backend service that:

1. Serves **every** endpoint the TS server serves today, with identical
   behaviour (PARITY.md is the definition of "every").
2. Is consumed over HTTPS by the web (Vercel), the Android app, and the PWA —
   no client talks to MongoDB directly.
3. Runs as a long-lived process in Docker on a Kathmandu VPS beside its own Redis.
4. Runs every scheduled job itself.
5. Answers as close to 0 ms of server time as the work allows (DESIGN.md §2
   holds the budgets).

## 3. Non-goals

- **No behaviour changes during the port.** Bugs found while porting are fixed
  in the TS server first (so the spec stays the spec), then ported.
- **No API redesign.** Paths, payloads, status codes and error codes stay. A
  cleaner v2 can come after cut-over, as its own project.
- **No schema migration.** Same collections, same fields, same indexes.
- **No client rewrite.** Web and app change their base URL, nothing else — apart
  from the 56 web files that query Mongo directly (PARITY.md §9).

## 4. Consumers

| Consumer | How it calls | Auth |
|---|---|---|
| Web (Next.js on Vercel) — browser | `fetch` to `https://api.hostelpalika.com` with credentials | cookies on `.hostelpalika.com` |
| Web — server components / SEO pages | server-side `fetch` to the API | forwarded cookie or none (public) |
| Android app (Expo) | `fetch` with bearer token, `x-hostelhub-client`, `x-hostel-id` | access + rotating refresh token |
| PWA (`/app`, Expo web export) | same as the app | same |
| cron-job.org | `POST /api/v1/cron/*` with `x-cron-secret` | until each job moves in-process |
| GitHub Actions (platform backup) | `POST /api/v1/cron/platform-backup` | `x-cron-secret` |
| Payment gateways, Softmato, QuestionCall | webhooks | signatures / shared secrets |

## 5. Success criteria

- Every ☐ in PARITY.md is ☑ at the current baseline.
- Contract tests (TESTING.md §3) pass for every route against recordings from
  the TS server.
- Server time (the `Server-Timing: app` value) meets DESIGN.md §2 at p95 under
  the k6 load profile.
- Nobody is logged out by the cut-over.
- No cron job is missed or run twice during the switch.
- The web runs with no `MONGODB_URI`.

## 6. Constraints from outside our code

These are real limits; everything inside the repo is just work.

- **Vercel Hobby is for non-commercial use only.** HostelPalika is commercial,
  so a Hobby web risks suspension. Options: Vercel Pro, Cloudflare Pages (free
  tier allows commercial use), or the web as a container on the same VPS.
- **Distance.** The API is in Kathmandu, but Atlas (no Nepal region) and
  Vercel (`bom1`) are in Mumbai, so every Mongo query and every web SSR fetch
  crosses the border. No server change removes that hop; Redis-first reads,
  `revalidate` on public pages and fewer round trips hide it.
- **Atlas M0** is a shared, throttled tier with no backups. It caps query
  latency whatever the server is written in.
- **Play payments policy** — unchanged: resident rent via eSewa/Khalti is
  allowed in-app; the hostel plan is paid on the website only.
- **Expo push** is the only route to FCM/APNs for the app; the Go server talks
  to Expo, not to Firebase.
