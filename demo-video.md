# HostelPalika demo videos — the shoot plan

The live work order for the demo/tutorial videos. A new session reads this file top to
bottom, then runs the shoot chapter by chapter and ticks ☐ → ☑ here as each take lands.

**This round: the app video only.** The web video comes later, as its own plan.

Sources this was built from: the handbook (`packages/shared/src/guide/guide.ts`, every
role's chapters + "How it connects"), `docs/FEATURES_BY_CATEGORY.md`,
`apps/web/src/lib/portal-nav.ts`, `docs/RECEIPT_SHARE.md`, `docs/CRON.md`.

---

## 1. The idea: record once, cut five

We do **not** shoot five separate videos. We shoot **one story** — a hostel's first
month, from installing the app to a resident moving out — on two phones that are
**both screen-recorded in every take**. Each chapter is tagged with the videos it feeds.

### How it looks (motion graphic, HyperFrames)

- **Solo — the default.** One phone screen fills the frame, clean and full size, so every
  tap and every component is readable. A soft tap ripple shows where the finger went. No
  clutter around it.
- **Duo — only when the other phone is the point** (★ chapters): the owner taps on one
  phone and the result lands on the other. Both phones side by side, a role badge over
  each, a pulse travels across, the receiving screen punches in. Then back to Solo.
- **Swap** — the move between Solo and Duo, or from one role's phone to the other's.
- **Cards** — a title card per act, a short chapter title, lower-third captions.

| Video | Whose phone is the Solo screen | Built from |
|---|---|---|
| **ADM** — Hostel Admin: complete guide (the super video) | Owner | every chapter |
| **WAR** — Warden | Warden | chapters tagged WAR |
| **RES** — Resident | Resident | chapters tagged RES |
| **COOK** — Cook | Cook | chapters tagged COOK |
| **GUA** — Guardian | Guardian | chapters tagged GUA |

The same two recordings make every video: a chapter filmed as "owner → warden" is the
owner's lesson in ADM and the warden's lesson in WAR. Only the framing changes. That is
how resident↔warden work appears in the resident video without filming it twice.

Chapters where the warden does exactly what the owner did (add a resident, notices,
complaints, move-out) are tagged WAR too, and the voiceover says "owner or warden".

### Build it with the promo-film toolkit — read `marketing/video/PLAYBOOK.md` first

The promo films already solved capture, voice, sound and the phone rig. Reuse all of it:
- **Capture:** `marketing/video/capture/rec.sh` (screen record + a time-stamped touch log, so
  the film draws the finger and the ring exactly where it tapped) and `capture/ui.mjs`
  (find elements by label). It drives one phone through plain `adb`. Extend it for two
  phones: one recorder and one touch log per phone, picked with `ANDROID_SERIAL`.
- **Film:** a new `marketing/video/demo-film/` on the shared `lib/` (`film.mjs` pipeline,
  `phone.mjs` rig, close-ups with frosted screen + green ring + sound, `blur` boxes).
- **Look and sound:** the playbook's rules — white moving mesh, black type, green accent
  only, a soft sound on every tap and zoom, music that never thins out, status bar cropped
  and redrawn clean.
- **Sound tools (installed globally 2026-11-19):**
  - **earshot** — MCP server `earshot` + CLI `earshot`. Its bank of code-made SFX
    (`earshot sfx list / render`, `earshot kit` with the `launch` preset) places taps, pops
    and whooshes against the cut and the music bed. Before delivery, `earshot critique
    <film>.mp4` and `earshot timeline --video` check the mix and the sync to the picture.
  - **openverse-sfx** skill — real recorded CC0 sound effects from Openverse/Freesound
    (`~/.claude/skills/openverse-sfx/scripts/search.sh <keyword> cc0`), for anything the
    bank does not have (paper, cash, phone buzz, ambience). Keep `license=cc0`.

### Pace and voice

- **Every feature is explained by doing it, calmly.** The action happens at a relaxed pace,
  the voice explains it, the result holds on screen. Every main button gets a close-up.
- **Forms are not lessons.** Fill them fast with any sensible demo names; the edit speeds
  them up and the voice covers them in one sentence.
- **Voice: ElevenLabs Sunita** (`kiOHzNtCRPG6PpJF256k`), model `eleven_v3`, `language_code
  "ne"`, through `marketing/video/tts.mjs`. The key is already in `marketing/video/.env`.
  Emotion tags (`[warmly]`, `[confident]`), then sped up 1.1–1.25× and loudness-normalised.
- **How the narration is written** (owner's standing rules from the promo films):
  - **Complete, clear sentences.** Never fragments or bullet-point phrasing.
  - **Two sentences per feature:** the everyday problem, then what the app does about it.
  - Spoken Nepali; English feature words written in Devanagari (रुम, पेमेन्ट, रेजिडेन्ट,
    वार्डेन, अप्रुभ), never formal Nepali equivalents.
  - Conversational and warm ("अनि…", "हेर्नुहोस्…"), trustworthy, never salesy claims.
    Only true statements; no invented numbers.
  - On screen: the English feature name, a Nepali line under it, Nepali subtitles of the voice.
  - Write the whole script first and get the owner's OK before generating any audio.

## 2. Accounts and who is on which phone

Dummy accounts, made for the shoot. Names: any sensible Nepali names, set when each
account is registered or added.

| Key | Role | Email |
|---|---|---|
| O | Hostel admin (owner) | yobaweb977@kranove.com |
| W | Warden | jikeke4595@kranove.com |
| R | Resident (1st) | vilet87824@dvdee.com |
| C | Cook | kitchen login himaj7@cook.local, named Hari Magar (2026-11-21; the invite to fedax13245@afronewz.com could not be accepted: inbox lost) |
| G | Guardian (R's parent) | lixofi6457@forims.com (2026-11-22; the first address's temp inbox was lost) |
| R2 | Resident (2nd) — form demo, removed in ch 49, never signs in | posigin416@afronewz.com |

One account per role: once an account is a warden, adding it as a resident is refused
(`EMAIL_ALREADY_HAS_ROLE`, `warden.service.ts`).

### Signing in

The owner asked for the session to type the passwords on the login screen. **The session
cannot do that part**: the app talks to the live server (`apps/mobile/src/lib/api.ts`
always uses the production API), and typing a password into a live service is a fixed
safety rule for Claude. It holds even for dummy accounts and even when the owner says yes.
It is not a code limit and not something a later session can switch off.

So each sign-in goes like this: the session opens the login screen, types the **email**,
and stops; the owner types the password on the phone and taps Sign in; the session carries
on. Same for any email code. **Never write a password in this file** — the repo is public.

The phones are assigned so there are only **8 sign-ins in the whole shoot**:

| # | Phone | Account | When |
|---|---|---|---|
| 1 | A | O | ch 03 (registering the hostel) |
| 2 | B | W | ch 13 |
| 3 | B | R | ch 21 |
| 4 | A | W | start of Act 5 |
| 5 | B | C | start of Act 7 |
| 6 | A | R | ch 43 |
| 7 | B | G | ch 45 |
| 8 | B | O | start of Act 9 (the owner lives on phone B from here) |

If an account does not exist on HostelPalika yet, it is registered as a normal account at
its first sign-in (the owner types the password and any code).

| Act | 📱A | 📱B |
|---|---|---|
| 1 Get started | O | — |
| 2 Set up | O | signed out (visitor) |
| 3 Your staff | O | W |
| 4 Your residents join | O | R |
| 5 Collecting rent | W | R |
| 6 When rent is late | W | R |
| 7 The kitchen | W, then R | C |
| 8 Families | R | G |
| 9 Moving out | R | O |
| 10 Your numbers | — | O |
| 11 Your plan | — | O |

### The owner's hands, and only here
The session pauses and says exactly what to do:
- The 8 passwords above, and any email code.
- Fingerprint and app-lock PIN (ch 06 only; app lock goes off again straight after).
- The superadmin **Approve** on the KYC (ch 05) and on the plan payment (ch 57).
- Saying yes before R2 is removed (ch 49).

**No real money moves anywhere.** Expenses use a receipt the phone already has. Rent is
collected at the warden's desk (the main lane). The resident's "send a receipt" lane uses
an old receipt from the gallery, presented as "a receipt you paid to your hostel". The plan
payment proof (ch 57) is the same kind of image.

## 3. Before the first take

Owner:
☑ Store build done, live on Play, installed from Play on both phones (2026-11-19).
☑ Both phones: USB debugging on, plugged in, screen lock set to swipe or none (the session cannot type a phone PIN).
☑ Both phones: Do Not Disturb on, HostelPalika allowed through.
☐ Phone B: three old payment receipts in the gallery (eSewa / Khalti / bank screenshots or
PDFs, small amounts): for the expense share (ch 17), the resident's receipt (ch 35), the plan
payment (ch 57). Names and numbers on them get blurred in the edit.
☑ Both phones: Developer options → Stay awake on.
☐ Answer the open decisions (§9).

Session:
☑ `adb devices -l` shows both. Serials: A `RZCY81L8MCZ` (Samsung SM-A176B, 1080×2340) · B `061162513H005522` (Infinix X682B, 720×1640, the promo-film phone).
☑ The Play Store build is the one installed on both phones (`adb shell dumpsys package com.softmato.hostelpalika | grep versionCode` ≥ 34), not the dev build. 2026-11-20: v35 from `com.android.vending` on both.
☑ `capture/rec.sh` extended for two phones (§1) and tried on both: `rec2_start <NN-slug> <s>` / `rec2_stop`, `on A` / `on B` points every helper at that phone.
☐ Narration script for the whole video written and approved by the owner (§1).
◐ Demo data + scenario script (§6): `dev demo seed-history` / `unseed` / `inspect` built, tested (`TestDemoSeedPlan`) and **run 2026-11-20** (commit 6334ce3e). Time scenarios (`rent-due-soon` … `plan-past-due`, `statement-file`, `restore`) still to build, before Act 6.
◐ Sample images (§7): documents made (`marketing/video/demo-film/assets/make-samples.py` → `samples/`) and pushed to both phones. Hostel photos + food photo still to make (needed from ch 12 / ch 43).

## 4. Which build to film: the Play Store build — ☑ done

**Done 2026-11-19:** the store build is live on Play and installed from Play on both phones.
For ch 02, uninstall it from one phone (owner's yes) and film the real install from Play.

How it was made, for next time. Never film a dev build: it shows the dev-client menu and
overlays, runs JS in dev mode (slower, warning toasts), and a viewer would see all of it.

The owner runs the store build (many native changes since the last one, so an OTA is not
enough). From `apps/mobile`:

```
npx eas build --profile store-android --platform android
```

The first run (2026-11-19, eas-cli 22.0.0) died with `expo config --json exited with non-zero
code: 3221226505` (0xC0000409: Node aborted natively). The same `expo config` and
`eas config --profile store-android` ran clean straight after, with the same EAS
environment. Fix: `npm install -g eas-cli` (27.x), then run the build again.

`store-android` = production environment and API, production channel, `app-bundle` (AAB),
version code bumped by EAS. It builds the working tree as it is, uncommitted changes included.
Upload the AAB to Play (internal testing is quickest), then install from the Play Store on
both phones. **Uninstall the dev build first**: same package (`com.softmato.hostelpalika`),
different signature, so Play cannot install over it. Filming that Play install is ch 02.

## 5. How the session runs a take

1. Say the setup for the chapter (who is signed in on A and B). For a sign-in, follow §2.
   For any other hand moment, stop and tell the owner exactly what to tap; carry on at "ready".
2. Dry-run once without recording (`ui.mjs list`, get the coordinates), back out.
3. Start both recordings with the two-phone `rec.sh` (clips `NN-slug-A` / `NN-slug-B` in
   `marketing/video/assets/raw/clips/`, each with its `.touches` log). `screenrecord` stops at
   180 s, so a longer chapter is two clips.
4. Drive with the `rec.sh` helpers (`tapt "Label"`, `tap`, `swipe`, `type_slow`) so every
   touch is logged. Typing is ASCII only — data is romanized. Calm pace on the feature
   itself, quick on forms. Check `mInputShown` before using BACK to hide a keyboard.
5. Hold **2 s on the proof moment** (balance changed, notification arrived, receipt shown).
6. Stop both recordings, check with `sheet`. Tick the chapter here with the clip names and the balance seen.
7. Anything broken or confusing → log it in §10. Do not change UI mid-shoot (screens must
   match across takes) unless the owner says so.

**Never:**
- Press **Run now** on the superadmin Cron page. Those jobs run for every hostel, so real
  residents would get pushes. Time-based chapters use the scenario script (§6) or the demo
  hostel's own settings (night-status hour, meal times, notice days) set a little ahead.
- Show real personal data: no real contacts, no real ID cards; receipts blurred in the edit.

**Phones are the owner's daily phones**: keep adb to taps, typing, screenshots and screen recording.

## 6. Demo data and scenario script

Two jobs, one tool. **Produce the data** the money screens need (statement, expenses,
reports, bookings, bank import) so they look like a hostel that has been running for months —
no real hostel's account, no real residents on camera. And **move the calendar** for the
time-based states (bills, reminders, late fines, the plan running out): move **only the demo
hostel** into each state, then run the real job code for that hostel alone.

Build it where the jobs live: a `dev` subcommand in the Go server (read
`server/docs/MISSION.md` first). It must refuse any hostel id except the demo hostel's.

| Scenario | What it sets up | Filmed in |
|---|---|---|
| `rent-due-soon` | Open rent of the residents who can sign in (Aarav) falls due in 2 days → reminder bell + push | ch 38 |
| `rent-overdue` | Those bills fall due before the late-fine grace → FINE lines (late fine must be on) + overdue notice | ch 39–40 |
| `month-roll` | Next BS month's bills raised for this hostel (they stay; that month's own run finds them billed) | ch 41 |
| `trial-ending` | Trial ends in 2 days → owner's bell "ends in 2 days" + email | ch 55 |
| `trial-ended` | Trial ended an hour ago → Free plan, locked tiles | ch 56 |
| `plan-past-due` | A bought plan's period ended yesterday → renewal bill, PAST_DUE, back on the Free plan (no suspension any more: the code drops lapsed plans to Free) | ch 58 |
| `seed-bookings` | One booking waiting for the hostel (Bishal Karki, Single), one confirmed (Sandesh Lama, Double). Ghost guests: no user, no email, no Softmato invoice, so no sweep or refund can reach anyone. Run just before ch 21b | ch 21b |
| `statement-file` | `marketing/video/demo-film/samples/esewa-statement.csv` in eSewa's real app-export format: what the open seeded bills still owe, from each resident by name, plus a stranger and two debits. Push it to the phone's Download before ch 50a | ch 50a |
| `restore` | Due dates, trial/plan dates put back; the renewal bill voided (number kept); seeded bookings and their bells removed; plan limits recomputed. Fine lines stay (waive on the bill) | after each |
| `check` | Builds the jobs and stops — run before a shoot. Writes nothing | before a shoot |
| `seed-history` | The lived-in hostel (below) | once, right after ch 05 |
| `unseed` | `restore`, then removes everything `seed-history` made (every row carries a demo-seed mark), seeded bookings included | after the shoot |

**Built 2026-11-23.** Run from PowerShell in `server/`: `go build -o bin\dev.exe ./cmd/dev` then `.\bin\dev.exe demo <scenario>`. The jobs run **inside the command** (the server's own code through `router.New`, the cron door with `?hostelId=`), so they touch the demo hostel alone and need no deploy; a scenario refuses (writing nothing) when its precondition is missing — e.g. rent scenarios need a resident with a login, trial ones need no plan, `plan-past-due` needs one.

**`seed-history` makes** (all romanized Nepali names, `@example.com` emails, `98000000xx` phones):
- ~15 residents in rooms 102–104 and 201–204, **with no logins**, so room 101 and the free beds
  stay for the live story. Nothing it writes may send an email, a push or an SMS.
- Three past BS months of rent bills, joining bills, khata lines and a few festival discounts.
- Payments in the real mix: mostly cash at the desk, then QR at the desk, receipt claims, a
  few online; two or three residents overdue with late-fine lines; one paid in advance.
- Expenses in every category (groceries, vegetables & meat, gas, electricity, water,
  internet, salary, repair, cleaning) with SAMPLE bill photos; staff cash given and spent.
- Inventory history, resolved complaints, old notices, food ratings, night-status and
  attendance history, two bookings (one confirmed, one waiting), three inquiries.

The statement file uses the same format as a real bank / eSewa export (take the format from a
real export the owner shares once, with the personal rows removed — invented formats broke
the parsers before), so the import in ch 50a matches payments for real.

## 7. Demo data card

- Hostel: **Himalaya Boys Hostel**, Baneshwor, Kathmandu. 2 floors; rooms 101–104, 201–204.
- Rate card: single Rs 14,000 · two-seater Rs 11,000 · three-seater Rs 9,000.
  Admission Rs 2,000, deposit Rs 5,000. Billing: calendar month.
- R joins a two-seater: joining bill Rs 18,000 (admission + deposit + first month).
- Ch 33: Rs 10,000 cash. Ch 35: the old receipt's amount. Ch 34: whatever is left, paid by
  QR at the desk → bill cleared. (Film 35 before 34 if the receipt has to fit inside what is owed.)
- Petty cash to warden: Rs 5,000. Warden expense: vegetables Rs 1,200 with bill photo.
- Notices: "Water tank cleaning on Saturday" (now) + Clothes Washing (weekly).
- Sample images in `marketing/video/demo-film/assets/samples/` stamped **SAMPLE**: ID card, citizenship front/back,
  hostel photos, food photo, bill photo. Pushed to `/sdcard/Pictures/HostelPalika-demo/`.
- Money check: R's balance must read the same for the warden, on R's Statement and on G's
  Fee summary. Note it at ch 36 and ch 46.

## 8. The chapters

Tags: ADM WAR RES COOK GUA. ★ = Duo (the other phone is the point); everything else is Solo.

### Act 1 · Get started  (A = O)
| ☐ | # | Chapter | What happens on screen | Proof moment | Videos |
|---|---|---|---|---|---|
| ☐ | 01 | What HostelPalika is | Motion intro: five roles, one app (made last, from other footage) | — | ALL |
| ☑ | 02 | Get the app | One phone with the app removed: Play Store → "HostelPalika" → Install → Open. iPhone line in voice only (web/PWA comes in the web video) | App opens | ALL |
| ☑ | 03 | Register your hostel | A: Register your hostel → hostel name, owner name, O's email (sign-in 1) + referral code `EDUC309CF` (owner's ask 2026-11-20; voice: "no code? no worries — later you refer others the same way and earn the reward") | Portal opens at once; Free trial banner | ADM |
| ☑ | 04 | Hostel KYC | A: the 8 steps, filled fast → draw signature → submit. **Voice (owner, 2026-11-20): explain KYC smartly — why (only real, checked hostels get the Verified badge, so residents and parents can trust the listing; it proves the owner runs the hostel; it unlocks every feature) and how (13 short steps grouped as Your hostel · Rooms & price · Daily life · Money, documents seen only by the owner and our team, a drawn signature, our team checks within 24 hours). Close on 100% · 13 of 13 · Verified.** | "Submitted" | ADM |
| ☑ | 05 | We check every hostel | Owner approves as superadmin (hand) → A: bell + email | Locked features open | ADM |
| ☑ | 06 | Lock the app | Settings → App lock → PIN + fingerprint (hand); reopen asks for it; then off | PIN screen | ALL |

### Act 2 · Set up your hostel  (A = O, B = signed out)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 07 | Your Home | Filmed after `seed-history`, so Home looks like a running hostel: tabs, bell, today's numbers, hostel switcher | — | ADM |
| ☑ | 08 | Rooms & beds | Floors, rooms 101–204, beds; deleting a room with people → refused | Vacancy count | ADM |
| ☑ | 09 | Room rates & how bills work | Rate card, admission + deposit, billing choice; bills make themselves each month | "HostelPalika does the maths" | ADM |
| ☑ | 10 | Payment setup | Hostel QR + bank details; Online checkout screen | QR saved | ADM |
| ☑ | 11 | Money rules | Late fine (free days), festival discount, notice days | — | ADM |
| ☑ | 12 | Your hostel page ★ | A edits photos and facilities → B (signed out) finds it in the listings | Live listing on B | ADM |

### Act 3 · Your staff  (A = O, B = W)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 13 | Add a warden ★ | A: Wardens → Add → W's email. B: W signs in (sign-in 2) | B opens warden screens | ADM WAR |
| ☑ | 14 | Warden permissions ★ | A: View payments off → on | Payments leaves / returns in B's menu | ADM WAR |
| ☑ | 15 | Petty cash ★ | A gives Rs 5,000 → B bell → Got it | B My cash Rs 5,000; A sees "Got it" | ADM WAR |
| ☑ | 16 | Warden expense | B: Add expense, vegetables Rs 1,200, bill photo, cash | B My cash Rs 3,800; A Expenses shows it with the photo | ADM WAR |
| ☑ | 17 | **Share a receipt** ★ | B: open an old receipt (gallery / eSewa history) → Share → HostelPalika → the sheet reads the amount → Save. Share the **same** receipt again | A Expenses shows it with the receipt; the second share says it is **already added** (no double count). "Don't ask next time" → saves in the background | ADM WAR |
| ☑ | 18 | Inventory | B records Bought + a stock Count → A approves the count | Count approved | ADM WAR |
| ☑ | 19 | Add a cook | A: Cooks → invite C's email; switches: cook enters stock used / cook adds expenses | Cook listed | ADM COOK |
| ☐ | 20 | Temporary login & audit log | A: one-day login; Audit log | Who changed what | ADM |

### Act 4 · Your residents join  (A = O, B = R)
B logs out W; R signs in (sign-in 3) — still a public account.
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 21 | Find a hostel | B: listings, map + directions, near a college, compare, save | — | RES |
| ☑ | 21a | Ask the hostel ★ | B: Inquiry on the hostel page (name, phone, question) → A: Inquiries → call / reply | Inquiry lands on A | ADM RES |
| ☑ | 21b | Book a bed online ★ | B: hostel page → Book → room type, move-in date → sees the advance and what happens next → **stops at the payment screen**. A: Bookings (seeded ones) → confirm. A short motion diagram shows the money path: visitor → HostelPalika → the hostel's payout | Booking waiting on A | ADM RES |
| ☑ | 22 | Join link ★ | A shares the join link/QR → B sends room + rent + ID card → A Join requests → Add | B's app turns into the resident Home | ADM RES |
| ☑ | 23 | Add a resident by form | A only, R2: Scan ID / Form QR / by hand (fast), room, special fee; which form fields the hostel asks for (Form details); the existing-residents list with "paid till" | Bill shown before saving | ADM WAR |
| ☑ | 24 | The resident's Home & first bill ★ | B: Home, digital ID card, joining bill Rs 18,000, month code | Same bill on A's resident detail | ADM RES |
| ☑ | 23a | Admission forms (Form QR) | A: Residents → "Filled your Form QR" → Admission forms → open one → pick a bed → register. Needs a filled form: a signed-out phone scans the Form QR (film when a phone is public, e.g. after ch 48) | Resident registered from the form | ADM WAR |
| ☑ | 24a | The resident's profile ★ | A: Residents → search everyone → a seeded resident → who they are, documents, tenancy, paid so far, payment history → Set status · Set this fee (why) · Room type · Issue an activation code · Move-in checklist · Add guardian / emergency contact (seeded resident, no real people) | Every fact about one resident on one screen | ADM WAR |
| ☑ | 25 | Khata | B asks to open a khata → A approves | Khata open on B | ADM RES |
| ☑ | 26 | Notices ★ | A: notice now + weekly Clothes Washing | B push arrives | ADM WAR RES |
| ☑ | 27 | Complaints & repairs ★ | B: complaint with photo → A updates → resolved; repairs with a voice note, send to a service provider | B told at each update | ADM WAR RES |
| ☑ | 27a | Community ★ | B posts in the hostel community; A: community settings, a reported post handled | Post on both; report cleared | ADM WAR RES |
| ☑ | 28 | Room change ★ | B asks for a free bed → A confirms | B's room changes only after confirm | ADM RES |
| ☑ | 28a | Move a resident & move history | A: resident profile → Floor & room → Move them (seeded resident to the free bed in 104) → Move in / out history | Bed counts change at once; the move is in the history | ADM WAR |
| ☑ | 29 | Night status & days away ★ | Night-status hour set just ahead → B answers In/Out from the Android shade; days away | A sees who answered and who didn't | ADM WAR RES |
| ◐ | 30 | Attendance & roll call | B location check-in; A: attendance settings, roll call | A sees it; no coordinates stored | ADM WAR RES |
| ☑ | 31 | Points, offers, referral, reviews | B only | — | RES |

### Act 5 · Collecting rent  (A = W, B = R) — the main money act
A logs out O; W signs in (sign-in 4). Desk collection gets most of the screen time; the
receipt lane is the alternative.
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 32 | The warden's Home | Leaving today, alerts, daily routines, My cash | — | WAR |
| ☑ | 33 | **Collect rent at the desk** ★ | A: resident → Take payment → Rs 10,000 cash | B receipt arrives at once (HP- code, QR); balance Rs 8,000 on both. Scanning the receipt's QR opens the "real receipt" check | ADM WAR RES |
| ☑ | 34 | **Paid by QR at the desk** ★ | R pays the hostel QR at the desk; A records it as eSewa / bank with the reference | Bill cleared on both phones | ADM WAR RES |
| ☑ | 35 | Or the resident sends a receipt ★ | B: old receipt → Share → HostelPalika → claim on the bill → A bell → Payments → check → Approve. Send the same receipt again. Then show Pay online (eSewa / Khalti) up to the wallet's own screen and back out — no money moves | B certified receipt + points; the repeat is refused | ADM WAR RES |
| ☑ | 36 | One statement, both sides ★ | A resident ledger beside B Statement | Same running balance (note: ____) | ADM WAR RES |
| ☑ | 36a | Void a wrong bill | Money → a seeded resident's bill → Void invoice → reason → gone from what they owe | Balance drops on the resident's record | ADM WAR |
| ☑ | 37 | The warden's daily checks ★ | B complaint + night status → A (warden) updates | B told | WAR RES |

### Act 6 · When rent is late  (A = W, B = R; scenario script)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 38 | A reminder before the due date | `rent-due-soon` | B push + email | ADM RES |
| ☑ | 39 | Overdue and the late fine ★ | `rent-overdue` | FINE lines on B's bill; A's overdue list | ADM WAR RES |
| ☑ | 40 | Collecting a late bill ★ | A takes the payment, fine included (or waives it) | Cleared on both | ADM WAR RES |
| ☑ | 41 | Next month's bill makes itself | `month-roll` | New BS-month bill on B | ADM RES |

### Act 7 · The kitchen  (A = W then R, B = C)
B logs out R; C signs in (sign-in 5).
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 42 | The menu reaches the cook ★ | A=W: changes the weekly menu + a meal time just ahead | B cook gets "menu changed"; meal-call reminder fires | ADM WAR COOK |
| ☑ | 43 | Food ready ★ | A logs out W; R signs in (sign-in 6). B=C: food photo → Food ready → A=R notified → rates it | B cook sees the rating | ADM COOK RES |
| ☑ | 44 | Khata give & kitchen spending ★ | A=R asks for eggs → B=C taps Give; cook records stock used + a market expense with photo | Eggs on R's next bill | ADM COOK RES |

### Act 8 · Families  (A = R, B = G)
B logs out C; G signs in (sign-in 7).
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 45 | Invite a guardian ★ | A=R: More → Guardians → G's email, choose what they see. B=G opens guardian screens | Guardian screens open | RES GUA |
| ☑ | 46 | What the guardian sees ★ | B: fee summary, receipts, food, notices, safety, emergency contact. A turns Payments off | It disappears on B. Balance = ch 36 (note: ____) | RES GUA |
| ☑ | 47 | SOS ★ | A=R taps SOS → B guardian alert. At the start of Act 9 (B = O) film SOS Alerts and join it here | Alert on guardian and owner; SOS active in the header | ADM WAR RES GUA |

### Act 9 · Moving out  (A = R, B = O)
B logs out G; O signs in (sign-in 8). Set the notice days so the last day can be today.
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 48 | Move out ★ | A=R picks the last day → B=O approves → Leaving today → checklist: leaving month, deposit, write-off | Bill stops that day; A's app returns to the public Home | ADM WAR RES |
| ☑ | 49 | Remove a resident | B: remove R2 (owner says yes first) | Bed free again | ADM |

### Act 10 · Your numbers  (B = O)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 50 | Hostel statement & expenses | Everything in and out this month, balance after each line; Transactions list | Matches the takes above | ADM |
| ☑ | 50a | Bank & wallet statements | A: import the `statement-file` → payments matched to residents on their own; the odd one left for a tap | Matched list | ADM |
| ☑ | 51 | Reports & PDF exports | Charts, date range, PDF download | PDF opens | ADM |
| ☑ | 52 | Branches & Overall | Add a branch (name + label), switcher, Overall view, stock Send → Got it | — | ADM |
| ☑ | 53 | Referrals & supply store | Referral code, invite other hostels, what it earns; browse the supply store catalogue (no order) | — | ADM |
| ☑ | 54 | Notifications, settings & your data | Bell, push, email opt-out per topic; switch to नेपाली; dark mode; Forgot password; the Guide inside the app; nightly backup and data export (your data stays yours) | — | ALL |

### Act 11 · Your plan  (B = O; scenario script; filmed last because a suspended hostel blocks other takes, then `restore`)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☑ | 55 | Your free trial | `trial-ending`: days left, what's included, the reminder | Banner + bell | ADM |
| ☑ | 56 | If the trial ends unpaid | `trial-ended`: Free plan, which screens lock | Locked tiles | ADM |
| ☐ | 57 | Buy a plan (**web video**: Play policy bars selling the plan in the Android app) | Plan billing → choose → pay by QR + proof image → owner approves as superadmin (hand) | Plan active, features open | ADM |
| ☐ | 58 | If a plan bill goes unpaid | `plan-past-due`: renewal bill, past due, back on the Free plan (locked tiles); pay the renewal to restore | Back to active | ADM |
| ☐ | 59 | Get started | Outro: install, register, WhatsApp | — | ALL |

## 8b. Feature modules — how the videos are organised (owner, 2026-11-20)

**Filmed in act order (§8, the sign-ins force it); cut and titled by feature module.** Each
module is one YouTube chapter group that covers *everything* under that subject, so a viewer
who wants "residents" or "money" finds all of it in one place. Each role video keeps the module
order, skipping clips that role never sees. Sub-features below come from a walk through the
app's own screens (`(admin)/residents`, `manage/resident/[id]`, `(admin)/money`,
`manage/finance/*`, `manage/statements`, `expenses/*`, `manage/reports`, resident `payments` /
`statement` / `my-room`). **New** = a gap the analysis found; it is added to §8 as a chapter.

| Module | Sub-features → clips |
|---|---|
| **M1 Get started** | install 02 · register 03 · KYC 04 · we check every hostel 05 · app lock 06 |
| **M2 Your hostel** | Home 07 · floors, rooms & beds 08 · hostel page + live listing 12 · branches & Overall 52 |
| **M3 Staff** | add a warden 13 · permissions 14 · add a cook 19 (temporary login / audit log: web only, 20) |
| **M4 Resident management** | *Getting residents:* listings 21 · inquiries / leads 21a · online bookings + booking payouts 21b · join link + join requests 22 · register by Scan ID / Form QR / by hand + form details 23 · existing residents (Excel or one by one) 23 · Form QR admission forms waiting for a bed **23a new**. *The record:* the resident's Home & first bill 24 · resident profile — who they are, documents, tenancy, paid so far, payment history; set status, set a fee, room type, login email, activation code, move-in checklist, guardians & emergency contacts **24a new** · search everyone 24a. *Moving rooms:* resident asks for a free bed → warden confirms 28 · owner moves a resident directly + move in/out history **28a new**. *Away and leaving:* days away (food-only rate) 29 · move out — notice, last day, checklist, deposit, write-off 48 · remove a resident 49 |
| **M5 Finance management** | *Money rules:* room rates + past rates + how bills work 09 · festival discounts, late fine, move-out & days away, opening balance 11 · payment setup — QR, bank, wallets, online gateways 10 · booking payouts 21b. *Bills:* first / joining bill 24 · special fee 23 · next month's bill makes itself 41 · void a wrong bill **36a new**. *Collecting:* cash at the desk 33 · QR at the desk 34 · resident sends a receipt → approve, money waiting on you, pay online 35 · certified receipt + QR check 33. *Late rent:* reminder 38 · overdue + late fine 39 · collecting a late bill / waiving the fine 40. *Khata:* opening one 25 · cook gives → next bill 44. *Spending:* staff cash 15 · expense with a bill photo 16 · share a receipt 17 · inventory 18 · kitchen spending 44. *Records:* resident ledger = resident statement 36 · hostel statement + download 50 · bank & wallet statements (reconcile) 50a · reports & PDF exports 51 |
| **M6 Daily life** | notices 26 · complaints & repairs 27 · community 27a · night status 29 · attendance & roll call 30 · the warden's Home & daily checks 32 37 · menu & food 42 43 |
| **M7 Families & safety** | invite a guardian 45 · what the guardian sees 46 · SOS 47 |
| **M8 Rewards & growth** | points, offers, referral, reviews 31 · hostel referrals & supply store 53 |
| **M9 Your plan** | trial 55 · trial ends 56 · buy a plan 57 · unpaid plan bill 58 |
| **M10 Settings & your data** | notifications, नेपाली, dark mode, password, Guide, backup & export 54 |

## 9. Role cuts, edit and open decisions

| Video | Chapters |
|---|---|
| ADM | all, in act order |
| WAR | 01 02 06 · 13–18 · 23 26 27 27a 29 30 · 32–37 · 39 40 · 42 · 47 48 · 54 59 |
| RES | 01 02 06 · 21 21a 21b 22 24–31 (27a) · 33–37 · 38–41 · 43 44 · 45–47 · 48 · 54 59 |
| COOK | 01 02 06 · 19 · 42–44 · 54 59 |
| GUA | 01 02 · 45–47 · 54 59 |

Edit: `marketing/video/demo-film/` on the promo `lib/` (Solo by default, Duo for ★, §1),
Sunita voiceover. Output in `marketing/video/demo-film/renders/`: one full video per role,
every chapter as its own clip, a `youtube/<video>.txt` with chapter timestamps (first at
00:00, each ≥ 10 s), `.srt` captions. Status bar redrawn clean; receipts blurred.

**Left out of this round:** the web portal (its own video later); completing an online
booking payment (ch 21b explains it and stops at the payment screen); placing a supply store
order; leaving the platform (named in ch 54's data
line only); the service-provider and field-team portals (separate audiences).

Open decisions:
1. ~~Demo hostel name.~~ **Himalaya Boys Hostel** (2026-11-20). Names **on screen** (the accounts' own; voiceover uses these): O Suresh Adhikari · W Ramesh Thapa · R Aarav Sherestha · C Hari Magar · G Krishna Sherestha · R2 Suman Rai.
2. After the shoot: keep the demo hostel public as a showcase, or hide it from listings.

## 10. Issues found while filming

(Log here: chapter, what broke, screenshot path. Fix after the shoot unless told otherwise.)

- **ch 03** — Open your hostel portal form: after "Turn on notifications" → Android Allow, the form re-renders and the pre-filled **Owner's name is wiped** (empty field, validation error on submit). Re-opening the form brings the prefill back.
- **ch 05** — after KYC approval the Home card still reads "KYC in review, 69% done" while the header says Live.
- **ch 06** — "App lock" row on More: when app lock is on, the same switch row shows no "On" state text in the lock settings card (fine), but turning it off needs the PIN in a sheet — expected.
- **ch 12** — after KYC approval the home read Live; later it reads "Not published yet": the hostel's status is APPROVED, and public search needs a separate superadmin Publish. Find out which action moved PUBLISHED → APPROVED (KYC approve sets PUBLISHED in `platform_review.go`).
- **ch 20 (parity)** — hostel admins have no temporary login or audit log in the app (only `manage/platform/audit-log` for superadmin); the web has both under Settings.
- **ch 23** — the hand-fill form's first "Upload" is the resident's photo, the second is the ID; easy to put an ID into the photo slot.
- **typing** — the Samsung keyboard drops letters when a whole string arrives in one `input text`; `typef` now sends one character per command in a single adb call.
- **ch 13** — the warden's first sign-in shows the owner's "Congratulations! 12-day free trial" sheet (plus Lock the app). A warden has no plan to celebrate.
- **ch 14** — Wardens → Ramesh → Permissions opens once; after Save, tapping the row → Permissions again closes the first sheet and never opens the permissions sheet. Leaving Wardens and coming back fixes it.
- **ch 23 data** — Bibek Shrestha (existing-residents list) has `depositAmount: 500020260515`: deposit and a date typed into one field and accepted. The form or server needs a bound on the deposit.
- **ch 17 (money)** — the same eSewa receipt shared twice saved **two** expenses. eSewa's Share builds a fresh PDF each time (new timestamp), so `receiptHash` differs, and the parser never filled `receiptTxnId` (null on every row) though the PDF prints `Reference Code : 1V57HHC`. Dedupe must key on the wallet's transaction code. Same rows: `what` is junk ("Code · Of Payment"), the expense sheet shows the PDF receipt as an empty grey box, and an eSewa-paid staff expense still lowers the warden's **cash** left.
- **ch 16** — Expenses header "Left Rs -1,640" is drawn in green; a negative balance should not use the success colour.
- **ch 21 (compare)** — Compare shows "Room types —" for Himalaya: it reads the old `roomTypes` array (empty), not `roomConfigurations`.
- **ch 21b (blocked)** — booking availability answers `NO_PAYOUT_ACCOUNT`: the KYC payout account exists but is not `VERIFIED`. Needs a superadmin to verify it before ch 21b. Seeded bookings for ch 21b not made yet.
- **ch 21a** — an inquiry sent while the phone field was empty still went through (3 leads from Aarav after my retries; 2 extra stay as New — "Close" on the lead sheet only closes the sheet, there's no way to mark a lead done/closed from it).
- **ch 22 (owner, 2026-11-20)** — the join link should open the join form directly, and filling that form should make the resident's ID card on its own; today it stops at "Make your ID card first" and a 9-step wizard.
- **ch 22** — after the owner adds a join request, the resident's app stays on the public Home (bell says "Welcome to Himalaya Boys Hostel", no tap target); it only becomes the resident Home after a restart.
- **ch 22 (tooling)** — the photo picker's **Albums** tab shows the phone's own albums: never open it. A freshly pushed sample needs repeated `MEDIA_SCANNER_SCAN_FILE` until `content query` finds it, before it shows in Recent.
- **ch 22 (data)** — a join-link resident with "1 month due (Mangsir)" is stored as moved in **Kartik 1** ("Since Kartik 1, 2083 BS" on both phones). The join link is an existing-resident flow: no admission fee or deposit bill, just Mangsir rent Rs 11,000. The money story changes from the Rs 18,000 joining bill to Rs 11,000.
- **ch 25 (tooling, solved 2026-11-20)** — not a crash: phone A uses 3-button nav and a tap at y≈2260 hits Samsung's **Home** button. On A, never tap below y≈2200; scroll the target up first.
- **ch 27** — the resident's complaint photo is live-camera only (no gallery), so the take has no photo. The repair request's **Accept and raise** goes to every real plumbing provider on the platform, so a demo hostel can't film the dispatch without reaching real people. Needs a demo/test provider, or a flag that keeps demo-hostel jobs off the live provider pool.
- **dev demo** — money in the ledger is whole rupees (`positiveWholeRupees`, `monthlyRent: 14000`), not paisa as the brief said.
- **ch 28a** — Floor & room on the resident profile moves the resident **on the first tap**, no confirm, and the fee follows the new room type at once. A mis-tap moves someone and changes their rent. The room list in that sheet is also stale after a move (showed the old free beds until the profile was reopened).
- **ch 28a** — after closing the Residents search keyboard with Back, the **tab bar vanished app-wide** (Residents and Home); only an app restart brought it back.
- **ch 24a** — Issue an activation code for a resident with no email shows the raw code `Not emailed (email_suppressed)`.
- **ch 36a** — after Void, the resident's row says "Not billed yet — the month's billing run has not happened", which is untrue (it was billed, then voided). The "8 people still owe" count did not move after the void (check whether it counts Kartik-only debtors).
- **ch 21b** — R is a resident now, so booking as R is refused (`ALREADY_RESIDENT`); the visitor half needs a public account (R after ch 48, or G before ch 45). Payout account still `PENDING_REVIEW` at 19:10 (the owner's approval didn't reach it): superadmin → Bookings → Payout accounts → Verify.
- **ch 52** — a new branch is missing from the header switcher until the session token refreshes: `/hostel-admin/branches/summary` reads `p.AllHostelIDs` from the access token, and adding a branch doesn't refresh it (Branches screen lists it at once). Fix: refresh the token (or read ids from the DB) right after the branch is created.
- **ch 35 (day 7, not fixed)** — Aarav's Payments: "Pay this next · Monthly rent — Mangsir · **Rs 0**" with a **Pay Rs 0** button while Total outstanding is Rs 6,000 and "0 of 2 settled"; the proof form then says "Rs 0 due". Likely left by `month-roll` → `restore` (the day-6 claim still says "for Poush 2083 BS" though the month is back to Mangsir): check what restore leaves on bills/claims made during a scenario, and that "Pay this next" skips a bill with nothing left to pay.
- **ch 54** — FIXED day 7: नेपाली was always there (EN/नेपाली switch at the top of More → Guide, since c6db0651), the take never tapped it. Email opt-out per topic lived in Settings but the owner's More had no "Notification settings" row (now added, needs OTA). **Backup** trial gate: a running trial now passes (Go + TS, trial = everything in Max).
- **ch 40 (money)** — after **Waive fine**, the collect sheet drops the fine line but still offers **Collect Rs 12,350** (the old total) until it is closed and reopened — collecting then would take Rs 1,350 too much. The payment success screen prints **Rs 23.350** (dot as the thousands separator, Infinix locale) and says **"Cash collected" for an eSewa payment**. Part payment's amount box is prefilled with the full due, so typed digits append (5850 → 58503000 → "Collect Rs 58,503,000"); check the server caps a part payment at what is owed.
- **ch 52 (owner can't get back)** — picking the new branch (KYC draft) in the switcher drops the owner into the **public** Home (Register hostel, My bookings, Profile tab "Hostel admin account"), with no branch chip and no way back to the portal until the app is restarted. Evidence: `52-bug-public-home-B` (29 s).
- **ch 50 (money, statement)** — a second part payment on one bill does not add a statement line: the bill's single credit row is re-dated to the newest payment and shows the running total. Dipesh's Kartik bill: Rs 4,500 seeded earlier + Rs 3,000 at 19:37 → one row "received **Rs 7,500** · Part payment · 7:37 pm" (the receipt RCP-HIM-2083-08-00010 correctly says Rs 3,000). Closing balance stays right (Rs 3,14,706), but Kartik's money-in drops Rs 4,500 after the fact and Mangsir gains it. A statement line must be one payment, dated when it was paid. Same gap on Expenses: Mangsir "Money In Rs 109,350" there vs "Rs 113,850 in" on the Statement.
- **ch 51** — the "Downloaded · Tap to open" toast did not open the PDF on B (file is fine: `Download/HostelPalika/statement-2083-05-to-2083-07.pdf`, 3 pages, Rs 1,85,000 grouping). The app screens use Western grouping (Rs 314,706, Rs 396,376) while the PDF uses Nepali (Rs 1,85,000).
- **ch 29 (parity)** — a resident can't file days away in the app (only staff, from the resident's profile → Days away).
- **ch 09a** — Finance settings shows the opening balance as "Rs 185,000 on 2026-08-17": AD date and Western grouping, everywhere else is BS and Rs 1,85,000.
- **shoot tooling (phone B)** — `input keycombination` doesn't exist on the Infinix's Android; clear a field with `keyevent 123` (end) + `keyevent 67` × n.
- **shoot tooling** — uiautomator cannot dump a screen with a running animation (the orbit on "Open your hostel portal"): tap those by screenshot coordinates.
- **ch 30 (gap, blocks the proof)** — the app never sends a check-in. "Record my location" only saves consent (`app/attendance.tsx`: "this screen ships before any pinging does"); there is no background geofence task, so A's Attendance stays "Unknown" for everyone and no Android location prompt appears. To build: a background location task (expo-location + TaskManager) that, at the hostel's check-in times, measures distance to the pin on the phone and POSTs only the zone (inside / nearby / away), the same privacy line the server already holds.
- **ch 36 (money, blocks the take)** — the resident's own Statement also merges payments: Aarav's Rs 6,000 cash (8:35) + Rs 5,000 QR (8:41) show as **one** row "Mangsir rent · Rs 11,000 paid · 8:41 am". Root cause: `finance.ListLedger` (`server/internal/modules/finance/ledger.go`) returns one row per invoice, so every statement (owner, warden, resident) shows a bill's paid total re-dated to the last payment. `paymentevents` keeps each payment, so a per-payment statement fixes the old rows too. Film ch 36 after the fix ships.
- **ch 33/34 (money)** — the collect success screen prints **Rs 6.000 / Rs 5.000** on the Samsung too (dot grouping is not an Infinix locale thing), and says **"Cash collected" for a QR payment**. The resident's push says "NPR 6,000 received for **2083-08**" (raw month code, should be Mangsir 2083).
- **ch 33** — Payments opened from the Collect tile focuses the search box, so the keyboard comes up at once; on the Samsung a tap there opened the keyboard's **clipboard panel** (shows clipboard history: blur/cut).
- **ch 37** — a resident's Room complaint did not show in the **warden's** bell (it is in the warden's Complaints list as Pending). Check who the Room category notifies.
- **ch 43** — the cook never sees meal ratings (`app/(cook)/menu.tsx` leaves the rating slot out), so "B cook sees the rating" can't be filmed; the owner/warden average is the proof. The resident's lunch card keeps saying "Rate this meal" after Send (no rated state), and the server stored **two** ratings for one resident/meal/day when sent twice — rating should upsert.
- **tab bar / back stack** — Back from the warden's Home went to the **public Home** left in history from before sign-in (Profile still "Warden account"); a restart fixed it. The resident's tab bar vanished again on day 5 (scrolling Community); the guardian's hides while scrolled.
- **ch 46** — guardian Safety "Last update **2026-11-20**" and receipts "— · 2026-11-21": AD dates and a dash placeholder where the app uses BS.
- **ch 47** — status chip reads "**Sos triggered**" (should be "SOS active"); the SOS screen says "No contacts on file" though the resident's ID card has guardian Krishna Sherestha 9800000107. After the owner's Acknowledge the resident still shows "SOS active".
- **ch 48** — after the owner moves a resident out, the resident's app stays in the resident shell ("This role is not allowed to perform this action" on Payments) until restarted; the leaving-day field shows an AD date (2026-11-22) over the BS line.
- **ch 49** — after removing R2, Residents says 12 living but Home says "13 residents · 4 beds free" (16 beds: 4 free = 12).
- **cook/guardian invites** — both only work through the emailed link; there's no in-app code. The kitchen-login path (password shown on screen) was the way round for the cook.
- **ch 23a** — the registration screen shows "Due at move-in Rs 7,000" (deposit + admission) but the Payments sheet right after shows only the Rs 9,103 rent bill; check the joining invoice (admission + deposit should be one invoice, see memory note "joining is one payment"). The room tiles sit under the header after scrolling, so the first tap misses.
- **phone B font** — B's system font is the Infinix theme's handwriting-style face (all B clips since day 3 have it; the app uses the system font). For a clean B look, set B → Settings → Display → Font to the plain system font before the remaining B takes.

- **Fixed 2026-11-23 (uncommitted, needs deploy + OTA):** ch 36/50 statement rows merged per bill → one row per payment, dated when paid (Go + TS + app); ch 33/34 "Rs 6.000" (clipped comma) and "Cash collected" for QR/eSewa; ch 40 Waive fine leaving the old total on Collect, and Part payment digits appending to a prefilled due; "received for 2083-08" in the payment push. The server still lets a desk payment exceed what is owed: the extra becomes the resident's credit, and the app caps it at the balance.

- **Go deploy was failing since 6334ce3e** (gofmt gate on `finance/ledger.go` + `hostelrooms/rooms.go`), so step 1's server half (per-payment statements, scenarios on the cron door) was never live. Fixed b09b6882.
- **ch 50a (bug)** — statement CSV import refused on Android: picker hands `text/comma-separated-values`, not in the allowlist. Fixed e164853f (Go + TS allowlist; app maps .csv/.xls/.xlsx itself — OTA).
- **app lock** — returning from the system file picker asks for the PIN again (the picker counts as leaving the app).
- **ch 52/56 (counts)** — Overall says 12 residents, Main alone 13; the Free banner also says 12 while the card says 13.
- **ch 55 (copy)** — bell "ends in 2 days" vs Billing "3 days left" for the same end (Mangsir 9; one counts today).
- **ch 56 / 21b (dates)** — "Read-only from 30 Nov" and booking "Plans to arrive 2026-12-01" are AD; the app's one date format is BS.
- **data** — Bibek Shrestha's deposit is stored as **Rs 500,020,260,515** (a date typed into the deposit box on the existing-residents form); needs a cap/validation and a data fix.
- **ch 33/34/40 (app)** — in the payment sheet the first tap on Collect/Save after typing only blurred the amount box (Sheet's scroll view used the default `keyboardShouldPersistTaps`). Fixed in `ui/sheet.tsx` (`"handled"`) → OTA.
- **ch 38 (copy)** — the due-soon bell printed "Your 2083-08 fee is due on Wed Nov 25 2026". Fixed Go + TS (`bs.FormatPeriod` + `bs.FormatDate`).
- **ch 33–41 (A)** — A's Home and bell badge don't update live after a payment (needs a pull; badge said 7 while 11 unread), and no push reaches A's shade. The amounts eye turns itself off each time A comes back to Home.
- **ch 34 (data)** — a payment taken with **QR** is listed as **Bank** in the profile's payment history.
- **ch 41 (copy)** — bills say "NPR 11,000" in bell text, "Rs 11,000" everywhere else.
- **owner chip** — after `trial-ended` → `restore`, the owner's branch chip stays hidden (even after a cold start) though the subscription is back on trial (trialEndsAt Dec 2). `useBranchesLock` reads `/hostel-admin/subscription` with `.catch(() => null)`: check whether that GET fails or serves a cached copy.
- **ch 50a (money text)** — the "Who sent this?" sheet still prints **Rs 14.000**: `Money size="display"` clips the comma's tail there even with the 1.4× line box (Home is fine).
- **ch 50a (copy)** — a stranger's row "Ramila Basnet" is labelled "No name on it"; and the header stays "0 of 8 payments matched" after a suggestion is assigned.
- **ch 50 (data)** — an expense row reads "Code · Of Payment · Ramesh Thapa, Rs 220": the ch 17 eSewa receipt parse took label words as the item.
- **ch 35 (raw error)** — the uploader's notification printed "Call to function 'FileSystemUploadTask.start' has been rejected → Caused by: Unable to upload a file: timeout" (2nd send of the same receipt). Raw native text must never reach the user; sent to the fix session.
- **More search** — "plan" finds nothing; only "billing" finds Billing.
- **Fixed 2026-11-23, day-6 money/bell batch (committed locally, not pushed; needs the Go deploy, then the OTA):**
  - **ch 50a Rs 14.000** — `Money`'s small `Rs` was our `<Text>` with the default `body` variant, so it carried `text-base`'s 24pt line height into the 42pt display line and Android let the shorter box win. The prefix now inherits (`variant={null}`) and gets the same line box, as `PaintedAmount` (Home) always did. Its colour also follows the digits now (owed/credit amounts).
  - **owner chip** — the server answer was right after `restore` (checked: trial still running, no plan bought). `restore` writes Mongo directly and cannot reach the API's Redis, so the API served the cached trial-ended plan for up to 60 s and nothing told the open app to ask again; the app also filed any failed plan read as "no plan". `restore` now waits out the cache and publishes the plan/money topics; the app no longer caches a failed read as "no plan".
  - **ch 34 QR as Bank** — the app sent a desk QR as `BANK`. It now sends `QR`; the server files it as a BANK event (it reconciles against the bank statement) with `via: QR`, and the profile history and statements say QR (Go + TS). Aarav's two ch 34 QR payments marked by `dev demo fix-data`.
  - **ch 41 / ch 35 NPR in bells** — every bell/push body says Rs (Go + TS); the proof bells name the month ("for Poush 2083 BS").
  - **ch 50a stranger / 0 of 8** — a named stranger reads "No resident by that name"; a row assigned from "Who sent this?" now counts as tied (it fell out of both lists) (Go + TS).
  - **ch 33–41 live Home / bell** — Go never published a staff write's realtime topics (TS did, in `announceWrite`), so a desk payment moved no open Home. Wired into Go's `announceWrite`. The app's socket also kept the channels it had at sign-in (a resident added to a hostel never joined its channel) and gave up for the session after one failed config read; it now follows role/hostels and retries on foreground. Push to A's shade not checked here.
  - **ch 23 deposit** — existing-resident rows (form and file) and the resident edit refuse amounts over Rs 1 crore (Go + TS). Bibek's deposit set to Rs 5,000 (`500020260515` read as 5000 + 2026-05-15) by `dev demo fix-data`.
  - **ch 35 same receipt again** — the PUT goes straight to R2 and Android counts bytes written to the socket as sent, so "100%" then a 60 s timeout was a stalled phone→R2 transfer, not a refusal. The app now sends the receipt's sha256 with presign and the server refuses a used receipt before a byte moves: "You already sent this receipt for Rs 5,000 for Poush 2083 BS." (Go + TS).
  - **ch 35 reference** — the claim card ignored the receipt read's "reference on image" flag; it now says "Receipt shows HIM-…" (Go + TS).
  - **ch 35 raw error** — `readApiError` no longer passes a native or engine error's text to any screen, toast or notification; it maps to plain words and logs the raw text.
### Takes log
- ch 02 → `02-get-the-app-A` (57 s): Play search → page → Install → Open → splash. Blur: Play account avatar, recent-search suggestions. B idle.
- ch 03 → `03-register-A1` (21 s: Home → Register hostel → Sign in, email typed; password by owner off-camera) + `03-register-A2` (68 s: notifications already granted; form: owner Suresh Adhikari (account's own name), phone 9800000101, Himalaya Boys Hostel, referral EDUC309CF → "Referred by Education Light Hostel · 1 month extra" → portal: Awaiting verification, KYC 8%). Idle 34–41 s to trim. Accounts already existed, so no Create account.
- ch 04 → `04-kyc-01-hub` (16 s) · `-02-pin` (44 s, **Use my location** — owner's choice, so the public pin is the owner's real spot; area filled "Sirsiya") · `-03-details` (Boys only, address) · `-04-facilities` (8 picked) · `-05-photos` (outside + 2 inside via the Android photo picker) · `-06-rates` (140 s: single 14,000 / two-seater 11,000 / three-seater 9,000, admission 2,000, deposit 5,000, two-seater photo) · `-07-rules` (4 rules) · `-08-documents` (112 s: owner ID + PAN, in review; **cut** the accidental "Open with" chooser in the middle; picker shows Drive account emails → blur) · `-09-agreement` (scroll, name, drawn signature, agree) · `-10-submit` (review → Send → confirm → "Sent · In review", 69%). Food menu, rent payments, booking money, opening balance skipped (chapters 08/10/42).
- ch 05 → `05-approved` (98 s): owner approved on superadmin → A: shade push "Your KYC is verified" → tap → Home **Live**, tiles unlocked → bell (3 unread). Shade shows DND line; blur nothing else.
- ch 06 → `06-app-lock-1` (171 s: More → App lock → "Choose a PIN" pad; pad sits idle, use its first seconds only) + `06-app-lock-2` (154 s: cold start → "Enter your PIN" lock screen → owner unlocks → More → App lock settings (App lock on, Biometric, Change PIN)). App lock switched off after. No fingerprint enrolled on A, so PIN only. **Blur the keypad.** The first retake (`06-app-lock-1` overwritten) also toggled Dark mode by mistake; not in the kept clips.
- ch 08 → `08-rooms-1` (178 s: Home → Rooms → Not floor-wise (hold) → **Floor-wise** (owner favours it) → Ground 001 single, 002–003 two-seater, 004 three-seater; 1st 101 single, 102–103 two-seater, 104 three-seater (16 beds); **cut** the 105–107 add/remove slip; room 102 sheet) + `08-rooms-2` (room 101 with Suman Rai → Delete room greyed out).
- ch 09 → `09-rates` (39 s): Finance → Room rates → New rates (starts next BS month, joining fees) → back, nothing saved.
- ch 10 → `10-payment-1` (SAMPLE QR upload → "Residents can pay") · `10-payment-2` (Name residents see; Bank → Nabil, account name; **number left for the owner**, sheet closed) · `10-payment-3` (Online payment options eSewa/Fonepay/Khalti, view only). Note for residents set off-camera.
- ch 11 → `11-money-rules-1` (late fine Rs 50/day after 5 free days; Holi 25% off Falgun; move-out notice 0 days kept for Act 9; days away food-only Rs 150/day, ≥5 days) + `11-money-rules-2` (opening balance Rs 1,85,000 as of Bhadra 1 2083; khata items Egg 20 / Extra meal 150 / Laundry 100; note for residents).
- ch 12 → A half only: `12-hostel-page-A`/`-B` (About description + 2 floors, gate note, triple-room + food photos). **B half blocked:** the hostel is APPROVED, not PUBLISHED → not in public search until superadmin **Publish**.
- ch 13 → A half: `13-add-warden-A` (Wardens → Invite → name, W's email, phone, default 13/19 permissions → "Warden invited"; account shows as **Ramesh Thapa**). B half needs sign-in 2.
- ch 19 → `19-add-cook` (Cooks → both switches on (stock used set on after the clip) → Add a cook → Invite by email: Hari Magar, C's email → Invite pending). A default "Himalaya Boys Hostel Cook" sign-in exists too.
- ch 23 → `23-form-1` (Admission form: guardian ID switch on → off again) · `23-form-2` (Register a resident: Scan ID / Form QR tabs → Fill by hand… **recording hit the 180 s cap at the email field**; R2 = Suman Rai registered after it, room 101, special rent Rs 13,000 "Relative") · `23-form-3` (Existing residents → Add one: Bibek Shrestha, room 002, paid this month, deposit 5,000 → added) · `23-form-4` (re-film of step 3: two-seater room 003, Edit → short stay Rs 10,000 → bill shown before saving → backed out, nothing saved). R2's profile photo is the SAMPLE citizenship (picked into the wrong slot). The photo picker showed the owner's own photos below ours → **blur** in `23-form-2`.
- ch 20 → **not filmable in the app**: temporary login and audit log are web-only for hostel admins (§10).
- ch 53 → `53-referrals-store` (95 s): Home → Referrals (code HIMAF794D, QR, share, "They get 1 month", resident referrals) → Store tile → **"Store coming soon"** dialog (the store isn't open, so no catalogue to film).
- ch 04 extra → `04-kyc-11-food`: meal times set (breakfast 7:30–9:00, lunch 9–10, snacks 4–5 PM, dinner 7–8 PM). Dishes not added yet: a **Samsung Account "policies updated — agree" screen** kept popping over the app on phone A and catching taps. Trim it from the clip.

- Day 1, later: owner typed the account numbers on camera → `10-payment-4` (bank Nabil, eSewa, Khalti → 4 of 4 ways to pay); `04-kyc-12-payout` (Booking money: name, Nabil, branch Baneshwor, owner's number); `04-kyc-13-food` (Sunday menu typed, Copy day → all 7 days 4 of 4 → **KYC 100% · 13 of 13 · Verified**, held). PAN/VAT set by the owner off-camera. Superadmin published the hostel → `12-hostel-page-B2` (B: search "Himalaya" → 1 hostel, Verified → listing: menu, About, rules, location, Call / Send inquiry). A first try of that clip caught the owner's Instagram after a Back left the app; **deleted**.
- **Branch switcher bug (fixed 2026-11-20):** the owner's header chip only showed on a paid Max plan, not on the trial (which is everything in Max). `hostel-switcher.tsx` now follows `useBranchesLock`. OTA published to production (Android runtime `07f747e7…`, matching the v35 Play build; the uncommitted `withOptionalPortrait` plugin was set aside for the publish because v35 was built without it, then restored). Reopen the app twice to load it. Ch 52 can be filmed after that.

- Day 2: sign-in 2 done (B = warden Ramesh Thapa; email typed by the session, password by the owner).
- ch 13 → `13-add-warden-B1` (B: Sign in → email typed; cut before the password) · `13-add-warden-B2` (A: Wardens → Ramesh Thapa · 13 of 19 · Active; B: warden Home, scroll). The trial + lock sheets were closed off-camera.
- ch 14 → `14-permissions-A/B` (82 s, clean take: A turns See payments off → Save → B pull-to-refresh shows "Some of this is not yours to see"; A Back → Wardens → Permissions → on → Save → B notice gone, 13 of 19). Earlier tries deleted: one caught a personal phone call on A, one ended on A's notification shade.
- ch 15 → `15-petty-cash-A/B` (188 s): A Expenses → Staff cash → Give cash → Rs 5,000 → (Save needed the warden chip tapped first; trim the fumbling) → "Cash to Ramesh Thapa · Waiting" → B bell "Cash for the hostel" → Got it → B Cash left Rs 5,000, A "Got it · Cash".
- ch 16 → `16-warden-expense-A/B` (B Home → Add expense → Rs 1,200 → Vegetables & meat → From gallery → SAMPLE bill → Save; **B went offline for a moment**, so the app showed "Saved on this phone — sends by itself when you're back online" — usable as a beat) + `16-warden-expense-2-A/B` (B Cash left Rs 3,800 · You spent Rs 1,200; A opens the expense: bill photo, Added by Ramesh Thapa). The phone-number autofill bubble shows over the amount for a second → blur.
- ch 17 → `17-share-receipt-4-A/B` (eSewa receipt → ⋮ Share → OK → HostelPalika → sheet reads Rs 220, eSewa (auto) → ticks "Save shared receipts automatically next time" → Save → Saved; A lists it) + `17-share-receipt-3-B` (the same PDF sent again from the PDF viewer → **"Already added · Rs. 220 · added by Ramesh Thapa"**). Blur: the share sheet's WhatsApp contacts row, the eSewa phone number / merchant / request ids. The refusal only works for the same file bytes (see §10), so the take shares a downloaded PDF twice. Lost: `17-share-receipt` B and the end of `17-share-receipt-2-B` (the last part was pulled before it was finalised; rec.sh fixed). Off-camera: 3 extra Rs 220 rows cancelled ("Same receipt shared again"); one stays.
- ch 07 → `07-home-A` (189 s, after the seed + OTA): hero masked → eye → Rs 2,77,356 / Rs 72,000 / Rs 53,655 → scroll tiles → **Main** branch chip → Switch hostel sheet (Show label) → bell (13 unread) → Residents (13) → **cut** the accidental Register-a-resident scanner (black camera) → Payments: Mangsir owing 7 / paid 6, Kartik owing 3 with fines → Home, masked again.
- Sign-in 3 → `21-resident-signin-B` (email typed; password by owner). R's account is named **Aarav Sherestha** (use this, not "Aayush Karki"); sample ID card regenerated with that name.
- ch 21 → `21-find-hostel-B` (77 s: Home scroll → Filters → Boys (10 hostels) → Add to compare ×2 → save Himalaya → Compare tab; phone dropped off USB at the end) + `21-find-hostel-2-B` (Search → Map (Kathmandu cluster + Himalaya by the phone's own dot) → pin → hostel page scroll: "3 beds vacant", "Not taking bookings", Call / Send inquiry). Directions left out (would map the route to the owner's real spot).
- ch 21a → `21a-inquiry-A/B` (two parts each): B Send inquiry (name Aarav Sherestha prefilled, phone 9800000105, "two-seater bed… Shanker Dev Campus") → A bell "New inquiry" → Leads (6, incl. seeded) → open → message, Call / Email → Mark read → "2 of 6 leads picked up". Trim the field-typing retries.
- ch 22 → `22-join-link-A/B` (long): A Residents → Join link (QR + link) → owner scans with B's camera → B "Make your ID card first" → 9-step ID card (Male, DOB 12 Aswin 2062, B+, phone, Koshi/Ilam address, Shanker Dev Campus BBA, guardian Krishna Sherestha father 9800000107, non-veg, 8–12k, SAMPLE silhouette photo, drawn signature, terms ticked by the owner) → "Your ID is ready!" → Digital ID card (HH-2TDP-C2YJ) → join form: Double Sharing Rs 11,000, Mangsir 1 month due → Send → A Join requests "1 waiting" → Add → room 102 → "Bills of Rs 11,000 are made now" → Yes, add → "Aarav Sherestha added". **CUT** the picker's Albums tab on B (~14:17, the owner's personal albums). B stayed on the public Home (see §10) — the resident Home is filmed in ch 24 after a restart.
- ch 24 → `24-resident-home-B` (after a restart, B is Aarav's resident Home: Double Sharing · Since Kartik 1 · eye → **Rs 11,000** remaining, due in 25 days → Digital ID HH-2TDP-C2YJ → Payments: total outstanding Rs 11,000, Monthly rent — Mangsir → Invoice detail, reference **HIM-00DD-MAN83**). **Cut** the end of `24-resident-home-A` (Recents screen with the owner's home apps). + `24-resident-home-2-A` (Residents → Aarav, Room 102 · 1st floor · Rs 11,000 rate card · "Month still open: Mangsir 2083" → Payments tab: Aarav Rs 11,000 Unpaid).
- ch 25 → `25-khata-B` (32 s, Khata screen before the request; B dropped off USB) + `25-khata-2-B` (Open my khata → "Waiting for the warden") + `25-khata-3-A/B` (A bell "Khata request" → Khata: Want a khata · 1 → Open khata → Open khatas · 1; B refresh → khata open, "Ask for" Egg / Extra meal / Laundry). A clips showing the launcher deleted.
- ch 26 → `26-notices-A/B` (A Notices → Write a notice "Water tank cleaning on Saturday" / "No water 10 AM–2 PM… fill your buckets on Friday night" → Publish → Live 1; B bell 2 unread, Notices "1 waiting" → opens it; A Push notices → **Clothes Washing Notice**, Sun & Wed 6 PM, running). The push did reach B (shade not shown: personal notifications).
- ch 27 → `27-complaint-A/B` (~400 s): B More → Complaints → Raise → Maintenance → Type instead "The bathroom tap in room 102 is leaking all night." → Send → Pending; A bell "New complaint" → Complaints → reply "Plumber is coming tomorrow at 10 AM." + Mark in progress → B In progress; A reply "Fixed. The plumber changed the tap washer." → Resolve → B "Confirm fix" → **Confirm it is fixed** → Resolved. + `27b-repair-A` (A Repairs → Raise a request → Plumbing → typed problem (owner chose no voice note) → Medium → "Sounds like a job for: Plumber" → Raise it → **What this will cost: Plumbing Rs 200 minimum, sent to every plumbing provider** → Decline, nothing sent).
- ch 18 → `18-inventory-A/B` (~390 s, 3 parts): B Inventory (empty) → Buy → Rice 25 kg + Dal 5 kg, bill total Rs 3,500 ("shared equally"), Paid all, bill photo required → SAMPLE `bill-groceries.jpg` (made by `make-samples.py`, pushed to B) → Save → Stock check: Dal 4, Rice 22, "Used, not entered" → "goes to the owner to approve" → A Inventory "Stock check, 1 waiting" → Check → Book vs Found → **Approve count** → "Counted"; B stock Dal 4 kg / Rice 22 kg. Trim the save-button retries.

- Day 3 (2026-11-20 evening): B's system font had changed to a handwriting style; owner set it back to Default before any B take.
- ch 24a → `24a-profile-A` (387 s): Residents → search "Manish" → Manish Poudel (104, triple): who they are, tenancy, paid so far Rs 6,300 / still owed Rs 9,000, payment history (Kartik, eSewa, RCP-HIM-2083-07-00010) → Status sheet (Pending / Active / Suspended, shown, not changed) → Monthly fee sheet (shown) → Days away sheet (Rs 150 off a day from 5 days, shown) → **Issue a code** (LKWZXQDW, valid till Mangsir 11) → Move-in checklist (deposit 5000, citizenship copy + college ID, mattress/pillow/room key, room + bed condition, rules accepted) → saved → guardian Ram Poudel (Father, primary) → emergency contact Sita Poudel (Mother, call first). **Trim** the emergency-contact phone mistype (~300–340 s). A first try ended on the launcher (Home button) and was overwritten.
- ch 28a → `28a-move-A` (156 s): search "Roshan" → Roshan KC (103, double) → Floor & room → Ground / 1st tabs → Room 104 → "Moved to Room 104", room type Triple, fee Rs 9,000. (A dry run had already moved him; moved back to 103 off-camera first — room moves don't show in the move history.) Tab bar then vanished (§10), so + `28a-move-2-A` (73 s, after a restart): More → Move in / out → list by month, Moved out / All filters.
- ch 36a → `36a-void-A` (104 s): Payments → Mangsir → **Suman Rai (R2)** Rs 11,655 → Void this invoice → reason "Wrong fee on this bill." → Mangsir 7 waiting → 6 → search Suman → "Not billed · Would be Rs 11,655" → Nothing unpaid. Trim the reason retype.
- ch 27a → `27a-community-A/B` (~215 s): B Community → **Himalaya Boys Hostel** tab → "Football at Tundikhel this Saturday, 7 AM. Who is in?" → audience **Himalaya Boys Hostel only** → Post ("members only"); A Himalaya tab → Like → comment "Good plan. Be back by 9 for breakfast."; B refresh → 1 comment; A Reported posts (0 waiting) → More → Settings → Community (enabled, profanity filter). No reported post to handle (none exist); trim the first audience-chip miss on B.
- ch 28 → `28-room-change-A/B` (~107 s): B More → My room (102) → Ask for another room → Room 103 (1 of 2 free, same type, so rent stays Rs 11,000) → "Closer to my classmate Sujan." → Send to warden → "Waiting for the warden"; A bell → Room change request → Rooms & Floors → Room change requests → **Confirm** → "Moved"; B refresh → **Room 103**.
- Ch 29 started off-camera: A Night status → Edit time picker opened, closed unchanged (still 20:00) when the owner took phone A away. Phone B signed out of Aarav → owner sign-in (email typed, password by the owner).

- **Phone A taken away by the owner (~19:20). Phone B = owner (sign-in done by the owner).** App lock reads "On" for the owner on B.
- ch 54 → `54-settings-B` (177 s): More → bell → Show only one kind (Resident) → Needs you → All → Dark mode on → (an accidental tap opened a Guide article in dark mode: "Choose the bed and see the bill") → Guide list scroll → Dark mode off → Privacy & your data. ◐: no नेपाली / email opt-out / backup in the app (§10).
- ch 54 → `54-settings-2-B` (119 s, day 7, after OTA 38357c8a): More → Guide (English) → नेपाली → list scroll → chapter "कोठा र बेड" in Nepali → back → Notification settings → Emails → Attendance alerts OFF (hold) → ON again → More → Backup ("Set up recovery key", "Connect Google Drive"; no longer "Does not include it"). Cut from 54-settings-B: bell filter, dark mode, Privacy. Guide put back to English off camera.
- ch 09a (new, M5 opener) → `09a-finance-hub-B` (43 s): Home → Finance → Finance settings hub: room rates, festival discounts, late fine, move-out & days away, opening balance, khata, payment setup, bank & wallet statements, booking payouts (in review), online payment (not set up) → Room rates → back.
- ch 52 part 1 → `52-branches-B` (125 s): Main chip → Switch hostel → Manage branches (0 of 20 on Max trial · no extra cost) → Add a branch: "Himalaya Boys Hostel Koteshwor", label Koteshwor → "Koteshwor added · complete its KYC" → Later → Branches lists it ("KYC to finish") → switcher still shows only Main (§10). Part 2 (switcher + Overall) after the token refresh: by 19:39 the switcher listed Koteshwor and "Overall · All 2 branches together"; switching into Koteshwor hit the public-Home bug (§10), so part 2 is re-filmed with Overall and Main only (after the owner's PIN). The branch stays an unapproved KYC draft (owner asked; approval is locked on the agreement anyway).
- ch 39–40 (owner side, seeded residents) → `39-overdue-B` (327 s): Payments → Kartik (3 overdue, fines Rs 1,350) → **Nischal**: fine line "Rs 50 a day · 27 days late", tick Kartik + Mangsir → 2 months Rs 23,350 → Cash → collected · **Sujan**: Waive fine → confirm → "Fine waived" (sheet kept the stale Rs 12,350 total: closed and reopened → Rs 11,000, trim) → eSewa (hostel number shown, 2 s undo) → saved · **Dipesh**: Part payment Rs 3,000 cash (trim the amount fix) → Rs 2,850 left, still overdue. Kartik: 1 waiting. R's own late-bill story (39–40 with phone B as R) is still to film if wanted; this covers the owner side.

- ch 52 part 2 → `52-branches-2-B` (62 s, after the owner's PIN): switcher (Main, Koteshwor, Overall) → **Overall** "Viewing all branches" → eye → scroll to Branches cards (Main: 14 of 16 beds, collected Rs 83,000, due Rs 42,000; Koteshwor: 0 beds) → switcher → Main → amounts hidden. ◐: stock Send → Got it needs a warden at the branch.
- ch 51 → `51-reports-B` (181 s): Home → Reports (Mangsir: 66% collected, Rs 83,000 of Rs 1,25,000; trend; residents; month by month with in/out/net) → tap Kartik → whole-month report → Report tools (night check-ins, meal timing, download 3 mo PDF/CSV per report) → Collection PDF downloaded → month PDF sheet (1 month … Custom, PDF/CSV, performance report) → 3 months → "Downloaded · statement-2083-05-to-2083-07.pdf". The open-on-tap didn't work (§10): the edit can insert page 1 of the pulled PDF.
- ch 50 → `50-statement-B` (171 s): Home → Statement (Rs 1,13,850 in · Rs 36,870 out · net Rs 76,980, balance after each line) → filter **Out** → expenses list → "Cash to Ramesh Thapa" details → filter **In + Cash** → clear → quick ranges 7 / 14 / **30 days** → Expenses (Mangsir in/out/left, Staff cash: Ramesh **Rs 80 left** → Cash box: given Rs 5,000, spent Rs 4,920, by day with bills) → Spent on by category. **Blur or cut** the first statement row ("Dipesh Rai … Rs 7,500 · Part payment", §10 bug) and the junk "Code · Of Payment" rows in the cash box.

- **Day 4 (2026-11-21 morning).** A = owner at start, then **sign-in 4: A = warden Ramesh Thapa** (email by the session, password by the owner). B = Aarav (R) all morning.
- ch 29 owner half → `29-night-status-A` (106 s): Home → Night status (1 of 14) → Inside filter → **Aarav Sherestha · Inside hostel · Mangsir 4, 8:15 pm** → sheet (Inside / Outside / Marked safe, Seen in their room / Called them / Told us earlier) → To check → Anish Tamang → Seen in their room + Inside → Save → toast "Anish Tamang marked Inside hostel" → **2 of 14**.
- ch 30 → `30-attendance-A/B` (~100 s): A Settings → Attendance → Tracking on (50 m inside / 200 m nearby, check-ins 06:00, 08:00, 22:00, alert after 14 days, keep 600 days, "Only the zone is kept") → Save; B More → Location & attendance → Record my location **On** (three privacy lines, "No days recorded") + `30-attendance-2-A` (13 s: More → Attendance, everyone "Unknown", "Exact locations are never stored"). ◐: no check-in can arrive (§10).
- ch 32 → `32-warden-home-A` (66 s): warden Home → eye → Rs 3,91,456 / in Mangsir Rs 83,000 / still due Rs 53,655 → tiles → My cash Rs 80 (spent Rs 4,920, list) → bell → back. Trim: the end still shows amounts.
- ch 33 → `33-desk-cash-A/B` (~236 s, 2 parts): B eye → Rs 11,000; A Collect → search "Aarav" → Cash → Part payment → **Rs 6,000** → success (cut: "Rs 6.000") → row **Rs 5,000 Partial**; B Home updates live to **Rs 5,000**, bell "Cash collected… NPR 5,000 still due" → Payments PARTIAL → Invoice detail: paid Rs 6,000, outstanding Rs 5,000, receipt **RCP-HIM-2083-08-00011**. Trim: B's accidental Community tab (shows a real public post) and the receipt "busy" wait. The receipt-QR check is not filmed (needs the owner's hands to scan B's screen).
- ch 34 → `34-desk-qr-A/B` (~85 s): A Aarav's row → **QR** (hostel QR shown full-size, "Scan to pay rent") → Save Rs 5,000 → (cut the "Cash collected" success) → Owing 6 · **Paid 8**; B Home **Rs 0 · Nothing outstanding** → Payments "1 of 1 settled · Mangsir Rs 11,000 PAID".
- ch 37 → `37-warden-checks-A/B` (~215 s, 2 parts): B Complaints → Raise → Room → Type instead "The window in room 103 does not lock. Since last night." → Send; A (warden) bell has nothing (§10) → Complaints → Open 1 → reply "The carpenter will fix the latch by 5 PM today." → Mark in progress; B complaint → History: **Warden · 8:47 · Marked in progress** + the reply. Trim: a stray "2" typed into the reply (deleted on camera).

- **Day 4 later / day 5 (2026-11-21 → 22).** Sign-in 5: the cook invite (fedax) couldn't be accepted (inbox lost), so the warden renamed the existing kitchen login **himaj7@cook.local → Hari Magar** and issued a new password on screen; the owner typed it on B. Sign-in 6: A = Aarav. Day 5: guardian re-invited to **lixofi6457@forims.com** (old pending invite revoked), sign-in 7 by the owner, then sign-in 8: B = owner.
- ch 42 → `42-menu-cook-A/B` (~135 s): A (warden) Food → Saturday snacks → "Veg momo, achar, tea" + note "Saturday special" → **Save the week**; B (cook) bell "**The menu changed** · just now" (above "Lunch is due", the 30-min meal call) → Menu: Snacks Veg momo… Saturday special.
- ch 43 → `43-food-ready-A/B` (~270 s, 2 parts): B (cook) Lunch **Food ready** → "Lunch announced, 2 resident(s) notified, the office too"; A (Aarav) bell "Food is ready · Today's lunch…" → Food → Rate lunch 5★ "Dal was very tasty today." Trim: the first rating attempt and the second sheet.
- ch 44 → `44-khata-kitchen-A/B` (~340 s, 2 parts): A Khata → Egg ×2 "Boiled, with breakfast tomorrow" → Ask Rs 40 → Waiting; B Khata asks → **Give** → A "Rs 40 · On next bill"; B Kitchen inventory → Rice +2 kg → Used (20 kg left); B Add expense Rs 850 Vegetables & meat, Cash, bill photo `bill-market.jpg` (new sample: eggs + paneer, `make-samples.py`) → saved. **Cut** the autofill popup over the amount (shows a phone number).
- ch 45 resident half retake → `45-guardian-invite-2-A` (111 s): Invite a guardian (prefilled Krishna Sherestha, Father, 9800000107) → email **lixofi6457@forims.com** → fee status, receipts, notices, food menu, night safety → "They will see 5 things" → Send → Pending, 7 days.
- ch 46 → `46-guardian-view-A/B` (~190 s, 2 parts): B (guardian) Home (Aarav · Inside hostel · "You are their father", outstanding settled, today's meals, notices) → Safety → Payments (Rs 0, Mangsir Rs 11,000 paid, receipts 00011 Rs 6,000 / 00012 Rs 5,000); A turns fee status + receipts off → B Payments "**Not shared with you**", Home loses the outstanding card.
- ch 47 → `47-sos-A/B` (~115 s): A SOS → "I have high fever and cannot get up. Room 103." + guardians on → Send → "Alert sent · 2 people at your hostel, along with 1 guardian"; B (guardian) Home "Sos triggered", bell "🚨 Emergency SOS · Aarav Sherestha raised an emergency SOS". + `47-sos-owner-A/B` (~70 s): B (owner) Home "An SOS is active" → Action queue SOS 1 → **Acknowledge** → SOS 0; A past alerts "**Seen by staff**".
- ch 48 → `48-move-out-A/B` (~240 s, 2 parts): A Moving out → today, "Semester is over. Going home to Ilam." → I'm leaving; B bell "Aarav Sherestha is leaving" → Home **Leaving today** → sheet: Till the day **Rs 2,276 for 6 of 29 days**, nothing unpaid, **Rs 8,724 back as credit**, no deposit → Move out → "Aarav has moved out"; A bell "Your stay has ended" → (app needs a restart, §10) → public Home.
- ch 49 → `49-remove-r2-B` (101 s): Residents → Suman Rai → Remove resident → owner's PIN → 12 living, beds free.
- ch 21b visitor half → `21b-book-A` (~200 s: search Himalaya → **trim** the wrong card that opened Alsus Boys Hostel's booking page, a real listing → Himalaya → Book: Single Room Rs 14,000, answers within 24 h, bed held 7 days, booking fee Rs 980 = 7% paid to HostelPalika, refund schedule) + `21b-book-pay-A` (135 s: refund account eSewa, wallet number typed by the owner, accept policy → Book and pay → "finish paying on Softmato" → Pay Rs 980 → **live Softmato checkout** NPR 980, INV-2083/84-000051, billed to Aarav, Fonepay → stopped, nothing paid; tab closed). **Edit (owner, 2026-11-22): after the checkout, cut to a faked "booking paid" screen** built in HyperFrames from the app's own booking-success layout. Owner confirm still needs seeded bookings. The unpaid live invoice/booking is left to expire.
- ch 23a → only `23a-form-qr-A/B` (~35 s: owner's Form QR link `hostelpalika.com/join/apply/…`; A opens the form, no account needed: photo, ID, guardian ID, personal). Superseded by the retake below.
- ch 23a retake → `23a-form-qr-3-A/B` (~440 s, 3 parts): A opens the Form QR link (no account) → Upload photo (sample silhouette, crop) → ID `applicant-citizenship-front.jpg` (new sample: **Bikash Karki**, 05-01-79-04321, Kaski) → Bikash Karki, 9800000108, bikash.karki.demo@example.com, DOB 15 Poush 2062 BS, Male, B+, Non-veg, Kaski-8 Pokhara Lakeside, father Hari Karki 9800000109 Farmer → finger signature → agree → **Sent**: "They will choose your bed and call you on 9800000108"; B Residents "1 wants to live here · Filled your Form QR" → Bikash's form → Next — bed and money → Double Sharing, **Room 102**, calendar month: rent Rs 11,000, this month (24 of 29 days) Rs 9,103, deposit Rs 5,000, admission Rs 2,000, "Due at move-in Rs 7,000" → Register them → Payments sheet: Mangsir bill HIM-00EK-MAN83 **Rs 9,103** (not collected). Trim: the first room tap that didn't take (tile under the header). Bikash is a new demo resident (example.com email, no real inbox); `unseed` should remove him.

- **Day 6 (2026-11-23), B = owner; A dropped off adb ("offline", no serial) after the first restart.** Aarav on A turned out to be linked to "Bikash Karki" (the ch 23a Form QR was filled on A while signed in as Aarav) → owner removed Bikash Karki so Aarav is public again for ch 22.
- ch 21b owner half → `21b-confirm-B` (48 s): Home → Bookings (1 waiting) → Bishal Karki, Single Sitter, BK-DEMO01, share Rs 588 → Confirm → "Confirm this booking?" → Confirm booking → Confirmed tab: bed held until Mangsir 14, Admit by ID card / Cancel booking; Sandesh Lama confirmed below.
- ch 52 part 2 → `52-overall-B` (52 s): Main chip → Switch hostel (Main · Koteshwor · Overall · Show label · Manage branches) → Overall ("Your hostels · Every hostel you manage", eye → amounts) → scroll → All chip → Main → eye.
- ch 55 → `55-trial-ending-B` (43 s): bell → "Your free trial ends in 2 days" → Billing: Free trial, **3 days left**, Mangsir 4 → Mangsir 9, usage. (First take `.55-trial-ending-B-bad` showed 39 days: scenario fixed to move `currentPeriodEnd` too.)
- ch 56 → `56-trial-ended-B` (61 s): Billing → Refresh → Free, "This plan has run out" → Home: branch chip gone, banner "Read-only from 30 Nov · 12 residents (covers 10), 2 cook accounts (covers 1) on Free. Choose a plan" → tap → Billing. Then `restore`.
- ch 50a attempt → `.50a-import-B-bad` (240 s, unusable): DocumentsUI ignores injected taps on files (owner tapped), then the import failed "File MIME type is not allowed" (Android reports `text/comma-separated-values`). Fixed e164853f (server accepts it; app names the type from the extension → needs OTA). Re-shoot after deploy.
- ch 22 re-join → `22-rejoin-A/B` (A 137 s, B 144 s): B Join link (QR + https://hostelpalika.com/join/…) · A opens the link (adb VIEW at ~3 s: cut to "A scans the QR") → Join your hostel (ID card already there) → Double Sharing Rs 11,000 → "1 month due" → Send → "Sent to Himalaya Boys Hostel" · B back → 1 waiting → card (Bill on add Rs 11,000) → Add → room sheet 1st floor → 103 → "Add Aarav Sherestha? … Bills of Rs 11,000" → Yes, add → "Aarav Sherestha added" · **A turns into the resident Home on its own** (no restart: §10 ch 22 restart issue gone). A still says "Since Kartik 1" (§10 ch 22 data).
- ch 33 re-shoot → `33-desk-cash-v2-A/B` (A 264 s, B 281 s; **trim** the search fumble "AaravAarav" / Aswin chip, and the dead first tap): B Payments → search Aarav → Rs 11,000 Unpaid → Cash → Part payment (box empty) → 5000 → **Collect Rs 5,000** → "Cash collected" (comma right) · A pull → **Rs 6,000** → bell "Cash collected. NPR 5,000 received for Mangsir 2083 BS. NPR 6,000 still due" → Payments → invoice: paid Rs 5,000, outstanding Rs 6,000, receipt RCP-HIM-2083-08-00013.
- ch 34 re-shoot → `34-desk-qr-v2-A/B` (A 140 s, B 150 s): B Aarav (Partial, Rs 6,000 left) → **QR** (SAMPLE hostel QR full-size) → Part payment 3000 → Save Rs 3,000 (2nd tap; 1st only blurred the box) → row Rs 3,000 Partial · A pull → **Rs 3,000**.
- ch 38 → `38-reminder-A` (36 s): `rent-due-soon` → A pull: "Mangsir 2083 BS · Due in 2 days" → bell **"Payment due soon. Your Mangsir 2083 BS fee is due on Mangsir 9, 2083 BS."** (text fixed this session; it printed "2083-08 … Wed Nov 25 2026") → Payments Rs 3,000 due Mangsir 9.
- ch 39 → `39-overdue-A/B` (A 90 s, B 94 s): `rent-overdue` → A "8 days overdue", eye → **Rs 3,400** → bell "Payment overdue. Your Mangsir 2083 BS fee is overdue." → invoice OVERDUE: **Late fine Rs 50 a day · 8 days late = Rs 400** · B pull → Aarav Rs 3,400 · "Fine Rs 400".
- ch 40 → `40-late-collect-A/B` (A 73 s, B 84 s): B sheet: Month rent 11,000 + Late fine 400 (Waive fine link), paid 8,000, total Rs 3,400 → Cash → **Collect Rs 3,400** → Mangsir 4 waiting · A pull → **Nothing outstanding**.
- ch 41 → `41-month-roll-A` (67 s): `month-roll` (13 Poush bills, Rs 125,000) → A bell **"Rent bill ready. Your rent for Poush 2083 BS is NPR 11,000."** → Payments: Monthly rent — Poush Rs 11,000, due Poush 5. (B's Payments strip has no Poush chip until Poush.)
- ch 36 → `36-one-statement-A/B` (A 33 s, B 40 s): A Statement: "Rs 11,400 paid in total", one row per payment (3,400 · 3,000 · 5,000) with running total · B Aarav's profile: Paid so far **Rs 11,400**, Nothing outstanding, Months settled 1 of 1, Payment history (5,000 Cash · 3,000 Bank · 3,400 Cash, each with its RCP number). Same Rs 11,400 on both.
- ch 50 re-shoot → `50-statement-v2-B` (71 s): Home → Statement "Rs 131,750 in · Rs 37,720 out" → Aarav's three payments as **three lines** (3,400 · 3,000 · 5,000, balance after each) → scroll → Expenses: Money In **Rs 131,750** (now equals the Statement), Out 37,720, Left 94,030, staff cash.
- ch 50a → `50a-import-B` (222 s; **trim** the picker + PIN): Finance → Bank and wallet statements → eSewa → (owner taps `esewa-statement.csv`) → "0 of 8 payments matched · Who paid? 6" → Prabin Gurung Rs 14,000 "High match · name matches, owes exactly this amount" → Assign to Prabin Gurung → Who paid? 5. (Auto "Matched" needs the bill's reference code in the remark; name + amount is a suggestion by design.)
- **Left after day 6:** 17 (◐, receipt), 57 + 58 (plan proof image + superadmin approve), then `restore`; 54 waits on the app features (§10).
- **Sample receipts** (owner, day 6): no real receipt on A, so `marketing/video/demo-film/make_sample_receipts.py` draws a wallet-app "Transaction Details" screenshot for a made-up **Demo Pay** (no real wallet's name or marks) with a light SAMPLE · DEMO ONLY stamp → `assets/samples/receipt-resident-rent.png` (ch 35: Rs 5,000, Txn 7KQ2M9X, Remarks HIM-00FS-POU83) and `receipt-expense-grocery.png` (ch 17: Rs 850, Khanal Kirana Store). Reusable in the guide. Pushed to `/sdcard/Pictures/HostelPalika-demo/`.
- ch 35 → `35-receipt-claim-A/B` (A 564 s, 4 parts; **trim** the two failed share-intent tries at the start and **blur the photo-picker grid** beside the receipt: the owner's own photos): A Payments → I've paid → Photos → receipt → Done → form fills **Amount 5000 · Txn 7KQ2M9X · "Reference HIM-00FS-POU83 found" · Payment receipt Checked** → Method eSewa → Submit → "Waiting for approval" · B bell "Payment proof submitted…" → Payments Poush → Aarav "Pending proof" → **1 claim to verify** (thumbnail, Claims Rs 5,000 · Esewa, Txn 7KQ2M9X, 5 checks passed) → **Approve** · A pull → Rs 6,000 → bell **"Payment verified. NPR 5,000 received for Poush 2083 BS… added to the Resident Offer Program"** · A sends the same receipt again → **refused, but as "Upload failed — check your internet connection"** (§10). Pay online not shown (online gateway not set up).
- ch 35 repeat → `35-receipt-repeat-A` (65 s, day 7): Payments → I've paid → Photos → same `receipt-resident-rent.png` → Done → red card **"This receipt was already used · You already sent this receipt for Rs 5,000 for Poush 2083 BS"** + the same toast; nothing uploaded. **Blur the photo-picker grid** (owner's photos). **Start the cut at I've paid**: the Payments screen shows the Rs 0 bug below.
- ch 17 re-shoot → `17-share-sample-B` (173 s): B photo viewer (just the sample, no grid) → Share → HostelPalika → **Add expense** reads **Rs 850**, Paid by Bank → Save → "Saved" · same receipt again → **"Already added · Rs. 850 · added by Suresh Adhikari"**. Then `demo restore` (day 6 end).
- **57 + 58 → web video.** The Android app may not sell the plan or point to another way to pay (Play Payments policy, memory 2026-09-15; app Billing has no buy button by design). Buy on the web, owner approves as superadmin, then `plan-past-due` (the app may show 58's Pay-by block, without a pay link), then `restore`. 54 waits on the app features. Phone A is free.
### Seed (2026-11-20) — what `seed-history` wrote
Run from PowerShell in `server/` (Git Bash can't start the exe): `.in\dev.exe demo seed-history` · `unseed` · `inspect <collection> [json filter] [limit]`. It reads the repo root `.env` MONGODB_URI (production) and refuses any hostel but slug `himalaya-boys-hostel-2` with `_id` ending `ba1f794d`.
- 11 residents, desk-registered, **no login, no email** (no job can reach them), phones 9800000020–30: 001 Prabin Gurung · 002 Sagar Basnet · 003 Rohan Shrestha, Nischal Adhikari · 004 Bibash Maharjan, Anish Tamang, Kiran Bhandari · 103 Sujan Thapa, Roshan KC · 104 Dipesh Rai (joined Ashwin 12), Manish Poudel (joined Kartik 10). **102 stays free for R**, one bed free in 104. Home: 13 residents · 3 beds free · 81% full.
- Bills Bhadra/Ashwin/Kartik/Mangsir through the real billing engine (Ashwin 10% "Dashain" discount, khata on Kartik's bills), joining bills for the two late joiners, 36 desk payments (cash, eSewa/Fonepay/bank QR) settled through the ledger with receipts. Kartik: Nischal + Sujan unpaid, Dipesh half → OVERDUE with "Late fine — Rs 50 a day × 27 days". Mangsir: 5 paid, Kiran paid two months (credit), the rest open.
- 62 expenses (salary, groceries, vegetables & meat, gas, electricity, water, internet, repair, cleaning; **no bill photos**), 2 old notices, 3 resolved complaints, 3 new inquiries.
- `lateFine.enabledAt` moved back to Kartik 1 so the overdue bills carry fines; `unseed` puts the real value back.
- **Not seeded yet** (add before the chapter that needs it): bookings (ch 21b), food ratings, night-status/attendance history, staff cash history (ch 15's live Rs 5,000 is the warden's only cash).
- Owner Home after the seed: balance Rs 2,77,356 · in Mangsir Rs 72,000 · still due Rs 53,655.

### Waiting on the owner — status after day 1
Done: Samsung popup handled · hostel published · all account numbers + PAN typed · production writes for `dev demo` **approved by the owner** (demo hostel only, rows marked, `unseed` after).
Still to do with the owner: sign-ins 2–8 (§2), ch 57 superadmin approve, ch 49 yes before removing R2.

- ~20:05 phone B → **Aarav (R)** (owner typed the password). Phone A back on the cable but **not seen by Windows** (no ADB device at all): cable / port / USB debugging.
- ch 21b → `21b-booking-settings-B` (50 s, owner, before the switch): Bookings → History → Settings: Booking payouts **Verified** (Nabil ••••8020), short stays off with per-night minimums → How booking works (guest steps + "If you run a hostel").
- ch 31 → `31-rewards-B` (91 s): More → Offer Program (this quarter Rs 0, reference HIM-00DD-MAN83, perks, receipts) → Refer a friend (code HH01053228, referred/joined/first payment) → Review your hostel (overall + food/cleanliness/security/room/location/management) shown and **not sent** — a dummy review would go live on the public listing.
- ch 29 resident half → `29-night-status-B` (48 s): More → Night status ("Your hostel does not know where you are tonight") → Inside the hostel → Tell my hostel → "Status updated" → Home chip **Checked in**. Owner/warden half (roll call) on A next.
- ch 45 resident half → `45-guardian-invite-B` (140 s): More → Guardians → Invite: Krishna Sherestha, G's email, 9800000107, Father; on: fee status, receipts, notices, food menu, night safety (complaints off) → "They will see 5 things" → Send → **Pending, expires in 8 days**. G signs in later (sign-in 7).
- ch 30 waits for the owner: "Record my location" brings up Android's location permission on B.

### Next session starts here (day 7, after the 2026-11-23 shoot)
**State:** day 6 filmed 21b 22 33 34 35 36 38 39 40 41 50 50a 52 55 56 17 (all ☑, takes log below). `demo restore` ran at the end. Server fixes pushed (b09b6882 gofmt gate, e164853f CSV MIME, d2c067b8 BS reminder text, 2b85645d the 11 day-6 bugs). **OTA published 2026-11-23** on `production`, runtime `07f747e7…` = the store build: update group `2b302785-f451-4d29-914d-40fde9031dcf`.

**First, before any take:**
1. `gh run list --workflow "Go server" --limit 1`: 2b85645d's deploy must be green (it was running at hand-off).
2. Cold-start the app **twice** on each phone (the first start downloads the OTA, the second runs it). The owner types B's PIN.
3. `server/`: `go build -o bin\dev.exe ./cmd/dev` then `.\bin\dev.exe demo check` (PowerShell).

**Left to film:**
| Ch | What | Needs |
|---|---|---|
| 54 | Guide → EN/नेपाली switch; More → Notification settings → Emails (per topic); Backup | ☑ filmed day 7: `54-settings-2-B` (OTA group `38357c8a-f957-4ac9-a35b-9e6aa14af404`) |
| 35 (part) ☑ day 7 `35-receipt-repeat-A` | Re-shoot only the **repeat send**: the refusal now names the earlier claim | A = Aarav; same `receipt-resident-rent.png` (already on A) |
| 50a (part) | Optional: "Who sent this?" now prints Rs 14,000 with its comma | B |
| 57, 58 | Buy a plan / unpaid plan bill → **web video** (Play Payments policy: the Android app may not sell the plan or link out to buy it) | Web session, owner approves as superadmin, then `plan-past-due`, then `restore` |
| 30 | Attendance check-ins | Only once background check-ins ship in a store build |

**Then the edit** (§9, §8b module order): narration per module, 01 intro + 59 outro. Trims and blurs are listed per take (search fumbles in 33, picker grids in 35/50a, PINs).

**Tooling learnt on day 6:** DocumentsUI (Android's file picker) ignores injected taps on files: the owner taps the file. A shell `SEND` intent can't grant a MediaStore URI, so to share a sample, open it with `am start -a android.intent.action.VIEW -d content://media/external/images/media/<id>` and use the viewer's own Share. On Samsung A, sticky footers sit at y≈2134: tap at y≈2085 (inside the button, above the nav bar). Sample receipts: `marketing/video/demo-film/make_sample_receipts.py`.

### Next session starts here (day 6, footage checked 2026-11-23)
Footage: 139 takes in `assets/raw/clips` (A Samsung 1080×2340, B Infinix 720×1640), each with its `.touches`; `NN-slug-A/B` names map straight onto the §8b modules. 48 chapters ☑ · 9 ◐ · 9 still to shoot (01 and 59 are made in the edit, 20 is web only).

| Module | Left to shoot |
|---|---|
| M1 Get started · M3 Staff · M7 Families · M8 Rewards | nothing (complete) |
| M2 Your hostel | 52 ◐ |
| M4 Resident management | 21b owner confirm · 22 join link |
| M5 Finance | 35 36 38 41 50a ☐ · 17 39 40 50 ◐ · re-shoot 33/34 (they show "Rs 6.000" and "Cash collected" for QR) |
| M6 Daily life | 30 (needs background check-ins) |
| M9 Your plan | 55–58 |
| M10 Settings | 54 ◐ |

Order:
1. ☑ **Build, no phones (2026-11-23, uncommitted).** `dev demo` scenarios (§6 table). Per-payment statements: ledger + resident invoices carry `payments` (Go + TS, contracts re-recorded from TS), app draws one row per payment. Money text: big amounts printed "Rs 5.000" because Manrope's comma tail was clipped (line box 1.2× vs the font's 1.37×), not a locale — fixed in `Money`; success line says "QR / eSewa / Bank payment saved"; Collect re-reads the bill after Waive fine; Part payment box starts empty; payment push names the month ("Mangsir 2083 BS"). **Before step 2:** commit + push (server deploys itself), then the owner runs the OTA for the app fixes; `.\bin\dev.exe demo check` passes. Aarav's own ch 21b booking (BK-FMH6XQ, AWAITING_PAYMENT) lapses by itself; if it blocks his re-join in ch 22, wait for the sweep.
2. **Two phones, one session** (A = Aarav, public · B = owner · no new sign-ins): 21b owner confirms a seeded booking → 22 Aarav rejoins by the join link (makes him a resident again for the money takes; cut the restart) → 33/34 re-shoot → 35 → 36 → 38 → 39 → 40 → 41.
3. **One phone** (B = owner): 17, 50, 50a, 52, 54, then 55–58 last (57 approve by the owner's hand) → `restore`.
4. Ch 30 only once background check-ins ship in a store build; otherwise out of this round.
5. **Edit:** narration per module in §8b order, 01 intro + 59 outro, module cut. Covered in the edit, no re-shoot: 47 "Sos triggered", 46/48 AD dates, 51 grouping. Must be cut/blurred: 44 autofill phone number, 33 clipboard panel, 23-form-2 owner's photos.

### Day 5 notes (2026-11-22 ~08:45, superseded by day 6 above)
1. **Phones:** A = **Aarav, public again** (moved out ch 48; Samsung, 3-button nav on day 5 — never tap below y≈2100 on tab screens). B = **owner** (sign-in 8 done; PIN by the owner). Guardian = lixofi6457@forims.com (fee status + receipts now off). Cook = himaj7@cook.local "Hari Magar". Aarav's SOS is acknowledged, not resolved.
2. **Feature modules (§8b)** decide the cut; film order stays by act. New chapters 09a, 23a, 24a, 28a, 36a.
3. **Next takes:** Aarav is public on A → ch 21b (book up to the payment screen; needs seeded bookings for the confirm step) and ch 23a (A scans the Form QR, fills the admission form; B registers it). Then Act 10 leftovers (50a needs `statement-file`, 52 stock Send → Got it needs a branch warden) and Act 11 (scenarios). **Waiting on a build:** ch 35 + 41 (`month-roll`), ch 36 (per-payment statement), ch 30 proof (background check-ins), ch 38 (`rent-due-soon`), 55–58 (plan scenarios).
4. **21b:** payout account **VERIFIED** (19:55); owner settings filmed. Still needs a public account to book up to the payment screen (R after ch 48, or G before ch 45) and seeded bookings for the confirm step.
5. **Still to build (Go, `dev demo`):** seeded bookings (one waiting, one confirmed), `rent-due-soon`, `month-roll`, `trial-ending`, `trial-ended`, `plan-past-due`, `statement-file`, `restore`. `rent-overdue` is not needed (seed already has Kartik overdue with fines). Unseed must also remove the **Koteshwor** branch (made on camera, ch 52).
6. **Money bugs to fix after the shoot (§10):** part-payment statement row re-dated/cumulative; Waive fine leaves the old total on Collect; success screen "Cash collected" for eSewa + dot grouping; Floor & room moves on one tap.

### Waiting on the owner (2026-11-20, first list)
1. **Phone A: the Samsung Account policies screen.** Agree or dismiss it yourself; until then it interrupts every take on A.
2. **Superadmin → Himalaya Boys Hostel → Publish.** It's APPROVED, not PUBLISHED, so it isn't in public search (blocks ch 12's B half, 21, 21a, 21b).
3. **Account numbers** (typed by the owner, any dummy number): Payment setup → Bank (Nabil, name already typed), eSewa, Khalti; KYC → Booking money (payout account); Settings → About → PAN/VAT number (9 digits, set once). Optional: they don't block filming.
4. **Sign-ins 2–8** (§2): the session types the email, the owner types the password. Next: B = W (Ramesh Thapa) for ch 13–18.
5. **Production writes for `dev demo`** (seed-history + time scenarios): needs the owner's explicit OK. MISSION.md says production Mongo is read-only for Go dev tools, and the permission system blocked even a read-only production query from this session. Blocks ch 07, 38–41, 50, 50a, 51, 55–58 and a lived-in Home.
6. Superadmin Approve for the plan payment (ch 57) and the yes before R2 is removed (ch 49), when those come.
- Pace (owner, 2026-11-20): forms typed fast (`typef` = whole field at once); each feature explained calmly with a short hold on every result; never boring.
