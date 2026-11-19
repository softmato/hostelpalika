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
| C | Cook | fedax13245@afronewz.com |
| G | Guardian (R's parent) | xadop74727@bonuscable.com |
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
☐ Run the store build (§4), upload the AAB to Play (internal testing), install it from Play on both phones.
☐ Both phones: USB debugging on, plugged in, screen lock set to swipe or none (the session cannot type a phone PIN).
☐ Both phones: Do Not Disturb on, HostelPalika allowed through.
☐ Phone B: three old payment receipts in the gallery (eSewa / Khalti / bank screenshots or
PDFs, small amounts): for the expense share (ch 17), the resident's receipt (ch 35), the plan
payment (ch 57). Names and numbers on them get blurred in the edit.
☐ Both phones: Developer options → Stay awake on.
☐ Answer the open decisions (§9).

Session:
☐ `adb devices -l` shows both. Serials: A `____` B `____` (one seen so far: `RZCY81L8MCZ`, Samsung SM-A176B).
☐ The Play Store build is the one installed (Settings → About shows the new version), not the dev build.
☐ `capture/rec.sh` extended for two phones (§1) and tried on both.
☐ Narration script for the whole video written and approved by the owner (§1).
☐ Scenario script built and tried on the demo hostel (§6).
☐ Sample images (§7) made and pushed to both phones.

## 4. Which build to film: the Play Store build

The phones have the dev build now. Do not film it: it shows the dev-client menu and
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

## 6. Scenario script — time-based states on camera

Monthly bills, reminders, late fines and the plan running out depend on the calendar. To
film them, build a script that moves **only the demo hostel** into each state, then runs
the real job code for that hostel alone.

Build it where the jobs live: a `dev` subcommand in the Go server (read
`server/docs/MISSION.md` first). It must refuse any hostel id except the demo hostel's.

| Scenario | What it sets up | Filmed in |
|---|---|---|
| `rent-due-soon` | Open bill due in a couple of days → payment reminder for this hostel | ch 38 |
| `rent-overdue` | Due date moved back past the free days → late fine lines added | ch 39–40 |
| `month-roll` | Next BS month's bill raised for this hostel | ch 41 |
| `trial-ending` | Trial ends in two days → plan reminder | ch 55 |
| `trial-ended` | Trial ended, no plan bought → Free plan, Max features locked | ch 56 |
| `plan-past-due` | Plan bill unpaid past its date → past due, then suspended | ch 58 |
| `restore` | Back to a normal, paid, unlocked hostel | after each |

## 7. Demo data card

- Hostel: **(decision 1)**, Kathmandu. 2 floors; rooms 101–104, 201–204.
- Rate card: single Rs 14,000 · two-seater Rs 11,000 · three-seater Rs 9,000.
  Admission Rs 2,000, deposit Rs 5,000. Billing: calendar month.
- R joins a two-seater: joining bill Rs 18,000 (admission + deposit + first month).
- Ch 33: Rs 10,000 cash. Ch 35: the old receipt's amount. Ch 34: whatever is left, paid by
  QR at the desk → bill cleared. (Film 35 before 34 if the receipt has to fit inside what is owed.)
- Petty cash to warden: Rs 5,000. Warden expense: vegetables Rs 1,200 with bill photo.
- Notices: "Water tank cleaning on Saturday" (now) + Clothes Washing (weekly).
- Sample images in `demo/assets/` stamped **SAMPLE**: ID card, citizenship front/back,
  hostel photos, food photo, bill photo. Pushed to `/sdcard/Pictures/HostelPalika-demo/`.
- Money check: R's balance must read the same for the warden, on R's Statement and on G's
  Fee summary. Note it at ch 36 and ch 46.

## 8. The chapters

Tags: ADM WAR RES COOK GUA. ★ = Duo (the other phone is the point); everything else is Solo.

### Act 1 · Get started  (A = O)
| ☐ | # | Chapter | What happens on screen | Proof moment | Videos |
|---|---|---|---|---|---|
| ☐ | 01 | What HostelPalika is | Motion intro: five roles, one app (made last, from other footage) | — | ALL |
| ☐ | 02 | Get the app | Play Store → "HostelPalika" → Install → Open | App opens | ALL |
| ☐ | 03 | Register your hostel | A: Register your hostel → hostel name, owner name, O's email (sign-in 1) | Portal opens at once; Free trial banner | ADM |
| ☐ | 04 | Hostel KYC | A: the 8 steps, filled fast → draw signature → submit | "Submitted" | ADM |
| ☐ | 05 | We check every hostel | Owner approves as superadmin (hand) → A: bell + email | Locked features open | ADM |
| ☐ | 06 | Lock the app | Settings → App lock → PIN + fingerprint (hand); reopen asks for it; then off | PIN screen | ALL |

### Act 2 · Set up your hostel  (A = O, B = signed out)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 07 | Your Home | Tabs, bell, hostel switcher | — | ADM |
| ☐ | 08 | Rooms & beds | Floors, rooms 101–204, beds; deleting a room with people → refused | Vacancy count | ADM |
| ☐ | 09 | Room rates & how bills work | Rate card, admission + deposit, billing choice; bills make themselves each month | "HostelPalika does the maths" | ADM |
| ☐ | 10 | Payment setup | Hostel QR + bank details; Online checkout screen | QR saved | ADM |
| ☐ | 11 | Money rules | Late fine (free days), festival discount, notice days | — | ADM |
| ☐ | 12 | Your hostel page ★ | A edits photos and facilities → B (signed out) finds it in the listings | Live listing on B | ADM |

### Act 3 · Your staff  (A = O, B = W)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 13 | Add a warden ★ | A: Wardens → Add → W's email. B: W signs in (sign-in 2) | B opens warden screens | ADM WAR |
| ☐ | 14 | Warden permissions ★ | A: View payments off → on | Payments leaves / returns in B's menu | ADM WAR |
| ☐ | 15 | Petty cash ★ | A gives Rs 5,000 → B bell → Got it | B My cash Rs 5,000; A sees "Got it" | ADM WAR |
| ☐ | 16 | Warden expense | B: Add expense, vegetables Rs 1,200, bill photo, cash | B My cash Rs 3,800; A Expenses shows it with the photo | ADM WAR |
| ☐ | 17 | **Share a receipt** ★ | B: open an old receipt (gallery / eSewa history) → Share → HostelPalika → the sheet reads the amount → Save. Share the **same** receipt again | A Expenses shows it with the receipt; the second share says it is **already added** (no double count). "Don't ask next time" → saves in the background | ADM WAR |
| ☐ | 18 | Inventory | B records Bought + a stock Count → A approves the count | Count approved | ADM WAR |
| ☐ | 19 | Add a cook | A: Cooks → invite C's email; switches: cook enters stock used / cook adds expenses | Cook listed | ADM COOK |
| ☐ | 20 | Temporary login & audit log | A: one-day login; Audit log | Who changed what | ADM |

### Act 4 · Your residents join  (A = O, B = R)
B logs out W; R signs in (sign-in 3) — still a public account.
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 21 | Find a hostel | B: listings, map, near a college, compare, save | — | RES |
| ☐ | 22 | Join link ★ | A shares the join link/QR → B sends room + rent + ID card → A Join requests → Add | B's app turns into the resident Home | ADM RES |
| ☐ | 23 | Add a resident by form | A only, R2: Scan ID / Form QR / by hand (fast), room, special fee; the existing-residents list with "paid till" | Bill shown before saving | ADM WAR |
| ☐ | 24 | The resident's Home & first bill ★ | B: Home, digital ID card, joining bill Rs 18,000, month code | Same bill on A's resident detail | ADM RES |
| ☐ | 25 | Khata | B asks to open a khata → A approves | Khata open on B | ADM RES |
| ☐ | 26 | Notices ★ | A: notice now + weekly Clothes Washing | B push arrives | ADM WAR RES |
| ☐ | 27 | Complaints & repairs ★ | B: complaint with photo → A updates → resolved; repairs with a voice note, send to a service provider | B told at each update | ADM WAR RES |
| ☐ | 28 | Room change ★ | B asks for a free bed → A confirms | B's room changes only after confirm | ADM RES |
| ☐ | 29 | Night status & days away ★ | Night-status hour set just ahead → B answers In/Out from the Android shade; days away | A sees who answered and who didn't | ADM WAR RES |
| ☐ | 30 | Attendance | B location check-in | A sees it; no coordinates stored | ADM RES |
| ☐ | 31 | Points, offers, referral, reviews | B only | — | RES |

### Act 5 · Collecting rent  (A = W, B = R) — the main money act
A logs out O; W signs in (sign-in 4). Desk collection gets most of the screen time; the
receipt lane is the alternative.
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 32 | The warden's Home | Leaving today, alerts, daily routines, My cash | — | WAR |
| ☐ | 33 | **Collect rent at the desk** ★ | A: resident → Take payment → Rs 10,000 cash | B receipt arrives at once (HP- code, QR); balance Rs 8,000 on both | ADM WAR RES |
| ☐ | 34 | **Paid by QR at the desk** ★ | R pays the hostel QR at the desk; A records it as eSewa / bank with the reference | Bill cleared on both phones | ADM WAR RES |
| ☐ | 35 | Or the resident sends a receipt ★ | B: old receipt → Share → HostelPalika → claim on the bill → A bell → Payments → check → Approve. Send the same receipt again | B certified receipt + points; the repeat is refused | ADM WAR RES |
| ☐ | 36 | One statement, both sides ★ | A resident ledger beside B Statement | Same running balance (note: ____) | ADM WAR RES |
| ☐ | 37 | The warden's daily checks ★ | B complaint + night status → A (warden) updates | B told | WAR RES |

### Act 6 · When rent is late  (A = W, B = R; scenario script)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 38 | A reminder before the due date | `rent-due-soon` | B push + email | ADM RES |
| ☐ | 39 | Overdue and the late fine ★ | `rent-overdue` | FINE lines on B's bill; A's overdue list | ADM WAR RES |
| ☐ | 40 | Collecting a late bill ★ | A takes the payment, fine included (or waives it) | Cleared on both | ADM WAR RES |
| ☐ | 41 | Next month's bill makes itself | `month-roll` | New BS-month bill on B | ADM RES |

### Act 7 · The kitchen  (A = W then R, B = C)
B logs out R; C signs in (sign-in 5).
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 42 | The menu reaches the cook ★ | A=W: changes the weekly menu + a meal time just ahead | B cook gets "menu changed"; meal-call reminder fires | ADM WAR COOK |
| ☐ | 43 | Food ready ★ | A logs out W; R signs in (sign-in 6). B=C: food photo → Food ready → A=R notified → rates it | B cook sees the rating | ADM COOK RES |
| ☐ | 44 | Khata give & kitchen spending ★ | A=R asks for eggs → B=C taps Give; cook records stock used + a market expense with photo | Eggs on R's next bill | ADM COOK RES |

### Act 8 · Families  (A = R, B = G)
B logs out C; G signs in (sign-in 7).
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 45 | Invite a guardian ★ | A=R: More → Guardians → G's email, choose what they see. B=G opens guardian screens | Guardian screens open | RES GUA |
| ☐ | 46 | What the guardian sees ★ | B: fee summary, receipts, food, notices, safety, emergency contact. A turns Payments off | It disappears on B. Balance = ch 36 (note: ____) | RES GUA |
| ☐ | 47 | SOS ★ | A=R taps SOS → B guardian alert. At the start of Act 9 (B = O) film SOS Alerts and join it here | Alert on guardian and owner; SOS active in the header | ADM WAR RES GUA |

### Act 9 · Moving out  (A = R, B = O)
B logs out G; O signs in (sign-in 8). Set the notice days so the last day can be today.
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 48 | Move out ★ | A=R picks the last day → B=O approves → Leaving today → checklist: leaving month, deposit, write-off | Bill stops that day; A's app returns to the public Home | ADM WAR RES |
| ☐ | 49 | Remove a resident | B: remove R2 (owner says yes first) | Bed free again | ADM |

### Act 10 · Your numbers  (B = O)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 50 | Hostel statement & expenses | Everything in and out this month, balance after each line | Matches the takes above | ADM |
| ☐ | 51 | Reports & PDF exports | Charts, date range, PDF download | PDF opens | ADM |
| ☐ | 52 | Branches & Overall | Add a branch (name + label), switcher, Overall view, stock Send → Got it | — | ADM |
| ☐ | 53 | Referrals | Referral code and what it earns | — | ADM |
| ☐ | 54 | Notifications & settings | Bell, push, email opt-out per topic; switch to नेपाली; dark mode | — | ALL |

### Act 11 · Your plan  (B = O; scenario script; filmed last because a suspended hostel blocks other takes, then `restore`)
| ☐ | # | Chapter | What happens | Proof | Videos |
|---|---|---|---|---|---|
| ☐ | 55 | Your free trial | `trial-ending`: days left, what's included, the reminder | Banner + bell | ADM |
| ☐ | 56 | If the trial ends unpaid | `trial-ended`: Free plan, which screens lock | Locked tiles | ADM |
| ☐ | 57 | Buy a plan | Plan billing → choose → pay by QR + proof image → owner approves as superadmin (hand) | Plan active, features open | ADM |
| ☐ | 58 | If a plan bill goes unpaid | `plan-past-due`: past due, then suspended; what staff and residents see; pay to restore | Back to active | ADM |
| ☐ | 59 | Get started | Outro: install, register, WhatsApp | — | ALL |

## 9. Role cuts, edit and open decisions

| Video | Chapters |
|---|---|
| ADM | all, in act order |
| WAR | 01 02 06 · 13–18 · 23 26 27 29 · 32–37 · 39 40 · 42 · 47 48 · 54 59 |
| RES | 01 02 06 · 21 22 24–31 · 33–37 · 38–41 · 43 44 · 45–47 · 48 · 54 59 |
| COOK | 01 02 06 · 19 · 42–44 · 54 59 |
| GUA | 01 02 · 45–47 · 54 59 |

Edit: `marketing/video/demo-film/` on the promo `lib/` (Solo by default, Duo for ★, §1),
Sunita voiceover. Output in `marketing/video/demo-film/renders/`: one full video per role,
every chapter as its own clip, a `youtube/<video>.txt` with chapter timestamps (first at
00:00, each ≥ 10 s), `.srt` captions. Status bar redrawn clean; receipts blurred.

**Left out of this round:** the web portal (its own video later), online booking with
payout, the supply store order, bank statement import.

Open decisions:
1. Demo hostel name.
2. After the shoot: keep the demo hostel public as a showcase, or hide it from listings.

## 10. Issues found while filming

(Log here: chapter, what broke, screenshot path. Fix after the shoot unless told otherwise.)
