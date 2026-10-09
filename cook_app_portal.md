# Cook Portal App — work order

**Created 2026-09-04**, after the resident tab-shape pass
(`resident_app_portal.md` §11) and the guardian pass (`guardian_app_portal.md`).
Scope: `apps/mobile`'s `(cook)` tab group.

Opened because the owner asked for it directly — *"make the cook app portal too"*
— and because the portal turned out to have the same four faults the other two
had just been cleared of, plus one of its own: **two tabs were fetching the same
payload, neither of them caching it.**

This file is the **handoff document** for that work. A session that picks it up
starts by reading it top to bottom and works at the first unticked box.

---

## How to use this file

- **One item at a time.** Write the code, verify it, then flip `[ ]` to `[x]`
  **in this file** with the date before starting the next item. Do not batch, and
  do not open a PR per box — the repo's convention is a tracker file, not a queue
  of branches.
- A `[x]` means *seen working*, not *file created*. Where "working" needs a
  handset, the box is marked **[device]** and stays `[ ]` until the device pass.
- **[server]** marks work that lives in `apps/web`. Do not fake it on the client.
- Anything found mid-task that is out of scope gets appended to §5, not fixed
  inline.

## Verification

```bash
npx --prefix apps/mobile tsc --noEmit -p apps/mobile
```

```bash
npm run mobile:lint && npm run mobile:test
```

> `npm run mobile:typecheck` **exits 0 with errors printed** — the npm wrapper
> swallows `tsc`'s status. Use the direct command above. See
> `resident_app_portal.md` §9.2.

**Baseline at the start of this work: `tsc` clean, lint clean, 1155 tests / 76
files.**

---

## §0 What the portal is, and what it is not

| | |
|---|---|
| **Tabs** | Today · Menu · Community · Photos · More |
| **Reads** | `GET /cook/today` (today's meals, today's announcements, the head count **and the whole week's routine**), the roster, the photo feed, the announcement log |
| **Writes** | Two, and only two: announce a meal, post a photo |
| **The account** | **A roster, not a single login.** `CookAccount` rows, managed from `manage/cook`: a generated short sign-in (`sunr@cook.local`) that a kitchen sharing one phone passes around, or an invitation to a cook's own email that turns their account into the cook account. Removing one deletes a generated account outright and drops an invited person back to `PUBLIC`, keeping the row so their past work reads `Previous <hostel> cook` |
| **Palette** | black / white / green, `roleAccent.COOK` for the tab bar. Never a literal hex from a reference image |

Three rules that follow from a login the hostel owns, and must not be softened:

- **"Signed in as" is not necessarily a person.** More names the *handset*,
  because a generated sign-in is passed around a kitchen and the device
  fingerprint is the thing actually stamped on an announcement. The
  announcement history does carry a name now — resolved through the roster, so
  a departed cook reads as `Previous Sunrise cook` — but that is the roster
  speaking, not the session.
- **The roster is a noticeboard.** `CookResident` is three fields with nothing
  contactable in it, because a shared, effectively static password makes this the
  list most exposed by a leak.
- **No account-deletion pathway.** Every other portal's More has one; a cook
  login belongs to the hostel — a generated one outright, an invited one for as
  long as the hostel says so — and the person holding the phone at 6am is not
  the person entitled to close it. The office removes a cook from
  `manage/cook`, which is where that decision has an owner.

And one about the product itself: **nothing on this portal is editable.**
`PUT /hostel-admin/food/routine` sits behind `manageFood`, which a COOK does not
hold — the menu is what the hostel promised its residents, and a kitchen changing
it silently is how a hostel serves something other than what it advertised.

---

## §1 Done in this pass

- [x] **1.1 Two tabs were fetching one payload, neither caching it.**
      *(2026-09-04)* Today calls `GET /cook/today` for the four buttons. Menu
      called it **again**, inside its own `loadMenu`, because the same payload
      carries the whole week's routine — which is the right call, made under an
      inline `useCallback` with **no `cacheKey`**. `useResource` without a key
      holds its payload in component state and loses it on unmount, so
      Today → Menu → Today was three round trips for one object.
      <br>`lib/cook-queries.ts` gives the portal four descriptors — `today`,
      `residents`, `photos`, `announcements` — and both tabs now read
      `cook:today`. The roster keeps a descriptor of its own so a roster that
      fails does not blank the week's menu, and it is the one query on the
      `residents` topic rather than `food`: it changes when somebody moves in or
      out, and a head count a day stale is the number on this portal that costs
      food.
      <br>A **warm-up** on `(cook)/_layout.tsx` covers the three tabs the cook is
      certain to reach but is not landing on. `today` is excluded for the reason
      the resident portal excludes Home: it is already asking.
- [x] **1.2 No cook screen had the bell.** *(2026-09-04)* More had a
      Notifications row and the other three tabs had nothing, so the control
      vanished the moment you left that one screen — `/notifications` is scoped
      to `principal.userId` with no role branch, so this account has a feed like
      any other. `<NotificationBell>` is in the `AppBar` `actions` slot on all
      four now, matching every other portal.
- [x] **1.3 Five spinners became skeletons.** *(2026-09-04)* `<LoadingState>` on
      Today, Menu, both sections of Photos, and nothing at all on More. Each
      placeholder is now the shape of what replaces it.
- [x] **1.4 The portal had no painted lead.** *(2026-09-04)* Today opened with a
      plain bordered box — `Cooking for` / `42` / a sentence — under a 16-point
      bar, while the other three portals all open on paint. Four portals of one
      product, one of which looked like a different app, and it is the one read
      at arm's length across a worktop.
      <br>`<CookShiftCard>`: the head count as the figure, `N of 4` on the
      shoulder, and a two-up of what has been called against what is next. Its
      shape is the **inset** card's (`AdminMoneyCard` / `ResidentDuesCard`), not
      the full-bleed hero's — this screen is a worktop rather than a front door,
      and the four announce buttons are the point of it.
      <br>**No percentage.** A shift is four discrete acts; a kitchen that has
      done breakfast and lunch at 2pm is on schedule, not half-failing. Same
      reasoning `app/attendance.tsx` records for refusing a presence percentage.
      <br>`nextUnannounced` (+3 tests) decides what "next" means: the first meal
      in **serving order** with nothing sent against it, not the one the clock
      suggests — a kitchen running an hour late would otherwise be told to
      announce the meal it has already served. The card that meal sits in is
      outlined in the brand, so one of four identical cards can be found without
      being read.
- [x] **1.5 Menu was a third hand-rolled copy of the week's routine.**
      *(2026-09-04)* Its own horizontal `ScrollView` of filled pills, then a
      `MEAL_TYPES.map` into `<MealRow>`s — which is exactly what
      `components/food-routine.tsx` already does, off the same payload, for the
      resident's Food tab and for `(admin)/today.tsx`. Three renderings of one
      menu is how "the app said chicken" starts, and the kitchen's was the copy
      nobody was looking at while editing the others.
      <br>It is `<FoodRoutineWeek>` now, which also brings two things this screen
      lacked: today stays marked on the strip when another day is selected, and
      each meal gets the icon square the rest of the app uses.
- [x] **1.6 The roster is searchable, once it is long enough to need it.**
      *(2026-09-04)* A hostel of forty gave a forty-row flat card.
      `searchCookResidents` (+4 tests) matches name and room type **as the row
      reads on screen** — `double sharing` finds `DOUBLE_SHARING` — and the field
      appears from twelve residents up, which is the rule `(admin)/money.tsx`
      states for its own search: a search box over eight rows is a control that
      exists to be ignored.
- [x] **1.7 The announcement history moved off Photos onto More.**
      *(2026-09-04)* It sat under the photo feed, on a tab named "Photos", and it
      is the list that grows — a hostel serving four meals a day adds ~120 rows a
      month underneath the control a cook opens that tab to press.
      <br>On More it is beside the block it belongs with: the device section says
      which handset is stamped on an announcement, and this says which
      announcements were stamped. Together they are the whole of what a shared
      kitchen login can be held to.
      <br>*"Did I already announce lunch?"* is **not** this list's question — it
      is answered on Today, on the meal's own card, which carries `Sent 12:04`.
- [x] **1.8 More.** *(2026-09-04)* An `<Avatar>` on the identity card, as every
      other More opens — and the only one in the product where the initial is
      deliberately not a person, which the caption says. `<FactRow>` for the
      three device facts, so a fingerprint wraps instead of being squeezed into
      the ~150dp a 320dp phone leaves a right-hand column (`NOTES.md` §8).
      `px-4 py-1` on the row cards, matching admin's.

**Verified after 1.1-1.8: `tsc` clean, lint clean, 1162 tests / 76 files.**

---

## §6 Push, the office, and the state the portal was refetching

**Opened 2026-09-07**, on the owner's ask: *"make sure this is push notification
to resident super important, and also warden should get notified with its
personal message as cook have marked as food is ready. polish the ui of cook
portal app as we do for guardian resident, add state management."*

The push half turned out not to be a missing feature. It was a fan-out shaped so
that the notification most likely to matter was the one most likely not to
arrive.

- [x] **6.1 [server] Food-ready push was one Expo round trip per resident, at
      default priority.** *(2026-09-07)* `announceFoodReady` looped over
      residents awaiting `createInAppNotification`, and every one of those fires
      its own `dispatchPush([oneUser])` — a preference query, a token query and
      an HTTP call to Expo, each handed to `after()`. A hostel of forty scheduled
      forty of them for one announcement. `after()` keeps the invocation alive
      but not without limit, so **the residents at the end of the list were the
      ones whose phones stayed silent**, and nothing reported it: the request
      that wrote their notification row had already returned 201.
      <br>`modules/food/food-ready-notify.ts` takes the whole audience,
      `sendPushToUsers` filters preferences once, looks tokens up once and posts
      to Expo in batches of a hundred. The durable bell rows are still per
      recipient; only the buzz is batched.
      <br>**Priority is `HIGH` now.** Food goes cold — `isHighPriority` is what
      puts `priority: "high"` on the Expo message, which is what wakes a dozing
      Android handset instead of leaving it until its next maintenance window. It
      was going out at the same priority as a monthly statement. Deliberately not
      `URGENT`: quiet hours still apply, and a resident who set 22:00–07:00 has
      asked not to be woken for breakfast. That exemption is for safety.
      <br>**And the audience was wrong.** The fan-out ran through
      `resolveActiveResidentRecipients`, which is an *email* resolver — it
      returns `null` for a resident with no address on their record and none on
      their account, and its own doc says why: "residents can be registered
      phone-only". Here that is the common case, not the edge. A resident with
      the app installed, signed in and holding a live device token was dropped
      because the hostel had never taken an email off them. The audience is now
      every ACTIVE resident with an account.
- [x] **6.2 [server] The office was told nothing.** *(2026-09-07)* A warden's
      question is not "is there food" — they are not queuing for it. It is *did
      the kitchen call the meal, when, and did it reach anybody*, which is the
      one thing about this portal an office cannot otherwise see: the login is
      shared, effectively static, and its only attribution is the handset on the
      log row (§0).
      <br>Owner, hostel admins and wardens now get their own notification —
      `Kitchen announced lunch`, then the hostel, the clock time, the reach, the
      handset it came from, and the line residents were sent. `NORMAL` priority
      and an explicit `kind: "NORMAL"`, because staff are being kept informed
      rather than summoned, and this must not sit in a warden's bell as an
      unresolved ACTION row.
      <br>Routed by `data.audience === "STAFF"` in `push-routing.ts` rather than
      by an `actionUrl`: `actionUrl` is also what the **web** bell links to, and
      `(admin)/today` is a mobile route group, not a URL.
      <br>**One shared-service fix rides along.** `push: false` on
      `createInAppNotification` used to gate the whole of
      `publishNewNotification`, so a caller batching its own push was also
      silently turning off that recipient's live bell and topic fan-out. It gates
      the Expo send and nothing else now, which also repairs `notifyOrderPlaced`.
- [x] **6.3 [mobile] Announcing refetched the payload it had just been
      handed.** *(2026-09-07)* The button called `today.refresh()` — a whole
      `GET /cook/today`, the week's routine and the hostel and the head count —
      to learn one fact the POST response already carried. On a kitchen handset
      that is a visible pause between the press and `Sent 12:04` appearing, which
      is exactly when a cook presses again because nothing happened, and the
      second press is the one that hits the cooldown 429.
      <br>`recordCookAnnouncement` (+4 tests) writes the server's own reply into
      `cook:today` and `cook:announcements`. Nothing is invented — this is not an
      optimistic update needing a rollback, it is the response, and the line is
      not reached if the announce threw. More's record and Today's buttons
      therefore cannot disagree about a meal announced thirty seconds ago.
      <br>The toast is `announcementSummary` (+3 tests), because there are two
      audiences now and each can be empty. "Only the office was told" is worth
      distinguishing from "nobody was told": it says the app works and the gap is
      residents not having installed it, which an admin can fix and a cook
      cannot.
- [x] **6.4 [server+mobile] The photo feed pages now.** *(2026-09-07)* §2.3.
      `listCookFoodPhotos` returned `hasMore` and nothing read it; there was also
      no parameter to ask for the next page with. The server takes a `cursor`
      that is the feed's own sort key (`date`, then `uploadedAt`) rather than a
      `skip` — a photo posted while a cook is paging would otherwise shuffle a
      row into or out of the next page, which on this feed is most of the time.
      <br>The screen gets a **Load older photos** button, not infinite scroll:
      this is a record somebody consults, not a feed they browse, and a thumb
      drag should not pull a fortnight of images over hostel wifi.
      <br>`mergePhotoDays` (+3 tests) folds a day that straddles a page boundary
      into one card and recomputes its `mealsCovered` — each page counts only its
      own half's coverage, so trusting either would tell a kitchen it documented
      two meals on a day it documented four.
- [x] **6.5 [mobile] The Today tab carries the count.** *(2026-09-07)* §2.2.
      A kitchen leaves Today constantly — to photograph the meal, to check the
      week, to look somebody up — and the shift is not a list of things read but
      four things *done*. The badge is the only thing in this portal that says
      the shift is unfinished from a tab that is not Today.
      <br>`hooks/use-query-value.ts` is the new piece and it is deliberately not
      a `useResource`: it **watches** `cook:today` and never asks for it. Today
      is the tab this group lands on and already loads that key, so the count is
      free; before it lands the badge is absent, and no request was made to find
      that out. The admin group solves the same problem the other way, with a
      provider owning the fetch, and that is right for *it* — its alert counts
      belong to no single tab. This is for when a tab already owns the data.
      <br>Zero draws nothing, so a finished shift is silent rather than showing a
      `0` in a dot, which reads as a fault.
- [x] **6.6 [mobile] The head count and the roster move together.**
      *(2026-09-07)* §2.4 guessed at deriving the count from the roster or
      folding both into one read. Neither was the cause. `cook:today` carries
      `residentCount` but was subscribed to `food` alone, so a resident moving in
      fired `residents`, invalidated `cook:residents` and left the head count
      sitting stale — the two numbers diverged *precisely* when the roster
      changed. `cook:today` is on both topics now.
      <br>Separately: the comment in `getCookToday` claiming its count matched
      the announcement fan-out's was never true, and is now wrong in a documented
      direction. The count is **plates** — every ACTIVE resident. The fan-out is
      every ACTIVE resident *with an account*. They are meant to differ, and the
      gap between them is how many residents have not installed the app.

**Verified after 6.1-6.6:** web `tsc` clean, 2266 tests / 154 files; mobile `tsc`
clean, lint clean, 1342 tests / 83 files.

---

## §2 Still open

- [ ] **2.1 [device]** The whole pass on a handset, light and dark: the shift
      card at 320dp with a three-digit head count and a long hostel name, the
      "all called" state, the four announce cards with wet hands, the roster
      search over forty, and the photo grid's skeleton throttled to 3G.
- [x] **2.2 The Today tab has no badge on the tab bar.** *(2026-09-07)* Done in
      §6.5 — see there for why it costs no request.
- [x] **2.3 The photo feed pages and the screen does not.** *(2026-09-07)* Done
      in §6.4, server and client.
- [x] **2.4 `Menu`'s roster and `Today`'s head count can disagree.**
      *(2026-09-07)* Done in §6.6, and the cause was neither of the two guesses
      recorded here — see there.

---

## §3 Server-side gaps — [server], not mobile work

- [ ] **3.1 No cook-side device registration.** The fingerprint is written by the
      first announcement, so More reads `collectDeviceInfo()` locally rather than
      showing what the server has on file. A kitchen cannot see, or revoke, the
      other handsets signed into the shared login.
      <br>*Half of this closed in §6.2*: the office's copy of every announcement
      names the handset it came from, so a warden can at least **see** an
      unfamiliar phone announcing meals. Revoking one is still not possible, and
      that is the half that needs the endpoint.
- [ ] **3.2 The cook cannot see a meal's feedback.** Residents rate per meal per
      day and the aggregate is the only thing that tells a kitchen Tuesday dinner
      is the problem — which is what the rating exists for. There is no
      `GET /cook/feedback`. *Mobile ships:* nothing, rather than a section that
      would have to invent a number.
- [ ] **3.3 The announcement log is unpaginated.** `listFoodReadyLogs` returns
      what it returns; a kitchen a year in has no way to reach last February.

---

## §4 Not in scope, recorded so it is not reopened

- **Nothing on this portal edits the menu.** See §0. If a hostel wants the
  kitchen to be able to correct a cell, that is a capability change on the
  server, not a form here.
- **The cooldown stays the server's.** `foodReadyCooldownMinutes` returns a 429
  naming the wait; the button says "Announce again" rather than disabling itself,
  because a cook re-calling a late sitting must be able to try and a client-side
  copy of that rule drifts the moment an admin changes it.
- **The meal type of a photo is guessed, not asked.** `mealTypeNow()` reads the
  Kathmandu clock. A picker between "I want to share this" and the photo being
  shared is where people give up, and a wrong bucket costs the hostel nothing.

---

## §5 Discovered mid-task — append only

- **5.1** `mealButtons` is the only thing standing between a blank routine cell
  and a missing announce button, and it is right — but nothing on the *server*
  stops an admin publishing a routine with all four cells empty, in which case
  the kitchen announces four meals whose message is built from nothing. Worth a
  look at what `announceFoodReady` composes in that case.
- **5.2** *(2026-10-09)* **Kitchen stock.** The cook now also enters what the
  kitchen took from the store: a *Kitchen stock* row on Today and in More opens
  `app/kitchen-stock.tsx` — picture tiles, one item per sheet, `+½ +1 +2 +5`,
  one green **Used**. Same-day **Undo** for its own taps. No prices. Behind
  `HostelSettings.cookCanUseStock` (on by default; owner's switch on
  `manage/cook`). Server: `GET/POST /cook/stock`, `POST /cook/stock/entries/[id]/undo`.
  See docs/INVENTORY_PLAN.md.

---

## Progress log

| When | What | Next |
|---|---|---|
| 2026-09-04 | Portal read against `(admin)`, `(resident)` and `(guardian)` after both earlier passes. Found Today and Menu refetching one payload with no cache, no bell on any tab, five spinners, no painted lead, a third copy of the week's routine, and the announcement log growing on the Photos tab. §1 built whole. **1162 tests / 76 files, lint and tsc clean.** | §2.1 [device] |
| 2026-09-07 | Owner asked for push to residents, a warden-facing message, UI polish and state management. The push was already firing — once per resident, at default priority, over an email-shaped audience that dropped phone-only residents. §6 rebuilt the fan-out, added the office's own notification, and cleared §2.2, §2.3 and §2.4. **web 2266 / 154, mobile 1342 / 83, lint and tsc clean.** | §2.1 [device] |
